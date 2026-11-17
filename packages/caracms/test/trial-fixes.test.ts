// M8 Exit step 11: the cold trial's package fixes (the M8 trial's findings),
// the ones a unit test can hold.
//
// - Item 1: `siteSettings` from `caracms/content` gives a site's own routes Site Settings as the
//   page component gets `Astro.props.settings`: rich text parsed, media resolved, links as
//   render values, brand and seo.
// - Item 2: a fragment-only link (`#`, `#some-id`) is a usable href, so an address-only link
//   keeps it in the render instead of turning it into null.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { link, media, resolveSite, richText, type SiteConfig } from '../src/config.ts';
import { diskSource, siteSettings } from '../src/content.ts';
import { renderValue, usableHref } from '../src/fields.ts';
import { settingsRenderData } from '../src/read.ts';

describe('siteSettings: Site Settings for a code route (trial item 1)', () => {
	let root: string;
	let site: ReturnType<typeof resolveSite>;
	before(() => {
		root = mkdtempSync(join(tmpdir(), 'caracms-site-settings-'));
		mkdirSync(join(root, 'content'), { recursive: true });
		writeFileSync(join(root, 'Block.astro'), '---\n---\n');
		writeFileSync(
			join(root, 'content/site-settings.json'),
			JSON.stringify({
				title: 'Site Settings',
				editors: ['aoife@example.com'],
				brand: { name: 'CaraCMS' },
				tagline: [{ p: ['A small ', { b: 'design' }, ' studio.'] }],
				badge: { key: 'uploads/1fb083002e3a/mark.svg', w: 32, h: 32, alt: 'CaraCMS' },
				social: { href: '#' },
				contact: { label: 'Say hello', href: '/contact' },
			}),
		);
		site = resolveSite(
			{
				collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } },
				blocks: { text: { component: 'Block.astro', fields: {} } },
				page: 'Block.astro',
				textStyles: {},
				settings: { fields: { tagline: richText(), badge: media({ only: 'image' }), social: link({ addressOnly: true }), contact: link() } },
			} as SiteConfig,
			root,
		);
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	test("it's the page component's settings, read from the disk", async () => {
		const settings = await siteSettings(site);
		assert.deepEqual(settings, await settingsRenderData(site, diskSource));
		assert.deepEqual(Object.keys(settings).sort(), ['badge', 'brand', 'contact', 'seo', 'social', 'tagline']);
		assert.equal((settings.brand as { name: string }).name, 'CaraCMS');
		assert.ok(!('editors' in settings));
	});

	test("seo.titleSeparator is the config's, so a code route's title matches the head's (round 2, item 3)", async () => {
		assert.equal(((await siteSettings(site)).seo as { titleSeparator: string }).titleSeparator, ' · ', 'the default');
		const piped = { ...site, titleSeparator: ' | ' };
		assert.equal(((await siteSettings(piped)).seo as { titleSeparator: string }).titleSeparator, ' | ');
	});

	test('rich text and media come out as the page component gets them', async () => {
		const settings = await siteSettings(site, {});
		assert.ok(Array.isArray(settings.tagline), 'rich text is the parsed value');
		assert.deepEqual(settings.badge, { kind: 'image', key: 'uploads/1fb083002e3a/mark.svg', alt: 'CaraCMS', decorative: false, focal: null, position: null, w: 32, h: 32 });
		assert.deepEqual(settings.social, { href: '#' }, 'a fragment-only address link keeps its href (item 2)');
		assert.deepEqual(settings.contact, { label: 'Say hello', href: '/contact' });
	});

	test("an editor's preview source in locals wins over the disk", async () => {
		const locals = {};
		const { setRenderSource } = await import('../src/read.ts');
		setRenderSource(locals, { readText: async (file) => (file.endsWith('site-settings.json') ? JSON.stringify({ brand: { name: 'Draft' } }) : null), listJson: async () => [] });
		assert.equal(((await siteSettings(site, locals)).brand as { name: string }).name, 'Draft');
	});
});

describe('fragment links render (trial item 2)', () => {
	test('`#` and `#some-id` are usable hrefs, in a link and an address-only link', () => {
		for (const href of ['#', '#some-id', '#1abc']) {
			assert.equal(usableHref(href), href);
			assert.deepEqual(renderValue(link({ addressOnly: true }), { href }), { href });
		}
		// What still can't render is null (and validate warns for it: validate.test.ts).
		assert.equal(renderValue(link({ addressOnly: true }), { href: 'javascript:alert(1)' }), null);
	});
});
