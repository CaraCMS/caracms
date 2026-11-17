// The block list without a browser (Phase 4): what a row says (Decision 21's kept
// summary), the hover and picker stores, and an unknown block surviving reorders
// byte for byte through the serializer (Decision 7; Verify 4's file side).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { offersFirstBlock } from '../src/editor/client/block-list/insert-points.ts';
import { blockHover, openPicker, pickerAt, setBlockHover } from '../src/editor/client/block-list/link.ts';
import { blockIcon, blockSummary, fieldsSummary, keptLine, keptSummary, previewValue } from '../src/editor/client/block-list/summary.ts';
import type { Editor, View } from '../src/editor/client/editor.ts';
import { createDocumentStore } from '../src/editor/client/state/document-store.ts';
import { createStore } from '../src/editor/client/state/store.ts';
import { parseDocumentText, type SiteDocument } from '../src/document.ts';
import { applyEdits } from '../src/serialize.ts';
import { fixtures, site } from './helpers/site.ts';

const base = readFileSync(`${fixtures}round-trip.json`, 'utf8');
const entry = { collection: 'pages', path: 'index', file: 'content/pages/index.json', url: '/', title: 'Round trip', label: 'Round trip', warning: null };
const newStore = () => createDocumentStore(site, { ref: { collection: 'pages', path: 'index' }, entry, base, document: parseDocumentText(base, site).document });

/** The gallery block's text exactly as it is in the file. */
const galleryText = base.slice(base.indexOf('    {\n      "type": "gallery"'), base.indexOf('    },\n    {\n      "intro"') + '    }'.length);

describe('what a block row says', () => {
	test('an unknown block: its type, then each kept key with a short preview (Decision 21)', () => {
		const unknown = newStore().get().document.blocks[0]!;
		assert.equal(unknown.known, false);
		assert.deepEqual(keptSummary(unknown.data), [
			{ key: 'images', label: 'Images', preview: '“harbour.jpg / hills.jpg”' },
			{ key: 'columns', label: 'Columns', preview: '3' },
			{ key: 'caption', label: 'Caption', preview: '2 fields' },
		]);
		assert.equal(blockSummary(site, unknown), 'gallery · Images: “harbour.jpg / hills.jpg” · Columns: 3 · Caption: 2 fields');
		assert.equal(keptLine({}), 'Nothing but its type');
		assert.equal(blockIcon(unknown), 'b-unknown');
	});

	test('previews are short', () => {
		assert.equal(previewValue('A very long sentence that goes on and on'), '“A very long sentence th…”');
		assert.equal(previewValue([{ a: 1 }, { b: 2 }, { c: 3 }]), '3 items');
		assert.equal(previewValue(''), 'empty');
		assert.equal(previewValue(null), 'empty');
		assert.equal(previewValue(true), 'true');
	});

	test('a known block: its first lockup\'s lines or first text; an empty one says so', () => {
		const store = newStore();
		const [, hero, text] = store.get().document.blocks;
		assert.equal(blockSummary(site, hero!), 'Play Hard / Work Hard');
		assert.equal(blockSummary(site, text!), 'Second block');
		const added = store.addBlock('text');
		assert.equal(blockSummary(site, store.block(added)!), 'Nothing in it yet');
		assert.equal(blockIcon({ type: 'hero', known: true }), 'b-hero');
		assert.equal(blockIcon({ type: 'text', known: true }), 'b-tm');
	});

	test('the picker lists a type\'s fields', () => {
		assert.equal(fieldsSummary(site.blocks.hero), 'Heading, Intro, Layout, Background');
	});
});

describe('an unknown block through reorders (Decision 7)', () => {
	test('its neighbours move round it, it moves itself, it is removed and brought back: its text stays byte for byte', () => {
		const store = newStore();
		const write = () => applyEdits(base, store.wire() as SiteDocument, site);
		const [gallery, hero, text, cta] = store.get().document.blocks;

		store.moveBlock(cta!.key, 1); // a neighbour moves past it
		assert.ok(write().includes(galleryText));
		store.moveBlock(gallery!.key, 3); // it moves itself, to the end
		let out = write();
		assert.ok(out.includes(galleryText));
		assert.ok(out.indexOf('"gallery"') > out.indexOf('"cta"'), 'it is now last');

		store.removeBlock(gallery!.key);
		assert.ok(!write().includes('"gallery"'), 'removed is gone from the file');
		store.undo();
		out = write();
		assert.ok(out.includes(galleryText), 'Undo brings it back as read');

		// Back to the file's order: the file comes back byte for byte.
		store.moveBlock(gallery!.key, 0);
		store.moveBlock(hero!.key, 1);
		store.moveBlock(text!.key, 2);
		assert.equal(write(), base);
	});
});

describe('the hover and picker stores', () => {
	const fakeEditor = () => {
		const doc = newStore();
		const view = createStore<View>({ level: 'document', collection: null, block: null, field: null, picked: false, width: 'desktop', pop: null, opening: null });
		return {
			doc,
			view,
			setPop: (pop: string | null) => view.update({ pop }),
			goTo: (level: View['level']) => view.update({ level }),
		} as unknown as Editor;
	};

	test('hover is one store per editor; removing the hovered block clears it', () => {
		const a = fakeEditor();
		const b = fakeEditor();
		const key = a.doc.keyAt(1)!;
		setBlockHover(a, key);
		assert.equal(blockHover(a).get(), key);
		assert.equal(blockHover(b).get(), null);
		a.doc.removeBlock(key);
		assert.equal(blockHover(a).get(), null);
	});

	test('openPicker clamps its index and goes to the document level; leaving the level closes it', () => {
		const editor = fakeEditor();
		editor.view.update({ level: 'documents', pop: 'switcher' });
		openPicker(editor, 99);
		assert.equal(pickerAt(editor).get(), 4);
		assert.equal(editor.view.get().level, 'document');
		assert.equal(editor.view.get().pop, null);
		editor.view.update({ level: 'block' });
		assert.equal(pickerAt(editor).get(), null);
	});
});

describe('the empty page\'s add', () => {
	const state = (patch: Partial<View>, blocks = true) => {
		const doc = newStore();
		if (!blocks) for (const b of doc.get().document.blocks) doc.removeBlock(b.key);
		const view = createStore<View>({ level: 'document', collection: null, block: null, field: null, picked: false, width: 'desktop', pop: null, opening: null, ...patch });
		const previewStatus = createStore({ painted: true, failed: false, showing: doc.get().ref, opening: null, warnings: [] });
		return { doc, view, previewStatus } as unknown as Editor;
	};

	test('an empty page offers its first block; nothing while another document is opening', () => {
		const e = state({}, false);
		assert.equal(offersFirstBlock(e), true);
		e.previewStatus.update({ opening: { collection: 'pages', path: 'about' } });
		assert.equal(offersFirstBlock(e), false);
		assert.equal(offersFirstBlock(state({})), false, 'a page with blocks: the sidebar adds');
	});
});
