import type { SiteConfig } from 'caracms/config';

/**
 * The lockup text styles (M7 Decision 7): part of the look, beside tokens.css, and
 * imported by caracms.config.ts. A lockup's style needs a font file to measure (Spec →
 * Text), so it can't be a CSS token; it's the one place the display type is set.
 *
 * `display`: Inter 4 (the body family, Decision 4), at the display token's settings
 * (`--text-display`: 500, -0.035em, 1.02). `sizePx` is the token's largest size, 88.
 * Measured with the variable font's TTF, served as its WOFF2 (both Latin subsets of the
 * same file, so they shape alike). Within 0.03% of Chrome at this tracking (M1 → E4
 * allows 0.064%; *Decisions during build*, 2026-10-19).
 *
 * `minSizePx`: 32. At 375 a lockup has 335px (the 20px gutters): "Building a better
 * mousetrap" on one line fits at about 26px, below this, so the editor warns and
 * suggests a break; "Building a / better mousetrap" fits at about 52px, above it.
 */
export const textStyles = {
	display: {
		family: 'Inter',
		cssVariable: '--font-display',
		fontFile: {
			measure: 'src/fonts/InterVariable.ttf',
			web: 'src/fonts/InterVariable.woff2',
		},
		weightRange: '100 900',
		axes: { wght: 500, opsz: 32 },
		sizePx: 88,
		minSizePx: 32,
		trackingEm: -0.035,
		leading: 1.02,
		textTransform: 'none',
	},
} satisfies SiteConfig['textStyles'];
