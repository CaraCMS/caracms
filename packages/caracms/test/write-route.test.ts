// The write route (Decision 5: M3's security boundary; Phase 2 → Verify 6), on a
// throwaway copy of the fixture site's content.
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ResolvedSite } from '../src/config.ts';
import { parseDocumentText } from '../src/document.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { confineDocumentFile, handleWrite, WriteRefused } from '../src/editor/server/write.ts';
import { applyEdits } from '../src/serialize.ts';
import { site as fixtureSite, siteRoot } from './helpers/site.ts';

let tmp: string;
let root: string;
let outside: string;
let site: ResolvedSite;
let store: ReturnType<typeof localDraftsStore>;

before(() => {
	tmp = mkdtempSync(join(tmpdir(), 'caracms-write-'));
	root = join(tmp, 'site');
	outside = join(tmp, 'outside');
	cpSync(join(siteRoot, 'content'), join(root, 'content'), { recursive: true });
	mkdirSync(join(root, 'content/other'), { recursive: true });
	writeFileSync(join(root, 'content/other/x.json'), '{ "title": "Other", "blocks": [] }\n');
	writeFileSync(join(root, 'content/pages/notes.txt'), 'not a document\n');
	writeFileSync(join(root, 'content/pages/.hidden.json'), '{ "title": "Hidden", "blocks": [] }\n');
	mkdirSync(outside);
	writeFileSync(join(outside, 'secret.json'), '{ "title": "Secret", "blocks": [] }\n');
	writeFileSync(join(root, 'outside-root.json'), '{ "title": "Root", "blocks": [] }\n');
	// A folder link and a file link inside the Pages folder, both pointing outside it.
	symlinkSync(outside, join(root, 'content/pages/linked'));
	symlinkSync(join(outside, 'secret.json'), join(root, 'content/pages/secret.json'));
	site = {
		...fixtureSite,
		root,
		collections: Object.fromEntries(
			Object.entries(fixtureSite.collections).map(([name, c]) => [name, { ...c, dir: join(root, c.folder) }]),
		),
	};
	store = localDraftsStore(site);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const read = (file: string) => readFileSync(join(root, file), 'utf8');

function post(body: unknown, init: { headers?: Record<string, string>; method?: string; raw?: string } = {}) {
	return handleWrite(
		new Request('http://localhost:4326/_caracms/write', {
			method: init.method ?? 'POST',
			headers: { 'content-type': 'application/json', ...init.headers },
			body: (init.method ?? 'POST') === 'GET' ? undefined : (init.raw ?? JSON.stringify(body)),
		}),
		store,
	);
}

/** A request that changes Home's hero intro, against the file as read now. */
function homeEdit(intro = 'Hello there') {
	const base = read('content/pages/index.json');
	const { document } = parseDocumentText(base, site);
	document.blocks[0]!.data.intro = intro;
	return { file: 'content/pages/index.json', base, document };
}

async function refused(response: Response, status: number, pattern?: RegExp) {
	assert.equal(response.status, status);
	const body = (await response.json()) as { error: string };
	assert.equal(typeof body.error, 'string');
	if (pattern) assert.match(body.error, pattern);
}

describe('the write route writes', () => {
	test('a one-field edit lands on disk with Decision 7\'s formatting', async () => {
		const request = homeEdit('Hello there');
		const response = await post(request);
		assert.equal(response.status, 200);
		const body = (await response.json()) as { ok: boolean; changed: boolean; mtimeMs: number; file: string };
		assert.deepEqual({ ok: body.ok, changed: body.changed, file: body.file }, { ok: true, changed: true, file: 'content/pages/index.json' });
		assert.equal(body.mtimeMs, statSync(join(root, 'content/pages/index.json')).mtimeMs);
		const text = read('content/pages/index.json');
		assert.equal(text, applyEdits(request.base, request.document, site));
		assert.match(text, /"heading": \["Building a better mousetrap", "For You"\],\n {6}"intro": "Hello there"\n/);
		assert.ok(text.endsWith('}\n'));
	});

	test('the same base and document again writes nothing (changed: false)', async () => {
		const first = homeEdit('Twice');
		await post(first);
		const before = statSync(join(root, 'content/pages/index.json')).mtimeMs;
		const again = await post(first);
		assert.equal(again.status, 200);
		assert.equal(((await again.json()) as { changed: boolean }).changed, false);
		assert.equal(statSync(join(root, 'content/pages/index.json')).mtimeMs, before);
	});

	test('atomically: no temp file is left behind, and the file\'s mode is kept', async () => {
		const file = join(root, 'content/journal/apples.json');
		const mode = statSync(file).mode;
		const base = read('content/journal/apples.json');
		const { document } = parseDocumentText(base, site);
		document.title = 'Pears';
		assert.equal((await post({ file: 'content/journal/apples.json', base, document })).status, 200);
		assert.match(read('content/journal/apples.json'), /"title": "Pears"/);
		assert.equal(statSync(file).mode, mode);
		assert.deepEqual(readdirSync(join(root, 'content/journal')).filter((n) => n.endsWith('.tmp')), []);
		assert.deepEqual(readdirSync(join(root, 'content/pages')).filter((n) => n.endsWith('.tmp')), []);
	});

	test('a nested page', async () => {
		const base = read('content/pages/services/branding.json');
		const { document } = parseDocumentText(base, site);
		document.title = 'Brand work';
		assert.equal((await post({ file: 'content/pages/services/branding.json', base, document })).status, 200);
		assert.match(read('content/pages/services/branding.json'), /"title": "Brand work"/);
	});
});

describe('the write route refuses (400)', () => {
	const doc = () => homeEdit();
	const cases: [string, string, RegExp][] = [
		['../ out of the site', '../outside/secret.json', /\.\./],
		['../ out of a collection', 'content/pages/../../outside-root.json', /\.\./],
		['a ./ segment', 'content/pages/./about.json', /\.\./],
		['an absolute path', join(root ?? '/', 'content/pages/about.json'), /absolute/],
		['an absolute system path', '/etc/passwd', /absolute/],
		['a Windows drive path', 'C:/site/content/pages/about.json', /absolute/],
		['a backslash', 'content\\pages\\about.json', /isn't a document path/],
		['a NUL byte', 'content/pages/about.json\0.txt', /isn't a document path/],
		['a folder no collection declares', 'content/other/x.json', /isn't in a folder any collection declares/],
		['a file at the site root', 'outside-root.json', /isn't in a folder any collection declares/],
		['a target that isn\'t .json', 'content/pages/notes.txt', /isn't a \.json document/],
		['a dot-file', 'content/pages/.hidden.json', /isn't a document path/],
		['a nested index.json', 'content/pages/services/index.json', /index\.json only means the top/],
		['a subfolder in a flat collection', 'content/journal/2026/apples.json', /isn't a document path/],
		['the collection folder itself', 'content/pages.json', /isn't in a folder any collection declares/],
		['an empty path', '', /must be the document's path/],
	];
	for (const [name, file, pattern] of cases) {
		test(name, async () => {
			const before = existsSync(join(root, 'content/pages/index.json')) ? read('content/pages/index.json') : null;
			await refused(await post({ ...doc(), file }), 400, pattern);
			assert.equal(read('content/pages/index.json'), before);
		});
	}

	test('a folder link inside a collection that points outside it', async () => {
		const secret = readFileSync(join(outside, 'secret.json'), 'utf8');
		await refused(await post({ ...doc(), file: 'content/pages/linked/secret.json' }), 400, /outside .* through a link/);
		assert.equal(readFileSync(join(outside, 'secret.json'), 'utf8'), secret);
	});

	test('a file that is a link', async () => {
		const secret = readFileSync(join(outside, 'secret.json'), 'utf8');
		await refused(await post({ ...doc(), file: 'content/pages/secret.json' }), 400, /is a link/);
		assert.equal(readFileSync(join(outside, 'secret.json'), 'utf8'), secret);
		assert.ok(lstatSync(join(root, 'content/pages/secret.json')).isSymbolicLink());
	});

	const malformed: [string, unknown, string?][] = [
		['not JSON', null, '{"file": '],
		['an array', [1, 2]],
		['no base', { file: 'content/pages/index.json', document: { title: 'x', blocks: [] } }],
		['a base that isn\'t a string', { file: 'content/pages/index.json', base: 3, document: { title: 'x', blocks: [] } }],
		['no document', { file: 'content/pages/index.json', base: '{}' }],
		['blocks not an array', { file: 'content/pages/index.json', base: '{}', document: { title: 'x', blocks: {} } }],
		['a block with a bad source', { file: 'content/pages/index.json', base: '{}', document: { title: 'x', blocks: [{ source: -1, type: 'hero', data: {} }] } }],
		['a block with no data', { file: 'content/pages/index.json', base: '{}', document: { title: 'x', blocks: [{ source: null, type: 'hero' }] } }],
		['an unexpected key', { file: 'content/pages/index.json', base: '{}', document: { title: 'x', blocks: [] }, path: '/etc/passwd' }],
		['a file that isn\'t a string', { file: ['content', 'pages', 'index.json'], base: '{}', document: { title: 'x', blocks: [] } }],
	];
	for (const [name, body, raw] of malformed) {
		test(`a malformed body: ${name}`, async () => {
			const before = read('content/pages/index.json');
			await refused(await post(body, raw ? { raw } : {}), 400, /Malformed body/);
			assert.equal(read('content/pages/index.json'), before);
		});
	}

	test('edits that don\'t fit the base sent with them (a source the base doesn\'t have)', async () => {
		const request = homeEdit();
		request.document.blocks[0]!.source = 7;
		await refused(await post(request), 400, /don't apply to the base/);
	});

	test('a base that isn\'t a JSON object', async () => {
		const request = { ...homeEdit(), base: '[1, 2]' };
		await refused(await post(request), 400, /don't apply to the base/);
	});
});

describe('the write route refuses other requests', () => {
	test('GET is 405, with Allow: POST', async () => {
		const response = await post(null, { method: 'GET' });
		await refused(response, 405);
		assert.equal(response.headers.get('allow'), 'POST');
	});

	test('a body that isn\'t JSON is 415', async () => {
		await refused(await post(homeEdit(), { headers: { 'content-type': 'text/plain' } }), 415);
	});

	test('a request from another site is 403 (Origin or Sec-Fetch-Site)', async () => {
		const before = read('content/pages/index.json');
		await refused(await post(homeEdit('evil'), { headers: { origin: 'https://evil.test' } }), 403);
		await refused(await post(homeEdit('evil'), { headers: { origin: 'null' } }), 403);
		await refused(await post(homeEdit('evil'), { headers: { 'sec-fetch-site': 'cross-site' } }), 403);
		assert.equal(read('content/pages/index.json'), before);
	});

	test('the editor\'s own same-origin request passes', async () => {
		const response = await post(homeEdit('From the editor'), { headers: { origin: 'http://localhost:4326', 'sec-fetch-site': 'same-origin' } });
		assert.equal(response.status, 200);
	});

	test('a document that doesn\'t exist is 404 (M3 never creates one)', async () => {
		await refused(await post({ ...homeEdit(), file: 'content/pages/nope.json' }), 404, /no document "nope"/);
		assert.equal(existsSync(join(root, 'content/pages/nope.json')), false);
		await refused(await post({ ...homeEdit(), file: 'content/pages/new-folder/nope.json' }), 404);
	});

	test('a body too large is 413', async () => {
		const request = homeEdit('x'.repeat(2 * 1024 * 1024 + 10));
		await refused(await post(request), 413);
	});
});

describe('confineDocumentFile', () => {
	test('maps a file to its collection and path', async () => {
		assert.deepEqual(await confineDocumentFile(site, 'content/pages/services/branding.json'), {
			collection: 'pages',
			path: 'services/branding',
			absolute: join(await import('node:fs/promises').then((f) => f.realpath(join(root, 'content/pages/services'))), 'branding.json'),
		});
		const journal = await confineDocumentFile(site, 'content/journal/apples.json');
		assert.equal(journal.collection, 'journal');
		assert.equal(journal.path, 'apples');
	});

	test('throws WriteRefused', async () => {
		await assert.rejects(confineDocumentFile(site, '../x.json'), WriteRefused);
	});
});
