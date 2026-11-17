/**
 * Heading ids: every `h2`/`h3` a rich-text field renders gets an
 * `id`, so a site can build a table of contents and link to a heading.
 *
 * - **One rule, three readers.** `headingId` is the slug: GitHub's, through
 *   `github-slugger` (lower case, spaces to `-`, punctuation dropped), of the heading's
 *   plain text (no `**` or link syntax; a break reads as a space), made unique on the page
 *   by `-1`, `-2`… in page order. The render's ids (RichText.astro), a site's TOC
 *   (`pageHeadings`) and a Markdown writer's anchors all come from it.
 * - **Page order is the document's order**: its blocks in order (a shared entry where it's
 *   placed, as Blocks.astro draws it; unknown blocks and slot blocks skipped), each
 *   block's fields in schema order, list items in order. A block component that draws a
 *   later field above an earlier one still gets the document's numbering.
 * - **Worked out once per render, up front**: Blocks.astro calls `headingIdsOf` with the
 *   page's document and gives each block's context its ids by field path
 *   (`cms.headingIds`); RichText looks its own up. No render-order state, so concurrent
 *   renders can't disturb it, and a preview render recomputes them from the draft.
 * - **Ids are render-only.** The stored rich text never holds them (`[{ "h2": "…" }]`).
 * - Only a block's own fields count: a page field the page component draws, Site
 *   Settings and a slot's block get no heading ids.
 */
import { slug } from 'github-slugger';
import type { ResolvedSite } from './config.ts';
import { documentKind, own, type DocumentBlock, type DocumentReader, type PageDocument, type SiteDocument } from './document.ts';
import { parseField, type Field, type Fields } from './fields.ts';
import { resolveShared } from './read.ts';
import { runsText, type RichTextValue, type TextRun } from './rich-text.ts';

/** One heading of a page, as Starlight's `<StarlightPage headings>` takes it. */
export interface PageHeading {
	depth: 2 | 3;
	slug: string;
	text: string;
}

/** The ids used so far on one page: each base slug and how many times it has repeated. Start each page with `new Map()`. */
export type HeadingSeen = Map<string, number>;

/**
 * A heading's id, unique on the page: github-slugger's slug of `text`, then `-1`, `-2`… for
 * each repeat (exactly as `GithubSlugger#slug`). Records it in `seen`. Text with nothing
 * left to slug (empty, or punctuation only) gives `''` and records nothing: such a heading
 * gets no id and no TOC entry.
 */
export function headingId(text: string, seen: HeadingSeen): string {
	const base = slug(text);
	if (base === '') return '';
	let id = base;
	while (seen.has(id)) {
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		id = `${base}-${n}`;
	}
	seen.set(id, 0);
	return id;
}

/** A heading's plain text from its runs: no markup, a break as a space, trimmed. */
export function headingText(runs: readonly TextRun[]): string {
	return runsText(runs).replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * The ids for one rich-text value's headings, in order, one per `h2`/`h3` (`''` for one
 * that gets none), and the headings themselves. Advances `seen`.
 */
export function richTextHeadings(value: RichTextValue, seen: HeadingSeen): { ids: string[]; headings: PageHeading[] } {
	const ids: string[] = [];
	const headings: PageHeading[] = [];
	for (const block of value) {
		if (block.kind !== 'h2' && block.kind !== 'h3') continue;
		const text = headingText(block.runs);
		const id = headingId(text, seen);
		ids.push(id);
		if (id) headings.push({ depth: block.kind === 'h2' ? 2 : 3, slug: id, text });
	}
	return { ids, headings };
}

/** A field path → its headings' ids (RichText's `field` prop is the key: `body`, `left.body`, `items.0.body`). */
export type HeadingIds = Record<string, string[]>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Walk parsed field values in schema order, list items in order, for rich-text fields that can hold headings. */
function walkFields(fields: Fields, data: Record<string, unknown>, prefix: string, seen: HeadingSeen, ids: HeadingIds, headings: PageHeading[]): void {
	for (const [key, field] of Object.entries(fields)) walkField(field, data[key], `${prefix}${key}`, seen, ids, headings);
}

function walkField(field: Field, value: unknown, path: string, seen: HeadingSeen, ids: HeadingIds, headings: PageHeading[]): void {
	if (field.kind === 'richText') {
		if (field.heading || field.headings.length === 0 || !Array.isArray(value)) return;
		const found = richTextHeadings(value as RichTextValue, seen);
		if (found.ids.length) ids[path] = found.ids;
		headings.push(...found.headings);
	} else if (field.kind === 'group' && isObject(value)) {
		walkFields(field.fields, value, `${path}.`, seen, ids, headings);
	} else if (field.kind === 'list' && Array.isArray(value)) {
		if (field.item) for (const [i, v] of value.entries()) walkField(field.item, v, `${path}.${i}`, seen, ids, headings);
		else if (field.fields) for (const [i, v] of value.entries()) if (isObject(v)) walkFields(field.fields, v, `${path}.${i}.`, seen, ids, headings);
	}
}

/** One block's (or fields document's) fields, parsed as the render parses them. */
function fieldsHeadings(fields: Fields, raw: Record<string, unknown>, seen: HeadingSeen, headings: PageHeading[]): HeadingIds {
	const ids: HeadingIds = {};
	const parsed: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(fields)) parsed[key] = parseField(field, raw[key]);
	walkFields(fields, parsed, '', seen, ids, headings);
	return ids;
}

/**
 * A section builder's heading ids, per block index (null where nothing renders), and the
 * page's headings in order. `resolved` gives a shared entry's block by index, as
 * Blocks.astro resolves them; an entry without one doesn't render.
 */
export function headingIdsOf(
	page: SiteDocument,
	site: Pick<ResolvedSite, 'blocks'>,
	resolved: ReadonlyMap<number, DocumentBlock> = new Map(),
): { blocks: (HeadingIds | null)[]; headings: PageHeading[] } {
	const seen: HeadingSeen = new Map();
	const headings: PageHeading[] = [];
	const blocks = page.blocks.map((entry, i) => {
		if (entry.shared !== undefined && !resolved.has(i)) return null;
		const block = resolved.get(i) ?? entry;
		const schema = block.known ? own(site.blocks, block.type) : undefined;
		if (!schema) return null;
		return fieldsHeadings(schema.fields, block.data, seen, headings);
	});
	return { blocks, headings };
}

/** A fields document's heading ids and headings (its collection's fields, in schema order). */
export function fieldsDocumentHeadingIds(fields: Fields, data: Record<string, unknown>): { ids: HeadingIds; headings: PageHeading[] } {
	const headings: PageHeading[] = [];
	return { ids: fieldsHeadings(fields, data, new Map(), headings), headings };
}

/**
 * The shared entries of a section builder that render, resolved from `read` (Blocks.astro's
 * rule): a shared block that exists and whose type is known, and isn't a slot's block.
 */
export async function resolvedSharedEntries(page: SiteDocument, site: Pick<ResolvedSite, 'blocks'>, read: DocumentReader): Promise<Map<number, DocumentBlock>> {
	const resolved = new Map<number, DocumentBlock>();
	await Promise.all(
		page.blocks.map(async (entry, i) => {
			if (entry.shared === undefined) return;
			const r = await resolveShared(entry, read);
			if ('block' in r && !own(site.blocks, r.block.type)?.slot) resolved.set(i, r.block);
		}),
	);
	return resolved;
}

/**
 * A page's headings, `{ depth, slug, text }[]` in page order: the ids its rendered `h2`s and
 * `h3`s carry. For Starlight, `<StarlightPage headings={await pageHeadings(site, document,
 * { collection, read })}>` in the page component, with `document`, `collection` and `read`
 * from its props. `read` resolves shared entries (without it, a shared block's headings are
 * left out, as if it didn't render); `collection` is needed for a fields document.
 */
export async function pageHeadings(
	site: Pick<ResolvedSite, 'blocks' | 'collections'>,
	document: PageDocument,
	options: { collection?: string; read?: DocumentReader } = {},
): Promise<PageHeading[]> {
	const kind = documentKind(document);
	if (kind === 'fields') {
		const c = options.collection ? own(site.collections, options.collection) : undefined;
		if (!c || c.kind !== 'fields') return [];
		return fieldsDocumentHeadingIds(c.fields ?? {}, (document as Extract<PageDocument, { kind: 'fields' }>).data).headings;
	}
	if (kind === 'shared') {
		const block = (document as Extract<PageDocument, { kind: 'shared' }>).block;
		if (!block.known || own(site.blocks, block.type)?.slot) return [];
		return headingIdsOf({ title: document.title, blocks: [block] }, site).headings;
	}
	const page = document as SiteDocument;
	const resolved = options.read ? await resolvedSharedEntries(page, site, options.read) : new Map<number, DocumentBlock>();
	return headingIdsOf(page, site, resolved).headings;
}
