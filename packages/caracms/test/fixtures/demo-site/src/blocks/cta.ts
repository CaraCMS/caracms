import { lockup, text, type BlockConfig, type BlockData } from 'caracms/config';
import { background } from './background.ts';

/** The call to action's schema, beside its component (Cta.astro). */
export const cta = {
	label: 'Call to action',
	component: 'src/blocks/Cta.astro',
	fields: {
		heading: lockup({ style: 'display', label: 'Heading' }),
		text: text({ multiline: true, label: 'Text' }),
		button: text({ label: 'Button label' }),
		background: background(),
	},
} satisfies BlockConfig;

export type CtaData = BlockData<typeof cta.fields>;
