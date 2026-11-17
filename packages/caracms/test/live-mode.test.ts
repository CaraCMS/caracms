// The mode (M4 Decision 1), the webhook (Decision 14), the config's repoPath and
// timeZone (Decisions 3 and 16), and the runtime's in-memory GitHub (Decision 2).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, mock, test } from 'node:test';
import { CaracmsConfigError, resolveSite, type SiteConfig } from '../src/config.ts';
import { readMode, unconfiguredMessage } from '../src/live/mode.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { createLiveRuntime } from '../src/live/runtime.ts';
import { handleGithubWebhook } from '../src/live/webhook.ts';
import { site, siteRoot, variant } from './helpers/site.ts';

const app = {
	GITHUB_APP_ID: '123',
	GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
	RAILWAY_GIT_REPO_OWNER: 'CaraCodeDev',
	RAILWAY_GIT_REPO_NAME: 'caracms-git-spike',
	CARACMS_SECRET: 's'.repeat(32),
	SITE_URL: 'https://example.com',
};

describe('readMode', () => {
	test('dev with no App: local mode', () => {
		assert.deepEqual(readMode({}, false), { kind: 'local' });
	});

	test('production is always live, and names what it\'s missing', () => {
		const m = readMode({}, true);
		assert.equal(m.kind, 'unconfigured');
		if (m.kind !== 'unconfigured') return;
		assert.deepEqual(m.missing, ['CARACMS_CLOUD_KEY (or CARACMS_GITHUB_TOKEN, or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)', 'GITHUB_REPO', 'CARACMS_SECRET', 'REDIS_URL']);
		assert.match(unconfiguredMessage(m), /^The editor isn't set up on this server yet: it needs CARACMS_CLOUD_KEY \(or CARACMS_GITHUB_TOKEN, or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY\), /);
	});

	test('the App configured in dev: live, with the stand-in Redis allowed', () => {
		const m = readMode(app, false);
		assert.equal(m.kind, 'live');
		if (m.kind !== 'live') return;
		assert.deepEqual(m.settings.github, { kind: 'app', appId: '123', privateKey: app.GITHUB_APP_PRIVATE_KEY, owner: 'CaraCodeDev', repo: 'caracms-git-spike' });
		assert.equal(m.settings.redisUrl, null);
		assert.equal(m.settings.webhookSecret, null);
		assert.equal(m.settings.railway, null);
		assert.equal(m.settings.runningCommit, null);
	});

	test('production with everything, and the optional ones', () => {
		const m = readMode(
			{
				...app,
				GITHUB_REPO: 'Other/repo',
				REDIS_URL: 'redis://x',
				CARACMS_ALLOW: ' Walker@Example.com, @example.org ,',
				GITHUB_WEBHOOK_SECRET: 'w',
				CARACMS_RAILWAY_TOKEN: 't',
				RAILWAY_SERVICE_ID: 'svc',
				RAILWAY_ENVIRONMENT_ID: 'env',
				CARACMS_BACKUP_USER: 'backup',
				CARACMS_BACKUP_PASSWORD: 'p'.repeat(24),
				RAILWAY_GIT_COMMIT_SHA: 'abc',
			},
			true,
		);
		assert.equal(m.kind, 'live');
		if (m.kind !== 'live') return;
		const s = m.settings;
		assert.deepEqual([s.github.kind === 'app' && `${s.github.owner}/${s.github.repo}`, s.allow, s.webhookSecret, s.railway, s.backup?.user, s.runningCommit], [
			'Other/repo',
			['walker@example.com', '@example.org'],
			'w',
			{ token: 't', serviceId: 'svc', environmentId: 'env' },
			'backup',
			'abc',
		]);
		const tests = readMode({ ...app, REDIS_URL: 'r', RAILWAY_GIT_COMMIT_SHA: 'abc', CARACMS_RUNNING_COMMIT: 'def' }, true);
		assert.equal(tests.kind === 'live' && tests.settings.runningCommit, 'def', 'CARACMS_RUNNING_COMMIT wins (tests)');
	});

	test('CARACMS_GITHUB=memory: live in dev with no App; refused in production', () => {
		const m = readMode({ CARACMS_GITHUB: 'memory', CARACMS_SECRET: 'x', CARACMS_TIMINGS: '{"sweepIdleMs":2000}' }, false);
		assert.equal(m.kind, 'live');
		if (m.kind === 'live') {
			assert.deepEqual(m.settings.github, { kind: 'memory' });
			assert.equal(m.settings.timings.sweepIdleMs, 2000);
			assert.equal(m.settings.timings.sweepCapMs, 300_000);
		}
		const p = readMode({ ...app, REDIS_URL: 'r', CARACMS_GITHUB: 'memory' }, true);
		assert.equal(p.kind, 'unconfigured');
		if (p.kind === 'unconfigured') assert.match(p.problems.join(' '), /never uses the in-memory GitHub/);
	});

	test('a bad GITHUB_REPO or CARACMS_TIMINGS is a problem, in plain words', () => {
		const m = readMode({ ...app, GITHUB_REPO: 'nope', CARACMS_TIMINGS: '{"sweepIdle":1}' }, false);
		assert.equal(m.kind, 'unconfigured');
		if (m.kind === 'unconfigured') {
			assert.match(m.problems.join(' '), /GITHUB_REPO must be owner\/name/);
			assert.match(m.problems.join(' '), /"sweepIdle" isn't a timing/);
		}
	});
});

describe('the webhook', () => {
	const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
	const req = (body: string, signature?: string, method = 'POST') =>
		new Request('http://localhost/_caracms/github', { method, body: method === 'POST' ? body : undefined, headers: signature ? { 'x-hub-signature-256': signature } : {} });

	test('no secret: 404, and nothing triggered', async () => {
		let n = 0;
		const res = await handleGithubWebhook(req('{}', sign('x', '{}')), { secret: null, trigger: async () => void n++ });
		assert.equal(res.status, 404);
		assert.equal(n, 0);
	});

	test('a bad or missing signature: 401, and nothing triggered', async () => {
		let n = 0;
		const trigger = async () => void n++;
		assert.equal((await handleGithubWebhook(req('{"ref":"x"}', sign('wrong', '{"ref":"x"}')), { secret: 's', trigger })).status, 401);
		assert.equal((await handleGithubWebhook(req('{"ref":"x"}'), { secret: 's', trigger })).status, 401);
		assert.equal((await handleGithubWebhook(req('{"ref":"x"}', sign('s', '{"ref":"y"}')), { secret: 's', trigger })).status, 401);
		assert.equal(n, 0);
	});

	test('a good signature only triggers the check; the body isn\'t read', async () => {
		let n = 0;
		const body = 'not even json';
		const res = await handleGithubWebhook(req(body, sign('s', body)), { secret: 's', trigger: async () => void n++ });
		assert.equal(res.status, 202);
		assert.equal(n, 1);
		assert.equal((await handleGithubWebhook(req('', undefined, 'GET'), { secret: 's', trigger: async () => void n++ })).status, 405);
	});
});

describe('the webhook: the signature\'s edge cases (Decision 14)', () => {
	const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
	const post = (body: string, headers: Record<string, string> = {}) => new Request('http://localhost/_caracms/github', { method: 'POST', body, headers });

	test('a header of the wrong shape is 401, not a crash: sha1, no prefix, empty, short, long, upper-case hex, doubled', async () => {
		let n = 0;
		const trigger = async () => void n++;
		const body = '{"zen":"x"}';
		const good = sign('s', body);
		const hex = good.slice('sha256='.length);
		const sha1 = `sha1=${createHmac('sha1', 's').update(body).digest('hex')}`;
		for (const header of [sha1, hex, '', 'sha256=', 'sha256=abc', `${good}00`, `sha256=${hex.toUpperCase()}`, `${good},${good}`, `sha256=${'0'.repeat(200)}`, ` ${good}x`]) {
			const res = await handleGithubWebhook(post(body, { 'x-hub-signature-256': header }), { secret: 's', trigger });
			assert.equal(res.status, 401, JSON.stringify(header));
		}
		assert.equal(n, 0);
		// GitHub's own signature, the one with the secret and the exact body.
		assert.equal((await handleGithubWebhook(post(body, { 'x-hub-signature-256': good }), { secret: 's', trigger })).status, 202);
		assert.equal(n, 1);
	});

	test('the signature covers the exact bytes: one changed byte, a trailing newline or a different secret fails', async () => {
		const trigger = async () => {};
		const body = '{"ref":"refs/heads/main","commits":[]}';
		const signed = sign('secret-1', body);
		for (const sent of [body.replace('main', 'dain'), `${body}\n`, ` ${body}`, '']) {
			assert.equal((await handleGithubWebhook(post(sent, { 'x-hub-signature-256': signed }), { secret: 'secret-1', trigger })).status, 401, JSON.stringify(sent));
		}
		assert.equal((await handleGithubWebhook(post(body, { 'x-hub-signature-256': signed }), { secret: 'secret-2', trigger })).status, 401);
	});

	test('a too-large body is refused before it is read; only POST is accepted', async () => {
		let n = 0;
		const trigger = async () => void n++;
		const big = new Request('http://localhost/_caracms/github', { method: 'POST', body: '{}', headers: { 'content-length': String(26 * 1024 * 1024), 'x-hub-signature-256': sign('s', '{}') } });
		assert.equal((await handleGithubWebhook(big, { secret: 's', trigger })).status, 413);
		for (const method of ['GET', 'PUT', 'DELETE']) {
			const res = await handleGithubWebhook(new Request('http://localhost/_caracms/github', { method, body: method === 'GET' ? undefined : '{}' }), { secret: 's', trigger });
			assert.equal(res.status, 405, method);
			assert.equal(res.headers.get('allow'), 'POST');
		}
		assert.equal(n, 0);
	});

	test('the check does not make the answer wait: a slow or failing check is still 202', async () => {
		const slow = await handleGithubWebhook(post('{}', { 'x-hub-signature-256': sign('s', '{}') }), { secret: 's', trigger: () => new Promise(() => {}) });
		assert.equal(slow.status, 202);
		const logged = mock.method(console, 'error', () => {});
		try {
			const failing = await handleGithubWebhook(post('{}', { 'x-hub-signature-256': sign('s', '{}') }), { secret: 's', trigger: async () => Promise.reject(new Error('GitHub is down')) });
			assert.equal(failing.status, 202);
			await new Promise((r) => setImmediate(r));
			assert.equal(logged.mock.callCount(), 1, 'the failure is logged, not thrown');
		} finally {
			logged.mock.restore();
		}
	});
});

describe('the timings (Decisions 4, 5, 8, 9, 12, 13) and who may change them', () => {
	test('the defaults are the spec\'s numbers', () => {
		assert.deepEqual(DEFAULT_TIMINGS, {
			mainCheckMs: 60_000, // Decision 8: at most once a minute
			deploymentReadMs: 10_000, // Decision 13: at most every 10 s while a publish is in flight
			historyMs: 60_000, // Decision 12: at most once a minute
			publishLockMs: 120_000,
			sweepTickMs: 30_000, // Decision 5: ticks every 30 s
			sweepIdleMs: 60_000, // …commits after a minute idle
			sweepCapMs: 300_000, // …and at least every five minutes while someone keeps typing
			lockLapseMs: 120_000, // Decision 9: about two minutes after the last heartbeat
			lockIdleMs: 600_000, // Decision 9: a tab nobody has touched for 10 minutes stops renewing its lock
			presenceMs: 15_000, // Decision 9: 15 seconds
			autosaveTtlMs: 7 * 24 * 60 * 60_000, // Decision 4: a week
			pollMs: 5000, // Decision 13: every 5 s
			publishSlowMs: 900_000, // runs-anywhere Decision 10: taking longer than usual after 15 minutes
			publishAnswerMs: 60_000, // runs-anywhere Watch-outs: Publish answers well inside Cloudflare's 100 s
			statusCacheMs: 30_000, // Redis diet Decision 1: the status poll's reads are at most 30 s old
			beatEveryMs: 30_000, // Redis diet Decision 6: a heartbeat at most every 30 s
			idleSlowAfterMs: 120_000, // Redis diet Decision 8: a tab untouched for 2 minutes slows down…
			slowPollMs: 30_000, // …to a poll every 30 s
			keepDelayMs: 3000, // Redis diet Decision 10: a keep 3 s after the last change…
			keepCapMs: 15_000, // …and at most 15 s after the first unsent one
		});
	});

	test('a production server cannot shorten them; a dev one can, one at a time', () => {
		const prod = readMode({ ...app, REDIS_URL: 'r', CARACMS_TIMINGS: '{"sweepIdleMs":1000}' }, true);
		assert.equal(prod.kind, 'unconfigured');
		if (prod.kind === 'unconfigured') assert.match(prod.problems.join(' '), /CARACMS_TIMINGS is for tests; a production server uses the real timings/);
		const clean = readMode({ ...app, REDIS_URL: 'r' }, true);
		assert.deepEqual(clean.kind === 'live' && clean.settings.timings, DEFAULT_TIMINGS);
		const dev = readMode({ ...app, CARACMS_TIMINGS: '{"lockLapseMs":5000,"presenceMs":1000}' }, false);
		assert.deepEqual(dev.kind === 'live' && [dev.settings.timings.lockLapseMs, dev.settings.timings.presenceMs, dev.settings.timings.sweepIdleMs], [5000, 1000, 60_000]);
		for (const bad of ['{"lockLapseMs":0}', '{"lockLapseMs":"5"}', '{"lockLapseMs":-1}', '[1]', 'nope']) {
			assert.equal(readMode({ ...app, CARACMS_TIMINGS: bad }, false).kind, 'unconfigured', bad);
		}
	});

	test('the repo: Railway\'s own variables, overridden by GITHUB_REPO; either missing is named', () => {
		const from = (env: Record<string, string>) => {
			const m = readMode({ ...app, ...env }, false);
			return m.kind === 'live' && m.settings.github.kind === 'app' ? `${m.settings.github.owner}/${m.settings.github.repo}` : m;
		};
		assert.equal(from({}), 'CaraCodeDev/caracms-git-spike');
		assert.equal(from({ GITHUB_REPO: 'Someone/else' }), 'Someone/else');
		assert.equal(from({ GITHUB_REPO: '  Someone/else  ' }), 'Someone/else');
		const { RAILWAY_GIT_REPO_NAME: _drop, ...noName } = app;
		const m = readMode(noName, false);
		assert.equal(m.kind, 'unconfigured');
		if (m.kind === 'unconfigured') assert.ok(m.missing.some((x) => /RAILWAY_GIT_REPO_OWNER and RAILWAY_GIT_REPO_NAME/.test(x)));
	});

	test('production names every missing required variable, and REDIS_URL is required only there', () => {
		const m = readMode({ GITHUB_APP_ID: '1' }, true);
		assert.equal(m.kind, 'unconfigured');
		if (m.kind === 'unconfigured') assert.deepEqual(m.missing, ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_REPO', 'CARACMS_SECRET', 'REDIS_URL']);
		const dev = readMode({ GITHUB_APP_ID: '1' }, false);
		assert.equal(dev.kind, 'unconfigured');
		if (dev.kind === 'unconfigured') assert.ok(!dev.missing.includes('REDIS_URL'), 'dev may use the stand-in');
		// The optional ones, absent: the optional features are simply off.
		const bare = readMode({ ...app, REDIS_URL: 'r' }, true);
		assert.equal(bare.kind, 'live');
		if (bare.kind === 'live') assert.deepEqual([bare.settings.allow, bare.settings.webhookSecret, bare.settings.railway, bare.settings.backup, bare.settings.runningCommit], [[], null, null, null, null]);
	});
});

describe('the site config: repoPath and timeZone', () => {
	test('defaults: the repo root, and UTC', () => {
		assert.deepEqual([site.repoPath, site.timeZone], ['.', 'UTC']);
	});

	test('normalised, and refused when outside the repo or not a time zone', () => {
		const r = (patch: object) => resolveSite(variant(patch as Partial<SiteConfig>), siteRoot);
		assert.equal(r({ repoPath: './starter/' }).repoPath, 'starter');
		assert.equal(r({ repoPath: 'sites/demo' }).repoPath, 'sites/demo');
		assert.equal(r({ repoPath: '' }).repoPath, '.');
		for (const bad of ['../x', '/abs', 'a//b', 'a\\b']) assert.throws(() => r({ repoPath: bad }), (e: Error) => e instanceof CaracmsConfigError && /repoPath/.test(e.message), bad);
		assert.equal(r({ timeZone: 'Europe/Dublin' }).timeZone, 'Europe/Dublin');
		assert.throws(() => r({ timeZone: 'Mars/Olympus' }), /timeZone must be an IANA time zone/);
	});
});

describe('the runtime on the in-memory GitHub', () => {
	test('seeded from the site\'s files on disk as main; drafts created from it', async () => {
		const s = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);
		const mode = readMode({ CARACMS_GITHUB: 'memory', CARACMS_SECRET: 'x' }, false);
		assert.equal(mode.kind, 'live');
		if (mode.kind !== 'live') return;
		const rt = await createLiveRuntime({ site: s, settings: mode.settings, log: () => {} });
		assert.equal(rt.backend.name, 'memory');
		const heads = await rt.backend.readHeads();
		assert.equal(heads.drafts.commit, heads.main.commit);
		assert.ok(rt.git.files().get('content/pages/index.json')?.includes('"title"'));
		await rt.close();
	});

	test('refused when NODE_ENV is production', async () => {
		const mode = readMode({ CARACMS_GITHUB: 'memory', CARACMS_SECRET: 'x' }, false);
		if (mode.kind !== 'live') return assert.fail('expected live');
		const before = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		try {
			await assert.rejects(createLiveRuntime({ site, settings: mode.settings, log: () => {} }), /refused in production/);
		} finally {
			if (before === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = before;
		}
	});
});
