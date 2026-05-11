// Topbar mining toggle.
//
// Fetches /api/anchor/status on init; renders the current state on the
// #mining-toggle button; clicks POST /api/anchor/enabled to flip it.
// Hides itself silently if the daemon is unreachable (e.g. read-only
// viewer) — astrolabe still works without it.

const STATUS_URL = "/api/anchor/status";
const TOGGLE_URL = "/api/anchor/enabled";
const REFRESH_MS = 30_000;

let lastEnabled = null;

function setLabel(button, enabled, extra) {
	const label = button.querySelector(".mining-label");
	if (label) label.textContent = enabled ? "mining: ON" : "mining: OFF";
	button.dataset.enabled = enabled ? "on" : "off";
	button.title = enabled
		? "FIG mining ON — anchors every 60s. Click to pause."
		: "FIG mining OFF — no anchor blocks. Click to resume.";
	if (extra) button.title += `\n${extra}`;
	button.hidden = false;
	button.disabled = false;
	lastEnabled = enabled;
}

async function fetchStatus(button) {
	try {
		const r = await fetch(STATUS_URL);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const body = await r.json();
		if (!body?.ok) throw new Error(body?.error ?? "unknown error");
		const s = body.status ?? {};
		const enabled = !!s.enabled;
		const extra = s.last_anchor_height >= 0
			? `height ${s.last_anchor_height} · reward ${s.next_reward_units} ${s.reward_symbol}`
			: "no anchors yet";
		setLabel(button, enabled, extra);
	} catch (err) {
		// Daemon unreachable / not wired — hide silently rather than spam errors.
		button.hidden = true;
	}
}

async function toggle(button) {
	if (lastEnabled === null) return;
	const target = !lastEnabled;
	button.disabled = true;
	const oldLabel = button.querySelector(".mining-label")?.textContent;
	const labelEl = button.querySelector(".mining-label");
	if (labelEl) labelEl.textContent = target ? "starting…" : "stopping…";
	try {
		const r = await fetch(TOGGLE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: target }),
		});
		const body = await r.json().catch(() => null);
		if (!r.ok || !body?.ok) {
			if (labelEl && oldLabel) labelEl.textContent = oldLabel;
			button.disabled = false;
			console.warn("[mining-toggle] failed:", body?.error ?? `HTTP ${r.status}`);
			return;
		}
		setLabel(button, target);
	} catch (err) {
		if (labelEl && oldLabel) labelEl.textContent = oldLabel;
		button.disabled = false;
		console.warn("[mining-toggle] error:", err?.message ?? String(err));
	}
}

export function initMiningToggle() {
	const button = document.getElementById("mining-toggle");
	if (!button) return;
	button.addEventListener("click", () => toggle(button));
	fetchStatus(button);
	setInterval(() => fetchStatus(button), REFRESH_MS);
}
