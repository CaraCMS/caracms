// M6 Decision 9 (Acceptance 14, 17, 22–25, 27): the inbox's routes over the memory store, the guard's let-through, the unconfigured 503's exemption.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { resolveSite } from '../src/config.ts';
import { inboxFromAddress } from '../src/editor/addresses.ts';
import { isEditorPath } from '../src/editor/middleware.ts';
import { attachmentHeader, handleSubmissions, submissionsSetup, submissionsSetupQuick, UNREAD_HEADER, type InboxContext, type SubmissionResponse, type SubmissionsListResponse } from '../src/forms/inbox.ts';
import { fileKey, MemoryBackend, storeOver, type SubmissionStore } from '../src/forms/store.ts';
import type { Auth } from '../src/live/auth/auth.ts';
import { guard, isLetThrough } from '../src/live/auth/guard.ts';
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
	}),
	siteRoot,
);
const ORIGIN = 'http://site.test';
let backend: MemoryBackend;
let store: SubmissionStore;

const ctx = (patch: Partial<InboxContext> = {}): InboxContext => ({ site, mode: 'local', person: null, store, log: () => {}, ...patch });
const get = (path: string, c = ctx()) => handleSubmissions(new Request(`${ORIGIN}${path}`), c);
const post = (path: string, body?: unknown, c = ctx(), headers: Record<string, string> = { Origin: ORIGIN }) =>
	handleSubmissions(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), c);

/** One submission received at minute `i` of the day. */
const make = (i: number, extra: { files?: { name: string; type: string; data: Uint8Array }[] } = {}) =>
	store.create({ form: 'contact', receivedAt: new Date(Date.UTC(2026, 9, 16, 9, i)).toISOString(), fields: { name: `Visitor ${i}`, email: `v${i}@x.test`, message: `Message ${i}\nsecond line` }, ...extra });

beforeEach(() => {
	backend = new MemoryBackend();
	store = storeOver(backend);
});

describe('the list (Acceptance 23)', () => {
	test('newest first, 50 at a time, and Older reaches the 51st; rows carry what the inbox shows', async () => {
		for (let i = 0; i < 51; i++) await make(i);
		const first = (await (await get('/_caracms/submissions')).json()) as SubmissionsListResponse;
		assert.equal(first.items.length, 50);
		assert.equal(first.items[0]!.name, 'Visitor 50');
		assert.equal(first.unread, 51);
		assert.ok(first.older);
		const row = first.items[0]!;
		assert.deepEqual({ ...row, id: '', receivedAt: '' }, { id: '', form: 'contact', formLabel: 'Contact', name: 'Visitor 50', email: 'v50@x.test', snippet: 'Message 50 second line', receivedAt: '', readAt: null, files: 0, emailStatus: null, spam: false });
		const older = (await (await get(`/_caracms/submissions?before=${encodeURIComponent(first.older!)}`)).json()) as SubmissionsListResponse;
		assert.equal(older.items.length, 1);
		assert.equal(older.items[0]!.name, 'Visitor 0');
		assert.equal(older.older, null);
	});

	test('every reply is private, no-store and noindex', async () => {
		const res = await get('/_caracms/submissions');
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
		assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
	});

	test('a bad cursor is a 400', async () => {
		assert.equal((await get('/_caracms/submissions?before=../x')).status, 400);
	});
});

describe('reading, read and unread (Acceptance 24)', () => {
	test('a GET of a submission changes nothing; read marks it; unread clears it; each 204 carries the count', async () => {
		const s = await make(1);
		await make(2);
		const detail = (await (await get(`/_caracms/submissions/${s.id}`)).json()) as SubmissionResponse;
		assert.equal(detail.submission.id, s.id);
		assert.equal(detail.submission.readAt, null);
		assert.equal(detail.form!.label, 'Contact');
		assert.deepEqual(detail.form!.fields.map((f) => f.name), ['name', 'email', 'message', 'plans']);
		assert.equal(detail.unread, 2);
		assert.equal((await store.get(s.id))!.readAt, null, 'the GET wrote nothing');

		const read = await post(`/_caracms/submissions/${s.id}/read`);
		assert.equal(read.status, 204);
		assert.equal(read.headers.get(UNREAD_HEADER), '1');
		assert.ok((await store.get(s.id))!.readAt);
		const unread = await post(`/_caracms/submissions/${s.id}/unread`);
		assert.equal(unread.headers.get(UNREAD_HEADER), '2');
		assert.equal((await store.get(s.id))!.readAt, null);
	});

	test('a POST from another site is refused', async () => {
		const s = await make(1);
		assert.equal((await post(`/_caracms/submissions/${s.id}/read`, undefined, ctx(), { Origin: 'https://evil.test' })).status, 403);
	});

	test('an unknown id, or one that is not an id, is a 404 without asking the store', async () => {
		for (const path of ['/_caracms/submissions/../x', '/_caracms/submissions/2026-10-16', '/_caracms/submissions/x/read', '/_caracms/submissions/2026-10-16T09-01-00-000Z_aaaaaa/files/0']) {
			backend.calls.length = 0;
			assert.equal((await get(path)).status, 404, path);
			assert.deepEqual(backend.calls, [], path);
		}
		assert.equal((await get('/_caracms/submissions/2026-10-16T09-01-00-000Z_aaaaaa')).status, 404);
	});
});

describe('files (Acceptance 17, 25)', () => {
	test('a download is an attachment with the name escaped, nosniff, the type from the key, and the uploaded bytes', async () => {
		const bytes = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);
		const s = await make(1, { files: [{ name: '../../Site plan.pdf', type: 'image/png', data: bytes }, { name: 'Café <script>.jpg', type: '', data: new Uint8Array([1]) }] });
		assert.equal(s.files![0]!.key, `${s.id}/1-Site-plan.pdf`);
		const res = await get(`/_caracms/submissions/${s.id}/files/1`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('content-type'), 'application/pdf', 'from the key, not the declared image/png');
		assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Site plan.pdf"');
		assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
		assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
		const second = await get(`/_caracms/submissions/${s.id}/files/2`);
		assert.equal(second.headers.get('content-type'), 'image/jpeg');
		assert.equal(second.headers.get('content-disposition'), `attachment; filename="Caf_ <script>.jpg"; filename*=UTF-8''Caf%C3%A9%20%3Cscript%3E.jpg`);
		assert.equal((await get(`/_caracms/submissions/${s.id}/files/3`)).status, 404);
		assert.equal(attachmentHeader('a"b.pdf'), 'attachment; filename="a_b.pdf"; filename*=UTF-8\'\'a%22b.pdf');
	});

	test('a tampered stored key makes the file route a 404, and the store is never asked for it', async () => {
		const other = await make(2, { files: [{ name: 'secret.pdf', type: '', data: new Uint8Array([9]) }] });
		const s = await make(1, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }] });
		const record = (await store.get(s.id))!;
		for (const key of [other.files![0]!.key, `${other.id}.json`, `${s.id}/../${other.id}.json`, '/etc/passwd']) {
			await backend.put(`${s.id}.json`, new TextEncoder().encode(JSON.stringify({ ...record, files: [{ ...record.files![0]!, key }] })), 'application/json');
			backend.calls.length = 0;
			assert.equal((await get(`/_caracms/submissions/${s.id}/files/1`)).status, 404, key);
			assert.deepEqual(backend.calls, [`get:${s.id}.json`], `only the JSON was read for ${key}`);
		}
		assert.equal(fileKey(s.id, 1, '../../Site plan.pdf'), `${s.id}/1-Site-plan.pdf`);
	});
});

describe('delete (Acceptance 27)', () => {
	test('needs { confirm: true }; removes the files, then the JSON; then 404', async () => {
		const s = await make(1, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }, { name: 'b.pdf', type: '', data: new Uint8Array([2]) }] });
		assert.equal((await post(`/_caracms/submissions/${s.id}/delete`, {})).status, 400);
		assert.ok(await store.get(s.id));
		backend.calls.length = 0;
		const res = await post(`/_caracms/submissions/${s.id}/delete`, { confirm: true });
		assert.equal(res.status, 204);
		assert.equal(res.headers.get(UNREAD_HEADER), '0');
		assert.deepEqual(backend.calls.filter((c) => c.startsWith('remove:')), [`remove:${s.id}/1-a.pdf`, `remove:${s.id}/2-b.pdf`, `remove:${s.id}.json`]);
		assert.equal((await get(`/_caracms/submissions/${s.id}`)).status, 404);
		assert.equal(backend.objects.size, 0);
	});

	test('a delete that fails part-way leaves the submission listed; a file not yet removed is still reachable, a removed one is a 404', async () => {
		const s = await make(1, { files: [{ name: 'a.pdf', type: '', data: new Uint8Array([1]) }, { name: 'b.pdf', type: '', data: new Uint8Array([2]) }] });
		backend.failOn = (call) => call === `remove:${s.id}/2-b.pdf`;
		const res = await post(`/_caracms/submissions/${s.id}/delete`, { confirm: true });
		assert.equal(res.status, 502);
		backend.failOn = null;
		const list = (await (await get('/_caracms/submissions')).json()) as SubmissionsListResponse;
		assert.deepEqual(list.items.map((r) => r.id), [s.id]);
		assert.equal((await get(`/_caracms/submissions/${s.id}/files/1`)).status, 404);
		assert.equal((await get(`/_caracms/submissions/${s.id}/files/2`)).status, 200);
	});
});

describe('who can reach it (Acceptance 14, 22)', () => {
	const signedOut: Auth = { identify: () => ({ state: 'out', reason: 'signed-out' }) } as unknown as Auth;

	test('live mode with no person: every route is a 401 (defence in depth behind the guard)', async () => {
		const s = await make(1);
		for (const path of ['/_caracms/submissions', `/_caracms/submissions/${s.id}`, `/_caracms/submissions/${s.id}/files/1`]) {
			assert.equal((await get(path, ctx({ mode: 'live', person: null }))).status, 401);
		}
		assert.equal((await post(`/_caracms/submissions/${s.id}/read`, undefined, ctx({ mode: 'live', person: null }))).status, 401);
		assert.equal((await get('/_caracms/submissions', ctx({ mode: 'live', person: 'niamh@example.com' }))).status, 200);
	});

	test('the guard: submissions routes answer 401 signed out; /admin/submissions/<id> redirects to sign-in with next kept', () => {
		const api = guard(new Request(`${ORIGIN}/_caracms/submissions`), signedOut);
		assert.equal(api.kind, 'respond');
		assert.equal((api as { response: Response }).response.status, 401);
		const id = '2026-10-16T09-01-00-000Z_k3f9a2';
		const page = guard(new Request(`${ORIGIN}/admin/submissions/${id}`), signedOut);
		const location = (page as { response: Response }).response.headers.get('location')!;
		assert.equal((page as { response: Response }).response.status, 303);
		assert.ok(location.startsWith('/admin/login'));
		assert.equal(new URL(location, ORIGIN).searchParams.get('next'), `/admin/submissions/${id}`);
	});

	test('POST /_caracms/form needs no session and no same origin; every other /_caracms/ write still does', () => {
		assert.equal(isLetThrough('/_caracms/form', 'POST'), true);
		assert.equal(guard(new Request(`${ORIGIN}/_caracms/form`, { method: 'POST', headers: { Origin: 'https://elsewhere.test' } }), signedOut).kind, 'skip');
		assert.equal(isLetThrough('/_caracms/form', 'GET'), false);
		for (const path of ['/_caracms/form/x', '/_caracms/%66orm', '/_caracms/FORM', '/_caracms/forms']) assert.equal(isLetThrough(path, 'POST'), false, path);
		const write = guard(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { Origin: 'https://elsewhere.test' } }), signedOut);
		assert.equal((write as { response: Response }).response.status, 403);
		const same = guard(new Request(`${ORIGIN}/_caracms/submissions/x/read`, { method: 'POST', headers: { Origin: ORIGIN } }), signedOut);
		assert.equal((same as { response: Response }).response.status, 401);
		assert.equal(isLetThrough('/_caracms/github', 'POST'), true, 'the webhook still checks its signature instead');
	});

	test('the unconfigured server answers 503 on every /_caracms/ path but the form endpoint', () => {
		assert.equal(isEditorPath('/_caracms/form'), false);
		assert.equal(isEditorPath('/_caracms/form/'), false);
		for (const path of ['/_caracms/submissions', '/_caracms/write', '/admin', '/admin/submissions', '/_caracms/forms']) assert.equal(isEditorPath(path), true, path);
	});
});

describe('the inbox address and its first paint', () => {
	test('/admin/submissions and /admin/submissions/<id>', () => {
		assert.deepEqual(inboxFromAddress('/admin/submissions'), { id: null });
		assert.deepEqual(inboxFromAddress('/admin/submissions/'), { id: null });
		assert.deepEqual(inboxFromAddress('/admin/submissions/2026-10-16T09-01-00-000Z_k3f9a2'), { id: '2026-10-16T09-01-00-000Z_k3f9a2' });
		assert.equal(inboxFromAddress('/admin/submissions/nope'), 'bad');
		assert.equal(inboxFromAddress('/admin/pages/about'), null);
	});

	test('the unread count, or the sentence naming the missing variables', async () => {
		await make(1);
		assert.deepEqual(await submissionsSetup({ site, store }), { unread: 1 });
		const off = await submissionsSetup({ site, env: { NODE_ENV: 'production' } });
		assert.equal(off.unread, null);
		assert.match((off as { error: string }).error, /SUBMISSIONS_S3_BUCKET/);
		const res = await get('/_caracms/submissions', ctx({ store: undefined, env: { NODE_ENV: 'production' } }));
		assert.equal(res.status, 503);
		assert.equal(((await res.json()) as { code: string }).code, 'submissions-unset');
	});

	test('the unread count follows writes made through the store', async () => {
		const a = await make(1);
		assert.equal(await store.unreadCount(), 1);
		await make(2);
		assert.equal(await store.unreadCount(), 2);
		await store.update(a.id, { readAt: '2026-10-16T10:00:00.000Z' });
		assert.equal(await store.unreadCount(), 1);
		await store.delete(a.id);
		assert.equal(await store.unreadCount(), 1);
	});
});

describe('the unread count on the editor pages never stalls them (review fix 1)', () => {
	/** A store whose count is the given function; everything else is the real one. */
	const counting = (unreadCount: () => Promise<number>): SubmissionStore => ({ ...store, unreadCount });
	const never = () => new Promise<number>(() => {});

	test('a count that does not come back in time is the unreadable shape, then remembered for the retry window', async () => {
		let asked = 0;
		let clock = 1_000;
		const slow = counting(() => (asked++, never()));
		const timing = { waitMs: 20, retryMs: 30_000, now: () => clock };
		const started = Date.now();
		const first = await submissionsSetupQuick({ site, store: slow, log: () => {} }, timing);
		assert.ok(Date.now() - started < 1000, 'it stopped waiting');
		assert.deepEqual(first, { unread: null, error: "The submissions couldn't be read just now.", code: 'submissions-unreadable', missing: [] });
		assert.equal(asked, 1);

		clock += 10_000;
		const again = await submissionsSetupQuick({ site, store: slow, log: () => {} }, timing);
		assert.equal(again.unread, null);
		assert.equal(asked, 1, 'within the window it does not ask again');

		clock += 21_000;
		await submissionsSetupQuick({ site, store: slow, log: () => {} }, timing);
		assert.equal(asked, 2, 'after the window it tries again');
	});

	test('an error is the unreadable shape too, and is remembered', async () => {
		let asked = 0;
		const failing = counting(async () => {
			asked++;
			throw new Error('list: 500');
		});
		const lines: string[] = [];
		const timing = { waitMs: 500, retryMs: 30_000, now: () => 0 };
		const one = await submissionsSetupQuick({ site, store: failing, log: (l) => lines.push(l) }, timing);
		assert.equal((one as { code: string }).code, 'submissions-unreadable');
		assert.ok(lines.some((l) => /list: 500/.test(l)));
		await submissionsSetupQuick({ site, store: failing, log: () => {} }, timing);
		assert.equal(asked, 1);
	});

	test('a good count is the count; a failure that is over is forgotten once a count lands', async () => {
		await make(1);
		let fail = true;
		const flaky = counting(async () => {
			if (fail) throw new Error('down');
			return store.unreadCount();
		});
		let clock = 0;
		const timing = { waitMs: 500, retryMs: 100, now: () => clock };
		assert.equal((await submissionsSetupQuick({ site, store: flaky, log: () => {} }, timing)).unread, null);
		fail = false;
		clock = 200;
		assert.deepEqual(await submissionsSetupQuick({ site, store: flaky, log: () => {} }, timing), { unread: 1 });
	});

	test('an unset bucket is still the unset shape, at once', async () => {
		const off = await submissionsSetupQuick({ site, env: { NODE_ENV: 'production' } });
		assert.equal((off as { code: string }).code, 'submissions-unset');
	});
});

describe('the unread set (review fix 5)', () => {
	test('a write landing while the first listing is under way, then failing, leaves no unhandled rejection', async () => {
		const slow = new MemoryBackend();
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		slow.ids = async () => {
			await gate;
			throw new Error('list failed');
		};
		const s = storeOver(slow);
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const counted = s.unreadCount();
			const caught = counted.then(
				() => null,
				(error: unknown) => error,
			);
			await s.create({ form: 'contact', receivedAt: '2026-10-16T09:00:00.000Z', fields: { name: 'A', email: 'a@x.test', message: 'm' } });
			open();
			assert.match(String(await caught), /list failed/, 'the count itself still fails for its caller');
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepEqual(unhandled, []);
			// The count rebuilds on the next read, now that the listing works.
			slow.ids = MemoryBackend.prototype.ids;
			assert.equal(await s.unreadCount(), 1);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});
