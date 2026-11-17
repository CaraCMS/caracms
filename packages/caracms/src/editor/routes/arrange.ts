/**
 * POST /_caracms/arrange: ArrangeRequest → `{ ok: true }`, or `{ error, code }` as the move
 * route refuses (arrange pages, Contracts; shapes: ../types.ts → ArrangeRequest). The rules
 * are in ../server/arrange.ts; the store is the mode's (server/mode.ts), as for move: on
 * disk in local mode, autosaves under this tab's locks in live mode, where the request
 * carries `X-Caracms-Tab` and the guard has checked the session (its `/_caracms/` prefix rule).
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { personOf } from '../../live/locals.ts';
import { handleArrange } from '../server/arrange.ts';
import { editorStore } from '../server/mode.ts';

export const prerender = false;

/** POST, and every other method (405). */
export const ALL: APIRoute = async ({ request, locals }) => handleArrange(request, await editorStore(site), { person: personOf(locals) });
