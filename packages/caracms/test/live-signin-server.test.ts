// Sign-in on a real server (M4 Phase 3 → Verify 4): a copy of the demo under `astro dev`
// in live mode on the in-memory GitHub and the Redis stand-in (CARACMS_GITHUB=memory,
// Decision 2), driven by plain HTTP. Request a link, take it from the server log, press
// Sign in as the page's script does, and land on /admin.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startDevSite, type DevSite } from './helpers/dev-site.ts';

const ENV = {
	CARACMS_GITHUB: 'memory',
	CARACMS_SECRET: 'a-test-secret-for-the-signin-server-0123456789',
	CARACMS_ALLOW: 'walker@example.com',
};

describe('sign-in, served in live mode', () => {
	let site: DevSite;
	const logged: string[] = [];
	const original = console.log;
	const saved: Record<string, string | undefined> = {};

	before(async () => {
		for (const [k, v] of Object.entries(ENV)) {
			saved[k] = process.env[k];
			process.env[k] = v;
		}
		console.log = (...args: unknown[]) => {
			logged.push(args.map(String).join(' '));
		};
		site = await startDevSite('signin-server');
	});
	after(async () => {
		console.log = original;
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await site?.close();
	});

	const req = (path: string, init: RequestInit = {}) => fetch(site.origin + path, { redirect: 'manual', ...init });

	async function linkFromLog(email: string): Promise<string> {
		for (let i = 0; i < 100; i++) {
			const line = logged.find((l) => l.includes(`sign-in link for ${email} `));
			if (line) return /(https?:\/\/\S+\/admin\/login\/confirm\?token=[A-Za-z0-9_-]{43})/.exec(line)![1]!;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`no link for ${email} in the log:\n${logged.join('\n')}`);
	}

	test('/admin with no session redirects to sign-in; an API answers 401; the public site is open', async () => {
		const admin = await req('/admin/pages/about');
		assert.equal(admin.status, 303);
		assert.equal(admin.headers.get('location'), '/admin/login?next=%2Fadmin%2Fpages%2Fabout');
		const api = await req('/_caracms/documents');
		assert.equal(api.status, 401);
		assert.equal((await api.json()).reason, 'signed-out');
		assert.equal((await req('/')).status, 200);
		const login = await req('/admin/login?next=/admin/pages/about');
		assert.equal(login.status, 200);
		const html = await login.text();
		assert.match(html, /<h1>Sign in<\/h1>/);
		assert.match(html, /<title>Sign in · CaraCMS<\/title>/);
		// The fixture's Site Settings names no logo (and the config can't, M5b Decision 11): the initial on the accent.
		assert.match(html, /<span class="logo-mono" aria-hidden="true">C<\/span>/);
		assert.doesNotMatch(html, /<script/);
	});

	test('request a link, take it from the log, press Sign in, and land on /admin', async () => {
		// The demo's own Site Settings lists niamh@example.com (Decision 15).
		const email = 'niamh@example.com';
		const asked = await req('/admin/login', {
			method: 'POST',
			headers: { Origin: site.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ email, next: '/admin' }),
		});
		assert.equal(asked.status, 200);
		assert.match(await asked.text(), /<h1>Check your email<\/h1>/);
		const link = await linkFromLog(email);
		assert.ok(link.startsWith(`${site.origin}/admin/login/confirm?token=`), link);
		const token = new URL(link).searchParams.get('token')!;

		// Opening it spends nothing.
		const confirm = await req(new URL(link).pathname + new URL(link).search);
		assert.equal(confirm.status, 200);
		const page = await confirm.text();
		assert.match(page, /Sign in as <strong>niamh@example\.com<\/strong>/);
		assert.match(confirm.headers.get('content-security-policy')!, /script-src 'sha256-/);

		// The press, as the page's script makes it.
		const pressed = await req('/admin/login/signin', {
			method: 'POST',
			headers: { Origin: site.origin, 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ kind: 'link', token }),
		});
		assert.equal(pressed.status, 200);
		const { location } = (await pressed.json()) as { location: string };
		assert.equal(location, '/admin');
		const cookie = pressed.headers.get('set-cookie')!.split(';')[0]!;
		assert.match(cookie, /^caracms_session=/);

		const editor = await req(location, { headers: { cookie } });
		assert.equal(editor.status, 200);
		assert.match(await editor.text(), /<footer class="bar" id="bar"/);

		// The same link again: dead.
		const again = await req('/admin/login/signin', {
			method: 'POST',
			headers: { Origin: site.origin, 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind: 'link', token }),
		});
		assert.equal(again.status, 410);
		assert.equal((await req(new URL(link).pathname + new URL(link).search)).status, 410);

		// A cross-origin write with the session: 403.
		const write = await req('/_caracms/write', { method: 'POST', headers: { cookie, Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' });
		assert.equal(write.status, 403);

		// Sign out, and /admin is closed again.
		const out = await req('/admin/login/signout', { method: 'POST', headers: { cookie, Origin: site.origin } });
		assert.equal(out.status, 303);
		assert.equal(out.headers.get('location'), '/admin/login?signedout=1');
		assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);
	});

	test('an unknown address gets the same page and no link', async () => {
		const asked = await req('/admin/login', {
			method: 'POST',
			headers: { Origin: site.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ email: 'stranger@elsewhere.test' }),
		});
		assert.equal(asked.status, 200);
		assert.match(await asked.text(), /<h1>Check your email<\/h1>/);
		await new Promise((r) => setTimeout(r, 200));
		assert.ok(!logged.some((l) => l.includes('sign-in link for stranger@')));
	});
});
