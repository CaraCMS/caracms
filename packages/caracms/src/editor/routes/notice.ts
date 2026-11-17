/**
 * POST /_caracms/notice { id }: dismiss a notice.
 * Live mode only (M4 Phase 2); the handler is ../../live/editor.ts → `notice`. Shapes: ../types.ts.
 */
import { liveRoute } from './_live.ts';

export const prerender = false;

export const ALL = liveRoute('notice');
