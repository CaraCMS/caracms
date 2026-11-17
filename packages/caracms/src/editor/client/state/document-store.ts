/**
 * The open document's editing state, and every operation that changes it. Phases 3
 * and 4 call these and nothing else changes the document:
 *
 *   setField(key, path, value, { origin, undoLabel })    a field, or a value inside one by dotted path
 *                                                         (M5a Decision 16: `credits.1.name`, `cta.label`)
 *   addBlock(type, index) / removeBlock(key) /
 *   moveBlock(key, to) / restoreBlock(block, index)       the block list (Phase 4)
 *   removeItem(key, path, index, { label })               M5a Decision 14: a list's row (or a button, or a
 *                                                         reference in a list) removed, with Undo
 *   undo()                                                Decision 18: brings back a removed block, a
 *                                                         removed list row (back in place), or a field
 *                                                         change made with an undoLabel (dropping a
 *                                                         lockup's phone lines)
 *
 * **Every kind of document** (M5a Phase 5) is held as a list of blocks, so a field is
 * always set by a key and a path, and Undo, the keeper and the write path work the
 * same for all four:
 *   - a section builder: its blocks (`document.blocks`), as M3 had it;
 *   - a list-of-fields document and Site Settings: one block, the form, whose `data`
 *     is the document's `data` (`type` '', `known`; `formKey(session)` is its key);
 *   - a shared block: one block, the shared block itself (its own type and fields).
 * `wire()` gives each back in its own shape (`{ kind: 'fields', title, data }`…).
 * Adding, moving and removing blocks only apply to a section builder.
 *
 * **A page's own `seo`** (M6 Decision 13), on a section builder and a fields document, is
 * held beside the blocks (`document.seo`, present only when the file had it or it's been
 * set) and set through the same calls under the scope `SEO_SCOPE`: `setField('seo',
 * 'title', …)`, `block('seo')` (a stand-in whose `data` is the seo object). So the media
 * picker, Undo and the keeper take it as they take a field. `wire()` sends it only when
 * present: absent leaves the file's as it is, emptied removes it (serialize.ts).
 *
 * **A section builder's page fields** (M6c G2) are held the same way: `document.data`
 * (present when the collection has page fields), set under `PAGE_SCOPE`
 * (`setField('page', 'side', …)`, `block('page')`, `removeItem('page', …)`), sent as the
 * wire's `data`.
 *
 * Blocks are addressed by `key`, a client-only id that stays with a block through
 * moves (EditorBlock). `source` follows the serializer's model (serialize.ts): it's
 * the block's index in the file as first read, `null` for an added block, kept
 * through moves, gone when removed, and the same `source` back when restored, so
 * the write puts an untouched or restored block back byte for byte.
 *
 * Every change makes a new immutable snapshot (React reads it with useStore) and
 * tells subscribers what changed: the keeper writes it (keeper.ts), the preview
 * renders it (preview/driver.ts; a field typed on the page, `origin: 'page'`, is
 * already on the page, so it isn't re-rendered, Decision 13).
 */
import type { DocumentEntry } from '../../../content.ts';
import type { SlotName } from '../../../config.ts';
import { documentKind, emptyBlock, own, type AnyDocument, type DocumentBlock, type Frame } from '../../../document.ts';
import { getAtPath, setAtPath } from '../../../fields.ts';
import type { Seo } from '../../../seo.ts';
import type { DocRef, EditorBlock, EditorDocument, EditorSite } from '../../types.ts';
import { createStore, type Store } from './store.ts';

/** Where a field change came from. `page`: typed on the page (the preview already shows it). */
export type ChangeOrigin = 'sidebar' | 'page';

export type DocumentChange =
	/** A document was opened. `adopted`: its unsent edits came back from the browser's storage. */
	| { kind: 'load'; adopted: boolean }
	/** `field` is the path that was set: a field's key, or a dotted path into it (`credits.1.name`). */
	| { kind: 'field'; key: string; field: string; origin: ChangeOrigin }
	| { kind: 'title' }
	/** M9 Decision 7: the page hidden from the site, or shown again. */
	| { kind: 'hidden' }
	/** Edit in context, Decision 3: a header or footer picked for the page, or the pick cleared. */
	| { kind: 'frame' }
	/** Edit in context, Decision 3: a slot block made its slot's default. */
	| { kind: 'default' }
	| { kind: 'add'; key: string }
	| { kind: 'remove'; key: string }
	| { kind: 'move'; key: string }
	| { kind: 'restore'; key: string };

/** Something Undo can bring back (Decision 18). Newest last. */
export type UndoEntry =
	| { id: number; label: string; kind: 'block'; block: EditorBlock; index: number }
	| { id: number; label: string; kind: 'field'; key: string; field: string; value: unknown }
	/** M5a Decision 14: a list row removed from the list at `field` (a dotted path), put back at `index`. */
	| { id: number; label: string; kind: 'item'; key: string; field: string; item: unknown; index: number };

export interface DocumentSession {
	ref: DocRef;
	entry: DocumentEntry;
	/** The serializer's base: the file's text as first opened, or as carried by unsent edits (keeper.ts). */
	base: string;
	document: EditorDocument;
	/** 0 when opened; +1 for every change. */
	revision: number;
	/** What Undo can bring back in this document, newest last. Cleared when another document opens. */
	undo: readonly UndoEntry[];
}

export interface DocumentStore {
	/** The open document. */
	get(): DocumentSession;
	/** The snapshot store, for React (useStore). */
	readonly state: Store<DocumentSession>;
	/** Called after every change with the new snapshot and what changed. */
	subscribe(listener: (session: DocumentSession, change: DocumentChange) => void): () => void;

	/** Open a document: a new session (new keys, empty Undo). */
	load(input: { ref: DocRef; entry: DocumentEntry; base: string; document: AnyDocument }, options?: { adopted?: boolean }): void;

	block(key: string): EditorBlock | undefined;
	indexOf(key: string): number;
	keyAt(index: number): string | undefined;

	/**
	 * Set one field of a known block (unknown blocks aren't editable, Decision 21).
	 * `field` is the field's key, or a dotted path into its value (M5a Decision 16):
	 * `credits.1.name` sets one list item's field, `cta.label` a link's label,
	 * `buttons.0.href` one button's link; the rest of the value is kept (only the
	 * objects along the path are copied). A missing step is made (an array for an
	 * index, an object otherwise). `origin: 'page'` for text typed on the page. With
	 * `undoLabel`, the old value at that path goes on the Undo stack under that label
	 * (the toast's text): Decision 18's dropped phone lines. A value equal to the
	 * current one is no change.
	 */
	setField(key: string, field: string, value: unknown, options?: { origin?: ChangeOrigin; undoLabel?: string }): void;
	setTitle(title: string): void;
	/** M9 Decision 7: hide a section builder's page from the site, or show it again (never the home page's). */
	setHidden(hidden: boolean): void;
	/**
	 * Edit in context, Decision 3: a section builder's or a fields document's pick for one slot
	 * of its frame (a shared block's path), or null to clear it (the pick goes; an emptied
	 * `frame` leaves the file). A pick is kept as picked, even of the current default.
	 */
	setFrame(slot: SlotName, path: string | null): void;
	/** Edit in context, Decision 3: a slot block's own `"default"` (the others are the slot-default route's). */
	setDefault(on: boolean): void;
	/** Add a new, empty block of a known type at `index` (default: the end). Returns its key. */
	addBlock(type: string, index?: number): string;
	/**
	 * Add a shared block's entry, `{ "shared": name }`, at `index` (M5a Decision 8: the
	 * picker's Shared blocks section). It's selected, moved and removed like a block, never
	 * edited here. Returns its key.
	 */
	addShared(name: string, index?: number): string;
	/** Remove a block at once (M2 Decision 14), with Undo. Returns the Undo entry. */
	removeBlock(key: string, options?: { label?: string }): UndoEntry | null;
	/** Move a block to `toIndex` (its index after the move). */
	moveBlock(key: string, toIndex: number): void;
	/** Put a block back at `index` (clamped), keeping its key and source. */
	restoreBlock(block: EditorBlock, index: number): void;
	/**
	 * Remove item `index` from the list at `field` (a field's key, or a dotted path to a
	 * list inside it) of a known block, with Undo (M5a Decision 14, as a removed block
	 * is): Undo puts the item back at the same index. Lists, buttons and lists of
	 * references all remove this way. Returns the Undo entry.
	 */
	removeItem(key: string, field: string, index: number, options?: { label?: string }): UndoEntry | null;
	/** Undo the newest Undo entry. Returns it, or null when there's nothing to undo. */
	undo(): UndoEntry | null;

	/** The document as the server takes it, in its kind's shape (keys dropped): the write's and the preview's `document`. */
	wire(): AnyDocument;
}

let nextUndo = 1;

/** M6: the scope a page's own `seo` is set under (block keys are `b1`, `b2`…, so it never clashes). */
export const SEO_SCOPE = 'seo';
/** Which kinds of document have their own `seo` (Decision 13: not shared blocks or Site Settings). */
const hasSeo = (kind: EditorDocument['kind']) => kind === 'sections' || kind === 'fields';
/** M6c (G2): the scope a section builder's page fields are set under (never a block key either). */
export const PAGE_SCOPE = 'page';

/** The document-level scopes (held beside the blocks, not in one): which property of the document each sets. */
type Scoped = 'seo' | 'data';
const scopedProp = (key: string): Scoped | null => (key === SEO_SCOPE ? 'seo' : key === PAGE_SCOPE ? 'data' : null);
/** Whether the document has that scope: `seo` by its kind, page fields when its collection has them. */
const hasScope = (document: EditorDocument, prop: Scoped) => (prop === 'seo' ? hasSeo(document.kind) : document.kind === 'sections' && document.data !== undefined);

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The key of a fields document's or Site Settings' form (its one block), or of a shared block; null for a section builder. */
export function formKey(session: Pick<DocumentSession, 'document'>): string | null {
	return session.document.kind === 'sections' ? null : (session.document.blocks[0]?.key ?? null);
}

export function blockLabel(site: Pick<EditorSite, 'blocks'>, block: { type: string; known: boolean }): string {
	return block.known ? (own(site.blocks, block.type)?.label ?? block.type) : 'Unknown block';
}

export function createDocumentStore(
	site: Pick<EditorSite, 'blocks'>,
	initial: { ref: DocRef; entry: DocumentEntry; base: string; document: AnyDocument },
	/**
	 * M4: `canEdit` false makes every change a no-op (someone else's lock, held edits,
	 * signed out: Decision 9). The UI disables its controls too; this is the backstop,
	 * so no key or stray event can change a read-only document.
	 */
	options: { canEdit?: () => boolean } = {},
): DocumentStore {
	const editable = () => options.canEdit?.() ?? true;
	// Keys are per session and deterministic (b1, b2… in file order), so the server's
	// render and the browser's hydration agree.
	let keys = 0;
	const newKey = () => `b${++keys}`;
	const toSession = (input: typeof initial): DocumentSession => {
		keys = 0;
		const doc = input.document;
		const kind = documentKind(doc);
		const keyed = (b: DocumentBlock): EditorBlock => ({ source: b.source, type: b.type, known: b.known, data: b.data, ...(b.shared !== undefined ? { shared: b.shared } : {}), key: newKey() });
		const blocks: EditorBlock[] =
			doc.kind === 'fields' || doc.kind === 'settings'
				? [{ source: 0, type: '', known: true, data: doc.data as Record<string, unknown>, key: newKey() }]
				: doc.kind === 'shared'
					? [keyed(doc.block)]
					: doc.blocks.map(keyed);
		const seo = (doc.kind === undefined || doc.kind === 'sections' || doc.kind === 'fields') && doc.seo !== undefined ? { seo: doc.seo as Record<string, unknown> } : {};
		const data = (doc.kind === undefined || doc.kind === 'sections') && doc.data !== undefined ? { data: doc.data } : {};
		const hidden = (doc.kind === undefined || doc.kind === 'sections') && doc.hidden ? { hidden: true } : {};
		const frame = (doc.kind === undefined || doc.kind === 'sections' || doc.kind === 'fields') && doc.frame ? { frame: doc.frame } : {};
		const isDefault = doc.kind === 'shared' && doc.default ? { default: true } : {};
		return {
			ref: { collection: input.ref.collection, path: input.ref.path },
			entry: input.entry,
			base: input.base,
			document: { kind, title: doc.title, blocks, ...seo, ...data, ...hidden, ...frame, ...isDefault },
			revision: 0,
			undo: [],
		};
	};
	const state = createStore<DocumentSession>(toSession(initial));
	const listeners = new Set<(session: DocumentSession, change: DocumentChange) => void>();

	const commit = (next: DocumentSession, change: DocumentChange) => {
		state.set(next);
		for (const listener of [...listeners]) listener(next, change);
	};
	/** A change to the document: a new snapshot with the revision bumped. */
	const change = (blocks: EditorBlock[], change: DocumentChange, extra: Partial<DocumentSession> = {}) => {
		const current = state.get();
		commit({ ...current, ...extra, document: { ...current.document, blocks }, revision: current.revision + 1 }, change);
	};
	const blocks = () => state.get().document.blocks;
	const indexOf = (key: string) => blocks().findIndex((b) => b.key === key);
	const clamp = (index: number, length: number) => Math.max(0, Math.min(length, Number.isFinite(index) ? Math.trunc(index) : length));
	const pushUndo = (entry: UndoEntry): UndoEntry[] => [...state.get().undo, entry].slice(-50);
	/** Only a section builder's blocks are added, moved and removed. */
	const builder = () => state.get().document.kind === 'sections';

	const store: DocumentStore = {
		get: () => state.get(),
		state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		load(input, options = {}) {
			commit(toSession(input), { kind: 'load', adopted: !!options.adopted });
		},
		block: (key) => {
			const prop = scopedProp(key);
			return prop ? scopedBlock(key, prop) : blocks().find((b) => b.key === key);
		},
		indexOf,
		keyAt: (index) => blocks()[index]?.key,

		setField(key, field, value, options = {}) {
			if (!editable()) return;
			const prop = scopedProp(key);
			if (prop) {
				setScoped(key, prop, field, value, options.undoLabel, options.origin);
				return;
			}
			const index = indexOf(key);
			const block = blocks()[index];
			if (!block || !block.known || field === '') return;
			const before = getAtPath(block.data, field);
			if (same(before, value)) return;
			const next = [...blocks()];
			next[index] = { ...block, data: setAtPath(block.data, field, value) as Record<string, unknown> };
			const undo = options.undoLabel
				? pushUndo({ id: nextUndo++, label: options.undoLabel, kind: 'field', key, field, value: before })
				: state.get().undo;
			change(next, { kind: 'field', key, field, origin: options.origin ?? 'sidebar' }, { undo });
		},

		setTitle(title) {
			if (!editable()) return;
			const current = state.get();
			if (current.document.title === title) return;
			commit({ ...current, document: { ...current.document, title }, revision: current.revision + 1 }, { kind: 'title' });
		},

		setHidden(hidden) {
			if (!editable() || !builder()) return;
			const current = state.get();
			if (!!current.document.hidden === hidden) return;
			commit({ ...current, document: { ...current.document, hidden }, revision: current.revision + 1 }, { kind: 'hidden' });
		},

		setFrame(slot, path) {
			const current = state.get();
			if (!editable() || (current.document.kind !== 'sections' && current.document.kind !== 'fields')) return;
			const before = current.document.frame ?? {};
			if ((before[slot] ?? null) === path) return;
			const frame: Frame = { ...before };
			if (path === null) delete frame[slot];
			else frame[slot] = path;
			commit({ ...current, document: { ...current.document, frame }, revision: current.revision + 1 }, { kind: 'frame' });
		},

		setDefault(on) {
			const current = state.get();
			if (!editable() || current.document.kind !== 'shared' || !!current.document.default === on) return;
			commit({ ...current, document: { ...current.document, default: on }, revision: current.revision + 1 }, { kind: 'default' });
		},

		addBlock(type, index) {
			if (!editable() || !builder()) return '';
			const created = emptyBlock(type, site as Parameters<typeof emptyBlock>[1]);
			if (!created.known) throw new Error(`addBlock: "${type}" isn't a block type this site declares`);
			const block: EditorBlock = { ...created, key: newKey() };
			const next = [...blocks()];
			next.splice(clamp(index ?? next.length, next.length), 0, block);
			change(next, { kind: 'add', key: block.key });
			return block.key;
		},

		addShared(name, index) {
			if (!editable() || !builder()) return '';
			const block: EditorBlock = { source: null, type: '', known: false, data: { shared: name }, shared: name, key: newKey() };
			const next = [...blocks()];
			next.splice(clamp(index ?? next.length, next.length), 0, block);
			change(next, { kind: 'add', key: block.key });
			return block.key;
		},

		removeBlock(key, options = {}) {
			if (!editable() || !builder()) return null;
			const index = indexOf(key);
			const block = blocks()[index];
			if (!block) return null;
			const entry: UndoEntry = { id: nextUndo++, label: options.label ?? `Removed ${blockLabel(site, block)}`, kind: 'block', block, index };
			const next = blocks().filter((b) => b.key !== key);
			change(next, { kind: 'remove', key }, { undo: pushUndo(entry) });
			return entry;
		},

		moveBlock(key, toIndex) {
			if (!editable() || !builder()) return;
			const from = indexOf(key);
			if (from < 0) return;
			const next = [...blocks()];
			const [block] = next.splice(from, 1);
			const to = clamp(toIndex, next.length);
			if (to === from) return;
			next.splice(to, 0, block!);
			change(next, { kind: 'move', key });
		},

		removeItem(key, field, index, options = {}) {
			if (!editable()) return null;
			const prop = scopedProp(key);
			if (prop) {
				const current = state.get();
				if (!hasScope(current.document, prop) || field === '') return null;
				const list = getAtPath(current.document[prop] ?? {}, field);
				if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return null;
				const entry: UndoEntry = { id: nextUndo++, label: options.label ?? 'Removed an item', kind: 'item', key, field, item: list[index], index };
				const value = setAtPath(current.document[prop] ?? {}, field, list.filter((_, i) => i !== index)) as Record<string, unknown>;
				commit({ ...current, undo: pushUndo(entry), document: { ...current.document, [prop]: value }, revision: current.revision + 1 }, { kind: 'field', key, field, origin: 'sidebar' });
				return entry;
			}
			const at = indexOf(key);
			const block = blocks()[at];
			if (!block || !block.known || field === '') return null;
			const list = getAtPath(block.data, field);
			if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return null;
			const entry: UndoEntry = { id: nextUndo++, label: options.label ?? 'Removed an item', kind: 'item', key, field, item: list[index], index };
			const next = [...blocks()];
			next[at] = { ...block, data: setAtPath(block.data, field, list.filter((_, i) => i !== index)) as Record<string, unknown> };
			change(next, { kind: 'field', key, field, origin: 'sidebar' }, { undo: pushUndo(entry) });
			return entry;
		},

		restoreBlock(block, index) {
			if (!editable() || !builder()) return;
			if (indexOf(block.key) >= 0) return;
			const next = [...blocks()];
			next.splice(clamp(index, next.length), 0, block);
			change(next, { kind: 'restore', key: block.key });
		},

		undo() {
			if (!editable()) return null;
			const stack = state.get().undo;
			const entry = stack.at(-1);
			if (!entry) return null;
			const rest = stack.slice(0, -1);
			if (entry.kind === 'block') {
				if (indexOf(entry.block.key) >= 0) {
					state.set({ ...state.get(), undo: rest });
					return entry;
				}
				const next = [...blocks()];
				next.splice(clamp(entry.index, next.length), 0, entry.block);
				change(next, { kind: 'restore', key: entry.block.key }, { undo: rest });
			} else if (entry.kind === 'item' && scopedProp(entry.key)) {
				const prop = scopedProp(entry.key)!;
				const current = state.get();
				const list = hasScope(current.document, prop) ? getAtPath(current.document[prop] ?? {}, entry.field) : undefined;
				if (!Array.isArray(list)) {
					state.set({ ...current, undo: rest });
					return entry;
				}
				const items = [...list];
				items.splice(clamp(entry.index, items.length), 0, entry.item);
				const value = setAtPath(current.document[prop] ?? {}, entry.field, items) as Record<string, unknown>;
				commit({ ...current, undo: rest, document: { ...current.document, [prop]: value }, revision: current.revision + 1 }, { kind: 'field', key: entry.key, field: entry.field, origin: 'sidebar' });
			} else if (entry.kind === 'item') {
				const index = indexOf(entry.key);
				const block = blocks()[index];
				const list = block ? getAtPath(block.data, entry.field) : undefined;
				if (!block || !Array.isArray(list)) {
					state.set({ ...state.get(), undo: rest });
					return entry;
				}
				const items = [...list];
				items.splice(clamp(entry.index, items.length), 0, entry.item);
				const next = [...blocks()];
				next[index] = { ...block, data: setAtPath(block.data, entry.field, items) as Record<string, unknown> };
				change(next, { kind: 'field', key: entry.key, field: entry.field, origin: 'sidebar' }, { undo: rest });
			} else if (scopedProp(entry.key)) {
				const prop = scopedProp(entry.key)!;
				const current = state.get();
				if (!hasScope(current.document, prop)) {
					state.set({ ...current, undo: rest });
					return entry;
				}
				const value = setAtPath(current.document[prop] ?? {}, entry.field, entry.value) as Record<string, unknown>;
				commit({ ...current, undo: rest, document: { ...current.document, [prop]: value }, revision: current.revision + 1 }, { kind: 'field', key: entry.key, field: entry.field, origin: 'sidebar' });
			} else {
				const index = indexOf(entry.key);
				const block = blocks()[index];
				if (!block) {
					state.set({ ...state.get(), undo: rest });
					return entry;
				}
				const next = [...blocks()];
				next[index] = { ...block, data: setAtPath(block.data, entry.field, entry.value) as Record<string, unknown> };
				change(next, { kind: 'field', key: entry.key, field: entry.field, origin: 'sidebar' }, { undo: rest });
			}
			return entry;
		},

		wire() {
			const { document } = state.get();
			const plain = ({ source, type, known, data, shared }: EditorBlock): DocumentBlock => ({ source, type, known, data, ...(shared !== undefined ? { shared } : {}) });
			const first = document.blocks[0];
			switch (document.kind) {
				case 'fields':
					return { kind: 'fields', title: document.title, data: first?.data ?? {}, ...seoWire(), ...(document.frame !== undefined ? { frame: document.frame } : {}) };
				case 'settings':
					return { kind: 'settings', title: document.title, data: (first?.data ?? {}) as Extract<AnyDocument, { kind: 'settings' }>['data'] };
				case 'shared':
					return { kind: 'shared', title: document.title, block: first ? plain(first) : { source: 0, type: '', known: false, data: {} }, ...(document.default !== undefined ? { default: document.default } : {}) };
				default:
					return {
						title: document.title,
						blocks: document.blocks.map(plain),
						...seoWire(),
						...(document.data !== undefined ? { data: document.data } : {}),
						...(document.hidden !== undefined ? { hidden: document.hidden } : {}),
						...(document.frame !== undefined ? { frame: document.frame } : {}),
					};
			}
		},
	};

	/** The page's `seo`, or its page fields, as a stand-in block (undefined for a document without that scope). */
	function scopedBlock(key: string, prop: Scoped): EditorBlock | undefined {
		const { document } = state.get();
		if (!hasScope(document, prop)) return undefined;
		return { key, source: null, type: '', known: true, data: document[prop] ?? {} };
	}
	function setScoped(key: string, prop: Scoped, field: string, value: unknown, undoLabel?: string, origin: ChangeOrigin = 'sidebar') {
		const current = state.get();
		if (!hasScope(current.document, prop) || field === '') return;
		const before = getAtPath(current.document[prop] ?? {}, field);
		if (same(before, value)) return;
		const next = setAtPath(current.document[prop] ?? {}, field, value) as Record<string, unknown>;
		const undo = undoLabel ? pushUndo({ id: nextUndo++, label: undoLabel, kind: 'field', key, field, value: before }) : current.undo;
		commit({ ...current, undo, document: { ...current.document, [prop]: next }, revision: current.revision + 1 }, { kind: 'field', key, field, origin });
	}
	/** `seo` for the wire, only when the document has one (absent: the file's stays as it is). */
	function seoWire(): { seo?: Seo } {
		const seo = state.get().document.seo;
		return seo !== undefined ? { seo: seo as Seo } : {};
	}
	return store;
}
