// The group field (the editor-friction batch, item 1): its helper and the
// config's rules, parse / write / render, warnings and paths, the file's text, and the
// walks that read a schema (references, relinks, images without alt text, a card's picture).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	buttons,
	fieldAt,
	fieldAtPath,
	fieldHoldsMedia,
	fieldToJson,
	fieldWarnings,
	firstImagePath,
	group,
	headingPaths,
	isEmptyValue,
	isKeyPath,
	link,
	list,
	media,
	parseField,
	reference,
	renderValue,
	resolveSite,
	richText,
	text,
	toggle,
	type Field,
	type FieldValue,
	type GroupField,
	type SiteConfig,
} from '../src/config.ts';
import { blockContexts, fieldsHeading, firstHeadingIndex, parseDocumentText, type SiteDocument } from '../src/document.ts';
import { itemSummary } from '../src/editor/client/fields/list-summary.ts';
import { staleNames } from '../src/editor/client/fields/stale.ts';
import { missingAltIn } from '../src/editor/server/media/alt.ts';
import { resolveRefs } from '../src/read.ts';
import { relinkText } from '../src/relink.ts';
import { applyEdits } from '../src/serialize.ts';
import { config, siteRoot, variant } from './helpers/site.ts';

const column = group(
	{
		heading: text(),
		text: richText(),
		more: link(),
		button: buttons({ styles: ['primary', 'secondary'], max: 1 }),
		picture: media(),
		wide: toggle(),
		credits: list({ name: text() }),
		lead: reference({ to: 'journal' }),
	},
	{ label: 'Left', help: 'The left-hand column.' },
);
const twoColumns = { component: 'Block.astro', fields: { left: column, right: group({ heading: text() }) } };
const site = resolveSite(variant({ blocks: { ...config.blocks, columns: twoColumns } }), siteRoot);

describe('group(): the helper and the config', () => {
	test('a group of named fields, with its label and help', () => {
		assert.equal(column.kind, 'group');
		assert.equal(column.label, 'Left');
		assert.equal(column.help, 'The left-hand column.');
		assert.deepEqual(Object.keys(column.fields), ['heading', 'text', 'more', 'button', 'picture', 'wide', 'credits', 'lead']);
	});

	test('the helper refuses a group inside a group, saying what to do instead', () => {
		assert.throws(() => group({ inner: group({ a: text() }) }), /group\(\): "inner" is a group, and a group can't hold another group/);
	});

	const withField = (field: unknown, where: 'block' | 'page' | 'settings' = 'block') =>
		where === 'block'
			? variant({ blocks: { x: { component: 'Block.astro', fields: { f: field as Field } } } })
			: where === 'page'
				? variant({ collections: { ...config.collections, games: { kind: 'sections', folder: 'content/games', urlBase: '/games/', fields: { f: field as Field } } } })
				: ({ ...config, settings: { fields: { f: field as Field } } } as SiteConfig);
	const refuses = (field: unknown, message: RegExp) => assert.throws(() => resolveSite(withField(field), siteRoot), message);

	test('a group is accepted in a block, in a list item, in page fields and in Site Settings, and can hold a list', () => {
		for (const where of ['block', 'page', 'settings'] as const) assert.doesNotThrow(() => resolveSite(withField(group({ a: text(), rows: list(text()) }), where), siteRoot), where);
		assert.doesNotThrow(() => resolveSite(withField(list({ name: text(), side: group({ a: text() }) })), siteRoot));
	});

	test('the config refuses a group in a group (built by hand), a list of a group, a list in a group in a list, an empty group', () => {
		refuses({ kind: 'group', fields: { inner: { kind: 'group', fields: { a: text() } } } }, /a group can't hold another group/);
		refuses(list(group({ a: text() }) as Field), /a list can't be of a group/);
		refuses(list({ side: group({ rows: list(text()) }) }), /group field "rows": a list inside a list must be one of the item's own fields/);
		refuses({ kind: 'group', fields: {} }, /a group needs at least one field/);
		refuses(group({ a: { kind: 'colour' } as unknown as Field }), /isn't a field the package knows/);
	});

	test("labels are filled in inside a group; the group's own is the key's when not set", () => {
		const left = site.blocks.columns!.fields.left as GroupField;
		assert.equal(left.fields.heading!.label, 'Heading');
		assert.equal(left.fields.credits!.kind === 'list' && left.fields.credits.fields!.name!.label, 'Name');
		assert.equal(site.blocks.columns!.fields.right!.label, 'Right');
	});
});

describe('a group: parse, write, render', () => {
	test('parses to every field at its own value; missing or not an object is every field empty', () => {
		const v = parseField(column, { heading: ' Hi ', wide: true, stray: 1 }) as Record<string, unknown>;
		assert.deepEqual(Object.keys(v), Object.keys(column.fields), 'schema keys only, in order');
		assert.equal(v.heading, 'Hi');
		assert.equal(v.wide, true);
		assert.deepEqual(v.button, []);
		assert.deepEqual(parseField(column, 'nope'), parseField(column, undefined));
	});

	test('writes an object with its keys in schema order, each by its own rule', () => {
		const out = fieldToJson(column, { wide: false, heading: 'Hi', text: [{ p: 'One' }], button: [{ label: 'Go', href: '/x', style: 'primary' }] }) as Record<string, unknown>;
		assert.deepEqual(Object.keys(out), Object.keys(column.fields));
		assert.deepEqual(out.text, [{ p: 'One' }]);
		assert.deepEqual(out.more, { label: '', href: '' });
	});

	test('is empty when every field in it is', () => {
		assert.equal(isEmptyValue(group({ a: text(), b: list(text()) }), parseField(group({ a: text(), b: list(text()) }), undefined)), true);
		assert.equal(isEmptyValue(group({ a: text() }), { a: 'x' }), false);
	});

	test("the render's value maps each field (an image resolved, a number out of range null)", () => {
		const r = renderValue(column, parseField(column, { picture: { key: 'uploads/1fb083002e3a/a.jpg', alt: 'A', w: 10, h: 10 } })) as Record<string, unknown>;
		assert.equal((r.picture as { kind: string }).kind, 'image');
		assert.equal(r.heading, '');
	});

	test('a block\'s props get the nested type', () => {
		type Left = FieldValue<typeof column>;
		const left: Left = parseField(column, undefined) as Left;
		const heading: string = left.heading;
		const flag: boolean = left.wide;
		assert.equal(typeof heading, 'string');
		assert.equal(typeof flag, 'boolean');
	});
});

describe('a group: warnings and paths', () => {
	test("each field's warnings, at its key inside the group; a group that isn't an object is unreadable", () => {
		const ws = fieldWarnings(column, { more: { label: 'Read', href: '' }, button: [{ label: '', href: '/x', style: 'primary' }], picture: { key: 'uploads/1fb083002e3a/a.jpg', alt: '', w: 1, h: 1 } });
		assert.deepEqual(ws.map((w) => [w.path, w.code]), [
			['more', 'half-link'],
			['button.0', 'half-link'],
			['picture.alt', 'missing-alt'],
		]);
		assert.deepEqual(fieldWarnings(column, 'x').map((w) => w.code), ['unreadable']);
		assert.deepEqual(fieldWarnings(column, undefined), []);
	});

	test('fieldAtPath and fieldAt go into a group by key; isKeyPath is a path with no list index', () => {
		const fields = site.blocks.columns!.fields;
		assert.equal(fieldAt(fields, 'left.heading')?.kind, 'text');
		assert.deepEqual(fieldAtPath(fields, 'left.button.0.label')?.rest, ['0', 'label']);
		assert.equal(fieldAt(fields, 'left.credits.1.name')?.kind, 'text');
		assert.equal(fieldAtPath(fields, 'left.nope'), undefined);
		assert.equal(fieldAt(fields, 'left.button.0'), undefined, 'not exactly a field');
		assert.equal(isKeyPath('left.heading'), true);
		assert.equal(isKeyPath('heading'), true);
		assert.equal(isKeyPath('credits.1.name'), false);
		assert.equal(isKeyPath(''), false);
	});

	test('a group holding an image holds media; the first image is found through it', () => {
		assert.equal(fieldHoldsMedia(column), true);
		assert.equal(fieldHoldsMedia(group({ a: text() })), false);
		const data = { left: parseField(column, { picture: { key: 'uploads/1fb083002e3a/a.jpg', alt: 'A', w: 10, h: 10 } }) };
		assert.equal(firstImagePath(site.blocks.columns!.fields, data), 'left.picture');
	});
});

const pageText = `{
  "title": "Two",
  "blocks": [
    {
      "type": "columns",
      "left": {
        "heading":   "Left side",
        "more": { "label": "About", "href": "/about" },
        "picture": { "key": "uploads/1fb083002e3a/a.jpg", "w": 10, "h": 10 },
        "lead": "gone"
      },
      "right": { "heading": "Right side" }
    }
  ]
}
`;

describe('a group in the file', () => {
	const read = (): SiteDocument => structuredClone(parseDocumentText(pageText, site).document);

	test('untouched, the file comes back byte for byte', () => {
		assert.equal(applyEdits(pageText, read(), site), pageText);
	});

	test('a change inside one group rewrites that group, on its own lines in schema order; the other is left as it was', () => {
		const doc = read();
		(doc.blocks[0]!.data.left as Record<string, unknown>).heading = 'New left';
		const out = applyEdits(pageText, doc, site);
		assert.match(out, /"left": \{\n {8}"heading": "New left",\n {8}"text": \[\],\n {8}"more": \{/);
		assert.match(out, /"right": \{ "heading": "Right side" \}/);
		assert.deepEqual(parseDocumentText(out, site).document.blocks[0]!.data.right, read().blocks[0]!.data.right);
	});

	test('a new block is written with its groups whole', () => {
		const doc = read();
		const out = applyEdits(null, doc, site);
		assert.equal(applyEdits(out, structuredClone(parseDocumentText(out, site).document), site), out, 'canonical: round-trips');
		assert.match(out, /"right": \{\n {8}"heading": "Right side"\n {6}\}/);
	});

	test("a link in a group is relinked when the page it points at moves", () => {
		const out = relinkText(pageText, { collection: 'pages', fromPath: 'about', toPath: 'studio', fromUrl: '/about', toUrl: '/studio' }, site, site.collections.pages!);
		assert.equal(out.links, 1);
		assert.match(out.text, /"more": \{ "label": "About", "href": "\/studio" \}/);
	});

	test("an image in a group with no alt text is in Publish's summary, at its path", () => {
		const gaps = missingAltIn(site, 'pages', pageText);
		assert.equal(gaps.length, 1);
		assert.equal(gaps[0]!.path, 'left.picture.alt');
		assert.equal(gaps[0]!.block, 0);
		assert.equal(gaps[0]!.row, null);
	});

	test("a list of images in a group: Publish's summary numbers its rows", () => {
		const galleried = resolveSite(variant({ blocks: { ...config.blocks, columns: { component: 'Block.astro', fields: { left: group({ gallery: list(media()) }) } } } }), siteRoot);
		const img = (n: number) => `{ "key": "uploads/1fb083002e3a/${n}.jpg", "w": 10, "h": 10 }`;
		const text = `{ "title": "G", "blocks": [ { "type": "columns", "left": { "gallery": [ ${img(1)}, ${img(2)} ] } } ] }\n`;
		const gaps = missingAltIn(galleried, 'pages', text);
		assert.deepEqual(gaps.map((g) => [g.path, g.row]), [
			['left.gallery.0.alt', 0],
			['left.gallery.1.alt', 1],
		]);
		assert.match(gaps[0]!.label, / 1$/);
		assert.match(gaps[1]!.label, / 2$/);
	});

	test('a reference in a group to a document that is gone is null in the render', async () => {
		const data = { left: { lead: 'gone', heading: 'x' } };
		const out = await resolveRefs(site.blocks.columns!.fields, data, async () => false);
		assert.equal((out.left as Record<string, unknown>).lead, null);
		assert.equal((out.left as Record<string, unknown>).heading, 'x');
	});
});

describe('a group in the editor: paths', () => {
	test("a change marks its field's frame as not in the preview yet: a list marks itself, a group's field its own", () => {
		assert.deepEqual(staleNames('heading'), ['heading']);
		assert.deepEqual(staleNames('credits.1.name'), ['credits']);
		assert.deepEqual(staleNames('left.heading'), ['left', 'left.heading']);
		assert.deepEqual(staleNames('left.credits.0.name'), ['left', 'left.credits']);
		assert.deepEqual(staleNames('cta.label'), ['cta', 'cta.label']);
	});

	test("a list row whose only field is a group is summed up from inside the group", () => {
		const cols = list({ col: group({ heading: text(), more: link() }) });
		assert.deepEqual(itemSummary(cols, { col: { heading: 'North', more: { label: 'Read', href: '/n' } } }, () => null), { main: 'North', more: 'Read' });
		assert.deepEqual(itemSummary(cols, {}, () => null), { main: '', more: '' });
	});
});

describe("a group: the page's h1", () => {
	const col = (heading: boolean) => group({ heading: text({ heading }), body: richText() });
	const block = (fields: Record<string, Field>) => ({ component: 'Block.astro', fields });
	const headed = resolveSite(
		variant({
			blocks: {
				...config.blocks,
				pair: block({ left: col(true), right: col(true) }),
				topWins: block({ left: col(true), title: text({ heading: true }) }),
				plain: block({ left: col(false), note: text() }),
			},
		}),
		siteRoot,
	);

	test("headingPaths: top-level headings first, then those inside groups, groups in schema order", () => {
		assert.deepEqual(headingPaths({ left: col(true), title: text({ heading: true }), right: col(true), note: text() }), ['title', 'left.heading', 'right.heading']);
		assert.deepEqual(headingPaths({ left: col(false) }), []);
	});

	test("a block's heading field is a group's heading at its dotted path; a top-level one wins; two groups give one", () => {
		assert.equal(headed.blocks.pair!.headingField, 'left.heading');
		assert.equal(headed.blocks.topWins!.headingField, 'title');
		assert.equal(headed.blocks.plain!.headingField, null);
	});

	test("the first block whose group heading has words holds the page's h1, at the group's path", () => {
		const page = (blocks: unknown[]) => parseDocumentText(JSON.stringify({ title: 'P', blocks }), headed).document as SiteDocument;
		const first = page([{ type: 'pair', left: { heading: 'Left' }, right: { heading: 'Right' } }, { type: 'pair', left: { heading: 'Next' } }]);
		assert.equal(firstHeadingIndex(first, headed), 0);
		assert.deepEqual(blockContexts(first, headed, false).map((c) => c?.h1Field ?? null), ['left.heading', null]);
		// An empty left heading: the block holds no h1 (the right one never does), so it passes on.
		const passed = page([{ type: 'pair', left: { heading: '' }, right: { heading: 'Right' } }, { type: 'pair', left: { heading: 'Next' } }]);
		assert.equal(firstHeadingIndex(passed, headed), 1);
	});

	test("a fields document: a top-level heading with words wins, else the first group heading with words", () => {
		const fields = { left: col(true), title: text({ heading: true }), right: col(true) };
		assert.equal(fieldsHeading(fields, { left: { heading: 'L' }, title: 'T', right: { heading: 'R' } }), 'title');
		assert.equal(fieldsHeading(fields, { left: { heading: 'L' }, title: '', right: { heading: 'R' } }), 'left.heading');
		assert.equal(fieldsHeading(fields, { left: { heading: '' }, title: '', right: { heading: 'R' } }), 'right.heading');
		assert.equal(fieldsHeading(fields, { left: 'not an object' }), null);
	});
});
