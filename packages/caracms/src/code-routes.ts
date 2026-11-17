/**
 * Code routes (M8 Decision 10): the URLs the site's own `src/pages/` serves, which a
 * document can't take. A page is either code or a document, never both.
 *
 * - **Read from the file names**, as Astro's file routing reads them (`srcDir` honoured
 *   by the caller): `about.astro` is `/about`, `index.astro` its folder, `sitemap.xml.ts`
 *   `/sitemap.xml`, `[slug]` and `[...rest]` are parameters. Endpoints count too. A file
 *   or folder whose name starts with `_` or `.` isn't a route (Astro's rule).
 * - **The documents' own routes reserve nothing:** a route with parameters whose static
 *   prefix is a collection's `urlBase` (the catch-all `[...path].astro` at `/`,
 *   `work/[slug].astro` at `/work/`).
 * - **One per base.** When several routes with parameters sit at one collection's
 *   `urlBase`, the collection's own is the one Astro ranks last (`[...path]` below
 *   `[slug]`: a rest parameter ranks below a named one); every one ranked above it is
 *   code that takes the documents' addresses first. So the trial's `[slug].astro` beside
 *   `[...path].astro` at `/` is code: `validate` reports it as an error naming it and the
 *   collection (`shadowingRoutes`), and it reserves its addresses like any other route
 *   with parameters. A base's only route with parameters is always the collection's.
 * - **Everything else is code.** A static route reserves exactly its URL; a route with
 *   parameters reserves everything under its static prefix (and the prefix itself when
 *   its first parameter is a rest parameter, which can be empty).
 *
 * The integration reads them once at setup (`site.codeRoutes`, so the editor's server and
 * browser both have them); `validate` reads them from disk itself (cli/validate.ts). This
 * module is pure and browser-safe: the reading of the folder is `code-routes-disk.ts`.
 */

/** An address compared with others: lower case, no trailing slash (slug.ts → sameAddress, kept here so slug.ts can import this). */
const sameAddress = (url: string): string => {
	const lower = url.toLowerCase();
	return lower.length > 1 ? lower.replace(/\/+$/, '') : lower;
};

export interface CodeRoute {
	/** The route's file, relative to the site's root, `/`-separated (`src/pages/about.astro`). */
	file: string;
	/** A static route's URL, or a route with parameters' static prefix, ending in `/` (`/work/`). */
	url: string;
	/** True for a route with parameters: it reserves everything under `url`. */
	dynamic: boolean;
	/** A dynamic route whose first parameter is a rest one (`[...path]`): it also matches `url` itself without its slash. */
	rest: boolean;
}

/** The file extensions Astro routes from `src/pages/` (pages and endpoints). */
export const ROUTE_EXTENSIONS = ['.astro', '.md', '.mdx', '.markdown', '.html', '.ts', '.js', '.mjs', '.mts'] as const;

/**
 * A file under the pages folder as its route, or null when it isn't one. `path` is the
 * file's path inside the pages folder (`work/[slug].astro`); `file` is how to name it.
 */
export function routeOf(path: string, file: string): CodeRoute | null {
	const parts = path.split('/').filter(Boolean);
	if (parts.length === 0 || parts.some((p) => p.startsWith('_') || p.startsWith('.'))) return null;
	const name = parts[parts.length - 1]!;
	if (/\.d\.[mc]?ts$/.test(name)) return null;
	const ext = ROUTE_EXTENSIONS.find((e) => name.endsWith(e));
	if (!ext) return null;
	const base = name.slice(0, -ext.length);
	const segments = [...parts.slice(0, -1), ...(base === 'index' ? [] : [base])];
	const firstParam = segments.findIndex((s) => s.includes('['));
	if (firstParam === -1) return { file, url: `/${segments.join('/')}`, dynamic: false, rest: false };
	const prefix = segments.slice(0, firstParam);
	const url = prefix.length ? `/${prefix.join('/')}/` : '/';
	return { file, url, dynamic: true, rest: /^\[\.\.\.[^\]]+\]$/.test(segments[firstParam]!) };
}

/**
 * Astro's order for routes with parameters at the same static prefix, highest first: a
 * named parameter above a rest one, more segments above fewer, then by name (Astro's own
 * tie-break). Negative when `a` ranks above `b`.
 */
function astroRank(a: CodeRoute, b: CodeRoute): number {
	if (a.rest !== b.rest) return a.rest ? 1 : -1;
	const depth = (r: CodeRoute) => r.file.replace(/\/index\.[^/]+$/, '').split('/').length;
	if (depth(a) !== depth(b)) return depth(b) - depth(a);
	return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/** A route with parameters at a collection's `urlBase` that isn't the collection's own: Astro ranks it above `own`, so it serves the documents' addresses first. */
export interface ShadowingRoute<C> {
	route: CodeRoute;
	/** The collection's own route at that base (the one Astro ranks last). */
	own: CodeRoute;
	collection: C;
}

/** Every route with parameters that sits at a collection's base above the collection's own (see the header: one per base). */
export function shadowingRoutes<C extends { urlBase: string | null }>(routes: readonly CodeRoute[], collections: readonly C[]): ShadowingRoute<C>[] {
	const out: ShadowingRoute<C>[] = [];
	const seen = new Set<string>();
	for (const collection of collections) {
		if (collection.urlBase === null) continue;
		const base = sameAddress(collection.urlBase);
		if (seen.has(base)) continue;
		seen.add(base);
		const at = routes.filter((r) => r.dynamic && sameAddress(r.url) === base).sort(astroRank);
		const own = at[at.length - 1];
		for (const route of at.slice(0, -1)) out.push({ route, own: own!, collection });
	}
	return out;
}

/** The routes that reserve URLs: every route but the collections' own (the last-ranked route with parameters at a collection's `urlBase`). */
export function codeRoutesFrom(routes: readonly CodeRoute[], collections: readonly { urlBase: string | null }[]): CodeRoute[] {
	const bases = new Set(collections.map((c) => c.urlBase).filter((b): b is string => b !== null).map((b) => sameAddress(b)));
	const shadowing = new Set(shadowingRoutes(routes, collections).map((s) => s.route));
	return routes.filter((r) => shadowing.has(r) || !(r.dynamic && bases.has(sameAddress(r.url))));
}

/**
 * Collections under pages (Decision 14): the prefix collections whose base has a route with
 * parameters of its own (`tags/[slug].astro`), which the catch-all's reader leaves to that route,
 * so no address is built twice. Never a collection at `/` (its own route is the catch-all) or a
 * held one (its documents are always the catch-all's).
 */
export function ownRoutedCollections<C extends { name: string; urlBase: string | null; heldBy?: string | null }>(routes: readonly CodeRoute[], collections: readonly C[]): C[] {
	return collections.filter((c) => c.urlBase !== null && !c.heldBy && sameAddress(c.urlBase) !== '/' && routes.some((r) => r.dynamic && sameAddress(r.url) === sameAddress(c.urlBase!)));
}

/** A route with parameters left at a held collection's resolved base (Decision 14): it serves those addresses ahead of the catch-all. */
export interface LeftBehindRoute {
	route: CodeRoute;
	/** The held collection's label, its resolved base, and its holder's label. */
	collection: { name: string; label: string; base: string; holder: string };
}

/** Every route with parameters whose static prefix is a held collection's resolved base (`journal/[slug].astro` after the switch). */
export function leftBehindRoutes(routes: readonly CodeRoute[], held: readonly LeftBehindRoute['collection'][]): LeftBehindRoute[] {
	return held.flatMap((collection) => routes.filter((r) => r.dynamic && sameAddress(r.url) === sameAddress(collection.base)).map((route) => ({ route, collection })));
}

/** validate's and the dev log's sentence for a route left at a held base (Decision 14). */
export const leftBehindMessage = (l: LeftBehindRoute): string =>
	`${l.route.file} serves ${l.collection.base}…, where the ${l.collection.holder} page's ${l.collection.label} documents are now. Delete it: the catch-all serves them.`;

/** validate's sentence for a route that shadows a collection's documents. */
export const shadowingMessage = (s: ShadowingRoute<{ name: string; urlBase: string | null }>): string =>
	`${s.route.file} is a second route with parameters at the ${s.collection.name} collection's address (${s.collection.urlBase}), beside its own ${s.own.file}. Astro ranks it first, so it serves the addresses of that collection's documents and hides them. Move it under a folder of its own, or delete it if the documents replace it.`;

/** The code route that serves `url` (a public address), or null. */
export function codeRouteAt(url: string, routes: readonly CodeRoute[] | undefined): CodeRoute | null {
	if (!routes?.length) return null;
	const at = sameAddress(url);
	// A static route first: it's the more specific (Astro's own priority).
	const exact = routes.find((r) => !r.dynamic && sameAddress(r.url) === at);
	if (exact) return exact;
	return (
		routes.find((r) => {
			if (!r.dynamic) return false;
			const prefix = r.url.toLowerCase();
			if (prefix === '/') return at !== '/' || r.rest;
			return at.startsWith(prefix) || (r.rest && at === sameAddress(prefix));
		}) ?? null
	);
}

/** The editor's and validate's sentence for a document at a code route's URL. */
export const codeRouteMessage = (url: string, route: CodeRoute): string =>
	`${url} is served by the site's own code (${route.file}), so a page can't go there.`;
