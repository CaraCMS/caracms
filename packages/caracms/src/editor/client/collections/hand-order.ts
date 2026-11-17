/**
 * A manual collection's hand order in the editor (review gaps, Decisions 2–4), on
 * `POST /_caracms/collection-order`.
 *
 *   moveInOrder(editor, collection, path, to)   a drag or ⌥↑/⌥↓: the list moves at once
 *   noteWaiting(editor, collection, path)       a new entry whose place waits on Site Settings
 *   orderHolder(marks)                          who has Site Settings, so the order can't change
 *
 * **A move shows at once.** The listing is put in the new order straight away (the documents
 * of that collection swap places among themselves), then the whole list goes to the server.
 * Moves made while one is on its way wait and go as one, the latest list; the listing is read
 * again once the last is kept, or at once when one is refused (the list goes back as it was)
 * with the server's sentence in the toast.
 *
 * **A waiting new entry** (`create` answered `order: 'waiting'`): someone else had Site
 * Settings, so it's after the named entries for now. On each live poll while it waits, once
 * nobody else has Site Settings, its place is sent (`first`); a refusal waits for the next
 * poll. If the tab closes first it stays where any unnamed entry is (Decisions during build).
 */
import { SITE_SETTINGS_FILE } from '../../../reserved.ts';
import { ENDPOINTS, type CollectionOrderResponse, type ListedDocument, type Person } from '../../types.ts';
import { post } from '../documents/actions.ts';
import type { DocMarks, Editor } from '../editor.ts';
import { createStore, type Store } from '../state/store.ts';

/** Per collection: the new entries whose place waits on Site Settings, newest last. */
export type Waiting = Record<string, string[]>;

interface HandOrderState {
	waiting: Store<Waiting>;
	/** Per collection: a move on its way, and the list to send after it (the latest). */
	sending: Map<string, { next: string[] | null }>;
	watching: boolean;
	placing: boolean;
	/** Page folders: a waiting new page's folder (`collection\0path` → the folder's id), sent with its filing. */
	folders: Map<string, string>;
}

const states = new WeakMap<Editor, HandOrderState>();

function stateOf(editor: Editor): HandOrderState {
	let state = states.get(editor);
	if (!state) states.set(editor, (state = { waiting: createStore<Waiting>({}), sending: new Map(), watching: false, placing: false, folders: new Map() }));
	return state;
}

/** The new entries waiting for their place, per collection. */
export const waitingFor = (editor: Editor): Store<Waiting> => stateOf(editor).waiting;

/** Who has Site Settings, which holds the order (someone else, in live mode), or null. */
export const orderHolder = (marks: ReadonlyMap<string, DocMarks>): Person | null => marks.get(SITE_SETTINGS_FILE)?.editing ?? null;

/** `documents` with `collection`'s entries in `order` (by path), in the places that collection's entries had. */
export function reordered(documents: readonly ListedDocument[], collection: string, order: readonly string[]): ListedDocument[] {
	const rank = new Map(order.map((p, i) => [p, i]));
	const mine = documents.filter((d) => d.collection === collection).sort((a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity));
	let i = 0;
	return documents.map((d) => (d.collection === collection ? mine[i++]! : d));
}

/** A collection's paths in Site order, as the listing has them. */
export const siteOrderOf = (documents: readonly ListedDocument[], collection: string): string[] => documents.filter((d) => d.collection === collection).map((d) => d.path);

/** Move `path` to `to` (an index in Site order). The list moves at once; the order is kept in the background. */
export function moveInOrder(editor: Editor, collection: string, path: string, to: number): void {
	const paths = siteOrderOf(editor.documents.get(), collection);
	const from = paths.indexOf(path);
	if (from < 0 || from === to) return;
	const next = [...paths];
	next.splice(from, 1);
	next.splice(Math.max(0, Math.min(to, next.length)), 0, path);
	editor.documents.set((all) => reordered(all, collection, next));
	const state = stateOf(editor);
	const busy = state.sending.get(collection);
	if (busy) {
		busy.next = next;
		return;
	}
	state.sending.set(collection, { next: null });
	void send(editor, collection, next);
}

async function send(editor: Editor, collection: string, order: string[]): Promise<void> {
	const state = stateOf(editor);
	const answer = await post<CollectionOrderResponse>(editor, ENDPOINTS.collectionOrder, { collection, order });
	const pending = state.sending.get(collection);
	if (answer.ok && pending?.next) {
		const next = pending.next;
		pending.next = null;
		return send(editor, collection, next);
	}
	state.sending.delete(collection);
	if (!answer.ok) {
		editor.toast(answer.error, 'warn');
		editor.announce(answer.error);
	}
	await editor.refreshDocuments().catch(() => undefined);
}

/** Decision 4: a new entry whose place waits on Site Settings. Its place goes once nobody else has it. */
export function noteWaiting(editor: Editor, collection: string, path: string, folder?: string): void {
	const state = stateOf(editor);
	// Page folders (check 10): New page in <Folder> waits the same way, and is filed when Site Settings is free.
	if (folder !== undefined) state.folders.set(`${collection}\0${path}`, folder);
	state.waiting.set((all) => ({ ...all, [collection]: [...(all[collection] ?? []).filter((p) => p !== path), path] }));
	if (state.watching || !editor.liveSession) return;
	state.watching = true;
	const stop = editor.liveState.subscribe((next, previous) => {
		if (next.status === previous.status) return;
		void placeWaiting(editor).then((left) => {
			if (!left) {
				stop();
				state.watching = false;
			}
		});
	});
}

/** Send each waiting entry's place, oldest first (so the newest ends up first). Returns whether any still wait. */
async function placeWaiting(editor: Editor): Promise<boolean> {
	const state = stateOf(editor);
	const waiting = state.waiting.get();
	if (state.placing) return true;
	if (orderHolder(editor.marks.get())) return Object.values(waiting).some((l) => l.length > 0);
	state.placing = true;
	let placed = false;
	try {
		for (const [collection, paths] of Object.entries(waiting)) {
			for (const path of paths) {
				const folder = state.folders.get(`${collection}\0${path}`);
				const answer = await post<CollectionOrderResponse>(editor, ENDPOINTS.collectionOrder, { collection, first: path, ...(folder !== undefined ? { folder } : {}) });
				// Gone meanwhile (deleted, or renamed): nothing to place. A folder gone by then: said (check 10).
				if (!answer.ok && answer.status !== 404) return true;
				if (!answer.ok && folder !== undefined) editor.toast(answer.error, 'warn');
				state.folders.delete(`${collection}\0${path}`);
				placed = true;
				state.waiting.set((all) => {
					const left = (all[collection] ?? []).filter((p) => p !== path);
					const out = { ...all };
					if (left.length) out[collection] = left;
					else delete out[collection];
					return out;
				});
			}
		}
	} finally {
		state.placing = false;
		if (placed) await editor.refreshDocuments().catch(() => undefined);
	}
	return Object.values(state.waiting.get()).some((l) => l.length > 0);
}
