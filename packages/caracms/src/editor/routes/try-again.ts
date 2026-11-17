/**
 * POST /_caracms/try-again: redeploy a failed (or slow) publish through the redeployer:
 * Railway's API or a deploy hook (M4 Decision 12; runs-anywhere Decision 11).
 * Live mode only (M4 Phase 2); the handler is ../../live/editor.ts → `tryAgain`. Shapes: ../types.ts.
 */
import { liveRoute } from './_live.ts';

export const prerender = false;

export const ALL = liveRoute('tryAgain');
