// An adoption trial, item 2 (its findings → "Where caracms and its skills fell
// short"): the page component is told its document's address (`PageProps.path`), the same on a
// public render and in the preview, and a block knows whether it's the first the page renders
// (`cms.first`). Through Astro's container on a copy of the fixture site, with a probe page
// component and a probe block.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const demo = pinnedSite('page-path-first');
const root = demo.root;
let r: Renderer;
let site: any;
let parseDocumentText: (text: string, site: unknown) => { document: any };
let parseAnyDocument: (raw: unknown, site: unknown, collection: unknown) => any;

before(async () => {
	writeFileSync(
		join(root, 'src/components/Page.astro'),
		`---
import Blocks from 'caracms/components/Blocks.astro';
import Head from 'caracms/components/Head.astro';
import type { PageProps } from 'caracms/document';
type Props = PageProps;
const { document, collection, path, preview = false, listPage } = Astro.props;
---
<html><head><Head document={document} collection={collection} path={path} preview={preview} listPage={listPage} /></head><body data-path={JSON.stringify(path)}><Blocks document={document} collection={collection} preview={preview} listPage={listPage} /></body></html>
`,
	);
	writeFileSync(join(root, 'src/blocks/Probe.astro'), "---\nconst { block, cms } = Astro.props;\n---\n<div class=\"probe\" data-name={block.title} data-index={cms.index} data-first={String(cms.first)} />\n");
	const config = join(root, 'caracms.config.ts');
	writeFileSync(
		config,
		`import { text as probeText } from 'caracms/config';\n${readFileSync(config, 'utf8').replace('\tblocks: {\n', "\tblocks: {\n\t\tprobe: { component: 'src/blocks/Probe.astro', fields: { title: probeText() } },\n")}`,
	);
	r = await startRenderer(root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseDocumentText, parseAnyDocument } = await r.load('caracms/document'));
});
after(async () => {
	await r.close();
	demo.close();
});

const doc = (blocks: unknown[] = []) => parseDocumentText(JSON.stringify({ title: 'Probe', blocks }), site).document;
const pathOf = (html: string) => JSON.parse(html.match(/data-path="([^"]*)"/)![1]!.replaceAll('&quot;', '"')) as string | null;
const render = (props: Record<string, unknown>, url?: string) => r.page('caracms/components/RenderDocument.astro', { document: doc(), collection: 'pages', ...props }, url);

describe('PageProps.path: the document\'s address, the same in public and in the preview', () => {
	test('a public page: its address, no trailing slash, decoded', async () => {
		assert.equal(pathOf(await render({}, 'http://localhost/about/')), '/about');
		assert.equal(pathOf(await render({}, 'http://localhost/')), '/');
		assert.equal(pathOf(await render({}, 'http://localhost/caf%C3%A9')), '/café');
		assert.equal(pathOf(await render({ collection: 'journal' }, 'http://localhost/journal/first-post')), '/journal/first-post');
	});

	test("a build.format 'file' prerender's address: no .html, and /index.html is Home", async () => {
		assert.equal(pathOf(await render({}, 'http://localhost/about.html')), '/about');
		assert.equal(pathOf(await render({}, 'http://localhost/index.html')), '/');
		// <Head> reads the address too: /index.html is the home page, so it takes Site Settings' title.
		const settings = JSON.parse(readFileSync(join(root, 'content/site-settings.json'), 'utf8'));
		assert.match(await render({}, 'http://localhost/index.html'), new RegExp(`<title>${settings.seo.title}</title>`));
	});

	test('a paged listing\'s page 2 is its document\'s address', async () => {
		assert.equal(pathOf(await render({ listPage: 2 }, 'http://localhost/journal/page/2')), '/journal');
		assert.equal(pathOf(await render({ listPage: 2 }, 'http://localhost/page/2')), '/');
	});

	test('the preview: the same addresses, from the GET\'s ?path= or the route\'s previewPath (a POST has no query)', async () => {
		assert.equal(pathOf(await render({ preview: true }, 'http://localhost/_caracms/preview?collection=pages&path=about')), '/about');
		assert.equal(pathOf(await render({ preview: true }, 'http://localhost/_caracms/preview?collection=pages&path=index')), '/');
		assert.equal(pathOf(await render({ preview: true, previewPath: 'services/branding' }, 'http://localhost/_caracms/preview')), '/services/branding');
		assert.equal(pathOf(await render({ preview: true, collection: 'journal', previewPath: 'first-post' }, 'http://localhost/_caracms/preview')), '/journal/first-post');
	});

	test('null for a document with no page of its own: a shared block\'s preview, a preview naming no document', async () => {
		const shared = parseAnyDocument(JSON.parse(readFileSync(join(root, 'content/shared/footer.json'), 'utf8')), site, site.collections.shared);
		assert.equal(shared.kind, 'shared');
		assert.equal(pathOf(await r.page('caracms/components/RenderDocument.astro', { document: shared, collection: 'shared', preview: true, previewPath: 'footer' }, 'http://localhost/_caracms/preview')), null);
		assert.equal(pathOf(await render({ preview: true }, 'http://localhost/_caracms/preview')), null);
	});

	test('<Head> takes the preview\'s path from it: the home page\'s title in a render with no ?path=', async () => {
		const settings = JSON.parse(readFileSync(join(root, 'content/site-settings.json'), 'utf8'));
		const home = await render({ preview: true, previewPath: 'index' }, 'http://localhost/_caracms/preview');
		assert.match(home, new RegExp(`<title>${settings.seo.title}</title>`));
		assert.doesNotMatch(await render({ preview: true, previewPath: 'about' }, 'http://localhost/_caracms/preview'), new RegExp(`<title>${settings.seo.title}</title>`));
	});
});

describe('cms.first: the first block the page renders', () => {
	const firsts = (html: string) => [...html.matchAll(/class="probe" data-name="([^"]*)" data-index="(\d+)" data-first="(true|false)"/g)].map((m) => `${m[1]}@${m[2]}:${m[3]}`);

	test('the first entry renders: it\'s first, and index 0', async () => {
		const html = await r.page('caracms/components/RenderDocument.astro', { document: doc([{ type: 'probe', title: 'a' }, { type: 'probe', title: 'b' }]), collection: 'pages' });
		assert.deepEqual(firsts(html), ['a@0:true', 'b@1:false']);
	});

	test('an unknown block and a shared block that\'s gone don\'t render, so the first that does is first, not index 0', async () => {
		const blocks = [{ type: 'nope' }, { shared: 'gone' }, { type: 'probe', title: 'a' }, { type: 'probe', title: 'b' }];
		for (const preview of [false, true]) {
			const html = await r.page('caracms/components/RenderDocument.astro', { document: doc(blocks), collection: 'pages', preview });
			assert.deepEqual(firsts(html), ['a@2:true', 'b@3:false'], `preview: ${preview}`);
		}
	});

	test('a shared block that resolves counts where it\'s placed', async () => {
		// Not the footer, which fills the page's footer slot (edit in context, Decision 2): a body block.
		writeFileSync(join(root, 'content/shared/note.json'), JSON.stringify({ title: 'Note', block: { type: 'text', heading: 'A note', body: 'x', background: 'light' } }));
		const html = await r.page('caracms/components/RenderDocument.astro', { document: doc([{ shared: 'note' }, { type: 'probe', title: 'a' }]), collection: 'pages' });
		assert.deepEqual(firsts(html), ['a@1:false']);
	});
});
