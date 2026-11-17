/**
 * Two editor gaps found building a Starlight docs site: `media({ altFrom })` (an image's empty
 * alt starts with a sibling text field's words) and its config checks; and the block-list
 * and list-row summaries for rich text (a leading select's choice as a prefix, a rich-text
 * fallback, a row named by its first list's first item).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CaracmsConfigError, group, list, media, resolveSite, richText, select, text, type Fields } from '../src/config.ts';
import { blockSummary } from '../src/editor/client/block-list/summary.ts';
import { itemSummary } from '../src/editor/client/fields/list-summary.ts';
import { siblingWords } from '../src/editor/client/media/store.ts';
import type { ListField } from '../src/fields.ts';
import type { EditorBlock, EditorSite } from '../src/editor/types.ts';
import { siteRoot, variant } from './helpers/site.ts';

const withBlock = (fields: Fields) => () => resolveSite(variant({ blocks: { shot: { component: 'Block.astro', fields } } }), siteRoot);
const refused = (fields: Fields, pattern: RegExp) =>
	assert.throws(withBlock(fields), (e: Error) => {
		assert.ok(e instanceof CaracmsConfigError, e.message);
		assert.match(e.message, pattern);
		return true;
	});

describe("media's altFrom: the config checks", () => {
	test('a sibling text field is taken, at the top, in a group and in a list row', () => {
		const s = withBlock({
			image: media({ only: 'image', altFrom: 'capture' }),
			capture: text({ label: 'What to capture' }),
			pair: group({ image: media({ altFrom: 'note' }), note: text() }),
			rows: list({ image: media({ altFrom: 'words' }), words: text() }),
		})();
		const fields = s.blocks.shot!.fields;
		assert.equal((fields.image as { altFrom?: string }).altFrom, 'capture');
	});

	test('off unless declared: media() has no altFrom', () => {
		assert.equal('altFrom' in media(), false);
	});

	test('a name that is no sibling is refused, naming the text fields there are', () => {
		refused({ image: media({ altFrom: 'capture' }), caption: text() }, /block "shot": field "image": altFrom "capture" isn't a field beside this one \(its text fields are "caption"\)/);
		refused({ image: media({ altFrom: 'capture' }) }, /there are no text fields beside it/);
	});

	test('a sibling that is not a text field is refused', () => {
		refused({ image: media({ altFrom: 'body' }), body: richText() }, /altFrom "body" is a richText field; it must name a text field/);
		refused({ image: media({ altFrom: 'kind' }), kind: select({ options: ['a', 'b'] }) }, /altFrom "kind" is a select field/);
	});

	test("a field in a group can't name one outside it, nor a list row's one outside the row", () => {
		refused({ capture: text(), pair: group({ image: media({ altFrom: 'capture' }), note: text() }) }, /group field "image": altFrom "capture" isn't a field beside this one/);
		refused({ capture: text(), rows: list({ image: media({ altFrom: 'capture' }) }) }, /item field "image": altFrom "capture" isn't a field beside this one/);
	});

	test('a list of one media field has no siblings', () => {
		refused({ capture: text(), images: list(media({ altFrom: 'capture' })) }, /a list of one media field has no fields beside it/);
	});

	test('a video-only slot, and a name that is no string, are refused', () => {
		refused({ clip: media({ only: 'video', altFrom: 'capture' }), capture: text() }, /altFrom fills an image's alt text, but this slot takes videos only/);
		refused({ image: media({ altFrom: '' }), capture: text() }, /altFrom names a text field beside this one/);
	});
});

describe("altFrom's words", () => {
	test('the sibling beside the slot, on one line; nothing for an empty or missing one', () => {
		assert.equal(siblingWords({ capture: '  The members\n page ' }, 'image', 'capture'), 'The members page');
		assert.equal(siblingWords({ rows: [{}, { words: 'Second' }] }, 'rows.1.image', 'words'), 'Second');
		assert.equal(siblingWords({ pair: { note: 'Left' } }, 'pair.image', 'note'), 'Left');
		assert.equal(siblingWords({}, 'image', 'capture'), '');
		assert.equal(siblingWords({ capture: 3 }, 'image', 'capture'), '');
	});
});

const aside = {
	label: 'Aside',
	fields: {
		kind: select({ options: [{ value: 'note', label: 'Note' }, { value: 'tip', label: 'Tip' }, { value: 'danger', label: 'Danger' }] }),
		body: richText(),
	},
};
const site = {
	blocks: {
		aside,
		text: { label: 'Text', fields: { body: richText({ headings: ['h2', 'h3'] }) } },
		titled: { label: 'Titled', fields: { heading: text({ heading: true }), body: richText() } },
		steps: { label: 'Steps', fields: { steps: list(richText(), { label: 'Steps' }) } },
		table: { label: 'Table', fields: { header: list(richText(), { label: 'Header' }), rows: list({ cells: list(richText(), { label: 'Cells' }) }, { label: 'Rows' }) } },
		listed: { label: 'Listed', fields: { kind: select({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }), items: list(text(), { label: 'Items' }) } },
		pair: { label: 'Pair', fields: { left: group({ heading: text(), body: richText() }), right: group({ heading: text(), body: richText() }) } },
	},
} as unknown as Pick<EditorSite, 'blocks'>;
const block = (type: string, data: Record<string, unknown>): EditorBlock => ({ key: 'b1', type, known: true, data }) as EditorBlock;

describe('block rows: rich text', () => {
	test("a block whose words are all rich text reads them, on one line, without the marks", () => {
		assert.equal(blockSummary(site, block('text', { body: [{ h2: 'Getting started' }, { p: 'Open **Settings**, then\nMembers.' }] })), 'Getting started Open Settings, then Members.');
		assert.equal(blockSummary(site, block('text', { body: '' })), 'Nothing in it yet');
	});

	test('a text field still comes first; the rich text is the fallback', () => {
		assert.equal(blockSummary(site, block('titled', { heading: 'Plans', body: 'Pick one.' })), 'Plans');
		assert.equal(blockSummary(site, block('titled', { heading: '', body: 'Pick one.' })), 'Pick one.');
	});

	test("every group's text is read before any rich text", () => {
		assert.equal(blockSummary(site, block('pair', { left: { heading: '', body: 'Left words' }, right: { heading: 'Right', body: '' } })), 'Right');
		assert.equal(blockSummary(site, block('pair', { left: { heading: '', body: 'Left words' }, right: { heading: '', body: '' } })), 'Left words');
	});

	test("a leading select's chosen label is the prefix: Tip · first words", () => {
		assert.equal(blockSummary(site, block('aside', { kind: 'tip', body: 'Save before you leave.' })), 'Tip · Save before you leave.');
		// The select's default (its first option) when the file has none.
		assert.equal(blockSummary(site, block('aside', { body: 'Heads up.' })), 'Note · Heads up.');
		// Nothing to say after it: the block is still empty.
		assert.equal(blockSummary(site, block('aside', { kind: 'danger', body: '' })), 'Nothing in it yet');
	});
});

describe('block rows: list fields', () => {
	test("a block whose words are only a list of rich text reads its first step", () => {
		assert.equal(blockSummary(site, block('steps', { steps: [[{ p: 'Open **Settings**.' }], [{ p: 'Then Members.' }]] })), 'Open Settings.');
		// Empty items are skipped: the first one with words.
		assert.equal(blockSummary(site, block('steps', { steps: ['', [{ p: 'Second.' }]] })), 'Second.');
	});

	test("a table reads its header's first cell, else its first row's label", () => {
		const rows = [{ cells: [[{ p: '**Plan**' }], 'Price'] }, { cells: ['Free', '€0'] }];
		assert.equal(blockSummary(site, block('table', { header: [[{ p: 'Feature' }], 'Free'], rows })), 'Feature');
		assert.equal(blockSummary(site, block('table', { header: ['', ''], rows })), 'Plan');
		assert.equal(blockSummary(site, block('table', { header: [], rows: [{ cells: ['', 'x'] }, { cells: ['Free', 'y'] }] })), 'Free');
	});

	test('empty blocks still say so, and a leading select still prefixes', () => {
		assert.equal(blockSummary(site, block('steps', { steps: [] })), 'Nothing in it yet');
		assert.equal(blockSummary(site, block('steps', {})), 'Nothing in it yet');
		assert.equal(blockSummary(site, block('table', { header: ['', ''], rows: [{ cells: [] }] })), 'Nothing in it yet');
		assert.equal(blockSummary(site, block('listed', { kind: 'b', items: ['', 'One'] })), 'B · One');
		assert.equal(blockSummary(site, block('listed', { kind: 'b', items: [] })), 'Nothing in it yet');
	});

	test('text and rich text still come before a list', () => {
		assert.equal(blockSummary(site, block('titled', { heading: 'Plans', body: '' })), 'Plans');
	});
});

const none = () => null;

describe('list rows: rich text and inner lists', () => {
	test('a list of rich text: each item by its words, on one line', () => {
		const steps = list(richText(), { label: 'Steps' }) as ListField;
		assert.deepEqual(itemSummary(steps, [{ p: 'Open **Settings**.' }, { p: 'Then Members.' }], none), { main: 'Open Settings. Then Members.', more: '' });
		assert.deepEqual(itemSummary(steps, '', none), { main: '', more: '' });
	});

	test("a row whose only field is a list is named by its first item: a table row by its first cell", () => {
		const rows = list({ cells: list(richText(), { label: 'Cells' }) }, { label: 'Rows' }) as ListField;
		assert.deepEqual(itemSummary(rows, { cells: [[{ p: '**Plan**' }], 'Price', 'Seats'] }, none), { main: 'Plan', more: '3 cells' });
		assert.deepEqual(itemSummary(rows, { cells: [] }, none), { main: '', more: '' });
	});

	test("a row with a text label left empty isn't named by its inner list", () => {
		const menu = list({ label: text(), links: list(text(), { label: 'Links' }) }, { label: 'Menu' }) as ListField;
		assert.deepEqual(itemSummary(menu, { label: '', links: ['About'] }, none), { main: '', more: '1 link' });
	});

	test('a row of rich text fields is named by the first', () => {
		const rows = list({ body: richText(), note: richText() }, { label: 'Rows' }) as ListField;
		assert.deepEqual(itemSummary(rows, { body: [{ p: 'First **words**' }], note: 'x' }, none), { main: 'First words', more: '' });
	});
});
