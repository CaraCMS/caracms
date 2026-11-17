// M7 Decision 2: moved from starter/test. It checks a package feature through a site, so it runs on the
// package's fixture site (test/fixtures/demo-site, the pre-M7 demo) and pinned content (helpers/site-render.ts).
// The editor-friction batch through the demo's Two columns block (Astro's container, as
// fields-render.test.ts does): item 1, a block's groups reach its component as nested
// props, with markers at the group's paths; item 4, a button with words and no link in a
// field with `allowNoLink` is a plain label with the button's classes. Nothing here opens
// a browser.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const demo = pinnedSite('columns-render');
let r: Renderer;
let site: any;
let parseDocumentText: (text: string, site: unknown) => { document: any };
before(async () => {
	r = await startRenderer(demo.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseDocumentText } = await r.load('caracms/document'));
});
after(async () => {
	await r.close();
	demo.close();
});

const render = (document: unknown, preview = false) => r.page('caracms/components/RenderDocument.astro', { document, collection: 'pages', preview });
const doc = (blocks: unknown[]) => parseDocumentText(JSON.stringify({ title: 'Test', blocks }), site).document;
const columns = (left: Record<string, unknown>, right: Record<string, unknown> = {}) => ({ type: 'columns', left, right, background: 'light' });

describe('item 1: a group reaches the block as nested props', () => {
	test("each column's heading, text and button render from its group", async () => {
		const html = await render(doc([columns({ heading: 'Left side', text: [{ p: 'Words.' }], button: [{ label: 'Go', href: '/contact', style: 'primary' }] }, { heading: 'Right side' })]));
		// The block is first on the page, so the left column's heading is the page's h1 (2026-10-19); the right's stays h2.
		assert.match(html, /<h1[^>]*class="column-heading[^"]*"[^>]*>Left side<\/h1>/);
		assert.match(html, /<h2[^>]*class="column-heading[^"]*"[^>]*>Right side<\/h2>/);
		assert.match(html, /<p>Words\.<\/p>/);
		assert.match(html, /<a href="\/contact" class="column-button column-button--primary"[^>]*>Go<\/a>/);
	});

	test("preview: markers at the group's paths; its text is typed on the page", async () => {
		const html = await render(doc([columns({ heading: 'Left side', text: [{ p: 'Words.' }] })]), true);
		assert.match(html, /data-cms-field="left\.heading" data-cms-kind="text" contenteditable="plaintext-only"/);
		assert.match(html, /data-cms-field="left\.text" data-cms-kind="richText" tabindex="0"/);
		assert.match(html, /data-cms-field="right\.button" data-cms-kind="buttons"/);
	});
});

describe('item 4: allowNoLink draws words with no link as a plain label', () => {
	test('a button with words and no link is a span with the button classes; one with a link is still a link', async () => {
		const html = await render(doc([columns({ button: [{ label: 'Coming soon', href: '', style: 'secondary' }] }, { button: [{ label: 'Go', href: '/contact', style: 'primary' }] })]));
		assert.match(html, /<span class="column-button column-button--secondary"[^>]*>Coming soon<\/span>/);
		assert.doesNotMatch(html, /<a[^>]*>Coming soon/);
		assert.match(html, /<a href="\/contact" class="column-button column-button--primary"[^>]*>Go<\/a>/);
	});

	test('a link with no words, or a link that fails the rule, still shows nothing', async () => {
		const html = await render(doc([columns({ button: [{ label: '', href: '/contact', style: 'primary' }] }, { button: [{ label: 'Bad', href: 'nope', style: 'primary' }] })]));
		assert.doesNotMatch(html, /column-button/);
	});

	test("preview: the plain label carries the button's marker, so a click picks it", async () => {
		const html = await render(doc([columns({ button: [{ label: 'Coming soon', href: '', style: 'secondary' }] })]), true);
		assert.match(html, /<span class="column-button column-button--secondary" data-cms-field="left\.button\.0\.label" data-cms-kind="button">Coming soon<\/span>/);
	});
});
