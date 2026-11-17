/**
 * Each iframe's selection, saved and restored around every morph (Decision 13;
 * M1 → E2). Chrome moves an iframe's activeElement to its <body> when focus leaves
 * for the parent, so idiomorph's `ignoreActive` only protects a caret while focus is
 * inside that iframe; restoring the selection by position covers the rest, so a caret
 * on the page survives a re-render whether focus is in the iframe or the sidebar.
 *
 * A selection is remembered by where it is in the page's terms: the field's context
 * (its block's `data-cms-block`, the page's `data-cms-page`, or a source's
 * `data-cms-source`: edit in context, markers.ts), the field (`data-cms-field`), which
 * of that field's elements when a source draws it more than once, and character offsets
 * in the field's text, a `<br>` counting as one character (the line-break rule). Only
 * selections inside a field are kept; anything else isn't worth restoring.
 *
 * **A field with a page editor mounted is left to the editor** (on-page rich text,
 * Decision 6): the morph never touches it, and ProseMirror owns its selection.
 */
import { contextRootOf, ctxFromKey, ctxKey, ctxOf, fieldElements } from './markers.ts';
import { mountedIn } from './page-editor-registry.ts';

export interface SavedSelection {
	/** The field's context (markers.ts → ctxKey): `b:2`, `page`, `s:settings`. */
	ctx: string;
	field: string;
	/** Which of the field's elements in that context (a source's field may be drawn twice). */
	nth: number;
	anchor: number;
	focus: number;
	/** The field had focus inside the iframe (focus is put back too). */
	focused: boolean;
}

const fieldOf = (node: Node | null): HTMLElement | null => {
	const element = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
	return (element?.closest('[data-cms-field]') as HTMLElement | null) ?? null;
};

/** Characters in a node: its text, a `<br>` as one. */
function lengthOf(node: Node): number {
	if (node.nodeType === 3) return (node as Text).data.length;
	if ((node as Element).tagName === 'BR') return 1;
	let n = 0;
	for (const child of node.childNodes) n += lengthOf(child);
	return n;
}

/** Characters before (node, offset) inside root. */
function offsetIn(root: Node, node: Node, offset: number): number {
	// An element position is "before child N", or the element's end.
	const before = node.nodeType === 1 && offset < node.childNodes.length ? node.childNodes[offset]! : null;
	const endOf = node.nodeType === 1 && !before ? node : null;
	const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	let count = 0;
	for (let current: Node | null = walker.nextNode(); current; current = walker.nextNode()) {
		if (current === before) return count;
		if (current === endOf) return count + lengthOf(current);
		if (current === node && node.nodeType === 3) return count + offset;
		if (current.nodeType === 3) count += (current as Text).data.length;
		else if ((current as Element).tagName === 'BR') count += 1;
	}
	return count;
}

/** The (node, offset) for a character offset inside root. */
function pointAt(root: Node, target: number): { node: Node; offset: number } {
	const doc = root.ownerDocument!;
	let count = 0;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let current: Node | null = walker.nextNode(); current; current = walker.nextNode()) {
		if (current.nodeType === 3) {
			const length = (current as Text).data.length;
			if (count + length >= target) return { node: current, offset: target - count };
			count += length;
		} else if ((current as Element).tagName === 'BR') {
			if (count + 1 > target) {
				const parent = current.parentNode!;
				return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, current) };
			}
			count += 1;
		}
	}
	return { node: root, offset: root.childNodes.length };
}

export function saveSelection(doc: Document): SavedSelection | null {
	const selection = doc.getSelection();
	if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) return null;
	const field = fieldOf(selection.anchorNode);
	if (!field || field !== fieldOf(selection.focusNode)) return null;
	if (mountedIn(doc)?.el === field) return null;
	const root = contextRootOf(field);
	const ctx = root ? ctxOf(root) : null;
	if (!ctx) return null;
	const name = field.dataset.cmsField!;
	return {
		ctx: ctxKey(ctx),
		field: name,
		nth: Math.max(0, fieldElements(doc, ctx, name).indexOf(field)),
		anchor: offsetIn(field, selection.anchorNode, selection.anchorOffset),
		focus: offsetIn(field, selection.focusNode, selection.focusOffset),
		focused: doc.hasFocus() && !!doc.activeElement && (doc.activeElement === field || field.contains(doc.activeElement)),
	};
}

export function restoreSelection(doc: Document, saved: SavedSelection | null): void {
	if (!saved) return;
	const ctx = ctxFromKey(saved.ctx);
	const all = ctx ? fieldElements(doc, ctx, saved.field) : [];
	const field = all[saved.nth] ?? all[0];
	const selection = doc.getSelection();
	if (!field || !selection || mountedIn(doc)?.el === field) return;
	const anchor = pointAt(field, saved.anchor);
	const focus = pointAt(field, saved.focus);
	if (saved.focused && doc.activeElement !== field) field.focus({ preventScroll: true });
	const current = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
	if (
		current &&
		selection.anchorNode === anchor.node &&
		selection.anchorOffset === anchor.offset &&
		selection.focusNode === focus.node &&
		selection.focusOffset === focus.offset
	) {
		return;
	}
	selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}
