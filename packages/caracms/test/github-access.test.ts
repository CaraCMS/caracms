// Runs anywhere, Decisions 3 and 5: the GitHub client
// signs in with a fine-grained token as well as the App, and keeps what GitHub's answers say
// about access, which the status response carries to the editor while it holds. Faked
// GitHub answers through the client's injectable fetch (acceptance checks 5–7); never GitHub.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import type { StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor } from '../src/live/editor.ts';
import { accessProblemMessage, GitHubClient, parseTokenExpiry, Tracker, type GitHubAccessProblem } from '../src/live/github.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { siteRoot, variant } from './helpers/site.ts';

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';
const NOW = Date.parse('2026-10-24T10:00:00Z');
const DAY = 24 * 60 * 60_000;
/** GitHub's format for the header: "2026-11-03 10:00:00 UTC". */
const expiryHeader = (at: number) => new Date(at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
/** A GitHub that answers each request with `answer(path, method, body)` and records what it was sent. */
function fakeGitHub(answer: (path: string, method: string, body: Record<string, unknown> | null) => Answer) {
	const asked: { path: string; method: string; authorization: string | null }[] = [];
	const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
		const u = new URL(String(url));
		const method = init.method ?? 'GET';
		asked.push({ path: u.pathname, method, authorization: new Headers(init.headers).get('authorization') });
		const a = answer(u.pathname, method, init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null);
		return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { 'content-type': 'application/json', ...a.headers } });
	}) as typeof fetch;
	return { asked, fetcher };
}
const tokenClient = (fetcher: typeof fetch) => new GitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetch: fetcher, now: () => NOW }, new Tracker());
const NOT_ACCESSIBLE = { message: 'Resource not accessible by personal access token', documentation_url: 'https://docs.github.com/rest' };

describe('the token as the credential (Decision 3)', () => {
	test('every request carries the token as it is; there is no installation to find', async () => {
		const { asked, fetcher } = fakeGitHub(() => ({ body: { ok: true } }));
		const gh = tokenClient(fetcher);
		await gh.rest('GET', gh.repoPath('/commits'));
		await gh.graphql('query { viewer { login } }', {}, 'viewer');
		assert.deepEqual(
			asked.map((a) => [a.path, a.authorization]),
			[
				['/repos/o/r/commits', `Bearer ${TOKEN}`],
				['/graphql', `Bearer ${TOKEN}`],
			],
		);
		assert.equal(gh.credential, 'token');
	});
});

describe('the expiry (check 7)', () => {
	test('GitHub\'s header parses, with UTC or an offset', () => {
		assert.equal(parseTokenExpiry('2026-11-23 08:35:31 UTC'), Date.parse('2026-11-23T08:35:31Z'));
		assert.equal(parseTokenExpiry('2026-11-23 08:35:31 -0700'), Date.parse('2026-11-23T15:35:31Z'));
		assert.equal(parseTokenExpiry('nonsense'), null);
		assert.equal(parseTokenExpiry(null), null);
	});

	test('a token expiring in 10 days: the date and what to do. 20 days: nothing', async () => {
		for (const [days, expected] of [
			[10, true],
			[20, false],
		] as const) {
			const at = NOW + days * DAY;
			const gh = tokenClient(fakeGitHub(() => ({ headers: { 'github-authentication-token-expiration': expiryHeader(at) } })).fetcher);
			await gh.rest('GET', gh.repoPath('/commits'));
			const problem = gh.accessProblem();
			if (!expected) {
				assert.equal(problem, null, `${days} days`);
				continue;
			}
			assert.deepEqual(problem, { kind: 'expiring', credential: 'token', expires: new Date(at).toISOString() });
			assert.match(accessProblemMessage(problem!), /expires on 3 November 2026\. After that, changes can't be saved to GitHub: a developer can regenerate it/);
		}
	});

	test('an App never shows an expiry, whatever the headers say', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
		const { fetcher } = fakeGitHub((path) => {
			if (path.endsWith('/installation')) return { body: { id: 1 } };
			if (path.endsWith('/access_tokens')) return { status: 201, body: { token: 't', expires_at: new Date(NOW + 3_600_000).toISOString() } };
			return { headers: { 'github-authentication-token-expiration': expiryHeader(NOW + DAY) } };
		});
		const gh = new GitHubClient({ appId: '1', privateKey, owner: 'o', repo: 'r', fetch: fetcher, now: () => NOW }, new Tracker());
		await gh.rest('GET', gh.repoPath('/commits'));
		assert.equal(gh.accessProblem(), null);
	});
});

describe('a refused credential (check 6)', () => {
	test('a 401 is a refused credential until a request succeeds again', async () => {
		let status = 401;
		const gh = tokenClient(fakeGitHub(() => ({ status, body: status === 401 ? { message: 'Bad credentials' } : {} })).fetcher);
		await assert.rejects(gh.rest('GET', gh.repoPath('/commits')));
		assert.deepEqual(gh.accessProblem(), { kind: 'refused', credential: 'token' });
		assert.match(accessProblemMessage(gh.accessProblem()!), /GitHub refused this site's GitHub token \(CARACMS_GITHUB_TOKEN\): it may have expired or been revoked/);
		status = 200;
		await gh.rest('GET', gh.repoPath('/commits'));
		assert.equal(gh.accessProblem(), null);
	});

	test('an App uninstalled from the repo is refused too', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
		const { fetcher } = fakeGitHub(() => ({ status: 404, body: { message: 'Not Found' } }));
		const gh = new GitHubClient({ appId: '1', privateKey, owner: 'o', repo: 'r', fetch: fetcher, now: () => NOW }, new Tracker());
		await assert.rejects(gh.rest('GET', gh.repoPath('/commits')), /isn't installed/);
		assert.deepEqual(gh.accessProblem(), { kind: 'refused', credential: 'app' });
		assert.match(accessProblemMessage(gh.accessProblem()!), /uninstalled from the repo or suspended/);
	});
});

describe('a missing permission (check 5)', () => {
	test('a REST write refused as not accessible names "Contents: Read and write"; a later write that works clears it', async () => {
		let refuse = true;
		const gh = tokenClient(fakeGitHub(() => (refuse ? { status: 403, body: NOT_ACCESSIBLE } : { status: 201, body: { sha: 'c' } })).fetcher);
		await assert.rejects(gh.rest('POST', gh.repoPath('/git/commits'), { message: 'm', tree: 't', parents: [] }));
		assert.deepEqual(gh.accessProblem(), { kind: 'permission', credential: 'token', permission: 'Contents: Read and write' });
		assert.match(accessProblemMessage(gh.accessProblem()!), /lacks the "Contents: Read and write" permission\. A developer can add it in the token's settings/);
		refuse = false;
		await gh.rest('GET', gh.repoPath('/commits'));
		assert.ok(gh.accessProblem(), 'a read doesn\'t clear it');
		await gh.rest('POST', gh.repoPath('/git/commits'), { message: 'm', tree: 't', parents: [] });
		assert.equal(gh.accessProblem(), null);
	});

	test('a GraphQL commit refused as FORBIDDEN (createCommitOnBranch answers 200 with errors) is the same', async () => {
		const gh = tokenClient(fakeGitHub(() => ({ body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] } })).fetcher);
		await assert.rejects(gh.graphql('mutation { createCommitOnBranch(input: {}) { commit { oid } } }', {}, 'createCommitOnBranch'));
		assert.equal(gh.accessProblem()?.kind, 'permission');
	});

	test('a GraphQL mutation that answers 200 with a non-permission error (a stale head) does not clear it; one with no errors does', async () => {
		let answer: unknown = { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] };
		const gh = tokenClient(fakeGitHub(() => ({ body: answer })).fetcher);
		const mutation = 'mutation { createCommitOnBranch(input: {}) { commit { oid } } }';
		await assert.rejects(gh.graphql(mutation, {}, 'createCommitOnBranch'));
		assert.equal(gh.accessProblem()?.kind, 'permission');
		answer = { data: null, errors: [{ type: 'STALE_DATA', message: 'Expected branch to point to "abc" but it did not.' }] };
		await assert.rejects(gh.graphql(mutation, {}, 'createCommitOnBranch'));
		assert.equal(gh.accessProblem()?.kind, 'permission', 'the write did not land, so the missing permission stands');
		answer = { data: { createCommitOnBranch: { commit: { oid: 'c' } } } };
		await gh.graphql(mutation, {}, 'createCommitOnBranch');
		assert.equal(gh.accessProblem(), null);
	});

	test('not a permission: a rate limit\'s 403, a refused read of Deployments (optional), a 403 on a read', async () => {
		const gh = tokenClient(
			fakeGitHub((path, method) => {
				if (path.includes('/deployments')) return { status: 403, body: NOT_ACCESSIBLE };
				if (method === 'POST') return { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } };
				return { status: 403, body: NOT_ACCESSIBLE };
			}).fetcher,
		);
		await assert.rejects(gh.rest('POST', gh.repoPath('/git/commits'), {}));
		await assert.rejects(gh.rest('GET', gh.repoPath('/deployments')));
		await assert.rejects(gh.rest('GET', gh.repoPath('/compare/a...b')));
		assert.equal(gh.accessProblem(), null);
	});
});

describe('the status response carries it to the editor (Decision 5)', () => {
	const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
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
	const person = { email: 'aoife@example.com', name: 'Aoife' };

	/** A memory backend whose access is the faked GitHub client's: what GitHub answered is what the poll says. */
	class Watched extends MemoryBackend {
		gh: GitHubClient | null = null;
		override accessProblem(): GitHubAccessProblem | null {
			return this.gh?.accessProblem() ?? null;
		}
	}

	async function editorOn(backend: MemoryBackend) {
		backend.seed(await siteFiles(site));
		const rt = await createLiveRuntime({ site, settings, backend, redis: memoryRedis(), log: () => {}, runningCommit: () => null });
		return createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	}
	const poll = async (ed: Awaited<ReturnType<typeof editorOn>>) =>
		(await (await ed.status(new Request('http://site.test/_caracms/status', { headers: { origin: 'http://site.test' } }), person)).json()) as StatusResponse;

	test('checks 5 and 6: a refused write, then a refused credential, each within one poll; gone once GitHub answers again', async () => {
		let answer: Answer = { status: 403, body: NOT_ACCESSIBLE };
		const backend = new Watched(new Tracker());
		backend.gh = tokenClient(fakeGitHub(() => answer).fetcher);
		const ed = await editorOn(backend);
		assert.equal((await poll(ed)).githubAccess, null);

		await assert.rejects(backend.gh.rest('POST', backend.gh.repoPath('/git/commits'), {}));
		const refused = (await poll(ed)).githubAccess;
		assert.equal(refused?.kind, 'permission');
		assert.match(refused!.message, /"Contents: Read and write"/);

		answer = { status: 401, body: { message: 'Bad credentials' } };
		await assert.rejects(backend.gh.rest('GET', backend.gh.repoPath('/commits')));
		const revoked = (await poll(ed)).githubAccess;
		assert.deepEqual([revoked?.kind, revoked?.title], ['refused', 'GitHub refused this site']);
		assert.match(revoked!.message, /expired or been revoked/);
		assert.ok(!revoked!.message.includes(TOKEN), 'never the token itself');

		answer = { status: 201, body: {} };
		await backend.gh.rest('POST', backend.gh.repoPath('/git/commits'), {});
		assert.equal((await poll(ed)).githubAccess, null);
	});

	test('check 7: a token expiring in 10 days shows, for every person, with no way to dismiss it', async () => {
		const backend = new Watched(new Tracker());
		backend.gh = tokenClient(fakeGitHub(() => ({ headers: { 'github-authentication-token-expiration': expiryHeader(NOW + 10 * DAY) } })).fetcher);
		await backend.gh.rest('GET', backend.gh.repoPath('/commits'));
		const ed = await editorOn(backend);
		const access = (await poll(ed)).githubAccess;
		assert.equal(access?.kind, 'expiring');
		assert.match(access!.message, /3 November 2026/);
		assert.ok(!(await poll(ed)).notices.some((n) => JSON.stringify(n).includes('expires')), 'not a notice');
	});
});
