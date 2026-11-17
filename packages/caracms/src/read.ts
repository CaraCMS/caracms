/**
 * The render's read access to other documents (M5a Decision 9), and what a render
 * needs to resolve: shared-block entries (Decision 8) and references (Decision 6).
 *
 * - **One source per render.** `documentReader(site, source)` reads through a
 *   content.ts ContentSource: the disk at build (`main` as deployed), and in a
 *   preview the editor's store with autosaves on top (the preview route hands its
 *   store's source to the render through `Astro.locals`: `setRenderSource`). So a
 *   preview never shows what the public page wouldn't once published, and both read
 *   through the same parsing (content.ts).
 * - **Per render, never module state:** a reader caches what it read for its own
 *   render only, so a list block and a reference reading one collection read it once.
 *   The exception is a production build on the disk source, where every reader shares
 *   one cache (posts and tags, Decision 15: `shareBuildReads`).
 * - **A reference to a document that doesn't exist reaches the component as `null`**
 *   (Decision 6), in a list of references too (`[null, "tiny-publisher"]` keeps the
 *   editor's indexes). `resolveRefs` does it, for a block's data and a fields
 *   document's alike.
 *
 * Server-only (it reads files through content.ts).
 */
import { join } from 'node:path';
import { DEFAULT_TITLE_SEPARATOR, type ResolvedSite } from './config.ts';
import { DocumentError, diskSource, listDocuments, readDocument, type ContentSource } from './content.ts';
import { own, parseFields, parseSettingsBrand, settingsContext, type BlockContext, type DocumentBlock, type DocumentReader, type ReadEntry, type SharedDocument } from './document.ts';
import { renderData, type Field, type Fields } from './fields.ts';
import { renderMedia } from './media-value.ts';
import { SITE_SETTINGS_FILE } from './reserved.ts';
import { parseSeo } from './seo.ts';
import { FORM_WORDS_KEY, resolveFormWords, storedWordsOf, type FormCodeWords, type FormWords } from './forms/words.ts';
import { readFormSources } from './forms/sources.ts';

type Site = Pick<ResolvedSite, 'root' | 'collections' | 'blocks'> & Partial<Pick<ResolvedSite, 'titleSeparator' | 'forms'>>;

const SOURCE = '__caracms_render_source';

/** The preview route's source for this request's render (Decision 9). The build sets none: the disk. */
export function setRenderSource(locals: object, source: ContentSource): void {
	(locals as Record<string, unknown>)[SOURCE] = source;
}

/** The source this request's render reads other documents from: the preview's store, else the disk. */
export function renderSourceOf(locals: object | undefined): ContentSource {
	return ((locals as Record<string, unknown> | undefined)?.[SOURCE] as ContentSource | undefined) ?? diskSource;
}

/**
 * Review gaps (Decision 8, Contracts → Preview): the block state a preview asked for, `{ block, name }`,
 * `block` being the index among the previewed document's own blocks (0 for a shared block's own
 * render). The preview route sets it; Blocks.astro and Slot.astro give it to that block as
 * `cms.state` when the block declares the state (document.ts → stateOf). A public render, a build
 * and `caracms audit` set none.
 */
export interface RenderState {
	block: number;
	name: string;
}

const STATE = '__caracms_render_state';

/** The preview route: the block state this request's render draws. */
export function setRenderState(locals: object, state: RenderState | null): void {
	(locals as Record<string, unknown>)[STATE] = state;
}

/** The block state this request's render draws, or null (no preview asked for one). */
export function renderStateOf(locals: object | undefined): RenderState | null {
	return ((locals as Record<string, unknown> | undefined)?.[STATE] as RenderState | null | undefined) ?? null;
}

/**
 * Edit in context, Contracts → the read record: what each block of a preview render read through
 * its `cms.read`, keyed by block index. `lists` is each collection listed with `documents()` and how
 * many it returned; `documents` is each `<collection>/<path>` read alone with `document()` (found).
 * The preview route starts one for its render (`startReadRecord`); Blocks.astro gives each block a
 * reader that writes to it (`recordingReader`); the editor middleware appends it to the page
 * (`readRecordScript`). Never in a public render.
 */
export type ReadRecord = Record<string, { lists: Record<string, number>; documents: string[] }>;

const READS = '__caracms_read_record';

/** Start this request's read record (the preview route, before its render). */
export function startReadRecord(locals: object): void {
	(locals as Record<string, unknown>)[READS] = {} as ReadRecord;
}

/** This request's read record, or undefined when nothing started one (a public render). */
export function readRecordOf(locals: object | undefined): ReadRecord | undefined {
	return (locals as Record<string, unknown> | undefined)?.[READS] as ReadRecord | undefined;
}

/** A block's reader: `reader`, with what it returns written to `record` under the block's index. */
export function recordingReader(reader: DocumentReader, record: ReadRecord, index: number): DocumentReader {
	const entry = () => (record[String(index)] ??= { lists: {}, documents: [] });
	return {
		async document(collection, path) {
			const found = await reader.document(collection, path);
			if (found) {
				const key = `${collection}/${path}`;
				const reads = entry().documents;
				if (!reads.includes(key)) reads.push(key);
			}
			return found;
		},
		async documents(collection) {
			const found = await reader.documents(collection);
			entry().lists[collection] = found.length;
			return found;
		},
		exists: (collection, path) => reader.exists(collection, path),
		...(reader.formWords ? { formWords: reader.formWords } : {}),
	};
}

/** The record as the page carries it, before `</body>`: `<script type="application/json" id="cms-reads">…</script>`. */
export function readRecordScript(record: ReadRecord): string {
	// `<` escaped, so no `</script>` in a document's path can end it early.
	return `<script type="application/json" id="cms-reads">${JSON.stringify(record).replace(/</g, '\\u003c')}</script>`;
}

/**
 * Edit in context, Contracts → rendering a page with a document over it: `source` with one
 * document's file read as `text` (the opened document's unkept copy, written as a save would
 * write it), for one render only. Everything that reads through the render's source sees it:
 * `cms.read`, the slot component, `siteSettings()` and the page component's `settings`. Nothing is
 * written anywhere: the drafts store never sees it.
 */
export function overlaySource(source: ContentSource, file: string, text: string): ContentSource {
	return {
		readText: (f) => (f === file ? Promise.resolve(text) : source.readText(f)),
		listJson: (dir, recursive) => source.listJson(dir, recursive),
	};
}

/**
 * Decision 15 (posts and tags): a production build reads each document once. The integration
 * turns this on for `astro build` only (`astro:build:start`, off again at `astro:build:done`),
 * on globalThis because the build's prerender runs a bundled copy of this module. Never in
 * `astro dev`, where the disk-mode editor writes files between requests.
 */
const BUILD_READS = Symbol.for('caracms.buildReads');

interface ReadCaches {
	/** The source the reader reads through: in a build, the disk with each file's text and each folder's listing read once. */
	source: ContentSource;
	reads: Map<string, Promise<Awaited<ReturnType<typeof readDocument>> | null>>;
	entries: Map<string, Promise<ReadEntry | null>>;
	lists: Map<string, Promise<ReadEntry[]>>;
}

const newCaches = (source: ContentSource): ReadCaches => ({ source, reads: new Map(), entries: new Map(), lists: new Map() });

/** A source that reads each file and lists each folder once (a listing and a document read the same file). */
function onceSource(source: ContentSource): ContentSource {
	const texts = new Map<string, Promise<string | null>>();
	const lists = new Map<string, Promise<string[]>>();
	const once = <T>(map: Map<string, Promise<T>>, key: string, read: () => Promise<T>) => {
		let found = map.get(key);
		if (!found) map.set(key, (found = read()));
		return found;
	};
	return {
		readText: (file) => once(texts, file, () => source.readText(file)),
		listJson: (dir, recursive) => once(lists, `${recursive}\0${dir}`, () => source.listJson(dir, recursive)),
	};
}

/** Share the disk's reads across every reader (on), or stop and forget them (off). Called by the integration's build hooks, and by tests. */
export function shareBuildReads(on: boolean): void {
	const g = globalThis as Record<symbol, unknown>;
	if (on) g[BUILD_READS] = new Map<string, ReadCaches>();
	else delete g[BUILD_READS];
}

/** The caches a reader uses: per site, shared across readers during a build on the disk source; else its own. */
function cachesFor(site: Site, source: ContentSource): ReadCaches {
	const shared = (globalThis as Record<symbol, unknown>)[BUILD_READS] as Map<string, ReadCaches> | undefined;
	if (!shared || source !== diskSource) return newCaches(source);
	let caches = shared.get(site.root);
	if (!caches) shared.set(site.root, (caches = newCaches(onceSource(diskSource))));
	return caches;
}

/**
 * A reader over one source. Documents that can't be opened read as missing. Its reads are its
 * own render's, except in a production build on the disk source, where every reader shares them
 * (Decision 15: the disk doesn't change during a build).
 */
export function documentReader(site: Site, source: ContentSource): DocumentReader {
	const caches = cachesFor(site, source);
	const { reads, entries, lists } = caches;
	source = caches.source;

	/** The document as read, cached; no references resolved, so nothing here waits on another document. */
	const raw = (collection: string, path: string) => {
		const key = `${collection}\0${path}`;
		let found = reads.get(key);
		if (!found) {
			found = readDocument(site, collection, path, source).catch((error: unknown) => {
				if (error instanceof DocumentError) return null;
				throw error;
			});
			reads.set(key, found);
		}
		return found;
	};
	const exists = async (collection: string, path: unknown) =>
		typeof path === 'string' && path !== '' && !!own(site.collections, collection) && (await raw(collection, path)) !== null;

	const reader: DocumentReader = {
		document(collection, path) {
			if (!own(site.collections, collection) || typeof path !== 'string' || path === '') return Promise.resolve(null);
			const key = `${collection}\0${path}`;
			let found = entries.get(key);
			if (!found) {
				found = raw(collection, path).then(async (read) => {
					if (!read) return null;
					const fields = own(site.collections, collection)!.fields ?? {};
					// A fields document's fields; a section builder's page fields (M6c G2), when it has them.
					const values = read.document.kind === 'fields' ? read.document.data : read.document.kind === undefined || read.document.kind === 'sections' ? read.document.data : undefined;
					const data = values ? await resolveRefs(fields, renderData(fields, values), exists) : {};
					return { collection, path, url: read.entry.url, title: read.entry.title, document: read.document, data };
				});
				entries.set(key, found);
			}
			return found;
		},
		documents(collection) {
			if (!own(site.collections, collection)) return Promise.resolve([]);
			let found = lists.get(collection);
			if (!found) {
				found = listDocuments(site, collection, source).then(async (listed) => {
					// M9 Decision 7: a hidden page isn't on the site, so a listing of its collection leaves it out.
					const read = await Promise.all(listed.filter((e) => !e.warning && !e.hidden).map((e) => reader.document(collection, e.path)));
					return read.filter((r): r is ReadEntry => r !== null);
				});
				lists.set(collection, found);
			}
			return found;
		},
		exists: (collection, path) => exists(collection, path),
		formWords: (form, code) => readFormWords(site, source, form, code, reader),
	};
	return reader;
}

/**
 * Decision 14 (posts and tags): a route's reader on the disk, as `cms.read` gives a block, so
 * `getStaticPaths` can count and filter documents by their fields. Shared across a production
 * build, as every disk reader is. Exported from `caracms/content`.
 */
export function contentReader(site: Site): DocumentReader {
	return documentReader(site, diskSource);
}

type Exists = (collection: string, path: unknown) => Promise<boolean>;

/** A field's render value with references resolved: a missing one is null (Decision 6). */
async function resolveValue(field: Field, value: unknown, exists: Exists): Promise<unknown> {
	if (field.kind === 'reference') return (await exists(field.to, value)) ? value : null;
	if (field.kind === 'list' && Array.isArray(value)) {
		if (field.item) {
			const item = field.item;
			return Promise.all(value.map((v) => resolveValue(item, v, exists)));
		}
		const fields = field.fields ?? {};
		return Promise.all(value.map((v) => (v && typeof v === 'object' ? resolveRefs(fields, v as Record<string, unknown>, exists) : v)));
	}
	if (field.kind === 'group' && value && typeof value === 'object' && !Array.isArray(value)) return resolveRefs(field.fields, value as Record<string, unknown>, exists);
	return value;
}

/** Data with every reference to a missing document as null (Decision 6). */
export async function resolveRefs(fields: Fields, data: Record<string, unknown>, exists: Exists): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = { ...data };
	for (const [key, field] of Object.entries(fields)) if (Object.hasOwn(data, key)) out[key] = await resolveValue(field, data[key], exists);
	return out;
}

/** A block's or a fields document's parsed data as its component gets it: renderData, with missing references as null. */
export function renderFields(fields: Fields, data: Record<string, unknown>, reader: DocumentReader): Promise<Record<string, unknown>> {
	return resolveRefs(fields, renderData(fields, data), reader.exists);
}

/**
 * M7 Decision 13: Site Settings as the page component gets it (document.ts → PageProps
 * `settings`), read from the render's source (the disk at build, the editor's store in a
 * preview, as Head reads it). The site's own `settings: { fields }` as a block's render data
 * (links as render values, media resolved, a reference to a missing document as null),
 * plus the package's `brand` (`name`, `logo`, `icon`) and `seo` (`title`, `description`,
 * `image`, and the config's `titleSeparator`, so a code route can build its title as head.ts
 * does: `${title}${seo.titleSeparator}${brand.name}`). `brand.name` is the site's name: Site Settings' brand name, else the default
 * search title, else "Site" (as head.ts names the site). Never `editors`, `formRecipients`, `formWords`
 * or `googleTag`, nor the document's own `title`. Never throws on content: a missing or
 * broken file reads as empty.
 */
export async function settingsRenderData(site: Site, source: ContentSource, reader: DocumentReader = documentReader(site, source)): Promise<Record<string, unknown>> {
	const raw = await rawSettings(site, source);
	// The site's own fields: the forms' words (review gaps, Decision 9a) are Site Settings fields too, read by the forms alone.
	const { [FORM_WORDS_KEY]: _formWords, ...fields } = own(site.collections, 'settings')?.fields ?? {};
	const data = await renderFields(fields, parseFields(fields, raw), reader);
	const brand = parseSettingsBrand(raw.brand);
	const seo = parseSeo(raw.seo);
	return {
		...data,
		brand: { name: brand.name || seo.title || 'Site', logo: renderMedia(brand.logo, { only: 'image' }), icon: renderMedia(brand.icon, { only: 'image' }) },
		seo: { title: seo.title ?? '', description: seo.description ?? '', image: renderMedia(seo.image ?? null, { only: 'image' }), titleSeparator: site.titleSeparator ?? DEFAULT_TITLE_SEPARATOR },
	};
}

/** Site Settings' file as the render's source has it, parsed; `{}` when it's missing or broken (never throws on content). */
async function rawSettings(site: Pick<Site, 'root'>, source: ContentSource): Promise<Record<string, unknown>> {
	try {
		const text = await source.readText(join(site.root, SITE_SETTINGS_FILE));
		const parsed = text ? (JSON.parse(text) as unknown) : null;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		/* unreadable: the site's fields at their empty values, the name "Site" */
	}
	return {};
}

/**
 * Review gaps (Decisions 10 and 13): a form's words as they resolve for this render, Site Settings
 * read from its source (the disk, or the editor's store in a preview), then `code` (the site code's
 * words), the config's and the package's. Null for a form the config doesn't have. What
 * `cms.formWords` returns, and what Form.astro draws.
 */
export async function readFormWords(site: Site, source: ContentSource, form: string, code: FormCodeWords = {}, reader: DocumentReader = documentReader(site, source)): Promise<FormWords | null> {
	const config = site.forms && Object.hasOwn(site.forms, form) ? site.forms[form]! : null;
	if (!config) return null;
	// Form rows Decisions 2 and 13: a sourced select's choices, from the render's source (the disk at build, the preview's store).
	const [raw, sources] = await Promise.all([rawSettings(site, source), readFormSources(reader, config)]);
	return resolveFormWords(config, storedWordsOf(raw[FORM_WORDS_KEY], form), code, sources);
}

/**
 * M8 trial (item 1): Site Settings for the site's own `.astro` routes, exactly as the page
 * component gets `Astro.props.settings` (settingsRenderData: rich text parsed, media
 * resolved, links as render values, `brand` and `seo`). Exported from `caracms/content`:
 *
 *   import { siteSettings } from 'caracms/content';
 *   import { site } from 'virtual:caracms/config';
 *   const settings = await siteSettings(site, Astro.locals);
 *
 * Read from the render's source (`locals`, as RenderDocument reads it): the disk, as deployed,
 * unless an editor's preview set its store. `locals` may be left out (the disk).
 */
export function siteSettings(site: Site, locals?: object): Promise<Record<string, unknown>> {
	return settingsRenderData(site, renderSourceOf(locals));
}

/**
 * Edit in context (Contracts → a source context): Site Settings' context for a site's own `.astro`
 * route, beside `siteSettings()`, so the code that draws its values can use the package's field
 * components on them (`<Text cms={settingsCms} field="contact.phone" …>`). A code route is never a
 * preview, so it marks nothing. Exported from `caracms/content`.
 */
export function siteSettingsContext(site: Site, locals?: object): BlockContext {
	return settingsContext(false, documentReader(site, renderSourceOf(locals)));
}

/** Why a shared-block entry doesn't render (Decision 8), or null when it does. */
export type SharedSkip = 'missing' | 'unknown-type';

/**
 * A page's shared entry resolved from the render's source: the shared block's block
 * (`source` as the entry's, so markers are the page's index), or why it's skipped:
 * the shared block doesn't exist (or can't be opened), or its type isn't in the code.
 */
export async function resolveShared(entry: DocumentBlock, reader: DocumentReader): Promise<{ block: DocumentBlock } | { skip: SharedSkip; type: string }> {
	const found = entry.shared ? await reader.document('shared', entry.shared) : null;
	if (!found || found.document.kind !== 'shared') return { skip: 'missing', type: '' };
	const block = (found.document as SharedDocument).block;
	if (!block.known) return { skip: 'unknown-type', type: block.type };
	return { block: { ...block, source: entry.source } };
}
