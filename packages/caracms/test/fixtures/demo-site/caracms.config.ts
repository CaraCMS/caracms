import { defineSite } from 'caracms/config';
import { caseStudies } from './src/collections/case-studies.ts';
import { cases } from './src/blocks/cases.ts';
import { columns } from './src/blocks/columns.ts';
import { cta } from './src/blocks/cta.ts';
import { footer } from './src/blocks/footer.ts';
import { formBlock } from './src/blocks/form.ts';
import { gallery } from './src/blocks/gallery.ts';
import { hero } from './src/blocks/hero.ts';
import { textBlock } from './src/blocks/text.ts';
import { tm } from './src/blocks/tm.ts';
import { journalFields } from './src/collections/journal.ts';
import { forms } from './src/forms.ts';

/**
 * The demo site (a fictional studio). Everything caracms knows about
 * the site is here (M3 Decision 3); astro.config.mjs passes it to the integration.
 * The brand (name, accent, logo and tab icon) is Site Settings' (content/site-settings.json,
 * M5a Decision 10, M5b Decision 11), so the editor can change it.
 */
export default defineSite({
	collections: {
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
		journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: journalFields },
		// M5a Decision 17: a list-of-fields collection, at /work/<slug>.
		'case-studies': caseStudies,
	},
	blocks: {
		hero,
		text: textBlock,
		// M5b Decision 10: the media blocks.
		tm,
		gallery,
		cta,
		cases,
		// The editor-friction batch (item 1): two groups of fields, Left and Right.
		columns,
		// M6 Decision 17: one of the site's forms.
		form: formBlock,
		footer,
	},
	textStyles: {
		// One display style drives the CSS, the measurement and the editor's warning.
		// Uppercase and tracked, every axis of the variable font pinned (M1 → E4).
		// With the hero's 24px phone gutter, "Building a better mousetrap" fits the
		// 375 preview at about 21px, below this 28px minimum, and "Building a /
		// better mousetrap" at about 34px, above it (Phase 1's Verified note).
		display: {
			family: 'Bricolage Grotesque',
			cssVariable: '--font-display',
			fontFile: {
				measure: 'src/fonts/BricolageGrotesque.ttf',
				web: 'src/fonts/BricolageGrotesque.woff2',
			},
			weightRange: '200 800',
			axes: { wght: 700, wdth: 100, opsz: 96 },
			sizePx: 96,
			minSizePx: 28,
			trackingEm: 0.04,
			leading: 0.95,
			textTransform: 'uppercase',
		},
	},
	page: 'src/components/Page.astro',
	// The demo's own phone breakpoint is 640 (Page.astro's CSS), so phone lines match it.
	phoneLinesWidth: 640,
	// The demo lives in the caracms monorepo, so its files sit under starter/ in git (M4 Decision 3).
	repoPath: 'starter',
	// Times in the editor show in Ireland's time (M4 Decision 16).
	timeZone: 'Europe/Dublin',
	// M6 Decision 4: what a visitor can send the studio (src/forms.ts).
	forms,
});
