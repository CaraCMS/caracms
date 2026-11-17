/**
 * Changing a document's address (pre-M7 item 8): the rules both stores apply, what
 * the move changes in every file, the disk half (local mode), and the route.
 *
 * **A security boundary, as create and delete are** (create.ts): the paths come from
 * the browser, so the route is the same POST-JSON-same-origin handler, both paths go
 * through create.ts → `target`, and on disk the new file is made by `createOnDisk` and
 * the old one removed by `deleteOnDisk`, with their symlink checks.
 *
 * The rules (`planMove`), over the store's own listing:
 *
 * - **Only documents with an address move**: a page, a case study, a journal entry.
 *   Shared blocks and Site Settings have none. The top of a nested collection (Home,
 *   or a collection's own page at its `urlBase`) is its collection's address, so it
 *   stays.
 * - **The new address follows a new document's rules** (create.ts): its parts are
 *   slugs (a folder that already holds documents keeps its name), none is `index`, and
 *   it's free in every collection (the document's own address aside), not under
 *   `/admin` or `/_caracms`, not strictly below another collection's `urlBase`. The
 *   same address is refused (`same`): there's nothing to change.
 * - **Everything under it moves with it** (collections under pages, Decision 9; a delete
 *   still leaves them, M5a Decision 12): moving Services to /offerings carries
 *   /services/branding to /offerings/branding, and a page that holds a collection carries
 *   its documents' addresses (`movesUnder`, `planMoves`). The whole plan is checked, then
 *   lands all or nothing: the many-move engine (Contracts), which the arrange screen reuses.
 *
 * What a move changes (`movesChanges`), worked out from the store's own texts, each file once for every move:
 *
 * - the document, at its new path, with its own links to itself rewritten;
 * - **every other document that links to it or references it** (relink.ts), Site
 *   Settings included, each changed only where it points at the old address;
 * - **Site Settings' redirects** (redirects.ts): entries to the old address go to the
 *   new one (chains collapse), an entry from the new address goes (a page is there
 *   now), and `old → new` is added, unless the request says not to (`redirect: false`,
 *   Change address…'s box unticked: pages shuffled before a site launches need none)
 *   or the document was never live (live mode's document made since the last Publish).
 *   Either way `addRedirect` is false; the chains still collapse.
 *
 * On disk the order is: the new files (exclusive creates), the rewritten files, Site
 * Settings, then the old files go; a failure part way puts every file back (`movesOnDisk`).
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SITE_SETTINGS_FILE, type ResolvedCollection, type ResolvedSite } from '../../config.ts';
import { documentUrl, type DocumentEntry } from '../../content.ts';
import { heldBases, withHeldBases, type HeldBase } from '../../held.ts';
import { own, parseAnyDocument, type SettingsDocument } from '../../document.ts';
import type { Person } from '../../live/messages.ts';
import { redirectsAddedBy, redirectsAfterMoves, type LiveHome, type Redirect } from '../../redirects.ts';
import { relinkText, type AddressMove } from '../../relink.ts';
import { schemaRef, stampSchema } from '../../schema-key.ts';
import { applyKeyedEdits } from '../../serialize.ts';
import { addressProblem, INDEX_MESSAGE, isSlug, NO_ADDRESS_MESSAGE, RESERVED_SLUG, sameAddress, slugify } from '../../slug.ts';
import { RELEASE_HEADER, type MoveRequest, type MoveResponse } from '../types.ts';
import { confineOnDisk, createOnDisk, deleteOnDisk, MAX_CREATE_BODY_BYTES, refused, target, type Target } from './create.ts';
import { checkOrigin, seqOf, tabOf, WriteRefused, writeAtomic, type WriteContext } from './write.ts';
import { readCappedText } from '../../body.ts';

type Site = Pick<ResolvedSite, 'root' | 'collections' | 'blocks' | 'codeRoutes'>;

const MOVE_SHAPE = '{ collection, path, to, redirect? }';

/** A path for a message: control characters shown escaped, long ones cut. */
const printable = (value: string) => {
	const shown = JSON.stringify(value).slice(1, -1);
	return shown.length > 120 ? `${shown.slice(0, 117)}...` : shown;
};

/** Validate a move body's shape. Throws WriteRefused 400. */
export function parseMoveBody(body: unknown): MoveRequest {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw refused(400, 'bad-request', `Malformed body: it must be a JSON object. Send ${MOVE_SHAPE}.`);
	const b = body as Record<string, unknown>;
	const extra = Object.keys(b).filter((k) => !['collection', 'path', 'to', 'redirect'].includes(k));
	if (extra.length) throw refused(400, 'bad-request', `Malformed body: unexpected ${extra.map((k) => `"${printable(k)}"`).join(', ')}. Send ${MOVE_SHAPE}.`);
	if (typeof b.collection !== 'string' || b.collection === '') throw refused(400, 'bad-request', `Malformed body: "collection" must be a collection's name. Send ${MOVE_SHAPE}.`);
	if (typeof b.path !== 'string' || b.path === '') throw refused(400, 'bad-request', `Malformed body: "path" must be the document's path in its collection. Send ${MOVE_SHAPE}.`);
	if (typeof b.to !== 'string') throw refused(400, 'bad-request', `Malformed body: "to" must be the document's new path in its collection. Send ${MOVE_SHAPE}.`);
	if (b.redirect !== undefined && typeof b.redirect !== 'boolean') throw refused(400, 'bad-request', `Malformed body: "redirect" must be true or false. Send ${MOVE_SHAPE}.`);
	if (b.path.length > 512 || b.to.length > 512) throw refused(400, 'bad-path', 'That path is too long.');
	return { collection: b.collection, path: b.path, to: b.to, ...(b.redirect === false ? { redirect: false } : {}) };
}

/** One document's new path in its collection: the many-move engine's unit (Contracts). */
export interface PathMove {
	collection: string;
	path: string;
	to: string;
}

/**
 * The many-move engine's request (collections under pages, Decision 9 and Contracts):
 * every document whose path changes, any collections, any number; the one redirect
 * choice; and an optional change to Site Settings' text that lands, or rolls back, with
 * the redirects (the arrange screen's saved order). A held document whose holder moves
 * keeps its path, so it's never listed: the plan adds it.
 */
export interface ManyMoveRequest {
	moves: readonly PathMove[];
	/** Whether to leave redirects from the old addresses (default true). A document that was never live gets none either way. */
	redirect?: boolean;
	/** A pure function, Site Settings' text → its text, applied after the redirects are folded in. */
	editSettings?: (text: string) => string;
}

/** One address that changes. */
export interface MovePlan {
	from: Target & { entry: DocumentEntry; url: string };
	to: Target & { url: string };
	move: AddressMove;
	title: string;
	/** False for a held document whose holder moved: its file stays where it is, only its address changes. */
	refiled: boolean;
}

/** The individual rules for one requested move, against the listing as it is. Throws WriteRefused. */
function checkOne(site: Site, bases: Readonly<Record<string, HeldBase>>, request: PathMove, documents: readonly DocumentEntry[]) {
	const collection = own(site.collections, request.collection);
	if (!collection) throw refused(400, 'bad-path', `No collection "${printable(request.collection)}" is declared.`);
	const unheld = own(bases, collection.name)?.problem;
	if (unheld) throw refused(400, 'not-held', unheld);
	if (collection.urlBase === null) {
		const what = collection.kind === 'shared' ? 'A shared block' : collection.kind === 'settings' ? 'Site Settings' : `${collection.label} has no pages of its own, so a document there`;
		throw refused(400, 'not-allowed', `${what} has no address to change.`);
	}
	const from = target(site, collection.name, request.path);
	const entry = documents.find((d) => d.file === from.file);
	if (!entry) throw refused(404, 'not-found', `${collection.label}: no document "${printable(from.path)}".`);
	const fromUrl = documentUrl(collection, from.path);
	if (collection.nested && from.path === 'index') {
		throw refused(400, 'not-allowed', collection.urlBase === '/' ? 'Home is always at /, so its address can\'t change.' : `${entry.label} is the top of ${collection.label}, at ${collection.urlBase}, so its address can't change.`);
	}
	if (fromUrl === null || entry.warning) throw refused(400, 'not-allowed', `${entry.label} can't be opened, so its address can't change.`);

	if (request.to === '') throw refused(400, 'bad-name', NO_ADDRESS_MESSAGE);
	if (request.to.split('/').includes(RESERVED_SLUG)) throw refused(400, 'index', INDEX_MESSAGE);
	if (request.to === from.path) throw refused(400, 'same', `${fromUrl} is its address already.`);
	const to = target(site, collection.name, request.to);
	const parts = to.path.split('/');
	parts.forEach((part, i) => {
		// As on a create: a folder that already has documents in it keeps its name, whatever it is.
		const prefix = parts.slice(0, i + 1).join('/');
		const existing = i < parts.length - 1 && documents.some((d) => d.collection === collection.name && d.path.startsWith(`${prefix}/`));
		if (existing || isSlug(part)) return;
		const better = slugify(part);
		throw refused(400, 'bad-name', better ? `"${printable(part)}" can't be part of an address; "${better}" can.` : NO_ADDRESS_MESSAGE);
	});
	return { collection, from: { ...from, entry, url: fromUrl }, to };
}

/**
 * Change address… on a page (Decision 9): the page, then every page under it at any
 * depth, each at the same place under the new address. (Held documents follow their
 * holder in `planMoves`.) Anything else is the one move asked for.
 */
export function movesUnder(site: Pick<Site, 'collections'>, request: Pick<PathMove, 'collection' | 'path' | 'to'>, documents: readonly DocumentEntry[]): PathMove[] {
	const root: PathMove = { collection: request.collection, path: request.path, to: request.to };
	const collection = own(site.collections, request.collection);
	if (!collection?.nested || request.to === request.path) return [root];
	if (request.to.startsWith(`${request.path}/`)) {
		const label = documents.find((d) => d.collection === collection.name && d.path === request.path)?.label ?? request.path;
		throw refused(400, 'not-allowed', `${label} can't go under itself.`);
	}
	const under = documents.filter((d) => d.collection === collection.name && d.path.startsWith(`${request.path}/`));
	// A file under it that can't be opened has no address to carry: it would be left behind as a group.
	const broken = under.find((d) => d.warning);
	if (broken) {
		const label = documents.find((d) => d.collection === collection.name && d.path === request.path)?.label ?? request.path;
		throw refused(400, 'not-allowed', `${broken.file} is under ${label} and can't be opened, so ${label} can't move with everything under it. Fix or delete that file first.`);
	}
	return [root, ...under.map((d) => ({ collection: d.collection, path: d.path, to: `${request.to}${d.path.slice(request.path.length)}` }))];
}

/**
 * Check a whole plan against the rules and the store's listing at call time (every
 * document, every collection), and work out every address that changes: the requested
 * moves, in order, then the documents of each held collection whose holder's address
 * changes. Each requested move follows a single move's rules; then, as a whole, every new
 * address must be free of documents (as they'll be once the plan has landed, so a swap is
 * fine) and code routes, none reserved, and no two moves may land on one address.
 * Throws WriteRefused, naming the first problem.
 */
export function planMoves(configured: Site, requests: readonly PathMove[], documents: readonly DocumentEntry[]): MovePlan[] {
	if (requests.length === 0) throw refused(400, 'bad-request', 'Nothing to move.');
	// Collections under pages (Decision 7): a held collection's base is resolved from the listing.
	const before = heldBases(configured.collections, documents);
	const site = withHeldBases(configured, before);
	const checked = requests.map((r) => checkOne(site, before, r, documents));
	const moving = new Map<string, (typeof checked)[number]>();
	for (const c of checked) {
		if (moving.has(c.from.file)) throw refused(400, 'bad-request', `${c.from.entry.label} is in the plan twice.`);
		moving.set(c.from.file, c);
	}

	// The listing once the plan has landed: moved documents at their new paths, then every
	// held collection's base worked out again from it (a holder may have moved).
	const shifted = documents.map((d) => {
		const c = moving.get(d.file);
		return c ? { ...d, path: c.to.path, file: c.to.file, url: documentUrl(site.collections[d.collection]!, c.to.path) } : d;
	});
	const after = heldBases(configured.collections, shifted);
	const landed = withHeldBases(configured, after);
	const urlAfter = (d: { collection: string; path: string }) => documentUrl(landed.collections[d.collection]!, d.path);

	const plans: MovePlan[] = checked.map((c) => {
		const toUrl = urlAfter(c.to);
		if (toUrl === null) throw refused(400, 'not-held', own(after, c.collection.name)?.problem ?? `${c.from.entry.label} would have no address.`);
		return {
			from: c.from,
			to: { ...c.to, url: toUrl },
			move: { collection: c.collection.name, fromPath: c.from.path, toPath: c.to.path, fromUrl: c.from.url, toUrl },
			title: c.from.entry.label,
			refiled: true,
		};
	});
	// Each held collection whose holder's address changes: its documents follow, each an ordinary move (Decision 3).
	for (const b of Object.values(before)) {
		const next = after[b.collection];
		if (b.base === null || !next?.base || next.base === b.base) continue;
		for (const d of documents) {
			if (d.collection !== b.collection || d.warning || moving.has(d.file)) continue;
			const fromUrl = documentUrl(site.collections[d.collection]!, d.path);
			const toUrl = urlAfter(d);
			if (fromUrl === null || toUrl === null) continue;
			const at = target(site, d.collection, d.path);
			plans.push({ from: { ...at, entry: d, url: fromUrl }, to: { ...at, url: toUrl }, move: { collection: d.collection, fromPath: d.path, toPath: d.path, fromUrl, toUrl }, title: d.label, refiled: false });
		}
	}

	// As a whole: every new address free, none reserved, no two moves to one.
	const lead = (p: MovePlan, i: number) => (i === 0 ? '' : `${p.title} would move to ${p.to.url}. `);
	const listedAfter = shifted.map((d) => ({ ...d, url: urlAfter(d) }));
	const collections = Object.values(landed.collections).map(({ name, label, urlBase, heldBy }) => ({ name, label, urlBase, heldBy }));
	const vacated = new Set(plans.filter((p) => p.refiled).map((p) => p.from.file));
	const seen = new Map<string, MovePlan>();
	plans.forEach((p, i) => {
		const key = sameAddress(p.to.url);
		const twice = seen.get(key);
		if (twice) throw refused(409, 'address-taken', `${twice.title} and ${p.title} would both be at ${p.to.url}.`);
		seen.set(key, p);
		if (p.refiled && !vacated.has(p.to.file) && documents.some((d) => d.file === p.to.file)) throw refused(409, 'address-taken', `${lead(p, i)}There's already a page at ${p.to.url}.`);
		const others = listedAfter.filter((d) => d.file !== p.to.file);
		const problem = addressProblem(p.to.url, p.move.collection, collections, others, site.codeRoutes);
		if (problem) throw refused(problem.code === 'address-taken' ? 409 : 400, problem.code, `${lead(p, i)}${problem.message}`);
	});
	return plans;
}

/** One move's plan (a page alone, with nothing under it). See `planMoves`. */
export function planMove(site: Site, request: PathMove, documents: readonly DocumentEntry[]): MovePlan {
	return planMoves(site, [request], documents)[0]!;
}

export interface MoveChanges {
	/** Each refiled document's text at its new path, in plan order. */
	moved: { plan: MovePlan; text: string }[];
	/** Every other document whose text changes (links or references to any of them), Site Settings aside: a held document whose file stays among them. */
	relinked: { file: string; collection: string; path: string; title: string; text: string }[];
	/** Site Settings' text after (null: no change), and before (null: the file isn't there yet). */
	settings: { before: string | null; after: string } | null;
	/** The redirects added, one per address that was live (and asked for). */
	redirects: Redirect[];
	/** Whether Site Settings changed for its own links, not only its redirects. */
	settingsRelinked: boolean;
}

const settingsCollection = (site: Site): ResolvedCollection | undefined => Object.values(site.collections).find((c) => c.kind === 'settings');

/**
 * Site Settings' text once its redirects follow every move (redirects.ts →
 * `redirectsAfterMoves`: all at once, against the list before the plan, so a swap or a
 * chain comes out right; `add` per move; `homes`, live mode's documents whose live address
 * is elsewhere, for a live address a move vacates), its own links are rewritten, and the
 * caller's own `edit` is applied; null when nothing changes. `text` null: there's no Site Settings file yet.
 */
export function settingsAfterMoves(
	site: Site,
	text: string | null,
	moves: readonly { move: AddressMove; add: boolean }[],
	edit?: (text: string) => string,
	homes: readonly LiveHome[] = [],
): string | null {
	const collection = settingsCollection(site);
	if (!collection) return null;
	const relinked = text === null ? null : relinkText(text, moves.map((m) => m.move), site, collection).text;
	let raw: unknown = {};
	if (relinked !== null) {
		try {
			raw = JSON.parse(relinked);
		} catch {
			return null; // a Site Settings that isn't JSON is left as it is (the editor warns about it)
		}
	}
	const doc = parseAnyDocument(raw, site, collection) as SettingsDocument;
	const redirects = redirectsAfterMoves(doc.data.redirects ?? [], moves.map((m) => ({ from: m.move.fromUrl, to: m.move.toUrl, add: m.add })), homes);
	const title = relinked === null ? 'Site Settings' : doc.title;
	let after = applyKeyedEdits(relinked, { title, data: { ...doc.data, redirects } }, collection);
	if (edit) after = edit(after);
	return after === text ? null : after;
}

/** One move's Site Settings (see `settingsAfterMoves`). */
export function settingsAfterMove(site: Site, text: string | null, move: AddressMove, addRedirect: boolean): string | null {
	return settingsAfterMoves(site, text, [{ move, add: addRedirect }]);
}

/**
 * Site Settings' text without its redirect from `url`, or null when it has none: a new
 * document made at an address that redirected (a page is there again). Both stores'
 * create call it; the server also lets a real page win over a redirect.
 */
export function settingsWithoutRedirectFrom(site: Site, text: string | null, url: string | null): string | null {
	const collection = settingsCollection(site);
	if (!collection || text === null || url === null) return null;
	let doc: SettingsDocument;
	try {
		doc = parseAnyDocument(JSON.parse(text), site, collection) as SettingsDocument;
	} catch {
		return null;
	}
	const list = doc.data.redirects ?? [];
	const kept = list.filter((r) => r.from.toLowerCase() !== url.replace(/\/+$/, '').toLowerCase());
	if (kept.length === list.length) return null;
	return applyKeyedEdits(text, { title: doc.title, data: { ...doc.data, redirects: kept } }, collection);
}

/**
 * Discard changes, a move going back (live mode): Site Settings' redirects from the addresses
 * the move back vacates, as the live Site Settings (`live`) has them, put back where the
 * move had taken them out (a page was there). When that leaves the same redirects as the
 * live ones, they're in the live order. Null when there's nothing to put back.
 */
export function settingsWithRedirectsBack(site: Site, text: string | null, live: string | null, vacated: readonly string[]): string | null {
	const collection = settingsCollection(site);
	if (!collection || text === null || live === null || vacated.length === 0) return null;
	let doc: SettingsDocument;
	let was: SettingsDocument;
	try {
		doc = parseAnyDocument(JSON.parse(text), site, collection) as SettingsDocument;
		was = parseAnyDocument(JSON.parse(live), site, collection) as SettingsDocument;
	} catch {
		return null;
	}
	const key = (url: string) => url.replace(/\/+$/, '').toLowerCase();
	const away = new Set(vacated.map(key));
	const list = doc.data.redirects ?? [];
	const back = (was.data.redirects ?? []).filter((r) => away.has(key(r.from)) && !list.some((x) => key(x.from) === key(r.from)));
	if (back.length === 0) return null;
	const next = [...list, ...back];
	const same = (a: readonly Redirect[], b: readonly Redirect[]) => a.length === b.length && a.every((r) => b.some((x) => key(x.from) === key(r.from) && x.to === r.to));
	const redirects = same(next, was.data.redirects ?? []) ? was.data.redirects! : next;
	return applyKeyedEdits(text, { title: doc.title, data: { ...doc.data, redirects } }, collection);
}

/**
 * What the plan changes, from the store's own texts (`readText` by site-relative file;
 * live mode's has the autosaves on top): each linking file rewritten once for all the
 * moves that touch it. `addRedirect(plan)`: whether that address gets `old → new`.
 *
 * `liveAddressOf(file)` (live mode, passed only when the move leaves redirects): a
 * document's live address by its file before the plan, when it isn't where the document is
 * (moved since the last Publish; autosaves.ts → `addresses`), else null. When a move
 * vacates such an address and no document takes it, it redirects to where that document
 * is once the plan has landed (redirects.ts → `redirectsAfterMoves`'s `homes`): after a
 * chain A → B, B → C, B's document has no redirect from B (A's sat there), so A's moving
 * on from B leaves `B → C`.
 */
export async function movesChanges(
	site: Site,
	plans: readonly MovePlan[],
	documents: readonly DocumentEntry[],
	readText: (file: string) => Promise<string | null>,
	addRedirect: (plan: MovePlan) => boolean,
	editSettings?: (text: string) => string,
	liveAddressOf?: (file: string) => string | null,
): Promise<MoveChanges> {
	const moves = plans.map((p) => p.move);
	const collectionOf = (name: string) => site.collections[name]!;
	const refiled = new Set(plans.filter((p) => p.refiled).map((p) => p.from.file));
	const moved: MoveChanges['moved'] = [];
	for (const plan of plans) {
		if (!plan.refiled) continue;
		const text = await readText(plan.from.file);
		if (text === null) throw refused(404, 'not-found', `${collectionOf(plan.from.collection).label}: no document "${plan.from.path}".`);
		// M8 Decision 14: its `$schema` path follows the file to its new folder.
		moved.push({ plan, text: stampSchema(relinkText(text, moves, site, collectionOf(plan.from.collection)).text, schemaRef(collectionOf(plan.to.collection), plan.to.file), { add: false }) });
	}
	const relinked: MoveChanges['relinked'] = [];
	for (const d of documents) {
		if (refiled.has(d.file) || d.file === SITE_SETTINGS_FILE) continue;
		const text = await readText(d.file);
		if (text === null) continue;
		const after = relinkText(text, moves, site, collectionOf(d.collection));
		if (after.links) relinked.push({ file: d.file, collection: d.collection, path: d.path, title: d.label, text: after.text });
	}
	const before = await readText(SITE_SETTINGS_FILE);
	const adds = plans.map((p) => ({ move: p.move, add: addRedirect(p) }));
	const homes = liveAddressOf ? liveHomes(site, plans, documents, liveAddressOf) : [];
	const after = settingsAfterMoves(site, before, adds, editSettings, homes);
	const settings = settingsCollection(site);
	return {
		moved,
		relinked,
		settings: after === null ? null : { before, after },
		redirects: redirectsAddedBy(adds.map((a) => ({ from: a.move.fromUrl, to: a.move.toUrl, add: a.add })), homes),
		settingsRelinked: !!settings && before !== null && relinkText(before, moves, site, settings).links > 0,
	};
}

/** Each document with a live address elsewhere (`liveAddressOf`), and its address once the plan has landed. */
function liveHomes(site: Site, plans: readonly MovePlan[], documents: readonly DocumentEntry[], liveAddressOf: (file: string) => string | null): LiveHome[] {
	const planned = new Map(plans.map((p) => [p.from.file, p]));
	let sited: Site | null = null;
	const homes: LiveHome[] = [];
	for (const d of documents) {
		const live = liveAddressOf(d.file);
		if (live === null) continue;
		const plan = planned.get(d.file);
		let now: string | null;
		if (plan) now = plan.to.url;
		else {
			// Not in the plan: its address doesn't change (a held document whose holder moves is in it).
			sited ??= withHeldBases(site, heldBases(site.collections, documents));
			const collection = sited.collections[d.collection];
			now = collection ? documentUrl(collection, d.path) : null;
		}
		if (now !== null) homes.push({ live, now });
	}
	return homes;
}

/** The route's answer for a plan done: the first plan's document is the one asked about. */
export function moveResponse(plans: readonly MovePlan[], changes: MoveChanges): MoveResponse {
	const [first] = plans;
	const relinked = changes.relinked.map(({ collection, path, title }) => ({ collection, path, title }));
	if (changes.settingsRelinked) relinked.push({ collection: 'settings', path: 'site-settings', title: 'Site Settings' });
	const redirectOf = (p: MovePlan) => changes.redirects.find((r) => r.from === p.move.fromUrl && r.to === p.move.toUrl) ?? null;
	return {
		ok: true,
		collection: first!.to.collection,
		path: first!.to.path,
		file: first!.to.file,
		url: first!.to.url,
		from: { path: first!.from.path, file: first!.from.file, url: first!.from.url },
		relinked,
		redirect: redirectOf(first!),
		moved: plans.map((p) => ({ collection: p.move.collection, from: p.move.fromPath, to: p.move.toPath, title: p.title, fromUrl: p.move.fromUrl, toUrl: p.move.toUrl })),
		redirects: changes.redirects,
	};
}

// ── The disk (local mode) ──────────────────────────────────────────────────

/**
 * The plan on disk, all or nothing: each new file (an exclusive create; a file another
 * move in the plan vacates is written over, as a swap needs), the rewritten files, Site
 * Settings, then the old files go (and the folders they leave empty). Every text was read
 * first, so a failure part way puts every file back as it was.
 */
export async function movesOnDisk(site: Site, changes: MoveChanges): Promise<void> {
	const vacated = new Set(changes.moved.map((m) => m.plan.from.file));
	const targets = new Set(changes.moved.map((m) => m.plan.to.file));
	const undo: (() => Promise<unknown>)[] = [];
	const overwrite = async (file: string, text: string, before: string | null) => {
		const confined = await confineOnDisk(site, file);
		const prior = before ?? (await readFile(confined.absolute, 'utf8'));
		await writeAtomic(confined.absolute, text);
		undo.push(() => writeAtomic(confined.absolute, prior));
	};
	try {
		for (const { plan, text } of changes.moved) {
			if (vacated.has(plan.to.file)) {
				await overwrite(plan.to.file, text, null);
				continue;
			}
			const collection = site.collections[plan.to.collection]!;
			const document = parseAnyDocument(JSON.parse(text), site, collection);
			await createOnDisk(site, { ...plan.to, title: plan.title, text, document });
			undo.push(() => deleteOnDisk(site, { ...plan.to, entry: plan.from.entry }));
		}
		for (const r of changes.relinked) await overwrite(r.file, r.text, null);
		if (changes.settings) {
			const file = join(site.root, SITE_SETTINGS_FILE);
			if (changes.settings.before === null) {
				await writeFile(file, changes.settings.after, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
				undo.push(() => rm(file, { force: true }));
			} else {
				await writeAtomic(file, changes.settings.after);
				const before = changes.settings.before;
				undo.push(() => writeAtomic(file, before));
			}
		}
		for (const { plan } of changes.moved) {
			if (targets.has(plan.from.file)) continue;
			const confined = await confineOnDisk(site, plan.from.file);
			const text = await readFile(confined.absolute, 'utf8');
			await deleteOnDisk(site, { ...plan.from, entry: plan.from.entry });
			const collection = site.collections[plan.from.collection]!;
			undo.push(() => createOnDisk(site, { ...plan.from, title: plan.title, text, document: parseAnyDocument(JSON.parse(text), site, collection) }));
		}
	} catch (error) {
		for (const step of undo.reverse()) await step().catch(() => {});
		throw error;
	}
}

// ── The route ──────────────────────────────────────────────────────────────

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
	});

/** What the route needs of the drafts store. */
export interface Moves {
	move(request: MoveRequest, context?: WriteContext): Promise<MoveResponse>;
}

/** POST /_caracms/move: a Request in, a Response out, through the mode's store (create.ts's handling, the same checks). */
export async function handleMove(request: Request, store: Moves, who: { person?: Person | null } = {}): Promise<Response> {
	try {
		if (request.method !== 'POST') throw new WriteRefused(405, 'The move route only takes POST.');
		checkOrigin(request);
		const type = request.headers.get('content-type') ?? '';
		if (!/^application\/json\s*(;|$)/i.test(type)) throw new WriteRefused(415, 'Send JSON (Content-Type: application/json).');
		// caracms-cloud adversarial review, finding 10: counted as it's read, so a chunked body stops at the cap too.
		const raw = await readCappedText(request, MAX_CREATE_BODY_BYTES);
		if (raw === null) throw new WriteRefused(413, 'That body is too large.');
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			throw refused(400, 'bad-request', 'Malformed body: it isn\'t valid JSON.');
		}
		const context: WriteContext = { person: who.person ?? null, tab: tabOf(request), release: request.headers.get(RELEASE_HEADER) === '1', seq: seqOf(request) };
		return json(200, await store.move(parseMoveBody(body), context));
	} catch (error) {
		if (error instanceof WriteRefused) return json(error.status, { error: error.message, ...error.body }, error.status === 405 ? { Allow: 'POST' } : {});
		console.error('[caracms] move failed:', error);
		return json(500, { error: `That didn't work (${error instanceof Error ? error.message : String(error)}).` });
	}
}
