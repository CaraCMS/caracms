// A section builder's offered blocks (typed list items): the `blocks`
// option is checked when the site is resolved, reaches the editor, and decides what the
// picker and the List / Grid switch see.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { media, resolveSite, text } from '../src/config.ts';
import { editorSite } from '../src/editor/server/admin-props.ts';
import { offeredBlocks, offersBlock } from '../src/editor/client/state/schema.ts';
import { config, site, siteRoot, variant } from './helpers/site.ts';

const withJournal = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	variant({ collections: { ...config.collections, journal: { ...config.collections.journal, ...patch } } as never, ...extra });

describe('a section builder\'s blocks option', () => {
	test('left out, every block (nothing stored); set, checked and kept in order, duplicates dropped', () => {
		assert.equal(site.collections.journal!.blocks, undefined);
		const s = resolveSite(withJournal({ blocks: ['cta', 'text', 'cta'] }), siteRoot);
		assert.deepEqual(s.collections.journal!.blocks, ['cta', 'text']);
		assert.equal(s.collections.pages!.blocks, undefined);
		assert.deepEqual(JSON.parse(JSON.stringify(s)), s, 'still plain JSON');
	});

	test('refuses an unknown name, an empty list, a non-list, and blocks on a fields collection', () => {
		assert.throws(() => resolveSite(withJournal({ blocks: ['text', 'gallery'] }), siteRoot), /collection "journal": blocks names "gallery", which isn't one of the site's blocks \(hero, text, cta\)/);
		assert.throws(() => resolveSite(withJournal({ blocks: [] }), siteRoot), /collection "journal": blocks is empty/);
		assert.throws(() => resolveSite(withJournal({ blocks: 'text' }), siteRoot), /collection "journal": blocks must be a list of block types/);
		const cases = { kind: 'fields', folder: 'content/case-studies', urlBase: '/work', component: 'Block.astro', fields: { client: text() }, blocks: ['text'] };
		assert.throws(() => resolveSite(variant({ collections: { ...config.collections, 'case-studies': cases } as never }), siteRoot), /collection "case-studies": blocks is for a section builder's picker/);
	});

	test('the List / Grid switch looks at the offered blocks only', () => {
		const blocks = { ...config.blocks, picture: { component: 'Block.astro', fields: { image: media() } } };
		// Every block: the picture block holds media, so the journal gets the switch.
		assert.ok(resolveSite(variant({ blocks } as never), siteRoot).collections.journal!.view);
		// Offering only text: no media, no switch; asking for one is refused.
		assert.equal(resolveSite(withJournal({ blocks: ['text'] }, { blocks }), siteRoot).collections.journal!.view, null);
		assert.throws(() => resolveSite(withJournal({ blocks: ['text'], view: {} }, { blocks }), siteRoot), /none of the blocks it offers has a media field/);
		assert.ok(resolveSite(withJournal({ blocks: ['picture'] }, { blocks }), siteRoot).collections.journal!.view);
	});

	test('reaches the editor; the helpers answer per collection', () => {
		const s = resolveSite(withJournal({ blocks: ['text', 'cta'] }), siteRoot);
		const e = editorSite(s, [], 'localhost', { name: 'Test', accent: '#1f2f57' } as never);
		assert.deepEqual(e.collections.find((c) => c.name === 'journal')!.blocks, ['text', 'cta']);
		assert.equal(e.collections.find((c) => c.name === 'pages')!.blocks, null);
		assert.deepEqual(offeredBlocks(e, 'journal'), ['text', 'cta']);
		assert.equal(offeredBlocks(e, 'pages'), null);
		assert.equal(offersBlock(e, 'journal', 'hero'), false);
		assert.equal(offersBlock(e, 'journal', 'text'), true);
		assert.equal(offersBlock(e, 'pages', 'hero'), true);
		assert.equal(offersBlock(e, 'shared', 'hero'), true, 'a shared block holds any type');
	});
});
