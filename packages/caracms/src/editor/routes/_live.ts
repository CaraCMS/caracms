/**
 * Live mode's routes (M4 Phase 2) share this: each is one handler on the process's live
 * editor (../../live/editor.ts), given the signed-in person from `locals`. In local
 * mode they answer 404 `{ code: 'not-live' }`: M3's editor has no status, locks or
 * Publish (Decision 1).
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import type { LiveEditor } from '../../live/editor.ts';
import { personOf } from '../../live/locals.ts';
import { liveEditorOf } from '../server/mode.ts';

type Name = 'status' | 'lock' | 'publish' | 'history' | 'tryAgain' | 'notice' | 'discard';

export const liveRoute =
	(name: Name): APIRoute =>
	async ({ request, locals }) => {
		const live: LiveEditor | null = await liveEditorOf(site);
		if (!live) {
			return new Response(JSON.stringify({ error: 'This route is for live mode; the editor is in local mode here.', code: 'not-live' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
			});
		}
		return live[name](request, personOf(locals));
	};
