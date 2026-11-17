/**
 * Text styles (Spec → Text: "defined once per site"). The same definition drives
 *   - the CSS (the Lockup component reads it into custom properties, and the
 *     integration registers its font with Astro's fonts API),
 *   - the measurement (measure.ts shapes text with these axes, tracking and transform),
 *   - and the editor's "Too long for mobile" warning (Phase 3), which compares the
 *     phone preview's computed size with `minSizePx` (exposed on the lockup in
 *     preview renders as `data-cms-min-size`).
 *
 * Plain data with no imports, so a site's config, components, tests and the editor
 * can all import it.
 */

export type TextTransform = 'none' | 'uppercase' | 'lowercase';

export interface TextStyle {
	/** The CSS font-family name the fonts API registers. */
	family: string;
	/** The CSS variable Astro's fonts API defines for the family, e.g. `--font-display`. */
	cssVariable: `--${string}`;
	/** Font files, relative to the site's root. */
	fontFile: {
		/** The file measured at render (harfbuzzjs reads TTF/OTF, not WOFF2). */
		measure: string;
		/** The file the page serves, through Astro's fonts API. */
		web: string;
	};
	/** The `@font-face` weight range of a variable web font, e.g. `"200 800"`. */
	weightRange: string;
	/**
	 * Every variable axis pinned to one value (M1 → E4). Set in CSS with
	 * `font-variation-settings` (plus `font-optical-sizing: none`) and used by the
	 * shaper, so the em width doesn't change with the font size. A static font: `{}`.
	 */
	axes: Record<string, number>;
	/** The design size in px. The fit never goes above it. */
	sizePx: number;
	/** Editorial minimum in px. Not a CSS floor (Spec → Text); the editor's warning reads it. */
	minSizePx: number;
	/** Letter-spacing in em, so it scales with the font size. */
	trackingEm: number;
	/** Line height, unitless. */
	leading: number;
	/** Applied before shaping, as the browser does. */
	textTransform: TextTransform;
	/** Fallback families after the web font. Default `['sans-serif']`. */
	fallbacks?: string[];
}

/** A style plus its name in the site's config, and its font files resolved to absolute paths. */
export interface ResolvedTextStyle extends TextStyle {
	name: string;
	/** Absolute paths, resolved against the site's root by the integration. */
	resolvedFontFile: { measure: string; web: string };
}

/** CSS `font-variation-settings` value for a style's pinned axes (`normal` if none). */
export function variationSettings(style: Pick<TextStyle, 'axes'>): string {
	const entries = Object.entries(style.axes);
	if (entries.length === 0) return 'normal';
	return entries.map(([tag, value]) => `"${tag}" ${value}`).join(', ');
}
