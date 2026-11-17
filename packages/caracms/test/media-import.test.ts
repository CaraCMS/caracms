// M8 Decision 18, Acceptance 23: `caracms media import <files…>` (bin/media.mjs), against a
// fake S3 on node:http, and the upload route's own rules beside it so the two can't drift.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AwsV4Signer } from 'aws4fetch';
import { cleanName, CLOUD_KEY_MISSING as BIN_CLOUD_KEY_MISSING, DEFAULT_CLOUD_URL as BIN_CLOUD_URL, ignoredLine, keyFor, readServices, REPLACED_NAMES, run as runMedia, keyName as importKeyName, readS3Env, signS3, slugify as importSlugify, sniffImage as importSniff } from '../bin/media.mjs';
import { DEFAULT_CLOUD_URL } from '../src/live/cloud.ts';
import { CLOUD_KEY_MISSING_PROBLEM, ignoredMessage, REPLACED_VARIABLES } from '../src/live/services.ts';
import { MemoryBucket, s3Bucket } from '../src/editor/server/media/bucket.ts';
import { sniffImage } from '../src/editor/server/media/sniff.ts';
import { keyName, storeUpload, uploadName } from '../src/editor/server/media/upload.ts';
import { slugify } from '../src/slug.ts';
import { MEDIA_NAME_HEADER } from '../src/editor/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, '..', 'bin');

// ── Images, made by hand ─────────────────────────────────────────────────────────

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

/** A JPEG header: SOI, optionally an EXIF APP1 with an orientation, a SOF0, EOI. `salt` changes the hash. */
function jpeg(w: number, h: number, { orientation, salt = 0 }: { orientation?: number; salt?: number } = {}): Buffer {
	const parts: number[] = [0xff, 0xd8];
	if (orientation) {
		// TIFF, big-endian: header, IFD0 with one entry (0x0112, SHORT, 1, value).
		const tiff = [0x4d, 0x4d, 0x00, 0x2a, ...u32be(8), ...u16be(1), ...u16be(0x0112), ...u16be(3), ...u32be(1), ...u16be(orientation), 0, 0, ...u32be(0)];
		const body = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
		parts.push(0xff, 0xe1, ...u16be(body.length + 2), ...body);
	}
	parts.push(0xff, 0xfe, ...u16be(3), salt & 0xff); // a comment, for distinct bytes
	parts.push(0xff, 0xc0, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
	parts.push(0xff, 0xd9);
	return Buffer.from(parts);
}

function png(w: number, h: number): Buffer {
	const ihdr = [...u32be(13), ...Buffer.from('IHDR'), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0, 0, 0, 0, 0];
	return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...u32be(0), ...Buffer.from('IEND'), 0, 0, 0, 0]);
}

const gif = (w: number, h: number) => Buffer.from([...Buffer.from('GIF89a'), w & 0xff, w >> 8, h & 0xff, h >> 8, 0, 0, 0, 0x3b]);

function webp(w: number, h: number): Buffer {
	const vp8x = [...Buffer.from('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)];
	const body = [...Buffer.from('WEBP'), ...vp8x];
	return Buffer.from([...Buffer.from('RIFF'), body.length & 0xff, (body.length >> 8) & 0xff, 0, 0, ...body]);
}

const svg = (attrs: string) => Buffer.from(`<?xml version="1.0"?>\n<!-- a mark -->\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="1" height="1"/></svg>\n`);

const SAMPLES: Record<string, Buffer> = {
	jpeg: jpeg(1200, 800),
	'jpeg turned (EXIF 6)': jpeg(1200, 800, { orientation: 6, salt: 1 }),
	png: png(640, 480),
	gif: gif(32, 16),
	webp: webp(300, 200),
	'svg viewBox': svg('viewBox="0 0 120.4 40"'),
	'svg width and height': svg('width="64px" height="48"'),
	'svg no size': svg('fill="none"'),
	pdf: Buffer.from('%PDF-1.7\n%…'),
	'web page': Buffer.from('<!DOCTYPE html><html><body></body></html>'),
	text: Buffer.from('just words'),
	empty: Buffer.alloc(0),
};

// ── The rules agree with the route's ────────────────────────────────────────────

describe('media import: the upload route\'s rules, written out again, agree with it', () => {
	test('the type and size from the bytes, for every kind', () => {
		for (const [label, bytes] of Object.entries(SAMPLES)) {
			const route = sniffImage(bytes);
			const mine = importSniff(bytes);
			assert.equal(mine.ok, route.ok, label);
			if (route.ok && mine.ok) {
				assert.deepEqual({ ext: mine.ext, mime: mine.mime, w: mine.w, h: mine.h, format: mine.format }, { ext: route.ext, mime: route.mime, w: route.w, h: route.h, format: route.format }, label);
			} else if (!route.ok && !mine.ok) assert.equal(mine.code, route.code, label);
		}
		// And the sizes are the real ones.
		assert.deepEqual(pick(importSniff(SAMPLES['jpeg turned (EXIF 6)']!)), { w: 800, h: 1200 });
		assert.deepEqual(pick(importSniff(SAMPLES['svg viewBox']!)), { w: 120, h: 40 });
		assert.deepEqual(pick(importSniff(SAMPLES['svg width and height']!)), { w: 64, h: 48 });
	});

	const NAMES = ['Harbour Wall.JPG', 'Café Ölé & Co.png', 'Straße_ßæ.svg', '.hidden.jpg', 'no-extension', '!!!.png', '', `${'very long name '.repeat(8)}.webp`, 'Ünïcödé 写真.gif', 'two.dots.in.it.jpeg'];

	test('slugify and keyName match src/slug.ts and upload.ts', () => {
		for (const name of NAMES) {
			assert.equal(importSlugify(name), slugify(name), name);
			assert.equal(importKeyName(name), keyName(name), name);
			assert.equal(importKeyName(name, 'file'), keyName(name, 'file'), name);
		}
	});

	test('a name is cleaned as the route\'s uploadName cleans the header', () => {
		for (const name of [...NAMES, ' padded.jpg ', 'tab\there.png', `${'é'.repeat(400)}.jpg`]) {
			const request = new Request('http://x/', { method: 'POST', headers: { [MEDIA_NAME_HEADER]: encodeURIComponent(name) } });
			assert.equal(cleanName(name), uploadName(request), JSON.stringify(name));
		}
	});

	test('the whole key is the one the route stores, for several files and names', async () => {
		const images = Object.entries(SAMPLES).filter(([, b]) => sniffImage(b).ok);
		for (const [label, bytes] of images) {
			for (const name of NAMES) {
				const bucket = new MemoryBucket();
				const stored = await storeUpload(bucket, { bytes: new Uint8Array(bytes), name: cleanName(name), by: null });
				const mine = keyFor(bytes, name);
				assert.ok(mine.ok, label);
				assert.equal(mine.key, stored.key, `${label} as ${JSON.stringify(name)}`);
				assert.deepEqual({ w: mine.sniffed.w, h: mine.sniffed.h }, { w: stored.meta.w, h: stored.meta.h }, label);
			}
		}
	});

	test('the hand-rolled SigV4 signs as aws4fetch does', async () => {
		const creds = { S3_ENDPOINT: 'https://s3.example.test/', S3_REGION: 'auto', S3_BUCKET: 'site-media', S3_ACCESS_KEY_ID: 'AKIDEXAMPLE', S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
		const now = new Date('2026-10-21T09:30:00.000Z');
		const body = Buffer.from('bytes');
		const cases = [
			{ method: 'GET', key: '', query: { 'list-type': '2', prefix: 'uploads/3f9a1c07b2e4/', 'max-keys': '1' } },
			{ method: 'HEAD', key: 'uploads/3f9a1c07b2e4/harbour-wall.jpg' },
			{ method: 'PUT', key: 'uploads/3f9a1c07b2e4/café-写真.jpg', body, headers: { 'x-amz-meta-w': '10', 'x-amz-meta-name': encodeURIComponent('Café 写真.jpg') } },
			{ method: 'PUT', key: "uploads/3f9a1c07b2e4/photo (1) it's!*.jpg", body },
			{ method: 'HEAD', key: "uploads/3f9a1c07b2e4/photo (1) it's!*.jpg" },
		];
		for (const c of cases) {
			const mine = signS3(creds, { ...c, now });
			const theirs = await new AwsV4Signer({
				method: c.method,
				url: mine.url,
				headers: { ...(c.headers ?? {}), 'x-amz-content-sha256': createHash('sha256').update(c.body ?? '').digest('hex') },
				accessKeyId: creds.S3_ACCESS_KEY_ID,
				secretAccessKey: creds.S3_SECRET_ACCESS_KEY,
				service: 's3',
				region: creds.S3_REGION,
				datetime: '20261021T093000Z',
			}).sign();
			assert.equal(mine.headers.authorization, theirs.headers.get('authorization'), c.method);
		}
	});

	test('the bin\'s DEFAULT_CLOUD_URL is src/live/cloud.ts\'s', () => {
		assert.equal(BIN_CLOUD_URL, DEFAULT_CLOUD_URL);
	});

	test('the bin imports only Node built-ins, and nothing in it deletes', () => {
		const source = readFileSync(join(binDir, 'media.mjs'), 'utf8');
		const specifiers = [...source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
		assert.ok(specifiers.length > 0);
		for (const s of specifiers) assert.ok(s.startsWith('node:'), `imports ${s}`);
		assert.doesNotMatch(source, /\.ts['"]/);
		assert.doesNotMatch(source, /['"]DELETE['"]|DeleteObject|\?delete/i);
	});
});

// ── The command, run by node with no flags, against a fake S3 ────────────────────

interface Stored {
	body: Buffer;
	headers: Record<string, string>;
}
const objects = new Map<string, Stored>();
const calls: string[] = [];
let server: Server;
let endpoint = '';
let work = '';
let runner = '';
const BUCKET = 'site-media';

const readBody = (req: IncomingMessage) =>
	new Promise<Buffer>((resolve) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
	});

const pick = (x: { w?: number; h?: number }) => ({ w: x.w, h: x.h });

before(async () => {
	server = createServer(async (req, res) => {
		const url = new URL(req.url!, 'http://fake');
		const body = await readBody(req);
		calls.push(`${req.method} ${url.pathname}${url.search}`);
		const signed = String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=');
		const hashOk = req.headers['x-amz-content-sha256'] === createHash('sha256').update(body).digest('hex');
		if (!signed || !hashOk) {
			res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
			return;
		}
		const [, bucket, ...rest] = url.pathname.split('/');
		const key = rest.map((p) => decodeURIComponent(p)).join('/');
		if (bucket !== BUCKET) return void res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>');
		if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
			const prefix = url.searchParams.get('prefix') ?? '';
			const max = Number(url.searchParams.get('max-keys') ?? 1000);
			const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, max);
			const contents = keys.map((k) => `<Contents><Key>${k}</Key><LastModified>2026-10-21T09:00:00.000Z</LastModified><Size>${objects.get(k)!.body.length}</Size></Contents>`).join('');
			res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
			return;
		}
		if (req.method === 'GET' && key) {
			const o = objects.get(key);
			if (!o) return void res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
			const meta = Object.fromEntries(Object.entries(o.headers).filter(([k]) => k.startsWith('x-amz-meta-') || k === 'content-type'));
			res.writeHead(200, { ...meta, 'content-length': String(o.body.length) }).end(o.body);
			return;
		}
		if (req.method === 'HEAD' && key) {
			const o = objects.get(key);
			if (!o) return void res.writeHead(404).end();
			const meta = Object.fromEntries(Object.entries(o.headers).filter(([k]) => k.startsWith('x-amz-meta-') || k === 'content-type'));
			res.writeHead(200, { ...meta, 'content-length': String(o.body.length), 'last-modified': 'Wed, 21 Oct 2026 09:00:00 GMT' }).end();
			return;
		}
		if (req.method === 'PUT' && key) {
			if (objects.has(key)) return void res.writeHead(409).end('<Error><Code>Overwrite</Code></Error>');
			objects.set(key, { body, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])) });
			res.writeHead(200).end();
			return;
		}
		res.writeHead(405).end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	work = mkdtempSync(join(tmpdir(), 'caracms-media-import-'));
	runner = join(work, 'run.mjs');
	writeFileSync(runner, `import { run } from ${JSON.stringify(pathToFileURL(join(binDir, 'media.mjs')).href)};\nprocess.exitCode = await run(process.argv.slice(2));\n`);
});

after(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
	objects.clear();
	calls.length = 0;
});

const S3_ENV = () => ({ S3_ENDPOINT: endpoint, S3_REGION: 'auto', S3_BUCKET: BUCKET, S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'test-secret' });

/** `node run.mjs …` in `cwd`, with only `env` (plus PATH) in its environment: no flags. */
function media(args: string[], { cwd, env }: { cwd: string; env: Record<string, string> }) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(process.execPath, [runner, ...args], { cwd, env: { PATH: process.env.PATH ?? '', ...env } }, (error, stdout, stderr) => {
			resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});
}

/** A site folder with these files in it. */
function site(name: string, files: Record<string, Buffer | string>): string {
	const root = join(work, name);
	mkdirSync(root, { recursive: true });
	for (const [path, data] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), data);
	}
	return root;
}

const hash12 = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 12);

describe('caracms media import (Acceptance 23)', () => {
	const photo = jpeg(1600, 900, { salt: 7 });
	const mark = svg('viewBox="0 0 240 80"');

	test('a jpg and an svg go in under the route\'s keys, and it prints the JSON', async () => {
		const cwd = site('one', { 'images/Harbour Wall.JPG': photo, 'logo mark.svg': mark });
		const r = await media(['import', 'images/Harbour Wall.JPG', 'logo mark.svg'], { cwd, env: S3_ENV() });
		assert.equal(r.code, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(out, [
			{ file: 'images/Harbour Wall.JPG', key: `uploads/${hash12(photo)}/harbour-wall.jpg`, w: 1600, h: 900, existed: false },
			{ file: 'logo mark.svg', key: `uploads/${hash12(mark)}/logo-mark.svg`, w: 240, h: 80, existed: false },
		]);
		const stored = objects.get(out[0].key)!;
		assert.ok(stored.body.equals(photo));
		assert.equal(stored.headers['content-type'], 'image/jpeg');
		assert.equal(stored.headers['x-amz-meta-w'], '1600');
		assert.equal(stored.headers['x-amz-meta-h'], '900');
		assert.equal(decodeURIComponent(stored.headers['x-amz-meta-name']!), 'Harbour Wall.JPG');
		assert.equal(objects.get(out[1].key)!.headers['content-type'], 'image/svg+xml');
		assert.equal(calls.filter((c) => c.startsWith('PUT')).length, 2);
		assert.ok(!calls.some((c) => c.startsWith('DELETE') || c.includes('delete')));
	});

	test('importing the same files again writes nothing and prints the same keys with existed: true', async () => {
		const cwd = site('again', { 'a.jpg': photo, 'b.svg': mark, 'renamed copy.jpg': photo });
		const first = JSON.parse((await media(['import', 'a.jpg', 'b.svg'], { cwd, env: S3_ENV() })).stdout);
		const puts = calls.filter((c) => c.startsWith('PUT')).length;
		const r = await media(['import', 'a.jpg', 'b.svg', 'renamed copy.jpg'], { cwd, env: S3_ENV() });
		assert.equal(r.code, 0, r.stderr);
		const again = JSON.parse(r.stdout);
		assert.deepEqual(again, [
			{ ...first[0], existed: true },
			{ ...first[1], existed: true },
			{ file: 'renamed copy.jpg', key: first[0].key, w: 1600, h: 900, existed: true },
		]);
		assert.equal(calls.filter((c) => c.startsWith('PUT')).length, puts, 'no second write');
		assert.equal(objects.size, 2);
	});

	test('an image the editor\'s route stored is found, and one the import stored is found by the route', async () => {
		const settings = { endpoint, region: 'auto', bucket: BUCKET, accessKeyId: 'k', secretAccessKey: 's' };
		const routeStored = await storeUpload(s3Bucket(settings), { bytes: new Uint8Array(photo), name: 'From the editor.jpg', by: 'walker@example.test' });
		const cwd = site('mixed', { 'mine.jpg': photo, 'b.svg': mark });
		const r = await media(['import', 'mine.jpg', 'b.svg'], { cwd, env: S3_ENV() });
		assert.equal(r.code, 0, r.stderr);
		const [jpg, svgOut] = JSON.parse(r.stdout);
		assert.deepEqual(jpg, { file: 'mine.jpg', key: routeStored.key, w: 1600, h: 900, existed: true });
		const back = await storeUpload(s3Bucket(settings), { bytes: new Uint8Array(mark), name: 'other.svg', by: null });
		assert.equal(back.created, false);
		assert.equal(back.key, svgOut.key);
	});

	test('credentials come from the site\'s .env when the environment lacks them, and a missing one is named', async () => {
		const env = S3_ENV();
		const dotenv = `# media\nexport S3_ENDPOINT="${env.S3_ENDPOINT}"\nS3_REGION=auto\nS3_BUCKET='${BUCKET}' # the demo's\nS3_ACCESS_KEY_ID=test-key\n`;
		const cwd = site('dotenv', { '.env': dotenv, 'a.jpg': photo });
		const missing = await media(['import', 'a.jpg'], { cwd, env: {} });
		assert.equal(missing.code, 1);
		assert.match(missing.stderr, /S3_SECRET_ACCESS_KEY/);
		assert.doesNotMatch(missing.stderr, /S3_ENDPOINT|S3_REGION|S3_BUCKET|S3_ACCESS_KEY_ID/);
		assert.equal(missing.stdout, '');
		assert.equal(calls.length, 0, 'nothing sent');
		const ok = await media(['import', 'a.jpg'], { cwd, env: { S3_SECRET_ACCESS_KEY: 'test-secret' } });
		assert.equal(ok.code, 0, ok.stderr);
		assert.equal(JSON.parse(ok.stdout)[0].existed, false);

		const none = readS3Env({}, join(work, 'nowhere'));
		assert.deepEqual(none.missing, ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
	});

	test('bad usage exits 2: no subcommand, an unknown one, no files', async () => {
		const cwd = site('usage', {});
		for (const args of [[], ['export', 'a.jpg'], ['import'], ['import', '--force', 'a.jpg']]) {
			const r = await media(args, { cwd, env: S3_ENV() });
			assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.stderr}`);
			assert.match(r.stderr, /caracms media import <files…>/);
			assert.equal(r.stdout, '');
		}
		assert.equal(calls.length, 0);
	});

	test('a file that isn\'t an image, or isn\'t there, stops the run before anything is written', async () => {
		const cwd = site('refused', { 'a.jpg': photo, 'doc.pdf': SAMPLES.pdf!, 'blank.svg': SAMPLES['svg no size']! });
		const r = await media(['import', 'a.jpg', 'doc.pdf', 'blank.svg', 'gone.png'], { cwd, env: S3_ENV() });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /doc\.pdf: This is a PDF/);
		assert.match(r.stderr, /blank\.svg: This SVG has no size/);
		assert.match(r.stderr, /gone\.png: can't read it/);
		assert.equal(r.stdout, '');
		assert.equal(calls.length, 0, 'nothing sent');
	});
});

// ── On CaraCMS Cloud (caracms-cloud M3 Decisions 6 and 6a; Acceptance 17, 17a) ─────

const CLOUD_KEY = `cck_${'b'.repeat(43)}`;
const LIMIT = 'This site has reached its storage limit in CaraCMS Cloud (5 GB). Ask CaraCMS to raise it.';

interface CloudObject {
	body: Buffer;
	headers: Record<string, string>;
}
/** The site's folder in the cloud, keys relative to it (the API strips sites/<folder>/). */
const cloudObjects = new Map<string, CloudObject>();
const cloudCalls: string[] = [];
const uploadAsks: Record<string, unknown>[] = [];
let cloudServer: Server;
let cloudUrl = '';
/** Upload URLs given → the headers they named. */
const given = new Map<string, Record<string, string>>();
/** Refuse upload URLs after this many (the cap). */
let uploadsLeft = Infinity;

before(async () => {
	cloudServer = createServer(async (req, res) => {
		const url = new URL(req.url!, 'http://fake');
		const body = await readBody(req);
		cloudCalls.push(`${req.method} ${url.pathname}`);
		const send = (status: number, json: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(json));
		if (url.pathname.startsWith('/r2/')) {
			const key = decodeURIComponent(url.pathname.slice('/r2/sites/picker/'.length));
			const named = given.get(url.pathname);
			if (req.method !== 'PUT' || !named) return void res.writeHead(403).end();
			for (const [name, value] of Object.entries(named)) {
				if (String(req.headers[name.toLowerCase()]) !== value) return void res.writeHead(403).end(`<Error>${name}</Error>`);
			}
			if (createHash('sha256').update(body).digest('hex') !== named['x-amz-content-sha256']) return void res.writeHead(400).end('<Error>BadDigest</Error>');
			if (cloudObjects.has(key)) return void res.writeHead(412).end();
			cloudObjects.set(key, { body, headers: Object.fromEntries(Object.entries(named).map(([k, v]) => [k.toLowerCase(), v])) });
			return void res.writeHead(200).end();
		}
		if (req.headers.authorization !== `Bearer ${CLOUD_KEY}`) return send(401, { error: 'unknown_key', message: 'That key is not one CaraCMS Cloud knows.' });
		if (req.method === 'GET' && url.pathname === '/v1/media/list') {
			const prefix = url.searchParams.get('prefix') ?? '';
			const keys = [...cloudObjects.keys()].filter((k) => k.startsWith(prefix)).sort();
			return send(200, { objects: keys.map((key) => ({ key, lastModified: '2026-10-26T09:00:00.000Z', size: cloudObjects.get(key)!.body.length })), next: null });
		}
		if (req.method === 'GET' && url.pathname === '/v1/media/object') {
			const key = url.searchParams.get('key')!;
			const o = cloudObjects.get(key);
			if (!o) return send(404, { error: 'not_found', message: 'There is no such file.' });
			const h = o.headers;
			return send(200, { key, w: h['x-amz-meta-w'] ? Number(h['x-amz-meta-w']) : null, h: h['x-amz-meta-h'] ? Number(h['x-amz-meta-h']) : null, name: h['x-amz-meta-name'] ? decodeURIComponent(h['x-amz-meta-name']) : null, by: h['x-amz-meta-by'] ?? null, contentType: h['content-type'], lastModified: '2026-10-26T09:00:00.000Z', size: o.body.length });
		}
		if (req.method === 'POST' && url.pathname === '/v1/media/upload-url') {
			const ask = JSON.parse(body.toString('utf8'));
			uploadAsks.push(ask);
			if (uploadsLeft <= 0) return send(403, { error: 'upload_limit', message: LIMIT });
			uploadsLeft--;
			const path = `/r2/sites/picker/${ask.key}`;
			const headers: Record<string, string> = {
				'Content-Type': ask.contentType,
				'Content-Length': String(ask.size),
				'x-amz-content-sha256': ask.sha256,
				'If-None-Match': '*',
				...(ask.meta.w !== undefined ? { 'x-amz-meta-w': String(ask.meta.w) } : {}),
				...(ask.meta.h !== undefined ? { 'x-amz-meta-h': String(ask.meta.h) } : {}),
				'x-amz-meta-name': encodeURIComponent(ask.meta.name),
				...(ask.meta.by ? { 'x-amz-meta-by': ask.meta.by } : {}),
			};
			given.set(new URL(path, 'http://fake').pathname, headers);
			return send(200, { url: `${cloudUrl}${path}?X-Amz-Signature=put`, method: 'PUT', headers, expiresAt: '2026-10-26T09:05:00.000Z' });
		}
		send(404, { error: 'not_found', message: 'No such route.' });
	});
	await new Promise<void>((resolve) => cloudServer.listen(0, '127.0.0.1', resolve));
	cloudUrl = `http://127.0.0.1:${(cloudServer.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((resolve) => cloudServer.close(() => resolve()));
});

beforeEach(() => {
	cloudObjects.clear();
	cloudCalls.length = 0;
	uploadAsks.length = 0;
	given.clear();
	uploadsLeft = Infinity;
});

const CLOUD_ENV = () => ({ CARACMS_CLOUD_KEY: CLOUD_KEY, CARACMS_CLOUD_URL: cloudUrl });

describe('caracms media import on CaraCMS Cloud (Acceptance 17)', () => {
	const photo = jpeg(1600, 900, { salt: 21 });
	const mark = svg('viewBox="0 0 240 80"');

	test('new files go in through upload URLs, existing ones are reported existed: true, with the same output as the S3 path', async () => {
		const cwd = site('cloud-one', { 'images/Harbour Wall.JPG': photo, 'logo mark.svg': mark });
		const r = await media(['import', 'images/Harbour Wall.JPG', 'logo mark.svg'], { cwd, env: CLOUD_ENV() });
		assert.equal(r.code, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(out, [
			{ file: 'images/Harbour Wall.JPG', key: `uploads/${hash12(photo)}/harbour-wall.jpg`, w: 1600, h: 900, existed: false },
			{ file: 'logo mark.svg', key: `uploads/${hash12(mark)}/logo-mark.svg`, w: 240, h: 80, existed: false },
		]);
		assert.ok(cloudObjects.get(out[0].key)!.body.equals(photo));
		assert.deepEqual(uploadAsks[0], { key: out[0].key, size: photo.length, contentType: 'image/jpeg', sha256: createHash('sha256').update(photo).digest('hex'), meta: { w: 1600, h: 900, name: 'Harbour Wall.JPG', by: 'import' } });
		assert.equal(calls.length, 0, 'no S3 call');

		const again = await media(['import', 'images/Harbour Wall.JPG', 'logo mark.svg'], { cwd, env: CLOUD_ENV() });
		assert.equal(again.code, 0, again.stderr);
		assert.deepEqual(JSON.parse(again.stdout), out.map((o: object) => ({ ...o, existed: true })));
		assert.equal(uploadAsks.length, 2, 'no upload URL asked the second time');
	});

	test('the key from the site\'s .env; with any of the site\'s own media variables it refuses with the running site\'s sentence', async () => {
		const cwd = site('cloud-dotenv', { '.env': `CARACMS_CLOUD_KEY=${CLOUD_KEY}\nCARACMS_CLOUD_URL=${cloudUrl}\n`, 'a.jpg': photo });
		const ok = await media(['import', 'a.jpg'], { cwd, env: {} });
		assert.equal(ok.code, 0, ok.stderr);
		const both = await media(['import', 'a.jpg'], { cwd, env: { S3_BUCKET: BUCKET, IMGPROXY_KEY: 'aa' } });
		assert.equal(both.code, 1);
		assert.match(both.stderr, /Set CARACMS_CLOUD_KEY or the site's own media variables, not both: remove S3_BUCKET and IMGPROXY_KEY\./);
		assert.equal(both.stdout, '');
	});

	test('the cloud\'s refusal is printed as sent, with what went in before it', async () => {
		uploadsLeft = 1;
		const cwd = site('cloud-full', { 'a.jpg': photo, 'b.svg': mark });
		const r = await media(['import', 'a.jpg', 'b.svg'], { cwd, env: CLOUD_ENV() });
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes(LIMIT));
		assert.match(r.stderr, /These went in before it stopped: .*a\.jpg/);
		assert.equal(r.stdout, '');
	});
});

/** `run` in this process, with the config's `services` given (a real config needs the site's Vite: readServices). */
async function mediaIn(args: string[], { cwd, env, services }: { cwd: string; env: Record<string, string>; services: 'cloud' | 'self-hosted' | null }) {
	let stdout = '';
	let stderr = '';
	const code = await runMedia(args, { cwd, env, services, stdout: { write: (t: string) => (stdout += t) }, stderr: { write: (t: string) => (stderr += t) } });
	return { code, stdout, stderr };
}

describe("caracms media import with the config's services (caracms-cloud M5, Acceptance 6)", () => {
	const photo = jpeg(800, 600, { salt: 41 });

	test("'cloud' with both sets (one in .env) uploads to the cloud and names the ignored variables once", async () => {
		const cwd = site('services-cloud', { '.env': `S3_BUCKET=${BUCKET}\nIMGPROXY_KEY=aa\n`, 'a.jpg': photo });
		const r = await mediaIn(['import', 'a.jpg'], { cwd, env: { ...S3_ENV(), ...CLOUD_ENV(), RESEND_API_KEY: 're_x' }, services: 'cloud' });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout)[0].existed, false);
		assert.equal(uploadAsks.length, 1);
		assert.equal(calls.length, 0, 'no S3 call');
		const lines = r.stderr.trim().split('\n').filter((l) => /ignored/.test(l));
		assert.equal(lines.length, 1, r.stderr);
		assert.match(lines[0]!, /^S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, IMGPROXY_KEY and RESEND_API_KEY are set, but this site runs on CaraCMS Cloud \(caracms\.config\.ts\): they're ignored\. Remove them once the move is done\.$/);
	});

	test("'cloud' without the key is Decision 4's sentence, never the site's own bucket", async () => {
		const cwd = site('services-cloud-nokey', { 'a.jpg': photo });
		const r = await mediaIn(['import', 'a.jpg'], { cwd, env: S3_ENV(), services: 'cloud' });
		assert.equal(r.code, 1);
		assert.equal(r.stderr.trim(), CLOUD_KEY_MISSING_PROBLEM);
		assert.equal(calls.length, 0);
	});

	test("'self-hosted' with the key uploads to the site's own bucket and names the key as ignored", async () => {
		const cwd = site('services-self', { 'a.jpg': photo });
		const r = await mediaIn(['import', 'a.jpg'], { cwd, env: { ...S3_ENV(), ...CLOUD_ENV() }, services: 'self-hosted' });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(uploadAsks.length, 0);
		assert.ok(calls.length > 0);
		assert.match(r.stderr, /CARACMS_CLOUD_KEY is set, but this site is self-hosted \(caracms\.config\.ts\): it's ignored\./);
	});

	test("the bin's copies match the package's: the replaced names and Decision 4's sentence", () => {
		assert.deepEqual(REPLACED_NAMES, Object.values(REPLACED_VARIABLES).flat());
		assert.equal(BIN_CLOUD_KEY_MISSING, CLOUD_KEY_MISSING_PROBLEM);
	});

	test("the bin's ignored line is the running site's ignoredMessage, word for word, ending included", () => {
		for (const names of [['S3_BUCKET'], ['S3_BUCKET', 'RESEND_API_KEY'], ['S3_BUCKET', 'IMGPROXY_KEY', 'MUX_TOKEN_ID']]) {
			assert.equal(ignoredLine(names, 'cloud'), ignoredMessage(names, 'cloud'));
		}
		assert.equal(ignoredLine(['CARACMS_CLOUD_KEY'], 'self-hosted'), ignoredMessage(['CARACMS_CLOUD_KEY'], 'self-hosted'));
		assert.match(ignoredLine(['S3_BUCKET'], 'cloud'), /Remove it once the move is done\.$/);
	});

	test("readServices reads the field through the site's Vite; no config is null", async () => {
		assert.equal(await readServices(site('services-none', {})), null);
		// A site with a config whose services is 'cloud', its Astro the package's own (a link to its node_modules).
		const cwd = site('services-config', {
			'caracms.config.mjs': "export default { services: 'cloud', collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/' } }, blocks: {}, textStyles: {}, page: 'Page.astro' };\n",
			'Page.astro': '---\n---\n',
			'package.json': '{ "type": "module" }\n',
		});
		symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(cwd, 'node_modules'));
		assert.equal(await readServices(cwd), 'cloud');
	});
});

describe('caracms media push (Acceptance 17a)', () => {
	const one = jpeg(1200, 800, { salt: 31 });
	const two = png(640, 480);
	const three = svg('viewBox="0 0 10 10"');
	const pdf = Buffer.from('%PDF-1.7 the price list');
	const KEY_ONE = `uploads/${hash12(one)}/harbour.jpg`;
	const KEY_TWO = `uploads/${hash12(two)}/kiln.png`;
	const KEY_THREE = `uploads/${hash12(three)}/mark.svg`;
	const KEY_PDF = `uploads/${hash12(pdf)}/prices.pdf`;
	const MISMATCH = `uploads/${'0'.repeat(12)}/liar.jpg`;
	const OFF_SHAPE = 'uploads/notes/readme.txt';

	const seedSource = () => {
		const put = (key: string, body: Buffer, headers: Record<string, string>) => objects.set(key, { body, headers });
		put(KEY_ONE, one, { 'content-type': 'image/jpeg', 'x-amz-meta-w': '1200', 'x-amz-meta-h': '800', 'x-amz-meta-name': encodeURIComponent('Harbour Wall (final).jpg'), 'x-amz-meta-by': 'aoife@example.com' });
		put(KEY_TWO, two, { 'content-type': 'image/png', 'x-amz-meta-w': '640', 'x-amz-meta-h': '480', 'x-amz-meta-name': 'kiln.png', 'x-amz-meta-by': encodeURIComponent('Aoife') });
		put(KEY_THREE, three, { 'content-type': 'image/svg+xml', 'x-amz-meta-w': '10', 'x-amz-meta-h': '10', 'x-amz-meta-name': 'mark.svg' });
		put(KEY_PDF, pdf, { 'content-type': 'application/pdf', 'x-amz-meta-name': 'prices.pdf', 'x-amz-meta-by': 'import' });
		put(MISMATCH, one, { 'content-type': 'image/jpeg', 'x-amz-meta-name': 'liar.jpg' });
		put(OFF_SHAPE, Buffer.from('words'), { 'content-type': 'text/plain' });
		put('elsewhere/x.jpg', one, { 'content-type': 'image/jpeg' });
	};
	const BOTH = () => ({ ...S3_ENV(), ...CLOUD_ENV() });

	test('copies every uploads/ object under its own key with its metadata; a hash mismatch fails unsent, an off-shape key is left; a second run copies nothing', async () => {
		seedSource();
		cloudObjects.set(KEY_THREE, { body: three, headers: { 'content-type': 'image/svg+xml' } });
		const cwd = site('push', {});
		const r = await media(['push'], { cwd, env: BOTH() });
		assert.equal(r.code, 1, 'something failed');
		const out = JSON.parse(r.stdout);
		assert.equal(out.copied, 3);
		assert.equal(out.skipped, 1);
		assert.equal(out.left, 1, 'the off-shape key is counted as left');
		assert.deepEqual(out.failed.map((f: { key: string }) => f.key), [MISMATCH], 'an off-shape key is not a failure');
		assert.match(out.failed.find((f: { key: string }) => f.key === MISMATCH).reason, /don't match the hash/);
		assert.deepEqual([...cloudObjects.keys()].sort(), [KEY_ONE, KEY_PDF, KEY_THREE, KEY_TWO].sort(), 'the keys kept exactly; nothing outside uploads/, nothing failed');
		assert.ok(cloudObjects.get(KEY_ONE)!.body.equals(one));
		assert.deepEqual(uploadAsks.find((a) => a.key === KEY_ONE), { key: KEY_ONE, size: one.length, contentType: 'image/jpeg', sha256: createHash('sha256').update(one).digest('hex'), meta: { w: 1200, h: 800, name: 'Harbour Wall (final).jpg', by: 'aoife@example.com' } });
		assert.deepEqual(uploadAsks.find((a) => a.key === KEY_TWO)!.meta, { w: 640, h: 480, name: 'kiln.png', by: 'Aoife' });
		assert.deepEqual(uploadAsks.find((a) => a.key === KEY_PDF)!.meta, { name: 'prices.pdf', by: 'import' }, 'a file has no w or h');
		assert.ok(!uploadAsks.some((a) => a.key === MISMATCH || a.key === OFF_SHAPE || a.key === KEY_THREE), 'never sent');
		assert.ok(!calls.some((c) => !c.startsWith('GET') && !c.startsWith('HEAD')), 'the source bucket is only read');
		assert.match(r.stderr, /copied uploads\//);

		const again = await media(['push'], { cwd, env: BOTH() });
		const second = JSON.parse(again.stdout);
		assert.deepEqual({ copied: second.copied, skipped: second.skipped, left: second.left }, { copied: 0, skipped: 4, left: 1 });
		assert.equal(uploadAsks.length, 3, 'no upload URL asked the second time');
	});

	test('the first upload_limit stops the run with the cloud\'s sentence and what was copied so far; run again, it resumes', async () => {
		seedSource();
		objects.delete(MISMATCH);
		objects.delete(OFF_SHAPE);
		uploadsLeft = 2;
		const cwd = site('push-cap', {});
		const r = await media(['push'], { cwd, env: BOTH() });
		assert.equal(r.code, 1);
		const out = JSON.parse(r.stdout);
		assert.equal(out.copied, 2);
		assert.equal(out.failed.length, 1);
		assert.equal(out.failed[0].reason, LIMIT);
		assert.ok(r.stderr.includes(LIMIT));
		assert.equal(uploadAsks.length, 3, 'stopped at the first refusal');
		uploadsLeft = Infinity;
		const resumed = await media(['push'], { cwd, env: BOTH() });
		assert.equal(resumed.code, 0, resumed.stderr);
		assert.deepEqual(JSON.parse(resumed.stdout), { copied: 2, skipped: 2, left: 0, failed: [] });
	});

	test('a name slugify keeps from another script is of the shape and goes in', async () => {
		const tokyo = jpeg(300, 200, { salt: 41 });
		const key = `uploads/${hash12(tokyo)}/東京.jpg`;
		objects.set(key, { body: tokyo, headers: { 'content-type': 'image/jpeg', 'x-amz-meta-name': encodeURIComponent('東京.jpg') } });
		const r = await media(['push'], { cwd: site('push-tokyo', {}), env: BOTH() });
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), { copied: 1, skipped: 0, left: 0, failed: [] });
		assert.ok(cloudObjects.has(key));
	});

	test("a Tina site's bucket: its old keys are left, named, and the run ends with nothing failed (exit 0)", async () => {
		const tinaOld = 'uploads/Harbour Wall.jpg';
		const nested = 'uploads/2024/05/kiln-photo.PNG';
		objects.set(tinaOld, { body: one, headers: { 'content-type': 'image/jpeg' } });
		objects.set(nested, { body: two, headers: { 'content-type': 'image/png' } });
		objects.set(KEY_ONE, { body: one, headers: { 'content-type': 'image/jpeg', 'x-amz-meta-name': 'harbour.jpg' } });
		const r = await media(['push'], { cwd: site('push-tina', {}), env: BOTH() });
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), { copied: 1, skipped: 0, left: 2, failed: [] });
		assert.deepEqual([...cloudObjects.keys()], [KEY_ONE], 'only the upload-shaped key is sent');
		assert.ok(r.stderr.includes(`left ${tinaOld}: not of the upload key's shape`));
		assert.ok(r.stderr.includes(`left ${nested}: not of the upload key's shape`));
		assert.match(r.stderr, /Left 2 objects not of the upload key's shape .*: the cloud takes only that shape\./);
		assert.match(r.stderr, /Done: 1 copied, 0 already there, 2 left, 0 failed\./);
	});

	test('it needs both credentials, and takes no arguments', async () => {
		const cwd = site('push-usage', {});
		const noCloud = await media(['push'], { cwd, env: S3_ENV() });
		assert.equal(noCloud.code, 1);
		assert.match(noCloud.stderr, /Missing CARACMS_CLOUD_KEY/);
		const noS3 = await media(['push'], { cwd, env: CLOUD_ENV() });
		assert.equal(noS3.code, 1);
		assert.match(noS3.stderr, /S3_SECRET_ACCESS_KEY/);
		const extra = await media(['push', 'uploads/'], { cwd, env: BOTH() });
		assert.equal(extra.code, 2);
		assert.equal(calls.length + cloudCalls.length, 0, 'nothing sent');
	});
});
