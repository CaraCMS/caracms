/**
 * The docs kit's text block: rich text with h2 and h3 headings, lists and links.
 *
 * Stored: { "type": "text", "body": [{ "h2": "…" }, { "p": "…" }, { "ul": ["…"] }] }
 *
 * Its h2s and h3s are the page's table of contents (the page component reads them).
 */
import { richText, type BlockConfig, type BlockData } from 'caracms/config';

export const textBlock = {
	label: 'Text',
	component: 'src/starlight-kit/blocks/Text.astro',
	fields: {
		body: richText({ label: 'Text', headings: ['h2', 'h3'] }),
	},
} satisfies BlockConfig;

export type TextData = BlockData<typeof textBlock.fields>;
