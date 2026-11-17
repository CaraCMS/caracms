// M6c (port readiness): G2 page fields on a section builder.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buttons, date, link, list, lockup, media, number, reference, resolveSite, richText, select, text, toggle } from '../src/config.ts';
import { documentUrl, filesSource, listDocuments } from '../src/content.ts';
import { planCreate } from '../src/editor/server/create.ts';
import { planMove } from '../src/editor/server/move.ts';
import { WriteRefused } from '../src/editor/server/write.ts';
import { normaliseAnyDocument, parseAnyDocument, parseDocument, type SiteDocument } from '../src/document.ts';
import { fieldToJson, fieldWarnings, parseField, renderValue } from '../src/fields.ts';
import { createDocumentStore, PAGE_SCOPE } from '../src/editor/client/state/document-store.ts';
import { missingAltIn } from '../src/editor/server/media/alt.ts';
import { documentReader } from '../src/read.ts';
import { relinkText } from '../src/relink.ts';
import { applyDocumentEdits, applyEdits } from '../src/serialize.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { config, siteRoot, variant } from './helpers/site.ts';

// ── G2: fields on a section-builder page ─────────────────────────────────────

const gameFields = {
	tagline: text(),
	side: select({ options: ['left', 'right'] }),
	fade: toggle(),
	tile: media({ only: 'image' }),
	more: link(),
	related: reference({ to: 'games' }),
	notes: list({ label: text(), url: link() }),
};
const g2Config = variant({ collections: { ...config.collections, games: { kind: 'sections', folder: 'content/games', urlBase: '/games/', fields: gameFields } } });
const g2 = resolveSite(g2Config, siteRoot);
const games = g2.collections.games!;

const gameText = `{
  "title": "Kites",
  "tagline":   "Fly one",
  "side": "left",
  "blocks": [
    { "type": "text", "heading": "Hello", "body": "", "background": "light" }
  ],
  "extra": 1
}
`;
const parse = (t: string) => parseAnyDocument(JSON.parse(t), g2, games) as SiteDocument;

describe('G2: page fields on a section builder', () => {
	test('the config resolves them labelled; a collection without them has none; title, blocks and seo are refused', () => {
		assert.equal(games.fields!.tagline!.label, 'Tagline');
		assert.equal(g2.collections.journal!.fields, null);
		for (const key of ['title', 'blocks', 'seo']) {
			const bad = variant({ collections: { ...config.collections, games: { kind: 'sections', folder: 'content/games', urlBase: '/games/', fields: { [key]: text() } } } });
			assert.throws(() => resolveSite(bad, siteRoot), new RegExp(`"${key}" is every page's own`));
		}
		const badRef = variant({ collections: { ...config.collections, games: { kind: 'sections', folder: 'content/games', urlBase: '/games/', fields: { x: reference({ to: 'nope' }) } } } });
		assert.throws(() => resolveSite(badRef, siteRoot), /nope/);
	});

	test('a document parses its page fields into `data`, every field present; a collection without them has no `data`', () => {
		const doc = parse(gameText);
		assert.deepEqual(Object.keys(doc.data!), Object.keys(gameFields));
		assert.equal(doc.data!.tagline, 'Fly one');
		assert.equal(doc.data!.side, 'left');
		assert.equal(doc.data!.fade, false);
		assert.equal((parseAnyDocument(JSON.parse(gameText), g2, g2.collections.journal!) as SiteDocument).data, undefined);
	});

	test('opening and saving is byte for byte; `data` absent leaves the file as it is', () => {
		assert.equal(applyDocumentEdits(gameText, parse(gameText), g2, games), gameText);
		// The path the write route, the keeper and the preview take: the editor's document
		// through normaliseAnyDocument. Without `data` it must carry none (not every field's
		// default), so the file's page fields stay as they are.
		const { data: _d, ...noData } = parse(gameText);
		for (const input of [noData, { ...noData, data: null }, { ...noData, data: 'x' }]) {
			const n = normaliseAnyDocument(JSON.parse(JSON.stringify(input)), g2, games) as SiteDocument;
			assert.equal('data' in n, false, 'no `data` key at all');
			assert.equal(applyDocumentEdits(gameText, n, g2, games), gameText);
		}
		// …and a title change without `data` writes the title alone.
		const retitled = normaliseAnyDocument({ ...noData, title: 'Kites!' }, g2, games);
		assert.equal(applyDocumentEdits(gameText, retitled, g2, games), gameText.replace('"Kites"', '"Kites!"'));
	});

	test('a title and a page field changed in one edit: both written, keys in order title, page fields, seo, blocks', () => {
		const t = `{
  "title": "Kites",
  "tagline": "Fly one",
  "seo": {
    "title": "S"
  },
  "blocks": []
}
`;
		const doc = parse(t);
		const edited = normaliseAnyDocument({ ...doc, title: 'Kites!', data: { ...doc.data, tagline: 'Fly two' } }, g2, games);
		const out = applyDocumentEdits(t, edited, g2, games);
		assert.equal(out, t.replace('"Kites"', '"Kites!"').replace('"Fly one"', '"Fly two"'));
		const value = JSON.parse(out);
		assert.deepEqual(Object.keys(value), ['title', 'tagline', 'seo', 'blocks']);
		assert.equal(value.title, 'Kites!');
		assert.equal(value.tagline, 'Fly two');
	});

	test('a changed field is written in place; a new one after the key before it, before blocks; untouched keys keep their text', () => {
		const doc = parse(gameText);
		const out = applyDocumentEdits(gameText, { ...doc, data: { ...doc.data, side: 'right', fade: true } }, g2, games);
		assert.equal(
			out,
			gameText.replace('"side": "left",', '"side": "right",\n  "fade": true,'),
			'side in place, fade after it, tagline keeps its spacing, blocks and extra untouched',
		);
		const out2 = applyDocumentEdits(gameText, { ...doc, data: { ...doc.data, notes: [{ label: 'Rules', url: { label: 'Rules', href: '/rules' } }] } }, g2, games);
		assert.match(out2, /"side": "left",\n {2}"notes": \[\n {4}\{\n {6}"label": "Rules",/);
		assert.ok(out2.indexOf('"notes"') < out2.indexOf('"blocks"'));
		// Back to what the file had: untouched again.
		assert.equal(applyDocumentEdits(gameText, { ...doc, data: { ...doc.data } }, g2, games), gameText);
	});

	test('a new document: title, the page fields with a value in schema order, blocks, then seo', () => {
		const out = applyDocumentEdits(null, { title: 'New', blocks: [], data: { side: 'right', tagline: '', fade: false }, seo: { title: 'S' } }, g2, games);
		assert.equal(out, '{\n  "title": "New",\n  "side": "right",\n  "fade": false,\n  "blocks": [],\n  "seo": {\n    "title": "S"\n  }\n}\n');
	});

	test("the editor's document carries `data` through normalise (the preview and the write route)", () => {
		const n = normaliseAnyDocument({ title: 'K', blocks: [], data: { side: 'up', fade: 'yes', tagline: ' x ' } }, g2, games) as SiteDocument;
		assert.equal(n.data!.side, 'left', 'not an option: the first');
		assert.equal(n.data!.fade, false);
		assert.ok('related' in n.data!);
	});

	test("cms.read gives a section builder's page fields as render data; a missing reference is null", async () => {
		const files = new Map([
			['content/games/kites.json', '{ "title": "Kites", "tagline": "Fly", "related": "gone", "blocks": [] }\n'],
			['content/journal/a.json', '{ "title": "A", "blocks": [] }\n'],
		]);
		const reader = documentReader(g2, filesSource(siteRoot, () => files));
		const kites = await reader.document('games', 'kites');
		assert.equal(kites!.url, '/games/kites');
		assert.equal(kites!.data.tagline, 'Fly');
		assert.equal(kites!.data.related, null);
		assert.deepEqual((await reader.document('journal', 'a'))!.data, {});
	});

	test('a link in a page field is relinked when the page it points at moves', () => {
		const t = '{\n  "title": "K",\n  "more": { "label": "About", "href": "/about" },\n  "blocks": []\n}\n';
		const out = relinkText(t, { collection: 'pages', fromPath: 'about', toPath: 'studio', fromUrl: '/about', toUrl: '/studio' }, g2, games);
		assert.equal(out.links, 1);
		assert.match(out.text, /"href": "\/studio"/);
	});

	test("a page field's image with no alt is in Publish's summary, as a form's (block null)", () => {
		const t = '{\n  "title": "K",\n  "tile": { "key": "uploads/1fb083002e3a/t.jpg", "w": 10, "h": 10 },\n  "blocks": []\n}\n';
		const gaps = missingAltIn(g2, 'games', t);
		assert.equal(gaps.length, 1);
		assert.equal(gaps[0]!.block, null);
		assert.equal(gaps[0]!.path, 'tile.alt');
		assert.equal(gaps[0]!.label, 'Tile image');
	});

	test('the document store sets page fields under PAGE_SCOPE, with Undo, and sends them as `data`', () => {
		const entry = { collection: 'games', path: 'kites', file: 'content/games/kites.json', url: '/games/kites', title: 'Kites', label: 'Kites', warning: null };
		const store = createDocumentStore(g2, { ref: { collection: 'games', path: 'kites' }, entry, base: gameText, document: parse(gameText) });
		assert.equal(store.block(PAGE_SCOPE)!.data.side, 'left');
		store.setField(PAGE_SCOPE, 'side', 'right', { undoLabel: 'Changed side' });
		assert.equal((store.wire() as SiteDocument).data!.side, 'right');
		store.setField(PAGE_SCOPE, 'notes', [{ label: 'A', url: null }, { label: 'B', url: null }]);
		store.removeItem(PAGE_SCOPE, 'notes', 0, { label: 'Removed a note' });
		assert.deepEqual(((store.wire() as SiteDocument).data!.notes as { label: string }[]).map((n) => n.label), ['B']);
		store.undo();
		assert.deepEqual(((store.wire() as SiteDocument).data!.notes as { label: string }[]).map((n) => n.label), ['A', 'B']);
		store.undo();
		assert.equal((store.wire() as SiteDocument).data!.side, 'left');
		// A page in a collection without page fields has no such scope.
		const plain = createDocumentStore(g2, { ref: { collection: 'journal', path: 'a' }, entry: { ...entry, collection: 'journal' }, base: '{ "title": "A", "blocks": [] }\n', document: { title: 'A', blocks: [] } });
		plain.setField(PAGE_SCOPE, 'side', 'right');
		assert.equal(plain.block(PAGE_SCOPE), undefined);
		assert.equal((plain.wire() as SiteDocument).data, undefined);
	});

	test('live mode: a write through the drafts store keeps the page fields per key, and the preview\'s reader has them', async () => {
		const live = resolveSite(variant({ collections: { ...config.collections, journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal/', fields: { tagline: text() } } } }), siteRoot);
		const ORIGIN = 'http://site.test';
		const settings: LiveSettings = { github: { kind: 'memory' }, redisUrl: null, secret: 's'.repeat(32), allow: [], webhookSecret: null, railway: null, backup: null, runningCommit: null, timings: { ...DEFAULT_TIMINGS }, production: false };
		const clock = { t: Date.parse('2026-10-17T10:00:00Z') };
		const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
		backend.seed(await siteFiles(live));
		const now = () => clock.t;
		const rt = await createLiveRuntime({ site: live, settings, backend, redis: memoryRedis({ now }), now, log: () => {}, runningCommit: () => null });
		const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
		const opened = await ed.store.read('journal', 'apples');
		const doc = structuredClone(opened.document as SiteDocument);
		assert.equal(doc.data!.tagline, '');
		doc.data = { tagline: 'Crisp' };
		const body = JSON.stringify({ file: 'content/journal/apples.json', base: opened.text, document: doc });
		const res = await ed.write(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { origin: ORIGIN, 'x-caracms-tab': 'tab-aoife-1', 'content-type': 'application/json' }, body }), { email: 'aoife@example.com', name: 'Aoife' });
		assert.equal(res.status, 200, await res.clone().text());
		const reader = documentReader(live, await ed.store.source());
		assert.equal((await reader.document('journal', 'apples'))!.data.tagline, 'Crisp');
		const again = await ed.store.read('journal', 'apples');
		assert.equal(again.text, opened.text.replace(/("title": [^\n]*?)(,?)\n/, '$1,\n  "tagline": "Crisp"$2\n'));
	});
});

// ── G1: collections with no pages of their own ──────────────────────────────

const g1 = resolveSite(
	variant({
		collections: {
			...config.collections,
			team: { kind: 'fields', folder: 'content/team', component: 'Block.astro', fields: { role: text(), photo: media({ only: 'image' }) }, columns: ['role', 'edited'] },
			journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal/', fields: { people: list(reference({ to: 'team' })) } },
		},
	}),
	siteRoot,
);
const team = g1.collections.team!;
const g1Files = new Map([
	['content/team/aoife.json', '{\n  "title": "Aoife",\n  "role": "Designer"\n}\n'],
	['content/team/admin.json', '{\n  "title": "Admin",\n  "role": "Office"\n}\n'],
	['content/journal/hello.json', '{\n  "title": "Hello",\n  "people": ["aoife", "gone"],\n  "blocks": []\n}\n'],
]);
const g1Source = filesSource(siteRoot, () => g1Files);

describe('G1: a fields collection with no pages of its own', () => {
	test('no urlBase: resolved as null; an address column is refused', () => {
		assert.equal(team.urlBase, null);
		assert.equal(team.component !== null, true, 'component stays required: the preview renders through it');
		const bad = variant({ collections: { ...config.collections, team: { kind: 'fields', folder: 'content/team', component: 'Block.astro', fields: { role: text() }, columns: ['address'] } } });
		assert.throws(() => resolveSite(bad, siteRoot), /no pages of their own \(no urlBase\), so there's no 'address' column/);
		const noComponent = variant({ collections: { ...config.collections, team: { kind: 'fields', folder: 'content/team', fields: { role: text() } } as never } });
		assert.throws(() => resolveSite(noComponent, siteRoot), /component is required/);
	});

	test('its documents have no URL; they list, read and resolve as references', async () => {
		assert.equal(documentUrl(team, 'aoife'), null);
		const listed = await listDocuments(g1, 'team', g1Source);
		assert.deepEqual(listed.map((d) => [d.path, d.url]), [['admin', null], ['aoife', null]]);
		const reader = documentReader(g1, g1Source);
		assert.deepEqual((await reader.documents('team')).map((d) => [d.title, d.url, d.data.role]), [['Admin', null, 'Office'], ['Aoife', null, 'Designer']]);
		assert.deepEqual((await reader.document('journal', 'hello'))!.data.people, ['aoife', null]);
	});

	test('create makes a file from the name, with no address checks (a slug like "admin" is fine); no address to change', async () => {
		const listed = [...(await listDocuments(g1, 'team', g1Source)), ...(await listDocuments(g1, 'journal', g1Source))];
		const plan = planCreate(g1, { collection: 'team', path: 'ciaran', title: 'Ciarán' }, listed);
		assert.equal(plan.url, null);
		assert.equal(plan.text, '{\n  "$schema": "../../schemas/team.schema.json",\n  "title": "Ciarán"\n}\n');
		assert.throws(() => planCreate(g1, { collection: 'team', path: 'admin', title: 'Admin' }, listed), (e: unknown) => e instanceof WriteRefused && /already a document called "admin"/.test(e.message));
		const fresh = planCreate(g1, { collection: 'team', path: 'admin', title: 'Admin' }, listed.filter((d) => d.path !== 'admin'));
		assert.equal(fresh.url, null, '"admin" is reserved for pages, not for a document with no page');
		assert.throws(() => planMove(g1, { collection: 'team', path: 'aoife', to: 'aoife-b' }, listed), (e: unknown) => e instanceof WriteRefused && /Team has no pages of its own, so a document there has no address to change/.test(e.message));
	});
});

// ── G8: help text ────────────────────────────────────────────────────────────

describe('G8: help on every field and block', () => {
	test('every helper takes help; a field without it is as before', () => {
		const help = 'Shown in the sidebar.';
		const all = [
			text({ help }),
			lockup({ style: 'display', help }),
			select({ options: ['a'], help }),
			richText({ help }),
			link({ help }),
			buttons({ styles: ['primary'], help }),
			toggle({ help }),
			number({ help }),
			date({ help }),
			list(text(), { help }),
			media({ help }),
			reference({ to: 'pages', help }),
		];
		for (const f of all) assert.equal(f.help, help, f.kind);
		assert.equal('help' in text(), false);
		assert.deepEqual(text(), { kind: 'text', label: undefined, multiline: false, heading: false });
	});

	test("the config keeps it (a block's, a list item's, a fields collection's, a page field's) and refuses one that isn't text", () => {
		const s = resolveSite(
			variant({
				collections: {
					...config.collections,
					journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal/', fields: { tagline: text({ help: 'Under the title on cards.' }) } },
					team: { kind: 'fields', folder: 'content/team', component: 'Block.astro', fields: { role: text({ help: 'As on the about page.' }) } },
				},
				blocks: { ...config.blocks, quote: { component: 'Block.astro', help: 'A pull quote.', fields: { lines: list({ who: text({ help: 'Their name.' }) }) } } },
			}),
			siteRoot,
		);
		assert.equal(s.blocks.quote!.help, 'A pull quote.');
		assert.equal('help' in s.blocks.text!, false);
		const lines = s.blocks.quote!.fields.lines!;
		assert.equal(lines.kind === 'list' && lines.fields!.who!.help, 'Their name.');
		assert.equal(s.collections.journal!.fields!.tagline!.help, 'Under the title on cards.');
		assert.equal(s.collections.team!.fields!.role!.help, 'As on the about page.');
		assert.throws(() => resolveSite(variant({ blocks: { ...config.blocks, quote: { component: 'Block.astro', help: '  ', fields: {} } } }), siteRoot), /block "quote": help is a sentence of plain text/);
		assert.throws(() => resolveSite(variant({ blocks: { ...config.blocks, quote: { component: 'Block.astro', fields: { x: { ...text(), help: 3 as never } } } } }), siteRoot), /field "x": help is a sentence of plain text/);
	});
});

// ── G9: a link that's only an address ────────────────────────────────────────

describe('G9: link({ addressOnly: true })', () => {
	const site = link({ addressOnly: true, label: 'Website' });

	test('the descriptor says so; a plain link is as before; the config refuses anything but true', () => {
		assert.equal(site.addressOnly, true);
		assert.equal('addressOnly' in link(), false);
		assert.throws(
			() => resolveSite(variant({ blocks: { ...config.blocks, logo: { component: 'Block.astro', fields: { to: { ...link(), addressOnly: 'yes' as never } } } } }), siteRoot),
			/addressOnly is true or left out/,
		);
	});

	test('addressOnly and help are refused inside a list item too (validateField recurses), in both list shapes', () => {
		const withField = (x: unknown) => variant({ blocks: { ...config.blocks, logo: { component: 'Block.astro', fields: { items: x as never } } } });
		const badAddress = { ...link(), addressOnly: 'yes' as never };
		const badHelp = { ...text(), help: '   ' };
		// A list of one field: `list(field)`.
		assert.throws(() => resolveSite(withField(list(badAddress)), siteRoot), /addressOnly is true or left out/);
		assert.throws(() => resolveSite(withField(list(badHelp)), siteRoot), /help is a sentence of plain text/);
		// A list of items with fields: `list({ ... })`.
		assert.throws(() => resolveSite(withField(list({ to: badAddress })), siteRoot), /addressOnly is true or left out/);
		assert.throws(() => resolveSite(withField(list({ who: badHelp })), siteRoot), /help is a sentence of plain text/);
		// The same items, valid, resolve.
		assert.doesNotThrow(() => resolveSite(withField(list({ to: link({ addressOnly: true }), who: text({ help: 'Their name.' }) })), siteRoot));
	});

	test('stored as { "href" }; the render gets { href }, or null when empty or failing the rule', () => {
		assert.deepEqual(parseField(site, { label: 'ignored', href: ' /about ' }), { href: '/about' });
		assert.deepEqual(fieldToJson(site, { href: 'https://example.com' }), { href: 'https://example.com' });
		assert.deepEqual(renderValue(site, { href: '/about' }), { href: '/about' });
		assert.equal(renderValue(site, { href: '' }), null);
		assert.equal(renderValue(site, parseField(site, undefined)), null);
		assert.equal(renderValue(site, { href: 'javascript:alert(1)' }), null);
		assert.deepEqual(renderValue(list(site), [{ href: '/a' }, { href: '' }]), [{ href: '/a' }, null]);
	});

	test('no half-link warning; the link rule and the missing-page warning still apply', () => {
		assert.deepEqual(fieldWarnings(site, { href: '/about' }, { addresses: ['/about'] }), []);
		assert.deepEqual(fieldWarnings(site, { href: '' }), []);
		assert.deepEqual(fieldWarnings(site, { href: 'about' }).map((w) => [w.path, w.code]), [['href', 'link-rule']]);
		assert.deepEqual(fieldWarnings(site, { href: '/gone' }, { addresses: ['/about'] }).map((w) => [w.path, w.code]), [['href', 'link-missing']]);
		// A plain link still warns about half a link.
		assert.deepEqual(fieldWarnings(link(), { label: '', href: '/about' }).map((w) => w.code), ['half-link']);
	});

	test('an address-only link in a page field (G2) is relinked when its page moves, and stays { "href" } alone', () => {
		const s = resolveSite(variant({ collections: { ...config.collections, games: { kind: 'sections', folder: 'content/games', urlBase: '/games/', fields: { home: link({ addressOnly: true }) } } } }), siteRoot);
		const t = '{\n  "title": "K",\n  "home": { "href": "/about" },\n  "blocks": []\n}\n';
		const moved = relinkText(t, { collection: 'pages', fromPath: 'about', toPath: 'studio', fromUrl: '/about', toUrl: '/studio' }, s, s.collections.games!);
		assert.equal(moved.links, 1);
		assert.match(moved.text, /"home": \{ "href": "\/studio" \}/);
		assert.doesNotMatch(moved.text, /"label"/);
	});

	test('written by the serializer as { "href" }, and relinked when its page moves', () => {
		const s9 = resolveSite(variant({ blocks: { ...config.blocks, logo: { component: 'Block.astro', fields: { to: site } } } }), siteRoot);
		const t = '{\n  "title": "Home",\n  "blocks": [\n    { "type": "logo", "to": { "href": "/about" } }\n  ]\n}\n';
		const doc = parseDocument(JSON.parse(t), s9);
		assert.deepEqual(doc.blocks[0]!.data.to, { href: '/about' });
		assert.equal(applyEdits(t, doc, s9), t, 'untouched');
		const edited = applyEdits(t, { ...doc, blocks: [{ ...doc.blocks[0]!, data: { to: { href: '/contact' } } }] }, s9);
		assert.match(edited, /"to": \{\n {8}"href": "\/contact"\n {6}\}/);
		const moved = relinkText(t, { collection: 'pages', fromPath: 'about', toPath: 'studio', fromUrl: '/about', toUrl: '/studio' }, s9, s9.collections.pages!);
		assert.equal(moved.links, 1);
		assert.match(moved.text, /\{ "href": "\/studio" \}/);
	});
});
