// The package's side of the seam with caracms-cloud (caracms-cloud adversarial review, seam
// note, items b and d; finding 20): the `no_repo` sentence is the cloud's, the token call waits
// 35 s while every other cloud call keeps 20 s, and a `held` email from the cloud's inbox API
// comes through as `held`. The cloud is faked through the injected fetch on
// `https://cloud.test`, never the production address.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resolveSite } from '../src/config.ts';
import { cloudStore } from '../src/forms/cloud-store.ts';
import { handleSubmissions, type SubmissionResponse, type SubmissionsListResponse } from '../src/forms/inbox.ts';
import type { EmailOutcome } from '../src/forms/store.ts';
import { CLOUD_NO_REPO, CLOUD_TIMEOUT_MS, CLOUD_TOKEN_TIMEOUT_MS, CloudRefusal, cloudSettings, cloudToken, fetchCloudSettings } from '../src/live/cloud.ts';
import { accessProblemMessage, GitHubClient, Tracker } from '../src/live/github.ts';
import { CLOUD_KEY, CLOUD_URL, fakeCloud } from './helpers/cloud-forms.ts';
import { siteRoot, variant } from './helpers/site.ts';

const KEY = `cck_${'A1b2C3d4E5'.repeat(4)}xY_`;
const CLOUD = 'https://cloud.test';
/** caracms-cloud `convex/http.ts`, the token route's `no_repo`, word for word. */
const CLOUDS_NO_REPO = 'This site has no GitHub repo in CaraCMS Cloud yet. A team owner can pick one in app.caracms.com.';

const settings = (repo: string | null) =>
	Response.json({ site: { name: 'CaraCMS' }, github: { repo }, folder: 'sites/site-a/', media: { bucket: 'b', imageHost: 'img.caracms.cloud' }, imgproxy: { key: 'ab', salt: 'cd' } });
const token = (repo: string) => Response.json({ token: 'ghs_x', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), repo });

describe('the no_repo sentence (seam note, item b)', () => {
	test("settings with no repo give the cloud's own sentence, word for word", async () => {
		assert.equal(CLOUD_NO_REPO, CLOUDS_NO_REPO);
		const error = (await cloudSettings({ key: KEY, url: CLOUD, fetch: (async () => settings(null)) as typeof fetch }).catch((e: unknown) => e)) as CloudRefusal;
		assert.deepEqual([error.error, error.message], ['no_repo', CLOUDS_NO_REPO]);
	});

	test("the token route's no_repo refusal is shown as the cloud sent it, not the package's copy", async () => {
		const sent = 'This site has no GitHub repo yet (a newer wording from the cloud).';
		const fetcher = (async () => Response.json({ error: 'no_repo', message: sent }, { status: 409 })) as typeof fetch;
		const client = new GitHubClient({ cloudKey: KEY, cloudUrl: CLOUD, owner: 'o', repo: 'r', fetch: fetcher }, new Tracker());
		const error = (await client.ready().catch((e: unknown) => e)) as CloudRefusal;
		assert.deepEqual([error.error, error.message], ['no_repo', sent]);
		assert.equal(accessProblemMessage(client.accessProblem()!), sent);
	});
});

describe("the token call's timeout (seam note, item d)", () => {
	/** The ms each request's signal was made with, by the request's `METHOD path`. */
	let waits: Map<string, number>;
	const real = AbortSignal.timeout;
	const made = new WeakMap<AbortSignal, number>();
	beforeEach(() => {
		waits = new Map();
		AbortSignal.timeout = (ms: number) => {
			const signal = real.call(AbortSignal, ms);
			made.set(signal, ms);
			return signal;
		};
	});
	afterEach(() => {
		AbortSignal.timeout = real;
	});
	const recording = (answer: (path: string) => Response) =>
		(async (url: string | URL, init: RequestInit = {}) => {
			const u = new URL(String(url));
			waits.set(`${init.method ?? 'GET'} ${u.pathname}`, made.get(init.signal!)!);
			return answer(u.pathname);
		}) as typeof fetch;

	test('35 s for the token, 20 s for the settings, called directly', async () => {
		assert.equal(CLOUD_TOKEN_TIMEOUT_MS, 35_000);
		assert.equal(CLOUD_TIMEOUT_MS, 20_000);
		const fetcher = recording((path) => (path === '/v1/settings' ? settings('o/r') : token('o/r')));
		await cloudToken({ key: KEY, url: CLOUD, fetch: fetcher });
		await fetchCloudSettings({ key: KEY, url: CLOUD, fetch: fetcher });
		assert.deepEqual(Object.fromEntries(waits), { 'POST /v1/github/token': 35_000, 'GET /v1/settings': 20_000 });
	});

	test("GitHubClient's token waits 35 s; the settings it reads again for a renamed repo, and GitHub, keep 20 s", async () => {
		// A token naming another repo makes the client read the settings again (finding 7), so both calls are seen.
		const fetcher = recording((path) => (path === '/v1/settings' ? settings('o/renamed') : path === '/v1/github/token' ? token('o/renamed') : Response.json({})));
		const client = new GitHubClient({ cloudKey: KEY, cloudUrl: CLOUD, owner: 'o', repo: 'r', fetch: fetcher, log: () => {} }, new Tracker());
		await client.ready();
		await client.rest('GET', '/repos/o/renamed');
		assert.deepEqual(Object.fromEntries(waits), { 'POST /v1/github/token': 35_000, 'GET /v1/settings': 20_000, 'GET /repos/o/renamed': 20_000 });
	});

	test("a test's own timeoutMs still wins for every call", async () => {
		const fetcher = recording((path) => (path === '/v1/settings' ? settings('o/renamed') : token('o/renamed')));
		await new GitHubClient({ cloudKey: KEY, cloudUrl: CLOUD, owner: 'o', repo: 'r', fetch: fetcher, timeoutMs: 50, log: () => {} }, new Tracker()).ready();
		assert.deepEqual(Object.fromEntries(waits), { 'POST /v1/github/token': 50, 'GET /v1/settings': 50 });
	});

	test('a token call that outlasts its timeout is unreachable, timed out', async () => {
		const stalling = ((_url: string | URL, init: RequestInit = {}) =>
			new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
		const error = (await cloudToken({ key: KEY, url: CLOUD, fetch: stalling, timeoutMs: 20 }).catch((e: unknown) => e)) as CloudRefusal;
		assert.deepEqual([error.error, error.detail], ['unreachable', 'timed out']);
	});
});

describe('a held email from the cloud (finding 20)', () => {
	const site = resolveSite(
		variant({ forms: { contact: { label: 'Contact', email: { subject: 'New contact enquiry' }, fields: { name: { label: 'Name', autocomplete: 'name' }, email: { label: 'Email', type: 'email' }, message: { label: 'Message', type: 'textarea' } } } } }),
		siteRoot,
	);
	const held: EmailOutcome = {
		status: 'held',
		at: '2026-10-27T09:00:05.000Z',
		to: ['niamh@example.com'],
		error: "Not emailed yet: this site reached its daily email limit in CaraCMS Cloud (100). It's held, and goes out when CaraCMS raises the limit or tomorrow.",
	};

	test('the list says held, and the detail carries the outcome with the cloud’s sentence', async () => {
		const cloud = fakeCloud();
		const store = cloudStore({ key: CLOUD_KEY, url: CLOUD_URL, fetch: cloud.fetch });
		const s = await store.create({ form: 'contact', receivedAt: '2026-10-27T09:00:00.000Z', fields: { name: 'Saoirse', email: 's@x.test', message: 'Hello' }, email: () => ({ emailSkipped: 'test' }) });
		cloud.rows.get(s.id)!.submission.email = held;
		const ctx = { site, mode: 'local' as const, person: null, log: () => {}, env: { NODE_ENV: 'production', CARACMS_CLOUD_KEY: CLOUD_KEY, CARACMS_CLOUD_URL: CLOUD_URL }, fetch: cloud.fetch };
		const list = (await (await handleSubmissions(new Request('http://site.test/_caracms/submissions'), ctx)).json()) as SubmissionsListResponse;
		assert.equal(list.items[0]!.emailStatus, 'held');
		const detail = (await (await handleSubmissions(new Request(`http://site.test/_caracms/submissions/${s.id}`), ctx)).json()) as SubmissionResponse;
		assert.deepEqual(detail.submission.email, held);
		assert.deepEqual((await store.get(s.id))!.email, held);
	});
});

describe("attachments the cloud didn't keep (filesNote)", () => {
	const site = resolveSite(
		variant({ forms: { contact: { label: 'Contact', email: { subject: 'New contact enquiry' }, fields: { name: { label: 'Name', autocomplete: 'name' }, email: { label: 'Email', type: 'email' }, cv: { label: 'CV', type: 'files' } } } } }),
		siteRoot,
	);
	const NOTE = 'Attachments not kept: this site reached its daily attachment limit in CaraCMS Cloud.';
	const ctx = (cloud: ReturnType<typeof fakeCloud>) => ({ site, mode: 'local' as const, person: null, log: () => {}, env: { NODE_ENV: 'production', CARACMS_CLOUD_KEY: CLOUD_KEY, CARACMS_CLOUD_URL: CLOUD_URL }, fetch: cloud.fetch });

	test('the sentence comes through on the submission, and the list row is marked', async () => {
		const cloud = fakeCloud();
		const store = cloudStore({ key: CLOUD_KEY, url: CLOUD_URL, fetch: cloud.fetch });
		const s = await store.create({ form: 'contact', receivedAt: '2026-10-27T09:00:00.000Z', fields: { name: 'Saoirse', email: 's@x.test' }, email: () => ({ emailSkipped: 'test' }) });
		(cloud.rows.get(s.id)!.submission as unknown as Record<string, unknown>).filesNote = `  ${NOTE} `;
		assert.equal((await store.get(s.id))!.filesNote, NOTE, 'trimmed');
		const list = (await (await handleSubmissions(new Request('http://site.test/_caracms/submissions'), ctx(cloud))).json()) as SubmissionsListResponse;
		assert.equal(list.items[0]!.filesNotKept, true);
		const detail = (await (await handleSubmissions(new Request(`http://site.test/_caracms/submissions/${s.id}`), ctx(cloud))).json()) as SubmissionResponse;
		assert.equal(detail.submission.filesNote, NOTE);
	});

	test('absent, empty or not a string: no note, and the row is unmarked', async () => {
		for (const value of [undefined, '', '   ', 42, null]) {
			const cloud = fakeCloud();
			const store = cloudStore({ key: CLOUD_KEY, url: CLOUD_URL, fetch: cloud.fetch });
			const s = await store.create({ form: 'contact', receivedAt: '2026-10-27T09:00:00.000Z', fields: { name: 'Saoirse', email: 's@x.test' }, email: () => ({ emailSkipped: 'test' }) });
			if (value !== undefined) (cloud.rows.get(s.id)!.submission as unknown as Record<string, unknown>).filesNote = value;
			const got = await store.get(s.id);
			assert.equal('filesNote' in got!, false, String(value));
			const list = (await (await handleSubmissions(new Request('http://site.test/_caracms/submissions'), ctx(cloud))).json()) as SubmissionsListResponse;
			assert.equal(list.items[0]!.filesNotKept, undefined);
		}
	});
});
