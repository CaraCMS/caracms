import { buttons, group, richText, text, type BlockConfig, type BlockData } from 'caracms/config';
import { band } from './background.ts';

/** One column: a heading, some text and a button, kept together as a group. */
const column = (label: string) =>
	group(
		{
			heading: text({ label: 'Heading', heading: true }),
			text: richText({ label: 'Text' }),
			// Item 4: words with no link are a plain label ("Coming soon"), not half a button.
			button: buttons({
				label: 'Button',
				max: 1,
				allowNoLink: true,
				styles: [
					{ value: 'primary', label: 'Primary' },
					{ value: 'secondary', label: 'Secondary' },
				],
			}),
		},
		{ label },
	);

/**
 * Two columns side by side (the editor-friction batch, item 1): each column's fields are a
 * group, so the sidebar shows "Left" and "Right" as two sections, and the file keeps
 * `{ "left": { "heading", "text", "button" }, "right": { … } }`. Schema beside its
 * component (Columns.astro).
 */
export const columns = {
	label: 'Two columns',
	component: 'src/blocks/Columns.astro',
	fields: {
		left: column('Left'),
		right: column('Right'),
		...band(),
	},
} satisfies BlockConfig;

export type ColumnsData = BlockData<typeof columns.fields>;
