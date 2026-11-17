// M4 Decision 1, for real: the demo's production server (`node dist/server/entry.mjs`)
// with no App variables is an unconfigured live-mode server. The public site is
// served; /admin and every /_caracms/ route answer 503 with the sentence naming
// what's missing (logged), and nothing is written. Started without `caracms start`, it has no
// gate, so the form endpoint and /files answer 503 saying to start it with `caracms start`
// (runs-anywhere Decision 8, acceptance check 17). build-output.test.ts reads the
// built files; this asks the running server. Needs `pnpm build` first; without
// starter/dist it skips.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const starter = fileURLToPath(new URL('../../../starter', import.meta.url));
const entry = join(starter, 'dist/server/entry.mjs');
const skip = existsSync(entry) ? false : 'starter/dist is missing: run `pnpm build` first';

// A document that doesn't exist: if a write got through it would answer 404 and write nothing,
// so this test can never touch the demo's content.
const PROBE = 'content/pages/no-such-page.json';

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});

const SENTENCE = /The editor isn't set up on this server yet: it needs CARACMS_CLOUD_KEY \(or CARACMS_GITHUB_TOKEN, or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY\), GITHUB_REPO, CARACMS_SECRET, REDIS_URL\./;
const NO_GATE = /This site wasn't started with `caracms start`/;

describe('the production server with no App variables', { skip }, () => {
	let child: ChildProcess;
	let origin: string;
	let log = '';
	const home = join(starter, 'content/pages/index.json');
	const homeBefore = readFileSync(home, 'utf8');

	before(async () => {
		const port = await freePort();
		origin = `http://127.0.0.1:${port}`;
		const env: NodeJS.ProcessEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(port) };
		for (const name of Object.keys(env)) {
			if (/^(GITHUB_|CARACMS_|RAILWAY_|REDIS_URL$)/.test(name)) delete env[name];
		}
		child = spawn(process.execPath, [entry], { cwd: starter, env, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout!.on('data', (d) => (log += d));
		child.stderr!.on('data', (d) => (log += d));
		const end = Date.now() + 15000;
		while (Date.now() < end) {
			if (child.exitCode !== null) throw new Error(`the server exited (${child.exitCode}):\n${log}`);
			try {
				if ((await fetch(origin + '/')).ok) return;
			} catch {}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`the server didn't start:\n${log}`);
	});
	after(() => child?.kill());

	test('the public site is served: Home and a nested page', async () => {
		const res = await fetch(origin + '/');
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /<h1/);
		// M6 Decision 16: the demo's Google tag (Site Settings, head.ts's gtag.js snippet) may be on a page.
		// M7 Decision 20: so are the starter's own bundled module scripts from /_astro/ (motion setup, menu): each
		// must be served, and none may be the editor's, carry React or carry editor markers.
		const scriptSrcs = [...html.matchAll(/<script type="module" src="(\/_astro\/[^"?#]+\.m?js)"><\/script>/g)].map((m) => m[1]!);
		assert.ok(scriptSrcs.length >= 1, 'Home loads the site\'s own script');
		for (const src of scriptSrcs) {
			assert.doesNotMatch(src, /admin/, `${src} is the editor's entry`);
			const js = await fetch(origin + src);
			assert.equal(js.status, 200, src);
			const code = await js.text();
			assert.doesNotMatch(code, /data-cms-|caracms-props|contenteditable/i, `${src} has editor code`);
			assert.doesNotMatch(code, /\breact(-dom)?\b|__SECRET_INTERNALS|jsx-runtime/i, `${src} has React`);
		}
		const page = html
			.replace(/<script type="module" src="\/_astro\/[^"?#]+\.m?js"><\/script>/g, '')
			.replace(/<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+"><\/script><script>window\.dataLayer=[^<]*<\/script>/g, '');
		assert.doesNotMatch(page, /<script|data-cms-(?!fixed\b)|contenteditable/i);
		assert.equal((await fetch(origin + '/services/branding')).status, 200);
		assert.equal((await fetch(origin + '/services')).status, 404, 'a folder with no page of its own has no page');
	});

	test('/admin, in every address form, is a 503 with the sentence, and no editor', async () => {
		for (const path of ['/admin', '/admin/', '/admin/pages/index', '/admin/pages/services/branding', '/admin/journal/notes-from-the-ridge']) {
			const res = await fetch(origin + path, { redirect: 'manual' });
			assert.equal(res.status, 503, path);
			const html = await res.text();
			assert.match(html, SENTENCE, path);
			assert.doesNotMatch(html, /id="bar"|id="side"|caracms-props/, `${path} rendered the editor`);
		}
	});

	test('every /_caracms/ route is a 503 for every method, with the sentence', async () => {
		for (const path of ['/_caracms/preview?collection=pages&path=index', '/_caracms/document?collection=pages&path=index', '/_caracms/documents', '/_caracms/write', '/_caracms/create', '/_caracms/delete', '/_caracms/status', '/_caracms/lock', '/_caracms/publish', '/_caracms/history', '/_caracms/try-again', '/_caracms/notice', '/_caracms/github']) {
			for (const method of ['GET', 'POST', 'PUT']) {
				const res = await fetch(origin + path, {
					method,
					headers: { 'content-type': 'application/json', origin },
					body: method === 'GET' ? undefined : JSON.stringify({ file: PROBE, base: '{}', document: { title: 'Hacked', blocks: [] } }),
				});
				assert.equal(res.status, 503, `${method} ${path}`);
				const body = (await res.json()) as { error: string; code: string };
				assert.equal(body.code, 'unconfigured');
				assert.match(body.error, SENTENCE);
			}
		}
	});

	test('check 17: without caracms start, the form endpoint and /files answer 503 saying so; the public pages serve', async () => {
		// The form endpoint is let through the unconfigured 503 (M6 Decision 5), and stops at the missing gate.
		const res = await fetch(origin + '/_caracms/form', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
			body: new URLSearchParams({ form: 'contact', fax: 'a bot', name: 'Test', email: 'test@example.com' }).toString(),
		});
		assert.equal(res.status, 503);
		assert.match(((await res.json()) as { error: string }).error, NO_GATE);
		const file = await fetch(origin + '/files/0123456789ab/rulebook.pdf');
		assert.equal(file.status, 503);
		assert.match(await file.text(), NO_GATE);
		assert.equal((await fetch(origin + '/')).status, 200);
	});

	test('only a POST to the form endpoint is let through: any other method is the same 503 as every other route', async () => {
		for (const method of ['GET', 'PUT']) {
			const res = await fetch(origin + '/_caracms/form', { method, headers: { 'content-type': 'application/json', origin }, body: method === 'GET' ? undefined : '{}' });
			assert.equal(res.status, 503, method);
			const body = (await res.json()) as { error: string; code: string };
			assert.equal(body.code, 'unconfigured');
			assert.match(body.error, SENTENCE);
		}
	});

	test('the missing variables are in the server log, once', () => {
		const lines = log.split('\n').filter((l) => SENTENCE.test(l));
		assert.equal(lines.length, 1, log);
	});

	test('nothing was written to the content', () => {
		assert.equal(readFileSync(home, 'utf8'), homeBefore);
		assert.equal(existsSync(join(starter, PROBE)), false);
	});
});
