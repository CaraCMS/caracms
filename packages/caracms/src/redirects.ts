/**
 * Redirects (pre-M7 item 8): Site Settings' `redirects`, a list of `{ from, to }`
 * site addresses. Changing a document's address adds one, from the old address to
 * the new, unless it's asked not to (move.ts); the package serves them as 301s on the public site (redirect-middleware.ts).
 * Browser-safe (no imports beyond links.ts, files.ts and code-routes.ts): the Redirects section reads them too.
 *
 *   parseRedirects(raw)                        the list as the file holds it, cleaned
 *   redirectsAfterMove(list, from, to, add)    the list once a document moves
 *   redirectsAfterMoves(list, moves, homes?)   the list once several move at once (swaps, chains)
 *   redirectFor(list, pathname)                where a request for `pathname` goes, or null
 *   redirectTargetProblem(to, site)            the Redirects section's sentence when nothing is at `to`
 *
 * - **Both ends are `/paths`**, without a trailing slash (`/` stays `/`). An entry that
 *   isn't, or that goes nowhere (`from` = `to`), is dropped; so is a second entry for
 *   the same `from` (the first wins).
 * - **Chains collapse** when a document moves: every entry that went to its old
 *   address goes to the new one, so `/a → /b` then `/b → /c` is `/a → /c` and
 *   `/b → /c`, never two hops.
 * - **A real page wins**: an entry whose `from` is the moved document's new address
 *   is dropped (its page is back). The server also checks: it only redirects a
 *   request that would otherwise be a 404.
 */
import { codeRouteAt, type CodeRoute } from './code-routes.ts';
import { fileKeyOf } from './files.ts';
import { internalLinkPath, normaliseAddress } from './links.ts';

export interface Redirect {
	from: string;
	to: string;
}

/** A site address as a redirect holds it: `/path`, no trailing slash, no query or anchor. Null when it isn't one. */
export function redirectAddress(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const v = value.trim();
	if (!/^\/(?!\/)[^\s?#]*$/.test(v)) return null;
	return normaliseAddress(v);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The list as the file holds it: entries that aren't two addresses, go nowhere, or repeat a `from` are dropped. */
export function parseRedirects(raw: unknown): Redirect[] {
	if (!Array.isArray(raw)) return [];
	const out: Redirect[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const from = redirectAddress((entry as Record<string, unknown>).from);
		const to = redirectAddress((entry as Record<string, unknown>).to);
		if (!from || !to || same(from, to) || out.some((r) => same(r.from, from))) continue;
		out.push({ from, to });
	}
	return out;
}

/**
 * The list once a document moves from `from` to `to` (both its public addresses):
 * entries to `from` go to `to` (chains collapse), an entry from `to` goes (a page is
 * there now), and, when `add`, `from → to` is added (replacing any entry from `from`).
 * `add` is false for a document that was never live (made since the last Publish).
 */
export function redirectsAfterMove(list: readonly Redirect[], from: string, to: string, add: boolean): Redirect[] {
	const next = list
		.filter((r) => !same(r.from, to) && !(add && same(r.from, from)))
		.map((r) => (same(r.to, from) ? { from: r.from, to } : r))
		.filter((r) => !same(r.from, r.to));
	if (add && !same(from, to)) next.push({ from, to });
	return next;
}

/**
 * A document's live address (the one the public site served at the last Publish) and
 * where it is once the plan has landed: live mode's documents moved since the last Publish
 * (autosaves.ts → `recordAddresses`). `redirectsAfterMoves` adds `live → now` when a move
 * in the plan vacates `live`.
 */
export interface LiveHome {
	live: string;
	now: string;
}

/** The homes whose live address a move in the plan vacates and no document then takes: each adds `live → now`. */
function strandedHomes(moves: readonly { from: string; to: string }[], homes: readonly LiveHome[]): Redirect[] {
	const taken = (address: string) => moves.some((m) => same(m.to, address));
	const out: Redirect[] = [];
	for (const h of homes) {
		if (same(h.live, h.now) || taken(h.live) || !moves.some((m) => same(m.from, h.live))) continue;
		if (out.some((r) => same(r.from, h.live))) continue;
		out.push({ from: h.live, to: h.now });
	}
	return out;
}

/**
 * The list once several documents move at once (the many-move engine): every move is
 * taken against the list before the plan, so a swap or a chain comes out as its
 * documents end up. Entries to an old address go to that document's new one (chains
 * collapse, one step: `X → A` becomes `X → B` when A moves to B); an entry from an
 * address a document now occupies goes (a page is there); and, per move with `add`,
 * `from → to` is added, unless another document now sits at `from` (in a swap neither
 * is added). With no address both vacated and taken, this is `redirectsAfterMove` per
 * move, in order.
 *
 * `homes` (live mode, and only when the move leaves redirects): when a move vacates an
 * address that is another document's live address (a chain before a Publish left that
 * document without a redirect from it, since a document sat there), `live → now` is added
 * too, replacing any entry from that address, so the public site's old address still
 * finds its document after the Publish.
 */
export function redirectsAfterMoves(list: readonly Redirect[], moves: readonly { from: string; to: string; add: boolean }[], homes: readonly LiveHome[] = []): Redirect[] {
	const taken = (address: string) => moves.some((m) => same(m.to, address));
	const stranded = strandedHomes(moves, homes);
	const replaced = (address: string) => moves.some((m) => m.add && same(m.from, address)) || stranded.some((r) => same(r.from, address));
	const next = list
		.filter((r) => !taken(r.from) && !replaced(r.from))
		.map((r) => {
			const m = moves.find((m) => same(r.to, m.from));
			return m ? { from: r.from, to: m.to } : r;
		})
		.filter((r) => !same(r.from, r.to));
	for (const r of redirectsAddedBy(moves, homes)) next.push(r);
	return next;
}

/** The redirects a plan adds (`redirectsAfterMoves`): one per move with `add`, unless another document now sits at its old address, and one per stranded live address (`homes`). */
export function redirectsAddedBy(moves: readonly { from: string; to: string; add: boolean }[], homes: readonly LiveHome[] = []): Redirect[] {
	const taken = (address: string) => moves.some((m) => same(m.to, address));
	const added = moves.filter((m) => m.add && !same(m.from, m.to) && !taken(m.from)).map((m) => ({ from: m.from, to: m.to }));
	for (const r of strandedHomes(moves, homes)) if (!added.some((a) => same(a.from, r.from))) added.push(r);
	return added;
}

/** Where a request for `pathname` goes, or null. Matched without a trailing slash; letter case counts, as it does for pages. */
export function redirectFor(list: readonly Redirect[], pathname: string): string | null {
	let path: string;
	try {
		path = normaliseAddress(decodeURI(pathname));
	} catch {
		path = normaliseAddress(pathname);
	}
	return list.find((r) => r.from === path)?.to ?? null;
}

/**
 * The Redirects section's sentence when nothing is at a redirect's new address, or null.
 * Checked as a link is (Decision 4): a file address (`/files/<hash>/<name>`, a Tina port's
 * old file links) against the library's keys, once they're known; an address a route of the
 * site's own code serves is there; an address with an extension (`/sitemap.xml`, a file in
 * `public/`) isn't checked; any other must be a document's.
 */
export function redirectTargetProblem(
	to: string,
	site: { addresses?: Iterable<string | null | undefined>; codeRoutes?: readonly CodeRoute[]; fileExists?: (key: string) => boolean },
): string | null {
	const file = fileKeyOf(to.trim());
	if (file) return site.fileExists && !site.fileExists(file.key) ? 'No file in the library is at the address it goes to.' : null;
	const path = internalLinkPath(to);
	if (path === null || codeRouteAt(path, site.codeRoutes)) return null;
	for (const a of site.addresses ?? []) if (a && same(normaliseAddress(a), path)) return null;
	return 'No page is at the address it goes to.';
}
