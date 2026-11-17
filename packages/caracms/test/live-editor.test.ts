// Live mode's editor server (M4 Phase 2 → Verify 1–6): the live drafts store, the
// sweep, locks and presence, the status route and Decision 11's "who last changed it".
// On the in-memory GitHub, the Redis stand-in and a fake clock; the sweep's timer is
// driven by hand.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import { parseDocumentText, type SiteDocument } from '../src/document.ts';
import { createKeeper, verdict, type KeeperStorage } from '../src/editor/client/state/keeper.ts';
import type { LockRefusal, OpenedDocument, StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import { parseMessage } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { connectRedis, memoryRedis, RedisUnavailableError, type MemoryRedis, type RedisClient } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { siteRoot, variant } from './helpers/site.ts';

const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const HOME = 'content/pages/index.json';
const ABOUT = 'content/pages/about.json';
const ORIGIN = 'http://site.test';
const SEC = 1000;
const MIN = 60 * SEC;

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
	redis: MemoryRedis;
	timers: { fn: () => void; ms: number }[];
}

function world(): World {
	const clock = { t: Date.parse('2026-10-14T10:00:00Z') };
	return { clock, backend: new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t }), redis: memoryRedis({ now: () => clock.t }), timers: [] };
}

/** A server: a runtime and its live editor on the shared backend and Redis (two of these are a deploy). */
async function server(w: World, options: { redis?: RedisClient; seed?: boolean } = {}): Promise<LiveEditor> {
	if (options.seed !== false && !w.backend.refs.has('main')) w.backend.seed([...(await siteFiles(site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const now = () => w.clock.t;
	const rt = await createLiveRuntime({ site, settings, backend: w.backend, redis: options.redis ?? w.redis, now, log: () => {}, runningCommit: () => null });
	return createLiveEditor(rt, {
		log: () => {},
		sleep: async () => {},
		schedule: (fn, ms) => {
			const timer = { fn, ms };
			w.timers.push(timer);
			return () => {
				const i = w.timers.indexOf(timer);
				if (i !== -1) w.timers.splice(i, 1);
			};
		},
	});
}

const clone = (d: SiteDocument): SiteDocument => JSON.parse(JSON.stringify(d));

async function open(ed: LiveEditor, path = 'index'): Promise<OpenedDocument> {
	return (await ed.store.read('pages', path)) as OpenedDocument;
}

function request(path: string, init: { method?: string; tab?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
	const headers: Record<string, string> = { origin: ORIGIN, ...init.headers };
	if (init.tab) headers['x-caracms-tab'] = init.tab;
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return new Request(`${ORIGIN}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

/** A write from a tab: the document as opened, changed by `edit`, against the base it was opened with. */
async function write(ed: LiveEditor, person: Person, tab: string, opened: OpenedDocument, edit: (d: SiteDocument) => void, options: { release?: boolean } = {}) {
	const document = clone(opened.document);
	edit(document);
	const res = await ed.write(
		request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document }, headers: options.release ? { 'x-caracms-release': '1' } : {} }),
		person,
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function poll(ed: LiveEditor, person: Person, tab: string, file: string | null = HOME): Promise<StatusResponse> {
	const res = await ed.status(request(`/_caracms/status${file ? `?file=${encodeURIComponent(file)}` : ''}`, { tab }), person);
	assert.equal(res.status, 200, await res.clone().text());
	return (await res.json()) as StatusResponse;
}

const drafts = (w: World, file = HOME) => JSON.parse(w.backend.file('drafts', `starter/${file}`)!);
const head = (w: World) => w.backend.refs.get('drafts')!;
/** Draft commits on drafts since `from`, newest first. */
function commitsSince(w: World, from: string): string[] {
	const out: string[] = [];
	for (let c = head(w); c && c !== from; c = w.backend.info(c).parents[0]!) out.push(c);
	return out;
}
const intro = (d: SiteDocument) => d.blocks[0]!.data.intro;
const setIntro = (text: string) => (d: SiteDocument) => {
	d.blocks[0]!.data.intro = text;
};

describe('the live drafts store (Decision 4)', () => {
	test('a write is the autosave: Kept at once; the document route reads it back with its version and who changed it', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		assert.deepEqual(opened.lastChange, { by: null, version: null, at: null, known: false }, 'never changed here: the server can\'t tell who last changed it');
		const r = await write(ed, aoife, 'tab-aoife-1', opened, setIntro('Kept on the server'));
		assert.equal(r.status, 200);
		assert.equal(r.body.ok, true);
		assert.equal(JSON.parse(w.backend.file('drafts', `starter/${HOME}`)!).blocks[0].intro, JSON.parse(opened.text).blocks[0].intro, 'nothing reached git yet');
		const again = await open(ed);
		assert.equal(intro(again.document), 'Kept on the server');
		assert.equal(again.version, r.body.version, 'the version the keeper compares with');
		assert.deepEqual(again.lastChange!.by, aoife);
		assert.equal(again.lastChange!.version, r.body.version);
		const listed = (await ed.store.list()).find((d) => d.file === HOME)!;
		assert.equal(typeof listed.mtimeMs, 'number');
		// caracms-cloud adversarial review, finding 4: an edit that hasn't reached GitHub never expires (live-hostile-world.test.ts).
		assert.equal(await w.redis.pttl(`caracms:autosave:${HOME}`), -1, 'no expiry until it\'s committed');
	});

	test('the path rules stay; existence is checked against the copy; no tab, no person', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		const send = async (file: string, person: Person | null = aoife, tab: string | null = 'tab-aoife-1') => {
			const res = await ed.write(request('/_caracms/write', { tab, body: { file, base: opened.text, document: opened.document } }), person);
			return { status: res.status, body: (await res.json()) as { error: string; code?: string } };
		};
		assert.equal((await send('../x.json')).status, 400);
		assert.equal((await send('src/Page.astro')).status, 400);
		const gone = await send('content/pages/no-such-page.json');
		assert.equal(gone.status, 404);
		assert.doesNotMatch(gone.body.error, /dev server/);
		assert.deepEqual(await send(HOME, null), { status: 401, body: { error: 'signed-out', code: 'signed-out' } });
		assert.equal((await send(HOME, aoife, null)).body.code, 'no-tab');
		const cross = await ed.write(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json', 'x-caracms-tab': 'tab-aoife-1' }, body: '{}' }), aoife);
		assert.equal(cross.status, 403);
		assert.doesNotMatch(((await cross.json()) as { error: string }).error, /dev server/);
	});
});

describe('the sweep (Decisions 5 and 6; Verify 1)', () => {
	test('an autosave is committed after a minute idle, not before', async () => {
		const w = world();
		const ed = await server(w);
		const before = head(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Idle a minute'));
		assert.equal(ed.sweep.active, true);
		assert.equal(w.timers.length, 1);
		w.clock.t += 30 * SEC;
		await ed.sweep.tick();
		assert.equal(head(w), before, 'not idle long enough');
		w.clock.t += 31 * SEC;
		const r = await ed.sweep.tick();
		assert.ok(r.commit);
		assert.equal(drafts(w).blocks[0].intro, 'Idle a minute');
		const message = parseMessage(w.backend.info(head(w)).message);
		assert.deepEqual(message.edits, [{ person: aoife, files: [HOME] }]);
		assert.equal(await w.redis.get(`caracms:autosave:${HOME}`), null, 'the autosave is gone once committed');
		assert.equal(ed.sweep.active, false, 'nothing left: the sweep goes quiet');
		assert.equal(w.timers.length, 0);
	});

	test('a steady typist is committed by five minutes', async () => {
		const w = world();
		const ed = await server(w);
		const before = head(w);
		const opened = await open(ed);
		let n = 0;
		for (let t = 0; t < 5 * MIN; t += 20 * SEC) {
			await write(ed, aoife, 'tab-aoife-1', opened, setIntro(`Typing ${n++}`));
			w.clock.t += 20 * SEC;
			await ed.sweep.tick();
			if (head(w) !== before) break;
		}
		assert.equal(commitsSince(w, before).length, 1, 'one commit within the cap');
		assert.ok(w.clock.t - Date.parse('2026-10-14T10:00:00Z') <= 5 * MIN + 20 * SEC);
		// Still typing after the commit: the next commit waits for the idle time or the cap again.
		await write(ed, aoife, 'tab-aoife-1', opened, setIntro('More'));
		w.clock.t += 20 * SEC;
		await ed.sweep.tick();
		assert.equal(commitsSince(w, before).length, 1);
	});

	test('two documents ready in one tick are one commit', async () => {
		const w = world();
		const ed = await server(w);
		const before = head(w);
		const creating = () => w.backend.tracker.records.filter((r) => r.creating).length;
		const c0 = creating();
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Home change'));
		await write(ed, ciaran, 'tab-ciaran-1', await open(ed, 'about'), (d) => (d.title = 'About, by Ciarán'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal(commitsSince(w, before).length, 1);
		assert.equal(creating() - c0, 1, 'one content-creating request');
		const message = parseMessage(w.backend.info(head(w)).message);
		assert.deepEqual(message.edits.map((e) => [e.person.email, e.files]), [
			['aoife@example.com', [HOME]],
			['ciaran@example.com', [ABOUT]],
		]);
	});

	test('two servers sweeping at once make one commit (the sweep\'s Redis lock)', async () => {
		const w = world();
		const a = await server(w);
		const b = await server(w);
		const before = head(w);
		await write(a, aoife, 'tab-aoife-1', await open(a), setIntro('Once'));
		b.sweep.poke();
		w.clock.t += 61 * SEC;
		const [ra, rb] = await Promise.all([a.sweep.tick(), b.sweep.tick()]);
		assert.equal(commitsSince(w, before).length, 1);
		assert.equal([ra, rb].filter((r) => r.commit).length, 1);
		assert.equal(drafts(w).blocks[0].intro, 'Once');
	});

	test('with nothing pending, the sweep makes no Redis call at all', async () => {
		const w = world();
		await server(w); // the startup check runs here
		assert.equal(w.timers.length, 0, 'nothing scheduled');
		w.redis.calls = 0;
		w.clock.t += 30 * MIN;
		for (const t of [...w.timers]) t.fn();
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(w.redis.calls, 0);
	});

	test('after its last commit the sweep is quiet: no timer, no Redis call', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Then quiet'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal(w.timers.length, 0);
		w.redis.calls = 0;
		w.clock.t += 10 * MIN;
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(w.redis.calls, 0);
	});

	test('a server starting finds the autosaves a previous one left behind', async () => {
		const w = world();
		const old = await server(w);
		await write(old, aoife, 'tab-aoife-1', await open(old), setIntro('Left behind'));
		old.sweep.stop(); // the old server goes away mid-deploy
		w.timers.length = 0;
		const fresh = await server(w);
		assert.equal(fresh.sweep.active, true);
		assert.equal(w.timers.length, 1);
		w.clock.t += 61 * SEC;
		await fresh.sweep.tick();
		assert.equal(drafts(w).blocks[0].intro, 'Left behind');
	});

	test('a session\'s second commit isn\'t mistaken for a change made elsewhere (no false notice)', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		await write(ed, aoife, 'tab-aoife-1', opened, setIntro('First'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		await write(ed, aoife, 'tab-aoife-1', opened, setIntro('Second'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).blocks[0].intro, 'Second');
		assert.deepEqual(parseMessage(w.backend.info(head(w)).message).keptDraft, []);
		assert.deepEqual((await poll(ed, aoife, 'tab-aoife-1')).notices, []);
	});
});

describe('one person\'s consecutive commits are never a "kept draft" (the exit walk\'s bug)', () => {
	const walkTimings = (ed: LiveEditor) => {
		// The walk's CARACMS_TIMINGS.
		ed.runtime.timings.sweepIdleMs = 20_000;
		ed.runtime.timings.lockLapseMs = 30_000;
	};
	const kept = (w: World) => parseMessage(w.backend.info(head(w)).message).keptDraft;

	test('commit, then a close-time write from the same tab (the keeper\'s pagehide), then the next commit: no Draft-kept', async () => {
		const w = world();
		const ed = await server(w);
		walkTimings(ed);
		const opened = await open(ed);
		const tab = 'b7f0c6de-3c1e-4c55-9d7e-0a1b2c3d4e5f';
		// The keeper as Phase 4 has it: tab header, release on pagehide.
		const keeper = createKeeper({
			site,
			storage: new MemoryStorage(),
			storageKey: 'site',
			log: () => {},
			delay: 1,
			tab,
			you: () => aoife,
			lockedFiles: () => [HOME],
			fetch: (async (url: string, init: RequestInit) => {
				const req = new Request(`${ORIGIN}${url}`, { method: init.method, headers: { ...(init.headers as Record<string, string>), origin: ORIGIN }, body: init.body as string });
				return url.includes('/lock') ? ed.lock(req, aoife) : ed.write(req, aoife);
			}) as typeof fetch,
		});
		keeper.opened('pages/index', HOME, opened.version);
		const first = clone(opened.document);
		first.blocks[0]!.data.intro = 'Aoife, first';
		keeper.change('pages/index', { file: HOME, base: opened.text, document: first });
		await keeper.flush();
		w.clock.t += 21 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).blocks[0].intro, 'Aoife, first');
		assert.deepEqual(kept(w), []);
		await poll(ed, aoife, tab);
		// Types more and closes the tab at once: the pagehide keepalive carries the release.
		const more = clone(first);
		more.blocks[0]!.data.intro = 'Aoife, first, and more';
		keeper.change('pages/index', { file: HOME, base: opened.text, document: more });
		keeper.pagehide();
		const until = Date.now() + 1000;
		while ((await w.redis.get(`caracms:autosave:${HOME}`)) === null && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
		w.clock.t += 30 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).blocks[0].intro, 'Aoife, first, and more');
		assert.deepEqual(kept(w), [], 'no Draft-kept on her own second commit');
		const s = await poll(ed, ciaran, 'tab-ciaran-1', ABOUT);
		assert.deepEqual(s.notices, []);
		assert.equal(s.waiting.find((x) => x.file === HOME)!.keptDraft, false);
	});

	test('the same session\'s held edits re-sent under another tab id (a reloaded tab): no Draft-kept', async () => {
		const w = world();
		const ed = await server(w);
		walkTimings(ed);
		const opened = await open(ed);
		await write(ed, aoife, 'tab-aoife-1', opened, setIntro('Aoife, first'));
		w.clock.t += 21 * SEC;
		await ed.sweep.tick();
		// The close-time write never landed; the next page re-sends the held copy (same base) as another tab.
		w.clock.t += 31 * SEC;
		assert.equal((await write(ed, aoife, 'tab-aoife-2', opened, setIntro('Aoife, first, and more'))).status, 200);
		w.clock.t += 21 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).blocks[0].intro, 'Aoife, first, and more');
		assert.deepEqual(kept(w), []);
	});

	test('another tab of hers that never touched a key her first tab changed doesn\'t undo it', async () => {
		const w = world();
		const ed = await server(w);
		walkTimings(ed);
		const opened = await open(ed);
		await write(ed, aoife, 'tab-aoife-1', opened, (d) => (d.title = 'Home, from tab one'));
		w.clock.t += 21 * SEC;
		await ed.sweep.tick();
		w.clock.t += 31 * SEC;
		await write(ed, aoife, 'tab-aoife-2', opened, setIntro('From tab two'));
		w.clock.t += 21 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).title, 'Home, from tab one');
		assert.equal(drafts(w).blocks[0].intro, 'From tab two');
		assert.deepEqual(kept(w), []);
	});

	test('someone else changing the same key from the same base is still a kept draft', async () => {
		const w = world();
		const ed = await server(w);
		walkTimings(ed);
		const opened = await open(ed);
		await write(ed, aoife, 'tab-aoife-1', opened, setIntro('Aoife\'s'));
		w.clock.t += 21 * SEC;
		await ed.sweep.tick();
		w.clock.t += 31 * SEC;
		await write(ed, ciaran, 'tab-ciaran-1', opened, setIntro('Ciarán\'s'));
		w.clock.t += 21 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).blocks[0].intro, 'Ciarán\'s');
		assert.deepEqual(kept(w), [HOME]);
	});
});

describe('an autosave waiting while main changes the same file (Decision 6; Verify 2)', () => {
	const pushSeo = (w: World) => {
		const text = w.backend.file('main', `starter/${HOME}`)!;
		const v = JSON.parse(text);
		v.seo = { description: 'From a developer' };
		return w.backend.push('main', { [`starter/${HOME}`]: `${JSON.stringify(v, null, 2)}\n` });
	};

	test('drafts only behind (a fast-forward), then the sweep: both changes are in drafts', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife\'s intro'));
		pushSeo(w);
		await ed.runtime.git.check({ force: true });
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).blocks[0].intro, 'Aoife\'s intro');
		assert.deepEqual(drafts(w).seo, { description: 'From a developer' });
	});

	test('diverged: the merge commits the pending autosave first, and both changes are in drafts', async () => {
		const w = world();
		const ed = await server(w);
		// drafts gets its own commit (About), so main and drafts diverge once main moves.
		await write(ed, ciaran, 'tab-ciaran-1', await open(ed, 'about'), (d) => (d.title = 'About, waiting'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife\'s intro'));
		pushSeo(w);
		const r = await ed.runtime.git.check({ force: true });
		assert.equal(r.kind, 'merged');
		assert.equal(await w.redis.get(`caracms:autosave:${HOME}`), null, 'committed before the merge');
		assert.equal(drafts(w).blocks[0].intro, 'Aoife\'s intro');
		assert.deepEqual(drafts(w).seo, { description: 'From a developer' });
		assert.equal(drafts(w, ABOUT).title, 'About, waiting');
	});
});

describe('locks (Decision 9; Verify 3)', () => {
	test('someone else\'s tab gets 409 on its first write, with the lock\'s state', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife'));
		const r = await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán'));
		assert.equal(r.status, 409);
		const body = r.body as unknown as LockRefusal;
		assert.equal(body.code, 'locked');
		assert.equal(body.state, 'theirs');
		assert.deepEqual(body.lock.person, aoife);
		assert.equal(body.lock.mine, null);
		assert.deepEqual(body.lastChange.by, aoife);
		assert.match(body.error, /Aoife/);
		assert.equal(intro((await open(ed)).document), 'Aoife', 'nothing of Ciarán\'s was kept');
		const status = await poll(ed, ciaran, 'tab-ciaran-1');
		assert.equal(status.open!.state, 'theirs');
		assert.equal(status.locks.length, 1);
	});

	test('the heartbeat stops: the lock doesn\'t lapse until the autosave is committed', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife'));
		w.clock.t += 3 * MIN; // past the lapse, with the autosave still uncommitted
		assert.equal((await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán'))).status, 409);
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'theirs');
		await ed.sweep.tick(); // commit first…
		assert.equal(drafts(w).blocks[0].intro, 'Aoife');
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'free'); // …then release
		const r = await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán'));
		assert.equal(r.status, 200);
	});

	test('the heartbeat keeps the lock while the tab polls', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick(); // committed: only the heartbeat holds it now
		for (let i = 0; i < 40; i++) {
			w.clock.t += 5 * SEC;
			await poll(ed, aoife, 'tab-aoife-1');
		}
		assert.equal((await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán'))).status, 409);
		assert.equal((await poll(ed, aoife, 'tab-aoife-1')).open!.state, 'yours');
	});

	test('a release that arrives before the tab\'s last write doesn\'t lose that write', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		await write(ed, aoife, 'tab-aoife-1', opened, setIntro('Earlier'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		// The closing tab's two keepalives: the lone release overtakes the last write.
		const release = await ed.lock(request('/_caracms/lock', { tab: 'tab-aoife-1', body: { file: HOME, action: 'release' } }), aoife);
		assert.equal(release.status, 200);
		assert.equal(((await release.json()) as { lock: { releasing: boolean } }).lock.releasing, true);
		w.clock.t += 50;
		const last = await write(ed, aoife, 'tab-aoife-1', opened, setIntro('The last change'), { release: true });
		assert.equal(last.status, 200, 'still accepted from the releasing tab');
		assert.equal((await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán'))).status, 409, 'held until it\'s committed');
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).blocks[0].intro, 'The last change');
		assert.equal(await w.redis.get(`caracms:lock:${HOME}`), null, 'dropped once committed');
		assert.equal((await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán'))).status, 200);
	});

	test('the release on the last write: the lock drops once that write is committed', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Closing'), { release: true });
		const status = await poll(ed, ciaran, 'tab-ciaran-1');
		assert.equal(status.locks[0]!.releasing, true);
		assert.equal(status.open!.state, 'theirs');
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'free');
	});

	test('a lone release with nothing unsent frees the lock after a short grace', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Done'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		await poll(ed, aoife, 'tab-aoife-1');
		await ed.lock(request('/_caracms/lock', { tab: 'tab-aoife-1', body: { file: HOME, action: 'release' } }), aoife);
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'theirs');
		w.clock.t += 6 * SEC;
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'free');
	});

	test('a tab hidden past the lapse re-takes a free lock on its next poll', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Before hiding'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		w.clock.t += 5 * MIN; // hidden: no polls
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'free', 'lapsed');
		const back = await poll(ed, aoife, 'tab-aoife-1');
		assert.equal(back.open!.state, 'yours', 're-taken on the first poll');
		assert.equal((await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán'))).status, 409);
	});

	test('browsing never locks: a poll doesn\'t take a lock the tab never held', async () => {
		const w = world();
		const ed = await server(w);
		assert.equal((await poll(ed, aoife, 'tab-aoife-1')).open!.state, 'free');
		assert.equal((await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán'))).status, 200);
	});

	test('the first write takes the lock atomically: two people\'s first writes at once give one 200 and one 409', async () => {
		for (let round = 0; round < 8; round++) {
			const w = world();
			const a = await server(w);
			const b = await server(w); // two servers, as in a deploy
			const [ra, rb] = await Promise.all([
				write(a, aoife, 'tab-aoife-1', await open(a), setIntro('Aoife')),
				write(b, ciaran, 'tab-ciaran-1', await open(b), setIntro('Ciarán')),
			]);
			assert.deepEqual([ra.status, rb.status].sort(), [200, 409], `round ${round}`);
			const winner = ra.status === 200 ? 'Aoife' : 'Ciarán';
			assert.equal(intro((await open(a)).document), winner, 'only the winner\'s edit is kept');
			const lock = JSON.parse((await w.redis.get(`caracms:lock:${HOME}`))!) as { person: Person };
			assert.equal(lock.person.email, ra.status === 200 ? aoife.email : ciaran.email);
		}
	});

	test('the same tab\'s two writes at once both succeed: the lock is its own', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		const [x, y] = await Promise.all([write(ed, aoife, 'tab-aoife-1', opened, setIntro('One')), write(ed, aoife, 'tab-aoife-1', opened, setIntro('Two'))]);
		assert.deepEqual([x.status, y.status], [200, 200]);
	});

	test('only the holder\'s tab can release: someone else\'s release changes nothing', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick(); // committed: only the heartbeat holds it now
		for (const [who, tab] of [[ciaran, 'tab-ciaran-1'], [aoife, 'tab-aoife-2']] as const) {
			await ed.lock(request('/_caracms/lock', { tab, body: { file: HOME, action: 'release' } }), who);
		}
		w.clock.t += 10 * SEC;
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'theirs', 'still Aoife\'s tab\'s lock');
		assert.equal((await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán'))).status, 409);
	});

	test('the lapse is two minutes after the last heartbeat, once the autosave is committed (not before, not much after)', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife'));
		const beat = w.clock.t; // the write was the last heartbeat
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		w.clock.t = beat + 119 * SEC;
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'theirs', '1:59 after the heartbeat: held');
		w.clock.t = beat + 121 * SEC;
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'free', '2:01 after: lapsed');
	});

	test('your own lock in another tab; Edit here moves it at once, and the old tab\'s next write gets 409', async () => {
		const w = world();
		const ed = await server(w);
		const first = await open(ed);
		await write(ed, aoife, 'tab-aoife-1', first, setIntro('Tab one'));
		const second = await poll(ed, aoife, 'tab-aoife-2');
		assert.equal(second.open!.state, 'yours-elsewhere');
		assert.equal(second.open!.lock!.mine, 'other-tab');
		const take = await ed.lock(request('/_caracms/lock', { tab: 'tab-aoife-2', body: { file: HOME, action: 'take' } }), aoife);
		assert.equal(take.status, 200);
		assert.equal(((await take.json()) as { state: string }).state, 'yours');
		assert.equal((await poll(ed, aoife, 'tab-aoife-1')).open!.state, 'yours-elsewhere', 'the old tab learns on its next poll');
		const old = await write(ed, aoife, 'tab-aoife-1', first, setIntro('Tab one, late'));
		assert.equal(old.status, 409);
		assert.equal((old.body as unknown as LockRefusal).state, 'yours-elsewhere');
		const opened = await open(ed);
		assert.equal(intro(opened.document), 'Tab one');
		assert.equal((await write(ed, aoife, 'tab-aoife-2', opened, setIntro('Tab two'))).status, 200);
		// Someone else can't Edit here.
		const theirs = await ed.lock(request('/_caracms/lock', { tab: 'tab-ciaran-1', body: { file: HOME, action: 'take' } }), ciaran);
		assert.equal(theirs.status, 409);
	});

	test('Edit here over an autosave the new tab doesn\'t hold commits that autosave first', async () => {
		const w = world();
		const ed = await server(w);
		const stale = await open(ed); // tab two opened before tab one typed
		await write(ed, aoife, 'tab-aoife-1', await open(ed), (d) => (d.title = 'Home, from tab one'));
		await ed.lock(request('/_caracms/lock', { tab: 'tab-aoife-2', body: { file: HOME, action: 'take' } }), aoife);
		await write(ed, aoife, 'tab-aoife-2', stale, setIntro('From tab two'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).title, 'Home, from tab one', 'tab one\'s change is kept');
		assert.equal(drafts(w).blocks[0].intro, 'From tab two');
	});

	test('presence: someone is on a document while a tab of theirs polled with it in the last 15 s', async () => {
		const w = world();
		const ed = await server(w);
		await poll(ed, aoife, 'tab-aoife-1', HOME);
		await poll(ed, ciaran, 'tab-ciaran-1', ABOUT);
		let s = await poll(ed, ciaran, 'tab-ciaran-1', ABOUT);
		assert.deepEqual(s.presence.find((p) => p.file === HOME)!.people, [aoife]);
		w.clock.t += 16 * SEC;
		s = await poll(ed, ciaran, 'tab-ciaran-1', ABOUT);
		assert.equal(s.presence.find((p) => p.file === HOME), undefined);
		assert.deepEqual(s.presence.find((p) => p.file === ABOUT)!.people, [ciaran]);
	});
});

describe('Take over and idle tabs (Decision 9, 2026-10-15)', () => {
	const takeOver = (ed: LiveEditor, person: Person, tab: string, file = HOME) =>
		ed.lock(request('/_caracms/lock', { tab, body: { file, action: 'take-over' } }), person);
	const pollIdle = async (ed: LiveEditor, person: Person, tab: string, input: number) => {
		const res = await ed.status(request(`/_caracms/status?file=${encodeURIComponent(HOME)}&input=${input}`, { tab }), person);
		return (await res.json()) as StatusResponse;
	};

	test('take over moves someone else\'s lock at once, commits their changes under their name first, and their next write gets 409', async () => {
		const w = world();
		const ed = await server(w);
		const aoifes = await open(ed);
		await write(ed, aoife, 'tab-aoife-1', aoifes, setIntro('Aoife, uncommitted'));
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'theirs');
		const before = head(w);
		const res = await takeOver(ed, ciaran, 'tab-ciaran-1');
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { state: string }).state, 'yours');
		// Her autosave is in drafts, committed as hers.
		assert.notEqual(head(w), before);
		assert.equal(drafts(w).blocks[0].intro, 'Aoife, uncommitted');
		assert.deepEqual(parseMessage(w.backend.info(head(w)).message).edits, [{ person: aoife, files: [HOME] }]);
		assert.equal(await w.redis.get(`caracms:autosave:${HOME}`), null);
		// Her tab learns on its next poll; anything it sends now is refused (and held).
		assert.equal((await poll(ed, aoife, 'tab-aoife-1')).open!.state, 'theirs');
		const late = await write(ed, aoife, 'tab-aoife-1', aoifes, setIntro('Aoife, late'));
		assert.equal(late.status, 409);
		// He opens from drafts, with her change, and edits.
		const his = await open(ed);
		assert.equal(intro(his.document), 'Aoife, uncommitted');
		assert.equal((await write(ed, ciaran, 'tab-ciaran-1', his, setIntro('Ciarán'))).status, 200);
	});

	test('take over of a free document just takes it, with no commit', async () => {
		const w = world();
		const ed = await server(w);
		const before = head(w);
		assert.equal((await takeOver(ed, ciaran, 'tab-ciaran-1')).status, 200);
		assert.equal(head(w), before);
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'yours');
	});

	test('an idle tab stops renewing its lock: it lapses about two minutes after ten minutes untouched', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick(); // committed: only the heartbeat holds it now
		// The tab stays open and visible, polling every 5 s, but nobody touches it.
		let untouched = 61 * SEC;
		for (let i = 0; i < 12 * 12; i++) {
			w.clock.t += 5 * SEC;
			untouched += 5 * SEC;
			await pollIdle(ed, aoife, 'tab-aoife-1', untouched);
			if (untouched < 10 * MIN) assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'theirs', `still hers at ${untouched / SEC}s`);
		}
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'free', 'lapsed after ~12 minutes untouched');
	});

	test('a tab someone keeps using keeps its lock; a poll that doesn\'t say counts as active', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		for (let i = 0; i < 40; i++) {
			w.clock.t += 5 * SEC;
			await pollIdle(ed, aoife, 'tab-aoife-1', 30 * SEC);
		}
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).open!.state, 'theirs');
	});
});

describe('who last changed it (Decision 11; Verify 4)', () => {
	test('after your own sweep and after a merge from main it still names you; after another editor, them', async () => {
		const w = world();
		const ed = await server(w);
		const r = await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		let opened = await open(ed);
		assert.deepEqual(opened.lastChange!.by, aoife, 'after the sweep of her own autosave');
		assert.equal(opened.lastChange!.version, r.body.version);
		// A merge from main (diverged: drafts has Aoife's commit).
		const v = JSON.parse(w.backend.file('main', `starter/${HOME}`)!);
		v.seo = { description: 'From main' };
		w.backend.push('main', { [`starter/${HOME}`]: `${JSON.stringify(v, null, 2)}\n` });
		assert.equal((await ed.runtime.git.check({ force: true })).kind, 'merged');
		opened = await open(ed);
		assert.deepEqual(opened.document.title, 'Home');
		assert.deepEqual(opened.lastChange!.by, aoife, 'after a merge from main');
		assert.notEqual(opened.version, r.body.version, 'the text moved, but not by someone else');
		// Another editor, once the lock lapses.
		w.clock.t += 3 * MIN;
		assert.equal((await write(ed, ciaran, 'tab-ciaran-1', opened, setIntro('Ciarán'))).status, 200);
		assert.deepEqual((await open(ed)).lastChange!.by, ciaran);
		assert.deepEqual((await poll(ed, aoife, 'tab-aoife-1')).open!.lastChange.by, ciaran);
	});
});

describe("an undo back to what's live isn't waiting (a client site's port)", () => {
	test('uncommitted: the autosave of the live text leaves the list at once', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		const title = opened.document.title;
		await write(ed, aoife, 'tab-aoife-1', opened, (d) => (d.title = 'Home, for a moment'));
		assert.deepEqual((await poll(ed, aoife, 'tab-aoife-1')).waiting.map((x) => x.file), [HOME]);
		await write(ed, aoife, 'tab-aoife-1', opened, (d) => (d.title = title));
		assert.deepEqual((await poll(ed, aoife, 'tab-aoife-1')).waiting, []);
	});

	test('committed first: the undo leaves the list, before and after the sweep commits it', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		const title = opened.document.title;
		await write(ed, aoife, 'tab-aoife-1', opened, (d) => (d.title = 'Home, committed'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal((await poll(ed, aoife, 'tab-aoife-1')).waiting.find((x) => x.file === HOME)?.uncommitted, false);
		await write(ed, aoife, 'tab-aoife-1', opened, (d) => (d.title = title));
		assert.deepEqual((await poll(ed, aoife, 'tab-aoife-1')).waiting, [], 'the autosave is back to main');
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.deepEqual((await poll(ed, aoife, 'tab-aoife-1')).waiting, [], 'and so is drafts');
	});
});

describe('Redis flushed mid-edit (Verify 5)', () => {
	test('the next write restores the whole document, and the waiting list rebuilds from git', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		await write(ed, aoife, 'tab-aoife-1', opened, (d) => (d.title = 'Home, committed'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		await write(ed, aoife, 'tab-aoife-1', opened, (d) => {
			d.title = 'Home, committed';
			d.blocks[0]!.data.intro = 'Then lost in the flush';
		});
		w.redis.flush();
		// The waiting list from git alone: Home, by Aoife.
		const s = await poll(ed, ciaran, 'tab-ciaran-1', ABOUT);
		const home = s.waiting.find((x) => x.file === HOME)!;
		assert.deepEqual(home.editors.map((e) => e.person.email), ['aoife@example.com']);
		assert.equal(home.uncommitted, false);
		assert.deepEqual((await open(ed)).lastChange!.by, { email: 'aoife@example.com', name: 'Aoife' }, 'named from git');
		// The tab's next write carries the whole document again.
		const r = await write(ed, aoife, 'tab-aoife-1', opened, (d) => {
			d.title = 'Home, committed';
			d.blocks[0]!.data.intro = 'Then lost in the flush, and typed again';
		});
		assert.equal(r.status, 200);
		const back = await open(ed);
		assert.equal(back.document.title, 'Home, committed');
		assert.equal(intro(back.document), 'Then lost in the flush, and typed again');
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal(drafts(w).blocks[0].intro, 'Then lost in the flush, and typed again');
		assert.equal(drafts(w).title, 'Home, committed');
	});
});

/** The stand-in, with a switch that makes every command fail as a Redis down past its budget does. */
function breakable(inner: MemoryRedis): RedisClient & { down: boolean } {
	const wrapped = { down: false } as RedisClient & { down: boolean };
	for (const key of Object.keys(inner) as (keyof MemoryRedis)[]) {
		const value = inner[key];
		if (typeof value !== 'function') continue;
		(wrapped as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
			if (wrapped.down && key !== 'close') return Promise.reject(new RedisUnavailableError('Redis wasn\'t reachable within 30 s (ECONNREFUSED).', 'ECONNREFUSED'));
			return (value as (...a: unknown[]) => unknown).apply(inner, args);
		};
	}
	return wrapped;
}

class MemoryStorage implements KeeperStorage {
	map = new Map<string, string>();
	get length() {
		return this.map.size;
	}
	key(i: number) {
		return [...this.map.keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.map.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.map.set(k, v);
	}
	removeItem(k: string) {
		this.map.delete(k);
	}
}

describe('Redis down past its budget during a write (Verify 6)', () => {
	test('the real client, out past its budget: the write route answers 503 unavailable', async () => {
		const w = world();
		// With drafts there already: a start that finds it missing needs Redis (finding 5), and fails without it.
		w.backend.seed(await siteFiles(site), { drafts: true });
		const dead = connectRedis('redis://127.0.0.1:1', { budgetMs: 300, backoffMs: 50, maxBackoffMs: 100, handshakeTimeoutMs: 100 });
		const ed = await server(w, { redis: dead });
		await assert.rejects(open(ed), (e: { status?: number }) => e.status === 503, 'reads answer 503 too');
		const base = w.backend.file('main', `starter/${HOME}`)!;
		const { document } = parseDocumentText(base, site);
		const res = await ed.write(request('/_caracms/write', { tab: 'tab-aoife-1', body: { file: HOME, base, document } }), aoife);
		assert.equal(res.status, 503);
		const body = (await res.json()) as { error: string; code: string };
		assert.equal(body.code, 'unavailable');
		assert.match(body.error, /can't reach its store/);
		await dead.close();
	});

	test('the keeper, as it is, maps that answer to offline and holds the edits', async () => {
		const w = world();
		const redis = breakable(w.redis);
		const ed = await server(w, { redis });
		const opened = await open(ed);
		const storage = new MemoryStorage();
		const keeper = createKeeper({
			site,
			storage,
			storageKey: 'site',
			log: () => {},
			delay: 1,
			// Phase 4 makes the keeper send the tab header; the shim adds it here.
			fetch: (async (_url: string, init: RequestInit) =>
				ed.write(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { ...(init.headers as Record<string, string>), 'x-caracms-tab': 'tab-aoife-1', origin: ORIGIN }, body: init.body }), aoife)) as typeof fetch,
		});
		keeper.opened('pages/index', HOME, opened.version);
		const edited = clone(opened.document);
		edited.title = 'Typed while Redis is away';
		redis.down = true;
		keeper.change('pages/index', { file: HOME, base: opened.text, document: edited });
		const until = Date.now() + 2000;
		while (keeper.status.get().state !== 'offline' && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
		assert.equal(keeper.status.get().state, 'offline');
		assert.match(keeper.status.get().error!, /can't reach its store/);
		assert.equal(JSON.parse(storage.getItem('caracms:unsent:site:pages/index')!).document.title, 'Typed while Redis is away', 'held');
		// Redis back: the next change gets through.
		redis.down = false;
		edited.title = 'Typed while Redis is away, and after';
		keeper.change('pages/index', { file: HOME, base: opened.text, document: clone(edited) });
		while (keeper.status.get().state !== 'kept' && Date.now() < until + 2000) await new Promise((r) => setTimeout(r, 5));
		assert.equal(keeper.status.get().state, 'kept');
		assert.equal((await open(ed)).document.title, 'Typed while Redis is away, and after');
		assert.equal(storage.map.size, 0);
	});
});

describe('the status route (Decision 13)', () => {
	test('one poll carries the waiting list (uncommitted included), locks, presence, notices, publish and you', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Uncommitted'));
		const s = await poll(ed, ciaran, 'tab-ciaran-1', HOME);
		assert.equal(s.mode, 'live');
		assert.deepEqual(s.you, ciaran);
		assert.equal(s.tab, 'tab-ciaran-1');
		assert.equal(s.timeZone, site.timeZone);
		assert.deepEqual(s.waiting.map((x) => [x.file, x.collection, x.path, x.uncommitted, x.editors.map((e) => e.person.email)]), [[HOME, 'pages', 'index', true, ['aoife@example.com']]]);
		assert.deepEqual(s.waiting[0]!.editingNow, [aoife], 'Aoife\'s tab holds the lock: "Editing now" for Ciarán');
		assert.deepEqual(s.publish, { state: 'none', running: false, record: null, assumed: false, canTryAgain: false, hasRedeployer: false });
	});

	test('polls ask GitHub for nothing within the minute (the throttled check only)', async () => {
		const w = world();
		const ed = await server(w);
		await poll(ed, aoife, 'tab-aoife-1');
		const n = w.backend.tracker.records.length;
		for (let i = 0; i < 10; i++) {
			w.clock.t += 5 * SEC;
			await poll(ed, aoife, 'tab-aoife-1');
		}
		assert.equal(w.backend.tracker.records.length, n);
		w.clock.t += MIN;
		await poll(ed, aoife, 'tab-aoife-1');
		assert.ok(w.backend.tracker.records.length - n <= 2, 'one cheap check after the minute');
	});

	test('a merge notice shows until dismissed; Publish commits pending autosaves and tells whoever had it open', async () => {
		const w = world();
		const ed = await server(w);
		// A conflict on the same key: Aoife's autosave and a developer's push both change the title.
		await write(ed, ciaran, 'tab-ciaran-1', await open(ed, 'about'), (d) => (d.title = 'About, waiting'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		await write(ed, aoife, 'tab-aoife-1', await open(ed), (d) => (d.title = 'Home, by Aoife'));
		const v = JSON.parse(w.backend.file('main', `starter/${HOME}`)!);
		v.title = 'Home, by a developer';
		w.backend.push('main', { [`starter/${HOME}`]: `${JSON.stringify(v, null, 2)}\n` });
		await ed.runtime.git.check({ force: true });
		let s = await poll(ed, aoife, 'tab-aoife-1');
		const notice = s.notices.find((n) => n.kind === 'draft-kept')!;
		assert.equal(notice.file, HOME);
		assert.equal(notice.title, 'Home, by Aoife');
		assert.equal(s.waiting.find((x) => x.file === HOME)!.keptDraft, true);
		const dismiss = await ed.notice(request('/_caracms/notice', { body: { id: notice.id } }), aoife);
		assert.equal(dismiss.status, 200);
		assert.deepEqual((await poll(ed, aoife, 'tab-aoife-1')).notices, []);

		// Aoife types again (uncommitted) with Home open; Ciarán publishes.
		await write(ed, aoife, 'tab-aoife-1', await open(ed), (d) => (d.title = 'Home, as it stood'));
		await poll(ed, aoife, 'tab-aoife-1');
		const pub = await ed.publish(request('/_caracms/publish', { body: {} }), ciaran);
		assert.equal(pub.status, 200);
		const body = (await pub.json()) as { result: string; publish: { state: string; record: { titles: string[] } } };
		assert.equal(body.result, 'published');
		assert.equal(body.publish.state, 'live', 'no deploy pipeline here: live once the refs moved');
		assert.equal(JSON.parse(w.backend.file('main', `starter/${HOME}`)!).title, 'Home, as it stood', 'the uncommitted autosave went out');
		s = await poll(ed, aoife, 'tab-aoife-1');
		const stood = s.notices.find((n) => n.kind === 'published-as-it-stood');
		assert.ok(stood && stood.kind === 'published-as-it-stood');
		assert.deepEqual(stood.by, ciaran);
		assert.equal(stood.file, HOME);
		assert.deepEqual(s.waiting, []);
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-1')).notices.length, 0, 'not for the publisher');
		const history = await ed.history(request('/_caracms/history'), ciaran);
		const h = (await history.json()) as { entries: { by: Person; state: string }[]; timeZone: string };
		assert.equal(h.entries.length, 1);
		assert.equal(h.entries[0]!.by.email, ciaran.email);
		const again = await ed.publish(request('/_caracms/publish', { body: {} }), ciaran);
		assert.equal(((await again.json()) as { result: string }).result, 'nothing-waiting');
	});

	test('failed, with and without Try again', async () => {
		const w = world();
		w.backend.seed(await siteFiles(site));
		const now = () => w.clock.t;
		let running = 'nope';
		const calls: string[] = [];
		const make = async (railway: LiveSettings['railway']) => {
			const rt = await createLiveRuntime({
				site,
				settings: { ...settings, railway },
				backend: w.backend,
				redis: w.redis,
				now,
				log: () => {},
				runningCommit: () => running,
				railwayFetch: (async (url: string) => {
					calls.push(url);
					return new Response(JSON.stringify({ data: { serviceInstanceRedeploy: true } }));
				}) as typeof fetch,
			});
			return createLiveEditor(rt, { log: () => {}, schedule: () => () => {} });
		};
		const ed = await make({ token: 't', serviceId: 's', environmentId: 'e' });
		running = w.backend.refs.get('main')!;
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('To publish'));
		const pub = (await (await ed.publish(request('/_caracms/publish', { body: {} }), aoife)).json()) as { publish: { state: string; record: { commit: string } } };
		assert.equal(pub.publish.state, 'publishing');
		const tooSoon = await ed.tryAgain(request('/_caracms/try-again', { body: {} }), aoife);
		assert.equal(tooSoon.status, 409);
		w.backend.deployments.push({ id: 1, sha: pub.publish.record.commit, createdAt: new Date(w.clock.t).toISOString(), statuses: [{ state: 'failure', createdAt: new Date(w.clock.t).toISOString() }] } as never);
		w.clock.t += 11 * SEC;
		let s = await poll(ed, aoife, 'tab-aoife-1');
		assert.equal(s.publish.state, 'failed');
		assert.equal(s.publish.canTryAgain, true);
		assert.equal(s.publish.hasRedeployer, true);
		const again = await ed.tryAgain(request('/_caracms/try-again', { body: {} }), aoife);
		assert.equal(again.status, 200);
		assert.equal(calls.length, 1);
		// Without a token: failed, no Try again, and the route says why.
		const noToken = await make(null);
		s = await poll(noToken, aoife, 'tab-aoife-2');
		assert.equal(s.publish.hasRedeployer, false);
		assert.equal(s.publish.canTryAgain, false);
		const refused = await noToken.tryAgain(request('/_caracms/try-again', { body: {} }), aoife);
		assert.equal(refused.status, 409);
		assert.match(((await refused.json()) as { error: string }).error, /a developer can redeploy it/);
	});

	test('no person: 401 signed-out on every route; a cross-origin POST: 403', async () => {
		const w = world();
		const ed = await server(w);
		for (const [fn, req] of [
			[ed.status, request('/_caracms/status')],
			[ed.lock, request('/_caracms/lock', { body: { file: HOME, action: 'take' } })],
			[ed.publish, request('/_caracms/publish', { body: {} })],
			[ed.history, request('/_caracms/history')],
			[ed.tryAgain, request('/_caracms/try-again', { body: {} })],
			[ed.notice, request('/_caracms/notice', { body: { id: 'x' } })],
		] as const) {
			const res = await fn(req, null);
			assert.equal(res.status, 401, req.url);
			assert.deepEqual(await res.json(), { error: 'signed-out', code: 'signed-out' });
		}
		const cross = await ed.publish(request('/_caracms/publish', { body: {}, headers: { origin: 'https://evil.test' } }), aoife);
		assert.equal(cross.status, 403);
	});
});

describe('Publish across two servers (Decision 10: one at a time per site; a second press joins it)', () => {
	test('two people press Publish at once on two servers: one squash commit on main, and the other press is told it joined or finds nothing waiting', async () => {
		const w = world();
		const a = await server(w);
		const b = await server(w);
		await write(a, aoife, 'tab-aoife-1', await open(a), setIntro('Publish me'));
		const press = async (ed: LiveEditor, who: Person) => ((await (await ed.publish(request('/_caracms/publish', { body: {} }), who)).json()) as { result: string; publish: { record: { commit: string } | null } });
		const [ra, rb] = await Promise.all([press(a, aoife), press(b, ciaran)]);
		const results = [ra.result, rb.result].sort();
		assert.equal(results.filter((r) => r === 'published').length, 1, `exactly one of them published: ${results}`);
		assert.ok(['joined', 'nothing-waiting'].includes(results.find((r) => r !== 'published')!), `and the other did not publish again: ${results}`);
		const squashes = [...w.backend.reachable('main')].filter((c) => w.backend.info(c).message.startsWith('Published:'));
		assert.equal(squashes.length, 1);
		assert.equal(JSON.parse(w.backend.file('main', `starter/${HOME}`)!).blocks[0].intro, 'Publish me');
		assert.equal(w.backend.refs.get('drafts'), w.backend.refs.get('main'));
		assert.equal(await w.redis.get('caracms:publish:lock'), null, 'the lock is released');
	});

	test('Publish with nothing waiting: no commit, no ref moves, no Redis record, and the answer says so', async () => {
		const w = world();
		const ed = await server(w);
		const creating = () => w.backend.tracker.records.filter((r) => r.creating).length;
		const [mainBefore, draftsBefore, made] = [w.backend.refs.get('main'), w.backend.refs.get('drafts'), creating()];
		const res = await ed.publish(request('/_caracms/publish', { body: {} }), aoife);
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { result: string }).result, 'nothing-waiting');
		assert.deepEqual([w.backend.refs.get('main'), w.backend.refs.get('drafts'), creating()], [mainBefore, draftsBefore, made]);
		assert.equal(await w.redis.get('caracms:publish:last'), null);
	});
});

// ── The M4 review round ─────────────────────────────────────────────────────────

/** A write with the tab's write sequence (`X-Caracms-Seq`), as today's keeper sends it. */
async function writeSeq(ed: LiveEditor, person: Person, tab: string, opened: OpenedDocument, seq: number, edit: (d: SiteDocument) => void, options: { release?: boolean } = {}) {
	const document = clone(opened.document);
	edit(document);
	const headers: Record<string, string> = { 'x-caracms-seq': String(seq) };
	if (options.release) headers['x-caracms-release'] = '1';
	const res = await ed.write(request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document }, headers }), person);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const within = <T>(p: Promise<T>, ms: number, what: string) =>
	Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms))]);

describe('the startup check commits pending autosaves before it merges main (Decision 8)', () => {
	test('an autosave for Home left in Redis and a diverging change to Home on main: a fresh server commits the draft, then merges, with Draft-kept naming Home', async () => {
		const w = world();
		const first = await server(w);
		// drafts ahead of main (About committed), and an autosave for Home still in Redis.
		await write(first, ciaran, 'tab-ciaran-1', await open(first, 'about'), (d) => (d.title = 'About, committed'));
		w.clock.t += 61 * SEC;
		await first.sweep.tick();
		first.sweep.stop();
		await write(first, aoife, 'tab-aoife-1', await open(first), (d) => (d.title = 'Home, by Aoife'));
		const before = head(w);
		// A developer changes Home's title on main: diverged, and the same key.
		const v = JSON.parse(w.backend.file('main', `starter/${HOME}`)!);
		v.title = 'Home, by a developer';
		w.backend.push('main', { [`starter/${HOME}`]: `${JSON.stringify(v, null, 2)}\n` });

		await server(w); // a fresh runtime and editor (a deploy, a restart)
		const commits = commitsSince(w, before).reverse(); // oldest first
		const messages = commits.map((c) => parseMessage(w.backend.info(c).message));
		assert.deepEqual(messages.map((m) => m.kind), ['draft', 'merge'], 'the draft commit comes before the merge');
		assert.ok(messages[0]!.edits.some((e) => e.files.includes(HOME)), 'the draft commit carries Home');
		assert.deepEqual(messages[1]!.keptDraft, [HOME], 'the merge kept the draft for Home, and says so');
		assert.equal(drafts(w).title, 'Home, by Aoife');
	});
});

describe('who changed it is never forgotten, and unknown is said (Decision 11)', () => {
	test('the change record outlives the autosave\'s week and a Publish; after a flush with nothing in git, it\'s unknown', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife, then published'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		assert.equal((await ed.publish(request('/_caracms/publish', { body: {} }), ciaran)).status, 200);
		w.clock.t += 8 * 24 * 60 * MIN; // past the autosave's week
		const later = (await open(ed)).lastChange!;
		assert.deepEqual(later.by, aoife, 'still names Aoife after the publish and the week');
		assert.notEqual(later.known, false);
		w.redis.flush();
		const flushed = (await open(ed)).lastChange!;
		assert.equal(flushed.known, false, 'Redis lost it and git names nobody (published): unknown');
		assert.equal(flushed.by, null);
	});
});

describe('the autosave is compare-and-set: an older write never replaces a newer one', () => {
	test('(a) the pagehide release write lands before the same tab\'s normal write: the newer stays', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		const newer = await writeSeq(ed, aoife, 'tab-aoife-1', opened, 2, setIntro('The last change (pagehide)'), { release: true });
		assert.equal(newer.status, 200);
		const older = await writeSeq(ed, aoife, 'tab-aoife-1', opened, 1, setIntro('An earlier change, landing late'));
		assert.equal(older.status, 200, 'the tab\'s own newer document is the one kept');
		assert.equal(older.body.version, newer.body.version, 'it answers with the version actually stored');
		assert.equal(intro((await open(ed)).document), 'The last change (pagehide)');
	});

	test('a newer seq from the same tab still replaces an older one', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		await writeSeq(ed, aoife, 'tab-aoife-1', opened, 1, setIntro('One'));
		await writeSeq(ed, aoife, 'tab-aoife-1', opened, 2, setIntro('Two'));
		assert.equal(intro((await open(ed)).document), 'Two');
	});

	test('(b) after Edit here, an old-tab write that got past acquire lands after the new tab\'s first write: refused, not Kept', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		assert.equal((await writeSeq(ed, aoife, 'tab-aoife-1', opened, 1, setIntro('Tab one'))).status, 200);
		const acquire = ed.locks.acquire.bind(ed.locks);
		let raced = false;
		ed.locks.acquire = async (file, tab, person) => {
			const r = await acquire(file, tab, person);
			if (tab === 'tab-aoife-1' && !raced) {
				raced = true;
				// Between tab one's acquire and its store: Edit here in tab two, and tab two's first write.
				assert.equal((await ed.lock(request('/_caracms/lock', { tab: 'tab-aoife-2', body: { file: HOME, action: 'take' } }), aoife)).status, 200);
				assert.equal((await writeSeq(ed, aoife, 'tab-aoife-2', await open(ed), 1, setIntro('Tab two'))).status, 200);
			}
			return r;
		};
		const late = await writeSeq(ed, aoife, 'tab-aoife-1', opened, 2, setIntro('Tab one, late'));
		assert.equal(late.status, 409, 'not Kept: tab one\'s document isn\'t the one stored');
		assert.equal((late.body as unknown as LockRefusal).state, 'yours-elsewhere');
		assert.equal(intro((await open(ed)).document), 'Tab two');
	});
});

describe('the status poll never waits on GitHub', () => {
	test('a check that hangs: the poll answers anyway, with what\'s known', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Waiting'));
		w.clock.t += 2 * MIN; // past the check's minute
		w.backend.beforeRequest = () => new Promise<void>(() => {}); // GitHub stops answering
		const s = await within(poll(ed, ciaran, 'tab-ciaran-1'), 2000, 'the poll');
		assert.equal(s.waiting.length, 1);
		assert.equal(s.waiting[0]!.uncommitted, true);
	});
});

describe('dismissing a notice: only one you\'re shown', () => {
	test('someone else\'s "published as it stood" is 404; yours goes; malformed and long ids are 400; a draft-kept notice is anyone\'s', async () => {
		const w = world();
		const ed = await server(w);
		const dismiss = (person: Person, id: unknown) => ed.notice(request('/_caracms/notice', { body: { id } }), person);
		// Aoife has Home open with a change; Ciarán publishes: the notice is Aoife's.
		await write(ed, aoife, 'tab-aoife-1', await open(ed), (d) => (d.title = 'Home, as it stood'));
		await poll(ed, aoife, 'tab-aoife-1');
		await ed.publish(request('/_caracms/publish', { body: {} }), ciaran);
		const stood = (await poll(ed, aoife, 'tab-aoife-1')).notices.find((n) => n.kind === 'published-as-it-stood')!;
		assert.ok(stood);
		assert.equal((await dismiss(ciaran, stood.id)).status, 404, 'not shown to Ciarán');
		assert.equal((await dismiss(aoife, 'stood:nope')).status, 404, 'no such notice');
		assert.equal((await dismiss(aoife, 'kept: has spaces')).status, 400);
		assert.equal((await dismiss(aoife, 'other:x')).status, 400);
		assert.equal((await dismiss(aoife, `kept:${'x'.repeat(600)}`)).status, 400);
		assert.equal((await dismiss(aoife, 42)).status, 400);
		assert.ok((await poll(ed, aoife, 'tab-aoife-1')).notices.some((n) => n.id === stood.id), 'still Aoife\'s');
		assert.equal((await dismiss(aoife, stood.id)).status, 200);
		assert.ok(!(await poll(ed, aoife, 'tab-aoife-1')).notices.some((n) => n.id === stood.id));

		// A draft-kept notice (shared): Ciarán, who didn't make the change, may dismiss it.
		await write(ed, ciaran, 'tab-ciaran-1', await open(ed, 'about'), (d) => (d.title = 'About, waiting'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		await write(ed, aoife, 'tab-aoife-1', await open(ed), (d) => (d.title = 'Home, by Aoife'));
		const v = JSON.parse(w.backend.file('main', `starter/${HOME}`)!);
		v.title = 'Home, by a developer';
		w.backend.push('main', { [`starter/${HOME}`]: `${JSON.stringify(v, null, 2)}\n` });
		await ed.runtime.git.check({ force: true });
		const kept = (await poll(ed, ciaran, 'tab-ciaran-1')).notices.find((n) => n.kind === 'draft-kept')!;
		assert.ok(kept);
		assert.equal((await dismiss(ciaran, kept.id)).status, 200);
		assert.ok(!(await poll(ed, aoife, 'tab-aoife-1')).notices.some((n) => n.id === kept.id), 'gone for everyone');
	});
});

describe('"Editing now" in the waiting list means someone other than this tab holds the lock', () => {
	test('your own tab\'s lock: not editing now; your other tab: editing now; presence alone: not', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-1', await open(ed), setIntro('Aoife'));
		let s = await poll(ed, aoife, 'tab-aoife-1');
		assert.deepEqual(s.waiting[0]!.editingNow, [], 'the viewer alone, holding the lock in this tab');
		s = await poll(ed, aoife, 'tab-aoife-2');
		assert.deepEqual(s.waiting[0]!.editingNow, [aoife], 'your own other tab holds it');
		s = await poll(ed, ciaran, 'tab-ciaran-1');
		assert.deepEqual(s.waiting[0]!.editingNow, [aoife], 'someone else holds it');
		// The lock lapses once committed and the heartbeat stops: on it (presence) but nobody holds it.
		w.clock.t += 3 * MIN;
		await ed.sweep.tick();
		s = await poll(ed, ciaran, 'tab-ciaran-1');
		assert.deepEqual(s.waiting.find((x) => x.file === HOME)!.editingNow, [], 'presence alone isn\'t "Editing now"');
	});
});

describe('a change from main is "only merges", not unknown (Decision 11)', () => {
	const pushTitle = async (w: World, file: string, title: string) => {
		const v = JSON.parse(w.backend.file('main', `starter/${file}`)!);
		v.title = title;
		w.backend.push('main', { [`starter/${file}`]: `${JSON.stringify(v, null, 2)}\n` });
	};

	test('never edited, then a push to main the check takes in (a fast-forward): known, by null, and held edits are re-sent', async () => {
		const w = world();
		const ed = await server(w);
		const before = await open(ed, 'about');
		await pushTitle(w, ABOUT, 'About, from main');
		assert.equal((await ed.runtime.git.check({ force: true })).kind, 'fast-forward');
		const after = await open(ed, 'about');
		assert.equal(after.document.title, 'About, from main');
		assert.notEqual(after.lastChange!.known, false, 'only merges are known');
		assert.equal(after.lastChange!.by, null);
		// Edits held from before the push: re-sent (the server merges them), not a conflict.
		const document = clone(before.document);
		document.title = 'About, held from before';
		const held = { base: before.text, document, fileVersion: before.version };
		assert.equal(verdict(held, { version: after.version, text: after.text, lastChange: after.lastChange }, site, aoife), 'send');
	});

	test('never edited, then a merge (diverged): known, by null', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Home, committed'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		await pushTitle(w, ABOUT, 'About, merged from main');
		assert.equal((await ed.runtime.git.check({ force: true })).kind, 'merged');
		const after = await open(ed, 'about');
		assert.equal(after.document.title, 'About, merged from main');
		assert.notEqual(after.lastChange!.known, false);
		assert.equal(after.lastChange!.by, null);
	});

	test('another editor changed it, then a merge from main: it still names them', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, ciaran, 'tab-ciaran-1', await open(ed), setIntro('Ciarán\'s intro'));
		w.clock.t += 61 * SEC;
		await ed.sweep.tick();
		await pushTitle(w, HOME, 'Home, from main');
		assert.equal((await ed.runtime.git.check({ force: true })).kind, 'merged');
		const after = await open(ed);
		assert.equal(after.document.title, 'Home, from main');
		assert.deepEqual(after.lastChange!.by, ciaran);
	});
});
