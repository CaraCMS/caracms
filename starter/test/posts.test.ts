// Posts and tags, the starter's part in a render (Decisions 7, 9, 10; Acceptance 4–9): the post
// order, a card with parts missing, and the Posts block's Tag and paging, on the pinned content.
// The built pages (the journal's three pages, tag pages, previous / next) are in build-output.test.ts.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { postOrder, type Post } from '../src/collections/journal.ts';
import { count, pinnedSite, startRenderer, type Renderer } from './helpers/render.ts';

const post = (title: string, date: string | null, path = title.toLowerCase()): Post => ({ path, url: `/journal/${path}`, title, data: { date, tags: [], cover: null, excerpt: '' } as Post['data'], entry: {} as Post['entry'] });

describe('the post order (Decision 7; Acceptance 4, 7)', () => {
	test('newest first, undated after every dated post, ties by title A to Z', () => {
		const sorted = [post('Zed', '2025-01-01'), post('Undated B', null), post('Beta', '2026-03-01'), post('Undated A', null), post('Alpha', '2026-03-01'), post('Old', '2024-12-31')].sort(postOrder);
		assert.deepEqual(sorted.map((p) => p.title), ['Alpha', 'Beta', 'Zed', 'Old', 'Undated A', 'Undated B']);
	});
	test('titles compare as the editor does: case aside, numbers by value', () => {
		assert.deepEqual([post('post 10', null), post('Post 9', null)].sort(postOrder).map((p) => p.title), ['Post 9', 'post 10']);
	});
});

describe('the Posts block and its cards, rendered (Acceptance 4–6, 8–9)', () => {
	const demo = pinnedSite('posts');
	let r: Renderer;
	let site: any;
	let parseDocumentText: (text: string, site: unknown) => { document: any };
	before(async () => {
		// A post with no date, no cover and no excerpt, beside the pinned ones.
		writeFileSync(join(demo.root, 'content/journal/bare.json'), JSON.stringify({ title: 'A bare post', tags: ['print'], blocks: [] }));
		// A shared All block, for Decision 10's rule that a shared one never pages.
		writeFileSync(join(demo.root, 'content/shared/all-posts.json'), JSON.stringify({ title: 'All posts', block: { type: 'posts', show: 'all' } }));
		r = await startRenderer(demo.root);
		({ site } = await r.load('virtual:caracms/config'));
		({ parseDocumentText } = await r.load('caracms/document'));
	});
	after(async () => {
		await r?.close();
		demo.close();
	});
	// The render's address is `/render-test` (helpers/render.ts), so the document is also that page's
	// file: the block finds its own page there to see whether it's the paging one (posts.ts → pagesHere).
	const render = (blocks: unknown[], props: Record<string, unknown> = {}) => {
		const text = JSON.stringify({ title: 'Test', blocks });
		writeFileSync(join(demo.root, 'content/pages/render-test.json'), text);
		return r.page('caracms/components/RenderDocument.astro', { document: parseDocumentText(text, site).document, collection: 'pages', ...props });
	};
	const cardsIn = (html: string) => [...html.matchAll(/<a class="post-card[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!);

	test('a card with no date, cover or excerpt: its title alone, no image, no empty line', async () => {
		const html = await render([{ type: 'posts', show: 'all', tag: 'print' }]);
		const bare = cardsIn(html).find((c) => c.includes('A bare post'))!;
		assert.ok(bare, 'the bare post is listed');
		assert.doesNotMatch(bare, /<img|<time|class="frame|fg-muted/);
		assert.match(bare, /^\s*<b class="post-title text-h4"[^>]*>A bare post<\/b>\s*$/);
		const full = cardsIn(html).find((c) => !c.includes('A bare post'))!;
		// The cover needs the media variables, which a test render hasn't got: the date, title and excerpt.
		assert.match(full, /<time[\s\S]*<b class="post-title[\s\S]*<span class="fg-muted"/, 'a full card: date, title, excerpt');
	});

	test('Acceptance 1: a post\'s preview shows its date and its tags above its blocks, each tag a link to its page', async () => {
		const { readDocument } = await r.load('caracms/content');
		const { document } = await readDocument(site, 'journal', 'the-autumn-print-run');
		const html = await r.page('caracms/components/RenderDocument.astro', { document, collection: 'journal', preview: true }, 'http://localhost/preview?collection=journal&path=the-autumn-print-run');
		const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)![1]!;
		assert.match(main, /^\s*<div[^>]*><time[^>]*datetime="2026-10-06"[^>]*>[^<]*<\/time>/, 'the date comes first');
		assert.match(main, /<a class="link"[^>]*href="\/tags\/print"[^>]*>Print<\/a>/);
		assert.ok(main.indexOf('href="/tags/print"') < main.indexOf('Three clients, one press'), 'above the first block');
	});

	test('with a Tag, only its posts; ten or fewer: no pager', async () => {
		const html = await render([{ type: 'posts', show: 'all', tag: 'print' }]);
		// The pinned Print posts and the bare one.
		assert.equal(cardsIn(html).length, 9);
		assert.equal(count(html, /class="pager/g), 0);
	});

	test('All with more than ten: page 1 has ten and "Older posts"; listPage 3 has the last five, the two undated last, by title', async () => {
		const first = await render([{ type: 'posts', show: 'all' }]);
		assert.equal(cardsIn(first).length, 10);
		assert.match(first, /Page 1 of 3/);
		const third = await render([{ type: 'posts', show: 'all' }], { listPage: 3 });
		assert.equal(cardsIn(third).length, 5);
		assert.match(cardsIn(third).at(-2)!, /A bare post/);
		assert.match(cardsIn(third).at(-1)!, /Things we keep on the wall/);
		assert.match(third, /Newer posts/);
		assert.doesNotMatch(third, /Older posts/);
	});

	test('a Tag that has been deleted reads as none: every post', async () => {
		const html = await render([{ type: 'posts', show: 'all', tag: 'gone' }]);
		assert.match(html, /Page 1 of 3/);
	});

	test('Latest: its count, 3 when it is empty; a page number does nothing to it', async () => {
		assert.equal(cardsIn(await render([{ type: 'posts', show: 'latest', count: 5 }])).length, 5);
		assert.equal(cardsIn(await render([{ type: 'posts', show: 'latest' }], { listPage: 2 })).length, 3);
	});

	test('a preview is page 1, its pager links on the document\'s own address', async () => {
		const html = await render([{ type: 'posts', show: 'all' }], { listPage: 2, preview: true });
		assert.match(html, /Page 1 of 3/);
	});

	// Decision 10: one paged Posts block per page, the page's first unshared All block.
	const titles = (html: string) => cardsIn(html).map((c) => /class="post-title[^>]*>([^<]*)</.exec(c)![1]);

	test('a shared All block never pages: its first ten and no pager, on a page and in its own preview', async () => {
		const html = await render([{ shared: 'all-posts' }]);
		assert.equal(cardsIn(html).length, 10);
		assert.equal(count(html, /class="pager/g), 0);
		const second = await render([{ shared: 'all-posts' }], { listPage: 2 });
		assert.deepEqual(titles(second), titles(html), 'page 2 shows the same first ten');
		assert.equal(count(second, /class="pager/g), 0);
		// Its own preview (the editor's `?collection=shared&path=all-posts`), which the render helper's
		// fixed address can't make: the rule itself.
		const { pagesHere } = await r.load('/src/blocks/posts.ts');
		const cms = { index: 0, preview: true, shared: null, listPage: 1, read: { document: async () => null, exists: async () => false } };
		assert.equal(await pagesHere(cms, new URL('http://localhost/preview?collection=shared&path=all-posts')), false);
		assert.equal(await pagesHere(cms, new URL('http://localhost/preview?collection=pages&path=new-page')), true, 'a page with nothing stored yet: as it would alone');
	});

	test('a shared All block first does not take the paging: the page\'s own All block after it pages', async () => {
		const html = await render([{ shared: 'all-posts' }, { type: 'posts', show: 'all' }], { listPage: 2 });
		assert.equal(count(html, /<nav class="pager/g), 1);
		assert.match(html, /Page 2 of 3/);
	});

	test('on page 2, a second All block shows the first ten and no pager; the first pages', async () => {
		const first = await render([{ type: 'posts', show: 'all' }]);
		const html = await render([{ type: 'posts', show: 'all' }, { type: 'posts', show: 'all' }], { listPage: 2 });
		assert.equal(count(html, /<nav class="pager/g), 1, 'one pager, the first block\'s');
		assert.match(html, /Page 2 of 3/);
		const cards = titles(html);
		assert.equal(cards.length, 20);
		assert.notDeepEqual(cards.slice(0, 10), titles(first), 'the first block is on page 2');
		assert.deepEqual(cards.slice(10), titles(first), 'the second shows the first ten');
	});

	test('a second All block with more posts than the first: no pager of its own to a page that was never built', async () => {
		const html = await render([{ type: 'posts', show: 'all', tag: 'print' }, { type: 'posts', show: 'all' }]);
		assert.equal(count(html, /class="pager/g), 0, 'the first has nine, so no pager; the second has none');
		assert.equal(cardsIn(html).length, 19);
	});
});
