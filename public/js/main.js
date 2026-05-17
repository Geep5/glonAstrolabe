/**
 * Figgies UI — bootstrap.
 *
 * The old glonAstrolabe was a 3D visualizer over a content-addressed DAG.
 * That substrate is gone; this is now a small panel-based UI over the
 * Figgies family auction house.
 *
 * Panels live; the user toggles them via the spell bar at the bottom of
 * the screen (number keys 1-9, 0, A also work). State that's purely UI
 * (panel hidden/shown, position, size) persists in localStorage; data
 * comes from the Figgies daemon via /api/* HTTP routes.
 *
 * Future chat (human-to-human, human-to-agent, agent-to-agent) hooks
 * into the network + peer-chat + agent-chat scaffolding that's already
 * imported here — those modules render empty until the Figgies daemon
 * grows the matching programs.
 */

import { initAuctionsPanel } from "./auctions-panel.js";
import { initFamilyPanel } from "./family-panel.js";
import { initNetworkPanel } from "./network-panel.js";
import { initPeerChatPanel } from "./peer-chat-panel.js";
import { initAgentChats } from "./chat.js";
import { initSpellBar } from "./spell-bar.js";

// ── Layout reset (opt-in nuke of remembered panel positions) ─────────
// URL: ?reset-layout — wipes glonAstrolabe.* localStorage keys, reloads.
// Console: glonResetLayout()
function glonResetLayout() {
	const keys = [];
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k && k.startsWith("glonAstrolabe.")) keys.push(k);
	}
	for (const k of keys) localStorage.removeItem(k);
	console.info(`[figgies] reset ${keys.length} localStorage entr${keys.length === 1 ? "y" : "ies"}`);
	return keys.length;
}
window.glonResetLayout = glonResetLayout;
if (window.location?.search?.includes("reset-layout")) {
	glonResetLayout();
	const url = new URL(window.location.href);
	url.searchParams.delete("reset-layout");
	window.location.replace(url.toString());
}

async function init() {
	// Surface the local user in the header so it's obvious whose device you're on.
	try {
		const w = await fetch("/api/wallet").then((r) => r.json());
		const me = (w?.pubkeys ?? [])[0] ?? "unknown";
		const el = document.getElementById("me-name");
		if (el) el.textContent = me;
	} catch { /* daemon offline; header stays "…" */ }

	initFamilyPanel();
	initAuctionsPanel();
	initNetworkPanel();
	initPeerChatPanel();
	initAgentChats([]); // agents start empty; daemon will populate when /agent ships
	initSpellBar();
}

init().catch((err) => {
	console.error("[figgies] init failed:", err);
});
