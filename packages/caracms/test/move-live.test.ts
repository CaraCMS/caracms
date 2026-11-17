// Pre-M7 item 8, live mode: changing an address lands as autosaves under the mover's
// locks and goes out in one Publish, headed "Visit (moved from /visit)". Someone else
// editing a document the move would change refuses the whole move, naming them.
// On the in-memory GitHub and Redis with a fake clock (never a real repo, M4 Decision 2).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SITE_SETTINGS_FILE } from '../src/config.ts';
import type { CreateDeleteRefusal, MoveResponse, StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import { parseMessage, type Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { parseRedirects } from '../src/redirects.ts';
import type { CreateSite } from './helpers/create-site.ts';
import { makeMoveSite } from './helpers/move-site.ts';
import { handleMove } from '../src/editor/server/move.ts';

const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const ORIGIN = 'http://site.test';
const TAB_A = 'tab-aoife-1';
const TAB_C = 'tab-ciaran-1';
const HOME = 'content/pages/index.json';
const VISIT = 'content/pages/visit.json';
const MOVED = 'content/pages/studio/visit.json';

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

let s: CreateSite;
before(() => {
	s = makeMoveSite({ repoPath: 'starter' });
});
after(() => s.cleanup());

interface World {
	clock: { t: number };
	backend: MemoryBackend;
	ed: LiveEditor;
}

async function world(): Promise<World> {
	const clock = { t: Date.parse('2026-10-17T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	backend.seed([...(await siteFiles(s.site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const rt = await createLiveRuntime({ site: s.site, settings, backend, redis: memoryRedis({ now: () => clock.t }), now: () => clock.t, log: () => {}, runningCommit: () => null });
	const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	return { clock, backend, ed };
}

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

const move = (w: World, body: Record<string, unknown>, tab = TAB_A, person = aoife) =>
	call<MoveResponse & CreateDeleteRefusal>(handleMove(request('/_caracms/move', { tab, body }), w.ed.store, { person }));
const create = (w: World, body: Record<string, unknown>) => call<CreateDeleteRefusal>(w.ed.create(request('/_caracms/create', { tab: TAB_A, body }), aoife));
const publish = (w: World) => call<{ result: string }>(w.ed.publish(request('/_caracms/publish', { body: {} }), aoife));
const poll = async (w: World, person: Person, tab: string) => (await call<StatusResponse>(w.ed.status(request('/_caracms/status', { tab }), person))).body;
const headMessage = (w: World, branch: 'main' | 'drafts') => w.backend.info(w.backend.refs.get(branch)!).message;
const repo = (file: string) => `starter/${file}`;

async function type(w: World, collection: string, path: string, person: Person, tab: string, edit: (d: Record<string, unknown>) => void) {
	const opened = await w.ed.store.read(collection, path);
	const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
	edit(document);
	return call(w.ed.write(request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document } }), person));
}

describe('live: a move is autosaves under the mover\'s locks, out in one Publish', () => {
	test('Visit to /studio/visit: listed at once, waiting as one move, published headed "Visit (moved from /visit)"', async () => {
		const w = await world();
		const r = await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.deepEqual(r.body.redirect, { from: '/visit', to: '/studio/visit' });
		const listed = (await w.ed.store.list()).filter((d) => d.collection === 'pages').map((d) => d.path);
		assert.ok(listed.includes('studio/visit') && !listed.includes('visit'), listed.join(', '));
		assert.match((await w.ed.store.read('pages', 'index')).text, /"href": "\/studio\/visit"/);

		const st = await poll(w, ciaran, TAB_C);
		const change = (file: string) => st.waiting.find((x) => x.file === file)?.change;
		// One entry for the move, on the new file, with its old address; the old file isn't listed.
		assert.equal(change(MOVED), 'new');
		assert.equal(st.waiting.find((x) => x.file === MOVED)?.movedFrom, '/visit');
		assert.equal(change(VISIT), undefined);
		assert.equal(change(HOME), 'changed');
		assert.equal(change(SITE_SETTINGS_FILE), 'changed');
		// Only the new address stays the mover's (the tab opens it next); the others drop once committed.
		assert.deepEqual(st.locks.map((l) => l.file).sort(), [HOME, MOVED, SITE_SETTINGS_FILE, VISIT].sort());

		assert.equal((await publish(w)).body.result, 'published');
		const head = headMessage(w, 'main');
		assert.match(head.split('\n')[0]!, /^Published: Visit \(moved from \/visit\), (Home, Site Settings|Site Settings, Home) — by Aoife$/);
		assert.deepEqual(parseMessage(head).publishedFiles.sort(), [HOME, MOVED, SITE_SETTINGS_FILE, VISIT].sort());
		// The editor's headline (the publish record) names the moved page once, as the commit does.
		const published = (await poll(w, ciaran, TAB_C)).publish.record!;
		assert.deepEqual(published.titles.filter((t) => t.startsWith('Visit')), ['Visit (moved from /visit)']);
		assert.equal(published.titles.length, 3, published.titles.join(', '));
		assert.equal(w.backend.file('main', repo(VISIT)), null);
		assert.match(w.backend.file('main', repo(MOVED))!, /"title": "Visit"/);
		assert.deepEqual(parseRedirects(JSON.parse(w.backend.file('main', repo(SITE_SETTINGS_FILE))!).redirects), [
			{ from: '/old-visit', to: '/studio/visit' },
			{ from: '/visit', to: '/studio/visit' },
		]);
		// The locks the move took are gone once committed (past the release grace), but the new address's, the mover's tab's.
		w.clock.t += 6_000;
		assert.deepEqual((await poll(w, ciaran, TAB_C)).locks.map((l) => l.file), [MOVED]);

		// Committed, its autosaves gone: the list's "Last edited" is still the move's time (its change records).
		const movedAt = Date.parse('2026-10-17T10:00:00Z');
		const edited = new Map((await w.ed.store.list()).map((d) => [d.file, d.mtimeMs]));
		assert.equal(edited.get(MOVED), movedAt);
		assert.equal(edited.get(HOME), movedAt);
	});

	test('a move that fails part way leaves nothing behind (no new page, no relinks, no redirect, no locks), and a retry lands', async () => {
		const w = await world();
		const putIf = w.ed.autosaves.putIf.bind(w.ed.autosaves);
		let writes = 0;
		w.ed.autosaves.putIf = async (read, autosave) => {
			if (++writes === 3) throw new Error('the store went away');
			return putIf(read, autosave);
		};
		const homeBefore = (await w.ed.store.read('pages', 'index')).text;
		const settingsBefore = (await w.ed.store.read('settings', 'site-settings')).text;
		const r = await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' });
		assert.equal(r.status, 500, JSON.stringify(r.body));
		assert.equal(writes, 3, 'two autosaves stored before the third failed');
		w.ed.autosaves.putIf = putIf;

		const listed = (await w.ed.store.list()).filter((d) => d.collection === 'pages').map((d) => d.path);
		assert.ok(listed.includes('visit') && !listed.includes('studio/visit'), listed.join(', '));
		assert.equal((await w.ed.store.read('pages', 'index')).text, homeBefore, 'Home unchanged');
		assert.equal((await w.ed.store.read('settings', 'site-settings')).text, settingsBefore, 'no redirect');
		for (const file of [MOVED, VISIT, HOME, SITE_SETTINGS_FILE]) assert.equal(await w.ed.autosaves.get(file), null, file);
		assert.equal((await poll(w, ciaran, TAB_C)).waiting.length, 0, 'nothing waiting');
		w.clock.t += 6_000;
		assert.deepEqual((await poll(w, ciaran, TAB_C)).locks, [], 'no locks held');

		const again = await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' });
		assert.equal(again.status, 200, JSON.stringify(again.body));
		assert.deepEqual(again.body.redirect, { from: '/visit', to: '/studio/visit' });
		const after = (await w.ed.store.list()).filter((d) => d.collection === 'pages').map((d) => d.path);
		assert.ok(after.includes('studio/visit') && !after.includes('visit'), after.join(', '));
	});

	test('someone editing a page that links to it: the whole move is refused, naming them, and nothing changes', async () => {
		const w = await world();
		assert.equal((await type(w, 'pages', 'index', ciaran, TAB_C, (d) => (d.title = 'Welcome'))).status, 200);
		const r = await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' });
		assert.equal(r.status, 409, JSON.stringify(r.body));
		assert.equal(r.body.code, 'locked');
		assert.equal(r.body.error, 'Ciarán is editing Welcome, which links to /visit, so the address can\'t change until they\'re done.');
		assert.ok((await w.ed.store.list()).some((d) => d.path === 'visit'));
		assert.equal((await w.ed.autosaves.get(VISIT)), null);
		// Nothing of Aoife's is left holding a lock past the release grace.
		w.clock.t += 6_000;
		assert.deepEqual((await poll(w, ciaran, TAB_C)).locks.filter((l) => l.person.email === aoife.email), []);
	});

	test('the mover\'s own lock in another tab moves to this one: the move goes ahead', async () => {
		const w = await world();
		assert.equal((await type(w, 'pages', 'index', aoife, 'tab-aoife-2', (d) => (d.title = 'Welcome'))).status, 200);
		const r = await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.match((await w.ed.store.read('pages', 'index')).text, /"title": "Welcome"[\s\S]*"href": "\/studio\/visit"/, 'the other tab\'s edit kept, the link rewritten');
	});

	test('a published page moved with "Leave a redirect" unticked: still one Moved entry, from /visit, with no redirect', async () => {
		const w = await world();
		const r = await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit', redirect: false });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.redirect, null);
		const moved = (await poll(w, ciaran, TAB_C)).waiting.find((x) => x.file === MOVED);
		assert.equal(moved?.movedFrom, '/visit');
		assert.equal(moved?.movedRedirect, false);
		assert.equal((await publish(w)).body.result, 'published');
		assert.match(headMessage(w, 'main').split('\n')[0]!, /^Published: Visit \(moved from \/visit\)/);
		assert.deepEqual(parseRedirects(JSON.parse(w.backend.file('main', repo(SITE_SETTINGS_FILE))!).redirects), [{ from: '/old-visit', to: '/studio/visit' }]);
	});

	test('a page made since the last Publish moves with no redirect: nobody has its old address', async () => {
		const w = await world();
		assert.equal((await create(w, { collection: 'pages', path: 'workshops', title: 'Workshops' })).status, 200);
		const r = await move(w, { collection: 'pages', path: 'workshops', to: 'studio/workshops' });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.redirect, null);
		const st = await poll(w, ciaran, TAB_C);
		assert.equal(st.waiting.find((x) => x.file === 'content/pages/workshops.json'), undefined, 'made and gone again: not waiting');
		assert.equal(st.waiting.find((x) => x.file === 'content/pages/studio/workshops.json')?.change, 'new');
		assert.equal(st.waiting.find((x) => x.file === SITE_SETTINGS_FILE), undefined, 'Site Settings unchanged');
	});

	test('the redirect taken out of Site Settings: still one "Moved" entry, published with one headline item; put back, the same', async () => {
		const w = await world();
		assert.equal((await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' })).status, 200);
		const moved = async () => {
			const st = await poll(w, ciaran, TAB_C);
			return { entry: st.waiting.find((x) => x.file === MOVED), old: st.waiting.find((x) => x.file === VISIT) };
		};
		let now = await moved();
		assert.equal(now.entry?.movedFrom, '/visit');
		assert.equal(now.entry?.movedRedirect, true);
		assert.equal(now.old, undefined);

		const redirects = (d: Record<string, unknown>) => (d.data as Record<string, unknown>).redirects as { from: string; to: string }[];
		let kept: { from: string; to: string }[] = [];
		assert.equal((await type(w, 'settings', 'site-settings', aoife, TAB_A, (d) => {
			kept = redirects(d);
			(d.data as Record<string, unknown>).redirects = kept.filter((r) => r.from !== '/visit');
		})).status, 200);
		now = await moved();
		assert.equal(now.entry?.movedFrom, '/visit', 'still a move');
		assert.equal(now.entry?.movedRedirect, false, 'with no redirect from its old address');
		assert.equal(now.old, undefined, 'the old file isn\'t a deletion of its own');

		// Put back, as it was: the same one entry, redirect and all.
		assert.equal((await type(w, 'settings', 'site-settings', aoife, TAB_A, (d) => ((d.data as Record<string, unknown>).redirects = kept))).status, 200);
		now = await moved();
		assert.equal(now.entry?.movedRedirect, true);
		assert.equal(now.old, undefined);

		// Out again, then Publish: one headline item for the move, and no redirect goes live.
		assert.equal((await type(w, 'settings', 'site-settings', aoife, TAB_A, (d) => ((d.data as Record<string, unknown>).redirects = kept.filter((r) => r.from !== '/visit')))).status, 200);
		assert.equal((await publish(w)).body.result, 'published');
		const head = headMessage(w, 'main').split('\n')[0]!;
		assert.match(head, /^Published: Visit \(moved from \/visit\), (Home, Site Settings|Site Settings, Home) — by Aoife$/);
		assert.deepEqual((await poll(w, ciaran, TAB_C)).publish.record!.titles.filter((t) => t.startsWith('Visit')), ['Visit (moved from /visit)']);
		assert.ok(!parseRedirects(JSON.parse(w.backend.file('main', repo(SITE_SETTINGS_FILE))!).redirects).some((r) => r.from === '/visit'));
		// Published: the move is done with.
		assert.deepEqual([...(await w.ed.autosaves.moves())], []);
	});

	// The walk at 0dff408: the redirect removed from Site Settings as opened over the move's
	// uncommitted autosave, then put back with ⌘Z. The editor's base is that autosave's text,
	// which `drafts` never had, so it can't be the merge's ancestor. Every order of sweep ticks.
	for (let ticks = 0; ticks < 8; ticks++) {
		const at = (n: number) => (ticks & (1 << n)) !== 0;
		test(`the redirect removed (Site Settings as on main) and put back, against the text opened after the move: kept for good (sweep after the move ${at(0)}, the removal ${at(1)}, the undo ${at(2)})`, async () => {
			const w = await world();
			const main = w.backend.file('main', repo(SITE_SETTINGS_FILE))!;
			assert.equal((await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' })).status, 200);
			if (at(0)) await w.ed.sweep.tick();
			const opened = await w.ed.store.read('settings', 'site-settings');
			const withRedirect = structuredClone(opened.document) as unknown as Record<string, unknown>;
			const asOnMain = structuredClone(withRedirect);
			(asOnMain.data as Record<string, unknown>).redirects = parseRedirects(JSON.parse(main).redirects);
			const write = async (document: unknown) =>
				assert.equal((await call(w.ed.write(request('/_caracms/write', { tab: TAB_A, body: { file: SITE_SETTINGS_FILE, base: opened.text, document } }), aoife))).status, 200);
			await write(asOnMain);
			if (at(1)) await w.ed.sweep.tick();
			await write(withRedirect);
			if (at(2)) await w.ed.sweep.tick();
			await w.ed.sweep.tick();
			const drafts = w.backend.file('drafts', repo(SITE_SETTINGS_FILE))!;
			assert.ok(parseRedirects(JSON.parse(drafts).redirects).some((r) => r.from === '/visit' && r.to === '/studio/visit'), `the redirect is in drafts:\n${drafts}`);
			const st = await poll(w, ciaran, TAB_C);
			assert.ok(st.waiting.some((x) => x.file === SITE_SETTINGS_FILE), 'Site Settings is waiting');
			assert.equal(st.waiting.find((x) => x.file === MOVED)?.movedRedirect, true);
		});
	}

	test('any Site Settings edit: reopened over its own uncommitted autosave, set back as on main, then undone: kept', async () => {
		const w = await world();
		await type(w, 'settings', 'site-settings', aoife, TAB_A, (d) => ((d.data as Record<string, unknown>).editors = ['niamh@example.com']));
		const opened = await w.ed.store.read('settings', 'site-settings'); // over the autosave, as a reload opens it
		const edited = structuredClone(opened.document) as unknown as Record<string, unknown>;
		const asOnMain = structuredClone(edited);
		(asOnMain.data as Record<string, unknown>).editors = [];
		for (const document of [asOnMain, edited]) {
			assert.equal((await call(w.ed.write(request('/_caracms/write', { tab: TAB_A, body: { file: SITE_SETTINGS_FILE, base: opened.text, document } }), aoife))).status, 200);
		}
		await w.ed.sweep.tick();
		assert.deepEqual((JSON.parse(w.backend.file('drafts', repo(SITE_SETTINGS_FILE))!) as { editors: string[] }).editors, ['niamh@example.com']);
	});

	test('moved back to where it was: no move waiting, nothing recorded', async () => {
		const w = await world();
		assert.equal((await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' })).status, 200);
		assert.deepEqual([...(await w.ed.autosaves.moves())], [[VISIT, MOVED]]);
		const back = await move(w, { collection: 'pages', path: 'studio/visit', to: 'visit' });
		assert.equal(back.status, 200, JSON.stringify(back.body));
		assert.deepEqual([...(await w.ed.autosaves.moves())], []);
		const st = await poll(w, ciaran, TAB_C);
		assert.ok(!st.waiting.some((x) => x.movedFrom), JSON.stringify(st.waiting.map((x) => [x.file, x.change])));
	});

	test('a new page made at an address that redirected takes the redirect out of Site Settings, as a draft', async () => {
		const w = await world();
		assert.equal((await create(w, { collection: 'pages', path: 'old-visit', title: 'Old visit' })).status, 200);
		const settingsNow = (await w.ed.store.read('settings', 'site-settings')).text;
		assert.deepEqual(parseRedirects(JSON.parse(settingsNow).redirects), [{ from: '/studio/visit', to: '/elsewhere' }]);
		assert.equal((await poll(w, ciaran, TAB_C)).waiting.find((x) => x.file === SITE_SETTINGS_FILE)?.change, 'changed');
	});
});
