import { link, list, text, type BlockConfig, type BlockData } from 'caracms/config';

/**
 * The header (edit in context, Decision 16): the page's header slot, a shared block in
 * content/shared/header.json, the default, drawn on every page by Page.astro's
 * `<Slot name="header">`. It holds the menu, which was Site Settings' until then (M7
 * Decision 16); the site's name stays Site Settings' brand. Its component is Header.astro,
 * which draws src/components/SiteHeader.astro.
 */
export const siteHeader = {
	label: 'Header',
	component: 'src/blocks/Header.astro',
	slot: 'header',
	fields: {
		menu: list(
			{
				label: text({ label: 'Label' }),
				href: link({ label: 'Address', addressOnly: true, help: 'With dropdown links, this item opens them; its own address isn’t used.' }),
				links: list(link({ label: 'Link' }), { label: 'Dropdown links' }),
			},
			{
				label: 'Menu',
				itemLabel: 'label',
				help: 'The links across the top of every page.',
			},
		),
	},
} satisfies BlockConfig;

export type SiteHeaderData = BlockData<typeof siteHeader.fields>;
