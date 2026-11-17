import { link, list, text, type BlockConfig, type BlockData } from 'caracms/config';

/**
 * The footer (edit in context, Decision 16): the page's footer slot, a shared block in
 * content/shared/footer.json, the default, drawn on every page by Page.astro's
 * `<Slot name="footer">`. It holds the link columns, which were Site Settings' until then
 * (M7 Decision 16); the contact details and social links stay Site Settings' (more than one
 * piece shows them), and the footer marks them as Site Settings' fields (Decision 4). Its
 * component is Footer.astro, which draws src/components/SiteFooter.astro.
 */
export const siteFooter = {
	label: 'Footer',
	component: 'src/blocks/Footer.astro',
	slot: 'footer',
	fields: {
		columns: list(
			{
				heading: text({ label: 'Heading' }),
				links: list(link({ label: 'Link' }), { label: 'Links' }),
			},
			{ label: 'Columns', itemLabel: 'heading', help: 'Footer links, in columns.' },
		),
	},
} satisfies BlockConfig;

export type SiteFooterData = BlockData<typeof siteFooter.fields>;
