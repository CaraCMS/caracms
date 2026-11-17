/**
 * The collections table's view (pre-M7 polish: collections/table.ts): its columns from
 * the config, what a cell shows, find, filters and sorting.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { date, list, reference, select, text, toggle, lockup, number } from '../src/config.ts';
import { captionColumns, cellText, cellValue, defaultView, filterable, nextSort, orderOptions, refIndex, refParts, sortable, tableColumns, viewRows } from '../src/editor/client/collections/table.ts';
import type { ListedDocument } from '../src/editor/types.ts';
import type { Fields } from '../src/fields.ts';

const fields: Fields = {
	heading: lockup({ style: 'display' }),
	client: text({ label: 'Client' }),
	sector: select({
		label: 'Sector',
		options: [
			{ value: 'food', label: 'Food and drink' },
			{ value: 'craft', label: 'Craft' },
		],
	}),
	featured: toggle({ label: 'Featured' }),
	launched: date({ label: 'Launched' }),
	rank: number(),
};

const doc = (path: string, title: string, columns: Record<string, unknown>, mtimeMs: number | null = 0): ListedDocument => ({
	collection: 'case-studies',
	kind: 'fields',
	path,
	file: `content/case-studies/${path}.json`,
	url: `/work/${path}`,
	title,
	label: title,
	warning: null,
	mtimeMs,
	columns,
});

const DOCS = [
	doc('roaster', 'High-street coffee roaster', { client: 'A coffee roaster', sector: 'food', featured: true, launched: '2024-05-02', rank: 2 }, 3000),
	doc('pots', 'Pots & Pans etc.', { client: 'A kitchen shop', sector: 'craft', featured: false, launched: '2025-01-10' }, 1000),
	doc('apple', 'apple orchard', { sector: 'food' }, null),
];

describe('the collections table', () => {
	test('columns: the title, then the config\'s (fields by key, the built-ins); by default the address and last edited', () => {
		const configured = tableColumns({ fields, columns: ['client', 'sector', 'launched', 'featured', 'edited'] });
		assert.deepEqual(
			configured.map((c) => [c.key, c.label, c.kind]),
			[
				['title', 'Title', 'title'],
				['client', 'Client', 'text'],
				['sector', 'Sector', 'select'],
				['launched', 'Launched', 'date'],
				['featured', 'Featured', 'toggle'],
				['edited', 'Last edited', 'edited'],
			],
		);
		assert.deepEqual(
			tableColumns({ fields: null, columns: null }).map((c) => c.key),
			['title', 'address', 'edited'],
		);
		// A field that can't be a column (a lockup) or isn't there is left out.
		assert.deepEqual(
			tableColumns({ fields, columns: ['heading', 'nope', 'rank'] }).map((c) => c.key),
			['title', 'rank'],
		);
		assert.deepEqual(filterable(configured).map((c) => c.key), ['sector', 'featured']);
		// Shared blocks have no address.
		assert.deepEqual(
			tableColumns({ fields: null, columns: null, urlBase: null }).map((c) => c.key),
			['title', 'edited'],
		);
	});

	test('cells: a select by its label, a day in words, a toggle as a mark, the edited time by the given clock', () => {
		const columns = tableColumns({ fields, columns: ['client', 'sector', 'launched', 'featured', 'edited', 'address'] });
		const at = (key: string) => columns.find((c) => c.key === key)!;
		const edited = (ms: number) => `at ${ms}`;
		assert.equal(cellText(DOCS[0]!, at('sector'), edited), 'Food and drink');
		assert.equal(cellText(DOCS[0]!, at('launched'), edited), '2 May 2024');
		assert.equal(cellText(DOCS[0]!, at('featured'), edited), 'Yes');
		assert.equal(cellText(DOCS[1]!, at('featured'), edited), '');
		assert.equal(cellText(DOCS[0]!, at('edited'), edited), 'at 3000');
		assert.equal(cellText(DOCS[2]!, at('edited'), edited), '');
		assert.equal(cellText(DOCS[0]!, at('address'), edited), '/work/roaster');
		assert.equal(cellText(DOCS[2]!, at('client'), edited), '');
		// A toggle with no value is its default (off).
		assert.equal(cellValue(DOCS[2]!, at('featured')), false);
	});

	test('sorting: by title by default (as a reader reads it); by any column either way; no value last', () => {
		const columns = tableColumns({ fields, columns: ['client', 'launched', 'edited', 'featured'] });
		const order = (sort = defaultView().sort) => viewRows(DOCS, columns, { ...defaultView(), sort }).map((d) => d.path);
		assert.deepEqual(order(), ['apple', 'roaster', 'pots']);
		assert.deepEqual(order({ key: 'title', dir: 'desc' }), ['pots', 'roaster', 'apple']);
		assert.deepEqual(order({ key: 'launched', dir: 'asc' }), ['roaster', 'pots', 'apple']);
		assert.deepEqual(order({ key: 'launched', dir: 'desc' }), ['pots', 'roaster', 'apple']);
		assert.deepEqual(order({ key: 'edited', dir: 'desc' }), ['roaster', 'pots', 'apple']);
		assert.deepEqual(order({ key: 'featured', dir: 'asc' }), ['roaster', 'apple', 'pots']);
		assert.deepEqual(nextSort({ key: 'title', dir: 'asc' }, 'title'), { key: 'title', dir: 'desc' });
		assert.deepEqual(nextSort({ key: 'title', dir: 'desc' }, 'client'), { key: 'client', dir: 'asc' });
	});

	test('find and filters narrow it together', () => {
		const columns = tableColumns({ fields, columns: ['sector', 'featured'] });
		const rows = (patch: Partial<ReturnType<typeof defaultView>>) => viewRows(DOCS, columns, { ...defaultView(), ...patch }).map((d) => d.path);
		assert.deepEqual(rows({ filters: { sector: 'food' } }), ['apple', 'roaster']);
		assert.deepEqual(rows({ filters: { sector: 'food', featured: true } }), ['roaster']);
		assert.deepEqual(rows({ filters: { featured: false } }), ['apple', 'pots']);
		assert.deepEqual(rows({ query: 'pots' }), ['pots']);
		assert.deepEqual(rows({ query: 'coffee', filters: { sector: 'craft' } }), []);
		// A filter on a column the config no longer has is ignored.
		assert.deepEqual(rows({ filters: { client: 'A kitchen shop' } }), ['apple', 'roaster', 'pots']);
	});

	describe('posts and tags (Decision 13): page fields, references, a default sort', () => {
		const postFields: Fields = { date: date(), tags: list(reference({ to: 'tags' })), author: reference({ to: 'people' }) };
		const listed = (collection: string, path: string, title: string, columns?: Record<string, unknown>): ListedDocument => ({
			collection,
			kind: collection === 'journal' ? 'sections' : 'fields',
			path,
			file: `content/${collection}/${path}.json`,
			url: `/${collection}/${path}`,
			title,
			label: title,
			warning: null,
			mtimeMs: 0,
			...(columns ? { columns } : {}),
		});
		const others = [listed('tags', 'print', 'Print'), listed('tags', 'kilns', 'Kilns'), listed('tags', 'dyes', 'Dyes'), listed('people', 'ada', 'Ada'), listed('people', 'bo', 'Bo')];
		const POSTS = [
			listed('journal', 'a', 'A post', { date: '2026-03-01', tags: ['print', 'kilns'], author: 'bo' }),
			listed('journal', 'b', 'B post', { date: '2025-11-20', tags: ['dyes'], author: 'gone' }),
			listed('journal', 'c', 'C post', { date: null, tags: ['print', 'gone'], author: 'ada' }),
			listed('journal', 'd', 'D post', { date: '2026-03-01', tags: [], author: null }),
		];
		const refs = refIndex([...others, ...POSTS]);
		const columns = tableColumns({ fields: postFields, columns: ['date', 'tags', 'author', 'edited'] });
		const col = (key: string) => columns.find((c) => c.key === key)!;
		const order = (sort: { key: string; dir: 'asc' | 'desc' }) => viewRows(POSTS, columns, { ...defaultView(), sort }, refs).map((d) => d.path);

		test('a section builder\'s page fields are columns; a reference and a list of references know their collection', () => {
			assert.deepEqual(columns.map((c) => [c.key, c.kind, c.to ?? null]), [['title', 'title', null], ['date', 'date', null], ['tags', 'references', 'tags'], ['author', 'reference', 'people'], ['edited', 'edited', null]]);
		});

		test('cells: a reference by its title, Missing when it\'s gone; a list joined by commas', () => {
			const text = (path: string, key: string) => cellText(POSTS.find((d) => d.path === path)!, col(key), () => '', refs);
			assert.equal(text('a', 'author'), 'Bo');
			assert.equal(text('b', 'author'), 'Missing');
			assert.equal(text('d', 'author'), '');
			assert.equal(text('a', 'tags'), 'Print, Kilns');
			assert.equal(text('c', 'tags'), 'Print, Missing');
			assert.equal(text('d', 'tags'), '');
			assert.deepEqual(refParts(POSTS[2]!, col('tags'), refs), [{ path: 'print', title: 'Print' }, { path: 'gone', title: null }]);
			// The sort value of a missing reference is none, so it goes last.
			assert.equal(cellValue(POSTS[1]!, col('author'), refs), null);
		});

		test('sorting: a reference by its title; dates newest first with undated last both ways; a list of references doesn\'t sort', () => {
			assert.deepEqual(order({ key: 'author', dir: 'asc' }), ['c', 'a', 'b', 'd']);
			assert.deepEqual(order({ key: 'author', dir: 'desc' }), ['a', 'c', 'b', 'd']);
			assert.deepEqual(order({ key: 'date', dir: 'desc' }), ['a', 'd', 'b', 'c']);
			assert.deepEqual(order({ key: 'date', dir: 'asc' }), ['b', 'a', 'd', 'c']);
			assert.equal(sortable(col('tags')), false);
			assert.equal(sortable(col('author')), true);
			// A sort on a list of references falls back to the title, that way.
			assert.deepEqual(order({ key: 'tags', dir: 'desc' }), ['d', 'c', 'b', 'a']);
			assert.ok(!orderOptions(columns, defaultView().sort).some((o) => o.sort.key === 'tags'), 'no grid order by tags');
		});

		test('filters: a reference picks one document; a list keeps the rows that include it', () => {
			assert.deepEqual(filterable(columns).map((c) => c.key), ['tags', 'author']);
			const rows = (filters: Record<string, string>) => viewRows(POSTS, columns, { ...defaultView(), filters }, refs).map((d) => d.path);
			assert.deepEqual(rows({ tags: 'print' }), ['a', 'c']);
			assert.deepEqual(rows({ tags: 'dyes' }), ['b']);
			assert.deepEqual(rows({ author: 'ada' }), ['c']);
			assert.deepEqual(rows({ tags: 'print', author: 'bo' }), ['a']);
		});

		test('the view opens in the config\'s sort, else the title A to Z', () => {
			assert.deepEqual(defaultView({ column: 'date', order: 'desc' }).sort, { key: 'date', dir: 'desc' });
			assert.deepEqual(defaultView(null).sort, { key: 'title', dir: 'asc' });
			assert.deepEqual(defaultView().sort, { key: 'title', dir: 'asc' });
		});

		test('captions: a section builder with page-field columns captions as a list of fields does; without, last edited', () => {
			assert.deepEqual(captionColumns({ kind: 'sections' }, columns).map((c) => c.key), ['date', 'tags']);
			assert.deepEqual(captionColumns({ kind: 'sections' }, tableColumns({ fields: postFields, columns: null })).map((c) => c.key), ['edited']);
		});
	});
});
