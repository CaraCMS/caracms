/**
 * The docs kit's steps: numbered instructions, drawn with Starlight's <Steps>.
 *
 * Stored: { "type": "steps", "steps": [[{ "p": "Open **Posts**." }], [{ "p": "…" }, { "ul": ["…"] }]] }
 * and, for steps that carry on after an interruption (a screenshot between steps 2 and 3),
 * the first one's number: { "type": "steps", "start": 3, "steps": [...] }. No `start` (or
 * `null`) numbers from 1.
 *
 * Each step is one rich-text value (paragraphs and lists, no headings), so a step can hold a
 * second paragraph or a bulleted list under it.
 */
import { list, number, richText, type BlockConfig, type BlockData } from 'caracms/config';

export const stepsBlock = {
	label: 'Steps',
	component: 'src/starlight-kit/blocks/Steps.astro',
	help: 'Numbered instructions, one step per item.',
	fields: {
		steps: list(richText({ label: 'Step' }), { label: 'Steps', itemNoun: 'step' }),
		start: number({ label: 'First step’s number', help: 'Leave empty to start at 1. Set it when these steps carry on from steps above, after a picture or a note.', min: 1, step: 1 }),
	},
} satisfies BlockConfig;

export type StepsData = BlockData<typeof stepsBlock.fields>;

/** The first step's number: `start` when it's a whole number above 1, else 1. */
export function stepsStart(start: unknown): number {
	return typeof start === 'number' && Number.isInteger(start) && start > 1 ? start : 1;
}
