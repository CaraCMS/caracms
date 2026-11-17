/**
 * GET /_caracms/documents: every document, in the editor's order, with warnings and
 * times (drafts-store.ts → list), through the mode's store (server/mode.ts). For
 * refreshing the documents level (editor.refreshDocuments).
 *
 * Page folders (Contracts): `?with=folders` answers `{ documents, pages }`, the Pages tree's
 * folders and order stamp read through the same source (types.ts → PagesLayout).
 *
 * M6 Decision 9: the inbox's unread count comes with it, in `X-Caracms-Unread` (absent
 * when the production server has no submissions bucket, or the count couldn't be read).
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { submissionsSetupQuick, UNREAD_HEADER } from '../../forms/inbox.ts';
import { personOf } from '../../live/locals.ts';
import { editorMode, editorStore } from '../server/mode.ts';
import { WriteRefused } from '../server/write.ts';
import { withCards } from '../server/cards.ts';
import { pagesLayout } from '../server/arrange.ts';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export const GET: APIRoute = async ({ locals, url }) => {
	if (editorMode().kind === 'live' && !personOf(locals)) return new Response(JSON.stringify({ error: 'signed-out', code: 'signed-out' }), { status: 401, headers });
	try {
		const store = await editorStore(site);
		const [documents, submissions] = await Promise.all([store.list().then((all) => withCards(site, all)), submissionsSetupQuick({ site })]);
		const body = url.searchParams.get('with') === 'folders' ? { documents, pages: await pagesLayout(site, documents, await store.source()) } : documents;
		return new Response(JSON.stringify(body), { headers: { ...headers, ...(submissions.unread !== null ? { [UNREAD_HEADER]: String(submissions.unread) } : {}) } });
	} catch (error) {
		if (error instanceof WriteRefused) return new Response(JSON.stringify({ error: error.message, ...error.body }), { status: error.status, headers });
		throw error;
	}
};
