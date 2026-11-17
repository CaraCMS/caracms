/**
 * `pageToMarkdown(entry)`: one caracms page as Markdown, for its `.md` twin and llms-full.txt.
 *
 * The rules (the reader, read.ts, reads exactly these shapes back):
 * - `# Title` first, then the blocks in order, a blank line between.
 * - text: paragraphs, `## h2` / `### h3`, `- ` and `1. ` lists. A line break in a paragraph
 *   is a plain newline. Heading anchors are the Markdown's own (GitHub's slug of each
 *   heading, numbered per page), which is the rule `headingId` gives the rendered ids.
 * - aside: a blockquote opening `**Note:**`, `**Tip:**`, `**Caution:**` or `**Danger:**`.
 * - steps: a numbered list from the block's `start` (1 when unset), a step's later paragraphs
 *   and lists indented under it.
 * - table: a GFM table, padded to its widest row. A cell's paragraphs are joined with
 *   `<br><br>`, its line breaks and list items with `<br>` (a list is flattened to lines:
 *   reported through `options.report`, not an error).
 * - screenshot: with a picture, `![alt](url)` (alt from the image, else "What to capture")
 *   and its caption on the next line in italics; without one, left out.
 * - A block type the writer doesn't know is left out and reported.
 *
 * Assumes the kit's blocks (blocks/): `text { body }`, `aside { kind, body }`,
 * `steps { steps }`, `table { header, rows: { cells } }`, `screenshot { image, capture,
 * caption }`, with values parsed as a `ReadEntry` gives them.
 */
import type { ReadEntry } from 'caracms/document';
import { settingsImageUrl } from 'caracms/content';
import { stepsStart } from '../blocks/steps.ts';
import { escapeMarkdownText, runsToMarkdown, runsPlain, type Run } from './inline.ts';

type RichBlock = { kind: 'p' | 'h2' | 'h3'; runs: Run[] } | { kind: 'ul' | 'ol'; items: Run[][] };
type Rich = RichBlock[];

/** Something the writer had to change to fit Markdown. */
export interface WriterNote {
	block: number;
	kind: 'cell-list-flattened' | 'unknown-block';
	detail: string;
}

export interface PageToMarkdownOptions {
	/** An image value's public URL. Default: caracms's `settingsImageUrl` (the signed media URL), else the key. */
	imageUrl?: (image: { key: string }) => string;
	report?: (note: WriterNote) => void;
}

const LABEL = { note: 'Note', tip: 'Tip', caution: 'Caution', danger: 'Danger' } as const;

/** A line of a paragraph made safe from reading as a block start (`# `, `- `, `1. `, `>`, `|`, `---`). */
export function escapeLineStart(line: string): string {
	return line
		.replace(/^(\s*)([#>+|-])/, (_m, ws: string, c: string) => `${ws}\\${c}`)
		.replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2');
}

const asRich = (v: unknown): Rich => (Array.isArray(v) ? (v as Rich) : []);
const indent = (text: string, by: number) =>
	text
		.split('\n')
		.map((l) => (l === '' ? '' : ' '.repeat(by) + l))
		.join('\n');

/** A paragraph's runs as Markdown lines. */
const paragraph = (runs: Run[]) => runsToMarkdown(runs).split('\n').map(escapeLineStart).join('\n');

/** A list item: its first line after the marker, later lines indented to the marker's width. */
function listItem(marker: string, runs: Run[]): string {
	const lines = paragraph(runs).split('\n');
	return [marker + lines[0], ...lines.slice(1).map((l) => ' '.repeat(marker.length) + l)].join('\n');
}

/** Rich text as Markdown chunks (one per block). */
export function richToMarkdown(value: Rich): string[] {
	const chunks: string[] = [];
	for (const b of value) {
		if ('items' in b) chunks.push(b.items.map((item, i) => listItem(b.kind === 'ul' ? '- ' : `${i + 1}. `, item)).join('\n'));
		else if (b.kind === 'p') chunks.push(paragraph(b.runs));
		else {
			const text = runsToMarkdown(b.runs).replace(/\s*\n\s*/g, ' ');
			if (text) chunks.push(`${b.kind === 'h2' ? '##' : '###'} ${text}`);
		}
	}
	return chunks.filter((c) => c !== '');
}

function aside(kind: unknown, body: Rich): string {
	const label = `**${LABEL[(typeof kind === 'string' && kind in LABEL ? kind : 'note') as keyof typeof LABEL]}:**`;
	const chunks = richToMarkdown(body);
	if (body[0]?.kind === 'p' && chunks.length) chunks[0] = `${label} ${chunks[0]}`;
	else chunks.unshift(label);
	return chunks
		.join('\n\n')
		.split('\n')
		.map((l) => (l === '' ? '>' : `> ${l}`))
		.join('\n');
}

function steps(list: Rich[], start = 1): string {
	return list
		.map((step, i) => {
			const marker = `${start + i}. `;
			const chunks = richToMarkdown(step);
			if (chunks.length === 0) return marker.trimEnd();
			const [first, ...rest] = chunks;
			const head = step[0]?.kind === 'p' ? marker + indent(first!, marker.length).slice(marker.length) : `${marker.trimEnd()}\n${indent(first!, marker.length)}`;
			return [head, ...rest.map((c) => indent(c, marker.length))].join('\n\n');
		})
		.join('\n');
}

function cell(value: Rich, flattened: () => void): string {
	return value
		.map((b) => {
			if ('items' in b) {
				flattened();
				return b.items.map((item, i) => `${b.kind === 'ul' ? '-' : `${i + 1}.`} ${runsToMarkdown(item, { table: true })}`).join('<br>');
			}
			return runsToMarkdown(b.runs, { table: true });
		})
		.map((s) => s.replace(/\n/g, '<br>'))
		.join('<br><br>');
}

function table(header: Rich[], rows: { cells: Rich[] }[], flattened: () => void): string {
	const width = Math.max(1, header.length, ...rows.map((r) => r.cells.length));
	const line = (cells: Rich[]) => {
		const out = Array.from({ length: width }, (_, i) => cell(cells[i] ?? [], flattened));
		return `| ${out.join(' | ')} |`;
	};
	return [line(header), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.map((r) => line(r.cells))].join('\n');
}

function defaultImageUrl(image: { key: string }): string {
	return settingsImageUrl(image) ?? image.key;
}

/** One page as Markdown (see the rules above). */
export function pageToMarkdown(entry: ReadEntry, options: PageToMarkdownOptions = {}): string {
	const report = options.report ?? (() => {});
	const imageUrl = options.imageUrl ?? defaultImageUrl;
	const out: string[] = [`# ${escapeMarkdownText(entry.title)}`];
	const doc = entry.document as { blocks?: { type: string; known: boolean; data: Record<string, unknown> }[] };
	for (const [i, block] of (doc.blocks ?? []).entries()) {
		const d = block.data;
		if (!block.known) {
			report({ block: i, kind: 'unknown-block', detail: `a "${block.type}" block (shared or unknown) is left out` });
			continue;
		}
		switch (block.type) {
			case 'text':
				out.push(...richToMarkdown(asRich(d.body)));
				break;
			case 'aside':
				out.push(aside(d.kind, asRich(d.body)));
				break;
			case 'steps': {
				const list = Array.isArray(d.steps) ? (d.steps as Rich[]) : [];
				if (list.length) out.push(steps(list, stepsStart(d.start)));
				break;
			}
			case 'table': {
				let flat = false;
				const header = Array.isArray(d.header) ? (d.header as Rich[]) : [];
				const rows = Array.isArray(d.rows) ? (d.rows as { cells?: Rich[] }[]).map((r) => ({ cells: Array.isArray(r?.cells) ? r.cells : [] })) : [];
				out.push(table(header, rows, () => (flat = true)));
				if (flat) report({ block: i, kind: 'cell-list-flattened', detail: 'a list in a table cell is written as lines' });
				break;
			}
			case 'screenshot': {
				const image = d.image as { key?: string; alt?: string } | null | undefined;
				if (!image || typeof image.key !== 'string' || !image.key) break;
				const capture = typeof d.capture === 'string' ? d.capture : '';
				const alt = (image.alt ?? '').trim() || capture;
				const url = imageUrl(image as { key: string });
				const caption = typeof d.caption === 'string' ? d.caption.trim() : '';
				out.push(`![${alt.replace(/[\\[\]]/g, (c) => `\\${c}`)}](${url.replace(/ /g, '%20').replace(/\)/g, '%29')})${caption ? `\n*${escapeMarkdownText(caption)}*` : ''}`);
				break;
			}
			default:
				report({ block: i, kind: 'unknown-block', detail: `a "${block.type}" block has no Markdown form and is left out` });
		}
	}
	return `${out.join('\n\n')}\n`;
}

export { runsPlain };
