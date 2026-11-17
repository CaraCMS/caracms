// The build's settings fetch tries an unreachable cloud again (adversarial review 2026-10-26,
// finding 2, in caracms-cloud's notes): a timeout, no answer or a 502 page waits and retries
// for about three minutes before failing with today's sentence; a refusal still fails at once
// (M3 Decision 20). The server's first request keeps its single try. The clock and the waits
// are faked: nothing here sleeps.
import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { BUILD_RETRY_WAITS_MS, BUILD_RETRY_WINDOW_MS, cloudSettingsForBuild, ensureCloudSettings, resetCloudSettingsRetry, type BuildRetry } from '../src/cloud-middleware.ts';
import { CLOUD_UNREACHABLE_BUILD, heldCloudSettings, resetCloudSettings } from '../src/live/cloud.ts';

const KEY = `cck_${'b'.repeat(43)}`;
const CLOUD = 'https://cloud.test';
const ENV = { CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: CLOUD };
const SETTINGS = {
	github: { repo: null },
	folder: 'sites/retry/',
	media: { bucket: 'caracms-media-dev', imageHost: 'img.caracms.cloud' },
	imgproxy: { key: '11'.repeat(32), salt: '22'.repeat(32) },
};

type Answer = 'timeout' | 'down' | 'bad-gateway' | { status: number; body: unknown };

/** `GET /v1/settings` answering from `script` in turn, then the settings. Each call costs `callMs` on the fake clock. */
function cloud(script: Answer[], clock: { t: number }, callMs = 0) {
	const calls: number[] = [];
	const fetcher = (async () => {
		calls.push(clock.t);
		clock.t += callMs;
		const next = script.shift();
		if (next === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
		if (next === 'down') throw new TypeError('fetch failed');
		if (next === 'bad-gateway') return new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
		if (next) return Response.json(next.body, { status: next.status });
		return Response.json(SETTINGS);
	}) as typeof fetch;
	return { fetcher, calls };
}

/** A fake clock the waits move on, and the log lines. */
function retryWith(clock: { t: number }) {
	const waits: number[] = [];
	const lines: string[] = [];
	const retry: BuildRetry = {
		now: () => clock.t,
		wait: async (ms) => {
			waits.push(ms);
			clock.t += ms;
		},
		log: (line) => lines.push(line),
	};
	return { retry, waits, lines };
}

const realFetch = globalThis.fetch;
beforeEach(() => {
	resetCloudSettings();
	resetCloudSettingsRetry();
});
after(() => {
	globalThis.fetch = realFetch;
});

describe('the build tries an unreachable cloud again', () => {
	test('a timeout or two, then the settings: the build goes on, one line per wait', async () => {
		const clock = { t: Date.parse('2026-10-27T09:00:00Z') };
		const { fetcher, calls } = cloud(['timeout', 'timeout'], clock, 20_000);
		globalThis.fetch = fetcher;
		const { retry, waits, lines } = retryWith(clock);
		await cloudSettingsForBuild(ENV, null, retry);
		assert.equal(calls.length, 3);
		assert.deepEqual(waits, [5_000, 10_000]);
		assert.equal(heldCloudSettings({ key: KEY, url: CLOUD })?.kind, 'ready');
		assert.deepEqual(lines, [
			"[caracms] CaraCMS Cloud couldn't be reached for the build's settings (timed out), try 1; trying again in 5 s, at 09:00:25 UTC.",
			"[caracms] CaraCMS Cloud couldn't be reached for the build's settings (timed out), try 2; trying again in 10 s, at 09:00:55 UTC.",
		]);
	});

	test('a 502 page that isn\'t the API\'s answer, then the settings', async () => {
		const clock = { t: 0 };
		const { fetcher, calls } = cloud(['bad-gateway', 'down'], clock);
		globalThis.fetch = fetcher;
		const { retry, lines } = retryWith(clock);
		await cloudSettingsForBuild(ENV, null, retry);
		assert.equal(calls.length, 3);
		assert.match(lines[0]!, /\(answered HTTP 502, not with JSON\), try 1;/);
		assert.match(lines[1]!, /\(the connection failed\), try 2;/);
	});

	test('a cloud away for the whole window fails the build with today\'s sentence', async () => {
		const clock = { t: 0 };
		const { fetcher, calls } = cloud(Array(50).fill('down'), clock);
		globalThis.fetch = fetcher;
		const { retry, waits, lines } = retryWith(clock);
		await assert.rejects(cloudSettingsForBuild(ENV, null, retry), { message: `caracms: ${CLOUD_UNREACHABLE_BUILD}` });
		// 5 + 10 + 20 + 40 + 60 + 60 s; a third minute's wait would end past the window.
		assert.deepEqual(waits, [...BUILD_RETRY_WAITS_MS, 60_000]);
		assert.equal(calls.length, waits.length + 1);
		assert.equal(lines.length, waits.length);
		assert.ok(clock.t <= BUILD_RETRY_WINDOW_MS);
	});

	test('with every try timing out, the build gives up after about three minutes', async () => {
		const clock = { t: 0 };
		const { fetcher, calls } = cloud(Array(50).fill('timeout'), clock, 20_000);
		globalThis.fetch = fetcher;
		const { retry, waits } = retryWith(clock);
		await assert.rejects(cloudSettingsForBuild(ENV, null, retry), { message: `caracms: ${CLOUD_UNREACHABLE_BUILD}` });
		assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000]);
		assert.equal(calls.length, 5);
		assert.equal(clock.t, 175_000);
	});
});

describe('a refusal still fails the build at once (M3 Decision 20)', () => {
	for (const [what, status, error, message] of [
		['a revoked key', 401, 'revoked_key', 'This key was revoked in CaraCMS Cloud. Make a new one in app.caracms.com.'],
		['a team switched off', 403, 'team_inactive', "This site's team is switched off in CaraCMS Cloud."],
	] as const) {
		test(`${what}: one fetch, no wait, the cloud's sentence`, async () => {
			const clock = { t: 0 };
			const { fetcher, calls } = cloud([{ status, body: { error, message } }], clock);
			globalThis.fetch = fetcher;
			const { retry, waits, lines } = retryWith(clock);
			await assert.rejects(cloudSettingsForBuild(ENV, null, retry), { message: `caracms: ${message}` });
			assert.equal(calls.length, 1);
			assert.deepEqual(waits, []);
			assert.deepEqual(lines, []);
		});
	}
});

describe('the running server keeps its single try', () => {
	test('the first request\'s fetch fails once and is not tried again inside it', async () => {
		const clock = { t: 0 };
		const { fetcher, calls } = cloud(['timeout', 'timeout'], clock);
		globalThis.fetch = fetcher;
		const lines: string[] = [];
		await ensureCloudSettings(ENV, 0, (line) => lines.push(line));
		assert.equal(calls.length, 1);
		assert.equal(heldCloudSettings({ key: KEY, url: CLOUD })?.kind, 'failed');
		assert.equal(lines.length, 1);
	});
});
