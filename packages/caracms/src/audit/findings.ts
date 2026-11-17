/**
 * What `caracms audit` reports (review gaps, Decisions 16–18), worked out from rendered pages
 * (html.ts's tree) and the preview's read record. Pure: the command (cli/audit.ts) renders and
 * calls these, and the tests call them on markup of their own.
 *
 * The page's contexts are the editor's (editor/client/preview/markers.ts): a block's root
 * (`data-cms-block`, a fields document's `data-cms-document` as block 0), the page's own fields
 * (`data-cms-page`) and a source (`data-cms-source`); a field element under a page region or a
 * source carries that marker itself, so a field's context is the nearest context from the field.
 */
import type { Field, Fields } from '../fields.ts';
import type { ResolvedForm } from '../forms/rules.ts';
import type { ReadRecord } from '../read.ts';
import { closest, elements, has, type HtmlElement } from './html.ts';

/** Contracts → `caracms audit`. */
export interface Finding {
	kind: 'unmarked' | 'unheld' | 'one-reader';
	/** The content file (unmarked), the component that wrote the words (unheld, when one did and it's known). */
	file?: string;
	/** Where in the file (unmarked): `blocks[2].stats.0.value`. */
	path?: string;
	/** The pages' addresses (unheld). */
	pages?: string[];
	message: string;
}

// ── Contexts and markers ────────────────────────────────────────────────────────────

export type Ctx = { kind: 'block'; index: number } | { kind: 'page' } | { kind: 'source'; id: string };

const isContext = (e: HtmlElement) => has(e, 'data-cms-source') || has(e, 'data-cms-page') || has(e, 'data-cms-block') || has(e, 'data-cms-document');

function ctxOf(root: HtmlElement): Ctx | null {
	if (has(root, 'data-cms-source')) return { kind: 'source', id: root.attrs['data-cms-source']! };
	if (has(root, 'data-cms-page')) return { kind: 'page' };
	if (has(root, 'data-cms-block')) {
		const index = Number(root.attrs['data-cms-block']);
		return Number.isInteger(index) ? { kind: 'block', index } : null;
	}
	return has(root, 'data-cms-document') ? { kind: 'block', index: 0 } : null;
}

const sameCtx = (a: Ctx | null, b: Ctx) =>
	!!a && a.kind === b.kind && (a.kind !== 'block' || a.index === (b as { index: number }).index) && (a.kind !== 'source' || a.id === (b as { id: string }).id);

/** Every field path marked on the page in a context (a valueless marker included). */
export function markedIn(tree: HtmlElement, ctx: Ctx): Set<string> {
	const out = new Set<string>();
	for (const e of elements(tree)) {
		if (!has(e, 'data-cms-field')) continue;
		const root = closest(e, isContext);
		if (root && sameCtx(ctxOf(root), ctx)) out.add(e.attrs['data-cms-field']!);
	}
	return out;
}

/**
 * Every field marked as a source in a render, by source id (`journal/a-day-on-the-ferry`,
 * `shared/footer`), added to `into`: a card that marks its entry's excerpt (`cms.of(entry)`) makes
 * that entry's field clickable, on whichever page draws the card.
 */
export function sourceMarks(tree: HtmlElement, into: Map<string, Set<string>> = new Map()): Map<string, Set<string>> {
	for (const e of elements(tree)) {
		if (!has(e, 'data-cms-field') || !has(e, 'data-cms-source')) continue;
		const id = e.attrs['data-cms-source']!;
		let set = into.get(id);
		if (!set) into.set(id, (set = new Set()));
		set.add(e.attrs['data-cms-field']!);
	}
	return into;
}

// ── Decision 16: not clickable on the page ─────────────────────────────────────────

export interface Unmarked {
	/** The field's path in its block (`stats.0.value`). */
	path: string;
	what: 'words' | 'image' | 'clip' | 'address';
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const join = (base: string, key: string | number) => (base === '' ? String(key) : `${base}.${key}`);

/**
 * A path is marked when a marker names it, something inside it (a link's `cta.label`, a button's
 * `buttons.0.label`) or something holding it (a list marked as a whole, `<Block field="stats">`).
 * So a link's address is never reported when its label is marked, nor an image's alt when the image is.
 */
function covered(path: string, marked: ReadonlySet<string>): boolean {
	for (const m of marked) if (m === path || m.startsWith(`${path}.`) || path.startsWith(`${m}.`)) return true;
	return false;
}

/** What a value holds that a visitor sees, or null: settings (select, toggle, number, date) and references hold none. */
function held(field: Field, value: unknown): Unmarked['what'] | null {
	switch (field.kind) {
		case 'text':
			return filled(value) ? 'words' : null;
		case 'lockup':
			return isObject(value) && Array.isArray(value.lines) && value.lines.some(filled) ? 'words' : null;
		case 'richText':
			return Array.isArray(value) &&
				value.some((b) => isObject(b) && ((Array.isArray(b.runs) && b.runs.some((r) => isObject(r) && filled(r.text))) || (Array.isArray(b.items) && b.items.some((item) => Array.isArray(item) && item.some((r) => isObject(r) && filled(r.text))))))
				? 'words'
				: null;
		case 'link':
			if (!isObject(value)) return null;
			return filled(value.label) ? 'words' : filled(value.href) ? 'address' : null;
		case 'media':
			if (!isObject(value)) return null;
			return filled(value.key) ? 'image' : filled(value.video) ? 'clip' : null;
		default:
			return null;
	}
}

/** Each field of `fields` with a value (`values`) and no marker in `marked`. */
export interface UnmarkedOptions {
	/**
	 * A slot (frame) block's own fields (edit in context, Decision 7: links in the frame are left
	 * unmarked so they follow): its links aren't reported, nor the words of an item that is a link
	 * split in two, a text beside an address-only link (a menu item's label and address).
	 */
	frame?: boolean;
	/**
	 * With `frame`: the words the slot draws inside its links and menu controls (`frameLinkPhrases`).
	 * A text field whose words are among them is on the page: a menu built in code, its labels from
	 * the slot's own fields, left unmarked so its links follow.
	 */
	linkPhrases?: ReadonlySet<string>;
}

/** Is `name` in `fields` the words of a frame's link: a text field beside an address-only link? */
const linkWords = (fields: Fields, name: string) =>
	fields[name]?.kind === 'text' && Object.values(fields).some((f) => f.kind === 'link' && f.addressOnly);

export function unmarkedFields(fields: Fields, values: Record<string, unknown>, marked: ReadonlySet<string>, base = '', options: UnmarkedOptions = {}): Unmarked[] {
	const out: Unmarked[] = [];
	const visit = (field: Field, value: unknown, path: string) => {
		if (options.frame && field.kind === 'link') return;
		if (field.kind === 'group') {
			if (isObject(value)) out.push(...unmarkedFields(field.fields, value, marked, path, options));
			return;
		}
		if (field.kind === 'list') {
			if (!Array.isArray(value)) return;
			value.forEach((item, i) => {
				if (field.item) visit(field.item, item, join(path, i));
				else if (field.fields && isObject(item)) out.push(...unmarkedFields(field.fields, item, marked, join(path, i), options));
			});
			return;
		}
		if (field.kind === 'buttons') {
			if (!Array.isArray(value)) return;
			value.forEach((b, i) => {
				if (!isObject(b)) return;
				const what = filled(b.label) ? 'words' : filled(b.href) ? 'address' : null;
				const at = join(path, i);
				if (what && !covered(at, marked)) out.push({ path: at, what });
			});
			return;
		}
		const what = held(field, value);
		if (what === 'words' && field.kind === 'text' && options.frame && options.linkPhrases?.has(words(value as string))) return;
		if (what && !covered(path, marked)) out.push({ path, what });
	};
	for (const [key, field] of Object.entries(fields)) {
		if (options.frame && linkWords(fields, key)) continue;
		visit(field, values[key], join(base, key));
	}
	return out;
}

/** A frame block's link words (labels, and the texts beside its address-only links), anywhere in its data: held inside its root (`unheldPhrases`'s `held`). */
export function frameLinkWords(fields: Fields, values: Record<string, unknown>, into: Set<string> = new Set()): Set<string> {
	for (const [key, field] of Object.entries(fields)) {
		const value = values[key];
		const add = (v: unknown) => {
			if (filled(v)) into.add(words(v as string));
		};
		if (field.kind === 'link' && isObject(value)) add(value.label);
		else if (linkWords(fields, key)) add(value);
		else if (field.kind === 'group' && isObject(value)) frameLinkWords(field.fields, value, into);
		else if (field.kind === 'list' && Array.isArray(value)) {
			for (const item of value) {
				if (field.fields && isObject(item)) frameLinkWords(field.fields, item, into);
				else if (field.item?.kind === 'link' && isObject(item)) add(item.label);
			}
		}
	}
	return into;
}

/**
 * A frame's links and a menu's controls: inside a slot's root they're left unmarked so they follow
 * (edit in context, Decision 7), so their words can't be marked whichever document holds them.
 */
const FRAME_CONTROLS = new Set(['a', 'button', 'summary']);

/** Is `el` inside a link or menu control that is inside one of the slot roots `slots` (`data-cms-source` ids)? */
export function inFrameLink(el: HtmlElement, slots: ReadonlySet<string>): boolean {
	let control = false;
	for (let e: HtmlElement | null = el; e; e = e.parent) {
		if (FRAME_CONTROLS.has(e.tag)) control = true;
		else if (control && slots.has(e.attrs['data-cms-source'] ?? '')) return true;
	}
	return false;
}

/** The words a slot's root (`root`) draws inside its links and menu controls, as phrases, with each control's own `aria-label` (its words to a screen reader). */
export function frameLinkPhrases(root: HtmlElement): Set<string> {
	const out = new Set<string>();
	for (const e of elements(root)) {
		if (!FRAME_CONTROLS.has(e.tag)) continue;
		for (const p of unheldPhrases(e)) out.add(p.words);
		const label = words(e.attrs['aria-label'] ?? '');
		if (label) out.add(label);
	}
	return out;
}

/** Words as a phrase compares them: trimmed, whitespace collapsed. */
export const words = (text: string): string => text.replace(/\s+/g, ' ').trim();

const HOLDS: Record<Unmarked['what'], string> = { words: 'has words', image: 'has an image', clip: 'has a clip', address: 'has an address' };

/** "About › Stats: stats.0.value has words but nothing on the page marks it". */
export const unmarkedMessage = (where: string, u: Unmarked): string => `${where}: ${u.path} ${HOLDS[u.what]} but nothing on the page marks it`;

// ── Decision 17: words no field holds ──────────────────────────────────────────────

/** Elements whose words never count: not drawn as text, or not the visitor's to read. */
const UNREAD = new Set(['head', 'script', 'style', 'svg', 'template', 'noscript', 'iframe', 'object', 'canvas', 'video', 'audio']);
/**
 * Elements a phrase runs through (their words join the words around them): the formatting ones.
 * Any other element starts and ends its own phrase, `<a>` and `<span>` included, since a site
 * often draws them as blocks (a card's kicker, title and line, a pager's "Older post").
 */
const INLINE = new Set(['abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'strong', 'sub', 'sup', 'u', 'var', 'wbr']);

export interface Phrase {
	words: string;
	/** The component that wrote them (Astro's `data-astro-source-file`, or an island's `component-url`; absolute), when the render carries it. */
	source: string | null;
}

export interface UnheldOptions {
	/** More elements to leave out (with everything inside). */
	skip?: (el: HtmlElement) => boolean;
	/** Words that count as held where they're drawn: `el` is the element whose phrase they are. */
	held?: (words: string, el: HtmlElement) => boolean;
}

/** A source root's id (`data-cms-source`), or `page` for the render's own document (a page region, a fields document's root); null for anything else. */
export const rootId = (el: HtmlElement): string | null =>
	has(el, 'data-cms-source') ? el.attrs['data-cms-source']! : has(el, 'data-cms-page') || has(el, 'data-cms-document') ? 'page' : null;

/**
 * A document's title is never marked (it's edited at the top of its form): inside that document's
 * own root (a `cms.of(entry)` root, the page's `data-cms-page`, a fields document's `data-cms-document`,
 * Site Settings' for its brand name)
 * a phrase that is its title is held. `titleOf` gives a root id's title (`page` for the render's own).
 */
export function titleHeld(titleOf: (id: string) => string | undefined): (words: string, el: HtmlElement) => boolean {
	return (phrase, el) => {
		for (let e: HtmlElement | null = el; e; e = e.parent) {
			const id = rootId(e);
			if (id === null) continue;
			const title = titleOf(id);
			if (title !== undefined && words(title) === phrase) return true;
		}
		return false;
	};
}

/**
 * An address as the audit compares them: `href`'s path, read from the page at `from`, decoded and
 * without a trailing slash (`/` stays `/`); null for an in-page anchor, another site's link, or one
 * that can't be read.
 */
export function addressOf(href: string, from = '/'): string | null {
	if (href.startsWith('#')) return null;
	try {
		const url = new URL(href, `http://audit.invalid${from}`);
		if (url.origin !== 'http://audit.invalid') return null;
		const path = decodeURI(url.pathname).replace(/\/+$/, '');
		return path === '' ? '/' : path;
	} catch {
		return null;
	}
}

/** The nearest `<a href>` from `el` up, or null. */
const linkOf = (el: HtmlElement): HtmlElement | null => closest(el, (e) => e.tag === 'a' && has(e, 'href'));

/**
 * A document's title drawn inside a link to that document is held (a nav, a docs sidebar, a pager's
 * next page): the link draws the title, which is edited at the top of its form. `titleAt` gives the
 * title of the document at an address (`addressOf`'s form); `from` is the page's own address.
 */
export function linkedTitleHeld(titleAt: (address: string) => string | undefined, from = '/'): (words: string, el: HtmlElement) => boolean {
	return (phrase, el) => {
		const link = linkOf(el);
		const address = link ? addressOf(link.attrs.href!, from) : null;
		const title = address === null ? undefined : titleAt(address);
		return title !== undefined && words(title) === phrase;
	};
}

/** An element's words, every text inside it joined (`words`'s form). */
const textOf = (el: HtmlElement): string => {
	let out = '';
	const walk = (e: HtmlElement) => {
		for (const child of e.children) {
			if (child.type === 'text') out += child.text;
			else if (child.tag === 'br') out += ' ';
			else if (!UNREAD.has(child.tag) && child.attrs['aria-hidden'] !== 'true') walk(child);
		}
	};
	walk(el);
	return words(out);
};

/**
 * The words of each element with an `id` that a field holds (it's marked, or inside a marked
 * element), by id: a marked heading's anchor, which a table of contents links to.
 */
export function markedAnchors(tree: HtmlElement): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of elements(tree)) {
		const id = e.attrs.id;
		if (!id || out.has(id)) continue;
		if (closest(e, (x) => has(x, 'data-cms-field'))) out.set(id, textOf(e));
	}
	return out;
}

/**
 * Words drawn inside an in-page link (`#id`) that are the words of the element it points to, when a
 * field holds that element (`markedAnchors`), are held: a table of contents repeating a marked heading.
 */
export function anchorHeld(anchors: ReadonlyMap<string, string>): (words: string, el: HtmlElement) => boolean {
	return (phrase, el) => {
		const href = linkOf(el)?.attrs.href;
		if (!href?.startsWith('#')) return false;
		let id = href.slice(1);
		try {
			id = decodeURIComponent(id);
		} catch {
			// Not percent-encoded as a URL would be: compare it as written.
		}
		return anchors.get(id) === phrase;
	};
}

const hasLetter = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** Is `el` left out of the words, with everything in it? */
function unread(el: HtmlElement, options: UnheldOptions): boolean {
	if (UNREAD.has(el.tag)) return true;
	if (el.attrs['aria-hidden'] === 'true') return true;
	if (has(el, 'data-cms-fixed')) return true;
	if ((el.attrs.class ?? '').split(/\s+/).includes('cms-form-hp')) return true;
	return options.skip?.(el) ?? false;
}

/**
 * The words under `from` (the page's `<body>`, or a block's root) that no element carrying
 * `data-cms-field` holds, as phrases: the text of one block-level element, broken where a held
 * or left-out element sits inside it. Being inside a block or source root alone doesn't count.
 */
export function unheldPhrases(from: HtmlElement, options: UnheldOptions = {}): Phrase[] {
	const out: Phrase[] = [];
	type Buffer = { parts: (string | null)[]; source: string | null; el: HtmlElement };
	const flush = (buf: Buffer) => {
		let run = '';
		const end = () => {
			const phrase = words(run);
			if (phrase && hasLetter(phrase) && !options.held?.(phrase, buf.el)) out.push({ words: phrase, source: buf.source });
			run = '';
		};
		for (const part of buf.parts) {
			if (part === null) end();
			else run += part;
		}
		end();
	};
	// The nearest component that wrote them: an Astro element's source annotation, or a framework
	// island's own component (`<astro-island component-url>`: its HTML carries no annotations).
	const sourceOf = (el: HtmlElement) => {
		const at = closest(el, (e) => has(e, 'data-astro-source-file') || (e.tag === 'astro-island' && has(e, 'component-url')));
		return at ? (at.attrs['data-astro-source-file'] ?? at.attrs['component-url']!) : null;
	};
	const walk = (el: HtmlElement, buf: Buffer) => {
		for (const child of el.children) {
			if (child.type === 'text') {
				if (child.text.trim() && buf.source === null) buf.source = sourceOf(el);
				buf.parts.push(child.text);
				continue;
			}
			if (child.tag === 'br') {
				buf.parts.push(' ');
				continue;
			}
			if (unread(child, options) || has(child, 'data-cms-field')) {
				buf.parts.push(null);
				continue;
			}
			if (INLINE.has(child.tag)) walk(child, buf);
			else {
				buf.parts.push(null);
				const own: Buffer = { parts: [], source: null, el: child };
				walk(child, own);
				flush(own);
			}
		}
	};
	if (unread(from, options) || has(from, 'data-cms-field')) return out;
	const top: Buffer = { parts: [], source: null, el: from };
	walk(from, top);
	flush(top);
	return out;
}

/** One render's phrases, with the page they're on. */
export interface PagePhrases {
	page: string;
	phrases: Phrase[];
}

/** "“Talk to Maeve” — 18 pages, in ContactCard", grouped by the words; the most pages first. `relative` names a component's file for `file`. */
export function groupUnheld(renders: readonly PagePhrases[], relative: (source: string) => string = (s) => s): Finding[] {
	const groups = new Map<string, { pages: Set<string>; sources: Set<string> }>();
	for (const { page, phrases } of renders) {
		for (const p of phrases) {
			let g = groups.get(p.words);
			if (!g) groups.set(p.words, (g = { pages: new Set(), sources: new Set() }));
			g.pages.add(page);
			if (p.source) g.sources.add(p.source);
		}
	}
	const name = (source: string) => source.split(/[\\/]/).pop()!.replace(/\.(astro|[cm]?[jt]sx?|vue|svelte)$/, '');
	return [...groups.entries()]
		.sort(([a, x], [b, y]) => y.pages.size - x.pages.size || a.localeCompare(b))
		.map(([words, g]) => {
			const pages = [...g.pages];
			const on = pages.length === 1 ? `on ${pages[0]}` : `${pages.length} pages`;
			const sources = [...g.sources];
			const by = sources.length ? `, in ${sources.map(name).join(', ')}` : '';
			return { kind: 'unheld' as const, ...(sources.length === 1 ? { file: relative(sources[0]!) } : {}), pages, message: `“${words}” — ${on}${by}` };
		});
}

// ── Decision 18: a pageless collection only one block reads ────────────────────────

/** One render's read record, with who each block index is. */
export interface RecordedRender {
	record: ReadRecord;
	/** A block index's reader: `key` tells two blocks apart (a shared block is one, wherever it's placed), `label` names it. Null: not a block. */
	readerOf(index: number): { key: string; label: string } | null;
}

/** The collections each reader read, from every render's record: collection → reader key → label. */
export function readersByCollection(renders: readonly RecordedRender[]): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	const add = (collection: string, reader: { key: string; label: string }) => {
		let readers = out.get(collection);
		if (!readers) out.set(collection, (readers = new Map()));
		readers.set(reader.key, reader.label);
	};
	for (const { record, readerOf } of renders) {
		for (const [index, reads] of Object.entries(record)) {
			const reader = readerOf(Number(index));
			if (!reader) continue;
			for (const collection of Object.keys(reads.lists)) add(collection, reader);
			for (const doc of reads.documents) add(doc.slice(0, doc.indexOf('/')), reader);
		}
	}
	return out;
}

/**
 * The collections a form reads (form rows review fix 2): every `source` of a form's select field or
 * of a rows field's select column. The endpoint reads them, not a block, so they're never one-reader findings.
 */
export function formSourceCollections(forms: Record<string, Pick<ResolvedForm, 'fields'>>): Set<string> {
	const out = new Set<string>();
	for (const form of Object.values(forms)) {
		for (const field of form.fields) {
			if (field.source) out.add(field.source.collection);
			for (const column of field.columns ?? []) if (column.source) out.add(column.source.collection);
		}
	}
	return out;
}

/** The one-reader findings for the site's pageless collections (`name`, `label`), leaving out those a form's `source` names (`formSources`). */
export function oneReader(pageless: readonly { name: string; label: string }[], renders: readonly RecordedRender[], formSources: ReadonlySet<string> = new Set()): Finding[] {
	const readers = readersByCollection(renders);
	const out: Finding[] = [];
	for (const c of pageless) {
		if (formSources.has(c.name)) continue;
		const by = [...(readers.get(c.name)?.values() ?? [])];
		if (by.length === 1) out.push({ kind: 'one-reader', message: `${c.label} is read only by ${by[0]}: a list on the block?` });
		else if (by.length === 0)
			out.push({
				kind: 'one-reader',
				message: `${c.label} is read by no block. Reads by the page component, a slot's own read or Head aren't recorded, so check those before taking it for unused.`,
			});
	}
	return out;
}
