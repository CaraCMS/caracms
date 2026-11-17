// caracms-cloud M4 (Decisions 22–25, acceptance checks 18–21): a cloud site's forms and email,
// against a stubbed API and stubbed R2 (helpers/cloud-forms.ts).
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { resolveSite } from '../src/config.ts';
import { cloudSettingsForBuild } from '../src/cloud-middleware.ts';
import { cloudStore } from '../src/forms/cloud-store.ts';
import { handleForm, STORE_FAILED_MESSAGE, type FormContext } from '../src/forms/endpoint.ts';
import { formSettingsFrom, fromName, MAX_RECIPIENTS, writeNotification } from '../src/forms/email.ts';
import { handleSubmissions, UNREAD_HEADER, type InboxContext, type NotSpamResponse, type SubmissionResponse, type SubmissionsListResponse } from '../src/forms/inbox.ts';
import { memoryLimiter } from '../src/forms/rate-limit.ts';
import { MemoryBackend, readSubmissionsConfig, storeOver, submissionStore, type StoredSubmission, type SubmissionStore } from '../src/forms/store.ts';
import { deliverLink } from '../src/live/auth/email.ts';
import { CLOUD_AND_FORMS_PROBLEM, readMode } from '../src/live/mode.ts';
import { CLOUD_KEY, CLOUD_URL, fakeCloud, type FakeCloud } from './helpers/cloud-forms.ts';
import { siteRoot, variant } from './helpers/site.ts';

const site = resolveSite(
	variant({
		forms: {
			contact: {
				label: 'Contact',
				email: { subject: 'New contact enquiry' },
				fields: { name: { label: 'Name', autocomplete: 'name' }, email: { label: 'Email', type: 'email' }, message: { label: 'Message', type: 'textarea' }, plans: { label: 'Plans', type: 'files', optional: true } },
			},
		},
		timeZone: 'Europe/Dublin',
	}),
	siteRoot,
);
const ORIGIN = 'http://site.test';
const CLOUD_ENV = { NODE_ENV: 'production', CARACMS_CLOUD_KEY: CLOUD_KEY, CARACMS_CLOUD_URL: CLOUD_URL };

let cloud: FakeCloud;
let store: SubmissionStore;
let logs: string[];

beforeEach(() => {
	cloud = fakeCloud();
	store = cloudStore({ key: CLOUD_KEY, url: CLOUD_URL, fetch: cloud.fetch });
	logs = [];
});

describe('which store (check 18)', () => {
	test('a production server with the cloud key uses the cloud', () => {
		assert.deepEqual(readSubmissionsConfig('/site', CLOUD_ENV), { kind: 'cloud', connection: { key: CLOUD_KEY, url: CLOUD_URL } });
		assert.deepEqual(readSubmissionsConfig('/site', { NODE_ENV: 'production', CARACMS_CLOUD_KEY: CLOUD_KEY }), { kind: 'cloud', connection: { key: CLOUD_KEY, url: 'https://glad-bird-412.ap-southeast-2.convex.site' } });
		const chosen = submissionStore(readSubmissionsConfig('/site', CLOUD_ENV), cloud.fetch);
		assert.ok(!('kind' in chosen) && chosen.sendsEmail === true);
	});

	test('outside production it is the folder, even with the key', () => {
		assert.deepEqual(readSubmissionsConfig('/site', { CARACMS_CLOUD_KEY: CLOUD_KEY }), { kind: 'folder', dir: '/site/.caracms/submissions' });
		assert.deepEqual(readSubmissionsConfig('/site', { NODE_ENV: 'development', CARACMS_CLOUD_KEY: CLOUD_KEY }), { kind: 'folder', dir: '/site/.caracms/submissions' });
	});

	test('CARACMS_SUBMISSIONS=memory still wins, and is still refused in production', () => {
		assert.deepEqual(readSubmissionsConfig('/site', { CARACMS_CLOUD_KEY: CLOUD_KEY, CARACMS_SUBMISSIONS: 'memory' }), { kind: 'memory' });
		assert.equal(readSubmissionsConfig('/site', { ...CLOUD_ENV, CARACMS_SUBMISSIONS: 'memory' }).kind, 'unset');
	});

	test('a production server with neither the key nor the bucket names the key as the other way', () => {
		const unset = readSubmissionsConfig('/site', { NODE_ENV: 'production' });
		assert.equal(unset.kind, 'unset');
		assert.match((unset as { message: string }).message, /set CARACMS_CLOUD_KEY to the site's CaraCMS Cloud key, or set SUBMISSIONS_S3_BUCKET/);
	});
});

describe("the key with the site's own forms and email variables (check 19)", () => {
	const sentence = "Set CARACMS_CLOUD_KEY or the site's own forms and email variables, not both: remove SUBMISSIONS_S3_BUCKET, RESEND_API_KEY and FORMS_FROM.";
	const env = { ...CLOUD_ENV, SUBMISSIONS_S3_BUCKET: 'b', RESEND_API_KEY: 're_x', FORMS_FROM: 'f@x.test' };

	test('the sentence names them', () => {
		assert.equal(CLOUD_AND_FORMS_PROBLEM(['SUBMISSIONS_S3_BUCKET', 'RESEND_API_KEY', 'FORMS_FROM']), sentence);
	});

	test('at start (readMode), as unconfigured', () => {
		const mode = readMode({ ...env, CARACMS_SECRET: 's'.repeat(32), REDIS_URL: 'redis://x', SITE_URL: 'https://example.com' }, true);
		assert.equal(mode.kind, 'unconfigured');
		assert.ok(mode.kind === 'unconfigured' && mode.problems.includes(sentence), JSON.stringify(mode));
		const each = readMode({ ...CLOUD_ENV, SUBMISSIONS_S3_SECRET_ACCESS_KEY: 'x', CARACMS_SECRET: 's'.repeat(32), REDIS_URL: 'redis://x', SITE_URL: 'https://example.com' }, true);
		assert.ok(each.kind === 'unconfigured' && each.problems.includes(CLOUD_AND_FORMS_PROBLEM(['SUBMISSIONS_S3_SECRET_ACCESS_KEY'])));
	});

	test('at build', async () => {
		await assert.rejects(cloudSettingsForBuild({ ...env, CARACMS_MEDIA: 'memory' }), (error: Error) => error.message === `caracms: ${sentence}`);
	});

	test('from readSubmissionsConfig as unset, in production and out of it', () => {
		assert.deepEqual(readSubmissionsConfig('/site', env), { kind: 'unset', message: sentence, missing: [] });
		const { NODE_ENV: _, ...laptop } = env;
		assert.deepEqual(readSubmissionsConfig('/site', laptop), { kind: 'unset', message: sentence, missing: [] });
	});

	test('each of the five variables alone is enough, and the sentence names only the ones set', () => {
		for (const name of ['SUBMISSIONS_S3_BUCKET', 'SUBMISSIONS_S3_ACCESS_KEY_ID', 'SUBMISSIONS_S3_SECRET_ACCESS_KEY', 'RESEND_API_KEY', 'FORMS_FROM']) {
			const config = readSubmissionsConfig('/site', { ...CLOUD_ENV, [name]: 'x' });
			assert.deepEqual(config, { kind: 'unset', message: CLOUD_AND_FORMS_PROBLEM([name]), missing: [] }, name);
			assert.match((config as { message: string }).message, new RegExp(`remove ${name}\\.$`), name);
		}
	});

	test('from deliverLink as failed, the sentence logged, nothing sent', async () => {
		const lines: string[] = [];
		assert.equal(await deliverLink({ to: 'aoife@example.com', link: 'https://example.com/admin/login/confirm?token=t', siteName: 'CaraCMS', env, log: (l) => lines.push(l), fetch: cloud.fetch }), 'failed');
		assert.deepEqual(lines, [`could not email a sign-in link: ${sentence}`]);
		assert.deepEqual(cloud.calls, []);
	});
});

// ── v3's store cases, against the cloud store (check 20) ─────────────────────

const make = (i: number, extra: { files?: { name: string; type: string; data: Uint8Array }[] } = {}) =>
	store.create({
		form: 'contact',
		receivedAt: new Date(Date.UTC(2026, 9, 16, 9, i)).toISOString(),
		fields: { name: `Visitor ${i}`, email: `v${i}@x.test`, message: `Message ${i}\nsecond line` },
		email: () => ({ emailSkipped: 'test' }),
		...extra,
	});

const inbox = (patch: Partial<InboxContext> = {}): InboxContext => ({ site, mode: 'local', person: null, log: () => {}, env: CLOUD_ENV, fetch: cloud.fetch, ...patch });
const get = (path: string) => handleSubmissions(new Request(`${ORIGIN}${path}`), inbox());
const post = (path: string, body?: unknown) =>
	handleSubmissions(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: body === undefined ? undefined : JSON.stringify(body) }), inbox());

describe('the cloud store runs v3’s store cases (check 20)', () => {
	test('create without files: one call, complete, the email handed over with it', async () => {
		const s = await make(1);
		assert.deepEqual(cloud.calls, ['POST /v1/submissions']);
		assert.equal(cloud.rows.get(s.id)!.state, 'complete');
		assert.deepEqual(cloud.rows.get(s.id)!.written, { emailSkipped: 'test' });
		assert.deepEqual(await store.get(s.id), { ...s });
		assert.equal(s.files, undefined);
	});

	test('create with files: the row, each upload with the named headers, then the confirm', async () => {
		const a = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);
		const s = await make(1, { files: [{ name: '../../Site plan.pdf', type: 'application/pdf', data: a }, { name: 'b.jpg', type: '', data: new Uint8Array([9]) }] });
		assert.deepEqual(cloud.calls, ['POST /v1/submissions', `PUT r2:sites/site-a/${s.id}/1-Site-plan.pdf`, `PUT r2:sites/site-a/${s.id}/2-b.jpg`, 'POST /v1/submissions/confirm']);
		assert.deepEqual(s.files, [
			{ name: '../../Site plan.pdf', size: 7, type: 'application/pdf', key: `${s.id}/1-Site-plan.pdf` },
			{ name: 'b.jpg', size: 1, type: '', key: `${s.id}/2-b.jpg` },
		]);
		const sent = cloud.bodies[0]!.body.files as { sha256: string }[];
		assert.match(sent[0]!.sha256, /^[0-9a-f]{64}$/);
		assert.equal(cloud.rows.get(s.id)!.state, 'complete');
		assert.deepEqual(cloud.r2.get(`sites/site-a/${s.id}/1-Site-plan.pdf`), a);
	});

	test('a failed upload removes the row and throws', async () => {
		cloud.failOn = (call) => (call.endsWith('2-b.jpg') && call.startsWith('PUT') ? new Response('no', { status: 403 }) : null);
		await assert.rejects(make(1, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }, { name: 'b.jpg', type: '', data: new Uint8Array([2]) }] }), /upload 2 of 2: the storage answered 403/);
		assert.equal(cloud.calls.at(-1), 'POST /v1/submissions/delete');
		assert.equal(cloud.rows.size, 0);
		assert.equal(cloud.r2.size, 0);
	});

	test('a confirm answered 409 incomplete removes the row and throws', async () => {
		cloud.failOn = (call) => (call === 'POST /v1/submissions/confirm' ? Response.json({ error: 'incomplete', message: 'A file is missing.' }, { status: 409 }) : null);
		await assert.rejects(make(1, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }] }), (e: Error) => e.message === 'A file is missing.');
		assert.deepEqual(cloud.calls.slice(-2), ['POST /v1/submissions/confirm', 'POST /v1/submissions/delete']);
		assert.equal(cloud.rows.size, 0);
	});

	test('a confirm that never gets through is tried once more, then left to the cloud’s clean-up', async () => {
		let n = 0;
		cloud.failOn = (call) => (call === 'POST /v1/submissions/confirm' && n++ < 1 ? 'throw' : null);
		const s = await make(1, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }] });
		assert.equal(cloud.calls.filter((c) => c === 'POST /v1/submissions/confirm').length, 2);
		assert.equal(cloud.rows.get(s.id)!.state, 'complete');

		cloud.failOn = (call) => (call === 'POST /v1/submissions/confirm' ? 'throw' : null);
		cloud.calls.length = 0;
		await assert.rejects(make(2, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }] }), /couldn't be reached/);
		assert.deepEqual(cloud.calls.filter((c) => c.startsWith('POST')), ['POST /v1/submissions', 'POST /v1/submissions/confirm', 'POST /v1/submissions/confirm']);
		assert.equal([...cloud.rows.values()].filter((r) => r.state === 'pending').length, 1, 'the pending row is the cron’s');
	});

	test('the list: newest first, 50 at a time, Older reaches the 51st, the unread count from the cloud; pending rows never listed', async () => {
		for (let i = 0; i < 51; i++) await make(i);
		cloud.failOn = (call) => (call === 'POST /v1/submissions/confirm' ? 'throw' : null);
		await assert.rejects(make(59, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }] }));
		cloud.failOn = null;
		const first = (await (await get('/_caracms/submissions')).json()) as SubmissionsListResponse;
		assert.equal(first.items.length, 50);
		assert.equal(first.items[0]!.name, 'Visitor 50');
		assert.equal(first.unread, 51);
		assert.ok(first.older);
		const older = (await (await get(`/_caracms/submissions?before=${encodeURIComponent(first.older!)}`)).json()) as SubmissionsListResponse;
		assert.deepEqual(older.items.map((r) => r.name), ['Visitor 0']);
		assert.equal(older.older, null);
		assert.ok(!cloud.calls.includes('GET /v1/submissions/unread'), 'the count came with the list');
	});

	test('review gaps (Acceptance 17): one submission’s form names its fields as Site Settings does', async () => {
		const s = await make(3);
		const worded = inbox({ readWords: async () => ({ contact: { fields: { name: { label: 'Who you are' } } } }) });
		const detail = (await (await handleSubmissions(new Request(`${ORIGIN}/_caracms/submissions/${s.id}`), worded)).json()) as SubmissionResponse;
		assert.equal(detail.form!.fields.find((f) => f.name === 'name')!.label, 'Who you are');
	});

	test('get, read and unread: each answer carries the count', async () => {
		const s = await make(1);
		await make(2);
		const detail = (await (await get(`/_caracms/submissions/${s.id}`)).json()) as SubmissionResponse;
		assert.equal(detail.submission.id, s.id);
		assert.equal(detail.submission.readAt, null);
		assert.equal(detail.unread, 2);
		const read = await post(`/_caracms/submissions/${s.id}/read`);
		assert.equal(read.status, 204);
		assert.equal(read.headers.get(UNREAD_HEADER), '1');
		assert.ok(cloud.rows.get(s.id)!.submission.readAt);
		const unread = await post(`/_caracms/submissions/${s.id}/unread`);
		assert.equal(unread.headers.get(UNREAD_HEADER), '2');
		assert.equal(await store.unreadCount(), 2);
		assert.equal(await cloudStore({ key: CLOUD_KEY, url: CLOUD_URL, fetch: cloud.fetch }).unreadCount(), 2, 'a fresh store asks');
	});

	test('an unknown id is a 404; one that is not an id never reaches the cloud', async () => {
		assert.equal((await get('/_caracms/submissions/2026-10-16T09-01-00-000Z_aaaaaa')).status, 404);
		cloud.calls.length = 0;
		assert.equal(await store.get('../x'), null);
		assert.equal(await store.getFile('../x', 1), null);
		assert.equal(await store.update('../x', { readAt: null }), null);
		assert.equal(await store.delete('../x'), false);
		assert.deepEqual(cloud.calls, []);
	});

	test('getFile: the download URL, then the bytes; the type from the key', async () => {
		const bytes = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);
		const s = await make(1, { files: [{ name: 'Site plan.pdf', type: 'image/png', data: bytes }] });
		const res = await get(`/_caracms/submissions/${s.id}/files/1`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('content-type'), 'application/pdf');
		assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Site plan.pdf"');
		assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
		assert.equal((await get(`/_caracms/submissions/${s.id}/files/2`)).status, 404);
	});

	test('a file answer whose key is not this submission’s is never fetched', async () => {
		const other = await make(2, { files: [{ name: 'secret.pdf', type: '', data: new Uint8Array([9]) }] });
		const s = await make(1, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }] });
		cloud.rows.get(s.id)!.submission.files = [{ ...other.files![0]! }];
		cloud.calls.length = 0;
		assert.equal((await get(`/_caracms/submissions/${s.id}/files/1`)).status, 502);
		assert.ok(!cloud.calls.some((c) => c.startsWith('GET r2:')));
	});

	test('delete: gone from the list and its files, the count with it; a second is a 404', async () => {
		const s = await make(1, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }] });
		const res = await post(`/_caracms/submissions/${s.id}/delete`, { confirm: true });
		assert.equal(res.status, 204);
		assert.equal(res.headers.get(UNREAD_HEADER), '0');
		assert.equal(cloud.rows.size, 0);
		assert.equal(cloud.r2.size, 0);
		assert.equal((await post(`/_caracms/submissions/${s.id}/delete`, { confirm: true })).status, 404);
	});
});

// ── "Possibly spam" and "Not spam, send it" (email feedback, 2026-11-11) ─────

const HELD_FOR_SPAM = 'Not emailed: CaraCMS marked this enquiry as possibly spam.';
/** Flag one as the cloud's spam check does: `spam`, and its email held with the cloud's sentence. */
function flag(id: string, at = '2026-10-16T09:01:30.000Z') {
	const row = cloud.rows.get(id)!;
	row.submission = { ...row.submission, spam: { at }, email: { status: 'held', at, to: ['walker@example.com'], error: HELD_FOR_SPAM } };
}

describe('possibly spam, and "Not spam, send it", through the cloud', () => {
	test('the flag is kept from the list and the get only as an object with a string `at`, and only that', async () => {
		const a = await make(1);
		const b = await make(2);
		const c = await make(3);
		const d = await make(4);
		flag(a.id);
		(cloud.rows.get(b.id)!.submission as unknown as Record<string, unknown>).spam = { at: 12 };
		(cloud.rows.get(c.id)!.submission as unknown as Record<string, unknown>).spam = true;
		(cloud.rows.get(d.id)!.submission as unknown as Record<string, unknown>).spam = { at: '2026-10-16T09:04:00.000Z', score: 0.9 };
		assert.deepEqual((await store.get(a.id))!.spam, { at: '2026-10-16T09:01:30.000Z' });
		assert.equal('spam' in (await store.get(b.id))!, false);
		assert.equal('spam' in (await store.get(c.id))!, false);
		assert.deepEqual((await store.get(d.id))!.spam, { at: '2026-10-16T09:04:00.000Z' }, 'nothing but `at`');
		const listed = new Map((await store.list()).items.map((s) => [s.id, s]));
		assert.deepEqual(listed.get(a.id)!.spam, { at: '2026-10-16T09:01:30.000Z' });
		assert.equal('spam' in listed.get(b.id)!, false);
	});

	test('the inbox list marks the row, and the sheet’s answer carries the flag and the held email', async () => {
		const a = await make(1);
		const b = await make(2);
		flag(a.id);
		const list = (await (await get('/_caracms/submissions')).json()) as SubmissionsListResponse;
		const rows = new Map(list.items.map((r) => [r.id, r]));
		assert.equal(rows.get(a.id)!.spam, true);
		assert.equal(rows.get(a.id)!.emailStatus, 'held');
		assert.equal(rows.get(b.id)!.spam, false);
		const detail = (await (await get(`/_caracms/submissions/${a.id}`)).json()) as SubmissionResponse;
		assert.deepEqual(detail.submission.spam, { at: '2026-10-16T09:01:30.000Z' });
		assert.equal(detail.submission.email?.error, HELD_FOR_SPAM);
	});

	test('POST …/not-spam asks the cloud, and answers the submission and its row with the flag gone', async () => {
		const a = await make(1);
		flag(a.id);
		cloud.calls.length = 0;
		const res = await post(`/_caracms/submissions/${a.id}/not-spam`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(cloud.calls, ['POST /v1/submissions/not-spam']);
		assert.deepEqual(cloud.bodies.at(-1), { route: '/v1/submissions/not-spam', body: { id: a.id } });
		const body = (await res.json()) as NotSpamResponse;
		assert.equal(body.submission.id, a.id);
		assert.equal('spam' in body.submission, false);
		assert.equal(body.submission.email, undefined, 'absent while the cloud sends it');
		assert.equal(body.row.spam, false);
		assert.equal(body.row.emailStatus, null);
		assert.equal(cloud.rows.get(a.id)!.submission.spam, undefined);
	});

	test('over the daily limit, the answer is its email held with the cloud’s sentence', async () => {
		const a = await make(1);
		flag(a.id);
		cloud.notSpamHolds = 'Not emailed yet: this site reached its daily email limit in CaraCMS Cloud (100).';
		const body = (await (await post(`/_caracms/submissions/${a.id}/not-spam`)).json()) as NotSpamResponse;
		assert.equal(body.row.spam, false);
		assert.equal(body.row.emailStatus, 'held');
		assert.equal(body.submission.email?.error, cloud.notSpamHolds);
	});

	test('a bare answer (the submission alone, as caracms-cloud 3718e34 answered) is read too', async () => {
		const a = await make(1);
		flag(a.id);
		const inner = cloud.fetch;
		const wrapped: typeof fetch = async (input, init) => {
			const res = await inner(input, init);
			if (!String(input instanceof Request ? input.url : input).endsWith('/v1/submissions/not-spam')) return res;
			return Response.json(((await res.json()) as { submission: unknown }).submission);
		};
		const s = await cloudStore({ key: CLOUD_KEY, url: CLOUD_URL, fetch: wrapped }).notSpam!(a.id);
		assert.equal(s!.id, a.id);
		assert.equal('spam' in s!, false);
	});

	test('an unflagged one comes back unchanged; an unknown id, a bad id or a GET are refused as for the other actions', async () => {
		const a = await make(1);
		const res = await post(`/_caracms/submissions/${a.id}/not-spam`);
		assert.equal(res.status, 200);
		assert.deepEqual(((await res.json()) as NotSpamResponse).submission, await store.get(a.id));
		const unknown = a.id.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
		assert.equal((await post(`/_caracms/submissions/${unknown}/not-spam`)).status, 404);
		cloud.calls.length = 0;
		assert.equal((await post('/_caracms/submissions/not-an-id/not-spam')).status, 404);
		assert.equal((await post(`/_caracms/submissions/${a.id}/not-spam/more`)).status, 404);
		assert.deepEqual(cloud.calls, [], 'refused before the cloud is asked');
		assert.equal((await get(`/_caracms/submissions/${a.id}/not-spam`)).status, 405);
	});

	test('a refusal from the cloud is the inbox’s 502, as for the other actions', async () => {
		const a = await make(1);
		flag(a.id);
		cloud.failOn = (call) => (call === 'POST /v1/submissions/not-spam' ? 'throw' : null);
		const res = await handleSubmissions(
			new Request(`${ORIGIN}/_caracms/submissions/${a.id}/not-spam`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}' }),
			inbox(),
		);
		assert.equal(res.status, 502);
	});

	test('stores that never flag spam answer as for an unknown id; the memory store (tests) lifts a seeded flag', async () => {
		const folder = storeOver(new MemoryBackend());
		const one = await folder.create({ form: 'contact', receivedAt: '2026-10-16T09:01:00.000Z', fields: { name: 'A' } });
		assert.equal(folder.notSpam, undefined);
		const res = await handleSubmissions(
			new Request(`${ORIGIN}/_caracms/submissions/${one.id}/not-spam`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN } }),
			inbox({ store: folder }),
		);
		assert.equal(res.status, 404);

		const backend = new MemoryBackend();
		const memory = storeOver(backend, { notSpam: true });
		const two = await memory.create({ form: 'contact', receivedAt: '2026-10-16T09:02:00.000Z', fields: { name: 'B' } });
		await memory.update(two.id, { email: { status: 'held', at: '2026-10-16T09:02:30.000Z', to: [], error: HELD_FOR_SPAM } });
		await backend.put(`${two.id}.json`, new TextEncoder().encode(JSON.stringify({ ...(await memory.get(two.id))!, spam: { at: '2026-10-16T09:02:30.000Z' } })), 'application/json');
		const lifted = await memory.notSpam!(two.id);
		assert.equal('spam' in lifted!, false);
		assert.equal(lifted!.email, undefined);
		assert.deepEqual(await memory.get(two.id), lifted);
	});
});

// ── The endpoint on the cloud kind (checks 20 and 4's package half) ──────────

const settings = (recipients: string[]) => async () => formSettingsFrom({ brand: { name: 'CaraCMS' }, formRecipients: { contact: recipients } });
const formCtx = (patch: Partial<FormContext> = {}): FormContext => ({
	site,
	env: { ...CLOUD_ENV, SITE_URL: 'https://example.com' },
	limiter: memoryLimiter(),
	log: (line) => logs.push(line),
	readSettings: settings(['walker@example.com']),
	fetch: cloud.fetch,
	now: () => new Date('2026-10-26T10:00:00.000Z'),
	...patch,
});
const form = (fields: Record<string, string>) =>
	new Request(`${ORIGIN}/_caracms/form`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields).toString() });
const good = { form: 'contact', return: '/contact', name: 'Aoife', email: 'aoife@example.com', message: 'Hello there' };

describe('the endpoint on the cloud kind (check 20)', () => {
	test('hands over the written email and sends nothing itself', async () => {
		const res = await handleForm(form(good), formCtx());
		assert.equal(res.status, 200);
		assert.deepEqual(cloud.calls, ['POST /v1/submissions'], 'no Resend, no update');
		const body = cloud.bodies[0]!.body;
		const email = body.email as { to: string[]; subject: string; text: string; replyTo: string; fromName: string };
		assert.deepEqual(email.to, ['walker@example.com']);
		assert.equal(email.subject, 'New contact enquiry — CaraCMS website');
		assert.equal(email.replyTo, 'aoife@example.com');
		assert.equal(email.fromName, 'CaraCMS – Contact');
		assert.ok(email.text.includes(`https://example.com/admin/submissions/${body.id}`));
		assert.equal(body.emailSkipped, undefined);
		assert.equal(body.emailFailed, undefined);
	});

	test('on 409 exists the retried email links to the new id', async () => {
		cloud.existsNext = 1;
		const res = await handleForm(form(good), formCtx());
		assert.equal(res.status, 200);
		const [first, second] = cloud.bodies.map((b) => b.body);
		assert.notEqual(first!.id, second!.id);
		assert.ok((second!.email as { text: string }).text.includes(`/admin/submissions/${second!.id}`));
		assert.ok(!(second!.email as { text: string }).text.includes(String(first!.id)));
		assert.ok(cloud.rows.has(String(second!.id)));
	});

	test('a second 409 exists, or any refusal, is the visitor’s 502 with the cloud’s sentence logged', async () => {
		cloud.existsNext = 2;
		const res = await handleForm(form(good), formCtx());
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: STORE_FAILED_MESSAGE });
		assert.ok(logs.some((l) => l.includes("couldn't store a contact submission: Refused: exists.")), logs.join('\n'));
	});

	test('no recipients: emailSkipped with the package’s sentence', async () => {
		await handleForm(form(good), formCtx({ readSettings: settings([]) }));
		assert.equal(cloud.bodies[0]!.body.emailSkipped, "No one is set to get the Contact form's emails (Site Settings → Forms).");
	});

	test('Site Settings unreadable: emailFailed, and still stored', async () => {
		const res = await handleForm(form(good), formCtx({ readSettings: async () => { throw new Error('ENOENT'); } }));
		assert.equal(res.status, 200);
		assert.equal(cloud.bodies[0]!.body.emailFailed, 'Could not read Site Settings: ENOENT');
	});

	test('more than ten recipients: the first ten, and one log line saying how many were left off', async () => {
		const many = Array.from({ length: 12 }, (_, i) => `r${i}@x.test`);
		await handleForm(form(good), formCtx({ readSettings: settings(many) }));
		assert.deepEqual((cloud.bodies[0]!.body.email as { to: string[] }).to, many.slice(0, MAX_RECIPIENTS));
		assert.deepEqual(logs.filter((l) => l.includes('left off')), ["[caracms] forms: the Contact form has 12 recipients; its email goes to the first 10, and 2 were left off (Site Settings → Forms)."]);
	});

	test('outside production the same key stores in the folder and the cloud is never called', async () => {
		const { NODE_ENV: _, ...laptop } = CLOUD_ENV;
		const chosen = submissionStore(readSubmissionsConfig('/site', laptop), cloud.fetch);
		assert.ok(!('kind' in chosen) && !chosen.sendsEmail);
		assert.deepEqual(cloud.calls, []);
	});
});

describe('fromName and the written email', () => {
	test('"<brand> – <form label>", the label alone with no brand', () => {
		assert.equal(fromName('High-street coffee roaster', 'Contact'), 'High-street coffee roaster – Contact');
		assert.equal(fromName('  ', 'Contact'), 'Contact');
	});

	test('writeNotification never throws, whatever the submission', () => {
		const submission = { v: 1, id: '2026-10-16T13-12-00-000Z_aaaaaa', form: 'gone', receivedAt: 'not a date', fields: {}, readAt: null } satisfies StoredSubmission;
		const written = writeNotification({ submission, form: null, settings: { brandName: '', recipients: { gone: ['a@x.test'] } }, siteUrl: null, timeZone: 'Europe/Dublin', log: () => {} });
		assert.ok('email' in written && written.email.fromName === 'gone');
	});
});

describe('deliverLink on a cloud production server (check 21)', () => {
	const link = 'https://example.com/admin/login/confirm?token=t';

	test('calls the sign-in route, never Resend, and returns sent on 202', async () => {
		const lines: string[] = [];
		const fetchSeen: string[] = [];
		const watching: typeof fetch = (input, init) => {
			fetchSeen.push(new Request(input, init).url);
			return cloud.fetch(input, init);
		};
		assert.equal(await deliverLink({ to: 'aoife@example.com', link, siteName: 'CaraCMS', env: CLOUD_ENV, log: (l) => lines.push(l), fetch: watching }), 'sent');
		assert.deepEqual(cloud.signIns, [{ to: 'aoife@example.com', link, siteName: 'CaraCMS' }]);
		assert.deepEqual(fetchSeen, [`${CLOUD_URL}/v1/email/sign-in`]);
		assert.deepEqual(lines, [], 'the link is never logged');
	});

	test('a refusal is failed, with the cloud’s message logged', async () => {
		cloud.failOn = (call) => (call === 'POST /v1/email/sign-in' ? Response.json({ error: 'sign_in_limit', message: 'This site has sent its 200 sign-in emails for today.' }, { status: 429 }) : null);
		const lines: string[] = [];
		assert.equal(await deliverLink({ to: 'aoife@example.com', link, siteName: 'CaraCMS', env: CLOUD_ENV, log: (l) => lines.push(l), fetch: cloud.fetch }), 'failed');
		assert.deepEqual(lines, ['could not email a sign-in link: CaraCMS Cloud (sign_in_limit): This site has sent its 200 sign-in emails for today.']);
	});

	test('outside production it logs the link, key or not', async () => {
		const { NODE_ENV: _, ...laptop } = CLOUD_ENV;
		const lines: string[] = [];
		assert.equal(await deliverLink({ to: 'aoife@example.com', link, siteName: 'CaraCMS', env: laptop, log: (l) => lines.push(l), fetch: cloud.fetch }), 'logged');
		assert.deepEqual(lines, [`sign-in link for aoife@example.com (not emailed outside production): ${link}`]);
		assert.deepEqual(cloud.calls, []);
	});
});

// ── Form rows (form rows and sourced selects, Acceptance 27) ──────

describe('a rows submission through the cloud (form rows check 27)', () => {
	const rowsSite = resolveSite(
		variant({
			forms: {
				order: {
					label: 'Order',
					email: { subject: 'New order' },
					fields: {
						name: { label: 'Name', autocomplete: 'name' },
						email: { label: 'Email', type: 'email' },
						lines: {
							label: 'Order',
							type: 'rows',
							rowLabel: 'Product',
							columns: {
								product: { label: 'Product', type: 'select', options: [{ value: 'paint', label: 'Paint' }, { value: 'primer', label: 'Primer' }] },
								amount: { label: 'Amount', type: 'number' },
								unit: { label: 'Unit', type: 'select', options: [{ value: 'tin', label: '5L Tin' }, { value: 'l', label: 'L' }] },
							},
						},
					},
				},
			},
			timeZone: 'Europe/Dublin',
		}),
		siteRoot,
	);
	const post = (fields: Record<string, string>) =>
		new Request(`${ORIGIN}/_caracms/form`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields).toString() });

	test('created with its list, read back in the inbox with its lines, the email written with them', async () => {
		const res = await handleForm(
			post({ form: 'order', return: '/order', name: 'Aoife', email: 'aoife@example.com', 'lines[0][product]': 'paint', 'lines[0][amount]': '2.5', 'lines[0][unit]': 'l', 'lines[3][product]': 'primer', 'lines[3][amount]': '4', 'lines[3][unit]': 'tin', 'lines[4][product]': '', 'lines[4][amount]': '', 'lines[4][unit]': '' }),
			{
				site: rowsSite,
				env: CLOUD_ENV,
				store,
				limiter: memoryLimiter(),
				log: (line) => logs.push(line),
				astroSite: new URL('https://example.com'),
				readSettings: async () => formSettingsFrom({ brand: { name: 'CaraCMS' }, formRecipients: { order: ['walker@example.com'] } }),
			},
		);
		assert.equal(res.status, 200, await res.clone().text());
		const body = cloud.bodies[0]!.body;
		const lines = [
			{ product: 'paint', amount: '2.5', unit: 'l' },
			{ product: 'primer', amount: '4', unit: 'tin' },
		];
		assert.deepEqual((body.fields as Record<string, unknown>).lines, lines, 'sent as a real list');
		assert.match((body.email as { text: string }).text, /Order:\nPaint — 2\.5 L\nPrimer — 4 × 5L Tin\n/);
		const read = await handleSubmissions(new Request(`${ORIGIN}/_caracms/submissions/${body.id}`), { site: rowsSite, mode: 'live', person: 'walker@example.com', store, readWords: async () => undefined });
		const answer = (await read.json()) as SubmissionResponse;
		assert.deepEqual(answer.submission.fields.lines, lines, 'read back as the list');
		const listed = await handleSubmissions(new Request(`${ORIGIN}/_caracms/submissions`), { site: rowsSite, mode: 'live', person: 'walker@example.com', store });
		assert.equal(((await listed.json()) as SubmissionsListResponse).items[0]!.name, 'Aoife', 'the list row is as before');
	});

	test('the fake cloud refuses what the cloud refuses: a nested list, a number cell, a bad column name', async () => {
		for (const bad of [[{ a: ['x'] }], [{ a: 2 }], [{ '1a': 'x' }], [['x']], { a: 'x' }]) {
			await assert.rejects(
				store.create({ form: 'order', receivedAt: new Date().toISOString(), fields: { lines: bad as never }, email: () => ({ emailSkipped: 'test' }) }),
				/bad_request/,
				JSON.stringify(bad),
			);
		}
	});
});
