/**
 * The documents as the package and the editor see them, and how they're parsed from
 * a content file. Four kinds (M5a → Core framing), one per kind of collection:
 *
 *   SiteDocument      a section builder (Pages, Journal): `{ title, blocks }`, and its
 *                     page fields' values as `data` when the collection has some (M6c G2)
 *   FieldsDocument    a list-of-fields document (case studies): `{ kind: 'fields', title, data }`
 *   SharedDocument    a shared block: `{ kind: 'shared', title, block }`
 *   SettingsDocument  Site Settings: `{ kind: 'settings', title, data }`
 *
 * A SiteDocument has no `kind` (or `'sections'`): M3's shape, unchanged.
 * `parseAnyDocument(raw, site, collection)` reads any of them by its collection's kind.
 *
 * Block identity: every block carries `source`, its index in the file's `blocks`
 * array as read, or `null` for a block the editor added. The editor keeps `source`
 * on a block through reorders, and drops the block to remove it (bringing it back
 * with Undo restores the same `source`). The serializer (serialize.ts) uses it to
 * find each block's raw form in the file, so an unknown block, or any block the
 * editor didn't change, is written back byte for byte wherever it moves (Decision 7).
 * `source` is never written to the file.
 */
import type { ResolvedCollection, ResolvedSite } from './config.ts';
import { fieldAtPath, firstImagePath, getAtPath, headingPaths, isEmptyValue, list, parseField, text, type FieldValue, type Field, type Fields } from './fields.ts';
import { parseSource, type ParsedSource } from './json-source.ts';
import { isFileKey } from './files.ts';
import { VIVID_SETTINGS, vividEntry, vividShared, type DocumentRef, type VividDoc } from './vivid.ts';
import { parseMedia } from './media-value.ts';
import { parseRedirects, type Redirect } from './redirects.ts';
import { parsePageOrder, type PageOrder } from './page-order.ts';
import { parsePageFolders, type PageFolders } from './page-folders.ts';
import { parseCollectionOrder, type CollectionOrder } from './collection-order.ts';
import { parseFormRecipients, parseGoogleTag, parseSeo, type Seo } from './seo.ts';
import type { FormCodeWords, FormWords } from './forms/words.ts';

export interface DocumentBlock {
	/** Index of the block in the file's `blocks` as read; `null` for a block the editor added. */
	source: number | null;
	/** The block's `type` (`''` when the file's block has none). */
	type: string;
	/** Whether the site's config knows this type. An unknown block is skipped in the render (Decision 7). */
	known: boolean;
	/**
	 * Known: the parsed value of every field in the block's schema, keyed by field.
	 * Unknown: the block's raw keys (minus `type`) as read, so the editor can
	 * summarise what's kept (Decision 21); the serializer never writes these back,
	 * it copies the raw block instead.
	 */
	data: Record<string, unknown>;
	/**
	 * A shared-block entry (M5a Decision 8: `{ "shared": "footer" }`): the shared
	 * block's path in the `shared` collection. Such an entry is never `known` (it's
	 * selected, moved and removed like a block; its fields are the shared block's, opened over the page) and is
	 * copied from the file as read; the render resolves it to the shared block.
	 */
	shared?: string;
}

export interface SiteDocument {
	kind?: 'sections';
	title: string;
	blocks: DocumentBlock[];
	/**
	 * M6 Decision 13: the page's search and sharing settings (seo.ts). Present when the
	 * file has the key (or the editor sent it); a write with it absent leaves the file's
	 * own `seo` as it is.
	 */
	seo?: Seo;
	/**
	 * M9 Decision 7: the page is hidden from the site (the file's top-level `"hidden": true`;
	 * absent means shown). Not served, not in the sitemap, not offered by the link picker; still
	 * edited, previewed and published in /admin. The editor sends `false` to unhide, which takes
	 * the key out of the file. The home page (`index`) can't be hidden (content.ts reads it as shown).
	 */
	hidden?: boolean;
	/**
	 * Collections under pages (Decision 5): the collection this page holds (the file's
	 * top-level `"holds"`, after `title` and `hidden`): its documents are at this page's
	 * address + `/` + their slug (held.ts). Edited in the file only, never by the editor,
	 * whose saves keep it where it is.
	 */
	holds?: string;
	/** Edit in context, Decision 3: the page's own header and footer picks (the file's top-level `"frame"`), absent when it picks neither. */
	frame?: Frame;
	/**
	 * M6c (G2): the page fields' parsed values, keyed by field, every field of the
	 * collection's `fields` present (the file's top-level keys after `title`). Present
	 * only when the collection has page fields; a write with it absent leaves the
	 * file's as they are.
	 */
	data?: Record<string, unknown>;
}

/**
 * A list-of-fields document (Decision 7): its title and its fields' parsed values,
 * keyed by field, every field of the collection's schema present. Keys the schema
 * doesn't know aren't here; the serializer keeps them in the file.
 */
export interface FieldsDocument {
	kind: 'fields';
	title: string;
	data: Record<string, unknown>;
	/** M6 Decision 13, as on a section builder's document. */
	seo?: Seo;
	/** Edit in context, Decision 3: as on a section builder's document. */
	frame?: Frame;
}

/**
 * Edit in context, Decision 3: a page's own picks for the slots of its frame, each a shared
 * block's path (`{ "footer": "footer-dark" }`). A slot it doesn't name gets the site's default.
 * **It rides on the document as `hidden` does:** absent from an edit, the file's is left as it
 * is; `{}` (every pick cleared) takes the key out of the file; anything else is written.
 */
export interface Frame {
	header?: string;
	footer?: string;
}

/** A file's (or a request's) `frame`, parsed: only the slots it names with a non-empty path; `{}` for anything else. */
export function parseFrame(raw: unknown): Frame {
	const o = asObject(raw);
	const out: Frame = {};
	for (const slot of ['header', 'footer'] as const) if (typeof o[slot] === 'string' && o[slot] !== '') out[slot] = o[slot] as string;
	return out;
}

/** A file's `frame` as a document carries it: present only when it picks something. */
function frameOf(raw: Record<string, unknown>): { frame?: Frame } {
	if (!Object.hasOwn(raw, 'frame')) return {};
	const frame = parseFrame(raw.frame);
	return Object.keys(frame).length ? { frame } : {};
}

/** A request's `frame`: absent leaves the file's (undefined), anything else is the picks it sends (`null` and `{}` clear). */
function frameEdit(raw: Record<string, unknown>): { frame?: Frame } {
	return Object.hasOwn(raw, 'frame') && raw.frame !== undefined ? { frame: parseFrame(raw.frame) } : {};
}

/** A shared block (Decision 8): `{ "title", "block": { "type", ...fields } }`. */
export interface SharedDocument {
	kind: 'shared';
	title: string;
	/** The block, parsed as a page's block is (`source` 0). An unknown type is kept and skipped, as on a page. */
	block: DocumentBlock;
	/**
	 * Edit in context, Decision 3: this block is its slot's default (the file's `"default": true`,
	 * beside `block`), for a slot block. Rides as `hidden` does: true adds it, false takes it out,
	 * absent leaves the file's.
	 */
	default?: boolean;
}

/** A brand slot's image (M5b Decision 11): image-only, no alt (the logo's text alternative is the brand's name). */
export interface BrandImage {
	key: string;
	w?: number;
	h?: number;
}

/** Site Settings' brand (Decision 10), as typed: `accent` may not be a colour yet (Decision 15). M5b adds the logo and icon. */
export interface SettingsBrand {
	name: string;
	accent: string;
	logo: BrandImage | null;
	icon: BrandImage | null;
}

/**
 * Site Settings (Decision 10): `data` holds `editors` (a list of strings), `brand`
 * (`{ name, accent }`) and the site's own `settings.fields`, parsed. M6 Decision 14 adds
 * `seo` (the defaults), `googleTag` and `formRecipients`, each present when the file
 * has it (or the editor sent it); a write without one leaves the file's as it is.
 */
export interface SettingsDocument {
	kind: 'settings';
	title: string;
	data: Record<string, unknown> & { editors: string[]; brand: SettingsBrand; seo?: Seo; googleTag?: string; formRecipients?: Record<string, string[]>; redirects?: Redirect[]; pageOrder?: PageOrder; pageFolders?: PageFolders; collectionOrder?: CollectionOrder };
}

/** M6: Site Settings' search and sharing keys, parsed, each only when `raw` has it. */
function settingsM6(raw: Record<string, unknown>): { seo?: Seo; googleTag?: string; formRecipients?: Record<string, string[]>; redirects?: Redirect[]; pageOrder?: PageOrder; pageFolders?: PageFolders; collectionOrder?: CollectionOrder } {
	return {
		// Pre-M7 item 8: the redirects changing an address adds (redirects.ts).
		...(Object.hasOwn(raw, 'redirects') ? { redirects: parseRedirects(raw.redirects) } : {}),
		// Arrange pages (Decision 6): the Pages tree's saved order (page-order.ts).
		...(Object.hasOwn(raw, 'pageOrder') ? { pageOrder: parsePageOrder(raw.pageOrder) } : {}),
		// Page folders: the Pages tree's editor-only folders (page-folders.ts).
		...(Object.hasOwn(raw, 'pageFolders') ? { pageFolders: parsePageFolders(raw.pageFolders) } : {}),
		// Review gaps (Decision 2): the manual collections' hand orders (collection-order.ts).
		...(Object.hasOwn(raw, 'collectionOrder') ? { collectionOrder: parseCollectionOrder(raw.collectionOrder) } : {}),
		...(Object.hasOwn(raw, 'seo') ? { seo: parseSeo(raw.seo) } : {}),
		...(Object.hasOwn(raw, 'googleTag') ? { googleTag: parseGoogleTag(raw.googleTag) } : {}),
		...(Object.hasOwn(raw, 'formRecipients') ? { formRecipients: parseFormRecipients(raw.formRecipients) } : {}),
	};
}

/** M6: a page's `seo`, parsed, only when `raw` has it. */
const seoOf = (raw: Record<string, unknown>): { seo?: Seo } => (Object.hasOwn(raw, 'seo') ? { seo: parseSeo(raw.seo) } : {});

/** Any document. */
export type AnyDocument = SiteDocument | FieldsDocument | SharedDocument | SettingsDocument;
/** What a page renders: a section builder, a fields document, or a shared block on its own (its preview). */
export type PageDocument = SiteDocument | FieldsDocument | SharedDocument;
export type DocumentKind = 'sections' | 'fields' | 'shared' | 'settings';

/** A document's kind (a SiteDocument has none, or `'sections'`). */
export function documentKind(document: AnyDocument): DocumentKind {
	return document.kind ?? 'sections';
}

const isObject = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw);
const asObject = (raw: unknown): Record<string, unknown> => (isObject(raw) ? raw : {});
const titleOf = (doc: Record<string, unknown>) => (typeof doc.title === 'string' ? doc.title : '');

/** Every field's parsed value from a raw object (a missing key parses as empty). */
export function parseFields(fields: Fields, raw: Record<string, unknown>): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(fields)) data[key] = parseField(field, raw[key]);
	return data;
}

/** A brand slot's raw value as an image (`{ key, w, h }`), or null: a clip, or anything else, is no image. */
export function parseBrandImage(raw: unknown): BrandImage | null {
	const v = parseMedia(raw);
	if (!v || !('key' in v) || isFileKey(v.key)) return null;
	const out: BrandImage = { key: v.key };
	if (v.w !== undefined) out.w = v.w;
	if (v.h !== undefined) out.h = v.h;
	return out;
}

/** Site Settings' brand from its raw value: two strings, trimmed (`''` when missing), and the logo and icon (null when unset). */
export function parseSettingsBrand(raw: unknown): SettingsBrand {
	const o = asObject(raw);
	return {
		name: typeof o.name === 'string' ? o.name.trim() : '',
		accent: typeof o.accent === 'string' ? o.accent.trim() : '',
		logo: parseBrandImage(o.logo),
		icon: parseBrandImage(o.icon),
	};
}

/** Site Settings' `editors` (Decision 10): `list(text())`, each an address or an `@domain`. */
export const EDITORS_FIELD = list(text(), { label: 'Editors' });

/** Site Settings' editors, parsed as the field reads them (blank entries kept: they're the editor's to drop). */
export function parseEditors(raw: unknown): string[] {
	return parseField(EDITORS_FIELD, raw) as string[];
}

/**
 * Any document's plain JSON value, by its collection's kind. Never throws on content:
 * a value of the wrong shape parses as empty (and is kept in the file, Decision 7).
 */
export function parseAnyDocument(raw: unknown, site: Pick<ResolvedSite, 'blocks'>, collection: Pick<ResolvedCollection, 'kind' | 'fields'>): AnyDocument {
	const doc = asObject(raw);
	switch (collection.kind) {
		case 'fields':
			return { kind: 'fields', title: titleOf(doc), data: parseFields(collection.fields ?? {}, doc), ...seoOf(doc), ...frameOf(doc) };
		case 'shared':
			return { kind: 'shared', title: titleOf(doc), block: parseBlock(doc.block, 0, site), ...(doc.default === true ? { default: true } : {}) };
		case 'settings':
			return {
				kind: 'settings',
				title: titleOf(doc),
				data: { ...parseFields(collection.fields ?? {}, doc), editors: parseEditors(doc.editors), brand: parseSettingsBrand(doc.brand), ...settingsM6(doc) },
			};
		default:
			return { ...parseDocument(raw, site), ...pageDataOf(collection, doc) };
	}
}

/** M6c (G2): a section builder's page fields parsed from `raw`, only when its collection has some. */
function pageDataOf(collection: Pick<ResolvedCollection, 'fields'>, raw: Record<string, unknown>): { data?: Record<string, unknown> } {
	return collection.fields && Object.keys(collection.fields).length ? { data: parseFields(collection.fields, raw) } : {};
}

/** Parse a document's plain JSON value. Never throws on content: odd blocks become unknown ones. */
export function parseDocument(raw: unknown, site: Pick<ResolvedSite, 'blocks'>): SiteDocument {
	const doc = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const rawBlocks = Array.isArray(doc.blocks) ? doc.blocks : [];
	return {
		title: typeof doc.title === 'string' ? doc.title : '',
		blocks: rawBlocks.map((b, index) => parseBlock(b, index, site)),
		...seoOf(doc),
		...(doc.hidden === true ? { hidden: true } : {}),
		...(typeof doc.holds === 'string' ? { holds: doc.holds } : {}),
		...frameOf(doc),
	};
}

/** Parse a content file's text. Throws JSON.parse's SyntaxError on invalid JSON. */
export function parseDocumentText(text: string, site: Pick<ResolvedSite, 'blocks'>): { source: ParsedSource; document: SiteDocument } {
	const source = parseSource(text);
	return { source, document: parseDocument(source.value, site) };
}

/**
 * `record[key]` for the record's own keys only. Block types, collections, text styles
 * and field names come from content files and requests, so a type such as
 * "constructor", "toString" or "__proto__" must read as unknown, never as Object's
 * built-ins (which would make a whole file fail to parse).
 */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function parseBlock(raw: unknown, source: number | null, site: Pick<ResolvedSite, 'blocks'>): DocumentBlock {
	const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	// A shared-block entry (Decision 8): kept, never edited here; the render resolves it.
	if (obj && typeof obj.shared === 'string') {
		const { type: _t, ...rest } = obj;
		return { source, type: typeof obj.type === 'string' ? obj.type : '', known: false, data: rest, shared: obj.shared };
	}
	const type = obj && typeof obj.type === 'string' ? obj.type : '';
	const schema = obj ? own(site.blocks, type) : undefined;
	if (!obj || !schema) {
		const { type: _type, ...rest } = obj ?? {};
		return { source, type, known: false, data: rest };
	}
	const data: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(schema.fields)) data[key] = parseField(field, obj[key]);
	return { source, type, known: true, data };
}

/**
 * Make a document that came from outside (the editor's POST to the preview route)
 * safe to render: every known block's fields re-parsed by their schema, so a value
 * of the wrong shape renders as empty instead of throwing. Sources are kept.
 */
export function normaliseDocument(input: unknown, site: Pick<ResolvedSite, 'blocks'>): SiteDocument {
	const doc = input && typeof input === 'object' ? (input as Partial<SiteDocument>) : {};
	const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
	return {
		title: typeof doc.title === 'string' ? doc.title : '',
		blocks: blocks.map((b): DocumentBlock => {
			const block = b && typeof b === 'object' ? (b as Partial<DocumentBlock>) : {};
			const source = typeof block.source === 'number' ? block.source : null;
			const type = typeof block.type === 'string' ? block.type : '';
			const data = block.data && typeof block.data === 'object' ? block.data : {};
			// A shared entry: `shared` on the block, or (from an editor that keeps only source, type, known and data) in its raw keys.
			const shared = typeof block.shared === 'string' ? block.shared : block.known !== true && typeof data.shared === 'string' ? data.shared : undefined;
			if (shared !== undefined) return { source, type, known: false, data, shared };
			const schema = own(site.blocks, type);
			if (!schema) return { source, type, known: false, data };
			const parsed: Record<string, unknown> = {};
			for (const [key, field] of Object.entries(schema.fields)) parsed[key] = parseField(field, data[key]);
			return { source, type, known: true, data: parsed };
		}),
		...seoOf(asObject(input)),
		// M9 Decision 7: true hides, false unhides, absent leaves the file's as it is.
		...(typeof doc.hidden === 'boolean' ? { hidden: doc.hidden } : {}),
		// Edit in context, Decision 3: the same for the page's picks.
		...frameEdit(asObject(input)),
	};
}

/**
 * Any document that came from outside (the editor's POST to the preview or write
 * route), made safe by its collection's kind: every field re-parsed by its schema.
 * A shape that doesn't match the collection's kind reads as an empty one of that kind.
 */
export function normaliseAnyDocument(input: unknown, site: Pick<ResolvedSite, 'blocks'>, collection: Pick<ResolvedCollection, 'kind' | 'fields'>): AnyDocument {
	const doc = asObject(input);
	switch (collection.kind) {
		case 'fields':
			return { kind: 'fields', title: titleOf(doc), data: parseFields(collection.fields ?? {}, asObject(doc.data)), ...seoOf(doc), ...frameEdit(doc) };
		case 'shared': {
			const [block] = normaliseDocument({ blocks: [doc.block ?? {}] }, site).blocks;
			return { kind: 'shared', title: titleOf(doc), block: { ...block!, source: 0 }, ...(typeof doc.default === 'boolean' ? { default: doc.default } : {}) };
		}
		case 'settings': {
			const data = asObject(doc.data);
			return {
				kind: 'settings',
				title: titleOf(doc),
				data: { ...parseFields(collection.fields ?? {}, data), editors: parseEditors(data.editors), brand: parseSettingsBrand(data.brand), ...settingsM6(data) },
			};
		}
		default:
			// `data` absent (or not an object) means "leave the file's page fields as they are"
			// (SiteDocument.data): parsing an empty object would write every field's default.
			return { ...normaliseDocument(input, site), ...(isObject(doc.data) ? pageDataOf(collection, doc.data) : {}) };
	}
}

/**
 * The shared block a block-list entry names (Decision 8), or undefined: `shared` on
 * the block, or, for a block the editor holds as `{ source, type, known, data }`, the
 * `shared` key among its raw keys.
 */
export function sharedEntryOf(block: Pick<DocumentBlock, 'known' | 'data' | 'shared'>): string | undefined {
	if (typeof block.shared === 'string') return block.shared;
	return !block.known && typeof block.data?.shared === 'string' ? block.data.shared : undefined;
}

/** A new block of a type, with every field empty (its parsed default). For the editor's picker. */
export function emptyBlock(type: string, site: Pick<ResolvedSite, 'blocks'>): DocumentBlock {
	return parseBlock({ type }, null, site);
}

// ── Rendering contract ────────────────────────────────────────────────────────

/** A document another component reads through the render context (Decision 9). */
export interface ReadEntry {
	collection: string;
	path: string;
	/** Its page's URL, or null (a shared block, Site Settings). */
	url: string | null;
	title: string;
	document: AnyDocument;
	/**
	 * A fields document's (or Site Settings') render data: each field as a component
	 * gets it (fields.ts → renderData; a reference to a document that doesn't exist is
	 * null). For a section builder with page fields (M6c G2), those fields' render data
	 * (a game's tile details, read by a block on another page). Empty otherwise.
	 */
	data: Record<string, unknown>;
}

/**
 * Read access to the site's other documents from a render (M5a Decision 9), **from
 * the source the page itself is rendered from**: the disk at build (`main` as
 * deployed), and in a preview the editor's store with autosaves on top. The same
 * parsing either way. Documents that can't be opened (invalid JSON, no title) aren't
 * there.
 */
export interface DocumentReader {
	/** One document by collection and path, or null when it doesn't exist (or can't be opened). */
	document(collection: string, path: string): Promise<ReadEntry | null>;
	/** A collection's documents in the editor's order (a flat collection: alphabetical by title). */
	documents(collection: string): Promise<ReadEntry[]>;
	/** Whether a document exists (and opens): what a reference's render checks. */
	exists(collection: string, path: unknown): Promise<boolean>;
	/**
	 * Review gaps (Decision 13): a form's words as they resolve from this source's Site Settings
	 * (read.ts → readFormWords), behind `cms.formWords`. Absent on a reader that can't read them.
	 */
	formWords?(form: string, code?: FormCodeWords): Promise<FormWords | null>;
}

/**
 * What the Blocks loop gives each block component, beside its data. Built per
 * render from the document (never module state, so concurrent preview renders
 * can't leak into each other: M3 → Watch-outs).
 */
/** M9 Decision 9: `<Blocks wrap>`'s rule and its runs, for a site's page component (`import type { WrapBlocks } from 'caracms/document'`). */
export type { BlockRun, WrapBlock, WrapBlocks } from './block-runs.ts';

export interface BlockContext {
	/**
	 * The block's position in the document being rendered: the editor's block index (0 for a
	 * fields document's or a shared block's own render). It counts every entry in the file's
	 * `blocks`, rendered or not, so `index === 0` isn't "the first block on the page" when the
	 * first entry doesn't render (an unknown type, a shared block that's gone): use `first`.
	 */
	index: number;
	/**
	 * An adoption trial, item 2: this is the first block the page renders (unknown blocks and shared
	 * entries that don't resolve are skipped; a shared block counts where it's placed). A fields
	 * document's render, and a shared block's own preview, are always first. Its page's other
	 * blocks are never told about it: anything page-wide goes through the page component.
	 */
	first: boolean;
	/** The block's type; for a fields document's render, its collection's name. */
	type: string;
	/**
	 * A preview render (Decision 17): only then do the package's components emit
	 * `data-cms-*` markers and make plain text fields `contenteditable`.
	 */
	preview: boolean;
	/**
	 * The key of this block's field that holds the page's `h1` (Decision 16), or
	 * null. Set on the first block, in render order, with a non-empty heading.
	 * The package's Lockup and Text use it; `headingTag()` reads it for a block's own markup.
	 */
	h1Field: string | null;
	/**
	 * A fields document's render (M5a Decision 7): its collection's name. The package's
	 * components then find a field's descriptor in the collection's fields, and the
	 * root's marker is `data-cms-document` in place of `data-cms-block` (Decision 16).
	 * Null for a block.
	 */
	collection?: string | null;
	/**
	 * A shared block rendered on a page through a `{ "shared": … }` entry (Decision 8).
	 * In a preview its root is the page's block (`data-cms-block`, `data-cms-shared`: selected,
	 * moved and removed there), and its fields carry the shared block's source marker
	 * (`source` is `{ collection: 'shared', path }`), so a click on them opens it over the page.
	 * Null otherwise.
	 */
	shared?: { name: string; preview: boolean } | null;
	/**
	 * Heading ids (heading-ids.ts): this block's rich-text fields' `h2`/`h3` ids, by field path
	 * (`body`, `items.0.body`), numbered across the whole page. Blocks.astro sets it; RichText
	 * reads its own. Absent: its headings render without ids (page fields, Site Settings, slots).
	 */
	headingIds?: Readonly<Record<string, readonly string[]>> | null;
	/** Read the site's other documents (Decision 9): the case-study list reads its collection here. */
	read: DocumentReader;
	/**
	 * Posts and tags, Decision 12: the page of a paged listing this render is (1, 2, …), as the
	 * route passes it to RenderDocument. 1 for every page that isn't paged, and always 1 in a preview.
	 */
	listPage: number;
	/**
	 * M5b Decision 4's loading rule: the block is one of the first two *rendered* blocks
	 * (unknown and skipped ones don't count), so its images load eagerly. A fields
	 * document's render is its page's first. Absent: lazy.
	 */
	eager?: boolean;
	/**
	 * The path of the one image that gets `fetchpriority="high"`: the first image of the
	 * first rendered block (fields.ts → firstImagePath), or a fields document's first
	 * (its cover). Null on every other block.
	 */
	priority?: string | null;
	/**
	 * Edit in context, Contracts → a source context: the document this context's fields belong to
	 * when it isn't the one being edited. `{ collection: 'settings' }` for Site Settings,
	 * `{ collection: 'shared', path }` for a shared block (a slot's, Decision 2, or one placed in a
	 * page's body, beside `shared`), `{ collection, path }` for an entry a block read (`cms.of(entry)`).
	 * Its field paths resolve against that document's fields (descriptor.ts → fieldsOf), and in a
	 * preview every field component marks its fields with `data-cms-source`, and `<Block>` its root
	 * (never `data-cms-block` or `data-cms-document`); a placed shared block's root is the page's
	 * block instead (`shared`).
	 * Null or absent for a block's own context.
	 */
	source?: { collection: string; path?: string } | null;
	/**
	 * Edit in context, Decisions 10a and 10b: the page's own context (`PageProps.cms`), whose fields
	 * are its collection's page `fields`: `{ collection, path }`, `path` being the document's path in
	 * its collection when the render knows it (a preview's), else null. It marks only on a section
	 * builder's document (`preview` is false on any other): its roots carry `data-cms-page`, never
	 * `data-cms-block` or `data-cms-document`. Null or absent on every other context.
	 */
	page?: { collection: string; path: string | null } | null;
	/**
	 * Edit in context, Contracts → Slots: on a slot's block (`<Slot>`), the address of the page it's
	 * drawn on (PageProps.path), for a header's current-page mark; null on the block's own preview.
	 * Absent on every other context.
	 */
	path?: string | null;
	/**
	 * Edit in context, Decision 10: Site Settings' context, in every render, so a block can mark the
	 * Site Settings fields it shows (`<Text cms={cms.settings} field="contact.phone" …>`); its values
	 * come from `siteSettings()` or the page component's `settings`. Markers only in a preview.
	 */
	settings: BlockContext;
	/**
	 * Edit in context, Decision 10: the context of an entry this block read through `cms.read`
	 * (`cms.of(caseStudy)`), so a card can mark itself, and the fields it shows, as that entry's.
	 */
	of(entry: ReadEntry): BlockContext;
	/**
	 * Review gaps (Decision 8): the state the editor's switch chose for this block (one of its
	 * config's `states` keys), so the component draws that state's markup on the server. Null on
	 * every other block, and on the public page, in a build and in a preview that asked for none.
	 */
	state: string | null;
	/**
	 * Review gaps (Decision 13): a form's words, resolved (Site Settings, then `defaults`, the site
	 * code's, then the config's, then the package's), each with the Site Settings field that holds
	 * it, for a site that draws its own form markup:
	 *
	 *   const words = await cms.formWords('contact');
	 *   <Text cms={cms.settings} field={words.fields.name.label.field} value={words.fields.name.label.value} as="span" />
	 *
	 * Null for a form the config doesn't have. Read from the render's source, as `cms.read` is.
	 */
	formWords(form: string, defaults?: FormCodeWords): Promise<FormWords | null>;
	/**
	 * Vivid (the config's `vivid`, vivid.ts): the document this context's fields are stored in and the
	 * path to them in its file (`blocks.2.` for a section builder's block, `block.` for a shared
	 * block's, '' otherwise), which the package's field components put in `data-vivid-field` and
	 * `data-vivid-edit`. Only on a public render with the switch on; null or absent otherwise (every
	 * preview), so they add nothing. A document built in code (the 404's) has none for its own fields.
	 */
	vivid?: VividDoc | null;
}

/**
 * Review gaps (Decision 8): the state a block at `index` of type `type` draws, given the state the
 * render was asked for (read.ts → renderStateOf): its name when it's this block and the block
 * declares it, else null (an unknown block or key renders with no state, Contracts → Preview).
 */
export function stateOf(site: Pick<ResolvedSite, 'blocks'>, type: string, chosen: { block: number; name: string } | null, index: number): string | null {
	if (!chosen || chosen.block !== index) return null;
	const states = own(site.blocks, type)?.states;
	return states && Object.hasOwn(states, chosen.name) ? chosen.name : null;
}

/** A source context's `data-cms-source`: `settings`, `shared/<path>`, `<collection>/<path>`. */
export function sourceKey(source: { collection: string; path?: string }): string {
	return source.collection === 'settings' || source.path === undefined ? source.collection : `${source.collection}/${source.path}`;
}

/** What every context of one render shares, to make the source contexts from. */
export interface RenderBase {
	/** Whether this render is a preview. */
	preview: boolean;
	read: DocumentReader;
	listPage: number;
	/** Vivid (vivid.ts): whether this render's contexts carry their documents (a public render with the config's `vivid` on). */
	vivid?: boolean;
}

/** A context's `settings` and `of`, given the render it's in (`settings` null: the context is Site Settings' own). Mutates and returns `cms`. */
export function withSources<T extends Omit<BlockContext, 'settings' | 'of' | 'state' | 'formWords'> & { state?: string | null }>(cms: T, render: RenderBase, settings: BlockContext | null): T & Pick<BlockContext, 'settings' | 'of' | 'state' | 'formWords'> {
	const out = cms as T & Pick<BlockContext, 'settings' | 'of' | 'state' | 'formWords'>;
	// Review gaps (Decision 13): through the reader the context has when it's called (Blocks.astro may give it one afterwards).
	out.formWords = (form, defaults) => out.read.formWords?.(form, defaults) ?? Promise.resolve(null);
	// Review gaps (Decision 8): no state unless the render gives this block one (stateOf).
	out.state = cms.state ?? null;
	out.settings = settings ?? (out as unknown as BlockContext);
	// `of` reads `out.read` when called, so a reader Blocks.astro gives the block afterwards is the entry's too.
	out.of = (entry: ReadEntry) => sourceContext(out, render, entry);
	return out;
}

/** An entry's context, from a block's (`cms.of(entry)`). */
function sourceContext(parent: BlockContext, render: RenderBase, entry: ReadEntry): BlockContext {
	const type = entry.document.kind === 'shared' ? (entry.document as SharedDocument).block.type : entry.collection;
	const source = entry.collection === 'settings' ? { collection: 'settings' } : { collection: entry.collection, path: entry.path };
	const vivid = render.vivid ? vividEntry(entry) : null;
	return withSources(
		{ index: parent.index, first: false, type, preview: render.preview, h1Field: null, collection: null, shared: null, source, read: parent.read, listPage: parent.listPage, eager: parent.eager, priority: null, vivid },
		{ ...render, read: parent.read },
		parent.settings,
	);
}

/** Edit in context, Decision 10: Site Settings' context for one render (PageProps.settingsCms, every block's `cms.settings`). */
export function settingsContext(preview: boolean, read: DocumentReader, listPage = 1, vivid = false): BlockContext {
	const render = { preview, read, listPage, vivid };
	return withSources({ index: 0, first: false, type: 'settings', preview, h1Field: null, collection: null, shared: null, source: { collection: 'settings' }, read, listPage, vivid: vivid ? VIVID_SETTINGS : null }, render, null);
}

/**
 * Edit in context, Decisions 10a and 10b: the page's own context (PageProps.cms). It marks only on
 * a section builder's document in a preview, so a fields document's page (whose own context is its
 * component's, Blocks.astro) and a shared block's own preview never get a second root.
 */
export function pageContext(collection: string, path: string | null, document: AnyDocument, preview: boolean, read: DocumentReader, settings: BlockContext, listPage = 1, vivid: { ref: DocumentRef | null } | null = null): BlockContext {
	const marks = preview && documentKind(document) === 'sections';
	// Vivid: a section builder's page fields sit at its file's top level, as a fields document's do.
	const stored = vivid?.ref ? { collection: vivid.ref.collection, path: vivid.ref.path, prefix: '' } : null;
	return withSources(
		{ index: 0, first: false, type: collection, preview: marks, h1Field: null, collection: null, shared: null, page: { collection, path }, read, listPage, vivid: stored },
		{ preview, read, listPage, vivid: !!vivid },
		settings,
	);
}

/**
 * Edit in context, Contracts → Slots: the context of the shared block a slot draws (`<Slot>`):
 * that shared block's source context, with the page's address as `path`. A header loads its
 * images eagerly; nothing in a slot holds the page's `h1` or the high-priority image.
 */
export function slotContext(slot: 'header' | 'footer', shared: { path: string; type: string }, address: string | null, preview: boolean, read: DocumentReader, settings: BlockContext, listPage = 1, vivid = false): BlockContext {
	return withSources(
		{ index: 0, first: false, type: shared.type, preview, h1Field: null, collection: null, shared: null, source: { collection: 'shared', path: shared.path }, path: address, read, listPage, eager: slot === 'header', priority: null, vivid: vivid ? vividShared(shared.path) : null },
		{ preview, read, listPage, vivid },
		settings,
	);
}

/** Props of a block component: `const { block, cms } = Astro.props as BlockProps<…>`. */
export interface BlockProps<D = Record<string, unknown>> {
	block: D;
	cms: BlockContext;
}

/**
 * Props of a fields collection's component (Decision 7): `document` is the
 * document's render data (each field as fields.ts → renderData gives it, a missing
 * reference as null) plus its `title`; `cms` is its render context, as a block's.
 */
export interface FieldsDocumentProps<D = Record<string, unknown>> {
	document: D & { title: string };
	cms: BlockContext;
}

/** Props of the site's page component. */
export interface PageProps {
	/** The document: a section builder's, a fields document's, or a shared block alone (its own preview, Decision 8). */
	document: PageDocument;
	/** The collection the document belongs to. */
	collection: string;
	/**
	 * An adoption trial, item 2: the document's address on the site (`/`, `/about`, `/work/high-street-coffee`),
	 * the same in a public render and in the editor's preview, so the page component never reads
	 * `Astro.url` or `?path=` itself. No trailing slash, not URL-encoded; a paged listing's page 2
	 * (`/journal/page/2`) is its document's `/journal` (`listPage` says which page). Null when the
	 * document has no page of its own: a shared block's preview, a collection without pages.
	 * RenderDocument always gives it (head.ts → documentPath).
	 */
	path: string | null;
	/** A preview render (Decision 17). Pass it on to `<Blocks>`. */
	preview?: boolean;
	/**
	 * M6c (G2): the document's own fields' render data, as a component gets them
	 * (fields.ts → renderData, a reference to a missing document as null): a section
	 * builder's page fields (the header's "side" picked on the page), or a fields
	 * document's fields. Empty for a shared block and for a section builder with no page
	 * fields. RenderDocument always gives it.
	 */
	data: Record<string, unknown>;
	/**
	 * M7 Decision 13: Site Settings' render data, for the page's shell (its menu, its footer):
	 * the site's own `settings: { fields }` as a block's are rendered (links as render values,
	 * media resolved, a reference to a missing document as null), plus `brand` (`name`, `logo`,
	 * `icon`) and `seo` (`title`, `description`, `image`, and the config's `titleSeparator`). `brand.name` is the site's name (the
	 * brand's, else the default search title, else "Site"). Read from the render's source, so a
	 * preview shows the draft's and a build the published. Never undefined; never `editors`,
	 * `formRecipients` or `googleTag`. RenderDocument always gives it (read.ts → settingsRenderData).
	 */
	settings: Record<string, unknown>;
	/**
	 * Posts and tags, Decision 12: the page of a paged listing this render is (1 by default, always 1
	 * in a preview). Pass it on to `<Blocks>` and `<Head>`, so a paged block shows its page and the
	 * title says " — page N".
	 */
	listPage: number;
	/**
	 * Posts and tags, Decision 12: the site's other documents, read from the render's source, the
	 * same reader a block's `cms.read` is (a post's page finds its neighbours here).
	 */
	read: DocumentReader;
	/**
	 * Edit in context, Decisions 10a and 10b: the document's own context, for the page fields the
	 * page component draws itself (a case study hero's question and photo), used with the package's
	 * field components as a block's `cms` is: `<Block cms={cms} as="header"><Text cms={cms}
	 * field="question" value={data.question} /></Block>`. Marks only a section builder's document,
	 * in a preview (document.ts → pageContext). RenderDocument always gives it.
	 */
	cms: BlockContext;
	/**
	 * Edit in context, Decision 10: Site Settings' context, for the Site Settings fields the page
	 * component draws itself (beside `settings`, their values). Markers only in a preview.
	 * RenderDocument always gives it.
	 */
	settingsCms: BlockContext;
}

/** `h1` if this field holds the page's first heading, otherwise `h2`. */
export function headingTag(cms: BlockContext, field: string): 'h1' | 'h2' {
	return cms.h1Field === field ? 'h1' : 'h2';
}

/** Is a field one that can hold the page's heading (Decision 16): a lockup, or a text or rich-text field (M9 Decision 11) marked `heading`? */
export const isHeadingField = (field: Field): boolean => (field.kind === 'lockup' || field.kind === 'text' || field.kind === 'richText') && !!field.heading;

/**
 * Decision 16: the index of the first block, in render order (skipping unknown
 * blocks), whose heading field is non-empty; -1 if none. A shared entry counts by
 * the block it resolves to, when the caller gives them (`resolved`, by index).
 */
export function firstHeadingIndex(document: SiteDocument, site: Pick<ResolvedSite, 'blocks'>, resolved: ReadonlyMap<number, DocumentBlock> = new Map()): number {
	return document.blocks.findIndex((entry, index) => {
		const block = resolved.get(index) ?? entry;
		if (!block.known) return false;
		const schema = own(site.blocks, block.type);
		if (!schema?.headingField) return false;
		// The heading field may sit in a group (`left.heading`).
		const field = fieldAtPath(schema.fields, schema.headingField)?.field;
		return !!field && !isEmptyValue(field, getAtPath(block.data, schema.headingField) as FieldValue<Field>);
	});
}

/**
 * The render context for every block of a document, in order (null for unknown
 * blocks, which don't render). `resolved` gives a shared entry's block by its index
 * (Blocks.astro resolves them through `read`); an entry without one doesn't render.
 */
export function blockContexts(
	document: SiteDocument,
	site: Pick<ResolvedSite, 'blocks'>,
	preview: boolean,
	read: DocumentReader = EMPTY_READER,
	resolved: ReadonlyMap<number, DocumentBlock> = new Map(),
	listPage = 1,
	settings: BlockContext = settingsContext(preview, read, listPage),
	vivid: { ref: DocumentRef | null } | null = null,
): (BlockContext | null)[] {
	const first = firstHeadingIndex(document, site, resolved);
	const render = { preview, read, listPage, vivid: !!vivid };
	// Vivid: a block's fields sit at `blocks.<index>.` in its document's file; a shared entry's in the shared block's own.
	const stored = (index: number, entry: DocumentBlock): VividDoc | null => {
		if (!vivid) return null;
		if (entry.shared !== undefined) return vividShared(entry.shared);
		return vivid.ref ? { collection: vivid.ref.collection, path: vivid.ref.path, prefix: `blocks.${index}.` } : null;
	};
	let rendered = 0;
	return document.blocks.map((entry, index) => {
		const block = resolved.get(index) ?? entry;
		if (!block.known) return null;
		const schema = own(site.blocks, block.type)!;
		const h1Field = index === first ? schema.headingField : null;
		const order = rendered++;
		const media = { first: order === 0, eager: order < 2, priority: order === 0 ? firstImagePath(schema.fields, block.data) : null };
		// A placed shared block's fields are the shared block's, marked as its source (`shared/<path>`, as a card's
		// `cms.of(entry)`): its root stays the page's block, and a click on its words opens it over the page.
		if (entry.shared !== undefined) return withSources({ index, type: block.type, preview, h1Field, collection: null, shared: { name: entry.shared, preview }, source: { collection: 'shared', path: entry.shared }, read, listPage, ...media, vivid: stored(index, entry) }, render, settings);
		return withSources({ index, type: block.type, preview, h1Field, collection: null, shared: null, read, listPage, ...media, vivid: stored(index, entry) }, render, settings);
	});
}

/**
 * A fields document's heading field (Decision 7): the first heading field with a
 * non-empty value, top-level ones in schema order first, then those inside groups
 * (`left.heading`, fields.ts → headingPaths), or null (the page has no `h1`, as M3
 * accepted). One path at most, so two groups' headings never make two h1s.
 */
export function fieldsHeading(fields: Fields, data: Record<string, unknown>): string | null {
	for (const path of headingPaths(fields)) {
		const field = fieldAtPath(fields, path)?.field;
		if (field && !isEmptyValue(field, getAtPath(data, path) as FieldValue<Field>)) return path;
	}
	return null;
}

/** A reader with nothing in it (a render with no source: tests, and the default). */
export const EMPTY_READER: DocumentReader = {
	document: async () => null,
	documents: async () => [],
	exists: async () => false,
};
