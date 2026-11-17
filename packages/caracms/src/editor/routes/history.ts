/**
 * GET /_caracms/history: the newest 20 publishes (Decision 12).
 * Live mode only (M4 Phase 2); the handler is ../../live/editor.ts → `history`. Shapes: ../types.ts.
 */
import { liveRoute } from './_live.ts';

export const prerender = false;

export const ALL = liveRoute('history');
