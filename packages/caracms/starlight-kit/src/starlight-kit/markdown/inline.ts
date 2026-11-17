/**
 * Inline text between Markdown and caracms rich text, both ways.
 *
 * caracms stores a rich-text unit as a string in its own inline syntax (`**bold**`,
 * `*italic*`, `[text](href)`, with `\*`, `\[`, `\]` and `\\` as the only escapes), and
 * hands a render the same unit parsed as runs (`{ text, bold?, italic?, href? }`).
 *
 * - `runsToMarkdown(runs)`: parsed runs → Markdown (CommonMark/GFM inline). Escapes every
 *   character Markdown would read as syntax, so the reader below gets the same text back.
 * - `markdownToStored(src, note)`: Markdown inline → the stored string. Bold, italic (`*` or
 *   `_`) and links carry over; Markdown escapes the stored syntax doesn't have are undone
 *   (`\_` → `_`); a literal `[` or `]` is escaped. What rich text can't hold is turned into
 *   plain text and passed to `note` (inline code, an inline image, an HTML tag,
 *   `~~strike~~`, a footnote marker, a reference with no definition), never dropped. A
 *   reference-style link (`[text][label]`, `[label][]`, `[label]`) whose definition is in
 *   `refs` becomes a normal link (noted).
 * - `storedToPlain(s)`: a stored string as plain text (for a description or a title).
 * - `mapStoredLinks(s, fn)`: rewrite (or unlink) the links in a stored string.
 *
 * Assumes rich text's inline model: bold, italic and links only (no inline code).
 */

/** One run of parsed rich text, as caracms's `ReadEntry` gives it. */
export interface Run {
	text: string;
	bold?: boolean;
	italic?: boolean;
	href?: string;
}

/** What the inline reader couldn't carry over as it was. */
export interface InlineNote {
	kind: 'inline-code' | 'inline-image' | 'html-tag' | 'strikethrough' | 'reference-link' | 'footnote' | 'unresolved-reference';
	was: string;
	became: string;
}

const STORED_ESCAPES = new Set(['*', '[', ']', '\\']);
const PUNCT = /[!-/:-@[-`{-~]/;

// ── Writing Markdown ──────────────────────────────────────────────────────────

/** Escape plain text for Markdown inline. `table` also escapes `|`. */
export function escapeMarkdownText(text: string, options: { table?: boolean } = {}): string {
	let out = text.replace(/[\\*_[\]`]/g, (c) => `\\${c}`).replace(/<(?=[A-Za-z/!?])/g, '\\<');
	if (options.table) out = out.replace(/\|/g, '\\|');
	return out;
}

/** An href as a Markdown link destination: spaces and parentheses percent-encoded. */
const markdownHref = (href: string) => href.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

type Mark = 'bold' | 'italic';
const MARK = { bold: '**', italic: '*' } as const;

/** One link group's runs as Markdown: marks opened and closed as the runs change, whitespace kept outside them. */
function groupMarkdown(runs: readonly Run[], table: boolean): string {
	let out = '';
	const stack: Mark[] = [];
	let pending = '';
	for (const run of runs) {
		const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text)!;
		const [, lead, core, trail] = m as unknown as [string, string, string, string];
		if (core === '') {
			pending += run.text;
			continue;
		}
		const needed = new Set<Mark>([...(run.bold ? (['bold'] as const) : []), ...(run.italic ? (['italic'] as const) : [])]);
		const firstStale = stack.findIndex((mk) => !needed.has(mk));
		if (firstStale !== -1) while (stack.length > firstStale) out += MARK[stack.pop()!];
		out += escapeMarkdownText(pending + lead, { table });
		pending = '';
		for (const mk of ['bold', 'italic'] as const) {
			if (needed.has(mk) && !stack.includes(mk)) {
				stack.push(mk);
				out += MARK[mk];
			}
		}
		out += escapeMarkdownText(core, { table });
		pending = trail;
	}
	while (stack.length) out += MARK[stack.pop()!];
	return out + escapeMarkdownText(pending, { table });
}

/** Parsed runs as Markdown inline. Line breaks stay `\n`; the caller lays out lines. */
export function runsToMarkdown(runs: readonly Run[], options: { table?: boolean } = {}): string {
	let out = '';
	let i = 0;
	while (i < runs.length) {
		const href = runs[i]!.href;
		let j = i;
		while (j < runs.length && runs[j]!.href === href) j++;
		const inner = groupMarkdown(runs.slice(i, j), !!options.table);
		out += href === undefined ? inner : `[${inner}](${markdownHref(href)})`;
		i = j;
	}
	return out;
}

/** Plain text of runs (a heading's, a description's). */
export const runsPlain = (runs: readonly Run[]) => runs.map((r) => r.text).join('');

// ── Reading Markdown ──────────────────────────────────────────────────────────

/** Escape plain text for the stored inline syntax. */
export const escapeStored = (text: string) => text.replace(/[\\*[\]]/g, (c) => `\\${c}`);

/** The index of the `]` closing the `[` at `open`, skipping escapes and nested brackets; -1 if none. */
function closingBracket(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '\\') {
			i++;
			continue;
		}
		if (c === '`') {
			const close = src.indexOf('`', i + 1);
			if (close !== -1) i = close;
			continue;
		}
		if (c === '[') depth++;
		else if (c === ']' && --depth === 0) return i;
	}
	return -1;
}

/** A link destination at `at` (just after `](`... i.e. at the `(`): its href and the index after `)`, or null. */
function destination(src: string, at: number): { href: string; end: number } | null {
	if (src[at] !== '(') return null;
	if (src[at + 1] === '<') {
		const close = src.indexOf('>)', at + 2);
		return close === -1 ? null : { href: src.slice(at + 2, close), end: close + 2 };
	}
	let depth = 0;
	for (let i = at + 1; i < src.length; i++) {
		const c = src[i]!;
		if (c === '\\') {
			i++;
			continue;
		}
		if (/\s/.test(c)) {
			// A title (`[t](href "title")`) isn't kept: rich text has none.
			const close = src.indexOf(')', i);
			return close === -1 ? null : { href: src.slice(at + 1, i), end: close + 1 };
		}
		if (c === '(') depth++;
		else if (c === ')') {
			if (depth === 0) return { href: src.slice(at + 1, i), end: i + 1 };
			depth--;
		}
	}
	return null;
}

/** A reference label as definitions and uses compare it: case-folded, whitespace collapsed. */
export const refLabel = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

const wordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * Markdown inline → the stored string. `note` hears about anything rich text can't hold
 * (which is kept as plain text).
 */
export function markdownToStored(src: string, note: (n: InlineNote) => void = () => {}, refs?: ReadonlyMap<string, string>): string {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		if (c === '\\') {
			const next = src[i + 1];
			if (next === undefined || next === '\n') {
				out += next === '\n' ? '\n' : '\\\\';
				i += 2;
			} else if (STORED_ESCAPES.has(next)) {
				out += `\\${next}`;
				i += 2;
			} else if (PUNCT.test(next)) {
				out += next;
				i += 2;
			} else {
				out += '\\\\';
				i += 1;
			}
			continue;
		}
		if (c === '`') {
			const run = /^`+/.exec(src.slice(i))![0];
			const close = src.indexOf(run, i + run.length);
			if (close !== -1) {
				const code = src.slice(i + run.length, close);
				const text = code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code;
				note({ kind: 'inline-code', was: src.slice(i, close + run.length), became: text });
				out += escapeStored(text);
				i = close + run.length;
				continue;
			}
			out += run;
			i += run.length;
			continue;
		}
		if (c === '!' && src[i + 1] === '[') {
			const close = closingBracket(src, i + 1);
			const dest = close === -1 ? null : destination(src, close + 1);
			if (dest) {
				const alt = src.slice(i + 2, close);
				note({ kind: 'inline-image', was: src.slice(i, dest.end), became: `its alt text, "${alt}"` });
				out += markdownToStored(alt, note, refs);
				i = dest.end;
				continue;
			}
			out += '!';
			i += 1;
			continue;
		}
		if (c === '[') {
			const close = closingBracket(src, i);
			const dest = close === -1 ? null : destination(src, close + 1);
			if (dest) {
				out += `[${markdownToStored(src.slice(i + 1, close), note, refs)}](${dest.href})`;
				i = dest.end;
				continue;
			}
			if (close !== -1) {
				const inner = src.slice(i + 1, close);
				if (inner.startsWith('^') && !/\s/.test(inner)) {
					const was = src.slice(i, close + 1);
					note({ kind: 'footnote', was, became: 'kept as the text, with no footnote' });
					out += escapeStored(was);
					i = close + 1;
					continue;
				}
				if (src[close + 1] === '[') {
					const close2 = closingBracket(src, close + 1);
					if (close2 !== -1) {
						const was = src.slice(i, close2 + 1);
						const label = close2 === close + 2 ? inner : src.slice(close + 2, close2);
						const href = refs?.get(refLabel(label));
						if (href !== undefined) {
							note({ kind: 'reference-link', was, became: `a normal link to ${href}` });
							out += `[${markdownToStored(inner, note, refs)}](${href})`;
						} else {
							note({ kind: 'unresolved-reference', was, became: `kept as text; no definition for [${label}]` });
							out += escapeStored(was);
						}
						i = close2 + 1;
						continue;
					}
				}
				const href = refs?.get(refLabel(inner));
				if (href !== undefined) {
					note({ kind: 'reference-link', was: src.slice(i, close + 1), became: `a normal link to ${href}` });
					out += `[${markdownToStored(inner, note, refs)}](${href})`;
					i = close + 1;
					continue;
				}
			}
			out += '\\[';
			i += 1;
			continue;
		}
		if (c === ']') {
			out += '\\]';
			i += 1;
			continue;
		}
		if (c === '_') {
			// `_italic_` / `__bold__` at word edges (an underscore inside a word is literal).
			const run = src.startsWith('__', i) ? '__' : '_';
			const before = src[i - 1];
			const after = src[i + run.length];
			if (!wordChar(before) && after !== undefined && !/\s/.test(after)) {
				let close = i + run.length;
				while ((close = src.indexOf(run, close + 1)) !== -1) {
					if (src[close - 1] !== '\\' && !/\s/.test(src[close - 1]!) && !wordChar(src[close + run.length])) break;
				}
				if (close !== -1) {
					const mark = run === '__' ? '**' : '*';
					out += mark + markdownToStored(src.slice(i + run.length, close), note, refs) + mark;
					i = close + run.length;
					continue;
				}
			}
			out += run;
			i += run.length;
			continue;
		}
		if (c === '~' && src.startsWith('~~', i) && src[i + 2] !== '~') {
			const close = src.indexOf('~~', i + 2);
			const inner = close === -1 ? '' : src.slice(i + 2, close);
			if (inner !== '' && inner.trim() === inner) {
				note({ kind: 'strikethrough', was: src.slice(i, close + 2), became: 'the text without the strike-through (rich text has none)' });
				out += markdownToStored(inner, note, refs);
				i = close + 2;
				continue;
			}
		}
		if (c === '<') {
			const tag = /^<\/?[A-Za-z][^>\n]*>|^<!--[\s\S]*?-->/.exec(src.slice(i));
			if (tag) {
				note({ kind: 'html-tag', was: tag[0], became: 'the same characters, as plain text' });
				out += escapeStored(tag[0]);
				i += tag[0].length;
				continue;
			}
		}
		out += c;
		i += 1;
	}
	return out;
}

/** A stored string as plain text: marks and link syntax gone, escapes undone. */
export function storedToPlain(s: string): string {
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (c === '\\' && i + 1 < s.length) out += s[++i];
		else if (c === '*') continue;
		else if (c === '[') continue;
		else if (c === ']' && s[i + 1] === '(') {
			const close = s.indexOf(')', i);
			i = close === -1 ? s.length : close;
		} else out += c;
	}
	return out.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Rewrite each link in a stored string. `fn` returns the new href, or null to unlink (the
 * link's text stays, as text).
 */
export function mapStoredLinks(s: string, fn: (href: string) => string | null): string {
	const opens: number[] = [];
	const edits: { from: number; to: number; text: string }[] = [];
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '\\') {
			i++;
			continue;
		}
		if (c === '[') opens.push(i);
		else if (c === ']' && opens.length && s[i + 1] === '(') {
			const open = opens.pop()!;
			const close = s.indexOf(')', i + 2);
			if (close === -1) continue;
			const href = s.slice(i + 2, close);
			const next = fn(href);
			if (next === null) {
				edits.push({ from: open, to: open + 1, text: '' }, { from: i, to: close + 1, text: '' });
			} else if (next !== href) {
				edits.push({ from: i + 2, to: close, text: next });
			}
			i = close;
		}
	}
	let out = s;
	for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
	return out;
}

/** Every link's href in a stored string, in order. */
export function storedLinks(s: string): string[] {
	const hrefs: string[] = [];
	mapStoredLinks(s, (href) => {
		hrefs.push(href);
		return href;
	});
	return hrefs;
}
