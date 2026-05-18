/**
 * glonAstrolabe — HTTP server.
 *
 * Routes:
 *   GET /api/state                       graph snapshot (objects + links + types + timeline)
 *   GET /api/objects/:id                 full detail + outbound/inbound links + raw fields
 *   GET /api/objects/:id/changes         the object's change DAG
 *   GET /api/agents/:id/conversation     classified blocks + registered tools
 *   GET /api/events                      live SSE stream of glon changes (tool calls, blocks, fields)
 *   GET /api/events/recent               last ≤200 events as JSON
 *   GET /api/meta                        host/data root info
 *   static /                             frontend from public/
 *   static /vendor/*                     mapped to node_modules/three/* for bare ES imports
 */

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { snapshot, getObjectDetail, getObjectChanges, getAgentConversation, getAgentContextRefs, getRoot, search, getWalletPubkeys } from "./reader.js";
	import { getPrograms, DAEMON_URL, askAgent, recallBlock, injectObject, dispatchToDaemon } from "./daemon-client.js";
	import { startWatcher, streamEvents, recentEvents } from "./events.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

// ── Global logging middleware ────────────────────────────────────────
app.use((req, res, next) => {
	console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
	next();
});

// ── API ────────────────────────────────────────────────────────────

app.get("/api/meta", (_req, res) => {
	res.json({
		root: getRoot(),
		now: Date.now(),
	});
});

app.get("/api/state", (_req, res) => {
	res.json(snapshot());
});
app.get("/api/agents", (_req, res) => {
	const s = snapshot();
	const agents = (s.objects ?? []).filter((o: any) => o.typeKey === "agent");
	res.json({ agents });
});

app.get("/api/objects/:id", (req, res) => {
	const detail = getObjectDetail(req.params.id);
	if (!detail) return res.status(404).json({ error: "not found" });
	res.json(detail);
});

app.get("/api/objects/:id/changes", (req, res) => {
	const changes = getObjectChanges(req.params.id);
	if (!changes) return res.status(404).json({ error: "not found" });
	res.json({ id: req.params.id, changes });
});

app.get("/api/agents/:id/conversation", (req, res) => {
	const conv = getAgentConversation(req.params.id);
	if (!conv) return res.status(404).json({ error: "agent not found" });
	res.json(conv);
});

// Object ids referenced by any in-context block of this agent. Used by the
// cosmos to render context-active balls with a persistent halo and to gate
// the inject button.
app.get("/api/agents/:id/context", (req, res) => {
	const c = getAgentContextRefs(req.params.id);
	if (!c) return res.status(404).json({ error: "agent not found" });
	res.json({ agentId: req.params.id, agentName: c.agent.name, objectIds: c.objectIds });
});

	// Send a message to an agent. Queues the ask asynchronously and returns
	// immediately so the browser doesn't hang on long-running tasks (10-30 min).
	// The UI polls /conversation to pick up the response when it arrives.
	app.post("/api/agents/:id/chat", async (req, res) => {
		const { id } = req.params;
		const { message } = req.body;
		if (!message || typeof message !== "string") {
			return res.status(400).json({ error: "message required" });
		}
		// Fire-and-forget: askAgent can take 10-30 min for complex tasks.
		// We return immediately; the UI polls /conversation for the result.
		askAgent(id, message).catch((err) => {
			console.warn("[chat] background ask failed:", err?.message ?? String(err));
		});
		res.json({ ok: true, agentId: id, status: "accepted" });
	});
// ── Auction house, coins, x402 payments, family-figgies routes
// were stripped along with the /coin and /auction programs.

// ── Network panel: peers discovered through the Hyperswarm directory ──
//
// Mirrors the /directory program's actions. The UI calls these to render
// the network panel, surface peer-request prompts, and send accept/decline.

app.get("/api/network/status", async (_req, res) => {
	console.log("[GET /api/network/status] request");
	try {
		const status = await dispatchToDaemon("/directory", "status", []);
		console.log("[GET /api/network/status] success");
		res.json({ ok: true, status });
	} catch (err: any) {
		console.log("[GET /api/network/status] caught error (graceful fallback):", err?.message);
		// Return empty status instead of crashing on missing /directory program
		res.json({ ok: true, status: { ready: false, reason: "directory program not deployed" } });
	}
});

app.get("/api/network/peers", async (_req, res) => {
	console.log("[GET /api/network/peers] request");
	try {
		const peers = await dispatchToDaemon("/directory", "listDiscovered", []);
		const peerList = await dispatchToDaemon("/peer", "list", []);
		console.log(`[GET /api/network/peers] discovered ${peers?.length ?? 0} peers, ${peerList?.length ?? 0} in list`);
		// Index /peer records by every key the discovered-peer side might
		// know — identity_pubkey, hyperswarm_pubkey, display_name — so the
		// merge succeeds even before a peer has bootstrapped its wallet
		// (identity empty) or when two peers happen to share a name.
		const trustMap = new Map<string, string>();
		const setBest = (key: string | undefined, level: string | undefined) => {
			if (!key || !level) return;
			const k = key.toLowerCase();
			const existing = trustMap.get(k);
			if (!existing || existing !== "trusted") trustMap.set(k, level);
		};
		for (const p of peerList || []) {
			setBest(p.identity_pubkey, p.trust_level);
			setBest(p.hyperswarm_pubkey, p.trust_level);
			setBest(p.display_name, p.trust_level);
		}
		// Group /peer records by host_peer_id so each discovered glon row
		// can render chat buttons on its remote agents.
		const remoteAgentsByHost = new Map<string, any[]>();
		for (const p of peerList || []) {
			if (p?.kind === "agent" && p?.host_peer_id) {
				const arr = remoteAgentsByHost.get(p.host_peer_id) ?? [];
				arr.push({
					id: p.id,
					display_name: p.display_name,
					agent_id_remote: p.agent_id_remote,
					trust_level: p.trust_level,
				});
				remoteAgentsByHost.set(p.host_peer_id, arr);
			}
		}
		const merged = (peers || []).map((p: any) => ({
			...p,
			trust_level: trustMap.get((p.identity_pubkey || "").toLowerCase())
				|| trustMap.get((p.hyperswarm_pubkey || "").toLowerCase())
				|| trustMap.get((p.agent_name || "").toLowerCase())
				|| (p.peer_object_id ? "trusted" : "discovered"),
			remote_agent_peers: p.peer_object_id ? (remoteAgentsByHost.get(p.peer_object_id) ?? []) : [],
			is_online: true,
		}));
		// Persistent contacts: every kind=human /peer record that's peered
		// (trusted/family/friend) but not currently in listDiscovered. Lets
		// the network panel render trusted peers as offline rows so they
		// don't disappear when their daemon naps — like a contacts list.
		const liveIds = new Set(merged.map((p: any) => p.peer_object_id).filter(Boolean));
		const peeredTrust = new Set(["trusted", "family", "friend"]);
		const offlineHosts = (peerList || [])
			.filter((p: any) => p?.kind === "human" && peeredTrust.has(p?.trust_level) && !liveIds.has(p.id))
			.map((p: any) => ({
				identity_pubkey: p.identity_pubkey ?? "",
				hyperswarm_pubkey: p.hyperswarm_pubkey ?? "",
				agent_name: p.display_name ?? "(unnamed host)",
				capabilities: [],
				first_seen: null,
				last_seen: p.last_seen ? Number(p.last_seen) : null,
				peer_object_id: p.id,
				agents: [],
				trust_level: p.trust_level,
				remote_agent_peers: remoteAgentsByHost.get(p.id) ?? [],
				is_online: false,
			}));
		const allPeers = [...merged, ...offlineHosts];
		console.log(`[GET /api/network/peers] returning ${merged.length} online + ${offlineHosts.length} offline`);
		res.json({ ok: true, peers: allPeers });
	} catch (err: any) {
		console.log("[GET /api/network/peers] caught error (graceful fallback):", err?.message);
		// Return empty peers list instead of crashing
		res.json({ ok: true, peers: [] });
	}
});

app.get("/api/network/requests", async (_req, res) => {
	console.log("[GET /api/network/requests] request");
	try {
		const requests = await dispatchToDaemon("/directory", "listRequests", []);
		console.log(`[GET /api/network/requests] found ${requests?.length ?? 0} requests`);
		res.json({ ok: true, requests });
	} catch (err: any) {
		console.log("[GET /api/network/requests] caught error (graceful fallback):", err?.message);
		// Return empty requests list instead of crashing
		res.json({ ok: true, requests: [] });
	}
});

app.post("/api/network/peer", async (req, res) => {
	// Body: { hyperswarm_pubkey?: string, identity_pubkey?: string, message?: string }
	try {
		const result = await dispatchToDaemon("/directory", "requestPeering", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/network/requests/:id/accept", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/directory", "acceptRequest", [{ request_id: req.params.id }]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/network/requests/:id/decline", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/directory", "declineRequest", [{ request_id: req.params.id }]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/network/announce", async (_req, res) => {
	try {
		const result = await dispatchToDaemon("/directory", "announce", []);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

// ── Peer-chat: agent-to-agent text messaging ────────────────────────
//
// Mirrors /peer-chat typed actions. The Network panel opens a chat panel
// when the user clicks a `peered` row; the panel polls messages and posts
// new ones through these endpoints.

app.get("/api/peer-chat/conversations", async (_req, res) => {
	console.log("[GET /api/peer-chat/conversations] request");
	try {
		const conversations = await dispatchToDaemon("/peer-chat", "listConversations", []);
		console.log(`[GET /api/peer-chat/conversations] found ${conversations?.length ?? 0} conversations`);
		res.json({ ok: true, conversations });
	} catch (err: any) {
		console.log("[GET /api/peer-chat/conversations] caught error (graceful fallback):", err?.message);
		// Return empty conversations list instead of crashing
		res.json({ ok: true, conversations: [] });
	}
});

app.get("/api/peer-chat/messages", async (req, res) => {
	// Query: ?conversation_id=... | ?identity_pubkey=... | ?peer_id=... [&since=&limit=]
	try {
		const input: Record<string, unknown> = {};
		if (typeof req.query.conversation_id === "string") input.conversation_id = req.query.conversation_id;
		if (typeof req.query.identity_pubkey === "string") input.identity_pubkey = req.query.identity_pubkey;
		if (typeof req.query.peer_id === "string") input.peer_id = req.query.peer_id;
		if (typeof req.query.since === "string") {
			const n = Number(req.query.since);
			if (Number.isFinite(n)) input.since = n;
		}
		if (typeof req.query.limit === "string") {
			const n = Number(req.query.limit);
			if (Number.isFinite(n)) input.limit = n;
		}
		const messages = await dispatchToDaemon("/peer-chat", "listMessages", [input]);
		res.json({ ok: true, messages });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/peer-chat/send", async (req, res) => {
	// Body: { identity_pubkey?: string, peer_id?: string, display_name?: string, text: string, in_reply_to?: string|null }
	try {
		const result = await dispatchToDaemon("/peer-chat", "send", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		// Distinguish trust-gate refusals (user-fixable) from swarm timeouts
		// so the UI can show a useful message.
		const msg = err?.message ?? String(err);
		const status = /trust|peered|peer matches/i.test(msg) ? 400 : 503;
		res.status(status).json({ ok: false, error: msg });
	}
});

app.post("/api/peer-chat/start", async (req, res) => {
	// Body: { peer_id?: string, identity_pubkey?: string, display_name?: string, goal: string, text: string }
	// Starts a new conversation with a peer. Used by the inspector when
	// the user types into a peer's chat pane and no active conversation exists.
	try {
		const result = await dispatchToDaemon("/peer-chat", "startConversation", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		const msg = err?.message ?? String(err);
		const status = /trust|peered|peer matches/i.test(msg) ? 400 : 503;
		res.status(status).json({ ok: false, error: msg });
	}
});

app.post("/api/peer-chat/mark-read", async (req, res) => {
	try {
		const result = await dispatchToDaemon("/peer-chat", "markRead", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/peer-chat/resume", async (req, res) => {
	// Body: { conversation_id }
	try {
		const result = await dispatchToDaemon("/peer-chat", "resumeConversation", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/peer-chat/end", async (req, res) => {
	// Body: { conversation_id, reason? }
	try {
		const result = await dispatchToDaemon("/peer-chat", "endConversation", [req.body ?? {}]);
		res.json({ ok: true, result });
	} catch (err: any) {
		res.status(503).json({ ok: false, error: err?.message ?? String(err) });
	}
});

// Inject an object into an agent's context: post a user_text via /agent ask
// describing the object. Triggers one assistant turn but the reference stays
// in context for every subsequent turn until the next compaction.
	app.post("/api/agents/:agentId/inject/:objectId", async (req, res) => {
		const { agentId, objectId } = req.params;
		const detail = getObjectDetail(objectId);
		if (!detail) return res.status(404).json({ error: "object not found" });
		const summary = injectSummary(detail);
		try {
			const result = await injectObject(agentId, summary);
			if (result === null) {
				return res.status(502).json({ error: "glon daemon dispatch failed (actor unreachable)" });
			}
			res.json({ ok: true, agentId, objectId, summary });
		} catch (err: any) {
			res.status(503).json({ error: "could not reach glon daemon", detail: err?.message ?? String(err) });
		}
	});

function injectSummary(detail: { object: { id: string; typeKey: string; name?: string }; rawFields: Record<string, unknown>; contentPreview?: string }): string {
	const { object: obj, rawFields, contentPreview } = detail;
	const lines: string[] = [];
	const label = obj.name ? `"${obj.name}"` : obj.id.slice(0, 8);
	lines.push(`(glonAstrolabe inject) Reference \u2014 the user wants you aware of this object:`);
	lines.push(`  type: ${obj.typeKey}`);
	lines.push(`  name: ${label}`);
	lines.push(`  id:   ${obj.id}`);
	const scalars = Object.entries(rawFields)
		.filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
		.slice(0, 6);
	if (scalars.length > 0) {
		lines.push(`  fields: ${scalars.map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`).join(", ")}`);
	}
	if (contentPreview) {
		const preview = contentPreview.slice(0, 240).replace(/\s+/g, " ");
		lines.push(`  content: ${preview}${contentPreview.length > 240 ? "\u2026" : ""}`);
	}
	lines.push(`Please acknowledge briefly so I know you got it; no further action needed unless I follow up.`);
	return lines.join("\n");
}

// Free-text search across object metadata + agent block content. Used by the
// frontend search box to surface compacted turns the user can recall.
app.get("/api/search", (req, res) => {
	const q = String(req.query.q ?? "");
	const limit = Number(req.query.limit ?? 20);
	res.json(search(q, Number.isFinite(limit) && limit > 0 ? limit : 20));
});

// Live event stream (SSE) of new glon changes — tool calls, messages,
// field writes — as they land on disk. Replays the last ≤200 entries on
// connect so a freshly-opened tab has context.
app.get("/api/events", (req, res) => {
	streamEvents(res);
});

app.get("/api/events/recent", (_req, res) => {
	res.json({ events: recentEvents() });
});

	// Re-inject a compacted block into an agent's live context. Proxies to the
	// glon daemon at $GLON_DISPATCH_URL (default port 6420), which
	// owns the actor that mutates the DAG. Returns the new block id so the
	// frontend can re-fetch the conversation and highlight it.
	app.post("/api/agents/:id/recall/:blockId", async (req, res) => {
		const { id, blockId } = req.params;
		try {
			const result = await recallBlock(id, blockId);
			if (result === null) {
				return res.status(502).json({ error: "glon daemon dispatch failed (actor unreachable)" });
			}
			res.json({ ok: true, result });
		} catch (err: any) {
			res.status(503).json({ error: "could not reach glon daemon", detail: err?.message ?? String(err) });
		}
	});


	// Planet Forge — AI-assisted planet styling. Proxies to OpenAI.
	app.post("/api/planet-forge", async (req, res) => {
		const { messages, apiKey } = req.body;
		if (!Array.isArray(messages) || messages.length === 0) {
			return res.status(400).json({ error: "messages array required" });
		}
		const key = apiKey || process.env.OPENAI_API_KEY;
		if (!key) {
			return res.status(400).json({ error: "OpenAI API key required. Set OPENAI_API_KEY env var or pass apiKey in request." });
		}
		try {
			const r = await fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${key}`,
				},
				body: JSON.stringify({
					model: "gpt-4o",
					messages,
					temperature: 0.8,
					max_tokens: 2048,
				}),
			});
			if (!r.ok) {
				const body = await r.text();
				return res.status(502).json({ error: `OpenAI API error (${r.status})`, body });
			}
			const data = await r.json();
			res.json(data);
		} catch (err: any) {
			res.status(503).json({ error: "could not reach OpenAI", detail: err?.message ?? String(err) });
		}
	});
// Wallet pubkeys (local-only, read-only)
app.get("/api/wallet", (_req, res) => {
	res.json({ pubkeys: [...getWalletPubkeys()] });
});


	// Coin overview routes were removed along with the /coin program.

	// Program registry: auto-discover what programs glon is running.
	app.get("/api/programs", async (_req, res) => {
		const programs = await getPrograms();
		if (programs) {
			res.json({ ok: true, programs });
		} else {
			res.status(503).json({ ok: false, error: "daemon offline" });
		}
	});

	// ── Tasks: merged daemon tasks + glon reminders ──────────────────

	const DAEMON_TASKS_URL = DAEMON_URL.replace("/dispatch", "/tasks");
	const GLON_DISPATCH_URL = process.env.GLON_DISPATCH_URL ?? DAEMON_URL;

	app.get("/api/tasks", async (_req, res) => {
		try {
			const [daemonRes, snap] = await Promise.all([
				fetch(DAEMON_TASKS_URL).then(r => r.ok ? r.json() : { tasks: [] }).catch(() => ({ tasks: [] })),
				Promise.resolve(snapshot()),
			]);
			const daemonTasks = (daemonRes.tasks ?? []).map((t: any) => ({ ...t, source: "daemon" }));
			const reminders = (snap.objects ?? [])
				.filter((o) => o.typeKey === "reminder" && !o.deleted)
				.map((o) => {
					const sc = (o as any).rawFields ?? {};
					const status = String(sc.status ?? "pending");
					const fireAt = Number(sc.fire_at_ms ?? 0);
					const now = Date.now();
					return {
						id: o.id,
						name: String(sc.note ?? o.name ?? o.id),
						type: "reminder",
						enabled: status === "pending" || status === "sending",
						status,
						fireAt,
						channel: String(sc.channel ?? "-"),
						target: String(sc.target ?? "-"),
						payload: sc.payload,
						overdue: fireAt <= now && status === "pending",
						source: "glon",
					};
				});
			res.json({ ok: true, tasks: [...daemonTasks, ...reminders] });
		} catch (err: any) {
			res.status(500).json({ ok: false, error: err?.message ?? String(err) });
		}
	});

	app.post("/api/tasks/reminders", async (req, res) => {
		const { channel, target, fireAt, payload, note, createdBy } = req.body;
		if (!channel || !fireAt || !payload) {
			return res.status(400).json({ ok: false, error: "channel, fireAt, and payload are required" });
		}
		try {
			const r = await fetch(GLON_DISPATCH_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prefix: "/remind",
					action: "schedule",
					args: [{ channel, target, fire_at: fireAt, payload, note, created_by: createdBy }],
				}),
			});
			if (!r.ok) {
				const body = await r.text();
				return res.status(502).json({ ok: false, error: `daemon dispatch failed (${r.status})`, body });
			}
			const data = await r.json();
			res.json({ ok: true, ...(data.result ?? data) });
		} catch (err: any) {
			res.status(503).json({ ok: false, error: "could not reach glon daemon", detail: err?.message ?? String(err) });
		}
	});

	app.post("/api/tasks/reminders/:id/cancel", async (req, res) => {
		try {
			const r = await fetch(GLON_DISPATCH_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prefix: "/remind",
					action: "cancel",
					args: [req.params.id],
				}),
			});
			if (!r.ok) {
				const body = await r.text();
				return res.status(502).json({ ok: false, error: `daemon dispatch failed (${r.status})`, body });
			}
			const data = await r.json();
			res.json({ ok: true, ...(data.result ?? data) });
		} catch (err: any) {
			res.status(503).json({ ok: false, error: "could not reach glon daemon", detail: err?.message ?? String(err) });
		}
	});

// /api/pay/authorize + /api/pay/settle (x402) were stripped along with /coin.
// ── Error handler ──────────────────────────────────────────────────
app.use((err: any, req: any, res: any, next: any) => {
	console.error(`[ERROR] ${req.method} ${req.path}:`, err?.message ?? String(err));
	console.error(err?.stack);
	res.status(500).json({ ok: false, error: err?.message ?? "Internal server error" });
});

// ── Static: three.js + frontend ────────────────────────────────────
//
// Serve three's ESM bundle from node_modules so the browser can resolve
// bare `three` imports via an importmap (see public/index.html).

	app.use("/vendor/three", express.static(join(ROOT, "node_modules", "three")));
	app.use("/vendor/rapier", express.static(join(ROOT, "node_modules", "@dimforge", "rapier3d-compat")));
	app.use(express.static(join(ROOT, "public"), { extensions: ["html"] }));

// ── Bootstrap ──────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";

app.listen(PORT, HOST, () => {
	console.log(`glonAstrolabe → http://${HOST}:${PORT}`);
	// The legacy DAG snapshot is best-effort — Figgies doesn't write change
	// files, so the reader has nothing to load. Don't let startup fail on it.
	try {
		const snap = snapshot();
		console.log(`  loaded: ${snap.objects.length} legacy objects, ${snap.links.length} links`);
	} catch (err: any) {
		console.log(`  legacy DAG snapshot skipped: ${err?.message ?? err}`);
	}
	try { startWatcher(); } catch (err: any) { console.log(`  events watcher skipped: ${err?.message ?? err}`); }
});
