// M9 (the Tina port), checked through the fixture site with M9's test blocks added (helpers/m9-site.ts):
// - Decision 8 / check 4: `<Media>` on a PNG field asks for `@png` at every width; other fields stay WebP.
// - Decision 10 / check 5: the lines rendering (a span per typed line, blank lines dropped, one line bare).
// - Decision 11 / check 6: a heading rich-text field draws inline runs joined by <br> in its heading tag,
//   can be the page's h1, and reads as plain text where the heading is read as text.
// - Decision 7 / checks 2-3: a hidden page (About, and Team under it) isn't among the pages route's paths,
//   the sitemap's URLs or a collection's documents as blocks read them; the others are.
// - Decision 9 / check 14's package side: `<Blocks wrap>` draws a band of cards round blocks 1-3; each
//   block inside keeps its index, its context and its preview markers.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { addCards, addM9, CARDS_DOCUMENT, M9_DOCUMENT } from './helpers/m9-site.ts';
import { count, pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const copy = pinnedSite('m9-render');
addM9(copy.root);
addCards(copy.root);
// Decision 7: About hidden, as the editor writes it (Team, under it, is hidden with it).
const aboutFile = join(copy.root, 'content/pages/about.json');
writeFileSync(aboutFile, readFileSync(aboutFile, 'utf8').replace('"title": "About",', '"title": "About",\n  "hidden": true,'));
let r: Renderer;
let site: any;
let parseDocumentText: (text: string, site: unknown) => { document: any };
const was = process.env.CARACMS_MEDIA;
before(async () => {
	process.env.CARACMS_MEDIA = 'memory';
	r = await startRenderer(copy.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseDocumentText } = await r.load('caracms/document'));
});
after(async () => {
	await r.close();
	copy.close();
	if (was === undefined) delete process.env.CARACMS_MEDIA;
	else process.env.CARACMS_MEDIA = was;
});

const doc = (blocks: unknown[]) => parseDocumentText(JSON.stringify({ title: 'M9', blocks }), site).document;
const render = (blocks: unknown[], preview = false) => r.page('caracms/components/RenderDocument.astro', { document: doc(blocks), collection: 'pages', preview });
const [statement, lines] = M9_DOCUMENT.blocks as unknown as [Record<string, unknown>, Record<string, unknown>];
const srcsetOf = (html: string, cls: string) => {
	const tag = html.match(new RegExp(`<img[^>]*class="${cls}"[^>]*>`))?.[0] ?? '';
	return [...(tag.match(/srcset="([^"]*)"/)?.[1] ?? '').split(', ').map((e) => e.split(' ')[0]!), tag.match(/ src="([^"]*)"/)?.[1] ?? ''];
};

describe('PNG media through <Media> (Decision 8, check 4)', () => {
	test('the PNG field\'s image asks for @png at every width; the other field\'s for @webp', async () => {
		const html = await render([lines]);
		const png = srcsetOf(html, 'lines-art');
		const webp = srcsetOf(html, 'lines-photo');
		assert.ok(png.length > 2, html);
		for (const url of png) assert.match(url, /@png$/);
		for (const url of webp) assert.match(url, /@webp$/);
	});
});

describe('the lines rendering (Decision 10, check 5)', () => {
	test('two lines: a span each with the component\'s class, the blank line drawing nothing, no <br>', async () => {
		const html = await render([lines]);
		const heading = html.match(/<h1[^>]*class="lines-heading"[^>]*>(.*?)<\/h1>/s)?.[1];
		assert.equal(heading, '<span class="block text-balance">First line</span><span class="block text-balance">Second line</span>');
		assert.doesNotMatch(html, /data-cms-line/, 'no preview markers in the public render');
	});

	test('one line is drawn unwrapped; an empty value draws nothing', async () => {
		assert.match(await render([{ ...lines, heading: '\nOnly line\n' }]), /<h1 class="lines-heading"[^>]*>Only line<\/h1>/);
		assert.doesNotMatch(await render([{ ...lines, heading: '' }]), /lines-heading/);
	});

	test("each line is drawn trimmed, as Tina's toLines() did (port friction 7); a line of spaces draws nothing", async () => {
		const heading = (await render([{ ...lines, heading: '  First line \n   \n\tSecond line  ' }])).match(/<h1[^>]*class="lines-heading"[^>]*>(.*?)<\/h1>/s)?.[1];
		assert.equal(heading, '<span class="block text-balance">First line</span><span class="block text-balance">Second line</span>');
		assert.match(await render([{ ...lines, heading: '   Only line  ' }]), /<h1 class="lines-heading"[^>]*>Only line<\/h1>/);
	});

	test('the preview marks each line and the element, so the page reads and writes it back', async () => {
		const html = await render([lines], true);
		assert.equal(count(html, /<span class="block text-balance" data-cms-line(="")?>/g), 2, html.match(/<h1.*?<\/h1>/s)?.[0]);
		assert.match(html, /<h1[^>]*data-cms-field="heading"[^>]*data-cms-lines(="")?[^>]*data-cms-line-class="block text-balance"/);
	});
});

describe('heading rich text (Decision 11, check 6)', () => {
	test('inline runs joined by <br> inside the h1, bold as <strong>, italic and lists dropped, no <p>', async () => {
		const html = await render([{ ...statement, statement: [{ p: 'Play **hard**' }, { p: 'Win *softly*' }, { ul: ['A list item'] }] }]);
		const h1 = html.match(/<h1 class="statement"[^>]*>(.*?)<\/h1>/s)?.[1];
		assert.equal(h1, 'Play <strong>hard</strong><br>Win softly<br>A list item');
		assert.doesNotMatch(html.match(/<main>.*<\/main>/s)![0], /<p[\s>]/);
	});

	test('it counts as the block\'s heading: the first block with one holds the h1; a later one is an h2', async () => {
		const html = await render([lines, statement]);
		assert.equal(count(html, /<h1[\s>]/g), 1);
		assert.match(html, /<h1 class="lines-heading"/);
		assert.match(html, /<h2 class="statement"[^>]*>Play <strong>hard<\/strong>/);
		// Empty, it doesn't take the h1.
		const empty = await render([{ ...statement, statement: [] }, lines]);
		assert.match(empty, /<h1 class="lines-heading"/);
	});

	test('the preview keeps the on-page markers on the heading itself', async () => {
		const html = await render([statement], true);
		assert.match(html, /<h1 class="statement"[^>]*data-cms-field="statement"[^>]*data-cms-kind="richText"[^>]*tabindex="0"/);
	});
});

describe('hidden pages on the site (Decision 7, checks 2-3)', () => {
	test('the pages route builds no page for About or Team, and every other page as before', async () => {
		const { getStaticPaths } = await r.load('/src/pages/[...path].astro');
		const paths = ((await getStaticPaths()) as { params: { path?: string } }[]).map((p) => p.params.path ?? '');
		assert.ok(!paths.includes('about') && !paths.includes('about/team'), paths.join(', '));
		for (const shown of ['', 'contact', 'visit', 'work', 'services/branding', 'm9']) assert.ok(paths.includes(shown), `${shown} in ${paths.join(', ')}`);
	});

	test('the sitemap leaves them out', async () => {
		const { sitemapUrls } = await r.load('caracms/components/sitemap.xml.ts');
		const urls = (await sitemapUrls('https://example.com')) as string[];
		assert.ok(urls.includes('https://example.com/contact'));
		assert.ok(!urls.some((u) => /\/about(\/|$)/.test(u)), urls.join('\n'));
	});

	test('a block reading the collection doesn\'t get them; reading one by its path still does', async () => {
		const { contentReader } = await r.load('caracms/content');
		const read = contentReader(site);
		const listed = ((await read.documents('pages')) as { path: string }[]).map((d) => d.path);
		assert.ok(!listed.includes('about') && !listed.includes('about/team'));
		assert.ok(listed.includes('contact'));
		assert.equal((await read.document('pages', 'about'))?.title, 'About');
	});
});

describe('runs of blocks (Decision 9, check 14)', () => {
	const main = (html: string) => html.match(/<main>(.*)<\/main>/s)![1]!;
	const strip = (html: string) => html.replace(/ data-astro-[a-z-]+(="[^"]*")?/g, '');

	test('the band holds the two cards, each its blocks in order; the blocks either side stay outside', async () => {
		// The title drives the page component's rule: the document needs its own title.
		const html = await r.page('caracms/components/RenderDocument.astro', { document: parseDocumentText(JSON.stringify(CARDS_DOCUMENT), site).document, collection: 'pages' });
		const body = strip(main(html));
		const order = ['Before', '<div class="band-of-cards" data-label="About us">', '<article class="card" id="story">', 'Story one', 'Story two', '</article>', '<article class="card" id="team">', 'Team', '</article>', '</div>', 'After'];
		let at = -1;
		for (const piece of order) {
			const next = body.indexOf(piece, at + 1);
			assert.ok(next > at, `${piece} after the one before:\n${body}`);
			at = next;
		}
		assert.equal(count(body, /<h1[\s>]/g), 1, 'the h1 rule is unchanged: the first block\'s heading');
		assert.match(body, /<h1 class="text-heading"[^>]*>Before<\/h1>/);
	});

	test('in a preview each block inside keeps its own index and markers; the wrappers carry none', async () => {
		const html = await r.page('caracms/components/RenderDocument.astro', { document: parseDocumentText(JSON.stringify(CARDS_DOCUMENT), site).document, collection: 'pages', preview: true });
		const body = main(html);
		for (const i of [0, 1, 2, 3, 4]) assert.equal(count(body, new RegExp(`data-cms-block="${i}"`, 'g')), 1, `block ${i}`);
		assert.match(body, /<article class="card" id="story"[^>]*><section[^>]*data-cms-block="1"/);
		assert.doesNotMatch(body.match(/<div class="band-of-cards"[^>]*>/)![0], /data-cms/);
	});

	test('another page has no runs: the flat list, as before', async () => {
		const html = await render([lines]);
		assert.doesNotMatch(html, /band-of-cards|class="card"/);
	});
});
