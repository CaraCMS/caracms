// M6 Decisions 5–8 (Acceptance 3–13, 18–20): POST /_caracms/form, in-process, over the memory store.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { resolveSite, type FormConfig } from '../src/config.ts';
import { BODY_LIMIT, cleanReturn, handleForm, RATE_LIMITED_MESSAGE, STORE_FAILED_MESSAGE, TOO_LARGE_MESSAGE, TOO_LONG_MESSAGE, TURNSTILE_MESSAGE, type FormContext } from '../src/forms/endpoint.ts';
import { buildNotification, formSettingsFrom, receivedText } from '../src/forms/email.ts';
import { memoryLimiter, redisLimiter } from '../src/forms/rate-limit.ts';
import { MemoryBackend, readSubmissionsConfig, storeOver, SUBMISSIONS_MEMORY_IN_PRODUCTION } from '../src/forms/store.ts';
import { MemoryBackend as MemoryGit } from '../src/live/backend.ts';
import { createLiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { siteRoot, variant } from './helpers/site.ts';

const FORMS: Record<string, FormConfig> = {
	contact: {
		label: 'Contact',
		email: { subject: 'New contact enquiry' },
		fields: {
			name: { label: 'Name', autocomplete: 'name' },
			email: { label: 'Email', type: 'email' },
			topic: { label: 'Topic', type: 'select', optional: true, options: [{ value: 'branding', label: 'Branding' }, { value: 'web', label: 'A website' }] },
			message: { label: 'Message', type: 'textarea' },
			plans: { label: 'Plans', type: 'files', optional: true },
		},
	},
};
const resolved = resolveSite(variant({ forms: FORMS, timeZone: 'Europe/Dublin' }), siteRoot);
const noFiles = resolveSite(variant({ forms: { contact: { ...FORMS.contact!, fields: { name: FORMS.contact!.fields.name!, email: FORMS.contact!.fields.email!, message: FORMS.contact!.fields.message! } } } }), siteRoot);

const URL_ = 'http://site.test/_caracms/form';
const good = { form: 'contact', return: '/contact', name: 'Aoife', email: 'aoife@example.com', message: 'Hello there', topic: 'web' };

let backend: MemoryBackend;
let logs: string[];
let sent: { url: string; body: Record<string, unknown> }[];

const fakeFetch = (answers: { resend?: number; turnstile?: boolean | 'down' } = {}): typeof fetch =>
	(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
		sent.push({ url, body });
		if (url.includes('challenges.cloudflare.com')) {
			if (answers.turnstile === 'down') throw new Error('connect ECONNREFUSED');
			return Response.json({ success: answers.turnstile ?? true });
		}
		const status = answers.resend ?? 200;
		return status === 200 ? Response.json({ id: 'x' }) : Response.json({ message: 'The from address is not verified' }, { status });
	}) as typeof fetch;

const ctx = (patch: Partial<FormContext> = {}): FormContext => ({
	site: resolved,
	env: {},
	store: storeOver(backend),
	limiter: memoryLimiter(),
	log: (line) => logs.push(line),
	readSettings: async () => formSettingsFrom({ brand: { name: 'CaraCMS' }, formRecipients: { contact: ['walker@example.com'] } }),
	fetch: fakeFetch(),
	...patch,
});

const encoded = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
	new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
const asJson = { Accept: 'application/json' };
/** A browser's multipart post, buffered (as a Node server's body arrives), so a cut read leaves no stream behind. */
const multipart = async (fields: Record<string, string>, files: { name: string; type: string; bytes: Uint8Array | number }[] = [], field = 'plans', headers: Record<string, string> = asJson) => {
	const data = new FormData();
	for (const [k, v] of Object.entries(fields)) data.append(k, v);
	for (const f of files) data.append(field, new File([(typeof f.bytes === 'number' ? new Uint8Array(f.bytes) : f.bytes) as BlobPart], f.name, { type: f.type }));
	const encoded = new Response(data);
	return new Request(URL_, { method: 'POST', headers: { ...headers, 'Content-Type': encoded.headers.get('content-type')! }, body: await encoded.arrayBuffer() });
};
const stored = async () => (await storeOver(backend).list()).items;

beforeEach(() => {
	backend = new MemoryBackend();
	logs = [];
	sent = [];
});

describe('the reply (Acceptance 3–5)', () => {
	test('a no-JS form post: 303 to <return>?sent=1, one submission stored', async () => {
		const res = await handleForm(encoded(good), ctx());
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/contact?sent=1');
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
		const items = await stored();
		assert.equal(items.length, 1);
		assert.deepEqual(items[0]!.fields, { name: 'Aoife', email: 'aoife@example.com', topic: 'web', message: 'Hello there' });
		assert.equal(items[0]!.form, 'contact');
		assert.equal(items[0]!.readAt, null);
	});

	test('a fetch with Accept: application/json gets { ok: true }, and stores one', async () => {
		const res = await handleForm(await multipart(good), ctx());
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });
		assert.equal((await stored()).length, 1);
	});

	for (const bad of ['//evil.test', 'https://evil.test', '/x?y', '/\\evil.test', '/Contact']) {
		test(`a return of ${bad} becomes /`, async () => {
			assert.equal(cleanReturn(bad), '/');
			const res = await handleForm(encoded({ ...good, return: bad }), ctx());
			assert.equal(res.headers.get('location'), '/?sent=1');
		});
	}

	test('an unknown form id: 400, nothing stored', async () => {
		for (const form of ['quote', '', '__proto__']) {
			const res = await handleForm(encoded({ ...good, form }, asJson), ctx());
			assert.equal(res.status, 400);
			assert.match(((await res.json()) as { error: string }).error, /isn't on the site/);
		}
		assert.equal(backend.objects.size, 0);
	});

	test('GET is a 405', async () => {
		const res = await handleForm(new Request(URL_), ctx());
		assert.equal(res.status, 405);
		assert.equal(res.headers.get('allow'), 'POST');
	});
});

describe('the honeypot and the fields (Acceptance 6–7)', () => {
	test('a filled fax gets the success reply and nothing is stored, files included', async () => {
		const res = await handleForm(await multipart({ ...good, fax: '555' }, [{ name: 'plan.pdf', type: 'application/pdf', bytes: 10 }]), ctx());
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });
		assert.equal(backend.objects.size, 0);
		assert.equal(sent.length, 0, 'no email');
	});

	test('a missing required field is named; a bad email and a select outside its options come back in the same 400', async () => {
		const res = await handleForm(encoded({ form: 'contact', email: 'not-an-address', topic: 'catering', name: '' }, asJson), ctx());
		assert.equal(res.status, 400);
		const { error } = (await res.json()) as { error: string };
		assert.match(error, /^Missing: Name, Message\./);
		assert.match(error, /That email address doesn't look right\./);
		assert.match(error, /Topic: choose one of the options\./);
		assert.equal(backend.objects.size, 0);
	});

	test('review gaps (Acceptance 17): the 400 names a field by Site Settings’ label when it has one', async () => {
		const worded = ctx({ readSettings: async () => formSettingsFrom({ brand: { name: 'CaraCMS' }, formRecipients: {}, formWords: { contact: { fields: { name: { label: 'Your name' } } } } }) });
		const res = await handleForm(encoded({ form: 'contact', email: 'a@b.test', name: '' }, asJson), worded);
		const { error } = (await res.json()) as { error: string };
		assert.match(error, /^Missing: Your name, Message\./);
	});

	test('an optional field left out is stored as an empty string', async () => {
		const { topic: _, ...rest } = good;
		await handleForm(encoded(rest), ctx());
		assert.equal((await stored())[0]!.fields.topic, '');
	});

	test('a no-JS refusal is plain text', async () => {
		const res = await handleForm(encoded({ ...good, email: 'x' }), ctx());
		assert.equal(res.status, 400);
		assert.match(res.headers.get('content-type')!, /text\/plain/);
		assert.equal(await res.text(), "That email address doesn't look right.");
	});
});

describe('files (Acceptance 9–10, 17)', () => {
	test('files are stored beside the submission under safe keys, with their sizes', async () => {
		const res = await handleForm(await multipart(good, [{ name: '../../Site plan.pdf', type: 'application/pdf', bytes: 1200 }, { name: 'photo.HEIC', type: '', bytes: 30 }]), ctx());
		assert.equal(res.status, 200);
		const [s] = await stored();
		assert.equal(s!.files!.length, 2);
		assert.equal(s!.files![0]!.key, `${s!.id}/1-Site-plan.pdf`);
		assert.equal(s!.files![0]!.name, '../../Site plan.pdf');
		assert.equal(s!.files![0]!.size, 1200);
		assert.equal(s!.files![1]!.key, `${s!.id}/2-photo.HEIC`);
		assert.equal(backend.objects.get(s!.files![0]!.key)!.byteLength, 1200);
	});

	test("a sixth file, a .exe, and a .pdf declared image/png each get the template's sentence; nothing is stored", async () => {
		const pdf = { name: 'a.pdf', type: 'application/pdf', bytes: 1 };
		const six = await handleForm(await multipart(good, [pdf, pdf, pdf, pdf, pdf, pdf]), ctx());
		assert.equal(six.status, 400);
		assert.equal(((await six.json()) as { error: string }).error, 'Attach up to 5 files (you chose 6).');
		const exe = await handleForm(await multipart(good, [{ name: 'setup.exe', type: 'application/octet-stream', bytes: 1 }]), ctx());
		assert.equal(((await exe.json()) as { error: string }).error, "setup.exe: we can't take that kind of file. Send JPEG, PNG, WebP, HEIC, PDF, Word or Excel files.");
		const liar = await handleForm(await multipart(good, [{ name: 'plan.pdf', type: 'image/png', bytes: 1 }]), ctx());
		assert.equal(((await liar.json()) as { error: string }).error, "plan.pdf: the file isn't what its name says (a .pdf file). Save it again as a .pdf, or send another.");
		assert.equal(backend.objects.size, 0);
	});

	test('a declared Content-Length over the cap is a 413 about attachments, before the body is read', async () => {
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(1024));
			},
		});
		const request = new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(30 * 1024 * 1024), ...asJson }, body, duplex: 'half' } as RequestInit);
		const res = await handleForm(request, ctx());
		assert.equal(res.status, 413);
		assert.equal(((await res.json()) as { error: string }).error, TOO_LARGE_MESSAGE);
		assert.ok(pulled <= 1, `read ${pulled} chunks`);
		assert.equal(backend.objects.size, 0);
	});

	test('a body without a Content-Length is cut at the chunk that passes the cap', async () => {
		let sentBytes = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				sentBytes += 1024 * 1024;
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
		});
		const request = new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x', ...asJson }, body, duplex: 'half' } as RequestInit);
		const res = await handleForm(request, ctx());
		assert.equal(res.status, 413);
		assert.ok(sentBytes <= 27 * 1024 * 1024, `read ${sentBytes} bytes`);
	});

	test('files over 25 MB in all: the attachments sentence', async () => {
		// 25.1 MiB of files: under the body's cap, over the files'.
		const res = await handleForm(await multipart(good, [{ name: 'a.pdf', type: 'application/pdf', bytes: 12.55 * 1024 * 1024 }, { name: 'b.pdf', type: 'application/pdf', bytes: 12.55 * 1024 * 1024 }]), ctx());
		assert.equal(res.status, 413);
		assert.equal(((await res.json()) as { error: string }).error, TOO_LARGE_MESSAGE);
	});

	test('a multipart body to a site with no files field is held to 256 KB, and its file parts are never stored', async () => {
		const big = await handleForm(await multipart(good, [{ name: 'a.pdf', type: 'application/pdf', bytes: BODY_LIMIT + 10 }]), ctx({ site: noFiles }));
		assert.equal(big.status, 413);
		assert.equal(((await big.json()) as { error: string }).error, TOO_LONG_MESSAGE);
		const small = await handleForm(await multipart(good, [{ name: 'a.pdf', type: 'application/pdf', bytes: 10 }]), ctx({ site: noFiles }));
		assert.equal(small.status, 200);
		const [s] = await stored();
		assert.equal(s!.files, undefined);
		assert.equal(backend.objects.size, 1);
	});
});

describe('the rate limit (Acceptance 8)', () => {
	test('a sixth hit from one IP within 10 minutes is a 429; small failures and the honeypot do not count; Turnstile refusals do', async () => {
		const limiter = memoryLimiter();
		const c = ctx({ limiter });
		const from = (ip: string) => ({ ...asJson, 'X-Real-IP': ip });
		// Small failures and a small honeypot post don't count.
		for (let i = 0; i < 6; i++) assert.equal((await handleForm(encoded({ ...good, email: 'x' }, from('1.1.1.1')), c)).status, 400);
		assert.equal((await handleForm(encoded({ ...good, fax: '1' }, from('1.1.1.1')), c)).status, 200);
		for (let i = 0; i < 4; i++) assert.equal((await handleForm(encoded(good, from('1.1.1.1')), c)).status, 200);
		// A Turnstile refusal counts: the 5th hit.
		const withKeys = ctx({ limiter, env: { TURNSTILE_SECRET_KEY: 'k' }, fetch: fakeFetch({ turnstile: false }) });
		assert.equal((await handleForm(encoded({ ...good, 'cf-turnstile-response': 'bad' }, from('1.1.1.1')), withKeys)).status, 403);
		const sixth = await handleForm(encoded(good, from('1.1.1.1')), c);
		assert.equal(sixth.status, 429);
		assert.equal(((await sixth.json()) as { error: string }).error, RATE_LIMITED_MESSAGE);
		assert.equal((await handleForm(encoded(good, from('2.2.2.2')), c)).status, 200, 'another IP is fine');
		assert.equal((await stored()).length, 5);
	});

	test('a store failure does not use up a try; the limit is still checked before storing (review fix 6)', async () => {
		const limiter = memoryLimiter();
		const ip = { ...asJson, 'X-Real-IP': '4.4.4.4' };
		backend.failOn = (call) => call.startsWith('put:') && call.endsWith('.json');
		for (let i = 0; i < 8; i++) assert.equal((await handleForm(encoded(good, ip), ctx({ limiter }))).status, 502);
		assert.equal(await limiter.peek('4.4.4.4'), false, 'eight 502s counted for nothing');
		backend.failOn = null;
		for (let i = 0; i < 5; i++) assert.equal((await handleForm(encoded(good, ip), ctx({ limiter }))).status, 200, `stored try ${i + 1}`);
		const sixth = await handleForm(encoded(good, ip), ctx({ limiter }));
		assert.equal(sixth.status, 429);
		assert.equal((await stored()).length, 5, 'the sixth was refused before it was stored');
	});

	test('the window is 10 minutes', async () => {
		let t = 0;
		const limiter = memoryLimiter({ now: () => t });
		for (let i = 0; i < 5; i++) assert.equal(await limiter.hit('ip'), false);
		assert.equal(await limiter.hit('ip'), true);
		t += 10 * 60 * 1000 + 1;
		assert.equal(await limiter.hit('ip'), false);
	});

	test('a large body that ends in the honeypot counts; at the limit a large body is refused before it is read', async () => {
		const limiter = memoryLimiter();
		const c = ctx({ limiter });
		const big = [{ name: 'big.pdf', type: 'application/pdf', bytes: BODY_LIMIT }];
		for (let i = 0; i < 5; i++) assert.equal((await handleForm(await multipart({ ...good, fax: '1' }, big, 'plans', { ...asJson, 'X-Real-IP': '3.3.3.3' }), c)).status, 200);
		assert.equal(await limiter.peek('3.3.3.3'), true);
		const res = await handleForm(await multipart(good, [{ name: 'a.pdf', type: 'application/pdf', bytes: 10 }], 'plans', { ...asJson, 'X-Real-IP': '3.3.3.3' }), c);
		assert.equal(res.status, 429);
		assert.equal(backend.objects.size, 0);
	});

	test('in Redis, the count survives a restart (a new limiter over the same Redis)', async () => {
		const redis = memoryRedis();
		for (let i = 0; i < 5; i++) assert.equal(await redisLimiter(redis).hit('9.9.9.9'), false);
		assert.equal(await redisLimiter(redis).hit('9.9.9.9'), true);
		assert.ok((await redis.pttl((await redis.scan('caracms:forms:rl:*'))[0]!)) > 9 * 60 * 1000, 'the key expires');
	});

	test('Redis out fails open, logged', async () => {
		const down = { ...memoryRedis(), incr: async () => Promise.reject(new Error('ECONNREFUSED')), get: async () => Promise.reject(new Error('ECONNREFUSED')) };
		const lines: string[] = [];
		const limiter = redisLimiter(down, (l) => lines.push(l));
		assert.equal(await limiter.hit('x'), false);
		assert.equal(await limiter.peek('x'), false);
		assert.match(lines[0]!, /couldn't reach Redis/);
	});
});

describe('Turnstile (Acceptance 11)', () => {
	test('with the keys set, no token or a failing one is a 403; Cloudflare unreachable is accepted with a log line', async () => {
		const env = { TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA' };
		const none = await handleForm(encoded(good, asJson), ctx({ env }));
		assert.equal(none.status, 403);
		assert.equal(((await none.json()) as { error: string }).error, TURNSTILE_MESSAGE);
		assert.equal((await handleForm(encoded({ ...good, 'cf-turnstile-response': 't' }, asJson), ctx({ env, fetch: fakeFetch({ turnstile: false }) }))).status, 403);
		assert.equal((await handleForm(encoded({ ...good, 'cf-turnstile-response': 't' }, asJson), ctx({ env, fetch: fakeFetch({ turnstile: true }) }))).status, 200);
		const turnstile = sent.find((s) => s.url.includes('siteverify'))!;
		assert.equal(turnstile.body.secret, env.TURNSTILE_SECRET_KEY);
		assert.equal(turnstile.body.response, 't');
		logs = [];
		assert.equal((await handleForm(encoded({ ...good, 'cf-turnstile-response': 't' }, asJson), ctx({ env, fetch: fakeFetch({ turnstile: 'down' }) }))).status, 200);
		assert.ok(logs.some((l) => /couldn't reach Turnstile/.test(l)));
		assert.equal((await stored()).length, 2);
	});

	test('with no keys it is accepted, with a warning logged', async () => {
		assert.equal((await handleForm(encoded(good, asJson), ctx())).status, 200);
		assert.ok(logs.some((l) => /TURNSTILE_SECRET_KEY is not set/.test(l)));
	});
});

describe('store, then email, then record (Acceptance 12–13, 18–20)', () => {
	test('a storage failure is a 502 "Could not send your message." and leaves nothing half-written', async () => {
		backend.failOn = (call) => call.startsWith('put:') && call.endsWith('.json');
		const res = await handleForm(await multipart(good, [{ name: 'a.pdf', type: 'application/pdf', bytes: 5 }]), ctx());
		assert.equal(res.status, 502);
		assert.equal(((await res.json()) as { error: string }).error, STORE_FAILED_MESSAGE);
		assert.equal(backend.objects.size, 0, 'the file written first was removed');
	});

	test('production with no bucket: 502, the missing names logged, never the disk', async () => {
		const res = await handleForm(encoded(good, asJson), ctx({ store: undefined, env: { NODE_ENV: 'production', S3_ENDPOINT: 'https://t3.test', S3_REGION: 'ams' } }));
		assert.equal(res.status, 502);
		assert.ok(logs.some((l) => /SUBMISSIONS_S3_BUCKET, SUBMISSIONS_S3_ACCESS_KEY_ID and SUBMISSIONS_S3_SECRET_ACCESS_KEY/.test(l)));
	});

	test('in production the email goes to the deployed recipients, from FORMS_FROM, Reply-To the visitor, and is recorded sent', async () => {
		const env = { NODE_ENV: 'production', RESEND_API_KEY: 're_test', FORMS_FROM: 'CaraCMS website <forms@noti.test>', SITE_URL: 'https://site.test' };
		const res = await handleForm(await multipart(good, [{ name: 'Site plan.pdf', type: 'application/pdf', bytes: 2048 }]), ctx({ env }));
		assert.equal(res.status, 200);
		const email = sent.find((s) => s.url === 'https://api.resend.com/emails')!;
		assert.equal(email.body.from, 'CaraCMS website <forms@noti.test>');
		assert.deepEqual(email.body.to, ['walker@example.com']);
		assert.equal(email.body.reply_to, 'aoife@example.com');
		assert.equal(email.body.subject, 'New contact enquiry — CaraCMS website');
		const text = String(email.body.text);
		const [s] = await stored();
		assert.match(text, /Name: Aoife\nEmail: aoife@example\.com\nTopic: A website\nMessage: Hello there\nPlans:\nSite plan\.pdf, 2 KB\n/);
		assert.ok(text.includes(`https://site.test/admin/submissions/${s!.id}`));
		assert.ok(!/storageapi|s3|bucket/i.test(text), 'no bucket URL');
		assert.equal(email.body.attachments, undefined);
		assert.equal(s!.email!.status, 'sent');
		assert.deepEqual(s!.email!.to, ['walker@example.com']);
	});

	test("the email's editor link uses the public origin, never the Host header (review fix 3)", async () => {
		const base = { NODE_ENV: 'production', RESEND_API_KEY: 're_test', FORMS_FROM: 'CaraCMS website <forms@noti.test>' };
		const emailText = () => String(sent.find((s) => s.url === 'https://api.resend.com/emails')!.body.text);
		const run = async (patch: Partial<FormContext>) => {
			sent.length = 0;
			assert.equal((await handleForm(encoded(good, { ...asJson, Host: 'evil.test' }), ctx({ ...patch, env: { ...base, ...patch.env }, store: storeOver(new MemoryBackend()) }))).status, 200);
			return emailText();
		};
		assert.match(await run({ astroSite: new URL('https://site.test/') }), /Open it in the editor:\nhttps:\/\/site\.test\/admin\/submissions\//);
		assert.match(await run({ env: { RAILWAY_PUBLIC_DOMAIN: 'site.up.railway.app' } }), /https:\/\/site\.up\.railway\.app\/admin\/submissions\//);
		const none = await run({});
		assert.match(none, /Open Site-wide → Submissions in the editor\./);
		assert.doesNotMatch(none, /https?:\/\/|evil\.test|\/admin\/submissions/, 'no link at all');
		assert.doesNotMatch(none, new RegExp(new URL(URL_).host.replace('.', '\\.')), 'and not the request URL either');
	});

	test("an email failure still gets the success reply, and records failed with Resend's message", async () => {
		const env = { NODE_ENV: 'production', RESEND_API_KEY: 're_test', FORMS_FROM: 'forms@noti.test' };
		const res = await handleForm(encoded(good, asJson), ctx({ env, fetch: fakeFetch({ resend: 422 }) }));
		assert.equal(res.status, 200);
		const [s] = await stored();
		assert.equal(s!.email!.status, 'failed');
		assert.equal(s!.email!.error, 'Resend answered 422: The from address is not verified');
	});

	test('Site Settings unreadable: recorded failed with "Could not read Site Settings"', async () => {
		await handleForm(encoded(good, asJson), ctx({ readSettings: async () => Promise.reject(new Error('ENOENT')) }));
		const [s] = await stored();
		assert.equal(s!.email!.status, 'failed');
		assert.match(s!.email!.error!, /^Could not read Site Settings/);
	});

	test('outside production the email is logged, not sent, and recorded skipped saying so', async () => {
		await handleForm(encoded(good, asJson), ctx({ env: { RESEND_API_KEY: 're_test', FORMS_FROM: 'forms@noti.test' } }));
		assert.equal(sent.filter((s) => s.url.includes('resend')).length, 0);
		assert.ok(logs.some((l) => l.includes('not emailed outside production') && l.includes('Subject: New contact enquiry')), 'the email is in the log');
		const [s] = await stored();
		assert.equal(s!.email!.status, 'skipped');
		assert.match(s!.email!.error!, /only the production server sends email/);
	});

	test('an empty recipient list stores the submission with email.status skipped', async () => {
		await handleForm(encoded(good, asJson), ctx({ env: { NODE_ENV: 'production', RESEND_API_KEY: 'k', FORMS_FROM: 'f@x.test' }, readSettings: async () => formSettingsFrom({ brand: { name: 'CaraCMS' }, formRecipients: { contact: [] } }) }));
		const [s] = await stored();
		assert.equal(s!.email!.status, 'skipped');
		assert.match(s!.email!.error!, /No one is set to get the Contact form's emails/);
	});

	test('the email skips an invalid address and a duplicate, and goes to the rest', async () => {
		const env = { NODE_ENV: 'production', RESEND_API_KEY: 'k', FORMS_FROM: 'f@x.test' };
		await handleForm(encoded(good, asJson), ctx({ env, readSettings: async () => formSettingsFrom({ formRecipients: { contact: [' a@b.test ', 'not an address', 'A@B.test', 'c@d.test'] } }) }));
		assert.deepEqual(sent.find((s) => s.url.includes('resend'))!.body.to, ['a@b.test', 'c@d.test']);
	});

	test('recipients and the brand name are read from the deployed file on disk', async () => {
		const root = await mkdtemp(join(tmpdir(), 'caracms-forms-'));
		try {
			await mkdir(join(root, 'content'), { recursive: true });
			await writeFile(join(root, 'content/site-settings.json'), JSON.stringify({ title: 'Site Settings', brand: { name: 'Site B' }, formRecipients: { contact: ['x@site-b.test'] } }));
			const env = { NODE_ENV: 'production', RESEND_API_KEY: 'k', FORMS_FROM: 'f@x.test' };
			await handleForm(encoded(good, asJson), ctx({ env, site: { ...resolved, root }, readSettings: undefined }));
			const email = sent.find((s) => s.url.includes('resend'))!;
			assert.deepEqual(email.body.to, ['x@site-b.test']);
			assert.equal(email.body.subject, 'New contact enquiry — Site B website');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('Acceptance 21: a recipient change in Site Settings (a live draft) does not apply until it is deployed to the file', async () => {
		const base = await mkdtemp(join(tmpdir(), 'caracms-forms-'));
		const root = join(base, 'site');
		const file = join(root, 'content/site-settings.json');
		const settingsWith = (to: string[]) => JSON.stringify({ title: 'Site Settings', brand: { name: 'Site B' }, formRecipients: { contact: to } }, null, 2) + '\n';
		try {
			// The config's font and component paths are relative to the site: the fixture's own files, copied.
			await cp(join(siteRoot, '../fonts'), join(base, 'fonts'), { recursive: true });
			await cp(siteRoot, root, { recursive: true });
			await mkdir(join(root, 'content'), { recursive: true });
			await writeFile(file, settingsWith(['deployed@site-b.test']));
			const live = resolveSite(variant({ forms: FORMS, repoPath: 'starter' } as never), root);
			// A live editor over the in-memory GitHub and the Redis stand-in: Site Settings' draft is kept there, never in the file.
			const backend = new MemoryGit(new Tracker(() => 0), { now: () => 0 });
			backend.seed([...(await siteFiles(live))]);
			const settings: LiveSettings = { github: { kind: 'memory' }, redisUrl: null, secret: 's'.repeat(32), allow: [], webhookSecret: null, railway: null, backup: null, runningCommit: null, timings: { ...DEFAULT_TIMINGS }, production: false };
			const rt = await createLiveRuntime({ site: live, settings, backend, redis: memoryRedis({ now: () => 0 }), now: () => 0, log: () => {}, runningCommit: () => null });
			const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
			const person = { email: 'aoife@example.com', name: 'Aoife' };
			const opened = (await ed.store.read('settings', 'site-settings')) as { entry: { file: string }; text: string; document: { data: Record<string, unknown> } };
			const document = JSON.parse(JSON.stringify(opened.document)) as typeof opened.document;
			document.data.formRecipients = { contact: ['draft@site-b.test'] };
			const res = await ed.write(
				new Request('http://site.test/_caracms/write', { method: 'POST', headers: { origin: 'http://site.test', 'content-type': 'application/json', 'x-caracms-tab': 'tab-aoife-1' }, body: JSON.stringify({ file: opened.entry.file, base: opened.text, document }) }),
				person,
			);
			assert.equal(res.status, 200, await res.clone().text());
			assert.match(((await ed.store.read('settings', 'site-settings')) as { text: string }).text, /draft@site-b\.test/, 'the editor reads the draft with the change');
			assert.doesNotMatch(await readFile(file, 'utf8'), /draft@site-b/, 'the deployed file does not');

			const env = { NODE_ENV: 'production', RESEND_API_KEY: 'k', FORMS_FROM: 'f@x.test' };
			const recipients = async () => {
				sent = [];
				await handleForm(encoded(good, asJson), ctx({ env, site: { ...live, root }, readSettings: undefined }));
				return sent.find((s) => s.url.includes('resend'))!.body.to;
			};
			assert.deepEqual(await recipients(), ['deployed@site-b.test'], 'the email still goes to the deployed list');
			await writeFile(file, settingsWith(['draft@site-b.test'])); // published and deployed
			assert.deepEqual(await recipients(), ['draft@site-b.test'], 'and to the new one once the file has it');
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test('the received time is in the site zone', () => {
		assert.equal(receivedText('2026-10-16T13:12:00.000Z', 'Europe/Dublin'), '16 October 2026, 2:12 pm');
		const { text } = buildNotification({ submission: { v: 1, id: '2026-10-16T13-12-00-000Z_aaaaaa', form: 'contact', receivedAt: '2026-10-16T13:12:00.000Z', fields: { email: 'a@b.test' }, readAt: null }, form: resolved.forms.contact!, brandName: 'CaraCMS', siteUrl: 'https://site.test', timeZone: 'Europe/Dublin' });
		assert.match(text, /Received: 16 October 2026, 2:12 pm/);
	});
});

describe('where submissions go (Acceptance 15–16)', () => {
	test('outside production: the folder, even with the bucket variables set', () => {
		const env = { SUBMISSIONS_S3_BUCKET: 'b', SUBMISSIONS_S3_ACCESS_KEY_ID: 'k', SUBMISSIONS_S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'https://t3.test', S3_REGION: 'ams' };
		assert.deepEqual(readSubmissionsConfig('/site', env), { kind: 'folder', dir: '/site/.caracms/submissions' });
		const prod = readSubmissionsConfig('/site', { ...env, NODE_ENV: 'production' });
		assert.equal(prod.kind, 'bucket');
	});

	test('production with them unset is unset, naming them; CARACMS_SUBMISSIONS=memory is refused in production', () => {
		const unset = readSubmissionsConfig('/site', { NODE_ENV: 'production' });
		assert.equal(unset.kind, 'unset');
		assert.deepEqual((unset as { missing: string[] }).missing, ['SUBMISSIONS_S3_BUCKET', 'SUBMISSIONS_S3_ACCESS_KEY_ID', 'SUBMISSIONS_S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT', 'S3_REGION']);
		assert.deepEqual(readSubmissionsConfig('/site', { NODE_ENV: 'production', CARACMS_SUBMISSIONS: 'memory' }), { kind: 'unset', message: SUBMISSIONS_MEMORY_IN_PRODUCTION, missing: [] });
		assert.deepEqual(readSubmissionsConfig('/site', { CARACMS_SUBMISSIONS: 'memory' }), { kind: 'memory' });
	});

	test('the folder store writes under .caracms/submissions/ (the endpoint with no store given)', async () => {
		const root = await mkdtemp(join(tmpdir(), 'caracms-forms-'));
		try {
			const res = await handleForm(await multipart(good, [{ name: 'a.pdf', type: 'application/pdf', bytes: 3 }]), ctx({ store: undefined, site: { ...resolved, root } }));
			assert.equal(res.status, 200);
			const names = await readdir(join(root, '.caracms/submissions'));
			const json = names.find((n) => n.endsWith('.json'))!;
			const record = JSON.parse(await readFile(join(root, '.caracms/submissions', json), 'utf8')) as { id: string; v: number };
			assert.equal(record.v, 1);
			assert.deepEqual(await readdir(join(root, '.caracms/submissions', record.id)), ['1-a.pdf']);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
