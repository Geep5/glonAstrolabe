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

export function initSpellBar() {
	const bar = document.getElementById("spell-bar");
	if (!bar) return;
	const slots = [...bar.querySelectorAll(".spell-slot")];

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
	}
}
