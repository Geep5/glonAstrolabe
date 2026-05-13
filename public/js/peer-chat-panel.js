// Peer-chat panel — floating overlay shown when the user clicks a peered
// row in the Network panel. Polls /api/peer-chat/messages for the open
// conversation every PEER_CHAT_POLL_MS; posts new messages via
// /api/peer-chat/send.
//
// State is intentionally minimal: one `current` object describing which
// peer the panel is bound to, plus a `lastSentAt` watermark so polls
// only fetch new messages. Re-renders the full message list each tick;
// dedupes by msg_id since outbound messages are echoed locally on send.

const PEER_CHAT_POLL_MS = 2_000;

const PEER_CHAT = document.getElementById("peer-chat");
const PEER_CHAT_TITLE = document.getElementById("peer-chat-title");
const PEER_CHAT_MESSAGES = document.getElementById("peer-chat-messages");
const PEER_CHAT_FORM = document.getElementById("peer-chat-compose");
const PEER_CHAT_INPUT = document.getElementById("peer-chat-input");
const PEER_CHAT_SEND = document.getElementById("peer-chat-send");
const PEER_CHAT_STATUS = document.getElementById("peer-chat-status");
const PEER_CHAT_CLOSE = document.getElementById("peer-chat-close");

const state = {
	open: false,
	identity_pubkey: null,         // hex string identifying the peer
	display_name: null,
	messagesById: new Map(),       // msg_id → message; dedup across polls + local echo
	pollHandle: null,
	pollInflight: false,
};

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shortKey(s) {
	if (!s || typeof s !== "string") return "";
	return s.slice(0, 8);
}

function renderMessages() {
	try {
		const msgs = [...state.messagesById.values()].sort((a, b) => (a.sent_at || 0) - (b.sent_at || 0));
		if (msgs.length === 0) {
			if (PEER_CHAT_MESSAGES) PEER_CHAT_MESSAGES.innerHTML = `<li class="peer-chat-empty muted small">No messages yet. Say hello.</li>`;
			return;
		}
		const wasAtBottom = isScrolledToBottom();
		if (!PEER_CHAT_MESSAGES) { console.warn("[peer-chat] PEER_CHAT_MESSAGES element missing"); return; }
		PEER_CHAT_MESSAGES.innerHTML = msgs.map((m) => {
			const cls = m.direction === "out" ? "out" : "in";
			const tsRaw = m.sent_at ? new Date(m.sent_at) : null;
			const ts = tsRaw && !isNaN(tsRaw.getTime())
				? tsRaw.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				: "";
			let body;
			if (m.kind === "text") {
				body = escapeHtml(String(m.body ?? ""));
			} else {
				body = `<span class="peer-chat-kind">[${escapeHtml(String(m.kind))}]</span> <code>${escapeHtml(JSON.stringify(m.body))}</code>`;
			}
			return `<li class="peer-chat-msg peer-chat-msg-${cls}"><span class="peer-chat-body">${body}</span><span class="peer-chat-ts muted">${ts}</span></li>`;
		}).join("");
		if (wasAtBottom) scrollToBottom();
	} catch (err) {
		console.error("[peer-chat] renderMessages crashed:", err);
	}
}

function isScrolledToBottom() {
	const el = PEER_CHAT_MESSAGES;
	if (!el) return true;
	return (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
}
function scrollToBottom() {
	if (PEER_CHAT_MESSAGES) PEER_CHAT_MESSAGES.scrollTop = PEER_CHAT_MESSAGES.scrollHeight;
}

async function poll() {
	if (!state.open || !state.identity_pubkey) return;
	if (state.pollInflight) return;
	state.pollInflight = true;
	try {
		const res = await fetch(`/api/peer-chat/messages?identity_pubkey=${encodeURIComponent(state.identity_pubkey)}`);
		const json = await res.json().catch(() => null);
		console.log("[peer-chat] poll:", res.status, "messages count:", (json?.messages ?? []).length);
		if (!res.ok || json?.ok === false) {
			PEER_CHAT_STATUS.textContent = json?.error ? `poll error: ${json.error}` : `HTTP ${res.status}`;
			return;
		}
		PEER_CHAT_STATUS.textContent = "";
		let changed = false;
		for (const m of json.messages ?? []) {
			if (!state.messagesById.has(m.msg_id)) {
				state.messagesById.set(m.msg_id, m);
				changed = true;
			}
		}
		if (changed) {
			renderMessages();
			console.log("[peer-chat] poll: rendered", state.messagesById.size, "messages");
		}
		// Mark read so the unread badge can clear on the daemon side.
		// Best-effort; ignore failures.
		fetch("/api/peer-chat/mark-read", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identity_pubkey: state.identity_pubkey }),
		}).catch(() => {});
	} catch (err) {
		console.error("[peer-chat] poll: network error", err);
		PEER_CHAT_STATUS.textContent = `network: ${err?.message ?? String(err)}`;
	} finally {
		state.pollInflight = false;
	}
}

async function sendMessage(text) {
	if (!state.identity_pubkey || !text) return;
	PEER_CHAT_SEND.disabled = true;
	PEER_CHAT_INPUT.disabled = true;
	PEER_CHAT_STATUS.textContent = "sending...";
	// Optimistically insert so the user sees immediate feedback.
	const tmpId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const optimistic = {
		msg_id: tmpId,
		direction: "out",
		kind: "text",
		in_reply_to: null,
		body: text,
		sent_at: Date.now(),
	};
	state.messagesById.set(tmpId, optimistic);
	renderMessages();
	console.log("[peer-chat] sendMessage: optimistic inserted, tmpId=", tmpId, "map size=", state.messagesById.size);
	try {
		const res = await fetch("/api/peer-chat/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identity_pubkey: state.identity_pubkey, text }),
		});
		const json = await res.json().catch(() => null);
		console.log("[peer-chat] sendMessage: response", res.status, json);
		if (!res.ok || json?.ok === false) {
			PEER_CHAT_STATUS.textContent = json?.error || `send failed (HTTP ${res.status})`;
			state.messagesById.delete(tmpId);
			renderMessages();
			return false;
		}
		PEER_CHAT_STATUS.textContent = "";
		if (json?.result?.msg_id) {
			state.messagesById.delete(tmpId);
			state.messagesById.set(json.result.msg_id, {
				...optimistic,
				msg_id: json.result.msg_id,
			});
			renderMessages();
			console.log("[peer-chat] sendMessage: replaced tmpId with real msg_id", json.result.msg_id);
		}
		poll();
		return true;
	} catch (err) {
		console.error("[peer-chat] sendMessage: network error", err);
		PEER_CHAT_STATUS.textContent = `network: ${err?.message ?? String(err)}`;
		state.messagesById.delete(tmpId);
		renderMessages();
		return false;
	} finally {
		PEER_CHAT_SEND.disabled = false;
		PEER_CHAT_INPUT.disabled = false;
		PEER_CHAT_INPUT.focus();
	}
}

export function openPeerChat({ identity_pubkey, display_name }) {
	if (!PEER_CHAT) return;
	if (!identity_pubkey) {
		console.warn("[peer-chat] openPeerChat: identity_pubkey required");
		return;
	}
	// If switching peers, clear the buffer so old messages don't bleed in.
	if (state.identity_pubkey !== identity_pubkey) {
		console.log("[peer-chat] openPeerChat: switching peer from", state.identity_pubkey, "to", identity_pubkey, "- clearing messages");
		state.messagesById = new Map();
	}
	state.identity_pubkey = identity_pubkey;
	state.display_name = display_name || "(unnamed)";
	state.open = true;
	const suffix = shortKey(identity_pubkey);
	PEER_CHAT_TITLE.textContent = `${state.display_name} · ${suffix}`;
	PEER_CHAT.hidden = false;
	renderMessages();
	if (state.pollHandle) clearInterval(state.pollHandle);
	state.pollHandle = setInterval(poll, PEER_CHAT_POLL_MS);
	poll();
	setTimeout(() => PEER_CHAT_INPUT.focus(), 0);
	console.log("[peer-chat] openPeerChat: opened for", identity_pubkey, "messages:", state.messagesById.size);
}

export function closePeerChat() {
	state.open = false;
	if (state.pollHandle) { clearInterval(state.pollHandle); state.pollHandle = null; }
	if (PEER_CHAT) PEER_CHAT.hidden = true;
}

export function initPeerChatPanel() {
	if (!PEER_CHAT) return;
	PEER_CHAT_CLOSE?.addEventListener("click", closePeerChat);
	PEER_CHAT_FORM?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const text = PEER_CHAT_INPUT.value.trim();
		if (!text) return;
		PEER_CHAT_INPUT.value = "";
		const ok = await sendMessage(text);
		if (!ok) {
			// Put text back so the user can retry.
			PEER_CHAT_INPUT.value = text;
		}
	});
	// ESC closes the panel when focused inside it.
	PEER_CHAT.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closePeerChat();
	});
}
