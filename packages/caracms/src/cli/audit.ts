/**
 * `caracms audit [--json]` (review gaps, Decisions 15–18): renders the site's previews in its own
 * Vite and says what an agency couldn't edit from the page. Everything it finds is a warning, so it
 * exits 0 whatever it finds; but a document it couldn't render wasn't checked, so then it says how
 * many on its last line, never "quiet", and exits 1. `--json` prints `{ findings }` (and
 * `unrendered` and `total` when any failed). `validate` stays static and quick.
 *
 * It renders **every document with an address** (section builders' and fields collections') and
 * **each shared block on its own**, each as the preview route does: through RenderDocument with
 * `preview` on, the disk as the render's source (`setRenderSource`) and a read record started
 * (`startReadRecord`), so the markers and the record are the editor's. It renders through Astro's
 * container (audit/render.ts), not the route itself: the route is the editor's (its mode, its store,
 * its sign-in), and the container is the same render with the same two calls, with no server.
 *
 * It renders with the in-memory media (`CARACMS_MEDIA=memory`), so `<Media>` draws (and marks) an
 * image whether or not the site's media is set up where audit runs.
 *
 * Three kinds (audit/findings.ts):
 * - `unmarked`: per document › block, each field with a value and nothing on the page marking it.
 *   A shared or slot block is reported once, under Shared, from its own render (its marks where a
 *   page places it count too, as a source's); a shared block placed in a page's body is never
 *   reported per page.
 * - `unheld`: words in `<body>` no `data-cms-field` element holds, grouped by the words. A shared
 *   block placed in a body is read from its own render (where its fields are marked), on the pages
 *   that place it.
 * - `one-reader`: a collection with no pages that exactly one block reads, from the read record,
 *   or that no block reads (a sentence says what the record can't see).
 */
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteCollections, type ResolvedSite } from '../config.ts';
import { diskSource, listDocuments, readDocument, type DocumentEntry } from '../content.ts';
import { SETTINGS_PATH } from '../reserved.ts';
import type { AnyDocument, FieldsDocument, SettingsDocument, SharedDocument, SiteDocument } from '../document.ts';
import type { ReadRecord } from '../read.ts';
import { find, has, parseHtml, type HtmlElement } from '../audit/html.ts';
import {
	addressOf,
	anchorHeld,
	groupUnheld,
	linkedTitleHeld,
	markedAnchors,
	words,
	markedIn,
	formSourceCollections,
	oneReader,
	sourceMarks,
	frameLinkPhrases,
	frameLinkWords,
	inFrameLink,
	titleHeld,
	unheldPhrases,
	unmarkedFields,
	unmarkedMessage,
	type Ctx,
	type Finding,
	type PagePhrases,
	type RecordedRender,
} from '../audit/findings.ts';
import { startRenderer, type Renderer } from '../audit/render.ts';
import { allowPagedPreview } from '../audit/paged.ts';
import { pagesRoutes, srcDirOf } from '../code-routes-disk.ts';
import { loadSite, posix } from './site.ts';

export type { Finding } from '../audit/findings.ts';

const READ_MODULE = fileURLToPath(new URL('../read.ts', import.meta.url));

interface ReadModule {
	setRenderSource(locals: object, source: unknown): void;
	startReadRecord(locals: object): void;
	readRecordOf(locals: object): ReadRecord | undefined;
}

interface Rendered {
	entry: DocumentEntry;
	document: AnyDocument;
	tree: HtmlElement;
	record: ReadRecord;
	/** A paged listing's later page (`/journal/page/2`): its address. Read for words, marks and reads; its document's fields are checked on page 1. */
	paged?: string;
}

export interface AuditResult {
	findings: Finding[];
	/** Documents that couldn't be rendered, a sentence each (said on stderr; not findings). */
	problems: string[];
	/** How many documents (pages and shared blocks) couldn't be rendered, so weren't checked. */
	unrendered: number;
	/** How many documents there were to render. */
	total: number;
}

/**
 * Render one document as the preview route does, and keep its read record. `paged`: a later page of
 * its listing, rendered at the address the site serves it at, with the preview route's query (a
 * site's paging block may read it, as the starter's does) and the audit's hook (audit/paged.ts).
 */
async function renderOne(r: Renderer, read: ReadModule, entry: DocumentEntry, document: AnyDocument, paged?: { address: string; listPage: number }): Promise<{ html: string; record: ReadRecord }> {
	const locals: Record<string, unknown> = {};
	read.setRenderSource(locals, diskSource);
	read.startReadRecord(locals);
	if (paged) allowPagedPreview(locals);
	const query = `?collection=${encodeURIComponent(entry.collection)}&path=${encodeURIComponent(entry.path)}`;
	const url = paged ? `http://localhost${paged.address}${query}` : `http://localhost${entry.url ?? '/_caracms/preview'}`;
	const props = { document, collection: entry.collection, preview: true, previewPath: entry.path, ...(paged ? { listPage: paged.listPage } : {}) };
	const html = await r.page('caracms/components/RenderDocument.astro', props, url, locals);
	return { html, record: read.readRecordOf(locals) ?? {} };
}

/** A dynamic route's address for one of its paths: its file under `pages/` with each `[param]` and `[...rest]` filled in. */
export function routeAddress(file: string, params: Record<string, unknown>): string {
	const parts = file.replace(/\.astro$/, '').split('/').filter((p) => p !== 'index');
	const filled = parts.map((part) =>
		part.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_, _rest, name: string) => {
			const v = params[name];
			return v === undefined || v === null ? '' : String(v);
		}),
	);
	return `/${filled.filter((p) => p !== '').join('/')}`;
}

/** The later pages of the site's paged listings, from its dynamic routes' own `getStaticPaths`: each path whose props name a document and a `listPage` over 1. */
async function pagedAddresses(r: Renderer, site: ResolvedSite, problems: string[]): Promise<{ collection: string; path: string; listPage: number; address: string }[]> {
	const srcDir = srcDirOf(site.root);
	const pagesDir = posix(relative(site.root, join(isAbsolute(srcDir) ? srcDir : join(site.root, srcDir), 'pages')));
	const out: { collection: string; path: string; listPage: number; address: string }[] = [];
	for (const route of pagesRoutes(site.root, srcDir)) {
		if (!route.dynamic || !route.file.endsWith('.astro')) continue;
		try {
			const module = (await r.load(join(site.root, route.file))) as { getStaticPaths?: (options: unknown) => unknown };
			if (typeof module.getStaticPaths !== 'function') continue;
			const paths = (await module.getStaticPaths({ paginate: () => [], routePattern: '' })) as unknown;
			for (const item of (Array.isArray(paths) ? paths : []).flat()) {
				const props = (item as { props?: Record<string, unknown> })?.props;
				const params = (item as { params?: Record<string, unknown> })?.params ?? {};
				if (!props || typeof props.collection !== 'string' || typeof props.path !== 'string') continue;
				if (!Number.isInteger(props.listPage) || (props.listPage as number) < 2) continue;
				out.push({ collection: props.collection, path: props.path, listPage: props.listPage as number, address: routeAddress(route.file.slice(pagesDir.length + 1), params) });
			}
		} catch (error) {
			problems.push(`${route.file}: its getStaticPaths couldn't be read, so its later pages weren't rendered (${(error as Error).message.split('\n')[0]})`);
		}
	}
	return out;
}

/** Render every page and shared block of the site at `root` and work out the findings. */
export async function auditSite(site: ResolvedSite): Promise<AuditResult> {
	const entries = (await listDocuments(site)).filter((e) => !e.warning);
	const pages = entries.filter((e) => (e.kind === 'sections' || e.kind === 'fields') && e.url);
	const shared = entries.filter((e) => e.kind === 'shared');
	const urlOf = new Map(entries.map((e) => [`${e.collection}/${e.path}`, e.url]));
	const sharedTitle = new Map(shared.map((e) => [e.path, e.label]));

	const problems: string[] = [];
	let unrendered = 0;
	const rendered: Rendered[] = [];
	// The in-memory media for these renders, whatever the site's own: with none set up, `<Media>` draws
	// nothing even in a preview, and every image would be reported as unmarked. The audit reads markers,
	// never the pictures, so the site's real media isn't needed (nor fetched from the cloud).
	const media = process.env.CARACMS_MEDIA;
	process.env.CARACMS_MEDIA = 'memory';
	const r = await startRenderer(site.root, { annotate: true });
	try {
		const read = (await r.load(READ_MODULE)) as ReadModule;
		for (const entry of [...pages, ...shared]) {
			try {
				const { document } = await readDocument(site, entry.collection, entry.path);
				const { html, record } = await renderOne(r, read, entry, document);
				rendered.push({ entry, document, tree: parseHtml(html), record });
			} catch (error) {
				unrendered++;
				problems.push(`${entry.file}: couldn't be rendered (${(error as Error).message.split('\n')[0]})`);
			}
		}
		// A paged listing's later pages (`/journal/page/2`), as the site's own routes make them.
		for (const p of await pagedAddresses(r, site, problems)) {
			const entry = pages.find((e) => e.collection === p.collection && e.path === p.path);
			if (!entry) continue;
			try {
				const { document } = await readDocument(site, entry.collection, entry.path);
				const { html, record } = await renderOne(r, read, entry, document, p);
				rendered.push({ entry, document, tree: parseHtml(html), record, paged: p.address });
			} catch (error) {
				problems.push(`${p.address}: couldn't be rendered (${(error as Error).message.split('\n')[0]})`);
			}
		}
	} finally {
		await r.close();
		if (media === undefined) delete process.env.CARACMS_MEDIA;
		else process.env.CARACMS_MEDIA = media;
	}

	const findings: Finding[] = [];
	const blockLabel = (type: string) => site.blocks[type]?.label ?? type;
	const sharedLabel = (path: string) => `Shared › ${sharedTitle.get(path) ?? path}`;

	// Decision 16. A document's own fields (a fields document's, a page's own, a shared block's) are
	// also clickable where another render draws them as that document's source (a card's `cms.of`).
	const asSource = new Map<string, Set<string>>();
	for (const { tree } of rendered) sourceMarks(tree, asSource);
	const unmarked = (entry: DocumentEntry, where: string, fields: Parameters<typeof unmarkedFields>[0], values: Record<string, unknown>, tree: HtmlElement, ctx: Ctx, base: string, ownFields = true, frame = false) => {
		const marked = markedIn(tree, ctx);
		if (ownFields) for (const f of asSource.get(`${entry.collection}/${entry.path}`) ?? []) marked.add(f);
		const slotRoot = frame && ctx.kind === 'source' ? find(tree, (e) => e.attrs['data-cms-source'] === ctx.id) : null;
		const linkPhrases = slotRoot ? frameLinkPhrases(slotRoot) : undefined;
		for (const u of unmarkedFields(fields, values, marked, '', { frame, linkPhrases })) {
			findings.push({ kind: 'unmarked', file: entry.file, path: `${base}${u.path}`, message: unmarkedMessage(where, u) });
		}
	};
	for (const { entry, document, tree, paged } of rendered) {
		if (paged) continue;
		const collection = site.collections[entry.collection]!;
		if (document.kind === 'shared') {
			const block = (document as SharedDocument).block;
			const config = block.known ? site.blocks[block.type] : undefined;
			if (!config) continue;
			const ctx: Ctx = config.slot ? { kind: 'source', id: `shared/${entry.path}` } : { kind: 'block', index: 0 };
			// A slot block whose component's outermost element isn't `<Block cms={cms}>` (a framework
			// island drawn straight in, say): nothing on the page is its source root, so a click opens
			// nothing and its link words aren't the frame's. Said once, as the cause, beside its words.
			if (config.slot && !find(tree, (e) => e.attrs['data-cms-source'] === `shared/${entry.path}`)) {
				findings.push({ kind: 'unmarked', file: entry.file, path: 'block', message: `${sharedLabel(entry.path)}: its component's outermost element isn't a <Block cms={cms}>, so nothing on the page opens it and its links' words count as no field's` });
			}
			unmarked(entry, sharedLabel(entry.path), config.fields, block.data, tree, ctx, 'block.', true, !!config.slot);
		} else if (document.kind === 'fields') {
			unmarked(entry, `${collection.label} › ${entry.label}`, collection.fields ?? {}, (document as FieldsDocument).data, tree, { kind: 'block', index: 0 }, '');
		} else {
			const page = document as SiteDocument;
			if (collection.fields && page.data) unmarked(entry, entry.label, collection.fields, page.data, tree, { kind: 'page' }, '');
			page.blocks.forEach((block, i) => {
				const config = block.shared === undefined && block.known ? site.blocks[block.type] : undefined;
				if (!config || config.slot) return;
				unmarked(entry, `${entry.label} › ${config.label}`, config.fields, block.data, tree, { kind: 'block', index: i }, `blocks[${i}].`, false);
			});
		}
	}

	// Decision 17. Held besides marked fields: a document's title inside its own root (titles are
	// never marked: they're edited at the top of the form), and a slot block's link words inside its
	// root (edit in context, Decision 7: the frame's links aren't marked, so they follow), and any
	// words drawn inside a link or menu control within a slot's root, whoever holds them (a menu
	// built in code from the slot's fields, Site Settings' socials): they can't be marked either.
	// Titles are also held where a page draws its own anywhere on it (a docs layout's `<h1>` outside
	// the blocks), and inside a link to their document (a nav, a sidebar, a pager); and an in-page
	// link's words are held when they're those of a marked element it points to (a table of contents
	// repeating a marked heading). A framework's fixed words (Starlight's "Next", "On this page") stay
	// findings: they're words no field holds, and the site's skill says how to read them.
	const titles = new Map<string, string>(entries.map((e) => [`${e.collection}/${e.path}`, e.title]));
	try {
		const settings = (await readDocument(site, 'settings', SETTINGS_PATH)).document as SettingsDocument;
		// Its title on the page is the brand's name, read as settingsRenderData reads it (its fallbacks included).
		titles.set('settings', settings.data.brand?.name || settings.data.seo?.title || 'Site');
	} catch {
		// No Site Settings file: no brand name to hold.
	}
	const frameWords = new Map<string, Set<string>>();
	for (const { entry, document, tree } of rendered) {
		if (document.kind !== 'shared') continue;
		const block = (document as SharedDocument).block;
		const config = block.known ? site.blocks[block.type] : undefined;
		if (!config?.slot) continue;
		const id = `shared/${entry.path}`;
		const held = frameLinkWords(config.fields, block.data);
		// The words its links built in code draw (a menu's labels from its text fields), held anywhere in its root too.
		const root = find(tree, (e) => e.attrs['data-cms-source'] === id);
		if (root) for (const phrase of frameLinkPhrases(root)) held.add(phrase);
		frameWords.set(id, held);
	}
	const slots = new Set(frameWords.keys());
	// Each address's document title, for the links that draw it.
	const titleAt = new Map<string, string>();
	for (const e of entries) {
		const address = e.url ? addressOf(e.url) : null;
		if (address !== null && !titleAt.has(address)) titleAt.set(address, e.title);
	}
	const heldIn = (tree: HtmlElement, page: { title: string; url: string } | undefined) => {
		const title = titleHeld((id) => (id === 'page' ? page?.title : titles.get(id)));
		const linked = linkedTitleHeld((address) => titleAt.get(address), page?.url);
		const anchor = anchorHeld(markedAnchors(tree));
		const own = page ? words(page.title) : undefined;
		return (phrase: string, el: HtmlElement) => {
			if (phrase === own || title(phrase, el) || linked(phrase, el) || anchor(phrase, el)) return true;
			if (inFrameLink(el, slots)) return true;
			for (let e: HtmlElement | null = el; e; e = e.parent) {
				const id = e.attrs['data-cms-source'];
				if (id !== undefined && frameWords.get(id)?.has(phrase)) return true;
			}
			return false;
		};
	};
	const phrases: PagePhrases[] = [];
	const placed = (el: HtmlElement) => has(el, 'data-cms-shared');
	for (const { entry, document, tree, paged } of rendered) {
		if (document.kind !== 'shared') {
			const body = find(tree, (e) => e.tag === 'body') ?? tree;
			phrases.push({ page: paged ?? entry.url!, phrases: unheldPhrases(body, { skip: placed, held: heldIn(tree, { title: entry.title, url: paged ?? entry.url! }) }) });
			continue;
		}
		const block = (document as SharedDocument).block;
		if (!block.known || site.blocks[block.type]?.slot) continue; // A slot's words are read on every page it's drawn on.
		const root = find(tree, (e) => e.attrs['data-cms-block'] === '0');
		if (!root) continue;
		const found = unheldPhrases(root, { held: heldIn(tree, undefined) });
		for (const at of entry.usedOn ?? []) {
			const url = urlOf.get(`${at.collection}/${at.path}`);
			if (url) phrases.push({ page: url, phrases: found });
		}
	}
	findings.push(...groupUnheld(phrases, (source) => posix(relative(site.root, source))));

	// Decision 18.
	const records: RecordedRender[] = rendered.map(({ entry, document, record }) => ({
		record,
		readerOf(index) {
			if (document.kind === 'shared') return index === 0 ? { key: `shared/${entry.path}`, label: sharedLabel(entry.path) } : null;
			if (document.kind === 'fields') return index === 0 ? { key: `${entry.collection}/${entry.path}`, label: `${site.collections[entry.collection]!.label} › ${entry.label}` } : null;
			const block = (document as SiteDocument).blocks[index];
			if (!block) return null;
			if (block.shared !== undefined) return { key: `shared/${block.shared}`, label: sharedLabel(block.shared) };
			return { key: `${entry.collection}/${entry.path}#${index}`, label: `${entry.label} › ${blockLabel(block.type)}` };
		},
	}));
	const pageless = siteCollections(site).filter((c) => c.urlBase === null && !c.heldBy);
	// A collection a form's select reads (its `source`) is the endpoint's, not a block's: never a finding.
	findings.push(...oneReader(pageless, records, formSourceCollections(site.forms)));

	return { findings, problems, unrendered, total: pages.length + shared.length };
}

const HEADINGS: Record<Finding['kind'], string> = {
	unmarked: 'Not clickable on the page',
	unheld: 'Words no field holds',
	'one-reader': 'Read by only one block',
};

/**
 * The plain report: each kind's findings under its heading, then the summary line. `unrendered`:
 * how many of `total` documents couldn't be rendered. Any at all, and the summary never says quiet:
 * those documents weren't checked.
 */
export function formatAudit(findings: readonly Finding[], unrendered = 0, total = 0): string {
	const parts: string[] = [];
	for (const kind of Object.keys(HEADINGS) as Finding['kind'][]) {
		const of = findings.filter((f) => f.kind === kind);
		if (of.length) parts.push(`${HEADINGS[kind]}:\n${of.map((f) => `  ${f.message}`).join('\n')}`);
	}
	const warnings = `${findings.length} warning${findings.length === 1 ? '' : 's'}`;
	if (unrendered) {
		const skipped = `${unrendered} of ${total} document${total === 1 ? '' : 's'} couldn't be rendered, so ${unrendered === 1 ? "it wasn't" : "they weren't"} checked`;
		parts.push(`caracms audit: ${skipped}${findings.length ? `; ${warnings} in the rest` : ''}.`);
	} else {
		parts.push(findings.length ? `caracms audit: ${warnings}.` : 'caracms audit: quiet.');
	}
	return `${parts.join('\n\n')}\n`;
}

/**
 * The command's entry (bin/caracms.mjs loads this module through the site's Vite). Findings are
 * warnings (exit 0); a document that couldn't be rendered wasn't checked, so that exits 1, and a
 * script or CI run can't take it for a pass. A later page or a route whose paths couldn't be read
 * is said, but doesn't fail the run (its document was checked on its first page).
 */
export async function command(root: string, options: { json?: boolean } = {}): Promise<{ code: number; out: string; err?: string }> {
	const site = await loadSite(root);
	const { findings, problems, unrendered, total } = await auditSite(site);
	const err = problems.length ? `${problems.map((p) => `caracms audit: ${p}`).join('\n')}\n` : undefined;
	const code = unrendered ? 1 : 0;
	if (options.json) return { code, out: `${JSON.stringify({ findings, ...(unrendered ? { unrendered, total } : {}) }, null, 2)}\n`, err };
	return { code, out: formatAudit(findings, unrendered, total), err };
}
