// Decision 8's edges, on a throwaway Pages folder: paths deeper than two levels, a
// parent page two levels down, the folder label rule, Home first whatever its title,
// and `index.json` meaning "/" at the top only.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DocumentError, listDocuments, pageTree, readDocument, resolveDocumentFile, type PageTreeNode } from '../src/content.ts';
import { resolveSite } from '../src/config.ts';
import { parentLabel } from '../src/editor/client/nav/search.ts';
import { treeRows } from '../src/editor/client/nav/tree.ts';
import type { ListedDocument } from '../src/editor/types.ts';
import { fileURLToPath } from 'node:url';
import { config, siteRoot } from './helpers/site.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const tmp = join(packageRoot, 'test/.tmp');
let base: string;
let root: string;
let site: ReturnType<typeof resolveSite>;

const FILES: Record<string, string> = {
	// Home's title isn't "Home": it's first because its path is index.json.
	'index.json': 'Welcome to CaraCMS',
	'zebra.json': 'Zebra',
	'about.json': 'About',
	// two levels, a parent page at the second level, a group at the third
	'a/b/c/d.json': 'Deep page',
	'a/b/c/e.json': 'Another deep page',
	'a/b/own.json': 'Own page at level two',
	'a/b/own/child.json': 'Child of a deeper parent',
	'a/b/own/grand/leaf.json': 'Leaf under a group under a page',
	// the label rule
	'case-studies/alpha.json': 'Alpha',
	'big-client_work/two-words/x.json': 'X',
	'camelCaseFolder/y.json': 'Y',
	// a nested index.json at depth three is the same error as at depth one
	'a/b/c/index.json': 'Nested index',
};

before(() => {
	mkdirSync(tmp, { recursive: true });
	base = mkdtempSync(join(tmp, 'depth-'));
	root = join(base, 'site');
	mkdirSync(root);
	// The config names its font files relative to the site root ("../fonts/…").
	cpSync(join(siteRoot, '../fonts'), join(base, 'fonts'), { recursive: true });
	cpSync(`${siteRoot}/Block.astro`, join(root, 'Block.astro'));
	for (const [file, title] of Object.entries(FILES)) {
		const path = join(root, 'content/pages', file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ title, blocks: [] }, null, 2) + '\n');
	}
	mkdirSync(join(root, 'content/journal'), { recursive: true });
	site = resolveSite(config, root);
});
after(() => rmSync(base, { recursive: true, force: true }));

const outline = (nodes: PageTreeNode[], depth = 0): string[] =>
	nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.kind === 'group' ? '[' + n.label + ']' : n.label}`, ...outline(n.children, depth + 1)]);

describe('Pages deeper than two levels', () => {
	test('the path is the URL at any depth', async () => {
		const pages = await listDocuments(site, 'pages');
		const url = (path: string) => pages.find((e) => e.path === path)?.url;
		assert.equal(url('a/b/c/d'), '/a/b/c/d');
		assert.equal(url('a/b/own'), '/a/b/own');
		assert.equal(url('a/b/own/child'), '/a/b/own/child');
		assert.equal(url('a/b/own/grand/leaf'), '/a/b/own/grand/leaf');
		assert.equal(url('index'), '/');
	});

	test('the tree: Home first whatever its title, then what has pages under it A–Z, then the rest A–Z, at every level (arrange pages, Decision 7); groups and a parent page nest', async () => {
		const pages = await listDocuments(site, 'pages');
		assert.deepEqual(outline(pageTree(pages)), [
			'Welcome to CaraCMS',
			'[A]',
			'  [B]',
			'    [C]',
			'      Index', // a nested index.json sorts first in its folder; it's warned and never opens
			'      Another deep page',
			'      Deep page',
			'    Own page at level two',
			'      [Grand]',
			'        Leaf under a group under a page',
			'      Child of a deeper parent',
			'[Big client work]',
			'  [Two words]',
			'    X',
			'[Camel case folder]',
			'  Y',
			'[Case studies]',
			'  Alpha',
			'About',
			'Zebra',
		]);
	});

	test('the sidebar rows indent one step per level and hide under any closed folder', async () => {
		const pages = (await listDocuments(site, 'pages')).map((d): ListedDocument => ({ ...d, mtimeMs: 0 }));
		const label = (r: ReturnType<typeof treeRows>[number]) => (r.kind === 'group' ? `[${r.label}]` : r.kind === 'held' ? `{${r.label} · ${r.count}}` : r.kind === 'folder' ? `(${r.label})` : r.doc.label);
		const closed = treeRows('pages', pages, {});
		assert.deepEqual(closed.map((r) => [label(r), r.depth]), [
			['Welcome to CaraCMS', 0],
			['[A]', 0],
			['[Big client work]', 0],
			['[Camel case folder]', 0],
			['[Case studies]', 0],
			['About', 0],
			['Zebra', 0],
		]);
		// Open a, a/b and a/b/own: the rows go down to depth 3, each a step deeper.
		const open = treeRows('pages', pages, { 'pages:a': true, 'pages:a/b': true, 'pages:a/b/own': true });
		const depths = Object.fromEntries(open.map((r) => [r.kind === 'group' ? `${r.path}/` : r.path, r.depth]));
		assert.equal(depths['a/'], 0);
		assert.equal(depths['a/b/'], 1);
		assert.equal(depths['a/b/c/'], 2);
		assert.equal(depths['a/b/own'], 2);
		assert.equal(depths['a/b/own/child'], 3);
		assert.equal(depths['a/b/own/grand/'], 3);
		assert.equal(open.some((r) => r.kind === 'page' && r.path === 'a/b/c/d'), false, 'a/b/c is still closed, so its pages are hidden');
		const own = open.find((r) => r.kind === 'page' && r.path === 'a/b/own')!;
		assert.equal(own.kind === 'page' && own.parent, true, 'a parent page two levels down gets its chevron');
		assert.equal(own.kind === 'page' && own.under.length, 2, 'its children, any depth');
		// Opening only the inner folder shows nothing of it: a closed ancestor hides everything below.
		const innerOnly = treeRows('pages', pages, { 'pages:a/b': true });
		assert.equal(innerOnly.some((r) => r.path.startsWith('a/b')), false);
	});

	test('index.json is "/" at the top only: a nested one, at any depth, is warned and never opens', async () => {
		const pages = await listDocuments(site, 'pages');
		const nested = pages.find((e) => e.path === 'a/b/c/index')!;
		assert.equal(nested.url, null);
		assert.equal(nested.warning?.code, 'nested-index');
		await assert.rejects(readDocument(site, 'pages', 'a/b/c/index'), (e: unknown) => e instanceof DocumentError && e.code === 'nested-index');
		assert.equal(pages.find((e) => e.path === 'index')?.warning, null);
	});

	test('a deeper path is confined like any other', () => {
		assert.ok(resolveDocumentFile(site, 'pages', 'a/b/own/grand/leaf').endsWith('content/pages/a/b/own/grand/leaf.json'));
		assert.throws(() => resolveDocumentFile(site, 'pages', 'a/b/../../../outside'), DocumentError);
	});
});

describe('the folder label rule', () => {
	test('hyphens and underscores become spaces, the first letter a capital, the rest lowercase', async () => {
		const pages = await listDocuments(site, 'pages');
		const labels = (nodes: PageTreeNode[]): string[] => nodes.flatMap((n) => (n.kind === 'group' ? [n.label] : []).concat(labels(n.children)));
		const all = labels(pageTree(pages));
		for (const expected of ['Case studies', 'Big client work', 'Two words', 'Camel case folder']) assert.ok(all.includes(expected), expected);
	});

	test('the same rule labels a document\'s parent in search and in the header, at any depth', async () => {
		const docs = (await listDocuments(site, 'pages')).map((d): ListedDocument => ({ ...d, mtimeMs: 0 }));
		assert.equal(parentLabel({ collection: 'pages', path: 'case-studies/alpha' }, docs), 'Case studies');
		assert.equal(parentLabel({ collection: 'pages', path: 'big-client_work/two-words/x' }, docs), 'Two words');
		assert.equal(parentLabel({ collection: 'pages', path: 'a/b/own/child' }, docs), 'Own page at level two', 'a parent page wins over its folder name');
		assert.equal(parentLabel({ collection: 'pages', path: 'a/b/c/d' }, docs), 'C');
		assert.equal(parentLabel({ collection: 'pages', path: 'zebra' }, docs), '');
	});
});

describe('other collections are flat lists', () => {
	test('a subfolder in a flat collection is not a tree: its files are not listed as nested documents', async () => {
		mkdirSync(join(root, 'content/journal/sub'), { recursive: true });
		writeFileSync(join(root, 'content/journal/post.json'), JSON.stringify({ title: 'Post', blocks: [] }));
		writeFileSync(join(root, 'content/journal/sub/hidden.json'), JSON.stringify({ title: 'Hidden', blocks: [] }));
		const journal = await listDocuments(site, 'journal');
		assert.deepEqual(journal.map((e) => e.path), ['post']);
		await assert.rejects(readDocument(site, 'journal', 'sub/hidden'));
	});
});
