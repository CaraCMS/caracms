import { media, select, text, type BlockConfig, type BlockData } from 'caracms/config';
import { band } from './background.ts';

/**
 * Full-width media (M7 Decision 10; M5b → "a full-width media block is M7's"): one
 * image or clip at 16:9 (a clip plays as its own choice: a loop or a player),
 * full-bleed with square corners or framed at the content width, with an optional
 * caption. Empty, it renders nothing (Acceptance 27). Schema beside its component
 * (FullMedia.astro).
 */
export const fullMedia = {
	label: 'Full-width media',
	component: 'src/blocks/FullMedia.astro',
	fields: {
		media: media({ label: 'Image or video' }),
		width: select({
			label: 'Width',
			options: [
				{ value: 'bleed', label: 'Full-bleed' },
				{ value: 'content', label: 'Content width' },
			],
		}),
		caption: text({ label: 'Caption', multiline: true }),
		...band(),
	},
} satisfies BlockConfig;

export type FullMediaData = BlockData<typeof fullMedia.fields>;
