// M7 Decision 2: moved from starter/test. It checks a package feature through a site, so it runs on the
// package's fixture site (test/fixtures/demo-site, the pre-M7 demo) and pinned content (helpers/site-render.ts).
// The demo's page rendered from documents, through the package's components
// (Phase 1 → Verify 3's render half and Verify 4; Decisions 16 and 17).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { count, pinnedSite, root, startRenderer, type Renderer } from './helpers/site-render.ts';

// The demo's documents as pinned (helpers/render.ts), not the live demo's.
const demo = pinnedSite('render');
let r: Renderer;
let site: any;
let parseDocumentText: (text: string, site: unknown) => { document: any };
let measureLockup: (lines: string[], style: unknown) => { longest: number };
before(async () => {
	r = await startRenderer(demo.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseDocumentText } = await r.load('caracms/document'));
	({ measureLockup } = await r.load('caracms/measure'));
});
after(async () => {
	await r.close();
	demo.close();
});

const render = (document: unknown, preview = false) =>
	r.page('caracms/components/RenderDocument.astro', { document, collection: 'pages', preview });
const doc = (blocks: unknown[]) => parseDocumentText(JSON.stringify({ title: 'Test', blocks }), site).document;

const hero = (heading: unknown, extra: Record<string, unknown> = {}) => ({ type: 'hero', heading, intro: 'Intro', ...extra });
const text = (heading: string, body = 'Body') => ({ type: 'text', heading, body });
const h1s = (html: string) => count(html, /<h1[\s>]/g);

// The round-trip fixture lives with the serializer's tests, in the package (it uses the demo's block types).
// Its unknown block is a "gallery", which the demo has had since M5b: it's renamed here so it stays unknown.
const fixture = readFileSync(`${root}/test/fixtures/round-trip.json`, 'utf8').replace('"type": "gallery"', '"type": "carousel"');

describe('the round-trip fixture renders without its unknowns (Verify 3)', () => {
	test('the unknown block and the unknown field are skipped; the known blocks render in order', async () => {
		const html = await render(parseDocumentText(fixture, site).document);
		assert.doesNotMatch(html, /carousel|harbour\.jpg|flourish/);
		assert.match(html, /<title>Round trip · CaraCMS<\/title>/);
		assert.equal(count(html, /<section /g), 3);
		assert.ok(html.indexOf('Play Hard') < html.indexOf('Second block'));
		assert.ok(html.indexOf('Second block') < html.indexOf('Building a better mousetrap'));
		// The trailing space is trimmed in the render (it's kept in the file).
		assert.match(html, /Keys out of order, and a trailing space\.<\/p>/);
	});
});

describe('the page\'s h1 (Decision 16, Verify 4)', () => {
	test('a heading inside a group is the h1 when its block comes first; of two groups\' headings only the first is', async () => {
		const column = (heading: string) => ({ heading, text: '', button: [] });
		const html = await render(doc([{ type: 'columns', left: column('Left first'), right: column('Right after') }, text('Later')]));
		assert.equal(h1s(html), 1);
		assert.match(html, /<h1[^>]*class="column-heading"[^>]*>Left first<\/h1>/);
		assert.match(html, /<h2[^>]*class="column-heading"[^>]*>Right after<\/h2>/);
		assert.match(html, /<h2 class="text-heading"[^>]*>Later<\/h2>/);
		// The left column's heading empty: the block has no h1, and the next block's heading takes it.
		const passed = await render(doc([{ type: 'columns', left: column(''), right: column('Right') }, text('Later')]));
		assert.equal(h1s(passed), 1);
		assert.match(passed, /<h1 class="text-heading"[^>]*>Later<\/h1>/);
	});

	test('a page whose first block is an unknown type still has exactly one h1', async () => {
		const html = await render(doc([{ type: 'carousel', images: [] }, hero(['First', 'Heading']), hero(['Second'])]));
		assert.equal(h1s(html), 1);
		assert.match(html, /<h1[^>]*class="cms-lockup"[^>]*>.*First.*<\/h1>/s);
	});

	test('a page whose first heading is a lockup with phone lines has exactly one h1, holding both line sets', async () => {
		const html = await render(doc([hero({ lines: ['A small studio', 'with big ideas'], phone: ['A small', 'studio with', 'big ideas'] }), text('Next')]));
		assert.equal(h1s(html), 1);
		const h1 = /<h1[\s\S]*?<\/h1>/.exec(html)![0];
		assert.equal(count(h1, /class="cms-lockup-set /g), 2);
		assert.match(h1, /cms-lockup-main/);
		assert.match(h1, /cms-lockup-phone/);
		assert.equal(count(html, /<h2[\s>]/g), 1);
	});

	test('a block with an empty heading passes the h1 on to the next block with one', async () => {
		const html = await render(doc([hero([' ', '']), text(''), text('The real first heading')]));
		assert.equal(h1s(html), 1);
		assert.match(html, /<h1 class="text-heading"[^>]*>The real first heading<\/h1>/);
	});

	test('a page with no heading at all has no h1', async () => {
		assert.equal(h1s(await render(doc([text('', 'Only a body')]))), 0);
	});

	test('concurrent renders don\'t leak into each other (no module state)', async () => {
		const a = doc([{ type: 'carousel' }, text('A first')]);
		const b = doc([text('B first'), text('B second')]);
		const results = await Promise.all(Array.from({ length: 20 }, (_, i) => render(i % 2 ? a : b, i % 3 === 0)));
		results.forEach((html, i) => {
			assert.equal(h1s(html), 1, `render ${i}`);
			assert.match(html, i % 2 ? /<h1[^>]*>A first<\/h1>/ : /<h1[^>]*>B first<\/h1>/);
			assert.equal(count(html, /data-cms-/g) > 0, i % 3 === 0, `render ${i}: markers only in preview`);
		});
	});
});

describe('markers only in preview renders (Decision 17)', () => {
	const fixtureDoc = () => parseDocumentText(fixture, site).document;

	test('the public render has no data-cms-*, no contenteditable, no script', async () => {
		const html = await render(fixtureDoc());
		assert.equal(count(html, /data-cms-/g), 0);
		assert.equal(count(html, /contenteditable/g), 0);
		assert.equal(count(html, /<script/g), 0);
	});

	test('a preview render marks each block with its index in the document and its type', async () => {
		const html = await render(fixtureDoc(), true);
		// The unknown block (index 0) doesn't render; the others keep their document indexes.
		assert.deepEqual(
			[...html.matchAll(/<section [^>]*data-cms-block="(\d+)" data-cms-type="(\w+)"/g)].map((m) => [m[1], m[2]]),
			[
				['1', 'hero'],
				['2', 'text'],
				['3', 'cta'],
			],
		);
	});

	test('plain text fields are contenteditable and keyed; lockups are marked but never editable', async () => {
		const html = await render(fixtureDoc(), true);
		assert.match(html, /<p class="hero-intro"[^>]*data-cms-field="intro" data-cms-kind="text" contenteditable="plaintext-only"/);
		assert.match(html, /<h2 class="text-heading"[^>]*data-cms-field="heading" data-cms-kind="text" contenteditable="plaintext-only"/);
		assert.match(html, /<span[^>]*data-cms-field="button" data-cms-kind="text" contenteditable="plaintext-only"/);
		const lockups = [...html.matchAll(/<h[12][^>]*data-cms-kind="lockup"[^>]*>/g)].map((m) => m[0]);
		assert.equal(lockups.length, 2);
		for (const tag of lockups) {
			assert.match(tag, /data-cms-field="heading"/);
			assert.match(tag, /data-cms-min-size="28"/);
			assert.match(tag, /data-cms-size="96"/);
			assert.doesNotMatch(tag, /contenteditable/);
		}
	});

	test('each lockup line set is marked main or phone, with its own longest line', async () => {
		const html = await render(fixtureDoc(), true);
		const cta = /<section[^>]*data-cms-block="3"[\s\S]*?<\/section>/.exec(html)![0];
		const sets = [...cta.matchAll(/data-cms-lines="(main|phone)" data-cms-longest="([\d.]+)"/g)].map((m) => [m[1], Number(m[2])]);
		const style = site.textStyles.display;
		assert.deepEqual(sets, [
			['main', Number(measureLockup(['Building a better mousetrap', 'For You'], style).longest.toFixed(4))],
			['phone', Number(measureLockup(['Building a', 'better mousetrap', 'For You'], style).longest.toFixed(4))],
		]);
	});

	test('an empty text field still renders in a preview (so it can be typed into), and not in public', async () => {
		const d = doc([hero(['Hi'], { intro: '' })]);
		assert.match(await render(d, true), /<p class="hero-intro"[^>]*data-cms-field="intro"[^>]*><\/p>/);
		assert.doesNotMatch(await render(d), /hero-intro/);
	});

	test('uncovered characters are reported on the line set (Decision 15)', async () => {
		const html = await render(doc([hero(['Hello ✨', 'There'])]), true);
		assert.match(html, /data-cms-lines="main" data-cms-longest="[\d.]+" data-cms-uncovered="\[&quot;✨&quot;\]"/);
		assert.doesNotMatch(await render(doc([hero(['Hello', 'There'])]), true), /data-cms-uncovered/);
	});
});

describe('the lockup', () => {
	test('one heading, a span per line with a real space between, blank lines dropped', async () => {
		const html = await render(doc([hero(['', ' Play Hard ', '  ', 'Work Hard'])]));
		const h1 = /<h1[\s\S]*?<\/h1>/.exec(html)![0];
		assert.deepEqual([...h1.matchAll(/<span class="cms-lockup-line"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]), ['Play Hard', 'Work Hard']);
		assert.equal(count(h1, /<\/span> <span class="cms-lockup-line"/g), 1);
	});

	test('the style drives the CSS variables; the fit width is rounded up', async () => {
		const html = await render(doc([hero(['Building a better mousetrap'])]));
		const style = site.textStyles.display;
		const exact = measureLockup(['Building a better mousetrap'], style).longest;
		assert.match(html, /--cms-size: 96px; --cms-tracking: 0\.04em/);
		assert.match(html, /--cms-variation: &quot;wght&quot; 700, &quot;wdth&quot; 100, &quot;opsz&quot; 96/);
		const v = Number(/--longest-line: ([\d.]+)/.exec(html)![1]);
		assert.ok(v >= exact && v - exact < 1.0001e-4);
	});

	test('an empty lockup renders nothing', async () => {
		const html = await render(doc([hero(['', ' '])]));
		assert.doesNotMatch(html, /cms-lockup/);
	});
});

describe('M5a: the other kinds of document, and what a render reads (Decisions 7, 8, 9, 16)', () => {
	let parseAnyDocument: (raw: unknown, site: unknown, collection: unknown) => any;
	before(async () => {
		({ parseAnyDocument } = await r.load('caracms/document'));
	});
	const caseStudy = () => parseAnyDocument(JSON.parse(readFileSync(`${demo.root}/content/case-studies/high-street-coffee.json`, 'utf8')), site, site.collections['case-studies']);
	const renderAs = (document: unknown, collection: string, preview = false) => r.page('caracms/components/RenderDocument.astro', { document, collection, preview });

	test('a case study renders through its collection\'s component in the page frame; its heading is the h1', async () => {
		const html = await renderAs(caseStudy(), 'case-studies');
		assert.match(html, /<title>High-street coffee roaster · CaraCMS<\/title>/);
		assert.equal(h1s(html), 1);
		assert.match(/<h1[\s\S]*?<\/h1>/.exec(html)![0], /High-street<\/span> <span class="cms-lockup-line">Coffee/);
		assert.match(html, /<h2 id="from-the-harbour-wall-outward">From the harbour wall<br>outward<\/h2>/);
		assert.equal(count(html, /data-cms-/g), 0);
	});

	test('in a preview, its markers sit under a document-level marker, in place of data-cms-block; list items carry their paths', async () => {
		const html = await renderAs(caseStudy(), 'case-studies', true);
		assert.match(html, /<article class="case"[^>]*data-cms-document="case-studies"/);
		assert.doesNotMatch(html, /data-cms-block/);
		assert.match(html, /data-cms-field="credits\.1\.name"/);
		assert.match(html, /data-cms-field="body" data-cms-kind="richText"/);
		assert.match(html, /data-cms-field="client" data-cms-kind="text" contenteditable="plaintext-only"/);
		assert.doesNotMatch(html, /data-cms-field="credits\.1\.name"[^>]*contenteditable/);
	});

	test('a shared entry renders the shared block as it stands in the source; in a preview its root is the page\'s block, its fields the shared block\'s', async () => {
		// A body block in Shared (the fixture's footer fills the footer slot since edit in context, Decision 16).
		writeFileSync(`${demo.root}/content/shared/note.json`, JSON.stringify({ title: 'Note', block: { type: 'text', heading: 'A shared note', body: 'Kept in one place.', background: 'dark' } }));
		const page = doc([hero(['Hi']), { shared: 'note' }]);
		const pub = await render(page);
		assert.match(pub, /A shared note/);
		const preview = await render(page, true);
		assert.match(preview, /<section [^>]*data-cms-block="1" data-cms-type="text" data-cms-shared="note"/);
		const note = /<section [^>]*data-cms-shared="note"[\s\S]*?<\/section>/.exec(preview)![0];
		// The root is the page's block, never the shared block's source (a click on it selects the block).
		assert.doesNotMatch(/<section [^>]*>/.exec(note)![0], /data-cms-source/);
		// Its fields carry the shared block's source, so a click on them opens it over the page.
		assert.match(note, /data-cms-field="heading"[^>]*data-cms-source="shared\/note"|data-cms-source="shared\/note"[^>]*data-cms-field="heading"/);
		assert.match(note, /data-cms-field="body"[^>]*data-cms-source="shared\/note"|data-cms-source="shared\/note"[^>]*data-cms-field="body"/);
		// Public: no editor markers at all.
		assert.doesNotMatch(pub, /data-cms-/);
	});

	test('an entry naming a missing shared block is skipped: nothing public, a comment in a preview (no element)', async () => {
		const page = doc([hero(['Hi']), { shared: 'nowhere' }, text('After')]);
		const pub = await render(page);
		assert.doesNotMatch(pub, /nowhere/);
		assert.match(pub, /After/);
		const preview = await render(page, true);
		assert.match(preview, /<!--cms-skipped 1 type= shared=nowhere-->/);
		assert.doesNotMatch(preview, /data-cms-skipped|data-cms-block="1"/);
	});

	test('a shared block\'s own preview: the block alone in the page frame, as its only block (Decision 16\'s h1 rule)', async () => {
		const shared = parseAnyDocument({ title: 'Footer', block: { type: 'cta', heading: ['Got Something', 'Half-Built?'], text: 'x', button: 'Go' } }, site, site.collections.shared);
		const html = await renderAs(shared, 'shared', true);
		assert.equal(count(html, /data-cms-block="0"/g), 1);
		assert.equal(h1s(html), 1);
		// The page's frame is its document (fonts, styles), not its header and colophon: the block alone, centred (the mockup's #shared-doc).
		assert.doesNotMatch(html, /class="site-header"|class="site-footer"/);
		assert.match(html, /<main class="solo"/);
	});

	test('the case-study list reads its collection: Featured, newest first, up to its count (3 when it has none)', async () => {
		const html = await render(doc([hero(['Hi']), { type: 'cases', heading: 'Work', show: 'featured' }]));
		assert.deepEqual([...html.matchAll(/<a href="(\/work\/[^"]+)"[^>]*><span class="cases-sector"/g)].map((m) => m[1]), ['/work/tiny-publisher', '/work/high-street-coffee', '/work/sourdough-bakery']);
	});
});
