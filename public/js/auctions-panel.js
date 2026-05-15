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
		: "warn";
	return `<span class="auction-status ${cls}">${escapeHtml(status ?? "?")}</span>`;
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

	// Sort: open auctions first, then settled, then cancelled. Within
	// each bucket, newest created_at first.
	const order = { open: 0, settled: 1, cancelled: 2 };
	const sorted = [...auctions].sort((a, b) => {
		const sa = order[a.status] ?? 99;
		const sb = order[b.status] ?? 99;
		if (sa !== sb) return sa - sb;
		return (b.created_at ?? 0) - (a.created_at ?? 0);
	});

	const html = sorted.map((row) => {
		const give = (row.give ?? []).map(fmtAsset).join(" + ");
		const want = (row.want ?? []).map(fmtAsset).join(" + ") || "<span class='muted'>(gift)</span>";
		const sellerShort = shortKey(row.seller_pubkey);
		const recipient = row.recipient_pubkey ? ` → ${shortKey(row.recipient_pubkey)}` : "";
		const cancelBtn = (row.status === "open" && row.seller_pubkey === status.writer_pubkey)
			? `<button class="auction-cancel" data-id="${escapeHtml(row.id)}">cancel</button>`
			: "";
		return `
			<li class="auction-row" data-id="${escapeHtml(row.id)}">
				<div class="auction-line">
					<span class="auction-id">${escapeHtml(row.id.slice(0, 12))}</span>
					${statusBadge(row.status)}
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

export function initAuctionsPanel() {
	AUCTIONS_PANEL  = document.getElementById("auctions");
	AUCTIONS_LIST   = document.getElementById("auctions-list");
	AUCTIONS_COUNT  = document.getElementById("auctions-count");
	AUCTIONS_STATUS = document.getElementById("auctions-status");
	if (!AUCTIONS_PANEL || !AUCTIONS_LIST) return;
	refresh();
	setInterval(refresh, POLL_MS);
}
