import { media, richText, select, type BlockConfig, type BlockData } from 'caracms/config';
import { background } from './background.ts';

/**
 * Text and media (M5b Decision 10): rich text beside an image or a clip at 3:2, the
 * media on the left or the right. With an empty slot it's one column of text.
 * Schema beside its component (Tm.astro).
 */
export const tm = {
	label: 'Text and media',
	component: 'src/blocks/Tm.astro',
	fields: {
		body: richText({ label: 'Text', headings: ['h2', 'h3'] }),
		media: media({ label: 'Image or video' }),
		side: select({
			label: 'Media side',
			options: [
				{ value: 'left', label: 'Image left' },
				{ value: 'right', label: 'Image right' },
			],
		}),
		background: background(),
	},
} satisfies BlockConfig;

export type TmData = BlockData<typeof tm.fields>;
