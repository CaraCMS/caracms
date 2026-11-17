/**
 * Fields changed since the preview last rendered (the mockup's #preview-failed: the
 * field says "Not in the preview yet" while the preview is behind). A field is added
 * when it changes and dropped when a render lands; the field frame shows the chip
 * only while the latest render failed (previewStatus.failed).
 *
 *   staleFields(editor)     Store<ReadonlySet<string>> of `${blockKey} ${field}`
 *   staleKey(key, field)
 *
 * One store per editor (a WeakMap); nothing on the server, where there's no preview.
 */
import { isIndexPart, splitPath } from '../../../fields.ts';
import type { Editor } from '../editor.ts';
import { createStore, type Store } from '../state/store.ts';

const stores = new WeakMap<Editor, Store<ReadonlySet<string>>>();

export const staleKey = (key: string, field: string) => `${key} ${field}`;

/**
 * The field frames a change at `path` marks: a list marks itself (`credits.1.name` →
 * `credits`, M5a Decision 16), and a group is see-through, so its fields mark their own
 * frames (`left.heading` → `left`, `left.heading`; `left.gallery.0.alt` → `left`,
 * `left.gallery`). Every key part up to the first row index.
 */
export function staleNames(path: string): string[] {
	const out: string[] = [];
	let at = '';
	for (const part of splitPath(path)) {
		if (isIndexPart(part)) break;
		at = at ? `${at}.${part}` : part;
		out.push(at);
	}
	return out;
}

export function staleFields(editor: Editor): Store<ReadonlySet<string>> {
	let store = stores.get(editor);
	if (store) return store;
	store = createStore<ReadonlySet<string>>(new Set());
	stores.set(editor, store);
	const driver = editor.preview;
	if (!driver) return store;
	const s = store;
	editor.doc.subscribe((_, change) => {
		if (change.kind === 'field') {
			// A change inside a list (`credits.1.name`) marks the list; inside a group, the group's field.
			const keys = staleNames(change.field).map((name) => staleKey(change.key, name));
			if (keys.some((k) => !s.get().has(k))) s.set(new Set([...s.get(), ...keys]));
		} else if (change.kind === 'load') {
			if (s.get().size) s.set(new Set());
		}
	});
	driver.onMorph(() => {
		if (s.get().size) s.set(new Set());
	});
	return s;
}
