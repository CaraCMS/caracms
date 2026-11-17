/**
 * The one heading-slug rule, for the kit's Markdown writer and reader.
 *
 * Re-exports caracms's own `headingId` (exported from `caracms/content`), the function the
 * rendered `h2`/`h3` ids and the table of contents use: GitHub's slug (lower case, spaces to
 * `-`, punctuation dropped), made unique on a page with `-1`, `-2`… across every block.
 * Keeping it behind this one import means the kit never grows a second copy of the rule.
 *
 * Assumes caracms with heading ids (the release after 0.13.1).
 */
import { headingId, type HeadingSeen } from 'caracms/content';

export { headingId, type HeadingSeen };

/** The ids for a page's heading texts, in page order (`''` for one with nothing to slug). */
export function headingIds(texts: readonly string[]): string[] {
	const seen: HeadingSeen = new Map();
	return texts.map((t) => headingId(t.replace(/\s*\n\s*/g, ' ').trim(), seen));
}
