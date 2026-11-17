/** `/llms-full.txt`: every public page's Markdown, Home first, then sidebar order (../llms.ts; injected by ../integration.ts). */
import type { APIRoute } from 'astro';
import { contentReader } from 'caracms/content';
import { site } from 'virtual:caracms/config';
import { llmsFullTxt, TEXT_HEADERS, warnWriterNotes } from '../llms.ts';
import { pageToMarkdown } from '../writer.ts';

export const prerender = true;

export const GET: APIRoute = async () => new Response(await llmsFullTxt(contentReader(site), (entry) => pageToMarkdown(entry, { report: warnWriterNotes(entry) })), { headers: TEXT_HEADERS });
