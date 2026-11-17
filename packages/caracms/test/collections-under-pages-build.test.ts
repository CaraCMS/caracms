// Collections under pages, the production build (checks 3, 13, 16), on the package's fixture site
// (test/fixtures/demo-site) and pinned content (helpers/site-render.ts), each built in its own process:
// - check 3: a held collection no page holds has no addresses: the build makes no pages for its documents,
//   puts them in no sitemap, logs the sentence, and does not fail;
// - check 13: a hidden holder's documents answer nothing (no page built) and are out of the sitemap;
// - check 16: a site that keeps its own route file for a prefix collection gets exactly that route's
//   page for each of its documents (the catch-all builds none of them), beside the held documents
//   the catch-all builds as before, and Astro reports no route built twice.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { count, pinnedSite, root } from './helpers/site-render.ts';

/** Made up, as in site-build-variants.test.ts: the pinned content has images. */
const FAKE_MEDIA_ENV = {
	CARACMS_MEDIA_URL: 'https://img.example.test',
	IMGPROXY_KEY: '6275696c642d746573742d6b6579',
	IMGPROXY_SALT: '6275696c642d746573742d73616c74',
	S3_BUCKET: 'test-media',
};
const SITE = 'https://site.test';

function astroBuild(at: string) {
	const env: NodeJS.ProcessEnv = { ...process.env, ...FAKE_MEDIA_ENV, SITE_URL: SITE };
	for (const name of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']) delete env[name];
	const run = spawnSync(join(root, 'node_modules/.bin/astro'), ['build', '--root', at], { env, encoding: 'utf8', timeout: 240_000 });
	return { status: run.status, log: `${run.stdout}\n${run.stderr}` };
}

const htmlIn = (dir: string): string[] =>
	existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? htmlIn(join(dir, n)) : n.endsWith('.html') ? [join(dir, n)] : [])) : [];
const sitemapOf = (at: string) => readFileSync(join(at, 'dist/client/sitemap.xml'), 'utf8');
const POSTS = ['a-new-home-for-caracms', 'notes-from-the-ridge', 'type-that-holds-its-lines'];

function edit(at: string, file: string, change: (text: string) => string) {
	const path = join(at, file);
	writeFileSync(path, change(readFileSync(path, 'utf8')));
}

describe('a held collection no page holds (check 3)', () => {
	const copy = pinnedSite('held-unheld');
	after(() => copy.close());

	test('the build succeeds, makes no pages and no sitemap entries for its documents, and says why', () => {
		edit(copy.root, 'content/pages/journal.json', (t) => t.replace('  "holds": "journal",\n', ''));
		const run = astroBuild(copy.root);
		assert.equal(run.status, 0, run.log);
		const client = join(copy.root, 'dist/client');
		assert.ok(existsSync(join(client, 'journal/index.html')), 'the Journal page is still a page');
		for (const post of POSTS) assert.equal(existsSync(join(client, 'journal', post)), false, `${post} has no page`);
		assert.ok(existsSync(join(client, 'work/index.html')) && existsSync(join(client, 'contact/index.html')), 'everything else was built');
		const sitemap = sitemapOf(copy.root);
		assert.match(sitemap, /<loc>https:\/\/site\.test\/journal<\/loc>/);
		for (const post of POSTS) assert.ok(!sitemap.includes(post), `${post} is out of the sitemap`);
		assert.match(run.log, /No page holds Journal/, 'the build logs the sentence');
		assert.equal(count(run.log, /No page holds Journal/g), 1, 'once');
	});
});

describe('a hidden holder (check 13)', () => {
	const copy = pinnedSite('held-hidden');
	after(() => copy.close());

	test('its documents are not built and not in the sitemap, nor is the page', () => {
		edit(copy.root, 'content/pages/journal.json', (t) => t.replace('"title": "Journal",', '"title": "Journal",\n  "hidden": true,'));
		const run = astroBuild(copy.root);
		assert.equal(run.status, 0, run.log);
		const client = join(copy.root, 'dist/client');
		assert.equal(existsSync(join(client, 'journal')), false, 'no journal folder at all');
		assert.ok(existsSync(join(client, 'work/index.html')), 'the rest of the site was built');
		const sitemap = sitemapOf(copy.root);
		assert.ok(!sitemap.includes('/journal'), sitemap);
		assert.ok(sitemap.includes(`${SITE}/work`));
	});
});

describe('a prefix collection with its own route, beside a held one (check 16)', () => {
	const copy = pinnedSite('held-own-route');
	after(() => copy.close());

	test('exactly one page per document address: the site\'s own route renders the prefix collection\'s, the catch-all everything else', () => {
		edit(copy.root, 'caracms.config.ts', (t) =>
			t
				.replace("import { defineSite } from 'caracms/config';", "import { defineSite, text } from 'caracms/config';")
				.replace("journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: journalFields },", "journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: journalFields },\n\t\tnotes: { kind: 'fields', folder: 'content/notes', urlBase: '/notes/', component: 'src/collections/Note.astro', fields: { blurb: text() } },"),
		);
		mkdirSync(join(copy.root, 'content/notes'), { recursive: true });
		for (const slug of ['alpha', 'beta']) writeFileSync(join(copy.root, `content/notes/${slug}.json`), JSON.stringify({ title: `Note ${slug}`, blurb: 'A note.' }));
		writeFileSync(join(copy.root, 'src/collections/Note.astro'), '---\nconst { document } = Astro.props;\n---\n<p>{document.title}</p>\n');
		mkdirSync(join(copy.root, 'src/pages/notes'), { recursive: true });
		writeFileSync(
			join(copy.root, 'src/pages/notes/[slug].astro'),
			[
				'---',
				"import { site } from 'virtual:caracms/config';",
				"import { listDocuments } from 'caracms/content';",
				'export const prerender = true;',
				'export async function getStaticPaths() {',
				"\treturn (await listDocuments(site, 'notes')).map((d) => ({ params: { slug: d.path } }));",
				'}',
				'const { slug } = Astro.params;',
				'---',
				'<html><head><title>Note</title></head><body><h1>own route: {slug}</h1></body></html>',
			].join('\n'),
		);
		const run = astroBuild(copy.root);
		assert.equal(run.status, 0, run.log);
		assert.doesNotMatch(run.log, /multiple routes|conflict|collision|duplicate/i, 'Astro reports no route built twice');
		const client = join(copy.root, 'dist/client');
		for (const slug of ['alpha', 'beta']) {
			const html = readFileSync(join(client, 'notes', slug, 'index.html'), 'utf8');
			assert.match(html, new RegExp(`own route: ${slug}`), `/notes/${slug} is the site's own route's`);
		}
		assert.equal(htmlIn(join(client, 'notes')).length, 2, 'one page for each note, no more');
		for (const post of POSTS) assert.ok(existsSync(join(client, 'journal', post, 'index.html')), `${post} is the catch-all's`);
		const sitemap = sitemapOf(copy.root);
		for (const url of ['/notes/alpha', '/notes/beta', '/journal/notes-from-the-ridge', '/work']) assert.ok(sitemap.includes(`${SITE}${url}<`), `${url} in the sitemap once`);
		assert.equal(count(sitemap, /\/notes\/alpha</g), 1);
	});
});
