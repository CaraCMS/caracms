// CaraCMS Cloud on a real server (caracms-cloud M2, acceptance checks 16 and 18): a copy of the
// demo under `astro dev` with only CARACMS_CLOUD_KEY for GitHub. The cloud (on `https://cloud.test`,
// never the production address) and GitHub are faked by stubbing the process's fetch. The cloud
// refuses first: /admin answers 503 with its sentence and the link as a link, while the public
// site renders. Then it gives a token: the next request starts the editor, and a person signs
// in. Nothing the server logged or answered carries the key or a token.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { demoContent, startDevSite, type DevSite } from './helpers/dev-site.ts';

const KEY = `cck_${'Zz9_-y8Xw7'.repeat(4)}Vu6`;
const TOKEN = 'ghs_aFakeInstallationTokenForTheServerTest01';
const CLOUD = 'https://cloud.test';
const INSTALL = 'https://github.com/apps/caracms/installations/new';
const EMAIL = 'walker@example.com';
const ENV = {
	CARACMS_CLOUD_KEY: KEY,
	CARACMS_CLOUD_URL: CLOUD,
	CARACMS_SECRET: 'a-test-secret-for-the-cloud-server-0123456789',
	CARACMS_ALLOW: EMAIL,
};

/** The demo's content as GitHub's archive of the repo: one top folder, then the site's `repoPath` (`starter`). */
function archive(): Buffer {
	const blocks: Buffer[] = [];
	const header = (name: string, size: number, type: string) => {
		const h = Buffer.alloc(512);
		h.write(name.slice(0, 99), 0);
		h.write('0000644\0', 100);
		h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
		h.write(type, 156);
		return h;
	};
	const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
	for (const rel of (readdirSync(demoContent, { recursive: true }) as string[]).sort()) {
		if (!rel.endsWith('.json')) continue;
		const name = `CaraCodeDev-caracms-git-spike-aaaaaaa/starter/content/${rel.split('\\').join('/')}`;
		const data = readFileSync(join(demoContent, rel));
		if (name.length > 99) blocks.push(header('././@LongLink', name.length + 1, 'L'), pad(Buffer.from(`${name}\0`)));
		blocks.push(header(name, data.length, '0'), pad(data));
	}
	return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe('CaraCMS Cloud, served', () => {
	let site: DevSite;
	const logged: string[] = [];
	const answered: string[] = [];
	const originals = { log: console.log, error: console.error, warn: console.warn, fetch: globalThis.fetch };
	const saved: Record<string, string | undefined> = {};
	let installed = false;
	const cloudAsked: string[] = [];
	const githubAuth = new Set<string | null>();

	before(async () => {
		for (const [k, v] of Object.entries(ENV)) {
			saved[k] = process.env[k];
			process.env[k] = v;
		}
		for (const name of ['log', 'error', 'warn'] as const) {
			console[name] = (...args: unknown[]) => {
				logged.push(args.map((a) => (a instanceof Error ? `${a.stack} ${String(a.cause)}` : String(a))).join(' '));
			};
		}
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.origin === CLOUD) {
				cloudAsked.push(`${init?.method ?? 'GET'} ${url.pathname} ${new Headers(init?.headers).get('authorization') === `Bearer ${KEY}`}`);
				if (url.pathname === '/v1/settings') return Response.json({ site: { name: 'Throwaway' }, github: { repo: 'CaraCodeDev/caracms-git-spike' } });
				if (!installed) {
					return Response.json(
						{
							error: 'app_not_installed',
							message: `The caracms GitHub App isn't installed on CaraCodeDev/caracms-git-spike, or that repo doesn't exist. Install the App on it: ${INSTALL}`,
							installUrl: INSTALL,
							repo: 'CaraCodeDev/caracms-git-spike',
						},
						{ status: 409 },
					);
				}
				return Response.json({ token: TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString(), repo: 'CaraCodeDev/caracms-git-spike' });
			}
			if (url.origin === 'https://api.github.com') {
				githubAuth.add(new Headers(init?.headers).get('authorization'));
				const ref = { target: { oid: 'a'.repeat(40), tree: { oid: 'b'.repeat(40) } } };
				if (url.pathname === '/graphql') return Response.json({ data: { repository: { id: 'R_1', main: ref, drafts: ref } } });
				if (url.pathname.includes('/tarball/')) return new Response(new Uint8Array(archive()));
				return Response.json((init?.method ?? 'GET') === 'GET' ? [] : {});
			}
			const res = await originals.fetch(input, init);
			if (url.origin === site?.origin) answered.push(await res.clone().text());
			return res;
		}) as typeof fetch;
		site = await startDevSite('cloud-server');
	});
	after(async () => {
		Object.assign(console, { log: originals.log, error: originals.error, warn: originals.warn });
		globalThis.fetch = originals.fetch;
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await site?.close();
	});

	const req = (path: string, init: RequestInit = {}) => fetch(site.origin + path, { redirect: 'manual', ...init });

	test("check 16: a refusal at start: /admin answers 503 with the cloud's sentence and link; the public site renders; the next request tries again", async () => {
		const admin = await req('/admin');
		assert.equal(admin.status, 503);
		assert.equal(admin.headers.get('content-type'), 'text/html; charset=utf-8');
		const html = await admin.text();
		assert.match(html, /The caracms GitHub App isn't installed on CaraCodeDev\/caracms-git-spike, or that repo doesn't exist\. Install the App on it: <a href="https:\/\/github\.com\/apps\/caracms\/installations\/new">/);

		const api = await req('/_caracms/status');
		assert.equal(api.status, 503);
		assert.equal(((await api.json()) as { code: string }).code, 'app_not_installed');

		assert.equal((await req('/')).status, 200);
		assert.ok(logged.some((l) => l.includes('CaraCMS Cloud (app_not_installed)')), logged.join('\n'));
		assert.ok(cloudAsked.length >= 2 && cloudAsked.every((c) => c.endsWith(' true')), 'every call to the cloud carries the key');

		installed = true;
		const again = await req('/admin');
		assert.equal(again.status, 303, await again.text());
		assert.match(again.headers.get('location')!, /^\/admin\/login/);
		assert.ok(logged.some((l) => l.includes('live mode on CaraCodeDev/caracms-git-spike through CaraCMS Cloud')), logged.join('\n'));
		assert.deepEqual([...githubAuth], [`Bearer ${TOKEN}`], 'GitHub sees only the cloud\'s token');
	});

	test('check 18: sign in and poll; neither the key nor a token is in any log line or anything sent to the browser', async () => {
		const asked = await req('/admin/login', {
			method: 'POST',
			headers: { Origin: site.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ email: EMAIL, next: '/admin' }),
		});
		assert.equal(asked.status, 200);
		let link: string | undefined;
		for (let i = 0; i < 100 && !link; i++) {
			link = /(https?:\/\/\S+\/admin\/login\/confirm\?token=[A-Za-z0-9_-]{43})/.exec(logged.find((l) => l.includes(`sign-in link for ${EMAIL} `)) ?? '')?.[1];
			if (!link) await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(link, logged.join('\n'));
		const pressed = await req('/admin/login/signin', {
			method: 'POST',
			headers: { Origin: site.origin, 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ kind: 'link', token: new URL(link).searchParams.get('token') }),
		});
		assert.equal(pressed.status, 200);
		const cookie = pressed.headers.get('set-cookie')!.split(';')[0]!;
		const editor = await req('/admin', { headers: { cookie } });
		assert.equal(editor.status, 200);
		const status = await req('/_caracms/status', { headers: { cookie, 'X-Caracms-Tab': 'tab-1' } });
		assert.equal(status.status, 200);
		await req('/_caracms/documents', { headers: { cookie } });

		assert.ok(answered.length >= 6, `responses read: ${answered.length}`);
		for (const [what, texts] of [
			['the log', logged],
			['the responses', answered],
		] as const) {
			const all = texts.join('\n');
			assert.ok(!all.includes(KEY), `the key is in ${what}`);
			assert.ok(!all.includes(KEY.slice(4)), `part of the key is in ${what}`);
			assert.ok(!all.includes(TOKEN), `the token is in ${what}`);
			assert.ok(!/ghs_/.test(all), `a token's prefix is in ${what}`);
		}
	});
});
