// New page's and Change address…'s "Inside": the top level, every group and every page,
// a page with nothing under it yet included (2026-10-24), but never Home.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { insideOptions } from '../src/editor/client/documents/actions.ts';
import type { ListedDocument } from '../src/editor/types.ts';

const pages = { name: 'pages', urlBase: '/' };
const doc = (path: string, label: string) => ({ collection: 'pages', path, label }) as unknown as ListedDocument;

describe('insideOptions', () => {
	test('offers a page with nothing under it, so a page can go under it', () => {
		const docs = [doc('index', 'Home'), doc('services/advisory', 'Advisory'), doc('contact', 'Contact')];
		assert.deepEqual(insideOptions(pages, docs), [
			{ path: '', label: 'Top level', name: 'Top level', depth: 0, page: false, holds: true, base: '/' },
			{ path: 'services', label: 'Services', name: 'Services', depth: 1, page: false, holds: true, base: '/services/' },
			{ path: 'services/advisory', label: 'Services / Advisory', name: 'Advisory', depth: 2, page: true, holds: false, base: '/services/advisory/' },
			{ path: 'contact', label: 'Contact', name: 'Contact', depth: 1, page: true, holds: false, base: '/contact/' },
		]);
	});

	test('in the listing\'s order (the Pages tree\'s: Home, the saved order, what holds pages, A–Z), a group where its first page is', () => {
		// The server lists in tree order (content.ts → pageTree); a saved order put Contact first.
		const docs = [doc('contact', 'Contact'), doc('blog/one', 'One'), doc('work/kiln', 'Kiln'), doc('work/kiln/notes', 'Notes'), doc('work/ash', 'Ash'), doc('about', 'About')];
		assert.deepEqual(
			insideOptions(pages, docs).map((o) => `${o.depth}:${o.path}`),
			['0:', '1:contact', '1:blog', '2:blog/one', '1:work', '2:work/kiln', '3:work/kiln/notes', '2:work/ash', '1:about'],
		);
	});

	test('the same order as the listing the server builds with a saved order (Decision 19)', async () => {
		const { pageTree } = await import('../src/content.ts');
		const entries = ['about', 'about/team', 'contact', 'services/print', 'services/branding', 'journal'].map((path) => ({ collection: 'pages', path, label: path.split('/').pop()!.replace(/^./, (c) => c.toUpperCase()), file: `content/pages/${path}.json`, url: `/${path}` })) as never[];
		const flat = (nodes: { kind: string; entry?: unknown; children: never[] }[]): ListedDocument[] => nodes.flatMap((n) => [...(n.kind === 'page' ? [n.entry as ListedDocument] : []), ...flat(n.children)]);
		const listed = flat(pageTree(entries, { '': ['contact', 'services'], services: ['print'] }) as never);
		assert.deepEqual(
			insideOptions(pages, listed).map((o) => o.path),
			['', 'contact', 'services', 'services/print', 'services/branding', 'about', 'about/team', 'journal'],
		);
	});

	test('still offers groups and pages with pages under them, at any depth, once each', () => {
		const docs = [doc('about', 'About'), doc('about/team', 'Team'), doc('studio/visit', 'Visit'), doc('studio/visit/map', 'Map')];
		assert.deepEqual(
			insideOptions(pages, docs).map((o) => o.path),
			['', 'about', 'about/team', 'studio', 'studio/visit', 'studio/visit/map'],
		);
	});

	test('never offers Home, or a folder named index', () => {
		const docs = [doc('index', 'Home'), doc('about/index', 'About')];
		assert.deepEqual(
			insideOptions(pages, docs).map((o) => o.path),
			['', 'about'],
		);
	});

	test('only the collection asked for', () => {
		const docs = [doc('contact', 'Contact'), { collection: 'work', path: 'kiln', label: 'Kiln' } as unknown as ListedDocument];
		assert.deepEqual(
			insideOptions(pages, docs).map((o) => o.path),
			['', 'contact'],
		);
	});
});
