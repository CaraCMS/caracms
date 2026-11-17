// M7 Decision 2: moved from starter/test. It checks a package feature through a site, so it runs on the
// package's fixture site (test/fixtures/demo-site, the pre-M7 demo) and pinned content (helpers/site-render.ts).
// M6c, what only a production build shows. The caracms browser tests' test-only edit of the
// fixture site (helpers/port-site.ts: a `team` collection with no urlBase, help
// on the text block, its heading and the journal's tagline) is built on SITE_URL, as the
// deploy builds, and:
// - G1: the sitemap lists no document of the collection with no pages of its own, and still
//   lists the pages and the journal entries;
// - G8: no help text is in any built page (it is for the sidebar only).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { edit } from './helpers/port-site.ts';
import { pinnedSite, root } from './helpers/site-render.ts';

const SITE_URL = 'https://site.test';
/** Made up, as in helpers/dist.ts: the pinned content has images, and a build that renders one needs the media variables. */
const FAKE_MEDIA_ENV = {
	CARACMS_MEDIA_URL: 'https://img.example.test',
	IMGPROXY_KEY: '6275696c642d746573742d6b6579',
	IMGPROXY_SALT: '6275696c642d746573742d73616c74',
	S3_BUCKET: 'test-media',
};

const filesIn = (dir: string): string[] =>
	existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesIn(join(dir, n)) : [join(dir, n)])) : [];

describe('M6c, built', () => {
	const copy = pinnedSite('port-readiness');
	let client = '';
	before(() => {
		edit(copy.root);
		const env: NodeJS.ProcessEnv = { ...process.env, ...FAKE_MEDIA_ENV, SITE_URL };
		const run = spawnSync(join(root, 'node_modules/.bin/astro'), ['build', '--root', copy.root], { env, encoding: 'utf8', timeout: 180_000 });
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
		client = join(copy.root, 'dist/client');
	});
	after(() => copy.close());

	test('G1: the sitemap has no document of a collection without urlBase, and still has the rest', () => {
		assert.ok(existsSync(join(copy.root, 'content/team/aoife.json')), 'the team document exists');
		const xml = readFileSync(join(client, 'sitemap.xml'), 'utf8');
		const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
		assert.ok(urls.includes(`${SITE_URL}/`), 'the home page is listed');
		assert.ok(urls.some((u) => u.startsWith(`${SITE_URL}/journal/`)), 'a journal entry is listed');
		assert.ok(urls.length >= 5, `the sitemap has the site's pages: ${urls.length}`);
		assert.deepEqual(urls.filter((u) => /^\/team(\/|$)|aoife/i.test(u.slice(SITE_URL.length))), [], 'no team address');
		assert.doesNotMatch(xml, /aoife/i);
		// Nor is there a built page for it.
		assert.equal(existsSync(join(client, 'team')), false, 'no team route');
	});

	test('G8: no help text is in any built page', () => {
		const pages = filesIn(client).filter((f) => f.endsWith('.html'));
		assert.ok(pages.length >= 5, 'the pages were built');
		const texts = [
			'A heading and a few paragraphs, on a plain band.',
			'Optional. The first heading on a page is its h1.',
			'Under the title on the journal cards.',
			'What they did, in a word or two.',
		];
		for (const page of pages) {
			const html = readFileSync(page, 'utf8');
			for (const t of texts) assert.equal(html.includes(t), false, `${page}: "${t}"`);
			assert.doesNotMatch(html, /data-help|field-help|data-block-help/, `${page}: no help markup`);
		}
	});
});
