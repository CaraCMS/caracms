// The serializer (Decision 7; Phase 1 → Verify 3 and 5, and the change model Phase 4 relies on).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { emptyBlock, parseDocumentText, type SiteDocument } from '../src/document.ts';
import { applyEdits, applyKeyedEdits, savedForm, serializeDocument, toJson } from '../src/serialize.ts';
import { fixtures, site } from './helpers/site.ts';

const base = readFileSync(`${fixtures}round-trip.json`, 'utf8');
const read = () => structuredClone(parseDocumentText(base, site).document);

/** Lines that differ between two texts, as [line number, before, after]. */
function changedLines(a: string, b: string): number[] {
	const x = a.split('\n');
	const y = b.split('\n');
	const out: number[] = [];
	for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(i + 1);
	return out;
}

/** The raw text of each block in a file, in order. */
function blockTexts(text: string): string[] {
	const { source } = parseDocumentText(text, site);
	const root = source.root as import('../src/json-source.ts').ObjectNode;
	const blocks = root.members.find((m) => m.key === 'blocks')!.value as import('../src/json-source.ts').ArrayNode;
	return blocks.items.map((n) => text.slice(n.start, n.end));
}

describe('toJson (canonical form)', () => {
	test('two-space indent, one member per line, string arrays on one line', () => {
		assert.equal(
			toJson({ title: 'Home', heading: ['Play Hard', 'Work Hard'], nested: { a: 1, b: [] }, list: [{ x: true }] }),
			[
				'{',
				'  "title": "Home",',
				'  "heading": ["Play Hard", "Work Hard"],',
				'  "nested": {',
				'    "a": 1,',
				'    "b": []',
				'  },',
				'  "list": [',
				'    {',
				'      "x": true',
				'    }',
				'  ]',
				'}',
			].join('\n'),
		);
	});

	test('strings are JSON-escaped, non-ASCII kept as is', () => {
		assert.equal(toJson(['a "quote"\nnext', 'Ciarán ✨']), '["a \\"quote\\"\\nnext", "Ciarán ✨"]');
	});
});

describe('applyEdits', () => {
	test('the fixture parses with its unknowns: an unknown block kept in place, unknown fields not in data', () => {
		const doc = read();
		assert.deepEqual(
			doc.blocks.map((b) => [b.source, b.type, b.known]),
			[
				[0, 'gallery', false],
				[1, 'hero', true],
				[2, 'text', true],
				[3, 'cta', true],
			],
		);
		assert.equal(doc.blocks[1]!.data.intro, 'Keys out of order, and a trailing space.'); // trimmed by the parse
		assert.equal('flourish' in doc.blocks[1]!.data, false);
		assert.equal(doc.blocks[1]!.data.layout, 'left'); // missing in the file: the default
		assert.deepEqual(doc.blocks[3]!.data.heading, {
			lines: ['Building a better mousetrap', 'For You'],
			phone: ['Building a', 'better mousetrap', 'For You'],
		});
	});

	test('no changes: byte-identical (unknown block, unknown field, keys out of order, the trailing space)', () => {
		assert.equal(applyEdits(base, read(), site), base);
	});

	test('no changes, a file in another layout: byte-identical too', () => {
		const odd = '{"title":"Odd",   "blocks":[{"type":"text","heading":" x ","body":"","background":"light"}]}';
		const doc = parseDocumentText(odd, site).document;
		assert.equal(applyEdits(odd, doc, site), odd);
	});

	test('sending the parsed (trimmed) value back is not an edit: the trailing space stays', () => {
		const doc = read();
		doc.blocks[1]!.data.intro = 'Keys out of order, and a trailing space.';
		assert.equal(applyEdits(base, doc, site), base);
	});

	test('one field of one block: only that block\'s lines change, its keys in schema order, unknown keys after', () => {
		const doc = read();
		doc.blocks[1]!.data.intro = 'A new intro';
		const out = applyEdits(base, doc, site);
		const before = blockTexts(base);
		const after = blockTexts(out);
		// Every other block is byte-identical.
		assert.equal(after[0], before[0]);
		assert.equal(after[2], before[2]);
		assert.equal(after[3], before[3]);
		// The touched block: type, the schema's fields present (heading, intro, background; no layout,
		// which the file didn't have and the editor didn't touch), then the unknown key.
		assert.equal(
			after[1],
			[
				'{',
				'      "type": "hero",',
				'      "heading": ["Play Hard", "Work Hard"],',
				'      "intro": "A new intro",',
				'      "background": "dark",',
				'      "flourish": true',
				'    }',
			].join('\n'),
		);
		// The diff stays inside that block's lines.
		const start = base.split('\n').findIndex((l) => l.includes('"intro": "Keys out of order')) + 1;
		const end = start + 5;
		for (const line of changedLines(base, out)) assert.ok(line >= start && line <= end, `line ${line} changed outside the block`);
		// The rest of the file, title and the unknown top-level key included, is as it was.
		assert.ok(out.endsWith('  "seo": {\n    "description": "An unknown top-level key, kept."\n  }\n}\n'));
	});

	test('a touched field takes the schema\'s form: lockup lines on one line, a normalised value', () => {
		const doc = read();
		doc.blocks[1]!.data.heading = { lines: ['  Play Harder ', '', 'Work Hard'], phone: null };
		const out = applyEdits(base, doc, site);
		assert.match(out, /\n {6}"heading": \["Play Harder", "Work Hard"\],\n/);
		// The untouched intro is copied as read, trailing space and all.
		assert.match(out, /"intro": "Keys out of order, and a trailing space. "/);
	});

	test('phone lines: added → the object form; removed → the plain list (Decision 10)', () => {
		const doc = read();
		doc.blocks[1]!.data.heading = { lines: ['Play Hard', 'Work Hard'], phone: ['Play', 'Hard', 'Work Hard'] };
		const withPhone = applyEdits(base, doc, site);
		assert.ok(
			withPhone.includes(
				'      "heading": {\n        "lines": ["Play Hard", "Work Hard"],\n        "phone": ["Play", "Hard", "Work Hard"]\n      },\n',
			),
		);
		const doc2 = read();
		doc2.blocks[3]!.data.heading = { lines: ['Building a better mousetrap', 'For You'], phone: null };
		const withoutPhone = applyEdits(base, doc2, site);
		assert.ok(withoutPhone.includes('      "heading": ["Building a better mousetrap", "For You"],\n'));
		assert.deepEqual(parseDocumentText(withoutPhone, site).document.blocks[3]!.data.heading, {
			lines: ['Building a better mousetrap', 'For You'],
			phone: null,
		});
	});

	test('a changed field changed back is untouched again (writes over the same base are idempotent)', () => {
		const doc = read();
		doc.blocks[2]!.data.body = 'Changed';
		assert.notEqual(applyEdits(base, doc, site), base);
		doc.blocks[2]!.data.body = 'One line\nand another';
		assert.equal(applyEdits(base, doc, site), base);
	});

	test('the title changes in place; the rest of the file is untouched', () => {
		const doc = read();
		doc.title = 'Round trip, renamed';
		const out = applyEdits(base, doc, site);
		assert.deepEqual(changedLines(base, out), [2]);
		assert.equal(out.split('\n')[1], '  "title": "Round trip, renamed",');
	});

	test('an unknown block survives a reorder of its neighbours byte for byte', () => {
		const doc = read();
		const [gallery, hero, text, cta] = doc.blocks;
		doc.blocks = [gallery!, text!, cta!, hero!];
		const out = applyEdits(base, doc, site);
		const before = blockTexts(base);
		assert.deepEqual(blockTexts(out), [before[0], before[2], before[3], before[1]]);
		assert.ok(out.endsWith('\n'));
	});

	test('an unknown block can be moved itself', () => {
		const doc = read();
		const [gallery, ...rest] = doc.blocks;
		doc.blocks = [...rest, gallery!];
		const before = blockTexts(base);
		assert.deepEqual(blockTexts(applyEdits(base, doc, site)), [before[1], before[2], before[3], before[0]]);
	});

	test('an unknown block can be removed, and brought back (Undo) as it was', () => {
		const doc = read();
		const gallery = doc.blocks.shift()!;
		const removed = applyEdits(base, doc, site);
		assert.doesNotMatch(removed, /gallery/);
		assert.equal(blockTexts(removed).length, 3);
		doc.blocks.unshift(gallery);
		assert.equal(applyEdits(base, doc, site), base);
	});

	test('an unknown block\'s data is never written: it is copied from the file', () => {
		const doc = read();
		doc.blocks[0]!.data.columns = 99;
		assert.equal(applyEdits(base, doc, site), base);
	});

	test('adding a block: every schema field in schema order, with its empty value', () => {
		const doc = read();
		doc.blocks.splice(2, 0, emptyBlock('text', site));
		const out = applyEdits(base, doc, site);
		const after = blockTexts(out);
		assert.equal(after.length, 5);
		assert.equal(
			after[2],
			['{', '      "type": "text",', '      "heading": "",', '      "body": "",', '      "background": "light"', '    }'].join('\n'),
		);
		const before = blockTexts(base);
		assert.deepEqual([after[0], after[1], after[3], after[4]], before);
	});

	test('the editor\'s document after a write re-reads the same', () => {
		const doc = read();
		doc.blocks[2]!.data.heading = 'Renamed';
		doc.blocks.reverse();
		const out = applyEdits(base, doc, site);
		const reread = parseDocumentText(out, site).document;
		assert.deepEqual(
			reread.blocks.map((b) => [b.type, b.data]),
			doc.blocks.map((b) => [b.type, b.data]),
		);
	});

	test('refuses a source the base doesn\'t have, and a new block of an unknown type', () => {
		const doc = read();
		doc.blocks[0] = { ...doc.blocks[0]!, source: 7 };
		assert.throws(() => applyEdits(base, doc, site), /source 7/);
		const doc2 = read();
		doc2.blocks.push({ source: null, type: 'gallery', known: false, data: {} });
		assert.throws(() => applyEdits(base, doc2, site), /unknown type "gallery"/);
	});

	test('a new document: canonical, with a trailing newline', () => {
		const doc: SiteDocument = { title: 'New', blocks: [emptyBlock('cta', site)] };
		doc.blocks[0]!.data.heading = { lines: ['Hello', 'There'], phone: null };
		assert.equal(
			serializeDocument(doc, site),
			[
				'{',
				'  "title": "New",',
				'  "blocks": [',
				'    {',
				'      "type": "cta",',
				'      "heading": ["Hello", "There"],',
				'      "text": "",',
				'      "button": "",',
				'      "background": "light"',
				'    }',
				'  ]',
				'}',
				'',
			].join('\n'),
		);
	});

	test('a file without a trailing newline gets one once something changes', () => {
		const text = '{\n  "title": "A",\n  "blocks": []\n}';
		const doc = parseDocumentText(text, site).document;
		doc.title = 'B';
		assert.equal(applyEdits(text, doc, site), '{\n  "title": "B",\n  "blocks": []\n}\n');
	});

	test('a file with no blocks key gets one when a block is added', () => {
		const text = '{\n  "title": "A"\n}\n';
		const doc = parseDocumentText(text, site).document;
		doc.blocks.push(emptyBlock('text', site));
		const out = applyEdits(text, doc, site);
		assert.match(out, /^\{\n {2}"title": "A",\n {2}"blocks": \[\n {4}\{\n {6}"type": "text",/);
	});
});

// An adoption trial, item 7: `validate --fix` writes savedForm; whatever a save writes must already be in it.
describe('savedForm (validate --fix)', () => {
	const pages = site.collections.pages!;
	// The round-trip fixture's known blocks (it keeps an unknown one, which a new file can't have).
	const known = () => {
		const doc = read();
		doc.blocks = doc.blocks.filter((b) => b.known);
		return doc;
	};
	test('a whole new document as a save writes it is already in its saved form', () => {
		const doc = known();
		for (const type of Object.keys(site.blocks)) doc.blocks.push(emptyBlock(type, site));
		const text = serializeDocument(doc, site, pages.fields);
		assert.equal(savedForm(text, pages, site), text);
	});

	test('the round-trip fixture\'s blocks, as a save writes them, are already in their saved form', () => {
		const text = serializeDocument(known(), site, pages.fields);
		assert.equal(savedForm(text, pages, site), text);
	});

	test('Site Settings as a save writes it: the brand\'s logo, the share image and each redirect on one line', () => {
		const settings = site.collections.settings!;
		const text = applyKeyedEdits(
			null,
			{
				title: 'Site Settings',
				data: {
					editors: ['a@example.com'],
					brand: { name: 'CaraCMS', accent: '#1f3a2e', logo: { key: 'uploads/0123456789ab/logo.svg', w: 120, h: 40 } },
					seo: { title: 'CaraCMS', description: 'A studio', image: { key: 'uploads/0123456789ab/share.jpg', alt: '', w: 1200, h: 630 } },
					googleTag: 'G-ABC',
					formRecipients: { contact: ['a@example.com'] },
					redirects: [{ from: '/old', to: '/new' }],
				},
			},
			settings,
		);
		assert.match(text, /"logo": \{ "key"/);
		assert.match(text, /\{ "from": "\/old", "to": "\/new" \}/);
		assert.equal(savedForm(text, settings, site), text);
	});

	test('only whitespace changes: a minified file gets the save\'s layout, its keys in their order', () => {
		const text = serializeDocument(known(), site, pages.fields);
		const minified = JSON.stringify(JSON.parse(text));
		assert.equal(savedForm(minified, pages, site), text);
		assert.equal(savedForm('[1, 2]', pages, site), null);
		assert.equal(savedForm('{ "title": ', pages, site), null);
	});
});
