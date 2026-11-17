import { date, defineSite, link, list, media, number, select, text, toggle, type BlockConfig } from 'caracms/config';

/**
 * `caracms audit`'s fixture. What it should print:
 * - unmarked: Home › Hero's `intro` (and nothing for its select, toggle, number, date, the marked
 *   link's address or the marked image's alt, nor its cover, drawn by `<Media>` with the in-memory
 *   media whatever the environment says); About › Stats's `stats.0.value`; Shared › Promo's
 *   `note` once (the promo is placed in five pages' bodies); Shared › Footer's `extra` once
 *   (never its links, its menu, or the labels of its links built in code, the frame's links).
 * - unheld: "Talk to Maeve" and "Instagram" on every page (the layout's code), never the head, ↘,
 *   aria-hidden words, the honeypot or the words inside `data-cms-fixed`; "Hello" (a post's title drawn
 *   outside its own root, by Latest). Titles inside their own roots (a FAQ entry's, the page's own, the
 *   brand's name in Site Settings') and the footer slot's link words inside its root are held, as are any words in a link or button inside
 *   the slot's root ("Privacy", code).
 * - The listing's later page (/news/page/2) is rendered too, from the site's own route, so the older
 *   post's teaser is marked by its card there; a route whose getStaticPaths throws is said on stderr.
 * - one-reader: FAQ, read only by About › Answers; Team, read by no block. Posts has pages: never.
 */
const hero = {
	label: 'Hero',
	component: 'src/blocks/Hero.astro',
	fields: {
		heading: text({ label: 'Heading' }),
		intro: text({ label: 'Intro' }),
		layout: select({ label: 'Layout', options: ['left', 'centre'] }),
		wide: toggle({ label: 'Wide' }),
		count: number({ label: 'Count' }),
		when: date({ label: 'When' }),
		cta: link({ label: 'Button' }),
		photo: media({ label: 'Photo' }),
		cover: media({ label: 'Cover' }),
	},
} satisfies BlockConfig;

const stats = {
	label: 'Stats',
	component: 'src/blocks/Stats.astro',
	fields: { stats: list({ value: text({ label: 'Value' }), label: text({ label: 'Label' }) }, { label: 'Stats' }) },
} satisfies BlockConfig;

const answers = { label: 'Answers', component: 'src/blocks/Answers.astro', fields: { heading: text({ label: 'Heading' }) } } satisfies BlockConfig;
const latest = { label: 'Latest', component: 'src/blocks/Latest.astro', fields: { heading: text({ label: 'Heading' }) } } satisfies BlockConfig;
// A paged listing (fix 3): one post a page; src/pages/[...path].astro makes /news/page/2.
const listing = { label: 'Listing', component: 'src/blocks/Listing.astro', fields: { heading: text({ label: 'Heading' }) } } satisfies BlockConfig;
const promo = { label: 'Promo', component: 'src/blocks/Promo.astro', fields: { line: text({ label: 'Line' }), note: text({ label: 'Note' }) } } satisfies BlockConfig;
const footer = {
	label: 'Footer',
	component: 'src/blocks/Footer.astro',
	slot: 'footer',
	fields: {
		address: text({ label: 'Address' }),
		extra: text({ label: 'Extra' }),
		// The frame's links (edit in context, Decision 7): left unmarked, never reported.
		links: list(link({ label: 'Link' }), { label: 'Links' }),
		menu: list({ label: text({ label: 'Label' }), href: link({ label: 'Address', addressOnly: true }) }, { label: 'Menu' }),
		// Labels of links built in code (weekend-bikes's nav): drawn inside the frame's links, so on the page.
		news: text({ label: 'News link' }),
		more: text({ label: 'More button' }),
		menuLabel: text({ label: 'Menu button label' }),
	},
} satisfies BlockConfig;

export default defineSite({
	collections: {
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
		faq: { label: 'FAQ', kind: 'fields', folder: 'content/faq', fields: { answer: text({ label: 'Answer' }) }, component: 'src/components/Entry.astro' },
		team: { kind: 'fields', folder: 'content/team', fields: { answer: text({ label: 'Role' }) }, component: 'src/components/Entry.astro' },
		// A post's teaser shows only on the listing's cards, marked as the post's there.
		posts: { kind: 'fields', folder: 'content/posts', urlBase: '/posts/', fields: { answer: text({ label: 'Line' }), teaser: text({ label: 'Teaser' }) }, component: 'src/components/Entry.astro' },
	},
	blocks: { hero, stats, answers, latest, listing, promo, footer },
	textStyles: {},
	page: 'src/components/Page.astro',
});
