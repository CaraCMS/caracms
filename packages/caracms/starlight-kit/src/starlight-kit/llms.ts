/**
 * The Markdown side of the site: which pages have a `.md` twin, and the
 * text of `/llms.txt` and `/llms-full.txt`, all from the page JSON through CaraCMS's reader.
 *
 * - Every public page has a twin at its address plus `.md`; Home's is `/index.md`.
 * - `/llms.txt`: Home's title as the H1, its description as the summary, then every page as
 *   a link to its `.md` with its description, grouped and ordered like the sidebar.
 * - `/llms-full.txt`: every page's Markdown, Home first, then sidebar order.
 * - Hidden pages, and pages under them, are in none of these (sidebar.ts → sidebarPages).
 *
 * Assumes: a nested `pages` collection with `urlBase: '/'` and a Home page (`index`).
 * Nothing here is site-specific: the site's name and summary are Home's title and description.
 */
import type { DocumentReader, ReadEntry } from 'caracms/document';
import type { WriterNote } from './markdown/write.ts';
import { sidebarFrom, sidebarPages, type SidebarItem, type SidebarOptions } from './sidebar.ts';

/** The kit's Markdown writer, passed in (writer.ts gives the real one), so this file runs in plain Node. */
export type PageToMarkdown = (entry: ReadEntry) => string;

export const MARKDOWN_HEADERS = { 'Content-Type': 'text/markdown; charset=utf-8' };
export const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8' };

/** A page's description on one line (a line break would end a list item or a quote). */
export const descriptionOf = (entry: ReadEntry): string => ((entry.document as { seo?: { description?: string } }).seo?.description ?? '').replace(/\s+/g, ' ').trim();

/** Link text with its brackets (and backslashes) escaped, so a title can't end the link early. */
export const escapeLinkText = (text: string): string => text.replace(/[\\[\]]/g, (c) => `\\${c}`);

const warned = new Set<string>();

/**
 * A `report` for `pageToMarkdown` (the writer's notes are not dropped):
 * each note is printed once at build with `console.warn`, naming the page and what happened.
 * The `.md` twin and llms-full.txt write the same page, so the same note is not repeated.
 */
export function warnWriterNotes(entry: ReadEntry, warn: (message: string) => void = console.warn): (note: WriterNote) => void {
	return (note) => {
		const message = `[markdown] ${entry.url ?? entry.path}: ${note.detail} (block ${note.block + 1}, ${note.kind})`;
		if (warned.has(message)) return;
		warned.add(message);
		warn(message);
	};
}

/** A page's `.md` address: its own plus `.md`, Home's `/index.md`. */
export const markdownUrl = (url: string): string => (url === '/' ? '/index.md' : `${url}.md`);

/** Every page with a `.md` twin, Home first, then sidebar order. */
export async function markdownPages(read: DocumentReader): Promise<ReadEntry[]> {
	const home = await read.document('pages', 'index');
	return [...(home?.url ? [home] : []), ...(await sidebarPages(read))];
}

export async function llmsTxt(read: DocumentReader, options: SidebarOptions = {}): Promise<string> {
	const home = await read.document('pages', 'index');
	const pages = await sidebarPages(read);
	const byUrl = new Map(pages.map((p) => [p.url!, p]));
	const line = (entry: ReadEntry, indent = '') => {
		const description = descriptionOf(entry);
		return `${indent}- [${escapeLinkText(entry.title)}](${markdownUrl(entry.url!)})${description ? `: ${description}` : ''}`;
	};
	const list = (items: SidebarItem[], indent = ''): string[] =>
		items.flatMap((item) => {
			if ('link' in item) {
				const entry = byUrl.get(item.link);
				return entry ? [line(entry, indent)] : [];
			}
			return [`${indent}- ${item.label}`, ...list(item.items, `${indent}  `)];
		});
	const sidebar = await sidebarFrom(read, options);
	const out: string[] = [`# ${home?.title ?? 'Pages'}`];
	if (home && descriptionOf(home)) out.push(`> ${descriptionOf(home)}`);
	// Home and the top-level pages outside any group come first, then one section per group.
	const loose = sidebar.filter((item) => 'link' in item);
	const top = [...(home?.url ? [line(home)] : []), ...list(loose)];
	if (top.length) out.push(top.join('\n'));
	for (const item of sidebar) if (!('link' in item)) out.push(`## ${item.label}\n\n${list(item.items).join('\n')}`);
	return out.join('\n\n') + '\n';
}

export async function llmsFullTxt(read: DocumentReader, pageToMarkdown: PageToMarkdown): Promise<string> {
	const pages = await markdownPages(read);
	return pages.map((entry) => pageToMarkdown(entry).trimEnd()).join('\n\n---\n\n') + '\n';
}
