// PageProps' `path` (head.ts → documentPath): the document's address, whatever the build format
// (a `build.format: 'file'` site prerenders `/about` at `/about.html`).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { documentPath, withoutHtml } from '../src/head.ts';

const pub = (pathname: string, listPage = 1) => documentPath({ preview: false, previewUrl: null, pathname, listPage });

describe('documentPath', () => {
	test('a public render: the address, no trailing slash, decoded', () => {
		assert.equal(pub('/about/'), '/about');
		assert.equal(pub('/'), '/');
		assert.equal(pub('/caf%C3%A9'), '/café');
	});
	test("build.format 'file': the file's .html and /index.html come off", () => {
		assert.equal(pub('/about-us.html'), '/about-us');
		assert.equal(pub('/index.html'), '/');
		assert.equal(pub('/services/index.html'), '/services');
		assert.equal(pub('/services/print.html'), '/services/print');
	});
	test('a paged listing: its page number comes off, in either format', () => {
		assert.equal(pub('/journal/page/2', 2), '/journal');
		assert.equal(pub('/journal/page/2.html', 2), '/journal');
	});
	test('a preview: its document URL, as given', () => {
		assert.equal(documentPath({ preview: true, previewUrl: '/about', pathname: '/_caracms/preview', listPage: 1 }), '/about');
		assert.equal(documentPath({ preview: true, previewUrl: null, pathname: '/_caracms/preview', listPage: 1 }), null);
	});
	test('withoutHtml: only a final .html, and /index.html as the folder', () => {
		assert.equal(withoutHtml('/about.html'), '/about');
		assert.equal(withoutHtml('/index.html'), '/');
		assert.equal(withoutHtml('/html-guide'), '/html-guide');
		assert.equal(withoutHtml('/about'), '/about');
	});
});
