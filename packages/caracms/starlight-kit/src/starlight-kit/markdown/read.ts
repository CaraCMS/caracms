/**
 * `markdownToPage(md)`: a Markdown article as a caracms page in the kit's blocks, with a
 * report of every conversion that changed the text's shape. The inverse of write.ts.
 *
 * - `# H1` → the title; the first paragraph straight after it → the description (it stays in
 *   the body too). A second `# H1` becomes an h2 (reported).
 * - Paragraphs, `##`/`###` headings and `- ` lists → text blocks (rich text). `####` and
 *   deeper → h3. A nested list comes straight after its parent item, as a list of its own;
 *   a `- [ ]` checkbox becomes a plain item. A paragraph's lines stay as line breaks.
 * - A blockquote → an aside: a `**Tip:**` lead-in → tip, `**Caution:**`/`**Warning:**` →
 *   caution, `**Danger:**` → danger, anything else → note. The lead-in is dropped only when
 *   it is exactly the kind's own label (Note, Tip, Caution, Danger).
 * - A numbered list → a steps block, a step's indented paragraphs and lists inside it. A
 *   numbered list that doesn't start at 1 (one interrupted by a screenshot) is a new steps
 *   block with that `start`, so it carries on the numbering: reported.
 * - A GFM table → a table block (`<br>` in a cell is a line break, `<br><br>` a new
 *   paragraph); short rows are padded to the widest.
 * - `<!-- screenshot: … -->` → an empty screenshot, its "What to capture" the text.
 *   `![alt](url)` on its own line → an empty screenshot with the alt as "What to capture"
 *   (the image isn't fetched; the URL is reported), an italic line under it the caption.
 * - A setext heading (`Title` over `=====` or `-----`) is read as `#` / `##` (reported).
 *   A closing `#` sequence is stripped from a heading only after a space (`## C#` keeps its #).
 * - Reference-style links (`[text][label]`, `[label][]`, `[label]`) become normal links where
 *   the definition (`[label]: url`) exists; the definition lines are removed. Both reported.
 *   A footnote marker (`[^1]`) or a reference with no definition stays as text, reported.
 * - `~~strike~~` keeps its text, without the tildes (reported; rich text has no strike).
 * - `---` dividers are dropped.
 * - `options.dropLists`: a `##` heading with one of these texts, and the list after it, are
 *   dropped (for a hand-kept table of contents the site's navigation replaces).
 * - Anything else (an HTML block such as `<details>`, a fenced code block, another comment)
 *   is kept as plain text and reported. Nothing is dropped silently.
 *
 * Links are kept as written: rewriting them is the caller's (mapStoredLinks in inline.ts).
 * Assumes the kit's blocks' stored shapes (blocks/).
 */
import { markdownToStored, refLabel, storedToPlain, type InlineNote } from './inline.ts';

export type StoredRich = ({ p: string } | { h2: string } | { h3: string } | { ul: string[] } | { ol: string[] })[];

export type StoredBlock =
	| { type: 'text'; body: StoredRich }
	| { type: 'aside'; kind: 'note' | 'tip' | 'caution' | 'danger'; body: StoredRich }
	| { type: 'steps'; steps: StoredRich[]; start?: number }
	| { type: 'table'; header: StoredRich[]; rows: { cells: StoredRich[] }[] }
	| { type: 'screenshot'; capture: string; caption?: string };

export type ReportKind =
	| 'divider-dropped'
	| 'screenshot-placeholder'
	| 'image-not-fetched'
	| 'blockquote-to-aside'
	| 'list-dropped'
	| 'nested-list'
	| 'checkbox'
	| 'deep-heading'
	| 'extra-h1'
	| 'setext-heading'
	| 'reference-definition'
	| 'item-heading'
	| 'heading-in-aside'
	| 'item-paragraph'
	| 'steps-renumbered'
	| 'table-padded'
	| 'no-description'
	| InlineNote['kind']
	| 'unhandled';

export interface ReportEntry {
	line: number;
	kind: ReportKind;
	was: string;
	became: string;
}

export interface MarkdownPage {
	title: string;
	description: string;
	blocks: StoredBlock[];
	report: ReportEntry[];
}

export interface MarkdownToPageOptions {
	/** `##` heading texts whose heading and following list are dropped (reported). */
	dropLists?: readonly string[];
}

interface Line {
	text: string;
	n: number;
}

const short = (s: string) => {
	const t = s.trim();
	return t.length > 90 ? `${t.slice(0, 87)}…` : t;
};

const BLANK = /^\s*$/;
// A closing `#` sequence counts only after a space (CommonMark): `## Learning C#` keeps its #.
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
// A link reference definition: `[label]: url "title"` (not a footnote, `[^1]: …`).
const REF_DEF = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*<?([^\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const BULLET = /^([-*+])\s+(.*)$/;
const ORDERED = /^(\d+)[.)](?:\s+(.*))?$/;
const DIVIDER = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const SCREENSHOT = /^\s*<!--\s*screenshot:\s*([\s\S]*?)\s*-->\s*$/i;
const IMAGE = /^\s*!\[((?:\\.|[^\]\\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const HTML = /^\s*<(?:[A-Za-z/]|!--)/;
const QUOTE = /^\s{0,3}>/;
const TABLE = /^\s*\|/;
const indentOf = (s: string) => /^ */.exec(s)![0].length;

const unescapeMd = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

class Reader {
	report: ReportEntry[] = [];
	/** Link reference definitions, by `refLabel`. */
	refs = new Map<string, string>();
	note(line: number, kind: ReportKind, was: string, became: string) {
		this.report.push({ line, kind, was: short(was), became });
	}
	inline(src: string, line: number): string {
		return markdownToStored(src, (n) => this.note(line, n.kind, n.was, n.became), this.refs);
	}

	/** Does this line start a block (so a paragraph ends before it)? */
	startsBlock(text: string, inList: boolean): boolean {
		return (
			HEADING.test(text) ||
			BULLET.test(text.trimStart()) ||
			ORDERED.test(text.trimStart()) ||
			DIVIDER.test(text) ||
			FENCE.test(text) ||
			HTML.test(text) ||
			QUOTE.test(text) ||
			(!inList && TABLE.test(text)) ||
			IMAGE.test(text)
		);
	}

	/**
	 * A paragraph starting at `lines[i]`: its lines, the index after it, and, when a setext
	 * underline (`===` or `---`) closes it, that underline (the paragraph is then a heading).
	 */
	paragraph(lines: Line[], i: number, inList: boolean): { para: string[]; next: number; underline?: Line } {
		const para: string[] = [];
		const first = i;
		while (i < lines.length && !BLANK.test(lines[i]!.text) && (para.length === 0 || (!this.startsBlock(lines[i]!.text, inList) && !SETEXT.test(lines[i]!.text)))) {
			para.push(lines[i]!.text.trim());
			i++;
		}
		const underline = i < lines.length && i > first && SETEXT.test(lines[i]!.text) ? lines[i]! : undefined;
		return { para, next: underline ? i + 1 : i, ...(underline ? { underline } : {}) };
	}

	/**
	 * A heading inside rich text (a text-block list item, an aside, a step): `level` is its
	 * `#` count, `src` its inline text, `was` what to report. Returns the unit to push.
	 */
	richHeading(level: number, src: string, n: number, was: string, headings: boolean, where: string): StoredRich[number] {
		const body = this.inline(src, n);
		if (!headings) {
			this.note(n, 'heading-in-aside', was, `a bold paragraph (${where} has no headings)`);
			return { p: `**${body}**` };
		}
		if (level <= 2) {
			if (level === 1) this.note(n, 'extra-h1', was, 'an h2');
			return { h2: body };
		}
		if (level > 3) this.note(n, 'deep-heading', was, 'an h3');
		return { h3: body };
	}

	/**
	 * A list starting at `lines[i]`: its items, each the item's own lines (marker removed,
	 * continuation dedented). Bullets end at a blank line; numbered items continue across
	 * blank lines only when the next number follows on.
	 */
	list(lines: Line[], i: number, ordered: boolean): { items: { lines: Line[]; number: number }[]; next: number } {
		const items: { lines: Line[]; number: number }[] = [];
		const marker = ordered ? ORDERED : BULLET;
		while (i < lines.length) {
			const m = marker.exec(lines[i]!.text);
			if (!m || indentOf(lines[i]!.text) > 0) break;
			const number = ordered ? Number(m[1]) : 0;
			const first = ordered ? (m[2] ?? '') : m[2]!;
			const own: Line[] = [{ text: first, n: lines[i]!.n }];
			i++;
			const rest: Line[] = [];
			while (i < lines.length) {
				const t = lines[i]!.text;
				if (!BLANK.test(t) && indentOf(t) >= 1) {
					rest.push(lines[i]!);
					i++;
					continue;
				}
				if (BLANK.test(t)) {
					let k = i;
					while (k < lines.length && BLANK.test(lines[k]!.text)) k++;
					if (k < lines.length && indentOf(lines[k]!.text) >= 2) {
						for (; i < k; i++) rest.push(lines[i]!);
						continue;
					}
				}
				break;
			}
			const cut = Math.min(...rest.filter((l) => !BLANK.test(l.text)).map((l) => indentOf(l.text)), Infinity);
			for (const l of rest) own.push({ text: BLANK.test(l.text) ? '' : l.text.slice(cut === Infinity ? 0 : cut), n: l.n });
			items.push({ lines: own, number });
			// What follows: another item straight on, or (numbered) after blank lines.
			if (i < lines.length && marker.test(lines[i]!.text) && indentOf(lines[i]!.text) === 0) continue;
			if (ordered && i < lines.length && BLANK.test(lines[i]!.text)) {
				let k = i;
				while (k < lines.length && BLANK.test(lines[k]!.text)) k++;
				const nm = k < lines.length ? ORDERED.exec(lines[k]!.text) : null;
				if (nm && indentOf(lines[k]!.text) === 0 && Number(nm[1]) === number + 1) {
					i = k;
					continue;
				}
			}
			break;
		}
		return { items, next: i };
	}

	/**
	 * Rich-text blocks (paragraphs, headings when allowed, lists) from lines. Anything else
	 * (a quote, a table, HTML) is kept as a plain paragraph and reported.
	 */
	rich(lines: Line[], headings: boolean, where: string): StoredRich {
		const out: StoredRich = [];
		let i = 0;
		while (i < lines.length) {
			const { text, n } = lines[i]!;
			if (BLANK.test(text)) {
				i++;
				continue;
			}
			const h = HEADING.exec(text);
			if (h) {
				out.push(this.richHeading(h[1]!.length, h[2]!, n, text, headings, where));
				i++;
				continue;
			}
			const bullet = BULLET.test(text) && indentOf(text) === 0;
			const ordered = ORDERED.test(text) && indentOf(text) === 0;
			if (bullet || ordered) {
				const { items, next } = this.list(lines, i, ordered);
				this.listBlocks(items, ordered ? 'ol' : 'ul', headings, where, out);
				i = next;
				continue;
			}
			if (indentOf(text) > 0 && (BULLET.test(text.trimStart()) || ORDERED.test(text.trimStart()))) {
				// An indented list with no parent: read it as its own list.
				const base = indentOf(text);
				const block: Line[] = [];
				while (i < lines.length && (BLANK.test(lines[i]!.text) || indentOf(lines[i]!.text) >= base)) {
					block.push({ text: lines[i]!.text.slice(Math.min(base, indentOf(lines[i]!.text))), n: lines[i]!.n });
					i++;
				}
				out.push(...this.rich(block, headings, where));
				continue;
			}
			if (QUOTE.test(text) || TABLE.test(text) || FENCE.test(text) || HTML.test(text) || DIVIDER.test(text) || IMAGE.test(text)) {
				this.note(n, 'unhandled', text, `plain text in ${where}`);
				out.push({ p: this.inline(text.trim().replace(/[\\*[\]]/g, (c) => `\\${c}`), n) });
				i++;
				continue;
			}
			const { para, next, underline } = this.paragraph(lines, i, true);
			i = next;
			if (underline) {
				const level = underline.text.trim().startsWith('=') ? 1 : 2;
				const was = `${para.join(' ')} / ${underline.text.trim()}`;
				this.note(n, 'setext-heading', was, `a ${'#'.repeat(level)} heading`);
				out.push(this.richHeading(level, para.join(' '), n, was, headings, where));
				continue;
			}
			out.push({ p: this.inline(para.join('\n'), n) });
		}
		return out;
	}

	/** A list's items as rich text: each item's own text, and what nests under it straight after. */
	listBlocks(items: { lines: Line[] }[], kind: 'ul' | 'ol', headings: boolean, where: string, out: StoredRich) {
		let current: string[] = [];
		const flush = () => {
			if (current.length) out.push((kind === 'ul' ? { ul: current } : { ol: current }) as StoredRich[number]);
			current = [];
		};
		for (const item of items) {
			const firstLine = item.lines[0]!;
			let first = firstLine.text;
			const box = /^\[( |x|X)\]\s+/.exec(first);
			if (box) {
				first = first.slice(box[0].length);
				this.note(firstLine.n, 'checkbox', `${kind === 'ul' ? '-' : '1.'} ${firstLine.text}`, 'a plain list item');
			}
			const blocks = this.rich([{ text: first, n: firstLine.n }, ...item.lines.slice(1)], headings, where);
			const head = blocks[0];
			if (head && 'p' in head) {
				current.push(head.p);
				blocks.shift();
			} else current.push('');
			if (blocks.length) {
				flush();
				for (const b of blocks) {
					const heading = 'h2' in b || 'h3' in b;
					const at = item.lines.find((l, k) => k > 0 && (heading ? HEADING.test(l.text) || SETEXT.test(l.text) : !BLANK.test(l.text))) ?? item.lines.find((l, k) => k > 0 && !BLANK.test(l.text));
					const line = at?.n ?? firstLine.n;
					if ('ul' in b || 'ol' in b) this.note(line, 'nested-list', at?.text ?? '', 'a list of its own, straight after its parent item');
					else if (heading) this.note(line, 'item-heading', at?.text ?? '', `${'h2' in b ? 'an h2' : 'an h3'} heading after the list (a heading can't sit inside a list item)`);
					else this.note(line, 'item-paragraph', at?.text ?? '', 'a paragraph after the list');
				}
				out.push(...blocks);
			}
		}
		flush();
	}
}

const ASIDE_LEAD = /^\*\*(Note|Tip|Caution|Warning|Danger):\*\*\s*/;

/** A Markdown article as a page (see the rules above). */
export function markdownToPage(md: string, options: MarkdownToPageOptions = {}): MarkdownPage {
	const r = new Reader();
	const lines: Line[] = md.replace(/\r\n?/g, '\n').split('\n').map((text, k) => ({ text: text.replace(/\t/g, '    '), n: k + 1 }));
	// Link reference definitions (`[g]: url`) outside fenced code: collected, and their lines
	// blanked (the links that use them are written as normal links).
	for (let k = 0, fence = ''; k < lines.length; k++) {
		const f = FENCE.exec(lines[k]!.text);
		if (f) fence = fence === '' ? f[1]! : lines[k]!.text.trimStart().startsWith(fence) ? '' : fence;
		if (fence !== '' || f) continue;
		const def = REF_DEF.exec(lines[k]!.text);
		if (!def) continue;
		const label = refLabel(def[1]!);
		if (!r.refs.has(label)) r.refs.set(label, def[2]!);
		r.note(lines[k]!.n, 'reference-definition', lines[k]!.text, 'removed; the links that use it are written as normal links');
		lines[k] = { text: '', n: lines[k]!.n };
	}
	const blocks: StoredBlock[] = [];
	let title = '';
	let description = '';
	let titleLine = 0;
	let afterTitle = false; // the next block is the first after the H1
	const drop = new Set((options.dropLists ?? []).map((s) => s.toLowerCase()));

	const textBody = (): StoredRich => {
		const last = blocks.at(-1);
		if (last?.type === 'text') return last.body;
		const block: StoredBlock = { type: 'text', body: [] };
		blocks.push(block);
		return block.body;
	};

	/** A heading at `lines[at]` (`was` its source): the title, an h2/h3, or a dropped list's heading. Returns the next line. */
	const heading = (level: number, src: string, n: number, was: string, at: number, next = at + 1): number => {
		if (level === 1) {
			if (!title) {
				title = storedToPlain(r.inline(src, n));
				titleLine = n;
				afterTitle = true;
			} else {
				r.note(n, 'extra-h1', was, 'an h2');
				textBody().push({ h2: r.inline(src, n) });
			}
			return next;
		}
		if (level === 2 && drop.has(storedToPlain(r.inline(src, n)).toLowerCase())) {
			let k = next;
			while (k < lines.length && BLANK.test(lines[k]!.text)) k++;
			const ordered = k < lines.length && ORDERED.test(lines[k]!.text);
			const bullet = k < lines.length && BULLET.test(lines[k]!.text);
			if (ordered || bullet) {
				const { items, next: after } = r.list(lines, k, ordered);
				r.note(n, 'list-dropped', `${was} and its list of ${items.length}`, 'dropped (the sidebar is that list)');
				return after;
			}
		}
		const body = r.inline(src, n);
		if (level > 3) r.note(n, 'deep-heading', was, 'an h3');
		textBody().push(level === 2 ? { h2: body } : { h3: body });
		return next;
	};

	let i = 0;
	while (i < lines.length) {
		const { text, n } = lines[i]!;
		if (BLANK.test(text)) {
			i++;
			continue;
		}
		const wasAfterTitle = afterTitle;
		afterTitle = false;

		const h = HEADING.exec(text);
		if (h) {
			i = heading(h[1]!.length, h[2]!, n, text, i);
			continue;
		}
		if (DIVIDER.test(text)) {
			r.note(n, 'divider-dropped', text, 'dropped');
			i++;
			continue;
		}
		const shot = SCREENSHOT.exec(text);
		if (shot) {
			blocks.push({ type: 'screenshot', capture: shot[1]!.trim() });
			r.note(n, 'screenshot-placeholder', text, 'an empty screenshot block');
			i++;
			continue;
		}
		const img = IMAGE.exec(text);
		if (img) {
			const capture = unescapeMd(img[1]!).trim();
			const block: StoredBlock = { type: 'screenshot', capture };
			r.note(n, 'image-not-fetched', text, `an empty screenshot ("${capture}"); the picture at ${img[2]} is to upload`);
			i++;
			const cap = i < lines.length ? /^\s*\*(?!\*)(.*[^*\s])\*\s*$/.exec(lines[i]!.text) ?? /^\s*_(?!_)(.*[^_\s])_\s*$/.exec(lines[i]!.text) : null;
			if (cap) {
				block.caption = unescapeMd(cap[1]!).trim();
				i++;
			}
			blocks.push(block);
			continue;
		}
		if (QUOTE.test(text)) {
			const inner: Line[] = [];
			while (i < lines.length && QUOTE.test(lines[i]!.text)) {
				inner.push({ text: lines[i]!.text.replace(/^\s{0,3}>\s?/, ''), n: lines[i]!.n });
				i++;
			}
			const body = r.rich(inner, false, 'an aside');
			let kind: 'note' | 'tip' | 'caution' | 'danger' = 'note';
			const head = body[0];
			const lead = head && 'p' in head ? ASIDE_LEAD.exec(head.p) : null;
			if (lead) {
				const label = lead[1]!;
				kind = label === 'Tip' ? 'tip' : label === 'Danger' ? 'danger' : label === 'Note' ? 'note' : 'caution';
				if (label !== 'Warning') {
					const rest = (head as { p: string }).p.slice(lead[0].length);
					if (rest) (head as { p: string }).p = rest;
					else body.shift();
				}
			}
			r.note(n, 'blockquote-to-aside', text, `a ${kind} aside${lead ? '' : ' (no kind label)'}`);
			blocks.push({ type: 'aside', kind, body });
			continue;
		}
		if (TABLE.test(text)) {
			const rowsText: Line[] = [];
			while (i < lines.length && TABLE.test(lines[i]!.text)) rowsText.push(lines[i++]!);
			blocks.push(table(r, rowsText));
			continue;
		}
		if (ORDERED.test(text) && indentOf(text) === 0) {
			const { items, next } = r.list(lines, i, true);
			const start = items[0]!.number;
			if (start !== 1) r.note(n, 'steps-renumbered', text, `a new steps block starting at ${start} (the numbering carries on after an interruption)`);
			// `start` after `steps`, the schema's order, as the editor lays a block out.
			blocks.push({ type: 'steps', steps: items.map((it) => r.rich(it.lines, false, 'a step')), ...(start > 1 ? { start } : {}) });
			i = next;
			continue;
		}
		if (BULLET.test(text) && indentOf(text) === 0) {
			const { items, next } = r.list(lines, i, false);
			r.listBlocks(items, 'ul', true, 'a text block', textBody());
			i = next;
			continue;
		}
		if (FENCE.test(text) || HTML.test(text)) {
			const kept: string[] = [];
			if (FENCE.test(text)) {
				const fence = FENCE.exec(text)![1]!;
				kept.push(text);
				i++;
				while (i < lines.length && !lines[i]!.text.trimStart().startsWith(fence)) kept.push(lines[i++]!.text);
				if (i < lines.length) kept.push(lines[i++]!.text);
			} else {
				while (i < lines.length && !BLANK.test(lines[i]!.text)) kept.push(lines[i++]!.text);
			}
			const raw = kept.join('\n');
			r.note(n, 'unhandled', raw.split('\n')[0]!, `kept as plain text (${kept.length} line${kept.length === 1 ? '' : 's'}); rich text has no ${FENCE.test(text) ? 'code block' : 'HTML'}`);
			textBody().push({ p: raw.replace(/[\\*[\]]/g, (c) => `\\${c}`) });
			continue;
		}
		// A paragraph.
		const { para, next, underline } = r.paragraph(lines, i, false);
		i = next;
		if (underline) {
			const level = underline.text.trim().startsWith('=') ? 1 : 2;
			const was = `${para.join(' ')} / ${underline.text.trim()}`;
			r.note(n, 'setext-heading', was, `a ${'#'.repeat(level)} heading`);
			i = heading(level, para.join(' '), n, was, i, i);
			continue;
		}
		const p = r.inline(para.join('\n'), n);
		if (wasAfterTitle) description = storedToPlain(p);
		textBody().push({ p });
	}
	if (title && !description) r.note(titleLine, 'no-description', `# ${title}`, 'no description (no paragraph straight after the title)');
	return { title, description, blocks, report: r.report };
}

/** Split a GFM table row on unescaped pipes, without the outer ones. */
function cellsOf(row: string): string[] {
	const cells: string[] = [];
	let cur = '';
	const s = row.trim().replace(/^\|/, '');
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (c === '\\' && s[i + 1] === '|') {
			cur += '|';
			i++;
		} else if (c === '\\') {
			cur += c + (s[i + 1] ?? '');
			i++;
		} else if (c === '|') {
			cells.push(cur);
			cur = '';
		} else cur += c;
	}
	if (cur.trim() !== '') cells.push(cur);
	return cells.map((c) => c.trim());
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function table(r: Reader, rows: Line[]): StoredBlock {
	const cellRich = (src: string, n: number): StoredRich =>
		src === ''
			? []
			: src
					.split(/<br\s*\/?>\s*<br\s*\/?>/i)
					.map((p) => ({ p: r.inline(p.replace(/<br\s*\/?>/gi, '\n').replace(/[ \t]*\n[ \t]*/g, '\n').trim(), n) }))
					.filter((b) => b.p !== '');
	let header: string[] = [];
	let body = rows;
	if (rows.length >= 2 && SEPARATOR.test(rows[1]!.text)) {
		header = cellsOf(rows[0]!.text);
		body = rows.slice(2);
	} else {
		r.note(rows[0]!.n, 'unhandled', rows[0]!.text, 'a table with no header row: read with an empty header');
	}
	const bodyCells = body.map((l) => cellsOf(l.text));
	const width = Math.max(header.length, ...bodyCells.map((c) => c.length));
	const pad = (cells: string[], n: number, what: string) => {
		if (cells.length < width) {
			r.note(n, 'table-padded', what, `padded from ${cells.length} to ${width} cells`);
			return [...cells, ...Array(width - cells.length).fill('')];
		}
		return cells;
	};
	return {
		type: 'table',
		header: pad(header, rows[0]!.n, rows[0]!.text).map((c) => cellRich(c, rows[0]!.n)),
		rows: bodyCells.map((cells, k) => ({ cells: pad(cells, body[k]!.n, body[k]!.text).map((c) => cellRich(c, body[k]!.n)) })),
	};
}
