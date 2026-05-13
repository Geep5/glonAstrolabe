// Spell bar — bottom-of-screen quick-launch for UI windows.
//
// WoW-style action bar: a row of square slots, each bound to one panel
// or overlay. Click toggles open/closed. The bar is the only place that
// knows about which panels exist; opt-in is by markup (data-panel or
// data-overlay attributes on the slot buttons in index.html).
//
// Two toggle modes:
//
//   data-panel="<id>"     — target is a collapsible <aside>. Toggles the
//                           `.collapsed` class and updates the local
//                           `.panel-collapse` button's glyph/title so
//                           the two affordances stay in sync.
//
//   data-overlay="<id>"   — target is an overlay (peer-chat, peer-detail).
//                           Toggles the `hidden` attribute.
//
// Active state on the slot is driven by a MutationObserver per target so
// the bar lights up regardless of how the panel was toggled (slot click,
// in-panel collapse button, or programmatic open from elsewhere).

function isOpenPanel(el) {
	if (!el) return false;
	if (el.hasAttribute("hidden")) return false;
	if (el.classList.contains("collapsed")) return false;
	return true;
}

function syncCollapseButton(panel) {
	const btn = panel?.querySelector?.(".panel-collapse");
	if (!btn) return;
	const collapsed = panel.classList.contains("collapsed");
	btn.textContent = collapsed ? "▲" : "─";
	btn.title = collapsed ? "Expand" : "Collapse";
}

function toggleSlot(slot) {
	const panelId   = slot.dataset.panel;
	const overlayId = slot.dataset.overlay;
	if (panelId) {
		const panel = document.getElementById(panelId);
		if (!panel) return;
		panel.classList.toggle("collapsed");
		syncCollapseButton(panel);
	} else if (overlayId) {
		const overlay = document.getElementById(overlayId);
		if (!overlay) return;
		overlay.hidden = !overlay.hidden;
	}
}

function paintSlotActive(slot) {
	const target = document.getElementById(slot.dataset.panel || slot.dataset.overlay);
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
		// Initial paint + observer for state-sync.
		const targetId = slot.dataset.panel || slot.dataset.overlay;
		const target = targetId ? document.getElementById(targetId) : null;
		paintSlotActive(slot);
		if (target) {
			// Watch for class (.collapsed) and hidden-attribute changes so
			// the slot's "active" glow reflects reality regardless of
			// who toggled the panel.
			const obs = new MutationObserver(() => paintSlotActive(slot));
			obs.observe(target, { attributes: true, attributeFilter: ["class", "hidden"] });
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
