/**
 * GET /_caracms/status?file=<open document's file>: the poll (Decision 13).
 * Live mode only (M4 Phase 2); the handler is ../../live/editor.ts → `status`. Shapes: ../types.ts.
 */
import { liveRoute } from './_live.ts';

export const prerender = false;

export const ALL = liveRoute('status');
