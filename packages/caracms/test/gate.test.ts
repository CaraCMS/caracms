// `caracms start` and its gate (M6 Decisions 2, 10, 11; Acceptance 35, 36, 38, 40, 41).
//
// The bin runs as a child process with `node` and no flags, in a temp site root whose
// `dist/server/entry.mjs` is a stub exporting a fake `handler`: pages written the way
// Astro writes them (`writeHead` with a headers object), static files the way `send`
// does (`setHeader`, then an implicit head), and a 404. Requests carry explicit `Host`
// headers, so the indexable host and the others are both reachable on 127.0.0.1.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	CLIENT_IP_FIX,
	GATED_MARK,
	isCloudflareIp,
	isNeverIndexableHostname,
	isPlatformHost,
	normaliseIp,
	parseRedirects as gateParseRedirects,
	parseSiteUrl,
	publicAddress,
	readBuildInfo,
	readClientIpSource,
	redirectFor as gateRedirectFor,
	resolveClientIp,
} from '../bin/gate.mjs';
import { SITE_SETTINGS_FILE } from '../src/config.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { handleMove } from '../src/editor/server/move.ts';
import { parseRedirects, redirectFor } from '../src/redirects.ts';
import { makeHolderSite } from './helpers/move-site.ts';
import { GATED_MARK as REQUEST_GATED_MARK } from '../src/live/auth/request.ts';

const bin = fileURLToPath(new URL('../bin/caracms.mjs', import.meta.url));
const binDir = fileURLToPath(new URL('../bin/', import.meta.url));

const STUB_ENTRY = `
const autostart = process.env.ASTRO_NODE_AUTOSTART;
// The gate's mark (Decision 8), as the site's own code sees it when it loads.
const gatedAtImport = globalThis[Symbol.for('caracms.gated')] === true;
const attempts = new Map();
export const options = { mode: 'standalone' };
export const handler = (req, res) => {
	const path = req.url.split('?')[0];
	if (path === '/_astro/app.css' || path === '/favicon.svg') {
		// As \`send\` does: headers one by one, then the body.
		res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'image/svg+xml');
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
		res.end('static ' + path);
		return;
	}
	if (path === '/autostart') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end(String(autostart));
		return;
	}
	if (path === '/gated') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ atImport: gatedAtImport, now: globalThis[Symbol.for('caracms.gated')] === true }));
		return;
	}
	if (path === '/node-env') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end(String(process.env.NODE_ENV));
		return;
	}
	if (path === '/ip') {
		// What the site sees of the visitor: the gate's header, and every copy of it the request still carries.
		const copies = [];
		for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'x-caracms-client-ip') copies.push(req.rawHeaders[i + 1]);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ip: req.headers['x-caracms-client-ip'] ?? null, copies }));
		return;
	}
	if (path === '/limited' && req.method === 'POST') {
		// A stand-in for the sign-in limit (src/live/auth): five attempts per IP, keyed on the gate's header as clientIp() is.
		const ip = String(req.headers['x-caracms-client-ip']);
		const count = (attempts.get(ip) ?? 0) + 1;
		attempts.set(ip, count);
		res.writeHead(count > 5 ? 429 : 401, { 'content-type': 'text/plain' });
		res.end(ip);
		return;
	}
	if (path === '/health') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('ok');
		return;
	}
	if (path === '/admin/login') {
		res.writeHead(200, { 'content-type': 'text/html', 'x-robots-tag': 'noindex, nofollow' });
		res.end('<h1>Sign in</h1>');
		return;
	}
	if (path === '/_caracms/form' && req.method === 'POST') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('{"ok":true}');
		return;
	}
	if (path === '/' || path === '/contact') {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<h1>page ' + path + '</h1>');
		return;
	}
	if (path.startsWith('/files/')) {
		// The file route (files-route.ts) reads CARACMS_PRELAUNCH in this same process for its cache header.
		res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': process.env.CARACMS_PRELAUNCH ? 'private, max-age=86400' : 'public, max-age=31536000, immutable' });
		res.end('file ' + path);
		return;
	}
	if (path.endsWith('.html')) {
		// A prerendered page, as the adapter's static handler sends it.
		res.setHeader('Content-Type', 'text/html');
		res.end('html ' + path);
		return;
	}
	if (path === '/gone-implicit') {
		// A 404 with an implicit head: a status, then the body.
		res.statusCode = 404;
		res.setHeader('Content-Type', 'text/html');
		res.end('<h1>Not found</h1>');
		return;
	}
	if (path === '/opinionated') {
		// A page that sets its own robots header: the gate's value wins where it has one.
		res.setHeader('X-Robots-Tag', 'all');
		res.writeHead(200, ['Content-Type', 'text/html', 'X-Robots-Tag', 'index, follow']);
		res.end('<h1>opinionated</h1>');
		return;
	}
	res.writeHead(404, { 'content-type': 'text/html' });
	res.end('<h1>Not found</h1>');
};
`;

function makeSite(brandName?: unknown): string {
	const root = mkdtempSync(join(tmpdir(), 'caracms-gate-'));
	mkdirSync(join(root, 'dist/server'), { recursive: true });
	writeFileSync(join(root, 'dist/server/entry.mjs'), STUB_ENTRY);
	if (brandName !== undefined) {
		mkdirSync(join(root, 'content'), { recursive: true });
		writeFileSync(join(root, 'content/site-settings.json'), JSON.stringify({ title: 'Site Settings', brand: { name: brandName } }));
	}
	return root;
}

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
	{ host = 'localhost', method = 'GET', auth, body, headers: extra = {} }: { host?: string; method?: string; auth?: string; body?: string; headers?: Record<string, string | string[]> } = {},
) {
	return new Promise<Reply>((resolve, reject) => {
		const headers: Record<string, string | string[]> = { Host: host, ...extra };
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

interface Server {
	port: number;
	log: () => string;
	stop: () => void;
}

const children: ChildProcess[] = [];
const roots: string[] = [];
after(() => {
	for (const child of children) child.kill();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The child's environment: this one's minus anything the gate reads, then `env` (an undefined value unsets it). */
function envFor(env: Record<string, string | undefined>, port: number, host: string | null = '127.0.0.1'): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const name of Object.keys(childEnv)) {
		if (/^(SITE_URL|CARACMS_|RAILWAY_|FLY_APP_NAME$|RENDER$|HOST$|PORT$|NODE_ENV$|NODE_OPTIONS$|ASTRO_)/.test(name)) delete childEnv[name];
	}
	// No host is detected here, so a test that doesn't name the IP source gets the socket.
	if (!('CARACMS_CLIENT_IP_HEADER' in env)) childEnv.CARACMS_CLIENT_IP_HEADER = 'socket';
	Object.assign(childEnv, { PORT: String(port) }, env);
	if (host !== null) childEnv.HOST = host;
	for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
	return childEnv;
}

/** Starts `node <bin> start` (no flags) in `root`, with `HOST=127.0.0.1` unless `host` is null (unset). */
async function startServer(root: string, env: Record<string, string | undefined>, { host = '127.0.0.1' }: { host?: string | null } = {}): Promise<Server> {
	const port = await freePort();
	const childEnv = envFor(env, port, host);
	const child = spawn(process.execPath, [bin, 'start'], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(child);
	let log = '';
	child.stdout!.on('data', (d) => (log += d));
	child.stderr!.on('data', (d) => (log += d));
	const end = Date.now() + 10000;
	while (Date.now() < end) {
		if (child.exitCode !== null) throw new Error(`the server exited (${child.exitCode}):\n${log}`);
		if (log.includes('listening on')) {
			try {
				// As a platform's health check asks at boot: from inside, so with no client-IP header.
				await ask(port, '/health', { headers: { Host: 'healthcheck.railway.app' } });
				return { port, log: () => log, stop: () => child.kill() };
			} catch {}
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	child.kill();
	throw new Error(`the server didn't start:\n${log}`);
}

function site(brandName?: unknown) {
	const root = makeSite(brandName);
	roots.push(root);
	return root;
}

describe('caracms start: the bin itself (Acceptance 40)', () => {
	test('it imports only Node built-ins and its own gate, and no TypeScript', () => {
		for (const file of ['caracms.mjs', 'gate.mjs']) {
			const source = readFileSync(join(binDir, file), 'utf8');
			assert.doesNotMatch(source, /\.ts['"]/, `${file} names a .ts file`);
		}
		// M8: every command's module, static imports and literal dynamic ones alike: Node built-ins and the bin's own modules.
		const own = readdirSync(binDir).filter((f) => f.endsWith('.mjs'));
		assert.ok(own.includes('caracms.mjs') && own.includes('gate.mjs'));
		for (const file of own) {
			const source = readFileSync(join(binDir, file), 'utf8');
			const specifiers = [
				...[...source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!),
				...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!),
			];
			// The ranges are data only, with nothing to import.
			assert.ok(specifiers.length > 0 || file === 'cloudflare-ips.mjs', file);
			for (const s of specifiers) assert.ok(s.startsWith('node:') || (s.startsWith('./') && own.includes(s.slice(2))), `${file} imports ${s}`);
		}
	});

	test("package.json's bin points at it as npm publishes it: no leading ./", () => {
		// npm 11's publish drops a bin entry written `./bin/…` ("invalid and removed"),
		// leaving a package with no `caracms` command; npm pack keeps it, so the release test can't see it.
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> };
		assert.deepEqual(pkg.bin, { caracms: 'bin/caracms.mjs' });
	});

	test('with HOST unset it listens on 0.0.0.0, run by node with no flags, and the adapter does not autostart', async () => {
		const server = await startServer(site('CaraCMS'), {}, { host: null });
		assert.match(server.log(), /listening on http:\/\/0\.0\.0\.0:\d+/);
		const res = await ask(server.port, '/autostart');
		assert.equal(res.body, 'disabled');
		server.stop();
	});

	test('with no built entry it stops with a sentence', async () => {
		const root = mkdtempSync(join(tmpdir(), 'caracms-gate-empty-'));
		roots.push(root);
		const child = spawn(process.execPath, [bin, 'start'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
		let log = '';
		child.stderr!.on('data', (d) => (log += d));
		const code = await new Promise((r) => child.on('exit', r));
		assert.equal(code, 1);
		assert.match(log, /dist\/server\/entry\.mjs.*Run `astro build`/);
	});
});

describe('never indexable: Railway hosts, localhost, no SITE_URL (Acceptance 35)', () => {
	for (const [label, env, host] of [
		['the Railway domain, as SITE_URL', { SITE_URL: 'https://site.up.railway.app' }, 'site.up.railway.app'],
		['localhost, as SITE_URL', { SITE_URL: 'http://localhost:4330' }, 'localhost:4330'],
		['no SITE_URL', {}, 'site.test'],
		['a custom SITE_URL, asked on another host', { SITE_URL: 'https://site.test' }, 'site.up.railway.app'],
	] as const) {
		test(label, async () => {
			const server = await startServer(site('CaraCMS'), { ...env, CARACMS_PRELAUNCH: 'site:open' });
			const robots = await ask(server.port, '/robots.txt', { host });
			assert.equal(robots.status, 200);
			assert.equal(robots.body, 'User-agent: *\nDisallow: /\n');
			assert.equal(robots.headers['x-robots-tag'], 'noindex');

			for (const path of ['/', '/_astro/app.css', '/no-such-page', '/opinionated']) {
				const res = await ask(server.port, path, { host, auth: 'site:open' });
				assert.equal(res.headers['x-robots-tag'], 'noindex', `${path} (${res.status})`);
			}
			assert.equal((await ask(server.port, '/no-such-page', { host, auth: 'site:open' })).status, 404);
			const css = await ask(server.port, '/_astro/app.css', { host });
			assert.equal(css.status, 200);
			assert.equal(css.headers['cache-control'], 'public, max-age=31536000, immutable', 'the static headers are still there');

			const locked = await ask(server.port, '/', { host });
			assert.equal(locked.status, 401);
			assert.equal(locked.headers['x-robots-tag'], 'noindex');

			const admin = await ask(server.port, '/admin/login', { host });
			assert.equal(admin.headers['x-robots-tag'], 'noindex, nofollow');
			server.stop();
		});
	}
});

describe('indexable only on SITE_URL’s host (Acceptance 36)', () => {
	test('site.test: robots names the sitemap, pages carry no header, the editor does', async () => {
		const server = await startServer(site('CaraCMS'), { SITE_URL: 'https://site.test' });
		const robots = await ask(server.port, '/robots.txt', { host: 'site.test' });
		assert.equal(robots.status, 200);
		assert.equal(robots.body, 'User-agent: *\nDisallow: /admin\nDisallow: /_caracms/\nSitemap: https://site.test/sitemap.xml\n');
		assert.equal(robots.headers['x-robots-tag'], undefined);

		for (const path of ['/', '/contact', '/_astro/app.css', '/no-such-page']) {
			const res = await ask(server.port, path, { host: 'site.test' });
			assert.equal(res.headers['x-robots-tag'], undefined, path);
		}
		for (const path of ['/admin/login', '/admin', '/_caracms/preview', '//admin', '/%61dmin', '/ADMIN/x']) {
			const res = await ask(server.port, path, { host: 'site.test' });
			assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow', path);
		}
		const post = await ask(server.port, '/_caracms/form', { host: 'site.test', method: 'POST', body: 'form=contact' });
		assert.equal(post.headers['x-robots-tag'], 'noindex, nofollow');

		// The same server, asked on localhost, is closed.
		const local = await ask(server.port, '/robots.txt', { host: 'localhost' });
		assert.equal(local.body, 'User-agent: *\nDisallow: /\n');
		assert.equal((await ask(server.port, '/', { host: 'localhost' })).headers['x-robots-tag'], 'noindex');
		server.stop();
	});

	test('robots.txt by another spelling is still the gate’s', async () => {
		const server = await startServer(site('CaraCMS'), { SITE_URL: 'https://site.test', CARACMS_PRELAUNCH: 'site:open' });
		for (const path of ['//robots.txt', '/%72obots.txt', '/x/../robots.txt', '/robots.txt?x=1']) {
			const res = await ask(server.port, path, { host: 'site.test' });
			assert.equal(res.status, 200, path);
			assert.match(res.body, /Sitemap: https:\/\/site\.test\/sitemap\.xml/, path);
		}
		server.stop();
	});
});

describe('caracms start: NODE_ENV (Decision 7)', () => {
	test('a built site is a production server: the entry sees NODE_ENV=production when it was unset', async () => {
		const server = await startServer(site('CaraCMS'), {});
		assert.equal((await ask(server.port, '/node-env')).body, 'production');
		server.stop();
	});

	test('an explicit NODE_ENV is left as it was', async () => {
		const server = await startServer(site('CaraCMS'), { NODE_ENV: 'development' });
		assert.equal((await ask(server.port, '/node-env')).body, 'development');
		server.stop();
	});
});

describe('the pre-launch password (Acceptance 38, 41)', () => {
	const PASSWORD = 'site:open…';

	test('pages and public files answer 401 with the realm; robots, health, the editor, /_astro/ and the form don’t', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_PRELAUNCH: PASSWORD, SITE_URL: 'https://site.test' });
		for (const host of ['site.test', 'localhost']) {
			for (const path of ['/', '/contact', '/favicon.svg', '/no-such-page']) {
				const res = await ask(server.port, path, { host });
				assert.equal(res.status, 401, `${host}${path}`);
				assert.equal(res.headers['www-authenticate'], 'Basic realm="CaraCMS (not launched yet)"');
				assert.equal(res.headers['x-robots-tag'], 'noindex', `${host}${path}: the 401 is never indexable`);
				assert.doesNotMatch(res.body, /page|static/, 'the page never leaks');
			}
		}
		for (const path of ['/robots.txt', '/health', '/admin/login', '/_astro/app.css']) {
			assert.equal((await ask(server.port, path, { host: 'site.test' })).status, 200, path);
		}
		const form = await ask(server.port, '/_caracms/form', { host: 'site.test', method: 'POST', body: 'form=contact' });
		assert.equal(form.status, 200);
		assert.equal(form.body, '{"ok":true}');
		server.stop();
	});

	test('Acceptance 39 (the server half): the whole editor and its API pass without the password, and only the public files its preview links ask for it', async () => {
		// The browser half (a signed-in editor in a built server) needs a real GitHub App: the in-memory GitHub is refused in production.
		// What the editor needs of the gate is here: nothing of its own is behind the password (Decision 10), so the browser
		// asks for the site's password only for what the preview links, and sends it with every request after the first.
		const server = await startServer(site('CaraCMS'), { CARACMS_PRELAUNCH: PASSWORD });
		for (const path of ['/admin', '/admin/', '/admin/submissions', '/admin/submissions/2026-10-16T13-12-00-000Z_aaaaaa', '/_caracms/preview?path=index', '/_caracms/documents', '/_caracms/status', '/_caracms/write', '/_caracms/media/uploads/a.jpg']) {
			const res = await ask(server.port, path, { host: 'localhost' });
			assert.notEqual(res.status, 401, `${path}: reached the app, not the gate`);
		}
		const link = await ask(server.port, '/favicon.svg', { host: 'localhost' });
		assert.equal(link.status, 401, 'a file the preview links');
		assert.match(String(link.headers['www-authenticate']), /^Basic realm=/, 'so the browser asks, once');
		assert.equal((await ask(server.port, '/favicon.svg', { host: 'localhost', auth: PASSWORD })).status, 200, 'and with it, it loads');
		server.stop();
	});

	test('M6c Acceptance 9 (the gate half): /files/… asks for the password; past it, the process behind sees CARACMS_PRELAUNCH (the real header is files-route.test.ts’s)', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_PRELAUNCH: PASSWORD, SITE_URL: 'https://site.test' });
		const file = '/files/0123456789ab/rulebook.pdf';
		for (const path of [file, `${file}?download`, '/files/', '/files']) {
			for (const method of ['GET', 'HEAD']) {
				const res = await ask(server.port, path, { host: 'site.test', method });
				assert.equal(res.status, 401, `${method} ${path}`);
				assert.match(String(res.headers['www-authenticate']), /^Basic realm=/);
				assert.doesNotMatch(res.body, /file/, 'the file never leaks');
			}
		}
		const through = await ask(server.port, file, { host: 'site.test', auth: PASSWORD });
		assert.equal(through.status, 200);
		assert.equal(through.body, `file ${file}`);
		assert.equal(through.headers['cache-control'], 'private, max-age=86400', 'the stub entry reads the variable in the gate\'s own process (it proves the env arrives, not the real header)');
		server.stop();
		const open = await startServer(site('CaraCMS'), {});
		assert.equal((await ask(open.port, file)).headers['cache-control'], 'public, max-age=31536000, immutable', 'and without it, public');
		open.stop();
	});

	test('a wrong password is a 401, and the right one gets the page', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_PRELAUNCH: PASSWORD });
		for (const wrong of ['site:open', 'site:open……', 'site', 'site:', ':open…', 'Site:open…', '']) {
			assert.equal((await ask(server.port, '/', { auth: wrong })).status, 401, JSON.stringify(wrong));
		}
		const bad = await new Promise<number>((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port: server.port, path: '/', headers: { Host: 'localhost', Authorization: 'Bearer abc' } }, (res) => {
				res.resume();
				resolve(res.statusCode!);
			});
			req.on('error', reject);
			req.end();
		});
		assert.equal(bad, 401, 'not Basic');
		const ok = await ask(server.port, '/contact', { auth: PASSWORD });
		assert.equal(ok.status, 200);
		assert.equal(ok.body, '<h1>page /contact</h1>');
		assert.equal((await ask(server.port, '/favicon.svg', { auth: PASSWORD })).status, 200);
		server.stop();
	});

	test('address tricks neither dodge the password nor abuse an exemption', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_PRELAUNCH: PASSWORD });
		for (const path of [
			'/_astro/../contact',
			'/_astro/%2e%2e/contact',
			'/_astro/..%2Fcontact',
			'/_astro%2F..%2Fcontact',
			'/admin/../contact',
			'/admin/%2e%2e/contact',
			'/admin%2F..%2Fcontact',
			'/_caracms/..%2Fcontact',
			'/health/../contact',
			'/x/..%2Fadmin',
			'/%',
			'/contact%',
		]) {
			const res = await ask(server.port, path);
			assert.equal(res.status, 401, path);
		}
		// The editor's own spellings stay exempt (the guard handles them past the gate).
		for (const path of ['//admin/login', '/%61dmin/login', '/ADMIN/login', '/_caracms/x']) {
			assert.notEqual((await ask(server.port, path)).status, 401, path);
		}
		server.stop();
	});

	test('surrounding whitespace and newlines are trimmed from the whole value, as SITE_URL is', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_PRELAUNCH: ' site:open\n' });
		assert.equal((await ask(server.port, '/')).status, 401);
		assert.equal((await ask(server.port, '/', { auth: 'site:open' })).status, 200, 'the password has no newline in it');
		assert.equal((await ask(server.port, '/', { auth: 'site:open\n' })).status, 401);
		assert.match(server.log(), /pre-launch password: on/);
		server.stop();
	});

	test('unset, empty or one-part values leave the site public', async () => {
		for (const value of [undefined, '', 'site', 'site:', ':open', ' \n', 'site:\n', '\n:open']) {
			const server = await startServer(site('CaraCMS'), { CARACMS_PRELAUNCH: value });
			assert.equal((await ask(server.port, '/')).status, 200, JSON.stringify(value));
			server.stop();
		}
	});

	test('the realm strips quotes, backslashes, newlines and non-ASCII from the brand name', async () => {
		const cases: [unknown, string][] = [
			['Site "open" é\\café\nNew\r\tline\u0000', 'Basic realm="Site open cafNewline (not launched yet)"'],
			['Siteñopen', 'Basic realm="Siteopen (not launched yet)"'],
			['"\n"é', 'Basic realm="This site (not launched yet)"'],
			[42, 'Basic realm="This site (not launched yet)"'],
			[undefined, 'Basic realm="This site (not launched yet)"'],
		];
		for (const [name, realm] of cases) {
			const server = await startServer(site(name), { CARACMS_PRELAUNCH: PASSWORD });
			const res = await ask(server.port, '/');
			assert.equal(res.headers['www-authenticate'], realm, JSON.stringify(name));
			server.stop();
		}
	});
});

// ── Runs anywhere: the visitor's IP (Decision 8; Acceptance 13–16a) and indexing (Decision 13; Acceptance 28) ──

/** Runs `node <bin> start` expecting it to stop; its exit code and everything it printed. */
async function startExpectingExit(root: string, env: Record<string, string | undefined>) {
	const child = spawn(process.execPath, [bin, 'start'], { cwd: root, env: envFor(env, await freePort()), stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(child);
	let log = '';
	child.stdout!.on('data', (d) => (log += d));
	child.stderr!.on('data', (d) => (log += d));
	const code = await new Promise<number | null>((resolve) => {
		const timer = setTimeout(() => {
			child.kill();
			resolve(null);
		}, 10000);
		child.on('exit', (c) => {
			clearTimeout(timer);
			resolve(c);
		});
	});
	return { code, log };
}

const ipOf = async (port: number, headers: Record<string, string | string[]> = {}) => JSON.parse((await ask(port, '/ip', { headers })).body) as { ip: string | null; copies: string[] };

/** Six sign-in attempts, each with `headersFor(i)`: the sixth must be refused, so rotating those headers got past nothing. */
async function sixAttempts(port: number, headersFor: (i: number) => Record<string, string | string[]>) {
	const statuses: number[] = [];
	const keys = new Set<string>();
	for (let i = 0; i < 6; i++) {
		const res = await ask(port, '/limited', { method: 'POST', headers: headersFor(i) });
		statuses.push(res.status);
		keys.add(res.body);
	}
	return { statuses, keys: [...keys] };
}

const LIMITED = [401, 401, 401, 401, 401, 429];

describe('the IP source: settings and hosts (Acceptance 13)', () => {
	const fix = CLIENT_IP_FIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	test('no host detected and no CARACMS_CLIENT_IP_HEADER: it exits with the sentence giving the exact fix', async () => {
		const { code, log } = await startExpectingExit(site('CaraCMS'), { CARACMS_CLIENT_IP_HEADER: undefined });
		assert.equal(code, 1);
		assert.match(log, new RegExp(`caracms start: no host was detected.*${fix}`));
		assert.doesNotMatch(log, /listening on/);
	});

	for (const [label, env] of [
		['no host', { CARACMS_CLIENT_IP_HEADER: 'x-client-ip' }],
		['on Railway', { CARACMS_CLIENT_IP_HEADER: 'True-Client-IP', RAILWAY_ENVIRONMENT_ID: 'env-1' }],
		['on Fly', { CARACMS_CLIENT_IP_HEADER: 'x-forwarded-for-last', FLY_APP_NAME: 'site-a' }],
		['on Render', { CARACMS_CLIENT_IP_HEADER: 'forwarded', RENDER: 'true' }],
	] as const) {
		test(`an unknown value, ${label}: it exits with the same fix, naming the value`, async () => {
			const { code, log } = await startExpectingExit(site('CaraCMS'), env);
			assert.equal(code, 1);
			assert.match(log, new RegExp(`CARACMS_CLIENT_IP_HEADER is "${env.CARACMS_CLIENT_IP_HEADER}".*${fix}`));
		});
	}

	for (const [host, env, line] of [
		['Railway', { RAILWAY_ENVIRONMENT_ID: 'env-1' }, /client IP: X-Real-IP \(Railway's default, from RAILWAY_ENVIRONMENT_ID\)/],
		['Fly', { FLY_APP_NAME: 'site-a' }, /client IP: Fly-Client-IP \(Fly's default, from FLY_APP_NAME\)/],
		['Render', { RENDER: 'true' }, /client IP: X-Forwarded-For's last entry \(Render's default, from RENDER\)/],
	] as const) {
		test(`with nothing set, on ${host}: it starts with the host's default and prints which`, async () => {
			const server = await startServer(site('CaraCMS'), { ...env, CARACMS_CLIENT_IP_HEADER: undefined });
			assert.match(server.log(), line);
			assert.match(server.log(), /CF-Connecting-IP when that address is Cloudflare's, on the site's own domain/);
			server.stop();
		});
	}

	test('a set value always wins over the host, any case, and the line says where it came from', async () => {
		const server = await startServer(site('CaraCMS'), { RAILWAY_ENVIRONMENT_ID: 'env-1', CARACMS_CLIENT_IP_HEADER: ' Socket ' });
		assert.match(server.log(), /client IP: the socket \(CARACMS_CLIENT_IP_HEADER\)/);
		assert.equal((await ipOf(server.port, { 'X-Real-IP': '198.51.100.8' })).ip, '127.0.0.1');
		server.stop();
	});

	test('the printed lines name no secret', async () => {
		const server = await startServer(site('CaraCMS'), {
			CARACMS_CLIENT_IP_HEADER: 'x-real-ip',
			CARACMS_PRELAUNCH: 'site:s3cret-pass',
			CARACMS_SECRET: 'the-session-secret',
			CARACMS_DEPLOY_HOOK_URL: 'https://api.render.com/deploy/srv-abc?key=hook-secret',
		});
		for (const secret of ['s3cret-pass', 'the-session-secret', 'hook-secret']) assert.ok(!server.log().includes(secret), secret);
		server.stop();
	});

	test('readClientIpSource: a set value wins, then Railway, Fly, Render in turn; empty counts as unset', () => {
		assert.deepEqual(readClientIpSource({ RAILWAY_ENVIRONMENT_ID: 'x', FLY_APP_NAME: 'y' }).source, 'x-real-ip');
		assert.equal(readClientIpSource({ FLY_APP_NAME: 'y', CARACMS_CLIENT_IP_HEADER: 'x-forwarded-for' }).source, 'x-forwarded-for');
		assert.equal(readClientIpSource({ RENDER: 'true', CARACMS_CLIENT_IP_HEADER: '' }).source, 'x-forwarded-for');
		assert.equal(readClientIpSource({ CARACMS_CLIENT_IP_HEADER: 'CF-Connecting-IP' }).source, 'cf-connecting-ip');
		assert.equal(readClientIpSource({ RENDER: '' }).source, null);
		assert.match(readClientIpSource({}).problem!, /no host was detected/);
	});
});

describe('the IP comes from one source, and forged copies get past nothing (Acceptance 14, 15, 16)', () => {
	test('14: with x-real-ip, a forged X-Forwarded-For and x-caracms-client-ip are ignored; the limit keys on X-Real-IP', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_CLIENT_IP_HEADER: 'x-real-ip' });
		const seen = await ipOf(server.port, { 'X-Real-IP': '198.51.100.8', 'X-Forwarded-For': '203.0.113.1', 'X-Caracms-Client-IP': '203.0.113.2' });
		assert.deepEqual(seen, { ip: '198.51.100.8', copies: ['198.51.100.8'] });
		const run = await sixAttempts(server.port, (i) => ({
			'X-Real-IP': '198.51.100.8',
			'X-Forwarded-For': `203.0.113.${i + 10}`,
			'x-caracms-client-ip': [`192.0.2.${i}`, `192.0.2.${i + 100}`],
		}));
		assert.deepEqual(run, { statuses: LIMITED, keys: ['198.51.100.8'] });
		server.stop();
	});

	test('15: with socket, forged X-Real-IP, X-Forwarded-For, CF-Connecting-IP and x-caracms-client-ip are all ignored', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_CLIENT_IP_HEADER: 'socket' });
		const run = await sixAttempts(server.port, (i) => ({
			'X-Real-IP': `198.51.100.${i}`,
			'X-Forwarded-For': `203.0.113.${i}, 173.245.48.${i}`,
			'CF-Connecting-IP': `192.0.2.${i}`,
			'Fly-Client-IP': `192.0.2.${i + 50}`,
			'x-caracms-client-ip': `192.0.2.${i + 100}`,
		}));
		assert.deepEqual(run, { statuses: LIMITED, keys: ['127.0.0.1'] });
		server.stop();
	});

	test('16: with x-forwarded-for, the last entry is used, never the first, across repeated header lines too', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_CLIENT_IP_HEADER: 'x-forwarded-for' });
		assert.equal((await ipOf(server.port, { 'X-Forwarded-For': '203.0.113.1, 203.0.113.2, 198.51.100.20' })).ip, '198.51.100.20');
		assert.equal((await ipOf(server.port, { 'X-Forwarded-For': ['203.0.113.1', '198.51.100.21'] })).ip, '198.51.100.21');
		const run = await sixAttempts(server.port, (i) => ({
			'X-Forwarded-For': `203.0.113.${i}, 192.0.2.${i}, 198.51.100.20`,
			'X-Real-IP': `198.51.100.${i + 100}`,
			'x-caracms-client-ip': `192.0.2.${i + 100}`,
		}));
		assert.deepEqual(run, { statuses: LIMITED, keys: ['198.51.100.20'] });
		server.stop();
	});

	test('with fly-client-ip, forged X-Real-IP and X-Forwarded-For are ignored', async () => {
		const server = await startServer(site('CaraCMS'), { FLY_APP_NAME: 'site-a', CARACMS_CLIENT_IP_HEADER: undefined });
		const run = await sixAttempts(server.port, (i) => ({ 'Fly-Client-IP': '198.51.100.30', 'X-Real-IP': `203.0.113.${i}`, 'X-Forwarded-For': `203.0.113.${i + 50}` }));
		assert.deepEqual(run, { statuses: LIMITED, keys: ['198.51.100.30'] });
		server.stop();
	});

	test('the header is set on every request, the editor, the password’s 401 and robots.txt included', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_CLIENT_IP_HEADER: 'x-real-ip', CARACMS_PRELAUNCH: 'site:open' });
		// /ip sits behind the password; with it, the site still sees only the gate's copy.
		const res = await ask(server.port, '/ip', { auth: 'site:open', headers: { 'X-Real-IP': '198.51.100.8', 'x-caracms-client-ip': '192.0.2.1' } });
		assert.deepEqual(JSON.parse(res.body), { ip: '198.51.100.8', copies: ['198.51.100.8'] });
		server.stop();
	});

	test('the gate marks its process before the site loads, so clientIp() trusts the header only there', async () => {
		assert.equal(GATED_MARK, Symbol.for('caracms.gated'));
		assert.equal(GATED_MARK, REQUEST_GATED_MARK, 'the gate and clientIp() name the same global');
		const server = await startServer(site('CaraCMS'), { CARACMS_CLIENT_IP_HEADER: 'socket' });
		const res = await ask(server.port, '/gated', { headers: { 'x-caracms-client-ip': '192.0.2.1' } });
		assert.deepEqual(JSON.parse(res.body), { atImport: true, now: true });
		server.stop();
		assert.equal((globalThis as Record<symbol, unknown>)[GATED_MARK], undefined, 'and only there: not this test process');
	});

	test('a request without the source header gets its socket’s address (never a forged copy), and the server says so once', async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_CLIENT_IP_HEADER: 'x-real-ip' });
		assert.deepEqual(await ipOf(server.port, { 'x-caracms-client-ip': '192.0.2.1' }), { ip: '127.0.0.1', copies: ['127.0.0.1'] });
		assert.deepEqual(await ipOf(server.port, { 'X-Real-IP': 'not-an-address', 'x-caracms-client-ip': '192.0.2.1' }), { ip: '127.0.0.1', copies: ['127.0.0.1'] });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(server.log().match(/came without X-Real-IP/g)?.length, 1);
		server.stop();
	});

	test("Railway's health check (Host: healthcheck.railway.app) gets its socket's address without the line; the next request without the header still says it", async () => {
		const server = await startServer(site('CaraCMS'), { CARACMS_CLIENT_IP_HEADER: 'x-real-ip' });
		assert.deepEqual(await ipOf(server.port, { Host: 'healthcheck.railway.app' }), { ip: '127.0.0.1', copies: ['127.0.0.1'] });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(server.log().match(/came without/g), null);
		await ipOf(server.port);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(server.log().match(/came without X-Real-IP/g)?.length, 1);
		server.stop();
	});
});

describe('behind Cloudflare: CF-Connecting-IP only from Cloudflare’s ranges, on the site’s own domain (Acceptance 16a)', () => {
	// The site's custom domain, proxied by Cloudflare: where Cloudflare sets CF-Connecting-IP itself.
	const OWN = 'www.example.com';

	test('on Railway, an X-Real-IP in Cloudflare’s ranges (v4 and v6) at the site’s own domain means CF-Connecting-IP', async () => {
		const server = await startServer(site('CaraCMS'), { RAILWAY_ENVIRONMENT_ID: 'env-1', CARACMS_CLIENT_IP_HEADER: undefined });
		assert.equal((await ipOf(server.port, { Host: OWN, 'X-Real-IP': '173.245.48.5', 'CF-Connecting-IP': '198.51.100.40' })).ip, '198.51.100.40');
		assert.equal((await ipOf(server.port, { Host: `${OWN}:443`, 'X-Real-IP': '2606:4700:10::6816:1', 'CF-Connecting-IP': '2001:db8::40' })).ip, '2001:db8::40');
		// Through Cloudflare, the visitor is limited by CF-Connecting-IP, whatever else is forged.
		const through = await sixAttempts(server.port, (i) => ({
			Host: OWN,
			'X-Real-IP': `104.16.0.${i + 1}`,
			'CF-Connecting-IP': '198.51.100.41',
			'X-Forwarded-For': `203.0.113.${i}`,
			'x-caracms-client-ip': `192.0.2.${i}`,
		}));
		assert.deepEqual(through, { statuses: LIMITED, keys: ['198.51.100.41'] });
		server.stop();
	});

	test('on Railway, rotating CF-Connecting-IP on a request whose X-Real-IP isn’t Cloudflare’s (calling *.up.railway.app directly) changes nothing', async () => {
		const server = await startServer(site('CaraCMS'), { RAILWAY_ENVIRONMENT_ID: 'env-1', CARACMS_CLIENT_IP_HEADER: undefined });
		const direct = await sixAttempts(server.port, (i) => ({ 'X-Real-IP': '198.51.100.50', 'CF-Connecting-IP': `203.0.113.${i}`, Host: 'site.up.railway.app' }));
		assert.deepEqual(direct, { statuses: LIMITED, keys: ['198.51.100.50'] });
		server.stop();
	});

	test('a Worker calling the host’s own address (Cloudflare’s egress in X-Real-IP, a CF-Connecting-IP of its choosing) is limited as one IP', async () => {
		const server = await startServer(site('CaraCMS'), { RAILWAY_ENVIRONMENT_ID: 'env-1', CARACMS_CLIENT_IP_HEADER: undefined });
		const worker = await sixAttempts(server.port, (i) => ({ Host: 'x.up.railway.app', 'X-Real-IP': '104.16.0.9', 'CF-Connecting-IP': `198.51.100.${i + 70}` }));
		assert.deepEqual(worker, { statuses: LIMITED, keys: ['104.16.0.9'] });
		// The same request at the site's own domain still uses CF-Connecting-IP (check 16a).
		assert.equal((await ipOf(server.port, { Host: OWN, 'X-Real-IP': '104.16.0.9', 'CF-Connecting-IP': '198.51.100.70' })).ip, '198.51.100.70');
		server.stop();
	});

	test('the hosts’ own addresses, by Host: Fly, Render, localhost, bare IPs, and a missing Host, keep the Cloudflare address', () => {
		const req = (host: string | undefined) => ({ headers: { host, 'fly-client-ip': '172.64.0.5', 'cf-connecting-ip': '198.51.100.80' }, socket: { remoteAddress: '10.0.0.1' } });
		for (const host of ['x.fly.dev', 'X.FLY.DEV.', 'x.onrender.com', 'x.up.railway.app:443', 'localhost:8080', '203.0.113.5', '[2001:db8::5]:443', '', undefined, 'bad host'])
			assert.equal(resolveClientIp(req(host), 'fly-client-ip').ip, '172.64.0.5', String(host));
		for (const host of ['www.example.com', 'example.com:443', 'myfly.dev']) assert.equal(resolveClientIp(req(host), 'fly-client-ip').ip, '198.51.100.80', host);
		assert.ok(isPlatformHost('a.b.fly.dev') && !isPlatformHost('example.com'));
	});

	test('a Cloudflare address with no usable CF-Connecting-IP stays the Cloudflare address', () => {
		const req = (headers: Record<string, string>, remoteAddress = '10.0.0.1') => ({ headers: { host: 'www.example.com', ...headers }, socket: { remoteAddress } });
		assert.equal(resolveClientIp(req({ 'x-real-ip': '162.158.1.1' }), 'x-real-ip').ip, '162.158.1.1');
		assert.equal(resolveClientIp(req({ 'x-real-ip': '162.158.1.1', 'cf-connecting-ip': 'nonsense' }), 'x-real-ip').ip, '162.158.1.1');
		// The socket, and X-Forwarded-For's last entry, follow the same rule.
		assert.equal(resolveClientIp(req({ 'cf-connecting-ip': '198.51.100.60' }, '::ffff:172.64.1.1'), 'socket').ip, '198.51.100.60');
		assert.equal(resolveClientIp(req({ 'x-forwarded-for': '203.0.113.1, 131.0.72.9', 'cf-connecting-ip': '198.51.100.61' }), 'x-forwarded-for').ip, '198.51.100.61');
		// Just outside a range: not Cloudflare's.
		assert.equal(resolveClientIp(req({ 'x-real-ip': '173.245.64.1', 'cf-connecting-ip': '198.51.100.62' }), 'x-real-ip').ip, '173.245.64.1');
	});

	test('the ranges: edges of v4 and v6 ranges, mapped and bracketed forms', () => {
		for (const ip of ['173.245.48.0', '173.245.63.255', '104.16.0.1', '104.23.255.255', '131.0.75.255', '2400:cb00::1', '2a06:98c7:ffff::1', '2c0f:f248:0:0:0:0:0:1'])
			assert.ok(isCloudflareIp(ip), ip);
		for (const ip of ['173.245.47.255', '173.245.64.0', '104.32.0.0', '131.0.76.0', '2400:cb01::1', '2a06:98c8::1', '127.0.0.1', '::1', '2001:db8::1'])
			assert.ok(!isCloudflareIp(ip), ip);
		assert.equal(normaliseIp('::FFFF:162.158.0.1'), '162.158.0.1');
		assert.equal(normaliseIp('[2606:4700::1]:443'), '2606:4700::1');
		assert.equal(normaliseIp(' 198.51.100.1:8080 '), '198.51.100.1');
		assert.equal(normaliseIp('example.com'), null);
	});
});

describe('never indexable: hosts’ own addresses and bare IPs, whatever SITE_URL says (Acceptance 28)', () => {
	for (const [url, host] of [
		['https://x.onrender.com', 'x.onrender.com'],
		['https://x.fly.dev', 'x.fly.dev'],
		['https://203.0.113.5', '203.0.113.5'],
		['https://[2001:db8::5]', '[2001:db8::5]'],
		['https://X.Fly.Dev.', 'x.fly.dev.'],
	] as const) {
		test(`SITE_URL=${url}: robots closed and noindex, on that very host`, async () => {
			const server = await startServer(site('CaraCMS'), { SITE_URL: url });
			assert.match(server.log(), /indexing: never indexable/);
			const robots = await ask(server.port, '/robots.txt', { host });
			assert.equal(robots.body, 'User-agent: *\nDisallow: /\n');
			assert.equal(robots.headers['x-robots-tag'], 'noindex');
			assert.equal((await ask(server.port, '/', { host })).headers['x-robots-tag'], 'noindex');
			server.stop();
		});
	}

	test('the rule itself: platform domains and IPs are never indexable; look-alikes are', () => {
		for (const name of ['localhost', 'a.localhost', 'x.up.railway.app', 'x.onrender.com', 'onrender.com', 'a.b.fly.dev', 'x.fly.dev.', '10.0.0.1', '[::1]', '[2001:db8::5]'])
			assert.ok(isNeverIndexableHostname(name), name);
		for (const name of ['example.com', 'notonrender.com', 'fly.dev.example.com', 'myfly.dev', 'www.example.com']) assert.ok(!isNeverIndexableHostname(name), name);
		assert.equal(parseSiteUrl('https://203.0.113.5')?.indexable, false);
		assert.equal(parseSiteUrl('https://example.com')?.indexable, true);
	});

	test('the address chain: SITE_URL, then RAILWAY_PUBLIC_DOMAIN', async () => {
		assert.deepEqual(publicAddress({ SITE_URL: ' https://example.com ', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }), { value: 'https://example.com', from: 'SITE_URL' });
		assert.deepEqual(publicAddress({ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }), { value: 'https://x.up.railway.app', from: 'RAILWAY_PUBLIC_DOMAIN' });
		assert.equal(publicAddress({ SITE_URL: '  ' }), null);
		const server = await startServer(site('CaraCMS'), { SITE_URL: 'https://site.test' });
		assert.match(server.log(), /indexing: indexable on site\.test only \(SITE_URL\)/);
		server.stop();
	});

	test("Decision 7's whole chain: Astro's site as built (caracms-build.json) comes first", () => {
		const env = { SITE_URL: 'https://www.example.com', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' };
		assert.deepEqual(publicAddress(env, { site: 'https://example.com' }), { value: 'https://example.com', from: "Astro's site" });
		assert.deepEqual(publicAddress({}, { site: ' https://example.com ' }), { value: 'https://example.com', from: "Astro's site" });
		// No site in the build, or one that isn't an http(s) URL: the rest of the chain.
		for (const built of [null, undefined, { site: null }, { site: '' }, { site: 'example.com' }, { site: 'ftp://example.com' }, { site: 42 as never }])
			assert.deepEqual(publicAddress(env, built), { value: 'https://www.example.com', from: 'SITE_URL' }, JSON.stringify(built));
		assert.deepEqual(publicAddress({ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }, { site: null }), { value: 'https://x.up.railway.app', from: 'RAILWAY_PUBLIC_DOMAIN' });
	});

	test('readBuildInfo: the file beside the entry, or null when it is missing, unreadable or not an object', () => {
		const root = site('CaraCMS');
		const file = join(root, 'dist/server/caracms-build.json');
		assert.equal(readBuildInfo(root), null, 'missing');
		writeFileSync(file, '{"site":"https://example.com","commit":"abc123"}\n');
		assert.deepEqual(readBuildInfo(root), { site: 'https://example.com', commit: 'abc123' });
		writeFileSync(file, '{"site":null,"commit":null}');
		assert.deepEqual(readBuildInfo(root), { site: null, commit: null });
		writeFileSync(file, '{"site":7}');
		assert.deepEqual(readBuildInfo(root), { site: null, commit: null });
		for (const text of ['{"site":', '', 'null', '[]', '"https://example.com"']) {
			writeFileSync(file, text);
			assert.equal(readBuildInfo(root), null, JSON.stringify(text));
		}
		rmSync(file);
		mkdirSync(file);
		assert.equal(readBuildInfo(root), null, 'a directory where the file should be');
	});

	test("caracms start: indexing follows Astro's site as built, over SITE_URL; a broken file falls back to SITE_URL", async () => {
		const built = site('CaraCMS');
		writeFileSync(join(built, 'dist/server/caracms-build.json'), '{"site":"https://site.test","commit":null}\n');
		const server = await startServer(built, { SITE_URL: 'https://www.site.test' });
		assert.match(server.log(), /indexing: indexable on site\.test only \(Astro's site\)/);
		assert.match((await ask(server.port, '/robots.txt', { host: 'site.test' })).body, /Sitemap: https:\/\/site\.test\/sitemap\.xml/);
		assert.equal((await ask(server.port, '/', { host: 'www.site.test' })).headers['x-robots-tag'], 'noindex');
		server.stop();

		const onlyBuild = site('CaraCMS');
		writeFileSync(join(onlyBuild, 'dist/server/caracms-build.json'), '{"site":"https://site.test","commit":null}');
		const fromBuild = await startServer(onlyBuild, {});
		assert.match(fromBuild.log(), /indexing: indexable on site\.test only \(Astro's site\)/);
		fromBuild.stop();

		const broken = site('CaraCMS');
		writeFileSync(join(broken, 'dist/server/caracms-build.json'), '{"site": "https://exam');
		const fallback = await startServer(broken, { SITE_URL: 'https://www.site.test' });
		assert.match(fallback.log(), /indexing: indexable on www\.site\.test only \(SITE_URL\)/);
		fallback.stop();

		const platform = site('CaraCMS');
		writeFileSync(join(platform, 'dist/server/caracms-build.json'), '{"site":"https://x.up.railway.app","commit":null}');
		const never = await startServer(platform, { SITE_URL: 'https://site.test' });
		assert.match(never.log(), /indexing: never indexable \(the address, from Astro's site, is localhost, a host's own address or a bare IP\)/);
		never.stop();
	});
});

describe('caracms start: a page beside a folder, and Site Settings\' redirects (on a built site)', () => {
	/** A built site whose dist/client has `services/advisory.html` beside `services/advisory/`, and `studio/` with its own index.html beside `studio.html`. */
	function builtSite(redirects: unknown) {
		const root = site();
		for (const file of ['services/advisory.html', 'services/advisory/rent-reviews.html', 'studio.html', 'studio/index.html']) {
			mkdirSync(join(root, 'dist/client', file, '..'), { recursive: true });
			writeFileSync(join(root, 'dist/client', file), file);
		}
		mkdirSync(join(root, 'content'), { recursive: true });
		writeFileSync(join(root, 'content/site-settings.json'), JSON.stringify({ title: 'Site Settings', redirects }));
		return root;
	}

	test('a page whose address is also a folder is served from its .html file, query kept; a folder with its own index.html is left to the adapter', async () => {
		const server = await startServer(builtSite([]), {});
		const page = await ask(server.port, '/services/advisory?from=menu');
		assert.equal(page.status, 200);
		assert.equal(page.body, 'html /services/advisory.html');
		assert.equal((await ask(server.port, '/services/advisory/rent-reviews.html')).body, 'html /services/advisory/rent-reviews.html');
		// The stub answers 404 for anything else, as the adapter does for these.
		assert.equal((await ask(server.port, '/studio')).status, 404, 'its index.html is the adapter\'s to find');
		assert.equal((await ask(server.port, '/services/advisory/')).status, 404, 'a trailing slash is the adapter\'s');
		assert.equal((await ask(server.port, '/services/../services/advisory')).body, 'html /services/../services/advisory.html', 'dot segments are left in the target as sent');
		assert.equal((await ask(server.port, '/services/advisory', { method: 'POST' })).status, 404, 'only GET and HEAD');
		server.stop();
	});

	test('a request that would be a 404 is a 301 to its redirect, query kept, however the 404 is written; a real page wins; the editor and POST are never redirected', async () => {
		const server = await startServer(
			builtSite([
				{ from: '/advisory', to: '/services/advisory' },
				{ from: '/gone-implicit', to: '/contact' },
				{ from: '/contact', to: '/elsewhere' },
				{ from: '/admin/old', to: '/contact' },
				{ from: '/caf\u00e9', to: '/contact' },
			]),
			{},
		);
		const moved = await ask(server.port, '/advisory?utm=x');
		assert.equal(moved.status, 301);
		assert.equal(moved.headers.location, '/services/advisory?utm=x');
		assert.equal(moved.headers['x-robots-tag'], 'noindex', 'the held header stays');
		assert.equal(moved.body, '');
		assert.equal((await ask(server.port, '/advisory/')).headers.location, '/services/advisory', 'matched without a trailing slash');
		assert.equal((await ask(server.port, '/gone-implicit')).headers.location, '/contact', 'an implicit-head 404 too');
		assert.equal((await ask(server.port, '/caf%C3%A9')).headers.location, '/contact', 'matched decoded');
		assert.equal((await ask(server.port, '/contact')).status, 200, 'a real page wins over a redirect from its address');
		assert.equal((await ask(server.port, '/Advisory')).status, 404, 'letter case counts');
		assert.equal((await ask(server.port, '/admin/old')).status, 404, 'the editor is never redirected');
		assert.equal((await ask(server.port, '/advisory', { method: 'POST' })).status, 404, 'only GET and HEAD');
		const head = await ask(server.port, '/advisory', { method: 'HEAD' });
		assert.equal(head.status, 301);
		server.stop();
	});

	test('with no Site Settings, or no redirects in it, a 404 stays a 404', async () => {
		const none = await startServer(site(), {});
		assert.equal((await ask(none.port, '/advisory')).status, 404);
		none.stop();
	});

	test("the gate reads redirects as the package does (src/redirects.ts)", () => {
		const raw = [{ from: '/a/', to: '/b' }, { from: 'a', to: '/b' }, { from: '/c', to: '/c' }, { from: '/A', to: '/d' }, { from: '/a', to: '/e' }, null, { from: '/e', to: 'https://x.test' }, { from: '/caf\u00e9', to: '/f' }, { from: ' /g ', to: '/h//' }];
		assert.deepEqual(gateParseRedirects(raw), parseRedirects(raw));
		assert.deepEqual(gateParseRedirects('nope'), parseRedirects('nope'));
		const list = parseRedirects(raw);
		for (const path of ['/a', '/a/', '/A', '/caf%C3%A9', '/caf%C3%A9/', '/cafe', '/%E0%A4%A', '/g', '/', '/nope']) {
			assert.equal(gateRedirectFor(list, path), redirectFor(list, path), path);
		}
	});
});

describe('a moved held document on a built site (collections under pages, check 15)', () => {
	/** Work holds the case studies; moving it to /studio is the real engine's, and its Site Settings are what the gate reads. */
	async function movedSettings(): Promise<string> {
		const s = makeHolderSite();
		try {
			const origin = 'http://site.test';
			const body = JSON.stringify({ collection: 'pages', path: 'work', to: 'studio' });
			const res = await handleMove(new Request(`${origin}/_caracms/move`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body }), localDraftsStore(s.site));
			assert.equal(res.status, 200, await res.text());
			return readFileSync(join(s.root, SITE_SETTINGS_FILE), 'utf8');
		} finally {
			s.cleanup();
		}
	}
	const OLD = ['/work', '/work/kiln', '/work/high-street-coffee', '/work/tiny'];

	function built(settings: string, files: string[]) {
		const root = site();
		for (const file of files) {
			mkdirSync(join(root, 'dist/client', file, '..'), { recursive: true });
			writeFileSync(join(root, 'dist/client', file), file);
		}
		mkdirSync(join(root, SITE_SETTINGS_FILE, '..'), { recursive: true });
		writeFileSync(join(root, SITE_SETTINGS_FILE), settings);
		return root;
	}

	test('build.format "file": the holder comes from its .html file beside its folder and every old address (the holder and each document) answers 301 to the new one, query kept', async () => {
		const settings = await movedSettings();
		const server = await startServer(built(settings, ['studio.html', 'studio/kiln.html', 'studio/high-street-coffee.html', 'studio/tiny.html']), {});
		for (const [from, to] of [['/work', '/studio'], ['/work/kiln', '/studio/kiln'], ['/work/high-street-coffee', '/studio/high-street-coffee'], ['/work/tiny', '/studio/tiny']] as const) {
			const old = await ask(server.port, `${from}?from=menu`);
			assert.equal(old.status, 301, from);
			assert.equal(old.headers.location, `${to}?from=menu`, from);
			// The new address is never redirected: the holder (a page beside its folder) is the gate's to serve from its .html file; a document with no folder is the adapter's.
			const now = await ask(server.port, to);
			assert.notEqual(now.status, 301, `${to} isn't redirected`);
			if (to === '/studio') assert.equal(now.body, 'html /studio.html');
			assert.equal((await ask(server.port, `${to}.html`)).status, 200, `${to}.html is in the build`);
		}
		server.stop();
	});

	test('build.format "directory": the old addresses have no file, so they answer 301 as well', async () => {
		const settings = await movedSettings();
		const server = await startServer(built(settings, ['studio/index.html', 'studio/kiln/index.html', 'studio/high-street-coffee/index.html', 'studio/tiny/index.html']), {});
		for (const from of OLD) {
			const old = await ask(server.port, from);
			assert.equal(old.status, 301, from);
			assert.equal(old.headers.location, from.replace('/work', '/studio'));
		}
		server.stop();
	});
});
