// CaraCMS Cloud as the GitHub credential (M2, GitHub access,
// Decisions 11–14; acceptance checks 14, 15, 16 and 17). The cloud and GitHub are faked
// through the injected fetch, on `https://cloud.test`: never the production address.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import type { StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { CLOUD_NO_REPO, CLOUD_REPO_CHANGED, CLOUD_UNREACHABLE, CloudRefusal, cloudUnavailable, DEFAULT_CLOUD_URL } from '../src/live/cloud.ts';
import { createLiveEditor } from '../src/live/editor.ts';
import { accessProblemMessage, GitHubClient, Tracker, type GitHubAccessProblem } from '../src/live/github.ts';
import {
	CLOUD_AND_GITHUB_PROBLEM,
	CLOUD_KEY_PROBLEM,
	CLOUD_REPO_PROBLEM,
	readMode,
	unconfiguredMessage,
	type LiveSettings,
} from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { siteRoot, variant } from './helpers/site.ts';

const KEY = `cck_${'A1b2C3d4E5'.repeat(4)}xY_`;
const CLOUD = 'https://cloud.test';
const NOW = Date.parse('2026-10-25T10:00:00Z');
const MINUTE = 60_000;
const INSTALL = 'https://github.com/apps/caracms/installations/new';
const NOT_INSTALLED = {
	error: 'app_not_installed',
	message: `The caracms GitHub App isn't installed on CaraCodeDev/caracms-git-spike, or that repo doesn't exist. Install the App on it: ${INSTALL}`,
	installUrl: INSTALL,
	repo: 'CaraCodeDev/caracms-git-spike',
};

type Answer = { status?: number; body?: unknown };
type Asked = { host: string; path: string; method: string; authorization: string | null; body: string | null };

/**
 * CaraCMS Cloud and GitHub behind one fetch: `cloud(path, method)` answers the cloud, and GitHub
 * answers start's two reads (the heads, an empty archive) and 200 `{}` to anything else.
 */
function fakeCloud(cloud: (path: string, method: string) => Answer | 'down') {
	const asked: Asked[] = [];
	let tokens = 0;
	const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
		const u = new URL(String(url));
		const method = init.method ?? 'GET';
		asked.push({ host: u.origin, path: u.pathname, method, authorization: new Headers(init.headers).get('authorization'), body: init.body ? String(init.body) : null });
		if (u.origin === CLOUD) {
			const a = cloud(u.pathname, method);
			if (a === 'down') throw new TypeError('fetch failed');
			return Response.json(a.body ?? {}, { status: a.status ?? 200 });
		}
		assert.equal(u.origin, 'https://api.github.com', `nothing else is asked: ${u.href}`);
		if (u.pathname === '/graphql') {
			const ref = { target: { oid: 'a'.repeat(40), tree: { oid: 'b'.repeat(40) } } };
			return Response.json({ data: { repository: { id: 'R_1', main: ref, drafts: ref } } });
		}
		if (u.pathname.includes('/tarball/')) return new Response(gzipSync(Buffer.alloc(1024)));
		return Response.json({});
	}) as typeof fetch;
	/** The cloud's token answer: a new token each time, an hour long from `at`. */
	const token = (at: number, repo = 'CaraCodeDev/caracms-git-spike'): Answer => ({
		body: { token: `ghs_token${++tokens}`, expiresAt: new Date(at + 60 * MINUTE).toISOString(), repo },
	});
	return { asked, fetcher, token, tokens: () => tokens };
}

const settingsAnswer = (repo: string | null): Answer => ({
	body: { site: { name: 'Throwaway' }, github: { repo }, folder: 'sites/m2-throwaway/', media: { bucket: null, imageHost: 'img.caracms.cloud' }, imgproxy: { key: 'k', salt: 's' } },
});

describe('CARACMS_CLOUD_KEY in readMode (check 14, Decision 11)', () => {
	const SECRET = { CARACMS_SECRET: 'a-secret-for-the-cloud-tests-0123456789' };
	/** What a production server needs besides the credential. */
	const SERVER = { REDIS_URL: 'redis://x', SITE_URL: 'https://example.com' };
	const live = (env: Record<string, string>, production = true) => {
		const m = readMode({ ...SECRET, ...(production ? SERVER : {}), ...env }, production);
		assert.equal(m.kind, 'live', m.kind === 'unconfigured' ? unconfiguredMessage(m) : m.kind);
		return m.kind === 'live' ? m.settings : (null as never);
	};
	const problems = (env: Record<string, string>) => {
		const m = readMode({ ...SECRET, ...SERVER, ...env }, true);
		assert.equal(m.kind, 'unconfigured');
		return m.kind === 'unconfigured' ? m.problems : [];
	};

	test('the key alone is live mode on the cloud, at the production address; nothing names a repo', () => {
		assert.deepEqual(live({ CARACMS_CLOUD_KEY: KEY }).github, { kind: 'cloud', key: KEY, url: DEFAULT_CLOUD_URL });
		assert.equal(DEFAULT_CLOUD_URL, 'https://glad-bird-412.ap-southeast-2.convex.site');
	});

	test("astro dev with the key alone stays local: a laptop's key is the site's real repo", () => {
		assert.deepEqual(readMode({ ...SECRET, CARACMS_CLOUD_KEY: KEY }, false), { kind: 'local' });
		// A key that isn't one is never read there either; the build and the server name it.
		assert.deepEqual(readMode({ ...SECRET, CARACMS_CLOUD_KEY: 'cck_short' }, false), { kind: 'local' });
	});

	test("astro dev with the key and production's own address written out stays local", () => {
		assert.deepEqual(readMode({ ...SECRET, CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: DEFAULT_CLOUD_URL }, false), { kind: 'local' });
		assert.deepEqual(readMode({ ...SECRET, CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: `${DEFAULT_CLOUD_URL}/` }, false), { kind: 'local' });
	});

	test('astro dev with the key and CARACMS_CLOUD_URL (the dev deployment) is live', () => {
		assert.deepEqual(live({ CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: 'https://dev-deployment.convex.site' }, false).github, {
			kind: 'cloud',
			key: KEY,
			url: 'https://dev-deployment.convex.site',
		});
	});

	test('CARACMS_CLOUD_URL is used instead (its trailing slash dropped); http:// on localhost too', () => {
		assert.deepEqual(live({ CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: 'https://dev-deployment.convex.site/' }).github, {
			kind: 'cloud',
			key: KEY,
			url: 'https://dev-deployment.convex.site',
		});
		assert.equal((live({ CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: 'http://127.0.0.1:3211' }).github as { url: string }).url, 'http://127.0.0.1:3211');
	});

	test("Railway's repo variables beside a key are no problem and are never used", () => {
		const s = live({ CARACMS_CLOUD_KEY: KEY, RAILWAY_GIT_REPO_OWNER: 'example-org', RAILWAY_GIT_REPO_NAME: 'site-a', RAILWAY_ENVIRONMENT_ID: 'e' });
		assert.deepEqual(s.github, { kind: 'cloud', key: KEY, url: DEFAULT_CLOUD_URL });
	});

	test('each problem gives its sentence, and the mode is unconfigured', () => {
		const badKey = problems({ CARACMS_CLOUD_KEY: 'cck_short' });
		assert.deepEqual(badKey, [CLOUD_KEY_PROBLEM]);
		assert.ok(!badKey.join(' ').includes('cck_short'), 'the key is never repeated');
		assert.deepEqual(problems({ CARACMS_CLOUD_KEY: KEY, CARACMS_GITHUB_TOKEN: 'github_pat_11ABC' }), [CLOUD_AND_GITHUB_PROBLEM('CARACMS_GITHUB_TOKEN')]);
		assert.deepEqual(problems({ CARACMS_CLOUD_KEY: KEY, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pem' }), [CLOUD_AND_GITHUB_PROBLEM('GITHUB_APP_ID')]);
		assert.deepEqual(problems({ CARACMS_CLOUD_KEY: KEY, GITHUB_REPO: 'CaraCodeDev/caracms-git-spike' }), [CLOUD_REPO_PROBLEM]);
		assert.match(CLOUD_REPO_PROBLEM, /the repo comes from CaraCMS Cloud; remove GITHUB_REPO/);
		for (const url of ['http://dev-deployment.convex.site', 'ftp://x.test', 'not a url']) {
			const [p, ...rest] = problems({ CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: url });
			assert.equal(rest.length, 0);
			assert.match(p!, /^CARACMS_CLOUD_URL must be the cloud's https:\/\/ address \(http:\/\/ works for localhost only/);
		}
	});

	test('a production server with no credential names the cloud key first', () => {
		const m = readMode({ ...SECRET, REDIS_URL: 'redis://x', SITE_URL: 'https://example.com' }, true);
		assert.equal(m.kind, 'unconfigured');
		assert.ok(m.kind === 'unconfigured' && m.missing.includes('CARACMS_CLOUD_KEY (or CARACMS_GITHUB_TOKEN, or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)'), unconfiguredMessage(m as never));
	});
});

const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
const settings: LiveSettings = {
	github: { kind: 'cloud', key: KEY, url: CLOUD },
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
const start = (fetcher: typeof fetch, log: string[] = []) =>
	createLiveRuntime({ site, settings, redis: memoryRedis(), fetch: fetcher, now: () => NOW, log: (l) => log.push(l), runningCommit: () => null });

describe('the runtime starts on the cloud (check 15, Decisions 12–13)', () => {
	test('the repo from GET /v1/settings, then the token, then GitHub on that repo with it', async () => {
		const log: string[] = [];
		const f = fakeCloud((path, method) => (path === '/v1/settings' && method === 'GET' ? settingsAnswer('CaraCodeDev/caracms-git-spike') : f.token(NOW)));
		const rt = await start(f.fetcher, log);
		assert.deepEqual(
			f.asked.slice(0, 2).map((a) => [a.host, a.method, a.path, a.authorization, a.body]),
			[
				[CLOUD, 'GET', '/v1/settings', `Bearer ${KEY}`, null],
				[CLOUD, 'POST', '/v1/github/token', `Bearer ${KEY}`, null],
			],
		);
		const github = f.asked.slice(2);
		assert.ok(github.length >= 2);
		for (const a of github) assert.equal(a.authorization, 'Bearer ghs_token1', `${a.method} ${a.path}`);
		assert.match(github[0]!.body!, /"owner":"CaraCodeDev","name":"caracms-git-spike"/);
		assert.ok(github.some((a) => a.path.startsWith('/repos/CaraCodeDev/caracms-git-spike/tarball/')));
		assert.ok(log.includes('live mode on CaraCodeDev/caracms-git-spike through CaraCMS Cloud'), log.join('\n'));
		assert.ok(!log.join('\n').includes(KEY) && !log.join('\n').includes('ghs_'), 'neither the key nor a token is logged');
		await rt.close();
	});

	test('the token is refreshed five minutes before it expires, once for concurrent callers', async () => {
		let now = NOW;
		const f = fakeCloud(() => f.token(now));
		const gh = new GitHubClient({ cloudKey: KEY, cloudUrl: CLOUD, owner: 'CaraCodeDev', repo: 'caracms-git-spike', fetch: f.fetcher, now: () => now }, new Tracker());
		assert.equal(gh.credential, 'cloud');
		await Promise.all([1, 2, 3].map(() => gh.rest('GET', gh.repoPath('/commits'))));
		assert.equal(f.tokens(), 1, 'one token for three concurrent callers');
		now = NOW + 54 * MINUTE;
		await gh.rest('GET', gh.repoPath('/commits'));
		assert.equal(f.tokens(), 1, 'six minutes left: the same token');
		now = NOW + 56 * MINUTE;
		await Promise.all([1, 2].map(() => gh.rest('GET', gh.repoPath('/commits'))));
		assert.equal(f.tokens(), 2, 'four minutes left: one new token');
		assert.equal(f.asked.at(-1)!.authorization, 'Bearer ghs_token2');
	});
});

describe('a refusal at start (check 16, Decision 14)', () => {
	test('app_not_installed: the start throws the cloud\'s refusal, and the 503 shows its sentence with the link as a link', async () => {
		const f = fakeCloud((path) => (path === '/v1/settings' ? settingsAnswer('CaraCodeDev/caracms-git-spike') : { status: 409, body: NOT_INSTALLED }));
		const error = await start(f.fetcher).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof CloudRefusal);
		assert.deepEqual([error.error, error.message, error.installUrl], ['app_not_installed', NOT_INSTALLED.message, INSTALL]);
		assert.ok(!f.asked.some((a) => a.host !== CLOUD), 'GitHub is never asked');

		const page = cloudUnavailable(error, false);
		assert.equal(page.status, 503);
		assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
		const html = await page.text();
		assert.ok(
			html.includes(`<p>The caracms GitHub App isn't installed on CaraCodeDev/caracms-git-spike, or that repo doesn't exist. Install the App on it: <a href="${INSTALL}">${INSTALL}</a></p>`),
			html,
		);
		const api = cloudUnavailable(error, true);
		assert.deepEqual(await api.json(), { error: NOT_INSTALLED.message, code: 'app_not_installed', installUrl: INSTALL });
	});

	test('the message is escaped; a link that isn\'t https:// is never one', async () => {
		const html = await cloudUnavailable(new CloudRefusal('x', 'A <b>bold</b> "claim" & more', null), false).text();
		assert.match(html, /<p>A &lt;b&gt;bold&lt;\/b&gt; &quot;claim&quot; &amp; more<\/p>/);
		const f = fakeCloud(() => ({ status: 409, body: { error: 'app_not_installed', message: 'Install: javascript:alert(1)', installUrl: 'javascript:alert(1)' } }));
		const error = (await start(f.fetcher).catch((e: unknown) => e)) as CloudRefusal;
		assert.equal(error.installUrl, null);
		assert.doesNotMatch(await cloudUnavailable(error, false).text(), /<a /);
	});

	test('a repo of null in the settings is no_repo, with the cloud\'s sentence; no token is asked for', async () => {
		const f = fakeCloud(() => settingsAnswer(null));
		const error = (await start(f.fetcher).catch((e: unknown) => e)) as CloudRefusal;
		assert.deepEqual([error.error, error.message], ['no_repo', CLOUD_NO_REPO]);
		assert.deepEqual(
			f.asked.map((a) => a.path),
			['/v1/settings'],
		);
	});

	test("the cloud's own refusals (a revoked key, a switched-off team) come through as they are", async () => {
		const f = fakeCloud(() => ({ status: 403, body: { error: 'team_off', message: "This site's team is switched off. Ask CaraCMS to switch it back on." } }));
		const error = (await start(f.fetcher).catch((e: unknown) => e)) as CloudRefusal;
		assert.deepEqual([error.error, error.message], ['team_off', "This site's team is switched off. Ask CaraCMS to switch it back on."]);
	});

	test("a cloud that can't be reached, or answers something else, gets the package's own sentence", async () => {
		for (const answer of ['down', { status: 502, body: 'Bad gateway' }, { status: 200, body: { github: 'x' } }] as const) {
			const f = fakeCloud(() => answer);
			const error = (await start(f.fetcher).catch((e: unknown) => e)) as CloudRefusal;
			assert.ok(error instanceof CloudRefusal);
			assert.deepEqual([error.error, error.message], ['unreachable', CLOUD_UNREACHABLE]);
		}
	});

	test('the next start tries again', async () => {
		let installed = false;
		const f = fakeCloud((path) => (path === '/v1/settings' ? settingsAnswer('CaraCodeDev/caracms-git-spike') : installed ? f.token(NOW) : { status: 409, body: NOT_INSTALLED }));
		await assert.rejects(start(f.fetcher), CloudRefusal);
		installed = true;
		const rt = await start(f.fetcher);
		await rt.close();
	});
});

describe('a refusal while running (check 17, Decision 14)', () => {
	/** A memory backend whose access is the cloud client's (as github-access.test.ts does for the token). */
	class Watched extends MemoryBackend {
		gh: GitHubClient | null = null;
		override accessProblem(): GitHubAccessProblem | null {
			return this.gh?.accessProblem() ?? null;
		}
	}
	const person = { email: 'aoife@example.com', name: 'Aoife' };
	const memorySettings: LiveSettings = { ...settings, github: { kind: 'memory' } };

	async function editorWith(cloud: (path: string, method: string) => Answer | 'down', clock: () => number) {
		const backend = new Watched(new Tracker());
		const f = fakeCloud(cloud);
		backend.gh = new GitHubClient({ cloudKey: KEY, cloudUrl: CLOUD, owner: 'CaraCodeDev', repo: 'caracms-git-spike', fetch: f.fetcher, now: clock, log: () => {} }, new Tracker());
		backend.seed(await siteFiles(site));
		const rt = await createLiveRuntime({ site, settings: memorySettings, backend, redis: memoryRedis(), log: () => {}, runningCommit: () => null });
		const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
		const poll = async () =>
			(await (await ed.status(new Request('http://site.test/_caracms/status', { headers: { origin: 'http://site.test' } }), person)).json()) as StatusResponse;
		return { gh: backend.gh, poll, f };
	}

	test("a refused refresh shows the cloud's sentence and link in the access notice; the next token clears it", async () => {
		let now = NOW;
		let refuse = false;
		const { gh, poll } = await editorWith(
			(_path) => (refuse ? { status: 409, body: NOT_INSTALLED } : { body: { token: 'ghs_x', expiresAt: new Date(now + 60 * MINUTE).toISOString(), repo: 'CaraCodeDev/caracms-git-spike' } }),
			() => now,
		);
		await gh.ready();
		assert.equal((await poll()).githubAccess, null);

		refuse = true;
		now += 56 * MINUTE;
		await assert.rejects(gh.rest('GET', gh.repoPath('/commits')), CloudRefusal);
		const access = (await poll()).githubAccess;
		assert.deepEqual(access, { kind: 'cloud', title: 'No GitHub access through CaraCMS Cloud', message: NOT_INSTALLED.message, link: INSTALL });

		refuse = false;
		await gh.rest('GET', gh.repoPath('/commits'));
		assert.equal((await poll()).githubAccess, null);
	});

	test('a token answer naming another repo (finding 7, retiring Decision 13\'s refusal): refused while the settings say otherwise, taken once they agree', async () => {
		let now = NOW;
		let repo = 'CaraCodeDev/caracms-git-spike';
		let settingsRepo = repo;
		const token = () => ({ body: { token: 'ghs_x', expiresAt: new Date(now + 60 * MINUTE).toISOString(), repo } });
		const { gh, poll } = await editorWith((path) => (path === '/v1/settings' ? settingsAnswer(settingsRepo) : token()), () => now);
		await gh.ready();
		repo = 'CaraCodeDev/another-site';
		now += 56 * MINUTE;
		await assert.rejects(gh.rest('GET', gh.repoPath('/commits')), (error: CloudRefusal) => error.error === 'repo_changed' && error.message === CLOUD_REPO_CHANGED(repo));
		const access = (await poll()).githubAccess;
		assert.deepEqual([access?.kind, access?.message, access?.link], ['cloud', CLOUD_REPO_CHANGED('CaraCodeDev/another-site'), null]);
		assert.equal(gh.nameWithOwner, 'CaraCodeDev/caracms-git-spike');

		settingsRepo = repo;
		await gh.rest('GET', gh.repoPath('/commits'));
		assert.equal(gh.nameWithOwner, 'CaraCodeDev/another-site');
		assert.deepEqual((await poll()).githubAccess, {
			kind: 'renamed',
			title: "This site's repo has a new name",
			message: "This site's GitHub repo is now CaraCodeDev/another-site (it was CaraCodeDev/caracms-git-spike). Changes save and publish to it as before; nothing needs doing.",
			link: null,
		});
	});

	test('an unreachable cloud fails the call but is no access problem; a GitHub 401 on a cloud token names CaraCMS Cloud', async () => {
		let now = NOW;
		let down = false;
		const { gh } = await editorWith(() => (down ? 'down' : { body: { token: 'ghs_x', expiresAt: new Date(now + 60 * MINUTE).toISOString(), repo: 'CaraCodeDev/caracms-git-spike' } }), () => now);
		await gh.ready();
		down = true;
		now += 56 * MINUTE;
		await assert.rejects(gh.rest('GET', gh.repoPath('/commits')), CloudRefusal);
		assert.equal(gh.accessProblem(), null);

		const tokenFor = Response.json({ token: 'ghs_y', expiresAt: new Date(NOW + 60 * MINUTE).toISOString(), repo: 'o/r' });
		const refused = new GitHubClient(
			{
				cloudKey: KEY,
				cloudUrl: CLOUD,
				owner: 'o',
				repo: 'r',
				now: () => NOW,
				fetch: (async (url: string | URL) =>
					new URL(String(url)).origin === CLOUD ? tokenFor.clone() : Response.json({ message: 'Bad credentials' }, { status: 401 })) as typeof fetch,
			},
			new Tracker(),
		);
		await assert.rejects(refused.rest('GET', refused.repoPath('/commits')));
		const problem = refused.accessProblem();
		assert.deepEqual(problem, { kind: 'refused', credential: 'cloud' });
		assert.match(accessProblemMessage(problem!), /^GitHub refused the token CaraCMS Cloud gave this site/);
	});
});
