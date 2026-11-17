/** `/llms.txt`: the site's pages as links to their Markdown, grouped like the sidebar (../llms.ts; injected by ../integration.ts). */
import type { APIRoute } from 'astro';
import { contentReader } from 'caracms/content';
import { site } from 'virtual:caracms/config';
import { groupLabels } from 'virtual:starlight-kit/config';
import { llmsTxt, TEXT_HEADERS } from '../llms.ts';

export const prerender = true;

export const GET: APIRoute = async () => new Response(await llmsTxt(contentReader(site), { groupLabels }), { headers: TEXT_HEADERS });
