/**
 * POST /_caracms/discard { file }: Discard changes, one waiting document back to what's live;
 * { file, seen: true }: this tab has let go of its copy of a document someone discarded.
 * Live mode only (local mode has no waiting list or published state to go back to); the
 * handler is ../../live/editor.ts → `discard`. Shapes: ../types.ts → DiscardRequest.
 */
import { liveRoute } from './_live.ts';

export const prerender = false;

export const ALL = liveRoute('discard');
