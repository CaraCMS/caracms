import { buttons, lockup, media, select, text, type BlockConfig, type BlockData } from 'caracms/config';
import { band } from './background.ts';

/** The hero block's schema, beside its component (Hero.astro). */
export const hero = {
	label: 'Hero',
	component: 'src/blocks/Hero.astro',
	fields: {
		heading: lockup({ style: 'display', label: 'Heading' }),
		intro: text({ multiline: true, label: 'Intro' }),
		// M5a Decision 17: a new field renders blank, so the demo's heroes need no migration.
		buttons: buttons({
			label: 'Buttons',
			styles: [
				{ value: 'primary', label: 'Primary' },
				{ value: 'secondary', label: 'Secondary' },
			],
		}),
		// M5b Decision 10: an image or a loop filling the band behind the text. A hero can't
		// carry a player, so any clip here plays as a loop.
		media: media({ label: 'Image or video', play: 'loop' }),
		layout: select({
			label: 'Layout',
			options: [
				{ value: 'left', label: 'Left' },
				{ value: 'centre', label: 'Centred' },
			],
		}),
		...band({ backgroundHelp: 'A hero with an image or video behind its text shows that instead of this.' }),
	},
} satisfies BlockConfig;

export type HeroData = BlockData<typeof hero.fields>;
