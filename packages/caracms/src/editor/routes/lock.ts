/**
 * POST /_caracms/lock { file, action: 'take' | 'release' }: Edit here, and a closing tab's release (Decision 9).
 * Live mode only (M4 Phase 2); the handler is ../../live/editor.ts → `lock`. Shapes: ../types.ts.
 */
import { liveRoute } from './_live.ts';

export const prerender = false;

export const ALL = liveRoute('lock');
