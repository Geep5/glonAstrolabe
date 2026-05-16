// Auctions panel — Valencia-styled listings UI over the live autobase.
//
// Tabs (open / mine / my bids / all), search, sort (hot / ending / new /
// price), column-based row layout (give ⇄ want | top bid | trend | expires),
// expandable rows with bid history + sparkline + inline bid form, post
// form for sellers, accept-bid button per bid for sellers, toast on bid
// submission.
//
// All data is live. Reads /api/auctions, /api/auctions/:id/bids,
// /api/wallet. Writes via /api/auctions/{post,bid,settle,cancel}.

const POLL_MS = 5_000;
const COIN_LABEL_CACHE = new Map(); // token_id → { name, symbol }

let PANEL = null, LIST = null, COUNT = null, STATUS = null, FOOTER = null;
let SEARCH = null, TABS = null, SORTS = null;

let LOCAL_WALLET_KEYS = new Set();
let TAB  = "open";
let SORT = "hot";
let SEARCH_Q = "";

/** Auctions currently expanded inline. */
const expanded = new Set();
/** Bid history cache: auctionId → array of bid records (newest first). */
const bidsCache = new Map();
/** Auction IDs we know the local user has bid on. */
const myBidIds = new Set();
/** Bid-form state per auction (open + status). */
const bidForm = new Map();

// ── Fetch helpers ────────────────────────────────────────────────

async function getJSON(url) {
	const res = await fetch(url);
	const j = await res.json().catch(() => null);
	if (!res.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${res.status}`);
	return j;
}
async function postJSON(url, body) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const j = await res.json().catch(() => null);
	if (!res.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${res.status}`);
	return j;
}

async function loadWalletKeys() {
	try {
		const r = await fetch("/api/wallet").then((res) => res.json());
		LOCAL_WALLET_KEYS = new Set(r?.pubkeys ?? []);
	} catch {
		LOCAL_WALLET_KEYS = new Set();
	}
}

async function ensureCoinLabels(tokenIds) {
	const missing = [...tokenIds].filter((t) => !COIN_LABEL_CACHE.has(t));
	if (missing.length === 0) return;
	try {
		const r = await fetch("/api/coins").then((res) => res.json());
		for (const t of (r?.tokens ?? [])) {
			COIN_LABEL_CACHE.set(t.token_id, { name: t.name, symbol: t.symbol });
		}
	} catch { /* leave hex */ }
}

/** All tokens on the network (cache, refreshed when form opens). */
let ALL_TOKENS = [];
/** Map token_id → bigint of my aggregate balance across all wallet keys. */
let MY_BALANCES = new Map();

async function loadTokensAndBalances() {
	try {
		const r = await fetch("/api/coins").then((res) => res.json());
		ALL_TOKENS = (r?.tokens ?? []).map((t) => ({
			token_id: t.token_id,
			name: t.name,
			symbol: t.symbol,
			supply: t.supply,
		}));
		for (const t of ALL_TOKENS) {
			COIN_LABEL_CACHE.set(t.token_id, { name: t.name, symbol: t.symbol });
		}
	} catch { ALL_TOKENS = []; }
	// Fetch holders for each token and aggregate my balance.
	MY_BALANCES = new Map();
	await Promise.all(ALL_TOKENS.map(async (t) => {
		try {
			const hr = await fetch(`/api/coins/${encodeURIComponent(t.token_id)}/holders`).then((res) => res.json());
			let myBal = 0n;
			for (const h of (hr?.holders ?? [])) {
				if (LOCAL_WALLET_KEYS.has(h.pubkey)) myBal += BigInt(h.balance ?? "0");
			}
			if (myBal > 0n) MY_BALANCES.set(t.token_id, myBal);
		} catch { /* skip */ }
	}));
}

// ── Asset formatting ────────────────────────────────────────────

function shortKey(k) {
	if (!k || typeof k !== "string") return "—";
	if (k.length <= 12) return k;
	return k.slice(0, 6) + "…" + k.slice(-4);
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function tokenLabel(tokenId) {
	const meta = COIN_LABEL_CACHE.get(tokenId);
	return meta?.symbol ?? tokenId.slice(0, 8) + "…";
}

function assetLabel(a) {
	if (!a) return { label: "—", detail: "", kind: "data" };
	if (a.object_id) {
		return { label: a.object_id, detail: "object", kind: "item" };
	}
	if (a.token && a.amount) {
		return {
			label: `${Number(a.amount).toLocaleString()} ${tokenLabel(a.token)}`,
			detail: `coin · ${a.token.slice(0, 8)}…`,
			kind: "coin",
		};
	}
	return { label: "?", detail: "", kind: "data" };
}

function fmtTimeLeft(expires) {
	let s = Math.max(0, Math.floor((expires - Date.now()) / 1000));
	const d = Math.floor(s / 86400); s -= d * 86400;
	const h = Math.floor(s / 3600); s -= h * 3600;
	const m = Math.floor(s / 60); s -= m * 60;
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

function fmtAgo(ms) {
	const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function parseDurationMs(spec) {
	const m = /^(\d+)(ms|s|m|h|d)?$/.exec((spec ?? "").toString().trim().toLowerCase());
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

function parseAssetField(spec) {
	const s = (spec ?? "").toString().trim();
	if (!s) return null;
	const fungible = /^(\d+)\s+([0-9a-zA-Z_.-]+)$/.exec(s);
	if (fungible) return { token: fungible[2], amount: fungible[1] };
	return { object_id: s };
}

// ── Sparkline ────────────────────────────────────────────────────

function sparkline(bids) {
	if (!bids || bids.length < 2) {
		return `<div class="auction-spark-empty"></div>`;
	}
	// Reverse so the path goes left-to-right oldest→newest.
	const pts = [...bids].reverse()
		.map((b) => Number(b.offer?.[0]?.amount ?? 0))
		.filter((v) => Number.isFinite(v));
	if (pts.length < 2) return `<div class="auction-spark-empty"></div>`;
	const min = Math.min(...pts), max = Math.max(...pts);
	const range = max - min || 1;
	const w = 56, h = 18;
	const step = w / (pts.length - 1);
	const path = pts.map((v, i) => {
		const x = i * step;
		const y = h - ((v - min) / range) * h;
		return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
	}).join(" ");
	const lastY = h - ((pts[pts.length - 1] - min) / range) * h;
	return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="auction-spark"><path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.2"/><circle cx="${w}" cy="${lastY.toFixed(1)}" r="2" fill="var(--accent)"/></svg>`;
}

// ── Tab + filter logic ──────────────────────────────────────────

function filterAuctions(auctions) {
	let list = auctions;
	if (TAB === "open")      list = list.filter((a) => a.status === "open");
	else if (TAB === "mine") list = list.filter((a) => LOCAL_WALLET_KEYS.has(a.seller_pubkey));
	else if (TAB === "bids") list = list.filter((a) => myBidIds.has(a.id));
	// "all" = no filter
	if (SEARCH_Q) {
		const q = SEARCH_Q.toLowerCase();
		list = list.filter((a) => {
			const give = (a.give ?? []).map(assetLabel).map((x) => x.label).join(" ");
			const want = (a.want ?? []).map(assetLabel).map((x) => x.label).join(" ");
			return (a.id ?? "").toLowerCase().includes(q)
				|| (a.seller_pubkey ?? "").toLowerCase().includes(q)
				|| give.toLowerCase().includes(q)
				|| want.toLowerCase().includes(q);
		});
	}
	if (SORT === "hot") {
		list = [...list].sort((a, b) => (bidCount(b) - bidCount(a)) || ((b.created_at ?? 0) - (a.created_at ?? 0)));
	} else if (SORT === "ending") {
		list = [...list].sort((a, b) => (a.expiry_ms ?? Infinity) - (b.expiry_ms ?? Infinity));
	} else if (SORT === "new") {
		list = [...list].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
	} else if (SORT === "price") {
		list = [...list].sort((a, b) => topBidAmount(b) - topBidAmount(a));
	}
	return list;
}

function bidCount(auction) {
	return (bidsCache.get(auction.id) ?? []).length;
}
function topBid(auction) {
	const b = bidsCache.get(auction.id) ?? [];
	if (b.length === 0) return null;
	// "Top" = highest first-asset amount. v1 simplification.
	return b.reduce((best, x) => (topBidValue(x) > topBidValue(best) ? x : best), b[0]);
}
function topBidAmount(auction) {
	const t = topBid(auction);
	return t ? topBidValue(t) : 0;
}
function topBidValue(bid) {
	return Number(bid?.offer?.[0]?.amount ?? 0);
}

// ── Rendering ────────────────────────────────────────────────────

function statusBadge(status) {
	const cls = status === "open" ? "ok"
		: status === "settled" ? "info"
		: (status === "cancelled" || status === "expired") ? "muted"
		: "warn";
	return `<span class="auction-status ${cls}">${escapeHtml(status ?? "?")}</span>`;
}

function renderRow(a, status) {
	const giveAssets = (a.give ?? []).map(assetLabel);
	const wantAssets = (a.want ?? []).map(assetLabel);
	const isMine = LOCAL_WALLET_KEYS.has(a.seller_pubkey);
	const isExpanded = expanded.has(a.id);
	const expiringSoon = a.status === "open" && typeof a.expiry_ms === "number" && (a.expiry_ms - Date.now()) < 30 * 60_000;
	const stripeCls = isMine ? "stripe-mine" : (expiringSoon ? "stripe-soon" : "");
	const tb = topBid(a);
	const bidsN = bidCount(a);
	const wantText = wantAssets.length > 0
		? wantAssets.map((x) => `<span class="mono asset-label">${escapeHtml(x.label)}</span>`).join("")
		: (a.recipient_pubkey
			? `<span class="muted small">(gift to ${shortKey(a.recipient_pubkey)})</span>`
			: `<span class="muted small">(open · any offer)</span>`);
	const giveText = giveAssets.map((x) => `<span class="mono asset-label">${escapeHtml(x.label)}</span>`).join("");

	const topBidCell = tb
		? `<div class="bid-amt mono">${escapeHtml(String(topBidValue(tb).toLocaleString()))}</div>
		   <div class="bid-count mono small">${bidsN} bid${bidsN === 1 ? "" : "s"}</div>`
		: `<div class="muted small">no bids</div>`;

	const expiresColor = expiringSoon ? "var(--orange)" : "var(--text-muted)";
	const expiresLabel = a.status === "open"
		? fmtTimeLeft(a.expiry_ms ?? 0)
		: (a.status === "expired" ? "expired" : (a.status === "settled" ? "settled" : "—"));
	const expiresMeta = isMine ? "yours" : shortKey(a.seller_pubkey);

	return `
		<li class="auction-row-new ${isExpanded ? "expanded" : ""} ${stripeCls}" data-id="${escapeHtml(a.id)}">
			<div class="auction-row-main" data-toggle="${escapeHtml(a.id)}">
				<div class="col-give cell-asset">
					<span class="type-dot type-${giveAssets[0]?.kind ?? "data"}"></span>
					<div class="cell-asset-text">
						${giveText || `<span class="muted small">—</span>`}
					</div>
				</div>
				<div class="col-arrow">⇄</div>
				<div class="col-want cell-asset">
					<span class="type-dot type-${wantAssets[0]?.kind ?? "data"}"></span>
					<div class="cell-asset-text">${wantText}</div>
				</div>
				<div class="col-bid">${topBidCell}</div>
				<div class="col-trend">${sparkline(bidsCache.get(a.id))}</div>
				<div class="col-expires">
					<div class="mono" style="color: ${expiresColor}; font-weight: 500;">${escapeHtml(expiresLabel)}</div>
					<div class="muted small">${escapeHtml(expiresMeta)}</div>
				</div>
			</div>
			${isExpanded ? renderExpanded(a, status) : ""}
		</li>
	`;
}

function renderExpanded(a, status) {
	const isMine = LOCAL_WALLET_KEYS.has(a.seller_pubkey);
	const bids = bidsCache.get(a.id) ?? [];
	const giveAssets = (a.give ?? []).map(assetLabel);
	const isOpen = a.status === "open";

	let formHtml = "";
	if (isOpen) {
		if (isMine) {
			formHtml = `
				<div class="exp-mine-actions">
					<button class="ghost-btn" data-action="cancel" data-id="${escapeHtml(a.id)}">cancel listing</button>
				</div>
			`;
		} else {
			const state = bidForm.get(a.id) ?? { status: "idle", token: "", amount: "" };
			const isBusy = state.status === "signing" || state.status === "confirming";
			const isConfirmed = state.status === "confirmed";
			const ownedTokens = ALL_TOKENS.filter((t) => MY_BALANCES.has(t.token_id));
			const tokenOpts = ownedTokens.length === 0
				? `<option value="" disabled selected>no coins owned</option>`
				: ownedTokens.map((t) => {
					const sym = t.symbol ?? t.name ?? t.token_id.slice(0, 8);
					const bal = MY_BALANCES.get(t.token_id)?.toString() ?? "0";
					const selected = state.token === t.token_id ? " selected" : "";
					return `<option value="${escapeHtml(t.token_id)}"${selected}>${escapeHtml(sym)}  ·  bal ${escapeHtml(bal)}</option>`;
				}).join("");
			formHtml = `
				<div class="exp-bid-form">
					<div class="exp-label">place bid</div>
					<div class="bid-form-row">
						<select class="bid-form-token mono"
							data-id="${escapeHtml(a.id)}"
							${isBusy || isConfirmed ? "disabled" : ""}>${tokenOpts}</select>
						<input class="bid-form-amount mono"
							data-id="${escapeHtml(a.id)}"
							type="text"
							inputmode="numeric"
							value="${escapeHtml(state.amount)}"
							placeholder="amount"
							${isBusy || isConfirmed ? "disabled" : ""} />
						<button class="bid-form-submit ${isConfirmed ? "confirmed" : ""}"
							data-action="bid"
							data-id="${escapeHtml(a.id)}"
							${isBusy || isConfirmed ? "disabled" : ""}>
							${state.status === "idle" ? "place bid"
							: state.status === "signing" ? '<span class="spinner"></span> signing'
							: state.status === "confirming" ? '<span class="spinner"></span> confirming'
							: state.status === "confirmed" ? "✓ posted"
							: state.status === "error" ? "retry" : "place bid"}
						</button>
					</div>
					<div class="bid-form-hint mono small">
						${state.status === "error" ? `<span style="color: var(--err)">${escapeHtml(state.error ?? "failed")}</span>`
						: state.status === "idle" ? (ownedTokens.length === 0 ? "you don't own any coins yet" : `pick a token + enter an amount`)
						: state.status === "signing" ? "signing with key default…"
						: state.status === "confirming" ? "awaiting consensus…"
						: state.status === "confirmed" ? "bid live on the ledger" : ""}
					</div>
				</div>
			`;
		}
	}

	const bidHistory = bids.length === 0
		? `<div class="muted small">No bids yet${isMine ? " — share your listing." : " — be the first."}</div>`
		: `<div class="bid-history-grid">
			${bids.slice(0, 8).map((b, i) => {
				const isTop = b === topBid(a);
				const offerStr = (b.offer ?? []).map(assetLabel).map((x) => x.label).join(" + ");
				const acceptBtn = isMine
					? `<button class="accept-btn"
						data-action="accept"
						data-auction="${escapeHtml(a.id)}"
						data-winner="${escapeHtml(b.bidder_pubkey)}"
						data-at="${b.created_at}">accept</button>`
					: "";
				return `
					<div class="bid-history-row${isTop ? " top" : ""}">
						<div class="bid-history-who mono">${escapeHtml(shortKey(b.bidder_pubkey))}${isTop ? ' <span class="top-marker">● top</span>' : ""}</div>
						<div class="bid-history-amt mono">${escapeHtml(offerStr)}</div>
						<div class="bid-history-age mono small">${escapeHtml(fmtAgo(b.created_at))}</div>
						<div class="bid-history-action">${acceptBtn}</div>
					</div>`;
			}).join("")}
		</div>`;

	return `
		<div class="auction-expanded">
			<div class="exp-meta-row">
				<span class="chip mono"><span class="dot" style="background: var(--accent)"></span>offer · ${escapeHtml(a.id.slice(0, 8))}</span>
				<span class="chip mono">seller ${escapeHtml(shortKey(a.seller_pubkey))}${isMine ? " · you" : ""}</span>
				<span class="chip mono">posted ${escapeHtml(fmtAgo(a.created_at))}</span>
				${a.recipient_pubkey ? `<span class="chip mono">to ${escapeHtml(shortKey(a.recipient_pubkey))}</span>` : ""}
				<span class="chip mono">${statusBadge(a.status)}</span>
			</div>
			<div class="exp-section">
				<div class="exp-label">bid history</div>
				${bidHistory}
			</div>
			${formHtml}
		</div>
	`;
}

// ── Refresh ──────────────────────────────────────────────────────

let lastRender = "";
async function refresh() {
	let status = null;
	let auctions = [];
	let unreachable = false;
	try {
		const [s, a] = await Promise.all([
			fetch("/api/auction/status").then((r) => r.json()),
			fetch("/api/auctions").then((r) => r.json()),
		]);
		if (s?.ok) status = s.status; else unreachable = true;
		if (a?.ok) auctions = a.auctions ?? [];
	} catch { unreachable = true; }

	if (unreachable || !status?.bootstrap_key) {
		PANEL.hidden = true;
		return;
	}
	PANEL.hidden = false;

	// Collect token IDs that need labels.
	const tokenIds = new Set();
	for (const a of auctions) {
		for (const x of (a.give ?? [])) if (x.token) tokenIds.add(x.token);
		for (const x of (a.want ?? [])) if (x.token) tokenIds.add(x.token);
	}
	await ensureCoinLabels(tokenIds);

	// Lazy-load bids for visible (filtered) auctions in the open tab AND any expanded ones.
	const visible = filterAuctions(auctions);
	const needBids = new Set();
	for (const a of visible) if (a.status === "open") needBids.add(a.id);
	for (const id of expanded) needBids.add(id);
	await Promise.all([...needBids].map(async (id) => {
		try {
			const r = await fetch(`/api/auctions/${encodeURIComponent(id)}/bids`).then((res) => res.json());
			if (r?.ok) {
				const bids = r.bids ?? [];
				bidsCache.set(id, bids);
				// Track my bids
				for (const b of bids) {
					if (LOCAL_WALLET_KEYS.has(b.bidder_pubkey)) myBidIds.add(id);
				}
			}
		} catch { /* leave stale */ }
	}));

	// Header / footer / tab counts
	const writerShort = shortKey(status.writer_pubkey);
	const total = auctions.length;
	const mineN = auctions.filter((a) => LOCAL_WALLET_KEYS.has(a.seller_pubkey)).length;
	const openN = auctions.filter((a) => a.status === "open").length;
	const bidsN = auctions.filter((a) => myBidIds.has(a.id)).length;
	COUNT.textContent = String(visible.length);
	STATUS.textContent = `reader ${writerShort} · ${total} listings · ${status.view_length ?? 0} view ops`;
	document.getElementById("tab-count-open").textContent = openN;
	document.getElementById("tab-count-mine").textContent = mineN;
	document.getElementById("tab-count-bids").textContent = bidsN;
	document.getElementById("tab-count-all").textContent  = total;

	if (FOOTER) {
		FOOTER.innerHTML = `<span>view · auction-house · ${total} entries · ${status.system_length ?? 0} ops</span><span>signing key: default</span>`;
	}

	// Render rows
	const html = visible.length === 0
		? `<li class="auction-empty muted small">No listings match this filter.</li>`
		: visible.map((a) => renderRow(a, status)).join("");

	if (html !== lastRender) {
		LIST.innerHTML = html;
		lastRender = html;
		wireRows();
	}
}

// ── Event wiring ────────────────────────────────────────────────

function wireRows() {
	// Toggle expand on row body
	for (const row of LIST.querySelectorAll(".auction-row-main")) {
		row.addEventListener("click", (e) => {
			if (e.target.closest("button") || e.target.closest("input")) return;
			const id = row.getAttribute("data-toggle");
			if (!id) return;
			if (expanded.has(id)) expanded.delete(id);
			else expanded.add(id);
			lastRender = ""; refresh();
		});
	}
	// Cancel
	for (const btn of LIST.querySelectorAll('[data-action="cancel"]')) {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const id = e.currentTarget.getAttribute("data-id");
			try {
				await postJSON("/api/auctions/cancel", { auctionId: id, keyName: "default" });
				toast(`Listing ${id.slice(0, 8)} cancelled`);
				lastRender = ""; refresh();
			} catch (err) {
				toast(`Cancel failed: ${err.message ?? err}`, "err");
			}
		});
	}
	// Accept-bid
	for (const btn of LIST.querySelectorAll('[data-action="accept"]')) {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const auctionId = e.currentTarget.getAttribute("data-auction");
			const winner   = e.currentTarget.getAttribute("data-winner");
			const at       = parseInt(e.currentTarget.getAttribute("data-at"), 10);
			try {
				await postJSON("/api/auctions/settle", { auctionId, winner, winningBidAt: at, keyName: "default" });
				toast(`Settled · ${shortKey(winner)} wins`);
				expanded.delete(auctionId);
				lastRender = ""; refresh();
			} catch (err) {
				toast(`Settle failed: ${err.message ?? err}`, "err");
			}
		});
	}
	// Place bid
	for (const btn of LIST.querySelectorAll('[data-action="bid"]')) {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const id = e.currentTarget.getAttribute("data-id");
			const tokenSel = LIST.querySelector(`select.bid-form-token[data-id="${cssEscape(id)}"]`);
			const amtInput = LIST.querySelector(`input.bid-form-amount[data-id="${cssEscape(id)}"]`);
			const token  = tokenSel?.value ?? "";
			const amount = (amtInput?.value ?? "").trim();
			if (!token) {
				bidForm.set(id, { status: "error", error: "pick a token from the dropdown", token, amount });
				lastRender = ""; refresh();
				return;
			}
			if (!amount || !/^\d+$/.test(amount)) {
				bidForm.set(id, { status: "error", error: "amount must be a positive integer", token, amount });
				lastRender = ""; refresh();
				return;
			}
			const offer = { token, amount };
			bidForm.set(id, { status: "signing", token, amount });
			lastRender = ""; refresh();
			try {
				bidForm.set(id, { status: "confirming", token, amount });
				lastRender = ""; refresh();
				await postJSON("/api/auctions/bid", { auctionId: id, offer: [offer], keyName: "default" });
				bidForm.set(id, { status: "confirmed", token, amount });
				toast(`Bid posted on ${id.slice(0, 8)}`);
				// Refresh balances since the bid amount may matter at settle.
				loadTokensAndBalances();
				lastRender = ""; refresh();
				setTimeout(() => {
					bidForm.delete(id);
					lastRender = ""; refresh();
				}, 2500);
			} catch (err) {
				bidForm.set(id, { status: "error", error: err.message ?? String(err), token, amount });
				lastRender = ""; refresh();
			}
		});
	}
	// Persist bid form state across re-renders.
	for (const sel of LIST.querySelectorAll(".bid-form-token")) {
		sel.addEventListener("change", (e) => {
			const id = e.currentTarget.getAttribute("data-id");
			const cur = bidForm.get(id) ?? { status: "idle", amount: "" };
			bidForm.set(id, { ...cur, token: e.currentTarget.value });
		});
	}
	for (const input of LIST.querySelectorAll(".bid-form-amount")) {
		input.addEventListener("input", (e) => {
			const id = e.currentTarget.getAttribute("data-id");
			const cur = bidForm.get(id) ?? { status: "idle", token: "" };
			bidForm.set(id, { ...cur, amount: e.currentTarget.value });
		});
	}
}

function cssEscape(s) {
	return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// ── Toast ────────────────────────────────────────────────────────

function toast(text, kind = "ok") {
	const el = document.getElementById("auctions-toast");
	if (!el) return;
	el.innerHTML = `
		<div class="toast-dot ${kind}"></div>
		<div class="toast-text">${escapeHtml(text)}</div>
	`;
	el.hidden = false;
	el.classList.remove("show");
	requestAnimationFrame(() => el.classList.add("show"));
	clearTimeout(toast._t);
	toast._t = setTimeout(() => {
		el.classList.remove("show");
		setTimeout(() => { el.hidden = true; }, 200);
	}, 3200);
}

// ── New-listing form ────────────────────────────────────────────

/** Read an asset-picker's current state and produce an asset object
 *  (null if nothing selected / nothing typed). */
function readPicker(form, pickerName) {
	const picker = form.querySelector(`.asset-picker[data-picker="${pickerName}"]`);
	if (!picker) return null;
	const mode = picker.getAttribute("data-mode");
	if (mode === "none") return null;
	if (mode === "item") {
		const v = picker.querySelector('[data-role="item"]').value.trim();
		return v ? { object_id: v } : null;
	}
	// coins mode
	const token = picker.querySelector('[data-role="token"]').value;
	const amount = picker.querySelector('[data-role="amount"]').value.trim();
	if (!token || !amount) return null;
	return { token, amount };
}

/** Populate the <select> inside a picker with token options.
 *  `scope` = "owned" (only my-balance > 0) or "all". */
function populatePickerOptions(picker, scope) {
	const sel = picker.querySelector('[data-role="token"]');
	const existing = sel.value;
	const tokens = (scope === "owned")
		? ALL_TOKENS.filter((t) => MY_BALANCES.has(t.token_id))
		: ALL_TOKENS;
	const opts = tokens.map((t) => {
		const sym = t.symbol ?? t.name ?? t.token_id.slice(0, 8);
		const balStr = MY_BALANCES.has(t.token_id) ? `  ·  bal ${MY_BALANCES.get(t.token_id).toString()}` : "";
		return `<option value="${escapeHtml(t.token_id)}">${escapeHtml(sym)}${escapeHtml(balStr)}</option>`;
	}).join("");
	const emptyOpt = tokens.length === 0
		? `<option value="" disabled selected>${scope === "owned" ? "no coins owned" : "no tokens deployed"}</option>`
		: "";
	sel.innerHTML = emptyOpt + opts;
	if (existing && tokens.some((t) => t.token_id === existing)) sel.value = existing;
}

/** Switch a picker between coins / item / none. Re-renders inputs accordingly. */
function setPickerMode(picker, mode) {
	picker.setAttribute("data-mode", mode);
	const coinsBox = picker.querySelector(".asset-picker-coins");
	const itemBox  = picker.querySelector('[data-role="item"]');
	if (mode === "coins") { coinsBox.hidden = false; itemBox.hidden = true; }
	else if (mode === "item") { coinsBox.hidden = true; itemBox.hidden = false; }
	else { coinsBox.hidden = true; itemBox.hidden = true; }
	// Highlight the active toggle for the multi-toggle "want" picker.
	for (const b of picker.querySelectorAll(".asset-mode-toggle")) {
		const wm = b.getAttribute("data-want-mode");
		if (wm) b.classList.toggle("active", wm === mode);
	}
	// Update the live mode-hint chip whenever a picker state changes.
	const form = picker.closest("form");
	if (form) updateModeHint(form);
}

function updateModeHint(form) {
	const hint = document.getElementById("auctions-mode-hint");
	if (!hint) return;
	const want = readPicker(form, "want");
	const recipient = (form.elements.namedItem("recipient")?.value ?? "").trim();
	let label, cls;
	if (!want && !recipient)     { label = "mode: open auction (any bid welcome)";        cls = "mode-open"; }
	else if (!want && recipient) { label = "mode: gift — transfers instantly on post";   cls = "mode-gift"; }
	else if (want && !recipient) { label = "mode: fixed-price (public)";                 cls = "mode-fixed"; }
	else                          { label = "mode: directed sale (private)";              cls = "mode-directed"; }
	hint.textContent = label;
	hint.className = `auctions-mode-hint muted small ${cls}`;
}

async function submitNewAuction(form) {
	const errEl = document.getElementById("auctions-form-error");
	errEl.textContent = "";
	const give = readPicker(form, "give");
	const want = readPicker(form, "want");
	const data = new FormData(form);
	const recipient = (data.get("recipient") ?? "").toString().trim() || undefined;
	const expires = (data.get("expires") ?? "24h").toString().trim();
	const keyName = (data.get("keyName") ?? "default").toString().trim();
	if (!give) { errEl.textContent = "pick a token + amount or an item for 'give'"; return; }
	const expiryMs = parseDurationMs(expires);
	if (expiryMs === null) { errEl.textContent = "expires: use forms like 30m, 1h, 2d"; return; }
	const body = {
		give: [give],
		want: want ? [want] : [],
		keyName,
		recipient,
		expiryMs: Date.now() + expiryMs,
	};
	try {
		await postJSON("/api/auctions/post", body);
		form.reset();
		form.hidden = true;
		// Reset pickers to defaults.
		for (const picker of form.querySelectorAll(".asset-picker")) {
			const init = picker.getAttribute("data-picker") === "give" ? "coins" : "none";
			setPickerMode(picker, init);
			const item = picker.querySelector('[data-role="item"]');
			const amt  = picker.querySelector('[data-role="amount"]');
			if (item) item.value = "";
			if (amt)  amt.value = "";
		}
		toast(`Listing posted`);
		lastRender = "";
		refresh();
	} catch (err) {
		errEl.textContent = err.message ?? String(err);
	}
}

function wireForm() {
	const btn = document.getElementById("auctions-new-btn");
	const form = document.getElementById("auctions-new-form");
	const cancelBtn = document.getElementById("auctions-cancel-btn");
	if (!btn || !form || !cancelBtn) return;

	btn.addEventListener("click", async () => {
		form.hidden = !form.hidden;
		if (!form.hidden) {
			// Refresh tokens + balances when opening — picks up new deploys.
			await loadTokensAndBalances();
			for (const picker of form.querySelectorAll(".asset-picker")) {
				const name = picker.getAttribute("data-picker");
				const scope = name === "give" ? "owned" : "all";
				populatePickerOptions(picker, scope);
			}
			updateModeHint(form);
			form.querySelector('.asset-picker[data-picker="give"] [data-role="amount"]')?.focus();
		}
	});
	cancelBtn.addEventListener("click", () => {
		form.hidden = true;
		document.getElementById("auctions-form-error").textContent = "";
	});

	// Picker mode toggles.
	for (const btn of form.querySelectorAll(".asset-mode-toggle")) {
		btn.addEventListener("click", () => {
			const target = btn.getAttribute("data-picker-target");
			const picker = form.querySelector(`.asset-picker[data-picker="${target}"]`);
			if (!picker) return;
			const explicit = btn.getAttribute("data-want-mode");
			if (explicit) {
				setPickerMode(picker, explicit);
			} else {
				// Single-toggle (used by `give`): flip coins ⇄ item.
				const cur = picker.getAttribute("data-mode");
				const next = cur === "coins" ? "item" : "coins";
				setPickerMode(picker, next);
				btn.textContent = next === "coins" ? "use unique item instead" : "use coins instead";
			}
		});
	}

	// Picker state changes → live update the mode chip.
	for (const picker of form.querySelectorAll(".asset-picker")) {
		picker.addEventListener("input", () => updateModeHint(form));
		picker.addEventListener("change", () => updateModeHint(form));
	}
	const recipientInput = form.elements.namedItem("recipient");
	recipientInput?.addEventListener("input", () => updateModeHint(form));

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		submitNewAuction(form);
	});
}

function wireChrome() {
	// Tabs
	for (const b of TABS.querySelectorAll(".auctions-tab")) {
		b.addEventListener("click", () => {
			TAB = b.getAttribute("data-tab");
			for (const x of TABS.querySelectorAll(".auctions-tab")) x.classList.toggle("active", x === b);
			lastRender = ""; refresh();
		});
	}
	// Sort buttons
	for (const b of SORTS.querySelectorAll(".auctions-sort")) {
		b.addEventListener("click", () => {
			SORT = b.getAttribute("data-sort");
			for (const x of SORTS.querySelectorAll(".auctions-sort")) x.classList.toggle("active", x === b);
			lastRender = ""; refresh();
		});
	}
	// Search
	SEARCH.addEventListener("input", (e) => {
		SEARCH_Q = e.currentTarget.value;
		lastRender = ""; refresh();
	});
}

// ── Init ─────────────────────────────────────────────────────────

export function initAuctionsPanel() {
	PANEL  = document.getElementById("auctions");
	LIST   = document.getElementById("auctions-list");
	COUNT  = document.getElementById("auctions-count");
	STATUS = document.getElementById("auctions-status");
	FOOTER = document.getElementById("auctions-list-footer");
	SEARCH = document.getElementById("auctions-search");
	TABS   = document.getElementById("auctions-tabs");
	SORTS  = document.getElementById("auctions-sorts");
	if (!PANEL || !LIST) return;
	loadWalletKeys().then(async () => {
		await loadTokensAndBalances();
		wireForm();
		wireChrome();
		refresh();
		setInterval(refresh, POLL_MS);
		setInterval(loadWalletKeys, 30_000);
		// Refresh token list + my balances every 15s — picks up new deploys
		// and balance changes (gifts, settlements) without a page reload.
		setInterval(loadTokensAndBalances, 15_000);
	});
}
