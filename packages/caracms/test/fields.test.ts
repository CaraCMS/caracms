// M5a's fields (Decision 2): each one's value, parse (never throws) and write, the
// config's validation of them, warnings, render values, marker paths (Decision 16),
// and a hand-written file with every field that writes back with no diff.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
	buttons,
	date,
	fieldAtPath,
	fieldToJson,
	fieldWarnings,
	getAtPath,
	group,
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
	setAtPath,
	text,
	toggle,
	type Field,
	type SiteConfig,
} from '../src/config.ts';
import { parseDocumentText, type SiteDocument } from '../src/document.ts';
import { createDocumentStore } from '../src/editor/client/state/document-store.ts';
import { parseSource, slice, type ArrayNode, type ObjectNode } from '../src/json-source.ts';
import { applyEdits, fieldText } from '../src/serialize.ts';
import { fixtures, siteRoot, variant } from './helpers/site.ts';

const everything = {
	component: 'Block.astro',
	fields: {
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
	},
};
const site = resolveSite(variant({ blocks: { everything } }), siteRoot);
const fields = site.blocks.everything!.fields;
const base = readFileSync(`${fixtures}every-field.json`, 'utf8');
const read = (): SiteDocument => structuredClone(parseDocumentText(base, site).document);

/** Each block's members as their exact source text, keyed by member. */
function memberTexts(textIn: string): Record<string, string>[] {
	const source = parseSource(textIn);
	const blocks = (source.root as ObjectNode).members.find((m) => m.key === 'blocks')!.value as ArrayNode;
	return blocks.items.map((b) => Object.fromEntries((b as ObjectNode).members.map((m) => [m.key, slice(source, m.value)])));
}

describe('each field: parse, write, wrong shapes', () => {
	test('link: { label, href }; trimmed; a wrong shape is empty', () => {
		const f = link();
		assert.deepEqual(parseField(f, { href: ' /work ', label: 'See the work', extra: 1 }), { label: 'See the work', href: '/work' });
		assert.deepEqual(fieldToJson(f, { href: '/work', label: 'See' }), { label: 'See', href: '/work' });
		for (const raw of [undefined, null, 'x', 3, ['a']]) assert.deepEqual(parseField(f, raw), { label: '', href: '' });
		// A link failing the rule is kept as typed (Decision 15).
		assert.deepEqual(parseField(f, { label: 'x', href: 'nope' }), { label: 'x', href: 'nope' });
	});

	test('buttons: [{ label, href, style }]; an unknown style falls back to the first; non-objects dropped', () => {
		const f = buttons({ styles: ['primary', 'secondary'] });
		assert.equal(f.max, 2);
		assert.deepEqual(parseField(f, [{ style: 'secondary', label: 'B', href: '/b' }, 'junk', { label: 'C', style: 'loud' }]), [
			{ label: 'B', href: '/b', style: 'secondary' },
			{ label: 'C', href: '', style: 'primary' },
		]);
		assert.deepEqual(fieldToJson(f, [{ style: 'secondary', href: '/b', label: 'B' }]), [{ label: 'B', href: '/b', style: 'secondary' }]);
		for (const raw of [undefined, null, 'x', {}]) assert.deepEqual(parseField(f, raw), []);
	});

	test('toggle: true / false, its default otherwise', () => {
		assert.equal(parseField(toggle(), true), true);
		assert.equal(parseField(toggle(), 'true'), false);
		assert.equal(parseField(toggle({ default: true }), undefined), true);
		assert.equal(fieldToJson(toggle(), false), false);
	});

	test('number: a JSON number or null; out of range is kept as typed', () => {
		const f = number({ min: 1, max: 10, step: 1 });
		assert.equal(parseField(f, 4), 4);
		assert.equal(parseField(f, 12), 12);
		for (const raw of [undefined, null, '4', Number.NaN, Infinity, {}]) assert.equal(parseField(f, raw), null);
		assert.equal(fieldToJson(f, null), null);
		assert.equal(fieldToJson(f, 12), 12);
	});

	test('date: "YYYY-MM-DD" when it is a real day, else null; no zone handling', () => {
		assert.equal(parseField(date(), '2026-10-15'), '2026-10-15');
		for (const raw of ['2026-02-30', '15/10/2026', '2026-10-15T10:00', 20261015, undefined, null]) assert.equal(parseField(date(), raw), null, String(raw));
		assert.equal(fieldToJson(date(), '2024-05-02'), '2024-05-02');
	});

	test('reference: the document\'s path, or null', () => {
		const f = reference({ to: 'journal' });
		assert.equal(parseField(f, 'high-street-coffee'), 'high-street-coffee');
		for (const raw of ['', '  ', 3, undefined]) assert.equal(parseField(f, raw), null);
	});

	test('list of one field: a flat array, each item parsed by the field; written on one line', () => {
		const f = list(text());
		assert.deepEqual(parseField(f, [' a ', 'b', 3]), ['a', 'b', '']);
		assert.deepEqual(parseField(f, 'x'), []);
		assert.equal(fieldText(f, ['niamh@example.com', '@example.com'], 1), '["niamh@example.com", "@example.com"]');
	});

	test('list of several fields: objects with keys in schema order, each item on its own lines', () => {
		const f = list({ role: text(), name: text() });
		// M7 (Acceptance 10): an item's unknown key is kept, after the schema's keys.
		assert.deepEqual(parseField(f, [{ name: 'Aoife', role: 'Identity', x: 1 }, 'junk', {}]), [
			{ role: 'Identity', name: 'Aoife', x: 1 },
			{ role: '', name: '' },
		]);
		assert.equal(
			fieldText(f, [{ name: 'Aoife', role: 'Identity' }], 3),
			['[', '        {', '          "role": "Identity",', '          "name": "Aoife"', '        }', '      ]'].join('\n'),
		);
	});

	test('rich text: written one block per line, a list\'s items on its line', () => {
		const f = richText({ headings: ['h2'] });
		const value = parseField(f, [{ p: 'One *two*' }, { h2: 'A\nB' }, { ul: ['x', 'y'] }]);
		assert.equal(fieldText(f, value, 3), ['[', '        { "p": "One *two*" },', '        { "h2": "A\\nB" },', '        { "ul": ["x", "y"] }', '      ]'].join('\n'));
		assert.equal(fieldText(f, [], 3), '[]');
	});

	test('rich text: a string read as rich text, literal, written in the list form once edited', () => {
		const f = richText();
		assert.deepEqual(fieldToJson(f, 'Old * text\n\nSecond'), [{ p: 'Old \\* text' }, { p: 'Second' }]);
	});
});

describe('the config validates the new fields', () => {
	const withField = (field: unknown) => variant({ blocks: { x: { component: 'Block.astro', fields: { f: field as Field } } } }) as SiteConfig;
	const refuses = (field: unknown, message: RegExp) => assert.throws(() => resolveSite(withField(field), siteRoot), message);

	test('every new kind is accepted', () => {
		for (const field of [richText(), richText({ headings: ['h2'] }), richText({ headings: ['h2', 'h3'] }), link(), buttons({ styles: ['a'] }), toggle(), number({ min: 0 }), date(), list(text()), list({ a: text(), b: richText() }), reference({ to: 'pages' })]) {
			assert.doesNotThrow(() => resolveSite(withField(field), siteRoot), JSON.stringify(field));
		}
	});

	test('an unknown kind is refused', () => refuses({ kind: 'colour' }, /isn't a field the package knows/));
	test('M7 Decision 14: a list of several fields can hold a list, of one field or of several', () => {
		for (const field of [list({ label: text(), links: list(link()) }), list({ heading: text(), rows: list({ name: text(), href: link({ addressOnly: true }) }) })]) {
			assert.doesNotThrow(() => resolveSite(withField(field), siteRoot), JSON.stringify(field));
		}
	});
	test('M7 Acceptance 5: a list in an inner list, a list in a group in an inner list and list(list(…)) are refused, naming the field', () => {
		refuses(list({ a: list({ b: list(text()) }) }), /field "f", item field "a", item field "b": a list inside a list can't contain a list/);
		refuses(list({ a: list({ g: group({ b: list(text()) }) }) }), /item field "a", item field "g", group field "b": a list inside a list can't contain a list/);
		refuses(list({ a: list(list(text())) }), /item field "a": a list of one field can't be of a list|item field "a"'s item: a list/);
		refuses(list(list(text())), /field "f"'s item: a list of one field can't be of a list/);
	});
	test('reference({ to }) must name a collection that exists', () => refuses(reference({ to: 'case-studies' }), /must name one of the site's collections/));
	test("richText headings: ['h3'] alone is refused, and anything but h2/h3", () => {
		refuses(richText({ headings: ['h3'] }), /richText headings must be \['h2'\] or \['h2', 'h3'\]/);
		refuses({ ...richText(), headings: ['h1'] }, /richText headings/);
	});
	test('a lockup inside a list still needs its text style', () => refuses(list({ h: lockup({ style: 'nope' }) }), /text style "nope"/));
	test('number: min above max; buttons: max below 1; list: an itemLabel that isn\'t an item field', () => {
		refuses(number({ min: 5, max: 1 }), /min \(5\) is above max \(1\)/);
		refuses({ ...buttons({ styles: ['a'] }), max: 0 }, /max must be a whole number/);
		refuses(list({ a: text() }, { itemLabel: 'b' }), /itemLabel "b"/);
	});
	test('a field name with a dot is refused (dots separate a path)', () => {
		assert.throws(() => resolveSite(variant({ blocks: { x: { component: 'Block.astro', fields: { 'a.b': text() } } } }), siteRoot), /has a "\." in its name/);
	});
	test('labels are filled in, inside lists too', () => {
		const credits = fields.credits as Extract<Field, { kind: 'list' }>;
		assert.equal(credits.label, 'Credits');
		assert.equal(credits.fields!.role!.label, 'Role');
	});
});

describe('warnings (kept as typed, flagged on the field)', () => {
	test('rich text: a disallowed kind, a link with links off, a link failing the rule, a missing internal path', () => {
		const w = fieldWarnings(richText({ headings: ['h2'] }), [{ h3: 'x' }, { p: '[a](nope) [b](/gone) [c](/about)' }], { addresses: ['/', '/about'] });
		assert.deepEqual(
			w.map((x) => [x.path, x.code]),
			[
				['0', 'disallowed-kind'],
				['', 'link-rule'],
				['', 'link-missing'],
			],
		);
		assert.match(w[0]!.message, /shows as a paragraph/);
		assert.equal(w[2]!.message, "Links to /gone, which no page or route serves.");
		assert.deepEqual(
			fieldWarnings(richText({ links: false }), [{ p: '[a](/x)' }]).map((x) => x.code),
			['link-off'],
		);
	});

	test('link and buttons: half of one, the rule, too many', () => {
		assert.deepEqual(
			fieldWarnings(link(), { label: 'Only words', href: '' }).map((x) => x.code),
			['half-link'],
		);
		assert.deepEqual(
			fieldWarnings(link(), { label: 'x', href: 'nope' }).map((x) => [x.path, x.code]),
			[['href', 'link-rule']],
		);
		const b = fieldWarnings(buttons({ styles: ['a'], max: 1 }), [{ label: 'A', href: '/a' }, { label: 'Half' }]);
		assert.deepEqual(
			b.map((x) => [x.path, x.code]),
			[
				['1', 'half-link'],
				['', 'too-many'],
			],
		);
		assert.equal(b[0]!.message, 'Button 2 shows only once it has both a label and a link.');
	});

	test('number out of range; an unreadable value; a missing reference; paths inside lists', () => {
		assert.deepEqual(
			fieldWarnings(number({ min: 1, max: 10 }), 12).map((x) => [x.code, x.message]),
			[['out-of-range', 'Enter a number between 1 and 10. Until then the page shows its default.']],
		);
		assert.deepEqual(
			fieldWarnings(date(), '15/10/2026').map((x) => x.code),
			['unreadable'],
		);
		const exists = (collection: string, path: string) => collection === 'journal' && path === 'my-first-post';
		assert.deepEqual(
			fieldWarnings(list(reference({ to: 'journal' })), ['my-first-post', 'gone'], { documentExists: exists }).map((x) => [x.path, x.code]),
			[['1', 'missing-reference']],
		);
		assert.deepEqual(
			fieldWarnings(list({ cta: link() }), [{ cta: { label: 'x', href: 'nope' } }]).map((x) => x.path),
			['0.cta.href'],
		);
	});

	test('no warnings for clean values, and none thrown for any junk', () => {
		for (const [key, field] of Object.entries(fields)) {
			for (const raw of [undefined, null, 0, 'x', [], {}, [null, 3, 'y', {}], { a: [1] }]) assert.doesNotThrow(() => fieldWarnings(field, raw), key);
		}
		assert.deepEqual(fieldWarnings(link(), { label: 'See', href: '/work' }), []);
	});
});

describe('the render\'s values (Decision 15)', () => {
	test('a number out of range reaches the block as null; inside a list too; the rest as parsed', () => {
		const out = renderData({ n: number({ max: 10 }), rows: list({ n: number({ min: 0 }) }), cta: link() }, { n: 12, rows: [{ n: -1 }, { n: 3 }], cta: { label: 'x', href: 'nope' } });
		assert.deepEqual(out, { n: null, rows: [{ n: null }, { n: 3 }], cta: { label: 'x', href: 'nope' } });
	});
});

describe('marker paths (Decision 16)', () => {
	test('fieldAtPath lands on the descriptor, with what\'s left of the path', () => {
		assert.equal(fieldAtPath(fields, 'credits.1.name')!.field.kind, 'text');
		assert.deepEqual(fieldAtPath(fields, 'credits.1.name')!.rest, []);
		assert.equal(fieldAtPath(fields, 'tags.0')!.field.kind, 'text');
		assert.deepEqual(fieldAtPath(fields, 'buttons.0.label'), { field: fields.buttons, rest: ['0', 'label'] });
		assert.deepEqual(fieldAtPath(fields, 'cta.label')!.rest, ['label']);
		assert.equal(fieldAtPath(fields, 'nope'), undefined);
		assert.equal(fieldAtPath(fields, 'credits.x.name'), undefined);
		assert.equal(fieldAtPath(fields, 'credits.0.nope'), undefined);
		assert.equal(fieldAtPath(fields, 'constructor'), undefined);
	});

	test('getAtPath / setAtPath copy only along the path', () => {
		const data = { credits: [{ role: 'a', name: 'b' }, { role: 'c', name: 'd' }], cta: { label: 'x', href: '/y' }, other: { deep: 1 } };
		const next = setAtPath(data, 'credits.1.name', 'Dara') as typeof data;
		assert.equal(getAtPath(next, 'credits.1.name'), 'Dara');
		assert.equal(data.credits[1]!.name, 'd', 'the original is untouched');
		assert.equal(next.credits[0], data.credits[0], 'off the path is shared');
		assert.equal(next.other, data.other);
		assert.deepEqual(setAtPath({}, 'buttons.0.label', 'Go'), { buttons: [{ label: 'Go' }] });
		assert.equal(getAtPath(data, 'credits.9.name'), undefined);
	});

	test('the document store sets a value by path, with Undo, and a top-level key as before', () => {
		const entry = { collection: 'pages', path: 'every', file: 'content/pages/every.json', url: '/every', title: 'Every field', label: 'Every field', warning: null };
		const store = createDocumentStore(site, { ref: { collection: 'pages', path: 'every' }, entry, base, document: read() });
		const key = store.get().document.blocks[0]!.key;
		const changes: unknown[] = [];
		store.subscribe((_, change) => changes.push(change));
		store.setField(key, 'credits.1.name', 'Dara W.', { undoLabel: 'Renamed' });
		assert.equal(getAtPath(store.block(key)!.data, 'credits.1.name'), 'Dara W.');
		assert.equal(getAtPath(store.block(key)!.data, 'credits.0.name'), 'Aoife');
		assert.deepEqual(changes.at(-1), { kind: 'field', key, field: 'credits.1.name', origin: 'sidebar' });
		store.setField(key, 'credits.1.name', 'Dara W.');
		assert.equal(store.get().revision, 1, 'an equal value is no change');
		store.undo();
		assert.equal(getAtPath(store.block(key)!.data, 'credits.1.name'), 'Dara');
		store.setField(key, 'featured', false);
		assert.equal(store.block(key)!.data.featured, false);
		store.setField(key, 'cta.label', 'See all the work');
		assert.deepEqual(store.block(key)!.data.cta, { label: 'See all the work', href: '/work' });
	});
});

describe('a hand-written file with every field (odd spacing, keys out of order, a stray asterisk)', () => {
	test('it parses: kept-as-typed values kept, wrong shapes empty', () => {
		const doc = read();
		const [a, b] = doc.blocks;
		assert.equal(a!.data.count, 12, 'out of range, kept as typed');
		assert.deepEqual(a!.data.credits, [
			{ role: 'Identity', name: 'Aoife' },
			{ role: 'Photography', name: 'Dara' },
		]);
		assert.deepEqual((a!.data.body as { runs?: unknown }[])[0], { kind: 'p', runs: [{ text: 'The roaster started as a cart on the quay. 5 * 3 is a stray asterisk.' }] });
		assert.deepEqual(a!.data.notes, [
			{ kind: 'p', runs: [{ text: 'An old text value with a * in it' }] },
			{ kind: 'p', runs: [{ text: 'and a second paragraph' }] },
		]);
		assert.equal(b!.data.count, null);
		assert.equal(b!.data.launched, null);
		assert.deepEqual(b!.data.cta, { label: '', href: '' });
	});

	test('with no edits, it writes back byte for byte', () => {
		assert.equal(applyEdits(base, read(), site), base);
	});

	test('the editor\'s own values (sent back as the preview and the keeper do) are no edit', () => {
		const doc = JSON.parse(JSON.stringify(read())) as SiteDocument;
		assert.equal(applyEdits(base, doc, site), base);
	});

	test('one edit to one field: that value changes, every other value keeps its exact text, the other block is untouched', () => {
		const doc = read();
		doc.blocks[0]!.data.count = 5;
		const out = applyEdits(base, doc, site);
		const before = memberTexts(base);
		const after = memberTexts(out);
		assert.equal(after[0]!.count, '5');
		for (const key of Object.keys(before[0]!)) if (key !== 'count') assert.equal(after[0]![key], before[0]![key], key);
		assert.deepEqual(after[1], before[1]);
		assert.equal(out.slice(0, out.indexOf('"blocks"')), base.slice(0, base.indexOf('"blocks"')), 'the title line as written');
		// The second block's raw text is byte for byte the same.
		const second = (t: string) => t.slice(t.indexOf('"heading": ["Second"]'));
		assert.equal(second(out), second(base));
	});

	test('an edit inside a list (credits.1.name): the list takes the schema\'s form, the rest as read', () => {
		const doc = read();
		doc.blocks[0]!.data = setAtPath(doc.blocks[0]!.data, 'credits.1.name', 'Dara W.') as Record<string, unknown>;
		const out = applyEdits(base, doc, site);
		const after = memberTexts(out)[0]!;
		const before = memberTexts(base)[0]!;
		assert.equal(
			after.credits,
			[
				'[',
				'        {',
				'          "role": "Identity",',
				'          "name": "Aoife"',
				'        },',
				'        {',
				'          "role": "Photography",',
				'          "name": "Dara W."',
				'        }',
				'      ]',
			].join('\n'),
		);
		for (const key of Object.keys(before)) if (key !== 'credits') assert.equal(after[key], before[key], key);
		assert.deepEqual(JSON.parse(out).blocks[0].extra, { kept: true }, 'an unknown key stays');
	});

	test('editing the plain-string rich text writes the list form, escaped, one block per line', () => {
		const doc = read();
		const notes = doc.blocks[0]!.data.notes as { kind: string; runs: { text: string }[] }[];
		notes[1]!.runs[0]!.text = 'and a second, edited paragraph';
		const out = applyEdits(base, doc, site);
		assert.equal(memberTexts(out)[0]!.notes, ['[', '        { "p": "An old text value with a \\\\* in it" },', '        { "p": "and a second, edited paragraph" }', '      ]'].join('\n'));
		assert.equal(memberTexts(out)[0]!.body, memberTexts(base)[0]!.body, 'the other rich text, with its stray asterisk, as read');
	});

	test('a new block writes every field, empty, in schema order', () => {
		const doc = read();
		doc.blocks.push({ source: null, type: 'everything', known: true, data: {} });
		const parsed = JSON.parse(applyEdits(base, doc, site));
		assert.deepEqual(parsed.blocks[2], {
			type: 'everything',
			heading: [],
			body: [],
			notes: [],
			cta: { label: '', href: '' },
			buttons: [],
			featured: false,
			count: null,
			launched: null,
			credits: [],
			tags: [],
			related: [],
			lead: null,
		});
	});
});

describe('a select still works beside them', () => {
	test('select parse is unchanged', () => {
		assert.equal(parseField(select({ options: ['a', 'b'] }), 'b'), 'b');
	});
});
