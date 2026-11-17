/**
 * `/_caracms/media/*`: the media library, uploads and Mux (M5b Phase 2). Both modes:
 * in live mode the guard's prefix rule has checked the session and, for a POST, the
 * origin; local mode has no sign-in. Every route and shape: ../types.ts →
 * MEDIA_ENDPOINTS; the rules: ../server/media/handler.ts.
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { personOf } from '../../live/locals.ts';
import { handleMedia } from '../server/media/handler.ts';
import { editorMode, editorStore } from '../server/mode.ts';

export const prerender = false;

export const ALL: APIRoute = async ({ request, locals }) =>
	handleMedia(request, { site, store: await editorStore(site), mode: editorMode().kind === 'live' ? 'live' : 'local', person: personOf(locals) });
