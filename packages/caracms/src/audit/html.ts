/**
 * A small HTML reader for `caracms audit` (review gaps, Decisions 16–17): a rendered page as a
 * tree of elements and text, enough to find markers and the words outside them. The markup is
 * Astro's, well-formed, so this reads tags, attributes, text and comments, with void elements and
 * raw-text elements (script, style, textarea, title); a stray end tag closes back to its opener,
 * or is dropped when nothing open matches it. No dependency: the package ships none for HTML.
 */

export interface HtmlElement {
	type: 'element';
	tag: string;
	attrs: Record<string, string>;
	children: HtmlNode[];
	parent: HtmlElement | null;
}

export interface HtmlText {
	type: 'text';
	text: string;
	parent: HtmlElement;
}

export type HtmlNode = HtmlElement | HtmlText;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', copy: '©' };

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === '#') {
			const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function readAttrs(text: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const m of text.matchAll(ATTR)) {
		const name = m[1]!.toLowerCase();
		if (!Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
	}
	return attrs;
}

/** The document's tree under a root element (`#document`). */
export function parseHtml(html: string): HtmlElement {
	const root: HtmlElement = { type: 'element', tag: '#document', attrs: {}, children: [], parent: null };
	let at = root;
	let i = 0;
	const text = (t: string) => {
		if (t) at.children.push({ type: 'text', text: decodeEntities(t), parent: at });
	};
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		if (lt < 0) {
			text(html.slice(i));
			break;
		}
		text(html.slice(i, lt));
		if (html.startsWith('<!--', lt)) {
			const end = html.indexOf('-->', lt + 4);
			i = end < 0 ? html.length : end + 3;
			continue;
		}
		if (html[lt + 1] === '!' || html[lt + 1] === '?') {
			const end = html.indexOf('>', lt);
			i = end < 0 ? html.length : end + 1;
			continue;
		}
		const close = html[lt + 1] === '/';
		const name = /^[a-zA-Z][^\s/>]*/.exec(html.slice(lt + (close ? 2 : 1)))?.[0];
		if (!name) {
			text('<');
			i = lt + 1;
			continue;
		}
		// The tag's end: the first `>` outside a quoted attribute value.
		let j = lt + (close ? 2 : 1) + name.length;
		let quote = '';
		for (; j < html.length; j++) {
			const c = html[j]!;
			if (quote) {
				if (c === quote) quote = '';
			} else if (c === '"' || c === "'") quote = c;
			else if (c === '>') break;
		}
		const inner = html.slice(lt + (close ? 2 : 1) + name.length, j);
		i = j + 1;
		const tag = name.toLowerCase();
		if (close) {
			for (let e: HtmlElement | null = at; e && e !== root; e = e.parent) {
				if (e.tag === tag) {
					at = e.parent!;
					break;
				}
			}
			continue;
		}
		const el: HtmlElement = { type: 'element', tag, attrs: readAttrs(inner.replace(/\/\s*$/, '')), children: [], parent: at };
		at.children.push(el);
		if (VOID.has(tag) || /\/\s*$/.test(inner)) continue;
		if (RAW.has(tag)) {
			const end = html.toLowerCase().indexOf(`</${tag}`, i);
			const body = html.slice(i, end < 0 ? html.length : end);
			if (body) el.children.push({ type: 'text', text: tag === 'script' || tag === 'style' ? body : decodeEntities(body), parent: el });
			const gt = end < 0 ? -1 : html.indexOf('>', end);
			i = gt < 0 ? html.length : gt + 1;
			continue;
		}
		at = el;
	}
	return root;
}

/** Every element under `root` (not itself), in document order. */
export function* elements(root: HtmlElement): Generator<HtmlElement> {
	for (const child of root.children) {
		if (child.type !== 'element') continue;
		yield child;
		yield* elements(child);
	}
}

/** The nearest element from `el` up (itself included) that `test` accepts, or null. */
export function closest(el: HtmlElement | null, test: (e: HtmlElement) => boolean): HtmlElement | null {
	for (let e = el; e; e = e.parent) if (e.tag !== '#document' && test(e)) return e;
	return null;
}

export const has = (el: HtmlElement, attr: string): boolean => Object.hasOwn(el.attrs, attr);

/** The first element under `root` named `tag`, or null. */
export function find(root: HtmlElement, test: (e: HtmlElement) => boolean): HtmlElement | null {
	for (const e of elements(root)) if (test(e)) return e;
	return null;
}
