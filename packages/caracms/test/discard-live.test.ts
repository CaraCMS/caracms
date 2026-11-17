// Discard changes, live mode: one waiting document back to what's live. An edited one reads
// as `main` has it again, committed or not; a new one is removed; a deleted one comes back; a
// moved one goes back to its old address with its links. Under the sweep's locks, so a tick
// can't commit the discarded edit; another tab that had it can't bring it back (its writes are
// refused until it lets go, and its browser's held copy is dropped by the keeper's rule).
// On the in-memory GitHub and Redis with a fake clock (never a real repo, M4 Decision 2).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SITE_SETTINGS_FILE } from '../src/config.ts';
import type { DiscardResponse, MoveResponse, StatusResponse } from '../src/editor/types.ts';
import { handleMove } from '../src/editor/server/move.ts';
import { fileVersion } from '../src/editor/server/write.ts';
import { createKeeper, verdict } from '../src/editor/client/state/keeper.ts';
import { discardWording } from '../src/editor/client/documents/actions.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import { parseMessage, type Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis, type MemoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import type { CreateSite } from './helpers/create-site.ts';
import { makeMoveSite } from './helpers/move-site.ts';

const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const ORIGIN = 'http://site.test';
const SEC = 1000;
const TAB_A = 'tab-aoife-1';
const TAB_A2 = 'tab-aoife-2';
const TAB_C = 'tab-ciaran-1';
const ABOUT = 'content/pages/about.json';
const HOME = 'content/pages/index.json';
const VISIT = 'content/pages/visit.json';
const MOVED = 'content/pages/studio/visit.json';
const NEWS = 'content/pages/news.json';

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
	redis: MemoryRedis;
	ed: LiveEditor;
}

async function world(): Promise<World> {
	const clock = { t: Date.parse('2026-10-27T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	const redis = memoryRedis({ now: () => clock.t });
	backend.seed([...(await siteFiles(s.site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const rt = await createLiveRuntime({ site: s.site, settings, backend, redis, now: () => clock.t, log: () => {}, runningCommit: () => null });
	const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	return { clock, backend, redis, ed };
}

function request(path: string, init: { tab?: string | null; body?: unknown; method?: string; origin?: string; raw?: string } = {}) {
	const headers: Record<string, string> = { origin: init.origin ?? ORIGIN };
	if (init.tab) headers['x-caracms-tab'] = init.tab;
	if (init.body !== undefined || init.raw !== undefined) headers['content-type'] = 'application/json';
	const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
	return new Request(`${ORIGIN}${path}`, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
}

async function call<T = Record<string, unknown>>(res: Promise<Response>): Promise<{ status: number; body: T }> {
	const r = await res;
	return { status: r.status, body: (await r.json()) as T };
}

const discard = (w: World, file: string, person: Person | null = aoife, tab: string | null = TAB_A) =>
	call<DiscardResponse & { error?: string; code?: string }>(w.ed.discard(request('/_caracms/discard', { tab, body: { file } }), person));
const seen = (w: World, file: string, person: Person, tab: string) => call(w.ed.discard(request('/_caracms/discard', { tab, body: { file, seen: true } }), person));
const create = (w: World, body: Record<string, unknown>, person = aoife, tab = TAB_A) => call(w.ed.create(request('/_caracms/create', { tab, body }), person));
const remove = (w: World, body: Record<string, unknown>, person = aoife, tab = TAB_A) => call(w.ed.delete(request('/_caracms/delete', { tab, body }), person));
const move = (w: World, body: Record<string, unknown>, tab = TAB_A, person = aoife) => call<MoveResponse>(handleMove(request('/_caracms/move', { tab, body }), w.ed.store, { person }));
const repo = (file: string) => `starter/${file}`;
const headMessage = (w: World, branch: 'main' | 'drafts') => w.backend.info(w.backend.refs.get(branch)!).message;

async function poll(w: World, person: Person, tab: string, file: string | null = null): Promise<StatusResponse> {
	// Past the status cache's 30 s, so what the poll reads is Redis as it is now.
	const r = await call<StatusResponse>(w.ed.status(request(`/_caracms/status${file ? `?file=${encodeURIComponent(file)}` : ''}`, { tab }), person));
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return r.body;
}

/** A write from a tab: the document as the store opens it now (or `base` given), changed by `edit`. */
async function type(w: World, person: Person, tab: string, collection: string, path: string, edit: (d: Record<string, unknown>) => void, from?: { text: string; document: unknown }) {
	const opened = from ?? (await w.ed.store.read(collection, path));
	const document = structuredClone(opened.document) as Record<string, unknown>;
	edit(document);
	const file = (await w.ed.store.read(collection, path).catch(() => null))?.entry.file ?? `content/${collection}/${path}.json`;
	return call<{ error?: string; code?: string }>(w.ed.write(request('/_caracms/write', { tab, body: { file, base: opened.text, document } }), person));
}

async function sweep(w: World) {
	w.clock.t += 61 * SEC;
	return w.ed.sweep.tick();
}

describe('Discard changes, live mode', () => {
	test('an edit not committed yet: the autosave goes, the document reads as live, nothing waits', async () => {
		const w = await world();
		const live = w.backend.file('main', repo(ABOUT));
		assert.equal((await type(w, aoife, TAB_A, 'pages', 'about', (d) => (d.title = 'About us'))).status, 200);
		assert.ok((await poll(w, aoife, TAB_A)).waiting.some((x) => x.file === ABOUT));
		const draftsBefore = w.backend.refs.get('drafts');

		const r = await discard(w, ABOUT);
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.deepEqual({ ...r.body, files: [...r.body.files] }, { ok: true, file: ABOUT, change: 'changed', files: [ABOUT], movedBack: null });
		assert.equal(await w.ed.autosaves.get(ABOUT), null);
		assert.equal((await w.ed.store.read('pages', 'about')).text, live);
		assert.equal(w.backend.refs.get('drafts'), draftsBefore, 'drafts already matched main: no commit');
		assert.equal((await poll(w, aoife, TAB_A)).waiting.some((x) => x.file === ABOUT), false);
		// The sweep has nothing to commit afterwards.
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(ABOUT)), live);
	});

	test('an edit already committed to drafts: drafts gets the live file back in a "Discarded:" commit, and the committed record goes', async () => {
		const w = await world();
		const live = w.backend.file('main', repo(ABOUT));
		await type(w, ciaran, TAB_C, 'pages', 'about', (d) => (d.title = 'About CaraCMS'));
		await sweep(w);
		assert.notEqual(w.backend.file('drafts', repo(ABOUT)), live);
		assert.ok(await w.ed.autosaves.committed(ABOUT));
		const before = await poll(w, aoife, TAB_A);
		assert.deepEqual(before.waiting.find((x) => x.file === ABOUT)?.editors.map((e) => e.person.email), [ciaran.email]);

		w.clock.t += 120 * SEC; // Ciarán's tab has gone quiet: his lock only held until the commit
		const r = await discard(w, ABOUT);
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(w.backend.file('drafts', repo(ABOUT)), live);
		const msg = parseMessage(headMessage(w, 'drafts'));
		assert.equal(msg.kind, 'discard');
		assert.deepEqual(msg.discardedFiles, [ABOUT]);
		assert.match(headMessage(w, 'drafts').split('\n')[0]!, /^Discarded: About CaraCMS — by Aoife$/);
		assert.equal(await w.ed.autosaves.committed(ABOUT), null);
		const after = await poll(w, aoife, TAB_A);
		assert.equal(after.waiting.some((x) => x.file === ABOUT), false);
		// Ciarán is told, by name and document.
		const notice = (await poll(w, ciaran, TAB_C)).notices.find((n) => n.kind === 'discarded');
		assert.ok(notice && notice.kind === 'discarded');
		assert.equal(notice.by.email, aoife.email);
		assert.equal(notice.file, ABOUT);
		assert.equal((await poll(w, aoife, TAB_A)).notices.some((n) => n.kind === 'discarded'), false, 'not the person who discarded it');
		const dismissed = await call(w.ed.notice(request('/_caracms/notice', { body: { id: notice.id } }), ciaran));
		assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
		assert.equal((await poll(w, ciaran, TAB_C)).notices.some((n) => n.kind === 'discarded'), false);
		// Nothing left to publish.
		assert.equal((await call<{ result: string }>(w.ed.publish(request('/_caracms/publish', { body: {} }), aoife))).body.result, 'nothing-waiting');
	});

	test('a new page, committed or not, is removed; a deleted one comes back', async () => {
		const w = await world();
		assert.equal((await create(w, { collection: 'pages', path: 'news', title: 'News' })).status, 200);
		await sweep(w);
		assert.ok(w.backend.file('drafts', repo(NEWS)));
		const st = await poll(w, aoife, TAB_A);
		assert.equal(st.waiting.find((x) => x.file === NEWS)?.change, 'new');
		const r = await discard(w, NEWS);
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.change, 'new');
		assert.equal(w.backend.file('drafts', repo(NEWS)), null);
		assert.equal((await w.ed.store.list()).some((d) => d.file === NEWS), false);
		assert.equal((await poll(w, aoife, TAB_A)).waiting.some((x) => x.file === NEWS), false);

		// Deleted (uncommitted): it comes back as it is live.
		assert.equal((await remove(w, { collection: 'pages', path: 'about' })).status, 200);
		assert.equal((await poll(w, aoife, TAB_A)).waiting.find((x) => x.file === ABOUT)?.change, 'deleted');
		const back = await discard(w, ABOUT);
		assert.equal(back.status, 200, JSON.stringify(back.body));
		assert.equal(back.body.change, 'deleted');
		assert.equal((await w.ed.store.read('pages', 'about')).text, w.backend.file('main', repo(ABOUT)));
		assert.equal((await poll(w, aoife, TAB_A)).waiting.length, 0);
	});

	test('a moved page goes back to its old address, its links with it, and the move record goes', async () => {
		const w = await world();
		const liveVisit = w.backend.file('main', repo(VISIT));
		const liveHome = w.backend.file('main', repo(HOME));
		const r0 = await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' });
		assert.equal(r0.status, 200, JSON.stringify(r0.body));
		await sweep(w);
		w.clock.t += 120 * SEC;
		const st = await poll(w, aoife, TAB_A);
		assert.equal(st.waiting.find((x) => x.file === MOVED)?.movedFrom, '/visit');

		const r = await discard(w, MOVED);
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.deepEqual(r.body.movedBack, { collection: 'pages', path: 'visit', file: VISIT });
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(VISIT)), liveVisit);
		assert.equal(w.backend.file('drafts', repo(MOVED)), null);
		assert.equal(w.backend.file('drafts', repo(HOME)), liveHome, 'Home links to /visit again');
		assert.equal((await w.ed.autosaves.moves()).size, 0);
		const after = await poll(w, aoife, TAB_A);
		const files = after.waiting.map((x) => x.file);
		// Site Settings too: the move's redirect goes, and the one it took out (from /studio/visit) is back.
		assert.deepEqual(files, [], files.join(', '));
		assert.equal(w.backend.file('drafts', repo(SITE_SETTINGS_FILE)), w.backend.file('main', repo(SITE_SETTINGS_FILE)));
		assert.equal(after.locks.length, 0, JSON.stringify(after.locks));
	});

	test('a sweep racing the discard can\'t commit the edit back', async () => {
		const w = await world();
		const live = w.backend.file('main', repo(ABOUT));
		await type(w, aoife, TAB_A, 'pages', 'about', (d) => (d.title = 'Racing'));
		w.clock.t += 61 * SEC; // ready for the tick
		const [r] = await Promise.all([discard(w, ABOUT), w.ed.sweep.tick(), w.ed.sweep.commitAll()]);
		assert.equal(r.status, 200, JSON.stringify(r.body));
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(ABOUT)), live);
		assert.equal(await w.ed.autosaves.get(ABOUT), null);
		assert.equal((await poll(w, aoife, TAB_A)).waiting.some((x) => x.file === ABOUT), false);
	});

	test('another server holding the sweep\'s lock throughout: refused as busy, nothing changed', async () => {
		const w = await world();
		await type(w, aoife, TAB_A, 'pages', 'about', (d) => (d.title = 'Held'));
		await w.redis.set('caracms:sweep:lock', 'other-server', { px: 60_000 });
		const r = await discard(w, ABOUT);
		assert.equal(r.status, 409);
		assert.equal(r.body.code, 'busy');
		assert.ok(await w.ed.autosaves.get(ABOUT), 'the edit is still there');
	});

	test('another tab\'s copy can\'t bring it back: its write is refused, its poll says so, and once it lets go it writes again', async () => {
		const w = await world();
		const live = w.backend.file('main', repo(ABOUT));
		// Aoife's second tab edits About from the live text (the hard case: its base is what goes back).
		const opened = await w.ed.store.read('pages', 'about');
		await type(w, aoife, TAB_A2, 'pages', 'about', (d) => (d.title = 'Second tab'), opened);
		await poll(w, aoife, TAB_A2, ABOUT);
		await sweep(w);
		w.clock.t += 120 * SEC;
		const r = await discard(w, ABOUT);
		assert.equal(r.status, 200, JSON.stringify(r.body));

		// Its next write, on the same old base, is refused: nothing comes back.
		const late = await type(w, aoife, TAB_A2, 'pages', 'about', (d) => (d.title = 'Second tab, again'), opened);
		assert.equal(late.status, 409);
		assert.equal(late.body.code, 'discarded');
		assert.match(late.body.error!, /^Aoife discarded the unpublished changes to About, so these edits weren't kept\.$/);
		assert.equal(await w.ed.autosaves.get(ABOUT), null);
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(ABOUT)), live);

		// Its poll says it was discarded; the document reads as live, with the discard in lastChange.
		const st = await poll(w, aoife, TAB_A2, ABOUT);
		assert.equal(st.open?.discarded?.by.email, aoife.email);
		assert.equal(st.open?.lastChange.discarded?.by.email, aoife.email);
		const now = await w.ed.store.read('pages', 'about');
		assert.equal(now.text, live);
		// A browser's held copy from before the discard is dropped, not re-sent (keeper.ts → verdict).
		const stored = { base: opened.text, document: { ...opened.document, title: 'Held in a browser' }, fileVersion: 'older', at: Date.parse('2026-10-27T09:00:00Z') };
		assert.equal(verdict(stored, now, s.site, aoife), 'drop');
		assert.equal(verdict({ ...stored, at: undefined }, now, s.site, aoife), 'drop', 'a copy with no time is from before');
		assert.equal(verdict({ ...stored, at: w.clock.t + 60 * SEC }, now, s.site, aoife), 'send', 'one made since is yours to send');

		// It lets go: its poll is quiet, and a write from the fresh copy is taken.
		assert.equal((await seen(w, ABOUT, aoife, TAB_A2)).status, 200);
		assert.equal((await poll(w, aoife, TAB_A2, ABOUT)).open?.discarded, null);
		const fresh = await type(w, aoife, TAB_A2, 'pages', 'about', (d) => (d.title = 'After'));
		assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
		assert.equal((await w.ed.autosaves.changed(ABOUT))?.version, fileVersion((await w.ed.store.read('pages', 'about')).text));
	});

	test('the route: signed in, same origin, POST JSON with a tab, a waiting document, nobody editing it now, no Publish running', async () => {
		const w = await world();
		await type(w, aoife, TAB_A, 'pages', 'about', (d) => (d.title = 'Edited'));
		const send = (init: Parameters<typeof request>[1], person: Person | null = aoife) => call<{ error?: string; code?: string }>(w.ed.discard(request('/_caracms/discard', init), person));
		assert.equal((await send({ tab: TAB_A, body: { file: ABOUT } }, null)).status, 401);
		assert.equal((await send({ tab: TAB_A, body: { file: ABOUT }, origin: 'https://elsewhere.test' })).status, 403);
		assert.equal((await send({ tab: TAB_A, method: 'GET' })).status, 405);
		assert.equal((await send({ body: { file: ABOUT } })).body.code, 'no-tab');
		assert.equal((await send({ tab: TAB_A, body: { file: ABOUT, also: 1 } })).body.code, 'bad-request');
		assert.equal((await send({ tab: TAB_A, body: { file: 7 } })).status, 400);
		assert.equal((await send({ tab: TAB_A, raw: '[1]' })).status, 400);
		assert.equal((await send({ tab: TAB_A, body: { file: '../../etc/passwd.json' } })).status, 400);
		assert.equal((await send({ tab: TAB_A, body: { file: 'src/Page.astro' } })).status, 400);
		assert.equal((await send({ tab: TAB_A, raw: JSON.stringify({ file: ABOUT, pad: 'x'.repeat(20_000) }) })).status, 413);
		const none = await send({ tab: TAB_A, body: { file: HOME } });
		assert.equal(none.status, 404);
		assert.equal(none.body.code, 'not-waiting');
		assert.equal(none.body.error, 'Home has no unpublished changes.');

		// Someone else editing it now (a fresh lock).
		await type(w, ciaran, TAB_C, 'pages', 'index', (d) => (d.title = 'Ciarán\'s home'));
		const locked = await send({ tab: TAB_A, body: { file: HOME } });
		assert.equal(locked.status, 409);
		assert.equal(locked.body.code, 'locked');
		assert.equal(locked.body.error, "Ciarán is editing Ciarán's home right now, so its changes can't be discarded yet.");

		// A Publish running.
		await w.redis.set('caracms:publish:lock', 'someone', { px: 60_000 });
		const publishing = await send({ tab: TAB_A, body: { file: ABOUT } });
		assert.equal(publishing.status, 409);
		assert.equal(publishing.body.code, 'publishing');
		await w.redis.del('caracms:publish:lock');
		assert.equal((await send({ tab: TAB_A, body: { file: ABOUT } })).status, 200);
	});

	test('a moved page edited after its move goes back fully: old address, live text', async () => {
		const w = await world();
		const liveVisit = w.backend.file('main', repo(VISIT));
		assert.equal((await move(w, { collection: 'pages', path: 'visit', to: 'studio/visit' })).status, 200);
		assert.equal((await type(w, aoife, TAB_A, 'pages', 'studio/visit', (d) => (d.title = 'Visit the studio'))).status, 200);
		await sweep(w);
		const r = await discard(w, MOVED);
		assert.equal(r.status, 200, JSON.stringify(r.body));
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(VISIT)), liveVisit);
		assert.equal(w.backend.file('drafts', repo(MOVED)), null);
		assert.deepEqual((await poll(w, aoife, TAB_A)).waiting.map((x) => x.file), []);
	});

	test('the keeper: a write refused as discarded drops the edits (tab and browser) and tells the editor', async () => {
		const map = new Map<string, string>();
		const storage = { get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
		const told: string[] = [];
		const keeper = createKeeper({
			site: s.site,
			storage,
			storageKey: 'site',
			setTimer: (fn) => (fn(), 0),
			clearTimer: () => {},
			log: () => {},
			tab: 'tab-1',
			retryDelays: [3000],
			you: () => aoife,
			holds: () => false,
			onDiscarded: (file, body) => told.push(`${file}:${body.by?.email}`),
			fetch: (async () => new Response(JSON.stringify({ error: 'Ciarán discarded the unpublished changes to About, so these edits weren\'t kept.', code: 'discarded', by: ciaran, at: '2026-10-27T10:00:00Z' }), { status: 409 })) as typeof fetch,
		});
		const opened = await (await world()).ed.store.read('pages', 'about');
		keeper.opened('pages/about', ABOUT, opened.version);
		keeper.change('pages/about', { file: ABOUT, base: opened.text, document: { ...opened.document, title: 'Gone' } });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(told, [`${ABOUT}:${ciaran.email}`]);
		assert.equal(map.size, 0, 'nothing held in the browser');
		assert.equal(keeper.dirty('pages/about'), false);
		assert.equal(keeper.status.get().state, 'kept');
	});

	test('the wording names other people whose changes go too', () => {
		const ann: Person = { email: 'ann@example.com', name: 'Ann' };
		const at = '2026-10-27T10:00:00Z';
		const mine = discardWording({ title: 'About', change: 'changed', editors: [{ person: aoife, at }] }, aoife, 'page');
		assert.deepEqual(mine, { heading: 'Discard the unpublished changes to About?', body: "It goes back to what's live.", confirm: 'Discard changes', menu: 'Discard changes…' });
		assert.equal(discardWording({ title: 'About', change: 'changed', editors: [{ person: aoife, at }, { person: ann, at }] }, aoife, 'page').heading, "Discard the unpublished changes to About, including Ann's?");
		const fresh = discardWording({ title: 'News', change: 'new', editors: [{ person: ann, at }, { person: ciaran, at }] }, aoife, 'page');
		assert.equal(fresh.heading, "Discard this new page, including Ann's and Ciarán's changes?");
		assert.equal(fresh.confirm, 'Discard this new page');
		assert.equal(discardWording({ title: 'Visit', change: 'new', editors: [], movedFrom: '/visit' }, aoife, 'page').heading, 'Discard the unpublished changes to Visit?', 'a move waits as new on its new file');
		assert.equal(discardWording({ title: 'Visit', change: 'changed', editors: [], movedFrom: '/visit' }, aoife, 'page').body, 'It goes back to /visit, as it is on the live site.');
	});
});

