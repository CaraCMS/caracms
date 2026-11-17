/**
 * The docs kit's aside: a note, tip, caution or danger box, drawn with Starlight's <Aside>.
 *
 * Stored: { "type": "aside", "kind": "tip", "body": [{ "p": "…" }] }
 *
 * `kind` is one of ASIDE_KINDS (Starlight's own four). The body has no headings: an aside's
 * text never joins the table of contents.
 */
import { richText, select, type BlockConfig, type BlockData } from 'caracms/config';

export const ASIDE_KINDS = ['note', 'tip', 'caution', 'danger'] as const;
export type AsideKind = (typeof ASIDE_KINDS)[number];

export const asideBlock = {
	label: 'Aside',
	component: 'src/starlight-kit/blocks/Aside.astro',
	help: 'A boxed note beside the text: a note, a tip, a caution or a danger.',
	fields: {
		kind: select({
			label: 'Kind',
			options: [
				{ value: 'note', label: 'Note' },
				{ value: 'tip', label: 'Tip' },
				{ value: 'caution', label: 'Caution' },
				{ value: 'danger', label: 'Danger' },
			],
			default: 'note',
		}),
		body: richText({ label: 'Text' }),
	},
} satisfies BlockConfig;

export type AsideData = BlockData<typeof asideBlock.fields>;
