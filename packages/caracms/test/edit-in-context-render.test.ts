// Edit in context, the render side on the package's fixture
// (helpers/site-render.ts), through Astro's container:
// - The footer slot (Decision 16's fixture move): drawn from Shared by `<Slot name="footer">`, marked as
//   its shared block in a preview (`data-cms-source`, never `data-cms-block`), with its top-level text
//   typed on the page (Acceptance 8) and its email marked without its value (Decision 10).
// - The page's pick, its fallbacks, a body entry naming the slot block, and a slot block's own preview
//   (Decisions 2, 3 and 9; Acceptance 4a, 5).
// - Source contexts: a card marked as its case study (`cms.of`), its cover as that case study's field.
// - The page's own context (Decisions 10a and 10b, Acceptance 18a and 18b): a journal post's page fields
//   under `data-cms-page`, a valueless marker with `data-cms-field` only; a fields document marks nothing.
// - The public render has no `data-cms-*` and no read record (Acceptance 22).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { count, pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const demo = pinnedSite('edit-in-context');
let r: Renderer;
let site: any;
let parseAnyDocument: (raw: unknown, site: unknown, collection: unknown) => any;

before(async () => {
	// A second footer, a header-slot block and a page that picks the second footer, in the copy only.
	const footer = JSON.parse(readFileSync(`${demo.root}/content/shared/footer.json`, 'utf8'));
	delete footer.default;
	writeFileSync(`${demo.root}/content/shared/footer-dark.json`, JSON.stringify({ ...footer, title: 'Footer dark', block: { ...footer.block, address: 'The dark one' } }, null, 2));
	r = await startRenderer(demo.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseAnyDocument } = await r.load('caracms/document'));
});
after(async () => {
	await r.close();
	demo.close();
});

const read = (collection: string, path: string) => parseAnyDocument(JSON.parse(readFileSync(`${demo.root}/content/${collection === 'shared' ? 'shared' : collection}/${path}.json`, 'utf8')), site, site.collections[collection]);
const render = (document: unknown, collection: string, preview: boolean, previewPath?: string) =>
	r.page('caracms/components/RenderDocument.astro', { document, collection, preview, ...(previewPath ? { previewPath } : {}) });
const home = () => read('pages', 'index');
const footerOf = (html: string) => /<footer[^>]*footer-block[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';

describe('the footer slot (Decision 16, the fixture\'s move)', () => {
	test('every page draws the default footer outside <main>, with no entry in its blocks', async () => {
		const doc = home();
		assert.ok(!doc.blocks.some((b: any) => b.shared !== undefined), 'Home has no shared entry');
		for (const [collection, path] of [['pages', 'index'], ['pages', 'visit'], ['journal', 'notes-from-the-ridge'], ['case-studies', 'high-street-coffee']] as const) {
			const html = await render(read(collection, path), collection, false);
			assert.equal(count(html, /class="band bg-dark footer-block/g), 1, `${collection}/${path}`);
			assert.ok(html.indexOf('</main>') < html.indexOf('footer-block'), 'after the body');
			assert.match(footerOf(html), /Unit 4, The Old Mill<br>Cork/);
		}
	});

	test('in a preview: its root is its source; its address is typed on the page; its email is marked without its value', async () => {
		const footer = footerOf(await render(home(), 'pages', true, 'index'));
		assert.match(footer, /^<footer[^>]*data-cms-source="shared\/footer"/);
		assert.doesNotMatch(footer, /data-cms-block|data-cms-document|data-cms-shared/);
		assert.match(footer, /<p class="footer-address"[^>]*data-cms-field="address" data-cms-kind="text" contenteditable="plaintext-only" data-cms-source="shared\/footer"/);
		const email = /<a[^>]*class="footer-email"[^>]*>/.exec(footer)?.[0] ?? '';
		assert.match(email, /data-cms-field="email"/);
		assert.match(email, /data-cms-source="shared\/footer"/);
		assert.doesNotMatch(email, /data-cms-kind|contenteditable/);
		// A list row's link is picked in the sidebar: marked, never contenteditable.
		assert.match(footer, /data-cms-field="links\.0\.label" data-cms-kind="link" data-cms-source="shared\/footer"/);
	});

	test('the page\'s pick draws its footer; a stale pick gets the default, with the comment in a preview only', async () => {
		const picked = await render({ ...home(), frame: { footer: 'footer-dark' } }, 'pages', true, 'index');
		assert.match(footerOf(picked), /data-cms-source="shared\/footer-dark"/);
		assert.match(footerOf(picked), /The dark one/);
		assert.doesNotMatch(picked, /cms-slot/);
		const stale = await render({ ...home(), frame: { footer: 'gone' } }, 'pages', true, 'index');
		assert.match(footerOf(stale), /data-cms-source="shared\/footer"/);
		assert.match(stale, /<!--cms-slot footer problem=missing pick=gone-->/);
		const other = await render({ ...home(), frame: { footer: 'gone' } }, 'pages', false);
		assert.match(footerOf(other), /Unit 4, The Old Mill/);
		assert.doesNotMatch(other, /cms-slot/);
	});

	test('a body entry naming the slot block is skipped, kept as a comment that says its slot; the footer is drawn once', async () => {
		const doc = parseAnyDocument({ title: 'Home', blocks: [{ type: 'text', heading: 'Hi', body: 'x', background: 'light' }, { shared: 'footer' }] }, site, site.collections.pages);
		const html = await render(doc, 'pages', true, 'index');
		assert.equal(count(html, /footer-block/g), 1);
		assert.match(html, /<!--cms-skipped 1 type=footer shared=footer slot=footer-->/);
		assert.equal(count(await render(doc, 'pages', false), /footer-block/g), 1);
	});

	test('the footer\'s own preview: in its slot under the header, an empty <main>, no "add the first block" area', async () => {
		const html = await render(read('shared', 'footer'), 'shared', true, 'footer');
		assert.match(html, /<header class="site-header">/);
		assert.match(html, /<main[^>]*>\s*<\/main>/);
		assert.doesNotMatch(html, /data-cms-empty|data-cms-block/);
		assert.match(footerOf(html), /data-cms-source="shared\/footer"/);
		// As the editor holds it, not as stored.
		const edited = read('shared', 'footer');
		edited.block.data.address = 'Edited in the sidebar';
		assert.match(footerOf(await render(edited, 'shared', true, 'footer')), /Edited in the sidebar/);
	});
});

describe('source contexts and the valueless marker on a block (Decisions 10, 10b)', () => {
	test('each card is marked as its case study, its cover as that case study\'s field', async () => {
		const html = await render(home(), 'pages', true, 'index');
		const cards = [...html.matchAll(/<li[^>]*data-cms-source="(case-studies\/[^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(cards, ['case-studies/tiny-publisher', 'case-studies/high-street-coffee', 'case-studies/sourdough-bakery']);
		for (const m of html.matchAll(/data-cms-kind="media"[^>]*/g)) if (/cases-cover/.test(m[0])) assert.match(m[0], /data-cms-source="case-studies\//);
	});

	test('the cases heading is the block\'s heading without its value: data-cms-field only, its span kept', async () => {
		const html = await render(home(), 'pages', true, 'index');
		const heading = /<h2[^>]*class="cases-heading"[^>]*>([\s\S]*?)<\/h2>/.exec(html);
		assert.ok(heading, 'drawn');
		assert.match(heading[0], /data-cms-field="heading"/);
		assert.doesNotMatch(heading[0], /data-cms-kind|contenteditable|data-cms-source|data-cms-page/);
		assert.match(heading[1]!, /^<span[^>]*>Selected work<\/span>$/);
	});
});

describe('the page\'s own context (Decisions 10a and 10b)', () => {
	test('a journal post\'s page fields are marked under data-cms-page, never a block\'s or a document\'s markers', async () => {
		const html = await render(read('journal', 'notes-from-the-ridge'), 'journal', true, 'notes-from-the-ridge');
		const head = /<div class="band post-head"[^>]*>[\s\S]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? '';
		assert.match(head, /^<div class="band post-head"[^>]*data-cms-page/);
		assert.doesNotMatch(head, /data-cms-block|data-cms-document|data-cms-source/);
		assert.match(head, /<p class="post-kicker"[^>]*data-cms-field="kicker" data-cms-kind="text" contenteditable="plaintext-only" data-cms-page[^>]*>Field notes<\/p>/);
		// No photo yet: the slot's placeholder, marked.
		assert.match(head, /data-cms-placeholder=""[^>]*data-cms-field="photo" data-cms-kind="media" data-cms-page/);
		const credit = /<p class="post-credit"[^>]*>/.exec(head)?.[0] ?? '';
		assert.match(credit, /data-cms-field="credit" data-cms-page/);
		assert.doesNotMatch(credit, /data-cms-kind|contenteditable/);
		assert.match(head, /Photo: <span>Aoife<\/span>/);
		assert.equal(count(html, /data-cms-document=/g), 0);
	});

	test('a fields document\'s page component context marks nothing (its own context is its component\'s)', async () => {
		const html = await render(read('case-studies', 'high-street-coffee'), 'case-studies', true, 'high-street-coffee');
		assert.equal(count(html, /data-cms-page/g), 0);
		assert.equal(count(html, /data-cms-document="case-studies"/g), 1);
	});
});

describe('the public render (Acceptance 22)', () => {
	test('no data-cms-* attribute and no read record on any kind of page', async () => {
		for (const [collection, path] of [['pages', 'index'], ['pages', 'work'], ['journal', 'notes-from-the-ridge'], ['case-studies', 'high-street-coffee']] as const) {
			const html = await render(read(collection, path), collection, false);
			assert.doesNotMatch(html, /data-cms-|cms-reads|cms-slot|cms-skipped/, `${collection}/${path}`);
		}
	});
	test('a journal post\'s page fields are drawn on the public page too', async () => {
		const html = await render(read('journal', 'notes-from-the-ridge'), 'journal', false);
		assert.match(html, /<p class="post-kicker"[^>]*>Field notes<\/p>/);
		assert.match(html, /<p class="post-credit"[^>]*>\s*Photo: <span>Aoife<\/span>/);
	});
});
