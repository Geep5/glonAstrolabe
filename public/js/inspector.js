/**
 * Inspector panel — renders object detail, change DAG, link list,
 * and agent summary into the right-side panel. Pure DOM builder:
 * nothing here knows about three.js.
 */

	import { colorForType } from "./colors.js";
	import { getRender } from "./planet-styles.js";
	import * as planetForge from "./planet-forge.js";


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
		styleSection: document.getElementById("insp-style-section"),
		forgeHistory: document.getElementById("insp-forge-history"),
		forgeStatus: document.getElementById("insp-forge-status"),
		forgeInput: document.getElementById("insp-forge-input"),
		forgeSend: document.getElementById("insp-forge-send"),
		forgeApply: document.getElementById("insp-forge-apply"),
		forgeReset: document.getElementById("insp-forge-reset"),
		forgeKey: document.getElementById("insp-forge-key"),
		forgeKeySave: document.getElementById("insp-forge-key-save"),
		stats: document.getElementById("stats"),
		// Agent tab UI
		agentTabs: document.getElementById("insp-agent-tabs"),
		paneChat: document.getElementById("insp-pane-chat"),
		panePeers: document.getElementById("insp-pane-peers"),
		chatHistory: document.getElementById("insp-chat-history"),
		chatForm: document.getElementById("insp-chat-form"),
		chatInput: document.getElementById("insp-chat-input"),
		chatSend: document.getElementById("insp-chat-send"),
		chatStatus: document.getElementById("insp-chat-status"),
		peersList: document.getElementById("insp-peers-list"),
		peersEmpty: document.getElementById("insp-peers-empty"),
		peersCount: document.getElementById("insp-peers-count"),
	};

	// Wire up Planet Forge once
	planetForge.init({
		historyEl: els.forgeHistory,
		statusEl: els.forgeStatus,
		inputEl: els.forgeInput,
		sendBtn: els.forgeSend,
		applyBtn: els.forgeApply,
		resetBtn: els.forgeReset,
		keyInput: els.forgeKey,
		keySaveBtn: els.forgeKeySave,
	});
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
	// If this is an agent, start the in-inspector chat + peer-chat polling.
	if (detail?.object?.typeKey === "agent") {
		startAgentChatBindings(detail.object);
	} else {
		stopAgentChatBindings();
	}
}

export function clear() {
	currentId = null;
	stopAgentChatBindings();
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
	els.scalarsSection.hidden = true;
	els.linksSection.hidden = true;
	els.styleSection.hidden = true;
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
		append(els.agentStats, row("effective tokens", `≈${formatNumber(s.effectiveTokens)}`));
		append(els.agentStats, row("tools registered", String(s.toolCount)));
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


	// Coin buckets are gone — fungible balances now live in the autobase
	// hyperbee view at `balance/<token>/<pubkey>`, not as chain.coin.bucket
	// objects. The inspector defers coin display to the Coins panel.

	// Style section (all objects) --------------------------------
	renderStyleSection(obj.id);

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
		if (ch.authType) {
			const badge = document.createElement("span");
			badge.className = "auth-badge";
			badge.textContent = ch.authType;
			ops.appendChild(badge);
		}
		row.appendChild(dot); row.appendChild(hash); row.appendChild(ops);
		els.changes.appendChild(row);
	}
}


	// ── Style section ────────────────────────────────────────────

	function renderStyleSection(objectId) {
		els.styleSection.hidden = false;
		planetForge.setTarget(objectId);

		if (!els.styleSection._wired) {
			els.styleSection._wired = true;
			const header = els.styleSection.querySelector(".collapsible");
			const body = document.getElementById("insp-style-body");
			if (header && body) {
				header.addEventListener("click", () => {
					const isHidden = body.style.display === "none";
					body.style.display = isHidden ? "block" : "none";
					header.classList.toggle("expanded", isHidden);
				});
			}
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

// ── In-inspector agent chat + peer-chats ──────────────────────────
//
// When an agent is selected, two tabs appear inside the inspector:
//   Chat        — the LLM conversation (user_text / assistant_text / tool_use / tool_result)
//   Peer chats  — A2A conversations this agent has over /peer-chat
// Both poll every 2s while the inspector is showing this agent. The
// floating chat-dock from chat.js is gone — chat lives here now.

const CHAT_POLL_MS = 2_000;
let chatPollHandle = null;
let chatAgentId = null;
let lastChatRender = "";
let lastPeersRender = "";
let chatTabsWired = false;
let chatFormWired = false;
let activePane = "chat";
const expandedPeers = new Set(); // identity_pubkeys currently expanded

function wireChatTabsOnce() {
	if (chatTabsWired) return;
	chatTabsWired = true;
	if (!els.agentTabs) return;
	for (const btn of els.agentTabs.querySelectorAll(".insp-tab")) {
		btn.addEventListener("click", () => {
			activePane = btn.dataset.pane;
			for (const t of els.agentTabs.querySelectorAll(".insp-tab")) {
				t.classList.toggle("active", t === btn);
			}
			els.paneChat.hidden = activePane !== "chat";
			els.panePeers.hidden = activePane !== "peers";
			// Force a fresh paint when switching tabs.
			if (chatAgentId) {
				lastChatRender = "";
				lastPeersRender = "";
				pollAgentChat();
			}
		});
	}
}

function wireChatFormOnce() {
	if (chatFormWired) return;
	chatFormWired = true;
	if (!els.chatForm) return;
	els.chatForm.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!chatAgentId) return;
		const text = els.chatInput.value.trim();
		if (!text) return;
		els.chatInput.value = "";
		els.chatInput.disabled = true;
		els.chatSend.disabled = true;
		els.chatStatus.textContent = "sending…";
		try {
			const r = await fetch(`/api/agents/${encodeURIComponent(chatAgentId)}/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: text }),
			});
			const data = await r.json().catch(() => null);
			if (!r.ok || data?.ok === false) {
				throw new Error(data?.error ?? `HTTP ${r.status}`);
			}
			els.chatStatus.textContent = "thinking…";
		} catch (err) {
			els.chatStatus.textContent = `failed: ${err?.message ?? String(err)}`;
		} finally {
			els.chatInput.disabled = false;
			els.chatSend.disabled = false;
			els.chatInput.focus();
			// Force a refresh so the user's message lands immediately.
			lastChatRender = "";
			pollAgentChat();
		}
	});
}

export function startAgentChatBindings(agentObject) {
	wireChatTabsOnce();
	wireChatFormOnce();
	const newAgentId = agentObject.id;
	if (chatAgentId === newAgentId) return;
	stopAgentChatBindings();
	chatAgentId = newAgentId;
	activePane = "chat";
	for (const t of els.agentTabs.querySelectorAll(".insp-tab")) {
		t.classList.toggle("active", t.dataset.pane === "chat");
	}
	els.paneChat.hidden = false;
	els.panePeers.hidden = true;
	lastChatRender = "";
	lastPeersRender = "";
	expandedPeers.clear();
	els.chatHistory.innerHTML = "";
	els.peersList.innerHTML = "";
	els.chatStatus.textContent = "";
	pollAgentChat();
	chatPollHandle = setInterval(pollAgentChat, CHAT_POLL_MS);
}

export function stopAgentChatBindings() {
	if (chatPollHandle) {
		clearInterval(chatPollHandle);
		chatPollHandle = null;
	}
	chatAgentId = null;
}

async function pollAgentChat() {
	const id = chatAgentId;
	if (!id) return;
	// Only fetch what we're showing. Chat tab → conversation. Peers tab → peer-chat list.
	if (activePane === "chat") {
		await refreshChatPane(id);
	} else {
		await refreshPeersPane(id);
	}
	// Always refresh the peers count badge so it stays accurate from any tab.
	refreshPeersCount().catch(() => {});
}

async function refreshChatPane(id) {
	try {
		const r = await fetch(`/api/agents/${encodeURIComponent(id)}/conversation`);
		if (!r.ok) return;
		const data = await r.json();
		const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
		// Filter to user-visible block kinds; keep tool_use+tool_result as muted rows.
		const visible = blocks.filter((b) =>
			b.kind === "user_text" ||
			b.kind === "assistant_text" ||
			b.kind === "tool_use" ||
			b.kind === "tool_result",
		);
		const html = visible.map((b) => {
			if (b.kind === "user_text") {
				return `<li class="user"><span class="role">you</span>${escapeHtml(b.text ?? "")}</li>`;
			}
			if (b.kind === "assistant_text") {
				return `<li class="assistant"><span class="role">${escapeHtml(b.agentName ?? "agent")}</span>${escapeHtml(b.text ?? "")}</li>`;
			}
			if (b.kind === "tool_use") {
				const name = b.toolName ?? "tool";
				const preview = b.input ? `(${truncate(JSON.stringify(b.input), 100)})` : "";
				return `<li class="tool"><span class="role">tool · ${escapeHtml(name)}</span>${escapeHtml(preview)}</li>`;
			}
			if (b.kind === "tool_result") {
				const err = b.isError ? " · error" : "";
				return `<li class="tool"><span class="role">result${err}</span>${escapeHtml(truncate(b.content ?? "", 200))}</li>`;
			}
			return "";
		}).join("");
		if (html !== lastChatRender) {
			els.chatHistory.innerHTML = html || `<li class="tool" style="text-align:center"><span class="role">empty</span>Say hi to this agent.</li>`;
			lastChatRender = html;
			els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
		}
		// Clear "thinking…" once a new assistant_text lands after a user_text.
		if (visible.length > 0 && visible[visible.length - 1].kind === "assistant_text") {
			els.chatStatus.textContent = "";
		}
	} catch { /* swallow polling errors */ }
}

async function refreshPeersPane(id) {
	const convos = await fetchAgentConvos(id);
	const html = convos.map((c) => {
		const convId = c.conversation_id ?? c.peer_identity_pubkey;
		const peerName = c.peer_display_name || shortId(c.peer_identity_pubkey ?? "");
		const lastTs = c.last_message_at ? formatTime(c.last_message_at) : "";
		const lastPreview = truncate(c.last_message_preview ?? "", 80);
		const unread = c.unread_count ? ` <span class="muted small">· ${c.unread_count} unread</span>` : "";
		const isOpen = expandedPeers.has(convId);
		const status = c.status ?? "active";
		const statusGlyph = status === "active" ? "●" : status === "done" ? "✓" : "⏸";
		const statusClass = status === "active" ? "active" : status === "done" ? "done" : "paused";
		const goal = c.goal ? truncate(c.goal, 80) : "";
		const meta = [];
		if (status === "active" && typeof c.hops_remaining === "number") meta.push(`${c.hops_remaining} hops left`);
		if (c.message_count) meta.push(`${c.message_count} msg${c.message_count === 1 ? "" : "s"}`);
		if (status === "done" && c.ended_reason) meta.push(`ended: ${truncate(c.ended_reason, 40)}`);
		if (status === "paused") meta.push(`paused at ${c.message_count} hops`);
		if (typeof c.resumed_count === "number" && c.resumed_count > 0) meta.push(`resumed ${c.resumed_count}×`);
		const metaStr = meta.join(" · ");
		const pauseActions = status === "paused"
			? `<div class="insp-peer-actions">
				<button class="insp-peer-btn primary" data-act="resume" data-conv="${escapeHtml(convId)}">Continue</button>
				<button class="insp-peer-btn ghost"   data-act="end"    data-conv="${escapeHtml(convId)}">End conversation</button>
			   </div>`
			: "";
		return `
			<li class="insp-peer-li ${statusClass}">
				<div class="insp-peer-row" data-conv="${escapeHtml(convId)}">
					<div>
						<div class="name">
							<span class="insp-conv-status ${statusClass}" title="${escapeHtml(status)}">${statusGlyph}</span>
							${escapeHtml(peerName)}${unread}
						</div>
						${goal ? `<div class="last"><span class="muted">goal:</span> ${escapeHtml(goal)}</div>` : ""}
						<div class="last">${escapeHtml(lastPreview)}</div>
						${metaStr ? `<div class="last muted small">${escapeHtml(metaStr)}</div>` : ""}
					</div>
					<div class="when">${escapeHtml(lastTs)}</div>
				</div>
				${pauseActions}
				${isOpen ? `<div class="insp-peer-expand" data-expand="${escapeHtml(convId)}"></div>` : ""}
			</li>
		`;
	}).join("");
	if (html !== lastPeersRender) {
		els.peersList.innerHTML = html;
		lastPeersRender = html;
		els.peersEmpty.hidden = convos.length > 0;
		// Re-wire row clicks.
		for (const row of els.peersList.querySelectorAll(".insp-peer-row")) {
			row.addEventListener("click", (e) => {
				if (e.target?.closest?.(".insp-peer-btn")) return; // don't expand when clicking action buttons
				const cid = row.dataset.conv;
				if (expandedPeers.has(cid)) expandedPeers.delete(cid);
				else expandedPeers.add(cid);
				lastPeersRender = "";
				refreshPeersPane(id);
			});
		}
		// Pause-state action buttons (Continue / End)
		for (const btn of els.peersList.querySelectorAll(".insp-peer-btn")) {
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const cid = btn.dataset.conv;
				const act = btn.dataset.act;
				btn.disabled = true;
				try {
					if (act === "resume") {
						await fetch("/api/peer-chat/resume", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ conversation_id: cid }),
						});
					} else if (act === "end") {
						const reason = window.prompt("Reason for ending this conversation?", "user closed via inspector") ?? "user closed";
						await fetch("/api/peer-chat/end", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ conversation_id: cid, reason }),
						});
					}
					lastPeersRender = "";
					await refreshPeersPane(id);
				} catch (err) {
					console.warn("[peer-chat]", act, "failed", err);
					btn.disabled = false;
				}
			});
		}
	}
	// Populate any expanded rows with their message list.
	for (const expandEl of els.peersList.querySelectorAll("[data-expand]")) {
		const cid = expandEl.getAttribute("data-expand");
		try {
			const r = await fetch(`/api/peer-chat/messages?conversation_id=${encodeURIComponent(cid)}`);
			const data = await r.json();
			const msgs = Array.isArray(data?.messages) ? data.messages : [];
			expandEl.innerHTML = msgs.map((m) => {
				const dir = m.direction === "out" ? "out" : "in";
				const body = typeof m.body === "string" ? m.body : JSON.stringify(m.body);
				return `<div class="insp-peer-msg ${dir}"><span class="ts">${escapeHtml(formatTime(m.sent_at))}</span> ${escapeHtml(truncate(body, 400))}</div>`;
			}).join("") || `<div class="muted small">No messages yet.</div>`;
		} catch {
			expandEl.innerHTML = `<div class="muted small">(messages unreachable)</div>`;
		}
	}
}

async function fetchAgentConvos(agentId) {
	// v2 schema: conversations carry owner_agent_id (which local agent's
	// perspective this entry is) and peer_identity_pubkey="local:<other>".
	// Filter to entries OWNED by the current agent — drops the mirror that
	// belongs to the other agent.
	try {
		const r = await fetch("/api/peer-chat/conversations");
		const data = await r.json();
		const all = Array.isArray(data?.conversations) ? data.conversations : [];
		if (!agentId) return all;
		const ownLocal = `local:${agentId}`.toLowerCase();
		return all.filter((c) => {
			// Schema v2: prefer owner_agent_id when present.
			if (c.owner_agent_id) return c.owner_agent_id === agentId;
			// Fallback (legacy or cross-machine): drop conversations whose peer IS this agent.
			return (c.peer_identity_pubkey ?? "").toLowerCase() !== ownLocal;
		});
	} catch { return []; }
}

async function refreshPeersCount() {
	const convos = await fetchAgentConvos(chatAgentId);
	if (els.peersCount) els.peersCount.textContent = convos.length > 0 ? `(${convos.length})` : "";
}

function truncate(s, n) {
	if (!s) return "";
	const str = String(s);
	return str.length > n ? str.slice(0, n - 1) + "…" : str;
}
