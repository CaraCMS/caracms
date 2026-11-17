/**
 * The one link rule (M5a Decision 4), lifted from the template
 * (the Tina template's `validateLink`). The editor's link
 * inputs and the render both import it, so a link the field flags is exactly a
 * link the page shows as plain text.
 *
 * Browser-safe: no node imports.
 *
 *   validateLink(value)            the rule's message, or undefined (blank passes)
 *   isLinkHref(value)              true when the value is a usable href: non-blank and passes
 *   missingLinkTarget(href, urls)  "Links to /contact, which no page or route serves", or undefined
 *
 * Anything that fails the rule is kept as typed, with the message on the field,
 * and renders as plain text (Decision 15).
 */

const RELATIVE_PATH = /^\/(?!\/)\S*$/;
const ABSOLUTE_URL = /^https?:\/\/\S+$/;
const MAILTO = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEL = /^tel:\+?[0-9][0-9\s().-]*$/;
/**
 * A fragment: `#` alone (the top of the page, a placeholder link), or `#` then an HTML
 * id (any characters but spaces, HTML's own rule for an id).
 */
const ANCHOR = /^#\S*$/;

/** The rule's message: what the field says under a link that fails it. */
export const LINK_RULE_MESSAGE =
	'Enter a path starting with "/" (e.g. /contact), a full https:// URL, mailto:someone@example.com, tel:+353210000000, or an anchor on the page (#contact, or # alone).';

/**
 * The link rule: a `/path`, an `http(s)://` URL, `mailto:`, `tel:`, or a fragment (`#`, `#anchor`).
 * Blank passes (an empty link is a different matter: it shows nothing). Returns
 * the rule's message, or undefined when the value passes.
 */
export function validateLink(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.trim() === '') return undefined;
	const candidate = value.trim();
	if (RELATIVE_PATH.test(candidate) || ABSOLUTE_URL.test(candidate) || MAILTO.test(candidate) || TEL.test(candidate) || ANCHOR.test(candidate)) {
		return undefined;
	}
	return LINK_RULE_MESSAGE;
}

/** A usable href: a non-blank string that passes the rule. What the render checks before writing `<a href>`. */
export function isLinkHref(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '' && validateLink(value) === undefined;
}

/**
 * The site path an internal link points at, for comparing with documents'
 * addresses: `/contact/?x#y` → `/contact`. Null for anything that isn't checked:
 * not a `/path`, or a path to a file (an extension in its last part, such as
 * `/brochure.pdf`, a file in `public/`).
 */
export function internalLinkPath(href: unknown): string | null {
	if (typeof href !== 'string') return null;
	const candidate = href.trim();
	if (!RELATIVE_PATH.test(candidate)) return null;
	let path = candidate.replace(/[?#].*$/, '');
	const last = path.split('/').pop() ?? '';
	if (/\.[A-Za-z0-9]+$/.test(last)) return null;
	path = normaliseAddress(path);
	return path;
}

/** `/services/branding/` → `/services/branding`; `/` stays `/`. */
export function normaliseAddress(url: string): string {
	const trimmed = url.replace(/\/+$/, '');
	return trimmed === '' ? '/' : trimmed;
}

/**
 * Decision 4's warning: a `/path` with no file extension that matches no
 * document. `addresses` are the site's documents' URLs (DocumentEntry.url:
 * `/`, `/about`, `/journal/my-first-post`), from the store's listing (Phase 2
 * wires it). Never an error: a warning the field shows.
 */
/** M9 Decision 7: the hidden pages in a listing, as `WarningContext.hiddenPages` takes them (address → name). */
export function hiddenPages(entries: Iterable<{ url: string | null; label: string; hidden?: true }>): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of entries) if (e.hidden && e.url !== null) out.set(normaliseAddress(e.url), e.label);
	return out;
}

/** M9 Decision 7: the hidden documents in a listing, as `WarningContext.hiddenDocuments` takes them (`collection/path` → name and address). */
export function hiddenDocuments(entries: Iterable<{ collection: string; path: string; url: string | null; label: string; hidden?: true }>): Map<string, { label: string; url: string | null }> {
	const out = new Map<string, { label: string; url: string | null }>();
	for (const e of entries) if (e.hidden) out.set(`${e.collection}/${e.path}`, { label: e.label, url: e.url === null ? null : normaliseAddress(e.url) });
	return out;
}

/**
 * M9 Decision 7's warning for a reference (a `reference()` field) to a hidden page, worded as
 * the link one is. Never an error: unhiding the page fixes it.
 */
export function hiddenReferenceTarget(collection: string, path: string, hidden: ReadonlyMap<string, { label: string; url: string | null }>): string | undefined {
	const doc = hidden.get(`${collection}/${path}`);
	if (!doc) return undefined;
	return `Points at ${doc.url ?? path}, the ${doc.label || path} page, which is hidden from the site. Visitors get its 404 until it's shown again.`;
}

/**
 * M9 Decision 7's warning: a link to a hidden page. `hidden` maps a hidden page's address
 * (normalised) to its name. Never an error: unhiding the page fixes it.
 */
export function hiddenLinkTarget(href: unknown, hidden: ReadonlyMap<string, string>): string | undefined {
	const path = internalLinkPath(href);
	if (path === null) return undefined;
	const name = hidden.get(path);
	return name === undefined ? undefined : `Links to ${path}, the ${name} page, which is hidden from the site. Visitors get its 404 until it's shown again.`;
}

export function missingLinkTarget(href: unknown, addresses: Iterable<string | null | undefined>): string | undefined {
	const path = internalLinkPath(href);
	if (path === null) return undefined;
	for (const address of addresses) {
		if (typeof address === 'string' && normaliseAddress(address) === path) return undefined;
	}
	return `Links to ${path}, which no page or route serves.`;
}
