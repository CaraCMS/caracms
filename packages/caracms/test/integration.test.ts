// The integration's wiring. M4 Decision 1 (reversing M3 Decision 4): the editor's
// routes and its middleware are injected for every command, dev and build alike, and
// the mode is read at run time. Dev only: content out of Vite's watch (Decision 5) and
// the editor's deps pre-bundled.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { markPreviewHtml, onRequest } from '../src/editor/middleware.ts';
import { PREVIEW_MARK } from '../src/editor/types.ts';
import caracms, { BUILD_VITE_CACHE, CLOUD_MIDDLEWARE, contentWatchIgnores, EDITOR_CLIENT_DEPS, EDITOR_MIDDLEWARE, trustedDomains, watchContent } from '../src/index.ts';
import type { SiteConfig } from '../src/config.ts';
import { config, fixtures, site, siteRoot } from './helpers/site.ts';

async function setup(command: 'dev' | 'build' | 'preview' | 'sync', astro: { site?: string } = {}) {
	const routes: { pattern: string; entrypoint: string | URL; prerender?: boolean }[] = [];
	const updates: any[] = [];
	const middleware: { order: string; entrypoint: string | URL }[] = [];
	const hook = caracms(config as SiteConfig).hooks['astro:config:setup']!;
	await hook({
		command,
		config: { root: pathToFileURL(`${siteRoot}/`), ...astro },
		logger: { info() {}, warn() {} },
		addWatchFile() {},
		updateConfig: (c: unknown) => updates.push(c),
		injectRoute: (r: (typeof routes)[number]) => routes.push(r),
		addMiddleware: (m: (typeof middleware)[number]) => middleware.push(m),
	} as any);
	const vite = updates.map((u) => u.vite).find(Boolean);
	const security = updates.map((u) => u.security).find(Boolean);
	return { routes, vite, middleware, security };
}

describe('the integration', () => {
	test("astro:config:setup watches the site's caracms.config, so a change restarts the dev server", async () => {
		const root = mkdtempSync(join(fixtures, 'watch-')) // beside site/, so the config's ../fonts paths still resolve;
		const watched: string[] = [];
		const run = (dir: string) =>
			caracms(config as SiteConfig).hooks['astro:config:setup']!({
				command: 'dev',
				config: { root: pathToFileURL(`${dir}/`) },
				logger: { info() {}, warn() {} },
				addWatchFile: (path: URL | string) => watched.push(String(path)),
				updateConfig: () => ({}),
				injectRoute() {},
				addMiddleware() {},
			} as any);
		// No config file beside the site (the fixture's, or an unusual layout): nothing to watch, and no failure.
		await run(siteRoot);
		assert.deepEqual(watched, []);
		copyFileSync(join(siteRoot, 'Block.astro'), join(root, 'Block.astro'));
		writeFileSync(join(root, 'caracms.config.ts'), 'export default {};\n');
		try {
			await run(root);
			assert.deepEqual(watched, [join(root, 'caracms.config.ts')]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});


	const EDITOR = [
		'/admin/[...path]',
		'/_caracms/preview',
		'/_caracms/document',
		'/_caracms/documents',
		'/_caracms/write',
		'/_caracms/create',
		'/_caracms/delete',
		'/_caracms/move',
		'/_caracms/arrange',
		'/_caracms/collection-order',
		'/_caracms/slot-default',
		'/_caracms/media/[...path]',
		'/_caracms/github',
		'/_caracms/status',
		'/_caracms/lock',
		'/_caracms/publish',
		'/_caracms/history',
		'/_caracms/try-again',
		'/_caracms/notice',
	];

	for (const command of ['dev', 'build', 'preview', 'sync'] as const) {
		test(`astro ${command}: the editor's routes, on demand, and the 503 middleware first`, async () => {
			const { routes, middleware } = await setup(command);
			// Phase 3's sign-in routes follow these; the orchestrator reconciles that list.
			assert.deepEqual(routes.slice(0, EDITOR.length).map((r) => r.pattern), EDITOR);
			assert.ok(routes.every((r) => r.prerender === false));
			// caracms-cloud M3 Decision 20: a cloud site's settings fetch comes first of all, then the 503 middleware.
			assert.equal(String(middleware[0]?.entrypoint), String(new URL(`../src/${CLOUD_MIDDLEWARE}`, import.meta.url)));
			assert.equal(String(middleware[1]?.entrypoint), String(new URL(`../src/${EDITOR_MIDDLEWARE}`, import.meta.url)));
			assert.ok(middleware.every((m) => m.order === 'pre'));
		});
	}

	for (const command of ['build', 'preview', 'sync'] as const) {
		test(`astro ${command}: no watch ignores, no editor deps; a production define`, async () => {
			const { vite } = await setup(command);
			assert.equal(vite.server, undefined);
			assert.equal(vite.optimizeDeps, undefined);
			assert.equal(vite.define.__CARACMS_PRODUCTION__, 'true');
			// M8 review: its own Vite cache, so it never re-optimizes over a running dev server's deps.
			assert.equal(vite.cacheDir, BUILD_VITE_CACHE);
		});
	}

	test('astro dev is not a production server', async () => {
		assert.equal((await setup('dev')).vite.define.__CARACMS_PRODUCTION__, 'false');
	});

	test('under astro dev, every collection folder and the Site Settings file are out of the watch, and nothing else', async () => {
		const { vite } = await setup('dev');
		const ignored: ((p: string) => boolean)[] = vite.server.watch.ignored;
		const ignores = (p: string) => ignored.some((fn) => fn(p));
		// Every collection's folder, shared blocks' included (M5a); Site Settings is its one file (below).
		const folders = Object.values(site.collections).filter((c) => c.kind !== 'settings');
		assert.ok(folders.some((c) => c.kind === 'shared'));
		for (const c of folders) {
			assert.ok(ignores(c.dir), c.dir);
			assert.ok(ignores(join(c.dir, 'index.json')));
		}
		assert.equal(ignores(join(siteRoot, 'content')), false);
		assert.equal(ignores(join(siteRoot, 'Block.astro')), false);
		assert.equal(ignores(`${site.collections.pages!.dir}-other/x.json`), false);
		assert.ok(ignores(join(siteRoot, 'content/site-settings.json')), 'the Site Settings file (M4 Decision 15)');
		assert.equal(ignores(join(siteRoot, 'content/other.json')), false);
		assert.ok(ignores(join(siteRoot, '.caracms/submissions/x.json')), 'the local submissions folder (M6)');
		assert.equal(ignores(join(siteRoot, '.caracms-other')), false);
		assert.equal(contentWatchIgnores(site).length, folders.length + 2);
	});

	test('the content out of the watch is watched apart, so the dev server re-runs getStaticPaths after a page is added, moved or hidden', async () => {
		const root = mkdtempSync(join(tmpdir(), 'caracms-watch-'));
		const pages = join(root, 'content/pages');
		mkdirSync(join(pages, 'about'), { recursive: true });
		let calls = 0;
		const stop = watchContent({ root, collections: { pages: { kind: 'sections', dir: pages } } } as any, () => calls++, 100);
		// The next call, or none: fs.watch can be late, so wait for it rather than a fixed time.
		const after = async (change: () => void) => {
			const before = calls;
			change();
			for (let i = 0; i < 150 && calls === before; i++) await new Promise((r) => setTimeout(r, 20));
			await new Promise((r) => setTimeout(r, 300));
			return calls - before;
		};
		try {
			assert.equal(await after(() => writeFileSync(join(pages, 'a.json'), '{}')), 1, 'a new page');
			assert.equal(await after(() => writeFileSync(join(pages, 'about/team.json'), '{}')), 1, 'a nested page');
			assert.equal(
				await after(() => {
					renameSync(join(pages, 'a.json'), join(pages, 'b.json'));
					writeFileSync(join(pages, 'b.json'), '{"hidden":true}');
				}),
				1,
				'a burst of changes is one call',
			);
			assert.equal(await after(() => writeFileSync(join(root, 'content/site-settings.json'), '{}')), 1, 'Site Settings (its redirects)');
			assert.equal(await after(() => writeFileSync(join(root, 'content/other.json'), '{}')), 0, 'not other files beside it');
			stop();
			assert.equal(await after(() => writeFileSync(join(pages, 'c.json'), '{}')), 0, 'nothing once stopped');
		} finally {
			stop();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('under astro dev, the editor\'s browser deps are pre-bundled (no optimise-and-reload on the first /admin)', async () => {
		const { vite } = await setup('dev');
		assert.deepEqual(vite.optimizeDeps.include, EDITOR_CLIENT_DEPS);
		assert.equal(vite.cacheDir, undefined, "dev keeps Vite's own node_modules/.vite");
	});

	test('the build trusts the Host header for the site\'s public address, so a request behind a proxy keeps its real host', async () => {
		const { security } = await setup('build', { site: 'https://studio.test' });
		assert.deepEqual(security.allowedDomains[0], { hostname: 'studio.test', protocol: 'https' });
	});
});

describe('trustedDomains', () => {
	test('Astro\'s site, then Railway\'s public domain', () => {
		assert.deepEqual(trustedDomains('https://studio.test/', undefined, { RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }), [
			{ hostname: 'studio.test', protocol: 'https' },
			{ hostname: 'x.up.railway.app', protocol: 'https' },
		]);
	});
	test('Railway alone, and no repeat when site is the Railway domain', () => {
		assert.deepEqual(trustedDomains(undefined, undefined, { RAILWAY_PUBLIC_DOMAIN: ' x.up.railway.app ' }), [{ hostname: 'x.up.railway.app', protocol: 'https' }]);
		assert.equal(trustedDomains('https://x.up.railway.app', undefined, { RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }).length, 1);
	});
	test('nothing known, nothing trusted; a site\'s own allowedDomains is left alone', () => {
		assert.deepEqual(trustedDomains(undefined, undefined, {}), []);
		assert.deepEqual(trustedDomains('https://studio.test', [{ hostname: 'other.test' }], {}), []);
	});
});

describe('the preview mark (M8 review: a failed load is not the page)', () => {
	test('on the <html> of a 200 HTML answer to the preview\'s GET; after the doctype when there\'s no <html>', () => {
		assert.equal(markPreviewHtml('<!DOCTYPE html><html lang="en"><body>x</body></html>'), `<!DOCTYPE html><html ${PREVIEW_MARK} lang="en"><body>x</body></html>`);
		assert.equal(markPreviewHtml('<!doctype html>\n<p>x</p>'), `<!doctype html><html ${PREVIEW_MARK}>\n<p>x</p>`);
		assert.equal(markPreviewHtml('<p>x</p>'), `<html ${PREVIEW_MARK}><p>x</p>`);
	});

	test('only a 200 HTML GET of the preview is marked: an error answer, a POST, another path pass untouched', async () => {
		const run = async (path: string, method: string, response: Response) => {
			const context = { url: new URL(`http://localhost${path}`), request: new Request(`http://localhost${path}`, { method }) };
			const out = (await onRequest(context as never, async () => response)) as Response;
			return out.text();
		};
		const html = () => new Response('<html><body>page</body></html>', { headers: { 'Content-Type': 'text/html' } });
		assert.match(await run('/_caracms/preview?collection=pages&path=index', 'GET', html()), new RegExp(`^<html ${PREVIEW_MARK}>`));
		assert.equal(await run('/_caracms/preview', 'POST', html()), '<html><body>page</body></html>');
		assert.equal(await run('/about', 'GET', html()), '<html><body>page</body></html>');
		const missing = new Response('<html><body>Not found</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
		assert.equal(await run('/_caracms/preview', 'GET', missing), '<html><body>Not found</body></html>');
	});
});
