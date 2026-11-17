// Named branches (M9 Decision 6, acceptance check 1): CARACMS_MAIN_BRANCH and
// CARACMS_DRAFTS_BRANCH name the branches Publish and autosave move. With both set, a
// branch called `main` is never read or moved; unset, it's `main` and `drafts` as before.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import { DEFAULT_BRANCHES, GitHubBackend, MemoryBackend, type BranchNames } from '../src/live/backend.ts';
import { GitHubClient, Tracker } from '../src/live/github.ts';
import { LiveGit } from '../src/live/git.ts';
import { readMode, unconfiguredMessage } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { siteFiles } from '../src/live/runtime.ts';
import { siteRoot, variant } from './helpers/site.ts';

const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
const aoife = { email: 'aoife@example.com', name: 'Aoife' };
const HOME = 'content/pages/index.json';
const NAMED: BranchNames = { main: 'port-caracms', drafts: 'port-caracms-drafts' };

const edit = (text: string, patch: (v: Record<string, unknown>) => void) => {
	const v = JSON.parse(text);
	patch(v);
	return `${JSON.stringify(v, null, 2)}\n`;
};

describe('readMode: the branch settings', () => {
	const memory = { CARACMS_GITHUB: 'memory', CARACMS_SECRET: 'x' };
	const live = (env: Record<string, string>) => {
		const m = readMode({ ...memory, ...env }, false);
		assert.equal(m.kind, 'live', JSON.stringify(m));
		return m.kind === 'live' ? m.settings.branches : undefined;
	};
	const problems = (env: Record<string, string>) => {
		const m = readMode({ ...memory, ...env }, false);
		assert.equal(m.kind, 'unconfigured');
		return m.kind === 'unconfigured' ? m.problems.join(' ') : '';
	};

	test('unset: main and drafts', () => {
		assert.deepEqual(live({}), { main: 'main', drafts: 'drafts' });
		assert.deepEqual(live({ CARACMS_MAIN_BRANCH: '  ', CARACMS_DRAFTS_BRANCH: '' }), DEFAULT_BRANCHES);
	});

	test('set: the named branches, trimmed', () => {
		assert.deepEqual(live({ CARACMS_MAIN_BRANCH: ' port-caracms ', CARACMS_DRAFTS_BRANCH: 'port-caracms-drafts' }), NAMED);
		assert.deepEqual(live({ CARACMS_MAIN_BRANCH: 'feat/port', CARACMS_DRAFTS_BRANCH: 'drafts' }), { main: 'feat/port', drafts: 'drafts' });
	});

	test('one set alone: a problem (it would still publish to main), so /admin is unconfigured', () => {
		assert.match(problems({ CARACMS_DRAFTS_BRANCH: 'port-caracms-drafts' }), /CARACMS_MAIN_BRANCH and CARACMS_DRAFTS_BRANCH must be set together \(only CARACMS_DRAFTS_BRANCH is set\)/);
		assert.match(problems({ CARACMS_MAIN_BRANCH: 'port-caracms' }), /must be set together \(only CARACMS_MAIN_BRANCH is set\)/);
		assert.match(problems({ CARACMS_MAIN_BRANCH: 'port-caracms', CARACMS_DRAFTS_BRANCH: '  ' }), /must be set together/, 'blank counts as unset');
		// The 503 sentence, as /admin answers it.
		const m = readMode({ ...memory, CARACMS_DRAFTS_BRANCH: 'port-caracms-drafts' }, false);
		assert.equal(m.kind, 'unconfigured');
		if (m.kind === 'unconfigured') assert.match(unconfiguredMessage(m), /must be set together/);
	});

	test('the same name twice, autosaves to main, or a name git refuses: a problem', () => {
		assert.match(problems({ CARACMS_MAIN_BRANCH: 'port', CARACMS_DRAFTS_BRANCH: 'port' }), /must differ/);
		assert.match(problems({ CARACMS_DRAFTS_BRANCH: 'main' }), /must differ/);
		assert.match(problems({ CARACMS_MAIN_BRANCH: 'port', CARACMS_DRAFTS_BRANCH: 'main' }), /can't be main/);
		for (const bad of ['refs/heads/port', 'a..b', 'has space', 'x.lock', '-x', 'x/', '.x'])
			assert.match(problems({ CARACMS_MAIN_BRANCH: bad }), /CARACMS_MAIN_BRANCH must be a branch name/, bad);
	});
});

describe('the memory backend on named branches', () => {
	/** A repo whose `main` (the live site) and the port branch start at the same commit. */
	async function setup() {
		const backend = new MemoryBackend(new Tracker(), { branches: NAMED });
		const seed = backend.seed([...(await siteFiles(site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
		// The live site's own main moves on: caracms must neither read it nor move it.
		const seedTree = (await backend.compare(seed, seed)).mergeBase.tree;
		const liveTree = await backend.createTree(seedTree, [],[{ path: `starter/${HOME}`, contents: '{"title":"Tina\'s home"}\n' }]);
		const liveMain = await backend.createCommit(liveTree, [seed], 'The live site moves on');
		backend.refs.set('main', liveMain);
		const git = new LiveGit({ backend, site, redis: memoryRedis(), log: () => {}, runningCommit: () => null });
		await git.start();
		return { backend, git, seed, liveMain };
	}

	test('start creates the named drafts branch from the named main, and reads nothing from main', async () => {
		const { backend, git, seed, liveMain } = await setup();
		assert.equal(backend.refs.get(NAMED.drafts), seed);
		assert.equal(backend.refs.has('drafts'), false, 'no branch called drafts');
		assert.equal(backend.refs.get('main'), liveMain);
		assert.doesNotMatch(git.read(HOME)!, /Tina's home/);
	});

	test('autosave commits to the named drafts branch; Publish to the named main; main never moves', async () => {
		const { backend, git, seed, liveMain } = await setup();
		const home = git.read(HOME)!;
		const r = await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Ported home')), editor: aoife }]);
		assert.ok(r);
		const draft = backend.refs.get(NAMED.drafts)!;
		assert.notEqual(draft, seed);
		assert.equal(backend.refs.get(NAMED.main), seed, 'autosave leaves the named main');
		assert.equal(backend.refs.get('main'), liveMain);

		const p = await git.publish(aoife);
		assert.equal(p.kind, 'published');
		if (p.kind !== 'published') return;
		assert.equal(backend.refs.get(NAMED.main), p.record.commit);
		assert.equal(backend.refs.get(NAMED.drafts), p.record.commit);
		assert.deepEqual(backend.info(p.record.commit).parents, [seed]);
		assert.match(backend.file('main', `starter/${HOME}`)!, /Ported home/, 'file() reads the named main');
		assert.equal(backend.refs.get('main'), liveMain, 'the live site\'s main never moved');
		assert.equal(backend.refs.has('drafts'), false);
		assert.deepEqual([...backend.refs.keys()].sort(), ['main', NAMED.main, NAMED.drafts].sort());
	});

	test('a push to the named main is merged into the named drafts; main stays put', async () => {
		const { backend, git, liveMain } = await setup();
		backend.push('main', { 'starter/src/Page.astro': 'page 2\n' }, 'A developer push to the port branch');
		assert.equal((await git.check({ force: true })).kind, 'fast-forward');
		assert.equal(backend.file('drafts', 'starter/src/Page.astro'), 'page 2\n');
		assert.equal(backend.refs.get('main'), liveMain);
	});
});

describe('defaults unchanged', () => {
	test('a backend with no names uses main and drafts', async () => {
		const backend = new MemoryBackend(new Tracker());
		assert.deepEqual(backend.branches, { main: 'main', drafts: 'drafts' });
		const seed = backend.seed(await siteFiles(site));
		const git = new LiveGit({ backend, site, redis: memoryRedis(), log: () => {}, runningCommit: () => null });
		await git.start();
		assert.deepEqual([...backend.refs.keys()].sort(), ['drafts', 'main']);
		const home = git.read(HOME)!;
		await git.commitDrafts([{ file: HOME, base: home, text: edit(home, (v) => (v.title = 'Default home')), editor: aoife }]);
		const p = await git.publish(aoife);
		assert.equal(p.kind, 'published');
		assert.notEqual(backend.refs.get('main'), seed);
		assert.equal(backend.refs.get('main'), backend.refs.get('drafts'));
	});
});

describe('the GitHub backend asks for the named refs', () => {
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
	/** A GitHub that answers every call and records what was asked. */
	function recording() {
		const asked: { path: string; search: string; body: Record<string, unknown> | null }[] = [];
		const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
			const u = new URL(String(url));
			const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
			if (u.pathname.endsWith('/installation')) return Response.json({ id: 1 });
			if (u.pathname.endsWith('/access_tokens')) return Response.json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
			asked.push({ path: u.pathname, search: u.search, body });
			const target = { target: { oid: 'a'.repeat(40), tree: { oid: 'b'.repeat(40) } } };
			if (u.pathname === '/graphql') {
				const q = String(body?.query);
				if (q.includes('repository(owner')) return Response.json({ data: { repository: { id: 'R', main: target, drafts: target } } });
				if (q.includes('createCommitOnBranch')) return Response.json({ data: { createCommitOnBranch: { commit: { oid: 'c'.repeat(40), tree: { oid: 'd'.repeat(40) } } } } });
				return Response.json({ data: { updateRefs: { clientMutationId: null } } });
			}
			if (u.pathname.endsWith('/commits')) return Response.json([]);
			return Response.json({}, { status: 201 });
		}) as typeof fetch;
		return { asked, fetcher };
	}
	const backendOn = (fetcher: typeof fetch, branches?: BranchNames) =>
		new GitHubBackend(new GitHubClient({ appId: '1', privateKey, owner: 'o', repo: 'r', fetch: fetcher }, new Tracker()), branches);

	for (const [label, branches, expected] of [
		['named', NAMED, NAMED],
		['unset', undefined, DEFAULT_BRANCHES],
	] as const) {
		test(`${label}: heads, branch creation, commits, ref moves and history name ${expected.main} and ${expected.drafts}`, async () => {
			const { asked, fetcher } = recording();
			const b = backendOn(fetcher, branches);
			await b.readHeads();
			await b.createBranch('drafts', 'a'.repeat(40));
			await b.commitOnBranch('drafts', 'a'.repeat(40), [], [], 'h', '');
			await b.updateRefs([
				{ branch: 'main', before: 'a'.repeat(40), after: 'c'.repeat(40), force: false },
				{ branch: 'drafts', before: 'a'.repeat(40), after: 'c'.repeat(40), force: true },
			]);
			await b.listCommits('main', 1);
			const vars = asked.map((a) => a.body?.variables as Record<string, unknown> | undefined);
			assert.deepEqual([vars[0]?.main, vars[0]?.drafts], [`refs/heads/${expected.main}`, `refs/heads/${expected.drafts}`]);
			assert.equal(asked[1]!.body?.ref, `refs/heads/${expected.drafts}`);
			assert.equal(((vars[2]?.input as { branch: { branchName: string } }).branch).branchName, expected.drafts);
			assert.deepEqual(
				(vars[3]?.input as { refUpdates: { name: string }[] }).refUpdates.map((r) => r.name),
				[`refs/heads/${expected.main}`, `refs/heads/${expected.drafts}`],
			);
			assert.equal(new URLSearchParams(asked[4]!.search).get('sha'), expected.main);
			if (label === 'named') assert.ok(!JSON.stringify(asked).includes('refs/heads/main"') && !asked[4]!.search.includes('sha=main&'), 'nothing names main');
		});
	}
});
