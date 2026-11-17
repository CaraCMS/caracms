/**
 * GET /_caracms/document?collection=<name>&path=<path>: one document as the editor
 * opens it, through the mode's drafts store (server/mode.ts): the file on disk in
 * local mode; the `drafts` copy with its autosave on top in live mode (M4 Decision 4).
 *
 *   200 { entry, text, document, mtimeMs, version, lastChange? }   (types.ts → OpenedDocument; lastChange in live mode, Decision 11)
 *   400/404 { error, code }                                        (content.ts → DocumentError)
 *   401 { error: 'signed-out' } (live mode, no person); 503 { error, code: 'unavailable' } (Redis out)
 *
 * `text` is the serializer's base for the editing session, and what the keeper
 * compares held edits with.
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { DocumentError } from '../../content.ts';
import { personOf } from '../../live/locals.ts';
import { editorMode, editorStore } from '../server/mode.ts';
import { WriteRefused } from '../server/write.ts';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export const GET: APIRoute = async ({ url, locals }) => {
	if (editorMode().kind === 'live' && !personOf(locals)) return new Response(JSON.stringify({ error: 'signed-out', code: 'signed-out' }), { status: 401, headers });
	const collection = url.searchParams.get('collection') ?? '';
	const path = url.searchParams.get('path') ?? '';
	try {
		const store = await editorStore(site);
		return new Response(JSON.stringify(await store.read(collection, path)), { headers });
	} catch (error) {
		if (error instanceof DocumentError) {
			const status = error.code === 'not-found' ? 404 : 400;
			return new Response(JSON.stringify({ error: error.message, code: error.code }), { status, headers });
		}
		if (error instanceof WriteRefused) return new Response(JSON.stringify({ error: error.message, ...error.body }), { status: error.status, headers });
		throw error;
	}
};
