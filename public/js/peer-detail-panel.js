// Peer detail panel — opens when you click a peered remote glon's sun
// in the cosmos.
//
// Shows the connected host:
//   - Their HUMAN (the principal of the remote glon). Sun-to-sun chat;
//     opens the existing peer-chat overlay when clicked.
//   - Their AGENTS (from the roster announced in /api/network/peers
//     under scalars.agents_json — one row per agent). Each is clickable
//     to spawn a chat targeted at that specific agent.
//
// Until envelopes carry from_subentity_id / to_subentity_id, all chat
// clicks land in the SAME peer-chat conversation (one per glon). The
// per-agent rows are wired up regardless so the UX is in place when
// the per-agent addressing ships.

import { openPeerChat } from "./peer-chat-panel.js";

const PANEL  = document.getElementById("peer-detail");
const TITLE  = document.getElementById("peer-detail-title");
const BODY   = document.getElementById("peer-detail-body");
const CLOSE  = document.getElementById("peer-detail-close");

const state = {
	open: false,
	identity_pubkey: null,
};

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function shortKey(s) { return (typeof s === "string" && s.length >= 8) ? s.slice(0, 8) : ""; }

function parseRoster(peer) {
	// /api/network/peers passes the announced roster through directly as
	// `peer.agents` (added in DiscoveredPeer state). Fallback handles
	// legacy paths where the roster was JSON-encoded on a /peer field.
	if (Array.isArray(peer?.agents)) {
		return peer.agents.filter((a) => a && typeof a.name === "string");
	}
	const json = peer?.agents_json;
	if (typeof json !== "string" || json.length === 0) return [];
	try {
		const arr = JSON.parse(json);
		return Array.isArray(arr) ? arr.filter((a) => a && typeof a.name === "string") : [];
	} catch { return []; }
}

function render(peer) {
	if (!peer) {
		BODY.innerHTML = `<div class="peer-detail-empty muted small">No peer data yet.</div>`;
		return;
	}
	const hostName  = (peer.peer_display_name || peer.display_name || "(unnamed host)").replace(/[<>&]/g, "");
	const idp       = peer.peer_identity_pubkey || peer.identity_pubkey || "";
	const idpSuf    = shortKey(idp);
	const roster    = parseRoster(peer);
	TITLE.textContent = `${hostName}${idpSuf ? " · " + idpSuf : ""}`;
	const hostRow = `
		<div class="peer-detail-section">
			<div class="peer-detail-section-title">Host</div>
			<button class="peer-detail-row peer-detail-host" data-kind="host" data-identity="${escapeHtml(idp)}" data-name="${escapeHtml(hostName)}">
				<span class="peer-detail-dot peer-detail-dot-sun"></span>
				<span class="peer-detail-row-name">${escapeHtml(hostName)}</span>
				<span class="peer-detail-row-tag">sun</span>
			</button>
		</div>`;
	const agentRows = roster.length === 0
		? `<div class="peer-detail-empty muted small">No agents announced yet.<br><span class="muted small">Their announce will include a roster on next cycle once both glons are on protocol_version=1.</span></div>`
		: roster.map((a) => `
			<button class="peer-detail-row peer-detail-agent" data-kind="agent" data-identity="${escapeHtml(idp)}" data-name="${escapeHtml(hostName)}" data-agent-id="${escapeHtml(a.id || "")}" data-agent-name="${escapeHtml(a.name || "")}">
				<span class="peer-detail-dot peer-detail-dot-agent"></span>
				<span class="peer-detail-row-name">${escapeHtml(a.name)}</span>
				<span class="peer-detail-row-tag">agent</span>
			</button>`).join("");
	BODY.innerHTML = `${hostRow}<div class="peer-detail-section"><div class="peer-detail-section-title">Agents (${roster.length})</div>${agentRows}</div>`;
}

async function fetchPeer(identity_pubkey) {
	try {
		const r = await fetch("/api/network/peers").then((res) => res.json());
		const peers = r?.peers ?? [];
		return peers.find((p) => (p.identity_pubkey || "").toLowerCase() === (identity_pubkey || "").toLowerCase()) ?? null;
	} catch { return null; }
}

export async function openPeerDetail({ identity_pubkey, display_name }) {
	if (!PANEL) return;
	if (!identity_pubkey) {
		console.warn("[peer-detail] openPeerDetail: identity_pubkey required");
		return;
	}
	state.identity_pubkey = identity_pubkey;
	state.open = true;
	PANEL.hidden = false;
	// Optimistic render with what we already know from the click, then
	// fetch fresh roster from the API (which has the parsed agents_json).
	render({
		peer_identity_pubkey: identity_pubkey,
		peer_display_name: display_name,
	});
	const peer = await fetchPeer(identity_pubkey);
	if (state.open && state.identity_pubkey === identity_pubkey && peer) render(peer);
}

export function closePeerDetail() {
	state.open = false;
	if (PANEL) PANEL.hidden = true;
}

export function initPeerDetailPanel() {
	if (!PANEL) return;
	CLOSE?.addEventListener("click", closePeerDetail);
	BODY?.addEventListener("click", (e) => {
		const row = e.target.closest("[data-kind]");
		if (!row) return;
		const kind = row.dataset.kind;
		// In v1, every chat ride the same peer-chat conversation (one
		// per glon). Once envelopes carry from_subentity_id, the agent
		// row will pass through agent-id and the chat-panel can route
		// to the per-agent conversation. For now both kinds spawn the
		// host-level chat.
		openPeerChat({
			identity_pubkey: row.dataset.identity,
			display_name: kind === "agent"
				? `${row.dataset.name} → ${row.dataset.agentName}`
				: row.dataset.name,
		});
	});
	PANEL.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closePeerDetail();
	});
}
