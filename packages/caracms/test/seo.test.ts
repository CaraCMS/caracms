// M6 Decisions 13, 14 and 16 (Acceptance 32–34): the `seo` key per key, Site Settings' new keys, the Google tag's rule.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSite, text } from '../src/config.ts';
import { normaliseAnyDocument, parseAnyDocument, parseDocument, type FieldsDocument, type SettingsDocument, type SiteDocument } from '../src/document.ts';
import { missingAltIn } from '../src/editor/server/media/alt.ts';
import { googleTagIn, googleTagKind, parseFormRecipients, parseSeo } from '../src/seo.ts';
import { applyDocumentEdits, applyEdits, applyKeyedEdits, removeTopLevel } from '../src/serialize.ts';
import { config, site, siteRoot, variant } from './helpers/site.ts';

const page = `{
  "title": "Contact",
  "blocks": [
    { "type": "text", "heading": "Say hello", "body": "We read everything.", "background": "light" }
  ]
}
`;
const read = (text: string) => parseDocument(JSON.parse(text), site);

describe("a page's seo (Acceptance 32)", () => {
	test('a file with no seo key is untouched by opening and saving, with or without seo in the edit', () => {
		assert.equal(applyEdits(page, read(page), site), page);
		assert.equal(applyEdits(page, { ...read(page), seo: {} }, site), page);
		assert.equal(applyEdits(page, { ...read(page), seo: { title: '  ' } }, site), page, 'blank parts are left out');
	});

	test('setting the SEO title writes seo.title only; every other key keeps its text and position', () => {
		const out = applyEdits(page, { ...read(page), seo: { title: 'Contact CaraCMS' } }, site);
		assert.equal(out, page.replace('\n  ]\n}\n', '\n  ],\n  "seo": {\n    "title": "Contact CaraCMS"\n  }\n}\n'));
		const again = applyEdits(out, { ...read(out), seo: { title: 'Contact CaraCMS', description: 'Write to the studio.' } }, site);
		assert.ok(again.startsWith(page.slice(0, page.indexOf('\n  ]') + 4)), 'title and blocks untouched');
		assert.match(again, /"seo": \{\n    "title": "Contact CaraCMS",\n    "description": "Write to the studio\."\n  \}/);
	});

	test('clearing the last part removes seo, leaving the file as it was', () => {
		const withSeo = applyEdits(page, { ...read(page), seo: { title: 'X' } }, site);
		assert.equal(applyEdits(withSeo, { ...read(withSeo), seo: { title: '' } }, site), page);
	});

	test('a share image: key, size and focal point, on one line, no alt', () => {
		const out = applyEdits(page, { ...read(page), seo: { image: { key: 'uploads/1fb083002e3a/share.jpg', w: 2400, h: 1260, focal: [0.4, 0.3], alt: 'ignored' } as never } }, site);
		assert.match(out, /"image": \{ "key": "uploads\/1fb083002e3a\/share\.jpg", "w": 2400, "h": 1260, "focal": \[0\.4, 0\.3\] \}/);
		assert.deepEqual(read(out).seo, { image: { key: 'uploads/1fb083002e3a/share.jpg', w: 2400, h: 1260, focal: [0.4, 0.3] } });
	});

	test("the editor's document carries seo through normalise (the preview and the write route)", () => {
		const n = normaliseAnyDocument({ ...read(page), seo: { title: ' T ' } }, site, site.collections.pages!) as SiteDocument;
		assert.deepEqual(n.seo, { title: 'T' });
		assert.equal((normaliseAnyDocument(read(page), site, site.collections.pages!) as SiteDocument).seo, undefined);
		assert.equal(read(page).seo, undefined, 'absent from the file, absent from the document');
	});

	test('a new page with seo set writes it after blocks', () => {
		const out = applyEdits(null, { title: 'New', blocks: [], seo: { description: 'D' } }, site);
		assert.equal(out, '{\n  "title": "New",\n  "blocks": [],\n  "seo": {\n    "description": "D"\n  }\n}\n');
	});
});

describe("a fields document's seo", () => {
	const s = resolveSite(variant({ collections: { ...config.collections, work: { kind: 'fields', folder: 'content/work', urlBase: '/work/', component: 'Block.astro', fields: { client: text(), summary: text({ multiline: true }) } } } }), siteRoot);
	const work = s.collections.work!;
	const file = '{\n  "title": "High-street coffee roaster",\n  "client": "Harbour",\n  "summary": "A rebrand."\n}\n';
	test('set after the fields, cleared away, and untouched when absent', () => {
		const doc = parseAnyDocument(JSON.parse(file), s, work) as FieldsDocument;
		assert.equal(applyKeyedEdits(file, doc, work), file);
		const out = applyDocumentEdits(file, { ...doc, seo: { title: 'High-street coffee roaster rebrand' } }, s, work);
		assert.equal(out, '{\n  "title": "High-street coffee roaster",\n  "client": "Harbour",\n  "summary": "A rebrand.",\n  "seo": {\n    "title": "High-street coffee roaster rebrand"\n  }\n}\n');
		assert.deepEqual((parseAnyDocument(JSON.parse(out), s, work) as FieldsDocument).seo, { title: 'High-street coffee roaster rebrand' });
		const back = applyDocumentEdits(out, { ...doc, seo: {} }, s, work);
		assert.equal(back, file);
	});
});

describe("Site Settings' seo, googleTag and formRecipients (Decision 14)", () => {
	const settings = site.collections.settings!;
	const file = '{\n  "title": "Site Settings",\n  "editors": ["niamh@example.com"],\n  "brand": {\n    "name": "CaraCMS",\n    "accent": "#8a3b2a"\n  }\n}\n';
	const doc = () => parseAnyDocument(JSON.parse(file), site, settings) as SettingsDocument;

	test('absent from the edit: untouched; set: written after brand, each per key', () => {
		assert.equal(applyKeyedEdits(file, doc(), settings), file);
		const d = doc();
		const out = applyKeyedEdits(file, { ...d, data: { ...d.data, googleTag: ' G-TEST000001 ', formRecipients: { contact: [' walker@example.com ', 'WALKER@example.com', 'not an address', ''] }, seo: { title: 'CaraCMS', description: 'A small design studio.' } } }, settings);
		assert.equal(
			out,
			'{\n  "title": "Site Settings",\n  "editors": ["niamh@example.com"],\n  "brand": {\n    "name": "CaraCMS",\n    "accent": "#8a3b2a"\n  },\n  "seo": {\n    "title": "CaraCMS",\n    "description": "A small design studio."\n  },\n  "googleTag": "G-TEST000001",\n  "formRecipients": {\n    "contact": ["walker@example.com", "not an address"]\n  }\n}\n',
		);
		const parsed = parseAnyDocument(JSON.parse(out), site, settings) as SettingsDocument;
		assert.deepEqual(parsed.data.formRecipients, { contact: ['walker@example.com', 'not an address'] }, 'stored trimmed, a duplicate dropped, an invalid one kept as typed');
		assert.equal(parsed.data.googleTag, 'G-TEST000001');
		// Cleared: each key goes.
		const cleared = applyKeyedEdits(out, { ...parsed, data: { ...parsed.data, googleTag: '', formRecipients: { contact: [] }, seo: {} } }, settings);
		assert.equal(cleared, file);
	});

	test('an edit that leaves them out keeps what the file has', () => {
		const withAll = '{\n  "title": "Site Settings",\n  "googleTag": "G-TEST000001",\n  "formRecipients": { "contact": ["a@b.test"] }\n}\n';
		const parsed = parseAnyDocument(JSON.parse(withAll), site, settings) as SettingsDocument;
		const { googleTag: _g, formRecipients: _f, ...rest } = parsed.data;
		const n = normaliseAnyDocument({ ...parsed, data: { ...rest, editors: ['x@y.test'] } }, site, settings) as SettingsDocument;
		assert.equal(n.data.googleTag, undefined);
		const out = applyKeyedEdits(withAll, n, settings);
		assert.ok(out.includes('"googleTag": "G-TEST000001"') && out.includes('"formRecipients": { "contact": ["a@b.test"] }'));
	});

	test('parseFormRecipients drops forms with none and entries that are not text', () => {
		assert.deepEqual(parseFormRecipients({ contact: ['a@b.test', 3, null], quote: [], bad: 'x' }), { contact: ['a@b.test'] });
	});
});

describe('the share image and Publish (Acceptance 33)', () => {
	test("a share image with no alt is never in Publish's missing-alt summary", () => {
		const text = applyEdits(page, { ...read(page), seo: { image: { key: 'uploads/1fb083002e3a/share.jpg', w: 1, h: 1 } } }, site);
		assert.deepEqual(missingAltIn(site, 'pages', text), []);
		const settingsText = JSON.stringify({ title: 'Site Settings', seo: { image: { key: 'uploads/1fb083002e3a/share.jpg' } } });
		assert.deepEqual(missingAltIn(site, 'settings', settingsText), []);
	});
});

describe('the Google tag is an ID, never a script (Acceptance 34)', () => {
	test('GTM- and G- IDs load their snippets; anything else nothing', () => {
		assert.equal(googleTagKind('GTM-ABC1234'), 'gtm');
		assert.equal(googleTagKind('G-ABCDE12345'), 'gtag');
		assert.equal(googleTagKind('G-TEST000001'), 'gtag');
		for (const bad of ['<script>alert(1)</script>', 'G-', 'UA-123', 'g-abcde12345', 'G-ABC"><script>', ' G-ABCDE12345', '']) assert.equal(googleTagKind(bad), null, bad);
		assert.equal(googleTagIn(`<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABCDE12345"></script>`), 'G-ABCDE12345');
		assert.equal(googleTagIn('nothing here'), null);
	});
});

describe('removeTopLevel', () => {
	test('the first, a middle, the last and the only member', () => {
		const t = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
		assert.equal(removeTopLevel(t, 'a'), '{\n  "b": 2,\n  "c": 3\n}\n');
		assert.equal(removeTopLevel(t, 'b'), '{\n  "a": 1,\n  "c": 3\n}\n');
		assert.equal(removeTopLevel(t, 'c'), '{\n  "a": 1,\n  "b": 2\n}\n');
		assert.equal(removeTopLevel('{ "a": 1 }\n', 'a'), '{}\n');
		assert.equal(removeTopLevel(t, 'x'), t);
	});
	test('parseSeo: trimmed, blank parts out', () => {
		assert.deepEqual(parseSeo({ title: ' A ', description: '', image: { video: 'x' } }), { title: 'A' });
	});
});
