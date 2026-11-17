/**
 * The Pages tree's saved order (arrange pages, Decisions 6, 7 and 19). Browser-safe: no
 * node or disk imports, so the editor's client uses the same rules as the server.
 *
 * - **`PageOrder`** is Site Settings' `pageOrder`: a parent's path (`""` for the top level)
 *   → its children's slugs, pages and groups alike, in order. Absent means "the rule".
 * - **The order of one level** (`orderSiblings`, Decision 7): Home first, always; then the
 *   siblings the saved list names, in that order (an unknown slug is ignored); then the
 *   unlisted ones, those with pages or a held collection under them first, then A–Z by
 *   label (content.ts's collator).
 * - **After moves** (`orderAfterMoves`, Decision 6): a moved page's slug leaves its old
 *   parent's list and goes at the end of its new parent's (when that level has a saved
 *   list; with none, the rule places it); every key at or under a moved path is re-keyed,
 *   at any depth; a group renamed (every page under it moving to the same place under a new
 *   folder) changes its key and its slug in place; a list left empty is dropped.
 * - **The Apply's merge** (`arrangedOrder`): the re-keyed saved order, then the request's
 *   own lists replacing those keys.
 * - **The stamp** (`pageOrderStamp`, Decision 18): a short hash of the order, so another
 *   tab sees an order-only change on its next poll.
 */

import type { PageFolders } from './page-folders.ts';

/** Site Settings' `pageOrder`: parent path (`""` is the top level) → its children's slugs in order. */
export type PageOrder = Record<string, string[]>;

/** One path that changes: a page's (or a group's folder's) path in the Pages collection, before → after. */
export interface PathChange {
	from: string;
	to: string;
}

/** The collection the saved order is for: the nested section builder at `/` (Pages). */
export function isOrderedCollection(collection: { nested?: boolean; urlBase: string | null }): boolean {
	return !!collection.nested && collection.urlBase === '/';
}

/** A path's parent (`''` at the top level). */
export const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** A path's last part. */
export const slugOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const isHome = (path: string) => path === 'index' || path.endsWith('/index');
const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
/** A–Z by label, then by path (content.ts's order). */
export function byLabel(a: { label: string; path: string }, b: { label: string; path: string }): number {
	return collator.compare(a.label, b.label) || collator.compare(a.path, b.path);
}

/**
 * One level of the tree in order (Decision 7): Home first; then the siblings `saved` names,
 * in its order; then the rest, those `filled` (pages or a held collection under them) first,
 * then A–Z by label. `saved` undefined: the rule alone.
 */
export function orderSiblings<T extends { path: string; label: string }>(items: readonly T[], saved: readonly string[] | undefined, filled: (item: T) => boolean): T[] {
	const rank = new Map<string, number>();
	(saved ?? []).forEach((slug, i) => {
		if (!rank.has(slug)) rank.set(slug, i);
	});
	return [...items].sort((a, b) => {
		const ha = isHome(a.path);
		const hb = isHome(b.path);
		if (ha !== hb) return ha ? -1 : 1;
		const ra = rank.get(slugOf(a.path));
		const rb = rank.get(slugOf(b.path));
		if (ra !== undefined || rb !== undefined) {
			if (ra === undefined) return 1;
			if (rb === undefined) return -1;
			if (ra !== rb) return ra - rb;
		}
		const fa = filled(a);
		const fb = filled(b);
		if (fa !== fb) return fa ? -1 : 1;
		return byLabel(a, b);
	});
}

/** `pageOrder` as read from a file: an object of string lists; anything else dropped, each list without repeats, empty lists left out. */
export function parsePageOrder(raw: unknown): PageOrder {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out: PageOrder = {};
	for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(list)) continue;
		const slugs = [...new Set(list.filter((s): s is string => typeof s === 'string' && s !== ''))];
		if (slugs.length) out[key] = slugs;
	}
	return out;
}

/** The order without its empty lists (and without repeats in a list). */
function tidy(order: PageOrder): PageOrder {
	const out: PageOrder = {};
	for (const [key, list] of Object.entries(order)) {
		const slugs = [...new Set(list)];
		if (slugs.length) out[key] = slugs;
	}
	return out;
}

/**
 * The groups the moves rename: a folder with no page of its own (in `pathsBefore`, the Pages
 * collection's paths before the moves) all of whose pages move to the same place under one
 * new folder that's free once the moves land (a swap is fine). Topmost only.
 */
export function groupRenames(pathsBefore: readonly string[], moves: readonly PathChange[]): PathChange[] {
	const pages = new Set(pathsBefore);
	const moving = new Map(moves.map((m) => [m.from, m.to]));
	const folders = new Set<string>();
	for (const p of pathsBefore) {
		const parts = p.split('/');
		for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
	}
	const renames: PathChange[] = [];
	for (const group of [...folders].filter((f) => !pages.has(f)).sort((a, b) => a.split('/').length - b.split('/').length)) {
		if (renames.some((r) => under(group, r.from))) continue;
		const inside = pathsBefore.filter((p) => p.startsWith(`${group}/`));
		let to: string | null = null;
		const same = inside.every((p) => {
			const target = moving.get(p);
			const rest = p.slice(group.length);
			if (target === undefined || !target.endsWith(rest)) return false;
			const folder = target.slice(0, target.length - rest.length);
			if (to === null) to = folder;
			return folder === to;
		});
		if (!same || to === null || to === '' || to === group || under(to, group)) continue;
		const into = to as string;
		// The new folder is free once the moves land: whatever's there now moves away.
		if (pathsBefore.some((p) => under(p, into) && !moving.has(p))) continue;
		renames.push({ from: group, to: into });
	}
	return renames;
}

/**
 * The moves that change a list: every real move and every group the moves rename, minus
 * those carried by a move above them (shallowest first). Page folders re-key with these too.
 */
export function moveUnits(moves: readonly PathChange[], pathsBefore: readonly string[] = []): PathChange[] {
	const all = [...moves.filter((m) => m.from !== m.to), ...groupRenames(pathsBefore, moves)].sort((a, b) => a.from.split('/').length - b.from.split('/').length);
	const units: PathChange[] = [];
	for (const m of all) {
		if (units.some((u) => u.from === m.from)) continue;
		const carried = units.some((u) => m.from.startsWith(`${u.from}/`) && m.to === u.to + m.from.slice(u.from.length));
		if (!carried) units.push(m);
	}
	return units;
}

/** A path as it reads once `units` land (the deepest unit at or above it wins). */
export function rekeyWith(units: readonly PathChange[]): (path: string) => string {
	return (path) => {
		let best: PathChange | null = null;
		for (const u of units) if (under(path, u.from) && (!best || u.from.length > best.from.length)) best = u;
		return best ? best.to + path.slice(best.from.length) : path;
	};
}

/**
 * The saved order once these moves land (Decision 6). `moves`: every page path that changes
 * (Change address…'s or an Apply's, expanded: the pages under a moved page included);
 * `pathsBefore`: the Pages collection's paths before them, for the groups they rename.
 */
export function orderAfterMoves(order: PageOrder, moves: readonly PathChange[], pathsBefore: readonly string[] = []): PageOrder {
	const units = moveUnits(moves, pathsBefore);
	if (units.length === 0) return tidy(order);
	const rekey = rekeyWith(units);
	const out: PageOrder = {};
	for (const [key, list] of Object.entries(order)) {
		const into = (out[rekey(key)] ??= []);
		for (const slug of list) if (!into.includes(slug)) into.push(slug);
	}
	// Each unit's place in its old list, marked first, so a swap's slugs can't meet.
	const marks = units.map((_, i) => `\u0000${i}`);
	units.forEach((u, i) => {
		const list = out[rekey(parentOf(u.from))];
		const at = list ? list.indexOf(slugOf(u.from)) : -1;
		if (at >= 0) list![at] = marks[i]!;
	});
	units.forEach((u, i) => {
		const oldKey = rekey(parentOf(u.from));
		const newKey = parentOf(u.to);
		const slug = slugOf(u.to);
		const old = out[oldKey];
		const at = old ? old.indexOf(marks[i]!) : -1;
		if (oldKey === newKey) {
			// Renamed in place (a group rename, or a page's own slug): it keeps its place.
			if (at >= 0) {
				if (old!.includes(slug)) old!.splice(at, 1);
				else old![at] = slug;
			}
			return;
		}
		if (at >= 0) old!.splice(at, 1);
		const into = out[newKey];
		if (into && !into.includes(slug)) into.push(slug);
	});
	for (const list of Object.values(out)) for (let i = list.length - 1; i >= 0; i--) if (list[i]!.startsWith('\u0000')) list.splice(i, 1);
	return tidy(out);
}

/** The Apply's order (Contracts): the saved order re-keyed after the moves, then the request's lists replacing those keys, empty lists dropped. */
export function arrangedOrder(saved: PageOrder, requested: PageOrder, moves: readonly PathChange[], pathsBefore: readonly string[] = []): PageOrder {
	return tidy({ ...orderAfterMoves(saved, moves, pathsBefore), ...requested });
}

/**
 * The saved order's entries that name nothing: a key that's no page or group, or a slug that's no
 * child of its key. `paths`: the Pages collection's paths. Page folders: a token `(<id>)` naming a
 * folder in `folders` at its key is known (else `--fix` would prune every folder's place).
 */
export function unknownOrderEntries(order: PageOrder, paths: readonly string[], folders: PageFolders = {}): { key: string; slug: string | null }[] {
	const known = new Set<string>(['']);
	for (const p of paths) {
		const parts = p.split('/');
		for (let i = 1; i <= parts.length; i++) known.add(parts.slice(0, i).join('/'));
	}
	const out: { key: string; slug: string | null }[] = [];
	for (const [key, list] of Object.entries(order)) {
		if (!known.has(key)) {
			out.push({ key, slug: null });
			continue;
		}
		const ids = new Set((folders[key] ?? []).map((f) => `(${f.id})`));
		for (const slug of list) if (!ids.has(slug) && !known.has(key === '' ? slug : `${key}/${slug}`)) out.push({ key, slug });
	}
	return out;
}

/** The order without the entries `unknownOrderEntries` finds, and how many slugs went. */
export function prunedOrder(order: PageOrder, paths: readonly string[], folders: PageFolders = {}): { order: PageOrder; pruned: number } {
	const unknown = unknownOrderEntries(order, paths, folders);
	if (unknown.length === 0) return { order, pruned: 0 };
	const out: PageOrder = {};
	let pruned = 0;
	for (const [key, list] of Object.entries(order)) {
		if (unknown.some((u) => u.key === key && u.slug === null)) {
			pruned += list.length;
			continue;
		}
		const kept = list.filter((slug) => !unknown.some((u) => u.key === key && u.slug === slug));
		pruned += list.length - kept.length;
		if (kept.length) out[key] = kept;
	}
	return { order: out, pruned };
}

/** FNV-1a over a text, in base 36. */
function fnv(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/**
 * Decision 10: a short hash of a collection's document paths, sorted (FNV-1a), so the Apply
 * can tell the listing it was planned on from the one it lands on (`ArrangeRequest.expect`).
 */
export function listingStamp(paths: readonly string[]): string {
	return fnv(JSON.stringify([...paths].sort()));
}

/**
 * Decision 18: a short hash of the order (FNV-1a over its keys in order); `""` when there's none.
 * Page folders (Decision 12): it covers `pageFolders` too, appended after a `+` only when there
 * are some, so a site without folders keeps the stamp it had.
 */
export function pageOrderStamp(order: PageOrder | null | undefined, folders?: PageFolders | null): string {
	const keys = order ? Object.keys(order).sort() : [];
	const base = keys.length === 0 ? '' : fnv(JSON.stringify(keys.map((k) => [k, order![k]])));
	const levels = folders ? Object.keys(folders).filter((k) => folders[k]!.length > 0).sort() : [];
	if (levels.length === 0) return base;
	return `${base}+${fnv(JSON.stringify(levels.map((k) => [k, folders![k]!.map((f) => [f.id, f.name, f.pages])])))}`;
}
