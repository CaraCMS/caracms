// The Redis diet: the status poll's write-through cache,
// the heartbeat only when needed, presence holds from the tab's interval, and the
// command counts before and after (Decision 12). On the in-memory GitHub, the Redis
// stand-in (whose call count is the measure) and a fake clock; the sweep's timer is
// driven by hand.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import type { SiteDocument } from '../src/document.ts';
import { handleMove } from '../src/editor/server/move.ts';
import type { OpenedDocument, StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { RELEASE_GRACE_MS } from '../src/live/locks.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis, RedisUnavailableError, type MemoryRedis } from '../src/live/redis.ts';
import { StatusCache } from '../src/live/status-cache.ts';
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
}

function world(): World {
	const clock = { t: Date.parse('2026-10-24T10:00:00Z') };
	return { clock, backend: new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t }), redis: memoryRedis({ now: () => clock.t }) };
}

async function server(w: World): Promise<LiveEditor> {
	if (!w.backend.refs.has('main')) w.backend.seed([...(await siteFiles(site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const rt = await createLiveRuntime({ site, settings, backend: w.backend, redis: w.redis, now: () => w.clock.t, log: () => {}, runningCommit: () => null });
	// The sweep's timer never fires by itself here: a test that wants a tick runs `sweep.commitAll()`.
	return createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
}

const clone = (d: SiteDocument): SiteDocument => JSON.parse(JSON.stringify(d));

function request(path: string, init: { tab?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
	const headers: Record<string, string> = { origin: ORIGIN, ...init.headers };
	if (init.tab) headers['x-caracms-tab'] = init.tab;
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return new Request(`${ORIGIN}${path}`, { method: init.body === undefined ? 'GET' : 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

async function open(ed: LiveEditor, path = 'index'): Promise<OpenedDocument> {
	return (await ed.store.read('pages', path)) as OpenedDocument;
}

/** A write from a tab: the document as opened, its title changed. */
async function write(ed: LiveEditor, person: Person, tab: string, opened: OpenedDocument, title: string, options: { release?: boolean } = {}) {
	const document = clone(opened.document);
	(document as { title?: string }).title = title;
	const res = await ed.write(
		request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document }, headers: options.release ? { 'x-caracms-release': '1' } : {} }),
		person,
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A tab's poll. `interval`: what the tab says (absent: an old page that sends none). */
async function poll(ed: LiveEditor, person: Person, tab: string, file: string | null = HOME, o: { input?: number; interval?: number } = {}): Promise<StatusResponse> {
	const q = new URLSearchParams();
	if (file) q.set('file', file);
	q.set('input', String(o.input ?? 0));
	if (o.interval !== undefined) q.set('interval', String(o.interval));
	const res = await ed.status(request(`/_caracms/status?${q}`, { tab }), person);
	assert.equal(res.status, 200, await res.clone().text());
	return (await res.json()) as StatusResponse;
}

/** Commands `fn` made. */
async function count(w: World, fn: () => Promise<unknown>): Promise<number> {
	const before = w.redis.calls;
	await fn();
	return w.redis.calls - before;
}

// ── Decision 12: the counts ────────────────────────────────────────────────────

interface Counts {
	/** One active tab holding its document's lock, polling every 5 s for a minute: commands per poll. */
	onePerPoll: number;
	/** One keep (a write from the tab that holds the lock). */
	keep: number;
	/** One tab closing: its `pagehide` keep, which also releases the lock. */
	close: number;
	/** Five tabs on one site, each polling every 5 s for a minute: commands per poll, over all of them. */
	fivePerPoll: number;
}

async function measure(): Promise<Counts> {
	const w = world();
	const ed = await server(w);
	const opened = await open(ed);
	await write(ed, aoife, 'tab-aoife-a', opened, 'Typing');
	await poll(ed, aoife, 'tab-aoife-a', HOME, { interval: 5000 });
	// A minute of polls, after one to settle (the cache's first fill counts: it's in the minute).
	let polls = 0;
	const minute = await count(w, async () => {
		for (let i = 0; i < 12; i++) {
			w.clock.t += 5 * SEC;
			await poll(ed, aoife, 'tab-aoife-a', HOME, { interval: 5000 });
			polls++;
		}
	});
	const keep = await count(w, () => write(ed, aoife, 'tab-aoife-a', opened, 'Typing more'));
	const close = await count(w, () => write(ed, aoife, 'tab-aoife-a', opened, 'Typing more, closing', { release: true }));

	// Five tabs: Aoife holding Home, the others looking at pages, polls spread over each 5 s.
	const w5 = world();
	const ed5 = await server(w5);
	await write(ed5, aoife, 'tab-five-1', await open(ed5), 'Typing');
	const tabs: [Person, string, string][] = [
		[aoife, 'tab-five-1', HOME],
		[ciaran, 'tab-five-2', HOME],
		[ciaran, 'tab-five-3', ABOUT],
		[aoife, 'tab-five-4', ABOUT],
		[ciaran, 'tab-five-5', 'content/pages/work.json'],
	];
	for (const [p, t, f] of tabs) await poll(ed5, p, t, f, { interval: 5000 });
	let polls5 = 0;
	const five = await count(w5, async () => {
		for (let i = 0; i < 12; i++) {
			for (const [p, t, f] of tabs) {
				w5.clock.t += 1 * SEC;
				await poll(ed5, p, t, f, { interval: 5000 });
				polls5++;
			}
		}
	});
	return { onePerPoll: minute / polls, keep, close, fivePerPoll: five / polls5 };
}

/** Measured from the code before the diet (`0106a5f`), with `measure()` as it is here: the spec's *Decisions during build*. */
const BEFORE: Counts = { onePerPoll: 15, keep: 6, close: 8, fivePerPoll: 14.4 };

describe('the counts (Decision 12)', () => {
	test('check 1: one active tab polling for a minute averages at most a third of the commands per poll it did before', async () => {
		const c = await measure();
		if (process.env.CARACMS_COUNTS) console.log(JSON.stringify(c));
		assert.ok(c.onePerPoll <= BEFORE.onePerPoll / 3, `${c.onePerPoll} a poll`);
		assert.ok(c.fivePerPoll <= BEFORE.fivePerPoll / 3, `${c.fivePerPoll} a poll over five tabs`);
		assert.ok(c.keep <= BEFORE.keep && c.close <= BEFORE.close, JSON.stringify(c));
	});
});

/** Count calls to these Redis methods from now on (a batch's commands count under their own names). */
function spy(w: World, ...names: (keyof MemoryRedis & string)[]): Record<string, number> {
	const counts: Record<string, number> = {};
	const r = w.redis as unknown as Record<string, (...a: unknown[]) => unknown>;
	for (const n of names) {
		const original = r[n]!.bind(w.redis);
		counts[n] = 0;
		r[n] = (...args: unknown[]) => {
			counts[n]!++;
			return original(...args);
		};
	}
	return counts;
}

/** A lock written straight to Redis: the other server during a deploy (Decision 4). */
async function lockInRedis(w: World, file: string, tab: string, person: Person) {
	const t = w.clock.t;
	await w.redis.set(`caracms:lock:${file}`, JSON.stringify({ tab, person, since: t, beat: t, releasing: null }));
}

const onDoc = (st: StatusResponse, file: string, person: Person) => st.presence.some((p) => p.file === file && p.people.some((x) => x.email === person.email));

async function call<T = Record<string, unknown>>(res: Promise<Response>): Promise<{ status: number; body: T }> {
	const r = await res;
	return { status: r.status, body: (await r.json()) as T };
}
const publish = (ed: LiveEditor, person: Person) => call<{ result: string }>(ed.publish(request('/_caracms/publish', { body: {} }), person));

describe('the status cache (Decisions 1–5)', () => {
	test('check 2: an extra tab on the same site adds only its own commands (its presence each poll, a beat at most every 30 s), no site-wide reads', async () => {
		const run = async (two: boolean) => {
			const w = world();
			const ed = await server(w);
			await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
			if (two) await write(ed, ciaran, 'tab-ciaran-b', await open(ed, 'about'), 'Typing too');
			const before = w.redis.calls;
			const siteWide = spy(w, 'scan', 'mget', 'hgetall', 'smembers');
			for (let i = 0; i < 12; i++) {
				w.clock.t += 5 * SEC;
				await poll(ed, aoife, 'tab-aoife-a', HOME, { interval: 5000 });
				if (two) await poll(ed, ciaran, 'tab-ciaran-b', ABOUT, { interval: 5000 });
			}
			return { all: w.redis.calls - before, siteWide };
		};
		const one = await run(false);
		const two = await run(true);
		assert.deepEqual(two.siteWide, one.siteWide, 'no more site-wide reads');
		// Its own: 12 presence writes, 2 beats, and its open document's change record read every 30 s.
		assert.ok(two.all - one.all <= 12 + 2 + 2, `the second tab added ${two.all - one.all} commands over its 12 polls`);
	});

	test('check 3: five tabs whose polls arrive together while the cache is stale cause one refresh', async () => {
		const w = world();
		const ed = await server(w);
		const files = [HOME, ABOUT, 'content/pages/work.json', HOME, ABOUT];
		for (const [i, f] of files.entries()) await poll(ed, i % 2 ? ciaran : aoife, `tab-five-${i}`, f);
		w.clock.t += 31 * SEC;
		const counts = spy(w, 'scan', 'hgetall', 'smembers');
		await Promise.all(files.map((f, i) => poll(ed, i % 2 ? ciaran : aoife, `tab-five-${i}`, f)));
		assert.deepEqual(counts, { scan: 2, hgetall: 3, smembers: 1 }, 'one refresh: the two scans, presence, moves and notices, the dismissed set');
	});

	test('check 4: no tab polling for a minute: no Redis command at all (nothing refreshes on a timer)', async () => {
		const w = world();
		const ed = await server(w);
		await poll(ed, aoife, 'tab-aoife-a');
		const before = w.redis.calls;
		w.clock.t += MIN;
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(w.redis.calls, before);
	});

	test('check 5: a tab takes a lock by typing; its very next poll shows it as its own', async () => {
		const w = world();
		const ed = await server(w);
		assert.equal((await poll(ed, aoife, 'tab-aoife-a')).open?.state, 'free');
		await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
		const st = await poll(ed, aoife, 'tab-aoife-a');
		assert.equal(st.open?.state, 'yours');
		assert.equal(st.open?.lock?.mine, 'this-tab');
		assert.ok(st.waiting.some((x) => x.file === HOME && x.uncommitted), 'and its autosave is waiting');
		assert.equal(st.open?.lastChange.by?.email, aoife.email, 'and its change record');
	});

	test('check 6: A types on a page; B on the same page and server shows "A is editing" at its next poll', async () => {
		const w = world();
		const ed = await server(w);
		await poll(ed, ciaran, 'tab-ciaran-b');
		await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
		const st = await poll(ed, ciaran, 'tab-ciaran-b');
		assert.equal(st.open?.state, 'theirs');
		assert.equal(st.open?.lock?.person.email, aoife.email);
	});

	test('check 7: B types on the page A holds: refused, whatever B\'s cache said', async () => {
		const w = world();
		const ed = await server(w);
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-b')).open?.state, 'free');
		await lockInRedis(w, HOME, 'tab-aoife-a', aoife);
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-b')).open?.state, 'free', 'the cache hasn\'t seen it yet');
		const r = await write(ed, ciaran, 'tab-ciaran-b', await open(ed), 'Mine');
		assert.equal(r.status, 409);
		assert.equal(r.body.code, 'locked');
	});

	test('check 8: a lock written straight to Redis shows on the status route within 30 s plus one poll', async () => {
		const w = world();
		const ed = await server(w);
		await poll(ed, ciaran, 'tab-ciaran-b');
		const from = w.clock.t;
		await lockInRedis(w, HOME, 'tab-aoife-a', aoife);
		let shownAfter = Infinity;
		for (let i = 0; i < 10; i++) {
			w.clock.t += 5 * SEC;
			if ((await poll(ed, ciaran, 'tab-ciaran-b')).open?.state === 'theirs') {
				shownAfter = w.clock.t - from;
				break;
			}
		}
		assert.ok(shownAfter <= 35 * SEC, `shown after ${shownAfter / SEC} s`);
	});

	test('check 19: autosaves, the change record and the sweep\'s commit show at the next poll', async () => {
		const w = world();
		const ed = await server(w);
		await poll(ed, ciaran, 'tab-ciaran-b');
		await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
		let st = await poll(ed, ciaran, 'tab-ciaran-b');
		assert.equal(st.waiting.find((x) => x.file === HOME)?.uncommitted, true);
		assert.equal(st.open?.lastChange.by?.email, aoife.email);
		await ed.sweep.commitAll();
		st = await poll(ed, ciaran, 'tab-ciaran-b');
		assert.equal(st.waiting.find((x) => x.file === HOME)?.uncommitted, false, 'committed: the autosave is gone from the cache');
	});

	test('check 19: a lock\'s release shows at the next poll', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
		await poll(ed, ciaran, 'tab-ciaran-b');
		await call(ed.lock(request('/_caracms/lock', { tab: 'tab-aoife-a', body: { action: 'release', file: HOME } }), aoife));
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-b')).open?.lock?.releasing, true);
	});

	test('check 19: Publish\'s lock and record, and its "published as it stood" notice, show at the next poll; so does its dismissal', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
		await poll(ed, ciaran, 'tab-ciaran-b');
		// Hold the Publish part way, to see its lock from a poll.
		const git = ed.runtime.git;
		const commit = git.commitPending;
		let go!: () => void;
		const held = new Promise<void>((r) => (go = r));
		let reached!: () => void;
		const atCommit = new Promise<void>((r) => (reached = r));
		git.commitPending = async () => {
			reached();
			await held;
			await commit();
		};
		const publishing = publish(ed, aoife);
		await atCommit;
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-b')).publish.running, true, 'the Publish lock');
		go();
		assert.equal((await publishing).body.result, 'published');
		let st = await poll(ed, ciaran, 'tab-ciaran-b');
		assert.equal(st.publish.running, false, 'let go');
		assert.equal(st.publish.record?.commit, w.backend.refs.get('main'), 'the new record');
		const notice = st.notices.find((n) => n.kind === 'published-as-it-stood');
		assert.ok(notice, JSON.stringify(st.notices));
		assert.equal((await call(ed.notice(request('/_caracms/notice', { body: { id: notice.id } }), ciaran))).status, 200);
		st = await poll(ed, ciaran, 'tab-ciaran-b');
		assert.ok(!st.notices.some((n) => n.id === notice.id), 'dismissed');
	});

	test('check 19: a dismissed "draft kept" notice is gone at the next poll', async () => {
		const w = world();
		const ed = await server(w);
		const CONTACT = 'content/pages/contact.json';
		assert.equal((await call(ed.delete(request('/_caracms/delete', { tab: 'tab-aoife-a', body: { collection: 'pages', path: 'contact' } }), aoife))).status, 200);
		const v = JSON.parse(w.backend.file('main', `starter/${CONTACT}`)!);
		v.title = 'Contact us';
		w.backend.push('main', { [`starter/${CONTACT}`]: `${JSON.stringify(v, null, 2)}\n` });
		await ed.runtime.git.check({ force: true });
		await ed.sweep.commitAll();
		let st = await poll(ed, ciaran, 'tab-ciaran-b', null);
		const notice = st.notices.find((n) => n.kind === 'draft-kept');
		assert.ok(notice, JSON.stringify(st.notices));
		assert.equal((await call(ed.notice(request('/_caracms/notice', { body: { id: notice.id } }), ciaran))).status, 200);
		st = await poll(ed, ciaran, 'tab-ciaran-b', null);
		assert.ok(!st.notices.some((n) => n.id === notice.id), 'dismissed');
	});

	test('check 19: the moves a Publish clears are gone from the next poll (an edit to the moved page after it isn\'t a move)', async () => {
		const w = world();
		const ed = await server(w);
		const MOVED = 'content/pages/studio/work.json';
		const moved = await call(handleMove(request('/_caracms/move', { tab: 'tab-aoife-a', body: { collection: 'pages', path: 'work', to: 'studio/work' } }), ed.store, { person: aoife }));
		assert.equal(moved.status, 200, JSON.stringify(moved.body));
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-b', null)).waiting.find((x) => x.file === MOVED)?.movedFrom, '/work');
		assert.equal((await publish(ed, aoife)).body.result, 'published');
		assert.equal((await write(ed, aoife, 'tab-aoife-a', await open(ed, 'studio/work'), 'Work, again')).status, 200);
		const st = await poll(ed, ciaran, 'tab-ciaran-b', null);
		const entry = st.waiting.find((x) => x.file === MOVED);
		assert.equal(entry?.change, 'changed');
		assert.equal(entry?.movedFrom, undefined);
	});
});

describe('the heartbeat only when needed (Decision 6)', () => {
	test('check 14: a tab holding a lock for 5 minutes, active, beats about every 30 s, never every poll, and keeps the lock', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
		await ed.sweep.commitAll(); // no autosave left: only the beats keep it
		const counts = spy(w, 'compareAndSet');
		for (let i = 0; i < 60; i++) {
			w.clock.t += 5 * SEC;
			const st = await poll(ed, aoife, 'tab-aoife-a', HOME, { interval: 5000 });
			assert.equal(st.open?.state, 'yours', `poll ${i}`);
		}
		assert.ok(counts.compareAndSet! >= 9 && counts.compareAndSet! <= 11, `${counts.compareAndSet} beats in 5 minutes`);
	});

	test('a beat whose cached lock is out of date reads Redis again, and still beats', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
		await ed.sweep.commitAll();
		w.clock.t += 20 * SEC;
		await poll(ed, aoife, 'tab-aoife-a');
		// The same tab's lock, changed in Redis behind the cache (a write on the other server).
		const key = `caracms:lock:${HOME}`;
		const lock = JSON.parse((await w.redis.get(key))!);
		await w.redis.set(key, JSON.stringify({ ...lock, since: lock.since - 1 }));
		w.clock.t += 11 * SEC; // the beat is 31 s old; the cache only 11 s
		const counts = spy(w, 'compareAndSet', 'get');
		await poll(ed, aoife, 'tab-aoife-a');
		assert.equal(counts.compareAndSet, 2, 'the cached record lost, the re-read one won');
		assert.equal(JSON.parse((await w.redis.get(key))!).beat, w.clock.t);
	});

	test('check 21: a tab whose pagehide marked its lock releasing and which polls again still holds it after the grace', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
		await ed.sweep.commitAll();
		await poll(ed, aoife, 'tab-aoife-a');
		await call(ed.lock(request('/_caracms/lock', { tab: 'tab-aoife-a', body: { action: 'release', file: HOME } }), aoife));
		w.clock.t += 1 * SEC;
		await poll(ed, aoife, 'tab-aoife-a'); // back from the back-forward cache
		w.clock.t += RELEASE_GRACE_MS + SEC;
		const st = await poll(ed, aoife, 'tab-aoife-a');
		assert.equal(st.open?.state, 'yours');
		assert.equal(st.open?.lock?.releasing, false);
		assert.equal((await poll(ed, ciaran, 'tab-ciaran-b')).open?.state, 'theirs', 'and to someone else');
	});

	test('check 13: a tab idle for 20 minutes with an unsent autosave still holds its lock, and its person still shows on the document', async () => {
		const w = world();
		const ed = await server(w);
		await write(ed, aoife, 'tab-aoife-a', await open(ed), 'Typing');
		const start = w.clock.t;
		while (w.clock.t - start < 20 * MIN) {
			w.clock.t += 30 * SEC;
			await poll(ed, aoife, 'tab-aoife-a', HOME, { input: w.clock.t - start, interval: 30_000 });
			const st = await poll(ed, ciaran, 'tab-ciaran-b', HOME, { interval: 5000 });
			assert.equal(st.open?.lock?.person.email, aoife.email, `at ${(w.clock.t - start) / SEC} s`);
			assert.ok(onDoc(st, HOME, aoife), `on the page at ${(w.clock.t - start) / SEC} s`);
		}
	});
});

describe('presence holds from the tab\'s interval (Decision 9)', () => {
	test('check 11: a 30-second tab stays on its document to another editor the whole time', async () => {
		const w = world();
		const ed = await server(w);
		const start = w.clock.t;
		let next = start;
		for (let t = start; t <= start + 3 * MIN; t += 5 * SEC) {
			w.clock.t = t;
			if (t >= next) {
				await poll(ed, ciaran, 'tab-ciaran-b', ABOUT, { interval: 30_000 });
				next = t + 30 * SEC;
			}
			assert.ok(onDoc(await poll(ed, aoife, 'tab-aoife-a', HOME, { interval: 5000 }), ABOUT, ciaran), `at ${(t - start) / SEC} s`);
		}
	});

	test('check 11: a 5-second tab survives one poll answered 5 seconds late', async () => {
		const w = world();
		const ed = await server(w);
		const start = w.clock.t;
		const theirs = [0, 5, 10, 20, 25].map((s) => start + s * SEC); // the poll due at 15 s comes at 20
		for (let t = start; t <= start + 25 * SEC; t += SEC) {
			w.clock.t = t;
			if (theirs.includes(t)) await poll(ed, ciaran, 'tab-ciaran-b', ABOUT, { interval: 5000 });
			assert.ok(onDoc(await poll(ed, aoife, 'tab-aoife-a', HOME, { interval: 5000 }), ABOUT, ciaran), `at ${(t - start) / SEC} s`);
		}
	});

	for (const [interval, hold] of [
		[5000, 13],
		[30_000, 63],
	] as const) {
		test(`check 12: a closed ${interval / SEC}-second tab that sent no release drops out within its hold (${hold} s) plus one poll`, async () => {
			const w = world();
			const ed = await server(w);
			await poll(ed, ciaran, 'tab-ciaran-b', ABOUT, { interval });
			const closed = w.clock.t;
			w.clock.t = closed + (hold - 1) * SEC;
			assert.ok(onDoc(await poll(ed, aoife, 'tab-aoife-a'), ABOUT, ciaran), 'still on, inside its hold');
			w.clock.t = closed + (hold + 5) * SEC;
			assert.ok(!onDoc(await poll(ed, aoife, 'tab-aoife-a'), ABOUT, ciaran), 'gone after it');
		});
	}

	test('check 20: a poll without the interval parameter, or with one that isn\'t a number, is a 5-second tab', async () => {
		for (const q of ['', '&interval=soon']) {
			const w = world();
			const ed = await server(w);
			await ed.status(request(`/_caracms/status?file=${encodeURIComponent(ABOUT)}${q}`, { tab: 'tab-ciaran-b' }), ciaran);
			const at = w.clock.t;
			w.clock.t = at + 12 * SEC;
			assert.ok(onDoc(await poll(ed, aoife, 'tab-aoife-a'), ABOUT, ciaran), `held 13 s (${q || 'none'})`);
			w.clock.t = at + 14 * SEC;
			assert.ok(!onDoc(await poll(ed, aoife, 'tab-aoife-a'), ABOUT, ciaran), `and no longer (${q || 'none'})`);
		}
	});
});

describe('StatusCache', () => {
	test('a write that lands while its entry is being read is kept for that read, but the next read goes to Redis', async () => {
		const clock = { t: 0 };
		const redis = memoryRedis({ now: () => clock.t });
		await redis.set('k', 'old');
		const batch = redis.batch.bind(redis);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let gated = true;
		redis.batch = (async (commands: never) => {
			const replies = await batch(commands);
			if (gated) await gate;
			return replies;
		}) as typeof redis.batch;
		const cache = new StatusCache({ redis, maxAgeMs: 30_000, now: () => clock.t });
		const reading = cache.read({ strings: ['k'] });
		await redis.set('k', 'new');
		cache.string('k', 'new');
		release();
		gated = false;
		assert.equal((await reading).string('k'), 'old', 'what the read brought back');
		redis.calls = 0;
		assert.equal((await cache.read({ strings: ['k'] })).string('k'), 'new');
		assert.equal(redis.calls, 1, 'read again at once, not 30 s later');
		assert.equal((await cache.read({ strings: ['k'] })).string('k'), 'new');
		assert.equal(redis.calls, 1, 'and then held');
	});

	test('a refresh that fails caches nothing, and every poll waiting on it fails with it', async () => {
		const redis = memoryRedis();
		let fail = true;
		const batch = redis.batch.bind(redis);
		redis.batch = (async (commands: never) => {
			if (fail) throw new RedisUnavailableError('down', 'ECONNREFUSED');
			return batch(commands);
		}) as typeof redis.batch;
		const cache = new StatusCache({ redis, maxAgeMs: 30_000, now: () => 0 });
		const both = await Promise.allSettled([cache.read({ hashes: ['h'] }), cache.read({ hashes: ['h'] })]);
		assert.deepEqual(both.map((r) => r.status), ['rejected', 'rejected']);
		fail = false;
		await redis.hset('h', { a: '1' });
		assert.deepEqual([...(await cache.read({ hashes: ['h'] })).hash('h')], [['a', '1']]);
	});
});
