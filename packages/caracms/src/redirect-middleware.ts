/**
 * Site Settings' redirects, served (pre-M7 item 8): a public GET or HEAD that would be
 * a 404 and matches a redirect's `from` is answered 301 to its `to`, the query kept.
 * **A real page always wins**: the redirect is only looked at once the site has
 * answered 404, so a page made at an old address is served, redirect or not.
 *
 * - **Read from the file the public site is built from**, the site's own
 *   `content/site-settings.json` (local mode: the file the editor writes; a production
 *   server: `main` as built), never live mode's drafts: a redirect added by a move
 *   goes out with the Publish that moves the page. Re-read when the file changes
 *   (its modification time), so local edits apply at once.
 * - The editor's own paths (`/admin`, `/_caracms/`) are never redirected.
 *
 * This serves them in dev. A built site's 404 page is prerendered, sent without this
 * middleware running, so `caracms start`'s gate (bin/gate.mjs) serves them there.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MiddlewareHandler } from 'astro';
import { site } from 'virtual:caracms/config';
import { SITE_SETTINGS_FILE } from './reserved.ts';
import { parseRedirects, redirectFor, type Redirect } from './redirects.ts';

let kept: { mtimeMs: number; list: Redirect[] } | null = null;

/** The redirects in the site's Site Settings file, re-read when it changes. Empty when it's missing or unreadable. */
export async function siteRedirects(root: string): Promise<Redirect[]> {
	const file = join(root, SITE_SETTINGS_FILE);
	const info = await stat(file).catch(() => null);
	if (!info) return [];
	if (kept && kept.mtimeMs === info.mtimeMs) return kept.list;
	let list: Redirect[] = [];
	try {
		list = parseRedirects((JSON.parse(await readFile(file, 'utf8')) as { redirects?: unknown }).redirects);
	} catch {
		list = [];
	}
	kept = { mtimeMs: info.mtimeMs, list };
	return list;
}

const editorPath = (pathname: string) => pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/_caracms/');

export const onRequest: MiddlewareHandler = async (context, next) => {
	const { request, url } = context;
	if ((request.method !== 'GET' && request.method !== 'HEAD') || editorPath(url.pathname)) return next();
	const response = await next();
	if (response.status !== 404) return response;
	const to = redirectFor(await siteRedirects(site.root), url.pathname);
	if (!to) return response;
	return new Response(null, { status: 301, headers: { Location: `${to}${url.search}`, 'Cache-Control': 'no-cache' } });
};
