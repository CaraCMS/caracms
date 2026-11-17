/**
 * POST /_caracms/write: `{ file, base, document }` → `{ ok, file, changed, mtimeMs, version }`,
 * or `{ error, code? }` with 400/401/403/404/405/409/413/415/503. The logic, and why it's
 * a security boundary, is in ../server/write.ts; the store is the mode's
 * (server/mode.ts): the disk in local mode, the Redis autosave in live mode (M4
 * Decision 4), where the request also carries `X-Caracms-Tab` (and
 * `X-Caracms-Release: 1` on a closing tab's last write).
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { personOf } from '../../live/locals.ts';
import { editorStore } from '../server/mode.ts';
import { handleWrite } from '../server/write.ts';

export const prerender = false;

/** POST, and every other method (405). */
export const ALL: APIRoute = async ({ request, locals }) => handleWrite(request, await editorStore(site), { person: personOf(locals) });
