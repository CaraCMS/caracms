/**
 * The content reader: a collection's documents from its folder on disk.
 *
 * - **Read at request time, never imported** (Decision 5): plain `fs`, so dev keeps
 *   seeing what's on disk once content is out of Vite's watch.
 * - **Pure enough to be the drafts store's local implementation** (Phase 2): the
 *   seam is `list`, `read` and `write`; `listDocuments` and `readDocument` are its
 *   `list` and `read`, and `resolveDocumentFile` is the confinement check the
 *   write route reuses. No caches, no module state.
 * - **Pages nest** (Decision 8) in a collection with `nested: true`: the file's path
 *   is the URL, `index.json` at the top is the collection's `urlBase`, and an
 *   `index.json` any deeper is an error, listed with a warning and not opened.
 * - **Order** (Decision 8): the reader provides it. `listDocuments` returns a nested
 *   collection in tree order, and a flat collection alphabetically by title. `pageTree`
 *   builds the tree itself; each level follows page-order.ts (arrange pages, Decision 7:
 *   Home first, then Site Settings' saved `pageOrder` for Pages, read from the same
 *   source first, then what has pages under it, then A–Z, a folder with no page of its
 *   own sorted by its label). A manual collection (review gaps, Decision 5) follows
 *   Site Settings' `collectionOrder`, then A–Z (collection-order.ts).
 * - A file that isn't valid JSON, or has no `title`, is listed with a warning and
 *   can't be opened (Decision 9).
 * - **Two sources, one set of rules** (M4 Current state): the files come from a
 *   ContentSource, the disk by default (`diskSource`), or live mode's in-memory
 *   `drafts` copy (`filesSource`). Parsing, ordering and warnings are the same code
 *   either way, so a document never reads differently in the two modes.
 * - **Every kind of document** (M5a): a collection's kind says how its files parse
 *   (document.ts → parseAnyDocument). The two reserved collections are read like any
 *   other: `shared` is a flat folder of shared blocks, `settings` holds exactly one
 *   document, `site-settings` (`content/site-settings.json`). Neither has URLs.
 * - **"Used on"** (Decision 8): the full listing (every collection) gives each shared
 *   block the documents whose block list has an entry for it (`usedOn`), from the
 *   same source, so live mode's counts include autosaves.
 */
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SETTINGS_PATH, SLOT_NAMES, type ResolvedCollection, type ResolvedSite, type SlotName } from './config.ts';
import { titleCase } from './fields.ts';
import { isBuiltInColumn } from './columns.ts';
import { fieldsCover, sectionsCover, type CardCover } from './cards.ts';
import { own, parseAnyDocument, type AnyDocument, type DocumentKind, type Frame } from './document.ts';
import { resolveSlot, type SlotCandidate } from './slots.ts';
import { parseSource } from './json-source.ts';
import { hasHeld, heldBases, type HeldBase } from './held.ts';
import { leftBehindMessage, leftBehindRoutes, ownRoutedCollections } from './code-routes.ts';
import { sameAddress } from './slug.ts';
import { byLabel, isOrderedCollection, parsePageOrder, type PageOrder } from './page-order.ts';
import { orderLevel, parsePageFolders, type PageFolders } from './page-folders.ts';
import { inSiteOrder, isManual, parseCollectionOrder, type CollectionOrder } from './collection-order.ts';
import { SITE_SETTINGS_FILE } from './reserved.ts';
import { documentProblems } from './document-problems.ts';
import { tagDocument } from './vivid.ts';

// Posts and tags, Decision 14: a route's reader on the disk (read.ts).
export { contentReader } from './read.ts';
// M8 trial (item 1): Site Settings for a site's own routes, as the page component gets them.
export { siteSettings } from './read.ts';
// Edit in context: Site Settings' context for a site's own routes, beside its values (no markers).
export { siteSettingsContext } from './read.ts';
// A Site Settings image's URL for the page's frame (media.ts).
export { settingsImageUrl } from './media.ts';
// Heading ids: the slug rule, and a page's headings for a TOC (heading-ids.ts).
export { headingId, headingText, pageHeadings, type HeadingSeen, type PageHeading } from './heading-ids.ts';

export type WarningCode = 'invalid-json' | 'no-title' | 'nested-index';

export interface DocumentWarning {
	code: WarningCode;
	/** A plain sentence for the editor's list. */
	message: string;
}

export interface DocumentEntry {
	collection: string;
	/** The kind of document (its collection's kind, M5a). The reader always sets it; absent reads as `sections`. */
	kind?: DocumentKind;
	/**
	 * The document's path inside its collection's folder, `/`-separated, without
	 * `.json`: `index`, `about`, `services/branding`, `my-first-post`. With the
	 * collection, it's the document's identity (and its `/admin/<collection>/<path>`).
	 */
	path: string;
	/** The file, relative to the site's root, `/`-separated. */
	file: string;
	/** The page's URL: `/`, `/services/branding`, `/journal/my-first-post`. Null for a nested `index.json`. */
	url: string | null;
	/** The document's `title`, or `''` if it has none or can't be read. */
	title: string;
	/** The title, or the file name title-cased when there's no title: what the editor lists. */
	label: string;
	/** Set when the file can't be opened. */
	warning: DocumentWarning | null;
	/**
	 * M9 Decision 7: hidden from the site, by the page's own `"hidden": true` or (`hiddenBy`, the
	 * path of the hidden page above it) a page it's nested under. A site's routes, the sitemap and
	 * `contentReader().documents()` leave it out; the editor lists it, marked. Never the home page.
	 */
	hidden?: true;
	hiddenBy?: string;
	/**
	 * The page's own `"hidden": true`, kept apart from `hiddenBy`: a page hidden itself and also
	 * under a hidden page has both, and the arrange screen needs to know it stays hidden when moved.
	 */
	hiddenSelf?: true;
	/**
	 * Collections under pages (Decision 11): set when `hiddenBy` is a page of another collection,
	 * the page that holds this document's collection (`pages`). Absent: `hiddenBy` is in this one.
	 */
	hiddenByCollection?: string;
	/**
	 * Collections under pages (Decision 5): a page's `"holds"`, the collection it holds (held.ts).
	 * Read from a file that can't be opened too, as far as it can be, so a broken holder is named.
	 */
	holds?: string;
	/** A section builder's shared-block entries, by shared block path, in block order, once each (Decision 8). Absent otherwise. */
	uses?: string[];
	/** A shared block: its block's type (`''` when it has none). Absent otherwise. */
	blockType?: string;
	/** Edit in context, Decision 2: a shared block whose type the code knows and fills a slot of the page's frame: that slot. Absent otherwise. */
	slot?: SlotName;
	/** Edit in context, Decision 3: a shared block that's its slot's default (the file's `"default": true`). Absent otherwise. */
	default?: true;
	/** Edit in context, Decision 3: a page's (or a fields document's) own picks for its frame's slots (the file's `frame`). Absent when it picks none. */
	frame?: Frame;
	/**
	 * A shared block, in a listing of every collection: the documents whose block list
	 * has an entry for it, in listing order (Decision 8's "used on"). Absent otherwise.
	 * Edit in context, Decision 3: a slot's block is used on every document with an address
	 * it fills, its default's share and the picks alike, hidden ones included (`slotUses`).
	 */
	usedOn?: { collection: string; path: string }[];
	/**
	 * A list-of-fields document whose collection names table `columns` (pre-M7 polish):
	 * those fields' values, as parsed, so the editor's table draws without opening each.
	 * Absent otherwise.
	 */
	columns?: Record<string, unknown>;
	/**
	 * M6c (G5): in a collection with the List / Grid switch, the document's card picture
	 * before it's signed (cards.ts, Decision 14): absent when it has none (a text card).
	 * The editor's listing swaps it for signed URLs (editor/server/cards.ts) on the way out.
	 */
	cover?: CardCover;
}

export interface ReadDocument {
	entry: DocumentEntry;
	/** The file's text exactly as read: the serializer's base (serialize.ts → applyDocumentEdits). */
	text: string;
	document: AnyDocument;
}

export type DocumentErrorCode = WarningCode | 'not-found' | 'bad-path' | 'unknown-collection';

export class DocumentError extends Error {
	readonly code: DocumentErrorCode;
	constructor(code: DocumentErrorCode, message: string) {
		super(message);
		this.name = 'DocumentError';
		this.code = code;
	}
}

const posix = (p: string) => p.split(sep).join('/');

/**
 * Where the reader's files come from. Paths are absolute, as on disk; an in-memory
 * source maps them back to the site's own relative paths.
 */
export interface ContentSource {
	/** A file's text, or null when it doesn't exist. */
	readText(file: string): Promise<string | null>;
	/**
	 * The `.json` file names under a folder, relative to it and `/`-separated, in any
	 * order: every depth when `recursive`, else only the folder's own. Empty when the
	 * folder doesn't exist.
	 */
	listJson(dir: string, recursive: boolean): Promise<string[]>;
}

/** The content files on disk (M3). */
export const diskSource: ContentSource = {
	async readText(file) {
		try {
			return await readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	},
	async listJson(dir, recursive) {
		let names: string[];
		try {
			names = (await readdir(dir, { recursive })) as string[];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		return names.map(posix).filter((n) => n.endsWith('.json'));
	},
};

/**
 * Files held in memory, keyed by their path relative to the site's root
 * (`content/pages/index.json`): live mode's `drafts` copy. `files` is read on every
 * call, so the source follows a copy that changes under it.
 */
export function filesSource(root: string, files: () => ReadonlyMap<string, string>): ContentSource {
	const rel = (file: string) => posix(relative(root, file));
	return {
		async readText(file) {
			return files().get(rel(file)) ?? null;
		},
		async listJson(dir, recursive) {
			const folder = rel(dir);
			const prefix = folder === '' ? '' : `${folder}/`;
			const out: string[] = [];
			for (const path of files().keys()) {
				if (!path.startsWith(prefix) || !path.endsWith('.json')) continue;
				const inside = path.slice(prefix.length);
				if (!recursive && inside.includes('/')) continue;
				out.push(inside);
			}
			return out;
		},
	};
}

/** A document path's URL in its collection (`index` at the top of a nested collection is its base); null in the reserved collections. */
export function documentUrl(collection: ResolvedCollection, path: string): string | null {
	if (collection.urlBase === null) return null;
	if (collection.nested) {
		if (path === 'index') return collection.urlBase;
		if (path.endsWith('/index')) return null;
	}
	return collection.urlBase + path;
}

/**
 * The absolute file for a document path, confined to the collection's folder.
 * Refuses (DocumentError 'bad-path') an absolute path, `..`, an empty segment, a
 * backslash, a dot-file, or anything that resolves outside the folder; and an
 * undeclared collection ('unknown-collection'). Phase 2's write route uses this as
 * its security check (Decision 5).
 */
export function resolveDocumentFile(site: Pick<ResolvedSite, 'collections'>, collectionName: string, path: string): string {
	const collection = own(site.collections, collectionName);
	if (!collection) {
		throw new DocumentError('unknown-collection', `No collection "${collectionName}" is declared.`);
	}
	const bad = () => new DocumentError('bad-path', `"${path}" isn't a document path in ${collectionName}.`);
	if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('\\') || path.includes('\0')) throw bad();
	const segments = path.split('/');
	if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) throw bad();
	if (!collection.nested && segments.length > 1) throw bad();
	// Site Settings is one document (M4 Decision 15), however its folder is shared.
	if (collection.kind === 'settings' && path !== SETTINGS_PATH) throw bad();
	const file = resolve(collection.dir, `${path}.json`);
	const inside = relative(collection.dir, file);
	if (inside.startsWith('..') || isAbsolute(inside)) throw bad();
	return file;
}

/**
 * Every document in one collection, in several (in the order given), or in all of them (in
 * config order), with warnings, in the editor's order. A held collection's documents have
 * their resolved addresses (held.ts), whichever collections are listed.
 */
export async function listDocuments(
	site: Pick<ResolvedSite, 'collections' | 'root' | 'blocks'>,
	collectionName?: string | readonly string[],
	source: ContentSource = diskSource,
): Promise<DocumentEntry[]> {
	const names = collectionName === undefined ? Object.keys(site.collections) : typeof collectionName === 'string' ? [collectionName] : [...collectionName];
	const all: DocumentEntry[] = [];
	for (const name of names) {
		const collection = own(site.collections, name);
		if (!collection) throw new DocumentError('unknown-collection', `No collection "${name}" is declared.`);
		const paths = await documentPaths(collection, source);
		const entries = (await Promise.all(paths.map((path) => entryFor(site, collection, path, source)))).filter((e) => e !== null);
		if (collection.nested) hideChildren(entries);
		// Arrange pages (Decision 6): Pages follow Site Settings' saved order, read through the same source.
		const layout = isOrderedCollection(collection) ? await savedPageLayout(site, source) : undefined;
		// Review gaps (Decision 5): a manual collection follows its hand order, hidden entries and warned ones keeping their places.
		const hand = isManual(collection) ? (await savedCollectionOrder(site, source))[collection.name] : undefined;
		all.push(...(collection.nested ? flattenTree(pageTree(entries, layout?.order, layout?.folders)) : isManual(collection) ? inSiteOrder(entries, hand) : entries.sort(byLabel)));
	}
	// Collections under pages (Decision 7): a held collection's addresses come from its holder's listing.
	const held = names.map((n) => site.collections[n]!).filter((c) => c.heldBy);
	if (held.length) {
		const holding: DocumentEntry[] = [];
		for (const by of new Set(held.map((c) => c.heldBy!))) {
			holding.push(...(names.includes(by) ? all.filter((e) => e.collection === by) : await listDocuments(site, by, source)));
		}
		const bases = heldBases(site.collections, holding);
		for (const entry of all) {
			const base = own(bases, entry.collection);
			if (base) placeHeld(entry, base);
		}
	}
	if (collectionName === undefined) {
		// Decision 8's "used on": every document whose block list has an entry for the shared block.
		// Edit in context, Decision 3: a slot's block, every document with an address it fills.
		const fills = slotUses(all, site.blocks);
		for (const entry of all) {
			if (entry.kind !== 'shared') continue;
			const using = entry.slot ? (fills.get(entry.path) ?? []) : all.filter((d) => d.uses?.includes(entry.path));
			entry.usedOn = using.map((d) => ({ collection: d.collection, path: d.path }));
		}
	}
	return all;
}

/** A listed shared block as the slot rules take it (slots.ts), as the slot component builds it. */
export function slotCandidate(entry: DocumentEntry, blocks: Pick<ResolvedSite, 'blocks'>['blocks']): SlotCandidate {
	const type = entry.blockType ?? '';
	return { path: entry.path, title: entry.label, type, known: !!own(blocks, type), ...(entry.slot ? { slot: entry.slot } : {}), default: !!entry.default };
}

/**
 * Edit in context, Decision 3: which documents each slot block fills, by its path, in listing
 * order: every document with an address (a page, a held document, a fields document with an
 * address; hidden ones too; never one that can't be read) gets its pick, else the default
 * (slots.ts → `resolveSlot`, as the render does). The editor's lists read the same map.
 */
export function slotUses(all: readonly DocumentEntry[], blocks: Pick<ResolvedSite, 'blocks'>['blocks']): Map<string, DocumentEntry[]> {
	const out = new Map<string, DocumentEntry[]>();
	const shared = all.filter((d) => d.kind === 'shared' && !d.warning);
	if (!shared.some((d) => d.slot)) return out;
	const candidates = shared.map((d) => slotCandidate(d, blocks));
	for (const d of all) {
		if (d.url === null || d.warning || d.kind === 'shared' || d.kind === 'settings') continue;
		for (const slot of SLOT_NAMES) {
			const path = resolveSlot(slot, d.frame?.[slot], candidates).path;
			if (path === null) continue;
			const list = out.get(path) ?? [];
			list.push(d);
			out.set(path, list);
		}
	}
	return out;
}

/**
 * Arrange pages (Decision 6): Site Settings' `pageOrder` through `source` (live mode: the
 * `drafts` copy with the autosaves on top); `{}` when there's none or the file can't be read.
 */
export async function savedPageOrder(site: Pick<ResolvedSite, 'root'>, source: ContentSource = diskSource): Promise<PageOrder> {
	return (await savedPageLayout(site, source)).order;
}

/**
 * Page folders: Site Settings' `pageOrder` and `pageFolders` through `source`, read once
 * (`{}` each when there's none or the file can't be read).
 */
export async function savedPageLayout(site: Pick<ResolvedSite, 'root'>, source: ContentSource = diskSource): Promise<{ order: PageOrder; folders: PageFolders }> {
	const text = await source.readText(join(site.root, SITE_SETTINGS_FILE)).catch(() => null);
	if (text === null) return { order: {}, folders: {} };
	try {
		const raw = JSON.parse(text) as unknown;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { order: {}, folders: {} };
		const r = raw as Record<string, unknown>;
		return { order: parsePageOrder(r.pageOrder), folders: parsePageFolders(r.pageFolders) };
	} catch {
		return { order: {}, folders: {} };
	}
}

/**
 * Review gaps (Decision 2): Site Settings' `collectionOrder` through `source`, as
 * `savedPageOrder` reads `pageOrder`; `{}` when there's none or the file can't be read.
 */
export async function savedCollectionOrder(site: Pick<ResolvedSite, 'root'>, source: ContentSource = diskSource): Promise<CollectionOrder> {
	const text = await source.readText(join(site.root, SITE_SETTINGS_FILE)).catch(() => null);
	if (text === null) return {};
	try {
		const raw = JSON.parse(text) as unknown;
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? parseCollectionOrder((raw as Record<string, unknown>).collectionOrder) : {};
	} catch {
		return {};
	}
}

/** A held document's address and hidden mark from its collection's resolved base (held.ts). */
function placeHeld(entry: DocumentEntry, held: HeldBase): void {
	entry.url = held.base === null ? null : held.base + entry.path;
	// Decision 11: a hidden holder hides its documents, as a hidden page hides the pages under it.
	if (held.hidden && held.holder) {
		entry.hidden = true;
		entry.hiddenBy = held.holder.path;
		entry.hiddenByCollection = held.holder.collection;
	}
}

/** A held collection's resolved base, from its holder collection's listing through `source`. */
export async function heldBaseOf(site: Pick<ResolvedSite, 'collections' | 'root' | 'blocks'>, collectionName: string, source: ContentSource = diskSource): Promise<HeldBase | null> {
	const collection = own(site.collections, collectionName);
	if (!collection?.heldBy) return null;
	return heldBases({ [collection.name]: collection }, await listDocuments(site, collection.heldBy, source))[collection.name] ?? null;
}

/** Every held collection's resolved base (held.ts), from the listings of the collections that hold them; `{}` on a site with none. */
export async function heldBasesOf(site: Pick<ResolvedSite, 'collections' | 'root' | 'blocks'>, source: ContentSource = diskSource): Promise<Record<string, HeldBase>> {
	if (!hasHeld(site.collections)) return {};
	const by = [...new Set(Object.values(site.collections).flatMap((c) => (c.heldBy ? [c.heldBy] : [])))];
	const holding = (await Promise.all(by.map((name) => listDocuments(site, name, source)))).flat();
	return heldBases(site.collections, holding);
}

/**
 * A document's public address as its listing gives it: `documentUrl` for a collection with a
 * prefix, the holder's address + `/` + the path for a held one (null while it isn't held).
 */
export async function documentAddress(site: Pick<ResolvedSite, 'collections' | 'root' | 'blocks'>, collectionName: string, path: string, source: ContentSource = diskSource): Promise<string | null> {
	const collection = own(site.collections, collectionName);
	if (!collection) return null;
	if (!collection.heldBy) return documentUrl(collection, path);
	const held = await heldBaseOf(site, collectionName, source);
	return held?.base ? held.base + path : null;
}

/** M9 Decision 7: a hidden page's children are hidden with it; `hiddenBy` names the topmost hidden page above. */
function hideChildren(entries: DocumentEntry[]): void {
	const hidden = new Set(entries.filter((e) => e.hidden).map((e) => e.path));
	if (hidden.size === 0) return;
	for (const entry of entries) {
		const parts = entry.path.split('/');
		for (let n = 1; n < parts.length; n++) {
			const above = parts.slice(0, n).join('/');
			if (!hidden.has(above)) continue;
			entry.hidden = true;
			entry.hiddenBy = above;
			break;
		}
	}
}

/**
 * Read one document. Throws DocumentError: 'not-found', 'bad-path',
 * 'unknown-collection', or the listing's warning codes ('invalid-json',
 * 'no-title', 'nested-index') for a file that can't be opened.
 *
 * `untitled: true` is the editor's read (caracms-cloud adversarial review, finding 15): a
 * document with no title opens, its entry still warned, so the title can be put back there.
 * Everything that renders the site reads without it, so such a document has no page there.
 */
export async function readDocument(
	site: Pick<ResolvedSite, 'collections' | 'root' | 'blocks'>,
	collectionName: string,
	path: string,
	source: ContentSource = diskSource,
	options: { untitled?: boolean } = {},
): Promise<ReadDocument> {
	const file = resolveDocumentFile(site, collectionName, path);
	const collection = site.collections[collectionName]!;
	const text = await source.readText(file);
	if (text === null) throw new DocumentError('not-found', `${collection.label}: no document "${path}".`);
	const { entry, document } = inspect(site, collection, path, text);
	const opens = !entry.warning || (options.untitled === true && entry.warning.code === 'no-title');
	if (!opens || !document) throw new DocumentError(entry.warning!.code, entry.warning!.message);
	if (collection.heldBy) {
		const held = await heldBaseOf(site, collection.name, source);
		if (held) placeHeld(entry, held);
	}
	// Vivid (vivid.ts): RenderDocument and <Blocks> find the document's collection and path from it.
	tagDocument(document, { collection: collectionName, path });
	return { entry, text, document };
}

/** Document paths in a collection's folder (sorted, `/`-separated, without `.json`). A missing folder is empty. */
async function documentPaths(collection: ResolvedCollection, source: ContentSource): Promise<string[]> {
	const names = await source.listJson(collection.dir, collection.nested);
	if (collection.kind === 'settings') return names.includes(`${SETTINGS_PATH}.json`) ? [SETTINGS_PATH] : [];
	return names
		.filter((n) => !n.split('/').some((s) => s.startsWith('.')))
		.map((n) => n.slice(0, -'.json'.length))
		.sort();
}

/** A listed path's entry; null when the file went away between listing and reading. */
async function entryFor(site: Pick<ResolvedSite, 'root' | 'blocks'>, collection: ResolvedCollection, path: string, source: ContentSource): Promise<DocumentEntry | null> {
	const text = await source.readText(join(collection.dir, `${path}.json`));
	return text === null ? null : inspect(site, collection, path, text).entry;
}

function inspect(
	site: Pick<ResolvedSite, 'root' | 'blocks'>,
	collection: ResolvedCollection,
	path: string,
	text: string,
): { entry: DocumentEntry; document: AnyDocument | null } {
	const base = {
		collection: collection.name,
		kind: collection.kind,
		path,
		file: posix(relative(site.root, join(collection.dir, `${path}.json`))),
		url: documentUrl(collection, path),
	};
	const fileLabel = titleCase(path.split('/').pop()!);
	// Decision 13: a broken holder is named, so its `"holds"` is read from the text as far as it can be.
	const holdsIn = () => (collection.kind === 'sections' ? /"holds"\s*:\s*"([^"\\]*)"/.exec(text)?.[1] : undefined);
	const warn = (code: WarningCode, message: string, title = '') => {
		const holds = holdsIn();
		return { entry: { ...base, title, label: title || fileLabel, warning: { code, message }, ...(holds !== undefined ? { holds } : {}) }, document: null };
	};

	if (collection.nested && path.endsWith('/index')) {
		const parent = path.slice(0, -'/index'.length);
		return warn('nested-index', `index.json only means the top of ${collection.label}. Rename it to ${parent}.json to make it the ${parent} page.`);
	}
	let document: AnyDocument;
	let raw: unknown;
	try {
		raw = parseSource(text).value;
		document = parseAnyDocument(raw, site, collection);
	} catch (error) {
		return warn('invalid-json', `This file isn't valid JSON (${error instanceof Error ? error.message : String(error)}).`);
	}
	// caracms-cloud adversarial review, finding 15: a blank title keeps the document off the site
	// (the listing's warning), but it's still read, columns and all, so the editor can open it
	// and put one back.
	const untitled = documentProblems(raw).length > 0;
	const title = untitled ? '' : (raw as { title: string }).title;
	const warning: DocumentWarning | null = untitled ? { code: 'no-title', message: 'This has no title, so it isn’t on the site. Open it to add one.' } : null;
	const entry: DocumentEntry = { ...base, title, label: title || fileLabel, warning };
	// M9 Decision 7: the home page is never hidden.
	if ((document.kind === undefined || document.kind === 'sections') && document.hidden && path !== 'index') entry.hidden = entry.hiddenSelf = true;
	if ((document.kind === undefined || document.kind === 'sections') && document.holds !== undefined) entry.holds = document.holds;
	if (document.kind === undefined || document.kind === 'sections') {
		entry.uses = [...new Set(document.blocks.flatMap((b) => (b.shared !== undefined ? [b.shared] : [])))];
	} else if (document.kind === 'shared') {
		entry.blockType = document.block.type;
		const slot = document.block.known ? own(site.blocks, document.block.type)?.slot : undefined;
		if (slot) entry.slot = slot;
		if (document.default) entry.default = true;
	}
	if ((document.kind === undefined || document.kind === 'sections' || document.kind === 'fields') && document.frame) entry.frame = document.frame;
	// A field column's values ride on the listing (pre-M7 polish); a section builder's page fields too (posts and tags, Decision 13).
	if ((document.kind === 'fields' || document.kind === undefined || document.kind === 'sections') && collection.columns) {
		const data = (document.data ?? {}) as Record<string, unknown>;
		const keys = collection.columns.filter((k) => !isBuiltInColumn(k));
		if (keys.length) entry.columns = Object.fromEntries(keys.map((k) => [k, data[k] ?? null]));
	}
	if (collection.view) {
		const cover =
			document.kind === 'fields'
				? fieldsCover(collection.fields ?? {}, document.data as Record<string, unknown>, collection.view.image)
				: document.kind === undefined || document.kind === 'sections'
					? sectionsCover(collection.fields, document.data, document.blocks, site.blocks)
					: null;
		if (cover) entry.cover = cover;
	}
	return { entry, document };
}

// ── The Pages tree (Decision 8) ───────────────────────────────────────────────

export type PageTreeNode =
	| { kind: 'page'; path: string; label: string; entry: DocumentEntry; children: PageTreeNode[] }
	| {
			/** A folder with no page of its own: shows or hides its children only. */
			kind: 'group';
			path: string;
			/** The folder's name, hyphens as spaces, capital first letter (`case-studies` → "Case studies"). */
			label: string;
			children: PageTreeNode[];
	  };

/**
 * A nested collection's entries as a tree that mirrors their paths. A page with
 * pages under it (`about.json` beside `about/`) is one node with children; a folder
 * with no page is a group. Each level is ordered by page-folders.ts → `orderLevel`
 * (arrange pages, Decision 7): Home (`index`) first, then the siblings `order` lists
 * for that level, then those with pages or a held collection under them, then A–Z. Page
 * folders: a level's folders take their places with their rows together, flattened (the
 * site never sees a folder, Decision 10; page-folders.ts → `orderLevel`).
 */
export function pageTree(entries: readonly DocumentEntry[], order: PageOrder = {}, folders: PageFolders = {}): PageTreeNode[] {
	interface Draft {
		path: string;
		entry?: DocumentEntry;
		children: Map<string, Draft>;
	}
	const top: Draft = { path: '', children: new Map() };
	for (const entry of entries) {
		const segments = entry.path.split('/');
		let node = top;
		segments.forEach((segment, i) => {
			const path = segments.slice(0, i + 1).join('/');
			let child = node.children.get(segment);
			if (!child) {
				child = { path, children: new Map() };
				node.children.set(segment, child);
			}
			node = child;
		});
		node.entry = entry;
	}
	const build = (draft: Draft): PageTreeNode[] =>
		orderLevel(
			[...draft.children.values()].map((d): PageTreeNode => {
				const children = build(d);
				if (d.entry) return { kind: 'page', path: d.path, label: d.entry.label, entry: d.entry, children };
				return { kind: 'group', path: d.path, label: titleCase(d.path.split('/').pop()!), children };
			}),
			Object.hasOwn(order, draft.path) ? order[draft.path] : undefined,
			Object.hasOwn(folders, draft.path) ? folders[draft.path] : undefined,
			(n) => n.children.length > 0 || (n.kind === 'page' && n.entry.holds !== undefined),
		).rows;
	return build(top);
}

function flattenTree(nodes: PageTreeNode[]): DocumentEntry[] {
	return nodes.flatMap((n) => [...(n.kind === 'page' ? [n.entry] : []), ...flattenTree(n.children)]);
}


// ── The catch-all's reader (collections under pages, Decision 14) ────────────────

/** A public page the site's catch-all serves: its collection, its path there, and its address. */
export interface AddressedDocument {
	collection: string;
	path: string;
	/** `/`, `/about`, `/journal/a-day-on-the-ferry`: no trailing slash, as the listing gives it. */
	url: string;
}

/** What the reader reads: the site, and the routes in its `src/pages/` (the integration sets `pageRoutes`). */
type CatchAllSite = Pick<ResolvedSite, 'collections' | 'root' | 'blocks'> & Partial<Pick<ResolvedSite, 'pageRoutes'>>;

const logged = new Set<string>();
/** The build's and dev's log, once per sentence per process (Decision 13: logged, never a failed build). */
function logOnce(message: string): void {
	if (logged.has(message)) return;
	logged.add(message);
	console.warn(`[caracms] ${message}`);
}

/**
 * Every public page of every collection with an address, for the site's one catch-all route
 * (`src/pages/[...path].astro`'s `getStaticPaths`): Pages, every held collection's documents at
 * their holder's address, and every prefix collection's (`/tags/<slug>`), in config order then
 * the editor's. Left out: a file that can't be opened, a hidden page (and the documents of a
 * hidden holder), a held collection no page holds, and a prefix collection whose base has its
 * own route (`src/pages/tags/[slug].astro`), which that route serves. A holder problem or a
 * route left at a held base is logged once (`caracms validate` reports both as errors).
 * `source`: where the files come from (the disk by default, as a build reads them).
 */
export async function addressedDocuments(site: CatchAllSite, source: ContentSource = diskSource): Promise<AddressedDocument[]> {
	const collections = Object.values(site.collections);
	const routes = site.pageRoutes ?? [];
	const ownRouted = new Set(ownRoutedCollections(routes, collections).map((c) => c.name));
	const names = collections.filter((c) => (c.urlBase !== null || c.heldBy) && !ownRouted.has(c.name)).map((c) => c.name);
	const entries = await listDocuments(site, names, source);
	if (hasHeld(site.collections)) {
		const held: { name: string; label: string; base: string; holder: string }[] = [];
		for (const base of Object.values(await heldBasesOf(site, source))) {
			if (base.problem) logOnce(base.problem);
			const c = site.collections[base.collection]!;
			if (base.base && base.holder) held.push({ name: c.name, label: c.label, base: base.base, holder: base.holder.label });
		}
		for (const left of leftBehindRoutes(routes, held)) logOnce(leftBehindMessage(left));
	}
	return entries.filter((e): e is DocumentEntry & { url: string } => e.url !== null && !e.warning && !e.hidden).map(({ collection, path, url }) => ({ collection, path, url }));
}

/**
 * The document a request's path is (`/journal/a-day-on-the-ferry`, with or without a trailing
 * slash, URL-encoded or not), for a catch-all that renders on demand; null when no public page
 * is there (`addressedDocuments` says which are).
 */
export async function documentAt(site: CatchAllSite, pathname: string, source: ContentSource = diskSource): Promise<{ collection: string; path: string } | null> {
	let at: string;
	try {
		at = sameAddress(decodeURIComponent(pathname));
	} catch {
		return null;
	}
	const found = (await addressedDocuments(site, source)).find((d) => sameAddress(d.url) === at);
	return found ? { collection: found.collection, path: found.path } : null;
}
