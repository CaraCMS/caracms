// What's waiting, publish status, history and Try again (M4 Decisions 5, 12; Phase 1 → Verify 3 and 4).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { Tracker } from '../src/live/github.ts';
import { LiveGit } from '../src/live/git.ts';
import { draftMessage, mergeMessage, parseMessage, publishMessage } from '../src/live/messages.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { siteFiles } from '../src/live/runtime.ts';
import { publishState, waitingFromCommits, type PublishRecord } from '../src/live/status.ts';
import { siteRoot, variant } from './helpers/site.ts';

const aoife = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran = { email: 'ciaran@example.com', name: 'Ciarán' };
const HOME = 'content/pages/index.json';
const ABOUT = 'content/pages/about.json';

describe('commit messages (the contract, Decision 5)', () => {
	test('a draft commit with two editors, one file shared', () => {
		const { headline, body } = draftMessage([
			{ file: HOME, title: 'Home', editor: aoife },
			{ file: ABOUT, title: 'About', editor: aoife },
			{ file: ABOUT, title: 'About', editor: ciaran },
		]);
		assert.equal(
			`${headline}\n\n${body}`,
			'Draft: Home, About\n\nEdited-by: Aoife <aoife@example.com>: content/pages/index.json, content/pages/about.json\nEdited-by: Ciarán <ciaran@example.com>: content/pages/about.json',
		);
	});

	test('a name is the address\'s local part when there\'s no other', () => {
		assert.match(draftMessage([{ file: HOME, title: 'Home', editor: { email: 'sam@x.test' } }]).body, /^Edited-by: sam <sam@x\.test>: /);
	});

	test('they read back', () => {
		const p = parseMessage(publishMessage(['Home'], [HOME], aoife));
		assert.deepEqual([p.kind, p.titles, p.publishedBy, p.publishedFiles], ['publish', ['Home'], aoife, [HOME]]);
		assert.deepEqual(parseMessage(mergeMessage([ABOUT], [HOME])).keptDraft, [HOME]);
	});
});

describe('commit messages read back by parseMessage (Decision 5: the format is a contract)', () => {
	const kept = 'content/pages/work.json';

	test('a draft commit gives back its titles, each editor with their files, and the kept files', () => {
		const { headline, body } = draftMessage(
			[
				{ file: HOME, title: 'Home', editor: aoife },
				{ file: ABOUT, title: 'About', editor: aoife },
				{ file: ABOUT, title: 'About', editor: ciaran },
				{ file: kept, title: 'Work', editor: ciaran },
			],
			[ABOUT],
		);
		const p = parseMessage(`${headline}\n\n${body}`);
		assert.equal(p.kind, 'draft');
		assert.deepEqual(p.titles, ['Home', 'About', 'Work']);
		assert.deepEqual(p.edits, [
			{ person: aoife, files: [HOME, ABOUT] },
			{ person: ciaran, files: [ABOUT, kept] },
		]);
		assert.deepEqual(p.keptDraft, [ABOUT]);
	});

	test('a person with no other name reads back as the address, with no invented name', () => {
		const { headline, body } = draftMessage([{ file: HOME, title: 'Home', editor: { email: 'sam@x.test' } }]);
		assert.equal(`${headline}\n\n${body}`, 'Draft: Home\n\nEdited-by: sam <sam@x.test>: content/pages/index.json');
		assert.deepEqual(parseMessage(`${headline}\n\n${body}`).edits, [{ person: { email: 'sam@x.test', name: null }, files: [HOME] }]);
	});

	test('names with accents, a colon, a comma or an angle bracket are written safely and read back', () => {
		const odd = { email: 'seán@example.com', name: 'Seán Óg: Main Street, Cork' };
		const bracket = { email: 'bad@x.test', name: 'Mal <script>' };
		const { headline, body } = draftMessage([
			{ file: HOME, title: 'Home', editor: odd },
			{ file: ABOUT, title: 'About', editor: bracket },
		]);
		const p = parseMessage(`${headline}\n\n${body}`);
		assert.deepEqual(p.edits[0], { person: odd, files: [HOME] });
		assert.deepEqual(p.edits[1]!.files, [ABOUT], 'the angle brackets can\'t break the line');
		assert.equal(p.edits[1]!.person.email, 'bad@x.test');
		assert.doesNotMatch(body, /<script>/);
	});

	test('more than five titles: the headline says "and N more", the trailers still list every file', () => {
		const files = Array.from({ length: 8 }, (_, i) => `content/pages/p${i}.json`);
		const { headline, body } = draftMessage(files.map((file, i) => ({ file, title: `Page ${i}`, editor: aoife })));
		assert.equal(headline, 'Draft: Page 0, Page 1, Page 2, Page 3, Page 4 and 3 more');
		const p = parseMessage(`${headline}\n\n${body}`);
		assert.deepEqual(p.titles, ['Page 0', 'Page 1', 'Page 2', 'Page 3', 'Page 4']);
		assert.deepEqual(p.edits, [{ person: aoife, files }]);
	});

	test('a publish and a merge read back, and anything else is "other" with no data', () => {
		const pub = parseMessage(publishMessage(['Home', 'About'], [HOME, ABOUT], ciaran));
		assert.deepEqual([pub.kind, pub.titles, pub.publishedBy, pub.publishedFiles], ['publish', ['Home', 'About'], ciaran, [HOME, ABOUT]]);
		const merge = parseMessage(mergeMessage([kept], [HOME, ABOUT]));
		assert.deepEqual([merge.kind, merge.keptDraft], ['merge', [HOME, ABOUT]]);
		for (const other of ['Fix the hero spacing', 'Update README', 'Merge branch \'feature\'\n\nEdited-by: not <real>: nothing', '']) {
			const p = parseMessage(other);
			assert.equal(p.kind, 'other', other);
			assert.deepEqual([p.titles, p.keptDraft, p.publishedBy], [[], [], null]);
		}
	});
});

describe('waiting, rebuilt from commit messages alone (Verify 4)', () => {
	test('who changed which file, newest first, including two editors on one file', () => {
		const d1 = draftMessage([{ file: HOME, title: 'Home', editor: aoife }]);
		const d2 = draftMessage([
			{ file: ABOUT, title: 'About', editor: aoife },
			{ file: ABOUT, title: 'About', editor: ciaran },
		]);
		const commits = [
			{ sha: 'a', parents: ['m'], message: `${d1.headline}\n\n${d1.body}`, date: '2026-10-14T10:00:00Z' },
			{ sha: 'b', parents: ['a', 'x'], message: mergeMessage(['content/pages/work.json'], [HOME]), date: '2026-10-14T10:05:00Z' },
			{ sha: 'c', parents: ['b'], message: `${d2.headline}\n\n${d2.body}`, date: '2026-10-14T10:10:00Z' },
		];
		const w = waitingFromCommits([HOME, ABOUT, 'content/pages/contact.json'], commits);
		assert.deepEqual(
			w.map((x) => [x.file, x.editors.map((e) => `${e.person.name}@${e.at.slice(11, 16)}`), x.changedAt, x.keptDraft]),
			[
				// Same commit: the later trailer counts as the later change.
				[ABOUT, ['Ciarán@10:10', 'Aoife@10:10'], '2026-10-14T10:10:00Z', false],
				[HOME, ['Aoife@10:00'], '2026-10-14T10:00:00Z', true],
				['content/pages/contact.json', [], null, false],
			],
		);
	});
});

const record = (over: Partial<PublishRecord> = {}): PublishRecord => ({ commit: 'P', by: aoife, at: '2026-10-14T10:00:00Z', files: [HOME], titles: ['Home'], tryAgainAt: null, ...over });

describe('publish status from fixtures (Verify 3)', () => {
	const base = { record: record(), running: 'OLD', runningIncludesPublish: false, laterOnMain: new Set(['L']), deployments: [] };

	test('a stuck in_progress for a later skipped push never reads as failed or finished', () => {
		const facts = { ...base, deployments: [{ sha: 'P', createdAt: '2026-10-14T10:00:05Z', state: 'in_progress' }, { sha: 'L', createdAt: '2026-10-14T10:01:00Z', state: 'in_progress' }] };
		assert.equal(publishState(facts).state, 'publishing');
		// The publish's own deploy failed, then a skipped push left one stuck: failed, from the answer that exists.
		const failed = { ...base, deployments: [{ sha: 'P', createdAt: '2026-10-14T10:00:05Z', state: 'failure' }, { sha: 'L', createdAt: '2026-10-14T10:01:00Z', state: 'in_progress' }] };
		assert.equal(publishState(failed).state, 'failed');
		// It went live, and a later skipped push is stuck: still live.
		assert.equal(publishState({ ...facts, running: 'P' }).state, 'live');
	});

	test('live once the running commit is the publish commit or after it', () => {
		assert.equal(publishState({ ...base, running: 'P' }).state, 'live');
		assert.equal(publishState({ ...base, running: 'L', runningIncludesPublish: true }).state, 'live');
		assert.equal(publishState(base).state, 'publishing');
	});

	test('with no running commit at all: live once the refs moved, flagged as assumed', () => {
		assert.deepEqual(publishState({ ...base, running: null }), { state: 'live', assumed: true });
	});

	test('failure or error on the publish or a later commit fails it; a Try again resets the clock', () => {
		const failed = { ...base, deployments: [{ sha: 'L', createdAt: '2026-10-14T10:02:00Z', state: 'error' }] };
		assert.equal(publishState(failed).state, 'failed');
		assert.equal(publishState({ ...failed, record: record({ tryAgainAt: '2026-10-14T10:03:00Z' }) }).state, 'publishing');
		assert.equal(publishState({ ...base, deployments: [{ sha: 'other', createdAt: '2026-10-14T10:02:00Z', state: 'failure' }] }).state, 'publishing');
	});
});

describe('publish status from fixtures: what counts as an answer (Decision 12)', () => {
	const base = { record: record(), running: 'OLD', runningIncludesPublish: false, laterOnMain: new Set(['L']), deployments: [] };
	const dep = (sha: string, createdAt: string, state: string | null) => ({ sha, createdAt, state });

	test('the newest answer wins: a later success after a failure is not failed', () => {
		const facts = { ...base, deployments: [dep('P', '2026-10-14T10:00:05Z', 'failure'), dep('L', '2026-10-14T10:05:00Z', 'success')] };
		assert.equal(publishState(facts).state, 'publishing', 'the newest answered deployment succeeded, but the running server is not it yet');
		const reverse = { ...base, deployments: [dep('P', '2026-10-14T10:00:05Z', 'success'), dep('L', '2026-10-14T10:05:00Z', 'error')] };
		assert.equal(publishState(reverse).state, 'failed');
	});

	test('only a final status is an answer: in_progress, queued, pending and no status at all never fail a publish', () => {
		for (const state of ['in_progress', 'queued', 'pending', null, 'something-new']) {
			const facts = { ...base, deployments: [dep('P', '2026-10-14T10:00:05Z', state), dep('L', '2026-10-14T10:01:00Z', state)] };
			assert.equal(publishState(facts).state, 'publishing', String(state));
		}
		assert.equal(publishState({ ...base, deployments: [dep('P', '2026-10-14T10:00:05Z', 'inactive')] }).state, 'publishing', 'inactive means replaced, not failed');
	});

	test('a stuck deployment never finishes the publish either: live comes only from the running commit', () => {
		const stuck = { ...base, deployments: [dep('P', '2026-10-14T10:00:05Z', 'in_progress'), dep('P', '2026-10-14T10:00:06Z', 'success')] };
		assert.equal(publishState(stuck).state, 'publishing', 'a success for the publish commit is not "live" until the server runs it');
		assert.equal(publishState({ ...stuck, running: 'P' }).state, 'live');
	});

	test('a deployment for an unrelated or earlier commit does not count', () => {
		assert.equal(publishState({ ...base, deployments: [dep('EARLIER', '2026-10-14T09:00:00Z', 'failure')] }).state, 'publishing');
		assert.equal(publishState({ ...base, deployments: [dep('P', '2026-10-14T09:59:00Z', 'failure')], record: record({ tryAgainAt: '2026-10-14T10:00:00Z' }) }).state, 'publishing', 'older than the last Try again');
	});
});

describe('publish status, history and Try again on the in-memory backend', () => {
	const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);

	async function published(running: { value: string | null }, railwayFetch?: typeof fetch) {
		let t = Date.parse('2026-10-14T10:00:00Z');
		const backend = new MemoryBackend(new Tracker(), { now: () => t });
		backend.seed(await siteFiles(site));
		const logs: string[] = [];
		const git = new LiveGit({
			backend,
			site,
			redis: memoryRedis(),
			now: () => t,
			log: (l) => logs.push(l),
			runningCommit: () => running.value,
			redeployer: railwayFetch ? { kind: 'railway', token: 't', serviceId: 's', environmentId: 'e', fetch: railwayFetch } : null,
		});
		await git.start();
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: home.replace('"title": "Home"', '"title": "Home v2"'), editor: aoife }]);
		const r = await git.publish(aoife);
		assert.equal(r.kind, 'published');
		const commit = r.kind === 'published' ? r.record.commit : '';
		return { backend, git, commit, logs, tick: (ms: number) => (t += ms) };
	}

	test('no deploy pipeline: live at once, logged once', async () => {
		const { git, logs } = await published({ value: null });
		assert.deepEqual([(await git.publishStatus()).state, (await git.publishStatus()).assumed], ['live', true]);
		assert.equal(logs.filter((l) => /no running commit known/.test(l)).length, 1);
	});

	test('publishing until CARACMS_RUNNING_COMMIT moves to it; failed with a failed deployment; Try again', async () => {
		const running = { value: 'unknown-commit' };
		const calls: unknown[] = [];
		const fake = (async (_url: string, init: RequestInit) => {
			calls.push(JSON.parse(String(init.body)));
			return new Response(JSON.stringify({ data: { serviceInstanceRedeploy: true } }), { status: 200 });
		}) as unknown as typeof fetch;
		const { backend, git, commit, tick } = await published(running, fake);
		running.value = backend.info(commit).parents[0]!; // the old server is still running
		assert.equal((await git.publishStatus()).state, 'publishing');
		backend.deployments.push({ id: 1, sha: commit, environment: 'production', createdAt: '2026-10-14T10:00:10Z', statuses: [{ state: 'in_progress', createdAt: '2026-10-14T10:00:10Z' }] });
		tick(11_000);
		assert.equal((await git.publishStatus()).state, 'publishing', 'in_progress is not an answer');
		backend.deployments[0]!.statuses.push({ state: 'failure', createdAt: '2026-10-14T10:01:00Z' });
		tick(11_000);
		const failed = await git.publishStatus();
		assert.deepEqual([failed.state, failed.canTryAgain], ['failed', true]);
		assert.deepEqual(await git.tryAgain(), { ok: true });
		assert.equal(calls.length, 1);
		assert.equal((await git.publishStatus()).state, 'publishing', 'after Try again, the old failure no longer counts');
		running.value = commit;
		assert.equal((await git.publishStatus()).state, 'live');
		// History: the publish, who, which documents, live.
		const history = await git.history({ refresh: true });
		assert.deepEqual(history.map((h) => [h.commit, h.by?.email, h.titles, h.files, h.state]), [[commit, 'aoife@example.com', ['Home v2'], [HOME], 'live']]);
	});

	test('the deployments are read at most every 10 s while a publish is in flight', async () => {
		const running = { value: 'x' };
		const { backend, git, commit, tick } = await published(running);
		running.value = backend.info(commit).parents[0]!;
		await git.publishStatus();
		const n = backend.tracker.records.length;
		await git.publishStatus();
		await git.publishStatus();
		assert.equal(backend.tracker.records.length, n);
		tick(10_001);
		await git.publishStatus();
		assert.ok(backend.tracker.records.length > n);
	});

	test('a deployment stuck in progress is never failed or finished: publishing, then taking longer than usual (runs-anywhere Decision 10)', async () => {
		const running = { value: 'x' };
		const { backend, git, commit, tick } = await published(running);
		running.value = backend.info(commit).parents[0]!;
		backend.deployments.push({ id: 1, sha: commit, environment: 'production', createdAt: '2026-10-14T10:00:10Z', statuses: [{ state: 'in_progress', createdAt: '2026-10-14T10:00:10Z' }] });
		tick(10 * 60_000);
		assert.deepEqual([(await git.publishStatus()).state, (await git.publishStatus()).canTryAgain], ['publishing', false], 'after 10 minutes');
		for (let i = 0; i < 5; i++) {
			tick(10 * 60_000);
			const st = await git.publishStatus();
			assert.deepEqual([st.state, st.canTryAgain], ['slow', false], `after ${(i + 2) * 10} minutes, no redeployer`);
		}
	});

	test('a later commit on main whose deployment fails fails the publish (once the check has taken that push in)', async () => {
		const running = { value: 'x' };
		const { backend, git, commit, tick } = await published(running);
		running.value = backend.info(commit).parents[0]!;
		const pushed = backend.push('main', { 'starter/src/Page.astro': 'later push\n' });
		await git.check({ force: true });
		backend.deployments.push({ id: 2, sha: pushed, environment: 'production', createdAt: '2026-10-14T10:03:00Z', statuses: [{ state: 'failure', createdAt: '2026-10-14T10:04:00Z' }] });
		tick(11_000);
		assert.equal((await git.publishStatus()).state, 'failed');
	});

	test('the descendant check is one GitHub compare per publish, cached', async () => {
		const running = { value: 'x' };
		const { backend, git, commit, tick } = await published(running);
		const pushed = backend.push('main', { 'starter/src/Page.astro': 'a developer deployed on top\n' });
		running.value = pushed; // the running server has the publish commit as an ancestor
		const before = backend.tracker.records.length;
		assert.equal((await git.publishStatus()).state, 'live');
		assert.equal(backend.tracker.records.length - before, 1, 'one compare');
		tick(5 * 60_000);
		await git.publishStatus();
		await git.publishStatus();
		assert.equal(backend.tracker.records.length - before, 1, 'and no more');
		assert.ok(commit);
	});

	test('history: the newest 20 publishes, newest first, cached and refreshed at most once a minute', async () => {
		const running = { value: null as string | null };
		const { backend, git, tick } = await published(running);
		for (let i = 3; i <= 26; i++) { // 25 publishes with the helper's own
			const home = git.read(HOME)!;
			await git.commitDrafts([{ file: HOME, base: home, text: home.replace(/"title": "[^"]*"/, `"title": "Home v${i}"`), editor: aoife }]);
			assert.equal((await git.publish(aoife)).kind, 'published');
		}
		const entries = await git.history({ refresh: true });
		assert.equal(entries.length, 20);
		assert.equal(entries[0]!.commit, backend.refs.get('main'));
		assert.deepEqual(entries[0]!.titles, ['Home v26']);
		assert.deepEqual(entries[19]!.titles, ['Home v7']);
		assert.ok(entries.every((e) => e.state === 'live' && e.by?.email === 'aoife@example.com'));
		const n = backend.tracker.records.length;
		tick(30_000);
		await git.history({ refresh: true });
		await git.history();
		assert.equal(backend.tracker.records.length, n, 'within a minute: the cache');
		tick(31_000);
		await git.history({ refresh: true });
		assert.ok(backend.tracker.records.length > n, 'after a minute, when asked to refresh');
	});

	test('no redeployer: Try again says a developer can redeploy it, naming no host (runs-anywhere Decision 11)', async () => {
		const { git } = await published({ value: null });
		const r = await git.tryAgain();
		assert.equal(r.ok, false);
		assert.match(!r.ok ? r.reason : '', /a developer can redeploy it\.$/);
		assert.doesNotMatch(!r.ok ? r.reason : '', /railway/i);
	});
});
