/**
 * POST /_caracms/slot-default: `{ path }` → `{ ok, path, undefaulted }`, or `{ error, code }`
 * (edit in context, Decision 3; shapes: ../types.ts → SlotDefaultRequest). The rules are in
 * ../server/slot-default.ts; the store is the mode's (server/mode.ts): the files on disk in
 * local mode, autosaves under this tab's locks in live mode, where the request carries
 * `X-Caracms-Tab` and the guard has checked the session (M4 Decision 14's path prefix).
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { personOf } from '../../live/locals.ts';
import { handleSlotDefault } from '../server/create.ts';
import { editorStore } from '../server/mode.ts';

export const prerender = false;

/** POST, and every other method (405). */
export const ALL: APIRoute = async ({ request, locals }) => handleSlotDefault(request, await editorStore(site), { person: personOf(locals) });
