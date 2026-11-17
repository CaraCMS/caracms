/**
 * Rich text's format (M5a Decision 3): the parser, the serializer and the HTML
 * render, in one browser-safe module the editor (Phase 4) and the render share.
 *
 * ## On disk
 *
 *   "body": [
 *     { "p": "We drew the letters from the old **ferry signs**, see [the print work](/services/print)." },
 *     { "h2": "From the harbour wall\noutward" },
 *     { "ul": ["First point", "Second point"] }
 *   ]
 *
 * Block kinds `p`, `ul`, `ol`, and `h2`/`h3` where the field allows them; never
 * `h1`. Inline: `**bold**`, `*italic*`, `[text](href)`, and `\n` for a break.
 * Marks open and close within one unit (a paragraph, a heading, one list item);
 * bold and italic nest in each other and in a link's text; a link can't hold a link.
 *
 * - **Reading is forgiving** (parseInline): an unpaired `*`, `[` or `]` is literal
 *   text; `\` before `*`, `[`, `]` or `\` makes that character literal.
 * - **Writing is strict** (serializeInline): a literal `*`, `[`, `]` or `\` is
 *   escaped with `\`. In an href, `\` and `)` are escaped the same way.
 * - **A plain string is read as rich text** with its characters literal: one
 *   paragraph per blank-line-separated chunk, single newlines as breaks.
 * - Empty paragraphs, empty list items and empty lists are dropped, and
 *   whitespace (breaks included) at the start or end of a unit is trimmed.
 * - A kind the field doesn't allow reads as `p`, and a link where `links` is off
 *   reads as its text, each with an issue for the field's warning. The file keeps
 *   them until the field is edited (serialize.ts copies untouched fields as read).
 *
 * ## The value (what the editor and the render hold)
 *
 *   [{ kind: 'p', runs: [{ text: 'We drew… ' }, { text: 'ferry signs', bold: true }, …] },
 *    { kind: 'ul', items: [[{ text: 'First point' }], [{ text: 'Second point' }]] }]
 *
 * A unit is a list of text runs, each with its marks, as ProseMirror models text:
 * `bold`, `italic` (present only when true) and `href` (the link's href as typed,
 * present only inside a link). A run's text may hold `\n`, a break. Runs are
 * normalised: none empty, neighbours with the same marks merged, so two values
 * that write the same text compare equal.
 *
 * Round trip: serializeInline(parseInline(s)) === s for any s serializeInline
 * wrote. A hand-written value in another spelling (`**a [b](x) c**` for
 * `**a** [**b**](x) **c**`) reads to the same runs and is kept as written until
 * the field is edited.
 */
import { fileLinkBehaviour } from './files.ts';
import { isLinkHref } from './links.ts';

export type TextKind = 'p' | 'h2' | 'h3';
export type ListKind = 'ul' | 'ol';
export type HeadingKind = 'h2' | 'h3';

export interface TextRun {
	text: string;
	bold?: true;
	italic?: true;
	/** The link's href as typed (it may fail the link rule: then it renders as text). */
	href?: string;
}

export type RichTextBlock = { kind: TextKind; runs: TextRun[] } | { kind: ListKind; items: TextRun[][] };
export type RichTextValue = RichTextBlock[];

/** The stored form: one single-key object per block. */
export type StoredRichTextBlock = { [K in TextKind]?: string } & { [K in ListKind]?: string[] };

export interface RichTextOptions {
	/** The heading kinds the field allows: none, `['h2']` or `['h2', 'h3']`. */
	headings: readonly HeadingKind[];
	/** Whether the field allows links. */
	links: boolean;
	/**
	 * M9 Decision 11: a heading rich-text field. Paragraphs and bold only: a list's items
	 * read as paragraphs (a `disallowed-kind` issue) and italic is dropped (`italic-off`).
	 * Such a field also has no headings and no links.
	 */
	heading?: boolean;
}

/** Something the reader changed or couldn't read, for the field's warning. `block` is the stored entry's index. */
export type RichTextIssue =
	| { code: 'disallowed-kind'; block: number; kind: string }
	| { code: 'link-off'; block: number }
	| { code: 'italic-off'; block: number }
	| { code: 'unreadable'; block: number };

// ── Runs ──────────────────────────────────────────────────────────────────────

function run(text: string, bold: boolean, italic: boolean, href: string | undefined): TextRun {
	const r: TextRun = { text };
	if (bold) r.bold = true;
	if (italic) r.italic = true;
	if (href !== undefined) r.href = href;
	return r;
}

const sameMarks = (a: TextRun, b: TextRun) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && a.href === b.href;

/**
 * Runs in canonical form: no empty text, neighbours with the same marks merged,
 * flags only when true, keys in the order text, bold, italic, href. Takes
 * anything (a value from outside) and never throws.
 */
export function normaliseRuns(input: unknown, options: { links?: boolean } = {}): TextRun[] {
	if (!Array.isArray(input)) return [];
	const out: TextRun[] = [];
	for (const item of input) {
		if (!item || typeof item !== 'object') continue;
		const o = item as Record<string, unknown>;
		if (typeof o.text !== 'string' || o.text === '') continue;
		const href = options.links === false || typeof o.href !== 'string' ? undefined : o.href;
		const next = run(o.text.replace(/\r\n?/g, '\n'), o.bold === true, o.italic === true, href);
		const last = out.at(-1);
		if (last && sameMarks(last, next)) last.text += next.text;
		else out.push(next);
	}
	return settleMarkEdges(out);
}

/**
 * Bold and italic never open just before whitespace or close just after it
 * (breaks included): the reader's flanking rule (a `*` run followed by whitespace
 * can't open, one preceded by whitespace can't close) would refuse that markup.
 * So the mark comes off that whitespace, which moves it outside: `**bold **` is
 * written `**bold** `, and a mark the writer would reopen at a space (to nest
 * under another) starts after it. Worked out on the writer's own plan (planMarks),
 * per link group, until nothing changes; only marks are removed, so it ends.
 * Links keep their whitespace.
 */
function settleMarkEdges(input: TextRun[]): TextRun[] {
	let runs = input;
	const ws = (c: string | undefined) => c !== undefined && /\s/.test(c);
	for (;;) {
		if (!runs.some((r) => (r.bold || r.italic) && /\s/.test(r.text))) return runs;
		const chars = runs.flatMap((r) => r.text.split('').map((c) => ({ c, bold: !!r.bold, italic: !!r.italic, href: r.href })));
		const starts: number[] = [];
		let at = 0;
		for (const r of runs) {
			starts.push(at);
			at += r.text.length;
		}
		starts.push(at);
		let changed = false;
		const strip = (from: number, to: number, step: 1 | -1, marks: Mark[]) => {
			for (let a = from; step === 1 ? a < to : a >= to; a += step) {
				if (!ws(chars[a]!.c)) break;
				for (const m of marks) {
					if (chars[a]![m]) {
						chars[a]![m] = false;
						changed = true;
					}
				}
			}
		};
		let g = 0;
		while (g < runs.length) {
			let h = g;
			while (h < runs.length && runs[h]!.href === runs[g]!.href) h++;
			const plan = planMarks(runs.slice(g, h));
			for (let k = 0; k < h - g; k++) {
				const idx = g + k;
				if (plan.opens[k]!.length > 0) strip(starts[idx]!, starts[idx + 1]!, 1, plan.opens[k]!);
				if (k > 0 && plan.closes[k]!.length > 0) strip(starts[idx]! - 1, starts[idx - 1]!, -1, plan.closes[k]!);
			}
			if (plan.end.length > 0) strip(starts[h]! - 1, starts[h - 1]!, -1, plan.end);
			g = h;
		}
		if (!changed) return runs;
		const out: TextRun[] = [];
		for (const ch of chars) {
			const next = run(ch.c, ch.bold, ch.italic, ch.href);
			const last = out.at(-1);
			if (last && sameMarks(last, next)) last.text += ch.c;
			else out.push(next);
		}
		runs = out;
	}
}

/** Trim whitespace (breaks included) from a unit's start and end, dropping runs that empty. */
export function trimRuns(runs: TextRun[]): TextRun[] {
	const out = runs.map((r) => ({ ...r }));
	while (out.length > 0) {
		const first = out[0]!;
		first.text = first.text.replace(/^\s+/, '');
		if (first.text !== '') break;
		out.shift();
	}
	while (out.length > 0) {
		const last = out.at(-1)!;
		last.text = last.text.replace(/\s+$/, '');
		if (last.text !== '') break;
		out.pop();
	}
	return out;
}

/** The unit's plain text, breaks as `\n`. */
export function runsText(runs: readonly TextRun[]): string {
	return runs.map((r) => r.text).join('');
}

// ── Reading inline markup (forgiving) ─────────────────────────────────────────

const ESCAPABLE = new Set(['*', '[', ']', '\\']);
const PLAIN = /[^*[\]\\]+/y;
/** Steps before the reader gives up on structure and reads the unit as literal text. */
const STEP_LIMIT = 50_000;

interface Ctx {
	bold: boolean;
	italic: boolean;
	/** The open link's id (its `[`'s offset), or null outside a link. */
	link: number | null;
	/** What closes this context: `**`, `*`, the link's `](`, or the end (null). */
	closer: 'bold' | 'italic' | 'link' | null;
	/** Where this context's content starts: a mark or link closes only after some content. */
	start: number;
}

interface RawRun {
	text: string;
	bold: boolean;
	italic: boolean;
	link: number | null;
}

class Budget extends Error {}

/**
 * A unit's inline markup as runs. Forgiving: never throws; an unpaired `*`, `[`
 * or `]` is literal text. When several readings fit, it prefers structure (a
 * pairing over a literal) and, inside italic, a bold opening over closing the
 * italic, which is how serializeInline's output reads back to its own runs.
 */
export function parseInline(src: string): TextRun[] {
	const text = src.replace(/\r\n?/g, '\n');
	// 1. The strict reading that writes back as itself: what serializeInline wrote
	//    reads back to its own runs, even where the delimiters could pair two ways.
	// 2. Any strict reading: every unescaped delimiter paired.
	// 3. The forgiving reading: unpaired delimiters literal.
	const passes: [boolean, ((runs: TextRun[]) => boolean) | null][] = [
		[true, (runs) => serializeInline(runs) === text],
		[true, null],
		[false, null],
	];
	for (const [strict, accept] of passes) {
		try {
			const runs = readStructured(text, strict, accept);
			if (runs) return normaliseRuns(runs);
		} catch (error) {
			if (!(error instanceof Budget) && !(error instanceof RangeError)) throw error;
		}
	}
	return normaliseRuns([{ text: unescapeAll(text) }]);
}

/** Every escape resolved, every delimiter literal: the fallback reading. */
function unescapeAll(src: string): string {
	return src.replace(/\\([*[\]\\])/g, '$1');
}

function readStructured(src: string, strict: boolean, accept: ((runs: TextRun[]) => boolean) | null): TextRun[] | null {
	const out: RawRun[] = [];
	const hrefs = new Map<number, string>();
	let steps = 0;
	const len = src.length;

	// Delimiter runs (CommonMark's flanking, for `*`): a maximal run of unescaped `*`
	// can open only when followed by non-whitespace, and close only when preceded by
	// non-whitespace. So `A * stray` and `**bold **` keep their asterisks literal.
	const escapedAt = new Set<number>();
	for (let i = 0; i < len; i++) {
		if (src[i] === '\\' && i + 1 < len && ESCAPABLE.has(src[i + 1]!)) {
			escapedAt.add(i + 1);
			i++;
		}
	}
	const isDelim = (i: number) => src[i] === '*' && !escapedAt.has(i);
	const runStart = new Int32Array(len);
	const runEnd = new Int32Array(len);
	for (let i = 0; i < len; ) {
		if (!isDelim(i)) {
			i++;
			continue;
		}
		let j = i;
		while (j < len && isDelim(j)) j++;
		for (let q = i; q < j; q++) {
			runStart[q] = i;
			runEnd[q] = j;
		}
		i = j;
	}
	const space = (c: string | undefined) => c === undefined || /\s/.test(c);
	const canOpen = (pos: number) => !space(src[runEnd[pos]!]);
	const canClose = (pos: number) => !space(src[runStart[pos]! - 1]);

	const push = (t: string, ctx: Ctx) => out.push({ text: t, bold: ctx.bold, italic: ctx.italic, link: ctx.link });
	/** Try `attempt`; on failure, put the output back as it was. */
	const tryAlt = (attempt: () => boolean): boolean => {
		const mark = out.length;
		if (attempt()) return true;
		out.length = mark;
		return false;
	};

	/**
	 * Read from `pos` in `ctx` until its closer, then call `k` with the offset after
	 * the closer. True when the whole unit read through (the caller stops there).
	 */
	const seq = (pos: number, ctx: Ctx, k: (pos: number) => boolean): boolean => {
		if (++steps > STEP_LIMIT) throw new Budget();
		if (pos >= len) return ctx.closer === null ? k(pos) : false;
		const c = src[pos]!;

		if (c === '\\') {
			const next = src[pos + 1];
			if (next !== undefined && ESCAPABLE.has(next)) {
				return tryAlt(() => {
					push(next, ctx);
					return seq(pos + 2, ctx, k);
				});
			}
			return tryAlt(() => {
				push('\\', ctx);
				return seq(pos + 1, ctx, k);
			});
		}

		if (c === '*') {
			const double = src[pos + 1] === '*';
			const opens = canOpen(pos);
			const closes = canClose(pos);
			if (double && closes && ctx.closer === 'bold' && pos > ctx.start && tryAlt(() => k(pos + 2))) return true;
			if (double && opens && !ctx.bold && tryAlt(() => seq(pos + 2, { ...ctx, bold: true, closer: 'bold', start: pos + 2 }, (p) => seq(p, ctx, k)))) return true;
			if (closes && ctx.closer === 'italic' && pos > ctx.start && tryAlt(() => k(pos + 1))) return true;
			if (opens && !ctx.italic && tryAlt(() => seq(pos + 1, { ...ctx, italic: true, closer: 'italic', start: pos + 1 }, (p) => seq(p, ctx, k)))) return true;
			if (strict) return false;
			return tryAlt(() => {
				push('*', ctx);
				return seq(pos + 1, ctx, k);
			});
		}

		if (c === '[') {
			if (ctx.link === null) {
				const opened = tryAlt(() =>
					seq(pos + 1, { ...ctx, link: pos, closer: 'link', start: pos + 1 }, (p) => {
						// `p` is just after `](`: the href runs to the first unescaped `)`.
						let href = '';
						let i = p;
						while (i < len && src[i] !== ')') {
							if (src[i] === '\\' && i + 1 < len) {
								href += src[i + 1];
								i += 2;
							} else {
								href += src[i];
								i += 1;
							}
						}
						if (i >= len) return false;
						hrefs.set(pos, href);
						return seq(i + 1, ctx, k);
					}),
				);
				if (opened) return true;
			}
			if (strict) return false;
			return tryAlt(() => {
				push('[', ctx);
				return seq(pos + 1, ctx, k);
			});
		}

		if (c === ']') {
			if (ctx.closer === 'link' && src[pos + 1] === '(' && pos > ctx.start && tryAlt(() => k(pos + 2))) return true;
			if (strict) return false;
			return tryAlt(() => {
				push(']', ctx);
				return seq(pos + 1, ctx, k);
			});
		}

		PLAIN.lastIndex = pos;
		const m = PLAIN.exec(src)!;
		return tryAlt(() => {
			push(m[0], ctx);
			return seq(pos + m[0].length, ctx, k);
		});
	};

	const result = () => out.map((r) => run(r.text, r.bold, r.italic, r.link === null ? undefined : (hrefs.get(r.link) ?? '')));
	const ok = seq(0, { bold: false, italic: false, link: null, closer: null, start: 0 }, () => !accept || accept(normaliseRuns(result())));
	// The forgiving reading always reads through (a literal is always possible).
	return ok ? result() : null;
}

// ── Writing inline markup (strict) ────────────────────────────────────────────

const escapeText = (t: string) => t.replace(/[\\*[\]]/g, (c) => `\\${c}`);
const escapeHref = (h: string) => h.replace(/[\\)]/g, (c) => `\\${c}`);

type Mark = 'bold' | 'italic';

/** Where the writer opens and closes bold and italic over a stretch of runs (one link group). */
interface MarkPlan {
	/** Marks closed just before run `i` (innermost first). */
	closes: Mark[][];
	/** Marks opened just before run `i` (outermost first). */
	opens: Mark[][];
	/** Marks closed after the last run. */
	end: Mark[];
}

/**
 * The writer's nesting: a mark that runs on longer opens first (it's the outer
 * one); bold first on a tie. A mark under one that has to close closes and
 * reopens with it.
 */
function planMarks(runs: readonly TextRun[]): MarkPlan {
	const has = (r: TextRun, m: Mark) => !!r[m];
	const stack: Mark[] = [];
	const plan: MarkPlan = { closes: [], opens: [], end: [] };
	runs.forEach((r, idx) => {
		let keep = 0;
		while (keep < stack.length && has(r, stack[keep]!)) keep++;
		const closed: Mark[] = [];
		while (stack.length > keep) closed.push(stack.pop()!);
		const lasting = (m: Mark) => {
			let n = 0;
			for (let j = idx; j < runs.length && has(runs[j]!, m); j++) n++;
			return n;
		};
		const missing = (['bold', 'italic'] as const).filter((m) => has(r, m) && !stack.includes(m));
		missing.sort((a, b) => lasting(b) - lasting(a));
		stack.push(...missing);
		plan.closes.push(closed);
		plan.opens.push(missing);
	});
	while (stack.length > 0) plan.end.push(stack.pop()!);
	return plan;
}

/** Bold and italic over a stretch of runs, as nested delimiters (planMarks). */
function markText(runs: readonly TextRun[], open: { bold: string; italic: string }, close: { bold: string; italic: string }, body: (t: string) => string): string {
	const plan = planMarks(runs);
	let out = '';
	runs.forEach((r, idx) => {
		for (const m of plan.closes[idx]!) out += close[m];
		for (const m of plan.opens[idx]!) out += open[m];
		out += body(r.text);
	});
	for (const m of plan.end) out += close[m];
	return out;
}

/** Consecutive runs grouped by link: each group is outside any link, or one link's text. */
function linkGroups(runs: readonly TextRun[]): { href: string | undefined; runs: TextRun[] }[] {
	const groups: { href: string | undefined; runs: TextRun[] }[] = [];
	for (const r of runs) {
		const last = groups.at(-1);
		if (last && last.href === r.href) last.runs.push(r);
		else groups.push({ href: r.href, runs: [r] });
	}
	return groups;
}

const MARKS = { bold: '**', italic: '*' };

/** A unit's runs as strict markup: every literal `*`, `[`, `]` and `\` escaped. */
export function serializeInline(input: readonly TextRun[]): string {
	const runs = normaliseRuns(input);
	return linkGroups(runs)
		.map((g) => {
			const inner = markText(g.runs, MARKS, MARKS, escapeText);
			return g.href === undefined ? inner : `[${inner}](${escapeHref(g.href)})`;
		})
		.join('');
}

// ── Blocks ────────────────────────────────────────────────────────────────────

const TEXT_KINDS = new Set<string>(['p', 'h2', 'h3']);
const LIST_KINDS = new Set<string>(['ul', 'ol']);

const allowedText = (kind: string, options: RichTextOptions): TextKind =>
	kind === 'p' || ((kind === 'h2' || kind === 'h3') && options.headings.includes(kind)) ? (kind as TextKind) : 'p';

/** Read one unit, applying `links` (off: hrefs dropped, with a flag) and a heading field's no italic (M9 Decision 11). */
function unit(runs: TextRun[], options: RichTextOptions): { runs: TextRun[]; droppedLink: boolean; droppedItalic: boolean } {
	const droppedLink = !options.links && runs.some((r) => r.href !== undefined);
	const droppedItalic = !!options.heading && runs.some((r) => r.italic);
	const plain = droppedItalic ? runs.map(({ italic: _, ...r }) => r) : runs;
	return { runs: trimRuns(normaliseRuns(plain, { links: options.links })), droppedLink, droppedItalic };
}

/** A plain string as rich text: its characters literal, one paragraph per blank-line chunk, single newlines as breaks. */
export function plainTextToRichText(text: string): RichTextValue {
	return text
		.replace(/\r\n?/g, '\n')
		.split(/\n[ \t]*\n/)
		.map((chunk) => trimRuns([{ text: chunk }]))
		.filter((runs) => runs.length > 0)
		.map((runs) => ({ kind: 'p' as const, runs }));
}

/**
 * A rich-text field's raw value (the file's, or one the editor holds) as its
 * value, with what the reader had to change. Never throws.
 *
 * - A string: plainTextToRichText.
 * - An array: each entry the stored form (`{ "p": "…" }`, `{ "ul": ["…"] }`) or the
 *   value's own form (`{ kind, runs }` / `{ kind, items }`). A single-key entry
 *   whose value is a string is a text block; its kind reads as `p` unless the
 *   field allows it. `ul`/`ol` take an array of strings. Anything else is unreadable
 *   and dropped (kept in the file until the field is edited).
 * - Anything else: empty.
 */
export function readRichText(raw: unknown, options: RichTextOptions): { value: RichTextValue; issues: RichTextIssue[] } {
	const issues: RichTextIssue[] = [];
	if (typeof raw === 'string') return { value: plainTextToRichText(raw), issues };
	if (!Array.isArray(raw)) return { value: [], issues };
	const value: RichTextValue = [];

	raw.forEach((entry, index) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			issues.push({ code: 'unreadable', block: index });
			return;
		}
		const o = entry as Record<string, unknown>;
		let kind: string;
		let units: TextRun[][];
		let list: boolean;

		if (typeof o.kind === 'string' && (Array.isArray(o.runs) || Array.isArray(o.items))) {
			// The value's own form (from the editor).
			kind = o.kind;
			list = LIST_KINDS.has(kind);
			if (list) units = Array.isArray(o.items) ? o.items.map((item) => normaliseRuns(item)) : [];
			else units = [normaliseRuns(o.runs)];
		} else {
			const keys = Object.keys(o);
			if (keys.length !== 1) {
				issues.push({ code: 'unreadable', block: index });
				return;
			}
			kind = keys[0]!;
			const v = o[kind];
			if (LIST_KINDS.has(kind) && Array.isArray(v)) {
				list = true;
				units = v.filter((item): item is string => typeof item === 'string').map(parseInline);
			} else if (!LIST_KINDS.has(kind) && typeof v === 'string') {
				list = false;
				units = [parseInline(v)];
			} else {
				issues.push({ code: 'unreadable', block: index });
				return;
			}
		}

		if ((!list || options.heading) && !(TEXT_KINDS.has(kind) && allowedText(kind, options) === kind)) {
			issues.push({ code: 'disallowed-kind', block: index, kind });
		}
		const read = units.map((u) => unit(u, options));
		if (read.some((u) => u.droppedLink)) issues.push({ code: 'link-off', block: index });
		if (read.some((u) => u.droppedItalic)) issues.push({ code: 'italic-off', block: index });
		const kept = read.map((u) => u.runs).filter((runs) => runs.length > 0);
		if (kept.length === 0) return;
		// M9 Decision 11: a heading field has no lists; each item is a line of its own.
		if (list && options.heading) for (const runs of kept) value.push({ kind: 'p', runs });
		else if (list) value.push({ kind: kind as ListKind, items: kept });
		else value.push({ kind: allowedText(kind, options), runs: kept[0]! });
	});
	return { value, issues };
}

/** readRichText's value alone. */
export function parseRichText(raw: unknown, options: RichTextOptions): RichTextValue {
	return readRichText(raw, options).value;
}

/**
 * A value in the stored form, strict: kinds the field doesn't allow written as
 * `p`, links where `links` is off written as their text, empty units dropped.
 */
export function serializeRichText(value: unknown, options: RichTextOptions): StoredRichTextBlock[] {
	return parseRichText(value, options).map((block): StoredRichTextBlock => {
		if ('items' in block) return { [block.kind]: block.items.map((item) => serializeInline(item)) };
		return { [block.kind]: serializeInline(block.runs) };
	});
}

/** Every href in a value, in order, for the field's link warnings. */
export function richTextHrefs(value: RichTextValue): string[] {
	const hrefs: string[] = [];
	const units = value.flatMap((b) => ('runs' in b ? [b.runs] : b.items));
	for (const runs of units) for (const g of linkGroups(runs)) if (g.href !== undefined) hrefs.push(g.href);
	return hrefs;
}

// ── Render ────────────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const HTML_OPEN = { bold: '<strong>', italic: '<em>' };
const HTML_CLOSE = { bold: '</strong>', italic: '</em>' };
const htmlText = (t: string) => escapeHtml(t).replace(/\n/g, '<br>');

/**
 * The visually hidden note a new-tab file link carries (M6c Decision 11). The package
 * ships no CSS for public pages, so the standard visually-hidden rules are inline.
 */
export const NEW_TAB_NOTE_HTML =
	'<span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0"> (opens in a new tab)</span>';

/**
 * The attributes a file link gets on the site (M6c Decision 11), from
 * `fileLinkBehaviour`: a PDF without `?download` opens in a new tab (and carries
 * `NEW_TAB_NOTE_HTML` inside), any other file link downloads, and every other
 * address gets nothing. `<Link>`, `<Buttons>` and `richTextHtml(…, { fileLinks: true })` share it.
 */
export function fileLinkAttributes(href: string): { attributes: Record<string, string>; newTab: boolean } {
	const behaviour = fileLinkBehaviour(href.trim());
	if (behaviour === 'new-tab') return { attributes: { target: '_blank', rel: 'noopener' }, newTab: true };
	if (behaviour === 'download') return { attributes: { download: '' }, newTab: false };
	return { attributes: {}, newTab: false };
}

/** How `inlineHtml` and `richTextHtml` render. */
export interface RichTextHtmlOptions {
	/**
	 * Mark file links as the site does (Decision 11). Off by default: the editor seeds
	 * Tiptap and mirrors the page from this HTML, and the hidden note would read back
	 * as link text. RichText.astro turns it on.
	 */
	fileLinks?: boolean;
	/**
	 * Heading ids (heading-ids.ts): the `id` of each `h2`/`h3`, in order (`''`: none).
	 * RichText.astro passes its field's from the block's context; the editor's own calls
	 * leave it off.
	 */
	headingIds?: readonly string[];
}

function anchorHtml(href: string, inner: string, options: RichTextHtmlOptions): string {
	const address = href.trim();
	if (!options.fileLinks) return `<a href="${escapeHtml(address)}">${inner}</a>`;
	const { attributes, newTab } = fileLinkAttributes(address);
	const extra = Object.entries(attributes)
		.map(([name, v]) => (v === '' ? ` ${name}` : ` ${name}="${escapeHtml(v)}"`))
		.join('');
	return `<a href="${escapeHtml(address)}"${extra}>${inner}${newTab ? NEW_TAB_NOTE_HTML : ''}</a>`;
}

/** A unit as inline HTML: `<strong>`, `<em>`, `<br>`, and `<a href>` for a link that passes the rule (else its text). */
export function inlineHtml(runs: readonly TextRun[], options: RichTextHtmlOptions = {}): string {
	return linkGroups(normaliseRuns(runs))
		.map((g) => {
			const inner = markText(g.runs, HTML_OPEN, HTML_CLOSE, htmlText);
			return g.href !== undefined && isLinkHref(g.href) ? anchorHtml(g.href, inner, options) : inner;
		})
		.join('');
}

/**
 * A heading rich-text field's value as the inside of its heading tag (M9 Decision 11):
 * each paragraph's inline runs, the paragraphs joined by `<br>`; never a `<p>`.
 */
export function richHeadingHtml(value: RichTextValue, options: RichTextHtmlOptions = {}): string {
	return value.flatMap((block) => ('runs' in block ? [block.runs] : block.items)).map((runs) => inlineHtml(runs, options)).join('<br>');
}

/** A value's plain text, one line per paragraph or item (breaks inside one as `\n`): what reads a rich heading as text. */
export function richTextPlain(value: RichTextValue): string {
	return value.flatMap((block) => ('runs' in block ? [block.runs] : block.items)).map(runsText).join('\n');
}

/**
 * A value as semantic HTML with no classes: `<p>`, `<h2>`, `<h3>`, `<ul>`/`<ol>`
 * with `<li>`. A heading with a break renders as Text's multi-line heading does,
 * the lines joined by `<br>`. With `fileLinks`, file links carry the site's
 * attributes (M6c Decision 11); the editor's own calls leave it off. With `headingIds`,
 * each `h2`/`h3` carries its id (heading-ids.ts).
 */
export function richTextHtml(value: RichTextValue, options: RichTextHtmlOptions = {}): string {
	let heading = 0;
	return value
		.map((block) => {
			if ('items' in block) {
				return `<${block.kind}>${block.items.map((item) => `<li>${inlineHtml(item, options)}</li>`).join('')}</${block.kind}>`;
			}
			const id = block.kind === 'p' ? '' : (options.headingIds?.[heading++] ?? '');
			if (id) return `<${block.kind} id="${escapeHtml(id)}">${inlineHtml(block.runs, options)}</${block.kind}>`;
			return `<${block.kind}>${inlineHtml(block.runs, options)}</${block.kind}>`;
		})
		.join('');
}
