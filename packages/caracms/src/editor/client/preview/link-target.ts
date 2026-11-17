/**
 * Where a link in the preview goes, for following it from the page (follow-links.ts):
 *
 *   document   a document in the editor: its page (`/about`), or a paged listing of it
 *              (`/journal/page/2` → the page at `/journal`)
 *   external   a web address on another site, or a file (`/brochure.pdf`): a new tab
 *   contact    `mailto:` or `tel:`: not followed (no mail app mid-edit); the chip shows it
 *   none       a page with no document in the editor (a redirect, a missing page), or a
 *              link to a spot on this page (`#team`): not followed; the chip says why
 *
 * Plain functions, no DOM beyond reading the anchor's `href`.
 */
import type { ListedDocument } from '../../types.ts';

export type LinkTarget =
	| { kind: 'document'; doc: ListedDocument; label: string }
	| { kind: 'external'; href: string; label: string }
	| { kind: 'contact'; label: string }
	| { kind: 'none'; label: string };

/** A document whose address is `href` (a `/path`, trailing slash and query ignored), if there is one. */
export function documentAt(href: string, documents: readonly ListedDocument[]): ListedDocument | undefined {
	const path = href.trim().replace(/[?#].*$/, '').replace(/\/+$/, '') || '/';
	if (!path.startsWith('/')) return undefined;
	return documents.find((d) => d.url !== null && (d.url.replace(/\/+$/, '') || '/') === path);
}

/**
 * What following `href` does. `here` is the preview frame's location (its origin decides
 * what's on this site); `documents` the editor's listing.
 */
export function linkTarget(href: string, here: { origin: string }, documents: readonly ListedDocument[]): LinkTarget {
	const raw = href.trim();
	if (/^(mailto|tel):/i.test(raw)) return { kind: 'contact', label: raw.replace(/^(mailto|tel):/i, '').replace(/\?.*$/, '') };
	if (raw === '' || raw.startsWith('#')) return { kind: 'none', label: 'On this page' };
	let url: URL;
	try {
		url = new URL(raw, `${here.origin}/`);
	} catch {
		return { kind: 'none', label: raw };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'none', label: raw };
	if (url.origin !== here.origin) return { kind: 'external', href: url.href, label: url.host.replace(/^www\./, '') };
	const path = url.pathname;
	// A file in `public/` (an extension in the last part) isn't a page: it opens in a tab.
	if (/\.[A-Za-z0-9]+$/.test(path.split('/').pop() ?? '')) return { kind: 'external', href: url.href, label: path };
	const doc = documentAt(path, documents) ?? documentAt(path.replace(/\/page\/\d+\/?$/, '') || '/', documents);
	if (doc) return { kind: 'document', doc, label: doc.url ?? path };
	return { kind: 'none', label: path };
}
