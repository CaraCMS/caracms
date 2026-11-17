/**
 * POST /_caracms/delete: `{ collection, path }` → `{ ok, collection, path, file }`, or
 * `{ error, code }` (M5a Phase 3, Decision 12; shapes and codes: ../types.ts →
 * DeleteRequest, CreateDeleteRefusal). The rules, and why it's a security boundary,
 * are in ../server/create.ts; the store is the mode's (server/mode.ts): the file and
 * its emptied folders on disk in local mode, the lock and a "gone" autosave in live
 * mode, where the request carries `X-Caracms-Tab` and the guard has checked the
 * session (M4 Decision 14's path prefix).
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { personOf } from '../../live/locals.ts';
import { handleDelete } from '../server/create.ts';
import { editorStore } from '../server/mode.ts';

export const prerender = false;

/** POST, and every other method (405). */
export const ALL: APIRoute = async ({ request, locals }) => handleDelete(request, await editorStore(site), { person: personOf(locals) });
