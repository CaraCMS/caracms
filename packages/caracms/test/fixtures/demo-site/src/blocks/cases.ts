import { number, select, text, type BlockConfig, type BlockData } from 'caracms/config';
import { background } from './background.ts';

/**
 * The case-study list (M5a Decision 17): Featured or In order (review gaps, Decision 5a: the
 * first few in Site order, the case studies' hand order), and how many. It reads
 * the case studies through its render context (Decision 9), so a preview shows them
 * as they stand in the editor, and the build as they are in git.
 */
export const cases = {
	label: 'Case-study list',
	component: 'src/blocks/Cases.astro',
	fields: {
		heading: text({ label: 'Heading', heading: true }),
		show: select({
			label: 'Which case studies',
			options: [
				{ value: 'featured', label: 'Featured' },
				{ value: 'in-order', label: 'In order' },
			],
		}),
		count: number({ label: 'How many', min: 3, max: 12, step: 1 }),
		background: background(),
	},
} satisfies BlockConfig;

export type CasesData = BlockData<typeof cases.fields>;

/** What the list shows when its count is empty or out of range (M5a → Watch-outs: the block's own default). */
export const DEFAULT_COUNT = 3;
