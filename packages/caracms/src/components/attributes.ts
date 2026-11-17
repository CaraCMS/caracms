/**
 * The attributes a caller passes through a package component (`<Block data-home-hero>`,
 * `<Text … hidden={!open}>`), as they'd render on a plain element in Astro (M8 trial,
 * item 4). A prop written bare reaches a component as `true`, and Astro's spread writes
 * `true` as `="true"` for most attributes; on a plain element the source's bare attribute
 * stays bare. So:
 *
 * - `true` is a bare attribute (`data-home-hero`, not `data-home-hero="true"`). Most names
 *   get `''`, which Astro writes bare; an HTML boolean attribute (`novalidate`, `hidden`,
 *   `disabled`, `open`, `required`…) keeps `true`, since Astro drops `''` for those;
 * - `false`, `undefined` and `null` are no attribute at all (kept as `undefined`, so a
 *   caller's `download={false}` still overrides what the component would add);
 * - anything else passes as given.
 *
 * Except where `"true"` and `"false"` are the attribute's own values, which Astro writes as
 * text on a plain element too: `aria-*`, `draggable`, `contenteditable`, `spellcheck` and
 * `writingsuggestions` pass unchanged (`aria-hidden={true}` stays `aria-hidden="true"`).
 *
 * Browser-safe, no imports.
 */
const TRUE_FALSE_VALUES = new Set(['draggable', 'contenteditable', 'spellcheck', 'writingsuggestions']);

/** The names Astro writes bare for `true` and drops for `''` (its own list, plus `hidden`, `download` and `popover`). */
const HTML_BOOLEAN =
	/^(?:allowfullscreen|async|autofocus|autoplay|checked|controls|default|defer|disabled|disablepictureinpicture|disableremoteplayback|download|formnovalidate|hidden|inert|itemscope|loop|muted|nomodule|novalidate|open|playsinline|popover|readonly|required|reversed|scoped|seamless|selected)$/i;

const keepsBooleans = (name: string) => name.startsWith('aria-') || TRUE_FALSE_VALUES.has(name.toLowerCase());

/** The pass-through attributes with booleans as a plain element renders a bare attribute. */
export function passThrough(attributes: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(attributes)) {
		if (typeof value === 'boolean' && keepsBooleans(name)) out[name] = value;
		else if (value === true) out[name] = HTML_BOOLEAN.test(name) ? true : '';
		else if (value === false || value === null) out[name] = undefined;
		else out[name] = value;
	}
	return out;
}
