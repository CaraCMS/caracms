// Posts and tags, the package's part through the fixture site (Decisions 12, 14–16; Acceptance 18–20),
// on `caracms.paged.config.ts`: the fixture plus a paged list block (`listing`, ten a page) and a
// `date` page field on the journal (helpers/site-render.ts → pagedSite).
// - A render: the page number reaches the block, a preview is always page 1, and the title says so.
// - A production build with 300 generated posts and a paged listing completes, with `/page/2` onwards
//   as the fixture's route makes them (through `contentReader`), their titles and canonical links,
//   and no paged address in the sitemap.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { count, pagedSite, root, startRenderer, type Renderer } from './helpers/site-render.ts';

/** Made up, as in site-build-variants.test.ts: the pinned content has images. */
const FAKE_MEDIA_ENV = {
	CARACMS_MEDIA_URL: 'https://img.example.test',
	IMGPROXY_KEY: '6275696c642d746573742d6b6579',
	IMGPROXY_SALT: '6275696c642d746573742d73616c74',
	S3_BUCKET: 'test-media',
};

const LISTING_PAGE = { title: 'Notes', blocks: [{ type: 'listing', heading: 'All notes' }] };

/** `n` journal posts, one a day back from 2026-06-30, so the newest is post 1. */
function addPosts(at: string, n: number) {
	for (let i = 1; i <= n; i++) {
		const day = new Date(Date.UTC(2026, 5, 30 - (i - 1))).toISOString().slice(0, 10);
		const post = { title: `Post ${String(i).padStart(3, '0')}`, date: day, blocks: [{ type: 'text', heading: `Post ${i}`, body: 'A note.', background: 'light' }] };
		writeFileSync(join(at, `content/journal/post-${String(i).padStart(3, '0')}.json`), JSON.stringify(post));
	}
}

describe('the page number in a render (Decisions 12, 16; Acceptance 19)', () => {
	const copy = pagedSite('paged-render');
	let r: Renderer;
	let site: any;
	let parseDocumentText: (text: string, site: unknown) => { document: any };
	before(async () => {
		addPosts(copy.root, 25);
		r = await startRenderer(copy.root);
		({ site } = await r.load('virtual:caracms/config'));
		({ parseDocumentText } = await r.load('caracms/document'));
	});
	after(async () => {
		await r.close();
		copy.close();
	});
	const render = (props: Record<string, unknown>) => r.page('caracms/components/RenderDocument.astro', { document: parseDocumentText(JSON.stringify(LISTING_PAGE), site).document, collection: 'pages', ...props });

	test('the block gets the page given: page 2 of 3 shows the next ten, and the title says " — page 2"', async () => {
		const html = await render({ listPage: 2 });
		assert.match(html, /Page 2 of 3/);
		assert.match(html, /Post 011/);
		assert.doesNotMatch(html, /Post 010</);
		assert.match(html, /<title>Notes — page 2 · /);
	});

	test('no page given: page 1, with its plain title', async () => {
		const html = await render({});
		assert.match(html, /Page 1 of 3/);
		assert.match(html, /<title>Notes · /);
	});

	test('a preview is always page 1, whatever it is given', async () => {
		const html = await render({ listPage: 2, preview: true });
		assert.match(html, /Page 1 of 3/);
		assert.doesNotMatch(html, /— page 2/);
	});
});

describe('a production build with 300 posts and a paged listing (Decisions 14, 15; Acceptance 18, 20)', () => {
	const copy = pagedSite('paged-build');
	after(() => copy.close());

	test('completes, with each page of the listing, its own title and canonical link, and no paged address in the sitemap', () => {
		addPosts(copy.root, 300);
		writeFileSync(join(copy.root, 'content/pages/notes.json'), JSON.stringify(LISTING_PAGE));
		const env: NodeJS.ProcessEnv = { ...process.env, ...FAKE_MEDIA_ENV, SITE_URL: 'https://site.test' };
		for (const name of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']) delete env[name];
		const run = spawnSync(join(root, 'node_modules/.bin/astro'), ['build', '--root', copy.root], { env, encoding: 'utf8', timeout: 300_000 });
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

		const client = join(copy.root, 'dist/client');
		const html = (path: string) => readFileSync(join(client, path, 'index.html'), 'utf8');
		// 300 dated posts and the fixture's 3 undated ones: 303, ten a page, so 31 pages. (The Journal page, which holds them, is journal/index.html.)
		assert.equal(readdirSync(join(client, 'journal')).filter((n) => n !== 'index.html').length, 303, 'every post was built');
		assert.match(html('notes'), /Page 1 of 31/);
		assert.match(html('notes'), /Post 001/);
		const page2 = html('notes/page/2');
		assert.match(page2, /Page 2 of 31/);
		assert.match(page2, /Post 011/);
		assert.match(page2, /<title>Notes — page 2 · [^<]+<\/title>/);
		assert.match(page2, /<link rel="canonical" href="https:\/\/site\.test\/notes\/page\/2"/);
		assert.match(html('notes/page/31'), /Page 31 of 31/);
		assert.equal(count(html('notes/page/31'), /<li>/g), 3, 'the last page has the 3 undated posts');
		assert.equal(existsSync(join(client, 'notes/page/1')), false, 'no /page/1');
		assert.equal(existsSync(join(client, 'notes/page/32')), false, 'no /page/32');
		assert.equal(existsSync(join(client, 'page')), false, "a page with no paged list gets no /page/ addresses");
		const sitemap = readFileSync(join(client, 'sitemap.xml'), 'utf8');
		assert.match(sitemap, /<loc>https:\/\/site\.test\/notes<\/loc>/);
		assert.doesNotMatch(sitemap, /\/page\/\d/);
	});
});
