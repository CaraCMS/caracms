/**
 * A collection's hand order (review gaps, Decisions 1–5). Browser-safe: no node or disk
 * imports, so the editor's client uses the same rules as the server.
 *
 * - **`CollectionOrder`** is Site Settings' `collectionOrder`: a manual collection's name
 *   (`order: 'manual'`) → its documents' paths, in order. Absent means "the rule".
 * - **The order** (`inSiteOrder`, Decision 4): the paths the saved list names, in its order
 *   (an unknown path is ignored); then the rest A–Z by label, page-order.ts's rule for pages.
 * - **A new entry** (`withFirst`, Decision 4) goes first.
 * - **After moves** (`collectionOrderAfterMoves`, Decision 2): a renamed entry keeps its place.
 * - **What validate finds** (`unknownCollectionOrderEntries`, Decision 2): a key that's no
 *   manual collection, or a path that's no document of it; `prunedCollectionOrder` drops them.
 */
import { byLabel, parsePageOrder } from './page-order.ts';

/** Site Settings' `collectionOrder`: a manual collection's name → its documents' paths in order. */
export type CollectionOrder = Record<string, string[]>;

/** One document's path change in a collection (a rename, a move). */
export interface CollectionPathChange {
	collection: string;
	from: string;
	to: string;
}

/** Whether a collection has a hand order (`order: 'manual'`). */
export const isManual = (collection: { order?: 'manual' | null } | undefined): boolean => collection?.order === 'manual';

/** `collectionOrder` as read from a file: an object of path lists; anything else dropped, each list without repeats, empty lists left out. */
export const parseCollectionOrder = (raw: unknown): CollectionOrder => parsePageOrder(raw);

/**
 * A manual collection's documents in Site order (Decision 4): the ones `saved` names, in its
 * order, then the rest A–Z by label. `saved` undefined: A–Z alone.
 */
export function inSiteOrder<T extends { path: string; label: string }>(items: readonly T[], saved: readonly string[] | undefined): T[] {
	const rank = new Map<string, number>();
	(saved ?? []).forEach((path, i) => {
		if (!rank.has(path)) rank.set(path, i);
	});
	return [...items].sort((a, b) => {
		const ra = rank.get(a.path);
		const rb = rank.get(b.path);
		if (ra !== undefined || rb !== undefined) {
			if (ra === undefined) return 1;
			if (rb === undefined) return -1;
			if (ra !== rb) return ra - rb;
		}
		return byLabel(a, b);
	});
}

/** The order without its empty lists (and without repeats in a list). */
function tidy(order: CollectionOrder): CollectionOrder {
	const out: CollectionOrder = {};
	for (const [key, list] of Object.entries(order)) {
		const paths = [...new Set(list)];
		if (paths.length) out[key] = paths;
	}
	return out;
}

/** Decision 4: the order with `path` first in `collection`'s list (taken from wherever it was). */
export function withFirst(order: CollectionOrder, collection: string, path: string): CollectionOrder {
	return tidy({ ...order, [collection]: [path, ...(order[collection] ?? []).filter((p) => p !== path)] });
}

/** The order with `collection`'s list replaced by `paths` (a drag's whole list). */
export function withList(order: CollectionOrder, collection: string, paths: readonly string[]): CollectionOrder {
	return tidy({ ...order, [collection]: [...paths] });
}

/**
 * Decision 2: the order once these moves land. A moved document's path changes in place in
 * its collection's list, so it keeps its place; a swap's paths can't meet (both change at once).
 */
export function collectionOrderAfterMoves(order: CollectionOrder, changes: readonly CollectionPathChange[]): CollectionOrder {
	const out: CollectionOrder = {};
	for (const [collection, list] of Object.entries(order)) {
		const moving = new Map(changes.filter((c) => c.collection === collection && c.from !== c.to).map((c) => [c.from, c.to]));
		out[collection] = moving.size ? list.map((p) => moving.get(p) ?? p) : [...list];
	}
	return tidy(out);
}

/** The saved order's entries that name nothing: a key that's no manual collection (`path` null), or a path that's no document of it. `paths`: each manual collection's document paths. */
export function unknownCollectionOrderEntries(order: CollectionOrder, paths: ReadonlyMap<string, readonly string[]>): { collection: string; path: string | null }[] {
	const out: { collection: string; path: string | null }[] = [];
	for (const [collection, list] of Object.entries(order)) {
		const known = paths.get(collection);
		if (!known) {
			out.push({ collection, path: null });
			continue;
		}
		const set = new Set(known);
		for (const path of list) if (!set.has(path)) out.push({ collection, path });
	}
	return out;
}

/** The order without the entries `unknownCollectionOrderEntries` finds, and how many paths went. */
export function prunedCollectionOrder(order: CollectionOrder, paths: ReadonlyMap<string, readonly string[]>): { order: CollectionOrder; pruned: number } {
	const unknown = unknownCollectionOrderEntries(order, paths);
	if (unknown.length === 0) return { order, pruned: 0 };
	const out: CollectionOrder = {};
	let pruned = 0;
	for (const [collection, list] of Object.entries(order)) {
		if (unknown.some((u) => u.collection === collection && u.path === null)) {
			pruned += list.length;
			continue;
		}
		const kept = list.filter((p) => !unknown.some((u) => u.collection === collection && u.path === p));
		pruned += list.length - kept.length;
		if (kept.length) out[collection] = kept;
	}
	return { order: out, pruned };
}
