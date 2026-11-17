// The Redirects section's warning on a redirect's new address (redirectTargetProblem): a page,
// a file in the library and a route of the site's own code are all somewhere; an address with
// an extension isn't checked. One port wrote redirects from its old /files/<name>
// links to their /files/<hash>/<name> addresses and from /sitemap-index.xml to /sitemap.xml,
// and the section said "No page is at the address it goes to." for each.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redirectTargetProblem } from '../src/redirects.ts';

const NO_PAGE = 'No page is at the address it goes to.';
const NO_FILE = 'No file in the library is at the address it goes to.';
const site = {
	addresses: ['/', '/about', '/journal/first-post', null],
	codeRoutes: [{ file: 'src/pages/shop/[...slug].astro', url: '/shop/', dynamic: true, rest: true }],
	fileExists: (key: string) => key === 'uploads/0123456789ab/rules.pdf',
};

test("a document's address, whatever its case or trailing slash, is somewhere", () => {
	assert.equal(redirectTargetProblem('/about', site), null);
	assert.equal(redirectTargetProblem('/About/', site), null);
	assert.equal(redirectTargetProblem('/journal/first-post', site), null);
});

test('an address with no document says so', () => {
	assert.equal(redirectTargetProblem('/gone', site), NO_PAGE);
});

test("a file address is checked against the library: there is nothing to say, missing says it's a file", () => {
	assert.equal(redirectTargetProblem('/files/0123456789ab/rules.pdf', site), null);
	assert.equal(redirectTargetProblem('/files/ffffffffffff/old.pdf', site), NO_FILE);
});

test("before the library's keys are read, a file address isn't flagged", () => {
	assert.equal(redirectTargetProblem('/files/ffffffffffff/old.pdf', { addresses: site.addresses }), null);
});

test("an address the site's own code serves, or one with an extension, isn't flagged", () => {
	assert.equal(redirectTargetProblem('/shop/mugs', site), null);
	assert.equal(redirectTargetProblem('/sitemap.xml', site), null);
	assert.equal(redirectTargetProblem('/brochure.pdf', site), null);
});
