/**
 * Where each preview frame sits on the stage (the mockup's layoutFrames; M2
 * Decision 3): each iframe at its true width, scaled down to fit, never reflowed
 * narrower. Desktop fills the stage's height, flush to the top; tablet and phone sit
 * in a box with --frame-pad (16px) around them. The ones not shown stay laid out
 * behind at opacity 0 (Decision 13): never display: none, never a zero-size box.
 */
import { TRUE_WIDTH, WIDTHS, type Width } from '../../types.ts';

export interface FrameBox {
	left: number;
	top: number;
	/** The box on screen (the scaled width). */
	width: number;
	height: number;
	scale: number;
	/** The iframe's own height, before the scale. */
	iframeHeight: number;
}

export type StageLayout = Record<Width, FrameBox>;

export const FRAME_PAD = 16;

export function frameBox(stageWidth: number, stageHeight: number, width: Width): FrameBox {
	const tw = TRUE_WIDTH[width];
	const desktop = width === 'desktop';
	const scale = Math.max(0.05, desktop ? Math.min(1, stageWidth / tw) : Math.min(1, (stageWidth - FRAME_PAD * 3) / tw));
	const top = desktop ? 0 : FRAME_PAD;
	const height = Math.max(1, desktop ? stageHeight : stageHeight - FRAME_PAD * 2);
	const boxWidth = Math.round(tw * scale);
	return { left: Math.round((stageWidth - boxWidth) / 2), top, width: boxWidth, height, scale, iframeHeight: Math.ceil(height / scale) };
}

export function stageLayout(stageWidth: number, stageHeight: number): StageLayout {
	return Object.fromEntries(WIDTHS.map((w) => [w, frameBox(stageWidth, stageHeight, w)])) as StageLayout;
}
