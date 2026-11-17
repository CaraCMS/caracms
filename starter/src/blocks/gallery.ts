import { list, media, text, type BlockConfig, type BlockData } from 'caracms/config';
import { band } from './background.ts';

/**
 * The gallery (M5b Decision 10): a heading and three to nine images at 4:5. Outside
 * 3–9 the field warns (amber) and blocks nothing. Schema beside Gallery.astro.
 */
export const gallery = {
	label: 'Gallery',
	component: 'src/blocks/Gallery.astro',
	fields: {
		heading: text({ label: 'Heading', heading: true }),
		images: list(media({ only: 'image', label: 'Image' }), { label: 'Images', min: 3, max: 9 }),
		...band(),
	},
} satisfies BlockConfig;

export type GalleryData = BlockData<typeof gallery.fields>;
