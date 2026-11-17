// M5a's test pass: the Decisions and bolded rules that the builders' own tests left
// thin. Each describe names the Decision it proves. No browser, no live store (the live
// half is m5a-rules-live.test.ts). The map of Decision → test lives in the test-pass report.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
	buttons,
	date,
	fieldToJson,
	fieldWarnings,
	link,
	list,
	lockup,
	number,
	parseField,
	reference,
	renderData,
	resolveSite,
	richText,
	select,
	SITE_SETTINGS_FILE,
	text,
	toggle,
	type Field,
	type Fields,
	type ResolvedSite,
	type SiteConfig,
} from '../src/config.ts';
import { listDocuments, readDocument } from '../src/content.ts';
import {
	blockContexts,
	firstHeadingIndex,
	fieldsHeading,
	parseAnyDocument,
	parseBlock,
	parseDocument,
	parseDocumentText,
	parseFields,
	type DocumentBlock,
	type FieldsDocument,
	type SettingsDocument,
	type SharedDocument,
	type SiteDocument,
} from '../src/document.ts';
import { createDocumentStore, formKey } from '../src/editor/client/state/document-store.ts';
import { currentBrand } from '../src/editor/server/settings.ts';
import { resetEditorMode } from '../src/editor/server/mode.ts';
import { handleCreate, handleDelete } from '../src/editor/server/create.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import type { CreateDeleteRefusal } from '../src/editor/types.ts';
import { parseSource, slice, type ArrayNode, type ObjectNode } from '../src/json-source.ts';
import { parseAllowEntry as fromAllow } from '../src/live/auth/allow.ts';
import { parseAllowEntry as fromRules } from '../src/live/auth/allow-rules.ts';
import { diskSource } from '../src/content.ts';
import { documentReader, renderSourceOf, resolveRefs, resolveShared, setRenderSource } from '../src/read.ts';
import { applyDocumentEdits, applyEdits, applyKeyedEdits } from '../src/serialize.ts';
import { makeCreateSite } from './helpers/create-site.ts';
import { config, display, fixtures, site as fixtureSite, siteRoot, variant } from './helpers/site.ts';

// ── Decision 2: every value parses without throwing; a wrong shape is written back untouched ──

const everyKind: Record<string, Field> = {
	text: text(),
	textMulti: text({ multiline: true }),
	textHeading: text({ heading: true }),
	lockup: lockup({ style: 'display' }),
	select: select({ options: ['a', 'b'] }),
	richText: richText(),
	richTextHeadings: richText({ headings: ['h2', 'h3'] }),
	richTextNoLinks: richText({ links: false }),
	link: link(),
	buttons: buttons({ styles: ['primary', 'secondary'] }),
	toggle: toggle(),
	toggleDefaultOn: toggle({ default: true }),
	number: number({ min: 1, max: 10, step: 1 }),
	date: date(),
	listOfText: list(text()),
	listOfFields: list({ role: text(), name: text(), cta: link(), when: date(), n: number() }),
	listOfLinks: list(link()),
	listOfReferences: list(reference({ to: 'journal' })),
	reference: reference({ to: 'journal' }),
};

function deep(n: number): unknown {
	let v: unknown = 'x';
	for (let i = 0; i < n; i++) v = [v];
	return v;
}

const junk: [string, unknown][] = [
	['undefined', undefined],
	['null', null],
	['true', true],
	['false', false],
	['zero', 0],
	['negative', -3],
	['a fraction', 1.5],
	['NaN', Number.NaN],
	['Infinity', Number.POSITIVE_INFINITY],
	['empty string', ''],
	['spaces', '   '],
	['a word', 'word'],
	['markup', '**bold** [a](/b) \\'],
	['paragraphs', 'one\n\ntwo\nthree'],
	['empty array', []],
	['array of null', [null]],
	['array of arrays', [[], [[]]]],
	['mixed array', [1, 'a', {}, null, true]],
	['rich text with a number', [{ p: 1 }]],
	['rich text with two kinds', [{ p: 'a', h2: 'b' }]],
	['rich text list as a string', [{ ul: 'x' }]],
	['empty object', {}],
	['a rich text block, not in a list', { p: 'x' }],
	['link with numbers', { label: 1, href: 2 }],
	['link with objects', { label: {}, href: [] }],
	['buttons with junk', [{ label: [], href: {}, style: 3 }, 'x', null]],
	['list of junk objects', [{ role: 1, name: [], cta: 'no', when: 3, n: 'x' }]],
	['numeric keys', { 0: 'a', 1: 'b' }],
	['a proto key', JSON.parse('{"__proto__": {"polluted": true}, "label": "x", "href": "/y"}')],
	['a very long string', 'x'.repeat(200_000)],
	['deeply nested arrays', deep(400)],
	['a date-looking object', { year: 2026 }],
];

describe('Decision 2: every value parses without throwing, for every kind and every wrong shape', () => {
	for (const [kindName, field] of Object.entries(everyKind)) {
		test(`${kindName}: parse, write, warn and render never throw, and the parsed value is stable`, () => {
			for (const [what, raw] of junk) {
				let parsed: unknown;
				assert.doesNotThrow(() => (parsed = parseField(field, raw)), `${kindName} parse of ${what}`);
				let written: unknown;
				assert.doesNotThrow(() => (written = fieldToJson(field, parsed)), `${kindName} write of ${what}`);
				assert.doesNotThrow(() => fieldWarnings(field, raw), `${kindName} warnings of ${what}`);
				assert.doesNotThrow(() => renderData({ k: field }, { k: raw }), `${kindName} render of ${what}`);
				// What the parser makes is a value the writer accepts, and reading what was written gives the same value.
				assert.deepEqual(parseField(field, JSON.parse(JSON.stringify(written ?? null))), parsed, `${kindName}: ${what} is stable through write and read`);
			}
		});
	}

	test('a document of any shape parses: not an object, blocks not an array, blocks of junk', () => {
		for (const raw of [null, undefined, 3, 'x', [], { blocks: 'x' }, { blocks: [1, null, 'a', [], { type: 3 }, { type: 'hero', heading: 9 }] }]) {
			assert.doesNotThrow(() => parseDocument(raw, fixtureSite));
			for (const name of ['pages', 'shared', 'settings']) assert.doesNotThrow(() => parseAnyDocument(raw, fixtureSite, fixtureSite.collections[name]!), name);
		}
	});
});

// A site with every field, and a document whose every value is the wrong shape.
const kitFields: Fields = {
	heading: lockup({ style: 'display' }),
	body: richText({ headings: ['h2', 'h3'] }),
	notes: richText(),
	cta: link(),
	buttons: buttons({ styles: ['primary', 'secondary'] }),
	featured: toggle(),
	count: number({ min: 1, max: 10 }),
	launched: date(),
	credits: list({ role: text(), name: text() }),
	tags: list(text()),
	related: list(reference({ to: 'journal' })),
	lead: reference({ to: 'journal' }),
};
const kitSite = resolveSite(variant({ blocks: { kit: { component: 'Block.astro', fields: kitFields } } }), siteRoot);

/** The source text of each member of the first block, keyed by key. */
function firstBlockTexts(textIn: string): Record<string, string> {
	const source = parseSource(textIn);
	const blocks = (source.root as ObjectNode).members.find((m) => m.key === 'blocks')!.value as ArrayNode;
	return Object.fromEntries((blocks.items[0] as ObjectNode).members.map((m) => [m.key, slice(source, m.value)]));
}

const WRONG_BLOCK = `{
  "title":"Wrong shapes",
  "blocks": [
    {
      "type": "kit",
      "heading": 7,
      "body": {"p": "not a list"},
      "notes": 42,
      "cta": ["no"],
      "buttons": "x",
      "featured": "yes",
      "count": "12",
      "launched": 20261015,
      "credits": "none",
      "tags": {"a": 1},
      "related": 3,
      "lead": ["a"],
      "unknown": [1,   2]
    }
  ]
}
`;

describe('Decision 2: a wrong-shape value is written back untouched unless the editor changes it', () => {
	test('a section builder: every field of the wrong shape reads as empty and the file comes back byte for byte', () => {
		const { document } = parseDocumentText(WRONG_BLOCK, kitSite);
		const data = document.blocks[0]!.data;
		assert.deepEqual(data.heading, { lines: [], phone: null });
		assert.deepEqual(data.body, []);
		assert.deepEqual(data.cta, { label: '', href: '' });
		assert.deepEqual(data.buttons, []);
		assert.equal(data.featured, false);
		assert.equal(data.count, null);
		assert.equal(data.launched, null);
		assert.deepEqual(data.credits, []);
		assert.equal(data.lead, null);
		assert.equal(applyEdits(WRONG_BLOCK, structuredClone(document), kitSite), WRONG_BLOCK);
	});

	test('editing one field changes only that one: every other wrong-shape member keeps its exact text', () => {
		const { document } = parseDocumentText(WRONG_BLOCK, kitSite);
		document.blocks[0]!.data.featured = true;
		const out = applyEdits(WRONG_BLOCK, document, kitSite);
		const before = firstBlockTexts(WRONG_BLOCK);
		const after = firstBlockTexts(out);
		assert.equal(after.featured, 'true');
		for (const key of Object.keys(before)) if (key !== 'featured') assert.equal(after[key], before[key], key);
		assert.equal(out.slice(0, out.indexOf('"blocks"')), WRONG_BLOCK.slice(0, WRONG_BLOCK.indexOf('"blocks"')));
	});

	test('a list-of-fields document: wrong shapes come back byte for byte, and one edit leaves them', () => {
		const collection = { kind: 'fields' as const, fields: kitFields };
		const base = `{
  "title": "Wrong",
  "heading":   7,
  "body": {"p": "not a list"},
  "cta": ["no"],
  "count": "12",
  "credits": "none",
  "lead": ["a"],
  "legacy": {"keep": true}
}
`;
		const doc = parseAnyDocument(JSON.parse(base), fixtureSite, collection) as FieldsDocument;
		assert.equal(applyKeyedEdits(base, structuredClone(doc), collection), base);
		doc.data.featured = true;
		const out = applyKeyedEdits(base, doc, collection);
		// The new key goes after the key before it in schema order (the link), and nothing else moves.
		assert.equal(out, base.replace('  "cta": ["no"],\n', '  "cta": ["no"],\n  "featured": true,\n'));
	});

	test('Site Settings: wrong-shape editors and brand come back byte for byte; an unknown key stays', () => {
		const collection = fixtureSite.collections.settings!;
		const base = '{\n  "title": "Site Settings",\n  "editors": "niamh@example.com",\n  "brand": 5,\n  "own":   [1]\n}\n';
		const doc = parseAnyDocument(JSON.parse(base), fixtureSite, collection) as SettingsDocument;
		assert.deepEqual(doc.data.editors, []);
		assert.deepEqual(doc.data.brand, { name: '', accent: '', logo: null, icon: null });
		assert.equal(applyDocumentEdits(base, structuredClone(doc), fixtureSite, collection), base);
	});

	test('a shared block: a wrong-shape field comes back byte for byte', () => {
		const collection = fixtureSite.collections.shared!;
		const base = '{\n  "title": "Footer",\n  "block": {\n    "type": "cta",\n    "heading": 7,\n    "text":   ["x"],\n    "extra": 1\n  }\n}\n';
		const doc = parseAnyDocument(JSON.parse(base), fixtureSite, collection) as SharedDocument;
		assert.equal(applyDocumentEdits(base, structuredClone(doc), fixtureSite, collection), base);
	});
});

// ── Decision 3: a disallowed kind or a link where links are off is kept until the field is touched ──

describe('Decision 3: a disallowed kind and a link where links are off stay in the file until the editor touches the field', () => {
	const site = resolveSite(
		variant({
			blocks: {
				plain: { component: 'Block.astro', fields: { body: richText(), other: richText() } },
				nolinks: { component: 'Block.astro', fields: { body: richText({ links: false }), other: richText() } },
				h2only: { component: 'Block.astro', fields: { body: richText({ headings: ['h2'] }), other: richText() } },
			},
		}),
		siteRoot,
	);
	const page = (block: unknown) => `{\n  "title": "P",\n  "blocks": [\n    ${JSON.stringify(block)}\n  ]\n}\n`;
	const cases: [string, unknown, (body: { kind: string; runs: { text: string; href?: string }[] }[]) => void, string, string][] = [
		['an h2 where headings are off', { type: 'plain', body: [{ h2: 'Hello' }, { p: 'Kept' }], other: [{ p: 'x' }] }, (b) => (b[0]!.runs[0]!.text = 'Hello!'), '{"h2":"Hello"}', '{ "p": "Hello!" }'],
		['an h1 anywhere', { type: 'h2only', body: [{ h1: 'Big' }, { h2: 'Fine' }], other: [{ p: 'x' }] }, (b) => (b[0]!.runs[0]!.text = 'Big!'), '{"h1":"Big"}', '{ "p": "Big!" }'],
		['an h3 where only h2 is allowed', { type: 'h2only', body: [{ h3: 'Small' }], other: [{ p: 'x' }] }, (b) => (b[0]!.runs[0]!.text = 'Small!'), '{"h3":"Small"}', '{ "p": "Small!" }'],
		['a link where links are off', { type: 'nolinks', body: [{ p: 'See [the work](/work) now' }], other: [{ p: 'x' }] }, (b) => b[0]!.runs.push({ text: '!' }), '[the work](/work)', 'See the work now!'],
	];
	for (const [what, block, touch, keptText, touchedText] of cases) {
		test(`${what}: kept as read; once touched, written as a paragraph or plain text`, () => {
			const base = page(block);
			const { document } = parseDocumentText(base, site);
			const kind = (block as { type: string }).type;
			assert.equal(applyEdits(base, structuredClone(document), site), base, 'untouched');
			assert.ok(base.includes(keptText));
			// Touching another field of the block doesn't rewrite this one.
			const other = structuredClone(document);
			other.blocks[0]!.data.other = [{ kind: 'p', runs: [{ text: 'y' }] }];
			const out = applyEdits(base, other, site);
			assert.ok(out.includes(keptText), 'an edit elsewhere leaves it');
			// Touching it writes the field's form.
			const touched = structuredClone(document);
			touch(touched.blocks[0]!.data.body as never);
			const written = applyEdits(base, touched, site);
			assert.ok(!written.includes(keptText), `${kind}: the disallowed form is gone`);
			assert.ok(written.includes(touchedText), written);
			assert.doesNotMatch(written, /"h1"|"h3"/);
		});
	}

	test('the warning says it will be written as a paragraph (the field says so)', () => {
		const w = fieldWarnings(richText({ headings: ['h2'] }), [{ h1: 'x' }, { h3: 'y' }]);
		assert.deepEqual(w.map((x) => x.code), ['disallowed-kind', 'disallowed-kind']);
		for (const x of w) assert.match(x.message, /paragraph/);
		assert.match(fieldWarnings(richText({ links: false }), [{ p: '[a](/b)' }])[0]!.message, /text|link/i);
	});

	test('a plain string stays a plain string in the file until the field is edited (the old text() value, asterisk and all)', () => {
		const base = page({ type: 'plain', body: 'Five * three\n\nsecond\nline', other: [] });
		const { document } = parseDocumentText(base, site);
		assert.deepEqual(document.blocks[0]!.data.body, [
			{ kind: 'p', runs: [{ text: 'Five * three' }] },
			{ kind: 'p', runs: [{ text: 'second\nline' }] },
		]);
		assert.equal(applyEdits(base, structuredClone(document), site), base);
		const edited = structuredClone(document);
		(edited.blocks[0]!.data.body as { runs: { text: string }[] }[])[0]!.runs[0]!.text = 'Five * four';
		assert.match(applyEdits(base, edited, site), /\{ "p": "Five \\\\\* four" \}/);
	});
});

// ── Decision 7: config rules and the fields document's page rules ──

describe('Decision 7: list-of-fields collections in the config and the page they make', () => {
	const cs = { kind: 'fields', folder: 'content/case-studies', urlBase: '/work/', component: 'Block.astro', fields: { client: text() } } as const;
	const withCollection = (patch: Record<string, unknown>) => variant({ collections: { ...config.collections, 'case-studies': { ...cs, ...patch } as never } });

	test('component and fields are required (M6c G1: urlBase is not); nested and a field named title are refused', () => {
		assert.doesNotThrow(() => resolveSite(withCollection({}), siteRoot));
		assert.throws(() => resolveSite(withCollection({ component: undefined }), siteRoot), /component is required/);
		assert.throws(() => resolveSite(withCollection({ component: 'Nope.astro' }), siteRoot), /doesn't exist/);
		assert.throws(() => resolveSite(withCollection({ fields: undefined }), siteRoot), /fields is required/);
		// M6c (G1): no urlBase is a collection with no pages of its own.
		assert.equal(resolveSite(withCollection({ urlBase: undefined }), siteRoot).collections['case-studies']!.urlBase, null);
		assert.throws(() => resolveSite(withCollection({ urlBase: 'work' }), siteRoot), /urlBase must start with "\/"/);
		assert.throws(() => resolveSite(withCollection({ nested: true }), siteRoot), /flat/);
		assert.throws(() => resolveSite(withCollection({ fields: { title: text() } }), siteRoot), /"title"/);
	});

	test('pre-M7 polish: the table\'s columns are its short fields or the built-ins, each once, never the title', () => {
		const cols = (columns: unknown, fields: Record<string, unknown> = { client: text(), launched: date(), credits: list(text()) }) =>
			resolveSite(withCollection({ fields, columns }), siteRoot).collections['case-studies']!.columns;
		assert.equal(cols(undefined), null, 'absent: the default');
		assert.deepEqual(cols(['client', 'launched', 'edited', 'address']), ['client', 'launched', 'edited', 'address']);
		assert.throws(() => cols(['nope']), /"nope" isn't one of its fields that show one short value \(text, select, toggle, date, number, a reference or a list of references\)/);
		assert.throws(() => cols(['credits']), /"credits" is a list field/);
		assert.throws(() => cols(['title']), /the title is always the table's first column/);
		assert.throws(() => cols(['client', 'client']), /names "client" twice/);
		assert.throws(() => cols('client'), /columns must be a list/);
		// A section builder has only the built-ins; Pages (nested) has no table.
		const journal = (columns: unknown, nested = false) =>
			resolveSite(variant({ collections: { ...config.collections, journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal/', nested, columns } as never } }), siteRoot).collections.journal!.columns;
		assert.deepEqual(journal(['edited']), ['edited']);
		assert.throws(() => journal(['client']), /"client" isn't one of 'address' and 'edited'/);
		assert.throws(() => journal(['edited'], true), /a nested one \(Pages\) is a tree/);
	});

	test('posts and tags (Decision 13): a section builder\'s columns may name its page fields; a top-level sort is checked against the columns', () => {
		const journal = (extra: Record<string, unknown>, fields: Record<string, unknown> | undefined = { date: date(), tags: list(reference({ to: 'pages' })), lead: reference({ to: 'pages' }), credits: list(text()) }) =>
			resolveSite(variant({ collections: { ...config.collections, journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal/', fields, ...extra } as never } }), siteRoot).collections.journal!;
		const j = journal({ columns: ['date', 'tags', 'lead', 'edited'], sort: { column: 'date', order: 'desc' } });
		assert.deepEqual(j.columns, ['date', 'tags', 'lead', 'edited']);
		assert.deepEqual(j.sort, { column: 'date', order: 'desc' });
		assert.equal(journal({}).sort, null, 'absent: the title, A to Z');
		assert.deepEqual(journal({ sort: { column: 'edited', order: 'asc' } }).sort, { column: 'edited', order: 'asc' }, 'a default column');
		assert.deepEqual(journal({ columns: ['lead'], sort: { column: 'title', order: 'desc' } }).sort, { column: 'title', order: 'desc' });
		assert.throws(() => journal({ columns: ['credits'] }), /columns: "credits" is a list field; a column shows one short value, so it can be a text, select, toggle, date, number or reference field, or a list of references\. Take "credits" out of columns\./);
		assert.throws(() => journal({ columns: ['date'], sort: { column: 'lead', order: 'asc' } }), /sort: "lead" isn't one of its table's columns \('title', 'date'\)\. Add "lead" to columns, or sort by one of those\./);
		assert.throws(() => journal({ sort: { column: 'date', order: 'desc' } }), /sort: "date" isn't one of its table's columns \('title', 'address', 'edited'\)/, 'the default columns');
		assert.throws(() => journal({ columns: ['tags'], sort: { column: 'tags', order: 'asc' } }), /"tags" is a list of references, which can't order the table/);
		assert.throws(() => journal({ columns: ['date'], sort: { column: 'date', order: 'down' } }), /sort's order must be 'asc'/);
		assert.throws(() => journal({ sort: 'date' }), /sort must be a column and an order/);
		assert.throws(() => journal({ sort: { column: 'title', order: 'asc', view: 'grid' } }), /sort has no "view"/);
		assert.throws(() => journal({ columns: ['date'] }, {}), /"date" isn't one of 'address' and 'edited'/, 'no page fields: only the built-ins');
		// A list of fields takes a top-level sort too, checked the same way.
		const cases = (extra: Record<string, unknown>) => resolveSite(withCollection({ fields: { client: text(), launched: date() }, ...extra }), siteRoot).collections['case-studies']!;
		assert.deepEqual(cases({ columns: ['launched'], sort: { column: 'launched', order: 'desc' } }).sort, { column: 'launched', order: 'desc' });
		assert.throws(() => cases({ columns: ['launched'], sort: { column: 'client', order: 'asc' } }), /Add "client" to columns/);
		assert.throws(() => cases({ urlBase: undefined, sort: { column: 'address', order: 'asc' } }), /\('title', 'edited'\)/, 'no urlBase: no address column');
		// Pages (nested) has no table, so no sort.
		assert.throws(() => resolveSite(variant({ collections: { ...config.collections, journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal/', nested: true, sort: { column: 'title', order: 'asc' } } as never } }), siteRoot), /sort is for the editor's table of a flat collection/);
	});

	test('Site Settings\' own keys (title, editors, brand) can\'t be given to a site field', () => {
		for (const key of ['title', 'editors', 'brand']) {
			assert.throws(() => resolveSite(variant({ settings: { fields: { [key]: text() } } }), siteRoot), /Site Settings' own keys/, key);
		}
		assert.doesNotThrow(() => resolveSite(variant({ settings: { fields: { footerNote: text() } } }), siteRoot));
	});

	test('the page\'s h1 is the first heading field in schema order with a non-empty value; none, no h1', () => {
		const fields: Fields = { kicker: text(), strap: text({ heading: true }), big: lockup({ style: 'display' }), other: text({ heading: true }) };
		const data = (raw: Record<string, unknown>) => parseFields(fields, raw);
		assert.equal(fieldsHeading(fields, data({ kicker: 'Not a heading', strap: 'Strap', big: ['Big'] })), 'strap', 'schema order, not the lockup first');
		assert.equal(fieldsHeading(fields, data({ strap: '', big: ['A', 'B'], other: 'Z' })), 'big', 'an empty one passes the h1 on');
		assert.equal(fieldsHeading(fields, data({ strap: '', big: ['', ' '], other: 'Z' })), 'other');
		assert.equal(fieldsHeading(fields, data({ kicker: 'Only a plain text field' })), null);
		assert.equal(fieldsHeading({ a: text(), b: select({ options: ['x'] }) }, { a: 'x', b: 'x' }), null, 'no heading field at all');
	});

	test('the shared block counts for the page\'s h1 by the block it resolves to, as the page\'s only block', () => {
		const page: SiteDocument = parseDocument({ title: 'P', blocks: [{ type: 'text', heading: '', body: 'x' }, { shared: 'footer' }, { type: 'hero', heading: ['Later'], intro: '' }] }, fixtureSite);
		assert.equal(firstHeadingIndex(page, fixtureSite), 2, 'an unresolved shared entry has no heading');
		const resolved = new Map<number, DocumentBlock>([[1, parseBlock({ type: 'cta', heading: ['Got', 'Something'], text: '' }, 1, fixtureSite)]]);
		assert.equal(firstHeadingIndex(page, fixtureSite, resolved), 1);
		const contexts = blockContexts(page, fixtureSite, false, undefined, resolved);
		assert.deepEqual(contexts.map((c) => c?.h1Field ?? null), [null, 'heading', null]);
	});

	test('posts and tags (Decision 13): a section builder\'s listing carries its page-field columns\' values, as raw as a list of fields\' do; without page-field columns, none', async () => {
		const root = mkdtempSync(join(tmpdir(), 'caracms-notes-'));
		try {
			cpSync(siteRoot, root, { recursive: true });
			mkdirSync(join(root, 'content/notes'), { recursive: true });
			writeFileSync(join(root, 'content/notes/a.json'), JSON.stringify({ title: 'A', date: '2026-03-01', tags: ['about', 'gone'], lead: 'about', blocks: [] }));
			writeFileSync(join(root, 'content/notes/b.json'), JSON.stringify({ title: 'B', blocks: [] }));
			const notes = (columns?: string[]) =>
				resolveSite(
					{
						...(config as SiteConfig),
						collections: { ...(config as SiteConfig).collections, notes: { kind: 'sections', folder: 'content/notes', urlBase: '/notes/', fields: { date: date(), tags: list(reference({ to: 'pages' })), lead: reference({ to: 'pages' }) }, columns } as never },
						textStyles: { display: { ...display, fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') } } },
					},
					root,
				);
			const listed = async (columns?: string[]) => Object.fromEntries((await listDocuments(notes(columns), 'notes')).map((d) => [d.path, d.columns ?? null]));
			assert.deepEqual(await listed(['date', 'tags', 'lead', 'edited']), {
				a: { date: '2026-03-01', tags: ['about', 'gone'], lead: 'about' },
				b: { date: null, tags: [], lead: null },
			});
			assert.deepEqual(await listed(['edited']), { a: null, b: null });
			assert.deepEqual(await listed(), { a: null, b: null });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('order: the collection\'s level and the render\'s documents() follow alphabetical by title, not by file name', async () => {
		const root = mkdtempSync(join(tmpdir(), 'caracms-order-'));
		try {
			cpSync(siteRoot, root, { recursive: true });
			mkdirSync(join(root, 'content/case-studies'), { recursive: true });
			for (const [file, title] of [['a-zebra', 'Zebra Crossing'], ['b-apple', 'apple orchard'], ['c-mango', 'Mango']]) {
				writeFileSync(join(root, `content/case-studies/${file}.json`), JSON.stringify({ title }));
			}
			const site = resolveSite(
				{
					...(config as SiteConfig),
					collections: { ...(config as SiteConfig).collections, 'case-studies': { ...cs, label: 'Case studies' } as never },
					textStyles: { display: { ...display, fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') } } },
				},
				root,
			);
			assert.deepEqual((await listDocuments(site, 'case-studies')).map((d) => d.path), ['b-apple', 'c-mango', 'a-zebra']);
			const reader = documentReader(site, diskSource);
			assert.deepEqual((await reader.documents('case-studies')).map((d) => d.path), ['b-apple', 'c-mango', 'a-zebra']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ── Decision 8: shared blocks ──

describe('Decision 8: shared blocks', () => {
	test('the entry naming a missing or unknown-typed shared block is kept in the file, byte for byte, through edits and moves', () => {
		const base = `{
  "title": "About",
  "blocks": [
    { "type": "hero", "heading": ["Hi"], "intro": "x" },
    { "shared": "nowhere" },
    {"shared":"odd",  "note": "kept"},
    { "type": "cta", "heading": ["Go"], "text": "t", "button": "b" }
  ]
}
`;
		const { document } = parseDocumentText(base, fixtureSite);
		assert.deepEqual(document.blocks.map((b) => b.shared ?? null), [null, 'nowhere', 'odd', null]);
		assert.equal(applyEdits(base, structuredClone(document), fixtureSite), base);
		const edited = structuredClone(document);
		edited.title = 'About us';
		edited.blocks[0]!.data.intro = 'changed';
		let out = applyEdits(base, edited, fixtureSite);
		assert.ok(out.includes('{ "shared": "nowhere" }') && out.includes('{"shared":"odd",  "note": "kept"}'));
		// Moved (the hero to the end) they still read the same.
		const moved = structuredClone(document);
		moved.blocks.push(moved.blocks.shift()!);
		out = applyEdits(base, moved, fixtureSite);
		assert.ok(out.includes('{ "shared": "nowhere" }') && out.includes('{"shared":"odd",  "note": "kept"}'));
		assert.deepEqual(parseDocumentText(out, fixtureSite).document.blocks.map((b) => b.shared ?? b.type), ['nowhere', 'odd', 'cta', 'hero']);
	});

	test('shared blocks don\'t nest: a shared file whose block is itself a shared entry is skipped, never rendered', async () => {
		const t = makeCreateSite({ link: false });
		try {
			writeFileSync(join(t.root, 'content/shared/loop.json'), '{ "title": "Loop", "block": { "shared": "footer" } }\n');
			const reader = documentReader(t.site, diskSource);
			const entry = parseBlock({ shared: 'loop' }, 0, t.site);
			const r = await resolveShared(entry, reader);
			assert.ok('skip' in r && r.skip === 'unknown-type', JSON.stringify(r));
		} finally {
			t.cleanup();
		}
	});

	test('"used on" counts documents of every collection, and a delete is refused naming them all', async () => {
		const t = makeCreateSite({ link: false });
		try {
			// Journal's Apples also uses the footer; Home and About already do.
			const file = join(t.root, 'content/journal/apples.json');
			const apples = JSON.parse(readFileSync(file, 'utf8'));
			apples.blocks.push({ shared: 'footer' });
			writeFileSync(file, `${JSON.stringify(apples, null, 2)}\n`);
			const footer = (await listDocuments(t.site)).find((d) => d.collection === 'shared' && d.path === 'footer')!;
			assert.deepEqual(footer.usedOn!.map((u) => `${u.collection}/${u.path}`).sort(), ['journal/apples', 'pages/about', 'pages/index']);

			const store = localDraftsStore(t.site);
			const post = async (route: 'delete', body: unknown) =>
				handleDelete(new Request('http://localhost:4326/_caracms/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), store);
			const refused = await post('delete', { collection: 'shared', path: 'footer' });
			assert.equal(refused.status, 409);
			const body = (await refused.json()) as CreateDeleteRefusal;
			assert.equal(body.code, 'in-use');
			assert.deepEqual(body.usedOn!.map((u) => `${u.collection}/${u.path}`).sort(), ['journal/apples', 'pages/about', 'pages/index']);
			// The last user lets go, and it can go. (A page using it twice counts once.)
			for (const f of ['content/journal/apples.json', 'content/pages/index.json', 'content/pages/about.json']) {
				const p = join(t.root, f);
				const doc = JSON.parse(readFileSync(p, 'utf8'));
				doc.blocks = doc.blocks.filter((b: { shared?: string }) => b.shared !== 'footer');
				writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
			}
			const ok = await post('delete', { collection: 'shared', path: 'footer' });
			assert.equal(ok.status, 200, await ok.clone().text());
		} finally {
			t.cleanup();
		}
	});

	test('the reserved names are refused as collections and as the shared folder\'s neighbours', () => {
		for (const name of ['shared', 'settings']) {
			assert.throws(() => resolveSite(variant({ collections: { ...config.collections, [name]: { kind: 'sections', folder: `content/${name}-x`, urlBase: `/${name}/` } as never } }), siteRoot), /package's own collections/, name);
			assert.throws(
				() => resolveSite(variant({ collections: { ...config.collections, [name]: { kind: 'fields', folder: `content/${name}-x`, urlBase: `/${name}/`, component: 'Block.astro', fields: {} } as never } }), siteRoot),
				/package's own collections/,
				`${name} as a list of fields`,
			);
		}
	});
});

// ── Decision 9: the render reads other documents ──

describe('Decision 9: a render\'s reads', () => {
	test('the build reads the disk; a preview hands the render its store\'s source (per request, never module state)', () => {
		assert.equal(renderSourceOf(undefined), diskSource);
		assert.equal(renderSourceOf({}), diskSource);
		const locals = {};
		const store = { readText: async () => null, listJson: async () => [] };
		setRenderSource(locals, store as never);
		assert.equal(renderSourceOf(locals), store);
		assert.equal(renderSourceOf({}), diskSource, 'another request is unaffected');
	});

	test('a reference to a missing document is null in a single reference and in a list of them, indexes kept', async () => {
		const exists = async (collection: string, path: unknown) => collection === 'journal' && path === 'apples';
		const out = await resolveRefs(
			{ lead: reference({ to: 'journal' }), more: list(reference({ to: 'journal' })), rows: list({ pick: reference({ to: 'journal' }), note: text() }), other: text() },
			{ lead: 'gone', more: ['apples', 'gone', 'apples'], rows: [{ pick: 'gone', note: 'n' }, { pick: 'apples', note: 'm' }], other: 'x' },
			exists,
		);
		assert.deepEqual(out, { lead: null, more: ['apples', null, 'apples'], rows: [{ pick: null, note: 'n' }, { pick: 'apples', note: 'm' }], other: 'x' });
		assert.equal((await resolveRefs({ lead: reference({ to: 'journal' }) }, { lead: 'apples' }, exists)).lead, 'apples');
	});

	test('documents that read a collection read the same parse on both paths: disk, and any other source over the same files', async () => {
		const t = makeCreateSite({ link: false });
		try {
			const fromDisk = await documentReader(t.site, diskSource).documents('case-studies');
			const text = (f: string) => readFileSync(join(t.root, f), 'utf8');
			const files = new Map([['content/case-studies/high-street-coffee.json', text('content/case-studies/high-street-coffee.json')]]);
			const { filesSource } = await import('../src/content.ts');
			const fromFiles = await documentReader(t.site, filesSource(t.root, () => files)).documents('case-studies');
			assert.deepEqual(fromFiles.map((d) => [d.path, d.title, d.url, d.data]), fromDisk.map((d) => [d.path, d.title, d.url, d.data]));
		} finally {
			t.cleanup();
		}
	});
});

// ── Decision 10: Site Settings' brand and editors ──

describe('Decision 10: the brand applies from the committed file; local mode reads the disk on every call', () => {
	let root: string;
	let site: ResolvedSite;
	const env = { ...process.env };
	before(() => {
		for (const key of Object.keys(process.env)) if (/^(CARACMS_|GITHUB_|RAILWAY_)/.test(key)) delete process.env[key];
		resetEditorMode();
		root = mkdtempSync(join(tmpdir(), 'caracms-brand-'));
		cpSync(siteRoot, root, { recursive: true });
		site = resolveSite(
			{
				...(config as SiteConfig),
				textStyles: { display: { ...display, fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') } } },
			},
			root,
		);
	});
	after(() => {
		Object.assign(process.env, env);
		resetEditorMode();
		rmSync(root, { recursive: true, force: true });
	});

	test('no file: "Site" and the neutral accent; a file: its name and accent; the next request sees an edit', async () => {
		const none = await currentBrand(site);
		assert.equal(none.name, 'Site');
		assert.equal(none.logo, undefined, 'no logo: the config\'s are refused (M5b Decision 11) and Site Settings names none');
		const neutral = none.accent;
		mkdirSync(join(root, 'content'), { recursive: true });
		writeFileSync(join(root, SITE_SETTINGS_FILE), '{ "title": "Site Settings", "brand": { "name": "CaraCMS", "accent": "#1f3a2e" } }\n');
		assert.deepEqual(await currentBrand(site), { name: 'CaraCMS', accent: '#1f3a2e' });
		writeFileSync(join(root, SITE_SETTINGS_FILE), '{ "title": "Site Settings", "brand": { "name": "CaraCMS", "accent": "#336699" } }\n');
		assert.equal((await currentBrand(site)).accent, '#336699');
		assert.equal((await currentBrand(site)).name, 'CaraCMS');
		writeFileSync(join(root, SITE_SETTINGS_FILE), '{ "title": "Site Settings", "brand": { "name": "", "accent": "not a colour" } }\n');
		const bad = await currentBrand(site);
		assert.equal(bad.name, 'Site');
		assert.equal(bad.accent, neutral);
	});

	test('the editors list is checked with the whitelist\'s own rules (one function, shared by the form and the server)', () => {
		assert.equal(fromAllow, fromRules);
		assert.deepEqual(fromRules('Niamh@Example.com '), { kind: 'address', value: 'niamh@example.com' });
		assert.deepEqual(fromRules('@example.com'), { kind: 'domain', value: 'example.com' });
		assert.equal(fromRules('@gmail.com').kind, 'public-domain');
		assert.equal(fromRules('ciaran@site').kind, 'invalid');
		assert.equal(fromRules('not an address').kind, 'invalid');
		assert.equal(fromRules(42).kind, 'invalid');
	});
});

// ── Decision 11: creating on disk, the rules the other tests don't reach ──

describe('Decision 11: addresses and where a create may go', () => {
	let t: ReturnType<typeof makeCreateSite>;
	before(() => {
		t = makeCreateSite({ link: false });
	});
	after(() => t.cleanup());
	const create = (body: unknown) =>
		handleCreate(new Request('http://localhost:4326/_caracms/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), localDraftsStore(t.site));

	test('a page exactly at another collection\'s base is allowed (a Journal page at /journal); one strictly below is not', async () => {
		const exact = await create({ collection: 'pages', path: 'journal', title: 'Journal' });
		assert.equal(exact.status, 200, await exact.clone().text());
		assert.equal(((await exact.json()) as { url: string }).url, '/journal');
		const below = await create({ collection: 'pages', path: 'journal/extra', title: 'Extra' });
		assert.equal(below.status, 400);
		assert.equal(((await below.json()) as CreateDeleteRefusal).code, 'below-collection');
		// The same at the Case studies' base (/work/), where a hand-made /work page already stands.
		assert.equal(((await create({ collection: 'pages', path: 'work', title: 'Work' })) as Response).status, 409, 'the base itself is a page that exists');
		assert.equal((await create({ collection: 'pages', path: 'work/x', title: 'X' })).status, 400);
		// A flat collection's own base is fine for its own documents.
		assert.equal((await create({ collection: 'case-studies', path: 'one-more', title: 'One more' })).status, 200);
	});

	test('a 60-character part is allowed, a 61-character one is not; a part with a capital or an underscore is not', async () => {
		assert.equal((await create({ collection: 'journal', path: 'a'.repeat(60), title: 'Long' })).status, 200);
		for (const path of ['a'.repeat(61), 'Capital', 'under_score', 'two  spaces', 'trailing-']) {
			const r = await create({ collection: 'journal', path, title: 'X' });
			assert.equal(r.status, 400, path);
			assert.equal(((await r.json()) as CreateDeleteRefusal).code, 'bad-name', path);
		}
	});

	test('a title that is only symbols leaves no address and says so in the field\'s words', async () => {
		const only = await create({ collection: 'pages', path: '', title: '?! …' });
		assert.equal(only.status, 400);
		assert.match(((await only.json()) as CreateDeleteRefusal).error, /no letters or numbers/);
	});
});

// ── Decisions 7, 8 and 10: the editor's document store holds every kind of document ──

describe('the document store: a shared entry on a page, a fields document\'s form, Site Settings', () => {
	const entryFor = (collection: string, path: string, kind: 'sections' | 'fields' | 'shared' | 'settings') =>
		({ collection, path, file: `content/${collection}/${path}.json`, url: kind === 'sections' ? '/x' : null, title: 'T', label: 'T', warning: null, kind }) as never;

	test('a shared entry is added as `{ "shared": name }`, moved and removed like a block, and never edited on the page', () => {
		const pageText = '{\n  "title": "About",\n  "blocks": [\n    { "type": "hero", "heading": ["Hi"], "intro": "x" },\n    { "type": "cta", "heading": ["Go"], "text": "t", "button": "b" }\n  ]\n}\n';
		const store = createDocumentStore(fixtureSite, { ref: { collection: 'pages', path: 'about' }, entry: entryFor('pages', 'about', 'sections'), base: pageText, document: parseDocumentText(pageText, fixtureSite).document });
		const start = store.wire();
		const key = store.addShared('footer', 1);
		const added = store.block(key)!;
		assert.deepEqual([added.shared, added.known, added.source, store.indexOf(key)], ['footer', false, null, 1]);
		const out = applyEdits(pageText, store.wire() as SiteDocument, fixtureSite);
		assert.ok(out.includes('{ "shared": "footer" }'), out);
		assert.deepEqual(parseDocumentText(out, fixtureSite).document.blocks.map((b) => b.shared ?? b.type), ['hero', 'footer', 'cta']);
		// Never edited here: a field set on it changes nothing.
		const revision = store.get().revision;
		store.setField(key, 'shared', 'other');
		store.setField(key, 'heading', 'x');
		assert.equal(store.get().revision, revision);
		assert.equal(store.block(key)!.shared, 'footer');
		// Moved and removed like a block, with Undo.
		store.moveBlock(key, 2);
		assert.equal(store.indexOf(key), 2);
		const undo = store.removeBlock(key)!;
		assert.equal(store.indexOf(key), -1);
		assert.equal(store.undo(), undo);
		assert.equal(store.indexOf(key), 2);
		store.removeBlock(key);
		assert.deepEqual(store.wire(), start);
		assert.equal(applyEdits(pageText, store.wire() as SiteDocument, fixtureSite), pageText);
	});

	test('a fields document is one form: a field by path sets the document\'s data; blocks can\'t be added, moved or removed', () => {
		const fields: Fields = { client: text(), credits: list({ role: text(), name: text() }) };
		const collection = { kind: 'fields' as const, fields };
		const base = '{\n  "title": "Harbour",\n  "client": "H",\n  "credits": [{ "role": "A", "name": "B" }, { "role": "C", "name": "D" }],\n  "extra": 1\n}\n';
		const document = parseAnyDocument(JSON.parse(base), fixtureSite, collection) as FieldsDocument;
		const store = createDocumentStore(fixtureSite, { ref: { collection: 'case-studies', path: 'harbour' }, entry: entryFor('case-studies', 'harbour', 'fields'), base, document });
		const key = formKey(store.get())!;
		assert.ok(key);
		store.setField(key, 'credits.1.name', 'Dara');
		store.addBlock('text');
		store.moveBlock(key, 3);
		assert.equal(store.get().document.blocks.length, 1, 'a form is one block, always');
		store.setTitle('High-street coffee roaster');
		const wire = store.wire() as FieldsDocument;
		assert.equal(wire.kind, 'fields');
		assert.equal(wire.title, 'High-street coffee roaster');
		assert.deepEqual(wire.data.credits, [{ role: 'A', name: 'B' }, { role: 'C', name: 'Dara' }]);
		const out = applyKeyedEdits(base, wire, collection);
		assert.ok(out.includes('"title": "High-street coffee roaster"') && out.includes('"client": "H"') && out.includes('"extra": 1'), out);
		assert.equal(JSON.parse(out).credits[1].name, 'Dara');
		// Removing a row is Undoable, as a block is (Decision 14).
		store.removeItem(key, 'credits', 0);
		assert.equal((((store.wire() as FieldsDocument).data.credits) as unknown[]).length, 1);
		store.undo();
		assert.equal((((store.wire() as FieldsDocument).data.credits) as unknown[]).length, 2);
	});

	test('Site Settings: brand and editors are set through the form and come back in the settings shape', () => {
		const collection = fixtureSite.collections.settings!;
		const base = '{\n  "title": "Site Settings",\n  "editors": ["niamh@example.com"],\n  "brand": { "name": "CaraCMS", "accent": "#1f3a2e" }\n}\n';
		const document = parseAnyDocument(JSON.parse(base), fixtureSite, collection) as SettingsDocument;
		const store = createDocumentStore(fixtureSite, { ref: { collection: 'settings', path: 'site-settings' }, entry: entryFor('settings', 'site-settings', 'settings'), base, document });
		const key = formKey(store.get())!;
		store.setField(key, 'brand.accent', '#336699');
		store.setField(key, 'editors', ['niamh@example.com', '@gmail.com']);
		const wire = store.wire() as SettingsDocument;
		assert.equal(wire.kind, 'settings');
		assert.deepEqual(wire.data.brand, { name: 'CaraCMS', accent: '#336699', logo: null, icon: null });
		// An entry that breaks the whitelist's rules is kept as typed (Decision 15).
		assert.deepEqual(wire.data.editors, ['niamh@example.com', '@gmail.com']);
		const out = applyDocumentEdits(base, wire, fixtureSite, collection);
		assert.deepEqual(JSON.parse(out).editors, ['niamh@example.com', '@gmail.com']);
		assert.equal(JSON.parse(out).brand.accent, '#336699');
		assert.equal(JSON.parse(out).brand.name, 'CaraCMS');
	});

	test('a shared block\'s own document is its one block, in the shared shape', () => {
		const collection = fixtureSite.collections.shared!;
		const base = '{\n  "title": "Footer",\n  "block": {\n    "type": "cta",\n    "heading": ["Go"],\n    "text": "t",\n    "button": "b"\n  }\n}\n';
		const document = parseAnyDocument(JSON.parse(base), fixtureSite, collection) as SharedDocument;
		const store = createDocumentStore(fixtureSite, { ref: { collection: 'shared', path: 'footer' }, entry: entryFor('shared', 'footer', 'shared'), base, document });
		const key = formKey(store.get())!;
		assert.equal(store.block(key)!.type, 'cta');
		store.setField(key, 'text', 'new');
		const wire = store.wire() as SharedDocument;
		assert.equal(wire.kind, 'shared');
		assert.equal(wire.block.type, 'cta');
		assert.match(applyDocumentEdits(base, wire, fixtureSite, collection), /"text": "new"/);
	});
});
