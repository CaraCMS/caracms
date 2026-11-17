// Sign-in (M4 Phase 3 → Verify 1–3; Decisions 11, 14 and 15), on the live runtime with
// the in-memory GitHub and the Redis stand-in, and a fake clock. Requests go straight to
// the sign-in pages' handler and the guard, as the route and the middleware call them.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { resolveSite, type SiteConfig } from '../src/config.ts';
import { createAuth, type Auth } from '../src/live/auth/auth.ts';
import { compileAllowList, createWhitelist, PUBLIC_MAIL_DOMAINS } from '../src/live/auth/allow.ts';
import { guard, isGuardedPath } from '../src/live/auth/guard.ts';
import { linkKey, sha256Hex } from '../src/live/auth/links.ts';
import { handleLogin, type LoginContext } from '../src/live/auth/login.ts';
import { clientIp, GATED_MARK, isSameOrigin } from '../src/live/auth/request.ts';
import { cleanNext, sessionCookieFor, sessionCookieName, signSession, verifySession } from '../src/live/auth/session.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { Tracker } from '../src/live/github.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles, type LiveRuntime } from '../src/live/runtime.ts';
import { handleGithubWebhook } from '../src/live/webhook.ts';
import { siteRoot, variant } from './helpers/site.ts';

const ORIGIN = 'http://site.test';
const SECRET = 'a-test-secret-that-is-long-enough-0123456789';
const SETTINGS_FILE = 'content/site-settings.json';
const settingsText = (editors: unknown) => `${JSON.stringify({ title: 'Site Settings', editors }, null, 2)}\n`;
const site = resolveSite(variant({ repoPath: 'starter' } as Partial<SiteConfig>), siteRoot);

const brand = { name: 'CaraCMS', accent: '#1f3a2e', accentInk: '#ffffff', accentEdge: '#1f3a2e', icon: '/icon.svg' };
const assets = { tokensCss: ':root{--surface:#fff}', fontsCss: '' };

interface Setup {
	rt: LiveRuntime;
	auth: Auth;
	backend: MemoryBackend;
	clock: { t: number };
	logs: string[];
	links: string[];
	ctx: LoginContext;
	/** Commit a new Site Settings text to `drafts`. */
	setSettings(text: string): Promise<void>;
}

async function setup(options: { agency?: string[]; editors?: unknown; settings?: string | null; backup?: { user: string; password: string } | null; env?: Record<string, string> } = {}): Promise<Setup> {
	const clock = { t: Date.UTC(2026, 9, 14, 12) };
	const now = () => clock.t;
	const backend = new MemoryBackend(new Tracker(now), { now });
	const settings = options.settings !== undefined ? options.settings : settingsText(options.editors ?? ['aoife@example.org', '@studio.test']);
	backend.seed([...(await siteFiles(site)).filter((f) => !f.path.endsWith(SETTINGS_FILE)), ...(settings === null ? [] : [{ path: `starter/${SETTINGS_FILE}`, contents: settings }])]);
	const logs: string[] = [];
	const log = (line: string) => logs.push(line);
	const liveSettings: LiveSettings = {
		github: { kind: 'memory' },
		redisUrl: null,
		secret: SECRET,
		allow: options.agency ?? ['walker@example.com'],
		webhookSecret: 'hook-secret',
		railway: null,
		backup: options.backup ?? null,
		runningCommit: null,
		timings: DEFAULT_TIMINGS,
		production: false,
	};
	const rt = await createLiveRuntime({ site, settings: liveSettings, backend, redis: memoryRedis({ now }), now, log: () => {}, runningCommit: () => null });
	const links: string[] = [];
	const auth = createAuth({
		secret: SECRET,
		agency: liveSettings.allow,
		backup: liveSettings.backup,
		secure: false,
		redis: rt.redis,
		readSettings: () => rt.git.read(SETTINGS_FILE),
		siteName: 'CaraCMS',
		siteOrigin: null,
		env: options.env ?? {},
		now,
		log,
		deliver: async ({ link }) => {
			links.push(link);
			return 'logged';
		},
	});
	const ctx: LoginContext = { auth, brand, assets, clientAddress: () => '10.0.0.1' };
	return {
		rt,
		auth,
		backend,
		clock,
		logs,
		links,
		ctx,
		async setSettings(text) {
			await rt.git.commitDrafts([{ file: SETTINGS_FILE, base: rt.git.read(SETTINGS_FILE), text, editor: { email: 'aoife@example.org' } }]);
		},
	};
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
	new Request(`${ORIGIN}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, ...headers }, body: new URLSearchParams(fields) });
const get = (path: string, cookie?: string) => new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const press = (body: unknown, cookie?: string) =>
	new Request(`${ORIGIN}/admin/login/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

/** Ask for a link and return its token (or null when none was sent). */
async function requestLink(s: Setup, email: string, headers: Record<string, string> = {}): Promise<{ res: Response; token: string | null }> {
	const before = s.links.length;
	const res = await handleLogin(form({ email, next: '/admin/pages/about' }, headers), s.ctx);
	await Promise.all(s.auth.sending);
	const link = s.links.length > before ? s.links.at(-1)! : null;
	return { res, token: link ? new URL(link).searchParams.get('token') : null };
}

/** A page's body with the typed address taken out, to compare pages across addresses. */
const without = (text: string, email: string) => text.split(email).join('<address>');

describe('Verify 1: links, pages, the whitelist, next and the backup account', () => {
	test('a token is spent once: two presses give one session', async () => {
		const s = await setup();
		const { token } = await requestLink(s, 'Aoife@Example.org ');
		assert.ok(token, 'a link was issued');
		assert.match(token!, /^[A-Za-z0-9_-]{43}$/);
		// Only the SHA-256 is stored, for 15 minutes.
		assert.equal(await s.rt.redis.get(`caracms:auth:link:${token}`), null);
		assert.ok(await s.rt.redis.get(linkKey(token!)));
		const ttl = await s.rt.redis.pttl(linkKey(token!));
		assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000, `ttl ${ttl}`);

		// Opening the link (a mail scanner, the person) spends nothing.
		for (let i = 0; i < 3; i++) {
			const confirm = await handleLogin(get(`/admin/login/confirm?token=${token}`), s.ctx);
			assert.equal(confirm.status, 200);
			const html = await confirm.text();
			assert.match(html, /<h1>Sign in to the CaraCMS website<\/h1>/);
			assert.match(html, /Sign in as <strong>aoife@example\.org<\/strong>/);
		}
		const [a, b] = await Promise.all([handleLogin(press({ kind: 'link', token }), s.ctx), handleLogin(press({ kind: 'link', token }), s.ctx)]);
		const statuses = [a.status, b.status].sort();
		assert.deepEqual(statuses, [200, 410]);
		const ok = a.status === 200 ? a : b;
		assert.deepEqual(await ok.json(), { location: '/admin/pages/about' });
		const set = ok.headers.get('set-cookie')!;
		assert.match(set, /^caracms_session=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
		const who = s.auth.identify(cookieOf(ok));
		assert.equal(who.state, 'in');
		assert.deepEqual(who.state === 'in' && who.person, { email: 'aoife@example.org' });
		// A third press, later: still dead.
		assert.equal((await handleLogin(press({ kind: 'link', token }), s.ctx)).status, 410);
	});

	test('expired, used, unknown and missing tokens give the same page', async () => {
		const s = await setup();
		const used = (await requestLink(s, 'aoife@example.org')).token!;
		await handleLogin(press({ kind: 'link', token: used }), s.ctx);
		const expired = (await requestLink(s, 'aoife@example.org')).token!;
		s.clock.t += 15 * 60_000 + 1;
		const pages = await Promise.all(
			[`?token=${expired}`, `?token=${used}`, `?token=${'A'.repeat(43)}`, `?token=short`, ''].map(async (q) => {
				const res = await handleLogin(get(`/admin/login/confirm${q}`), s.ctx);
				return { status: res.status, body: await res.text() };
			}),
		);
		for (const p of pages) {
			assert.equal(p.status, 410);
			assert.equal(p.body, pages[0]!.body);
		}
		assert.match(pages[0]!.body, /This link has expired or was already used/);
		assert.match(pages[0]!.body, /href="\/admin\/login">Send a new link<\/a>/);
	});

	test('the same "Check your email" page for an allowed, an unknown and a rate-limited address', async () => {
		const s = await setup();
		const page = async (email: string) => {
			const { res, token } = await requestLink(s, email);
			return { status: res.status, body: without(await res.text(), email), token };
		};
		const allowed = await page('aoife@example.org');
		const unknown = await page('stranger@elsewhere.test');
		await page('aoife@example.org');
		await page('aoife@example.org');
		const limited = await page('aoife@example.org'); // the 4th for this address in 15 minutes
		assert.ok(allowed.token);
		assert.equal(unknown.token, null);
		assert.equal(limited.token, null, 'nothing is sent past the limit');
		for (const p of [unknown, limited]) {
			assert.equal(p.status, 200);
			assert.equal(p.body, allowed.body);
		}
		assert.match(allowed.body, /<h1>Check your email<\/h1><p>If <strong><address><\/strong> can sign in, a link is on its way\./);
		// Editor wording note: why nothing may come, said to every address alike.
		assert.ok(allowed.body.includes('<p class="fine">Sign-in is by invitation. If nothing arrives in a few minutes, check the address or ask whoever invited you.</p>'));
		assert.ok(s.logs.some((l) => /refused by the rate limit/.test(l)));
		// The window ends after 15 minutes.
		s.clock.t += 15 * 60_000 + 1;
		assert.ok((await page('aoife@example.org')).token);
	});

	test('10 per IP: X-Real-IP keys it, and a rotated X-Forwarded-For does not get past', async () => {
		const s = await setup({ editors: ['@studio.test'] });
		let sent = 0;
		for (let i = 0; i < 11; i++) {
			const { token } = await requestLink(s, `p${i}@studio.test`, { 'X-Real-IP': '203.0.113.9', 'X-Forwarded-For': `198.51.100.${i}` });
			if (token) sent++;
		}
		assert.equal(sent, 10);
		// The IP and the address are hashed in the key names.
		const keys = await s.rt.redis.scan('caracms:auth:rl:*');
		assert.ok(keys.includes(`caracms:auth:rl:link-ip:${sha256Hex('203.0.113.9')}`));
		assert.ok(!keys.some((k) => k.includes('example.org') || k.includes('203.0.113')));
	});

	test('a malformed address gets the form\'s own error, and an empty one too', async () => {
		const s = await setup();
		const bad = await handleLogin(form({ email: 'aoife@', next: '/admin' }), s.ctx);
		assert.equal(bad.status, 400);
		const html = await bad.text();
		assert.match(html, /aria-invalid="true"/);
		assert.match(html, /Enter a full email address\./);
		assert.match(html, /value="aoife@"/);
		const empty = await (await handleLogin(form({ email: '  ' }), s.ctx)).text();
		assert.match(empty, /Enter your email address\./);
		assert.equal(s.links.length, 0);
	});

	test('the request form is a plain POST, the pages are branded, and their headers are strict', async () => {
		const s = await setup();
		const res = await handleLogin(get('/admin/login?next=/admin/pages/about'), s.ctx);
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /<form method="post" action="\/admin\/login" novalidate><input type="hidden" name="next" value="\/admin\/pages\/about">/);
		assert.doesNotMatch(html, /<script/, 'requesting a link needs no script');
		assert.match(html, /<title>Sign in · CaraCMS<\/title>/);
		assert.match(html, /--accent:#1f3a2e;--accent-ink:#ffffff/);
		assert.match(html, /<span class="nm">CaraCMS<\/span><span class="sub">· Sign in<\/span>/);
		assert.equal(res.headers.get('cache-control'), 'private, no-store');
		assert.equal(res.headers.get('referrer-policy'), 'same-origin');
		assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
		const csp = res.headers.get('content-security-policy')!;
		assert.match(csp, /default-src 'none'/);
		assert.match(csp, /script-src 'none'/);
		assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
		assert.match(csp, /form-action 'self'/);
		// Signed out.
		assert.match(await (await handleLogin(get('/admin/login?signedout=1'), s.ctx)).text(), /You're signed out\./);
		// A cross-origin POST is refused, and so is one with no Origin.
		assert.equal((await handleLogin(form({ email: 'aoife@example.org' }, { Origin: 'https://evil.test' }), s.ctx)).status, 403);
		const noOrigin = new Request(`${ORIGIN}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=aoife%40example.org' });
		assert.equal((await handleLogin(noOrigin, s.ctx)).status, 403);
		assert.equal(s.links.length, 0);
	});

	test('"Switch to …?" when another person is signed in; the same person goes straight on', async () => {
		const s = await setup();
		const aoife = sessionCookieFor({ email: 'aoife@example.org' }, SECRET, { now: s.clock.t });
		const token = (await requestLink(s, 'niamh@studio.test')).token!;
		const sw = await handleLogin(get(`/admin/login/confirm?token=${token}`, aoife), s.ctx);
		const html = await sw.text();
		assert.match(html, /<h1>Switch to niamh@studio\.test\?<\/h1>/);
		assert.match(html, /Signed in here as <strong>aoife@example\.org<\/strong>\. Signing in replaces that\./);
		assert.doesNotMatch(html, /class="si-home"/, 'the confirm pages have no link away');
		const niamh = sessionCookieFor({ email: 'niamh@studio.test' }, SECRET, { now: s.clock.t });
		const same = await handleLogin(get(`/admin/login/confirm?token=${token}`, niamh), s.ctx);
		assert.equal(same.status, 303);
		assert.equal(same.headers.get('location'), '/admin/pages/about');
		assert.ok(await s.auth.links.peek(token), 'the token is left unspent');
	});

	test('a whitelisted person removed after asking for a link can\'t spend it', async () => {
		const s = await setup();
		const token = (await requestLink(s, 'aoife@example.org')).token!;
		await s.setSettings(settingsText(['@studio.test']));
		const res = await handleLogin(press({ kind: 'link', token }), s.ctx);
		assert.equal(res.status, 410);
		assert.equal(res.headers.get('set-cookie'), null);
	});

	test('@gmail.com is refused as a domain entry (logged once); an exact gmail address is fine', () => {
		assert.ok(PUBLIC_MAIL_DOMAINS.has('gmail.com'));
		const logs: string[] = [];
		const list = createWhitelist({ agency: ['@gmail.com', 'Dara@Gmail.com ', '@example.com'], readSettings: () => settingsText(['@outlook.com', '@example.org']), settingsFile: SETTINGS_FILE, log: (l) => logs.push(l) });
		assert.equal(list.allows('anyone@gmail.com'), false);
		assert.equal(list.allows('anyone@outlook.com'), false);
		assert.equal(list.allows('dara@gmail.com'), true);
		assert.equal(list.allows(' AOIFE@EXAMPLE.ORG'), true);
		assert.equal(list.allows('x@example.com'), true);
		assert.equal(list.allows('x@sub.example.com'), false, 'a domain entry is that domain, not its subdomains');
		list.allows('again@gmail.com');
		assert.equal(logs.filter((l) => l.includes('"@gmail.com"')).length, 1);
		assert.equal(logs.filter((l) => l.includes('"@outlook.com"')).length, 1);
		const direct = compileAllowList(['@gmail.com'], 'test', () => {}, new Set());
		assert.equal(direct.domains.size, 0);
	});

	test('next: //evil.test, https://evil.test/admin, /x and the backslash and encoding tricks all become /admin', () => {
		for (const bad of [
			'//evil.test',
			'//evil.test/admin',
			'https://evil.test/admin',
			'http://site.test/admin',
			'/x',
			'/',
			'/\\evil.test',
			'\\\\evil.test',
			'/admin\\..\\x',
			'/admin/..%2f..%2fx',
			'/admin%2fpages',
			'/admin%5cx',
			'/admin/../x',
			'/admin/%2e%2e/x',
			'/admin/login',
			'/admin/login/confirm?token=x',
			'javascript:alert(1)',
			'/admin\nLocation: x',
			'',
			undefined,
			42,
		]) {
			assert.equal(cleanNext(bad), '/admin', String(bad));
		}
		assert.equal(cleanNext('/admin'), '/admin');
		assert.equal(cleanNext(' /admin/pages/about?x=1 '), '/admin/pages/about?x=1');
		assert.equal(cleanNext('/admin/journal/first-post'), '/admin/journal/first-post');
	});

	test('a backup password under 24 characters means no backup sign-in and no link to it', async () => {
		const s = await setup({ backup: { user: 'site-a', password: 'x'.repeat(23) } });
		assert.equal(s.auth.backup.enabled, false);
		assert.ok(s.logs.some((l) => /shorter than 24 characters: the backup account is off/.test(l)));
		const login = await (await handleLogin(get('/admin/login'), s.ctx)).text();
		assert.doesNotMatch(login, /backup/i);
		const asked = await (await handleLogin(get('/admin/login?backup=1'), s.ctx)).text();
		assert.doesNotMatch(asked, /Backup account/, '?backup=1 shows the email form');
		const sent = await (await handleLogin(form({ email: 'aoife@example.org' }), s.ctx)).text();
		assert.doesNotMatch(sent, /backup/i);
		const res = await handleLogin(press({ kind: 'backup', username: 'site-a', password: 'x'.repeat(23) }), s.ctx);
		assert.equal(res.status, 404);
		assert.equal(res.headers.get('set-cookie'), null);
	});

	test('the backup account: constant-time check, rate limited, and a new password signs it out', async () => {
		const password = 'p'.repeat(24);
		const s = await setup({ backup: { user: 'site-a', password } });
		assert.match(await (await handleLogin(get('/admin/login'), s.ctx)).text(), /href="\/admin\/login\?backup=1">Use the backup account<\/a>/);
		const backupPage = await handleLogin(get('/admin/login?backup=1&next=/admin/pages/about'), s.ctx);
		const html = await backupPage.text();
		assert.match(html, /<h1>Backup account<\/h1>/);
		assert.match(html, /data-signin="backup" data-next="\/admin\/pages\/about"/);
		assert.match(backupPage.headers.get('content-security-policy')!, /script-src 'sha256-/);

		assert.equal((await handleLogin(press({ kind: 'backup', username: 'site-a', password: `${password}x` }), s.ctx)).status, 401);
		assert.equal((await handleLogin(press({ kind: 'backup', username: 'someone', password }), s.ctx)).status, 401);
		const ok = await handleLogin(press({ kind: 'backup', username: 'site-a', password, next: '//evil.test' }), s.ctx);
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), { location: '/admin' });
		const cookie = cookieOf(ok);
		const who = s.auth.identify(cookie);
		assert.equal(who.state, 'in');
		assert.deepEqual(who.state === 'in' && who.person, { email: 'site-a@backup.invalid', name: 'site-a' });
		// The value carries a fingerprint, never the password.
		assert.ok(!Buffer.from(cookie.split('=')[1]!.split('.')[0]!, 'base64url').toString().includes(password));

		// The 6th attempt from one IP in 15 minutes is refused, even with the right password.
		assert.equal((await handleLogin(press({ kind: 'backup', username: 'x', password: 'y' }), s.ctx)).status, 401);
		assert.equal((await handleLogin(press({ kind: 'backup', username: 'x', password: 'y' }), s.ctx)).status, 401);
		const limited = await handleLogin(press({ kind: 'backup', username: 'site-a', password }), s.ctx);
		assert.equal(limited.status, 429);
		assert.equal((await limited.json()).reason, 'limited');

		// The password changes (a restart): the old backup session is signed out.
		const rotated = createAuth({ secret: SECRET, agency: [], backup: { user: 'site-a', password: 'q'.repeat(30) }, secure: false, redis: s.rt.redis, readSettings: () => null, siteName: 'CaraCMS', siteOrigin: null, env: {}, now: () => s.clock.t, log: () => {} });
		assert.deepEqual(rotated.identify(cookie), { state: 'out', reason: 'signed-out' });
		// The account turned off: signed out too.
		const off = createAuth({ secret: SECRET, agency: [], backup: null, secure: false, redis: s.rt.redis, readSettings: () => null, siteName: 'CaraCMS', siteOrigin: null, env: {}, now: () => s.clock.t, log: () => {} });
		assert.equal(off.identify(cookie).state, 'out');
	});

	test('the session: signed, 30 days from last use, renewed hourly, Secure and __Host- in production', async () => {
		const s = await setup();
		const cookie = sessionCookieFor({ email: 'aoife@example.org' }, SECRET, { now: s.clock.t });
		const [name, value] = cookie.split('=') as [string, string];
		assert.equal(name, 'caracms_session');
		// Tampered, or signed with another secret: out.
		const [body, mac] = value.split('.') as [string, string];
		const forged = Buffer.from(JSON.stringify({ v: 1, kind: 'link', email: 'walker@example.com', renewed: s.clock.t, expires: s.clock.t + 1e10 })).toString('base64url');
		assert.equal(s.auth.identify(`${name}=${forged}.${mac}`).state, 'out');
		assert.equal(s.auth.identify(`${name}=${body}.${mac.slice(0, -2)}AA`).state, 'out');
		assert.equal(verifySession(value, `${SECRET}x`, s.clock.t), null);
		// Within the hour: no renewal. After it: a renewed cookie that lasts 30 days from now.
		s.clock.t += 30 * 60_000;
		const fresh = s.auth.identify(cookie);
		assert.equal(fresh.state === 'in' && fresh.renew, null);
		s.clock.t += 31 * 60_000;
		const renewed = s.auth.identify(cookie);
		assert.ok(renewed.state === 'in' && renewed.renew);
		const renewedValue = (renewed.state === 'in' && renewed.renew!.split(';')[0]!.split('=')[1])!;
		s.clock.t += 30 * 24 * 3600_000 - 60_000;
		assert.equal(s.auth.identify(cookie).state, 'out', 'the original has run out');
		assert.equal(s.auth.identify(`${name}=${renewedValue}`).state, 'in', 'the renewed one is still good');
		// Production: Secure and __Host-.
		assert.equal(sessionCookieName(true), '__Host-caracms_session');
		const prod = createAuth({ secret: SECRET, agency: ['a@b.test'], backup: null, secure: true, redis: s.rt.redis, readSettings: () => null, siteName: 'X', siteOrigin: null, env: {}, now: () => s.clock.t, log: () => {} });
		assert.match(prod.startSession({ kind: 'link', email: 'a@b.test' }), /^__Host-caracms_session=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/);
		assert.equal(signSession({ v: 1, kind: 'link', email: 'x@y.z', renewed: 0, expires: 1 }, SECRET).split('.').length, 2);
	});

	test('sign out clears the cookie; the phone note says who is signed in', async () => {
		const s = await setup();
		const signout = await handleLogin(new Request(`${ORIGIN}/admin/login/signout`, { method: 'POST', headers: { Origin: ORIGIN } }), s.ctx);
		assert.equal(signout.status, 303);
		assert.equal(signout.headers.get('location'), '/admin/login?signedout=1');
		assert.match(signout.headers.get('set-cookie')!, /^caracms_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax$/);
		const json = await handleLogin(new Request(`${ORIGIN}/admin/login/signout`, { method: 'POST', headers: { Origin: ORIGIN, Accept: 'application/json' } }), s.ctx);
		assert.deepEqual(await json.json(), { ok: true, location: '/admin/login?signedout=1' });
		assert.equal((await handleLogin(new Request(`${ORIGIN}/admin/login/signout`, { method: 'POST', headers: { Origin: 'https://evil.test' } }), s.ctx)).status, 403);
		assert.equal((await handleLogin(get('/admin/login/signout'), s.ctx)).status, 405);

		const cookie = sessionCookieFor({ email: 'aoife@example.org' }, SECRET, { now: s.clock.t });
		const note = await handleLogin(get('/admin/login/signed-in', cookie), s.ctx);
		const html = await note.text();
		assert.match(html, /You're signed in as aoife@example\.org\./);
		assert.match(html, /<h1>Open the editor on a bigger screen<\/h1>/);
		assert.match(html, /<span>site\.test\/admin<\/span>/);
		assert.match(html, /action="\/admin\/login\/signout"><button type="submit" class="linkbtn subtle">Sign out<\/button>/);
		assert.equal((await handleLogin(get('/admin/login/signed-in'), s.ctx)).status, 303, 'signed out: back to sign-in');
	});

	test('the email goes through Resend only when NODE_ENV is production; otherwise the link is logged', async () => {
		const { deliverLink } = await import('../src/live/auth/email.ts');
		const calls: { url: string; body: any }[] = [];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init.body)) });
			return new Response('{}', { status: 200 });
		}) as unknown as typeof fetch;
		const logs: string[] = [];
		const link = `${ORIGIN}/admin/login/confirm?token=${'t'.repeat(43)}`;
		assert.equal(await deliverLink({ to: 'aoife@example.org', link, siteName: 'CaraCMS', env: {}, log: (l) => logs.push(l), fetch: fakeFetch }), 'logged');
		assert.equal(await deliverLink({ to: 'aoife@example.org', link, siteName: 'CaraCMS', env: { NODE_ENV: 'development', RESEND_API_KEY: 'k', FORMS_FROM: 'f@x.test' }, log: (l) => logs.push(l), fetch: fakeFetch }), 'logged');
		assert.equal(calls.length, 0);
		assert.ok(logs.every((l) => l.includes(link)));
		assert.equal(await deliverLink({ to: 'aoife@example.org', link, siteName: 'CaraCMS', env: { NODE_ENV: 'production', RESEND_API_KEY: 'k', FORMS_FROM: 'CaraCMS <f@x.test>' }, log: () => {}, fetch: fakeFetch }), 'sent');
		assert.equal(calls[0]!.url, 'https://api.resend.com/emails');
		assert.equal(calls[0]!.body.from, 'CaraCMS <f@x.test>');
		assert.deepEqual(calls[0]!.body.to, ['aoife@example.org']);
		assert.equal(calls[0]!.body.subject, 'Sign in to the CaraCMS website');
		assert.ok(calls[0]!.body.text.includes(link));
	});

	test('an emailed link points at the site\'s own address, never the request\'s Host', async () => {
		const links: string[] = [];
		const s = await setup();
		const auth = createAuth({
			secret: SECRET,
			agency: ['aoife@example.org'],
			backup: null,
			secure: true,
			redis: s.rt.redis,
			readSettings: () => null,
			siteName: 'CaraCMS',
			siteOrigin: null,
			env: { NODE_ENV: 'production' },
			log: (l) => links.push(`log: ${l}`),
			deliver: async ({ link }) => (links.push(link), 'sent'),
		});
		const evil = new Request('http://evil.test/admin/login', { method: 'POST', headers: { Origin: 'http://evil.test', 'Content-Type': 'application/x-www-form-urlencoded', 'x-caracms-client-ip': '203.0.113.9' }, body: 'email=aoife%40example.org' });
		// A production server behind `caracms start`: its mark on the process, so the gate's header counts (runs-anywhere Decision 8).
		const marks = globalThis as Record<symbol, unknown>;
		marks[GATED_MARK] = true;
		let res: Response;
		try {
			res = await handleLogin(evil, { ...s.ctx, auth });
		} finally {
			delete marks[GATED_MARK];
		}
		await Promise.all(auth.sending);
		assert.equal(res.status, 200);
		assert.ok(!links.some((l) => l.includes('evil.test')), links.join('\n'));
		assert.ok(links.some((l) => /public address isn't known/.test(l)));
	});

	test('the client IP under astro dev: X-Real-IP, then the socket, then the first X-Forwarded-For hop', () => {
		const r = (h: Record<string, string>) => new Request(ORIGIN, { headers: h });
		assert.equal(clientIp(r({ 'X-Real-IP': '1.1.1.1', 'X-Forwarded-For': '2.2.2.2' }), () => '3.3.3.3'), '1.1.1.1');
		assert.equal(clientIp(r({ 'X-Forwarded-For': '2.2.2.2, 4.4.4.4' }), () => '3.3.3.3'), '3.3.3.3');
		assert.equal(clientIp(r({ 'X-Forwarded-For': '2.2.2.2, 4.4.4.4' }), () => { throw new Error('none'); }), '2.2.2.2');
		assert.equal(clientIp(r({}), () => undefined), 'unknown');
	});
});

describe('Verify 2: the guard', () => {
	const pages = ['/admin', '/admin/', '/admin/pages/about', '/admin/journal/first-post?x=1', '/ADMIN', '/%61dmin/pages/about', '//admin', '/admin/login/confirm/extra', '/admin/login%2fconfirm'];
	const apis = ['/_caracms/preview?collection=pages&path=index', '/_caracms/document', '/_caracms/documents', '/_caracms/status', '/_caracms/history', '/_caracms/github', '/_caracms/anything-phase-2-adds', '/_CARACMS/status', '/_caracms'];
	// M5a Phase 3's create and delete are covered by the same prefix rule, with no list (Decision 14).
	const writes = ['/_caracms/write', '/_caracms/create', '/_caracms/delete', '/_caracms/lock', '/_caracms/publish', '/_caracms/try-again', '/_caracms/notice'];

	test('every editor route without a session: a page redirects to sign-in, an API answers 401', async () => {
		const s = await setup();
		for (const path of pages) {
			const result = guard(get(path), s.auth);
			assert.equal(result.kind, 'respond', path);
			if (result.kind !== 'respond') continue;
			assert.equal(result.response.status, 303, path);
			assert.match(result.response.headers.get('location')!, /^\/admin\/login(\?next=|$)/, path);
		}
		const about = guard(get('/admin/pages/about?x=1'), s.auth);
		assert.equal(about.kind === 'respond' && about.response.headers.get('location'), '/admin/login?next=%2Fadmin%2Fpages%2Fabout%3Fx%3D1');
		for (const path of apis) {
			const result = guard(get(path), s.auth);
			assert.equal(result.kind, 'respond', path);
			if (result.kind !== 'respond') continue;
			assert.equal(result.response.status, 401, path);
			assert.deepEqual(await result.response.json(), { error: "You're signed out. Sign in again to keep editing.", code: 'signed-out', reason: 'signed-out', signIn: '/admin/login' });
		}
		for (const path of writes) {
			const req = new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
			const result = guard(req, s.auth);
			assert.equal(result.kind === 'respond' && result.response.status, 401, path);
		}
	});

	test('the sign-in pages, the webhook\'s POST and the public site are let through; nothing else is', () => {
		for (const path of ['/admin/login', '/admin/login/', '/admin/login/confirm?token=x', '/admin/login/signin', '/admin/login/signed-in']) assert.equal(guard(get(path), {} as Auth).kind, 'skip', path);
		assert.equal(guard(new Request(`${ORIGIN}/_caracms/github`, { method: 'POST', body: '{}' }), {} as Auth).kind, 'skip');
		for (const path of ['/', '/about', '/journal/first-post', '/administration', '/mark.svg', '/_astro/x.js']) assert.equal(isGuardedPath(new URL(path, ORIGIN).pathname), false, path);
	});

	test('a session passes and names the person; a cross-origin write gives 403', async () => {
		const s = await setup();
		const cookie = sessionCookieFor({ email: 'aoife@example.org' }, SECRET, { now: s.clock.t });
		const page = guard(get('/admin/pages/about', cookie), s.auth);
		assert.equal(page.kind, 'pass');
		assert.deepEqual(page.kind === 'pass' && page.person, { email: 'aoife@example.org' });
		for (const route of ['/_caracms/write', '/_caracms/create', '/_caracms/delete']) {
			const write = (headers: Record<string, string>) => guard(new Request(`${ORIGIN}${route}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', ...headers }, body: '{}' }), s.auth);
			assert.equal(write({ Origin: ORIGIN }).kind, 'pass', route);
			const crossOrigin: Record<string, string>[] = [{ Origin: 'https://evil.test' }, {}, { Origin: 'null' }, { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-site' }];
			for (const headers of crossOrigin) {
				const result = write(headers);
				assert.equal(result.kind, 'respond', `${route} ${JSON.stringify(headers)}`);
				if (result.kind !== 'respond') continue;
				assert.equal(result.response.status, 403);
				assert.equal((await result.response.json()).code, 'cross-origin');
			}
		}
		// A cross-origin write is refused before the session is even looked at.
		const anon = guard(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' }), s.auth);
		assert.equal(anon.kind === 'respond' && anon.response.status, 403);
		assert.equal(isSameOrigin(new Request('http://site.test/x', { method: 'POST', headers: { Origin: 'https://site.test' } })), true, 'host only: Railway\'s edge is https, the server sees http');
	});

	test('a webhook with a bad signature gives 401 and triggers nothing', async () => {
		let triggered = 0;
		const trigger = async () => void triggered++;
		const body = '{"ref":"refs/heads/main"}';
		const bad = new Request(`${ORIGIN}/_caracms/github`, { method: 'POST', headers: { 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` }, body });
		assert.equal(guard(bad, {} as Auth).kind, 'skip', 'the guard lets the webhook through to its own check');
		assert.equal((await handleGithubWebhook(bad, { secret: 'hook-secret', trigger })).status, 401);
		const unsigned = new Request(`${ORIGIN}/_caracms/github`, { method: 'POST', body });
		assert.equal((await handleGithubWebhook(unsigned, { secret: 'hook-secret', trigger })).status, 401);
		assert.equal(triggered, 0);
		const good = new Request(`${ORIGIN}/_caracms/github`, { method: 'POST', headers: { 'X-Hub-Signature-256': `sha256=${createHmac('sha256', 'hook-secret').update(body).digest('hex')}` }, body });
		assert.equal((await handleGithubWebhook(good, { secret: 'hook-secret', trigger })).status, 202);
		assert.equal(triggered, 1);
	});
});

describe('Verify 3: the whitelist acts at once, from drafts', () => {
	test('removed from site-settings.json: the next request is signed out, and an API says removed', async () => {
		const s = await setup({ editors: ['aoife@example.org', 'niamh@studio.test'] });
		const cookie = sessionCookieFor({ email: 'aoife@example.org' }, SECRET, { now: s.clock.t });
		assert.equal(guard(get('/_caracms/status', cookie), s.auth).kind, 'pass');
		const commitsBefore = s.backend.tracker.records.length;
		await s.setSettings(settingsText(['niamh@studio.test']));
		assert.ok(s.backend.tracker.records.length > commitsBefore, 'a commit to drafts, no deploy');
		const api = guard(get('/_caracms/status', cookie), s.auth);
		assert.equal(api.kind, 'respond');
		if (api.kind === 'respond') {
			assert.equal(api.response.status, 401);
			assert.deepEqual(await api.response.json(), { error: "You can no longer sign in to this site, so your latest changes couldn't be kept.", code: 'signed-out', reason: 'removed', signIn: '/admin/login' });
		}
		// The page redirect is the same as for anyone with no session.
		const page = guard(get('/admin/pages/about', cookie), s.auth);
		const anon = guard(get('/admin/pages/about'), s.auth);
		assert.equal(page.kind === 'respond' && page.response.status, 303);
		assert.equal(page.kind === 'respond' && page.response.headers.get('location'), anon.kind === 'respond' && anon.response.headers.get('location'));
		// Added back: in again, at once.
		await s.setSettings(settingsText(['niamh@studio.test', '@example.org']));
		assert.equal(guard(get('/_caracms/status', cookie), s.auth).kind, 'pass');
	});

	test('a site-settings.json that doesn\'t parse leaves only CARACMS_ALLOW able to sign in, logged once', async () => {
		const s = await setup({ agency: ['walker@example.com'], settings: '{ "title": "Site Settings", "editors": [' });
		const aoife = sessionCookieFor({ email: 'aoife@example.org' }, SECRET, { now: s.clock.t });
		const rich = sessionCookieFor({ email: 'walker@example.com' }, SECRET, { now: s.clock.t });
		for (let i = 0; i < 3; i++) {
			assert.equal(guard(get('/_caracms/status', aoife), s.auth).kind, 'respond');
			assert.equal(guard(get('/_caracms/status', rich), s.auth).kind, 'pass');
		}
		assert.equal(s.logs.filter((l) => /site-settings\.json: it isn't valid JSON/.test(l)).length, 1);
		// A link isn't sent to a client address either, but is to the agency's.
		assert.equal((await requestLink(s, 'aoife@example.org')).token, null);
		assert.ok((await requestLink(s, 'walker@example.com')).token);
		// Another broken version is logged once more; editors that aren't strings count as broken.
		await s.setSettings(settingsText([42]));
		guard(get('/_caracms/status', aoife), s.auth);
		guard(get('/_caracms/status', aoife), s.auth);
		assert.equal(s.logs.filter((l) => /"editors" isn't a list of strings/.test(l)).length, 1);
	});

	test('no site-settings.json at all: the client half is empty, nothing logged', async () => {
		const s = await setup({ settings: null, agency: ['@example.com'] });
		assert.equal(s.auth.whitelist.allows('aoife@example.org'), false);
		assert.equal(s.auth.whitelist.allows('walker@example.com'), true);
		assert.ok(!s.logs.some((l) => l.includes('site-settings')));
	});
});

describe('Decision 15: the whitelist\'s failure cases and public domains', () => {
	/** A whitelist over a Site Settings text, logging into `logs`. */
	const over = (text: string | null, agency: string[] = ['walker@example.com']) => {
		const logs: string[] = [];
		return { logs, list: createWhitelist({ agency, readSettings: () => text, settingsFile: SETTINGS_FILE, log: (l) => logs.push(l) }) };
	};

	test('every shape of a broken editors list leaves the client half empty, the agency in, and says so once', () => {
		const broken: [string, string][] = [
			['editors is a string', '{ "title": "Site Settings", "editors": "aoife@example.org" }'],
			['editors is an object', '{ "title": "Site Settings", "editors": { "aoife@example.org": true } }'],
			['editors is null', '{ "title": "Site Settings", "editors": null }'],
			['one entry is not a string, so none count', '{ "title": "Site Settings", "editors": ["aoife@example.org", 42] }'],
			['an entry is null', '{ "title": "Site Settings", "editors": ["aoife@example.org", null] }'],
			['an entry is a nested list', '{ "title": "Site Settings", "editors": [["aoife@example.org"]] }'],
			['the file is a list', '["aoife@example.org"]'],
			['the file is null', 'null'],
			['the file is a string', '"aoife@example.org"'],
			['the file is empty', ''],
			['the file is cut off', '{ "title": "Site Settings", "editors": ["aoife@example.org"'],
		];
		for (const [name, text] of broken) {
			const { list, logs } = over(text);
			for (let i = 0; i < 3; i++) {
				assert.equal(list.allows('aoife@example.org'), false, name);
				assert.equal(list.allows('walker@example.com'), true, `${name}: the agency still gets in`);
			}
			assert.equal(logs.filter((l) => l.includes(SETTINGS_FILE)).length, 1, `${name}: logged once, not on every check (${logs.join(' | ')})`);
		}
	});

	test('a file with no editors key at all is an empty client half, and is not a failure', () => {
		const { list, logs } = over('{ "title": "Site Settings" }');
		assert.equal(list.allows('aoife@example.org'), false);
		assert.equal(list.allows('walker@example.com'), true);
		assert.deepEqual(logs, []);
		assert.equal(over('{ "title": "Site Settings", "editors": [] }').list.allows('aoife@example.org'), false);
	});

	test('a fixed file works again at once, and a different broken version is logged again', () => {
		let text: string | null = '{ "editors": ';
		const logs: string[] = [];
		const list = createWhitelist({ agency: [], readSettings: () => text, settingsFile: SETTINGS_FILE, log: (l) => logs.push(l) });
		assert.equal(list.allows('aoife@example.org'), false);
		text = settingsText(['aoife@example.org']);
		assert.equal(list.allows('aoife@example.org'), true, 'no deploy, no restart');
		text = '{ "editors": 7 }';
		assert.equal(list.allows('aoife@example.org'), false);
		text = '{ "editors": 8 }';
		assert.equal(list.allows('aoife@example.org'), false);
		assert.equal(logs.length, 3, 'the cut-off file once, then each new broken version once');
	});

	test('every public mail domain is refused as a domain entry in both halves; exact addresses there are fine', () => {
		assert.ok(PUBLIC_MAIL_DOMAINS.size >= 20);
		for (const domain of PUBLIC_MAIL_DOMAINS) {
			const { list, logs } = over(settingsText([`@${domain}`, ` @${domain.toUpperCase()} `]), [`@${domain}`]);
			assert.equal(list.allows(`anyone@${domain}`), false, `@${domain}`);
			assert.equal(list.allows(`someone.else@${domain}`), false);
			assert.ok(logs.some((l) => l.includes(`"@${domain}"`) && /public mail domain/.test(l)), `${domain} is logged`);
		}
		const { list } = over(settingsText(['dara@gmail.com', '@example.org']), ['aoife@outlook.com']);
		assert.equal(list.allows('dara@gmail.com'), true);
		assert.equal(list.allows('Aoife@Outlook.com'), true);
		assert.equal(list.allows('someone@gmail.com'), false);
		assert.equal(list.allows('x@example.org'), true);
		for (const common of ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'aol.com']) assert.ok(PUBLIC_MAIL_DOMAINS.has(common), common);
	});

	test('entries that are neither an address nor a domain are ignored and never open anything up', () => {
		const entries = ['example.org', '@', '@@example.org', '*', '*@example.org', '@*.org', '@localhost', '@exam ple.test', 'aoife', 'aoife@', '@.org', '', '   ', 'a b@c.test'];
		const { list, logs } = over(settingsText(entries), []);
		for (const probe of ['anyone@example.org', 'a@b.test', 'aoife@example.org', 'x@localhost', 'a@anything.test']) assert.equal(list.allows(probe), false, probe);
		assert.ok(logs.length >= 1 && logs.length <= entries.length, 'ignored entries are logged, once each');
		const again = logs.length;
		list.allows('anyone@example.org');
		assert.equal(logs.length, again, 'and not again');
	});

	test('a domain entry is that exact domain: a look-alike or a subdomain is not let in; case and spaces do not matter', () => {
		const { list } = over(settingsText(['  @Example.ORG ', 'Aoife@Studio.Test']), []);
		for (const yes of ['x@example.org', 'X@EXAMPLE.ORG', ' x@example.org ', 'aoife@studio.test', 'AOIFE@STUDIO.TEST']) assert.equal(list.allows(yes), true, yes);
		for (const no of ['x@evilexample.org', 'x@example.org.evil.test', 'x@sub.example.org', 'x@example.oRg.', 'example.org', 'x@y@example.org', 'other@studio.test', '', null, undefined, 42]) assert.equal(list.allows(no), false, String(no));
	});

	test('the demo\'s own Site Settings file has the fixed shape: a fictional address, and no public domain', async () => {
		const { readFileSync } = await import('node:fs');
		const { editorsFrom, parseAllowEntry } = await import('../src/live/auth/allow.ts');
		const text = readFileSync(new URL('../../../starter/content/site-settings.json', import.meta.url), 'utf8');
		// M5a Decision 10 adds the brand beside the editors; M6 Decision 14 may add seo, googleTag and formRecipients
		// (a Publish from the demo's editor writes them). M7 Decision 16: every other key is one of the site's own
		// `settings: { fields }` (the starter's menu, footer columns, contact details and social links), and any
		// email address in those is fictional too.
		const { SETTINGS_KEYS } = await import('../src/reserved.ts');
		const json = JSON.parse(text) as Record<string, unknown>;
		const keys = Object.keys(json);
		for (const key of ['title', 'editors', 'brand']) assert.ok(keys.includes(key), key);
		// M8 Decision 14: `$schema` is the file's own, not a field.
		const siteKeys = keys.filter((key) => key !== '$schema' && !(SETTINGS_KEYS as readonly string[]).includes(key));
		for (const key of siteKeys) {
			assert.match(key, /^[a-z][A-Za-z0-9]*$/, `${key} is a site field's key`);
			for (const email of JSON.stringify(json[key]).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
				assert.match(email, /@example\.com$/, `${key}: ${email} is fictional`);
			}
		}
		const { entries, problem } = editorsFrom(text);
		assert.equal(problem, null);
		assert.ok(entries.length >= 1);
		for (const entry of entries) {
			const parsed = parseAllowEntry(entry);
			assert.ok(parsed.kind === 'address' || parsed.kind === 'domain', entry);
			assert.match(entry, /@example\.com$/, 'the demo can never mail a real domain');
		}
	});

	test('the agency half is read once from CARACMS_ALLOW: an edit to Site Settings cannot take the agency out', async () => {
		const s = await setup({ agency: ['walker@example.com', '@agency.test'], editors: ['aoife@example.org'] });
		await s.setSettings(settingsText([]));
		assert.equal(s.auth.whitelist.allows('walker@example.com'), true);
		assert.equal(s.auth.whitelist.allows('anyone@agency.test'), true);
		assert.equal(s.auth.whitelist.allows('aoife@example.org'), false, 'the client half changed at once');
		await s.setSettings('not json at all');
		assert.equal(s.auth.whitelist.allows('walker@example.com'), true);
	});
});

