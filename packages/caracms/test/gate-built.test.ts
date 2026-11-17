// `caracms start` on the real built starter (M6 Decision 2): the adapter's own handler
// behind the gate, so prerendered pages and static files, which the adapter sends
// before Astro's middleware, get the password and the robots header too. gate.test.ts
// covers the rules on a stub; this proves the handler export and the header-keeping
// against what the adapter really writes. And Decision 8 on the real bundle: without the
// gate (`node dist/server/entry.mjs`), a forged x-caracms-client-ip gets the 503; behind it,
// the IP is the gate's. Needs `pnpm build` first; without starter/dist it skips.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NO_GATE_MESSAGE } from '../src/live/auth/request.ts';

const bin = fileURLToPath(new URL('../bin/caracms.mjs', import.meta.url));
const starter = fileURLToPath(new URL('../../../starter', import.meta.url));
const entry = join(starter, 'dist/server/entry.mjs');
const skip = existsSync(entry) ? false : 'starter/dist is missing: run `pnpm build` first';

const PASSWORD = 'site:open…';

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function ask(
	port: number,
	path: string,
	{ host = 'localhost', auth, method = 'GET', body, headers: extra = {} }: { host?: string; auth?: string; method?: string; body?: string; headers?: Record<string, string> } = {},
) {
	return new Promise<Reply>((resolve, reject) => {
		const headers: Record<string, string> = { Host: host, ...extra };
		if (auth !== undefined) headers.Authorization = 'Basic ' + Buffer.from(auth, 'utf8').toString('base64');
		if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
		const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (d) => (text += d));
			res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
		});
		req.on('error', reject);
		req.end(body);
	});
}

/** The child's environment: this one's minus anything caracms or the adapter reads, then `extra`. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of Object.keys(env)) {
		if (/^(GITHUB_|CARACMS_|RAILWAY_|FLY_APP_NAME$|RENDER$|REDIS_URL$|SITE_URL$|HOST$|PORT$|NODE_OPTIONS$|ASTRO_)/.test(name)) delete env[name];
	}
	return Object.assign(env, extra);
}

/** Spawns `args` in the starter and waits for /health. */
async function serve(args: string[], env: NodeJS.ProcessEnv, port: number) {
	const child = spawn(process.execPath, args, { cwd: starter, env, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	child.stdout!.on('data', (d) => (log += d));
	child.stderr!.on('data', (d) => (log += d));
	const end = Date.now() + 15000;
	while (Date.now() < end) {
		if (child.exitCode !== null) throw new Error(`the server exited (${child.exitCode}):\n${log}`);
		try {
			if ((await ask(port, '/health')).status === 200) return { child, log: () => log };
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	child.kill();
	throw new Error(`the server didn't start:\n${log}`);
}

/** A visitor's own x-caracms-client-ip (and the rest), different on each attempt. */
const forged = (i: number) => ({ 'x-caracms-client-ip': `198.51.100.${i}`, 'X-Real-IP': `203.0.113.${i}`, 'X-Forwarded-For': `192.0.2.${i}` });
const FORM_BODY = 'form=contact&name=Aoife&email=aoife%40example.com&return=/contact';
const FILE = '/files/0123456789ab/rulebook.pdf';
/** A same-site form post, as a browser sends it (Astro's own origin check lets it by). */
const SAME_SITE = { 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json' };

describe('caracms start on the built starter, behind the password', { skip }, () => {
	let child: ChildProcess;
	let port: number;
	let log = '';

	before(async () => {
		port = await freePort();
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const name of Object.keys(env)) {
			if (/^(GITHUB_|CARACMS_|RAILWAY_|FLY_APP_NAME$|RENDER$|REDIS_URL$|SITE_URL$|HOST$|PORT$|NODE_OPTIONS$|ASTRO_)/.test(name)) delete env[name];
		}
		// No host is detected, so the IP source is named (runs-anywhere Decision 8).
		Object.assign(env, { HOST: '127.0.0.1', PORT: String(port), SITE_URL: 'https://site.test', CARACMS_PRELAUNCH: PASSWORD, CARACMS_CLIENT_IP_HEADER: 'socket' });
		child = spawn(process.execPath, [bin, 'start'], { cwd: starter, env, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout!.on('data', (d) => (log += d));
		child.stderr!.on('data', (d) => (log += d));
		const end = Date.now() + 15000;
		while (Date.now() < end) {
			if (child.exitCode !== null) throw new Error(`the server exited (${child.exitCode}):\n${log}`);
			try {
				if ((await ask(port, '/health')).status === 200) return;
			} catch {}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`the server didn't start:\n${log}`);
	});
	after(() => child?.kill());

	test('a prerendered page and a public file answer 401 with the brand’s realm', async () => {
		const brand = JSON.parse(readFileSync(join(starter, 'content/site-settings.json'), 'utf8')).brand?.name ?? '';
		for (const path of ['/', '/favicon.svg']) {
			const res = await ask(port, path, { host: 'site.test' });
			assert.equal(res.status, 401, path);
			assert.equal(res.headers['www-authenticate'], `Basic realm="${brand.replace(/[^\x20-\x7e]|["\\]/g, '').trim() || 'This site'} (not launched yet)"`);
			assert.equal(res.headers['x-robots-tag'], 'noindex');
			assert.doesNotMatch(res.body, /<h1|<svg/);
		}
	});

	test('with the password: the page, unmarked on SITE_URL’s host, noindex elsewhere', async () => {
		const page = await ask(port, '/', { host: 'site.test', auth: PASSWORD });
		assert.equal(page.status, 200);
		assert.match(page.body, /<h1/);
		assert.equal(page.headers['x-robots-tag'], undefined);
		const local = await ask(port, '/', { host: 'localhost', auth: PASSWORD });
		assert.equal(local.status, 200);
		assert.equal(local.headers['x-robots-tag'], 'noindex');
		const missing = await ask(port, '/no-such-page', { host: 'localhost', auth: PASSWORD });
		assert.equal(missing.status, 404);
		assert.equal(missing.headers['x-robots-tag'], 'noindex', 'the 404 too');
	});

	test('robots.txt, /health, a /_astro/ file and the editor need no password', async () => {
		const robots = await ask(port, '/robots.txt', { host: 'site.test' });
		assert.equal(robots.status, 200);
		assert.match(robots.body, /Sitemap: https:\/\/site\.test\/sitemap\.xml/);
		assert.equal((await ask(port, '/health', { host: 'site.test' })).status, 200);

		const asset = readdirSync(join(starter, 'dist/client/_astro')).find((f) => f.endsWith('.css') || f.endsWith('.js'));
		assert.ok(asset, 'the build has a /_astro/ file');
		const file = await ask(port, `/_astro/${asset}`, { host: 'localhost' });
		assert.equal(file.status, 200);
		assert.equal(file.headers['x-robots-tag'], 'noindex', 'a static file sent by the adapter keeps the header');
		assert.match(String(file.headers['cache-control']), /immutable/, 'and its own headers');

		// No App variables: the editor's 503, past the gate, never indexable.
		const admin = await ask(port, '/admin/login', { host: 'site.test' });
		assert.notEqual(admin.status, 401);
		assert.equal(admin.headers['x-robots-tag'], 'noindex, nofollow');
	});
});

describe('runs-anywhere check 17 on the built starter: no gate, a forged gate header gets nothing', { skip }, () => {
	let server: Awaited<ReturnType<typeof serve>>;
	let port: number;

	before(async () => {
		port = await freePort();
		// The adapter's own server, as `node dist/server/entry.mjs` starts it: no `caracms start`, so no gate's mark.
		server = await serve([entry], cleanEnv({ HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', SITE_URL: 'https://site.test' }), port);
	});
	after(() => server?.child.kill());

	test('the form endpoint and /files answer 503 with the sentence, every forged header rotated', async () => {
		for (let i = 0; i < 6; i++) {
			const form = await ask(port, '/_caracms/form', { method: 'POST', host: 'site.test', body: FORM_BODY, headers: { ...SAME_SITE, ...forged(i) } });
			assert.equal(form.status, 503, `form, attempt ${i}`);
			assert.deepEqual(JSON.parse(form.body), { error: NO_GATE_MESSAGE });
			const file = await ask(port, FILE, { host: 'site.test', headers: forged(i) });
			assert.equal(file.status, 503, `file, attempt ${i}`);
			assert.equal(file.body, NO_GATE_MESSAGE);
		}
	});

	test('sign-in is a 503 too (here the unconfigured editor\'s; the sign-in handler\'s own is runs-anywhere-request.test.ts\'s), and the public pages serve', async () => {
		for (let i = 0; i < 3; i++) assert.equal((await ask(port, '/admin/login', { host: 'site.test', headers: forged(i) })).status, 503);
		const page = await ask(port, '/', { host: 'site.test', headers: forged(0) });
		assert.equal(page.status, 200);
		assert.match(page.body, /<h1/);
	});
});

describe('runs-anywhere checks 14–15 on the built starter: behind caracms start, the IP is the gate\'s', { skip }, () => {
	let server: Awaited<ReturnType<typeof serve>>;
	let port: number;

	before(async () => {
		port = await freePort();
		server = await serve([bin, 'start'], cleanEnv({ HOST: '127.0.0.1', PORT: String(port), SITE_URL: 'https://site.test', CARACMS_CLIENT_IP_HEADER: 'socket' }), port);
	});
	after(() => server?.child.kill());

	test('the gate marks the process the bundle runs in: a forged header is replaced, and the form and /files get past the IP', async () => {
		const form = await ask(port, '/_caracms/form', { method: 'POST', host: 'site.test', body: FORM_BODY, headers: { ...SAME_SITE, ...forged(0) } });
		// Past Astro's origin check and the IP: whatever the form endpoint answers next, it isn't the 503.
		assert.ok(form.status !== 503 && !/Cross-site/.test(form.body), `form: ${form.status} ${form.body}`);
		const file = await ask(port, FILE, { host: 'site.test', headers: forged(0) });
		assert.notEqual(file.body, NO_GATE_MESSAGE, `file: ${file.status}`);
	});
});
