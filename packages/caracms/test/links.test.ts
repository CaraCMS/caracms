// The link rule (M5a Decision 4), the template's, shared by the editor and the render.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { internalLinkPath, isLinkHref, LINK_RULE_MESSAGE, missingLinkTarget, validateLink } from '../src/links.ts';

describe('validateLink', () => {
	const passes = [
		'/',
		'/contact',
		'/services/branding',
		'/brochure.pdf',
		'/work?tag=print#top',
		'https://example.com',
		'http://example.com/a_(b)',
		'mailto:hello@example.com',
		'tel:+353210000000',
		'tel:021 000 0000',
		'#contact',
		'#a:b.c-d_e',
		// Trial item 2: a bare `#` (a placeholder, the top of the page) and any HTML id.
		'#',
		'#1abc',
		'  /padded  ',
	];
	const fails = [
		'contact',
		'//evil.test',
		'www.example.com',
		'ftp://example.com',
		'javascript:alert(1)',
		'mailto:not-an-address',
		'tel:call me',
		'# top',
		'/has space',
		'https://',
		'https://exa mple.com',
	];
	for (const href of passes) test(`passes ${JSON.stringify(href)}`, () => assert.equal(validateLink(href), undefined));
	for (const href of fails) test(`fails ${JSON.stringify(href)} with the rule's message`, () => assert.equal(validateLink(href), LINK_RULE_MESSAGE));

	test('blank passes (an empty link is a different matter); non-strings pass', () => {
		for (const v of ['', '   ', undefined, null, 3]) assert.equal(validateLink(v), undefined);
	});

	test('isLinkHref: non-blank and passing', () => {
		assert.equal(isLinkHref('/x'), true);
		assert.equal(isLinkHref(''), false);
		assert.equal(isLinkHref('nope'), false);
		assert.equal(isLinkHref(undefined), false);
	});
});

describe('the internal path warning', () => {
	const addresses = ['/', '/about', '/services/branding', '/journal/my-first-post', null];

	test('a /path with no extension that matches no document: "Links to /contact, which no page or route serves."', () => {
		assert.equal(missingLinkTarget('/contact', addresses), "Links to /contact, which no page or route serves.");
	});

	test('a path that matches a document, with or without a trailing slash, query or anchor, is fine', () => {
		for (const href of ['/', '/about', '/about/', '/about#team', '/services/branding?x=1', '/journal/my-first-post']) {
			assert.equal(missingLinkTarget(href, addresses), undefined, href);
		}
	});

	test('a file (an extension), an external URL, mailto, tel and #anchors aren\'t checked', () => {
		for (const href of ['/brochure.pdf', '/img/logo.svg', 'https://example.com/missing', 'mailto:a@b.test', 'tel:+1', '#x', 'nope']) {
			assert.equal(missingLinkTarget(href, addresses), undefined, href);
		}
		assert.equal(internalLinkPath('/brochure.pdf'), null);
		assert.equal(internalLinkPath('/a/b/'), '/a/b');
	});
});
