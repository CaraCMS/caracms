// Edit in context, carrier C: the sidebar's lists and
// forms, the parts checked without a browser.
// - The listing: a slot block's `slot` and `default`, a document's `frame`, and "used on" for a
//   slot's block, which counts every document with an address it fills (the default's share and
//   the picks, hidden ones included; never one that can't be read) (Decision 3, Acceptance 4).
// - Deleting: the default is refused ("make another the default first"); another slot block a
//   page picks is refused naming a few and "N more" (Decision 3, Acceptance 4).
// - Creating: the first block made for a slot is its default; the next isn't (Decision 3).
// - POST /_caracms/slot-default: every other default of the slot loses it, as a normal save;
//   one that isn't a default isn't written; a body block or a missing one is refused (Decision 3).
// - The Shared blocks level's groups and its "Default" chip (Decision 1, Acceptance 2 and 6).
// - The pickers' slots (Decision 3), what a block also shows from Site Settings (Decision 4)
//   and its "Shows entries from" rows (Decision 12, Acceptance 17).
// - A list's word for its rows (`itemNoun`, Deferred's row word, 2026-10-30).
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CaracmsConfigError, group, link, list, reference, resolveSite, text, type ResolvedSite, type SiteConfig } from '../src/config.ts';
import { listDocuments, type DocumentEntry } from '../src/content.ts';
import { fewList, handleSlotDefault, planCreate, planDelete } from '../src/editor/server/create.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import type { ListedDocument, SlotDefaultResponse } from '../src/editor/types.ts';
import { pickableSlots, sharedGroups, showsDefault, PROBLEMS_LABEL } from '../src/editor/client/collections/shared-groups.ts';
import { heldRefs, parseReadRecord, readRows, settingsLabel, settingsShown } from '../src/editor/client/pane/from-page.ts';
import { itemCount, itemNoun, itemSummary } from '../src/editor/client/fields/list-summary.ts';
import { config, siteRoot, variant } from './helpers/site.ts';

const footer = { component: 'Block.astro', slot: 'footer' as const, fields: { note: text() } };
const header = { component: 'Block.astro', slot: 'header' as const, fields: { menu: list(link()) } };
const cta = { component: 'Block.astro', label: 'Call to action', fields: { heading: text() } };

let root: string;
let site: ResolvedSite;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const put = (file: string, value: unknown) => {
	mkdirSync(join(root, file, '..'), { recursive: true });
	writeFileSync(join(root, file), typeof value === 'string' ? value : json(value));
};
const read = (file: string) => readFileSync(join(root, file), 'utf8');

before(() => {
	// Beside the fixture's site, so its config's ../fonts resolve; removed after.
	root = mkdtempSync(join(siteRoot, '..', '.eic-sidebar-'));
	copyFileSync(join(siteRoot, 'Block.astro'), join(root, 'Block.astro'));
	site = resolveSite(
		variant({
			collections: {
				...(config as SiteConfig).collections,
				cases: { kind: 'fields', folder: 'content/cases', urlBase: '/cases', component: 'Block.astro', fields: { client: text() } },
				people: { kind: 'fields', folder: 'content/people', component: 'Block.astro', fields: { name: text() } },
			} as never,
			blocks: { ...(config as SiteConfig).blocks, footer, header, cta },
		}),
		root,
	);
	put('content/pages/index.json', { title: 'Home', blocks: [] });
	put('content/pages/about.json', { title: 'About', frame: { footer: 'dark' }, blocks: [] });
	put('content/pages/work.json', { title: 'Work', hidden: true, blocks: [{ shared: 'start' }] });
	put('content/pages/contact.json', { title: 'Contact', frame: { footer: 'gone' }, blocks: [] });
	put('content/pages/broken.json', '{ not json');
	put('content/journal/ridge.json', { title: 'Ridge', frame: { footer: 'footer' }, blocks: [] });
	put('content/cases/harbour.json', { title: 'Harbour', frame: { footer: 'dark' }, client: 'High-street coffee roaster' });
	put('content/people/ada.json', { title: 'Ada', name: 'Ada' });
	put('content/shared/footer.json', { title: 'Footer', default: true, block: { type: 'footer', note: 'Hi' } });
	put('content/shared/dark.json', { title: 'Footer — dark', block: { type: 'footer', note: 'Dark' } });
	put('content/shared/header.json', { title: 'Header', default: true, block: { type: 'header', menu: [] } });
	put('content/shared/start.json', { title: 'Start a project', block: { type: 'cta', heading: 'Go' } });
	put('content/shared/old.json', { title: 'Old', block: { type: 'gone-type' } });
});
after(() => rmSync(root, { recursive: true, force: true }));

const listed = async () => (await listDocuments(site)) as ListedDocument[];
const entry = (all: readonly DocumentEntry[], collection: string, path: string) => all.find((d) => d.collection === collection && d.path === path)!;
const used = (all: readonly DocumentEntry[], path: string) => (entry(all, 'shared', path).usedOn ?? []).map((u) => `${u.collection}/${u.path}`).sort();

describe('the listing (Decision 3, Acceptance 4)', () => {
	test('a slot block says its slot and whether it\'s the default; a page its picks', async () => {
		const all = await listed();
		assert.equal(entry(all, 'shared', 'footer').slot, 'footer');
		assert.equal(entry(all, 'shared', 'footer').default, true);
		assert.equal(entry(all, 'shared', 'dark').default, undefined);
		assert.equal(entry(all, 'shared', 'start').slot, undefined);
		assert.equal(entry(all, 'shared', 'old').slot, undefined);
		assert.deepEqual(entry(all, 'pages', 'about').frame, { footer: 'dark' });
		assert.deepEqual(entry(all, 'cases', 'harbour').frame, { footer: 'dark' });
	});
	test('the default fills every document with an address that doesn\'t pick another, hidden and stale picks included; a pick fills its own', async () => {
		const all = await listed();
		// Ridge picks the default itself (kept as picked); Contact's pick is gone, so it gets the default; Work is hidden.
		assert.deepEqual(used(all, 'footer'), ['journal/ridge', 'pages/contact', 'pages/index', 'pages/work']);
		assert.deepEqual(used(all, 'dark'), ['cases/harbour', 'pages/about']);
		// The header has no picks: every document with an address. Never Ada (no address) or the broken file.
		assert.deepEqual(used(all, 'header'), ['cases/harbour', 'journal/ridge', 'pages/about', 'pages/contact', 'pages/index', 'pages/work']);
	});
	test('a body shared block is still used where a page has an entry for it', async () => {
		assert.deepEqual(used(await listed(), 'start'), ['pages/work']);
	});
});

describe('deleting a slot\'s block (Decision 3, Acceptance 4)', () => {
	test('the default is refused: make another the default first', async () => {
		const all = await listed();
		assert.throws(
			() => planDelete(site, { collection: 'shared', path: 'footer' }, all),
			(e: Error & { status?: number; body?: Record<string, unknown> }) =>
				e.status === 409 && e.body?.code === 'default' && e.message === "Footer is the default footer, so it can't be deleted. Make another the default first.",
		);
	});
	test('one a page picks is refused, naming the pages', async () => {
		const all = await listed();
		assert.throws(
			() => planDelete(site, { collection: 'shared', path: 'dark' }, all),
			(e: Error & { status?: number; body?: Record<string, unknown> }) =>
				e.status === 409 && e.body?.code === 'in-use' && e.message === "Footer — dark is the footer About and Harbour pick, so it can't be deleted. Pick another footer on those pages first.",
		);
	});
	test('a few are named, then "N more"', () => {
		assert.equal(fewList(['A', 'B', 'C', 'D']), 'A, B, C and D');
		assert.equal(fewList(['A', 'B', 'C', 'D', 'E']), 'A, B, C and 2 more');
		assert.equal(fewList(['A']), 'A');
	});
});

describe('creating a slot\'s block (Decision 3: the first one made is the default)', () => {
	test('a slot with a default: the new one isn\'t; a body block never is', async () => {
		const all = await listed();
		assert.doesNotMatch(planCreate(site, { collection: 'shared', path: 'light', title: 'Footer — light', blockType: 'footer' }, all).text, /"default"/);
		assert.doesNotMatch(planCreate(site, { collection: 'shared', path: 'cta2', title: 'Another', blockType: 'cta' }, all).text, /"default"/);
	});
	test('a slot with none: the new one is, beside its block', async () => {
		const all = (await listed()).filter((d) => !(d.collection === 'shared' && d.slot === 'header'));
		const plan = planCreate(site, { collection: 'shared', path: 'top', title: 'Top', blockType: 'header' }, all);
		assert.match(plan.text, /"title": "Top",\n {2}"default": true,\n {2}"block": \{\n {4}"type": "header"/);
		assert.equal((plan.document as { default?: boolean }).default, true);
	});
});

describe('POST /_caracms/slot-default (Decision 3)', () => {
	const call = async (body: unknown) => {
		const response = await handleSlotDefault(new Request('http://localhost:4326/_caracms/slot-default', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), localDraftsStore(site));
		return { status: response.status, body: (await response.json()) as SlotDefaultResponse & { error?: string; code?: string } };
	};
	test('the other default loses it, as a save writes it; the asked-for block is the editor\'s own edit', async () => {
		const before = read('content/shared/dark.json');
		const answer = await call({ path: 'dark' });
		assert.equal(answer.status, 200, JSON.stringify(answer.body));
		assert.deepEqual(answer.body.undefaulted, [{ path: 'footer', title: 'Footer' }]);
		assert.equal(read('content/shared/footer.json'), json({ title: 'Footer', block: { type: 'footer', note: 'Hi' } }));
		assert.equal(read('content/shared/dark.json'), before, 'the editor writes its own');
		// Put it back for the other tests.
		put('content/shared/footer.json', { title: 'Footer', default: true, block: { type: 'footer', note: 'Hi' } });
	});
	test('nothing to clear writes nothing; a header\'s default is left alone', async () => {
		const header = read('content/shared/header.json');
		const answer = await call({ path: 'footer' });
		assert.equal(answer.status, 200);
		assert.deepEqual(answer.body.undefaulted, []);
		assert.equal(read('content/shared/header.json'), header);
	});
	test('a body block, a missing one and a bad body are refused', async () => {
		assert.equal((await call({ path: 'start' })).status, 400);
		assert.equal((await call({ path: 'nope' })).status, 404);
		assert.equal((await call({ path: '' })).status, 400);
		assert.equal((await call({ path: 'dark', extra: 1 })).status, 400);
	});
});

describe('the Shared blocks level (Decision 1, Acceptance 2 and 6)', () => {
	test('Header, Footer, then the rest by type in the config\'s order, the ones with a warning last', async () => {
		const all = await listed();
		const groups = sharedGroups(site, all.filter((d) => d.collection === 'shared'));
		assert.deepEqual(
			groups.map((g) => [g.label, g.rows.map((d) => d.path)]),
			[
				['Header', ['header']],
				['Footer', ['footer', 'dark']],
				['Call to action', ['start']],
				[PROBLEMS_LABEL, ['old']],
			],
		);
	});
	test('"Default" only once a slot has two', async () => {
		const all = await listed();
		assert.equal(showsDefault(all, entry(all, 'shared', 'footer') as ListedDocument), true);
		assert.equal(showsDefault(all, entry(all, 'shared', 'header') as ListedDocument), false);
		assert.equal(showsDefault(all.filter((d) => d.path !== 'dark'), entry(all, 'shared', 'footer') as ListedDocument), false);
	});
	test('a page gets a picker for a slot with two, or one it already picks', async () => {
		const all = await listed();
		assert.deepEqual(pickableSlots(all, undefined), ['footer']);
		assert.deepEqual(pickableSlots(all, { header: 'header' }), ['header', 'footer']);
		assert.deepEqual(pickableSlots(all.filter((d) => d.path !== 'dark'), undefined), []);
	});
});

describe('what a block shows from elsewhere (Decisions 4 and 12)', () => {
	const settings = { contact: group({ phone: text({ label: 'Phone' }), email: text() }), socials: list({ network: text(), url: text() }, { label: 'Social links' }), tagline: text() };
	test('Site Settings\' fields its render marked, by their labels, in page order, once each', () => {
		assert.deepEqual(settingsShown(['contact.phone', 'contact.email', 'socials.0.network', 'socials.1.network'], settings), ['Phone', 'Email', 'Social links']);
		assert.equal(settingsLabel(settings, 'nope'), null);
		assert.equal(settingsLabel(settings, 'tagline'), 'Tagline');
	});
	test('the read record: a row per collection listed, and per document read alone that no reference holds', () => {
		const record = parseReadRecord('{"0":{"lists":{"clients":5},"documents":[]},"1":{"lists":{"work":3},"documents":["work/a","work/b","people/ada"]}}');
		assert.deepEqual(readRows(record, 0, new Set()), [{ kind: 'list', collection: 'clients', count: 5 }]);
		const fields = { picks: list(reference({ to: 'work' })), lead: group({ person: reference({ to: 'people' }) }) };
		const held = heldRefs(fields, { picks: ['a', 'b'], lead: { person: 'ada' } });
		assert.deepEqual([...held].sort(), ['people/ada', 'work/a', 'work/b']);
		assert.deepEqual(readRows(record, 1, held), [{ kind: 'list', collection: 'work', count: 3 }]);
		assert.deepEqual(readRows(record, 1, new Set(['work/a'])).map((r) => r.kind === 'document' && `${r.collection}/${r.path}`), [false, 'work/b', 'people/ada']);
		assert.deepEqual(readRows(record, 2, new Set()), [], 'a block that read nothing has no row');
		assert.equal(parseReadRecord(''), null);
		assert.equal(parseReadRecord('[1]'), null);
		assert.equal(parseReadRecord('{oops'), null);
	});
});

describe('a list\'s word for its rows (itemNoun)', () => {
	test('from the label, as today; named by the list when it says', () => {
		assert.equal(itemNoun('Credits'), 'credit');
		assert.equal(itemNoun('People'), 'people');
		assert.equal(itemNoun('People', 'person'), 'person');
		assert.equal(itemCount(2, 'Credits'), '2 credits');
		assert.equal(itemCount(2, 'People', 'person'), '2 people');
		assert.equal(itemCount(1, 'People', 'person'), '1 person');
	});
	test('list() keeps it; an inner list counts its rows in its words', () => {
		const people = list({ name: text() }, { label: 'People', itemNoun: 'person' });
		assert.equal(people.itemNoun, 'person');
		const teams = list({ team: text(), people }, { label: 'Teams' });
		assert.deepEqual(itemSummary(teams, { team: 'Studio', people: [{ name: 'A' }, { name: 'B' }] }, () => null), { main: 'Studio', more: '2 people' });
	});
	test('the config refuses an empty one', () => {
		const bad = { component: 'Block.astro', fields: { people: { ...list({ name: text() }), itemNoun: ' ' } } };
		assert.throws(() => resolveSite(variant({ blocks: { ...(config as SiteConfig).blocks, bad } as never }), siteRoot), (e: Error) => e instanceof CaracmsConfigError && /itemNoun/.test(e.message));
	});
});
