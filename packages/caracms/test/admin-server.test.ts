// The editor's server side, without a browser, on a throwaway copy of the demo under
// `astro dev` (helpers/dev-site.ts):
//   Decision 19  every document has an address; /admin opens Home; an unknown address is a 404
//   Decision 20  junk in the sidebar cookie never breaks the server render
//   Decision 9   a list-of-fields collection stops the dev server with the M5 sentence
//   Decision 11  a phone-lines width of 375 or 769 stops the dev server
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { startDevSite, type DevSite } from './helpers/dev-site.ts';

const UI_COOKIE = 'caracms-ui';
const enc = (value: unknown) => `${UI_COOKIE}=${encodeURIComponent(JSON.stringify(value))}`;

describe('the editor\'s addresses and cookie, served', () => {
	let site: DevSite;
	before(async () => {
		site = await startDevSite('admin-server');
		// Once, in a full parallel run, the dev server closed itself under the very first request
		// (Vite: "transport was disconnected"; never seen in 5 more runs). A real browser would
		// just be shown an error and retried, so warm the server up and restart it if it's gone.
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				if ((await fetch(`${site.origin}/admin`)).status === 200) break;
			} catch {
				await site.stop();
				await site.start();
			}
		}
	});
	after(() => site?.close());

	const get = (path: string, cookie?: string) => fetch(site.origin + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

	/** The chrome the server renders before any script (Decision 2). */
	function assertChrome(html: string, title = 'Home') {
		assert.match(html, /<footer class="bar" id="bar"/);
		assert.match(html, /<aside class="side" id="side"/);
		assert.match(html, /<main class="stage unpainted" id="stage"/);
		assert.match(html, new RegExp(`<title>${title} · CaraCMS</title>`));
	}

	describe('Decision 19: addresses', () => {
		test('/admin opens Home, and so does /admin/pages/index', async () => {
			const home = await get('/admin');
			assert.equal(home.status, 200);
			assertChrome(await home.text());
			const same = await get('/admin/pages/index');
			assert.equal(same.status, 200);
			assertChrome(await same.text());
		});

		test('a trailing slash on /admin still opens Home', async () => {
			const res = await get('/admin/');
			assert.equal(res.status, 200);
			assertChrome(await res.text());
		});

		test('/admin/<collection>/<path> opens that document, at any depth', async () => {
			for (const [path, title] of [
				['/admin/pages/about', 'About'],
				['/admin/pages/about/team', 'Team'],
				['/admin/pages/services/branding', 'Branding'],
			] as const) {
				const res = await get(path);
				assert.equal(res.status, 200, path);
				assertChrome(await res.text(), title);
			}
			const post = (await (await get('/admin/journal/notes-from-the-ridge')).text()).match(/<title>(.*?)<\/title>/)![1];
			assert.match(post!, / · CaraCMS$/);
			assert.doesNotMatch(post!, /^Home/);
		});

		test('an unknown address is a 404, not a 500 and not Home', async () => {
			const addresses = [
				'/admin/pages/nope',
				'/admin/pages/services/nope',
				'/admin/nope/index',
				'/admin/journal',
				'/admin/pages',
				'/admin/pages/',
				'/admin/pages/services', // a folder with no page of its own
				'/admin/pages/about/team/extra',
				'/admin/pages/index.json',
				'/admin/pages/%00',
				'/admin/pages/..%2f..%2fpackage',
				'/admin/__proto__/x',
				'/admin/constructor/prototype',
			];
			for (const path of addresses) {
				const res = await get(path);
				assert.ok(res.status === 404 || res.status === 400, `${path} → ${res.status}`);
				assert.doesNotMatch(await res.text(), /<aside class="side" id="side"/, `${path} rendered the editor`);
			}
		});

		test('a file that can\'t be opened has an address and no editor: 400 (a nested index.json, invalid JSON)', async () => {
			site.write('content/pages/broken.json', '{ not json');
			assert.equal((await get('/admin/pages/broken')).status, 400);
			site.write('content/pages/services/index.json', JSON.stringify({ title: 'Nested', blocks: [] }));
			assert.equal((await get('/admin/pages/services/index')).status, 400);
		});
	});

	describe('Decision 20: junk in the sidebar cookie', () => {
		const junk: [string, string][] = [
			['empty', `${UI_COOKIE}=`],
			['not JSON', `${UI_COOKIE}=hello`],
			['half a JSON object', `${UI_COOKIE}=${encodeURIComponent('{"open":{"pages:services":tru')}`],
			['a broken percent-escape', `${UI_COOKIE}=%E0%A4%A`],
			['unencoded JSON', `${UI_COOKIE}={"open":{},"recent":[]}`],
			['JSON null', enc(null)],
			['a number', enc(42)],
			['a string', enc('open')],
			['an array', enc([1, 2, 3])],
			['open and recent of the wrong types', enc({ open: 'yes', recent: 'pages/index' })],
			['open values that aren\'t booleans', enc({ open: { 'pages:services': 'yes', 'pages:about': 1, x: null }, recent: [] })],
			['recent holding junk', enc({ open: {}, recent: [1, null, {}, [], 'pages/gone', 'journal/gone', 'nope/x', '', '../../etc/passwd'] })],
			['prototype keys', enc({ open: { __proto__: true, constructor: true, 'pages:__proto__': true }, recent: ['__proto__/x'] })],
			['a very long value', `${UI_COOKIE}=${'a'.repeat(4000)}`],
			['a huge recent list', enc({ open: {}, recent: Array.from({ length: 500 }, (_, i) => `pages/p${i}`) })],
			['control characters', `${UI_COOKIE}=%00%01%02`],
			['the cookie twice, the second one junk', `${enc({ open: { 'pages:services': true }, recent: [] })}; ${UI_COOKIE}=%%%`],
			['junk beside other cookies', `a=b; ${UI_COOKIE}=%7Bnope; c=d`],
		];
		for (const [name, cookie] of junk) {
			test(`${name}: the page still renders, 200, with the chrome`, async () => {
				const res = await get('/admin', cookie);
				assert.equal(res.status, 200);
				const html = await res.text();
				assertChrome(html);
				assert.match(html, /aria-label="Blocks on Home"/, 'Home opens');
				if (!name.startsWith('the cookie twice')) {
					// Groups default to closed with no cookie to say otherwise.
					assert.match(html, /data-group="pages:services" aria-expanded="false"/);
					assert.doesNotMatch(html, /data-doc="pages\/services\/branding"/);
				}
			});
		}

		test('junk on a document address too, and a group holding the open document still starts open', async () => {
			const res = await get('/admin/pages/services/branding', `${UI_COOKIE}=%7Bnope`);
			assert.equal(res.status, 200);
			const html = await res.text();
			assertChrome(html, 'Branding');
			assert.match(html, /data-group="pages:services" aria-expanded="true"/);
		});

		test('a good cookie is read as it says, and Recent names only documents that exist', async () => {
			const html = await (await get('/admin', enc({ open: { 'pages:services': true }, recent: ['pages/about', 'pages/gone'] }))).text();
			assert.match(html, /data-group="pages:services" aria-expanded="true"/);
			assert.match(html, /data-doc="pages\/services\/branding"/);
			const chips = [...html.matchAll(/<button[^>]*class="rchip[^"]*"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, ''));
			// The open document (Home) joins Recent; the one that's gone doesn't get a chip.
			assert.deepEqual([...new Set(chips)].sort(), ['About', 'Home']);
		});
	});
});

describe('a bad site config stops the dev server with a plain sentence', () => {
	// startDevSite throws before it can hand back its copy, so remove them here.
	after(() => {
		const tmp = fileURLToPath(new URL('.tmp/', import.meta.url));
		for (const name of readdirSync(tmp)) if (name.startsWith('config-') && name.endsWith(`-${process.pid}`)) rmSync(join(tmp, name), { recursive: true, force: true });
	});
	const config = (patch: (text: string) => string) => ({ edit: (root: string) => void editConfig(root, patch) });

	test('M5a Decision 8: a site collection named "shared" is refused (the package reserves it)', async () => {
		await assert.rejects(
			startDevSite('config-reserved', {
				edit: (root) =>
					editConfig(root, (text) =>
						text.replace("journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: journalFields },", "journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: journalFields },\n\t\tshared: { kind: 'sections', folder: 'content/other', urlBase: '/other/' },"),
					),
			}),
			/package's own collections/,
		);
	});

	for (const width of [375, 769]) {
		test(`Decision 11: a phone-lines width of ${width} is refused: above 375 and at most 768`, async () => {
			await assert.rejects(
				startDevSite(`config-width-${width}`, config((text) => text.replace('phoneLinesWidth: 640', `phoneLinesWidth: ${width}`))),
				/above 375 and at most 768/,
			);
		});
	}
});

function editConfig(root: string, patch: (text: string) => string) {
	const file = join(root, 'caracms.config.ts');
	const before = readFileSync(file, 'utf8');
	const after = patch(before);
	assert.notEqual(after, before, 'the config edit changed nothing');
	writeFileSync(file, after);
}
