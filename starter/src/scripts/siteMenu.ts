/**
 * The header's menu (src/components/SiteHeader.astro; M7 Decision 17, from the Tina
 * template's siteMenu).
 *
 * The phone menu: a real <button> with `aria-expanded` opens and closes a panel in the
 * page flow. It closes, and the button's word turns back from "Close" to "Menu", when the
 * button is pressed again, when Escape is pressed (focus back on the button), when a link
 * in it is followed, and when the window grows past 768px (md), where the inline menu
 * takes over.
 *
 * A group's dropdown (desktop): a real <button> with `aria-expanded` opens its links. One
 * group is open at a time. It closes on Escape (focus back on its button), on a click
 * outside it, on choosing one of its links, when focus leaves it (tabbing past its last
 * link), and when the window narrows below 768px. Its links follow the button in the tab
 * order, so the keyboard reaches them in order.
 *
 * The listeners sit on the document and find the header's elements when an event comes,
 * so a preview's morph, which may replace the header, never leaves them on stale nodes.
 * Vanilla on purpose: the public site ships no React. Exported for the starter's tests.
 */

/** Tailwind's md breakpoint: the inline menu from here up. */
export const WIDE_QUERY = '(min-width: 48rem)';

const MARK = 'siteMenuReady';

export function initSiteMenu(doc: Document = document, win: Window = window): void {
	const root = doc.documentElement;
	if (root.dataset[MARK]) return;
	root.dataset[MARK] = '';

	const menuButton = () => doc.querySelector<HTMLButtonElement>('[data-menu-button]');
	const menuPanel = () => doc.querySelector<HTMLElement>('[data-menu-panel]');
	const groups = () => [...doc.querySelectorAll<HTMLElement>('[data-nav-group]')];
	const groupButton = (g: Element) => g.querySelector<HTMLButtonElement>('[data-nav-group-button]');
	const groupPanel = (g: Element) => g.querySelector<HTMLElement>('[data-nav-group-panel]');
	const isOpen = (button: Element | null) => button?.getAttribute('aria-expanded') === 'true';

	const setMenu = (open: boolean, refocus = false) => {
		const button = menuButton();
		const panel = menuPanel();
		if (!button || !panel) return;
		button.setAttribute('aria-expanded', String(open));
		panel.hidden = !open;
		const word = button.querySelector<HTMLElement>('[data-menu-word]');
		if (word) word.textContent = open ? 'Close' : 'Menu';
		if (!open && refocus) button.focus();
	};

	const setGroup = (g: Element, open: boolean, refocus = false) => {
		const button = groupButton(g);
		const panel = groupPanel(g);
		if (!button || !panel) return;
		button.setAttribute('aria-expanded', String(open));
		panel.hidden = !open;
		if (!open && refocus) button.focus();
	};
	const closeGroups = (except?: Element) => {
		for (const g of groups()) if (g !== except && isOpen(groupButton(g))) setGroup(g, false);
	};

	doc.addEventListener('click', (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const group = target?.closest('[data-nav-group]') ?? null;
		if (target?.closest('[data-nav-group-button]') && group) {
			closeGroups(group);
			setGroup(group, !isOpen(groupButton(group)));
			return;
		}
		if (group && target?.closest('a')) setGroup(group, false);
		if (!group) closeGroups();

		if (target?.closest('[data-menu-button]')) setMenu(!isOpen(menuButton()));
		else if (target?.closest('[data-menu-panel] a')) setMenu(false);
	});

	doc.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') return;
		const open = groups().find((g) => isOpen(groupButton(g)));
		if (open) {
			setGroup(open, false, open.contains(doc.activeElement));
			return;
		}
		if (isOpen(menuButton())) setMenu(false, true);
	});

	doc.addEventListener('focusout', (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const group = target?.closest('[data-nav-group]');
		if (!group || !isOpen(groupButton(group))) return;
		const next = (event as FocusEvent).relatedTarget;
		if (next instanceof Node) {
			if (!group.contains(next)) setGroup(group, false);
			return;
		}
		// Focus left to nothing (a click on the page's background, or the window losing focus): close it
		// unless focus is back inside the group by the next microtask. Focus isn't moved.
		queueMicrotask(() => {
			if (!group.contains(doc.activeElement) && isOpen(groupButton(group))) setGroup(group, false);
		});
	});

	const wide = win.matchMedia?.(WIDE_QUERY);
	wide?.addEventListener?.('change', (event) => {
		if (event.matches) setMenu(false);
		else closeGroups();
	});
}
