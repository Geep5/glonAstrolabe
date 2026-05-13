// Spell bar — bottom-of-screen quick-launch for UI windows.
//
// WoW-style action bar: a row of square slots, each bound to one panel.
// Click (or press the slot's data-key) toggles the panel between fully
// visible and fully hidden via the `hidden` HTML attribute.
//
// No half-open / collapsed state from this surface — the spell bar is
// a "is this window on the screen or not?" affordance. Panels reappear
// in the exact same position they were before being hidden, since
// their layout is fixed/absolute in CSS and we're only flipping
// visibility, not removing them from the DOM. The in-panel
// `.panel-collapse` button (─/▲) still exists for users who want a
// partial-collapse state; this surface is orthogonal to that.
//
// Slots use a unified data-target attribute (or the legacy data-panel /
// data-overlay attributes are still accepted) to name the element id
// they control.
//
// Active state on the slot is driven by a MutationObserver per target so
// the bar lights up regardless of how the panel was toggled.

function targetIdOf(slot) {
	return slot.dataset.target || slot.dataset.panel || slot.dataset.overlay || "";
}

function isOpenPanel(el) {
	if (!el) return false;
	return !el.hasAttribute("hidden");
}

function storageKeyFor(targetId) {
	return `glonAstrolabe.panelHidden.${targetId}`;
}

function toggleSlot(slot) {
	const targetId = targetIdOf(slot);
	if (!targetId) return;
	const target = document.getElementById(targetId);
	if (!target) return;
	target.hidden = !target.hidden;
	try { localStorage.setItem(storageKeyFor(targetId), target.hidden ? "1" : "0"); } catch {}
}

function paintSlotActive(slot) {
	const target = document.getElementById(targetIdOf(slot));
	slot.classList.toggle("active", isOpenPanel(target));
}

// True if the user is currently editing text (input, textarea, or any
// contenteditable). We DON'T want the number keys to toggle panels
// when the user is typing into the chat input or the search bar.
function userIsTyping() {
	const el = document.activeElement;
	if (!el) return false;
	const tag = el.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (el.isContentEditable) return true;
	return false;
}

export function initSpellBar() {
	const bar = document.getElementById("spell-bar");
	if (!bar) return;
	const slots = [...bar.querySelectorAll(".spell-slot")];
	const slotByKey = new Map();      // "1" → slot element

	for (const slot of slots) {
		// Click toggles the target.
		slot.addEventListener("click", (e) => {
			e.preventDefault();
			toggleSlot(slot);
		});
		// Restore saved hidden state. If the user last hid this panel
		// via the spell bar (or with the click handler in this module),
		// reapply that. Default to leaving the panel's HTML-declared
		// state alone — so overlays that ship with `hidden` stay
		// hidden, and asides without `hidden` stay visible.
		const targetId = targetIdOf(slot);
		const target = targetId ? document.getElementById(targetId) : null;
		if (target) {
			try {
				const saved = localStorage.getItem(storageKeyFor(targetId));
				if (saved === "1") target.hidden = true;
				else if (saved === "0") target.hidden = false;
			} catch {}
		}
		paintSlotActive(slot);
		if (target) {
			// Watch hidden-attribute changes so the slot's "active" glow
			// reflects reality regardless of who toggled the panel.
			const obs = new MutationObserver(() => paintSlotActive(slot));
			obs.observe(target, { attributes: true, attributeFilter: ["hidden"] });
		}
		// Index by data-key for the keyboard handler.
		const key = slot.dataset.key;
		if (key) slotByKey.set(key, slot);
	}

	// Keyboard handler: pressing 1–9 (or whatever data-key each slot
	// declares) toggles that slot's panel. Skipped when the user is
	// typing into an input/textarea/contenteditable so chat / search
	// boxes still capture digits normally.
	//
	// No modifier keys required — bare digit. Ignores keypresses with
	// Ctrl/Meta/Alt held so browser shortcuts (Ctrl+1 = first tab,
	// etc.) still work.
	document.addEventListener("keydown", (e) => {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (userIsTyping()) return;
		const slot = slotByKey.get(e.key);
		if (!slot) return;
		e.preventDefault();
		toggleSlot(slot);
		// Brief active flash so the user sees the keypress registered.
		slot.classList.add("spell-flash");
		setTimeout(() => slot.classList.remove("spell-flash"), 120);
	});
}
