// M6c Decision 6: the public file route's handler (files-route.ts) on plain Requests, with the
// in-memory bucket (CARACMS_MEDIA=memory) and injected limiters. Acceptance 4–8 and 10, and
// the bucket seam's `get` (S3 over a fake fetch, and the memory bucket). The same route served
// by `astro dev` is files-served.test.ts.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { MemoryBucket, s3Bucket } from '../src/editor/server/media/bucket.ts';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { fileAddress } from '../src/files.ts';
import {
	attachmentDisposition,
	CACHE_PRELAUNCH,
	CACHE_REDIRECT,
	CACHE_YEAR,
	FILES_LIMIT,
	filesLimiter,
	handleFileRequest,
	NOT_FOUND_TEXT,
	RATE_LIMITED_TEXT,
	resetFilesLimiter,
	UNAVAILABLE_TEXT,
	type FileRouteContext,
} from '../src/files-route.ts';
import { formLimiter, memoryLimiter, redisLimiter, resetFormLimiter } from '../src/forms/rate-limit.ts';
import { memoryRedis } from '../src/live/redis.ts';

const H = '0123456789ab';
const PDF_KEY = `uploads/${H}/rulebook.pdf`;
const DOCX_KEY = `uploads/${H}/terms.docx`;
const PDF = new TextEncoder().encode('%PDF-1.7\n% a tiny test PDF\n%%EOF\n');
const DOCX = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

const MEMORY = { CARACMS_MEDIA: 'memory' };
const bucket = () => memoryMedia().bucket;
const plenty = () => memoryLimiter({ max: 1_000_000 });

const get = (path: string, ctx: FileRouteContext = {}, init: RequestInit = {}) =>
	handleFileRequest(new Request(`http://site.test${path}`, init), { env: MEMORY, production: false, limiter: plenty(), log: () => {}, ...ctx });

beforeEach(() => {
	memoryMedia().reset();
	bucket().seed(PDF_KEY, { name: 'Rulebook.pdf', contentType: 'application/pdf' }, PDF);
	bucket().seed(DOCX_KEY, { name: 'Terms.docx' }, DOCX);
	bucket().seed(`uploads/${H}/photo.jpg`, { w: 40, h: 30 }, Uint8Array.from([0xff, 0xd8, 0xff]));
	bucket().seed(`uploads/aaaaaaaaaaaa/no-bytes.pdf`, { name: 'no-bytes.pdf' });
	bucket().calls.length = 0;
});

describe('serving a file (Acceptance 4, 5)', () => {
	test('GET streams a PDF inline, typed, nosniff, a year immutable, with its length', async () => {
		const res = await get(`/files/${H}/rulebook.pdf`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('content-type'), 'application/pdf');
		assert.equal(res.headers.get('content-disposition'), 'inline');
		assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
		assert.equal(res.headers.get('cache-control'), CACHE_YEAR);
		assert.equal(res.headers.get('content-length'), String(PDF.byteLength));
		assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PDF);
		assert.deepEqual(bucket().calls, [`get:${PDF_KEY}`], 'one read of that one key; no list, no head');
	});

	test('HEAD answers the same headers with no body', async () => {
		const g = await get(`/files/${H}/rulebook.pdf`);
		const h = await get(`/files/${H}/rulebook.pdf`, {}, { method: 'HEAD' });
		assert.equal(h.status, 200);
		for (const name of ['content-type', 'content-disposition', 'x-content-type-options', 'cache-control', 'content-length']) {
			assert.equal(h.headers.get(name), g.headers.get(name), name);
		}
		assert.equal(h.body, null);
	});

	test('?download makes a PDF an attachment with the key\'s name', async () => {
		const res = await get(`/files/${H}/rulebook.pdf?download`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('content-disposition'), 'attachment; filename="rulebook.pdf"');
		assert.equal(res.headers.get('content-type'), 'application/pdf');
		assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PDF);
	});

	test('a .docx is an attachment with or without ?download', async () => {
		for (const path of [`/files/${H}/terms.docx`, `/files/${H}/terms.docx?download`]) {
			const res = await get(path);
			assert.equal(res.status, 200, path);
			assert.equal(res.headers.get('content-disposition'), 'attachment; filename="terms.docx"', path);
			assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
			assert.deepEqual(new Uint8Array(await res.arrayBuffer()), DOCX);
		}
	});

	test('a non-ASCII name: its encoded address serves it, and the attachment adds filename*', async () => {
		const key = `uploads/${H}/café-menü.pdf`;
		bucket().seed(key, {}, PDF);
		const inline = await get(fileAddress(key));
		assert.equal(inline.status, 200);
		assert.equal(inline.headers.get('content-disposition'), 'inline');
		const download = await get(fileAddress(key, { download: true }));
		assert.equal(download.status, 200);
		assert.equal(download.headers.get('content-disposition'), `attachment; filename="caf_-men_.pdf"; filename*=UTF-8''caf%C3%A9-men%C3%BC.pdf`);
	});

	test('attachmentDisposition keeps quotes and backslashes out of the quoted name', () => {
		assert.equal(attachmentDisposition('a-b.pdf'), 'attachment; filename="a-b.pdf"');
		assert.equal(attachmentDisposition('a"b\\c.pdf'), `attachment; filename="a_b_c.pdf"; filename*=UTF-8''a%22b%5Cc.pdf`);
		assert.equal(attachmentDisposition("it's (1).pdf"), `attachment; filename="it's (1).pdf"`);
	});

	test('while the pre-launch password is on, the cache is private for a day', async () => {
		for (const method of ['GET', 'HEAD']) {
			const res = await get(`/files/${H}/rulebook.pdf`, { env: { ...MEMORY, CARACMS_PRELAUNCH: 'site:open' } }, { method });
			assert.equal(res.status, 200);
			assert.equal(res.headers.get('cache-control'), CACHE_PRELAUNCH);
		}
		assert.equal(CACHE_PRELAUNCH, 'private, max-age=86400');
		const blank = await get(`/files/${H}/rulebook.pdf`, { env: { ...MEMORY, CARACMS_PRELAUNCH: '  ' } });
		assert.equal(blank.headers.get('cache-control'), CACHE_YEAR, 'a blank value is off, as the gate reads it');
	});

	test('anything but GET and HEAD is a 405', async () => {
		const res = await get(`/files/${H}/rulebook.pdf`, {}, { method: 'POST', body: 'x' });
		assert.equal(res.status, 405);
		assert.equal(res.headers.get('allow'), 'GET, HEAD');
		assert.deepEqual(bucket().calls, []);
	});
});

describe('the query: none or exactly ?download (Acceptance 6)', () => {
	for (const [query, location] of [
		['?x=1', `/files/${H}/rulebook.pdf`],
		['?', `/files/${H}/rulebook.pdf`],
		['?download&x=1', `/files/${H}/rulebook.pdf?download`],
		['?x=1&download', `/files/${H}/rulebook.pdf?download`],
		['?download=1', `/files/${H}/rulebook.pdf?download`],
		['?Download', `/files/${H}/rulebook.pdf`],
		['?download&', `/files/${H}/rulebook.pdf?download`],
	] as const) {
		test(`${JSON.stringify(query)} is a 301 to ${location}`, async () => {
			const res = await get(`/files/${H}/rulebook.pdf${query}`);
			assert.equal(res.status, 301);
			assert.equal(res.headers.get('location'), location);
			assert.equal(res.headers.get('cache-control'), CACHE_REDIRECT);
			assert.equal(CACHE_REDIRECT, 'public, max-age=86400');
			assert.deepEqual(bucket().calls, [], 'the redirect never asks the bucket');
		});
	}

	test('a bad path with a query is the 404, never a redirect', async () => {
		const res = await get(`/files/${H}/rulebook.exe?x=1`);
		assert.equal(res.status, 404);
	});
});

describe('the path, an allow-list (Acceptance 7)', () => {
	// Each as the adapter would build the request's URL: WHATWG resolves dot segments (`%2e`
	// ones too) and turns a literal backslash into a slash first; the route sees the result.
	const cases: [string, string][] = [
		['`..` up and out', `/files/${H}/rulebook.pdf/..`],
		['`..` to the bucket root', `/files/../uploads/${H}/rulebook.pdf`],
		['`..` encoded with its slash', `/files/${H}/..%2frulebook.pdf`],
		['`..` and `%2f` in the name', `/files/${H}/%2e%2e%2f%2e%2e%2fsecret.pdf`],
		['a trailing `.` segment (the URL parser reduces it to a trailing slash)', `/files/${H}/.`],
		['a `.` for the hash (the URL parser drops it, leaving `/files/rulebook.pdf`: no hash)', `/files/./rulebook.pdf`],
		['an empty segment, `//`', `/files/${H}//rulebook.pdf`],
		['an empty first segment', `/files//${H}/rulebook.pdf`],
		['a trailing slash', `/files/${H}/rulebook.pdf/`],
		['a trailing slash on the hash', `/files/${H}/`],
		['a literal backslash (the URL parser makes it a slash: one segment too many)', `/files/${H}/a\\rulebook.pdf`],
		['`%5c`', `/files/${H}/a%5crulebook.pdf`],
		['`%5C` before the name', `/files/${H}/%5Crulebook.pdf`],
		['`%2f` in the name', `/files/${H}/sub%2frulebook.pdf`],
		['`%2F` joining hash and name', `/files/${H}%2Frulebook.pdf`],
		['NUL', `/files/${H}/rule%00book.pdf`],
		['a newline', `/files/${H}/rule%0abook.pdf`],
		['DEL', `/files/${H}/rule%7fbook.pdf`],
		['a malformed escape', `/files/${H}/rule%zzbook.pdf`],
		['a lone %', `/files/${H}/rule%.pdf`],
		['an escape that isn\'t UTF-8', `/files/${H}/rule%e9book.pdf`],
		['an extension not in the table', `/files/${H}/rulebook.exe`],
		['an image\'s key that exists', `/files/${H}/photo.jpg`],
		['an extension in capitals', `/files/${H}/rulebook.PDF`],
		['a name that is only the extension', `/files/${H}/.pdf`],
		['no extension', `/files/${H}/rulebook`],
		['a hash in capitals', `/files/0123456789AB/rulebook.pdf`],
		['a short hash', `/files/0123456789a/rulebook.pdf`],
		['a long hash', `/files/0123456789abc/rulebook.pdf`],
		['an encoded hash', `/files/%30123456789ab/rulebook.pdf`],
		['a submissions key', `/files/submissions/2026-10-16T13-12-00-000Z_aaaaaa.pdf`],
		['three segments', `/files/uploads/${H}/rulebook.pdf`],
		['the hash alone', `/files/${H}`],
		['/files', `/files`],
		['/files/', `/files/`],
		['outside /files', `/uploads/${H}/rulebook.pdf`],
	];
	for (const [label, path] of cases) {
		test(`${label}: ${path}`, async () => {
			let hits = 0;
			const limiter = { peek: async () => false, hit: async () => (hits++, false) };
			for (const method of ['GET', 'HEAD']) {
				const res = await get(path, { limiter }, { method });
				assert.equal(res.status, 404, method);
				assert.equal(res.headers.get('cache-control'), 'no-store');
				assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
				if (method === 'GET') assert.equal(await res.text(), NOT_FOUND_TEXT);
			}
			assert.deepEqual(bucket().calls, [], 'the bucket was never asked');
			assert.equal(hits, 0, 'nor the limiter');
		});
	}

	test('what WHATWG resolves to a key\'s own address is that address, never a way out of it', async () => {
		// `/files/<h>/./r.pdf` is `/files/<h>/r.pdf` before any code sees it: the same file.
		assert.equal(new URL(`http://site.test/files/${H}/./rulebook.pdf`).pathname, `/files/${H}/rulebook.pdf`);
		const res = await get(`/files/${H}/./rulebook.pdf`);
		assert.equal(res.status, 200);
		assert.deepEqual(bucket().calls, [`get:${PDF_KEY}`]);
	});
});

describe('missing, and no media variables (Acceptance 8)', () => {
	test('a key that doesn\'t exist, and a memory object with no bytes, are the same 404 (after one get)', async () => {
		for (const path of ['/files/ffffffffffff/rulebook.pdf', '/files/aaaaaaaaaaaa/no-bytes.pdf']) {
			const res = await get(path);
			assert.equal(res.status, 404, path);
			assert.equal(res.headers.get('cache-control'), 'no-store');
			assert.equal(await res.text(), NOT_FOUND_TEXT);
		}
		assert.deepEqual(bucket().calls, ['get:uploads/ffffffffffff/rulebook.pdf', 'get:uploads/aaaaaaaaaaaa/no-bytes.pdf']);
	});

	test('no media variables: 503 with the neutral sentence; the names go to the log only', async () => {
		const lines: string[] = [];
		for (const method of ['GET', 'HEAD']) {
			const res = await get(`/files/${H}/rulebook.pdf`, { env: {}, log: (l) => lines.push(l) }, { method });
			assert.equal(res.status, 503);
			assert.equal(res.headers.get('cache-control'), 'no-store');
			if (method === 'GET') {
				const body = await res.text();
				assert.equal(body, UNAVAILABLE_TEXT);
				assert.equal(body, "Downloads aren't available right now.\n");
				assert.doesNotMatch(body, /S3_|IMGPROXY|CARACMS_/);
			}
		}
		assert.equal(lines.length, 1, 'logged once, not per request');
		assert.match(lines[0]!, /S3_ENDPOINT/);
		assert.match(lines[0]!, /IMGPROXY_KEY/);
		assert.deepEqual(bucket().calls, []);
	});

	test('the in-memory media on a production server: 503', async () => {
		const res = await get(`/files/${H}/rulebook.pdf`, { production: true });
		assert.equal(res.status, 503);
		assert.deepEqual(bucket().calls, []);
	});

	test('the bucket failing: 503 with the same sentence, the cause logged', async () => {
		const env = {
			CARACMS_MEDIA_URL: 'https://img.example.com',
			IMGPROXY_KEY: 'abcd',
			IMGPROXY_SALT: 'abcd',
			S3_BUCKET: 'media',
			S3_ENDPOINT: 'https://s3.example.com',
			S3_REGION: 'ams',
			S3_ACCESS_KEY_ID: 'id',
			S3_SECRET_ACCESS_KEY: 'secret',
		};
		const lines: string[] = [];
		const res = await get(`/files/${H}/rulebook.pdf`, { env, log: (l) => lines.push(l), fetch: async () => new Response('<Error>SlowDown</Error>', { status: 500 }) });
		assert.equal(res.status, 503);
		assert.equal(await res.text(), UNAVAILABLE_TEXT);
		assert.match(lines[0]!, /couldn't read uploads\/0123456789ab\/rulebook\.pdf.*500/);
	});
});

describe('the download limiter (Acceptance 10)', () => {
	test('past 30 in the window: 429 with Retry-After the whole window', async () => {
		const limiter = memoryLimiter({ max: FILES_LIMIT.max, windowMs: FILES_LIMIT.windowMs });
		for (let i = 0; i < 30; i++) assert.equal((await get(`/files/${H}/rulebook.pdf`, { limiter })).status, 200, `download ${i + 1}`);
		const res = await get(`/files/${H}/rulebook.pdf`, { limiter });
		assert.equal(res.status, 429);
		assert.equal(res.headers.get('retry-after'), '600');
		assert.equal(res.headers.get('cache-control'), 'no-store');
		assert.equal(await res.text(), RATE_LIMITED_TEXT);
		assert.equal(bucket().calls.length, 30, 'the 31st never reached the bucket');
		const other = await get(`/files/${H}/rulebook.pdf`, { limiter }, { headers: { 'X-Real-IP': '203.0.113.9' } });
		assert.equal(other.status, 200, 'per visitor');
	});

	test('in Redis: its own prefix, and exhausting downloads leaves the contact form\'s allowance alone', async () => {
		const redis = memoryRedis();
		const files = redisLimiter(redis, () => {}, FILES_LIMIT);
		const ip = { 'X-Real-IP': '198.51.100.7' };
		for (let i = 0; i < 30; i++) assert.equal((await get(`/files/${H}/rulebook.pdf`, { limiter: files }, { headers: ip })).status, 200);
		assert.equal((await get(`/files/${H}/rulebook.pdf`, { limiter: files }, { headers: ip })).status, 429);
		assert.equal((await redis.scan('caracms:files:rl:*')).length, 1);
		assert.equal((await redis.scan('caracms:forms:rl:*')).length, 0, 'no form counter was touched');
		const forms = redisLimiter(redis); // the forms' own settings
		assert.equal(await forms.peek('198.51.100.7'), false, 'the form still takes this visitor');
		assert.equal(await forms.hit('198.51.100.7'), false);
		assert.ok((await redis.pttl((await redis.scan('caracms:files:rl:*'))[0]!)) > 9 * 60 * 1000, 'the download counter expires with its window');
	});

	test('the process limiters are two instances, so the route\'s default never shares the form\'s', async () => {
		resetFilesLimiter();
		resetFormLimiter();
		assert.notEqual(filesLimiter({}), formLimiter({}));
		assert.equal(filesLimiter({}), filesLimiter({}), 'kept per process');
		const headers = { 'X-Real-IP': '192.0.2.1' };
		for (let i = 0; i < 30; i++) await handleFileRequest(new Request(`http://site.test/files/${H}/rulebook.pdf`, { headers }), { env: MEMORY, production: false });
		assert.equal((await handleFileRequest(new Request(`http://site.test/files/${H}/rulebook.pdf`, { headers }), { env: MEMORY, production: false })).status, 429);
		assert.equal(await formLimiter({}).peek('192.0.2.1'), false);
		resetFilesLimiter();
		resetFormLimiter();
	});

	test('Redis out fails open, logged as a download', async () => {
		const down = { ...memoryRedis(), incr: async () => Promise.reject(new Error('ECONNREFUSED')) };
		const lines: string[] = [];
		const limiter = redisLimiter(down, (l) => lines.push(l), FILES_LIMIT);
		assert.equal((await get(`/files/${H}/rulebook.pdf`, { limiter })).status, 200);
		assert.match(lines[0]!, /files: couldn't reach Redis.*this download wasn't counted/);
	});
});

describe('the bucket seam\'s get', () => {
	test('MemoryBucket: the bytes as a stream, a copy; null with no bytes or no object', async () => {
		const b = new MemoryBucket();
		b.seed('uploads/aaaaaaaaaaaa/a.pdf', {}, PDF);
		b.seed('uploads/aaaaaaaaaaaa/b.pdf');
		const got = await b.get('uploads/aaaaaaaaaaaa/a.pdf');
		assert.equal(got!.size, PDF.byteLength);
		assert.deepEqual(new Uint8Array(await new Response(got!.body).arrayBuffer()), PDF);
		assert.equal(await b.get('uploads/aaaaaaaaaaaa/b.pdf'), null);
		assert.equal(await b.get('uploads/aaaaaaaaaaaa/c.pdf'), null);
		assert.deepEqual(b.calls, ['get:uploads/aaaaaaaaaaaa/a.pdf', 'get:uploads/aaaaaaaaaaaa/b.pdf', 'get:uploads/aaaaaaaaaaaa/c.pdf']);
	});

	test('S3: a signed GET of the one object; 404 is null; the body streams with its length', async () => {
		const seen: { method: string; url: string; auth: string | null }[] = [];
		const s3 = s3Bucket({ endpoint: 'https://s3.example.com', region: 'ams', bucket: 'media', accessKeyId: 'id', secretAccessKey: 'secret' }, async (input) => {
			const req = input as Request;
			seen.push({ method: req.method, url: req.url, auth: req.headers.get('authorization') });
			if (req.url.endsWith('/missing.pdf')) return new Response('<Error>NoSuchKey</Error>', { status: 404 });
			return new Response(PDF, { status: 200, headers: { 'Content-Length': String(PDF.byteLength) } });
		});
		const got = await s3.get(`uploads/${H}/café.pdf`);
		assert.equal(got!.size, PDF.byteLength);
		assert.deepEqual(new Uint8Array(await new Response(got!.body).arrayBuffer()), PDF);
		assert.equal(await s3.get(`uploads/${H}/missing.pdf`), null);
		assert.equal(seen[0]!.method, 'GET');
		assert.equal(seen[0]!.url, `https://s3.example.com/media/uploads/${H}/caf%C3%A9.pdf`);
		assert.match(seen[0]!.auth!, /^AWS4-HMAC-SHA256 /);
	});

	test('S3: any other refusal is a BucketError', async () => {
		const s3 = s3Bucket({ endpoint: 'https://s3.example.com', region: 'ams', bucket: 'media', accessKeyId: 'id', secretAccessKey: 'secret' }, async () => new Response('denied', { status: 403 }));
		await assert.rejects(s3.get(`uploads/${H}/a.pdf`), (e: Error) => e.name === 'BucketError' && /get uploads\/0123456789ab\/a\.pdf: 403/.test(e.message));
	});
});
