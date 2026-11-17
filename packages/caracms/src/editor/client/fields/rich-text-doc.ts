/**
 * Rich text's value (rich-text.ts: blocks of runs) and the editor's ProseMirror
 * document (JSON), both ways. Pure, so it's tested in node.
 *
 *   p          ↔ paragraph
 *   h2, h3     ↔ heading { level }
 *   ul, ol     ↔ bulletList / orderedList of listItem, each a textblock (its text
 *                directly, as `<li>` holds it); `fromDoc` also reads an item holding
 *                paragraphs, the shape before on-page rich text
 *   a run      ↔ text with marks bold, italic, link { href }
 *   "\n"       ↔ hardBreak (Shift+Enter: a break inside the paragraph, heading or item)
 *
 * A heading field (M9 Decision 11, `options.heading`) has no blocks: its document's
 * content is inline, as its heading tag holds it, each paragraph a line, the lines
 * joined by hardBreaks. Read back, every break starts a paragraph.
 *
 * `fromDoc` reads back through Phase 1's `parseRichText`, so what the store holds
 * is always the field's own value: empty paragraphs, items and lists dropped,
 * breaks at a unit's start or end trimmed, kinds the field doesn't allow as `p`,
 * links dropped where the field has them off (Decision 3).
 */
import { parseRichText, type RichTextOptions, type RichTextValue, type TextRun } from '../../../rich-text.ts';

export interface PMMark {
	type: 'bold' | 'italic' | 'link';
	attrs?: { href: string };
}

export interface PMNode {
	type: string;
	attrs?: Record<string, unknown>;
	content?: PMNode[];
	text?: string;
	marks?: PMMark[];
}

function marksOf(run: TextRun): PMMark[] | undefined {
	const marks: PMMark[] = [];
	if (run.bold) marks.push({ type: 'bold' });
	if (run.italic) marks.push({ type: 'italic' });
	if (run.href !== undefined) marks.push({ type: 'link', attrs: { href: run.href } });
	return marks.length ? marks : undefined;
}

/** A unit's runs as inline nodes: text with marks, and a hardBreak for each `\n`. */
export function inlineNodes(runs: readonly TextRun[]): PMNode[] {
	const out: PMNode[] = [];
	for (const run of runs) {
		const marks = marksOf(run);
		run.text.split('\n').forEach((part, i) => {
			if (i > 0) out.push({ type: 'hardBreak' });
			if (part !== '') out.push(marks ? { type: 'text', text: part, marks } : { type: 'text', text: part });
		});
	}
	return out;
}

const textblock = (type: string, runs: readonly TextRun[], attrs?: Record<string, unknown>): PMNode => {
	const content = inlineNodes(runs);
	return { type, ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) };
};

/** A value as the editor's document. Never empty: an empty value is one empty paragraph (a heading's: no content). */
export function toDoc(value: RichTextValue, options?: Pick<RichTextOptions, 'heading'>): PMNode {
	if (options?.heading) {
		const lines = value.flatMap((block) => ('items' in block ? block.items : [block.runs]));
		const content = lines.flatMap((runs, i) => [...(i > 0 ? [{ type: 'hardBreak' }] : []), ...inlineNodes(runs)]);
		return { type: 'doc', ...(content.length ? { content } : {}) };
	}
	const content: PMNode[] = value.map((block) => {
		if ('items' in block) {
			return {
				type: block.kind === 'ol' ? 'orderedList' : 'bulletList',
				content: block.items.map((runs) => textblock('listItem', runs)),
			};
		}
		if (block.kind === 'h2' || block.kind === 'h3') return textblock('heading', block.runs, { level: block.kind === 'h2' ? 2 : 3 });
		return textblock('paragraph', block.runs);
	});
	return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Inline nodes as runs: a hardBreak is a `\n` (with no marks). */
export function runsOf(content: readonly PMNode[] | undefined): TextRun[] {
	const runs: TextRun[] = [];
	for (const node of content ?? []) {
		if (node.type === 'hardBreak') {
			runs.push({ text: '\n' });
			continue;
		}
		if (node.type !== 'text' || !node.text) continue;
		const run: TextRun = { text: node.text };
		for (const mark of node.marks ?? []) {
			if (mark.type === 'bold') run.bold = true;
			else if (mark.type === 'italic') run.italic = true;
			else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') run.href = mark.attrs.href;
		}
		runs.push(run);
	}
	return runs;
}

/** Runs split at each `\n`: a heading field's lines (M9 Decision 11). */
export function splitLines(runs: readonly TextRun[]): TextRun[][] {
	const lines: TextRun[][] = [[]];
	for (const run of runs) {
		run.text.split('\n').forEach((part, i) => {
			if (i > 0) lines.push([]);
			if (part !== '') lines.at(-1)!.push({ ...run, text: part });
		});
	}
	return lines;
}

const isBlock = (node: PMNode) => node.type === 'paragraph' || node.type === 'heading';

/**
 * A list item's runs: its inline content (a textblock item), or, in the older shape,
 * its paragraphs joined by breaks should it hold more than one.
 */
const itemRuns = (item: PMNode): TextRun[] => {
	const content = item.content ?? [];
	if (!content.some(isBlock)) return runsOf(content);
	return content.filter(isBlock).flatMap((child, i) => [...(i > 0 ? [{ text: '\n' }] : []), ...runsOf(child.content)]);
};

/** The editor's document as the field's value (normalised by the field's rules). */
export function fromDoc(doc: PMNode, options: RichTextOptions): RichTextValue {
	if (options.heading) {
		// A heading's document is inline (or, from older content, paragraphs): each line a paragraph.
		const content = (doc.content ?? []).some(isBlock) ? (doc.content ?? []).filter(isBlock).flatMap((child, i) => [...(i > 0 ? [{ type: 'hardBreak' }] : []), ...(child.content ?? [])]) : doc.content;
		return parseRichText(splitLines(runsOf(content)).map((runs) => ({ kind: 'p', runs })), options);
	}
	const blocks: unknown[] = [];
	for (const node of doc.content ?? []) {
		if (node.type === 'paragraph') blocks.push({ kind: 'p', runs: runsOf(node.content) });
		else if (node.type === 'heading') blocks.push({ kind: node.attrs?.level === 3 ? 'h3' : 'h2', runs: runsOf(node.content) });
		else if (node.type === 'bulletList' || node.type === 'orderedList') {
			blocks.push({ kind: node.type === 'orderedList' ? 'ol' : 'ul', items: (node.content ?? []).map(itemRuns) });
		}
	}
	return parseRichText(blocks, options);
}

/**
 * Pasted plain text (Spec → Text): a blank line starts a new paragraph, a single
 * newline is a break. The paragraphs' inline content, one array per paragraph.
 */
export function pastedParagraphs(text: string): PMNode[][] {
	return text
		.replace(/\r\n?/g, '\n')
		.split(/\n[ \t]*\n/)
		.map((chunk) => chunk.replace(/^\n+|\n+$/g, ''))
		.filter((chunk) => chunk.trim() !== '')
		.map((chunk) => inlineNodes([{ text: chunk }]));
}
