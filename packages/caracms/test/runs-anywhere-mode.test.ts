// Runs anywhere: readMode's new rules. The token
// (Decisions 3–4; acceptance checks 2–4), the repo off Railway (Decision 6; check 9), the
// site's address (Decision 7; check 12), the running commit (Decision 9; checks 19–20) and
// the two redeployers (Decision 11; check 25).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	addressFrom,
	BOTH_CREDENTIALS_PROBLEM,
	BOTH_REDEPLOYERS_PROBLEM,
	CLASSIC_TOKEN_PROBLEM,
	NO_ADDRESS_PROBLEM,
	readMode,
	runningCommitFrom,
	unconfiguredMessage,
	type Mode,
} from '../src/live/mode.ts';

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';
const token = {
	CARACMS_GITHUB_TOKEN: TOKEN,
	GITHUB_REPO: 'example-org/caracms-git-spike',
	CARACMS_SECRET: 's'.repeat(32),
	REDIS_URL: 'rediss://default:x@redis.example.com:6379',
	SITE_URL: 'https://example.com',
};
const app = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'pem' };

const problems = (m: Mode) => (m.kind === 'unconfigured' ? m.problems : []);
const missing = (m: Mode) => (m.kind === 'unconfigured' ? m.missing : []);

describe('the token (Decisions 3–4)', () => {
	test('a fine-grained token on its own: live, signed in as the token', () => {
		const m = readMode(token, true);
		assert.equal(m.kind, 'live');
		if (m.kind !== 'live') return;
		assert.deepEqual(m.settings.github, { kind: 'token', token: TOKEN, owner: 'example-org', repo: 'caracms-git-spike' });
		assert.equal(m.settings.address, 'https://example.com');
	});

	test('check 2: GITHUB_TOKEN exported in the shell, no caracms credentials, under astro dev: local mode', () => {
		assert.deepEqual(readMode({ GITHUB_TOKEN: 'ghp_fromTheGhCli', GITHUB_REPO: 'Someone/else' }, false), { kind: 'local' });
		assert.deepEqual(readMode({ GITHUB_TOKEN: TOKEN }, false), { kind: 'local' });
	});

	test('the token alone in dev is live mode, as the App is', () => {
		const { REDIS_URL: _r, SITE_URL: _s, ...dev } = token;
		assert.equal(readMode(dev, false).kind, 'live');
	});

	test('check 3: both an App and a token: a sentence naming both', () => {
		const m = readMode({ ...token, ...app }, true);
		assert.equal(m.kind, 'unconfigured');
		assert.deepEqual(problems(m), [BOTH_CREDENTIALS_PROBLEM]);
		assert.match(unconfiguredMessage(m as Extract<Mode, { kind: 'unconfigured' }>), /GITHUB_APP_ID.*CARACMS_GITHUB_TOKEN/);
	});

	test('check 4: a classic token is refused, saying only fine-grained tokens are accepted, and why', () => {
		for (const classic of ['ghp_abcdef0123456789', 'gho_abc', 'ghu_abc', 'ghs_abc', 'ghr_abc']) {
			const m = readMode({ ...token, CARACMS_GITHUB_TOKEN: classic }, true);
			assert.deepEqual(problems(m), [CLASSIC_TOKEN_PROBLEM], classic);
		}
		assert.match(CLASSIC_TOKEN_PROBLEM, /classic token, which reaches every repo its owner can: use a fine-grained token/);
		assert.match(problems(readMode({ ...token, CARACMS_GITHUB_TOKEN: 'not-a-token' }, true))[0]!, /must be a fine-grained token: it starts with github_pat_/);
	});

	test('the token is never echoed in a sentence', () => {
		const m = readMode({ ...token, ...app }, true);
		assert.ok(!unconfiguredMessage(m as Extract<Mode, { kind: 'unconfigured' }>).includes(TOKEN));
	});

	test('no credential at all in production: both kinds named in one item', () => {
		const { CARACMS_GITHUB_TOKEN: _t, ...none } = token;
		assert.deepEqual(missing(readMode(none, true)), ['CARACMS_CLOUD_KEY (or CARACMS_GITHUB_TOKEN, or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)']);
	});
});

describe('the repo (Decision 6)', () => {
	test('check 9: off Railway with no GITHUB_REPO, the 503 names GITHUB_REPO', () => {
		const { GITHUB_REPO: _drop, ...noRepo } = token;
		const m = readMode(noRepo, true);
		assert.deepEqual(missing(m), ['GITHUB_REPO']);
		assert.match(unconfiguredMessage(m as Extract<Mode, { kind: 'unconfigured' }>), /it needs GITHUB_REPO\./);
	});

	test('on Railway, its own variables are still read, and still named when missing', () => {
		const { GITHUB_REPO: _drop, ...noRepo } = token;
		const m = readMode({ ...noRepo, RAILWAY_GIT_REPO_OWNER: 'example-org', RAILWAY_GIT_REPO_NAME: 'site' }, true);
		assert.equal(m.kind === 'live' && m.settings.github.kind === 'token' && `${m.settings.github.owner}/${m.settings.github.repo}`, 'example-org/site');
		assert.deepEqual(missing(readMode({ ...noRepo, RAILWAY_ENVIRONMENT_ID: 'env' }, true)), ['RAILWAY_GIT_REPO_OWNER and RAILWAY_GIT_REPO_NAME (or GITHUB_REPO)']);
	});
});

describe("the site's address (Decision 7)", () => {
	test('the chain: Astro\'s site as built, then SITE_URL, then RAILWAY_PUBLIC_DOMAIN', () => {
		assert.equal(addressFrom({ SITE_URL: 'https://b.test', RAILWAY_PUBLIC_DOMAIN: 'c.up.railway.app' }, 'https://a.test/blog'), 'https://a.test');
		assert.equal(addressFrom({ SITE_URL: 'https://b.test/', RAILWAY_PUBLIC_DOMAIN: 'c.up.railway.app' }, null), 'https://b.test');
		assert.equal(addressFrom({ RAILWAY_PUBLIC_DOMAIN: 'c.up.railway.app' }, undefined), 'https://c.up.railway.app');
		assert.equal(addressFrom({ SITE_URL: 'nope' }, undefined), null);
		assert.equal(addressFrom({}, undefined), null);
	});

	test('the baked site is the one readMode uses first', () => {
		const m = readMode({ ...token, SITE_URL: '' }, true, { site: 'https://built.test' });
		assert.equal(m.kind === 'live' && m.settings.address, 'https://built.test');
	});

	test('check 12: production live mode with no address at all, off Railway: the problem names SITE_URL', () => {
		const { SITE_URL: _drop, ...noAddress } = token;
		const m = readMode(noAddress, true);
		assert.deepEqual(problems(m), [NO_ADDRESS_PROBLEM]);
		assert.match(NO_ADDRESS_PROBLEM, /set SITE_URL to it, like https:\/\/example\.com, both when the site is built and when it runs/);
		// Railway's public domain is still an address.
		assert.equal(readMode({ ...noAddress, RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }, true).kind, 'live');
		// Dev doesn't need one.
		assert.equal(readMode(noAddress, false).kind, 'live');
	});

	test('check 12: an http:// address on a host other than localhost: the sentence about https and sign-in', () => {
		const m = readMode({ ...token, SITE_URL: 'http://example.com' }, true);
		assert.equal(problems(m).length, 1);
		assert.match(problems(m)[0]!, /\(http:\/\/example\.com\) is http:\/\/, but signing in needs https:\/\/: the session cookie is only ever sent over https/);
		for (const local of ['http://localhost:4330', 'http://127.0.0.1:4330']) assert.equal(readMode({ ...token, SITE_URL: local }, true).kind, 'live', local);
	});
});

describe('the running commit (Decision 9)', () => {
	test('CARACMS_RUNNING_COMMIT, then Railway\'s, Render\'s, Coolify\'s, then the baked one', () => {
		const all = { CARACMS_RUNNING_COMMIT: 'a', RAILWAY_GIT_COMMIT_SHA: 'b', RENDER_GIT_COMMIT: 'c', SOURCE_COMMIT: 'd' };
		assert.equal(runningCommitFrom(all, 'baked'), 'a');
		assert.equal(runningCommitFrom({ ...all, CARACMS_RUNNING_COMMIT: '' }, 'baked'), 'b');
		assert.equal(runningCommitFrom({ RENDER_GIT_COMMIT: 'c', SOURCE_COMMIT: 'd' }, 'baked'), 'c');
		assert.equal(runningCommitFrom({ SOURCE_COMMIT: 'd' }, 'baked'), 'd');
		assert.equal(runningCommitFrom({}, 'baked'), 'baked');
		assert.equal(runningCommitFrom({}, null), null);
	});

	test('check 20: the in-memory GitHub ignores the baked commit, but not one set at run time', () => {
		assert.equal(runningCommitFrom({ CARACMS_GITHUB: 'memory' }, 'baked'), null);
		assert.equal(runningCommitFrom({ CARACMS_GITHUB: 'memory', CARACMS_RUNNING_COMMIT: 'set' }, 'baked'), 'set');
	});

	test('check 19: RENDER_GIT_COMMIT with no Railway variables is the running commit', () => {
		const m = readMode({ ...token, RENDER_GIT_COMMIT: 'abc123' }, true);
		assert.equal(m.kind === 'live' && m.settings.runningCommit, 'abc123');
	});
});

describe('the redeployers (Decision 11)', () => {
	const railway = { CARACMS_RAILWAY_TOKEN: 't', RAILWAY_SERVICE_ID: 'svc', RAILWAY_ENVIRONMENT_ID: 'env' };
	const hook = 'https://api.render.com/deploy/srv-abc?key=secret';

	test('a deploy hook on its own', () => {
		const m = readMode({ ...token, CARACMS_DEPLOY_HOOK_URL: hook }, true);
		assert.equal(m.kind, 'live');
		if (m.kind === 'live') assert.deepEqual([m.settings.deployHook, m.settings.railway], [hook, null]);
	});

	test('check 25: both a deploy hook and a Railway token: a sentence naming both, and never the URL', () => {
		const m = readMode({ ...token, ...railway, CARACMS_DEPLOY_HOOK_URL: hook }, true);
		assert.deepEqual(problems(m), [BOTH_REDEPLOYERS_PROBLEM]);
		assert.match(BOTH_REDEPLOYERS_PROBLEM, /CARACMS_DEPLOY_HOOK_URL and CARACMS_RAILWAY_TOKEN/);
		assert.ok(!unconfiguredMessage(m as Extract<Mode, { kind: 'unconfigured' }>).includes('secret'));
	});

	test('a deploy hook that isn\'t an http(s) address is a problem that doesn\'t echo it', () => {
		const m = readMode({ ...token, CARACMS_DEPLOY_HOOK_URL: 'srv-abc?key=secret' }, true);
		assert.equal(problems(m).length, 1);
		assert.ok(!problems(m)[0]!.includes('secret'));
	});
});

describe('check 18: on Railway with nothing new configured', () => {
	test('the App, Railway\'s own variables and nothing else: live, with the repo, address, running commit and redeployer as before', () => {
		const m = readMode(
			{
				GITHUB_APP_ID: '123',
				GITHUB_APP_PRIVATE_KEY: 'pem',
				CARACMS_SECRET: 's'.repeat(32),
				REDIS_URL: 'redis://redis.railway.internal:6379',
				RAILWAY_ENVIRONMENT_ID: 'env',
				RAILWAY_SERVICE_ID: 'svc',
				RAILWAY_GIT_REPO_OWNER: 'example-org',
				RAILWAY_GIT_REPO_NAME: 'site',
				RAILWAY_GIT_COMMIT_SHA: 'abc123',
				RAILWAY_PUBLIC_DOMAIN: 'site.up.railway.app',
				CARACMS_RAILWAY_TOKEN: 'project-token',
			},
			true,
		);
		assert.equal(m.kind, 'live');
		if (m.kind !== 'live') return;
		assert.deepEqual(m.settings.github, { kind: 'app', appId: '123', privateKey: 'pem', owner: 'example-org', repo: 'site' });
		assert.equal(m.settings.address, 'https://site.up.railway.app');
		assert.equal(m.settings.runningCommit, 'abc123');
		assert.deepEqual([m.settings.railway, m.settings.deployHook], [{ token: 'project-token', serviceId: 'svc', environmentId: 'env' }, null]);
	});
});
