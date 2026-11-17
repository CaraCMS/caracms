import { select } from 'caracms/config';

/**
 * Every block's Background and Spacing (M7 Decision 11), from the tokens.
 *
 * Background is a scheme: Light (the surface), Grey (`grey-50`), Dark (the ink) and
 * Accent. Each sets its band's text, link and button colours (site.css → `.scheme-*`).
 * Space above and Space below are the section roles: None, Tight, Default, Extra
 * (`--spacing-section*`). Each select has a default, so an unset value, or one the
 * options don't know (a `photo` left in a draft by an older look), renders as Light and Default.
 */
export const background = (help?: string) =>
	select({
		label: 'Background',
		...(help ? { help } : {}),
		options: [
			{ value: 'light', label: 'Light' },
			{ value: 'grey', label: 'Grey' },
			{ value: 'dark', label: 'Dark' },
			{ value: 'accent', label: 'Accent' },
		],
		default: 'light',
	});

const space = (label: string) =>
	select({
		label,
		options: [
			{ value: 'none', label: 'None' },
			{ value: 'tight', label: 'Tight' },
			{ value: 'default', label: 'Default' },
			{ value: 'extra', label: 'Extra' },
		],
		default: 'default',
	});

/** The three fields every block ends with: `...band()`. A block can add help under Background. */
export const band = (options: { backgroundHelp?: string } = {}) => ({
	background: background(options.backgroundHelp),
	spaceAbove: space('Space above'),
	spaceBelow: space('Space below'),
});

type Scheme = 'light' | 'grey' | 'dark' | 'accent';
type Space = 'none' | 'tight' | 'default' | 'extra';

// Whole class names, so Tailwind finds them in this file.
const SCHEME: Record<Scheme, string> = { light: 'scheme-light', grey: 'scheme-grey', dark: 'scheme-dark', accent: 'scheme-accent' };
const ABOVE: Record<Space, string> = { none: 'pt-0', tight: 'pt-section-tight', default: 'pt-section', extra: 'pt-section-extra' };
const BELOW: Record<Space, string> = { none: 'pb-0', tight: 'pb-section-tight', default: 'pb-section', extra: 'pb-section-extra' };

/**
 * A block's band classes: `band`, its scheme, and its padding above and below.
 * `flush`: no padding above whatever Space above says (a hero with media behind its
 * text sits flush under the header: a layout rule, in code). `media`: white text on a
 * scrim over media, whatever Background says (the media covers the band).
 */
export function bandClass(block: { background: Scheme; spaceAbove: Space; spaceBelow: Space }, options: { flush?: boolean; media?: boolean } = {}): string {
	return ['band', options.media ? 'scheme-media' : SCHEME[block.background], options.flush ? 'pt-0' : ABOVE[block.spaceAbove], BELOW[block.spaceBelow]].join(' ');
}
