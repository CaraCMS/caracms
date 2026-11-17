// `main` rolled back by a force-push (caracms-cloud adversarial review, force-push note):
// a check that finds `main` without the last Publish's commit logs it and leaves every
// editor a note; a push on top, a merge or a `git revert` never does. The note goes with
// the next Publish, once nothing is waiting, or when `main` has the commit again. On the
// in-memory GitHub, the Redis stand-in and a fake clock.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import type { StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, MAIN_ROLLED_BACK_MESSAGE, MAIN_ROLLED_BACK_TITLE } from '../src/live/editor.ts';
import { LiveGit } from '../src/live/git.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis, type MemoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { siteRoot, variant } from './helpers/site.ts';

const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const HOME = 'content/pages/index.json';
const ABOUT = 'content/pages/about.json';
const PAGE = 'starter/src/Page.astro';
const ORIGIN = 'http://site.test';

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
	if (!w.backend.refs.has('main')) w.backend.seed([...(await siteFiles(site)), { path: PAGE, contents: 'page\n' }]);
}

async function gitOn(w: World): Promise<LiveGit> {
	await seed(w);
	const git = new LiveGit({ backend: w.backend, site, redis: w.redis, now: () => w.clock.t, log: (line) => w.logs.push(line), runningCommit: () => null, sleep: async () => {} });
	await git.start();
	return git;
}

const edit = (text: string, patch: (v: Record<string, unknown>) => void) => {
	const v = JSON.parse(text);
	patch(v);
	return `${JSON.stringify(v, null, 2)}\n`;
};

const rolledLogs = (w: World) => w.logs.filter((l) => l.startsWith('MAIN WAS ROLLED BACK:'));

/** `main`'s head and tree now. */
const mainHead = async (w: World) => (await w.backend.readHeads()).main;

/** An edit to `file`, published: returns `main` from before that Publish. */
async function publishOne(w: World, git: LiveGit, title: string, file = HOME): Promise<string> {
	const before = w.backend.refs.get('main')!;
	const text = git.read(file)!;
	await git.commitDrafts([{ file, base: text, text: edit(text, (v) => (v.title = title)), editor: aoife }]);
	assert.equal((await git.publish(aoife)).kind, 'published');
	return before;
}

describe('force-push note: main rolled back past the last Publish', () => {
	test('a force-push back to before the Publish: one loud log line, and the note', async () => {
		const w = world();
		const git = await gitOn(w);
		const main0 = await publishOne(w, git, 'Published, then rolled back');
		const published = w.backend.refs.get('main')!;
		assert.equal(git.mainRolledBack(), null);

		w.backend.refs.set('main', main0); // git reset --hard <before>; git push --force
		await git.check({ force: true });
		const note = git.mainRolledBack();
		assert.ok(note, 'warned');
		assert.equal(note.publish, published);
		assert.equal(note.main, main0);
		assert.equal(rolledLogs(w).length, 1);
		assert.ok(rolledLogs(w)[0]!.includes(published.slice(0, 7)));
		assert.deepEqual(git.waiting().map((x) => x.file), [HOME], 'what was rolled back is waiting (nothing works out which it is)');

		// Checks after that say nothing new.
		w.clock.t += 2 * 60_000;
		await git.check({ force: true });
		assert.ok(git.mainRolledBack());
		assert.equal(rolledLogs(w).length, 1, 'logged once');
		assert.ok(await w.redis.get(git.mainRolledBackKey), 'kept in Redis');
	});

	test('a force-push to a rewritten history (not an ancestor) is warned too', async () => {
		const w = world();
		const git = await gitOn(w);
		const { tree } = await mainHead(w);
		const main0 = await publishOne(w, git, 'Published');
		// A developer's amended or rebased main: a new commit on the old base, without the Publish.
		const rewritten = await w.backend.createCommit(tree, [main0], 'Rewritten');
		w.backend.refs.set('main', rewritten);
		await git.check({ force: true });
		assert.ok(git.mainRolledBack());
	});

	test('a developer push on top of the Publish commit: no note', async () => {
		const w = world();
		const git = await gitOn(w);
		await publishOne(w, git, 'Published');
		w.backend.push('main', { [PAGE]: 'page 2\n' });
		await git.check({ force: true });
		w.backend.push('main', { [PAGE]: 'page 3\n' });
		await git.check({ force: true });
		assert.equal(git.mainRolledBack(), null);
		assert.equal(rolledLogs(w).length, 0);
		assert.equal(await w.redis.get(git.mainRolledBackKey), null);
	});

	test('a push to main while edits wait (main and drafts diverge, then merge): no note', async () => {
		const w = world();
		const git = await gitOn(w);
		await publishOne(w, git, 'Published');
		const about = git.read(ABOUT)!;
		await git.commitDrafts([{ file: ABOUT, base: about, text: edit(about, (v) => (v.title = 'Waiting')), editor: aoife }]);
		w.backend.push('main', { [PAGE]: 'page 2\n' });
		const r = await git.check({ force: true });
		assert.equal(r.kind, 'merged');
		assert.equal(git.mainRolledBack(), null);
		assert.equal(rolledLogs(w).length, 0);
	});

	test('a branch merged into main (a merge commit): no note', async () => {
		const w = world();
		const git = await gitOn(w);
		const base = await mainHead(w);
		await publishOne(w, git, 'Published');
		const { commit: head, tree: headTree } = await mainHead(w);
		// A feature branch off the Publish's parent, merged with a merge commit.
		const featureTree = await w.backend.createTree(base.tree, [], [{ path: PAGE, contents: 'feature\n' }]);
		const feature = await w.backend.createCommit(featureTree, [base.commit], 'A feature');
		const mergedTree = await w.backend.createTree(headTree, [], [{ path: PAGE, contents: 'feature\n' }]);
		const merge = await w.backend.createCommit(mergedTree, [head, feature], 'Merge branch feature');
		w.backend.refs.set('main', merge);
		await git.check({ force: true });
		assert.equal(git.mainRolledBack(), null);
		assert.equal(rolledLogs(w).length, 0);
	});

	test('git revert of the Publish (a new commit on top): no note, and nothing is waiting', async () => {
		const w = world();
		const git = await gitOn(w);
		const main0 = await publishOne(w, git, 'Published, then reverted');
		const [old] = await w.backend.readFiles([{ commit: main0, path: `starter/${HOME}` }]);
		w.backend.push('main', { [`starter/${HOME}`]: old! }, 'Revert "Publish"');
		await git.check({ force: true });
		assert.equal(git.mainRolledBack(), null);
		assert.equal(rolledLogs(w).length, 0);
		assert.deepEqual(git.waiting(), [], 'drafts fast-forwarded onto the revert');
	});

	test('the note goes with the next Publish, here and in Redis', async () => {
		const w = world();
		const git = await gitOn(w);
		const main0 = await publishOne(w, git, 'Rolled back');
		w.backend.refs.set('main', main0);
		await git.check({ force: true });
		assert.ok(git.mainRolledBack());
		assert.equal((await git.publish(aoife)).kind, 'published');
		assert.equal(git.mainRolledBack(), null);
		assert.equal(await w.redis.get(git.mainRolledBackKey), null);
		await git.check({ force: true });
		assert.equal(git.mainRolledBack(), null, 'main has the new Publish');
	});

	test('the note goes once nothing is waiting (all of it discarded), and a later edit doesn\'t bring it back', async () => {
		const w = world();
		const git = await gitOn(w);
		const main0 = await publishOne(w, git, 'Rolled back');
		w.backend.refs.set('main', main0);
		await git.check({ force: true });
		assert.ok(git.mainRolledBack());

		await git.restoreDrafts([HOME], ['Home'], aoife);
		assert.deepEqual(git.waiting(), []);
		assert.equal(git.mainRolledBack(), null, 'gone at once');

		// A new edit after that is new: no note again, on this server or a new one.
		const about = git.read(ABOUT)!;
		await git.commitDrafts([{ file: ABOUT, base: about, text: edit(about, (v) => (v.title = 'New since')), editor: aoife }]);
		w.clock.t += 2 * 60_000;
		await git.check({ force: true });
		assert.equal(git.mainRolledBack(), null);
		const restarted = await gitOn(w);
		assert.equal(restarted.mainRolledBack(), null, 'kept as done with in Redis');
		assert.equal(rolledLogs(w).length, 1);
	});

	test('main pushed back to the Publish commit: the note goes', async () => {
		const w = world();
		const git = await gitOn(w);
		const main0 = await publishOne(w, git, 'Rolled back');
		const published = w.backend.refs.get('main')!;
		w.backend.refs.set('main', main0);
		await git.check({ force: true });
		assert.ok(git.mainRolledBack());
		w.backend.refs.set('main', published);
		await git.check({ force: true });
		assert.equal(git.mainRolledBack(), null);
		assert.equal(await w.redis.get(git.mainRolledBackKey), null);
	});

	test('a server starting after the rollback finds it too; no Publish yet: no note', async () => {
		const w = world();
		const fresh = await gitOn(w);
		assert.equal(fresh.mainRolledBack(), null, 'nothing published, nothing to compare');
		const main0 = await publishOne(w, fresh, 'Rolled back');
		w.backend.refs.set('main', main0);
		const started = await gitOn(w);
		assert.ok(started.mainRolledBack(), 'at start');
	});

	test('every editor sees the note in the status poll', async () => {
		const w = world();
		await seed(w);
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
		const log = (line: string) => w.logs.push(line);
		const rt = await createLiveRuntime({ site, settings, backend: w.backend, redis: w.redis, now: () => w.clock.t, log, runningCommit: () => null });
		const ed = await createLiveEditor(rt, { log, sleep: async () => {}, schedule: () => () => {} });
		const poll = async () => {
			const res = await ed.status(new Request(`${ORIGIN}/_caracms/status`, { headers: { origin: ORIGIN, 'x-caracms-tab': 'tab-1' } }), aoife);
			return (await res.json()) as StatusResponse;
		};
		const main0 = await publishOne(w, rt.git, 'Rolled back');
		assert.equal((await poll()).mainRolledBack, null);
		w.backend.refs.set('main', main0);
		await rt.git.check({ force: true });
		const st = await poll();
		assert.equal(st.mainRolledBack?.title, MAIN_ROLLED_BACK_TITLE);
		assert.equal(st.mainRolledBack?.message, MAIN_ROLLED_BACK_MESSAGE);
		assert.equal(MAIN_ROLLED_BACK_TITLE, 'The live site was rolled back on GitHub');
		assert.match(MAIN_ROLLED_BACK_MESSAGE, /include what was rolled back, and publishing will put it back\. Discard what you don't want first/);
	});
});
