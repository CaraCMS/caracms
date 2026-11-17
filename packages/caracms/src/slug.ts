/**
 * Addresses from names, and the rules a new document's address follows (M5a
 * Decision 11). **Browser-safe** (its one import, code-routes.ts, is too): Phase 5's New page dialog shows the
 * address before creating with `slugify`, and can check it with `addressProblem`;
 * the create route (editor/server/create.ts) applies the same two, so the dialog and
 * the server never disagree.
 *
 * - **`slugify(name)`**: lower case, accents folded (NFKD, marks dropped, plus the few
 *   letters that don't decompose: ß ss, æ ae, œ oe, ø o, ł l, đ/ð d, þ th, ı i), `&`
 *   as "and", every other run of characters that aren't letters or digits as one
 *   hyphen, hyphens trimmed from both ends, at most 60 characters (cut, then trimmed
 *   again). Letters and digits are Unicode's (`\p{L}`, `\p{N}`), as the decision words
 *   it, so a name in another script keeps its letters. A name that leaves nothing
 *   (only symbols) gives `''`, which the dialog and the route refuse.
 * - **`isSlug(part)`**: a part of an address that `slugify` leaves as it is.
 * - **`addressProblem(url, …)`**: why a new document can't have this public address,
 *   or null: under the editor's own `/admin` or `/_caracms`, or the library's files'
 *   `/files` (M6c Decision 3, served by files-route.ts); strictly below another
 *   collection's non-root `urlBase` (exactly at it is allowed: the Work page at
 *   `/work`), unless a page holds that collection (collections under pages, Decision 6:
 *   pages may sit under a holder beside its documents); or another document's address
 *   already, in any collection, held documents included (Decision 8), naming it.
 */
import { codeRouteAt, codeRouteMessage, type CodeRoute } from './code-routes.ts';

/** The longest an address part may be (Decision 11). */
export const SLUG_MAX = 60;

/** `index` is Home's file name (M3 Decision 8), so no part of a new address can be it. */
export const RESERVED_SLUG = 'index';

const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

/** A name as an address part: `Salt & Pepper` → `salt-and-pepper`, `Café Ölé` → `cafe-ole`. `''` when nothing is left. */
export function slugify(name: string): string {
	let s = String(name).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
	s = s.replace(/[ßæœøłđðþı]/g, (c) => FOLD[c]!);
	s = s.replace(/&/g, ' and ');
	s = s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
	s = s.normalize('NFC');
	const chars = [...s];
	if (chars.length > SLUG_MAX) s = chars.slice(0, SLUG_MAX).join('').replace(/-+$/, '');
	return s;
}

/** Is this an address part `slugify` leaves unchanged (and not empty)? */
export function isSlug(part: string): boolean {
	return typeof part === 'string' && part.length > 0 && slugify(part) === part;
}

/** The message for a name that leaves no address (only symbols). */
export const NO_ADDRESS_MESSAGE = 'That name has no letters or numbers to make an address from.';

/** The message for `index` as an address. */
export const INDEX_MESSAGE = '"index" is kept for Home, so it can\'t be an address. Choose another name.';

/** What `addressProblem` needs of a collection. */
export interface AddressCollection {
	name: string;
	label: string;
	/** Starts and ends with `/`; null for collections with no pages (shared blocks, Site Settings). A held collection's is its resolved base (held.ts). */
	urlBase: string | null;
	/** Collections under pages: set on a collection a page holds, whose base doesn't refuse pages below it (Decision 6). */
	heldBy?: string | null;
}

/** What `addressProblem` needs of a document. */
export interface AddressDocument {
	collection: string;
	path: string;
	url: string | null;
	/** What the editor lists it as: `address-taken` names a document of another collection by it (Decision 8). */
	label?: string;
}

export type AddressProblemCode = 'reserved-address' | 'below-collection' | 'address-taken';

export interface AddressProblem {
	code: AddressProblemCode;
	message: string;
}

/** An address compared with others: lower case, no trailing slash (`/` stays `/`). */
export const sameAddress = (url: string): string => {
	const lower = url.toLowerCase();
	return lower.length > 1 ? lower.replace(/\/+$/, '') : lower;
};

/**
 * Why a new document in `collection` can't be at `url` (its public address), or null.
 * `documents` is every document there is now, in every collection.
 */
export function addressProblem(
	url: string,
	collection: string,
	collections: readonly AddressCollection[],
	documents: readonly AddressDocument[],
	codeRoutes?: readonly CodeRoute[],
): AddressProblem | null {
	const at = sameAddress(url);
	for (const reserved of ['/admin', '/_caracms']) {
		if (at === reserved || at.startsWith(`${reserved}/`)) {
			return { code: 'reserved-address', message: `${url} is the editor's own address, so a page can't go there.` };
		}
	}
	const files = '/files';
	if (at === files || at.startsWith(`${files}/`)) {
		return { code: 'reserved-address', message: `${url} is where the library's files are served, so a page can't go there.` };
	}
	// M8 Decision 10: a URL the site's own code serves.
	const route = codeRouteAt(url, codeRoutes);
	if (route) return { code: 'reserved-address', message: codeRouteMessage(url, route) };
	for (const other of collections) {
		if (other.name === collection || other.urlBase === null || other.heldBy) continue;
		const base = sameAddress(other.urlBase);
		if (base === '/') continue;
		if (at.startsWith(`${base}/`)) {
			return {
				code: 'below-collection',
				message: `${url} is under ${other.label} (${other.urlBase}), so it can't be a page here. Create it in ${other.label} instead.`,
			};
		}
	}
	const taken = documents.find((d) => d.url !== null && sameAddress(d.url) === at);
	if (taken) {
		// Decision 8: a held document and a page can't share an address either way; the other is named.
		const other = taken.collection !== collection ? collections.find((c) => c.name === taken.collection) : undefined;
		const named = other && taken.label ? `: “${taken.label}” in ${other.label}` : '';
		return { code: 'address-taken', message: `There's already a page at ${url}${named}.` };
	}
	return null;
}
