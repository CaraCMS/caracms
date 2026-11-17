// Navigation without a browser (Phase 4): the Pages tree's rows and order
// (Decision 8), "Find a document" and ⌘K's search (Decision 9), and a collection's filter.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { listDocuments } from '../src/content.ts';
import { filterCollection, parentLabel, searchDocuments } from '../src/editor/client/nav/search.ts';
import { treeRows } from '../src/editor/client/nav/tree.ts';
import type { EditorCollection, ListedDocument } from '../src/editor/types.ts';
import { site } from './helpers/site.ts';

const listed = async (): Promise<ListedDocument[]> => (await listDocuments(site)).map((d) => ({ ...d, mtimeMs: 0 }));
const collections: EditorCollection[] = Object.values(site.collections)
	.filter((c) => c.kind === 'sections')
	.map(({ name, label, kind, urlBase, nested, fields }) => ({ name, label, kind, urlBase, nested, fields }));
const label = (r: ReturnType<typeof treeRows>[number]) => (r.kind === 'group' ? `[${r.label}]` : r.kind === 'held' ? `{${r.label} · ${r.count}}` : r.kind === 'folder' ? `(${r.label})` : r.doc.label);

describe('the Pages tree', () => {
	test('Home first, then what has pages under it A–Z, then the rest A–Z (arrange pages, Decision 7); folders with no page are groups; everything closed hides children', async () => {
		const pages = (await listed()).filter((d) => d.collection === 'pages');
		const rows = treeRows('pages', pages, {});
		assert.deepEqual(rows.map(label), ['Home', 'About', '[Case studies]', '[Services]', 'Broken', 'Contact', 'Untitled', 'Work']);
		const about = rows.find((r) => r.kind === 'page' && r.path === 'about')! as Extract<ReturnType<typeof treeRows>[number], { kind: 'page' }>;
		assert.equal(about.kind === 'page' && about.parent, true, 'About has a page under it, so it gets a chevron');
		assert.equal(about.open, false);
		const services = rows.find((r) => r.kind === 'group' && r.path === 'services')! as Extract<ReturnType<typeof treeRows>[number], { kind: 'group' }>;
		assert.equal(services.key, 'pages:services');
		assert.equal(services.depth, 0);
	});

	test('collections under pages (Decision 4): a held collection is one row, the first under its holder, open or closed, with every document counted', async () => {
		const pages = (await listed()).filter((d) => d.collection === 'pages');
		const held = [{ collection: 'journal', label: 'Journal', holder: 'about', files: ['a', 'b', 'c'] }];
		const closed = treeRows('pages', pages, {}, held);
		assert.deepEqual(closed.map(label).slice(0, 4), ['Home', 'About', '{Journal · 3}', '[Case studies]']);
		assert.equal(closed[2]!.depth, 1);
		const opened = treeRows('pages', pages, { 'pages:about': true }, held).map(label);
		assert.equal(opened.indexOf('{Journal · 3}'), opened.indexOf('About') + 1, 'above the pages under it');
	});
	test('an open group or parent shows its children one level deeper, in order', async () => {
		const pages = (await listed()).filter((d) => d.collection === 'pages');
		const rows = treeRows('pages', pages, { 'pages:services': true, 'pages:about': true });
		assert.deepEqual(rows.map(label), [
			'Home',
			'About',
			'Team',
			'[Case studies]',
			'[Services]',
			'Index', // the reader puts a nested index.json first in its folder; it's warned and won't open
			'Branding',
			'Print',
			'Websites',
			'Broken',
			'Contact',
			'Untitled',
			'Work',
		]);
		const branding = rows.find((r) => r.kind === 'page' && r.path === 'services/branding')!;
		assert.equal(branding.depth, 1);
		const nestedIndex = rows.find((r) => r.kind === 'page' && r.path === 'services/index');
		assert.equal(nestedIndex?.kind === 'page' && nestedIndex.doc.warning?.code, 'nested-index', 'a nested index.json is listed with its warning');
	});

	test('files that can\'t be opened are listed with their warning', async () => {
		const pages = (await listed()).filter((d) => d.collection === 'pages');
		const codes = Object.fromEntries(pages.filter((d) => d.warning).map((d) => [d.path, d.warning!.code]));
		assert.deepEqual(codes, { broken: 'invalid-json', 'services/index': 'nested-index', untitled: 'no-title' });
	});
});

describe('search', () => {
	test('finds a nested page by its title, with its parent in front', async () => {
		const docs = await listed();
		const groups = searchDocuments('brand', docs, collections);
		assert.deepEqual(groups.map((g) => g.collection.name), ['pages']);
		assert.deepEqual(groups[0]!.hits.map((h) => [h.crumb, h.doc.label]), [['Services', 'Branding']]);
	});

	test('matches the parent\'s name and the address too, and is grouped by collection', async () => {
		const docs = await listed();
		const byParent = searchDocuments('services', docs, collections)[0]!.hits.map((h) => h.doc.path);
		assert.ok(byParent.includes('services/print') && byParent.includes('services/websites'));
		const byAddress = searchDocuments('/journal/zebra', docs, collections);
		assert.deepEqual(byAddress.map((g) => [g.collection.name, g.hits.map((h) => h.doc.label), g.total]), [['journal', ['Zebra crossings'], 2]]);
		const both = searchDocuments('a', docs, collections).map((g) => g.collection.name);
		assert.deepEqual(both, ['pages', 'journal'], 'groups follow the config order');
	});

	test('words match in any order, ignoring case and accents; a blank query matches nothing', async () => {
		const docs = await listed();
		assert.equal(searchDocuments('CROSSINGS zebra', docs, collections)[0]?.hits[0]?.doc.label, 'Zebra crossings');
		assert.deepEqual(searchDocuments('   ', docs, collections), []);
		assert.deepEqual(searchDocuments('nothing like this', docs, collections), []);
	});

	test('a collection\'s own filter', async () => {
		const journal = (await listed()).filter((d) => d.collection === 'journal');
		assert.deepEqual(filterCollection('app', journal).map((d) => d.label), ['Apples']);
		assert.equal(filterCollection('', journal).length, 2);
	});

	test('parentLabel: a parent page\'s label, else the folder title-cased', async () => {
		const docs = await listed();
		assert.equal(parentLabel({ collection: 'pages', path: 'about/team' }, docs), 'About');
		assert.equal(parentLabel({ collection: 'pages', path: 'case-studies/alpha' }, docs), 'Case studies');
		assert.equal(parentLabel({ collection: 'pages', path: 'work' }, docs), '');
	});
});
