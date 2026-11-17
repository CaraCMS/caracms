// Runs anywhere: the request side. The visitor's IP from
// `caracms start`'s gate alone in production, and the 503 without it (Decision 8; acceptance
// checks 14–17, the gate's own half is gate.test.ts), and the site's address: the chain for
// emailed links and trusted domains (check 10), and the sentence naming SITE_URL when the site
// is opened at another address (Decision 7; check 11).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import { handleFileRequest } from '../src/files-route.ts';
import { handleForm } from '../src/forms/endpoint.ts';
import { memoryLimiter } from '../src/forms/rate-limit.ts';
import { MemoryBackend as SubmissionsMemory, storeOver } from '../src/forms/store.ts';
import { siteAddress, trustedDomains } from '../src/index.ts';
import { createAuth } from '../src/live/auth/auth.ts';
import { guard } from '../src/live/auth/guard.ts';
import { publicOrigin } from '../src/live/auth/index.ts';
import { handleLogin, type LoginContext } from '../src/live/auth/login.ts';
import { addressMismatch, addressNotice, CLIENT_IP_HEADER, clientIp, GATED_MARK, isGatedProcess, NO_GATE_MESSAGE } from '../src/live/auth/request.ts';
import { sessionCookieFor } from '../src/live/auth/session.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { siteRoot, variant } from './helpers/site.ts';

const SECRET = 's'.repeat(32);

// This file stands in for a server started by `caracms start`: the gate's mark is on the
// process (as `markProcessGated()` puts it there before importing the built site), so the
// gate's header is trusted. `withoutGate` takes it off, as for `node dist/server/entry.mjs`.
const marks = globalThis as Record<symbol, unknown>;
marks[GATED_MARK] = true;
async function withoutGate<T>(fn: () => T | Promise<T>): Promise<T> {
	delete marks[GATED_MARK];
	try {
		return await fn();
	} finally {
		marks[GATED_MARK] = true;
	}
}
const brand = { name: 'CaraCMS', accent: '#1f3a2e', accentInk: '#ffffff', accentEdge: '#1f3a2e', icon: '/icon.svg' };
const assets = { tokensCss: ':root{--surface:#fff}', fontsCss: '' };

/** A production sign-in: Secure cookies, a backup account, the site at `siteOrigin`. */
function production(siteOrigin: string | null = 'https://www.example.com') {
	const links: string[] = [];
	const auth = createAuth({
		secret: SECRET,
		agency: ['aoife@example.com'],
		backup: { user: 'backup', password: 'p'.repeat(24) },
		secure: true,
		redis: memoryRedis(),
		readSettings: () => null,
		siteName: 'CaraCMS',
		siteOrigin,
		env: { NODE_ENV: 'production' },
		log: () => {},
		deliver: async ({ link }) => (links.push(link), 'sent'),
	});
	const ctx: LoginContext = { auth, brand, assets, clientAddress: () => '10.0.0.1' };
	return { auth, ctx, links };
}

describe('the client IP (Decision 8, the Contracts)', () => {
	const r = (h: Record<string, string>) => new Request('https://www.example.com/', { headers: h });

	test('in production, only the gate\'s header: forged X-Real-IP and X-Forwarded-For are never read', () => {
		assert.equal(clientIp(r({ [CLIENT_IP_HEADER]: '198.51.100.7', 'X-Real-IP': '1.1.1.1', 'X-Forwarded-For': '2.2.2.2' }), () => '3.3.3.3', true), '198.51.100.7');
		assert.equal(clientIp(r({ 'X-Real-IP': '1.1.1.1', 'X-Forwarded-For': '2.2.2.2' }), () => '3.3.3.3', true), null, 'no header: null, never the adapter\'s address');
		assert.equal(clientIp(r({ [CLIENT_IP_HEADER]: '  ' }), () => '3.3.3.3', true), null);
	});

	test('in production with no gate\'s mark on the process, the header is never read: a visitor\'s own copy gets null', async () => {
		await withoutGate(() => {
			assert.equal(isGatedProcess(), false);
			assert.equal(clientIp(r({ [CLIENT_IP_HEADER]: '198.51.100.7' }), () => '3.3.3.3', true), null);
			assert.equal(clientIp(r({ [CLIENT_IP_HEADER]: '198.51.100.7', 'X-Real-IP': '1.1.1.1' }), () => '3.3.3.3', true), null);
		});
		// Only `true` counts as the mark.
		marks[GATED_MARK] = 'yes';
		try {
			assert.equal(clientIp(r({ [CLIENT_IP_HEADER]: '198.51.100.7' }), () => '3.3.3.3', true), null);
		} finally {
			marks[GATED_MARK] = true;
		}
		assert.equal(GATED_MARK, Symbol.for('caracms.gated'), 'the same symbol bin/gate.mjs sets');
	});

	test('under astro dev, as before: the gate\'s header means nothing there, and neither does the mark', async () => {
		assert.equal(clientIp(r({ [CLIENT_IP_HEADER]: '198.51.100.7', 'X-Real-IP': '1.1.1.1' }), () => '3.3.3.3'), '1.1.1.1');
		await withoutGate(() => assert.equal(clientIp(r({ [CLIENT_IP_HEADER]: '198.51.100.7', 'X-Real-IP': '1.1.1.1' }), () => '3.3.3.3'), '1.1.1.1'));
		await withoutGate(() => assert.equal(clientIp(r({}), () => '3.3.3.3'), '3.3.3.3'));
	});

	test('checks 14–15, the request side: rotating X-Real-IP, X-Forwarded-For and the socket doesn\'t get past the sign-in limit', async () => {
		const { ctx } = production();
		const attempt = (i: number) =>
			handleLogin(
				new Request('https://www.example.com/admin/login/signin', {
					method: 'POST',
					headers: { origin: 'https://www.example.com', 'content-type': 'application/json', [CLIENT_IP_HEADER]: '198.51.100.7', 'x-real-ip': `1.1.1.${i}`, 'x-forwarded-for': `2.2.2.${i}` },
					body: JSON.stringify({ kind: 'backup', username: 'backup', password: 'wrong' }),
				}),
				{ ...ctx, clientAddress: () => `3.3.3.${i}` },
			);
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) statuses.push((await attempt(i)).status);
		assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
	});
});

describe('check 17: a production server not started by caracms start', () => {
	// No gate's mark on the process, and a visitor who sends the gate's header themselves,
	// rotating it as a brute force would: every attempt is the 503, never a limit's 401/429.
	const forged = (i: number) => ({ [CLIENT_IP_HEADER]: `198.51.100.${i}`, 'x-real-ip': `1.1.1.${i}`, 'x-forwarded-for': `2.2.2.${i}` });

	test('sign-in: the form, the sign-in POST and the backup form all answer 503 with the sentence, a forged gate header or not', async () => {
		const { ctx } = production();
		await withoutGate(async () => {
			const page = await handleLogin(new Request('https://www.example.com/admin/login'), ctx);
			assert.equal(page.status, 503);
			assert.ok((await page.text()).includes('started with `caracms start`'));
			for (const headers of [{}, forged(0)]) {
				const post = await handleLogin(
					new Request('https://www.example.com/admin/login/signin', { method: 'POST', headers: { origin: 'https://www.example.com', 'content-type': 'application/json', ...headers }, body: '{"kind":"backup"}' }),
					ctx,
				);
				assert.equal(post.status, 503);
				assert.deepEqual(await post.json(), { error: NO_GATE_MESSAGE, reason: 'failed' });
			}
			const forgedPage = await handleLogin(new Request('https://www.example.com/admin/login', { headers: forged(1) }), ctx);
			assert.equal(forgedPage.status, 503, 'the sign-in form too');
			const statuses: number[] = [];
			for (let i = 0; i < 8; i++) {
				const res = await handleLogin(
					new Request('https://www.example.com/admin/login/signin', {
						method: 'POST',
						headers: { origin: 'https://www.example.com', 'content-type': 'application/json', ...forged(i) },
						body: JSON.stringify({ kind: 'backup', username: 'backup', password: 'wrong' }),
					}),
					{ ...ctx, clientAddress: () => `3.3.3.${i}` },
				);
				statuses.push(res.status);
			}
			assert.deepEqual(statuses, Array(8).fill(503), 'rotating the forged header gets to no password check at all');
		});
		// Behind the gate (the mark on), the form is there.
		assert.equal((await handleLogin(new Request('https://www.example.com/admin/login', { headers: { [CLIENT_IP_HEADER]: '198.51.100.7' } }), ctx)).status, 200);
	});

	test('the form endpoint: 503 with the sentence, a forged gate header or not, nothing stored', async () => {
		const site = resolveSite(variant({ forms: { contact: { label: 'Contact', email: { subject: 'New contact enquiry' }, fields: { name: { label: 'Name' }, email: { label: 'Email', type: 'email' } } } } } as Partial<SiteConfig>), siteRoot);
		const backend = new SubmissionsMemory();
		const post = (headers: Record<string, string>) =>
			handleForm(new Request('https://www.example.com/_caracms/form', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers }, body: 'form=contact&name=Aoife&email=aoife%40example.com&return=/contact' }), {
				site,
				production: true,
				env: {},
				store: storeOver(backend),
				limiter: memoryLimiter(),
				log: () => {},
				readSettings: async () => ({ recipients: {}, brandName: 'CaraCMS' }) as never,
				fetch: (async () => new Response('{}')) as typeof fetch,
			});
		await withoutGate(async () => {
			for (const headers of [{}, forged(0), forged(1), forged(2)]) {
				const refused = await post(headers);
				assert.equal(refused.status, 503);
				assert.deepEqual(await refused.json(), { error: NO_GATE_MESSAGE });
			}
		});
		assert.equal((await storeOver(backend).list()).items.length, 0);
		assert.notEqual((await post({ [CLIENT_IP_HEADER]: '198.51.100.7' })).status, 503, 'through the gate, the post is handled');
	});

	test('downloads at /files: 503 with the sentence, a forged gate header or not', async () => {
		memoryMedia().reset();
		const get = (headers: Record<string, string>) =>
			handleFileRequest(new Request('https://www.example.com/files/0123456789ab/rulebook.pdf', { headers }), { env: { CARACMS_MEDIA: 'memory' }, production: true, limiter: memoryLimiter(), log: () => {} });
		await withoutGate(async () => {
			for (const headers of [{}, forged(0), forged(1)]) {
				const res = await get(headers);
				assert.equal(res.status, 503);
				assert.equal(await res.text(), NO_GATE_MESSAGE);
			}
		});
		// Through the gate it gets past the IP (to whatever the file route answers next).
		assert.notEqual(await (await get({ [CLIENT_IP_HEADER]: '198.51.100.7' })).text(), NO_GATE_MESSAGE);
	});
});

describe("check 10: SITE_URL set and Astro's site unset", () => {
	test('emailed sign-in links, the trusted domains and the forms\' editor link all use SITE_URL', async () => {
		const env = { SITE_URL: 'https://example.com' };
		assert.equal(publicOrigin(undefined, env), 'https://example.com');
		assert.deepEqual(trustedDomains(siteAddress(undefined, env).url ?? undefined, undefined, {}), [{ hostname: 'example.com', protocol: 'https' }]);
		// Astro's site, when set, still wins; Railway's domain is the last resort.
		assert.equal(publicOrigin(new URL('https://a.test'), env), 'https://a.test');
		assert.equal(publicOrigin(undefined, { RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }), 'https://x.up.railway.app');

		const { ctx, links, auth } = production(publicOrigin(undefined, env));
		const res = await handleLogin(
			new Request('http://localhost:4330/admin/login', { method: 'POST', headers: { origin: 'http://localhost:4330', 'content-type': 'application/x-www-form-urlencoded', [CLIENT_IP_HEADER]: '198.51.100.7' }, body: 'email=aoife%40example.com' }),
			ctx,
		);
		await Promise.all(auth.sending);
		assert.equal(res.status, 200);
		assert.equal(links.length, 1);
		assert.ok(links[0]!.startsWith('https://example.com/admin/login/confirm?token='), links[0]);
	});
});

describe('check 11: SITE_URL is https://www.example.com, the site is opened at https://example.com', () => {
	// Astro trusts only www.example.com, so it reads the request as localhost:4330; the headers keep what the browser sent.
	const reached = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
		new Request(`http://localhost:4330${path}`, {
			method: init.method ?? 'GET',
			headers: { host: 'example.com', 'x-forwarded-proto': 'https', [CLIENT_IP_HEADER]: '198.51.100.7', ...init.headers },
			body: init.body,
		});
	const SENTENCE = /This site's address is set to https:\/\/www\.example\.com \(SITE_URL\), but it was opened at https:\/\/example\.com, so signing in and saving are refused here\. Open it at https:\/\/www\.example\.com, or set SITE_URL to https:\/\/example\.com/;

	test('the sign-in form says so, above the form', async () => {
		const { ctx } = production();
		const res = await handleLogin(reached('/admin/login'), ctx);
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html.replace(/&#39;|&#x27;/g, "'"), SENTENCE);
		assert.match(html, /data-notice="address"/);
		// Opened at its own address: no notice.
		const own = await handleLogin(new Request('https://www.example.com/admin/login', { headers: { host: 'www.example.com', [CLIENT_IP_HEADER]: '198.51.100.7' } }), ctx);
		assert.doesNotMatch(await own.text(), /data-notice="address"/);
	});

	test('the sign-in POST is refused with the sentence, not a bare 403', async () => {
		const { ctx } = production();
		const json = await handleLogin(
			reached('/admin/login/signin', { method: 'POST', headers: { origin: 'https://example.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{"kind":"backup"}' }),
			ctx,
		);
		assert.equal(json.status, 403);
		assert.match(((await json.json()) as { error: string }).error, SENTENCE);
		const form = await handleLogin(
			reached('/admin/login', { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=aoife%40example.com' }),
			ctx,
		);
		assert.equal(form.status, 403);
		assert.match((await form.text()).replace(/&#39;|&#x27;/g, "'"), SENTENCE);
	});

	test('so is an editor write', async () => {
		const { auth } = production();
		const cookie = sessionCookieFor({ email: 'aoife@example.com' }, SECRET, { secure: true });
		const r = guard(reached('/_caracms/write', { method: 'POST', headers: { origin: 'https://example.com', 'sec-fetch-site': 'same-origin', cookie, 'content-type': 'application/json' }, body: '{}' }), auth);
		assert.equal(r.kind, 'respond');
		if (r.kind !== 'respond') return;
		assert.equal(r.response.status, 403);
		const body = (await r.response.json()) as { error: string; code: string };
		assert.equal(body.code, 'cross-origin');
		assert.match(body.error, SENTENCE);
	});

	test('a real cross-site request keeps its plain refusal', () => {
		const evil = reached('/_caracms/write', { method: 'POST', headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' } });
		assert.equal(addressMismatch(evil, 'https://www.example.com'), null);
		const noFetchSite = reached('/_caracms/write', { method: 'POST', headers: { origin: 'https://evil.test' } });
		assert.equal(addressMismatch(noFetchSite, 'https://www.example.com'), null, 'its Origin isn\'t the Host it was sent to');
	});

	test('no address at all: the sentence says SITE_URL isn\'t set', () => {
		assert.match(addressNotice(reached('/admin/login'), null)!, /This site's address isn't set, so signing in and saving are refused\. Set SITE_URL to https:\/\/example\.com/);
	});
});
