// M8 Decision 14, Acceptance 18: a content file's `$schema` key. Reading ignores it, every
// kind of save keeps it first, a new document gets it, and a move keeps its path right.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { listDocuments, readDocument } from '../src/content.ts';
import { planCreate } from '../src/editor/server/create.ts';
import { movesChanges, planMove } from '../src/editor/server/move.ts';
import { schemaRef, stampSchema } from '../src/schema-key.ts';
import { applyDocumentEdits, applyEdits, applyKeyedEdits, applySharedEdits } from '../src/serialize.ts';
import { parseAnyDocument, type FieldsDocument, type SettingsDocument, type SharedDocument, type SiteDocument } from '../src/document.ts';
import { makeCreateSite, type CreateSite } from './helpers/create-site.ts';

const PAGE = '{\n  "$schema": "../../schemas/pages.schema.json",\n  "title": "About",\n  "blocks": [\n    { "type": "text", "heading": "Hi" }\n  ]\n}\n';
const FIELDS = '{\n  "$schema": "../../schemas/case-studies.schema.json",\n  "title": "Pots",\n  "client": "Pots & Pans etc."\n}\n';
const SHARED = '{\n  "$schema": "../../schemas/shared.schema.json",\n  "title": "Footer",\n  "block": {\n    "type": "cta",\n    "text": "Bring it over."\n  }\n}\n';
const SETTINGS = '{\n  "$schema": "../schemas/site-settings.schema.json",\n  "title": "Site Settings",\n  "editors": []\n}\n';

let s: CreateSite;
before(() => {
	s = makeCreateSite({
		files: {
			'content/pages/about.json': PAGE,
			'content/case-studies/pots.json': FIELDS,
			'content/shared/footer.json': SHARED,
			'content/site-settings.json': SETTINGS,
		},
	});
});
after(() => s.cleanup());

const firstKey = (text: string) => Object.keys(JSON.parse(text))[0];

describe('schemaRef and stampSchema', () => {
	test('the path is relative to the file, with fixed names for shared blocks and Site Settings', () => {
		assert.equal(schemaRef({ name: 'pages', kind: 'sections' }, 'content/pages/about.json'), '../../schemas/pages.schema.json');
		assert.equal(schemaRef({ name: 'pages', kind: 'sections' }, 'content/pages/studio/visit.json'), '../../../schemas/pages.schema.json');
		assert.equal(schemaRef({ name: 'blocks', kind: 'shared' }, 'content/shared/a.json'), '../../schemas/shared.schema.json');
		assert.equal(schemaRef({ name: 'settings', kind: 'settings' }, 'content/site-settings.json'), '../schemas/site-settings.schema.json');
	});

	test('a missing key goes first, in the file\'s own indentation; a right one is left; a wrong one is corrected in place', () => {
		const ref = '../../schemas/pages.schema.json';
		assert.equal(stampSchema('{\n\t"title": "A",\n\t"blocks": []\n}\n', ref), `{\n\t"$schema": "${ref}",\n\t"title": "A",\n\t"blocks": []\n}\n`);
		assert.equal(stampSchema('{ "title": "A" }', ref), `{ "$schema": "${ref}", "title": "A" }`);
		assert.equal(stampSchema('{}\n', ref), `{\n  "$schema": "${ref}"\n}\n`);
		assert.equal(stampSchema(PAGE, ref), PAGE);
		assert.equal(stampSchema(PAGE, '../x.json'), PAGE.replace(ref, '../x.json'));
		assert.equal(stampSchema('{\n  "title": "A"\n}\n', ref, { add: false }), '{\n  "title": "A"\n}\n');
		assert.equal(stampSchema('not json', ref), 'not json');
		assert.equal(stampSchema('[1]', ref), '[1]');
	});
});

describe('reading ignores $schema', () => {
	test('each kind reads as it would without the key, with no warning', async () => {
		const listed = await listDocuments(s.site);
		const mine = ['content/pages/about.json', 'content/case-studies/pots.json', 'content/shared/footer.json', 'content/site-settings.json'];
		for (const file of mine) {
			const d = listed.find((e) => e.file === file);
			assert.ok(d && !d.warning, `${file}: ${d?.warning?.message ?? 'not listed'}`);
		}
		const page = (await readDocument(s.site, 'pages', 'about')).document as SiteDocument;
		assert.equal(page.title, 'About');
		assert.equal(page.blocks.length, 1);
		assert.equal(page.blocks[0]!.known, true);
		const fields = (await readDocument(s.site, 'case-studies', 'pots')).document as FieldsDocument;
		assert.deepEqual(Object.keys(fields.data), ['client']);
		const shared = (await readDocument(s.site, 'shared', 'footer')).document as SharedDocument;
		assert.equal(shared.block.type, 'cta');
		const settings = (await readDocument(s.site, 'settings', 'site-settings')).document as SettingsDocument;
		assert.ok(!Object.hasOwn(settings.data, '$schema'));
	});
});

describe('saving keeps $schema first', () => {
	test('a page: a new title, new blocks and a key new to the file all go after it', async () => {
		const { document } = await readDocument(s.site, 'pages', 'about');
		const doc = document as SiteDocument;
		const out = applyEdits(PAGE, { ...doc, title: 'About us', blocks: [...doc.blocks, { ...doc.blocks[0]!, source: null }], seo: { title: 'S' } }, s.site);
		assert.equal(firstKey(out), '$schema');
		assert.equal(JSON.parse(out).title, 'About us');
		// A file with no title yet: the title is added, and $schema stays first.
		const untitled = '{\n  "$schema": "../../schemas/pages.schema.json",\n  "blocks": []\n}\n';
		assert.equal(firstKey(applyEdits(untitled, { title: 'T', blocks: [] }, s.site)), '$schema');
	});

	test('a fields document, a shared block and Site Settings', async () => {
		const fields = applyKeyedEdits(FIELDS, { title: 'Pots!', data: { client: 'A kitchen shop' } }, s.site.collections['case-studies']!);
		assert.deepEqual(Object.keys(JSON.parse(fields)), ['$schema', 'title', 'client']);
		const noTitle = applyKeyedEdits('{\n  "$schema": "x"\n}\n', { title: 'New', data: { client: 'C' } }, s.site.collections['case-studies']!);
		assert.deepEqual(Object.keys(JSON.parse(noTitle)), ['$schema', 'title', 'client']);
		const shared = parseAnyDocument(JSON.parse(SHARED), s.site, s.site.collections.shared!) as SharedDocument;
		const sharedOut = applySharedEdits(SHARED, { ...shared, title: 'Foot', block: { ...shared.block, data: { ...shared.block.data, text: 'Hi' } } }, s.site);
		assert.deepEqual(Object.keys(JSON.parse(sharedOut)), ['$schema', 'title', 'block']);
		const settings = parseAnyDocument(JSON.parse(SETTINGS), s.site, s.site.collections.settings!) as SettingsDocument;
		const settingsOut = applyDocumentEdits(SETTINGS, { ...settings, data: { ...settings.data, editors: ['a@b.c'] } }, s.site, s.site.collections.settings!);
		assert.equal(firstKey(settingsOut), '$schema');
		assert.deepEqual(JSON.parse(settingsOut).editors, ['a@b.c']);
	});

	test('a save never adds the key to a file without it', async () => {
		const plain = '{\n  "title": "Pots",\n  "client": "Pots & Pans etc."\n}\n';
		const out = applyKeyedEdits(plain, { title: 'Pots', data: { client: 'Other' } }, s.site.collections['case-studies']!);
		assert.ok(!out.includes('$schema'));
	});
});

describe('a new document names its schema', () => {
	test('each kind the editor creates starts with $schema', async () => {
		const listed = await listDocuments(s.site);
		const page = planCreate(s.site, { collection: 'pages', path: 'studio/visit', title: 'Visit' }, listed);
		assert.equal(page.text, '{\n  "$schema": "../../../schemas/pages.schema.json",\n  "title": "Visit",\n  "blocks": []\n}\n');
		const fields = planCreate(s.site, { collection: 'case-studies', path: 'new-one', title: 'New' }, listed);
		assert.equal(firstKey(fields.text), '$schema');
		const shared = planCreate(s.site, { collection: 'shared', path: 'banner', title: 'Banner', blockType: 'cta' }, listed);
		assert.equal(JSON.parse(shared.text).$schema, '../../schemas/shared.schema.json');
		assert.equal((shared.document as SharedDocument).block.type, 'cta');
	});
});

describe('a move', () => {
	test('a file\'s $schema path follows it to a deeper folder', async () => {
		const listed = await listDocuments(s.site);
		const plan = planMove(s.site, { collection: 'pages', path: 'about', to: 'studio/about' }, listed);
		const read = async (file: string) => {
			try {
				return readFileSync(join(s.root, file), 'utf8');
			} catch {
				return null;
			}
		};
		const changes = await movesChanges(s.site, [plan], listed, read, () => false);
		assert.equal(JSON.parse(changes.moved[0]!.text).$schema, '../../../schemas/pages.schema.json');
		assert.equal(firstKey(changes.moved[0]!.text), '$schema');
	});
});
