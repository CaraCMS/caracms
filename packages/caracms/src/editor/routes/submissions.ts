/**
 * `/_caracms/submissions/*`: the inbox (M6 Decision 9). Both modes: in live mode the
 * guard's prefix rule has checked the session and, for a POST, the origin; local mode
 * has no sign-in and reads `.caracms/submissions/`. Every route and shape:
 * ../../forms/inbox.ts.
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { handleSubmissions } from '../../forms/inbox.ts';
import { personOf } from '../../live/locals.ts';
import { editorMode } from '../server/mode.ts';

export const prerender = false;

export const ALL: APIRoute = ({ request, locals }) =>
	handleSubmissions(request, { site, mode: editorMode().kind === 'live' ? 'live' : 'local', person: personOf(locals)?.email ?? null });
