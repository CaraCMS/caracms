/**
 * A resolved site for the package's unit tests: the demo's block shapes (hero,
 * text, cta), a display style, and two collections over test/fixtures/site/content.
 * Built with resolveSite, so it's validated the way a real config is.
 */
import { fileURLToPath } from 'node:url';
import { defineSite, lockup, resolveSite, select, text, type SiteConfig } from '../../src/config.ts';

export const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const siteRoot = `${fixtures}site`;

const background = () => select({ options: ['light', 'dark', 'photo'] });

export const display = {
	family: 'Bricolage Grotesque',
	cssVariable: '--font-display',
	fontFile: { measure: '../fonts/BricolageGrotesque.ttf', web: '../fonts/BricolageGrotesque.ttf' },
	weightRange: '200 800',
	axes: { wght: 700, wdth: 100, opsz: 96 },
	sizePx: 96,
	minSizePx: 28,
	trackingEm: 0.04,
	leading: 1,
	textTransform: 'uppercase',
} as const;

export const config = defineSite({
	collections: {
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
		journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal' },
	},
	blocks: {
		hero: {
			component: 'Block.astro',
			fields: {
				heading: lockup({ style: 'display' }),
				intro: text({ multiline: true }),
				layout: select({ options: ['left', 'centre'] }),
				background: background(),
			},
		},
		text: {
			component: 'Block.astro',
			fields: { heading: text({ heading: true }), body: text({ multiline: true }), background: background() },
		},
		cta: {
			component: 'Block.astro',
			fields: { heading: lockup({ style: 'display' }), text: text({ multiline: true }), button: text(), background: background() },
		},
	},
	textStyles: { display },
	page: 'Block.astro',
});

export const site = resolveSite(config as SiteConfig, siteRoot);

/** The config with some keys replaced, for validation tests. */
export const variant = (patch: Partial<SiteConfig>): SiteConfig => ({ ...(config as SiteConfig), ...patch });
