// Edit in context, Decision 16: the starter's header and footer are shared blocks in the page's
// slots, marked in a preview as their sources (Acceptance 1, 7, 9–11 on the render side; the
// editor's clicks are the package's browser tests). Through Astro's container on the pinned content.
// - Every page, the 404's document included, draws the default header and footer with no entry
//   in its blocks (Acceptance 1).
// - In a preview: the header's and the footer's roots are their shared blocks; a column's heading is
//   the footer's field (picked in the sidebar); the phone and the address are Site Settings' fields
//   typed on the page, the email and a social marked without their values (the email keeps its
//   `<wbr>`); the columns' and the menu's links aren't marked, so they follow (Decision 7).
// - The Cases cards are marked as their case studies.
// - The public render has none of it (Acceptance 22).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { count, pinnedSite, startRenderer, type Renderer } from './helpers/render.ts';

const demo = pinnedSite('slots');
let r: Renderer;
let site: any;
let parseAnyDocument: (raw: unknown, site: unknown, collection: unknown) => any;
before(async () => {
	r = await startRenderer(demo.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseAnyDocument } = await r.load('caracms/document'));
});
after(async () => {
	await r.close();
	demo.close();
});

const read = (collection: string, path: string) => parseAnyDocument(JSON.parse(readFileSync(join(demo.root, 'content', collection, `${path}.json`), 'utf8')), site, site.collections[collection]);
const render = (collection: string, path: string, preview: boolean) =>
	r.page('caracms/components/RenderDocument.astro', { document: read(collection, path), collection, preview, ...(preview ? { previewPath: path } : {}) }, `http://localhost/${path === 'index' ? '' : path}`);
const part = (html: string, tag: 'header' | 'footer') => new RegExp(`<${tag}[^>]*data-site-${tag}[\\s\\S]*?</${tag}>`).exec(html)?.[0] ?? '';

describe('the header and footer slots (Decision 16)', () => {
	test('every page draws the default header and footer, with neither in its blocks', async () => {
		for (const [collection, path] of [['pages', 'index'], ['pages', 'about'], ['journal', 'a-day-on-the-ferry'], ['case-studies', 'high-street-coffee']] as const) {
			const html = await render(collection, path, false);
			assert.equal(count(html, /data-site-header/g), 1, path);
			assert.equal(count(html, /data-site-footer/g), 1, path);
			assert.match(part(html, 'header'), /href="\/journal"[^>]*>Journal<\/a>/);
			assert.match(part(html, 'footer'), /<h2 class="eyebrow fg-muted mb-3">Studio<\/h2>/);
			const doc = read(collection, path);
			if (doc.blocks) assert.ok(!doc.blocks.some((b: { shared?: string }) => b.shared === 'header' || b.shared === 'footer'));
		}
	});

	test('in a preview: the roots are their shared blocks; a column heading is the footer\'s field, picked in the sidebar', async () => {
		const html = await render('pages', 'index', true);
		const header = part(html, 'header');
		const footer = part(html, 'footer');
		assert.match(header, /^<header[^>]*data-site-header[^>]*data-cms-source="shared\/header"|^<header[^>]*data-cms-source="shared\/header"[^>]*data-site-header/);
		assert.match(footer, /^<footer[^>]*data-cms-source="shared\/footer"/);
		assert.doesNotMatch(header + footer, /data-cms-block|data-cms-document/);
		assert.match(footer, /<h2 class="eyebrow fg-muted mb-3" data-cms-field="columns\.0\.heading" data-cms-kind="text" data-cms-source="shared\/footer">Studio<\/h2>/);
		assert.doesNotMatch(footer, /columns\.0\.heading"[^>]*contenteditable/);
		// The links follow: no marks on the menu's or the columns' links.
		assert.doesNotMatch(header, /data-cms-field/);
		assert.match(footer, /<a class="[^"]*" href="\/about\/team">Team<\/a>/);
	});

	test('Site Settings\' fields in the footer: the phone typed, the address, the email and a social marked without their values', async () => {
		const footer = part(await render('pages', 'index', true), 'footer');
		assert.match(footer, /<span data-cms-field="contact\.phone" data-cms-kind="text" contenteditable="plaintext-only" data-cms-source="settings">\+353 21 000 0000<\/span>/);
		// Decision 10b: the address is drawn from a transformed value (trimmed lines), so it is never typed on the page.
		assert.match(footer, /<address data-cms-field="contact\.address" data-cms-source="settings">4 Example Lane<br>Cork<br>Ireland<\/address>/);
		const email = /<a [^>]*data-cms-field="contact\.email"[^>]*>([\s\S]*?)<\/a>/.exec(footer);
		assert.ok(email, 'the email is marked');
		assert.match(email[0], /data-cms-source="settings"/);
		assert.doesNotMatch(email[0], /data-cms-kind|contenteditable/);
		assert.equal(email[1], 'studio<wbr>@example.com', 'its line break before the @ is the site\'s own');
		assert.match(footer, /<a [^>]*data-cms-field="socials\.0\.network" data-cms-source="settings"[^>]*>Instagram<\/a>/);
	});

	test('the Cases cards are marked as their case studies', async () => {
		const html = await render('pages', 'index', true);
		assert.deepEqual([...html.matchAll(/<li[^>]*data-cms-source="(case-studies\/[^"]+)"/g)].map((m) => m[1]), ['case-studies/tiny-publisher', 'case-studies/kitchen-pottery', 'case-studies/local-travel']);
	});

	test('the public render has no marks', async () => {
		for (const [collection, path] of [['pages', 'index'], ['pages', 'contact'], ['case-studies', 'high-street-coffee']] as const) assert.doesNotMatch(await render(collection, path, false), /data-cms-(?!fixed\b)|cms-reads/, path);
	});
});
