import { select, text, type BlockConfig, type BlockData } from 'caracms/config';
import { forms } from '../forms.ts';

/**
 * The Form block's schema (M6 Decision 17, the mockup's `b-form`), beside its component
 * (Form.astro): a heading, a short intro (up to 200 characters) and which of the site's
 * forms it shows.
 */
export const formBlock = {
	label: 'Form',
	component: 'src/blocks/Form.astro',
	// Review gaps (Decision 14): the form's states, drawn by Form.astro from `cms.state`.
	states: { sent: 'Sent', error: 'Couldn’t send', invalid: 'Invalid' },
	fields: {
		heading: text({ label: 'Heading', heading: true }),
		intro: text({ label: 'Intro', multiline: true, max: 200 }),
		form: select({ label: 'Form', options: Object.entries(forms).map(([value, form]) => ({ value, label: form.label })) }),
	},
} satisfies BlockConfig;

export type FormBlockData = BlockData<typeof formBlock.fields>;
