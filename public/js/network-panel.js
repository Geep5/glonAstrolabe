// Network panel — Hyperswarm-discovered peers + peer-request approvals.
//
// Shows remote glons only. Each peer is rendered as a "host" row (the
// human principal, addressable via the inspector's Peer chats tab) with
// the glon's announced agent roster as indented sub-rows underneath.
// Your own local agents are NOT shown here — they live in the cosmos /
// inspector. Polls /api/network/{status,peers,requests} every POLL_MS.

const POLL_MS = 5_000;
const NETWORK_LIST = document.getElementById("network-list");
const NETWORK_REQUESTS = document.getElementById("network-requests");
const NETWORK_COUNT = document.getElementById("network-count");
const NETWORK_STATUS = document.getElementById("network-status");

let lastRender = "";

function shortKey(key) {
	if (!key || typeof key !== "string") return "";
	return key.length > 16 ? key.slice(0, 12) + "…" : key;
}

// 8-char hex suffix off the identity pubkey. Stable per-peer, always
// shown next to the agent name so two glons sharing a default name
// remain distinguishable. Falls back to hyperswarm_pubkey if identity
// isn't set yet (rare, only before /wallet bootstraps).
function peerSuffix(identityPubkey, hyperswarmPubkey) {
	const src = (identityPubkey && identityPubkey.length >= 8 ? identityPubkey : hyperswarmPubkey) || "";
	return src.slice(0, 8);
}

function trustClass(level) {
	if (level === "trusted") return "trusted";
	if (level === "discovered") return "discovered";
	return "";
}

// Render a millisecond timestamp as a compact relative-time string ("5m",
// "2h", "3d"). Used for the offline-peer "last seen" badge.
function shortAgo(ms) {
	if (!ms || typeof ms !== "number") return "";
	const dt = Date.now() - ms;
	if (dt < 60_000) return `${Math.max(1, Math.round(dt / 1000))}s`;
	if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m`;
	if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h`;
	return `${Math.round(dt / 86_400_000)}d`;
}

async function postAction(url, body) {
	const opts = { method: "POST", headers: { "Content-Type": "application/json" } };
	if (body !== undefined) opts.body = JSON.stringify(body);
	const res = await fetch(url, opts);
	const json = await res.json().catch(() => null);
	if (!res.ok || json?.ok === false) {
		throw new Error(json?.error ?? `HTTP ${res.status}`);
	}
	return json;
}

	async function refresh() {
		let status = null;
		let peers = [];
		let requests = [];
		let unreachable = false;
		try {
			const [s, p, r] = await Promise.all([
				fetch("/api/network/status").then((res) => res.json()),
				fetch("/api/network/peers").then((res) => res.json()),
				fetch("/api/network/requests").then((res) => res.json()),
			]);
			status = s?.status ?? null;
			peers = Array.isArray(p?.peers) ? p.peers : [];
			requests = Array.isArray(r?.requests) ? r.requests : [];
		} catch {
			unreachable = true;
		}

	// Pending incoming requests get a yellow inline strip above the peer list.
	const pendingIncoming = requests.filter((q) => q.direction === "incoming" && q.status === "waiting");
	const reqHtml = pendingIncoming.map((q) => {
		const id = q.request_id;
		const name = (q.peer_agent_name || "(unnamed)").replace(/[<>&]/g, "");
		return `<div class="network-request">
			<span><strong>${name}</strong> wants to peer</span>
			<button class="network-action" data-action="accept" data-id="${id}">accept</button>
			<button class="network-action decline" data-action="decline" data-id="${id}">decline</button>
		</div>`;
	}).join("");
	NETWORK_REQUESTS.innerHTML = reqHtml;

	// Peers, sorted: trusted first, then discovered, then by recency.
	peers.sort((a, b) => {
		const tA = (a.peer_object_id ? 1 : 0) + (a.identity_pubkey ? 0 : 0); // crude
		const tB = (b.peer_object_id ? 1 : 0) + (b.identity_pubkey ? 0 : 0);
		if (tA !== tB) return tB - tA;
		return (b.last_seen ?? 0) - (a.last_seen ?? 0);
	});

	// "You" row pinned at the top so users can see at a glance whether
	// they're announcing themselves into the directory (i.e. discoverable).
	// Represents the human principal of this glon — not any specific agent.
	const self = status?.self;
	const selfRow = self?.hyperswarm_pubkey ? (() => {
		const id = shortKey(self.identity_pubkey || self.hyperswarm_pubkey);
		const suffix = peerSuffix(self.identity_pubkey, self.hyperswarm_pubkey);
		const announcing = !!self.is_announcing;
		const stateLabel = announcing ? "discoverable" : "(not announcing yet)";
		return `<li class="network-row self">
			<span class="network-dot ${announcing ? "live" : ""}"></span>
			<span class="network-name" title="${id}">you<span class="peer-suffix">·${suffix}</span></span>
			<span class="network-action muted" title="hyperswarm pubkey ${id}">${stateLabel}</span>
		</li>`;
	})() : "";

	// Build a quick lookup of outgoing-waiting requests keyed by the peer's
	// hyperswarm pubkey so we can reflect "sent · waiting" on the row
	// without making it look clickable again.
	const outgoingPending = new Set(
		requests
			.filter((q) => q.direction === "outgoing" && q.status === "waiting")
			.map((q) => (q.peer_hyperswarm_pubkey || "").toLowerCase())
	);

	// Each peer is a remote glon → one "host" row (the human principal,
	// addressable for human-to-human chat) plus one indented sub-row per
	// agent on that glon. Online peers come from listDiscovered; offline
	// peers are trusted /peer records the server merged in so trusted
	// contacts stay visible across sleeps and network blips.
	// Sort: online first, then offline by last_seen desc.
	const sortedPeers = peers.slice().sort((a, b) => {
		const ao = a.is_online === false ? 1 : 0;
		const bo = b.is_online === false ? 1 : 0;
		if (ao !== bo) return ao - bo;
		return (b.last_seen ?? 0) - (a.last_seen ?? 0);
	});
	const rows = sortedPeers.map((p) => {
		// Trust level comes from /peer program via API merge.
		const trustLevel = p.trust_level || (p.peer_object_id ? "trusted" : "discovered");
		const id = shortKey(p.identity_pubkey || p.hyperswarm_pubkey);
		const suffix = peerSuffix(p.identity_pubkey, p.hyperswarm_pubkey);
		const hpLower = (p.hyperswarm_pubkey || "").toLowerCase();
		const isOnline = p.is_online !== false;        // true unless explicitly false
		const offlineClass = isOnline ? "" : "offline";
		const stateLabel = isOnline
			? ""
			: `<span class="offline-tag muted small" title="${p.last_seen ? new Date(p.last_seen).toISOString() : ''}">offline${p.last_seen ? ` · ${shortAgo(p.last_seen)}` : ""}</span>`;
		let action;
		if (trustLevel === "trusted") {
			// Peered → chat opens the host (principal) in the inspector,
			// where the Peer chats tab handles human-to-human messaging.
			// Offline peers keep the affordance — sends won't deliver
			// until they're back, but the user can still queue messages.
			action = `<button class="network-action" data-action="chat" data-peer-id="${p.peer_object_id ?? ""}" data-identity="${p.identity_pubkey ?? ""}">chat</button>`;
		} else if (outgoingPending.has(hpLower)) {
			action = `<button class="network-action muted" disabled>sent · waiting</button>`;
		} else {
			action = `<button class="network-action" data-action="peer" data-hyperswarm="${p.hyperswarm_pubkey}" data-identity="${p.identity_pubkey ?? ""}">peer with</button>`;
		}
		const hostRow = `<li class="network-row ${trustClass(trustLevel)} ${offlineClass}">
			<span class="network-dot"></span>
			<span class="network-name" title="${id}">host<span class="peer-suffix">·${suffix}</span>${stateLabel}</span>
			${action}
		</li>`;

		// Render the announced agent roster as nested sub-rows. Online
		// peers have a live `agents` array from their announce; offline
		// peers fall back to whatever remote_agent_peers /peer remembered.
		const remoteAgentPeers = Array.isArray(p.remote_agent_peers) ? p.remote_agent_peers : [];
		const peerIdByAgentId = new Map();
		for (const rp of remoteAgentPeers) {
			if (rp?.agent_id_remote && rp.id) peerIdByAgentId.set(rp.agent_id_remote, rp.id);
		}
		const remoteAgents = Array.isArray(p.agents) && p.agents.length > 0
			? p.agents
			: remoteAgentPeers.map((rp) => ({ id: rp.agent_id_remote, name: rp.display_name }));
		const agentSubRows = remoteAgents.map((a) => {
			const aName = (a.name || "(unnamed)").replace(/[<>&]/g, "");
			const aSuffix = (a.id || "").slice(0, 8);
			const subPeerId = peerIdByAgentId.get(a.id);
			const subAction = (trustLevel === "trusted" && subPeerId)
				? `<button class="network-action" data-action="chat" data-peer-id="${subPeerId}">chat</button>`
				: "";
			return `<li class="network-row remote-agent ${trustClass(trustLevel)} ${offlineClass}">
				<span class="network-dot"></span>
				<span class="network-name" title="${a.id || ""}">${aName}<span class="peer-suffix">·${aSuffix}</span></span>
				${subAction}
			</li>`;
		}).join("");

		return hostRow + agentSubRows;
	}).join("");

	NETWORK_LIST.innerHTML = selfRow + rows;
	NETWORK_COUNT.textContent = peers.length ? String(peers.length) : "";

	if (unreachable) {
		NETWORK_STATUS.textContent = "swarm offline (start daemon with GLON_SWARM=1)";
	} else if (status?.hyperswarm_pubkey) {
		NETWORK_STATUS.textContent = `${status.peers_connected ?? 0} connected · my pubkey ${shortKey(status.hyperswarm_pubkey)}`;
	} else {
		NETWORK_STATUS.textContent = "";
	}

	// Hash-based change check avoids unnecessary DOM churn.
	const sig = NETWORK_LIST.innerHTML + "|" + NETWORK_REQUESTS.innerHTML;
	if (sig !== lastRender) lastRender = sig;
}

function bindClicks() {
	const handler = async (e) => {
		const btn = e.target.closest("button.network-action");
		if (!btn || btn.disabled) return;
		const action = btn.dataset.action;
		btn.disabled = true;
		try {
			if (action === "peer") {
				const originalLabel = btn.textContent;
				btn.textContent = "sending…";
				try {
					const r = await postAction("/api/network/peer", { hyperswarm_pubkey: btn.dataset.hyperswarm, identity_pubkey: btn.dataset.identity });
					// Briefly flash "sent ✓" then re-render — the row stays
					// because trust isn't granted until they accept.
					btn.textContent = "sent ✓ · waiting";
					btn.classList.add("muted");
					console.info("[network] peer-request sent:", r?.result?.request_id);
					setTimeout(refresh, 1500);
				} catch (err) {
					btn.textContent = originalLabel || "peer with";
					btn.disabled = false;
					throw err;
				}
			} else if (action === "accept") {
				await postAction(`/api/network/requests/${encodeURIComponent(btn.dataset.id)}/accept`);
				setTimeout(refresh, 250);
			} else if (action === "decline") {
				await postAction(`/api/network/requests/${encodeURIComponent(btn.dataset.id)}/decline`);
				setTimeout(refresh, 250);
			} else if (action === "chat") {
				// Open this host (peer) in the inspector; user switches to
				// the Peer chats tab for human-to-human messaging.
				const peerId = btn.dataset.peerId;
				if (peerId) {
					try { window.glonSelectObject?.(peerId); } catch {}
				}
				btn.disabled = false;
			}
		} catch (err) {
			console.warn("[network] action failed:", err?.message ?? err);
			btn.disabled = false;
		}
	};
	NETWORK_LIST.addEventListener("click", handler);
	NETWORK_REQUESTS.addEventListener("click", handler);
}

export function initNetworkPanel() {
	if (!NETWORK_LIST) return;
	bindClicks();
	refresh();
	setInterval(refresh, POLL_MS);
}
