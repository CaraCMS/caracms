// What live mode does when the world around it breaks (caracms-cloud adversarial review,
// findings 4, 5 and 6; the review's proofs, turned round into regression tests): GitHub
// access lost while edits wait, the `drafts` branch deleted on GitHub, and Redis dropping
// out in the middle of a Publish. On the in-memory GitHub, the Redis stand-in and a fake
// clock; the sweep's timer is driven by hand.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import type { SiteDocument } from '../src/document.ts';
import type { OpenedDocument, StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend, type Branch } from '../src/live/backend.ts';
import { COMMIT_TROUBLE_MESSAGE, createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { COMMIT_TROUBLE_AFTER, LiveGit } from '../src/live/git.ts';
import { HttpError, Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis, RedisUnavailableError, type MemoryRedis, type RedisClient } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { siteRoot, variant } from './helpers/site.ts';

const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const HOME = 'content/pages/index.json';
const ORIGIN = 'http://site.test';
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
const WEEK = 7 * DAY;

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
	logs: string[];
}

function world(): World {
	const clock = { t: Date.parse('2026-10-27T10:00:00Z') };
	return { clock, backend: new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t }), redis: memoryRedis({ now: () => clock.t }), logs: [] };
}

async function seed(w: World) {
	if (!w.backend.refs.has('main')) w.backend.seed([...(await siteFiles(site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
}

/** A server: a runtime and its live editor on the world's backend and Redis. */
async function server(w: World, options: { redis?: RedisClient } = {}): Promise<LiveEditor> {
	await seed(w);
	const now = () => w.clock.t;
	const log = (line: string) => w.logs.push(line);
	const rt = await createLiveRuntime({ site, settings, backend: w.backend, redis: options.redis ?? w.redis, now, log, runningCommit: () => null });
	return createLiveEditor(rt, { log, sleep: async () => {}, schedule: () => () => {} });
}

/** The git layer alone, started. */
async function gitOn(w: World): Promise<LiveGit> {
	await seed(w);
	const git = new LiveGit({ backend: w.backend, site, redis: w.redis, now: () => w.clock.t, log: (line) => w.logs.push(line), runningCommit: () => null, sleep: async () => {} });
	await git.start();
	return git;
}

/** Redis that refuses every command while `down.on` is set, as Railway's does mid-restart. */
function flaky(redis: MemoryRedis): { redis: RedisClient; down: { on: boolean } } {
	const down = { on: false };
	const wrapped = new Proxy(redis, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver) as unknown;
			if (typeof value !== 'function' || prop === 'close') return value;
			return (...args: unknown[]) => (down.on ? Promise.reject(new RedisUnavailableError("Redis didn't answer (stream isn't writeable).", 'EPIPE')) : (value as (...a: unknown[]) => unknown).apply(target, args));
		},
	});
	return { redis: wrapped as RedisClient, down };
}

const clone = (d: SiteDocument): SiteDocument => JSON.parse(JSON.stringify(d));
const open = async (ed: LiveEditor, path = 'index') => (await ed.store.read('pages', path)) as OpenedDocument;
const intro = (text: string) => JSON.parse(text).blocks[0].intro as string;
const onBranch = (w: World, branch: Branch, file = HOME) => w.backend.file(branch, `starter/${file}`)!;

function request(path: string, init: { tab?: string; body?: unknown } = {}) {
	const headers: Record<string, string> = { origin: ORIGIN };
	if (init.tab) headers['x-caracms-tab'] = init.tab;
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return new Request(`${ORIGIN}${path}`, { method: init.body === undefined ? 'GET' : 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

async function write(ed: LiveEditor, tab: string, opened: OpenedDocument, text: string, person = aoife) {
	const document = clone(opened.document);
	document.blocks[0]!.data.intro = text;
	const res = await ed.write(request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document } }), person);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function poll(ed: LiveEditor, tab: string, person = aoife): Promise<StatusResponse> {
	const res = await ed.status(request(`/_caracms/status?file=${encodeURIComponent(HOME)}`, { tab }), person);
	assert.equal(res.status, 200, await res.clone().text());
	return (await res.json()) as StatusResponse;
}

async function publish(ed: LiveEditor, person = aoife) {
	const res = await ed.publish(request('/_caracms/publish', { tab: 'tab-aoife-1', body: {} }), person);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> & { result?: string; error?: string; publish?: StatusResponse['publish'] } };
}

const edit = (text: string, patch: (v: Record<string, unknown>) => void) => {
	const v = JSON.parse(text);
	patch(v);
	return `${JSON.stringify(v, null, 2)}\n`;
};

/** GitHub refuses every draft commit (an expired token, an uninstalled App) until `refusing.on` is cleared. */
function refuseCommits(w: World): { on: boolean } {
	const refusing = { on: true };
	w.backend.beforeRequest = async (endpoint) => {
		if (refusing.on && endpoint === 'graphql createCommitOnBranch') throw new HttpError(401, 'graphql createCommitOnBranch -> 401: Bad credentials', null);
	};
	return refusing;
}

describe('finding 4: an edit that hasn\'t reached GitHub never expires', () => {
	test('commits fail for more than a week: the edit is still there; once it\'s committed, its record expires a week later as before', async () => {
		const w = world();
		const ed = await server(w);
		const refusing = refuseCommits(w);
		w.backend.access = { kind: 'refused', credential: 'token' };

		const opened = await open(ed);
		const before = intro(opened.text);
		assert.equal((await write(ed, 'tab-aoife-1', opened, 'Typed while GitHub refuses the site')).status, 200);
		assert.equal(await w.redis.pttl(ed.autosaves.key(HOME)), -1, 'the autosave has no expiry');

		// Nobody touches it again, and every tick fails, for well over a week.
		w.clock.t += 61 * SEC;
		await assert.rejects(ed.sweep.tick(), /401/);
		for (let day = 1; day <= 9; day++) {
			w.clock.t += DAY;
			await assert.rejects(ed.sweep.tick(), /401/);
		}
		assert.ok(await ed.autosaves.get(HOME), 'the autosave is still in Redis');
		assert.equal(intro((await open(ed)).text), 'Typed while GitHub refuses the site', 'the document still reads as edited');
		assert.equal((await poll(ed, 'tab-aoife-1')).waiting.find((x) => x.file === HOME)?.uncommitted, true, 'and it waits to publish');
		assert.equal(intro(onBranch(w, 'drafts')), before, 'nothing reached drafts yet');

		// The developer fixes the token: the next tick commits it, and the autosave goes.
		refusing.on = false;
		w.backend.access = null;
		const r = await ed.sweep.tick();
		assert.ok(r.commit, 'committed');
		assert.equal(intro(onBranch(w, 'drafts')), 'Typed while GitHub refuses the site');
		assert.equal(await ed.autosaves.get(HOME), null, 'the autosave went with the commit');
		const committedKey = `caracms:committed:${HOME}`;
		const left = await w.redis.pttl(committedKey);
		assert.ok(left > WEEK - MIN && left <= WEEK, `the committed record expires in a week (${left} ms)`);
		w.clock.t += WEEK + MIN;
		assert.equal(await w.redis.get(committedKey), null, 'and then it has');
		assert.equal(intro(onBranch(w, 'drafts')), 'Typed while GitHub refuses the site', 'the edit is on drafts for good');
	});

	test('an autosave an older version left with a week\'s expiry loses it when a server starts', async () => {
		const w = world();
		const ed = await server(w);
		const opened = await open(ed);
		await write(ed, 'tab-aoife-1', opened, 'Kept by 0.8.0');
		const key = ed.autosaves.key(HOME);
		await w.redis.pexpire(key, WEEK); // as 0.8.0 wrote it
		refuseCommits(w);
		await server(w); // a deploy: the new server's startup check
		assert.equal(await w.redis.pttl(key), -1);
		assert.equal(intro((await open(ed)).text), 'Kept by 0.8.0');
	});
});

describe('finding 4: the save bar\'s warning while commits keep failing', () => {
	test(`after ${COMMIT_TROUBLE_AFTER} failed commits in a row the status says so; the next commit that goes through clears it`, async () => {
		const w = world();
		const ed = await server(w);
		const refusing = refuseCommits(w);
		await write(ed, 'tab-aoife-1', await open(ed), 'Not reaching GitHub');
		assert.equal((await poll(ed, 'tab-aoife-1')).commitTrouble, null, 'Kept, before any commit is tried');

		w.clock.t += 61 * SEC;
		for (let i = 1; i < COMMIT_TROUBLE_AFTER; i++) {
			await assert.rejects(ed.sweep.tick(), /401/);
			assert.equal((await poll(ed, 'tab-aoife-1')).commitTrouble, null, `still Kept after ${i} failure(s): one blip doesn't warn`);
			w.clock.t += 30 * SEC;
		}
		const failedAt = w.clock.t;
		await assert.rejects(ed.sweep.tick(), /401/);
		const st = await poll(ed, 'tab-aoife-1');
		assert.ok(st.commitTrouble, 'the warning');
		assert.equal(st.commitTrouble.failures, COMMIT_TROUBLE_AFTER);
		assert.equal(st.commitTrouble.message, COMMIT_TROUBLE_MESSAGE);
		assert.match(st.commitTrouble.message, /^Saved here, but not reaching GitHub\. Ask your developer to check the site's GitHub access\.$/);
		assert.ok(Date.parse(st.commitTrouble.since) < failedAt, 'since the first failure');
		assert.ok(w.logs.some((l) => l.includes(`failed ${COMMIT_TROUBLE_AFTER} times in a row`)), 'logged once it shows');

		refusing.on = false;
		w.clock.t += 30 * SEC;
		assert.ok((await ed.sweep.tick()).commit);
		assert.equal((await poll(ed, 'tab-aoife-1')).commitTrouble, null, 'cleared by the commit');
	});

	test('one failure, then a commit: never shown, and the count starts again', async () => {
		const w = world();
		const ed = await server(w);
		const refusing = refuseCommits(w);
		await write(ed, 'tab-aoife-1', await open(ed), 'A blip');
		w.clock.t += 61 * SEC;
		await assert.rejects(ed.sweep.tick(), /401/);
		await assert.rejects(ed.sweep.tick(), /401/);
		refusing.on = false;
		assert.ok((await ed.sweep.tick()).commit);
		refusing.on = true;
		await write(ed, 'tab-aoife-1', await open(ed), 'Another blip');
		w.clock.t += 61 * SEC;
		await assert.rejects(ed.sweep.tick(), /401/);
		assert.equal((await poll(ed, 'tab-aoife-1')).commitTrouble, null, 'two failures, a success, one failure: no warning');
	});
});

describe('finding 5: the drafts branch deleted on GitHub', () => {
	test('a restart makes drafts again from its recorded head: nothing unpublished is lost', async () => {
		const w = world();
		const git = await gitOn(w);
		const home = git.read(HOME)!;
		const r = await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Unpublished for a week')), editor: aoife }]);
		assert.ok(r.commit);
		assert.equal(await w.redis.get(git.draftsHeadKey), r.commit, 'every commit the server makes to drafts is recorded');

		w.backend.refs.delete('drafts'); // a branch tidy-up
		const restarted = await gitOn(w);
		assert.equal(w.backend.refs.get('drafts'), r.commit, 'drafts is back where it was');
		assert.equal(JSON.parse(restarted.read(HOME)!).title, 'Unpublished for a week');
		assert.deepEqual(restarted.waiting().map((x) => x.file), [HOME], 'still waiting to publish');
		assert.equal(restarted.draftsLost(), null, 'nothing lost, nothing to show');
		assert.ok(w.logs.some((l) => l.includes(`made it again from its last recorded head (${r.commit})`)), 'and the log says what it did');
	});

	test('the merge from main and Publish record the head too', async () => {
		const w = world();
		const git = await gitOn(w);
		assert.equal(await w.redis.get(git.draftsHeadKey), w.backend.refs.get('drafts'), 'recorded at start');
		w.backend.push('main', { 'starter/src/Page.astro': 'page 2\n' });
		await git.check({ force: true });
		assert.equal(await w.redis.get(git.draftsHeadKey), w.backend.refs.get('drafts'), 'after a fast-forward');
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Out')), editor: aoife }]);
		assert.equal((await git.publish(aoife)).kind, 'published');
		assert.equal(await w.redis.get(git.draftsHeadKey), w.backend.refs.get('drafts'), 'after a Publish');
	});

	test('the recorded commit is gone from GitHub: drafts is made from main, the lost sha is logged, and every editor is told until the next Publish', async () => {
		const w = world();
		const git = await gitOn(w);
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Gone for good')), editor: aoife }]);
		w.backend.refs.delete('drafts');
		const lost = 'f'.repeat(40); // a head GitHub no longer has (garbage-collected)
		await w.redis.set(git.draftsHeadKey, lost);

		const ed = await server(w);
		assert.equal(w.backend.refs.get('drafts'), w.backend.refs.get('main'), 'made from main');
		assert.ok(w.logs.some((l) => l.startsWith('UNPUBLISHED CHANGES LOST:') && l.includes(lost)), 'a loud log line naming the lost sha');
		const st = await poll(ed, 'tab-aoife-1');
		assert.ok(st.draftsLost, 'the editor shows it');
		assert.equal(st.draftsLost.commit, lost);
		assert.equal(st.draftsLost.title, 'Unpublished changes were lost');
		assert.match(st.draftsLost.message, /The drafts branch went missing on GitHub and its last commit \(fffffff\) couldn't be found/);
		assert.match(st.draftsLost.message, /protect the drafts branch from deletion/);

		// Another server starting (a deploy) still shows it: it's kept in Redis for a week.
		const other = await server(w);
		assert.equal((await poll(other, 'tab-aoife-2')).draftsLost?.commit, lost);

		// A Publish is the team carrying on: the note goes, here and in Redis.
		await write(ed, 'tab-aoife-1', await open(ed), 'Carrying on');
		assert.equal((await publish(ed)).body.result, 'published');
		assert.equal((await poll(ed, 'tab-aoife-1')).draftsLost, null);
		assert.equal(await w.redis.get(git.draftsLostKey), null);
	});

	test('no head recorded on a site that has published: the log and the editor say none was', async () => {
		const w = world();
		const git = await gitOn(w);
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Published')), editor: aoife }]);
		await git.publish(aoife);
		w.backend.refs.delete('drafts');
		await w.redis.del(git.draftsHeadKey); // say, written before 0.8.1, or Redis flushed

		const ed = await server(w);
		assert.ok(w.logs.some((l) => l.startsWith('UNPUBLISHED CHANGES LOST:') && l.includes('no head of it was recorded')));
		const st = await poll(ed, 'tab-aoife-1');
		assert.equal(st.draftsLost?.commit, null);
		assert.match(st.draftsLost?.message ?? '', /no record of its last commit was kept/);
	});

	test('a site\'s first start (no drafts, no record, nothing published) is quiet, as before', async () => {
		const w = world();
		const ed = await server(w);
		assert.ok(w.backend.refs.has('drafts'));
		assert.ok(w.logs.some((l) => l.startsWith('no drafts branch yet: created it from main')));
		assert.ok(!w.logs.some((l) => l.includes('LOST')));
		assert.equal((await poll(ed, 'tab-aoife-1')).draftsLost, null);
	});

	test('Redis out at a start that finds drafts missing: the start fails rather than make drafts from main', async () => {
		const w = world();
		const git = await gitOn(w);
		const home = git.read(HOME)!;
		const r = await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Not yet')), editor: aoife }]);
		w.backend.refs.delete('drafts');
		const { redis, down } = flaky(w.redis);
		down.on = true;
		const restarting = new LiveGit({ backend: w.backend, site, redis, now: () => w.clock.t, log: (line) => w.logs.push(line), runningCommit: () => null });
		await assert.rejects(restarting.start(), RedisUnavailableError);
		assert.equal(w.backend.refs.has('drafts'), false, 'drafts not made from main');
		down.on = false;
		await restarting.start();
		assert.equal(w.backend.refs.get('drafts'), r.commit, 'the next start puts it back');
	});
});

describe('finding 6: Redis dropping out during a Publish', () => {
	test('the refs move, then Redis is gone: the answer is published, with the record made in memory; the notices are logged as not sent', async () => {
		const w = world();
		const { redis, down } = flaky(w.redis);
		const ed = await server(w, { redis });
		await write(ed, 'tab-aoife-1', await open(ed), 'Going live');
		await poll(ed, 'tab-ciaran-1', ciaran); // Ciarán has Home open: he'd get a "published as it stood" notice
		const mainBefore = w.backend.refs.get('main')!;

		// Redis goes the moment GitHub's refs have moved.
		const updateRefs = w.backend.updateRefs.bind(w.backend);
		w.backend.updateRefs = async (updates) => {
			await updateRefs(updates);
			down.on = true;
		};
		const r = await publish(ed);
		down.on = false;

		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.result, 'published');
		const main = w.backend.refs.get('main')!;
		assert.notEqual(main, mainBefore);
		assert.equal(intro(onBranch(w, 'main')), 'Going live', 'it went out');
		assert.equal(r.body.publish?.record?.commit, main, 'the answer carries the record');
		assert.ok(w.logs.some((l) => l.startsWith(`published ${main.slice(0, 7)}, but what follows a publish in Redis didn't all happen`)));
		assert.ok(w.logs.some((l) => l.includes('"published as it stood" notices weren\'t sent')));

		// Redis back: the status shows this publish (from the server's memory: Redis never took the record).
		assert.equal(await w.redis.get('caracms:publish:last'), null);
		const st = await poll(ed, 'tab-aoife-1');
		assert.equal(st.publish.record?.commit, main);
		assert.notEqual(st.publish.state, 'none');
		assert.equal((await ed.runtime.git.lastPublish())?.commit, main);
		// The Publish lock couldn't be let go with Redis gone: it lapses by itself (`publishLockMs`).
		w.clock.t += DEFAULT_TIMINGS.publishLockMs + SEC;
		assert.equal((await publish(ed)).body.result, 'nothing-waiting', 'and a second press has nothing to do');
	});

	test('Redis out before the refs move: its own sentence, not the write route\'s, and nothing went out', async () => {
		const w = world();
		const { redis, down } = flaky(w.redis);
		const ed = await server(w, { redis });
		await write(ed, 'tab-aoife-1', await open(ed), 'Not yet');
		const mainBefore = w.backend.refs.get('main');
		down.on = true;
		const r = await publish(ed);
		down.on = false;
		assert.equal(r.status, 503);
		assert.equal(r.body.code, 'unavailable');
		assert.match(r.body.error ?? '', /^The server can't reach its store right now, so it couldn't publish\. Your changes are still waiting: try again in a minute \(Redis didn't answer/);
		assert.doesNotMatch(r.body.error ?? '', /held in this browser/);
		assert.equal(w.backend.refs.get('main'), mainBefore);
	});
});
