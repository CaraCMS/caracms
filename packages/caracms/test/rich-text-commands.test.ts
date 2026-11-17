// On-page rich text, Phase 2, without a browser: the list item is a textblock
// (Decision 3). The editor's document for a list, a round trip of every stored
// rich-text value in the starter and the fixtures through the schema, and the list
// commands (rich-text-commands.ts) on an EditorState: Enter, Backspace, the list
// toggle and the style menu in a list item (Decision 9).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { DOMSerializer } from '@tiptap/pm/model';
import { parseRichText, serializeRichText } from '../src/rich-text.ts';
import { fromDoc, toDoc, type PMNode } from '../src/editor/client/fields/rich-text-doc.ts';
import { richTextExtensions } from '../src/editor/client/fields/rich-text-schema.ts';
import { liftListItem, setBlockStyleCommand, splitListItem, toggleListCommand, type Command } from '../src/editor/client/fields/rich-text-commands.ts';

const options = { headings: ['h2', 'h3'] as const, links: true };
const schema = getSchema(richTextExtensions(options));

/** A stored value (the file's blocks) as an editor state, the caret after the first `at` (or a range to `to`). */
function stateOf(stored: unknown[], at: string, to?: string): EditorState {
	const doc = schema.nodeFromJSON(toDoc(parseRichText(stored, options)));
	const find = (needle: string) => {
		let found = -1;
		doc.descendants((node, pos) => {
			if (found >= 0 || !node.isText) return;
			const i = node.text!.indexOf(needle);
			if (i >= 0) found = pos + i + needle.length;
		});
		assert.ok(found >= 0, `"${needle}" is in the doc`);
		return found;
	};
	const anchor = find(at);
	return EditorState.create({ doc, selection: TextSelection.create(doc, anchor, to === undefined ? anchor : find(to)) });
}

/** Runs a command; returns the new state. */
function exec(state: EditorState, command: Command): EditorState {
	let tr: Transaction | null = null;
	assert.equal(
		command(state, (t) => (tr = t)),
		true,
		'the command applies',
	);
	return state.apply(tr!);
}

const storedOf = (state: EditorState) => serializeRichText(fromDoc(state.doc.toJSON() as PMNode, options), options);
const typeAt = (state: EditorState) => state.selection.$from.parent.type.name;

describe('the list item is a textblock (Decision 3)', () => {
	test('a two-item list: listItem holds its text directly, <ul><li>One</li><li>Two</li></ul>', () => {
		const doc = schema.nodeFromJSON(toDoc(parseRichText([{ ul: ['One', 'Two **b**'] }], options)));
		const list = doc.firstChild!;
		assert.equal(list.type.name, 'bulletList');
		assert.equal(list.firstChild!.type.name, 'listItem');
		assert.ok(list.firstChild!.isTextblock, 'the item is a textblock');
		assert.equal(list.firstChild!.firstChild!.isText, true);
		// The DOM the schema writes (the editor's own, the page's too): what richTextHtml renders.
		const spec = DOMSerializer.fromSchema(schema);
		const render = (node: typeof doc): string => {
			const out = spec.serializeNode(node, { document: fakeDocument() } as never) as unknown as FakeEl;
			return out.html();
		};
		assert.equal(render(list), '<ul><li>One</li><li>Two <strong>b</strong></li></ul>');
	});

	test('toDoc writes the item as inline content; a break in an item is a hardBreak in it', () => {
		const doc = toDoc(parseRichText([{ ol: ['A\nB', ''] }, { ul: ['x'] }], options));
		assert.deepEqual(doc.content![0], {
			type: 'orderedList',
			content: [{ type: 'listItem', content: [{ type: 'text', text: 'A' }, { type: 'hardBreak' }, { type: 'text', text: 'B' }] }],
		});
		assert.deepEqual(doc.content![1], { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'text', text: 'x' }] }] });
	});

	test('fromDoc reads both item shapes the same', () => {
		const inline: PMNode = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'text', text: 'one' }] }] }] };
		const old: PMNode = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }] };
		assert.deepEqual(fromDoc(inline, options), fromDoc(old, options));
	});
});

/** Every stored rich-text value (an array of one-key blocks) under a JSON value. */
function richValues(value: unknown, out: unknown[][] = []): unknown[][] {
	const isBlock = (b: unknown) => !!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length === 1 && ['p', 'h2', 'h3', 'ul', 'ol'].includes(Object.keys(b)[0]!);
	if (Array.isArray(value)) {
		if (value.length && value.every(isBlock)) out.push(value);
		else value.forEach((v) => richValues(v, out));
	} else if (value && typeof value === 'object') Object.values(value).forEach((v) => richValues(v, out));
	return out;
}

function jsonFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? jsonFiles(path) : name.endsWith('.json') ? [path] : [];
	});
}

describe('the stored value is unchanged (a round trip through the new schema)', () => {
	const root = fileURLToPath(new URL('../../..', import.meta.url));
	const files = [...jsonFiles(join(root, 'starter/content')), ...jsonFiles(join(root, 'packages/caracms/test/fixtures'))];
	const parsed = (file: string): unknown => {
		try {
			return JSON.parse(readFileSync(file, 'utf8'));
		} catch {
			return null; // a fixture that's broken on purpose
		}
	};
	const values = files.flatMap((file) => richValues(parsed(file)).map((v) => ({ file, v })));

	test('the starter and the fixtures hold rich text with lists', () => {
		assert.ok(values.length >= 5, `found ${values.length}`);
		assert.ok(
			values.some(({ v }) => v.some((b) => 'ul' in (b as object) || 'ol' in (b as object))),
			'at least one has a list',
		);
	});

	test('each is written back byte for byte through toDoc, the schema and fromDoc', () => {
		let exact = 0;
		for (const { file, v } of values) {
			const doc = schema.nodeFromJSON(toDoc(parseRichText(v, options)));
			doc.check();
			const back = serializeRichText(fromDoc(doc.toJSON() as PMNode, options), options);
			// What the store would write without the editor: the value itself, unless it's written loosely
			// (a stray asterisk the serializer escapes, M5a Decision 3), which the editor mustn't change either.
			const direct = serializeRichText(parseRichText(v, options), options);
			assert.equal(JSON.stringify(back), JSON.stringify(direct), file);
			if (JSON.stringify(direct) === JSON.stringify(v)) exact++;
		}
		assert.ok(exact >= values.length - 2, `${exact} of ${values.length} byte for byte`);
	});
});

describe('the keys on a textblock item (M5a → Resolved decisions)', () => {
	test('Enter mid-item splits it; at the end, a new empty item', () => {
		let s = exec(stateOf([{ ul: ['OneTwo'] }], 'One'), splitListItem);
		assert.deepEqual(storedOf(s), [{ ul: ['One', 'Two'] }]);
		assert.equal(typeAt(s), 'listItem');
		s = exec(stateOf([{ ul: ['One'] }], 'One'), splitListItem);
		assert.equal(s.doc.firstChild!.childCount, 2, 'two items, the second empty');
		assert.equal(s.selection.$from.index(1), 1, 'the caret in the new item');
	});

	test('Enter in an empty item leaves the list as a paragraph, splitting the list around it', () => {
		let s = exec(stateOf([{ ul: ['A', 'B'] }], 'A'), splitListItem);
		s = exec(s, splitListItem);
		assert.equal(typeAt(s), 'paragraph');
		assert.deepEqual(
			s.doc.toJSON().content.map((n: PMNode) => n.type),
			['bulletList', 'paragraph', 'bulletList'],
		);
		assert.deepEqual(storedOf(s), [{ ul: ['A'] }, { ul: ['B'] }]);
	});

	test('Backspace at the start of the first, a middle and the last item lifts just that item', () => {
		const list = [{ ul: ['One', 'Two', 'Three'] }];
		const at = (word: string) => {
			const s = stateOf(list, word);
			return EditorState.create({ doc: s.doc, selection: TextSelection.create(s.doc, s.selection.from - word.length) });
		};
		assert.deepEqual(storedOf(exec(at('One'), liftListItem)), [{ p: 'One' }, { ul: ['Two', 'Three'] }]);
		assert.deepEqual(storedOf(exec(at('Two'), liftListItem)), [{ ul: ['One'] }, { p: 'Two' }, { ul: ['Three'] }]);
		const last = exec(at('Three'), liftListItem);
		assert.deepEqual(storedOf(last), [{ ul: ['One', 'Two'] }, { p: 'Three' }]);
		assert.equal(last.selection.from, last.doc.firstChild!.nodeSize + 1, 'the caret at the start of the lifted paragraph');
	});

	test('a break in an item stays in it through a split', () => {
		const s = exec(stateOf([{ ul: ['A\nB'] }], 'B'), splitListItem);
		assert.deepEqual(storedOf(s), [{ ul: ['A\nB'] }]);
		assert.equal(s.doc.firstChild!.childCount, 2);
	});
});

describe('the list buttons (toggleList)', () => {
	test('a paragraph becomes a bulleted list, keeping the caret, and back', () => {
		let s = exec(stateOf([{ p: 'Hello' }], 'Hel'), toggleListCommand('bulletList'));
		assert.deepEqual(storedOf(s), [{ ul: ['Hello'] }]);
		assert.equal(typeAt(s), 'listItem');
		assert.equal(s.selection.$from.parentOffset, 3, 'the caret where it was');
		s = exec(s, toggleListCommand('bulletList'));
		assert.deepEqual(storedOf(s), [{ p: 'Hello' }]);
		assert.equal(typeAt(s), 'paragraph');
		assert.equal(s.selection.$from.parentOffset, 3);
	});

	test('an empty paragraph becomes an empty item with the caret in it', () => {
		const s0 = stateOf([{ p: 'A' }], 'A');
		const doc = s0.doc.type.schema.nodes.doc!.create(null, [s0.doc.firstChild!, schema.nodes.paragraph!.create()]);
		const s = exec(EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) }), toggleListCommand('bulletList'));
		assert.equal(typeAt(s), 'listItem');
		assert.equal(s.doc.child(1).type.name, 'bulletList');
	});

	test('bulleted to numbered changes the whole list', () => {
		const s = exec(stateOf([{ ul: ['One', 'Two'] }], 'Two'), toggleListCommand('orderedList'));
		assert.deepEqual(storedOf(s), [{ ol: ['One', 'Two'] }]);
		assert.equal(typeAt(s), 'listItem');
	});

	test('a paragraph after a list of that kind joins it', () => {
		const s = exec(stateOf([{ ul: ['One'] }, { p: 'Two' }], 'Two'), toggleListCommand('bulletList'));
		assert.deepEqual(storedOf(s), [{ ul: ['One', 'Two'] }]);
	});

	test('several paragraphs selected become one list; selected items in it, back to paragraphs', () => {
		let s = exec(stateOf([{ p: 'A' }, { h2: 'B' }, { p: 'C' }], 'A', 'C'), toggleListCommand('orderedList'));
		assert.deepEqual(storedOf(s), [{ ol: ['A', 'B', 'C'] }]);
		const doc = s.doc;
		// Select from inside B to inside C: just those two leave the list.
		const b = doc.firstChild!.child(0).nodeSize + 2;
		s = EditorState.create({ doc, selection: TextSelection.create(doc, b, doc.content.size - 2) });
		s = exec(s, toggleListCommand('orderedList'));
		assert.deepEqual(storedOf(s), [{ ol: ['A'] }, { p: 'B' }, { p: 'C' }]);
	});
});

describe('the style menu in a list item (Decision 9)', () => {
	test('Heading 2 in a middle item takes it out of the list as a heading, the list split around it', () => {
		const s = exec(stateOf([{ ul: ['One', 'Two', 'Three'] }], 'Tw'), setBlockStyleCommand('h2'));
		assert.deepEqual(storedOf(s), [{ ul: ['One'] }, { h2: 'Two' }, { ul: ['Three'] }]);
		assert.equal(typeAt(s), 'heading');
		assert.equal(s.selection.$from.parentOffset, 2);
	});

	test('Paragraph in the first item; a heading with a break keeps it', () => {
		assert.deepEqual(storedOf(exec(stateOf([{ ol: ['One', 'Two'] }], 'One'), setBlockStyleCommand('p'))), [{ p: 'One' }, { ol: ['Two'] }]);
		assert.deepEqual(storedOf(exec(stateOf([{ ul: ['A\nB'] }], 'A'), setBlockStyleCommand('h3'))), [{ h3: 'A\nB' }]);
	});

	test('outside a list it sets the block as before', () => {
		assert.deepEqual(storedOf(exec(stateOf([{ p: 'One' }, { p: 'Two' }], 'Two'), setBlockStyleCommand('h2'))), [{ p: 'One' }, { h2: 'Two' }]);
		assert.deepEqual(storedOf(exec(stateOf([{ h2: 'One' }], 'One'), setBlockStyleCommand('p'))), [{ p: 'One' }]);
	});
});

// ---- A tiny DOM, enough for DOMSerializer in node (no jsdom in this repo). ----
interface FakeEl {
	nodeType: number;
	appendChild(child: FakeEl): FakeEl;
	setAttribute(name: string, value: string): void;
	html(): string;
}
function fakeDocument() {
	const el = (tag: string | null, text?: string): FakeEl => {
		const children: FakeEl[] = [];
		const attrs: Record<string, string> = {};
		return {
			nodeType: tag ? 1 : 3,
			appendChild(c) {
				children.push(c);
				return c;
			},
			setAttribute(k, v) {
				attrs[k] = v;
			},
			html() {
				if (!tag) return text ?? '';
				const a = Object.entries(attrs)
					.map(([k, v]) => ` ${k}="${v}"`)
					.join('');
				return tag === 'br' ? '<br>' : `<${tag}${a}>${children.map((c) => c.html()).join('')}</${tag}>`;
			},
		};
	};
	return { createElement: (tag: string) => el(tag), createTextNode: (text: string) => el(null, text), createElementNS: (_ns: string, tag: string) => el(tag) };
}
