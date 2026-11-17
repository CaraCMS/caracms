/**
 * Rewriting links when a document's address changes (pre-M7 item 8): one document's
 * file text in, the same text out with every link to the old address pointing at the
 * new one. **Only those strings change**: the rest of the file is its own text, byte
 * for byte (the change is spliced in, as serialize.ts splices an edited key).
 *
 What counts as a link to the old address is found **by the schema** (block types by
 * their `type`, lists by index), so only real links change, never a text that happens
 * to read the same, nor a key the schema doesn't know:
 *
 * - **A link field's or a button's `href`** that is a `/path` to it: `/studio/visit`,
 *   `/studio/visit/`, `/studio/visit#hours`, `/studio/visit?x=1`. The path is swapped;
 *   a trailing slash, query or anchor stays.
 * - **Rich text's links** (`[text](/studio/visit)`, rich-text.ts's on-disk form), with
 *   the same rule for the href and its escapes kept.
 * - **A reference** to the document (`reference({ to })`, stored as its path in its
 *   collection, M5a Decision 6).
 *
 * Shared-block uses (`{ "shared": "footer" }`) never change: a shared block has no
 * address, so it never moves. Site Settings' own `redirects` are the caller's
 * (redirects.ts), never rewritten here. A file that isn't valid JSON is left as it is.
 *
 * M6c G4: the same walk finds and rewrites **links to files** (`/files/…`, caracms/files):
 * `fileLinksIn` lists a text's file links by schema (the library's "linked from",
 * Decision 8), and `refileText` points every link to one file at another (Replace…,
 * Decision 9), `?download` and a fragment kept. A plain-text mention of an address is
 * never a link: only link fields, buttons and rich text count.
 */
import type { ResolvedCollection, ResolvedSite } from './config.ts';
import { own } from './document.ts';
import type { Field } from './fields.ts';
import { fileAddress, fileKeyOf } from './files.ts';
import { internalLinkPath, normaliseAddress } from './links.ts';
import { parseSource, type JsonNode } from './json-source.ts';

export interface AddressMove {
	/** The document's collection. */
	collection: string;
	/** Its path in the collection, before and after. */
	fromPath: string;
	toPath: string;
	/** Its public address, before and after (`/studio/visit`). */
	fromUrl: string;
	toUrl: string;
}

type Segment = string | number;

/** An href pointing at the old address, pointed at the new one; null when it doesn't point there. */
export function relinkHref(href: string, move: Pick<AddressMove, 'fromUrl' | 'toUrl'>): string | null {
	const path = internalLinkPath(href);
	if (path === null || path !== normaliseAddress(move.fromUrl)) return null;
	const typed = href.trim();
	const pathPart = typed.replace(/[?#].*$/, '');
	const rest = typed.slice(pathPart.length);
	// A trailing slash as typed stays (`/studio/visit/` → `/visit/`), except on `/`.
	const slash = pathPart.length > 1 && pathPart.endsWith('/') && move.toUrl !== '/';
	return `${move.toUrl}${slash ? '/' : ''}${rest}`;
}

/** Rich text's `](href)`: the href runs to the first unescaped `)`, with `\` and `)` escaped inside it. */
const MARKDOWN_HREF = /\]\(((?:\\[\\)]|[^\\)])*)\)/g;

/** Rewrites one href: the new one, or null to leave it. */
type HrefRewrite = (href: string) => string | null;

/** A rich-text string's hrefs, unescaped, in order. */
export function richTextHrefs(value: string): string[] {
	if (!value.includes('](')) return [];
	return [...value.matchAll(MARKDOWN_HREF)].map((m) => m[1]!.replace(/\\([\\)])/g, '$1'));
}

/** A rich-text string with `rewrite` applied to each link, its escapes kept; null when none changed. */
function rewriteRichText(value: string, rewrite: HrefRewrite): { text: string; links: number } | null {
	if (!value.includes('](')) return null;
	let links = 0;
	const out = value.replace(MARKDOWN_HREF, (whole, escaped: string) => {
		const href = escaped.replace(/\\([\\)])/g, '$1');
		const next = rewrite(href);
		if (next === null || next === href) return whole;
		links++;
		return `](${next.replace(/[\\)]/g, '\\$&')})`;
	});
	return links ? { text: out, links } : null;
}

/** A string with its rich-text links to the old address rewritten; null when none were. */
export function relinkRichText(value: string, move: Pick<AddressMove, 'fromUrl' | 'toUrl'>): string | null {
	return rewriteRichText(value, (href) => relinkHref(href, move))?.text ?? null;
}

/**
 * The field a value in the file belongs to, by its path from the file's root (blocks by
 * their `type`, into lists by index), with the rest of the path inside the field's
 * value (`['href']` in a link, `[0, 'href']` in buttons); null where the schema has none.
 */
function fieldAt(site: Pick<ResolvedSite, 'blocks'>, collection: Pick<ResolvedCollection, 'kind' | 'fields'>, raw: unknown, path: Segment[]): { field: Field; rest: Segment[] } | null {
	const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
	const blockField = (block: unknown, key: Segment | undefined) => {
		const type = obj(block)?.type;
		const config = typeof type === 'string' ? own(site.blocks, type) : undefined;
		return typeof key === 'string' && config ? (own(config.fields, key) ?? null) : null;
	};
	let field: Field | null;
	let rest: Segment[];
	switch (collection.kind) {
		case 'sections': {
			// M6c (G2): a page field, a top-level key beside the blocks.
			if (typeof path[0] === 'string' && path[0] !== 'blocks') {
				field = path[0] !== 'seo' ? (own(collection.fields ?? {}, path[0]) ?? null) : null;
				rest = path.slice(1);
				break;
			}
			if (path[0] !== 'blocks' || typeof path[1] !== 'number') return null;
			const blocks = obj(raw)?.blocks;
			field = blockField(Array.isArray(blocks) ? blocks[path[1]] : null, path[2]);
			rest = path.slice(3);
			break;
		}
		case 'shared':
			if (path[0] !== 'block') return null;
			field = blockField(obj(raw)?.block, path[1]);
			rest = path.slice(2);
			break;
		default:
			field = typeof path[0] === 'string' ? (own(collection.fields ?? {}, path[0]) ?? null) : null;
			rest = path.slice(1);
	}
	// Into lists (an index, then, a list of several fields, the item's key) and groups (a key).
	while (field && (field.kind === 'list' || field.kind === 'group') && rest.length) {
		if (field.kind === 'group') {
			field = typeof rest[0] === 'string' ? (own(field.fields, rest[0]) ?? null) : null;
			rest = rest.slice(1);
			continue;
		}
		if (typeof rest[0] !== 'number') return null;
		if (field.item) {
			field = field.item;
			rest = rest.slice(1);
		} else {
			field = typeof rest[1] === 'string' ? (own(field.fields ?? {}, rest[1]) ?? null) : null;
			rest = rest.slice(2);
		}
	}
	return field ? { field, rest } : null;
}

/**
 * Several moves at once (collections under pages, Decision 9: a page and everything under
 * it): each link is matched against the addresses as they were, once, so a swap stays a
 * swap and a link is never moved twice.
 */
interface MoveIndex {
	href: HrefRewrite;
	ref: (collection: string, path: string) => string | null;
}

function indexMoves(moves: readonly AddressMove[]): MoveIndex {
	const byUrl = new Map<string, AddressMove>();
	const byPath = new Map<string, AddressMove>();
	for (const m of moves) {
		const url = normaliseAddress(m.fromUrl);
		if (m.fromUrl !== m.toUrl && !byUrl.has(url)) byUrl.set(url, m);
		// A held document keeps its path when its holder moves (check 18: references to it never change).
		const key = `${m.collection}\u0000${m.fromPath}`;
		if (m.fromPath !== m.toPath && !byPath.has(key)) byPath.set(key, m);
	}
	return {
		href: (href) => {
			const path = internalLinkPath(href);
			const move = path === null ? undefined : byUrl.get(path);
			return move ? relinkHref(href, move) : null;
		},
		ref: (collection, path) => byPath.get(`${collection}\u0000${path}`)?.toPath ?? null,
	};
}

/** A string at `rest` inside a field's value, with its links to the old addresses rewritten; null when it isn't a link there or doesn't point at one. */
function relinkIn(field: Field, rest: Segment[], value: string, moves: MoveIndex): string | null {
	switch (field.kind) {
		case 'link':
			return rest.length === 1 && rest[0] === 'href' ? moves.href(value) : null;
		case 'buttons':
			return rest.length === 2 && typeof rest[0] === 'number' && rest[1] === 'href' ? moves.href(value) : null;
		case 'richText':
			return rewriteRichText(value, moves.href)?.text ?? null;
		case 'reference':
			return rest.length === 0 && field.to ? moves.ref(field.to, value.trim()) : null;
		default:
			return null;
	}
}

/**
 * Every string in the file that the schema places in a field, depth first in file order,
 * with that field and the rest of the path inside its value. Site Settings' `redirects`
 * are skipped (redirects.ts's own). Null when the text isn't JSON.
 */
function fieldStrings(
	text: string,
	site: Pick<ResolvedSite, 'blocks'>,
	collection: Pick<ResolvedCollection, 'kind' | 'fields'>,
	visit: (field: Field, rest: Segment[], value: string, node: { start: number; end: number }) => void,
): boolean {
	let source;
	try {
		source = parseSource(text);
	} catch {
		return false;
	}
	const walk = (node: JsonNode, path: Segment[]) => {
		if (node.kind === 'object') {
			for (const m of node.members) {
				// Site Settings' redirects are redirects.ts's to change, never a link to rewrite.
				if (collection.kind === 'settings' && path.length === 0 && m.key === 'redirects') continue;
				walk(m.value, [...path, m.key]);
			}
			return;
		}
		if (node.kind === 'array') {
			node.items.forEach((item, i) => walk(item, [...path, i]));
			return;
		}
		if (typeof node.value !== 'string') return;
		const at = fieldAt(site, collection, source.value, path);
		if (at) visit(at.field, at.rest, node.value, node);
	};
	walk(source.root, []);
	return true;
}

/** A string's links where it sits in its field: a link's or a button's href, or rich text's hrefs. */
function hrefsAt(field: Field, rest: Segment[], value: string): 'href' | 'rich' | null {
	if (field.kind === 'link') return rest.length === 1 && rest[0] === 'href' ? 'href' : null;
	if (field.kind === 'buttons') return rest.length === 2 && typeof rest[0] === 'number' && rest[1] === 'href' ? 'href' : null;
	if (field.kind === 'richText') return value.includes('](') ? 'rich' : null;
	return null;
}

/** Splice edits into a text, latest first. */
function splice(text: string, edits: { start: number; end: number; text: string }[]): string {
	let out = text;
	for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return out;
}

/**
 * The file's text with every link and reference to the moved document pointing at
 * its new address (or path); `text` itself when nothing points there. `collection` is
 * the file's own collection (for its schema). Several moves are applied at once.
 */
export function relinkText(
	text: string,
	move: AddressMove | readonly AddressMove[],
	site: Pick<ResolvedSite, 'blocks'>,
	collection: Pick<ResolvedCollection, 'kind' | 'fields'>,
): { text: string; links: number } {
	const edits: { start: number; end: number; text: string }[] = [];
	const moves = indexMoves(Array.isArray(move) ? move : [move as AddressMove]);
	const ok = fieldStrings(text, site, collection, (field, rest, value, node) => {
		const next = relinkIn(field, rest, value, moves);
		if (next !== null && next !== value) edits.push({ start: node.start, end: node.end, text: JSON.stringify(next) });
	});
	if (!ok || edits.length === 0) return { text, links: 0 };
	return { text: splice(text, edits), links: edits.length };
}

/**
 * M6c G4: every file link in the file's text, by schema (link fields, buttons, rich text),
 * as the key and download flag `fileKeyOf` reads, in file order. A text that isn't JSON has none.
 */
export function fileLinksIn(text: string, site: Pick<ResolvedSite, 'blocks'>, collection: Pick<ResolvedCollection, 'kind' | 'fields'>): { key: string; download: boolean }[] {
	const out: { key: string; download: boolean }[] = [];
	fieldStrings(text, site, collection, (field, rest, value) => {
		const how = hrefsAt(field, rest, value);
		const hrefs = how === 'href' ? [value] : how === 'rich' ? richTextHrefs(value) : [];
		for (const href of hrefs) {
			const file = fileKeyOf(href.trim());
			if (file) out.push(file);
		}
	});
	return out;
}

/** A link to the file `from` pointed at `to`, `?download` and a fragment kept; null when it isn't a link to `from`. */
export function refileHref(href: string, from: string, to: string): string | null {
	const typed = href.trim();
	const file = fileKeyOf(typed);
	if (!file || file.key !== from) return null;
	const hash = typed.indexOf('#');
	return `${fileAddress(to, { download: file.download })}${hash === -1 ? '' : typed.slice(hash)}`;
}

/**
 * M6c G4 (Replace…, Decision 9): the file's text with every link to the file `from` (a
 * key) pointing at `to`, by schema, spliced in as relinkText does; `links` counts the
 * links rewritten (a rich text holding two counts two).
 */
export function refileText(
	text: string,
	from: string,
	to: string,
	site: Pick<ResolvedSite, 'blocks'>,
	collection: Pick<ResolvedCollection, 'kind' | 'fields'>,
): { text: string; links: number } {
	const edits: { start: number; end: number; text: string }[] = [];
	let links = 0;
	const ok = fieldStrings(text, site, collection, (field, rest, value, node) => {
		const how = hrefsAt(field, rest, value);
		if (how === 'href') {
			const next = refileHref(value, from, to);
			if (next === null) return;
			links++;
			edits.push({ start: node.start, end: node.end, text: JSON.stringify(next) });
		} else if (how === 'rich') {
			const next = rewriteRichText(value, (href) => refileHref(href, from, to));
			if (!next) return;
			links += next.links;
			edits.push({ start: node.start, end: node.end, text: JSON.stringify(next.text) });
		}
	});
	if (!ok || edits.length === 0) return { text, links: 0 };
	return { text: splice(text, edits), links };
}
