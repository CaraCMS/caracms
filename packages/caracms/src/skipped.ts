/**
 * The mark a preview render leaves where a block it skips would be (M3 Decision 17;
 * Blocks.astro): an HTML comment, `<!--cms-skipped 3 type=carousel-->` (with
 * ` shared=footer` for a shared-block entry, and ` slot=footer` for one naming a slot's block,
 * edit in context Decision 2), never an element. A site's sibling CSS
 * (`+`, `:has(+ …)`) matches across a comment, so the preview's blocks join as the
 * public page's do, where there's nothing for the block at all. The editor finds the
 * comment (preview/markers.ts → skippedAnchor) and draws its mark in the overlay layer.
 *
 * The type and shared name are percent-encoded, so no `--` or `>` from a content
 * file can end the comment early.
 */

const PREFIX = 'cms-skipped ';

/** The comment for block `index`, skipped, as HTML. */
export function skippedMarker(index: number, skipped: { type: string; shared?: string; slot?: string }): string {
	const shared = skipped.shared !== undefined ? ` shared=${encodeURIComponent(skipped.shared)}` : '';
	const slot = skipped.slot !== undefined ? ` slot=${encodeURIComponent(skipped.slot)}` : '';
	return `<!--${PREFIX}${index} type=${encodeURIComponent(skipped.type)}${shared}${slot}-->`;
}

/** A comment's text read back, or null when it isn't a skipped block's. */
export function parseSkipped(text: string): { index: number; type: string; shared?: string; slot?: string } | null {
	if (!text.startsWith(PREFIX)) return null;
	const [index, ...rest] = text.slice(PREFIX.length).trim().split(' ');
	if (!/^\d+$/.test(index ?? '')) return null;
	const out: { index: number; type: string; shared?: string; slot?: string } = { index: Number(index), type: '' };
	for (const part of rest) {
		const eq = part.indexOf('=');
		const key = part.slice(0, eq);
		const value = decodeURIComponent(part.slice(eq + 1));
		if (key === 'type') out.type = value;
		else if (key === 'shared') out.shared = value;
		else if (key === 'slot') out.slot = value;
	}
	return out;
}
