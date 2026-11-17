import type { SiteConfig } from 'caracms/config';

/**
 * The second look's lockup text style: the restyle proof's (M7 Decision 9), swapped in for the
 * starter's src/styles/text-styles.ts at the same path. It's the pre-M7 demo's `display`
 * style, unchanged: Bricolage Grotesque, uppercase and tracked, every axis of the variable
 * font pinned (M1 → E4). With the 20px phone gutter, "Building a better mousetrap" fits the
 * 375 preview below this 28px minimum, and "Building a / better mousetrap" above it.
 */
export const textStyles = {
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
} satisfies SiteConfig['textStyles'];
