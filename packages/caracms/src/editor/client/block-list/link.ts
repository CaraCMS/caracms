/**
 * The block list's link to the rest of the editor: which block row is hovered, and
 * where the add-block picker is open. One pair of stores per editor (a WeakMap, so
 * the server render's editors don't share anything with the browser's).
 *
 * ## The hover hook (for the preview link)
 *
 *   blockHover(editor)                Store<string | null>: the hovered block's key
 *   setBlockHover(editor, key | null)
 *
 * The block list sets it while the pointer is over a row (or a row has keyboard
 * focus) and draws a row as hovered (`.hov`) whenever it holds that row's key, so it
 * works both ways: the preview's overlays can read it to outline the block on the
 * page (`data-cms-block` = `editor.doc.indexOf(key)`), and set it when the pointer
 * is over a block on the page to light up its row.
 *
 * **Selected** is `editor.view.block` (the block level's block, kept when you go
 * back up to the list), drawn as `.is-current`.
 *
 * ## The picker
 *
 *   pickerAt(editor)                  Store<number | null>: the index a picked block goes in, or closed
 *   openPicker(editor, at)            opens it on the document level (the "Add block" row, the empty
 *                                     page, and later the preview's insert points)
 *   closePicker(editor)
 */
import type { Editor } from '../editor.ts';
import { createStore, type Store } from '../state/store.ts';

interface Link {
	hover: Store<string | null>;
	picker: Store<number | null>;
}

const links = new WeakMap<Editor, Link>();

function link(editor: Editor): Link {
	let found = links.get(editor);
	if (!found) {
		found = { hover: createStore<string | null>(null), picker: createStore<number | null>(null) };
		const made = found;
		// Another document opened: nothing is hovered, and the picker closes.
		editor.doc.subscribe((_, change) => {
			if (change.kind === 'load') {
				made.hover.set(null);
				made.picker.set(null);
			}
			if (change.kind === 'remove' && made.hover.get() === change.key) made.hover.set(null);
		});
		// The picker belongs to the document level: leaving it (up, or into a block) closes it.
		editor.view.subscribe((view) => {
			if (view.level !== 'document' && made.picker.get() !== null) made.picker.set(null);
		});
		links.set(editor, found);
	}
	return found;
}

export const blockHover = (editor: Editor): Store<string | null> => link(editor).hover;
export const setBlockHover = (editor: Editor, key: string | null) => link(editor).hover.set(key);

export const pickerAt = (editor: Editor): Store<number | null> => link(editor).picker;

export function openPicker(editor: Editor, at: number) {
	const length = editor.doc.get().document.blocks.length;
	editor.setPop(null);
	editor.goTo('document');
	link(editor).picker.set(Math.max(0, Math.min(length, Math.trunc(at))));
}

export const closePicker = (editor: Editor) => link(editor).picker.set(null);
