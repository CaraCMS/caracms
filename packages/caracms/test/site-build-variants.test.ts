// M7 Decision 2: moved from starter/test. It checks a package feature through a site, so it runs on the
// package's fixture site (test/fixtures/demo-site, the pre-M7 demo) and pinned content (helpers/site-render.ts).
// The demo built other ways than the build-output tests build it (M6 Acceptance 30, 34, 37, 42):
// - without SITE_URL: no canonical link, no og:url, no sitemap, one warning in the build's log;
// - with a Google tag in Site Settings: the production build carries its snippet, and a dev render
//   (public or preview) never does.
// Each builds its own pinned copy in its own process, as the deploy runs it (media-build.test.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { count, pinnedSite, root, startRenderer, type Renderer } from './helpers/site-render.ts';

/** Made up, as in helpers/dist.ts: the pinned content has images, and a build that renders one needs the media variables. */
const FAKE_MEDIA_ENV = {
	CARACMS_MEDIA_URL: 'https://img.example.test',
	IMGPROXY_KEY: '6275696c642d746573742d6b6579',
	IMGPROXY_SALT: '6275696c642d746573742d73616c74',
	S3_BUCKET: 'test-media',
};

function astroBuild(at: string, extra: Record<string, string> = {}) {
	const env: NodeJS.ProcessEnv = { ...process.env, ...FAKE_MEDIA_ENV };
	for (const name of ['SITE_URL', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']) delete env[name];
	Object.assign(env, extra);
	return spawnSync(join(root, 'node_modules/.bin/astro'), ['build', '--root', at], { env, encoding: 'utf8', timeout: 180_000 });
}

const htmlIn = (dir: string): string[] =>
	existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? htmlIn(join(dir, n)) : n.endsWith('.html') ? [join(dir, n)] : [])) : [];

describe('a build without SITE_URL (Acceptance 30, 37, 42)', () => {
	const copy = pinnedSite('no-site-url');
	after(() => copy.close());

	test('succeeds with one warning; no page has a canonical link or og:url; there is no sitemap; no page has a robots meta', () => {
		const run = astroBuild(copy.root);
		const log = `${run.stdout}\n${run.stderr}`;
		assert.equal(run.status, 0, log);
		assert.equal(count(log, /SITE_URL is not set/g), 1, `one warning:\n${log}`);
		const pages = htmlIn(join(copy.root, 'dist/client'));
		assert.ok(pages.length >= 5, 'the pages were built');
		for (const page of pages) {
			const html = readFileSync(page, 'utf8');
			assert.doesNotMatch(html, /rel="canonical"/, `${page}: canonical`);
			assert.doesNotMatch(html, /property="og:url"/, `${page}: og:url`);
			assert.doesNotMatch(html, /<meta name="robots"/, `${page}: robots`);
			assert.equal(count(html, /<title>/g), 1, `${page}: still has its title`);
		}
		assert.equal(existsSync(join(copy.root, 'dist/client/sitemap.xml')), false, 'no sitemap');
	});
});

describe('the Google tag (Acceptance 34)', () => {
	const copy = pinnedSite('google-tag');
	let r: Renderer;
	let site: any;
	let parseDocumentText: (text: string, site: unknown) => { document: any };
	before(async () => {
		const file = join(copy.root, 'content/site-settings.json');
		const settings = JSON.parse(readFileSync(file, 'utf8'));
		settings.googleTag = 'GTM-ABC1234';
		writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
		r = await startRenderer(copy.root);
		({ site } = await r.load('virtual:caracms/config'));
		({ parseDocumentText } = await r.load('caracms/document'));
	});
	after(async () => {
		await r?.close();
		copy.close();
	});

	test('a dev render shows no tag, public or in the editor\'s preview', async () => {
		const document = parseDocumentText(JSON.stringify({ title: 'Test', blocks: [{ type: 'text', heading: 'Hello', body: 'Body' }] }), site).document;
		for (const preview of [false, true]) {
			const html = await r.page('caracms/components/RenderDocument.astro', { document, collection: 'pages', preview });
			assert.match(html, /<title>/, 'the head rendered');
			assert.doesNotMatch(html, /googletagmanager|GTM-ABC1234/, preview ? 'preview' : 'public');
		}
	});

	test('the production build carries the snippet on its pages', () => {
		const run = astroBuild(copy.root, { SITE_URL: 'https://site.test' });
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
		const pages = htmlIn(join(copy.root, 'dist/client'));
		assert.ok(pages.length >= 5, 'the pages were built');
		for (const page of pages) assert.match(readFileSync(page, 'utf8'), /googletagmanager\.com\/gtm\.js\?id='\+i;.*"GTM-ABC1234"\);<\/script>/, page);
	});
});
