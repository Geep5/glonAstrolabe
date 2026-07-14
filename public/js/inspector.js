/**
 * Inspector panel — renders object detail, change DAG, link list,
 * and agent summary into the right-side panel. Pure DOM builder:
 * nothing here knows about the 3D renderer.
 */

	import { colorForType } from "./colors.js";


	const els = {
		empty: document.getElementById("inspector-empty"),
		content: document.getElementById("inspector-content"),
		typeBadge: document.getElementById("insp-type"),
		title: document.getElementById("insp-title"),
		subtitle: document.getElementById("insp-subtitle"),
		agentSection: document.getElementById("insp-agent-section"),
		agentStats: document.getElementById("insp-agent-stats"),
		scalarsSection: document.getElementById("insp-scalars-section"),
		scalars: document.getElementById("insp-scalars"),
		linksSection: document.getElementById("insp-links-section"),
		links: document.getElementById("insp-links"),
		contentSection: document.getElementById("insp-content-section"),
		contentTitle: document.getElementById("insp-content-title"),
		contentBody: document.getElementById("insp-content"),
		changes: document.getElementById("insp-changes"),
		changeCount: document.getElementById("insp-change-count"),
		stats: document.getElementById("stats"),
		// Discord-link containers. Astrolabe is no longer a chat client —
		// the chat lives in the agents' Discord guild. We just render
		// deep links into the right thread/channel here.
		paneChat: document.getElementById("insp-pane-chat"),
		chatLinks: document.getElementById("insp-chat-links"),
		peerChatSection: document.getElementById("insp-peer-chat-section"),
		peerChatTitle: document.getElementById("insp-peer-chat-title"),
		peerChatLinks: document.getElementById("insp-peer-chat-links"),
		selfChatsSection: document.getElementById("insp-self-chats-section"),
		selfChatsLinks: document.getElementById("insp-self-chats-links"),
	};

	let handlers = {};

export function bindInspector({ onNavigate, onInject }) {
	handlers = { onNavigate, onInject };
}

let contextState = { agentId: null, contextIds: new Set() };
// Called by main.js whenever the in-context set is refreshed so the inspect
// button can flip between 'inject' and 'already in context'.
export function setContextState(next) {
	contextState = next;
	if (currentId) renderInjectSection();
}

function renderInjectSection() {
	const host = document.getElementById("insp-inject");
	if (!host) return;
	host.innerHTML = "";
	if (!currentId || !contextState.agentId) return;
	if (currentId === contextState.agentId) return;       // the agent itself
	const inContext = contextState.contextIds.has(currentId);
	if (inContext) {
		const note = document.createElement("div");
		note.className = "insp-context-note";
		note.textContent = "\u2713 currently in agent context";
		host.appendChild(note);
		return;
	}
	const btn = document.createElement("button");
	btn.className = "recall-btn";
	btn.textContent = "\u2192 Inject into context";
	btn.title = "Post a user_text describing this object so the agent's next turn sees it.";
	btn.addEventListener("click", async () => {
		btn.disabled = true;
		btn.textContent = "Injecting\u2026";
		try {
			const objectId = currentId;
			const r = await fetch(`/api/agents/${encodeURIComponent(contextState.agentId)}/inject/${encodeURIComponent(objectId)}`, { method: "POST" });
			const data = await r.json();
			if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
			btn.textContent = "Injected \u2713 (agent will reply on next turn)";
			btn.classList.add("ok");
			handlers.onInject?.(objectId);
		} catch (err) {
			btn.textContent = `Inject failed: ${err?.message ?? err}`;
			btn.classList.add("err");
		}
	});
	host.appendChild(btn);
	const note = document.createElement("div");
	note.className = "recall-note";
	note.textContent = "This object isn't in the agent's current context. Inject posts a user_text reference so the next assistant turn can see it.";
	host.appendChild(note);
}

let currentId = null;

	export function setLanding(state) {
		const agent = state.objects.find((o) => o.typeKey === "agent");
		els.stats.innerHTML = "";
		const rows = [
			["objects", state.objects.length],
			["links", state.links.length],
			["types", Object.keys(state.byType).length],
			["agents", state.objects.filter((o) => o.typeKey === "agent").length],
			["trading", state.objects.filter((o) => o.typeKey === "trading_agent").length],
			["programs", state.objects.filter((o) => o.typeKey === "program").length],
		];
	if (agent?.agentStats) {
		rows.push(["agent turns", `${agent.agentStats.userTurns}u / ${agent.agentStats.assistantTurns}a`]);
		rows.push(["agent tool calls", agent.agentStats.toolUses]);
		rows.push(["agent tokens", `≈${formatNumber(agent.agentStats.effectiveTokens)}`]);
	}
	for (const [k, v] of rows) {
		els.stats.appendChild(row(k, v));
	}
	if (agent) {
		const hint = document.createElement("p");
		hint.style.marginTop = "14px";
		hint.style.fontSize = "12px";
		hint.style.color = "var(--accent)";
		hint.textContent = `Tip: click ${agent.name ?? "the agent"} (the bright glowing node) to inspect, or click any other ball to see what it is. Activity heat fades over a minute.`;
		els.empty.appendChild(hint);
	}
}

export async function showObject(id) {
	currentId = id;
	const [detail, changes] = await Promise.all([
		fetch(`/api/objects/${id}`).then((r) => r.json()),
		fetch(`/api/objects/${id}/changes`).then((r) => r.json()),
	]);
	render(detail, changes);
	const obj = detail?.object;
	if (obj?.typeKey === "agent") {
		startAgentChatBindings(obj);
		stopPeerChatBindings();
		stopSelfChatList();
	} else if (obj?.typeKey === "peer") {
		stopAgentChatBindings();
		const kind = String(obj?.scalars?.kind ?? "");
		if (kind === "self") {
			stopPeerChatBindings();
			startSelfChatList(obj);
		} else {
			stopSelfChatList();
			startPeerChatBindings(obj);
		}
	} else {
		stopAgentChatBindings();
		stopPeerChatBindings();
		stopSelfChatList();
	}
}

export function clear() {
	currentId = null;
	stopAgentChatBindings();
	stopPeerChatBindings();
	stopSelfChatList();
	els.empty.hidden = false;
	els.content.hidden = true;
}

export function showDaemonTask(task) {
	currentId = null;
	els.empty.hidden = true;
	els.content.hidden = false;

	// Header
	els.typeBadge.textContent = "daemon";
	els.typeBadge.style.background = "color-mix(in oklab, #a78bfa 65%, #000)";
	els.title.textContent = task.name ?? task.id;
	els.subtitle.textContent = `id: ${task.id}`;

	// Hide object-specific sections
	els.agentSection.hidden = true;
	if (els.peerChatSection) els.peerChatSection.hidden = true;
	els.scalarsSection.hidden = true;
	els.linksSection.hidden = true;
	els.contentSection.hidden = true;
	els.changes.innerHTML = "";
	els.changeCount.textContent = "";

	// Daemon info section
	const info = document.createElement("div");
	info.className = "insp-section";
	info.innerHTML = `
		<h3>Daemon Task</h3>
		<div class="kv">
			<div class="row"><span class="k">type</span><span class="v">${task.type}</span></div>
			<div class="row"><span class="k">enabled</span><span class="v">${task.enabled ? "yes" : "no"}</span></div>
			<div class="row"><span class="k">interval</span><span class="v">${task.intervalMs ? `${(task.intervalMs / 1000).toFixed(0)}s` : "-"}</span></div>
			<div class="row"><span class="k">location</span><span class="v">http://127.0.0.1:6430/tasks</span></div>
		</div>
	`;
	// Remove any existing daemon-info section
	const existing = els.content.querySelector(".daemon-info");
	if (existing) existing.remove();
	info.classList.add("daemon-info");
	els.content.appendChild(info);
}

function render(detail, changesResponse) {
	const obj = detail.object;
	els.empty.hidden = true;
	els.content.hidden = false;
	// Peer chat and self-chats are opt-in panes; default to hidden so
	// they don't carry over from a previously-inspected object.
	if (els.peerChatSection) els.peerChatSection.hidden = true;
	if (els.selfChatsSection) els.selfChatsSection.hidden = true;

	// Header ------------------------------------------------------
	const { hex } = colorForType(obj.typeKey);
	els.typeBadge.textContent = obj.typeKey;
	els.typeBadge.style.background = `color-mix(in oklab, ${hex} 65%, #000)`;
	els.title.textContent = obj.name ?? shortId(obj.id);
	const pieces = [obj.id];
	if (obj.createdAt) pieces.push(`created ${formatTime(obj.createdAt)}`);
	if (obj.updatedAt && obj.updatedAt !== obj.createdAt) pieces.push(`updated ${formatTime(obj.updatedAt)}`);
	els.subtitle.textContent = pieces.join(" · ");

	// Agent section ----------------------------------------------
	if (obj.agentStats) {
		els.agentSection.hidden = false;
		els.agentStats.innerHTML = "";
		const s = obj.agentStats;
		append(els.agentStats, row("model", s.model ?? "—"));
		append(els.agentStats, row("turns", `${s.userTurns} user · ${s.assistantTurns} assistant`));
		append(els.agentStats, row("tool calls", `${s.toolUses} (${s.toolResults} results)`));
		append(els.agentStats, row("compactions", String(s.compactions)));
		append(els.agentStats, row("tools registered", String(s.toolCount)));

		// Context fill bar: visual indicator of how close the agent is to
		// compaction. Replaces the agent row that used to live in the
		// (now-removed) AI jobs panel.
		if (s.contextWindow > 0) {
			const fill = Math.min(1, s.effectiveTokens / s.contextWindow);
			const pct = Math.round(fill * 100);
			const bar = document.createElement("div");
			bar.className = "insp-context";
			bar.innerHTML = `
				<div class="insp-context-label">
					<span class="k">context</span>
					<span class="v mono small">${formatNumber(s.effectiveTokens)} / ${formatNumber(s.contextWindow)} · ${pct}%</span>
				</div>
				<div class="insp-context-bar"><div class="insp-context-bar-fill" style="width:${pct}%"></div></div>
			`;
			els.agentStats.appendChild(bar);
		}

		if (s.system) {
			const r = row("system", "");
			const v = r.querySelector(".v");
			v.classList.add("long");
			v.textContent = s.system;
			append(els.agentStats, r);
		}
		// Chat section
	} else {
		els.agentSection.hidden = true;
	}


	// Scalars ----------------------------------------------------
	const scalars = Object.entries(detail.rawFields).filter(([, v]) => {
		return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
	});
	if (scalars.length > 0) {
		els.scalarsSection.hidden = false;
		els.scalars.innerHTML = "";
		for (const [k, v] of scalars) {
			const r = row(k, String(v));
			const el = r.querySelector(".v");
			if (typeof v === "string" && v.length > 60) el.classList.add("long");
			append(els.scalars, r);
		}
	} else {
		els.scalarsSection.hidden = true;
	}

	// Links ------------------------------------------------------
	const hasLinks = detail.outLinks.length + detail.inLinks.length > 0;
	if (hasLinks) {
		els.linksSection.hidden = false;
		els.links.innerHTML = "";
		for (const l of detail.outLinks) {
			els.links.appendChild(linkRow("→", l.relationKey, l.targetId, l.fieldPath));
		}
		for (const l of detail.inLinks) {
			els.links.appendChild(linkRow("←", l.relationKey, l.sourceId, l.fieldPath));
		}
	} else {
		els.linksSection.hidden = true;
	}

	// Style section (all objects) --------------------------------

	// Content preview -------------------------------------------
	if (detail.contentPreview) {
		els.contentSection.hidden = false;
		els.contentTitle.textContent = guessContentTitle(obj.typeKey);
		els.contentBody.textContent = detail.contentPreview;
	} else {
		els.contentSection.hidden = true;
	}

	renderInjectSection();

	// Changes DAG (mini) ----------------------------------------
	const changes = changesResponse.changes ?? [];
	els.changes.innerHTML = "";
	els.changeCount.textContent = `${changes.length} change${changes.length === 1 ? "" : "s"}`;
	// Sort newest first
	const sorted = [...changes].sort((a, b) => b.timestamp - a.timestamp);
	const headSet = new Set(obj.headIds);
	for (const ch of sorted) {
		const row = document.createElement("div");
		row.className = "change-row" + (headSet.has(ch.id) ? " head" : "");
		const dot = document.createElement("span"); dot.className = "dot";
		const hash = document.createElement("span"); hash.className = "hash"; hash.textContent = ch.id.slice(0, 10);
		const ops = document.createElement("span"); ops.className = "ops";
		ops.textContent = ch.opSummary.join(" ");
		ops.title = ch.opSummary.join("\n");
		row.appendChild(dot); row.appendChild(hash); row.appendChild(ops);
		els.changes.appendChild(row);
	}
}


	// ── DOM helpers ────────────────────────────────────────────────

function row(k, v) {
	const d = document.createElement("div");
	d.className = "k";
	d.textContent = k;
	const v2 = document.createElement("div");
	v2.className = "v";
	v2.textContent = v;
	const wrap = document.createDocumentFragment();
	wrap.appendChild(d);
	wrap.appendChild(v2);
	const container = document.createElement("div");
	container.style.display = "contents";
	container.appendChild(wrap);
	return container;
}

function append(parent, frag) {
	for (const node of [...frag.children]) parent.appendChild(node);
}

function linkRow(arrow, relation, targetId, fieldPath) {
	const d = document.createElement("div");
	d.className = "link-row";
	d.innerHTML = `<span class="dir">${arrow}</span><span class="rel">${escapeHtml(relation)}</span><span class="id">${shortId(targetId)}</span>`;
	d.title = fieldPath;
	d.addEventListener("click", () => handlers.onNavigate?.(targetId));
	return d;
}

function guessContentTitle(typeKey) {
	if (typeKey === "typescript") return "TypeScript source";
	if (typeKey === "javascript") return "JavaScript source";
	if (typeKey === "proto") return "Proto definition";
	if (typeKey === "json") return "JSON content";
	return "Content";
}

function shortId(id) {
	if (!id) return "";
	return id.length > 14 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
}

function formatTime(ms) {
	if (!ms) return "";
	const d = new Date(ms);
	const today = new Date();
	if (d.toDateString() === today.toDateString()) {
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatNumber(n) {
	if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
	return String(n);
}

function escapeHtml(s) {
	return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]));
}

// Tiny markdown → HTML for chat bubbles. Handles the common chat patterns:
// fenced code blocks, inline code, bold, italic, links, bullet/numbered
// lists, and headings. Everything outside markdown markers is HTML-escaped
// first, so untrusted peer content can't inject script tags. Preserves
// surrounding whitespace (CSS `white-space: pre-wrap` handles plain
// newlines), so don't auto-convert `\n` to `<br>` here.
function renderMarkdown(raw) {
	if (raw == null) return "";
	let s = String(raw);

	// Stash fenced code blocks first so their contents are immune to the
	// inline transforms below. We escape inside the placeholder restore.
	const blocks = [];
	s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
		const langClass = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
		blocks.push(`<pre><code${langClass}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
		return `@@CODE${blocks.length - 1}@@`;
	});

	// Stash inline code spans too — same reason.
	const inlines = [];
	s = s.replace(/`([^`\n]+)`/g, (_, code) => {
		inlines.push(`<code>${escapeHtml(code)}</code>`);
		return `@@INLINE${inlines.length - 1}@@`;
	});

	// Everything else: HTML-escape, then run inline transforms.
	s = escapeHtml(s);

	// Headings (anchored to line start). Cap at h3 so chat bubbles don't
	// dominate the inspector with giant text.
	s = s.replace(/^### (.+)$/gm, "<h4>$1</h4>");
	s = s.replace(/^## (.+)$/gm, "<h3>$1</h3>");
	s = s.replace(/^# (.+)$/gm, "<h3>$1</h3>");

	// Bullet and numbered lists — group consecutive list lines into one ul/ol.
	s = s.replace(/(^|\n)((?:[-*] .+(?:\n|$))+)/g, (_, prefix, group) => {
		const items = group.trim().split("\n")
			.map((l) => l.replace(/^[-*] /, ""))
			.map((t) => `<li>${t}</li>`)
			.join("");
		return `${prefix}<ul>${items}</ul>`;
	});
	s = s.replace(/(^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_, prefix, group) => {
		const items = group.trim().split("\n")
			.map((l) => l.replace(/^\d+\. /, ""))
			.map((t) => `<li>${t}</li>`)
			.join("");
		return `${prefix}<ol>${items}</ol>`;
	});

	// Bold then italic (order matters — bold uses ** which contains *).
	s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

	// Links: [text](url). Allow http/https/mailto schemes only; others fall
	// through as literal text to avoid javascript: / data: URI injection.
	s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
		'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

	// Restore stashed code spans.
	s = s.replace(/@@INLINE(\d+)@@/g, (_, idx) => inlines[+idx] ?? "");
	s = s.replace(/@@CODE(\d+)@@/g, (_, idx) => blocks[+idx] ?? "");

	return s;
}

// ── Discord link panels ────────────────────────────────────────────
//
// Astrolabe used to embed a chat UI inside the inspector — a Chat tab
// for talking to the agent, a Peer chats tab for A2A threads, plus
// floating peer-chat / self-chat panels. All of that has moved to the
// agents' Discord guild. We just render deep links here.
//
// The bindings module exposes the same start*/stop* names that
// showObject() / clear() call so the dispatch glue above doesn't need
// changes. start*() populates a links container with Discord-deep-link
// buttons; stop*() empties the container.

let discordConfigPromise = null;
function fetchDiscordConfig() {
	if (!discordConfigPromise) {
		discordConfigPromise = fetch("/api/discord/config")
			.then((r) => r.ok ? r.json() : { guild_id: "", roster_forum_id: "", pair_category_id: "" })
			.catch(() => ({ guild_id: "", roster_forum_id: "", pair_category_id: "" }));
	}
	return discordConfigPromise;
}

function discordChannelUrl(guildId, channelId) {
	if (!guildId || !channelId) return null;
	return `https://discord.com/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(channelId)}`;
}

function discordGuildUrl(guildId) {
	if (!guildId) return null;
	return `https://discord.com/channels/${encodeURIComponent(guildId)}`;
}

function clearChildren(el) {
	if (!el) return;
	while (el.firstChild) el.removeChild(el.firstChild);
}

function buildLinkButton({ label, href, sublabel, disabled = false, hint }) {
	const wrap = document.createElement("div");
	wrap.className = "insp-discord-link";
	if (href && !disabled) {
		const a = document.createElement("a");
		a.href = href;
		a.target = "_blank";
		a.rel = "noopener noreferrer";
		a.className = "insp-discord-link-anchor";
		a.textContent = label;
		wrap.appendChild(a);
	} else {
		const span = document.createElement("span");
		span.className = "insp-discord-link-anchor muted";
		span.textContent = label;
		wrap.appendChild(span);
	}
	if (sublabel) {
		const sub = document.createElement("div");
		sub.className = "insp-discord-link-sub muted small";
		sub.textContent = sublabel;
		wrap.appendChild(sub);
	}
	if (hint) {
		const h = document.createElement("div");
		h.className = "insp-discord-link-hint muted small";
		h.textContent = hint;
		wrap.appendChild(h);
	}
	return wrap;
}

function renderMissingDiscord(container, reason) {
	clearChildren(container);
	container.appendChild(buildLinkButton({
		label: "Discord A2A is not configured",
		hint: reason ?? "Set GLON_A2A_DISCORD_GUILD and ensure the daemon's Discord bot is online to enable chat links.",
		disabled: true,
	}));
}

// Read a field value off the inspector's object payload. The
// /api/objects/:id response surfaces scalar fields under `scalars` as
// plain strings (already unpacked from the proto wrapper).
function readScalar(obj, key) {
	if (!obj) return null;
	const v = obj?.scalars?.[key];
	if (v == null) return null;
	if (typeof v === "string") return v;
	if (typeof v?.stringValue === "string") return v.stringValue;
	return null;
}

// ── Agent inspect: roster thread + that agent's A2A threads ─────────
//
// We don't filter the peer-chat conversations to "this agent only" —
// the daemon's /api/peer-chat/conversations endpoint returns every
// conversation in the actor and lacks an agent-specific filter; we'd
// need a daemon-side change to scope it. For now we show all
// conversations and label each one with peer name + goal so the user
// can pick. Cheap to refine later.

export async function startAgentChatBindings(agentObject) {
	if (!els.chatLinks) return;
	const cfg = await fetchDiscordConfig();
	clearChildren(els.chatLinks);

	if (!cfg.guild_id) {
		renderMissingDiscord(els.chatLinks);
		return;
	}

	const rosterThreadId = readScalar(agentObject, "roster_thread_id");
	const name = agentObject?.name ?? "this agent";
	if (rosterThreadId) {
		els.chatLinks.appendChild(buildLinkButton({
			label: `💬 Chat with ${name} in Discord →`,
			href: discordChannelUrl(cfg.guild_id, rosterThreadId),
			sublabel: `Roster thread`,
			hint: `Multiple humans can chat with ${name} in the same thread; the bot replies with a ${"`**"}${name}:${"**`"} preamble.`,
		}));
	} else {
		els.chatLinks.appendChild(buildLinkButton({
			label: `${name} has no roster post yet`,
			hint: `Re-bootstrap the agent or wait for the next heartbeat tick — a forum post will be created in #roster automatically.`,
			disabled: true,
		}));
	}

	// A2A conversations involving this agent. Best-effort.
	try {
		const r = await fetch("/api/peer-chat/conversations");
		if (r.ok) {
			const list = await r.json();
			const convos = Array.isArray(list) ? list : [];
			const mine = convos.filter((c) => c?.owner_agent_object_id === agentObject?.id);
			if (mine.length > 0) {
				const sep = document.createElement("div");
				sep.className = "insp-discord-link-sep muted small";
				sep.textContent = "Active A2A conversations:";
				els.chatLinks.appendChild(sep);
				for (const c of mine.slice(0, 12)) {
					const tid = String(c?.conversation_id ?? "");
					if (!tid) continue;
					const peerName = c?.peer_display_name ?? "(unknown peer)";
					const goal = c?.goal ? `"${String(c.goal).slice(0, 60)}"` : "";
					const status = c?.status ?? "active";
					els.chatLinks.appendChild(buildLinkButton({
						label: `→ ${peerName} ${goal ? `· ${goal}` : ""}`,
						href: discordChannelUrl(cfg.guild_id, tid),
						sublabel: `${status} · ${c?.message_count ?? 0} msgs`,
					}));
				}
			}
		}
	} catch {
		// Silent — peer-chat endpoint may be unreachable.
	}
}

export function stopAgentChatBindings() {
	clearChildren(els.chatLinks);
}

// ── Peer inspect: link to the pair channel / shared chat ───────────
//
// For now we link to the guild (Discord will land you at whatever
// you last had open). A future iteration can call a daemon endpoint
// that maps peer.agent_uuid → pair_channel_id and link directly.

export async function startPeerChatBindings(peerObject) {
	if (!els.peerChatSection || !els.peerChatLinks) return;
	const cfg = await fetchDiscordConfig();
	els.peerChatSection.hidden = false;
	clearChildren(els.peerChatLinks);

	if (!cfg.guild_id) {
		renderMissingDiscord(els.peerChatLinks);
		return;
	}

	const name = peerObject?.name ?? "this peer";
	const kind = String(peerObject?.scalars?.kind ?? "");
	const agentUuid = readScalar(peerObject, "agent_uuid");

	if (kind === "agent" && agentUuid) {
		// Try to surface the pair channel by sniffing peer-chat conversations
		// where this peer is the counterpart.
		let pairChannelId = "";
		try {
			const r = await fetch("/api/peer-chat/conversations");
			if (r.ok) {
				const list = await r.json();
				const convos = Array.isArray(list) ? list : [];
				const match = convos.find((c) =>
					(c?.peer_agent_uuid ?? "").toLowerCase() === agentUuid.toLowerCase()
					|| c?.peer_object_id === peerObject?.id);
				// We don't have the pair channel id directly in conversation
				// data, but the conversation_id is a thread INSIDE the pair
				// channel — Discord's UI will let the user navigate to the
				// channel via the thread.
				if (match?.conversation_id) pairChannelId = String(match.conversation_id);
			}
		} catch { /* fall through */ }

		const href = pairChannelId
			? discordChannelUrl(cfg.guild_id, pairChannelId)
			: discordGuildUrl(cfg.guild_id);
		els.peerChatLinks.appendChild(buildLinkButton({
			label: `💬 Open chat with ${name} in Discord →`,
			href,
			sublabel: pairChannelId ? "Most recent A2A thread" : "Discord guild (navigate to the pair channel)",
			hint: `Pair channels live under the glon-a2a category. Each A2A conversation is its own thread.`,
		}));
	} else {
		els.peerChatLinks.appendChild(buildLinkButton({
			label: `Open Discord guild →`,
			href: discordGuildUrl(cfg.guild_id),
			sublabel: `${name} is ${kind || "a peer"}; navigate to the appropriate channel.`,
		}));
	}
}

export function stopPeerChatBindings() {
	if (els.peerChatSection) els.peerChatSection.hidden = true;
	clearChildren(els.peerChatLinks);
}

// ── Self peer inspect: link to the roster + guild ───────────────────

export async function startSelfChatList(_selfPeerObject) {
	if (!els.selfChatsSection || !els.selfChatsLinks) return;
	const cfg = await fetchDiscordConfig();
	els.selfChatsSection.hidden = false;
	clearChildren(els.selfChatsLinks);

	if (!cfg.guild_id) {
		renderMissingDiscord(els.selfChatsLinks);
		return;
	}

	if (cfg.roster_forum_id) {
		els.selfChatsLinks.appendChild(buildLinkButton({
			label: `📋 Open #roster (agent directory) →`,
			href: discordChannelUrl(cfg.guild_id, cfg.roster_forum_id),
			sublabel: "One forum post per agent; click any to chat",
		}));
	}
	els.selfChatsLinks.appendChild(buildLinkButton({
		label: `🛰️  Open the glon-a2a guild →`,
		href: discordGuildUrl(cfg.guild_id),
		sublabel: "Everything your agents talk about lives here",
	}));
}

export function stopSelfChatList() {
	if (els.selfChatsSection) els.selfChatsSection.hidden = true;
	clearChildren(els.selfChatsLinks);
}
