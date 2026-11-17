// Page folders in the sidebar's pure code, no browser:
// - nav/tree.ts treeRows with the listing's folders: the folder row, its depth and count, the
//   rows under it indented one step, open/closed keys, a folder under a group (Decision 8, check 3, 10);
// - nav/search.ts: a page's crumb names its folders, a folder whose name matches is a hit (check 11);
// - ui-state withOpenAncestors opens the folders above a document (check 11).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { searchDocuments } from '../src/editor/client/nav/search.ts';
import { folderPath, treeRows, type TreeRow } from '../src/editor/client/nav/tree.ts';
import type { ListedFolders } from '../src/page-folders.ts';
import type { EditorCollection, ListedDocument } from '../src/editor/types.ts';
import { groupKey, withOpenAncestors } from '../src/editor/ui-state.ts';

const doc = (path: string, label: string) => ({ collection: 'pages', path, label, title: label, url: path === 'index' ? '/' : `/${path}`, file: `content/pages/${path}.json` }) as unknown as ListedDocument;
// In the listing's order: each folder's rows together in its place.
const documents = [
	doc('index', 'Home'),
	doc('about', 'About'),
	doc('about/team', 'Team'),
	doc('contact', 'Contact'),
	doc('privacy', 'Privacy'),
	doc('services/branding', 'Branding'),
	doc('services/websites', 'Websites'),
];
const folders: ListedFolders = {
	'': [{ id: 'company', name: 'Company', rows: ['about', 'contact'] }],
	services: [{ id: 'extras', name: 'Extras', rows: ['services/websites'] }],
};
const mark = (r: TreeRow) => `${r.kind === 'folder' ? `(${r.label} ${r.count})` : r.kind === 'group' ? `[${r.label}]` : r.kind === 'page' ? r.doc.label : r.label}@${r.depth}`;
const shown = (open: Record<string, boolean>, f: ListedFolders = folders) => treeRows('pages', documents, open, [], f).map(mark);

describe('treeRows with folders (check 3, 10)', () => {
	test('a folder row before its first row, its count the rows filed in it (not the pages under them), its rows one step in', () => {
		const all = { 'pages:(company)': true, 'pages:about': true, 'pages:services': true, 'pages:services/(extras)': true };
		assert.deepEqual(shown(all), ['Home@0', '(Company 2)@0', 'About@1', 'Team@2', 'Contact@1', 'Privacy@0', '[Services]@0', 'Branding@1', '(Extras 1)@1', 'Websites@2']);
		const rows = treeRows('pages', documents, all, [], folders);
		const company = rows.find((r) => r.kind === 'folder')!;
		assert.ok(company.kind === 'folder');
		assert.deepEqual([company.path, company.level, company.id, company.key, company.open, company.count], ['(company)', '', 'company', 'pages:(company)', true, 2]);
		assert.deepEqual(company.under.map((d) => d.path), ['about', 'about/team', 'contact']);
		const extras = rows.find((r) => r.kind === 'folder' && r.id === 'extras')!;
		assert.ok(extras.kind === 'folder');
		assert.deepEqual([extras.path, extras.level, extras.key], ['services/(extras)', 'services', 'pages:services/(extras)']);
	});
	test('closed (nothing opened): the folder row shows and hides its rows; a group stays a group', () => {
		assert.deepEqual(shown({}), ['Home@0', '(Company 2)@0', 'Privacy@0', '[Services]@0']);
	});
	test('a folder open opens its rows, but a page in it stays closed on its own key', () => {
		assert.deepEqual(shown({ 'pages:(company)': true }), ['Home@0', '(Company 2)@0', 'About@1', 'Contact@1', 'Privacy@0', '[Services]@0']);
		assert.deepEqual(shown({ 'pages:(company)': true, 'pages:about': true }), ['Home@0', '(Company 2)@0', 'About@1', 'Team@2', 'Contact@1', 'Privacy@0', '[Services]@0']);
	});
	test('a folder under a group shows only while the group is open; its own state is its own key', () => {
		assert.deepEqual(shown({ 'pages:services': true }), ['Home@0', '(Company 2)@0', 'Privacy@0', '[Services]@0', 'Branding@1', '(Extras 1)@1']);
		assert.deepEqual(shown({ 'pages:services': true, 'pages:services/(extras)': true }).slice(-3), ['Branding@1', '(Extras 1)@1', 'Websites@2']);
		// The folder's key alone, with its group closed, shows nothing of it.
		assert.deepEqual(shown({ 'pages:services/(extras)': true }), ['Home@0', '(Company 2)@0', 'Privacy@0', '[Services]@0']);
	});
	test('no folders: the same rows as before, no folder row', () => {
		const rows = treeRows('pages', documents, { 'pages:about': true, 'pages:services': true });
		assert.equal(rows.some((r) => r.kind === 'folder'), false);
		assert.deepEqual(rows.map(mark), ['Home@0', 'About@0', 'Team@1', 'Contact@0', 'Privacy@0', '[Services]@0', 'Branding@1', 'Websites@1']);
	});
	test('a folder and a group have different keys even with one name; folderPath names them', () => {
		assert.equal(folderPath('', 'company'), '(company)');
		assert.equal(folderPath('services', 'extras'), 'services/(extras)');
		assert.equal(groupKey('pages', folderPath('services', 'extras')), 'pages:services/(extras)');
	});
});

describe('Find with folders (check 11)', () => {
	const collections = [{ name: 'pages', label: 'Pages', nested: true }] as unknown as EditorCollection[];
	const find = (query: string) => searchDocuments(query, documents, collections, { collection: 'pages', folders });
	test('"team" finds Team with the crumb "Company / About"', () => {
		const [group] = find('team');
		assert.deepEqual(group!.hits.map((h) => [h.doc.path, h.crumb]), [['about/team', 'Company / About']]);
		assert.equal(group!.folders, undefined);
	});
	test('"comp" finds the Company folder as a hit of its own, with the pages filed in it', () => {
		const [group] = find('comp');
		assert.deepEqual(group!.folders, [{ level: '', id: 'company', name: 'Company', count: 2, crumb: '' }]);
		assert.deepEqual(group!.hits.map((h) => h.doc.path), ['about', 'about/team', 'contact']);
	});
	test('a folder under a group names the group in its crumb; without the folders nothing changes', () => {
		assert.deepEqual(find('extras')[0]!.folders, [{ level: 'services', id: 'extras', name: 'Extras', count: 1, crumb: 'Services' }]);
		const plain = searchDocuments('team', documents, collections);
		assert.deepEqual(plain[0]!.hits.map((h) => h.crumb), ['About']);
		assert.equal(searchDocuments('comp', documents, collections).length, 0);
	});
});

describe('opening a document opens its folders (check 11)', () => {
	test('Team opens About and the Company folder above it; a page under a group opens the group and its folder', () => {
		const state = withOpenAncestors({ open: {}, recent: [] }, { collection: 'pages', path: 'about/team' }, folders);
		assert.deepEqual(Object.keys(state.open).sort(), ['pages:(company)', 'pages:about']);
		const deep = withOpenAncestors({ open: {}, recent: [] }, { collection: 'pages', path: 'services/websites' }, folders);
		assert.deepEqual(Object.keys(deep.open).sort(), ['pages:services', 'pages:services/(extras)']);
	});
	test('a page in no folder opens no folder; nothing to change returns the same state', () => {
		const state = withOpenAncestors({ open: {}, recent: [] }, { collection: 'pages', path: 'privacy' }, folders);
		assert.deepEqual(state.open, {});
		const open = { open: { 'pages:(company)': true, 'pages:about': true }, recent: [] };
		assert.equal(withOpenAncestors(open, { collection: 'pages', path: 'about/team' }, folders), open);
	});
});
