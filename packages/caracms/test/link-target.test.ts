// Where a link in the preview goes (src/editor/client/preview/link-target.ts): the resolver
// behind following links from the page.
//
//   node --test --experimental-strip-types test/link-target.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { documentAt, linkTarget } from '../src/editor/client/preview/link-target.ts';
import type { ListedDocument } from '../src/editor/types.ts';

const doc = (collection: string, path: string, url: string | null): ListedDocument => ({
	collection,
	path,
	file: `content/${collection}/${path}.json`,
	url,
	title: path,
	label: path,
	warning: null,
	mtimeMs: 0,
});

const HOME = doc('pages', 'index', '/');
const ABOUT = doc('pages', 'about', '/about');
const BRANDING = doc('pages', 'services/branding', '/services/branding');
const JOURNAL = doc('pages', 'journal', '/journal');
const POST = doc('journal', 'a-new-home', '/journal/a-new-home');
const NESTED = doc('pages', 'services', null); // a nested index.json with no address
const docs = [HOME, ABOUT, BRANDING, JOURNAL, POST, NESTED];
const here = { origin: 'http://127.0.0.1:4326' };

describe('documentAt', () => {
	test('finds a document by its address, ignoring a trailing slash, query and hash', () => {
		assert.equal(documentAt('/about', docs), ABOUT);
		assert.equal(documentAt('/about/', docs), ABOUT);
		assert.equal(documentAt('/about?ref=nav', docs), ABOUT);
		assert.equal(documentAt('/about#team', docs), ABOUT);
		assert.equal(documentAt('/about/?a=1#b', docs), ABOUT);
		assert.equal(documentAt('/services/branding', docs), BRANDING);
		assert.equal(documentAt('/journal/a-new-home', docs), POST);
	});

	test('the root is Home', () => {
		assert.equal(documentAt('/', docs), HOME);
		assert.equal(documentAt('/?x=1', docs), HOME);
		assert.equal(documentAt('/#top', docs), HOME);
	});

	test('an unknown path, or something that is not a path, is none', () => {
		assert.equal(documentAt('/nowhere', docs), undefined);
		assert.equal(documentAt('about', docs), undefined);
		assert.equal(documentAt('https://example.com/about', docs), undefined);
		assert.equal(documentAt('/about', []), undefined);
	});

	test('a document with no address is never found', () => {
		assert.equal(documentAt('/services', docs), undefined);
	});
});

describe('linkTarget', () => {
	test('a document path is a document, labelled with its address', () => {
		assert.deepEqual(linkTarget('/about', here, docs), { kind: 'document', doc: ABOUT, label: '/about' });
		assert.deepEqual(linkTarget('/about/', here, docs), { kind: 'document', doc: ABOUT, label: '/about' });
		assert.deepEqual(linkTarget('/about?x=1', here, docs), { kind: 'document', doc: ABOUT, label: '/about' });
		assert.deepEqual(linkTarget('/about#team', here, docs), { kind: 'document', doc: ABOUT, label: '/about' });
		assert.deepEqual(linkTarget('/', here, docs), { kind: 'document', doc: HOME, label: '/' });
	});

	test('a paged listing is the listing\'s page', () => {
		assert.deepEqual(linkTarget('/journal/page/2', here, docs), { kind: 'document', doc: JOURNAL, label: '/journal' });
		assert.deepEqual(linkTarget('/journal/page/12/', here, docs), { kind: 'document', doc: JOURNAL, label: '/journal' });
	});

	test('a path with no document is none, labelled with the path', () => {
		assert.deepEqual(linkTarget('/nowhere', here, docs), { kind: 'none', label: '/nowhere' });
		assert.deepEqual(linkTarget('/nowhere/page/2', here, docs), { kind: 'none', label: '/nowhere/page/2' });
	});

	test('a spot on this page is none', () => {
		assert.deepEqual(linkTarget('#x', here, docs), { kind: 'none', label: 'On this page' });
		assert.deepEqual(linkTarget('', here, docs), { kind: 'none', label: 'On this page' });
	});

	test('mailto: and tel: are contacts labelled with the address', () => {
		assert.deepEqual(linkTarget('mailto:hello@example.com', here, docs), { kind: 'contact', label: 'hello@example.com' });
		assert.deepEqual(linkTarget('mailto:hello@example.com?subject=Hi', here, docs), { kind: 'contact', label: 'hello@example.com' });
		assert.deepEqual(linkTarget('MAILTO:a@b.test', here, docs), { kind: 'contact', label: 'a@b.test' });
		assert.deepEqual(linkTarget('tel:+35315550142', here, docs), { kind: 'contact', label: '+35315550142' });
	});

	test('another origin is external, labelled with its host', () => {
		assert.deepEqual(linkTarget('https://instagram.com/example', here, docs), {
			kind: 'external',
			href: 'https://instagram.com/example',
			label: 'instagram.com',
		});
		assert.equal((linkTarget('https://www.example.com/x', here, docs) as { label: string }).label, 'example.com');
		// Same host, another port: another origin.
		assert.equal(linkTarget('http://127.0.0.1:9999/about', here, docs).kind, 'external');
	});

	test('a same-origin absolute URL is a document', () => {
		assert.deepEqual(linkTarget('http://127.0.0.1:4326/about', here, docs), { kind: 'document', doc: ABOUT, label: '/about' });
		assert.equal(linkTarget('http://127.0.0.1:4326/about?x=1#y', here, docs).kind, 'document');
	});

	test('a file in public/ is external, labelled with its path', () => {
		assert.deepEqual(linkTarget('/brochure.pdf', here, docs), { kind: 'external', href: 'http://127.0.0.1:4326/brochure.pdf', label: '/brochure.pdf' });
		assert.equal(linkTarget('/files/menu.PNG', here, docs).kind, 'external');
	});

	test('other schemes are none', () => {
		assert.equal(linkTarget('javascript:void(0)', here, docs).kind, 'none');
		assert.equal(linkTarget('ftp://example.com/x', here, docs).kind, 'none');
	});
});
