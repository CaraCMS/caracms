// The content reader (Decisions 5, 8, 9; Phase 1 → Verify 5).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DocumentError, documentUrl, listDocuments, pageTree, readDocument, resolveDocumentFile, type PageTreeNode } from '../src/content.ts';
import { parseDocument } from '../src/document.ts';
import type { SiteDocument } from '../src/document.ts';
import { site, siteRoot } from './helpers/site.ts';

const outline = (nodes: PageTreeNode[], depth = 0): string[] =>
	nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.kind === 'group' ? '[' + n.label + ']' : n.label}`, ...outline(n.children, depth + 1)]);

describe('listDocuments', () => {
	test('Pages: nested paths as URLs, in tree order (Home first, then what has pages under it A–Z, then the rest A–Z; arrange pages, Decision 7)', async () => {
		const pages = await listDocuments(site, 'pages');
		assert.deepEqual(
			pages.map((e) => [e.path, e.url, e.label, e.warning?.code ?? null]),
			[
				['index', '/', 'Home', null],
				['about', '/about', 'About', null],
				['about/team', '/about/team', 'Team', null],
				['case-studies/alpha', '/case-studies/alpha', 'Alpha', null],
				['services/index', null, 'Index', 'nested-index'],
				['services/branding', '/services/branding', 'Branding', null],
				['services/print', '/services/print', 'Print', null],
				['services/websites', '/services/websites', 'Websites', null],
				['broken', '/broken', 'Broken', 'invalid-json'],
				['contact', '/contact', 'Contact', null],
				['untitled', '/untitled', 'Untitled', 'no-title'],
				['work', '/work', 'Work', null],
			],
		);
		const team = pages.find((e) => e.path === 'about/team')!;
		assert.equal(team.collection, 'pages');
		assert.equal(team.file, 'content/pages/about/team.json');
		assert.equal(team.title, 'Team');
	});

	test('warnings are plain sentences', async () => {
		const pages = await listDocuments(site, 'pages');
		const by = (code: string) => pages.find((e) => e.warning?.code === code)!.warning!.message;
		assert.match(by('nested-index'), /index\.json only means the top of Pages\. Rename it to services\.json/);
		assert.match(by('invalid-json'), /isn't valid JSON/);
		assert.match(by('no-title'), /no title/);
	});

	test('a flat collection: /journal/<slug>, alphabetical by title', async () => {
		const journal = await listDocuments(site, 'journal');
		assert.deepEqual(
			journal.map((e) => [e.path, e.url, e.title]),
			[
				['apples', '/journal/apples', 'Apples'],
				['zebra-crossings', '/journal/zebra-crossings', 'Zebra crossings'],
			],
		);
	});

	test('every collection, in config order', async () => {
		const all = await listDocuments(site);
		assert.deepEqual([...new Set(all.map((e) => e.collection))], ['pages', 'journal']);
	});

	test('reads at request time: nothing is cached between calls', async () => {
		const a = await listDocuments(site, 'journal');
		const b = await listDocuments(site, 'journal');
		assert.notEqual(a, b);
		assert.deepEqual(a, b);
	});
});

describe('pageTree', () => {
	test('a page with pages under it, and a folder group with no page of its own', async () => {
		const pages = await listDocuments(site, 'pages');
		assert.deepEqual(outline(pageTree(pages)), [
			'Home',
			'About',
			'  Team',
			'[Case studies]',
			'  Alpha',
			'[Services]',
			'  Index',
			'  Branding',
			'  Print',
			'  Websites',
			'Broken',
			'Contact',
			'Untitled',
			'Work',
		]);
	});
});

describe('readDocument', () => {
	test('returns the text exactly as read, the entry and the parsed document', async () => {
		const { entry, text, document: doc } = await readDocument(site, 'pages', 'index');
		const document = doc as SiteDocument;
		assert.equal(entry.url, '/');
		assert.ok(text.startsWith('{\n  "title": "Home",'));
		assert.equal(document.title, 'Home');
		assert.deepEqual(document.blocks[0]!.data.heading, { lines: ['Building a better mousetrap', 'For You'], phone: null });
	});

	test('both lockup shapes (Decision 10)', async () => {
		const plain = await readDocument(site, 'journal', 'apples');
		assert.deepEqual((plain.document as SiteDocument).blocks[0]!.data.heading, { lines: ['Play Hard', 'Work Hard'], phone: null });
		const withPhone = await readDocument(site, 'journal', 'zebra-crossings');
		assert.deepEqual((withPhone.document as SiteDocument).blocks[0]!.data.heading, {
			lines: ['A small studio', 'with big ideas'],
			phone: ['A small', 'studio with', 'big ideas'],
		});
	});

	test('a nested index.json, invalid JSON and no title are refused', async () => {
		await assert.rejects(readDocument(site, 'pages', 'services/index'), (e: DocumentError) => e.code === 'nested-index');
		await assert.rejects(readDocument(site, 'pages', 'broken'), (e: DocumentError) => e.code === 'invalid-json');
		await assert.rejects(readDocument(site, 'pages', 'untitled'), (e: DocumentError) => e.code === 'no-title');
		await assert.rejects(readDocument(site, 'pages', 'nope'), (e: DocumentError) => e.code === 'not-found');
	});
});

describe('resolveDocumentFile (the confinement Phase 2\'s write route reuses)', () => {
	test('a declared collection\'s documents resolve inside its folder', () => {
		assert.equal(resolveDocumentFile(site, 'pages', 'services/branding'), `${siteRoot}/content/pages/services/branding.json`);
		assert.equal(resolveDocumentFile(site, 'journal', 'apples'), `${siteRoot}/content/journal/apples.json`);
	});

	for (const [collection, path, code] of [
		['pages', '../journal/apples', 'bad-path'],
		['pages', 'services/../../../package', 'bad-path'],
		['pages', '/etc/passwd', 'bad-path'],
		['pages', '', 'bad-path'],
		['pages', 'services//branding', 'bad-path'],
		['pages', '.hidden', 'bad-path'],
		['pages', 'a\\b', 'bad-path'],
		['journal', 'nested/post', 'bad-path'],
		['secrets', 'index', 'unknown-collection'],
		['constructor', 'index', 'unknown-collection'],
	] as const) {
		test(`refuses ${collection} / ${JSON.stringify(path)} (${code})`, () => {
			assert.throws(() => resolveDocumentFile(site, collection, path), (e: DocumentError) => e.code === code);
		});
	}
});

describe('parseDocument', () => {
	test('an unknown block is kept with its raw keys, so indexes match the file', () => {
		const doc = parseDocument({ title: 'T', blocks: [{ type: 'gallery', columns: 3 }, 'not an object', { type: 'text', heading: ' Hi ' }] }, site);
		assert.deepEqual(
			doc.blocks.map((b) => [b.source, b.type, b.known]),
			[
				[0, 'gallery', false],
				[1, '', false],
				[2, 'text', true],
			],
		);
		assert.deepEqual(doc.blocks[0]!.data, { columns: 3 });
		assert.deepEqual(doc.blocks[2]!.data, { heading: 'Hi', body: '', background: 'light' });
	});

	test('documentUrl: index at the top of a nested collection is its base', () => {
		assert.equal(documentUrl(site.collections.pages!, 'index'), '/');
		assert.equal(documentUrl(site.collections.pages!, 'services/index'), null);
		assert.equal(documentUrl(site.collections.journal!, 'index'), '/journal/index');
	});
});
