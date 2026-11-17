/**
 * Every public page's Markdown twin, at its address plus `.md` (Home at `/index.md`), from
 * the page JSON (../llms.ts). Prerendered; injected at `/[...path].md` by
 * ../integration.ts.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { contentReader } from 'caracms/content';
import { site } from 'virtual:caracms/config';
import { MARKDOWN_HEADERS, markdownPages, warnWriterNotes } from '../llms.ts';
import { pageToMarkdown } from '../writer.ts';

export const prerender = true;

export const getStaticPaths = (async () => {
	const pages = await markdownPages(contentReader(site));
	return pages.map((entry) => ({ params: { path: entry.url === '/' ? 'index' : entry.url!.slice(1) }, props: { path: entry.path } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
	const entry = await contentReader(site).document('pages', (props as { path: string }).path);
	if (!entry) return new Response('Not found', { status: 404 });
	return new Response(pageToMarkdown(entry, { report: warnWriterNotes(entry) }), { headers: MARKDOWN_HEADERS });
};
