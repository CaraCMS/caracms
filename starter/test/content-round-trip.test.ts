// Decision 7 / the Watch-out "byte-identical round trips are easy to break": every
// content file the demo ships goes through the serializer with no changes and comes
// back byte for byte, and a one-field edit changes only that block's lines. Reads the
// real files under starter/content/ and never writes to them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { listDocuments } from 'caracms/content';
import { parseAnyDocument, parseDocumentText } from 'caracms/document';
import { applyDocumentEdits, applyEdits, removeTopLevel, toJson } from 'caracms/serialize';
import { resolveSite } from 'caracms/config';
import config from '../caracms.config.ts';
import { root } from './helpers/render.ts';

// The live demo's own files, not the pinned copy the render tests use: whatever is
// published must round-trip too, and nothing here depends on which documents there are.
const site = resolveSite(config, root);
const entries = await listDocuments(site);
let edits = 0;
// M8 Decision 14: a file's `$schema` is stamped on a new file by the editor's create, not the serializer.
const unstamped = (text: string) => removeTopLevel(text, '$schema');
const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

describe('every demo content file round-trips through the serializer', () => {
	test('the demo has content (so this can\'t pass by checking nothing)', () => {
		assert.ok(entries.length >= 19, `${entries.length} documents`);
		assert.deepEqual([...new Set(entries.map((e) => e.collection))].sort(), ['case-studies', 'journal', 'pages', 'settings', 'shared', 'tags', 'workshops']);
	});

	for (const entry of entries) {
		const text = readFileSync(`${root}/${entry.file}`, 'utf8');

		test(`${entry.file}: opens without a warning`, () => {
			assert.equal(entry.warning, null);
		});

		if (entry.kind !== 'sections') {
			// M5a: list-of-fields documents, shared blocks and Site Settings, through their own writers.
			test(`${entry.file}: no changes comes back byte-identical (M5a, ${entry.kind})`, () => {
				const collection = site.collections[entry.collection]!;
				const document = parseAnyDocument(JSON.parse(text), site, collection);
				assert.equal(applyDocumentEdits(text, structuredClone(document), site, collection), text);
			});
			if (entry.kind !== 'settings') {
				test(`${entry.file}: is already in the canonical form, so a first save adds no noise (M5a, ${entry.kind})`, () => {
					const collection = site.collections[entry.collection]!;
					const document = parseAnyDocument(JSON.parse(text), site, collection);
					assert.equal(applyDocumentEdits(null, structuredClone(document), site, collection), unstamped(text));
				});
			}
			edits++; // the block edits below are a section builder's
			continue;
		}

		test(`${entry.file}: no changes comes back byte-identical`, () => {
			const { document } = parseDocumentText(text, site);
			assert.equal(applyEdits(text, structuredClone(document), site), text);
		});

		// A new document is written with every field of every block; the demo's pages predate M5a's
		// new fields (the hero's buttons) and hold shared entries, which a new file can't have, so this
		// holds only for a file whose every block has every field of its schema.
		const { document: parsed } = parseDocumentText(text, site);
		const raw = JSON.parse(text) as { blocks: Record<string, unknown>[] };
		const whole = parsed.blocks.every((b: any, i: number) => b.known && Object.keys(site.blocks[b.type]!.fields).every((k) => k in raw.blocks[i]!));
		test(`${entry.file}: is already in the canonical form, so a first save adds no noise`, { skip: whole ? false : 'a block predates a field M5a added, or is a shared entry' }, () => {
			const { document } = parseDocumentText(text, site);
			assert.equal(applyEdits(null, structuredClone(document), site), unstamped(text));
		});

		test(`${entry.file}: changing one text field of one block changes only that block's lines`, () => {
			const { document, source } = parseDocumentText(text, site);
			const rootNode = source.root as any;
			const blocksNode = rootNode.members.find((m: any) => m.key === 'blocks').value;
			document.blocks.forEach((block: any, index: number) => {
				if (!block.known) return;
				const schema = site.blocks[block.type]!;
				const field = Object.entries(schema.fields).find(([, f]: [string, any]) => f.kind === 'text');
				if (!field) return;
				const edited = structuredClone(document);
				const target = edited.blocks[index] as any;
				target.data[field[0]] = `${target.data[field[0]] ?? ''} edited`;
				const out = applyEdits(text, edited, site);
				edits++;
				assert.notEqual(out, text);
				const node = blocksNode.items[index];
				const first = lineOf(text, node.start);
				const last = lineOf(text, node.end);
				const before = text.split('\n');
				const after = out.split('\n');
				assert.equal(after.length, before.length, 'no lines added or removed');
				for (let i = 0; i < before.length; i++) {
					if (before[i] !== after[i]) assert.ok(i + 1 >= first && i + 1 <= last, `line ${i + 1} changed outside block ${index} (lines ${first}–${last})`);
				}
				// And back again: the same text as the file.
				assert.equal(applyEdits(text, structuredClone(document), site), text);
			});
		});
	}

	test('the one-field edits above really ran (at least one per file)', () => {
		assert.ok(edits >= entries.length, `${edits} edits for ${entries.length} files`);
	});

	test('toJson writes a string array on one line, as the demo files have them', () => {
		const home = readFileSync(`${root}/content/pages/index.json`, 'utf8');
		assert.match(home, /"heading": \["An editor for", "Astro sites"\]/);
		assert.match(toJson({ heading: ['An editor for', 'Astro sites'] }), /"heading": \["An editor for", "Astro sites"\]/);
	});
});
