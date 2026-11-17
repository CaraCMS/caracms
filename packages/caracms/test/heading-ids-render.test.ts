// Heading ids (Acceptance 8): through the fixture site's real text block
// (Astro's container, helpers/site-render.ts), the rendered h2/h3 ids are unique across the page's
// blocks and are exactly what pageHeadings gives the page component, in a public and a preview render.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const copy = pinnedSite('heading-ids-render');

let r: Renderer;
let site: any;
let parseDocumentText: (text: string, site: unknown) => { document: any };
let pageHeadings: (site: unknown, document: unknown, options?: unknown) => Promise<{ depth: number; slug: string; text: string }[]>;
before(async () => {
	r = await startRenderer(copy.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseDocumentText } = await r.load('caracms/document'));
	({ pageHeadings } = await r.load('caracms/content'));
});
after(async () => {
	await r?.close();
	copy.close();
});

const text = (body: unknown) => ({ type: 'text', heading: '', body });
const blocks = [
	text([{ h2: 'Getting started' }, { p: 'One.' }, { h3: 'Getting **started**' }, { h2: 'FAQ' }]),
	text([{ p: 'Between.' }]),
	text([{ h2: 'FAQ' }, { h3: 'What [links](/x) do?' }, { h2: 'Getting started' }]),
];
const docOf = () => parseDocumentText(JSON.stringify({ title: 'Test', blocks }), site).document;
// The rich-text fields' headings only (the text block's own heading field is an h2 too, with no id).
const bodies = (html: string) => [...html.matchAll(/<div class="text-body"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]).join('');
const rendered = (page: string) => [...bodies(page).matchAll(/<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/g)].map((m) => ({ depth: Number(m[1]), id: /\sid="([^"]*)"/.exec(m[2]!)?.[1] ?? null }));

describe('heading ids in the render', () => {
	for (const preview of [false, true]) {
		test(`${preview ? 'preview' : 'public'} render: unique across blocks, and the same as pageHeadings`, async () => {
			const document = docOf();
			const html = await r.page('caracms/components/RenderDocument.astro', { document, collection: 'pages', preview });
			const headings = await pageHeadings(site, document, { collection: 'pages' });
			assert.deepEqual(headings, [
				{ depth: 2, slug: 'getting-started', text: 'Getting started' },
				{ depth: 3, slug: 'getting-started-1', text: 'Getting started' },
				{ depth: 2, slug: 'faq', text: 'FAQ' },
				{ depth: 2, slug: 'faq-1', text: 'FAQ' },
				{ depth: 3, slug: 'what-links-do', text: 'What links do?' },
				{ depth: 2, slug: 'getting-started-2', text: 'Getting started' },
			]);
			assert.deepEqual(rendered(html), headings.map((h) => ({ depth: h.depth, id: h.slug })));
		});
	}
});
