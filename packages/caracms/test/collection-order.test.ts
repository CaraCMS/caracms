// Review gaps, hand order (Decisions 1–5), the server half, without a browser:
// - collection-order.ts: the order rule, a new entry first, a rename keeping its place, what
//   validate finds (checks 4, 5, 9, 10);
// - defineSite's refusals (check 1);
// - the listing and `documents()` follow Site Settings' `collectionOrder`, hidden entries
//   keeping their places (checks 3, 5, 6);
// - POST /_caracms/collection-order in local mode, a new entry first, a rename (checks 2, 4, 9);
// - live mode: the lock and the autosave, the stamp, a new entry while someone else has Site
//   Settings (checks 4, 8);
// - `collectionOrder` is a reserved key.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { resolveSite, SITE_SETTINGS_FILE, text, type ResolvedSite, type SiteConfig } from '../src/config.ts';
import { collectionOrderAfterMoves, inSiteOrder, prunedCollectionOrder, unknownCollectionOrderEntries, withFirst, withList } from '../src/collection-order.ts';
import { UNKEPT_PLACE_MESSAGE } from '../src/editor/server/collection-order.ts';
import { diskSource, listDocuments } from '../src/content.ts';
import { handleCollectionOrder, handleCreate } from '../src/editor/server/create.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { handleMove } from '../src/editor/server/move.ts';
import type { CreateResponse, StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { documentReader } from '../src/read.ts';
import { makeCliSite } from './helpers/cli-site.ts';
import { config, display, fixtures, siteRoot } from './helpers/site.ts';

const ORIGIN = 'http://site.test';
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const TAB_A = 'tab-aoife-1';
const TAB_C = 'tab-ciaran-1';

function request(path: string, init: { tab?: string | null; body?: unknown } = {}) {
	const headers: Record<string, string> = { origin: ORIGIN };
	if (init.tab) headers['x-caracms-tab'] = init.tab;
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return new Request(`${ORIGIN}${path}`, { method: init.body === undefined ? 'GET' : 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
async function call<T = Record<string, unknown>>(res: Promise<Response>): Promise<{ status: number; body: T }> {
	const r = await res;
	return { status: r.status, body: (await r.json()) as T };
}
type Answer = { ok?: true; error?: string; code?: string };

// ── The site ─────────────────────────────────────────────────────────────────

const page = (title: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ title, ...extra, blocks: [] }, null, 2)}\n`;
const SETTINGS = '{\n  "title": "Site Settings",\n  "editors": []\n}\n';
const withOrder = (order: Record<string, string[]>) => `${JSON.stringify({ title: 'Site Settings', editors: [], collectionOrder: order }, null, 2)}\n`;
const FILES: Record<string, string> = {
	'content/pages/index.json': page('Home'),
	'content/pages/journal.json': page('Journal', { holds: 'journal' }),
	'content/work/harbour.json': page('High-street coffee roaster'),
	'content/work/wheels.json': page('Weekend bike shop'),
	'content/work/art.json': page('Art books'),
	'content/work/mill.json': page('Mill house', { hidden: true }),
	'content/journal/first.json': page('First post'),
	'content/journal/second.json': page('Second post'),
	[SITE_SETTINGS_FILE]: SETTINGS,
};

const siteConfig = (collections: SiteConfig['collections'] = {}): SiteConfig => ({
	...(config as SiteConfig),
	collections: {
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
		work: { kind: 'sections', folder: 'content/work', urlBase: '/work/', order: 'manual' },
		journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', order: 'manual' },
		...collections,
	},
	textStyles: { display: { ...display, fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') } } },
});

interface TestSite {
	root: string;
	site: ResolvedSite;
	read(file: string): string;
	write(file: string, text: string): void;
	cleanup(): void;
}

function makeSite(options: { files?: Record<string, string>; repoPath?: string } = {}): TestSite {
	const tmp = mkdtempSync(join(tmpdir(), 'caracms-hand-order-'));
	const root = join(tmp, 'site');
	cpSync(siteRoot, root, { recursive: true });
	rmSync(join(root, 'content'), { recursive: true, force: true });
	const write = (file: string, text: string) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	};
	for (const [file, text] of Object.entries({ ...FILES, ...(options.files ?? {}) })) write(file, text);
	const site = resolveSite({ ...siteConfig(), ...(options.repoPath ? { repoPath: options.repoPath } : {}) }, root);
	return { root, site, read: (f) => readFileSync(join(root, f), 'utf8'), write, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

const handOrderOf = (text: string) => (JSON.parse(text) as { collectionOrder?: Record<string, string[]> }).collectionOrder;
const listed = async (site: ResolvedSite, collection = 'work', source?: Parameters<typeof listDocuments>[2]) => (await listDocuments(site, collection, source)).map((d) => d.path);

function local(files?: Record<string, string>) {
	const s = makeSite({ files });
	const store = localDraftsStore(s.site);
	const order = (body: unknown) => call<Answer>(handleCollectionOrder(request('/_caracms/collection-order', { body }), store));
	const create = (body: unknown) => call<CreateResponse & Answer>(handleCreate(request('/_caracms/create', { body }), store));
	const move = (body: unknown) => call<Answer>(handleMove(request('/_caracms/move', { body }), store));
	return { s, store, order, create, move };
}

// ── collection-order.ts ───────────────────────────────────────────────────────

describe('the order rule (Decisions 4, 5)', () => {
	const items = [
		{ path: 'harbour', label: 'High-street coffee roaster' },
		{ path: 'wheels', label: 'Weekend bike shop' },
		{ path: 'art', label: 'Art books' },
		{ path: 'mill', label: 'Mill house' },
	];
	const paths = (list: { path: string }[]) => list.map((i) => i.path);
	test('nothing saved: A–Z by label', () => {
		assert.deepEqual(paths(inSiteOrder(items, undefined)), ['art', 'harbour', 'mill', 'wheels']);
	});
	test('the named ones in the saved order, then the rest A–Z; an unknown path ignored (check 5)', () => {
		assert.deepEqual(paths(inSiteOrder(items, ['wheels', 'gone', 'mill'])), ['wheels', 'mill', 'art', 'harbour']);
	});
	test('a new entry goes first, taken from wherever it was; a whole list replaces the saved one', () => {
		assert.deepEqual(withFirst({ work: ['wheels', 'mill'] }, 'work', 'new'), { work: ['new', 'wheels', 'mill'] });
		assert.deepEqual(withFirst({ work: ['wheels', 'mill'] }, 'work', 'mill'), { work: ['mill', 'wheels'] });
		assert.deepEqual(withFirst({}, 'work', 'new'), { work: ['new'] });
		assert.deepEqual(withList({ work: ['wheels'], other: ['x'] }, 'work', ['a', 'b', 'a']), { work: ['a', 'b'], other: ['x'] });
		assert.deepEqual(withList({ work: ['wheels'] }, 'work', []), {});
	});
	test('a rename keeps its place; a swap keeps both (check 9)', () => {
		assert.deepEqual(collectionOrderAfterMoves({ work: ['wheels', 'mill', 'art'] }, [{ collection: 'work', from: 'mill', to: 'mill-house' }]), { work: ['wheels', 'mill-house', 'art'] });
		assert.deepEqual(
			collectionOrderAfterMoves({ work: ['wheels', 'mill'] }, [
				{ collection: 'work', from: 'wheels', to: 'mill' },
				{ collection: 'work', from: 'mill', to: 'wheels' },
			]),
			{ work: ['mill', 'wheels'] },
		);
		assert.deepEqual(collectionOrderAfterMoves({ work: ['wheels'] }, [{ collection: 'pages', from: 'wheels', to: 'x' }]), { work: ['wheels'] }, "another collection's move changes nothing");
	});
	test('unknown entries are found and pruned (check 10)', () => {
		const known = new Map([['work', ['wheels', 'mill']]]);
		const order = { work: ['wheels', 'gone', 'mill'], nowhere: ['x', 'y'] };
		assert.deepEqual(unknownCollectionOrderEntries(order, known), [
			{ collection: 'work', path: 'gone' },
			{ collection: 'nowhere', path: null },
		]);
		assert.deepEqual(prunedCollectionOrder(order, known), { order: { work: ['wheels', 'mill'] }, pruned: 3 });
	});
});

// ── defineSite ─────────────────────────────────────────────────────────────

describe("order: 'manual' in the config (check 1)", () => {
	const resolve = (collections: SiteConfig['collections']) => resolveSite(siteConfig(collections), siteRoot);
	test('accepted on a flat collection and a held one', () => {
		const site = resolve({});
		assert.equal(site.collections.work!.order, 'manual');
		assert.equal(site.collections.journal!.order, 'manual');
		assert.equal(site.collections.pages!.order, undefined);
	});
	test('refused beside sort, on a nested collection, and as anything but manual, naming the collection', () => {
		assert.throws(() => resolve({ work: { kind: 'sections', folder: 'content/work', urlBase: '/work/', order: 'manual', sort: { column: 'title', order: 'asc' } } }), /collection "work": it has both order: 'manual' and sort/);
		assert.throws(() => resolve({ pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true, order: 'manual' } }), /collection "pages": order: 'manual' is for a flat collection; a nested one \(Pages\) is ordered on the Arrange screen/);
		assert.throws(() => resolve({ work: { kind: 'sections', folder: 'content/work', urlBase: '/work/', order: 'random' as 'manual' } }), /collection "work": order must be 'manual'/);
	});
	test('collectionOrder is one of Site Settings\' own keys', () => {
		assert.throws(() => resolveSite({ ...siteConfig(), settings: { fields: { collectionOrder: text() } } } as SiteConfig, siteRoot), /settings: "collectionOrder" is one of Site Settings' own keys/);
	});
});

// ── The listing ──────────────────────────────────────────────────────────────

describe('the listing and documents() follow the hand order (checks 3, 5, 6)', () => {
	test('nothing saved: A–Z; saved: the named ones first, an unnamed file after them A–Z', async () => {
		const s = makeSite();
		try {
			assert.deepEqual(await listed(s.site), ['art', 'harbour', 'mill', 'wheels']);
			s.write(SITE_SETTINGS_FILE, withOrder({ work: ['wheels', 'mill'], journal: ['second', 'first'] }));
			assert.deepEqual(await listed(s.site), ['wheels', 'mill', 'art', 'harbour']);
			assert.deepEqual(await listed(s.site, 'journal'), ['second', 'first'], 'a held collection too');
			// An entry file added outside the editor: after the named ones, A–Z (check 5).
			s.write('content/work/bay.json', page('Bay'));
			assert.deepEqual(await listed(s.site), ['wheels', 'mill', 'art', 'bay', 'harbour']);
		} finally {
			s.cleanup();
		}
	});
	test('documents() leaves a hidden entry out after ordering, the rest keeping their order (check 6)', async () => {
		const s = makeSite({ files: { [SITE_SETTINGS_FILE]: withOrder({ work: ['harbour', 'mill', 'wheels', 'art'] }) } });
		try {
			assert.deepEqual(await listed(s.site), ['harbour', 'mill', 'wheels', 'art'], 'the hidden one keeps its place in the list');
			const read = await documentReader(s.site, diskSource).documents('work');
			assert.deepEqual(
				read.map((r) => r.path),
				['harbour', 'wheels', 'art'],
			);
		} finally {
			s.cleanup();
		}
	});
});

// ── Local ────────────────────────────────────────────────────────────────────

describe('local: POST /_caracms/collection-order (checks 2, 4, 9)', () => {
	test("a drag's whole list is written to collectionOrder, nothing else changes, and the listing follows", async () => {
		const { s, order } = local();
		try {
			const r = await order({ collection: 'work', order: ['wheels', 'art', 'harbour', 'mill'] });
			assert.deepEqual(r, { status: 200, body: { ok: true } });
			assert.deepEqual(handOrderOf(s.read(SITE_SETTINGS_FILE)), { work: ['wheels', 'art', 'harbour', 'mill'] });
			assert.match(s.read(SITE_SETTINGS_FILE), /"collectionOrder": \{\n {4}"work": \["wheels", "art", "harbour", "mill"\]\n {2}\}/, "one collection's list per line");
			assert.deepEqual(await listed(s.site), ['wheels', 'art', 'harbour', 'mill']);
		} finally {
			s.cleanup();
		}
	});
	test('refused: a collection with no hand order, a path that names nothing, a malformed body', async () => {
		const { s, order } = local();
		try {
			const before = s.read(SITE_SETTINGS_FILE);
			const pages = await order({ collection: 'pages', order: ['index'] });
			assert.equal(pages.status, 400);
			assert.match(pages.body.error!, /Pages has no hand order/);
			const gone = await order({ collection: 'work', order: ['wheels', 'gone'] });
			assert.equal(gone.status, 404);
			assert.equal(gone.body.code, 'not-found');
			assert.equal((await order({ collection: 'nope', order: [] })).status, 404);
			assert.equal((await order({ collection: 'work' })).status, 400);
			assert.equal((await order({ collection: 'work', order: ['wheels'], first: 'wheels' })).status, 400);
			assert.equal((await order({ collection: 'work', order: [3] })).status, 400);
			assert.equal(s.read(SITE_SETTINGS_FILE), before);
		} finally {
			s.cleanup();
		}
	});
	test('first puts one entry first in the order as it stands', async () => {
		const { s, order } = local({ [SITE_SETTINGS_FILE]: withOrder({ work: ['wheels', 'mill'] }) });
		try {
			assert.equal((await order({ collection: 'work', first: 'harbour' })).status, 200);
			assert.deepEqual(handOrderOf(s.read(SITE_SETTINGS_FILE)), { work: ['harbour', 'wheels', 'mill'] });
		} finally {
			s.cleanup();
		}
	});
	test('a new entry goes first, in the same write (check 4); another collection\'s gets no order', async () => {
		const { s, create } = local({ [SITE_SETTINGS_FILE]: withOrder({ work: ['wheels', 'mill'] }) });
		try {
			const made = await create({ collection: 'work', path: 'seaweed', title: 'Seaweed Baths' });
			assert.equal(made.status, 200, JSON.stringify(made.body));
			assert.equal(made.body.order, 'first');
			assert.deepEqual(handOrderOf(s.read(SITE_SETTINGS_FILE)), { work: ['seaweed', 'wheels', 'mill'] });
			assert.deepEqual((await listed(s.site)).slice(0, 2), ['seaweed', 'wheels']);
			const pageMade = await create({ collection: 'pages', path: 'about', title: 'About' });
			assert.equal(pageMade.body.order, undefined);
			assert.deepEqual(handOrderOf(s.read(SITE_SETTINGS_FILE)), { work: ['seaweed', 'wheels', 'mill'] });
		} finally {
			s.cleanup();
		}
		// With no Site Settings file yet, the create makes one holding the order.
		const v = local();
		try {
			rmSync(join(v.s.root, SITE_SETTINGS_FILE));
			assert.equal((await v.create({ collection: 'work', path: 'seaweed', title: 'Seaweed Baths' })).status, 200);
			assert.deepEqual(handOrderOf(v.s.read(SITE_SETTINGS_FILE)), { work: ['seaweed'] });
		} finally {
			v.s.cleanup();
		}
	});
	test("Site Settings that isn't JSON: the entry is made, Site Settings is left as it is, and create says its place wasn't kept", async () => {
		const { s, create } = local({ [SITE_SETTINGS_FILE]: '{ not json' });
		try {
			const made = await create({ collection: 'work', path: 'seaweed', title: 'Seaweed Baths' });
			assert.equal(made.status, 200, JSON.stringify(made.body));
			assert.equal(made.body.order, 'unkept');
			assert.equal(made.body.orderError, UNKEPT_PLACE_MESSAGE);
			assert.equal(s.read(SITE_SETTINGS_FILE), '{ not json');
			assert.ok((await listed(s.site)).includes('seaweed'), 'the entry is made');
		} finally {
			s.cleanup();
		}
	});
	test('Change address… keeps a renamed entry\'s place (check 9)', async () => {
		const { s, move } = local({ [SITE_SETTINGS_FILE]: withOrder({ work: ['wheels', 'mill', 'art'] }) });
		try {
			const r = await move({ collection: 'work', path: 'mill', to: 'mill-house' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(handOrderOf(s.read(SITE_SETTINGS_FILE)), { work: ['wheels', 'mill-house', 'art'] });
			assert.deepEqual((await listed(s.site)).slice(0, 3), ['wheels', 'mill-house', 'art']);
		} finally {
			s.cleanup();
		}
	});
});

// ── caracms validate ─────────────────────────────────────────────────────────

describe('caracms validate (check 10)', () => {
	test('warns on an ordered path that no longer exists, and on a collection with no hand order; --fix prunes them and says how many', () => {
		const cli = makeCliSite('hand-order');
		try {
			const settings = JSON.parse(cli.read(SITE_SETTINGS_FILE)) as Record<string, unknown>;
			settings.collectionOrder = { 'case-studies': ['weekend-bikes', 'gone', 'tiny-publisher'], journal: ['x'] };
			cli.write(SITE_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
			const warned = cli.run('validate');
			assert.match(warned.stdout, /content\/site-settings\.json › collectionOrder\["case-studies"\]: The order of Case studies names "gone", which isn't one of its entries any more\. `caracms validate --fix` prunes it\./);
			assert.match(warned.stdout, /collectionOrder\["journal"\]: The hand order names "journal", which \(Journal\) has no order: 'manual'/);
			const fixed = cli.run('validate', '--fix');
			assert.match(fixed.stdout, /pruned 2 hand-order entries/);
			assert.deepEqual((JSON.parse(cli.read(SITE_SETTINGS_FILE)) as Record<string, unknown>).collectionOrder, { 'case-studies': ['weekend-bikes', 'tiny-publisher'] });
			assert.doesNotMatch(cli.run('validate').stdout, /hand order|collectionOrder/);
		} finally {
			cli.cleanup();
		}
	});
});

// ── Live ─────────────────────────────────────────────────────────────────────

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

interface World {
	clock: { t: number };
	backend: MemoryBackend;
	ed: LiveEditor;
	s: TestSite;
}

async function world(files?: Record<string, string>): Promise<World> {
	const s = makeSite({ repoPath: 'starter', files });
	const clock = { t: Date.parse('2026-11-01T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	backend.seed([...(await siteFiles(s.site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const rt = await createLiveRuntime({ site: s.site, settings, backend, redis: memoryRedis({ now: () => clock.t }), now: () => clock.t, log: () => {}, runningCommit: () => null });
	const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	return { clock, backend, ed, s };
}
const orderLive = (w: World, body: unknown, tab = TAB_A, person = aoife) => call<Answer>(handleCollectionOrder(request('/_caracms/collection-order', { tab, body }), w.ed.store, { person }));
const createLive = (w: World, body: unknown, tab = TAB_A, person = aoife) => call<CreateResponse & Answer>(handleCreate(request('/_caracms/create', { tab, body }), w.ed.store, { person }));
const poll = async (w: World, person: Person, tab: string) => (await call<StatusResponse>(w.ed.status(request('/_caracms/status', { tab }), person))).body;
async function type(w: World, collection: string, path: string, person: Person, tab: string, edit: (d: Record<string, unknown>) => void) {
	const opened = await w.ed.store.read(collection, path);
	const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
	edit(document);
	return call(w.ed.write(request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document } }), person));
}
const handNow = async (w: World) => handOrderOf((await w.ed.store.read('settings', 'site-settings')).text);
const listedLive = async (w: World) => (await w.ed.store.list()).filter((d) => d.collection === 'work').map((d) => d.path);

describe('live: POST /_caracms/collection-order (checks 4, 8)', () => {
	test('a drag takes the Site Settings lock, autosaves, lets it go, and the stamp changes for another person', async () => {
		const w = await world();
		try {
			const before = await poll(w, ciaran, TAB_C);
			const r = await orderLive(w, { collection: 'work', order: ['wheels', 'harbour'] });
			assert.deepEqual(r, { status: 200, body: { ok: true } });
			assert.deepEqual(await handNow(w), { work: ['wheels', 'harbour'] });
			assert.ok(await w.ed.autosaves.get(SITE_SETTINGS_FILE), 'an autosave, going out at the next Publish');
			const after = await poll(w, ciaran, TAB_C);
			assert.notEqual(after.pageOrderStamp, before.pageOrderStamp);
			assert.ok(after.waiting.some((x) => x.file === SITE_SETTINGS_FILE));
			assert.deepEqual(after.locks.filter((l) => !l.releasing), [], 'no lock kept');
			assert.deepEqual(await listedLive(w), ['wheels', 'harbour', 'art', 'mill']);
		} finally {
			w.s.cleanup();
		}
	});
	test('Publish commits the order, and the next person to look sees it (check 8)', async () => {
		const w = await world();
		try {
			const onMain = () => handOrderOf(w.backend.file('main', `starter/${SITE_SETTINGS_FILE}`)!);
			assert.equal(onMain(), undefined);
			assert.equal((await orderLive(w, { collection: 'work', order: ['wheels', 'harbour'] })).status, 200);
			assert.equal(onMain(), undefined, 'an autosave only, until Publish');
			const pub = await w.ed.publish(request('/_caracms/publish', { body: {} }), ciaran);
			assert.equal(pub.status, 200);
			assert.equal(((await pub.json()) as { result: string }).result, 'published');
			assert.deepEqual(onMain(), { work: ['wheels', 'harbour'] }, 'the order is on main');
			assert.deepEqual(await listedLive(w), ['wheels', 'harbour', 'art', 'mill']);
			assert.deepEqual((await poll(w, ciaran, TAB_C)).waiting, [], 'nothing left waiting');
		} finally {
			w.s.cleanup();
		}
	});
	test('Change address… keeps a renamed entry\'s place in live mode too (check 9)', async () => {
		const w = await world({ [SITE_SETTINGS_FILE]: withOrder({ work: ['wheels', 'mill', 'art'] }) });
		try {
			const r = await call<Answer>(handleMove(request('/_caracms/move', { tab: TAB_A, body: { collection: 'work', path: 'mill', to: 'mill-house' } }), w.ed.store, { person: aoife }));
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(await handNow(w), { work: ['wheels', 'mill-house', 'art'] });
			assert.deepEqual((await listedLive(w)).slice(0, 3), ['wheels', 'mill-house', 'art']);
		} finally {
			w.s.cleanup();
		}
	});
	test("someone else's lock on Site Settings refuses a drag, naming them and the collection", async () => {
		const w = await world();
		try {
			assert.equal((await type(w, 'settings', 'site-settings', ciaran, TAB_C, (d) => (d.title = 'Mine'))).status, 200);
			const r = await orderLive(w, { collection: 'work', order: ['wheels'] });
			assert.equal(r.status, 409, JSON.stringify(r.body));
			assert.equal(r.body.code, 'locked');
			assert.equal(r.body.error, "Ciarán is editing Site Settings, which holds the order of Work, so the order can't change until they're done.");
			assert.equal(await handNow(w), undefined);
		} finally {
			w.s.cleanup();
		}
	});
	test('a new entry goes first; made while someone else has Site Settings, it waits after the named ones, then takes first place once free (check 4)', async () => {
		const w = await world({ [SITE_SETTINGS_FILE]: withOrder({ work: ['wheels', 'mill', 'harbour', 'art'] }) });
		try {
			const made = await createLive(w, { collection: 'work', path: 'seaweed', title: 'Seaweed Baths' });
			assert.equal(made.status, 200, JSON.stringify(made.body));
			assert.equal(made.body.order, 'first');
			assert.deepEqual((await handNow(w))?.work.slice(0, 2), ['seaweed', 'wheels']);
		} finally {
			w.s.cleanup();
		}
		const v = await world({ [SITE_SETTINGS_FILE]: withOrder({ work: ['wheels', 'mill', 'harbour', 'art'] }) });
		try {
			assert.equal((await type(v, 'settings', 'site-settings', ciaran, TAB_C, (d) => (d.title = 'Mine'))).status, 200);
			const made = await createLive(v, { collection: 'work', path: 'seaweed', title: 'Seaweed Baths' });
			assert.equal(made.status, 200, JSON.stringify(made.body));
			assert.equal(made.body.order, 'waiting');
			assert.deepEqual(await listedLive(v), ['wheels', 'mill', 'harbour', 'art', 'seaweed'], 'after the named ones');
			// Ciarán finishes; the editor sends the new entry's place.
			const theirs = await v.ed.store.read('settings', 'site-settings');
			assert.equal((await call(v.ed.write(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-caracms-tab': TAB_C, 'x-caracms-release': '1' }, body: JSON.stringify({ file: theirs.entry.file, base: theirs.text, document: theirs.document }) }), ciaran))).status, 200);
			assert.equal((await orderLive(v, { collection: 'work', first: 'seaweed' })).status, 409, 'still theirs while their lock is let go');
			// The sweep commits their autosave (Site Settings goes at once), and the let-go lock drops.
			v.clock.t += 6_000;
			await v.ed.sweep.tick();
			const placed = await orderLive(v, { collection: 'work', first: 'seaweed' });
			assert.equal(placed.status, 200, JSON.stringify(placed.body));
			assert.deepEqual(await listedLive(v), ['seaweed', 'wheels', 'mill', 'harbour', 'art']);
			assert.equal(((await v.ed.store.read('settings', 'site-settings')).document as { title: string }).title, 'Mine', 'their change kept');
		} finally {
			v.s.cleanup();
		}
	});
	test("Site Settings that isn't JSON: the entry is made, no autosave of Site Settings, and create says its place wasn't kept", async () => {
		const w = await world({ [SITE_SETTINGS_FILE]: '{ not json' });
		try {
			const made = await createLive(w, { collection: 'work', path: 'seaweed', title: 'Seaweed Baths' });
			assert.equal(made.status, 200, JSON.stringify(made.body));
			assert.equal(made.body.order, 'unkept');
			assert.equal(made.body.orderError, UNKEPT_PLACE_MESSAGE);
			assert.equal(await w.ed.autosaves.get(SITE_SETTINGS_FILE), null, 'nothing written to Site Settings');
			assert.ok((await listedLive(w)).includes('seaweed'), 'the entry is made');
		} finally {
			w.s.cleanup();
		}
	});
});
