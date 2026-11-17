// M7's package half: a list inside a list, one level
// (Decisions 14–15), and the page component's Site Settings render data (Decision 13).
//
// 4.  `list({ label, href, links: list(link()) })` stores `[{ label, href, links: [{ label, href }] }]`,
//     keys in schema order, and renders each link as its render value.
// 8.  An inner link to a page that moves is relinked; one failing the link rule is warned.
// 9.  An inner list's image with no alt text is in Publish's summary, at its path and rows.
// 10. An unknown key inside an inner item (or an outer one) is kept on save, after the
//     schema's keys, as a block's are (unmarked: Decisions during build).
// 11. A collapsed outer row leads with its own label, and counts its inner items.
// 12. `settings`: brand, seo and the site's own fields as render data, never editors,
//     formRecipients or googleTag; the site's name falls back to seo.title, then "Site".
// (5, the config's refusals, is in fields.test.ts and group-field.test.ts.)
//
//   node --test --experimental-strip-types test/nested-list.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { link, list, media, resolveSite, text, type BlockData, type SiteConfig } from '../src/config.ts';
import type { ContentSource } from '../src/content.ts';
import { parseAnyDocument } from '../src/document.ts';
import { itemSummary } from '../src/editor/client/fields/list-summary.ts';
import { missingAltIn } from '../src/editor/server/media/alt.ts';
import { fieldAt, fieldAtPath, fieldToJson, fieldWarnings, parseField, renderData, setAtPath, type ListField } from '../src/fields.ts';
import { settingsRenderData } from '../src/read.ts';
import { relinkText } from '../src/relink.ts';
import { fieldText } from '../src/serialize.ts';
import { config, siteRoot, variant } from './helpers/site.ts';

// The contract's menu (Contracts → List inside a list).
const menuFields = {
	menu: list(
		{
			label: text({ label: 'Label' }),
			href: link({ label: 'Address', addressOnly: true }),
			links: list(link({ label: 'Link' }), { label: 'Dropdown links' }),
		},
		{ label: 'Menu', itemLabel: 'label' },
	),
	partners: list({ name: text({ label: 'Name' }), logos: list(media({ only: 'image', label: 'Logo' }), { label: 'Logos' }) }, { label: 'Partners' }),
};
const site = resolveSite(variant({ settings: { fields: menuFields }, blocks: { ...config.blocks, nav: { component: 'Block.astro', fields: menuFields } } }) as SiteConfig, siteRoot);
const menu = site.collections.settings!.fields!.menu as ListField;

const stored = [
	{ label: 'About', href: { href: '/about' }, links: [] },
	{
		label: 'Services',
		href: { href: '' },
		links: [
			{ label: 'Branding', href: '/services/branding' },
			{ label: 'Websites', href: 'not an address' },
		],
	},
];

describe('a list inside a list: storage, paths and render data (Acceptance 4)', () => {
	test('it parses and stores as the contract has it, keys in schema order', () => {
		const shuffled = [{ links: [{ href: '/b', label: 'B' }], label: 'Services', href: { href: '' } }];
		assert.deepEqual(fieldToJson(menu, parseField(menu, shuffled)), [{ label: 'Services', href: { href: '' }, links: [{ label: 'B', href: '/b' }] }]);
		assert.deepEqual(Object.keys((fieldToJson(menu, shuffled) as Record<string, unknown>[])[0]!), ['label', 'href', 'links']);
		assert.deepEqual(parseField(menu, stored), stored);
	});

	test('the file writes an inner list as the outer one is written: each item on its own lines', () => {
		const out = fieldText(menu, [{ label: 'Services', href: { href: '' }, links: [{ label: 'B', href: '/b' }] }], 1);
		assert.equal(
			out,
			[
				'[',
				'    {',
				'      "label": "Services",',
				'      "href": {',
				'        "href": ""',
				'      },',
				'      "links": [',
				'        {',
				'          "label": "B",',
				'          "href": "/b"',
				'        }',
				'      ]',
				'    }',
				'  ]',
			].join('\n'),
		);
		assert.deepEqual(JSON.parse(out), [{ label: 'Services', href: { href: '' }, links: [{ label: 'B', href: '/b' }] }]);
	});

	test('it renders with each link as its render value', () => {
		const out = renderData({ menu }, { menu: stored }) as { menu: { href: unknown; links: unknown[] }[] };
		assert.deepEqual(out.menu[0]!.href, { href: '/about' });
		assert.equal(out.menu[1]!.href, null, 'an address-only link with no address is null');
		assert.deepEqual(out.menu[1]!.links, stored[1]!.links, 'a link is { label, href }, as it is outside a list');
	});

	test('a path into an inner item lands on its field', () => {
		const at = fieldAtPath({ menu }, 'menu.1.links.0.label');
		assert.equal(at?.field.kind, 'link');
		assert.deepEqual(at?.rest, ['label']);
		assert.equal(fieldAt({ menu }, 'menu.1.links')?.kind, 'list');
		assert.equal(fieldAt({ menu }, 'menu.1.links.0')?.kind, 'link');
	});

	test('BlockData types an inner list', () => {
		type Menu = BlockData<typeof menuFields>['menu'];
		const typed: Menu = [{ label: 'Services', href: null, links: [{ label: 'Branding', href: '/services/branding' }] }];
		const label: string = typed[0]!.links[0]!.label;
		assert.equal(label, 'Branding');
	});
});

describe('links and images in an inner list (Acceptance 8 and 9)', () => {
	const settingsText = (value: unknown) => `${JSON.stringify({ title: 'Site Settings', editors: [], brand: { name: 'CaraCMS' }, menu: value }, null, 2)}\n`;

	test('an inner link to a page that moves is relinked, in Site Settings and in a block', () => {
		const move = { collection: 'pages', fromPath: 'services/branding', toPath: 'services/identity', fromUrl: '/services/branding', toUrl: '/services/identity' };
		const settings = relinkText(settingsText(stored), move, site, site.collections.settings!);
		assert.equal(settings.links, 1);
		assert.equal((JSON.parse(settings.text).menu[1].links[0] as { href: string }).href, '/services/identity');
		const page = `${JSON.stringify({ title: 'P', blocks: [{ type: 'nav', menu: stored }] })}\n`;
		const out = relinkText(page, move, site, site.collections.pages!);
		assert.equal(out.links, 1);
		assert.equal(JSON.parse(out.text).blocks[0].menu[1].links[0].href, '/services/identity');
	});

	test('an inner link that fails the link rule is warned at its path', () => {
		const warnings = fieldWarnings(menu, stored, {}, 'menu');
		assert.ok(warnings.some((w) => w.path === 'menu.1.links.1.href'), JSON.stringify(warnings));
	});

	test("an inner list's image with no alt text is in Publish's summary, with both rows", () => {
		const img = (n: number, alt = '') => ({ key: `uploads/1fb083002e3a/${n}.jpg`, w: 10, h: 10, alt });
		const text = `${JSON.stringify({ title: 'Site Settings', editors: [], brand: {}, partners: [{ name: 'A', logos: [img(1, 'Fine')] }, { name: 'B', logos: [img(2, 'Fine'), img(3)] }] })}\n`;
		const gaps = missingAltIn(site, 'settings', text);
		assert.deepEqual(
			gaps.map((g) => [g.path, g.row, g.label]),
			[['partners.1.logos.1.alt', 1, 'Partners image 2, logos 2']],
		);
		const page = `${JSON.stringify({ title: 'P', blocks: [{ type: 'nav', partners: [{ name: 'A', logos: [img(1)] }] }] })}\n`;
		assert.deepEqual(missingAltIn(site, 'pages', page).map((g) => [g.block, g.path]), [[0, 'partners.0.logos.0.alt']]);
	});
});

describe('unknown keys in list items (Acceptance 10)', () => {
	const raw = [{ legacy: 'a', label: 'Services', href: { href: '' }, links: [{ href: '/b', legacyId: 7, label: 'B' }] }];

	test('they parse with the item and are written after its schema keys, outer and inner', () => {
		const parsed = parseField(menu, raw) as Record<string, unknown>[];
		assert.deepEqual(Object.keys(parsed[0]!), ['label', 'href', 'links', 'legacy']);
		assert.deepEqual(fieldToJson(menu, parsed), [{ label: 'Services', href: { href: '' }, links: [{ label: 'B', href: '/b' }], legacy: 'a' }], 'a list of one field (links) has no item keys of its own');
		const out = fieldText(list({ name: text(), people: list({ name: text() }) }), [{ name: 'A', x: 1, people: [{ name: 'P', legacyId: 7 }] }], 1);
		assert.deepEqual(JSON.parse(out), [{ name: 'A', people: [{ name: 'P', legacyId: 7 }], x: 1 }]);
		assert.match(out, /"name": "P",\n {10}"legacyId": 7\n/);
	});

	test('an edit to a sibling keeps them in the file', () => {
		const people = list({ name: text(), people: list({ name: text() }) });
		const edited = setAtPath(parseField(people, [{ name: 'A', people: [{ name: 'P', legacyId: 7 }] }]), '0.people.0.name', 'Q');
		assert.deepEqual(fieldToJson(people, edited), [{ name: 'A', people: [{ name: 'Q', legacyId: 7 }] }]);
	});
});

describe("a collapsed outer row's summary (Acceptance 11)", () => {
	const none = () => null;
	test('it leads with its own label and counts its inner items', () => {
		assert.deepEqual(itemSummary(menu, stored[1], none), { main: 'Services', more: '2 dropdown links' });
		assert.deepEqual(itemSummary(menu, { ...stored[1], links: [stored[1]!.links[0]] }, none), { main: 'Services', more: '1 dropdown link' });
	});
	test('with no inner items, it says where it goes, as before', () => {
		assert.deepEqual(itemSummary(menu, stored[0], none), { main: 'About', more: '/about' });
	});
});

describe("the page component's settings (Acceptance 12)", () => {
	const source = (text: string | null): ContentSource => ({ readText: async (file) => (file.endsWith('site-settings.json') ? text : null), listJson: async () => [] });
	const full = {
		title: 'Site Settings',
		editors: ['aoife@example.com'],
		brand: { name: 'CaraCMS', accent: '#1f3a2e', logo: { key: 'uploads/1fb083002e3a/mark.svg', w: 32, h: 32 } },
		seo: { title: 'CaraCMS, a small design studio', description: 'Identities.', image: { key: 'uploads/3f9a1c07b2e4/harbour-wall.jpg', w: 4000, h: 2667 } },
		googleTag: 'G-ABC123',
		formRecipients: { contact: ['studio@example.com'] },
		redirects: [{ from: '/old', to: '/new' }],
		menu: stored,
		mystery: 'kept in the file, not in the props',
	};

	test("it holds brand, seo and the site's own fields as render data, and nothing else", async () => {
		const settings = await settingsRenderData(site, source(JSON.stringify(full)));
		assert.deepEqual(Object.keys(settings).sort(), ['brand', 'menu', 'partners', 'seo']);
		assert.deepEqual(settings.brand, {
			name: 'CaraCMS',
			logo: { kind: 'image', key: 'uploads/1fb083002e3a/mark.svg', alt: '', decorative: false, focal: null, position: null, w: 32, h: 32 },
			icon: null,
		});
		assert.equal((settings.seo as { title: string }).title, 'CaraCMS, a small design studio');
		assert.equal((settings.seo as { description: string }).description, 'Identities.');
		assert.equal((settings.seo as { image: { key: string } }).image.key, 'uploads/3f9a1c07b2e4/harbour-wall.jpg');
		assert.deepEqual((settings.menu as { href: unknown }[]).map((m) => m.href), [{ href: '/about' }, null], 'links as render values');
		assert.deepEqual(settings.partners, []);
	});

	test("the site's name: the brand's, else seo.title, else \"Site\"", async () => {
		const named = async (raw: unknown) => ((await settingsRenderData(site, source(JSON.stringify(raw)))).brand as { name: string }).name;
		assert.equal(await named({ ...full, brand: { name: '  ' } }), 'CaraCMS, a small design studio');
		assert.equal(await named({ ...full, brand: {}, seo: {} }), 'Site');
		assert.equal(await named({ title: 'CaraCMS' }), 'Site', "the document's own title is never the site's name");
	});

	test('never undefined: a missing or broken file is the empty shape', async () => {
		for (const text of [null, '{ not json', '[]']) {
			const settings = await settingsRenderData(site, source(text));
			assert.deepEqual(settings, { menu: [], partners: [], brand: { name: 'Site', logo: null, icon: null }, seo: { title: '', description: '', image: null, titleSeparator: ' · ' } }, String(text));
		}
	});

	test('it reads the source it is given (the preview hands it the draft)', async () => {
		const draft = { ...full, menu: [{ ...stored[0], label: 'About us' }] };
		const settings = await settingsRenderData(site, source(JSON.stringify(draft)));
		assert.equal((settings.menu as { label: string }[])[0]!.label, 'About us');
		// The same text parses to the same values as the editor's Site Settings document holds.
		const doc = parseAnyDocument(draft, site, site.collections.settings!);
		assert.equal(doc.kind, 'settings');
		assert.deepEqual((doc as Extract<typeof doc, { kind: 'settings' }>).data.menu, parseField(menu, draft.menu));
	});
});
