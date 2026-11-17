/**
 * The docs kit's five blocks, keyed as they're stored (`"type": "text"` …). A site spreads
 * them into `defineSite({ blocks })`. The keys are stored in content: never rename one.
 */
import { asideBlock } from './aside.ts';
import { screenshotBlock } from './screenshot.ts';
import { stepsBlock } from './steps.ts';
import { tableBlock } from './table.ts';
import { textBlock } from './text.ts';

export const docsBlocks = {
	text: textBlock,
	aside: asideBlock,
	steps: stepsBlock,
	table: tableBlock,
	screenshot: screenshotBlock,
};
