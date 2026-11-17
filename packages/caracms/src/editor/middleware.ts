/**
 * The unconfigured server's answer (M4 Decision 1): a production server missing a
 * required variable still serves the public site, while `/admin` and `/_caracms/*`
 * answer 503 with a plain sentence naming what's missing (logged once, server/mode.ts).
 *
 * Registered first (`addMiddleware({ order: 'pre' })` in ../index.ts), so it runs
 * before Phase 3's sign-in guard, which then only ever sees local or live mode.
 * Every other path passes straight through, and so does a POST to the public form endpoint,
 * `/_caracms/form` (M6 Decision 5): the form is part of the public site, which works
 * without the editor.
 *
 * It also marks the preview route's pages (M8 review): a 200 HTML answer to the preview's GET
 * gets `data-caracms-preview` on its `<html>` (types.ts → PREVIEW_MARK), the one sign the
 * driver has that a frame loaded a preview and not an error page. The site's page component
 * writes the `<html>`, so the route itself can't. Everything else passes untouched.
 *
 * Edit in context (Contracts → the read record): every preview render, GET and POST alike, is
 * buffered too, and gets the render's read record (read.ts) as one
 * `<script type="application/json" id="cms-reads">` before `</body>` (at the end when the page has
 * none). A POST's `<html>` isn't marked (only its body is morphed).
 */
import type { MiddlewareHandler } from 'astro';
import { isFormEndpoint } from '../live/auth/guard.ts';
import { readRecordOf, readRecordScript, type ReadRecord } from '../read.ts';
import { unconfiguredMessage } from '../live/mode.ts';
import { editorMode } from './server/mode.ts';
import { ENDPOINTS, PREVIEW_MARK } from './types.ts';

/** `html` with the preview's mark on its `<html>` (one is added after the doctype when the page has none). */
export function markPreviewHtml(html: string): string {
	if (/<html\b/i.test(html)) return html.replace(/<html\b/i, `<html ${PREVIEW_MARK}`);
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? '';
	return `${doctype}<html ${PREVIEW_MARK}>${html.slice(doctype.length)}`;
}

/** `html` with the read record's script before its last `</body>` (at the end when it has none). */
export function withReadRecord(html: string, record: ReadRecord): string {
	const script = readRecordScript(record);
	const at = html.search(/<\/body>(?![\s\S]*<\/body>)/i);
	return at === -1 ? `${html}${script}` : `${html.slice(0, at)}${script}${html.slice(at)}`;
}

async function markPreview(response: Response, locals: object, mark: boolean): Promise<Response> {
	if (response.status !== 200 || !/^text\/html/i.test(response.headers.get('Content-Type') ?? '')) return response;
	const headers = new Headers(response.headers);
	headers.delete('Content-Length');
	let html = await response.text();
	// Read once the whole render is in: every block has written its reads by now.
	const record = readRecordOf(locals);
	if (record) html = withReadRecord(html, record);
	return new Response(mark ? markPreviewHtml(html) : html, { status: response.status, statusText: response.statusText, headers });
}

export const isEditorPath = (pathname: string) =>
	(pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/_caracms/')) && !isFormEndpoint(pathname);

export const onRequest: MiddlewareHandler = (context, next) => {
	// The form endpoint's POST is public; any other method to it is as unavailable as the rest (guard.ts's let-through is POST-only).
	if (!isEditorPath(context.url.pathname) && !(isFormEndpoint(context.url.pathname) && context.request.method !== 'POST')) return next();
	const mode = editorMode();
	if (mode.kind !== 'unconfigured') {
		const method = context.request.method;
		if (context.url.pathname !== ENDPOINTS.preview || (method !== 'GET' && method !== 'POST')) return next();
		return (async () => markPreview(await next(), context.locals, method === 'GET'))();
	}
	const message = unconfiguredMessage(mode);
	const api = context.url.pathname.startsWith('/_caracms/');
	const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
	return Promise.resolve(
		api
			? new Response(JSON.stringify({ error: message, code: 'unconfigured' }), {
					status: 503,
					headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
				})
			: new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Editor not set up</title><p>${escape(message)}</p>`, {
					status: 503,
					headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
				}),
	);
};
