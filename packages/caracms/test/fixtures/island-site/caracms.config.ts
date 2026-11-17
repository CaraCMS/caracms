import { defineSite, link, list, text, type BlockConfig } from 'caracms/config';

/**
 * `caracms audit`'s React fixture. What it should print:
 * - unmarked: Home › Gallery's `credit` (drawn by its island, unmarked), never its `caption` (the
 *   island draws the marker the block hands it); Shared › Footer once, as a slot block whose
 *   outermost element is an island, not a `<Block>`.
 * - unheld: "Drawn in React" on / (the Gallery island's own words), "in Caption"; the footer's link
 *   words on every page, "in Nav". Never the header's links or its menu button: the header island
 *   sits inside its `<Block>` root, so they're the frame's links.
 */
const nav = {
	links: list(link({ label: 'Link' }), { label: 'Links' }),
	menuLabel: text({ label: 'Menu button' }),
};

const header = { label: 'Header', component: 'src/blocks/Header.astro', slot: 'header', fields: nav } satisfies BlockConfig;
const footer = { label: 'Footer', component: 'src/blocks/BareFooter.astro', slot: 'footer', fields: nav } satisfies BlockConfig;
const gallery = {
	label: 'Gallery',
	component: 'src/blocks/Gallery.astro',
	fields: { caption: text({ label: 'Caption' }), credit: text({ label: 'Credit' }) },
} satisfies BlockConfig;

export default defineSite({
	collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } },
	blocks: { header, footer, gallery },
	textStyles: {},
	page: 'src/components/Page.astro',
});
