// M6c Decision 6, served: the public file route on a copy of the demo under `astro dev`, with
// the in-memory bucket (CARACMS_MEDIA=memory), never the real one. Requests go out raw
// (node:http, not fetch, which would tidy the path first), so what reaches the route is what
// Astro's router and the dev server make of each path: every trick ends at the route's own
// 404 without a bucket read, or never reaches the route at all.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { CACHE_REDIRECT, CACHE_YEAR, NOT_FOUND_TEXT, resetFilesLimiter, UNAVAILABLE_TEXT } from '../src/files-route.ts';
import { startDevSite, type DevSite } from './helpers/dev-site.ts';

const H = '0123456789ab';
const PDF_KEY = `uploads/${H}/rulebook.pdf`;
const PDF = new TextEncoder().encode('%PDF-1.7\n% a tiny test PDF\n%%EOF\n');

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: Buffer;
}

function ask(port: number, path: string, method = 'GET') {
	return new Promise<Reply>((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (d: Buffer) => chunks.push(d));
			res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on('error', reject);
		req.end();
	});
}

describe('the file route, served by astro dev', () => {
	let site: DevSite;
	const saved = process.env.CARACMS_MEDIA;
	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		site = await startDevSite('files-served');
	});
	after(async () => {
		await site?.close();
		if (saved === undefined) delete process.env.CARACMS_MEDIA;
		else process.env.CARACMS_MEDIA = saved;
	});
	beforeEach(() => {
		process.env.CARACMS_MEDIA = 'memory';
		resetFilesLimiter();
		memoryMedia().reset();
		memoryMedia().bucket.seed(PDF_KEY, { name: 'rulebook.pdf' }, PDF);
		memoryMedia().bucket.seed(`uploads/${H}/photo.jpg`, { w: 40, h: 30 }, Uint8Array.from([0xff, 0xd8, 0xff]));
		memoryMedia().bucket.calls.length = 0;
	});

	test('GET serves the seeded PDF inline; HEAD the same headers, no body', async () => {
		const res = await ask(site.port, `/files/${H}/rulebook.pdf`);
		assert.equal(res.status, 200);
		assert.equal(res.headers['content-type'], 'application/pdf');
		assert.equal(res.headers['content-disposition'], 'inline');
		assert.equal(res.headers['x-content-type-options'], 'nosniff');
		assert.equal(res.headers['cache-control'], CACHE_YEAR);
		assert.equal(res.headers['content-length'], String(PDF.byteLength));
		assert.deepEqual(new Uint8Array(res.body), PDF);

		const head = await ask(site.port, `/files/${H}/rulebook.pdf`, 'HEAD');
		assert.equal(head.status, 200);
		for (const name of ['content-type', 'content-disposition', 'x-content-type-options', 'cache-control', 'content-length']) assert.equal(head.headers[name], res.headers[name], name);
		assert.equal(head.body.byteLength, 0);
	});

	test('?download is an attachment with the key\'s name', async () => {
		const res = await ask(site.port, `/files/${H}/rulebook.pdf?download`);
		assert.equal(res.status, 200);
		assert.equal(res.headers['content-disposition'], 'attachment; filename="rulebook.pdf"');
		assert.deepEqual(new Uint8Array(res.body), PDF);
	});

	test('another query is a 301 to the clean address', async () => {
		for (const [query, location] of [
			['?x=1', `/files/${H}/rulebook.pdf`],
			['?', `/files/${H}/rulebook.pdf`],
			['?download&x=1', `/files/${H}/rulebook.pdf?download`],
		]) {
			const res = await ask(site.port, `/files/${H}/rulebook.pdf${query}`);
			assert.equal(res.status, 301, query);
			assert.equal(res.headers.location, location, query);
			assert.equal(res.headers['cache-control'], CACHE_REDIRECT, query);
		}
		assert.deepEqual(memoryMedia().bucket.calls, []);
	});

	test('path tricks never read the bucket: each ends at the route\'s own 404, or never reaches it', async () => {
		const routes = [
			`/files/${H}/..%2frulebook.pdf`,
			`/files/${H}/%2e%2e%2f%2e%2e%2fsecret.pdf`,
			`/files/${H}/sub%2frulebook.pdf`,
			`/files/${H}%2Frulebook.pdf`,
			`/files/${H}/a%5crulebook.pdf`,
			`/files/${H}/a\\rulebook.pdf`,
			`/files/${H}//rulebook.pdf`,
			`/files//${H}/rulebook.pdf`,
			`/files/${H}/rulebook.pdf/`,
			`/files/${H}/rulebook.pdf/..`,
			`/files/${H}/.`,
			`/files/${H}/rule%00book.pdf`,
			`/files/${H}/rulebook.exe`,
			`/files/${H}/photo.jpg`,
			`/files/submissions/2026-10-16T13-12-00-000Z_aaaaaa.pdf`,
			`/files/${H}`,
			`/files/`,
			`/files`,
		];
		for (const path of routes) {
			const res = await ask(site.port, path);
			assert.equal(res.status, 404, path);
			assert.equal(res.body.toString('utf8'), NOT_FOUND_TEXT, `${path}: the route's own 404`);
			assert.equal(res.headers['cache-control'], 'no-store', path);
		}
		// Resolved by the URL parser to /uploads/…: not under /files, so the site's own 404.
		const up = await ask(site.port, `/files/../uploads/${H}/rulebook.pdf`);
		assert.equal(up.status, 404);
		assert.notEqual(up.body.toString('utf8'), NOT_FOUND_TEXT);
		// A malformed escape: under `astro dev`, Vite answers 500 "URI malformed" before Astro
		// sees it. (A built server's Astro falls back to the raw path, so the route answers its
		// 404; the handler's own test covers that answer.)
		for (const path of [`/files/${H}/rule%zzbook.pdf`, `/files/${H}/rule%e9book.pdf`]) {
			const res = await ask(site.port, path);
			assert.ok(res.status === 404 || res.status === 500, `${path}: ${res.status}`);
		}
		assert.deepEqual(memoryMedia().bucket.calls, [], 'the bucket was never asked');
	});

	test('a missing key is the same 404, after one get', async () => {
		const res = await ask(site.port, '/files/ffffffffffff/rulebook.pdf');
		assert.equal(res.status, 404);
		assert.equal(res.body.toString('utf8'), NOT_FOUND_TEXT);
		assert.equal(res.headers['cache-control'], 'no-store');
		assert.deepEqual(memoryMedia().bucket.calls, ['get:uploads/ffffffffffff/rulebook.pdf']);
	});

	test('no media variables: 503 with the neutral sentence', async () => {
		delete process.env.CARACMS_MEDIA;
		try {
			const res = await ask(site.port, `/files/${H}/rulebook.pdf`);
			assert.equal(res.status, 503);
			assert.equal(res.headers['cache-control'], 'no-store');
			assert.equal(res.body.toString('utf8'), UNAVAILABLE_TEXT);
			assert.deepEqual(memoryMedia().bucket.calls, []);
		} finally {
			process.env.CARACMS_MEDIA = 'memory';
		}
	});
});
