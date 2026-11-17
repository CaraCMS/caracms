import { list, select, text, type BlockConfig, type BlockData } from 'caracms/config';
import { band } from './background.ts';

/**
 * Features (M7 Decision 10): a heading group, then short points, each a heading and a
 * line or two of text under a hairline, 2 or 3 per row on desktop. No icons. Schema
 * beside its component (Features.astro).
 */
export const features = {
	label: 'Features',
	component: 'src/blocks/Features.astro',
	fields: {
		heading: text({ label: 'Heading', heading: true }),
		intro: text({ label: 'Intro', multiline: true }),
		perRow: select({
			label: 'Per row on desktop',
			options: [
				{ value: '2', label: '2' },
				{ value: '3', label: '3' },
			],
			default: '3',
		}),
		items: list(
			{
				heading: text({ label: 'Heading' }),
				text: text({ label: 'Text', multiline: true }),
			},
			{ label: 'Points', itemLabel: 'heading' },
		),
		...band(),
	},
} satisfies BlockConfig;

export type FeaturesData = BlockData<typeof features.fields>;
