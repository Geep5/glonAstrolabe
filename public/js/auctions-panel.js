// Auctions panel — live view of the autobase auction house.
//
// Polls /api/auctions and /api/auction/status every AUCTIONS_POLL_MS,
// renders rows into #auctions-list. Each row shows the give/want assets,
// status, and (for the seller's own auctions) a Cancel button.
//
// If /api/auction/status returns 503, the panel hides itself —
// daemon was started without GLON_AUCTION=1.

const POLL_MS = 5_000;

let AUCTIONS_PANEL  = null;
let AUCTIONS_LIST   = null;
let AUCTIONS_COUNT  = null;
let AUCTIONS_STATUS = null;
let lastRender = "";

function shortKey(key) {
	if (!key || typeof key !== "string") return "";
	return key.length > 16 ? key.slice(0, 12) + "…" : key;
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmtAsset(a) {
	if (!a) return "";
	if (a.object_id) return `<span class="asset-obj">${escapeHtml(a.object_id)}</span>`;
	if (a.token && a.amount) return `<span class="asset-fungible"><b>${escapeHtml(a.amount)}</b> ${escapeHtml(a.token.slice(0, 8))}</span>`;
	return "<span class='asset-unknown'>?</span>";
}

function statusBadge(status) {
	const cls = (status === "open") ? "ok"
		: (status === "settled") ? "info"
		: (status === "cancelled") ? "muted"
		: (status === "expired") ? "muted"
		: "warn";
	return `<span class="auction-status ${cls}">${escapeHtml(status ?? "?")}</span>`;
}

/** Render "23h 45m" / "12m" / "in 3s" / "expired 5m ago". Compact + drift-aware. */
function expiryLabel(auction, nowMs) {
	if (!auction || typeof auction.expiry_ms !== "number") return "";
	if (auction.status === "expired") {
		const ago = Math.max(0, Math.floor((nowMs - (auction.expired_at ?? auction.expiry_ms)) / 1000));
		return `expired ${formatSecsAgo(ago)}`;
	}
	if (auction.status !== "open") return ""; // settled/cancelled — irrelevant
	const remainSec = Math.floor((auction.expiry_ms - nowMs) / 1000);
	if (remainSec <= 0) return "stale (past deadline)";
	return formatSecsRemaining(remainSec);
}

function formatSecsRemaining(s) {
	if (s < 60) return `in ${s}s`;
	if (s < 3600) return `in ${Math.floor(s / 60)}m`;
	if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
	return `in ${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function formatSecsAgo(s) {
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

async function postAction(url, body) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const json = await res.json().catch(() => null);
	if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
	return json;
}

async function refresh() {
	let status = null;
	let auctions = [];
	let unreachable = false;
	try {
		const [s, a] = await Promise.all([
			fetch("/api/auction/status").then((r) => r.json()),
			fetch("/api/auctions").then((r) => r.json()),
		]);
		if (s?.ok) status = s.status;
		else unreachable = true;
		if (a?.ok) auctions = a.auctions ?? [];
	} catch {
		unreachable = true;
	}

	if (unreachable || !status || !status.bootstrap_key) {
		AUCTIONS_PANEL.hidden = true;
		return;
	}
	AUCTIONS_PANEL.hidden = false;

	const writerShort = shortKey(status.writer_pubkey);
	AUCTIONS_COUNT.textContent = String(auctions.length);
	AUCTIONS_STATUS.textContent = `writer ${writerShort} · ${status.view_length ?? 0} view entries · ${status.system_length ?? 0} ops`;

	// Sort: open auctions first, then settled, then cancelled, then expired.
	// Within each bucket, newest created_at first.
	const order = { open: 0, settled: 1, cancelled: 2, expired: 3 };
	const sorted = [...auctions].sort((a, b) => {
		const sa = order[a.status] ?? 99;
		const sb = order[b.status] ?? 99;
		if (sa !== sb) return sa - sb;
		return (b.created_at ?? 0) - (a.created_at ?? 0);
	});

	const nowMs = Date.now();
	const html = sorted.map((row) => {
		const give = (row.give ?? []).map(fmtAsset).join(" + ");
		const want = (row.want ?? []).map(fmtAsset).join(" + ") || "<span class='muted'>(gift)</span>";
		const sellerShort = shortKey(row.seller_pubkey);
		const recipient = row.recipient_pubkey ? ` → ${shortKey(row.recipient_pubkey)}` : "";
		const cancelBtn = (row.status === "open" && row.seller_pubkey === status.writer_pubkey)
			? `<button class="auction-cancel" data-id="${escapeHtml(row.id)}">cancel</button>`
			: "";
		const expiry = expiryLabel(row, nowMs);
		// Stale = open in the view but past its deadline (no op has touched it
		// yet to trigger lazy-expire). Show as a soft warning.
		const isStale = row.status === "open" && typeof row.expiry_ms === "number" && row.expiry_ms <= nowMs;
		const expiryCls = isStale ? "auction-expiry stale" : "auction-expiry";
		return `
			<li class="auction-row" data-id="${escapeHtml(row.id)}">
				<div class="auction-line">
					<span class="auction-id">${escapeHtml(row.id.slice(0, 12))}</span>
					${statusBadge(row.status)}
					${expiry ? `<span class="${expiryCls}">${escapeHtml(expiry)}</span>` : ""}
				</div>
				<div class="auction-terms">
					<span class="give">${give}</span>
					<span class="for">for</span>
					<span class="want">${want}</span>
				</div>
				<div class="auction-meta muted small">
					<span class="seller">seller ${sellerShort}${recipient}</span>
					${cancelBtn}
				</div>
			</li>
		`;
	}).join("");

	if (html !== lastRender) {
		AUCTIONS_LIST.innerHTML = html;
		lastRender = html;
		wireCancels();
	}
}

function wireCancels() {
	for (const btn of AUCTIONS_LIST.querySelectorAll(".auction-cancel")) {
		btn.addEventListener("click", async (e) => {
			const id = e.currentTarget.getAttribute("data-id");
			if (!id) return;
			try {
				await postAction("/api/auctions/cancel", { auctionId: id, keyName: "default" });
				lastRender = ""; // force redraw
				refresh();
			} catch (err) {
				alert("Cancel failed: " + (err.message ?? err));
			}
		});
	}
}

function parseAssetField(spec) {
	const s = (spec ?? "").trim();
	if (!s) return null;
	const fungible = /^(\d+)\s+([0-9a-zA-Z_.-]+)$/.exec(s);
	if (fungible) return { token: fungible[2], amount: fungible[1] };
	return { object_id: s };
}

async function submitNewAuction(form) {
	const errEl = document.getElementById("auctions-form-error");
	errEl.textContent = "";
	const data = new FormData(form);
	const give = parseAssetField(data.get("give"));
	const wantSpec = (data.get("want") ?? "").toString().trim();
	const want = wantSpec ? parseAssetField(wantSpec) : null;
	const recipient = (data.get("recipient") ?? "").toString().trim() || undefined;
	const expires = (data.get("expires") ?? "24h").toString().trim();
	const keyName = (data.get("keyName") ?? "default").toString().trim();
	if (!give) { errEl.textContent = "give field required"; return; }
	const expiryMs = parseDurationMs(expires);
	if (expiryMs === null) { errEl.textContent = "expires: use forms like 30m, 1h, 2d"; return; }
	const body = {
		give: [give],
		want: want ? [want] : [],   // empty array = open auction (no preset price) or gift (when recipient set)
		keyName,
		recipient,
		expiryMs: Date.now() + expiryMs,
	};
	try {
		const res = await fetch("/api/auctions/post", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const json = await res.json();
		if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
		form.reset();
		form.hidden = true;
		document.getElementById("auctions-new-btn").hidden = false;
		lastRender = ""; // force a redraw
		refresh();
	} catch (err) {
		errEl.textContent = err.message ?? String(err);
	}
}

/** Mirror of /coin's parseDuration in pure JS (no TS imports). */
function parseDurationMs(spec) {
	const m = /^(\d+)(ms|s|m|h|d)?$/.exec(spec.trim().toLowerCase());
	if (!m) return null;
	const n = parseInt(m[1], 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	switch (m[2]) {
		case "d":  return n * 86_400_000;
		case "h":  return n * 3_600_000;
		case "m":  return n * 60_000;
		case "s":  return n * 1_000;
		case "ms":
		default:   return n;
	}
}

function updateModeHint(form) {
	const hint = document.getElementById("auctions-mode-hint");
	if (!hint) return;
	const want = (form.elements.namedItem("want")?.value ?? "").trim();
	const recipient = (form.elements.namedItem("recipient")?.value ?? "").trim();
	let label, cls;
	if (!want && !recipient)     { label = "mode: open auction (any bid welcome)";        cls = "mode-open"; }
	else if (!want && recipient) { label = "mode: gift — transfers instantly on post";    cls = "mode-gift"; }
	else if (want && !recipient) { label = "mode: fixed-price (public)";                  cls = "mode-fixed"; }
	else                          { label = "mode: directed sale (private)";              cls = "mode-directed"; }
	hint.textContent = label;
	hint.className = `auctions-mode-hint muted small ${cls}`;
}

function wireForm() {
	const btn = document.getElementById("auctions-new-btn");
	const form = document.getElementById("auctions-new-form");
	const cancelBtn = document.getElementById("auctions-cancel-btn");
	if (!btn || !form || !cancelBtn) return;

	btn.addEventListener("click", () => {
		form.hidden = false;
		btn.hidden = true;
		updateModeHint(form);
		form.querySelector('input[name="give"]')?.focus();
	});
	cancelBtn.addEventListener("click", () => {
		form.hidden = true;
		btn.hidden = false;
		document.getElementById("auctions-form-error").textContent = "";
	});
	// Re-render the mode label whenever `want` or `recipient` changes.
	for (const name of ["want", "recipient"]) {
		const el = form.elements.namedItem(name);
		el?.addEventListener("input", () => updateModeHint(form));
	}
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		submitNewAuction(form);
	});
}

export function initAuctionsPanel() {
	AUCTIONS_PANEL  = document.getElementById("auctions");
	AUCTIONS_LIST   = document.getElementById("auctions-list");
	AUCTIONS_COUNT  = document.getElementById("auctions-count");
	AUCTIONS_STATUS = document.getElementById("auctions-status");
	if (!AUCTIONS_PANEL || !AUCTIONS_LIST) return;
	wireForm();
	refresh();
	setInterval(refresh, POLL_MS);
}
