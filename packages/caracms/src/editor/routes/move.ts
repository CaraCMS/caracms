/**
 * POST /_caracms/move: `{ collection, path, to, redirect? }` → MoveResponse, or `{ error, code }`
 * (pre-M7 item 8; shapes: ../types.ts → MoveRequest). The rules are in ../server/move.ts;
 * the store is the mode's (server/mode.ts), as for create and delete: on disk in local
 * mode, autosaves under this tab's locks in live mode, where the request carries
 * `X-Caracms-Tab` and the guard has checked the session (its `/_caracms/` prefix rule).
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { personOf } from '../../live/locals.ts';
import { handleMove } from '../server/move.ts';
import { editorStore } from '../server/mode.ts';

export const prerender = false;

/** POST, and every other method (405). */
export const ALL: APIRoute = async ({ request, locals }) => handleMove(request, await editorStore(site), { person: personOf(locals) });
