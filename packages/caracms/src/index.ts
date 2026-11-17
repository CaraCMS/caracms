/**
 * The caracms integration.
 *
 * ## How the package loads the site (Decision 3; for Phase 2's builder)
 *
 * The package can't import the site, so the site hands itself over:
 *
 * 1. The site's `caracms.config.ts` is plain data (`defineSite`, from
 *    `caracms/config`): field descriptors, and components named by path. Its
 *    `astro.config.mjs` imports it and passes it in: `caracms(site)`.
 * 2. In `astro:config:setup`, before the dev server or the build starts, the
 *    integration validates it and resolves its paths (`resolveSite`); a bad config
 *    throws a plain sentence and stops `astro dev` / `astro build`.
 * 3. A Vite plugin serves four virtual modules from the resolved config. They work
 *    the same in dev, in the build and in tests (Vite's container renders), and any
 *    module, including routes the package injects, can import them:
 *
 *    - `virtual:caracms/config`     `{ site }`: the ResolvedSite as JSON (collections,
 *                                   block schemas, text styles, brand slots,
 *                                   phoneLinesWidth, absolute paths). No components.
 *    - `virtual:caracms/blocks`     `{ blocks }`: block type → its Astro component,
 *                                   imported by absolute path.
 *    - `virtual:caracms/page`       `{ Page }`: the site's page component.
 *    - `virtual:caracms/collections` `{ components }`: a list-of-fields collection's
 *                                   name → its component (M5a Decision 7).
 *    - `virtual:caracms/lockup.css` the lockup CSS with the site's phone-lines
 *                                   width in its media query (lockup-css.ts).
 *
 *    They're split so nothing imports in a circle: a block's Lockup imports
 *    `config`; the Blocks loop imports `blocks`; only RenderDocument imports `page`.
 *    Types: `caracms/virtual` (src/virtual.d.ts), injected into the site's
 *    `.astro/types.d.ts` by `injectTypes`.
 * 4. Fonts: every text style's web font is registered with Astro's fonts API from
 *    the style (`font-display: block`, Decision 14), so one definition drives the
 *    CSS and the measurement. A page puts `<Fonts />` in its head.
 *
 * Tree-shaking: the public side is `config`, `blocks` and the package's components;
 * nothing here imports editor code.
 *
 * ## The editor (Phase 2; src/editor/README.md)
 *
 * The integration injects the editor's routes (EDITOR_ROUTES: /admin, the preview,
 * document and write routes, and M4's live-mode routes, all on demand) in dev and in
 * the build (M4 Decision 1, reversing M3 Decision 4), with the editor's middleware.
 * Under `astro dev` only, it also takes the collection folders out of Vite's watch
 * (Decision 5) and has Vite pre-bundle the editor's browser deps. The public pages
 * have no script, no React and no editor markers in either.
 */
import { cloudSettingsForBuild } from './cloud-middleware.ts';
import type { AstroIntegration } from 'astro';
import { fontProviders } from 'astro/config';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSite, SITE_SETTINGS_FILE, type ResolvedSite, type SiteConfig } from './config.ts';
import { lockupCss } from './lockup-css.ts';
import { shareBuildReads } from './read.ts';
import { writeSchemaFiles } from './cli/schemas.ts';
import { skillsWarning } from '../bin/skills.mjs';
import { configFile } from './cli/site.ts';
import { pagesRoutes } from './code-routes-disk.ts';
import { codeRoutesFrom } from './code-routes.ts';
import { GUARD_MIDDLEWARE, LOGIN_ROUTES } from './live/auth/routes.ts';
import { HOST_COMMIT_VARIABLES } from './live/mode.ts';


export type { SiteConfig, ResolvedSite } from './config.ts';

const VIRTUAL = {
	config: 'virtual:caracms/config',
	public: 'virtual:caracms/public',
	blocks: 'virtual:caracms/blocks',
	page: 'virtual:caracms/page',
	collections: 'virtual:caracms/collections',
	css: 'virtual:caracms/lockup.css',
} as const;

const resolvedId = (id: string) => `\0${id}`;

/**
 * What the public site's components learn at build time (M6): the site's address
 * (`SITE_URL`, Decision 3), Turnstile's site key (read at build, Decision 6), and whether
 * this is a production build (the Google tag goes only there, Decision 16).
 */
export interface PublicBuild {
	/** Astro's `site` as it applies (the site's own, else `SITE_URL`), without a trailing slash; null when neither is set. */
	siteUrl: string | null;
	turnstileSiteKey: string | null;
	/** `astro build` (and the built server), not `astro dev`. */
	production: boolean;
}

/** The virtual modules' source, from a resolved site. Exported for tests. */
export function virtualModules(site: ResolvedSite, build: PublicBuild = { siteUrl: null, turnstileSiteKey: null, production: false }): Record<string, string> {
	const blockEntries = Object.values(site.blocks);
	const fieldsCollections = Object.values(site.collections).filter((c) => c.kind === 'fields' && c.component);
	return {
		[VIRTUAL.config]: `export const site = ${JSON.stringify(site)};\n`,
		[VIRTUAL.public]: `export const build = ${JSON.stringify(build)};\n`,
		[VIRTUAL.blocks]:
			blockEntries.map((b, i) => `import Block${i} from ${JSON.stringify(b.component)};`).join('\n') +
			`\nexport const blocks = {${blockEntries.map((b, i) => `${JSON.stringify(b.type)}: Block${i}`).join(', ')}};\n`,
		[VIRTUAL.page]: `import Page from ${JSON.stringify(site.page)};\nexport { Page };\n`,
		[VIRTUAL.collections]:
			fieldsCollections.map((c, i) => `import Collection${i} from ${JSON.stringify(c.component)};`).join('\n') +
			`\nexport const components = {${fieldsCollections.map((c, i) => `${JSON.stringify(c.name)}: Collection${i}`).join(', ')}};\n`,
		[VIRTUAL.css]: lockupCss(site.phoneLinesWidth),
	};
}

/**
 * The editor's routes, each on demand. M3 injected them under `astro dev` only; M4
 * Decision 1 reverses that: they're in the build too, and the mode (local, live or
 * unconfigured) is read at run time. The public pages still ship no script, no
 * React and no markers. See editor/README.md for what each takes.
 */
export const EDITOR_ROUTES = [
	{ pattern: '/admin/[...path]', entrypoint: 'editor/routes/admin.astro' },
	{ pattern: '/_caracms/preview', entrypoint: 'editor/routes/preview.astro' },
	{ pattern: '/_caracms/document', entrypoint: 'editor/routes/document.ts' },
	{ pattern: '/_caracms/documents', entrypoint: 'editor/routes/documents.ts' },
	{ pattern: '/_caracms/write', entrypoint: 'editor/routes/write.ts' },
	// M5a Phase 3: creating and deleting documents, both modes (the guard's prefix rule covers them in live mode).
	{ pattern: '/_caracms/create', entrypoint: 'editor/routes/create.ts' },
	{ pattern: '/_caracms/delete', entrypoint: 'editor/routes/delete.ts' },
	// Pre-M7 item 8: changing a document's address, both modes.
	{ pattern: '/_caracms/move', entrypoint: 'editor/routes/move.ts' },
	// Arrange pages: the arrange screen's Apply, both modes.
	{ pattern: '/_caracms/arrange', entrypoint: 'editor/routes/arrange.ts' },
	// Review gaps (Decisions 2 and 4): a manual collection's hand order, both modes.
	{ pattern: '/_caracms/collection-order', entrypoint: 'editor/routes/collection-order.ts' },
	// Edit in context, Decision 3: a slot block made its slot's default, both modes.
	{ pattern: '/_caracms/slot-default', entrypoint: 'editor/routes/slot-default.ts' },
	// M5b Phase 2: the media library, uploads and Mux, both modes (types.ts → MEDIA_ENDPOINTS).
	{ pattern: '/_caracms/media/[...path]', entrypoint: 'editor/routes/media.ts' },
	// M4 Decision 14: GitHub's push webhook (signature-checked; 404 with no secret).
	{ pattern: '/_caracms/github', entrypoint: 'editor/routes/github.ts' },
	// M4 Phase 2, live mode (local mode: 404): the poll, locks, Publish, history, Try again, notices.
	{ pattern: '/_caracms/status', entrypoint: 'editor/routes/status.ts' },
	{ pattern: '/_caracms/lock', entrypoint: 'editor/routes/lock.ts' },
	{ pattern: '/_caracms/publish', entrypoint: 'editor/routes/publish.ts' },
	{ pattern: '/_caracms/history', entrypoint: 'editor/routes/history.ts' },
	{ pattern: '/_caracms/try-again', entrypoint: 'editor/routes/try-again.ts' },
	{ pattern: '/_caracms/notice', entrypoint: 'editor/routes/notice.ts' },
	{ pattern: '/_caracms/discard', entrypoint: 'editor/routes/discard.ts' },
	// M6 Decision 9: the inbox, both modes (the guard's prefix rule covers it in live mode).
	{ pattern: '/_caracms/submissions/[...path]', entrypoint: 'editor/routes/submissions.ts' },
] as const;

/**
 * The public site's own on-demand routes (M6): the forms' endpoint, public in every mode
 * (the guard lets it through, the unconfigured 503 exempts it); and (M6c Decision 6) the
 * library's files at `/files/<hash>/<name>.<ext>`, every path under `/files` reaching the
 * route's own allow-list (files-route.ts), behind the pre-launch password like any page.
 */
export const PUBLIC_ROUTES = [
	{ pattern: '/_caracms/form', entrypoint: 'forms/route.ts' },
	{ pattern: '/files/[...path]', entrypoint: 'files-route.ts' },
] as const;

/** M6 Decision 12: the sitemap, prerendered, injected only when the site's address is known at build. */
export const SITEMAP_ROUTE = { pattern: '/sitemap.xml', entrypoint: 'components/sitemap.xml.ts' } as const;

/**
 * M6 Decision 3: the site's public address. Astro's `site` when the site's config sets
 * one, else `SITE_URL`; null when neither does (no sitemap, no canonical, a warning).
 * `SITE_URL` must be an http(s) origin, optionally with a path.
 */
export function siteAddress(astroSite: string | undefined, env: Record<string, string | undefined> = process.env): { url: string | null; problem: string | null } {
	const raw = astroSite ?? env['SITE_URL']?.trim();
	if (!raw) return { url: null, problem: null };
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { url: null, problem: `SITE_URL must be the site's address, like https://example.com (got "${raw}").` };
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return { url: null, problem: `SITE_URL must start with https:// (got "${raw}").` };
	return { url: `${url.origin}${url.pathname}`.replace(/\/+$/, ''), problem: null };
}

/**
 * Runs-anywhere Decision 9: the commit a build is made from, baked into the server.
 * CARACMS_RUNNING_COMMIT or a host's commit variable at build, else `git rev-parse HEAD`
 * when the build has a `.git` folder (Railway's and most Docker builds don't); null
 * when neither. A value at run time wins over it (live/mode.ts → `runningCommitFrom`).
 */
export function buildCommit(root: string, env: Record<string, string | undefined> = process.env): string | null {
	for (const name of ['CARACMS_RUNNING_COMMIT', ...HOST_COMMIT_VARIABLES]) {
		const v = env[name]?.trim();
		if (v) return v;
	}
	try {
		const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
}

/** Pre-M7 item 8: Site Settings' redirects, served as 301s on the public site. */
export const REDIRECT_MIDDLEWARE = 'redirect-middleware.ts';

/** M4 Phase 2: the unconfigured server's 503, registered before Phase 3's guard. */
export const EDITOR_MIDDLEWARE = 'editor/middleware.ts';
/** caracms-cloud M3 Decision 20: a cloud site's settings, fetched by the first request (cloud-middleware.ts). */
export const CLOUD_MIDDLEWARE = 'cloud-middleware.ts';

/**
 * Content files out of Vite's watch (Decision 5): a write never reloads `/admin`
 * or the preview. One matcher per declared collection folder, and one for the Site
 * Settings file (M4 Decision 15), which sits in `content/` beside them. M6: and the
 * local submissions folder (`.caracms/`), so a form post or marking one read doesn't
 * reload the editor.
 */
export function contentWatchIgnores(site: Pick<ResolvedSite, 'collections' | 'root'>): ((path: string) => boolean)[] {
	const settings = join(site.root, SITE_SETTINGS_FILE);
	const local = join(site.root, '.caracms');
	return [
		// Every collection's folder, shared blocks' included; Site Settings is one file, matched below.
		...Object.values(site.collections)
			.filter((c) => c.kind !== 'settings')
			.map(({ dir }) => (path: string) => path === dir || path.startsWith(dir + sep)),
		(path: string) => path === settings,
		(path: string) => path === local || path.startsWith(local + sep),
	];
}

/**
 * The content contentWatchIgnores takes out of Vite's watch, watched apart, so the dev server
 * learns a page was added, moved, hidden or removed. Astro's dev server caches each route's
 * `getStaticPaths` and clears it only on its own content changes, so without this the public
 * site kept its old list of pages until a restart (an old address even answered 500 rather
 * than its redirect). Every collection folder that exists at start, recursively, and the
 * Site Settings file; `onChange` once per burst of changes. Returns the stop.
 */
export function watchContent(site: Pick<ResolvedSite, 'collections' | 'root'>, onChange: () => void, wait = 100): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const changed = () => {
		clearTimeout(timer);
		timer = setTimeout(onChange, wait);
	};
	const watchers: FSWatcher[] = [];
	const add = (path: string, recursive: boolean, only?: string) => {
		if (!existsSync(path)) return;
		const watcher = watch(path, { recursive, persistent: false }, (_event, name) => {
			if (!only || name === only) changed();
		});
		// A watched folder that's removed mustn't take the dev server down with it.
		watcher.on('error', () => watcher.close());
		watchers.push(watcher);
	};
	for (const c of Object.values(site.collections)) if (c.kind !== 'settings') add(c.dir, true);
	const settings = join(site.root, SITE_SETTINGS_FILE);
	add(dirname(settings), false, basename(settings));
	return () => {
		clearTimeout(timer);
		for (const watcher of watchers) watcher.close();
	};
}

/**
 * The hosts Astro may take a request's address from (`security.allowedDomains`).
 * Without them, Astro ignores the Host header and every request reads as
 * `localhost:<port>`. Behind a host's proxy that breaks the same-origin checks on the
 * sign-in form and the editor's writes, and the addresses the pages show. Taken from
 * Astro's `site` (SITE_URL when the config sets none: `siteAddress`), then Railway's
 * public domain: the same chain as emailed links (live/mode.ts → `addressFrom`;
 * runs-anywhere Decision 7). A site's own `allowedDomains` wins.
 * Read at build time: Astro puts the list in the server's manifest.
 */
export function trustedDomains(
	astroSite: string | undefined,
	own: readonly unknown[] | undefined,
	env: Record<string, string | undefined> = process.env,
): { hostname: string; protocol: string }[] {
	if (own?.length) return [];
	const domains: { hostname: string; protocol: string }[] = [];
	if (astroSite) {
		const url = new URL(astroSite);
		domains.push({ hostname: url.hostname, protocol: url.protocol.replace(':', '') });
	}
	const railway = env['RAILWAY_PUBLIC_DOMAIN']?.trim();
	if (railway && !domains.some((d) => d.hostname === railway)) domains.push({ hostname: railway, protocol: 'https' });
	return domains;
}

/** Vite's cache for every command but `astro dev`, apart from dev's `node_modules/.vite` (see its use). Relative to the site's root. */
export const BUILD_VITE_CACHE = 'node_modules/.vite-caracms-build';

/**
 * Every bare import the package's browser code makes (the editor, and the site's own
 * components such as the video player), pre-bundled up front in dev. Two reasons:
 * - Vite doesn't discover them on the first visit to /admin and reload the page to
 *   optimise them (a flicker, M2 Decision 9).
 * - Installed from the registry (npm or pnpm), the package sits in the site's node_modules,
 *   and Vite serves a bare import from it that isn't listed here as the dependency's raw
 *   file. For a CommonJS one (react-dom) the browser refuses the module and the editor never
 *   starts (caracms-cloud adversarial review, finding 12). The workspace's linked copy hides
 *   this, so any new bare import in browser code goes here; test/pack-install.release.test.ts
 *   checks it in a real browser.
 */
export const EDITOR_CLIENT_DEPS = [
	'caracms > react',
	'caracms > react/jsx-runtime',
	'caracms > react/jsx-dev-runtime',
	// Arrange pages' createPortal (arrange/ArrangeStage.tsx). react-dom's root is CommonJS.
	'caracms > react-dom',
	'caracms > react-dom/client',
	'caracms > idiomorph',
	// M5a: the rich-text field's editor (Tiptap on ProseMirror), browser only.
	'caracms > @tiptap/core',
	'caracms > @tiptap/pm/history',
	'caracms > @tiptap/pm/model',
	// The on-page editor's: left out, Vite finds them on the first /admin, optimizes again
	// and reloads the page under whoever is on it (a browser test, mid-click).
	'caracms > @tiptap/pm/state',
	'caracms > @tiptap/pm/transform',
	'caracms > @tiptap/pm/view',
	// M5b: a clip's upload straight to Mux, imported on the first one (client/media/store.ts).
	'caracms > @mux/upchunk',
	// The site's video player, imported on the first click on Play (components/media-player.ts).
	// ESM, so served raw it still loaded, but unbundled, and one CommonJS file in its tree would break it.
	'caracms > @mux/mux-player',
	// The date field's calendar (pre-M7 polish).
	'caracms > react-day-picker',
];

/**
 * The variables M5b Decision 5 names: the media pipeline's and Mux's, and the cloud key,
 * which is both on a cloud site, with its address (else a `.env` naming the dev cloud left
 * `astro dev` on production's media while the CLI used the dev cloud). Only these are taken
 * from the site's env files (copyMediaEnv); everything else in `.env` (the GitHub App, live
 * mode) is left to the process's own environment, as before.
 */
export const MEDIA_ENV_NAMES = [
	'CARACMS_CLOUD_KEY',
	'CARACMS_CLOUD_URL',
	'CARACMS_MEDIA',
	'CARACMS_MEDIA_URL',
	'IMGPROXY_KEY',
	'IMGPROXY_SALT',
	'S3_ENDPOINT',
	'S3_REGION',
	'S3_BUCKET',
	'S3_ACCESS_KEY_ID',
	'S3_SECRET_ACCESS_KEY',
	'MUX_TOKEN_ID',
	'MUX_TOKEN_SECRET',
] as const;

/**
 * M6's variables a local run may take from the site's `.env` too: the site's address,
 * Turnstile's keys, and the tests' submissions store. Copied the same way (a set value wins).
 */
export const SITE_ENV_NAMES = ['SITE_URL', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'CARACMS_SUBMISSIONS'] as const;

/**
 * Copy Decision 5's variables from the env files' values (`loaded`, Vite's loadEnv) into
 * `env`, **never over a value already set**: a real environment (Railway) and a test's
 * `CARACMS_MEDIA=memory` always win. Other names are ignored. Returns the names copied.
 */
export function copyMediaEnv(loaded: Record<string, string | undefined>, env: Record<string, string | undefined> = process.env, names: readonly string[] = MEDIA_ENV_NAMES): string[] {
	const copied: string[] = [];
	for (const name of names) {
		const value = loaded[name];
		if (value === undefined || value === '' || (env[name] !== undefined && env[name] !== '')) continue;
		env[name] = value;
		copied.push(name);
	}
	return copied;
}

/**
 * The one warning for a cloud key that's set but empty in the env files: Vite's loadEnv lets
 * `.env.development.local`'s `CARACMS_CLOUD_KEY=` win over `.env`'s real key, copyMediaEnv
 * skips the empty value, and cloudMedia() is null, so `<Media>` renders nothing with no
 * message (found after two sessions on a cloud site's blank images). Null when the config is
 * `'self-hosted'`, the key isn't in the files at all, or `env` has a real one. Names the file
 * the empty value came from when it can: loadEnv's files, read again for the last one that
 * sets the name (most specific wins, as in loadEnv), only if that line's value is empty too
 * (an empty value exported in the shell also reaches `loaded`, through loadEnv's '' prefix).
 */
export function emptyCloudKeyWarning(loaded: Record<string, string | undefined>, env: Record<string, string | undefined>, services: ResolvedSite['services'], root: string, mode: string): string | null {
	if (services === 'self-hosted') return null;
	const value = loaded.CARACMS_CLOUD_KEY;
	if (value === undefined || value.trim() !== '' || env.CARACMS_CLOUD_KEY?.trim()) return null;
	let from: string | null = null;
	for (const file of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
		let text: string;
		try {
			text = readFileSync(join(root, file), 'utf8');
		} catch {
			continue;
		}
		const last = [...text.matchAll(/^[ \t]*(?:export[ \t]+)?CARACMS_CLOUD_KEY[ \t]*=(.*)$/gm)].at(-1);
		if (!last) continue;
		from = /^\s*(?:''|""|``)?\s*(?:#.*)?$/.test(last[1]!) ? file : null;
	}
	return `CARACMS_CLOUD_KEY is set but empty${from ? ` in ${from}` : ''}, so this site's images, uploads and video from CaraCMS Cloud are off. The usual cause is a .env.*.local file overriding the key in .env: remove the empty line or put the key there.`;
}

/** The site's env files (`.env`, `.env.<mode>`, `.local` variants) through Vite's loadEnv, resolved from Astro's own Vite. */
async function loadSiteEnv(mode: string, root: string): Promise<Record<string, string>> {
	const vite = createRequire(createRequire(import.meta.url).resolve('astro/package.json')).resolve('vite');
	// A native import, out of Vite's reach. Installed from npm, this module is compiled by the Vite runner that
	// loaded astro.config, which rewrites `import()` to go through it, and Astro has closed it before the hooks run
	// ("Vite module runner has been closed"; found by M8's pack-and-install check).
	const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;
	const { loadEnv } = (await nativeImport(pathToFileURL(vite).href)) as { loadEnv: (mode: string, dir: string, prefixes: string | string[]) => Record<string, string> };
	return loadEnv(mode, root, '');
}

/**
 * Runs-anywhere Decisions 7 and 9: what a build baked in, also written beside the server's
 * entry (`dist/server/caracms-build.json`) for `caracms start`'s gate, which can't import
 * the site: `{ "site": "https://example.com" | null, "commit": "<sha>" | null }`. `site` is
 * Astro's `site` as built (the config's, else SITE_URL's: `siteAddress`); `commit` is
 * `buildCommit()`'s.
 */
export const BUILD_INFO_FILE = 'caracms-build.json';
export interface BuildInfo {
	site: string | null;
	commit: string | null;
}

export default function caracms(config: SiteConfig): AstroIntegration {
	let site: ResolvedSite;
	let buildInfo: BuildInfo | null = null;
	let serverDir: URL | null = null;
	return {
		name: 'caracms',
		hooks: {
			'astro:config:setup': async ({ command, config: astroConfig, updateConfig, injectRoute, addMiddleware, addWatchFile, logger }) => {
				site = resolveSite(config, fileURLToPath(astroConfig.root));
				// A change to the site's caracms.config restarts the dev server, as one to astro.config does: the config
				// is read once, here, and a new block would otherwise stay "Unknown block" until a hand restart.
				// (A restart also regenerates schemas/, in astro:server:setup.) Only the config file itself: Astro's
				// addWatchFile doesn't follow what it imports.
				const configName = configFile(site.root);
				if (configName) addWatchFile(join(site.root, configName));
				// M8 Decision 10: the site's own routes, read once here, for the editor's server and browser alike.
				site.pageRoutes = pagesRoutes(site.root, astroConfig.srcDir ? fileURLToPath(astroConfig.srcDir) : 'src');
				site.codeRoutes = codeRoutesFrom(site.pageRoutes, Object.values(site.collections));
				// M5b Decision 5: local dev (and a local build) read the media variables from the site's
				// `.env`, which Astro doesn't put in process.env. Only those names; a set value wins.
				const envMode = command === 'dev' ? 'development' : 'production';
				const siteEnv = await loadSiteEnv(envMode, site.root);
				copyMediaEnv(siteEnv);
				copyMediaEnv(siteEnv, process.env, SITE_ENV_NAMES);
				const emptyKey = emptyCloudKeyWarning(siteEnv, process.env, site.services, site.root, envMode);
				if (emptyKey) logger.warn(emptyKey);
				const dev = command === 'dev';
				// M6 Decision 3: SITE_URL is Astro's `site` unless the site's config sets one.
				const address = siteAddress(astroConfig.site);
				if (address.problem) throw new Error(`caracms: ${address.problem}`);
				if (command === 'build' && !address.url) logger.warn('SITE_URL is not set, so this build has no sitemap and its pages have no canonical link or og:url. Set it to the site\'s public address.');
				const modules = virtualModules(site, { siteUrl: address.url, turnstileSiteKey: process.env.TURNSTILE_SITE_KEY?.trim() || null, production: !dev });
				// M4 Decision 1: the editor's routes in dev and in the build alike; the mode is read at run time (editor/server/mode.ts).
				{
					for (const route of [...EDITOR_ROUTES, ...PUBLIC_ROUTES]) {
						injectRoute({ pattern: route.pattern, entrypoint: new URL(`./${route.entrypoint}`, import.meta.url), prerender: false });
					}
					// M6 Decision 12: the sitemap, only with an address to put in it.
					if (address.url) injectRoute({ pattern: SITEMAP_ROUTE.pattern, entrypoint: new URL(`./${SITEMAP_ROUTE.entrypoint}`, import.meta.url), prerender: true });
					// M4 Phase 3: the sign-in pages (live/auth/routes.ts).
					for (const route of LOGIN_ROUTES) injectRoute({ pattern: route.pattern, entrypoint: new URL(`./${route.entrypoint}`, import.meta.url), prerender: false });
					// caracms-cloud M3 Decision 20: a cloud site's settings, awaited before anything renders. First of all.
					addMiddleware({ order: 'pre', entrypoint: new URL(`./${CLOUD_MIDDLEWARE}`, import.meta.url) });
					// M4 Phase 2: an unconfigured production server's 503 on /admin and /_caracms/*. First, so it runs before the guard.
					addMiddleware({ order: 'pre', entrypoint: new URL(`./${EDITOR_MIDDLEWARE}`, import.meta.url) });
					// M4 Phase 3: the sign-in guard on /admin and /_caracms/ (live mode only). Must stay after the 503 middleware.
					addMiddleware({ order: 'pre', entrypoint: new URL(`./${GUARD_MIDDLEWARE}`, import.meta.url) });
					// Pre-M7 item 8: Site Settings' redirects, as 301s, for a public path that would be a 404.
					addMiddleware({ order: 'pre', entrypoint: new URL(`./${REDIRECT_MIDDLEWARE}`, import.meta.url) });
				}

				const fontsFromStyles = Object.values(site.textStyles).map((style) => ({
					provider: fontProviders.local(),
					name: style.family,
					cssVariable: style.cssVariable,
					fallbacks: style.fallbacks ?? ['sans-serif'],
					optimizedFallbacks: true,
					// Decision 14: block, never a fallback that could make a line overflow (M1 → E6).
					display: 'block' as const,
					options: {
						variants: [
							{
								src: [isAbsolute(style.fontFile.web) ? style.fontFile.web : `./${style.fontFile.web}`],
								weight: style.weightRange,
								style: 'normal' as const,
							},
						],
					},
				}));

				// measure.ts loads harfbuzzjs from here at runtime (see its comment).
				const harfbuzz = pathToFileURL(createRequire(import.meta.url).resolve('harfbuzzjs')).href;

				const domains = trustedDomains(astroConfig.site ?? address.url ?? undefined, astroConfig.security?.allowedDomains);
				if (command === 'build' && !astroConfig.security?.allowedDomains?.length) {
					if (domains.length) logger.info(`trusting the Host header for ${domains.map((d) => d.hostname).join(', ')}`);
					else logger.warn("the site's public address isn't known (set SITE_URL, at build and at run time): behind a proxy, sign-in and the editor's saves will be refused as cross-origin.");
				}
				const commit = dev ? null : buildCommit(site.root);
				if (command === 'build') buildInfo = { site: address.url, commit };

				updateConfig({
					...(!astroConfig.site && address.url ? { site: address.url } : {}),
					fonts: fontsFromStyles,
					...(domains.length ? { security: { allowedDomains: domains } } : {}),
					vite: {
						// __CARACMS_PRODUCTION__: a production server is the build, so it's always live mode (M4 Decision 1; editor/server/mode.ts).
						// __CARACMS_TOKENS_CSS__: editor/brand.ts reads its inks from tokens.css, which isn't beside the bundled chunk.
						define: {
							__CARACMS_HARFBUZZ__: JSON.stringify(harfbuzz),
							__CARACMS_PRODUCTION__: JSON.stringify(!dev),
							// Runs-anywhere Decisions 7 and 9: the address and the commit the build was made with (editor/server/mode.ts → bakedAtBuild).
							__CARACMS_SITE__: JSON.stringify(astroConfig.site ?? address.url ?? null),
							__CARACMS_BUILD_COMMIT__: JSON.stringify(commit),
							// caracms-cloud M5 Decision 1: the config's `services`, for the key-or-own readers (live/services.ts → bakedServices).
							__CARACMS_SERVICES__: JSON.stringify(site.services),
							__CARACMS_TOKENS_CSS__: JSON.stringify(readFileSync(new URL('./editor/styles/tokens.css', import.meta.url), 'utf8')),
						},
						// Installed from npm, the package ships TypeScript and .astro source.
						ssr: { noExternal: ['caracms'] },
						...(dev
							? {
									server: { watch: { ignored: contentWatchIgnores(site) } },
									optimizeDeps: { include: EDITOR_CLIENT_DEPS },
								}
							: {
									// M8 review: `astro build` (and `astro sync`, `astro check`) starts a Vite server of its own, whose
									// config differs from dev's, so Vite re-optimizes into the shared node_modules/.vite and deletes the
									// running dev server's deps (react, idiomorph, the site's own): the editor and its preview answer 504
									// "Outdated Optimize Dep" until dev restarts. Anything but dev keeps its cache apart.
									cacheDir: BUILD_VITE_CACHE,
								}),
						plugins: [
							{
								name: 'caracms:virtual',
								resolveId(id) {
									return id in modules ? resolvedId(id) : undefined;
								},
								load(id) {
									if (!id.startsWith('\0virtual:caracms/')) return undefined;
									return modules[id.slice(1)];
								},
							},
						],
					},
				});
			},
			// M8 Decision 14: a dev server (at start, and on the restart a config change makes) regenerates
			// schemas/ from the config. Never content files: a dev run only changes what your code change derives.
			'astro:server:setup': ({ server, logger }) => {
				try {
					const changed = writeSchemaFiles(site);
					if (changed.length) logger.info(`updated ${changed.map((c) => c.file).join(', ')}`);
				} catch (error) {
					logger.warn(`couldn't write schemas/: ${(error as Error).message}`);
				}
				// The skills init copied in (bin/skills.mjs): one line when the installed caracms has newer ones.
				try {
					const skills = skillsWarning(site.root);
					if (skills) logger.warn(skills);
				} catch {
					// A warning about docs never stops the dev server.
				}
				// A content change re-runs every route's getStaticPaths, as Astro does for its own content
				// collections (the same event, to the same server environments). Never a browser reload:
				// the editor writes these files.
				const stop = watchContent(site, () => {
					for (const name of ['ssr', 'prerender']) server.environments[name]?.hot.send('astro:content-changed', {});
				});
				server.httpServer?.once('close', stop);
			},
			// Posts and tags, Decision 15: a production build reads each document once (read.ts). Never in dev.
			// caracms-cloud M3 Decision 20: a cloud site's settings, fetched once before any page renders; a refusal fails the build.
			'astro:build:start': async () => {
				shareBuildReads(true);
				await cloudSettingsForBuild(process.env, site.services);
			},
			'astro:build:done': () => {
				shareBuildReads(false);
				if (buildInfo && serverDir && existsSync(serverDir)) writeFileSync(new URL(BUILD_INFO_FILE, serverDir), `${JSON.stringify(buildInfo)}\n`);
			},
			'astro:config:done': ({ injectTypes, config: done }) => {
				serverDir = done.build.server;
				injectTypes({ filename: 'caracms.d.ts', content: '/// <reference types="caracms/virtual" />\n' });
			},
		},
	};
}
