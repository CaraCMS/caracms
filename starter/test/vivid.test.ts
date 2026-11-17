// Vivid (the config's `vivid`, packages/caracms/src/vivid.ts): with the switch on, the public page's
// fields carry `data-vivid-field` (`<document>#<path in its file>`) and `data-vivid-edit` (the
// document's absolute address in /admin), through Astro's container on the pinned content:
// - a section builder's block fields (`pages/index#blocks.0.intro`), a button's words, a list row;
// - a shared body entry's fields (`shared/start-a-project#block.…`), the footer slot's, and Site
//   Settings' (`settings#contact.phone`, a `<Block field>` too);
// - a fields document's fields (`case-studies/high-street-coffee#…`), a journal post's page field
//   (`journal/<slug>#date`), a case study card's summary through `cms.of`;
// - none in a preview, and with the switch off the public page is the same, byte for byte, as with
//   it on less these attributes.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pinnedSite, startRenderer, type Renderer } from './helpers/render.ts';

const on = pinnedSite('vivid-on');
const off = pinnedSite('vivid-off');
let rOn: Renderer;
let rOff: Renderer;

before(async () => {
	const config = join(on.root, 'caracms.config.ts');
	writeFileSync(config, readFileSync(config, 'utf8').replace('export default defineSite({', 'export default defineSite({\n\tvivid: true,'));
	[rOn, rOff] = await Promise.all([startRenderer(on.root), startRenderer(off.root)]);
});
after(async () => {
	await Promise.all([rOn.close(), rOff.close()]);
	on.close();
	off.close();
});

const url = (address: string) => `http://localhost${address}`;
async function render(r: Renderer, collection: string, path: string, address: string, preview = false): Promise<string> {
	const { site } = await r.load('virtual:caracms/config');
	const { readDocument } = await r.load('caracms/content');
	const { document } = await readDocument(site, collection, path);
	return r.page('caracms/components/RenderDocument.astro', { document, collection, preview, ...(preview ? { previewPath: path } : {}) }, url(address));
}
const pairs = (html: string) => [...html.matchAll(/data-vivid-field="([^"]*)" data-vivid-edit="([^"]*)"/g)].map((m) => [m[1], m[2]] as const);
const fields = (html: string) => pairs(html).map(([field]) => field);
const editOf = (html: string, field: string) => pairs(html).find(([f]) => f === field)?.[1];

describe('vivid: true, public pages', () => {
	test('a section builder: its block fields at blocks.<index>, editing at its /admin address (Home at /admin)', async () => {
		const html = await render(rOn, 'pages', 'index', '/');
		const found = fields(html);
		assert.ok(found.includes('pages/index#blocks.0.heading'), found.join('\n'));
		assert.ok(found.includes('pages/index#blocks.0.intro'));
		assert.equal(editOf(html, 'pages/index#blocks.0.intro'), 'http://localhost/admin');
		const about = await render(rOn, 'pages', 'about', '/about');
		assert.ok(fields(about).some((f) => /^pages\/about#blocks\.\d+\./.test(f)), fields(about).join('\n'));
		assert.equal(editOf(about, fields(about).find((f) => f.startsWith('pages/about#'))!), 'http://localhost/admin/pages/about');
	});

	test('a shared body entry is its shared block\'s; the slots and Site Settings are theirs', async () => {
		const html = await render(rOn, 'pages', 'about', '/about');
		const found = fields(html);
		const shared = found.filter((f) => f.startsWith('shared/start-a-project#block.'));
		assert.ok(shared.length > 0, found.join('\n'));
		assert.equal(editOf(html, shared[0]!), 'http://localhost/admin/shared/start-a-project');
		assert.ok(found.some((f) => f.startsWith('shared/footer#block.')), 'the footer slot');
		assert.ok(found.includes('settings#contact.phone'), 'a Site Settings <Text>');
		assert.ok(found.includes('settings#contact.email'), 'a Site Settings <Block field>');
		assert.equal(editOf(html, 'settings#contact.phone'), 'http://localhost/admin/settings');
	});

	test('a fields document, a journal post\'s page field, and a card read through cms.of', async () => {
		const study = await render(rOn, 'case-studies', 'high-street-coffee', '/work/high-street-coffee');
		const own = fields(study).filter((f) => f.startsWith('case-studies/high-street-coffee#'));
		assert.ok(own.length > 0, fields(study).join('\n'));
		assert.ok(own.every((f) => !f.includes('#blocks.')), 'top-level fields');
		assert.equal(editOf(study, own[0]!), 'http://localhost/admin/case-studies/high-street-coffee');
		const post = await render(rOn, 'journal', 'a-day-on-the-ferry', '/journal/a-day-on-the-ferry');
		assert.ok(fields(post).includes('journal/a-day-on-the-ferry#date'), fields(post).join('\n'));
		const work = await render(rOn, 'pages', 'work', '/work');
		assert.ok(fields(work).some((f) => /^case-studies\/[a-z-]+#summary$/.test(f)), fields(work).join('\n'));
	});

	test('every value is under 200 characters and every edit address absolute', async () => {
		for (const [c, p, a] of [['pages', 'index', '/'], ['pages', 'contact', '/contact'], ['journal', 'a-day-on-the-ferry', '/journal/a-day-on-the-ferry']] as const) {
			const html = await render(rOn, c, p, a);
			assert.equal(count(html, /data-vivid-field=/g), count(html, /data-vivid-edit="http:\/\/localhost\/admin/g), `${c}/${p}: each field has its edit address`);
			for (const [field] of pairs(html)) assert.ok(field.length <= 200, field);
		}
	});

	test('a preview carries none', async () => {
		const html = await render(rOn, 'pages', 'about', '/about', true);
		assert.doesNotMatch(html, /data-vivid/);
		assert.match(html, /data-cms-field/);
	});
});

describe('vivid off (the default)', () => {
	test('the public page is the same as with it on, less the data-vivid attributes', async () => {
		for (const [c, p, a] of [['pages', 'index', '/'], ['pages', 'about', '/about'], ['case-studies', 'high-street-coffee', '/work/high-street-coffee'], ['journal', 'a-day-on-the-ferry', '/journal/a-day-on-the-ferry']] as const) {
			const plain = await render(rOff, c, p, a);
			assert.doesNotMatch(plain, /data-vivid/);
			const tagged = await render(rOn, c, p, a);
			// The two copies' folders differ in a dev script's src, and nothing else may.
			const stripped = tagged.replace(/ data-vivid-(field|edit)="[^"]*"/g, '').replaceAll(on.root, off.root);
			const at = [...stripped].findIndex((ch, i) => ch !== plain[i]);
			assert.ok(stripped === plain, `${c}/${p} differs at ${at}:\n${stripped.slice(at - 300, at + 200)}\n---\n${plain.slice(at - 300, at + 200)}`);
		}
	});
});

function count(html: string, pattern: RegExp): number {
	return (html.match(pattern) ?? []).length;
}
