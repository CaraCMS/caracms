import { buttons, list, media, select, text, type BlockConfig, type BlockData } from 'caracms/config';
import { band } from './background.ts';

/**
 * Cards (M7 Decision 10, the template's Columns): a heading group, then a grid of
 * items, each an optional image or loop at 3:2, a heading, some text and one link.
 * 2, 3 or 4 per row on desktop, 2 on tablets, 1 on phones. A card with no media is a
 * text card (Acceptance 27). Schema beside its component (Cards.astro).
 */
export const cards = {
	label: 'Cards',
	component: 'src/blocks/Cards.astro',
	fields: {
		heading: text({ label: 'Heading', heading: true }),
		intro: text({ label: 'Intro', multiline: true }),
		perRow: select({
			label: 'Per row on desktop',
			options: [
				{ value: '2', label: '2' },
				{ value: '3', label: '3' },
				{ value: '4', label: '4' },
			],
			default: '3',
		}),
		items: list(
			{
				media: media({ label: 'Image or video', play: 'loop' }),
				heading: text({ label: 'Heading' }),
				text: text({ label: 'Text', multiline: true }),
				// The card's one button; a text link unless another style is picked.
				button: buttons({
					label: 'Button',
					max: 1,
					styles: [
						{ value: 'link', label: 'Text link' },
						{ value: 'primary', label: 'Primary' },
						{ value: 'secondary', label: 'Secondary' },
					],
				}),
			},
			{ label: 'Cards', itemLabel: 'heading' },
		),
		...band(),
	},
} satisfies BlockConfig;

export type CardsData = BlockData<typeof cards.fields>;
