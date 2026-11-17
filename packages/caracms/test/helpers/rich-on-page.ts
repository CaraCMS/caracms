/**
 * Helpers for on-page rich text's browser tests (Phase 1): the demo's Text block body
 * (`[data-cms-block="1"] [data-cms-field="body"]` on Home) in a preview iframe, as
 * the page editor sees it. Node side: each takes the admin Page.
 */
import type { Page } from 'playwright-core';

export const BODY = '[data-cms-block="1"] [data-cms-field="body"]';

/** Scroll the body into view in the iframe at `width` (default: the one on screen). */
export function revealBody(page: Page, selector = BODY) {
	return page.evaluate((selector) => {
		const f = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!;
		f.contentDocument!.querySelector(selector)!.scrollIntoView({ block: 'center' });
	}, selector);
}

/** A point in the admin page just inside the character at `text`+extra in the field (the caret lands before it). */
export function charPoint(page: Page, text: string, extra = 0, selector = BODY) {
	return page.evaluate(
		([text, extra, selector]) => {
			const f = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!;
			const doc = f.contentDocument!;
			const el = doc.querySelector(selector)!;
			const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
				const at = n.data.indexOf(text);
				if (at < 0) continue;
				const range = doc.createRange();
				range.setStart(n, at + extra);
				range.setEnd(n, at + extra + 1);
				const r = range.getClientRects()[0]!;
				const box = f.getBoundingClientRect();
				const k = box.width / f.offsetWidth;
				return { x: box.left + (r.left + 1) * k, y: box.top + (r.top + r.height / 2) * k };
			}
			throw new Error(`no "${text}" in ${selector}`);
		},
		[text, extra, selector] as const,
	);
}

export interface FieldState {
	/** A page editor is mounted on the element (it's ProseMirror's root). */
	mounted: boolean;
	/** A `.ProseMirror` element inside the field (Decision 3 says never). */
	wrapper: boolean;
	count: number;
	html: string;
	outer: string;
	/** The mounted editor's selection, or null. */
	selection: { anchor: number; head: number } | null;
	/** Focus is on the field inside its iframe. */
	focused: boolean;
}

/** The field in the iframe of `width` (1440, 768, 375). */
export function fieldState(page: Page, width = 1440, selector = BODY): Promise<FieldState> {
	return page.evaluate(
		([width, selector]) => {
			const doc = document.querySelector<HTMLIFrameElement>(`#stage iframe[data-width="${width}"]`)!.contentDocument!;
			const el = doc.querySelector<HTMLElement>(selector);
			const ed = (el as unknown as { editor?: { state: { selection: { anchor: number; head: number } }; isDestroyed: boolean } } | null)?.editor;
			const mounted = !!el?.classList.contains('ProseMirror') && !!ed && !ed.isDestroyed;
			return {
				mounted,
				wrapper: !!el?.querySelector('.ProseMirror'),
				count: doc.querySelectorAll(selector).length,
				html: el?.innerHTML ?? '',
				outer: el?.outerHTML ?? '',
				selection: mounted ? { anchor: ed!.state.selection.anchor, head: ed!.state.selection.head } : null,
				focused: !!el && doc.activeElement === el,
			};
		},
		[width, selector] as const,
	);
}

/** Mark every node in the field (and the field) so a later check can tell they're the very same ones. */
export function tagNodes(page: Page, selector = BODY) {
	return page.evaluate((selector) => {
		const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
		const el = doc.querySelector(selector)!;
		const all: Node[] = [el];
		const walker = doc.createTreeWalker(el, NodeFilter.SHOW_ALL);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) all.push(n);
		(window as unknown as { __tagged: Node[] }).__tagged = all;
		return all.length;
	}, selector);
}

export function sameNodes(page: Page, selector = BODY) {
	return page.evaluate((selector) => {
		const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
		const el = doc.querySelector(selector)!;
		const all: Node[] = [el];
		const walker = doc.createTreeWalker(el, NodeFilter.SHOW_ALL);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) all.push(n);
		const was = (window as unknown as { __tagged: Node[] }).__tagged;
		return was.length === all.length && was.every((n, i) => n === all[i]);
	}, selector);
}

/** The Text block's body as stored in the file. */
export const bodyInFile = (text: string) => (JSON.parse(text) as { blocks: { body?: unknown }[] }).blocks[1]!.body;

/**
 * ProseMirror's selection equals the iframe's DOM selection in the mounted editor. It reads a
 * native caret move (an arrow key, a click, a drag) on `selectionchange`, a task later, so a key
 * pressed straight after acts on the old caret: wait for this instead of a fixed pause.
 */
export function selectionInSync(page: Page, width = 1440, selector = BODY): Promise<boolean> {
	return page.evaluate(
		([width, selector]) => {
			const doc = document.querySelector<HTMLIFrameElement>(`#stage iframe[data-width="${width}"]`)!.contentDocument!;
			const el = doc.querySelector<HTMLElement>(selector);
			const ed = (el as unknown as { editor?: { isDestroyed: boolean; view: { posAtDOM(node: Node, offset: number): number }; state: { selection: { anchor: number; head: number } } } } | null)?.editor;
			const s = doc.getSelection();
			if (!el || !ed || ed.isDestroyed || !s || !s.anchorNode || !s.focusNode || !el.contains(s.anchorNode) || !el.contains(s.focusNode)) return false;
			return ed.view.posAtDOM(s.anchorNode, s.anchorOffset) === ed.state.selection.anchor && ed.view.posAtDOM(s.focusNode, s.focusOffset) === ed.state.selection.head;
		},
		[width, selector] as const,
	);
}

/** Poll `check` until it holds (80 ms apart); fails with `what`. For waits that depend on the browser, never a fixed pause. */
export async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 5000): Promise<void> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 80));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Wait until the mounted editor's selection has caught up with the iframe's (see `selectionInSync`). */
export const caretSettled = (page: Page, width = 1440, selector = BODY) => until(() => selectionInSync(page, width, selector), 'ProseMirror to read the caret', 5000);

/** A paste on the focused page editor, built in the iframe's realm as the browser would. Returns whether the editor handled it. */
export function pasteOnPage(page: Page, data: Record<string, string>, width = 1440): Promise<boolean> {
	return page.evaluate(
		([data, width]) => {
			const f = document.querySelector<HTMLIFrameElement>(`#stage iframe[data-width="${width}"]`)!;
			const win = f.contentWindow as unknown as typeof globalThis;
			const clipboardData = new win.DataTransfer();
			for (const [type, value] of Object.entries(data)) clipboardData.setData(type, value);
			const event = new win.ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
			f.contentDocument!.activeElement!.dispatchEvent(event);
			return event.defaultPrevented;
		},
		[data, width] as const,
	);
}
