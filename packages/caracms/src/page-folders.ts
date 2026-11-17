/**
 * Page folders: editor-only folders in the Pages tree,
 * saved in Site Settings' `pageFolders` beside `pageOrder`. Browser-safe, like page-order.ts.
 *
 * - **`PageFolders`**: a level's path (`""` for the top level) → its folders, in no particular
 *   order. A folder is `{ id, name, pages }`: `id` an address part, made from the name and kept
 *   on rename; `name` 1–60 characters; `pages` the slugs filed in it, in its order.
 * - **A folder's place** is the token `(<id>)` in its level's `pageOrder` list, read as a token
 *   only when the level has a folder with that id (Contracts). A folder with no token goes after
 *   the listed rows, folders by name, before the unlisted rows (Decision 7).
 * - **The reader's rules** for anything off are the spec's table: a level with a bad shape loses
 *   its folders; a slug naming nothing, `index`, or a slug already in an earlier folder is ignored;
 *   a folder with nothing to show isn't drawn; a filed slug's own `pageOrder` entry is ignored.
 * - **After moves** (`foldersAfterMoves`): re-keyed and re-slugged as `orderAfterMoves` does the
 *   order; a row that leaves its level leaves its folder; a slug arriving at a level where
 *   nothing was is cleared from any folder there first (a dead slug reused, Decision 9).
 * - **Settling** (`settleLayout`): what every write that touches folders ends with: members that
 *   name nothing dropped, empty folders and their tokens dropped, tokens naming no folder dropped.
 */
import { byLabel, moveUnits, parentOf, rekeyWith, slugOf, type PageOrder, type PathChange } from './page-order.ts';
import { isSlug, RESERVED_SLUG, slugify } from './slug.ts';

export interface PageFolder {
	id: string;
	name: string;
	pages: string[];
}

/** Site Settings' `pageFolders`: a level's path → its folders. */
export type PageFolders = Record<string, PageFolder[]>;

/** The longest a folder's name may be. */
export const FOLDER_NAME_MAX = 60;

/** The sentence a bad `pageFolders` is answered with (validate's error, the shape the docs give). */
export const PAGE_FOLDERS_SHAPE = '`pageFolders` must be { "<level path>": [{ "id": "<address part>", "name": "<1–60 characters>", "pages": ["<slug>"…] }…] }';

/** A folder's token in its level's `pageOrder` list. */
export const folderToken = (id: string): string => `(${id})`;

/** The folder id a `pageOrder` entry names if it's a token (`(company)` → `company`), else null. */
export function tokenIdOf(entry: string): string | null {
	const m = /^\((.+)\)$/.exec(entry);
	return m ? m[1]! : null;
}

/** The trimmed name, or null when it's empty or longer than `FOLDER_NAME_MAX`. */
export function folderName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const name = raw.trim();
	return name && [...name].length <= FOLDER_NAME_MAX ? name : null;
}

/** One level's folders checked for shape: the problem in words, or null. */
function levelProblem(list: unknown): string | null {
	if (!Array.isArray(list)) return 'isn’t a list of folders';
	const ids = new Set<string>();
	for (const [i, f] of list.entries()) {
		const which = `folder ${i + 1}`;
		if (!f || typeof f !== 'object' || Array.isArray(f)) return `${which} isn’t { id, name, pages }`;
		const r = f as Record<string, unknown>;
		const extra = Object.keys(r).filter((k) => !['id', 'name', 'pages'].includes(k));
		if (extra.length) return `${which} has ${extra.map((k) => JSON.stringify(k.slice(0, 60))).join(', ')}, which a folder doesn’t take`;
		if (typeof r.id !== 'string' || !isSlug(r.id)) return `${which}’s id isn’t an address part`;
		if (folderName(r.name) === null) return `${which} has no name, or one over ${FOLDER_NAME_MAX} characters`;
		// A member that's empty or has a `/` is the right shape but names nothing (`isMember`): ignored, not a shape error.
		if (!Array.isArray(r.pages) || !r.pages.every((s) => typeof s === 'string')) return `${which}’s pages aren’t a list of slugs`;
		if (ids.has(r.id)) return `two folders have the id "${r.id}"`;
		ids.add(r.id);
	}
	return null;
}

/** Whether a folder's member can name something: a single address part (not empty, no `/`). Anything else names nothing (check 21; the reader ignores it, `validate` warns). */
export const isMember = (slug: string): boolean => slug !== '' && !slug.includes('/');

/** A shape problem in `pageFolders`: the level it's at (`null`: the whole value) and what's wrong. */
export interface FolderShapeProblem {
	level: string | null;
	message: string;
}

/**
 * `pageFolders` as written: the levels whose shape is right (names trimmed, each folder's pages
 * without repeats), and a problem for each level that isn't (the reader ignores that level).
 */
export function readPageFolders(raw: unknown): { folders: PageFolders; problems: FolderShapeProblem[] } {
	if (raw === undefined || raw === null) return { folders: {}, problems: [] };
	if (typeof raw !== 'object' || Array.isArray(raw)) return { folders: {}, problems: [{ level: null, message: 'isn’t an object of levels' }] };
	const folders: PageFolders = {};
	const problems: FolderShapeProblem[] = [];
	for (const [level, list] of Object.entries(raw as Record<string, unknown>)) {
		const problem = levelProblem(list);
		if (problem) {
			problems.push({ level, message: problem });
			continue;
		}
		folders[level] = (list as PageFolder[]).map((f) => ({ id: f.id, name: folderName(f.name)!, pages: [...new Set(f.pages)] }));
	}
	return { folders, problems };
}

/** `pageFolders` as the reader takes it: the levels with a bad shape left out. */
export function parsePageFolders(raw: unknown): PageFolders {
	return readPageFolders(raw).folders;
}

/** A folder resolved against its level: the rows filed in it that exist, in its order. */
export interface ResolvedFolder<T> {
	id: string;
	name: string;
	rows: T[];
}

/**
 * One level in order, folders in their places with their rows together (Decisions 3 and 7,
 * the reader's table). `items`: the level's pages and groups; `saved`: its `pageOrder` list;
 * `filled`: has pages or a held collection under it (the rule's tie-break). `rows` is the level
 * flattened (what the listing and `documents()` see); `folders` the drawn folders in tree order.
 */
export function orderLevel<T extends { path: string; label: string }>(
	items: readonly T[],
	saved: readonly string[] | undefined,
	folders: readonly PageFolder[] | undefined,
	filled: (item: T) => boolean,
): { rows: T[]; folders: ResolvedFolder<T>[] } {
	const list = folders ?? [];
	const bySlug = new Map(items.map((i) => [slugOf(i.path), i]));
	const filed = new Set<string>();
	const drawn: ResolvedFolder<T>[] = [];
	for (const f of list) {
		const rows: T[] = [];
		for (const slug of f.pages) {
			const item = bySlug.get(slug);
			if (!item || slug === RESERVED_SLUG || filed.has(slug)) continue;
			filed.add(slug);
			rows.push(item);
		}
		if (rows.length) drawn.push({ id: f.id, name: f.name, rows });
	}
	const ids = new Set(list.map((f) => f.id));
	const rank = new Map<string, number>();
	(saved ?? []).forEach((entry, i) => {
		const id = tokenIdOf(entry);
		const key = id !== null && ids.has(id) ? `f\0${id}` : `p\0${entry}`;
		if (!rank.has(key)) rank.set(key, i);
	});
	type Unit = { row: T; folder?: undefined } | { folder: ResolvedFolder<T>; row?: undefined };
	const units: Unit[] = [...items.filter((i) => !filed.has(slugOf(i.path))).map((row) => ({ row })), ...drawn.map((folder) => ({ folder }))];
	const home = (u: Unit) => !!u.row && slugOf(u.row.path) === RESERVED_SLUG;
	const rankOf = (u: Unit) => rank.get(u.folder ? `f\0${u.folder.id}` : `p\0${slugOf(u.row!.path)}`);
	units.sort((a, b) => {
		const ha = home(a);
		const hb = home(b);
		if (ha !== hb) return ha ? -1 : 1;
		const ra = rankOf(a);
		const rb = rankOf(b);
		if (ra !== undefined || rb !== undefined) {
			if (ra === undefined) return 1;
			if (rb === undefined) return -1;
			if (ra !== rb) return ra - rb;
		}
		// Unlisted: folders by name, then the rows by the rule.
		if (!!a.folder !== !!b.folder) return a.folder ? -1 : 1;
		if (a.folder && b.folder) return byLabel({ label: a.folder.name, path: a.folder.id }, { label: b.folder.name, path: b.folder.id });
		const fa = filled(a.row!);
		const fb = filled(b.row!);
		if (fa !== fb) return fa ? -1 : 1;
		return byLabel(a.row!, b.row!);
	});
	return {
		rows: units.flatMap((u) => (u.folder ? u.folder.rows : [u.row!])),
		folders: units.flatMap((u) => (u.folder ? [u.folder] : [])),
	};
}

/** What the listing carries for the Pages collection (Contracts): each level's drawn folders, in tree order, with their rows' paths in order. */
export interface ListedFolder {
	id: string;
	name: string;
	rows: string[];
}
export type ListedFolders = Record<string, ListedFolder[]>;

/** Every page and group path the Pages collection's paths make (groups being the folders above a page). */
export function nodePaths(paths: readonly string[]): Set<string> {
	const known = new Set<string>();
	for (const p of paths) {
		const parts = p.split('/');
		for (let i = 1; i <= parts.length; i++) known.add(parts.slice(0, i).join('/'));
	}
	return known;
}

const childPath = (level: string, slug: string) => (level === '' ? slug : `${level}/${slug}`);

/**
 * The folders as they stand, settled against `paths` (the Pages collection's paths after any
 * moves): members that name nothing, `index`, a slug in an earlier folder, and a slug's own
 * order entry when it's filed are dropped; then empty folders, their tokens, tokens naming no
 * folder and levels with nothing left. Every write that touches folders ends here.
 */
export function settleLayout(order: PageOrder, folders: PageFolders, paths: readonly string[]): { order: PageOrder; folders: PageFolders } {
	const known = nodePaths(paths);
	known.add('');
	const outFolders: PageFolders = {};
	for (const [level, list] of Object.entries(folders)) {
		if (!known.has(level)) continue;
		const seen = new Set<string>();
		const kept: PageFolder[] = [];
		for (const f of list) {
			if (kept.some((k) => k.id === f.id)) continue;
			const pages = f.pages.filter((slug) => {
				if (!isMember(slug) || slug === RESERVED_SLUG || seen.has(slug) || !known.has(childPath(level, slug))) return false;
				seen.add(slug);
				return true;
			});
			if (pages.length) kept.push({ id: f.id, name: f.name, pages });
		}
		if (kept.length) outFolders[level] = kept;
	}
	const outOrder: PageOrder = {};
	for (const [level, list] of Object.entries(order)) {
		const levelFolders = outFolders[level] ?? [];
		const ids = new Set(levelFolders.map((f) => f.id));
		const filed = new Set(levelFolders.flatMap((f) => f.pages));
		const kept = list.filter((entry) => {
			const id = tokenIdOf(entry);
			if (id !== null) {
				if (ids.has(id)) return true;
				// A token whose folder went, or naming none: dropped (a real `(name)` page or group stays).
				if ((folders[level] ?? []).some((f) => f.id === id) || !known.has(childPath(level, entry))) return false;
			}
			return !filed.has(entry);
		});
		if (kept.length) outOrder[level] = [...new Set(kept)];
	}
	return { order: outOrder, folders: outFolders };
}

/**
 * The saved folders once these moves land: each level's key re-keyed, a moved row re-slugged in
 * its folder when it stays at its level, taken out of its folder when it leaves, and the slug it
 * arrives with cleared from any folder at its new level when nothing was at that path before
 * (a dead slug reused, Decision 9). A live group's slug stays filed: a page arriving at a
 * group's address joins the group, in its folder.
 */
export function foldersAfterMoves(folders: PageFolders, moves: readonly PathChange[], pathsBefore: readonly string[] = []): PageFolders {
	const units = moveUnits(moves, pathsBefore);
	const knownBefore = nodePaths(pathsBefore);
	const out: PageFolders = {};
	const rekey = rekeyWith(units);
	for (const [level, list] of Object.entries(folders)) {
		const into = (out[rekey(level)] ??= []);
		for (const f of list) if (!into.some((g) => g.id === f.id)) into.push({ id: f.id, name: f.name, pages: [...f.pages] });
	}
	if (units.length === 0) return out;
	// Each unit's place in its old folder, marked first, so a swap's slugs can't meet.
	const marks = units.map((_, i) => `\u0000${i}`);
	units.forEach((u, i) => {
		for (const f of out[rekey(parentOf(u.from))] ?? []) {
			const at = f.pages.indexOf(slugOf(u.from));
			if (at >= 0) f.pages[at] = marks[i]!;
		}
	});
	units.forEach((u, i) => {
		const oldKey = rekey(parentOf(u.from));
		const newKey = parentOf(u.to);
		const slug = slugOf(u.to);
		if (!knownBefore.has(u.to)) for (const f of out[newKey] ?? []) f.pages = f.pages.filter((s) => s !== slug);
		for (const f of out[oldKey] ?? []) {
			const at = f.pages.indexOf(marks[i]!);
			if (at < 0) continue;
			if (oldKey === newKey) f.pages[at] = slug;
			else f.pages.splice(at, 1);
		}
	});
	for (const list of Object.values(out)) for (const f of list) f.pages = f.pages.filter((s) => !s.startsWith('\u0000'));
	return out;
}

/** The Apply's folders (Contracts): the saved folders after the moves, then the request's levels replacing those keys (`[]` drops a level). */
export function arrangedFolders(saved: PageFolders, requested: PageFolders, moves: readonly PathChange[], pathsBefore: readonly string[] = []): PageFolders {
	return { ...foldersAfterMoves(saved, moves, pathsBefore), ...requested };
}

/** The folders the listing carries (Contracts): `paths` the Pages listing in tree order; folders in the order their rows first appear. */
export function listedFolders(paths: readonly string[], folders: PageFolders): ListedFolders {
	const known = nodePaths(paths);
	const firstSeen = new Map<string, number>();
	for (const [i, p] of paths.entries()) {
		const parts = p.split('/');
		for (let j = 1; j <= parts.length; j++) {
			const node = parts.slice(0, j).join('/');
			if (!firstSeen.has(node)) firstSeen.set(node, i);
		}
	}
	const out: ListedFolders = {};
	for (const [level, list] of Object.entries(folders)) {
		if (level !== '' && !known.has(level)) continue;
		const seen = new Set<string>();
		const drawn: ListedFolder[] = [];
		for (const f of list) {
			const rows = f.pages
				.filter((slug) => {
					if (!isMember(slug) || slug === RESERVED_SLUG || seen.has(slug) || !known.has(childPath(level, slug))) return false;
					seen.add(slug);
					return true;
				})
				.map((slug) => childPath(level, slug));
			if (rows.length) drawn.push({ id: f.id, name: f.name, rows });
		}
		drawn.sort((a, b) => (firstSeen.get(a.rows[0]!) ?? 0) - (firstSeen.get(b.rows[0]!) ?? 0));
		if (drawn.length) out[level] = drawn;
	}
	return out;
}

/** A new folder's id at its level (check 7): its name by the slug rules (`folder` when nothing's left), suffixed `-2`, `-3`… past `taken` (every id at the level, drawn or not). */
export function newFolderId(name: string, taken: Iterable<string>): string {
	const base = slugify(name) || 'folder';
	const used = new Set(taken);
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}
