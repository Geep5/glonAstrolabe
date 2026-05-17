// Family panel — every user's balance, parent-only "give figgies" form,
// and a one-time "register user" form for setting up new family members.
//
// Polls /api/family every 5s. Mirrors the AH panel's posting convention:
// optimistic local toast, lastRender cache to avoid pointless DOM churn.

const POLL_MS = 5_000;

let PANEL, LIST, GIVE_FORM, REGISTER_FORM, GIVE_BTN, REG_BTN, ERR;
let ME = null;     // { name, role } of the local user (parent | kid)

let lastRender = "";

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function getJSON(url) {
	const r = await fetch(url);
	const j = await r.json().catch(() => null);
	if (!r.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${r.status}`);
	return j;
}

async function postJSON(url, body) {
	const r = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const j = await r.json().catch(() => null);
	if (!r.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${r.status}`);
	return j;
}

async function refresh() {
	let users = [];
	try {
		const r = await getJSON("/api/family");
		users = r.users ?? [];
	} catch { /* show stale data on failure */ }

	const html = users.length === 0
		? `<li class="family-empty muted small">No users yet. Run with FIGGIES_AUTO_PARENT=1 to register the first parent, then use the Register form below.</li>`
		: users.map((u) => {
			const isMe = ME && u.name === ME.name;
			const roleClass = u.role === "parent" ? "role-parent" : "role-kid";
			return `
				<li class="family-row ${isMe ? "is-me" : ""}">
					<span class="family-name mono">${escapeHtml(u.name)}${isMe ? " <span class=\"muted small\">(you)</span>" : ""}</span>
					<span class="family-role mono small ${roleClass}">${escapeHtml(u.role)}</span>
					<span class="family-balance mono">${u.balance.toLocaleString()} FIG</span>
				</li>
			`;
		}).join("");

	if (html !== lastRender) {
		LIST.innerHTML = html;
		lastRender = html;
	}
}

async function loadMe() {
	try {
		const r = await getJSON("/api/family/me");
		ME = r?.user ? { name: r.name, role: r.user.role } : { name: r?.name ?? "unknown", role: "kid" };
		updateParentControls();
	} catch {
		ME = null;
	}
}

function updateParentControls() {
	const isParent = ME?.role === "parent";
	if (GIVE_FORM) GIVE_FORM.classList.toggle("hidden", !isParent);
	if (REGISTER_FORM) REGISTER_FORM.classList.toggle("hidden", !isParent);
	const note = document.getElementById("family-parent-note");
	if (note) {
		note.textContent = isParent
			? `Signed in as ${ME.name} (parent). You can mint figgies and register new family members.`
			: ME
			? `Signed in as ${ME.name} (${ME.role}). Ask a parent to give you figgies or register new users.`
			: "Identity unknown.";
	}
}

function wireForms() {
	GIVE_FORM.addEventListener("submit", async (e) => {
		e.preventDefault();
		ERR.textContent = "";
		const data = new FormData(GIVE_FORM);
		const to = (data.get("to") ?? "").toString().trim();
		const amount = parseInt((data.get("amount") ?? "").toString(), 10);
		const memo = (data.get("memo") ?? "").toString().trim() || undefined;
		if (!to) { ERR.textContent = "to: pick a recipient"; return; }
		if (!Number.isFinite(amount) || amount <= 0) { ERR.textContent = "amount: positive integer"; return; }
		try {
			await postJSON("/api/family/mint", { to, amount, memo });
			GIVE_FORM.reset();
			lastRender = "";
			refresh();
		} catch (err) {
			ERR.textContent = err.message ?? String(err);
		}
	});

	REGISTER_FORM.addEventListener("submit", async (e) => {
		e.preventDefault();
		ERR.textContent = "";
		const data = new FormData(REGISTER_FORM);
		const name = (data.get("name") ?? "").toString().trim();
		const role = (data.get("role") ?? "kid").toString();
		if (!name) { ERR.textContent = "name required"; return; }
		try {
			await postJSON("/api/family/register", { name, role });
			REGISTER_FORM.reset();
			lastRender = "";
			refresh();
		} catch (err) {
			ERR.textContent = err.message ?? String(err);
		}
	});
}

export async function initFamilyPanel() {
	PANEL = document.getElementById("family");
	LIST = document.getElementById("family-list");
	GIVE_FORM = document.getElementById("family-give-form");
	REGISTER_FORM = document.getElementById("family-register-form");
	GIVE_BTN = document.getElementById("family-give-btn");
	REG_BTN = document.getElementById("family-register-btn");
	ERR = document.getElementById("family-error");
	if (!PANEL || !LIST || !GIVE_FORM || !REGISTER_FORM) return;
	wireForms();
	await loadMe();
	await refresh();
	setInterval(refresh, POLL_MS);
}
