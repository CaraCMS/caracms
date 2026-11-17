import { richText, text, type BlockConfig, type BlockData } from 'caracms/config';
import { band } from './background.ts';

/** The text block's schema, beside its component (Text.astro). */
export const textBlock = {
	label: 'Text',
	component: 'src/blocks/Text.astro',
	fields: {
		heading: text({ label: 'Heading', heading: true }),
		// M5a Decision 3: was text({ multiline: true }); a plain string reads as rich text, so no migration.
		body: richText({ label: 'Body', headings: ['h2', 'h3'] }),
		...band(),
	},
} satisfies BlockConfig;

export type TextData = BlockData<typeof textBlock.fields>;
