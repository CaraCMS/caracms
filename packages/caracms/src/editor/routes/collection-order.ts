/**
 * POST /_caracms/collection-order: `{ collection, order }` or `{ collection, first }` →
 * `{ ok: true }`, or `{ error, code }` (review gaps, Decisions 2 and 4; shapes: ../types.ts →
 * CollectionOrderRequest). The rules are in ../server/collection-order.ts; the store is the
 * mode's (server/mode.ts): Site Settings on disk in local mode, an autosave under its lock in
 * live mode, where the request carries `X-Caracms-Tab` and the guard has checked the session
 * (M4 Decision 14's path prefix).
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { personOf } from '../../live/locals.ts';
import { handleCollectionOrder } from '../server/create.ts';
import { editorStore } from '../server/mode.ts';

export const prerender = false;

/** POST, and every other method (405). */
export const ALL: APIRoute = async ({ request, locals }) => handleCollectionOrder(request, await editorStore(site), { person: personOf(locals) });
