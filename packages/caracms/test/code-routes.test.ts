// M8 Decision 10, Acceptance 13 and 15: code routes. The file names in src/pages/ as Astro
// routes them; a collection's own route reserves nothing; a static route reserves its URL
// alone, one with parameters everything under its prefix; and the editor's create and move
// refuse a code route's URL as they refuse /admin.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import caracms, { virtualModules } from '../src/index.ts';
import { codeRouteAt, codeRoutesFrom, routeOf, shadowingRoutes } from '../src/code-routes.ts';
import { pagesRoutes, readCodeRoutes, srcDirOf } from '../src/code-routes-disk.ts';
import type { SiteConfig } from '../src/config.ts';
import { listDocuments } from '../src/content.ts';
import { planCreate } from '../src/editor/server/create.ts';
import { WriteRefused } from '../src/editor/server/write.ts';
import { planMove } from '../src/editor/server/move.ts';
import { editorSite } from '../src/editor/server/admin-props.ts';
import { addressProblem } from '../src/slug.ts';
import { demoContent, demoSite } from './helpers/dev-site.ts';
import { makeCreateSite, type CreateSite } from './helpers/create-site.ts';
import { config } from './helpers/site.ts';

/** The src/pages of a static site that adopts caracms (weekend-bikes), after `init` adds the catch-all and /health. */
const STATIC_SITE = [
	'404.astro',
	'about.astro',
	'contact.astro',
	'design-system.astro',
	'dev/[...stub].astro',
	'index.astro',
	'services/[slug].astro',
	'services/index.astro',
	'team.astro',
	'work/[slug].astro',
	'work/index.astro',
	'[...path].astro',
	'health.ts',
	// Not routes: Astro skips a leading underscore, and type files.
	'_partials/Hero.astro',
	'_draft.astro',
	'env.d.ts',
	'notes.txt',
];

function tree(files: readonly string[]): string {
	const root = mkdtempSync(join(tmpdir(), 'caracms-routes-'));
	for (const f of files) {
		mkdirSync(join(root, 'src/pages', f, '..'), { recursive: true });
		writeFileSync(join(root, 'src/pages', f), '');
	}
	return root;
}

describe('routes from file names', () => {
	test('Astro\'s rules: index, endpoints with an extension in the name, parameters, rest parameters, underscores', () => {
		const r = (path: string) => routeOf(path, `src/pages/${path}`);
		assert.deepEqual(r('index.astro'), { file: 'src/pages/index.astro', url: '/', dynamic: false, rest: false });
		assert.deepEqual(r('about.astro'), { file: 'src/pages/about.astro', url: '/about', dynamic: false, rest: false });
		assert.equal(r('work/index.astro')!.url, '/work');
		assert.equal(r('sitemap.xml.ts')!.url, '/sitemap.xml');
		assert.equal(r('robots.txt.js')!.url, '/robots.txt');
		assert.equal(r('health.ts')!.url, '/health');
		assert.deepEqual(r('work/[slug].astro'), { file: 'src/pages/work/[slug].astro', url: '/work/', dynamic: true, rest: false });
		assert.deepEqual(r('[...path].astro'), { file: 'src/pages/[...path].astro', url: '/', dynamic: true, rest: true });
		assert.deepEqual(r('blog/[year]/[slug].md'), { file: 'src/pages/blog/[year]/[slug].md', url: '/blog/', dynamic: true, rest: false });
		assert.equal(r('blog/post-[id].astro')!.url, '/blog/');
		assert.equal(r('_hidden.astro'), null);
		assert.equal(r('_lib/x.astro'), null);
		assert.equal(r('types.d.ts'), null);
		assert.equal(r('readme.txt'), null);
	});

	test('the starter\'s own routes reserve nothing but /health (Acceptance 15)', () => {
		// Collections under pages: the journal and case studies are held (no urlBase in the config); the catch-all serves them.
		const collections = [{ urlBase: '/' }, { urlBase: null }, { urlBase: null }, { urlBase: null }];
		const routes = readCodeRoutes(demoSite, 'src', collections);
		assert.deepEqual(routes.map((r) => r.file), ['src/pages/health.ts']);
		for (const url of ['/', '/about', '/about/team', '/journal/a-post', '/work/high-street-coffee', '/services/print']) assert.equal(codeRouteAt(url, routes), null, url);
		assert.ok(codeRouteAt('/health', routes));
		// Every route is read; it's the collections that make the catch-all their own.
		assert.equal(pagesRoutes(demoSite, 'src').length, 2);
	});

	test('every page of the pinned demo content is at an address no starter route reserves (Acceptance 15)', () => {
		const collections = [{ urlBase: '/' }, { urlBase: null }, { urlBase: null }, { urlBase: null }];
		const routes = readCodeRoutes(demoSite, 'src', collections);
		const files = (dir: string): string[] => readdirSync(join(demoContent, dir), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json'));
		const urls = [
			...files('pages').map((f) => `/${f.replace(/\.json$/, '').replace(/(^|\/)index$/, '')}`),
			...files('journal').map((f) => `/journal/${f.replace(/\.json$/, '')}`),
			...files('case-studies').map((f) => `/work/${f.replace(/\.json$/, '')}`),
		];
		assert.ok(urls.length >= 15, urls.join(' '));
		for (const url of urls) {
			assert.equal(codeRouteAt(url, routes), null, url);
		}
	});

	test('weekend-bikes: a static route reserves only its URL, one with parameters everything under its prefix', () => {
		const root = tree(STATIC_SITE);
		try {
			const routes = readCodeRoutes(root, './src', [{ urlBase: '/' }]);
			assert.ok(!routes.some((r) => r.file === 'src/pages/[...path].astro'), 'the catch-all is the pages collection\'s');
			assert.ok(!routes.some((r) => r.file.includes('_') || r.file.endsWith('.d.ts') || r.file.endsWith('.txt')));
			const at = (url: string) => codeRouteAt(url, routes)?.file ?? null;
			assert.equal(at('/'), 'src/pages/index.astro');
			assert.equal(at('/about'), 'src/pages/about.astro');
			assert.equal(at('/About/'), 'src/pages/about.astro');
			assert.equal(at('/contact'), 'src/pages/contact.astro');
			assert.equal(at('/work'), 'src/pages/work/index.astro');
			assert.equal(at('/work/anything'), 'src/pages/work/[slug].astro');
			assert.equal(at('/work/a/b'), 'src/pages/work/[slug].astro');
			assert.equal(at('/services/brand'), 'src/pages/services/[slug].astro');
			assert.equal(at('/dev'), 'src/pages/dev/[...stub].astro', 'a rest parameter can be empty');
			assert.equal(at('/dev/x'), 'src/pages/dev/[...stub].astro');
			assert.equal(at('/health'), 'src/pages/health.ts');
			assert.equal(at('/team-2'), null);
			assert.equal(at('/careers'), null);
			assert.equal(at('/workshop'), null, 'a prefix is a folder, not the start of a word');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a dynamic route at / that isn\'t a collection\'s reserves every address under it', () => {
		const routes = codeRoutesFrom([routeOf('[lang].astro', 'src/pages/[lang].astro')!], [{ urlBase: '/journal/' }]);
		assert.ok(codeRouteAt('/anything', routes));
		assert.equal(codeRouteAt('/', routes), null);
	});

	test('one per base: a second route with parameters at a collection\'s base is code; the one Astro ranks last is the collection\'s', () => {
		const r = (f: string) => routeOf(f, `src/pages/${f}`)!;
		const collections = [{ name: 'pages', urlBase: '/' }, { name: 'case-studies', urlBase: '/work/' }];
		const routes = ['[slug].astro', '[...path].astro', 'work/[slug].astro', 'about.astro'].map(r);
		const shadowing = shadowingRoutes(routes, collections);
		assert.deepEqual(shadowing.map((s) => [s.route.file, s.own.file, s.collection.name]), [['src/pages/[slug].astro', 'src/pages/[...path].astro', 'pages']]);
		const code = codeRoutesFrom(routes, collections).map((x) => x.file);
		assert.deepEqual(code, ['src/pages/[slug].astro', 'src/pages/about.astro']);
		// The file order doesn't matter: Astro's rank does.
		assert.deepEqual(codeRoutesFrom([r('[...path].astro'), r('[slug].astro')], collections).map((x) => x.file), ['src/pages/[slug].astro']);
		// A base's only route with parameters is the collection's, whichever kind it is.
		assert.deepEqual(shadowingRoutes([r('work/[slug].astro'), r('[...path].astro')], collections), []);
		assert.deepEqual(shadowingRoutes([r('[slug].astro')], collections), []);
	});

	test('srcDir: Astro\'s default, or the one astro.config writes', () => {
		const root = mkdtempSync(join(tmpdir(), 'caracms-srcdir-'));
		try {
			assert.equal(srcDirOf(root), './src');
			writeFileSync(join(root, 'astro.config.mjs'), "export default defineConfig({ srcDir: './app', server: {} });\n");
			assert.equal(srcDirOf(root), './app');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('the editor refuses a code route\'s URL (Acceptance 13)', () => {
	let s: CreateSite;
	before(() => {
		s = makeCreateSite();
		s.site.codeRoutes = codeRoutesFrom(
			['design-system.astro', 'shop/[slug].astro', 'work/[slug].astro', 'index.astro', '[...path].astro'].map((f) => routeOf(f, `src/pages/${f}`)!),
			Object.values(s.site.collections),
		);
	});
	after(() => s.cleanup());

	const refusal = (fn: () => unknown) => {
		try {
			fn();
		} catch (error) {
			assert.ok(error instanceof WriteRefused);
			return { status: error.status, code: error.body.code, message: error.message };
		}
		assert.fail('not refused');
	};

	test('a new page at a static code route or under one with parameters is refused with a message naming the URL, as /admin is', async () => {
		const listed = await listDocuments(s.site);
		const contact = refusal(() => planCreate(s.site, { collection: 'pages', path: 'design-system', title: 'Design system' }, listed));
		assert.deepEqual(contact, { status: 400, code: 'reserved-address', message: "/design-system is served by the site's own code (src/pages/design-system.astro), so a page can't go there." });
		const shop = refusal(() => planCreate(s.site, { collection: 'pages', path: 'shop/a-mug', title: 'A mug' }, listed));
		assert.match(shop.message, /^\/shop\/a-mug is served by the site's own code \(src\/pages\/shop\/\[slug\]\.astro\)/);
		// work/[slug].astro is the case studies' own (their urlBase), so it reserves nothing.
		assert.ok(!s.site.codeRoutes!.some((r) => r.file.includes('work')));
		const admin = refusal(() => planCreate(s.site, { collection: 'pages', path: 'admin', title: 'Admin' }, listed));
		assert.equal(admin.code, contact.code);
	});

	test('with index.astro in place, a new page at /team-2 is fine: a static route reserves only its own URL', async () => {
		const listed = await listDocuments(s.site);
		assert.equal(planCreate(s.site, { collection: 'pages', path: 'team-2', title: 'Team' }, listed).url, '/team-2');
	});

	test('a move or a rename onto a code route\'s URL is refused', async () => {
		const listed = await listDocuments(s.site);
		const moved = refusal(() => planMove(s.site, { collection: 'pages', path: 'about', to: 'design-system' }, listed));
		assert.equal(moved.code, 'reserved-address');
		assert.match(moved.message, /^\/design-system is served/);
	});

	test('a second route with parameters at the pages\' base: a create or a move it would serve is refused', async () => {
		const shadowed = { ...s.site, codeRoutes: codeRoutesFrom(['[slug].astro', '[...path].astro'].map((f) => routeOf(f, `src/pages/${f}`)!), Object.values(s.site.collections)) };
		const listed = await listDocuments(s.site);
		const created = refusal(() => planCreate(shadowed, { collection: 'pages', path: 'careers', title: 'Careers' }, listed));
		assert.deepEqual(created, { status: 400, code: 'reserved-address', message: "/careers is served by the site's own code (src/pages/[slug].astro), so a page can't go there." });
		assert.equal(refusal(() => planMove(shadowed, { collection: 'pages', path: 'about', to: 'careers' }, listed)).code, 'reserved-address');
	});

	test('the browser has the routes, and its address check refuses the same', () => {
		const editor = editorSite({ ...s.site, textStyles: {} } as never, [], 'localhost', { name: 'Site', accent: '#000' } as never);
		assert.deepEqual(editor.codeRoutes, s.site.codeRoutes);
		const problem = addressProblem('/design-system', 'pages', editor.collections, [], editor.codeRoutes);
		assert.equal(problem?.code, 'reserved-address');
	});
});

describe('the integration reads them', () => {
	test('at setup, from Astro\'s srcDir, into the site the editor\'s modules get', async () => {
		const root = tree(['about.astro', '[...path].astro']);
		try {
			mkdirSync(join(root, 'content/pages'), { recursive: true });
			const blockFile = join(root, 'Block.astro');
			writeFileSync(blockFile, '');
			const site: SiteConfig = { ...(config as SiteConfig), blocks: Object.fromEntries(Object.entries((config as SiteConfig).blocks).map(([k, b]) => [k, { ...b, component: blockFile }])), page: blockFile, textStyles: {} };
			for (const b of Object.values(site.blocks)) for (const f of Object.values(b.fields)) if (f.kind === 'lockup') Object.assign(f, { kind: 'text', multiline: false, heading: true });
			const updates: { vite?: { plugins: { load(id: string): string | undefined }[] } }[] = [];
			await caracms(site).hooks['astro:config:setup']!({
				command: 'build',
				config: { root: pathToFileURL(`${root}/`), srcDir: pathToFileURL(`${root}/src/`) },
				logger: { info() {}, warn() {} },
				updateConfig: (c: never) => updates.push(c),
				injectRoute: () => {},
				addMiddleware: () => {},
			} as never);
			const plugin = updates.find((u) => u.vite)!.vite!.plugins[0]!;
			const text = plugin.load('\0virtual:caracms/config')!;
			assert.match(text, /"codeRoutes":\[\{"file":"src\/pages\/about\.astro","url":"\/about","dynamic":false,"rest":false\}\]/);
			assert.ok(virtualModules);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
