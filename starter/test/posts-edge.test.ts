// Posts and tags, the edge cases the demo's content can't show (Acceptance 5, 6, 9, 10, 13, 18), in a
// built copy of the pinned content changed first (helpers/dist.ts → buildCopy):
// - a post with no cover, and one with no excerpt, beside full ones (Acceptance 5, 6);
// - a tag with no posts, which says so and is still built (Acceptance 10);
// - a tag whose file is gone: the build doesn't fail, and the tag drops off its posts (Acceptance 13);
// - exactly ten matching posts with paging on: no pager, no `/page/2` (Acceptance 9);
// - the sitemap holds the journal and every tag, and no paged address (Acceptance 18).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { buildCopy, SITE_URL, type BuiltCopy } from './helpers/dist.ts';

const cover = { key: 'uploads/a40fe31a6eeb/material-samples.png', alt: 'Paint swatches', w: 1200, h: 1800 };
const write = (root: string, file: string, doc: unknown) => writeFileSync(join(root, 'content', file), `${JSON.stringify(doc, null, '\t')}\n`);

describe('posts and tags, the edge cases, built', () => {
	let built: BuiltCopy;
	let pinnedTags: string[];
	const htmlOf = (url: string) => readFileSync(join(built.client, url === '/' ? '' : url.replace(/^\//, ''), 'index.html'), 'utf8');
	const exists = (url: string) => existsSync(join(built.client, url.replace(/^\//, ''), 'index.html'));
	const cardsOf = (html: string) => [...html.matchAll(/<a class="post-card[^"]*"[^>]*href="\/journal\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ slug: m[1]!, html: m[2]! }));
	const card = (html: string, slug: string) => cardsOf(html).find((c) => c.slug === slug)!;

	before(async () => {
		built = await buildCopy('posts-edge', (root) => {
			pinnedTags = readdirSync(join(root, 'content/tags')).map((f) => f.slice(0, -5));
			// Acceptance 10: a tag nobody has used.
			write(root, 'tags/workshop.json', { title: 'Workshop', description: 'Days we open the studio for people to make things.' });
			// Acceptance 13: a tag deleted while posts still name it ("web" is on five pinned posts).
			rmSync(join(root, 'content/tags/web.json'));
			// Acceptance 5 and 6: two more Print posts, each missing one part. With the eight pinned ones
			// Print has exactly ten posts (Acceptance 9), and a page lists it with paging on.
			write(root, 'journal/no-cover.json', { title: 'No cover here', date: '2026-09-01', tags: ['print', 'web'], excerpt: 'A post with a date and an excerpt, and no picture.', blocks: [] });
			write(root, 'journal/no-excerpt.json', { title: 'No excerpt here', date: '2026-08-01', tags: ['print'], cover, blocks: [] });
			// Acceptance 8: a tag with eleven posts (seven pinned and four here), paged on its own: two pages.
			for (let i = 1; i <= 4; i++) write(root, `journal/extra-field-${i}.json`, { title: `Extra field ${i}`, date: `2025-12-0${i}`, tags: ['field'], blocks: [] });
			write(root, 'pages/field-posts.json', { title: 'Field posts', blocks: [{ type: 'posts', heading: 'Field', show: 'all', tag: 'field' }] });
			write(root, 'pages/print-notes.json', { title: 'Print notes', blocks: [{ type: 'posts', heading: 'Print', show: 'all', tag: 'print' }] });
		});
	});

	test('Acceptance 5: a post with no cover has a card without an image or an empty box, the rest of the card unchanged; the cards beside it have their images', () => {
		const html = htmlOf('/tags/print');
		const noCover = card(html, 'no-cover');
		assert.ok(noCover, 'the post is listed');
		assert.doesNotMatch(noCover.html, /<img|<picture|frame/);
		assert.match(noCover.html, /^\s*<time[^>]*datetime="2026-09-01"[\s\S]*<b class="post-title[^>]*>No cover here<\/b>[\s\S]*A post with a date and an excerpt, and no picture\.[\s\S]*$/);
		const others = cardsOf(html).filter((c) => c.slug !== 'no-cover');
		assert.equal(others.length, 9);
		for (const c of others) assert.match(c.html, /^\s*<img /, `${c.slug} leads with its cover`);
		// The same card element and classes, so the grid lines them up whichever parts a card has.
		const classes = new Set([...html.matchAll(/<a class="(post-card[^"]*)"/g)].map((m) => m[1]!.replace(/astro-\w+/g, '').trim()));
		assert.equal(classes.size, 1, [...classes].join(' | '));
	});

	test('Acceptance 6: a post with no excerpt has a card with its cover, date and title only', () => {
		const noExcerpt = card(htmlOf('/tags/print'), 'no-excerpt');
		assert.ok(noExcerpt, 'the post is listed');
		assert.match(noExcerpt.html, /^\s*<img /);
		assert.match(noExcerpt.html, /<time[^>]*datetime="2026-08-01"/);
		assert.match(noExcerpt.html, /<b class="post-title[^>]*>No excerpt here<\/b>\s*$/, 'the title is the last thing in the card');
		assert.doesNotMatch(noExcerpt.html, /<span class="fg-muted/, 'no excerpt line');
	});

	test('Acceptance 10: a tag with no posts says "No posts yet." and is still built, with its title and description', () => {
		assert.ok(exists('/tags/workshop'));
		const html = htmlOf('/tags/workshop');
		assert.match(html, /<h1[^>]*>Workshop<\/h1>/);
		assert.match(html, /Days we open the studio for people to make things\./);
		assert.match(html, /No posts yet\./);
		assert.equal(cardsOf(html).length, 0);
		assert.ok(htmlOf('/tags/print').indexOf('No posts yet.') === -1, 'a tag with posts does not say it');
	});

	test('Acceptance 13: a deleted tag does not fail the build; it has no page and drops off its posts, which keep their other tags', () => {
		assert.equal(exists('/tags/web'), false);
		assert.ok(exists('/tags/print'), 'the build went on to the other tags');
		const post = htmlOf('/journal/no-cover');
		assert.doesNotMatch(post, /href="\/tags\/web"/);
		assert.match(post, /<a class="link"[^>]*href="\/tags\/print"/);
		// Every other post that named "web" still builds, with no link to it.
		const named = readdirSync(join(built.root, 'content/journal'))
			.filter((f) => (JSON.parse(readFileSync(join(built.root, 'content/journal', f), 'utf8')).tags ?? []).includes('web'))
			.map((f) => f.slice(0, -5));
		assert.ok(named.length >= 5, 'the pinned posts that named it');
		for (const slug of named) {
			assert.ok(exists(`/journal/${slug}`), slug);
			assert.doesNotMatch(htmlOf(`/journal/${slug}`), /\/tags\/web/, slug);
		}
		// Its cards on the journal are still there.
		assert.ok(cardsOf(htmlOf('/journal')).length > 0);
		assert.doesNotMatch(htmlOf('/journal'), /\/tags\/web/);
	});

	test('Acceptance 8: a Posts block with a Tag pages over that tag\'s posts only, and the page count follows', () => {
		const tagged = (f: string) => (JSON.parse(readFileSync(join(built.root, 'content/journal', f), 'utf8')).tags ?? []).includes('field');
		const field = readdirSync(join(built.root, 'content/journal')).filter(tagged).length;
		assert.equal(field, 11);
		const first = htmlOf('/field-posts');
		assert.equal(cardsOf(first).length, 10);
		assert.match(first, /Page 1 of 2/);
		assert.match(first, /rel="next" href="\/field-posts\/page\/2"/);
		const second = htmlOf('/field-posts/page/2');
		assert.equal(cardsOf(second).length, 1);
		assert.match(second, /Page 2 of 2/);
		assert.doesNotMatch(second, /rel="next"/);
		assert.equal(exists('/field-posts/page/3'), false);
		// Only Field's posts, whichever page: the other tags' are not there.
		const all = [...cardsOf(first), ...cardsOf(second)].map((c) => c.slug);
		assert.equal(new Set(all).size, 11);
		for (const slug of all) assert.ok(tagged(`${slug}.json`), slug);
	});

	test('Acceptance 9: ten matching posts with paging on: no pager and no /page/2', () => {
		assert.equal(pinnedTags.includes('print'), true);
		const html = htmlOf('/print-notes');
		assert.equal(cardsOf(html).length, 10);
		assert.doesNotMatch(html, /class="pager/);
		assert.equal(exists('/print-notes/page/2'), false);
		// The journal itself is paged: 30 posts, three pages.
		assert.ok(exists('/journal/page/3'));
		assert.equal(exists('/journal/page/4'), false);
	});

	test('Acceptance 18: the sitemap holds /journal and every tag page, and no paged address', () => {
		const xml = readFileSync(join(built.client, 'sitemap.xml'), 'utf8');
		const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
		assert.ok(locs.includes(`${SITE_URL}/journal`));
		for (const slug of [...pinnedTags.filter((t) => t !== 'web'), 'workshop']) assert.ok(locs.includes(`${SITE_URL}/tags/${slug}`), slug);
		assert.ok(!locs.includes(`${SITE_URL}/tags/web`), 'the deleted tag is not listed');
		assert.equal(locs.filter((l) => /\/page\/\d/.test(l!)).length, 0);
		// The paged pages exist, and each has its own canonical link.
		assert.match(htmlOf('/journal/page/2'), new RegExp(`<link rel="canonical" href="${SITE_URL}/journal/page/2"`));
	});
});
