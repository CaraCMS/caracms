// M5a Phase 4, without a browser: rich text's value ↔ the editor's ProseMirror
// document (rich-text-doc.ts), pasted plain text, a list row removed with Undo in
// the document store (Decision 14), the reorder keys the block list and lists share,
// and a list row's collapsed summary (Decision 5).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { list, parseField, reference, richText, text, link, type Fields } from '../src/fields.ts';
import { serializeRichText, type RichTextValue } from '../src/rich-text.ts';
import { fromDoc, pastedParagraphs, toDoc, type PMNode } from '../src/editor/client/fields/rich-text-doc.ts';
import { createDocumentStore } from '../src/editor/client/state/document-store.ts';
import { rowKeyAction } from '../src/editor/client/block-list/reorder.ts';
import { itemNoun, itemSummary } from '../src/editor/client/fields/list-summary.ts';

const withHeadings = { headings: ['h2', 'h3'] as const, links: true };
const plain = { headings: [] as const, links: true };

describe("rich text in the editor (Decision 3)", () => {
	const value = parseField(richText({ headings: ['h2', 'h3'] }), [
		{ p: 'We drew **ferry signs**, see [the *print*](/services/print).' },
		{ h2: 'From the wall\noutward' },
		{ ul: ['One', 'Two **b**'] },
		{ ol: ['First'] },
	]) as RichTextValue;

	test('a value goes to the editor and back unchanged', () => {
		const doc = toDoc(value);
		assert.equal(doc.type, 'doc');
		assert.deepEqual(fromDoc(doc, withHeadings), value);
	});

	test('a break is a hardBreak; a heading with a break stays one heading', () => {
		const heading = toDoc(value).content![1]!;
		assert.equal(heading.type, 'heading');
		assert.equal(heading.attrs?.level, 2);
		assert.deepEqual(
			heading.content!.map((n) => n.type),
			['text', 'hardBreak', 'text'],
		);
	});

	test('what the editor holds is written in the file\'s format', () => {
		const doc: PMNode = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Type ** and ' }, { type: 'text', text: 'bold', marks: [{ type: 'bold' }] }] },
				{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A' }, { type: 'hardBreak' }, { type: 'text', text: 'B' }] },
				{ type: 'paragraph' },
				{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '/work' } }] }] }] }, { type: 'listItem', content: [{ type: 'paragraph' }] }] },
			],
		};
		assert.deepEqual(serializeRichText(fromDoc(doc, withHeadings), withHeadings), [{ p: 'Type \\*\\* and **bold**' }, { h2: 'A\nB' }, { ul: ['[x](/work)'] }]);
	});

	test('empty paragraphs are dropped and breaks at a unit\'s ends trimmed', () => {
		const doc: PMNode = {
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'hardBreak' }, { type: 'text', text: 'Hi' }, { type: 'hardBreak' }] }, { type: 'paragraph' }],
		};
		assert.deepEqual(fromDoc(doc, plain), [{ kind: 'p', runs: [{ text: 'Hi' }] }]);
	});

	test('a heading where the field has none is written as a paragraph', () => {
		const doc: PMNode = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] }] };
		assert.deepEqual(serializeRichText(fromDoc(doc, plain), plain), [{ p: 'H' }]);
	});

	test('an empty value is one empty paragraph in the editor', () => {
		assert.deepEqual(toDoc([]), { type: 'doc', content: [{ type: 'paragraph' }] });
	});

	test('pasted plain text: a blank line starts a paragraph, a single newline is a break (Spec → Text)', () => {
		const paras = pastedParagraphs('One\ntwo\n\nThree\r\n\r\n\n');
		assert.equal(paras.length, 2);
		assert.deepEqual(
			paras[0]!.map((n) => n.type),
			['text', 'hardBreak', 'text'],
		);
		assert.deepEqual(paras[1], [{ type: 'text', text: 'Three' }]);
	});
});

describe('a list row removed, with Undo (Decision 14)', () => {
	const fields: Fields = { credits: list({ role: text(), name: text() }), tags: list(text()) };
	const site = { blocks: { kit: { type: 'kit', label: 'Kit', component: 'Kit.astro', fields, headingField: null } } };
	const credits = [
		{ role: 'Identity', name: 'Aoife' },
		{ role: 'Photography', name: 'Dara' },
		{ role: 'Type', name: 'Niamh' },
	];
	const newStore = () =>
		createDocumentStore(site as never, {
			ref: { collection: 'pages', path: 'kit' },
			entry: { collection: 'pages', path: 'kit', file: 'content/pages/kit.json', url: '/kit', title: 'Kit', label: 'Kit', warning: null } as never,
			base: '{}',
			document: { title: 'Kit', blocks: [{ source: 0, type: 'kit', known: true, data: { credits, tags: ['a', 'b'] } }] } as never,
		});

	test('removeItem takes the row out and puts an Undo entry on the stack', () => {
		const store = newStore();
		const key = store.get().document.blocks[0]!.key;
		const entry = store.removeItem(key, 'credits', 1, { label: 'Removed credit: Photography' });
		assert.equal(entry?.kind, 'item');
		assert.equal(entry?.label, 'Removed credit: Photography');
		assert.deepEqual(store.block(key)!.data.credits, [credits[0], credits[2]]);
	});

	test('Undo puts it back in place, even after another row changed', () => {
		const store = newStore();
		const key = store.get().document.blocks[0]!.key;
		store.removeItem(key, 'credits', 1);
		store.setField(key, 'credits.0.name', 'Aoife B');
		store.undo();
		assert.deepEqual(store.block(key)!.data.credits, [{ role: 'Identity', name: 'Aoife B' }, credits[1], credits[2]]);
		assert.equal(store.get().undo.length, 0);
	});

	test('a flat list too, and an index out of range is no change', () => {
		const store = newStore();
		const key = store.get().document.blocks[0]!.key;
		assert.equal(store.removeItem(key, 'tags', 5), null);
		store.removeItem(key, 'tags', 0);
		assert.deepEqual(store.block(key)!.data.tags, ['b']);
		store.undo();
		assert.deepEqual(store.block(key)!.data.tags, ['a', 'b']);
	});
});

describe('rows: keys and summaries', () => {
	const key = (k: string, mods: { altKey?: boolean } = {}) => {
		let prevented = false;
		const event = { key: k, altKey: !!mods.altKey, metaKey: false, ctrlKey: false, preventDefault: () => (prevented = true) };
		return { event: event as never, prevented: () => prevented };
	};

	test('⌥↑/⌥↓ move, ⌫ removes, ↑/↓ move focus, nothing past the ends', () => {
		assert.deepEqual(rowKeyAction(key('ArrowDown', { altKey: true }).event, 0, 3), { kind: 'move', to: 1 });
		assert.deepEqual(rowKeyAction(key('ArrowUp', { altKey: true }).event, 0, 3), null);
		assert.deepEqual(rowKeyAction(key('Backspace').event, 1, 3), { kind: 'remove' });
		assert.deepEqual(rowKeyAction(key('ArrowUp').event, 2, 3), { kind: 'focus', to: 1 });
		const end = key('ArrowDown');
		assert.equal(rowKeyAction(end.event, 2, 3), null);
		assert.equal(end.prevented(), false, 'the key goes on past the last row');
	});

	test('a collapsed row shows itemLabel, else the first text field, the string itself, or the referenced title', () => {
		const titleOf = (_to: string, path: string) => (path === 'kiln' ? 'Kitchen pottery' : null);
		assert.deepEqual(itemSummary(list({ role: text(), name: text() }), { role: 'Identity', name: 'Aoife' }, titleOf), { main: 'Identity', more: 'Aoife' });
		assert.equal(itemSummary(list({ role: text(), name: text() }, { itemLabel: 'name' }), { role: 'Identity', name: 'Aoife' }, titleOf).main, 'Aoife');
		assert.equal(itemSummary(list(text()), 'niamh@example.com', titleOf).main, 'niamh@example.com');
		assert.equal(itemSummary(list(reference({ to: 'case-studies' })), 'kiln', titleOf).main, 'Kitchen pottery');
		assert.equal(itemSummary(list({ label: text(), link: link() }), { label: '', link: { label: 'x', href: '/' } }, titleOf).main, '');
		// A list of links: its words, then where it goes, short (the mockup's footer links).
		assert.deepEqual(itemSummary(list(link()), { label: 'Instagram', href: 'https://instagram.com/example' }, titleOf), { main: 'Instagram', more: 'instagram.com/example' });
		assert.deepEqual(itemSummary(list(link()), { label: 'Write to us', href: 'mailto:hello@example.com' }, titleOf), { main: 'Write to us', more: 'hello@example.com' });
		assert.equal(itemSummary(list(link()), { label: 'Visit', href: '/contact' }, titleOf).more, '/contact');
	});

	test('what one item is called', () => {
		assert.equal(itemNoun('Credits'), 'credit');
		assert.equal(itemNoun('Related case studies'), 'related case study');
		assert.equal(itemNoun('Press'), 'press');
	});
});
