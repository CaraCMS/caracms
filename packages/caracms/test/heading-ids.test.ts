// Heading ids: the slug rule (headingId), a heading's plain text, the
// ids per rich-text field numbered across a page's blocks (headingIdsOf), and richTextHtml's ids.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import GithubSlugger from 'github-slugger';
import { headingId, headingIdsOf, headingText, pageHeadings, type HeadingSeen } from '../src/heading-ids.ts';
import { parseInline, parseRichText, richTextHtml, serializeRichText } from '../src/rich-text.ts';
import { list, richText, text } from '../src/fields.ts';
import { parseDocument } from '../src/document.ts';

const H = { headings: ['h2', 'h3'] as const, links: true };

describe('headingId: GitHub-style slugs', () => {
	const one = (t: string) => headingId(t, new Map());
	test('lower case, spaces to -, punctuation dropped', () => {
		assert.equal(one('Hello World'), 'hello-world');
		assert.equal(one('Hello, World!'), 'hello-world');
		assert.equal(one("What's new?"), 'whats-new');
		assert.equal(one('Step 1: Install'), 'step-1-install');
		assert.equal(one('C++ & Rust'), 'c--rust');
		assert.equal(one('snake_case and kebab-case'), 'snake_case-and-kebab-case');
		assert.equal(one('Ünïcödé Straße'), 'ünïcödé-straße');
		assert.equal(one('Adding media (images & video)'), 'adding-media-images--video');
	});
	test('the same as github-slugger, repeats included', () => {
		const samples = ['Intro', 'Intro', 'Intro-1', 'Intro', 'A — B', 'émoji 🎉 time', 'Intro'];
		const slugger = new GithubSlugger();
		const seen: HeadingSeen = new Map();
		assert.deepEqual(
			samples.map((s) => headingId(s, seen)),
			samples.map((s) => slugger.slug(s)),
		);
	});
	test('repeats on a page get -1, -2 in order', () => {
		const seen: HeadingSeen = new Map();
		assert.deepEqual(['Setup', 'Setup', 'setup!', 'Other', 'Setup'].map((t) => headingId(t, seen)), ['setup', 'setup-1', 'setup-2', 'other', 'setup-3']);
	});
	test('nothing to slug: no id, and nothing recorded', () => {
		const seen: HeadingSeen = new Map();
		assert.equal(headingId('', seen), '');
		assert.equal(headingId('?!', seen), '');
		assert.equal(seen.size, 0);
	});
});

describe('headingText: the plain text, not the markup', () => {
	test('bold, italic and links read as their text; a break as a space', () => {
		assert.equal(headingText(parseInline('**Bold** and *italic* [a link](/x)')), 'Bold and italic a link');
		assert.equal(headingId(headingText(parseInline('Using **the** [editor](/admin)')), new Map()), 'using-the-editor');
		assert.equal(headingText(parseInline('From the harbour wall\noutward')), 'From the harbour wall outward');
	});
});

describe('richTextHtml with headingIds', () => {
	const value = parseRichText([{ h2: 'Setup' }, { p: 'Text' }, { h3: 'More **here**' }, { ul: ['a'] }, { h2: 'Last' }], H);
	test('each h2/h3 gets its id in order; paragraphs and lists are untouched', () => {
		assert.equal(
			richTextHtml(value, { headingIds: ['setup', 'more-here', ''] }),
			'<h2 id="setup">Setup</h2><p>Text</p><h3 id="more-here">More <strong>here</strong></h3><ul><li>a</li></ul><h2>Last</h2>',
		);
	});
	test('without headingIds, the HTML is as before', () => {
		assert.equal(richTextHtml(value), '<h2>Setup</h2><p>Text</p><h3>More <strong>here</strong></h3><ul><li>a</li></ul><h2>Last</h2>');
	});
	test('the stored value never holds ids', () => {
		assert.deepEqual(serializeRichText(value, H), [{ h2: 'Setup' }, { p: 'Text' }, { h3: 'More **here**' }, { ul: ['a'] }, { h2: 'Last' }]);
	});
});

describe('headingIdsOf / pageHeadings: numbered across the page', () => {
	const site = {
		blocks: {
			text: { label: 'Text', fields: { heading: text({ label: 'Heading', heading: true }), body: richText({ label: 'Body', headings: ['h2', 'h3'] }) } },
			faq: { label: 'FAQ', fields: { items: list({ q: text({ label: 'Q' }), a: richText({ label: 'A', headings: ['h2'] }) }, { label: 'Items' }) } },
			plain: { label: 'Plain', fields: { body: richText({ label: 'Body' }) } },
		},
		collections: {},
	} as any;
	const doc = parseDocument(
		{
			title: 'T',
			blocks: [
				{ type: 'text', heading: 'Not counted', body: [{ h2: 'Setup' }, { p: 'x' }, { h3: 'Setup' }] },
				{ type: 'mystery', body: [{ h2: 'Setup' }] },
				{ type: 'plain', body: [{ h2: 'Setup' }] },
				{ type: 'faq', items: [{ q: 'q', a: [{ h2: 'Setup' }] }, { q: 'q', a: [{ h2: 'Why?' }] }] },
				{ type: 'text', heading: '', body: [{ h2: '**Setup**' }, { h2: '!!' }] },
			],
		},
		site,
	);
	test('ids per block by field path, duplicates within a field and across blocks', () => {
		const { blocks, headings } = headingIdsOf(doc, site);
		assert.deepEqual(blocks, [{ body: ['setup', 'setup-1'] }, null, {}, { 'items.0.a': ['setup-2'], 'items.1.a': ['why'] }, { body: ['setup-3', ''] }]);
		assert.deepEqual(headings, [
			{ depth: 2, slug: 'setup', text: 'Setup' },
			{ depth: 3, slug: 'setup-1', text: 'Setup' },
			{ depth: 2, slug: 'setup-2', text: 'Setup' },
			{ depth: 2, slug: 'why', text: 'Why?' },
			{ depth: 2, slug: 'setup-3', text: 'Setup' },
		]);
	});
	test('pageHeadings gives the same list', async () => {
		assert.deepEqual(await pageHeadings(site, doc), headingIdsOf(doc, site).headings);
	});
});
