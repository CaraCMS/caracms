import { buttons, lockup, text, type BlockConfig, type BlockData } from 'caracms/config';
import { band } from './background.ts';

/**
 * The call to action's schema, beside its component (Cta.astro): a lockup, some text and
 * up to two buttons. M7 Decision 10: `button` (a label with no link, which always went
 * to Contact) became `buttons`, the shared button shape; each stored label became one
 * Primary button with an empty address (*Decisions during build*, 2026-10-19).
 */
export const cta = {
	label: 'Call to action',
	component: 'src/blocks/Cta.astro',
	fields: {
		heading: lockup({ style: 'display', label: 'Heading' }),
		text: text({ multiline: true, label: 'Text' }),
		buttons: buttons({
			label: 'Buttons',
			max: 2,
			styles: [
				{ value: 'primary', label: 'Primary' },
				{ value: 'secondary', label: 'Secondary' },
			],
		}),
		...band(),
	},
} satisfies BlockConfig;

export type CtaData = BlockData<typeof cta.fields>;
