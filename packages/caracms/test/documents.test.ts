// M5a Phase 2: the documents. List-of-fields documents and their per-key writer
// (Decision 7), shared blocks (Decision 8), the render's reads (Decision 9), the
// reserved collections through the seams, and Site Settings' brand and editors applying
// from the committed copy on the sweep's next tick (Decision 10), in both stores.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { date, list, lockup, reference, resolveSite, richText, SITE_SETTINGS_FILE, text, toggle, type ResolvedSite, type SiteConfig } from '../src/config.ts';
import { DocumentError, listDocuments, readDocument } from '../src/content.ts';
import { blockContexts, normaliseAnyDocument, parseAnyDocument, sharedEntryOf, type FieldsDocument, type SettingsDocument, type SharedDocument, type SiteDocument } from '../src/document.ts';
import { addressOf, refFromAddress } from '../src/editor/addresses.ts';
import { brandFrom, DEFAULT_ACCENT } from '../src/editor/brand.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { applyWrite, confinePath, WriteRefused } from '../src/editor/server/write.ts';
import type { StatusResponse } from '../src/editor/types.ts';
import { createWhitelist } from '../src/live/auth/allow.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { ready } from '../src/live/sweep.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { documentReader, resolveShared } from '../src/read.ts';
import { applyDocumentEdits, applyKeyedEdits, applySharedEdits } from '../src/serialize.ts';
import { config, display, fixtures, siteRoot } from './helpers/site.ts';

let root: string;
let site: ResolvedSite;

const CASE = 'content/case-studies/high-street-coffee.json';
// Written by hand: odd spacing, an unknown key in the middle, keys out of schema order, a stray asterisk.
const HARBOUR = `{
  "title": "High-street coffee roaster",
  "client":   "High-street coffee roaster",
  "legacyId": 42,
  "heading": ["High-street", "Coffee"],
  "body": [
    { "p": "A * stray star." }
  ],
  "related": ["tiny-publisher", "gone"]
}
`;
const PUBLISHER = `{
  "title": "Tiny publisher",
  "related": ["high-street-coffee"]
}
`;
const FOOTER = `{
  "title": "Footer",
  "block": {
    "type": "cta",
    "text": "Bring it over.",
    "flourish": true,
    "heading": ["Got Something", "Half-Built?"]
  }
}
`;
const SETTINGS = `{
  "title": "Site Settings",
  "editors": ["niamh@example.com"],
  "brand": { "name": "CaraCMS", "accent": "#1f3a2e" },
  "own": "kept"
}
`;

function makeSite(): void {
	root = mkdtempSync(join(tmpdir(), 'caracms-docs-'));
	cpSync(siteRoot, root, { recursive: true });
	mkdirSync(join(root, 'content/case-studies'), { recursive: true });
	mkdirSync(join(root, 'content/shared'), { recursive: true });
	writeFileSync(join(root, CASE), HARBOUR);
	writeFileSync(join(root, 'content/case-studies/tiny-publisher.json'), PUBLISHER);
	writeFileSync(join(root, 'content/shared/footer.json'), FOOTER);
	writeFileSync(join(root, 'content/shared/odd.json'), '{ "title": "Odd", "block": { "type": "gallery" } }\n');
	writeFileSync(join(root, SITE_SETTINGS_FILE), SETTINGS);
	// Not Site Settings: a stray file beside it, which no collection holds.
	writeFileSync(join(root, 'content/stray.json'), '{ "title": "Stray" }\n');
	// Home uses the footer, About uses it and one that doesn't exist.
	const home = JSON.parse(readFileSync(join(root, 'content/pages/index.json'), 'utf8'));
	home.blocks.push({ shared: 'footer' });
	writeFileSync(join(root, 'content/pages/index.json'), `${JSON.stringify(home, null, 2)}\n`);
	const about = JSON.parse(readFileSync(join(root, 'content/pages/about.json'), 'utf8'));
	about.blocks.push({ shared: 'footer' }, { shared: 'nowhere' }, { shared: 'odd' });
	writeFileSync(join(root, 'content/pages/about.json'), `${JSON.stringify(about, null, 2)}\n`);
	const siteConfig: SiteConfig = {
		...(config as SiteConfig),
		collections: {
			...(config as SiteConfig).collections,
			'case-studies': {
				kind: 'fields',
				folder: 'content/case-studies',
				urlBase: '/work/',
				component: 'Block.astro',
				fields: {
					heading: lockup({ style: 'display' }),
					client: text(),
					featured: toggle(),
					launched: date(),
					body: richText({ headings: ['h2'] }),
					credits: list({ role: text(), name: text() }),
					related: list(reference({ to: 'case-studies' })),
				},
			},
		},
		settings: { fields: { own: text() } },
		repoPath: 'starter',
		// The copy isn't beside the fonts the fixture's relative paths point at.
		textStyles: { display: { ...display, fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') } } },
	};
	site = resolveSite(siteConfig, root);
}

before(makeSite);
after(() => rmSync(root, { recursive: true, force: true }));

const cases = () => site.collections['case-studies']!;
const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('a list-of-fields document (Decision 7)', () => {
	test('it parses by its schema: every field present, unknown keys left out, the title its own', async () => {
		const { document, entry } = await readDocument(site, 'case-studies', 'high-street-coffee');
		const doc = document as FieldsDocument;
		assert.equal(doc.kind, 'fields');
		assert.equal(doc.title, 'High-street coffee roaster');
		assert.deepEqual(Object.keys(doc.data), ['heading', 'client', 'featured', 'launched', 'body', 'credits', 'related']);
		assert.equal(doc.data.client, 'High-street coffee roaster');
		assert.equal(doc.data.launched, null);
		assert.equal(entry.url, '/work/high-street-coffee');
		assert.equal(entry.kind, 'fields');
	});

	test('nothing touched: written back byte for byte', () => {
		const doc = parseAnyDocument(JSON.parse(HARBOUR), site, cases()) as FieldsDocument;
		assert.equal(applyKeyedEdits(HARBOUR, structuredClone(doc), cases()), HARBOUR);
	});

	test('one field edited: only its value changes; the unknown key, the odd spacing and the order stay', () => {
		const doc = parseAnyDocument(JSON.parse(HARBOUR), site, cases()) as FieldsDocument;
		doc.data.client = 'High-street roaster';
		const out = applyKeyedEdits(HARBOUR, doc, cases());
		assert.equal(out, HARBOUR.replace('"client":   "High-street coffee roaster"', '"client":   "High-street roaster"'));
		assert.ok(out.indexOf('"legacyId": 42') > out.indexOf('"client"'), 'the unknown key is where it was');
	});

	test('a touched key the file lacks goes after the key before it in schema order; the stray asterisk is escaped only once the body is touched', () => {
		const doc = parseAnyDocument(JSON.parse(HARBOUR), site, cases()) as FieldsDocument;
		doc.data.featured = true;
		doc.data.launched = '2024-05-02';
		const out = applyKeyedEdits(HARBOUR, doc, cases());
		assert.match(out, /"client": {3}"High-street coffee roaster",\n {2}"featured": true,\n {2}"launched": "2024-05-02",\n {2}"legacyId": 42/);
		assert.match(out, /A \* stray star/, 'the body is untouched: written as read');
		const body = parseAnyDocument(JSON.parse(out), site, cases()) as FieldsDocument;
		(body.data.body as { kind: string; runs: { text: string }[] }[])[0]!.runs.push({ text: '!' });
		assert.match(applyKeyedEdits(out, body, cases()), /A \\\\\* stray star/);
		JSON.parse(out);
	});

	test('a title change stays in place; a new document is `{ "title" }` (Decision 11)', () => {
		const doc = parseAnyDocument(JSON.parse(HARBOUR), site, cases()) as FieldsDocument;
		doc.title = 'Harbour';
		assert.equal(applyKeyedEdits(HARBOUR, doc, cases()), HARBOUR.replace('"title": "High-street coffee roaster"', '"title": "Harbour"'));
		assert.equal(applyKeyedEdits(null, { title: 'Kitchen pottery', data: {} }, cases()), '{\n  "title": "Kitchen pottery"\n}\n');
	});

	test('a write of the wrong kind for the collection is refused', () => {
		const page: SiteDocument = { title: 'x', blocks: [] };
		assert.throws(() => applyDocumentEdits(HARBOUR, page, site, cases()), /sections document can't be written to a fields collection/);
	});

	test('the write route (local) writes it, keeping the unknown key', async () => {
		const opened = await localDraftsStore(site).read('case-studies', 'high-street-coffee');
		const doc = structuredClone(opened.document as FieldsDocument);
		doc.data.client = 'High-street roaster';
		await applyWrite(site, { file: CASE, base: opened.text, document: doc });
		assert.match(read(CASE), /"client": {3}"High-street roaster",\n {2}"legacyId": 42,/);
		writeFileSync(join(root, CASE), HARBOUR);
	});
});

describe('shared blocks (Decision 8)', () => {
	test('the file parses to its block; untouched, it writes back byte for byte; an edit rewrites the block, type first, unknown keys after', () => {
		const doc = parseAnyDocument(JSON.parse(FOOTER), site, site.collections.shared!) as SharedDocument;
		assert.equal(doc.block.type, 'cta');
		assert.equal(doc.block.known, true);
		assert.equal(applySharedEdits(FOOTER, structuredClone(doc), site), FOOTER);
		doc.block.data.text = 'Bring it round.';
		const out = applySharedEdits(FOOTER, doc, site);
		assert.match(out, /"block": \{\n {4}"type": "cta",\n {4}"heading": \["Got Something", "Half-Built\?"\],\n {4}"text": "Bring it round\.",\n {4}"flourish": true\n {2}\}/);
		assert.match(out, /^\{\n {2}"title": "Footer",/);
	});

	test('a page\'s shared entry is kept as read, never known; the listing gives "used on" and each page\'s uses', async () => {
		const about = (await readDocument(site, 'pages', 'about')).document as SiteDocument;
		const entries = about.blocks.filter((b) => b.shared !== undefined);
		assert.deepEqual(
			entries.map((b) => [b.shared, b.known]),
			[
				['footer', false],
				['nowhere', false],
				['odd', false],
			],
		);
		const all = await listDocuments(site);
		const footer = all.find((d) => d.collection === 'shared' && d.path === 'footer')!;
		assert.equal(footer.url, null);
		assert.equal(footer.blockType, 'cta');
		assert.deepEqual(footer.usedOn, [
			{ collection: 'pages', path: 'index' },
			{ collection: 'pages', path: 'about' },
		]);
		assert.deepEqual(all.find((d) => d.path === 'about')!.uses, ['footer', 'nowhere', 'odd']);
	});

	test('an entry the editor sends back as `{ source, type, known, data }` is still a shared entry (the preview and the write route)', () => {
		const doc = normaliseAnyDocument({ title: 'About', blocks: [{ source: 2, type: '', known: false, data: { shared: 'footer' } }] }, site, site.collections.pages!) as SiteDocument;
		assert.equal(doc.blocks[0]!.shared, 'footer');
		assert.equal(sharedEntryOf({ known: false, data: { shared: 'footer' } }), 'footer');
		assert.equal(sharedEntryOf({ known: true, data: { shared: 'footer' } }), undefined);
	});

	test('the render resolves an entry from its source: the block, or skipped when missing or of an unknown type', async () => {
		const reader = documentReader(site, (await localDraftsStore(site).source()));
		const about = (await readDocument(site, 'pages', 'about')).document as SiteDocument;
		const [ok, missing, odd] = about.blocks.filter((b) => b.shared !== undefined);
		const r = await resolveShared(ok!, reader);
		assert.ok('block' in r && r.block.type === 'cta' && r.block.source === ok!.source);
		assert.deepEqual(await resolveShared(missing!, reader), { skip: 'missing', type: '' });
		assert.deepEqual(await resolveShared(odd!, reader), { skip: 'unknown-type', type: 'gallery' });
		// The resolved block takes part in the page's h1 rule (Decision 16); its fields are marked as the shared block's.
		const resolved = new Map([[about.blocks.indexOf(ok!), (r as { block: never }).block]]);
		const contexts = blockContexts(about, site, true, reader, resolved);
		const shared = contexts[about.blocks.indexOf(ok!)]!;
		assert.equal(shared.preview, true);
		assert.deepEqual(shared.shared, { name: 'footer', preview: true });
		assert.deepEqual(shared.source, { collection: 'shared', path: 'footer' });
		// Public: no markers.
		const pub = blockContexts(about, site, false, reader, resolved)[about.blocks.indexOf(ok!)]!;
		assert.deepEqual([pub.preview, pub.shared], [false, { name: 'footer', preview: false }]);
		assert.equal(contexts[about.blocks.indexOf(missing!)], null);
	});
});

describe('the render reads other documents (Decision 9)', () => {
	test('one document, a collection in order; a reference to a missing document is null; documents that refer to each other don\'t wait on each other', async () => {
		const reader = documentReader(site, (await localDraftsStore(site).source()));
		const docs = await reader.documents('case-studies');
		assert.deepEqual(
			docs.map((d) => [d.path, d.url]),
			[
				['high-street-coffee', '/work/high-street-coffee'],
				['tiny-publisher', '/work/tiny-publisher'],
			],
		);
		assert.deepEqual(docs[0]!.data.related, ['tiny-publisher', null]);
		assert.equal(await reader.document('case-studies', 'gone'), null);
		assert.equal(await reader.exists('pages', 'about'), true);
		assert.equal(await reader.document('nope', 'x'), null);
	});
});

describe('the reserved collections through the seams (Decision 8)', () => {
	test('the listing has every kind, with its public address (null for shared blocks and Site Settings), and only Site Settings in `settings`', async () => {
		const all = await listDocuments(site);
		const by = (c: string) => all.filter((d) => d.collection === c).map((d) => d.path);
		assert.deepEqual(by('shared'), ['footer', 'odd']);
		assert.deepEqual(by('settings'), ['site-settings']);
		const settings = all.find((d) => d.collection === 'settings')!;
		assert.equal(settings.kind, 'settings');
		assert.equal(settings.url, null);
		assert.equal(settings.file, SITE_SETTINGS_FILE);
		assert.ok(all.some((d) => d.url === '/work/tiny-publisher'));
	});

	test('the write route\'s confinement takes a shared block and Site Settings, and nothing else beside it', () => {
		assert.deepEqual(confinePath(site, 'content/shared/footer.json'), { collection: 'shared', path: 'footer', absolute: join(root, 'content/shared/footer.json') });
		assert.equal(confinePath(site, SITE_SETTINGS_FILE).collection, 'settings');
		assert.throws(() => confinePath(site, 'content/stray.json'), (e: unknown) => e instanceof WriteRefused && /isn't in a folder any collection declares/.test(e.message));
		assert.throws(() => confinePath(site, 'content/shared/../stray.json'), WriteRefused);
		assert.rejects(readDocument(site, 'settings', 'stray'), DocumentError);
	});

	test('Site Settings parses and writes per key: the brand on its lines, editors on one, the site\'s own key kept', async () => {
		const store = localDraftsStore(site);
		const opened = await store.read('settings', 'site-settings');
		const doc = structuredClone(opened.document as SettingsDocument);
		assert.deepEqual(doc.data.brand, { name: 'CaraCMS', accent: '#1f3a2e', logo: null, icon: null });
		assert.equal(doc.data.own, 'kept');
		doc.data.brand = { name: 'CaraCMS', accent: '#336699', logo: null, icon: null };
		doc.data.editors = ['niamh@example.com', '@example.com'];
		await store.write({ file: SITE_SETTINGS_FILE, base: opened.text, document: doc });
		assert.equal(
			read(SITE_SETTINGS_FILE),
			'{\n  "title": "Site Settings",\n  "editors": ["niamh@example.com", "@example.com"],\n  "brand": {\n    "name": "CaraCMS",\n    "accent": "#336699"\n  },\n  "own": "kept"\n}\n',
		);
		writeFileSync(join(root, SITE_SETTINGS_FILE), SETTINGS);
	});

	test('the editor\'s addresses: /admin/shared/<name> and /admin/settings', () => {
		const home = { collection: 'pages', path: 'index' };
		assert.equal(addressOf({ collection: 'shared', path: 'footer' }, home), '/admin/shared/footer');
		assert.equal(addressOf({ collection: 'settings', path: 'site-settings' }, home), '/admin/settings');
		assert.deepEqual(refFromAddress('/admin/settings', ['pages'], home), { collection: 'settings', path: 'site-settings' });
		assert.deepEqual(refFromAddress('/admin/shared/footer', ['pages'], home), { collection: 'shared', path: 'footer' });
	});
});

describe('Site Settings\' brand (Decision 10)', () => {
	test('from the file, else "Site" and the neutral accent; a value that isn\'t a colour reads as the neutral one', () => {
		assert.deepEqual(brandFrom(SETTINGS, { brand: { logo: '/l.svg' } }), { logo: '/l.svg', name: 'CaraCMS', accent: '#1f3a2e' });
		assert.deepEqual(brandFrom(null, { brand: {} }), { name: 'Site', accent: DEFAULT_ACCENT });
		assert.deepEqual(brandFrom('{ "brand": { "name": " ", "accent": "navy" } }', { brand: {} }), { name: 'Site', accent: DEFAULT_ACCENT });
		assert.equal(brandFrom('not json', { brand: {} }).name, 'Site');
	});

	test('the sweep takes an autosave marked to go at once on its next tick, idle or not', () => {
		const t = 1_000_000;
		const a = { updatedAt: t, firstAt: t } as never;
		assert.equal(ready(a, t + 1, DEFAULT_TIMINGS), false);
		assert.equal(ready({ ...(a as object), sweepAtOnce: true } as never, t + 1, DEFAULT_TIMINGS), true);
	});
});

describe('live mode: Site Settings applies on the sweep\'s next tick, from the copy (Decision 10)', () => {
	const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
	const ORIGIN = 'http://site.test';
	const settings: LiveSettings = {
		github: { kind: 'memory' },
		redisUrl: null,
		secret: 's'.repeat(32),
		allow: [],
		webhookSecret: null,
		railway: null,
		backup: null,
		runningCommit: null,
		timings: { ...DEFAULT_TIMINGS },
		production: false,
	};
	const request = (path: string, body?: unknown) =>
		new Request(`${ORIGIN}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { origin: ORIGIN, 'x-caracms-tab': 'tab-aoife-1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});

	async function liveEditor(): Promise<{ ed: LiveEditor; clock: { t: number }; backend: MemoryBackend }> {
		const clock = { t: Date.parse('2026-10-15T10:00:00Z') };
		const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
		backend.seed(await siteFiles(site));
		const now = () => clock.t;
		const rt = await createLiveRuntime({ site, settings, backend, redis: memoryRedis({ now }), now, log: () => {}, runningCommit: () => null });
		const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
		return { ed, clock, backend };
	}
	const brandOf = async (ed: LiveEditor) => ((await (await ed.status(request('/_caracms/status'), aoife)).json()) as StatusResponse).brand;

	test('the copy keeps shared blocks and Site Settings; the live store lists and reads them', async () => {
		const { ed, backend } = await liveEditor();
		assert.ok(backend.file('drafts', 'starter/content/shared/footer.json'));
		assert.equal(backend.file('drafts', 'starter/content/stray.json'), null, 'not in any collection, so not in the copy');
		const all = await ed.store.list();
		assert.ok(all.some((d) => d.collection === 'shared' && d.path === 'footer'));
		assert.ok(all.some((d) => d.collection === 'settings'));
		assert.equal(((await ed.store.read('shared', 'footer')).document as SharedDocument).block.type, 'cta');
	});

	test('a kept accent change reaches the brand on the next tick, with no Publish and no idle wait; until then the copy\'s brand stands', async () => {
		const { ed, backend } = await liveEditor();
		const opened = await ed.store.read('settings', 'site-settings');
		const doc = structuredClone(opened.document as SettingsDocument);
		doc.data.brand = { name: 'CaraCMS', accent: '#336699', logo: null, icon: null };
		const res = await ed.write(request('/_caracms/write', { file: SITE_SETTINGS_FILE, base: opened.text, document: doc }), aoife);
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal((await brandOf(ed)).accent, '#1f3a2e', 'the autosave isn\'t laid on top');
		const tick = await ed.sweep.tick(); // no clock moved: no idle wait
		assert.ok(tick.commit, 'committed on the very next tick');
		assert.equal((await brandOf(ed)).accent, '#336699');
		assert.match(backend.file('drafts', `starter/${SITE_SETTINGS_FILE}`)!, /"accent": "#336699"/);
		assert.equal(backend.file('main', `starter/${SITE_SETTINGS_FILE}`), SETTINGS, 'no Publish');
	});

	test('a half-typed editors entry never reaches the whitelist: not while it\'s an autosave, and ignored once committed', async () => {
		const { ed } = await liveEditor();
		const allow = createWhitelist({ agency: [], readSettings: () => ed.runtime.git.read(SITE_SETTINGS_FILE), settingsFile: SITE_SETTINGS_FILE, log: () => {} });
		const opened = await ed.store.read('settings', 'site-settings');
		const doc = structuredClone(opened.document as SettingsDocument);
		doc.data.editors = ['niamh@example.com', 'ciaran@site'];
		await ed.write(request('/_caracms/write', { file: SITE_SETTINGS_FILE, base: opened.text, document: doc }), aoife);
		assert.equal(allow.allows('ciaran@site'), false, 'an autosave');
		await ed.sweep.tick();
		assert.equal(allow.allows('ciaran@site'), false, 'committed, and still not an address');
		assert.equal(allow.allows('niamh@example.com'), true);
		// The whole address, kept: it applies on the next tick.
		const again = await ed.store.read('settings', 'site-settings');
		const whole = structuredClone(again.document as SettingsDocument);
		whole.data.editors = ['niamh@example.com', 'ciaran@example.com'];
		await ed.write(request('/_caracms/write', { file: SITE_SETTINGS_FILE, base: again.text, document: whole }), aoife);
		assert.equal(allow.allows('ciaran@example.com'), false);
		await ed.sweep.tick();
		assert.equal(allow.allows('ciaran@example.com'), true);
	});

	test('a page\'s autosave still waits for the idle minute (only Site Settings goes at once)', async () => {
		const { ed } = await liveEditor();
		const opened = await ed.store.read('case-studies', 'high-street-coffee');
		const doc = structuredClone(opened.document as FieldsDocument);
		doc.data.client = 'High-street roaster';
		const res = await ed.write(request('/_caracms/write', { file: CASE, base: opened.text, document: doc }), aoife);
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal((await ed.sweep.tick()).commit, null);
		// The preview's source has the autosave on top (Decision 9).
		const reader = documentReader(site, await ed.store.source());
		assert.equal((await reader.document('case-studies', 'high-street-coffee'))!.data.client, 'High-street roaster');
	});
});
