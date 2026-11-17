import { list, richText, text, type BlockConfig, type BlockData } from 'caracms/config';
import { band } from './background.ts';

/**
 * Questions (M7 Decision 10): a heading group in the first third on desktop, then each
 * question with a rich-text answer, as `<details>`, so they open with no script. The
 * first one starts open. Schema beside its component (Faq.astro).
 */
export const faq = {
	label: 'Questions',
	component: 'src/blocks/Faq.astro',
	fields: {
		heading: text({ label: 'Heading', heading: true }),
		intro: text({ label: 'Intro', multiline: true }),
		items: list(
			{
				question: text({ label: 'Question' }),
				answer: richText({ label: 'Answer' }),
			},
			{ label: 'Questions', itemLabel: 'question' },
		),
		...band(),
	},
} satisfies BlockConfig;

export type FaqData = BlockData<typeof faq.fields>;
