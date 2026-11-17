/**
 * The page editor (on-page rich text, Decisions 2–5): /admin's own Tiptap, with the
 * sidebar's schema (`richTextExtensions`), conversion (`toDoc`/`fromDoc`) and paste
 * (`clipboardTextParser`), mounted on a rich-text field's own element in a preview
 * iframe. Candidate (A) of Decision 4: one realm, /admin's; the preview page still
 * carries no editor script.
 *
 * - **The editor's root is the field's element itself** (Decision 3):
 *   `element: { mount: fieldEl }`, which Tiptap passes straight to ProseMirror (a
 *   cast: it works at run time but isn't in Tiptap's types). No `div.ProseMirror`
 *   inside: the field's first child is the value's first block, as the render's is.
 * - **Mounting swaps the field's children in one task** (ProseMirror's constructor
 *   renders the document synchronously), so nothing paints in between.
 * - **Teardown leaves the element exactly as a render would** (Decision 5): the
 *   attributes captured at mount are put back exactly (ProseMirror strips the ones
 *   it set, Tiptap's `tiptap` class would stay), and the children are
 *   `richTextHtml(value)`, as RichText.astro renders them, with the render's heading ids
 *   put back by position (the next render recomputes them).
 * - **Outside changes** (Decision 8) replace the content without an update, compared
 *   with the value this editor last stored and with `fromDoc` of its own content, so
 *   its own echo never replaces it (an empty paragraph from Enter survives), as
 *   RichTextField.tsx does; only the range that differs is replaced, so the page's
 *   selection maps through it.
 * - **Blur with `view.dom.blur()`**, never Tiptap's `commands.blur()` (that clears
 *   /admin's selection, not the iframe's).
 */
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { parseRichText, richTextHtml, type RichTextOptions, type RichTextValue } from '../../../rich-text.ts';
import { headingIdsOf, setHeadingIds } from './page-editor-registry.ts';
import { fromDoc, toDoc, type PMNode } from '../fields/rich-text-doc.ts';
import { clipboardTextParser, richTextExtensions } from '../fields/rich-text-schema.ts';

export interface MountedPageEditor {
	/** The field's element (the editor's root while mounted). */
	readonly el: HTMLElement;
	readonly editor: Editor;
	readonly view: EditorView;
	readonly options: RichTextOptions;
	/** The value it was given or last stored. */
	value(): RichTextValue;
	/** A change from elsewhere (Decision 8): shown, without an update. */
	setValue(raw: unknown): void;
	/** The editor's selection (ProseMirror positions). */
	selection(): { anchor: number; head: number };
	/** Put the selection at these positions (clamped to the document), and focus the editor if asked. */
	select(anchor: number, head?: number, focus?: boolean): void;
	/**
	 * A render changed the element's own attributes while it was mounted: teardown puts
	 * back these (the render's) instead of the mount-time ones. The live element is
	 * left alone (ProseMirror owns its `class`, `contenteditable` and `translate`).
	 */
	syncAttributes(from: Element): void;
	/** Tear down (Decision 5's recipe). The element is left as a render of the current value. */
	destroy(): void;
	readonly destroyed: boolean;
}

export { renderedHtml } from './page-editor-registry.ts';

/**
 * A point in a rendered rich-text field (before mount), as a path the editor's DOM
 * has too: the top-level block's index, a list item's index inside a list, and the
 * characters before the point in that textblock (a `<br>` counts as one, as a
 * hardBreak does). Block boundaries count (Decision 5): that's what `selection.ts`
 * doesn't know.
 */
export interface FieldPoint {
	path: number[];
	offset: number;
}

const LISTS = new Set(['UL', 'OL']);

function charsBefore(root: Node, node: Node, offset: number): number {
	const doc = root.ownerDocument!;
	const range = doc.createRange();
	range.setStart(root, 0);
	range.setEnd(node, offset);
	const frag = range.cloneContents();
	let n = 0;
	const walk = (x: Node) => {
		for (const c of x.childNodes) {
			if (c.nodeType === 3) n += (c as Text).data.length;
			else if ((c as Element).tagName === 'BR') n += 1;
			else walk(c);
		}
	};
	walk(frag);
	return n;
}

/** Where the iframe's (collapsed or not) selection's focus is inside the field, or null. */
export function pointInField(el: HTMLElement): FieldPoint | null {
	const sel = el.ownerDocument.getSelection();
	const node = sel?.focusNode;
	if (!sel || !node || !el.contains(node) || node === el) return null;
	let block: Node = node;
	while (block.parentNode && block.parentNode !== el) block = block.parentNode;
	const path = [Array.prototype.indexOf.call(el.childNodes, block) as number];
	let textblock: Node = block;
	if (block.nodeType === 1 && LISTS.has((block as Element).tagName)) {
		let item: Node = node;
		while (item.parentNode && item.parentNode !== block) item = item.parentNode;
		if (item === block) return { path, offset: 0 };
		path.push(Array.prototype.indexOf.call(block.childNodes, item) as number);
		textblock = item;
	}
	return { path, offset: charsBefore(textblock, sel.focusNode!, sel.focusOffset) };
}

/** The editor's position for a FieldPoint (its DOM has the same blocks and items), or null. */
export function positionOf(view: EditorView, point: FieldPoint): number | null {
	let at: Node | undefined = view.dom.childNodes[point.path[0]!];
	if (point.path.length > 1) at = at?.childNodes[point.path[1]!];
	if (!at) return null;
	// A list item that still holds a paragraph (the older schema): its text is in there.
	if (at.nodeType === 1 && (at as Element).tagName === 'LI' && (at as Element).firstElementChild?.tagName === 'P') at = (at as Element).firstElementChild!;
	let left = point.offset;
	const walker = at.ownerDocument!.createTreeWalker(at, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.nodeType === 3) {
			const len = (n as Text).data.length;
			if (left <= len) return view.posAtDOM(n, left);
			left -= len;
		} else if ((n as Element).tagName === 'BR' && !(n as Element).classList.contains('ProseMirror-trailingBreak')) {
			if (left === 0) return view.posAtDOM(n.parentNode!, Array.prototype.indexOf.call(n.parentNode!.childNodes, n) as number);
			left -= 1;
		}
	}
	return view.posAtDOM(at, at.childNodes.length);
}

export function mountPageEditor(
	el: HTMLElement,
	init: {
		value: unknown;
		options: RichTextOptions;
		/** Each edit's value (fromDoc through the field's rules), when it differs from the last. */
		onChange?: (value: RichTextValue) => void;
		/** Keys first (⌘K and Esc are the page's). Return true when handled. */
		onKeyDown?: (event: KeyboardEvent) => boolean;
	},
): MountedPageEditor {
	const options: RichTextOptions = { headings: [...init.options.headings], links: init.options.links, ...(init.options.heading ? { heading: true } : {}) };
	let value = parseRichText(init.value, options);
	let last = JSON.stringify(value);
	// Decision 5's recipe: the attributes exactly as the render left them.
	let attributes = [...el.attributes].map((a) => [a.name, a.value] as const);
	// Heading ids: the render's, put back by position at teardown (page-editor-registry.ts → setHeadingIds).
	let headingIds = headingIdsOf(el);
	let destroyed = false;

	const editor = new Editor({
		// Decision 3: ProseMirror uses the element itself only when given `{ mount }`.
		element: { mount: el } as unknown as HTMLElement,
		extensions: richTextExtensions(options),
		content: toDoc(value, options),
		injectCSS: false,
		enableInputRules: false,
		enablePasteRules: false,
		editorProps: {
			clipboardTextParser,
			handleKeyDown: (_view, event) => init.onKeyDown?.(event) ?? false,
		},
		onUpdate: ({ editor: ed }) => {
			const next = fromDoc(ed.getJSON() as PMNode, options);
			const json = JSON.stringify(next);
			if (json === last) return;
			last = json;
			value = next;
			init.onChange?.(next);
		},
	});

	return {
		el,
		editor,
		get view() {
			return editor.view;
		},
		options,
		value: () => value,
		setValue(raw) {
			if (destroyed) return;
			const next = parseRichText(raw, options);
			const json = JSON.stringify(next);
			if (json === last) return;
			last = json;
			value = next;
			if (JSON.stringify(fromDoc(editor.getJSON() as PMNode, options)) === json) return;
			// Only the part that differs is replaced, so the selection maps through it (a
			// whole-document setContent would put it at the end), without an update and
			// outside the page's own undo (Decision 11).
			const target = editor.schema.nodeFromJSON(toDoc(next, options));
			const current = editor.state.doc;
			const start = current.content.findDiffStart(target.content);
			if (start === null) return;
			let { a, b } = current.content.findDiffEnd(target.content)!;
			const overlap = start - Math.min(a, b);
			if (overlap > 0) {
				a += overlap;
				b += overlap;
			}
			const tr = editor.state.tr.replace(start, a, target.slice(start, b));
			tr.setMeta('preventUpdate', true).setMeta('addToHistory', false);
			editor.view.dispatch(tr);
		},
		selection() {
			const s = editor.state.selection;
			return { anchor: s.anchor, head: s.head };
		},
		select(anchor, head = anchor, focus = false) {
			if (destroyed) return;
			const max = editor.state.doc.content.size;
			const clamp = (n: number) => Math.max(0, Math.min(n, max));
			const doc = editor.state.doc;
			const sel = TextSelection.between(doc.resolve(clamp(anchor)), doc.resolve(clamp(head)));
			editor.view.dispatch(editor.state.tr.setSelection(sel));
			if (focus) editor.view.focus();
		},
		syncAttributes(from) {
			if (destroyed) return;
			attributes = [...from.attributes].map((a) => [a.name, a.value] as const);
			headingIds = headingIdsOf(from);
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			editor.destroy();
			for (const name of el.getAttributeNames()) el.removeAttribute(name);
			for (const [name, v] of attributes) el.setAttribute(name, v);
			el.innerHTML = richTextHtml(value);
			setHeadingIds(el, headingIds);
		},
		get destroyed() {
			return destroyed;
		},
	};
}
