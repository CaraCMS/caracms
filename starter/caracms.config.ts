import { defineSite } from 'caracms/config';
import { caseStudies } from './src/collections/case-studies.ts';
import { journal } from './src/collections/journal.ts';
import { tags } from './src/collections/tags.ts';
import { workshops } from './src/collections/workshops.ts';
import { cases } from './src/blocks/cases.ts';
import { columns } from './src/blocks/columns.ts';
import { cards } from './src/blocks/cards.ts';
import { cta } from './src/blocks/cta.ts';
import { faq } from './src/blocks/faq.ts';
import { features } from './src/blocks/features.ts';
import { formBlock } from './src/blocks/form.ts';
import { gallery } from './src/blocks/gallery.ts';
import { posts } from './src/blocks/posts.ts';
import { hero } from './src/blocks/hero.ts';
import { fullMedia } from './src/blocks/media.ts';
import { textBlock } from './src/blocks/text.ts';
import { tm } from './src/blocks/tm.ts';
import { siteFooter } from './src/blocks/site-footer.ts';
import { siteHeader } from './src/blocks/site-header.ts';
import { forms } from './src/forms.ts';
import { siteSettings } from './src/settings.ts';
import { textStyles } from './src/styles/text-styles.ts';

/**
 * The starter: a site about CaraCMS itself. Everything caracms knows about the site is
 * here (M3 Decision 3); astro.config.mjs passes it to the integration. Its look isn't:
 * that's src/styles/ (M7 Decision 6), and this file only imports the lockup styles from there.
 * The brand (name, accent, logo and tab icon) is Site Settings' (content/site-settings.json,
 * M5a Decision 10, M5b Decision 11), so the editor can change it.
 */
export default defineSite({
	collections: {
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
		// Posts and tags (Decisions 6–8): dated posts with tags, cover and excerpt, and the tags at /tags/<slug>.
		journal,
		// M5a Decision 17: a list-of-fields collection, at /work/<slug>.
		'case-studies': caseStudies,
		tags,
		// Form rows and sourced selects: the workshops the booking form books, with no pages of their own.
		workshops,
	},
	// M7 Decision 10: the template's generic sections, by outcome. A type's key is stored
	// in content, so the kept ones keep theirs.
	blocks: {
		hero,
		text: textBlock,
		tm,
		// The editor-friction batch (item 1): two groups of fields, Left and Right.
		columns,
		cards,
		features,
		faq,
		media: fullMedia,
		gallery,
		cta,
		cases,
		// Posts and tags (Decision 9): the journal's posts, the latest few or all a page at a time.
		posts,
		// M6 Decision 17: one of the site's forms.
		form: formBlock,
		// Edit in context, Decision 16: the page's header and footer, shared blocks in their slots.
		siteHeader,
		siteFooter,
	},
	// M7 Decision 7: the lockup styles are part of the look, in src/styles/text-styles.ts.
	textStyles,
	// M7 Decision 16: the page shell's menu, footer columns, contact details and social links.
	settings: { fields: siteSettings },
	page: 'src/components/Page.astro',
	// M7 Decision 8: Tailwind's md breakpoint, where the tokens step and the header's phone menu switches.
	phoneLinesWidth: 768,
	// The starter lives in the caracms monorepo, so its files sit under starter/ in git (M4 Decision 3).
	repoPath: 'starter',
	// Times in the editor show in Ireland's time (M4 Decision 16).
	timeZone: 'Europe/Dublin',
	// M6 Decision 4: what a visitor can send the site (src/forms.ts).
	forms,
});
