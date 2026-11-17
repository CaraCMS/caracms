/**
 * POST /_caracms/publish: Publish (Decision 10).
 * Live mode only (M4 Phase 2); the handler is ../../live/editor.ts → `publish`. Shapes: ../types.ts.
 */
import { liveRoute } from './_live.ts';

export const prerender = false;

export const ALL = liveRoute('publish');
