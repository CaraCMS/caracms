// The site config's validation (Decisions 3, 9, 11).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CaracmsConfigError, DEFAULT_PHONE_LINES_WIDTH, lockup, resolveSite, select, text } from '../src/config.ts';
import { config, site, siteRoot, variant } from './helpers/site.ts';

describe('resolveSite', () => {
	test('resolves paths against the root and normalises URL bases', () => {
		assert.equal(site.root, siteRoot);
		assert.equal(site.collections.journal!.urlBase, '/journal/');
		assert.equal(site.collections.pages!.dir, `${siteRoot}/content/pages`);
		assert.equal(site.blocks.hero!.component, `${siteRoot}/Block.astro`);
		assert.equal(site.textStyles.display!.name, 'display');
		assert.ok(site.textStyles.display!.resolvedFontFile.measure.endsWith('/fixtures/fonts/BricolageGrotesque.ttf'));
		assert.equal(site.phoneLinesWidth, DEFAULT_PHONE_LINES_WIDTH);
		assert.equal(DEFAULT_PHONE_LINES_WIDTH, 640);
	});

	test('the heading field: a lockup by default, a text field only when marked', () => {
		assert.equal(site.blocks.hero!.headingField, 'heading');
		assert.equal(site.blocks.text!.headingField, 'heading');
		const s = resolveSite(variant({ blocks: { plain: { component: 'Block.astro', fields: { body: text() } } } }), siteRoot);
		assert.equal(s.blocks.plain!.headingField, null);
	});

	test('the resolved site is plain JSON (the virtual module is JSON.stringify of it)', () => {
		assert.deepEqual(JSON.parse(JSON.stringify(site)), site);
	});

	for (const width of [375, 300, 769, 1024, Number.NaN]) {
		test(`refuses phoneLinesWidth ${width}: above 375 and at most 768 (Decision 11)`, () => {
			assert.throws(() => resolveSite(variant({ phoneLinesWidth: width }), siteRoot), (e: Error) => e instanceof CaracmsConfigError && /above 375 and at most 768/.test(e.message));
		});
	}

	for (const width of [376, 600, 640, 768]) {
		test(`accepts phoneLinesWidth ${width}`, () => {
			assert.equal(resolveSite(variant({ phoneLinesWidth: width }), siteRoot).phoneLinesWidth, width);
		});
	}

	test('M5a Decision 7: a list-of-fields collection is accepted (M6c G1: with or without a urlBase); nested and a field named title are refused', () => {
		const cases = { kind: 'fields', folder: 'content/case-studies', urlBase: '/work', component: 'Block.astro', fields: { client: text() } } as const;
		const s = resolveSite(variant({ collections: { ...config.collections, 'case-studies': cases } as never }), siteRoot);
		assert.equal(s.collections['case-studies']!.kind, 'fields');
		assert.equal(s.collections['case-studies']!.urlBase, '/work/');
		assert.equal(s.collections['case-studies']!.fields!.client!.label, 'Client');
		assert.throws(() => resolveSite(variant({ collections: { x: { ...cases, nested: true } as never } }), siteRoot), /flat/);
		// M6c (G1): a fields collection may have no urlBase (no pages of its own); a section builder may not.
		assert.equal(resolveSite(variant({ collections: { ...config.collections, x: { ...cases, urlBase: undefined } as never } }), siteRoot).collections.x!.urlBase, null);
		assert.throws(() => resolveSite(variant({ collections: { x: { kind: 'sections', folder: 'content/x' } as never } }), siteRoot), /section builder needs a urlBase/);
		assert.throws(() => resolveSite(variant({ collections: { x: { ...cases, fields: { title: text() } } } }), siteRoot), /"title" is every document's own field/);
	});

	test('M5a Decision 8: the package reserves "shared" and "settings", and adds them after the site\'s', () => {
		assert.deepEqual(Object.keys(site.collections), ['pages', 'journal', 'shared', 'settings']);
		assert.equal(site.collections.shared!.dir, `${siteRoot}/content/shared`);
		assert.equal(site.collections.shared!.urlBase, null);
		assert.equal(site.collections.settings!.kind, 'settings');
		for (const name of ['shared', 'settings']) {
			assert.throws(() => resolveSite(variant({ collections: { [name]: { kind: 'sections', folder: 'content/x', urlBase: '/x/' } } }), siteRoot), /package's own collections/);
		}
		assert.throws(() => resolveSite(variant({ sharedFolder: 'content/pages' }), siteRoot), /share the folder/);
		// Review fix 4: Site Settings is the one file content/site-settings.json; no collection may own that folder.
		assert.throws(() => resolveSite(variant({ collections: { x: { kind: 'sections', folder: 'content', urlBase: '/x/' } } }), siteRoot), /collection "x": its folder "content" is where Site Settings lives/);
		assert.throws(() => resolveSite(variant({ collections: { ...config.collections, x: { kind: 'sections', folder: 'content/', urlBase: '/x/' } } as never }), siteRoot), /where Site Settings lives/);
		assert.throws(() => resolveSite(variant({ sharedFolder: 'content' }), siteRoot), /sharedFolder "content" is where Site Settings lives/);
	});

	test('refuses an unknown text style, a reserved field name, a missing component, a bad accent', () => {
		assert.throws(() => resolveSite(variant({ blocks: { x: { component: 'Block.astro', fields: { h: lockup({ style: 'nope' }) } } } }), siteRoot), /text style "nope"/);
		assert.throws(() => resolveSite(variant({ blocks: { x: { component: 'Block.astro', fields: { type: text() } } } }), siteRoot), /"type" is reserved/);
		assert.throws(() => resolveSite(variant({ blocks: { x: { component: 'Missing.astro', fields: {} } } }), siteRoot), /doesn't exist/);
		// M5a Decision 10: the name and accent are Site Settings' now.
		assert.throws(() => resolveSite(variant({ brand: { name: 'X' } as never }), siteRoot), /brand\.name has moved to Site Settings/);
		assert.throws(() => resolveSite(variant({ brand: { accent: '#123456' } as never }), siteRoot), /brand\.accent has moved to Site Settings/);
		// M5b Decision 11: so are the logo and the icon, pointing at Site Settings.
		assert.throws(() => resolveSite(variant({ brand: { logo: '/logo.svg' } }), siteRoot), /brand\.logo has moved to Site Settings \(content\/site-settings\.json → "brand": \{ "logo", "icon" \}, uploaded in the editor's Site Settings\)/);
		assert.throws(() => resolveSite(variant({ brand: { icon: '/icon.svg' } }), siteRoot), /brand\.icon has moved to Site Settings/);
		assert.deepEqual(resolveSite(variant({ brand: {} }), siteRoot).brand, {});
	});
});

describe('field helpers', () => {
	test('select: string options get title-cased labels; the default is the first option unless given', () => {
		const s = select({ options: ['light', 'dark'] });
		assert.deepEqual(s.options, [
			{ value: 'light', label: 'Light' },
			{ value: 'dark', label: 'Dark' },
		]);
		assert.equal(s.default, 'light');
		assert.equal(select({ options: ['a', 'b'], default: 'b' }).default, 'b');
		assert.throws(() => select({ options: ['a'], default: 'z' as 'a' }), /isn't one of its options/);
	});
});
