import { link, list, text, type BlockConfig, type BlockData } from 'caracms/config';

/**
 * The footer (M5a Decision 17): the page's footer slot (edit in context, Decision 16), filled by
 * the shared block content/shared/footer.json, the default, on every page. Its address is a
 * top-level text field, typed on the page (Acceptance 8).
 */
export const footer = {
	label: 'Footer',
	component: 'src/blocks/Footer.astro',
	slot: 'footer',
	fields: {
		address: text({ multiline: true, label: 'Address' }),
		email: text({ label: 'Email' }),
		links: list(link({ label: 'Link' }), { label: 'Links' }),
	},
} satisfies BlockConfig;

export type FooterData = BlockData<typeof footer.fields>;
