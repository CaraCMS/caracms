/**
 * Arrange pages (Contracts → Apply request): the arrange screen's Apply, both modes.
 *
 * **A security boundary, as move is** (move.ts): the paths come from the browser, so the
 * route is the same POST-JSON-same-origin handler, and every move goes through the
 * many-move engine (`moveMany`: create.ts → `target`, the store's own checks and locks).
 *
 * - `planArrange` expands each root with Change address…'s expansion (move.ts →
 *   `movesUnder`): everything under it, except what's under another root, which wins for its
 *   own subtree. It checks every `order` key and slug against the Pages collection as it
 *   will be once the moves land, and builds the engine's Site Settings edit: the saved order
 *   re-keyed after the moves, the request's lists replacing those keys (page-order.ts →
 *   `arrangedOrder`), so the order and the redirects land, or roll back, in one write.
 * - With no moves (an order-only Apply, Decision 21), the store writes Site Settings alone,
 *   taking its lock in live mode (`DraftsStore.arrange`).
 * - Change address… keeps the order current the same way (`orderEdit`, Decision 6).
 * - Page folders: the request's `folders` are checked (`bad-folders`, check 21) and merged with
 *   the saved ones after the moves (page-folders.ts → `arrangedFolders`, `settleLayout`), in the
 *   same write; `expectOrder` refuses a plan made on an order or folders that changed since
 *   (Decision 12). Change address… keeps folders current too.
 */
import type { ResolvedCollection, ResolvedSite } from '../../config.ts';
import type { DocumentEntry } from '../../content.ts';
import { parseAnyDocument } from '../../document.ts';
import type { Person } from '../../live/messages.ts';
import { arrangedOrder, isOrderedCollection, listingStamp, orderAfterMoves, pageOrderStamp, parsePageOrder, type PageOrder, type PathChange } from '../../page-order.ts';
import { arrangedFolders, folderName, foldersAfterMoves, isMember, listedFolders, nodePaths, readPageFolders, settleLayout, tokenIdOf, type FolderShapeProblem, type PageFolder, type PageFolders } from '../../page-folders.ts';
import { isSlug, RESERVED_SLUG } from '../../slug.ts';
import type { ContentSource } from '../../content.ts';
import { savedPageLayout } from '../../content.ts';
import type { PagesLayout } from '../types.ts';
import { handOrderEdit, settingsWithKey } from './collection-order.ts';
import type { ArrangeRequest, ArrangeResponse } from '../types.ts';
import { refused } from './create.ts';
import { movesUnder, type PathMove } from './move.ts';
import { checkOrigin, seqOf, tabOf, WriteRefused, type WriteContext } from './write.ts';
import { readCappedText } from '../../body.ts';

type Site = Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>;

/** An Apply's body can carry a whole tree's order and moves. */
export const MAX_ARRANGE_BODY_BYTES = 256 * 1024;

const ARRANGE_SHAPE = '{ moves: [{ collection, fromPath, toPath }…], order: { "<parent path>": ["slug"…] }, folders?: { "<level path>": [{ id, name, pages }…] }, redirect?, expect?, expectOrder? }';

/** Decision 10's sentence when the listing isn't the one the review was planned on. */
export const CHANGED_MESSAGE = 'The pages changed since you opened the review.';

/** Validate an Apply body's shape. Throws WriteRefused 400. */
export function parseArrangeBody(body: unknown): ArrangeRequest {
	const bad = (why: string) => refused(400, 'bad-request', `Malformed body: ${why}. Send ${ARRANGE_SHAPE}.`);
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('it must be a JSON object');
	const b = body as Record<string, unknown>;
	const extra = Object.keys(b).filter((k) => !['moves', 'order', 'folders', 'redirect', 'expect', 'expectOrder'].includes(k));
	if (extra.length) throw bad(`unexpected ${extra.map((k) => JSON.stringify(k.slice(0, 60))).join(', ')}`);
	if (!Array.isArray(b.moves)) throw bad('"moves" must be a list');
	const moves = b.moves.map((m, i) => {
		if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad(`moves[${i}] must be { collection, fromPath, toPath }`);
		const r = m as Record<string, unknown>;
		if (Object.keys(r).some((k) => !['collection', 'fromPath', 'toPath'].includes(k))) throw bad(`moves[${i}] must be { collection, fromPath, toPath }`);
		if (typeof r.collection !== 'string' || r.collection === '') throw bad(`moves[${i}].collection must be a collection's name`);
		if (typeof r.fromPath !== 'string' || r.fromPath === '') throw bad(`moves[${i}].fromPath must be the page's path`);
		if (typeof r.toPath !== 'string') throw bad(`moves[${i}].toPath must be the page's new path`);
		if (r.fromPath.length > 512 || r.toPath.length > 512) throw refused(400, 'bad-path', 'That path is too long.');
		return { collection: r.collection, fromPath: r.fromPath, toPath: r.toPath };
	});
	if (!b.order || typeof b.order !== 'object' || Array.isArray(b.order)) throw bad('"order" must be an object of lists');
	const order: PageOrder = {};
	for (const [key, list] of Object.entries(b.order as Record<string, unknown>)) {
		if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && s !== '')) throw bad(`order[${JSON.stringify(key.slice(0, 60))}] must be a list of slugs`);
		if (key.length > 512) throw refused(400, 'bad-path', 'That path is too long.');
		order[key] = [...new Set(list as string[])];
	}
	if (b.redirect !== undefined && typeof b.redirect !== 'boolean') throw bad('"redirect" must be true or false');
	let expect: Record<string, string> | undefined;
	if (b.expect !== undefined) {
		if (!b.expect || typeof b.expect !== 'object' || Array.isArray(b.expect) || !Object.values(b.expect).every((v) => typeof v === 'string')) throw bad('"expect" must be { "<collection>": "<stamp>" }');
		expect = { ...(b.expect as Record<string, string>) };
	}
	if (b.expectOrder !== undefined && typeof b.expectOrder !== 'string') throw bad('"expectOrder" must be the order stamp');
	let folders: PageFolders | undefined;
	if (b.folders !== undefined) {
		if (!b.folders || typeof b.folders !== 'object' || Array.isArray(b.folders)) throw bad('"folders" must be { "<level path>": [{ id, name, pages }…] }');
		folders = {};
		for (const [key, list] of Object.entries(b.folders as Record<string, unknown>)) {
			if (key.length > 512) throw refused(400, 'bad-path', 'That path is too long.');
			if (!Array.isArray(list)) throw bad(`folders[${JSON.stringify(key.slice(0, 60))}] must be a list of { id, name, pages }`);
			folders[key] = list.map((f, i) => {
				const where = `folders[${JSON.stringify(key.slice(0, 60))}][${i}]`;
				if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad(`${where} must be { id, name, pages }`);
				const r = f as Record<string, unknown>;
				if (Object.keys(r).some((k) => !['id', 'name', 'pages'].includes(k))) throw bad(`${where} must be { id, name, pages }`);
				if (typeof r.id !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.pages) || !r.pages.every((s) => typeof s === 'string')) throw bad(`${where} must be { id, name, pages }`);
				return { id: r.id, name: r.name, pages: r.pages as string[] };
			});
		}
	}
	return {
		moves,
		order,
		...(folders ? { folders } : {}),
		...(b.redirect === false ? { redirect: false } : {}),
		...(expect ? { expect } : {}),
		...(typeof b.expectOrder === 'string' ? { expectOrder: b.expectOrder } : {}),
	};
}

/** Check 21's sentence. */
const badFolders = (why: string) => refused(400, 'bad-folders', `Those folders can’t be saved: ${why}.`);

/**
 * Check 21: the request's folders against the Pages collection once the moves land (`known`:
 * every page and group path then). Throws 400 `bad-folders`; nothing is written.
 */
export function checkRequestFolders(folders: PageFolders, known: ReadonlySet<string>): PageFolders {
	const out: PageFolders = {};
	for (const [level, list] of Object.entries(folders)) {
		if (level !== '' && !known.has(level)) throw badFolders(`there’s no page or group at /${level} any more`);
		const ids = new Set<string>();
		const names = new Set<string>();
		const filed = new Set<string>();
		out[level] = list.map((f): PageFolder => {
			if (!isSlug(f.id)) throw badFolders(`"${f.id.slice(0, 60)}" isn’t an address part, so it can’t be a folder’s id`);
			const name = folderName(f.name);
			if (name === null) throw badFolders('a folder’s name must be 1 to 60 characters');
			if (ids.has(f.id)) throw badFolders(`two folders have the id "${f.id}"`);
			if (names.has(name.toLowerCase())) throw badFolders(`two folders are called ${name}`);
			ids.add(f.id);
			names.add(name.toLowerCase());
			if (f.pages.length === 0) throw badFolders(`the ${name} folder has nothing in it`);
			for (const slug of f.pages) {
				// A member is one address part naming a page or group directly at its level: not empty, no `/`.
				if (!isMember(slug)) throw badFolders(`"${slug.slice(0, 60)}" isn’t a page or group directly in ${level === '' ? 'the top level' : `/${level}`}`);
				if (slug === RESERVED_SLUG) throw badFolders('Home can’t go in a folder');
				const path = level === '' ? slug : `${level}/${slug}`;
				if (!known.has(path)) throw badFolders(`there’s no page or group at /${path}`);
				if (filed.has(slug)) throw badFolders(`/${path} is in two folders`);
				filed.add(slug);
			}
			return { id: f.id, name, pages: [...f.pages] };
		});
	}
	return out;
}

const orderedCollection = (site: Pick<Site, 'collections'>): ResolvedCollection | undefined => Object.values(site.collections).find((c) => isOrderedCollection(c));
const settingsCollection = (site: Pick<Site, 'collections'>): ResolvedCollection | undefined => Object.values(site.collections).find((c) => c.kind === 'settings');

/** Site Settings' `pageFolders` in its text as `readPageFolders` takes it (nothing: none, or the text isn't JSON). */
function readFoldersIn(text: string | null): { folders: PageFolders; problems: FolderShapeProblem[] } {
	if (text === null) return { folders: {}, problems: [] };
	try {
		const raw = JSON.parse(text) as unknown;
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? readPageFolders((raw as Record<string, unknown>).pageFolders) : { folders: {}, problems: [] };
	} catch {
		return { folders: {}, problems: [] };
	}
}

/** Site Settings' `pageFolders` in its text (`{}`: none, or the text isn't JSON); a level with a shape problem left out. */
export const foldersIn = (text: string | null): PageFolders => readFoldersIn(text).folders;

/** The shape problems in Site Settings' `pageFolders` (none: none saved, or the text isn't JSON). */
export const folderProblemsIn = (text: string | null): FolderShapeProblem[] => readFoldersIn(text).problems;

/**
 * Page folders with a shape problem: the `pageOrder` levels a write must leave exactly as saved.
 * Writing `pageFolders` would lose the bad level (its codec drops it, as the reader does), and
 * settling would drop its tokens, so while it's there an editor write leaves both alone (the
 * `validate` leaf's rule too). The levels: each one with a problem; when the whole value is
 * wrong, every level with a token-shaped entry. Null when the shape is fine.
 */
function heldLevels(problems: readonly FolderShapeProblem[], order: PageOrder): Set<string> | null {
	if (problems.length === 0) return null;
	if (problems.some((p) => p.level === null)) return new Set(Object.entries(order).filter(([, list]) => list.some((e) => tokenIdOf(e) !== null)).map(([level]) => level));
	return new Set(problems.map((p) => p.level!));
}

/** The sentence an Apply is refused with when it would change folders, or a bad level's order, while `pageFolders` has a shape problem. */
export const MISSHAPEN_FOLDERS_MESSAGE = "Site Settings' page folders aren't in the shape the editor reads (`npx caracms validate` says where), so this change can't be saved without losing them. Nothing was changed: fix Site Settings, then apply again.";
/** Page folders: the sentence when New page in <Folder> can't file the page because `pageFolders` has a shape problem. */
export const FOLDER_MISSHAPEN_MESSAGE = "Site Settings' page folders aren't in the shape the editor reads, so the new page couldn't be filed in its folder. It was made outside it: fix Site Settings, then file it with Arrange pages….";

/** Decision 12: the order stamp of Site Settings' text (its `pageOrder` and `pageFolders`). */
export const layoutStampIn = (text: string | null): string => pageOrderStamp(orderIn(text), foldersIn(text));

/** Site Settings' text with `pageOrder` and `pageFolders` set (each taken out when empty). */
export function settingsWithLayout(site: Pick<Site, 'collections' | 'blocks'>, text: string | null, layout: { order: PageOrder; folders: PageFolders }): string | null {
	const ordered = settingsWithKey(site, text, 'pageOrder', layout.order);
	return settingsWithKey(site, ordered, 'pageFolders', layout.folders);
}

/**
 * The listing's folders (Contracts) for the Pages collection, read through `source` as the
 * listing was, and the order stamp the Apply's `expectOrder` sends back.
 */
export async function pagesLayout(site: Pick<ResolvedSite, 'root' | 'collections'>, documents: readonly DocumentEntry[], source?: ContentSource): Promise<PagesLayout> {
	const pages = orderedCollection(site);
	if (!pages) return { folders: {}, orderStamp: '' };
	const layout = await savedPageLayout(site, source);
	const paths = documents.filter((d) => d.collection === pages.name).map((d) => d.path);
	const ids = Object.fromEntries(Object.entries(layout.folders).map(([level, list]) => [level, list.map((f) => f.id)]));
	return { folders: listedFolders(paths, layout.folders), orderStamp: pageOrderStamp(layout.order, layout.folders), ids };
}

/** Page folders: the sentence when New page in <Folder>'s folder went before the page was made. */
export const FOLDER_GONE_MESSAGE = "That folder isn't there any more, so the page was made outside any folder.";
/** Page folders: the sentence when Site Settings can't be read, so a new page can't be filed. */
export const FOLDER_UNKEPT_MESSAGE = "Site Settings isn't valid JSON, so the new page couldn't be filed in its folder. It was made outside it: fix Site Settings, then file it with Arrange pages….";

/**
 * Page folders (Decisions 8 and 9): a new Pages document's Site Settings edit. `pathsBefore`:
 * the Pages collection's paths before it (for a waiting filing, the listing as it is). When
 * nothing was at its path, the slug it arrives with is cleared from any folder at its level (a
 * dead slug reused); a group already there keeps its folder. With `folder`, it's filed at the
 * end of that folder (out of any other at its level). Home is never filed. A folder left with
 * nothing goes with its token. `gone()` says whether `folder` wasn't there (or the path is
 * Home's); `misshapen()` whether `pageFolders` has a shape problem, when nothing is written
 * (`heldLevels`). Null for any other collection.
 */
export function pageFilingEdit(
	site: Pick<Site, 'collections' | 'blocks'>,
	collection: string,
	path: string,
	folder: string | undefined,
	pathsBefore: readonly string[],
): { edit: (text: string | null) => string | null; gone: () => boolean; misshapen: () => boolean } | null {
	const pages = orderedCollection(site);
	if (!pages || pages.name !== collection) return null;
	let gone = false;
	let misshapen = false;
	const level = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	const slug = path.slice(path.lastIndexOf('/') + 1);
	const dead = !nodePaths(pathsBefore).has(path);
	return {
		edit: (text) => {
			const { folders, problems } = readFoldersIn(text);
			gone = false;
			misshapen = problems.length > 0;
			if (misshapen) return null;
			const order = orderIn(text);
			const into = folder === undefined || slug === RESERVED_SLUG ? undefined : (folders[level] ?? []).find((f) => f.id === folder);
			const list = (folders[level] ?? []).map((f) => ({ ...f, pages: dead || into ? f.pages.filter((s) => s !== slug) : [...f.pages] }));
			if (folder !== undefined) {
				if (into) list.find((f) => f.id === into.id)!.pages.push(slug);
				else gone = true;
			}
			const kept = list.filter((f) => f.pages.length > 0);
			const dropped = new Set(list.filter((f) => f.pages.length === 0).map((f) => `(${f.id})`));
			const nextFolders: PageFolders = { ...folders };
			if (kept.length) nextFolders[level] = kept;
			else delete nextFolders[level];
			const nextOrder: PageOrder = { ...order };
			if (dropped.size && order[level]) {
				const left = order[level].filter((e) => !dropped.has(e));
				if (left.length) nextOrder[level] = left;
				else delete nextOrder[level];
			}
			if (JSON.stringify(nextFolders) === JSON.stringify(folders) && JSON.stringify(nextOrder) === JSON.stringify(order)) return null;
			const after = settingsWithLayout(site, text, { order: nextOrder, folders: nextFolders });
			return after === text ? null : after;
		},
		gone: () => gone,
		misshapen: () => misshapen,
	};
}

/** Site Settings' `pageOrder` in its text (`{}`: none, or the text isn't JSON). */
export function orderIn(text: string | null): PageOrder {
	if (text === null) return {};
	try {
		const raw = JSON.parse(text) as unknown;
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? parsePageOrder((raw as Record<string, unknown>).pageOrder) : {};
	} catch {
		return {};
	}
}

/**
 * Site Settings' text with `pageOrder` set to `order` (taken out when it's empty), every
 * other key as it was; `text` null: a new file. Unchanged text when the order is the same,
 * or when the text isn't JSON (the editor warns about that file).
 */
export function settingsWithOrder(site: Pick<Site, 'collections' | 'blocks'>, text: string | null, order: PageOrder): string | null {
	return settingsWithKey(site, text, 'pageOrder', order);
}

/** The sentence an order-only Apply is refused with when Site Settings, which holds the order, can't be read. */
export const UNREADABLE_SETTINGS_MESSAGE = "Site Settings isn't valid JSON, so the new order can't be saved there. Nothing was changed: fix Site Settings, then apply again.";

/**
 * An order-only Apply (Decision 21) writes nothing but Site Settings, so one that can't be read
 * is refused (422 invalid-json) rather than answered `{ ok: true }` with the order dropped.
 * `text` null (no file yet) is fine: the order makes a new one.
 */
export function assertSettingsReadable(site: Pick<Site, 'collections' | 'blocks'>, text: string | null, message = UNREADABLE_SETTINGS_MESSAGE): void {
	const collection = settingsCollection(site);
	if (!collection || text === null) return;
	try {
		parseAnyDocument(JSON.parse(text), site, collection);
	} catch {
		throw refused(422, 'invalid-json', message);
	}
}

/** Review gaps (Decision 2): the same refusal for a hand order (a drag, or a new entry's place). */
export const UNREADABLE_HAND_ORDER_MESSAGE = "Site Settings isn't valid JSON, so the new order can't be saved there. Nothing was changed: fix Site Settings, then try again.";

/** The ordered collection's path changes in a list of moves. */
function pathChanges(site: Pick<Site, 'collections'>, moves: readonly PathMove[]): PathChange[] {
	const pages = orderedCollection(site);
	return pages ? moves.filter((m) => m.collection === pages.name).map((m) => ({ from: m.path, to: m.to })) : [];
}
const pathsOf = (site: Pick<Site, 'collections'>, documents: readonly DocumentEntry[]) => {
	const pages = orderedCollection(site);
	return pages ? documents.filter((d) => d.collection === pages.name).map((d) => d.path) : [];
};

/**
 * Change address… (Decision 6): the engine's Site Settings edit that keeps a saved order
 * current after these moves. Review gaps (Decision 2): the manual collections' hand orders
 * too, a renamed entry keeping its place (collection-order.ts → `handOrderEdit`).
 */
export function orderEdit(site: Site, moves: readonly PathMove[], documents: readonly DocumentEntry[]): (text: string) => string {
	const changes = pathChanges(site, moves);
	const before = pathsOf(site, documents);
	const hand = handOrderEdit(site, moves);
	const moving = new Map(changes.map((c) => [c.from, c.to]));
	const after = before.map((p) => moving.get(p) ?? p);
	return (text) => {
		const saved = orderIn(text);
		const { folders, problems } = readFoldersIn(text);
		if (changes.length === 0 || (Object.keys(saved).length === 0 && Object.keys(folders).length === 0)) return hand(text);
		// A `pageFolders` shape problem: the folders and their tokens are left as written (`heldLevels`); the order follows the moves as before folders.
		if (problems.length) return hand(settingsWithOrder(site, text, orderAfterMoves(saved, changes, before)) ?? text);
		// Page folders (Decision 9): a page renamed in place keeps its folder; one moved away leaves it; a folder left empty goes with its token.
		const layout = settleLayout(orderAfterMoves(saved, changes, before), foldersAfterMoves(folders, changes, before), after);
		return hand(settingsWithLayout(site, text, layout) ?? text);
	};
}

export interface ArrangePlan {
	/** Every document whose path changes, roots first (each root, then what it carries); empty for an order-only Apply. */
	moves: PathMove[];
	/** Site Settings' text → its text with the arranged order (the engine's `editSettings`, or the order-only write). */
	edit: (text: string | null) => string | null;
}

/**
 * The Apply's plan against the listing as it is (`documents`): the roots expanded, the
 * order checked against the Pages collection as it will be. Throws WriteRefused: the
 * engine's own refusals for a root (move.ts → `movesUnder`), `not-found` (404) for an
 * order entry that names nothing once the moves land.
 */
export function planArrange(site: Site, request: ArrangeRequest, documents: readonly DocumentEntry[]): ArrangePlan {
	// Decision 10: the review's listing, collection by collection, before anything is planned.
	for (const [collection, stamp] of Object.entries(request.expect ?? {})) {
		const paths = documents.filter((d) => d.collection === collection).map((d) => d.path);
		if (listingStamp(paths) !== stamp) throw refused(409, 'changed', CHANGED_MESSAGE);
	}
	const key = (m: { collection: string; path: string }) => `${m.collection}\0${m.path}`;
	// Shallowest first, so an inner root wins for its own subtree.
	const roots = [...request.moves].sort((a, b) => a.fromPath.split('/').length - b.fromPath.split('/').length);
	const seen = new Set<string>();
	for (const r of roots) {
		const k = key({ collection: r.collection, path: r.fromPath });
		if (seen.has(k)) throw refused(400, 'bad-request', `${r.fromPath} is in the plan twice.`);
		seen.add(k);
	}
	const planned = new Map<string, PathMove>();
	for (const r of roots) {
		for (const m of movesUnder(site, { collection: r.collection, path: r.fromPath, to: r.toPath }, documents)) planned.set(key(m), m);
	}
	// Roots in the order asked, each followed by what it carries (what the innermost root above it carries).
	const ownerOf = (m: PathMove) =>
		request.moves.filter((o) => o.collection === m.collection && (m.path === o.fromPath || m.path.startsWith(`${o.fromPath}/`))).sort((a, b) => b.fromPath.length - a.fromPath.length)[0]!;
	const ordered: PathMove[] = [];
	for (const r of request.moves) {
		ordered.push(planned.get(key({ collection: r.collection, path: r.fromPath }))!);
		for (const m of planned.values()) if (m.path !== r.fromPath && ownerOf(m) === r) ordered.push(m);
	}

	// The Pages collection once the moves land: every `order` key and slug names something there.
	const changes = pathChanges(site, ordered);
	const before = pathsOf(site, documents);
	const moving = new Map(changes.map((c) => [c.from, c.to]));
	const after = before.map((p) => moving.get(p) ?? p);
	const known = new Set<string>(['']);
	for (const p of after) {
		const parts = p.split('/');
		for (let i = 1; i <= parts.length; i++) known.add(parts.slice(0, i).join('/'));
	}
	for (const [parent, slugs] of Object.entries(request.order)) {
		if (!known.has(parent)) throw refused(404, 'not-found', `There's no page or group at /${parent} any more.`);
		for (const slug of slugs) {
			const path = parent === '' ? slug : `${parent}/${slug}`;
			// A folder's token (Contracts): one naming no folder in the result is dropped in the write, not refused.
			if (!known.has(path) && tokenIdOf(slug) === null) throw refused(404, 'not-found', `There's no page or group at /${path} any more.`);
		}
	}
	const folders = request.folders ? checkRequestFolders(request.folders, known) : {};
	const edit = (text: string | null) => {
		// Decision 12: the order and folders the review was planned on, checked in the write itself.
		if (request.expectOrder !== undefined && layoutStampIn(text) !== request.expectOrder) throw refused(409, 'changed', CHANGED_MESSAGE);
		const savedOrder = orderIn(text);
		const { folders: savedFolders, problems } = readFoldersIn(text);
		const nextOrder = arrangedOrder(savedOrder, request.order, changes, before);
		const nextFolders = arrangedFolders(savedFolders, folders, changes, before);
		const held = heldLevels(problems, savedOrder);
		if (!held) return settingsWithLayout(site, text, settleLayout(nextOrder, nextFolders, after));
		// `pageFolders` has a shape problem: an Apply that would change folders, or a bad level's order, is refused; any other writes `pageOrder` alone, the bad levels' lists as saved.
		const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
		const changesFolders = !same(canonical(nextFolders), canonical(savedFolders));
		if (changesFolders || [...held].some((level) => !same(nextOrder[level], savedOrder[level]))) throw refused(422, 'invalid-json', MISSHAPEN_FOLDERS_MESSAGE);
		const layout = settleLayout(nextOrder, savedFolders, after);
		for (const level of held) if (savedOrder[level]) layout.order[level] = savedOrder[level];
		return settingsWithOrder(site, text, layout.order);
	};
	return { moves: ordered, edit };
}

/** Folders compared as data: levels by key, empty levels left out. */
function canonical(folders: PageFolders): [string, PageFolder[]][] {
	return Object.entries(folders)
		.filter(([, list]) => list.length > 0)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ── The route ──────────────────────────────────────────────────────────────

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
	});

/** What the route needs of the drafts store. */
export interface Arranges {
	arrange(request: ArrangeRequest, context?: WriteContext): Promise<ArrangeResponse>;
}

/** POST /_caracms/arrange: a Request in, a Response out, through the mode's store (move.ts's handling, the same checks). */
export async function handleArrange(request: Request, store: Arranges, who: { person?: Person | null } = {}): Promise<Response> {
	try {
		if (request.method !== 'POST') throw new WriteRefused(405, 'The arrange route only takes POST.');
		checkOrigin(request);
		const type = request.headers.get('content-type') ?? '';
		if (!/^application\/json\s*(;|$)/i.test(type)) throw new WriteRefused(415, 'Send JSON (Content-Type: application/json).');
		// caracms-cloud adversarial review, finding 10: counted as it's read, so a chunked body stops at the cap too.
		const raw = await readCappedText(request, MAX_ARRANGE_BODY_BYTES);
		if (raw === null) throw new WriteRefused(413, 'That body is too large.');
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			throw refused(400, 'bad-request', 'Malformed body: it isn\'t valid JSON.');
		}
		const context: WriteContext = { person: who.person ?? null, tab: tabOf(request), release: false, seq: seqOf(request) };
		return json(200, await store.arrange(parseArrangeBody(body), context));
	} catch (error) {
		if (error instanceof WriteRefused) return json(error.status, { error: error.message, ...error.body }, error.status === 405 ? { Allow: 'POST' } : {});
		console.error('[caracms] arrange failed:', error);
		return json(500, { error: `That didn't work (${error instanceof Error ? error.message : String(error)}).` });
	}
}
