// The per-key three-way merge (M4 Decisions 6 and 7; Phase 1 → Verify 2).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { mergeFile } from '../src/live/merge.ts';
import { fixtures } from './helpers/site.ts';

const base = readFileSync(`${fixtures}round-trip.json`, 'utf8');

/** Replace one top-level member's value text, keeping everything else as written. */
const setKey = (text: string, key: string, valueText: string) => {
	const value = JSON.parse(text)[key];
	const was = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
	assert.ok(text.includes(`"${key}": ${was}`), `fixture shape for ${key}`);
	return text.replace(`"${key}": ${was}`, `"${key}": ${valueText}`);
};

describe('mergeFile: per top-level key', () => {
	test('untouched keys stay byte for byte: the draft changed the title, the other side the seo', () => {
		const draft = base.replace('"title": "Round trip"', '"title": "Round trip, edited"');
		const other = setKey(base, 'seo', '{\n    "description": "From main."\n  }');
		const r = mergeFile({ base, draft, other });
		assert.equal(r.keptDraft, false);
		assert.equal(r.text, draft.replace('"description": "An unknown top-level key, kept."', '"description": "From main."'));
		// The blocks, which neither touched, are exactly the base's text.
		const blocks = (t: string) => t.slice(t.indexOf('"blocks"'), t.indexOf('"seo"'));
		assert.equal(blocks(r.text!), blocks(base));
	});

	test('a key changed on both sides takes the draft, and says so', () => {
		const draft = base.replace('"title": "Round trip"', '"title": "Draft title"');
		const other = base.replace('"title": "Round trip"', '"title": "Main title"');
		const r = mergeFile({ base, draft, other });
		assert.equal(r.text, draft);
		assert.equal(r.keptDraft, true);
		assert.deepEqual(r.conflicts, ['title']);
	});

	test('both sides changing different keys keeps both changes', () => {
		const draft = base.replace('"title": "Round trip"', '"title": "Draft title"');
		const other = base.replace('"An unknown top-level key, kept."', '"Main changed it."');
		const r = mergeFile({ base, draft, other });
		const value = JSON.parse(r.text!);
		assert.equal(value.title, 'Draft title');
		assert.equal(value.seo.description, 'Main changed it.');
		assert.equal(r.keptDraft, false);
	});

	test('a key added on the other side is appended in its order, as written there; one it removed is cut', () => {
		const other = base.replace('\n  "seo": {\n    "description": "An unknown top-level key, kept."\n  }\n}', '\n  "seo": {\n    "description": "An unknown top-level key, kept."\n  },\n  "zeta": 1,\n  "alpha":   [1,2]\n}');
		const draft = base.replace('"title": "Round trip"', '"title": "Draft"');
		const r = mergeFile({ base, draft, other });
		assert.ok(r.text!.endsWith('\n  "seo": {\n    "description": "An unknown top-level key, kept."\n  },\n  "zeta": 1,\n  "alpha":   [1,2]\n}\n'), r.text!);
		assert.deepEqual(Object.keys(JSON.parse(r.text!)), ['title', 'blocks', 'seo', 'zeta', 'alpha']);

		const removed = base.replace(',\n  "seo": {\n    "description": "An unknown top-level key, kept."\n  }', '');
		const r2 = mergeFile({ base, draft, other: removed });
		assert.equal(r2.text, draft.replace(',\n  "seo": {\n    "description": "An unknown top-level key, kept."\n  }', ''));
		assert.deepEqual(Object.keys(JSON.parse(r2.text!)), ['title', 'blocks']);
	});

	test('a key the draft added and the other side left alone stays; one the draft removed stays removed', () => {
		const draft = base.replace('"title": "Round trip",', '"title": "Round trip",\n  "subtitle": "New",');
		const other = base.replace('"An unknown top-level key, kept."', '"Main."');
		const r = mergeFile({ base, draft, other });
		assert.deepEqual(Object.keys(JSON.parse(r.text!)), ['title', 'subtitle', 'blocks', 'seo']);
		assert.equal(JSON.parse(r.text!).seo.description, 'Main.');
	});

	test('removing a middle key keeps the commas right', () => {
		const b = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
		const r = mergeFile({ base: b, draft: '{\n  "a": 10,\n  "b": 2,\n  "c": 3\n}\n', other: '{\n  "a": 1,\n  "c": 3\n}\n' });
		assert.equal(r.text, '{\n  "a": 10,\n  "c": 3\n}\n');
	});

	test('re-indented but equal is no change', () => {
		const b = '{\n  "a": [1, 2],\n  "b": 1\n}\n';
		const r = mergeFile({ base: b, draft: '{\n  "a": [1, 2],\n  "b": 2\n}\n', other: '{\n  "a": [\n    1,\n    2\n  ],\n  "b": 1\n}\n' });
		assert.equal(r.text, '{\n  "a": [1, 2],\n  "b": 2\n}\n');
	});
});

describe('mergeFile: the whole-file fallback', () => {
	test('a file that isn\'t valid JSON on one side: the draft wins whole', () => {
		const draft = base.replace('"title": "Round trip"', '"title": "Draft"');
		const r = mergeFile({ base, draft, other: '{ not json' });
		assert.equal(r.text, draft);
		assert.equal(r.how, 'whole-file');
		assert.equal(r.keptDraft, true);
	});

	test('a non-content file: whole file, the draft winning', () => {
		const r = mergeFile({ base: 'a\n', draft: 'b\n', other: 'c\n', perKey: false });
		assert.deepEqual([r.text, r.keptDraft], ['b\n', true]);
	});

	test('deleted on one side, changed on the other: the draft wins (its deletion too)', () => {
		assert.equal(mergeFile({ base, draft: null, other: base.replace('Round trip', 'X') }).text, null);
		const draft = base.replace('Round trip', 'Y');
		assert.equal(mergeFile({ base, draft, other: null }).text, draft);
	});

	test('one side only: that side, including a deletion', () => {
		assert.equal(mergeFile({ base, draft: base, other: null }).text, null);
		assert.equal(mergeFile({ base, draft: null, other: base }).text, null);
		assert.equal(mergeFile({ base, draft: base, other: 'x' }).text, 'x');
	});

	test('added on both sides with different keys merges as if from {}', () => {
		const r = mergeFile({ base: null, draft: '{\n  "a": 1\n}\n', other: '{\n  "b": 2\n}\n' });
		assert.equal(r.text, '{\n  "a": 1,\n  "b": 2\n}\n');
	});
});

describe('mergeFile: Decision 7, the cases that decide for the draft', () => {
	const doc = (members: Record<string, unknown>) => `${JSON.stringify(members, null, 2)}\n`;
	const b = doc({ title: 'Base', intro: 'Hello', seo: { description: 'Base' } });

	test('changed on the draft, removed on the other side: the draft keeps its change, and says so', () => {
		const draft = doc({ title: 'Base', intro: 'Hello', seo: { description: 'Draft' } });
		const other = doc({ title: 'Base', intro: 'Hello' });
		const r = mergeFile({ base: b, draft, other });
		assert.equal(r.text, draft);
		assert.deepEqual([r.keptDraft, r.conflicts], [true, ['seo']]);
	});

	test('removed on the draft, changed on the other side: the draft\'s removal stands, and says so', () => {
		const draft = doc({ title: 'Base', intro: 'Hello' });
		const other = doc({ title: 'Base', intro: 'Hello', seo: { description: 'Main' } });
		const r = mergeFile({ base: b, draft, other });
		assert.equal(r.text, draft);
		assert.deepEqual([r.keptDraft, r.conflicts], [true, ['seo']]);
	});

	test('a key added on both sides with different values takes the draft; with the same value it is no conflict', () => {
		const draft = doc({ title: 'Base', intro: 'Hello', seo: { description: 'Base' }, extra: 'draft' });
		const other = doc({ title: 'Base', intro: 'Hello', seo: { description: 'Base' }, extra: 'main' });
		const r = mergeFile({ base: b, draft, other });
		assert.deepEqual([r.text, r.keptDraft, r.conflicts], [draft, true, ['extra']]);
		const same = mergeFile({ base: b, draft, other: draft });
		assert.deepEqual([same.keptDraft, same.conflicts], [false, []]);
	});

	test('one key in conflict and another changed cleanly in the same file: the clean one is taken, the notice still shows', () => {
		const draft = doc({ title: 'Draft', intro: 'Hello', seo: { description: 'Base' } });
		const other = doc({ title: 'Main', intro: 'Hello, from main', seo: { description: 'Base' } });
		const r = mergeFile({ base: b, draft, other });
		const v = JSON.parse(r.text!);
		assert.deepEqual([v.title, v.intro], ['Draft', 'Hello, from main']);
		assert.deepEqual([r.keptDraft, r.conflicts], [true, ['title']]);
	});

	test('nothing in conflict: no notice, however many keys moved', () => {
		const draft = doc({ title: 'Draft', intro: 'Hello', seo: { description: 'Base' } });
		const other = doc({ title: 'Base', intro: 'Hello, from main', seo: { description: 'Main' } });
		const r = mergeFile({ base: b, draft, other });
		assert.deepEqual([r.keptDraft, r.conflicts], [false, []]);
		assert.deepEqual(JSON.parse(r.text!), { title: 'Draft', intro: 'Hello, from main', seo: { description: 'Main' } });
	});

	test('a file that is not an object, or not JSON on any one side, falls back to the whole file, the draft winning', () => {
		const draft = doc({ title: 'Draft', intro: 'Hello', seo: { description: 'Base' } });
		const other = doc({ title: 'Main', intro: 'Hello', seo: { description: 'Base' } });
		for (const [name, input] of [
			['an array on the other side', { base: b, draft, other: '[1, 2, 3]\n' }],
			['an array in the draft', { base: b, draft: '[1, 2]\n', other }],
			['a string root', { base: b, draft, other: '"just text"\n' }],
			['not JSON in the draft', { base: b, draft: 'title: Draft\n', other }],
			['not JSON in the ancestor', { base: '{ nope', draft, other }],
		] as const) {
			const r = mergeFile(input);
			assert.deepEqual([r.text, r.keptDraft, r.how], [input.draft, true, 'whole-file'], name);
		}
	});

	test('untouched members keep their exact text: CRLF, tabs, escapes and odd spacing survive the other side\'s change', () => {
		// The draft's file is hand-formatted in ways JSON.stringify would undo.
		const ancestor = '{\r\n\t"title" :  "Caf\\u00e9",\r\n\t"intro":"Hello",   \r\n\t"list": [ 1,2,  3 ],\r\n\t"note": "tab\\there"\r\n}\r\n';
		const draft = ancestor.replace('"Hello"', '"Hello, edited"');
		const other = ancestor.replace('"tab\\there"', '"changed on main"');
		const r = mergeFile({ base: ancestor, draft, other });
		assert.equal(r.text, draft.replace('"tab\\there"', '"changed on main"'), 'only the one member differs, byte for byte');
		assert.equal(r.keptDraft, false);
		// Taking the other side's member does not reformat the draft's neighbours either.
		const takeList = mergeFile({ base: ancestor, draft, other: ancestor.replace('[ 1,2,  3 ]', '[ 9 ]') });
		assert.equal(takeList.text, draft.replace('[ 1,2,  3 ]', '[ 9 ]'));
	});

	test('key order is the draft\'s: the other side reordering its keys moves nothing', () => {
		const other = doc({ seo: { description: 'Base' }, intro: 'Hello', title: 'Base' });
		const draft = doc({ title: 'Draft', intro: 'Hello', seo: { description: 'Base' } });
		const r = mergeFile({ base: b, draft, other });
		assert.equal(r.text, draft);
		assert.equal(r.keptDraft, false);
	});
});
