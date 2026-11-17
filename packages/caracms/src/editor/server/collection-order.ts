/**
 * A collection's hand order (review gaps, Decisions 2 and 4): the server's side of
 * collection-order.ts, both modes.
 *
 * **A security boundary, as arrange is** (arrange.ts): the paths come from the browser, so
 * the route is the same POST-JSON-same-origin handler, the collection must be a manual one,
 * and every path must be one of its documents as the listing has them.
 *
 * - A drag sends the collection's whole list (`order`); a new entry whose place waited on
 *   the Site Settings lock sends `first` once it's free (Decision 4). Either way the store
 *   writes Site Settings alone: on disk in local mode, an autosave under its lock in live mode.
 * - `firstEdit` is a create's own Site Settings edit (the new entry first), and
 *   `handOrderEdit` keeps the order current when entries are renamed or moved (Decision 2,
 *   arrange.ts → `orderEdit`).
 */
import type { ResolvedCollection, ResolvedSite } from '../../config.ts';
import type { DocumentEntry } from '../../content.ts';
import { parseAnyDocument, type SettingsDocument } from '../../document.ts';
import { collectionOrderAfterMoves, isManual, parseCollectionOrder, withFirst, withList, type CollectionOrder, type CollectionPathChange } from '../../collection-order.ts';
import { applyKeyedEdits } from '../../serialize.ts';
import type { CollectionOrderRequest } from '../types.ts';
import { refused } from './create.ts';
import type { PathMove } from './move.ts';
import { FOLDER_GONE_MESSAGE, FOLDER_MISSHAPEN_MESSAGE, pageFilingEdit } from './arrange.ts';
import { RESERVED_SLUG } from '../../slug.ts';

type Site = Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>;

const SHAPE = '{ collection, order: ["path"…] } or { collection, first: "path", folder? }';

/** Validate a body's shape. Throws WriteRefused 400. */
export function parseCollectionOrderBody(body: unknown): CollectionOrderRequest {
	const bad = (why: string) => refused(400, 'bad-request', `Malformed body: ${why}. Send ${SHAPE}.`);
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('it must be a JSON object');
	const b = body as Record<string, unknown>;
	const extra = Object.keys(b).filter((k) => !['collection', 'order', 'first', 'folder'].includes(k));
	if (extra.length) throw bad(`unexpected ${extra.map((k) => JSON.stringify(k.slice(0, 60))).join(', ')}`);
	if (typeof b.collection !== 'string' || b.collection === '') throw bad('"collection" must be a collection\'s name');
	if ((b.order === undefined) === (b.first === undefined)) throw bad('send one of "order" and "first"');
	if (b.order !== undefined) {
		if (!Array.isArray(b.order) || !b.order.every((p) => typeof p === 'string' && p !== '')) throw bad('"order" must be a list of paths');
		if (b.order.some((p) => (p as string).length > 512)) throw refused(400, 'bad-path', 'That path is too long.');
		return { collection: b.collection, order: [...new Set(b.order as string[])] };
	}
	if (typeof b.first !== 'string' || b.first === '') throw bad('"first" must be a path');
	if (b.first.length > 512) throw refused(400, 'bad-path', 'That path is too long.');
	if (b.folder !== undefined && (typeof b.folder !== 'string' || b.folder === '' || b.folder.length > 120)) throw bad('"folder" must be a folder\'s id');
	return { collection: b.collection, first: b.first, ...(b.folder !== undefined ? { folder: b.folder as string } : {}) };
}

const settingsCollection = (site: Pick<Site, 'collections'>): ResolvedCollection | undefined => Object.values(site.collections).find((c) => c.kind === 'settings');

/** Site Settings' `collectionOrder` in its text (`{}`: none, or the text isn't JSON). */
export function collectionOrderIn(text: string | null): CollectionOrder {
	if (text === null) return {};
	try {
		const raw = JSON.parse(text) as unknown;
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? parseCollectionOrder((raw as Record<string, unknown>).collectionOrder) : {};
	} catch {
		return {};
	}
}

/**
 * Site Settings' text with one of its package keys set to `value`, every other key as it was
 * (an empty order is taken out by its codec); `text` null: a new file. Unchanged text when
 * the text isn't JSON (the editor warns about that file), or when there's no file and
 * nothing to write.
 */
export function settingsWithKey(site: Pick<Site, 'collections' | 'blocks'>, text: string | null, key: 'pageOrder' | 'pageFolders' | 'collectionOrder', value: Record<string, unknown>): string | null {
	const collection = settingsCollection(site);
	if (!collection) return text;
	let doc: SettingsDocument | null = null;
	if (text !== null) {
		try {
			doc = parseAnyDocument(JSON.parse(text), site, collection) as SettingsDocument;
		} catch {
			return text;
		}
	}
	if (doc === null && Object.keys(value).length === 0) return text;
	return applyKeyedEdits(text, { title: doc?.title ?? 'Site Settings', data: { ...(doc?.data ?? {}), [key]: value } }, collection);
}

/** Site Settings' text with `collectionOrder` set to `order` (settingsWithKey's rules). */
export const settingsWithCollectionOrder = (site: Pick<Site, 'collections' | 'blocks'>, text: string | null, order: CollectionOrder): string | null => settingsWithKey(site, text, 'collectionOrder', order);

/** The manual collection a request names. Throws WriteRefused: 404 for no such collection, 400 for one with no hand order. */
function manualCollection(site: Pick<Site, 'collections'>, name: string): ResolvedCollection {
	const collection = Object.hasOwn(site.collections, name) ? site.collections[name]! : undefined;
	if (!collection) throw refused(404, 'not-found', `No collection "${name.slice(0, 60)}" is declared.`);
	if (!isManual(collection)) throw refused(400, 'bad-request', `${collection.label} has no hand order (order: 'manual' in its config).`);
	return collection;
}

export interface CollectionOrderPlan {
	collection: string;
	/** Site Settings' text → its text with the new order; null when nothing changes. */
	edit: (text: string | null) => string | null;
}

/**
 * The request's plan against the listing as it is (`documents`). Every path must be one of
 * the collection's documents (404 `not-found` naming the first that isn't). A drag's list
 * replaces the collection's; `first` puts that one first in whatever the order is by then.
 */
export function planCollectionOrder(site: Site, request: CollectionOrderRequest, documents: readonly DocumentEntry[]): CollectionOrderPlan {
	// Page folders: a new page's filing that waited on Site Settings (Decision 8, check 10).
	if (request.folder !== undefined) {
		const paths = documents.filter((d) => d.collection === request.collection).map((d) => d.path);
		const filing = request.first === undefined ? null : pageFilingEdit(site, request.collection, request.first, request.folder, paths);
		if (!filing) throw refused(400, 'bad-request', 'Only a new page in the Pages collection is filed in a folder.');
		// Home is never filed (the reader's table).
		if (request.first!.slice(request.first!.lastIndexOf('/') + 1) === RESERVED_SLUG) throw refused(400, 'bad-request', 'Home can’t go in a folder.');
		if (!paths.includes(request.first!)) throw refused(404, 'not-found', `There's no page at /${request.first!.slice(0, 120)} any more.`);
		return {
			collection: request.collection,
			edit: (text) => {
				const after = filing.edit(text);
				if (filing.misshapen()) throw refused(422, 'invalid-json', FOLDER_MISSHAPEN_MESSAGE);
				if (filing.gone()) throw refused(404, 'not-found', FOLDER_GONE_MESSAGE);
				return after;
			},
		};
	}
	const collection = manualCollection(site, request.collection);
	const paths = new Set(documents.filter((d) => d.collection === collection.name).map((d) => d.path));
	const asked = request.order ?? [request.first!];
	const gone = asked.find((p) => !paths.has(p));
	if (gone !== undefined) throw refused(404, 'not-found', `There's no ${collection.label} entry called "${gone.slice(0, 120)}" any more.`);
	const edit = (text: string | null) => {
		const saved = collectionOrderIn(text);
		const next = request.order ? withList(saved, collection.name, request.order) : withFirst(saved, collection.name, request.first!);
		const after = settingsWithCollectionOrder(site, text, next);
		return after === text ? null : after;
	};
	return { collection: collection.name, edit };
}

/**
 * Decision 4 when Site Settings can't be read: a new entry is still made, but its place
 * can't be written (settingsWithKey leaves broken JSON as it is), so `create` answers
 * `order: 'unkept'` with this sentence, as a drag is refused with UNREADABLE_HAND_ORDER_MESSAGE.
 */
export const UNKEPT_PLACE_MESSAGE = "Site Settings isn't valid JSON, so the new entry's place in the order couldn't be saved there. It was made, and shows after the ordered entries: fix Site Settings, then drag it into place.";

/** Whether Site Settings' text is there but can't be read (not JSON, or not a document); null (no file yet) reads fine. */
export function settingsUnreadable(site: Pick<Site, 'collections' | 'blocks'>, text: string | null): boolean {
	const collection = settingsCollection(site);
	if (!collection || text === null) return false;
	try {
		parseAnyDocument(JSON.parse(text), site, collection);
		return false;
	} catch {
		return true;
	}
}

/** Decision 4: a create's Site Settings edit, the new entry first in its manual collection's order; null when it isn't a manual collection. */
export function firstEdit(site: Pick<Site, 'collections' | 'blocks'>, collection: string, path: string): ((text: string | null) => string | null) | null {
	if (!isManual(site.collections[collection])) return null;
	return (text) => {
		const after = settingsWithCollectionOrder(site, text, withFirst(collectionOrderIn(text), collection, path));
		return after === text ? null : after;
	};
}

/** Decision 2: the engine's Site Settings edit that keeps the hand orders current after these moves (a renamed entry keeps its place). */
export function handOrderEdit(site: Pick<Site, 'collections' | 'blocks'>, moves: readonly PathMove[]): (text: string) => string {
	const changes: CollectionPathChange[] = moves.filter((m) => m.path !== m.to && isManual(site.collections[m.collection])).map((m) => ({ collection: m.collection, from: m.path, to: m.to }));
	return (text) => {
		if (changes.length === 0) return text;
		const saved = collectionOrderIn(text);
		if (Object.keys(saved).length === 0) return text;
		return settingsWithCollectionOrder(site, text, collectionOrderAfterMoves(saved, changes)) ?? text;
	};
}
