// Edit in context, the parts checked without a renderer:
// - `frame` (a page's picks) and `default` (a slot block's) ride on the document as `hidden` does:
//   set adds, cleared removes, absent leaves; a new file writes them; the saved form keeps them
//   (Contracts → Slots, Acceptance 24).
// - The config: a block's `slot`, `frame` refused as a page field and a fields collection's field,
//   a collection's `blocks` naming a slot type refused (Decision 2, Acceptance 4a, Decision 17).
// - The slot rules (slots.ts): the pick, else the default; each fallback warns (Decision 2).
// - `caracms validate`: a stale pick, a slot without a default, two defaults, a slot block in a
//   body, and the shapes of `frame` and `default` (Acceptance 4a, 5).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CaracmsConfigError, link, list, resolveSite, text, type SiteConfig } from '../src/config.ts';
import { normaliseAnyDocument, parseAnyDocument, type SharedDocument, type SiteDocument } from '../src/document.ts';
import { applyDocumentEdits, savedForm } from '../src/serialize.ts';
import { resolveSlot, slotDefault, type SlotCandidate } from '../src/slots.ts';
import { makeCliSite, type CliSite } from './helpers/cli-site.ts';
import { config, siteRoot, variant } from './helpers/site.ts';

const footer = { component: 'Block.astro', slot: 'footer' as const, fields: { note: text(), links: list(link()) } };
const header = { component: 'Block.astro', slot: 'header' as const, fields: { menu: list(link()) } };
const slotted = resolveSite(variant({ blocks: { ...(config as SiteConfig).blocks, footer, header } }), siteRoot);
const pages = slotted.collections.pages!;
const shared = slotted.collections.shared!;
const cases = resolveSite(
	variant({ collections: { ...(config as SiteConfig).collections, cases: { kind: 'fields', folder: 'content/cases', urlBase: '/cases', component: 'Block.astro', fields: { client: text() } } } as never }),
	siteRoot,
);
const casesCollection = cases.collections.cases!;

const page = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ title: 'About', ...extra, blocks: [] }, null, 2)}\n`;
const readPage = (text: string) => parseAnyDocument(JSON.parse(text), slotted, pages) as SiteDocument;
const write = (base: string | null, doc: unknown, collection = pages, site = slotted) => applyDocumentEdits(base, doc as never, site, collection);

describe('a page\'s frame rides as hidden does (Contracts → Slots)', () => {
	const base = page();
	test('a pick is written after the title; another pick replaces it; clearing every pick takes the key out', () => {
		const picked = write(base, { ...readPage(base), frame: { footer: 'footer-dark' } });
		assert.equal(picked, '{\n  "title": "About",\n  "frame": {\n    "footer": "footer-dark"\n  },\n  "blocks": []\n}\n');
		assert.deepEqual(readPage(picked).frame, { footer: 'footer-dark' });
		const both = write(picked, { ...readPage(picked), frame: { header: 'header-b', footer: 'footer-dark' } });
		assert.deepEqual(readPage(both).frame, { header: 'header-b', footer: 'footer-dark' });
		assert.equal(write(both, { ...readPage(both), frame: {} }), base);
	});
	test('an edit without the key leaves the file\'s; the same picks leave the file byte for byte', () => {
		const picked = write(base, { ...readPage(base), frame: { footer: 'footer-dark' } });
		const { frame: _f, ...without } = readPage(picked);
		assert.equal(write(picked, without), picked);
		assert.equal(write(picked, { ...readPage(picked), frame: { footer: 'footer-dark' } }), picked);
		assert.equal(write(base, { ...readPage(base), frame: {} }), base, 'clearing nothing changes nothing');
	});
	test('it sits after hidden; a new page is written with it; an empty one reads as absent', () => {
		const hidden = page({ hidden: true });
		assert.equal(write(hidden, { ...readPage(hidden), frame: { header: 'h' } }), '{\n  "title": "About",\n  "hidden": true,\n  "frame": {\n    "header": "h"\n  },\n  "blocks": []\n}\n');
		assert.equal(write(null, { title: 'New', blocks: [], frame: { footer: 'f' } }), '{\n  "title": "New",\n  "frame": {\n    "footer": "f"\n  },\n  "blocks": []\n}\n');
		assert.equal(readPage(page({ frame: {} })).frame, undefined);
		assert.equal(readPage(page({ frame: { footer: '' } })).frame, undefined);
	});
	test('the editor\'s copy: null and {} clear, absent leaves (normaliseAnyDocument)', () => {
		assert.deepEqual((normaliseAnyDocument({ title: 'x', blocks: [], frame: null }, slotted, pages) as SiteDocument).frame, {});
		assert.equal((normaliseAnyDocument({ title: 'x', blocks: [] }, slotted, pages) as SiteDocument).frame, undefined);
		assert.deepEqual((normaliseAnyDocument({ title: 'x', blocks: [], frame: { footer: 'a', side: 'b' } }, slotted, pages) as SiteDocument).frame, { footer: 'a' });
	});
	test('a fields document\'s too: after its title, taken out when cleared', () => {
		const base = '{\n  "title": "Harbour",\n  "client": "High-street coffee roaster"\n}\n';
		const read = (t: string) => parseAnyDocument(JSON.parse(t), cases, casesCollection) as { kind: 'fields'; title: string; data: Record<string, unknown>; frame?: unknown };
		const picked = write(base, { ...read(base), frame: { footer: 'f' } }, casesCollection, cases);
		assert.equal(picked, '{\n  "title": "Harbour",\n  "frame": {\n    "footer": "f"\n  },\n  "client": "High-street coffee roaster"\n}\n');
		assert.deepEqual(read(picked).frame, { footer: 'f' });
		assert.equal(write(picked, { ...read(picked), frame: {} }, casesCollection, cases), base);
		const { frame: _f, ...without } = read(picked);
		assert.equal(write(picked, without, casesCollection, cases), picked);
	});
	test('the saved form keeps it as written', () => {
		const picked = write(base, { ...readPage(base), frame: { footer: 'footer-dark' } });
		assert.equal(savedForm(picked, pages, slotted), picked);
	});
});

describe('a slot block\'s default rides as hidden does', () => {
	const base = '{\n  "title": "Footer",\n  "block": {\n    "type": "footer",\n    "note": "Hi",\n    "links": []\n  }\n}\n';
	const read = (t: string) => parseAnyDocument(JSON.parse(t), slotted, shared) as SharedDocument;
	test('true adds it beside the block; false takes it out; absent leaves it', () => {
		const made = write(base, { ...read(base), default: true }, shared);
		assert.equal(made, '{\n  "title": "Footer",\n  "default": true,\n  "block": {\n    "type": "footer",\n    "note": "Hi",\n    "links": []\n  }\n}\n');
		assert.equal(read(made).default, true);
		assert.equal(read(base).default, undefined);
		const { default: _d, ...without } = read(made);
		assert.equal(write(made, without, shared), made);
		assert.equal(write(made, { ...read(made), default: true }, shared), made);
		assert.equal(write(made, { ...read(made), default: false }, shared), base);
		assert.equal(write(base, { ...read(base), default: false }, shared), base);
	});
	test('a new one is written with it; the editor\'s copy keeps true and false; the saved form keeps it', () => {
		const made = write(null, { kind: 'shared', title: 'Footer', default: true, block: { source: null, type: 'footer', known: true, data: { note: '', links: [] } } }, shared);
		assert.match(made, /^\{\n {2}"title": "Footer",\n {2}"default": true,\n {2}"block": \{/);
		assert.equal((normaliseAnyDocument({ title: 'F', default: false, block: { type: 'footer', data: {} } }, slotted, shared) as SharedDocument).default, false);
		assert.equal((normaliseAnyDocument({ title: 'F', block: { type: 'footer', data: {} } }, slotted, shared) as SharedDocument).default, undefined);
		assert.equal(savedForm(made, shared, slotted), made);
	});
});

describe('the config (Decisions 2 and 17)', () => {
	const fails = (patch: Partial<SiteConfig>, pattern: RegExp) => assert.throws(() => resolveSite(variant(patch), siteRoot), (e: Error) => e instanceof CaracmsConfigError && pattern.test(e.message));
	test('a block\'s slot is resolved; anything but header or footer is refused', () => {
		assert.equal(slotted.blocks.footer!.slot, 'footer');
		assert.equal(slotted.blocks.header!.slot, 'header');
		assert.equal(slotted.blocks.hero!.slot, undefined);
		fails({ blocks: { banner: { ...footer, slot: 'banner' as never } } }, /block "banner": slot must be one of 'header' or 'footer'/);
	});
	test('frame is refused as a page field and as a fields collection\'s field', () => {
		fails({ collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', fields: { frame: text() } } } as never }, /collection "pages": "frame" is every page's own \(its pick of its header and footer\)/);
		fails({ collections: { cases: { kind: 'fields', folder: 'content/cases', urlBase: '/cases', component: 'Block.astro', fields: { frame: text() } } } as never }, /collection "cases": "frame" is every page's own pick/);
	});
	test('a collection\'s blocks naming a slot type is refused', () => {
		fails(
			{ blocks: { ...(config as SiteConfig).blocks, footer }, collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', blocks: ['hero', 'footer'] } } as never },
			/collection "pages": blocks names "footer", which is the page's footer \(slot: 'footer'\), so it isn't a block of the body/,
		);
	});
});

describe('the slot rules (slots.ts)', () => {
	const c = (path: string, slot: 'header' | 'footer' | undefined, extra: Partial<SlotCandidate> = {}): SlotCandidate => ({ path, title: path, type: slot ?? 'cta', slot, known: true, default: false, ...extra });
	const all = [c('footer', 'footer', { default: true }), c('footer-dark', 'footer'), c('header', 'header', { default: true }), c('cta', undefined), c('odd', undefined, { known: false, type: 'gone' })];
	test('the pick, else the default', () => {
		assert.deepEqual(resolveSlot('footer', 'footer-dark', all), { path: 'footer-dark', picked: true, warnings: [] });
		assert.deepEqual(resolveSlot('footer', undefined, all), { path: 'footer', picked: false, warnings: [] });
		assert.deepEqual(resolveSlot('footer', 'footer', all), { path: 'footer', picked: true, warnings: [] }, 'a pick of the default is kept as picked');
	});
	test('a missing pick, one of an unknown type, one of the other slot or of the body: the default, with a warning naming it', () => {
		for (const [pick, problem, words] of [
			['gone', 'missing', /picks the footer "gone", which isn't a shared block, so it gets the default footer/],
			['odd', 'unknown-type', /picks the footer "odd", a block type the code doesn't know \("gone"\)/],
			['header', 'not-this-slot', /picks the footer "header", which is a header/],
			['cta', 'not-this-slot', /picks the footer "cta", which isn't a footer/],
		] as const) {
			const r = resolveSlot('footer', pick, all);
			assert.equal(r.path, 'footer', pick);
			assert.deepEqual(r.warnings.map((w) => w.problem), [problem], pick);
			assert.match(r.warnings[0]!.message, words);
		}
	});
	test('no default, or an unusable one: nothing, with a warning; two: the first by path, with a warning', () => {
		assert.deepEqual(resolveSlot('footer', undefined, [c('footer-dark', 'footer')]).path, null);
		assert.equal(slotDefault('footer', [c('footer-dark', 'footer')]).warnings[0]!.problem, 'no-default');
		assert.equal(slotDefault('footer', [c('f', undefined, { known: false, type: 'gone', default: true })]).warnings[0]!.problem, 'default-unusable');
		const two = slotDefault('footer', [c('b', 'footer', { default: true }), c('a', 'footer', { default: true })]);
		assert.equal(two.path, 'a');
		assert.equal(two.warnings[0]!.problem, 'two-defaults');
		assert.match(resolveSlot('footer', 'gone', [c('x', 'footer')]).warnings[0]!.message, /and there's no default footer, so it draws none/);
	});
});

describe('caracms validate (Acceptance 4a, 5)', () => {
	let s: CliSite;
	before(() => {
		s = makeCliSite('validate-slots');
		s.write('content/pages/about.json', s.read('content/pages/about.json').replace('"title": "About",', '"title": "About",\n  "frame": {\n    "footer": "footer-gone"\n  },'));
		s.write('content/pages/visit.json', s.read('content/pages/visit.json').replace('"title": "Visit",', '"title": "Visit",\n  "frame": {\n    "footer": 3,\n    "side": "x"\n  },'));
		s.write('content/pages/contact.json', s.read('content/pages/contact.json').replace('"blocks": [', '"blocks": [\n    { "shared": "footer" },'));
	});
	after(() => s.cleanup());
	const report = () => JSON.parse(s.run('validate', '--json').stdout) as { errors: { file: string; path: string; message: string }[]; warnings: { file: string; path: string; message: string }[] };

	test('a stale pick is a warning naming it; a pick of the wrong shape and an unknown slot are errors', () => {
		const r = report();
		assert.ok(r.warnings.some((w) => w.file === 'content/pages/about.json' && w.path === 'frame.footer' && /picks the footer "footer-gone", which isn't a shared block, so it gets the default footer/.test(w.message)), JSON.stringify(r.warnings));
		assert.ok(r.errors.some((e) => e.file === 'content/pages/visit.json' && e.path === 'frame.footer' && /Expected the path of a shared footer/.test(e.message)), JSON.stringify(r.errors));
		assert.ok(r.errors.some((e) => e.file === 'content/pages/visit.json' && e.path === 'frame.side'), JSON.stringify(r.errors));
	});
	test('a body entry naming the slot block: the page\'s warning', () => {
		const r = report();
		assert.ok(r.warnings.some((w) => w.file === 'content/pages/contact.json' && /Footer is the page's footer, so it isn't a block of the body\. Skipped on the page; kept in the file\./.test(w.message)), JSON.stringify(r.warnings));
	});
	test('no default footer: a warning on the shared folder; a second default: a warning on the default; default must be true', () => {
		const original = s.read('content/shared/footer.json');
		s.write('content/shared/footer.json', original.replace('  "default": true,\n', ''));
		assert.ok(report().warnings.some((w) => w.file === 'content/shared' && /There's no default footer/.test(w.message)));
		s.write('content/shared/footer-dark.json', original.replace('"title": "Footer"', '"title": "Footer dark"'));
		s.write('content/shared/footer.json', original);
		assert.ok(report().warnings.some((w) => w.path === 'default' && /"Footer" and "Footer dark" are each the default footer; the first by path \("Footer"\) is used/.test(w.message)), JSON.stringify(report().warnings));
		s.write('content/shared/footer-dark.json', original.replace('"default": true', '"default": "yes"'));
		assert.ok(report().errors.some((e) => e.file === 'content/shared/footer-dark.json' && e.path === 'default' && /Expected true/.test(e.message)));
	});
});
