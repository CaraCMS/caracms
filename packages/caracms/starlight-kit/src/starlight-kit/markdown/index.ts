/**
 * The kit's Markdown seam: a caracms page to Markdown and back.
 *
 * - `pageToMarkdown(entry: ReadEntry): string`: a page (from `read.documents('pages')` or
 *   `read.document`, parsed values) as Markdown, for `.md` twins and llms-full.txt.
 * - `markdownToPage(md): { title, description, blocks, report }`: Markdown as the kit's
 *   stored blocks, with a report of every shape change; an importer's core.
 * - `mapStoredLinks` / `storedLinks`: an importer's link rewriting over stored rich text.
 * - `headingId` / `headingIds`: the one slug rule (caracms's), for anchors.
 *
 * Assumes the kit's five blocks (../blocks/) and caracms with heading ids.
 */
export { pageToMarkdown, type PageToMarkdownOptions, type WriterNote } from './write.ts';
export { markdownToPage, type MarkdownPage, type MarkdownToPageOptions, type ReportEntry, type ReportKind, type StoredBlock, type StoredRich } from './read.ts';
export { mapStoredLinks, storedLinks, storedToPlain } from './inline.ts';
export { headingId, headingIds } from './heading-id.ts';
