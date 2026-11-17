/**
 * The page editor's spike (on-page rich text, Decision 4; Phase 1's first bullet),
 * loaded into /admin's own window by the spike's browser test through the dev
 * server (`import('/@fs/…/page-editor-spike.ts')`), so the editor runs in /admin's
 * realm and is mounted on the field's element in the iframe: candidate (A).
 *
 * Everything here runs in the admin page: helpers to find the field in the visible
 * iframe, mount the page editor on it, turn iframe coordinates into page ones for
 * the mouse, and morph the iframe with Decision 6's rule.
 */
import { Idiomorph } from 'idiomorph';
import { mountPageEditor, type MountedPageEditor } from '../../src/editor/client/preview/page-editor.ts';

const OPTIONS = { headings: ['h2', 'h3'] as const, links: true };

let mounted: MountedPageEditor | null = null;

export const iframe = () => document.querySelector<HTMLIFrameElement>('.frame.on iframe')!;
export const frameDoc = () => iframe().contentDocument!;
export const field = () => frameDoc().querySelector<HTMLElement>('[data-cms-block="1"] [data-cms-field="body"]')!;
export const pe = () => mounted!;

/** Once: keep page-edit out of the spike (it would mount its own page editor), and give ProseMirror its one style. */
export function prepare() {
	const win = iframe().contentWindow!;
	// The spike mounts its own editor: page-edit's (hover, focus, click to edit) stays out.
	// A move with a button down still goes through (ProseMirror's drag uses it).
	win.addEventListener('click', (event) => event.stopPropagation(), true);
	win.addEventListener('mousemove', (event) => event.buttons === 0 && event.stopPropagation(), true);
	for (const type of ['focusin', 'focusout', 'mouseleave']) win.addEventListener(type, (event) => event.stopPropagation(), true);
	const style = frameDoc().createElement('style');
	style.id = 'spike-style';
	style.textContent = '.ProseMirror{white-space:pre-wrap}';
	frameDoc().head.append(style);
}

export function mount(value: unknown) {
	mounted?.destroy();
	mounted = mountPageEditor(field(), { value, options: OPTIONS });
	return describe();
}

export function unmount() {
	mounted?.destroy();
	mounted = null;
}

/** The field's shape, for the first checklist item. */
export function describe() {
	const el = field();
	return {
		first: el.firstElementChild?.tagName ?? null,
		wrapper: !!el.querySelector('.ProseMirror'),
		rootIsField: mounted?.view.dom === el,
		childTags: [...el.children].map((c) => c.tagName),
		count: frameDoc().querySelectorAll('[data-cms-field="body"]').length,
	};
}

/** The text node holding `text` inside the field, and the offset of `text` in it. */
function locate(text: string, extra = 0) {
	const doc = frameDoc();
	const walker = doc.createTreeWalker(field(), NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
		const at = n.data.indexOf(text);
		if (at >= 0) return { node: n, offset: at + extra };
	}
	throw new Error(`no "${text}" in the field`);
}

/** The ProseMirror position at `text` (+extra characters). */
export function posAt(text: string, extra = 0) {
	const { node, offset } = locate(text, extra);
	return pe().view.posAtDOM(node, offset);
}

/** The scale from iframe coordinates to the admin page's. */
function scale() {
	const f = iframe();
	return f.getBoundingClientRect().width / f.offsetWidth;
}

export function toPage(x: number, y: number) {
	const r = iframe().getBoundingClientRect();
	const k = scale();
	return { x: r.left + x * k, y: r.top + y * k };
}

/** A page point just inside the left edge of the character at `text`+extra (the caret lands before it). */
export function charPoint(text: string, extra = 0) {
	const { node, offset } = locate(text, extra);
	const range = frameDoc().createRange();
	range.setStart(node, offset);
	range.setEnd(node, offset + 1);
	const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
	return toPage(rect.left + 1, rect.top + rect.height / 2);
}

/** The character's rect in the iframe's own coordinates (from the iframe's own document). */
export function charRect(text: string, extra = 0) {
	const { node, offset } = locate(text, extra);
	const range = frameDoc().createRange();
	range.setStart(node, offset);
	range.setEnd(node, offset + 1);
	const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
	return { left: r.left, top: r.top, bottom: r.bottom };
}

export function selection() {
	const s = pe().view.state.selection;
	return { from: s.from, to: s.to, empty: s.empty };
}

/** The iframe's DOM selection as ProseMirror positions (null if it isn't in the field). */
export function domSelection() {
	const s = frameDoc().getSelection();
	if (!s || !s.anchorNode || !field().contains(s.anchorNode)) return null;
	const v = pe().view;
	const a = v.posAtDOM(s.anchorNode, s.anchorOffset);
	const f = v.posAtDOM(s.focusNode!, s.focusOffset);
	return { from: Math.min(a, f), to: Math.max(a, f) };
}

export function json() {
	return pe().editor.getJSON();
}

export function html() {
	return field().innerHTML;
}

export function setSelection(from: number, to = from) {
	pe().editor.commands.setTextSelection({ from, to });
	pe().view.focus();
}

export function focusedInFrame() {
	const doc = frameDoc();
	return doc.hasFocus() && doc.activeElement === field();
}

/** A synthetic clipboard event on the editor, built in the iframe's realm. */
export function clipboard(type: 'copy' | 'cut' | 'paste', data: Record<string, string> = {}) {
	const win = iframe().contentWindow! as unknown as typeof globalThis;
	const dt = new win.DataTransfer();
	for (const [k, v] of Object.entries(data)) dt.setData(k, v);
	const event = new win.ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true });
	pe().view.dom.dispatchEvent(event);
	return { plain: dt.getData('text/plain'), html: dt.getData('text/html'), prevented: event.defaultPrevented };
}

/**
 * A dead-key composition (´ then e → é) as a browser does it, synthetically: the
 * composition events, and the DOM change the browser would make, at the caret.
 */
export async function compose() {
	const win = iframe().contentWindow! as unknown as typeof globalThis;
	const dom = pe().view.dom;
	const doc = frameDoc();
	const s = doc.getSelection()!;
	const node = s.anchorNode as Text;
	const offset = s.anchorOffset;
	const tick = () => new Promise((r) => setTimeout(r, 30));
	dom.dispatchEvent(new win.CompositionEvent('compositionstart', { data: '', bubbles: true }));
	node.insertData(offset, '´');
	s.collapse(node, offset + 1);
	dom.dispatchEvent(new win.CompositionEvent('compositionupdate', { data: '´', bubbles: true }));
	dom.dispatchEvent(new win.InputEvent('input', { data: '´', inputType: 'insertCompositionText', bubbles: true }));
	await tick();
	node.replaceData(offset, 1, 'é');
	s.collapse(node, offset + 1);
	dom.dispatchEvent(new win.CompositionEvent('compositionupdate', { data: 'é', bubbles: true }));
	dom.dispatchEvent(new win.InputEvent('input', { data: 'é', inputType: 'insertCompositionText', bubbles: true }));
	dom.dispatchEvent(new win.CompositionEvent('compositionend', { data: 'é', bubbles: true }));
	await tick();
	await tick();
}

/**
 * Morph the iframe's body with a fresh preview render (its own GET), with Decision
 * 6's rule: the editor's element is left alone only when paired with its own field
 * in the render; otherwise it's torn down in the callback.
 */
export async function morphFresh(transform?: (html: string) => string) {
	const doc = frameDoc();
	let source = await (await fetch(iframe().src)).text();
	if (transform) source = transform(source);
	const next = new DOMParser().parseFromString(source, 'text/html');
	const expected = next.querySelector('[data-cms-block="1"] [data-cms-field="body"]');
	const editorEl = mounted?.el ?? null;
	let tornDown = false;
	let paired = false;
	// idiomorph's ignoreActive skips the active element before any callback: with focus
	// in the editor, the rule below couldn't run (and a same-tag sibling would pair with
	// it). The editor is the only element it would protect, and the rule covers it.
	const editorActive = !!editorEl && doc.activeElement === editorEl;
	Idiomorph.morph(doc.body, [...next.body.childNodes], {
		morphStyle: 'innerHTML',
		ignoreActive: !editorActive,
		callbacks: {
			beforeNodeMorphed(oldNode: Node, newNode: Node) {
				if (!editorEl || oldNode !== editorEl || mounted?.destroyed) return true;
				if (newNode === expected) {
					paired = true;
					return false;
				}
				mounted!.destroy();
				tornDown = true;
				return true;
			},
		},
	});
	return { paired, tornDown, count: doc.querySelectorAll('[data-cms-field="body"]').length };
}
