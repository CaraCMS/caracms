// caracms-cloud M3, the package's half (Decisions 19–21; Acceptance 13–16): a cloud site's
// media from CARACMS_CLOUD_KEY alone, against a stubbed API and a stubbed R2 in one fetch.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cloudSettingsForBuild, ensureCloudSettings, resetCloudSettingsRetry, RETRY_MS } from '../src/cloud-middleware.ts';
import { defineSite, media, resolveSite, text, type SiteConfig } from '../src/config.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { BucketError } from '../src/editor/server/media/bucket.ts';
import { cloudBucket } from '../src/editor/server/media/cloud-bucket.ts';
import { readImagesConfig } from '../src/editor/server/media/config.ts';
import { handleMedia, type MediaContext } from '../src/editor/server/media/handler.ts';
import type { MediaUploadResponse } from '../src/editor/types.ts';
import { MEDIA_NAME_HEADER } from '../src/editor/types.ts';
import { CLOUD_NO_MEDIA, CLOUD_UNREACHABLE_BUILD, CloudRefusal, heldCloudSettings, loadCloudSettings, resetCloudSettings } from '../src/live/cloud.ts';
import { readMode } from '../src/live/mode.ts';
import { cloudRepoForStart } from '../src/live/runtime.ts';
import { CLOUD_MEDIA_UNREACHABLE, imageUrl, readMediaConfig, signPath } from '../src/media.ts';

const KEY = `cck_${'a'.repeat(43)}`;
const CLOUD = 'https://cloud.test';
const R2 = 'https://r2.test/caracms-media-dev';
const FOLDER = 'sites/m2b-picker/';
const PAIR = { key: '11'.repeat(32), salt: '22'.repeat(32) };
const ENV = { CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: CLOUD };
const LIMIT_SENTENCE = 'This site has reached its storage limit in CaraCMS Cloud (0.1 GB). Ask CaraCMS to raise it.';
const STORAGE_SENTENCE = "CaraCMS Cloud couldn't reach its storage just now. Try again in a minute.";

interface Stored {
	body: Uint8Array;
	contentType: string;
	headers: Record<string, string>;
	lastModified: string;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The API's media routes (the spec's Contracts) and R2's presigned URLs, as one fetch. */
class FakeCloud {
	objects = new Map<string, Stored>();
	calls: string[] = [];
	pageSize = 1000;
	settings: Record<string, unknown> = {
		site: { name: 'Picker' },
		github: { repo: null },
		folder: FOLDER,
		media: { bucket: 'caracms-media-dev', imageHost: 'imgproxy.example.com', storage: { usedBytes: 0, limitBytes: 5e9 } },
		imgproxy: PAIR,
	};
	/** A refusal for the next calls to a path: `{ status, error, message }`. */
	refuse = new Map<string, { status: number; error: string; message: string }>();
	/** Upload URLs given, with the headers they named. */
	given = new Map<string, Record<string, string>>();
	uploadRequests: Record<string, unknown>[] = [];
	down = false;

	fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const method = init.method ?? 'GET';
		const headers = new Headers(init.headers);
		const body = init.body === undefined || init.body === null ? null : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
		this.calls.push(`${method} ${url.origin === CLOUD ? url.pathname : `r2:${url.pathname}`}`);
		if (this.down) throw new TypeError('fetch failed');
		if (url.origin === CLOUD) return this.api(url, method, headers, body);
		return this.r2(url, method, headers, body);
	};

	private no(status: number, error: string, message: string) {
		return Response.json({ error, message }, { status, headers: { 'cache-control': 'no-store' } });
	}

	private api(url: URL, method: string, headers: Headers, body: Uint8Array | null): Response {
		if (headers.get('authorization') !== `Bearer ${KEY}`) return this.no(401, 'unknown_key', 'That key is not one CaraCMS Cloud knows.');
		const refusal = this.refuse.get(url.pathname);
		if (refusal) return this.no(refusal.status, refusal.error, refusal.message);
		const json = body ? (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>) : {};
		switch (`${method} ${url.pathname}`) {
			case 'GET /v1/settings':
				return Response.json(this.settings);
			case 'GET /v1/media/list': {
				const prefix = url.searchParams.get('prefix') ?? '';
				const after = url.searchParams.get('after');
				const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
				const from = after ? keys.indexOf(after) + 1 : 0;
				const page = keys.slice(from, from + this.pageSize);
				const next = from + this.pageSize < keys.length ? page[page.length - 1]! : null;
				return Response.json({ objects: page.map((key) => ({ key, lastModified: this.objects.get(key)!.lastModified, size: this.objects.get(key)!.body.byteLength })), next });
			}
			case 'GET /v1/media/object': {
				const key = url.searchParams.get('key')!;
				const o = this.objects.get(key);
				if (!o) return this.no(404, 'not_found', 'There is no such file.');
				const h = o.headers;
				const dec = (v: string | undefined) => (v === undefined ? null : decodeURIComponent(v));
				return Response.json({ key, w: h['x-amz-meta-w'] ? Number(h['x-amz-meta-w']) : null, h: h['x-amz-meta-h'] ? Number(h['x-amz-meta-h']) : null, name: dec(h['x-amz-meta-name']), by: dec(h['x-amz-meta-by']), contentType: o.contentType, lastModified: o.lastModified, size: o.body.byteLength });
			}
			case 'POST /v1/media/download-url':
				return Response.json({ url: `${R2}/${FOLDER}${json.key}?X-Amz-Signature=get`, expiresAt: new Date(Date.now() + 300_000).toISOString() });
			case 'POST /v1/media/upload-url': {
				this.uploadRequests.push(json);
				const meta = json.meta as { w?: number; h?: number; name: string; by: string | null };
				const named: Record<string, string> = {
					'Content-Type': String(json.contentType),
					'Content-Length': String(json.size),
					'x-amz-content-sha256': String(json.sha256),
					'If-None-Match': '*',
					...(meta.w !== undefined ? { 'x-amz-meta-w': String(meta.w) } : {}),
					...(meta.h !== undefined ? { 'x-amz-meta-h': String(meta.h) } : {}),
					'x-amz-meta-name': encodeURIComponent(meta.name),
					...(meta.by ? { 'x-amz-meta-by': meta.by } : {}),
				};
				const signed = `${R2}/${FOLDER}${json.key}?X-Amz-Signature=put`;
				this.given.set(signed, named);
				return Response.json({ url: signed, method: 'PUT', headers: named, expiresAt: new Date(Date.now() + 300_000).toISOString() });
			}
		}
		return this.no(404, 'not_found', 'No such route.');
	}

	private r2(url: URL, method: string, headers: Headers, body: Uint8Array | null): Response {
		const path = decodeURIComponent(url.pathname.replace(/^\/caracms-media-dev\//, ''));
		if (!path.startsWith(FOLDER)) return new Response('<Error>AccessDenied</Error>', { status: 403 });
		const key = path.slice(FOLDER.length);
		if (method === 'GET') {
			const o = this.objects.get(key);
			if (!o) return new Response('<Error>NoSuchKey</Error>', { status: 404 });
			return new Response(o.body as BodyInit, { headers: { 'content-length': String(o.body.byteLength), 'content-type': o.contentType } });
		}
		if (method === 'PUT') {
			const named = this.given.get(url.href);
			if (!named || !body) return new Response('<Error>SignatureDoesNotMatch</Error>', { status: 403 });
			for (const [name, value] of Object.entries(named)) {
				if (name === 'Content-Length') continue; // fetch's own
				if (headers.get(name) !== value) return new Response(`<Error>SignatureDoesNotMatch ${name}</Error>`, { status: 403 });
			}
			if (sha256(body) !== named['x-amz-content-sha256'] || String(body.byteLength) !== named['Content-Length']) return new Response('<Error>BadDigest</Error>', { status: 400 });
			if (this.objects.has(key)) return new Response('<Error>PreconditionFailed</Error>', { status: 412 });
			const stored: Record<string, string> = {};
			headers.forEach((v, k) => {
				if (k.startsWith('x-amz-meta-')) stored[k] = v;
			});
			this.objects.set(key, { body, contentType: named['Content-Type']!, headers: stored, lastModified: '2026-10-26T09:00:00.000Z' });
			return new Response(null, { status: 200 });
		}
		return new Response(null, { status: 405 });
	}

	seed(key: string, body: Uint8Array, meta: Record<string, string> = {}, contentType = 'image/jpeg') {
		this.objects.set(key, { body, contentType, headers: meta, lastModified: '2026-10-25T09:00:00.000Z' });
	}
}

const realFetch = globalThis.fetch;
let fake = new FakeCloud();
beforeEach(() => {
	fake = new FakeCloud();
	resetCloudSettings();
	resetCloudSettingsRetry();
	globalThis.fetch = fake.fetch as typeof fetch;
});
after(() => {
	globalThis.fetch = realFetch;
});

/** A JPEG header (SOF0 with the size, a comment to vary the bytes): no pixels, the server never decodes. */
function jpeg(w: number, h: number, salt = 0): Uint8Array {
	return Uint8Array.from([0xff, 0xd8, 0xff, 0xfe, 0, 3, salt & 0xff, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}

describe('the settings, once per process (Decision 20)', () => {
	test('Acceptance 13: after the start fetch, readMediaConfig is the cloud\'s, and an image URL\'s source is s3://<bucket>/sites/<folder>/uploads/…, signed with the site\'s pair', async () => {
		assert.deepEqual(readMediaConfig(ENV), { kind: 'unset', missing: [], problems: ["The site's media settings haven't come from CaraCMS Cloud yet."] }, 'nothing fetched yet');
		await ensureCloudSettings(ENV);
		const config = readMediaConfig(ENV);
		assert.equal(config.kind, 'ready');
		if (config.kind !== 'ready') return;
		assert.deepEqual(config.settings, { origin: 'https://imgproxy.example.com', key: PAIR.key, salt: PAIR.salt, bucket: 'caracms-media-dev', prefix: FOLDER, memory: false });
		const url = imageUrl(config.settings, 'uploads/0123456789ab/harbour wall.jpg', { width: 640, height: 400, focal: [0.3, 0.7] });
		const path = '/rs:fill:640:400/g:fp:0.3:0.7/q:80/plain/s3://caracms-media-dev/sites/m2b-picker/uploads/0123456789ab/harbour%20wall.jpg@webp';
		assert.equal(url, `https://imgproxy.example.com/${signPath(path, PAIR.key, PAIR.salt)}${path}`);
		const svg = imageUrl(config.settings, 'uploads/0123456789ab/mark.svg');
		assert.ok(svg.endsWith('/plain/s3://caracms-media-dev/sites/m2b-picker/uploads/0123456789ab/mark.svg'));
	});

	test('one GET /v1/settings per process: requests at once share it, later ones and the media reuse it', async () => {
		await Promise.all([ensureCloudSettings(ENV), ensureCloudSettings(ENV), ensureCloudSettings(ENV)]);
		await ensureCloudSettings(ENV);
		const held = await loadCloudSettings({ key: KEY, url: CLOUD });
		assert.equal(held.repo, null, 'no repo linked: the media are still ready');
		assert.deepEqual(fake.calls, ['GET /v1/settings']);
	});

	test('the editor\'s start asks again while the held copy has no repo, and reuses the copy once it has one', async () => {
		const connection = { key: KEY, url: CLOUD };
		await assert.rejects(cloudRepoForStart(connection), { error: 'no_repo' });
		assert.deepEqual(fake.calls, ['GET /v1/settings'], 'a first start fetches once');
		await assert.rejects(cloudRepoForStart(connection), { error: 'no_repo' });
		assert.equal(fake.calls.length, 2, 'the held copy has no repo: asked again');
		fake.settings = { ...fake.settings, github: { repo: 'example-org/site' } };
		assert.deepEqual(await cloudRepoForStart(connection), { owner: 'example-org', repo: 'site' });
		assert.equal(fake.calls.length, 3, 'linking the repo is picked up by the next start');
		assert.equal((await loadCloudSettings(connection)).repo, null, 'the held copy is left alone');
		assert.equal(readMediaConfig(ENV).kind, 'ready', 'the media still read the held copy');
		// A held copy with a repo is reused: one request, however many starts.
		resetCloudSettings();
		fake.calls.length = 0;
		await cloudRepoForStart(connection);
		await cloudRepoForStart(connection);
		assert.deepEqual(fake.calls, ['GET /v1/settings']);
	});

	test('no fetch at all off the cloud, under CARACMS_MEDIA=memory, or with the site\'s own media variables beside the key', async () => {
		await ensureCloudSettings({});
		await ensureCloudSettings({ ...ENV, CARACMS_MEDIA: 'memory' });
		await ensureCloudSettings({ ...ENV, S3_BUCKET: 'mine' });
		await cloudSettingsForBuild({ CARACMS_MEDIA: 'memory', CARACMS_CLOUD_KEY: KEY });
		assert.deepEqual(fake.calls, []);
	});

	test('a failed fetch leaves the media unset with the cloud\'s sentence, logged once; requests don\'t wait on another for 30 s, then one tries again', async () => {
		const logged: string[] = [];
		fake.refuse.set('/v1/settings', { status: 403, error: 'team_off', message: 'This site\'s team is switched off in CaraCMS Cloud.' });
		await ensureCloudSettings(ENV, 1_000, (l) => logged.push(l));
		await ensureCloudSettings(ENV, 2_000, (l) => logged.push(l));
		assert.deepEqual(readMediaConfig(ENV), { kind: 'unset', missing: [], problems: ['This site\'s team is switched off in CaraCMS Cloud.'] });
		assert.equal(fake.calls.length, 1, 'the second request inside the window waited on nothing');
		await ensureCloudSettings(ENV, 1_000 + RETRY_MS + 1, (l) => logged.push(l));
		assert.equal(fake.calls.length, 2);
		assert.equal(logged.length, 1, 'the same refusal is logged once');
		assert.match(logged[0]!, /team_off/);
		fake.refuse.clear();
		await ensureCloudSettings(ENV, 1_000 + 2 * RETRY_MS + 2, (l) => logged.push(l));
		assert.equal(readMediaConfig(ENV).kind, 'ready');
		fake.down = true;
		resetCloudSettings();
		await ensureCloudSettings(ENV, 0, (l) => logged.push(l));
		assert.deepEqual(readMediaConfig(ENV), { kind: 'unset', missing: [], problems: [CLOUD_MEDIA_UNREACHABLE] });
		for (const line of logged) assert.ok(!line.includes(PAIR.key) && !line.includes(PAIR.salt) && !line.includes(KEY));
	});

	test('the held copy is for its own key and address only', async () => {
		await ensureCloudSettings(ENV);
		assert.equal(heldCloudSettings({ key: KEY, url: CLOUD })?.kind, 'ready');
		assert.equal(heldCloudSettings({ key: KEY, url: 'https://other.test' }), null);
		assert.equal(readMediaConfig({ ...ENV, CARACMS_CLOUD_URL: 'https://other.test' }).kind, 'unset');
	});
});

describe('the cloud key is the media credential (Decision 19)', () => {
	test('Acceptance 14: the key with any of the site\'s own media variables is the sentence naming them', async () => {
		await ensureCloudSettings(ENV);
		const env = { ...ENV, S3_ENDPOINT: 'https://t3.storageapi.dev', IMGPROXY_SALT: 'aa', CARACMS_MEDIA_URL: 'https://img.example.com' };
		const sentence = "Set CARACMS_CLOUD_KEY or the site's own media variables, not both: remove S3_ENDPOINT, IMGPROXY_SALT and CARACMS_MEDIA_URL.";
		assert.deepEqual(readMediaConfig(env), { kind: 'unset', missing: [], problems: [sentence] });
		assert.deepEqual(readImagesConfig(env, false), { kind: 'unset', message: sentence, missing: [] });
		for (const name of ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'IMGPROXY_KEY']) {
			const one = readMediaConfig({ ...ENV, [name]: 'x' });
			assert.deepEqual(one, { kind: 'unset', missing: [], problems: [`Set CARACMS_CLOUD_KEY or the site's own media variables, not both: remove ${name}.`] });
		}
		await assert.rejects(cloudSettingsForBuild({ ...ENV, S3_BUCKET: 'x' }), { message: "caracms: Set CARACMS_CLOUD_KEY or the site's own media variables, not both: remove S3_BUCKET." });
		// The editor says so too: it's one of the mode's problems (the /admin 503), as M2's GitHub conflicts are.
		const mode = readMode({ ...env, SITE_URL: 'https://example.com' }, true);
		assert.equal(mode.kind, 'unconfigured');
		if (mode.kind === 'unconfigured') assert.ok(mode.problems.includes(sentence), mode.problems.join(' | '));
		assert.ok(!JSON.stringify(readMode({ ...env, CARACMS_MEDIA: 'memory' }, false)).includes('not both'), 'not under the in-memory media');
	});

	test('CARACMS_MEDIA=memory still wins over the key, and is still refused on a production server', () => {
		assert.equal(readImagesConfig({ ...ENV, CARACMS_MEDIA: 'memory' }, false).kind, 'memory');
		assert.equal(readImagesConfig({ ...ENV, CARACMS_MEDIA: 'memory' }, true).kind, 'unset');
	});

	test('the images config is the cloud\'s bucket, with the cloud\'s signing', async () => {
		await ensureCloudSettings(ENV);
		const config = readImagesConfig(ENV, true);
		assert.equal(config.kind, 'cloud');
		if (config.kind === 'cloud') assert.deepEqual(config.connection, { key: KEY, url: CLOUD });
	});
});

describe('the build (Decision 20)', () => {
	test('Acceptance 15: a refused settings fetch fails the build with the cloud\'s sentence; an unreachable cloud with the package\'s', async () => {
		fake.refuse.set('/v1/settings', { status: 401, error: 'revoked_key', message: 'This key was revoked in CaraCMS Cloud. Make a new one in app.caracms.com.' });
		await assert.rejects(cloudSettingsForBuild(ENV), { message: 'caracms: This key was revoked in CaraCMS Cloud. Make a new one in app.caracms.com.' });
		fake.refuse.clear();
		fake.down = true;
		// The build's waits between tries run on a fake clock here; test/cloud-build-retry.test.ts has them.
		let t = 0;
		const retry = { now: () => t, wait: async (ms: number) => void (t += ms), log: () => {} };
		await assert.rejects(cloudSettingsForBuild(ENV, null, retry), { message: `caracms: ${CLOUD_UNREACHABLE_BUILD}` });
		assert.equal(CLOUD_UNREACHABLE_BUILD, "CaraCMS Cloud couldn't be reached, so the site can't be built. Try again in a minute.");
	});

	test('the build ignores github.repo: a site with no repo linked builds, and the pages read the settings it fetched', async () => {
		await cloudSettingsForBuild(ENV);
		assert.equal(readMediaConfig(ENV).kind, 'ready');
		assert.deepEqual(fake.calls, ['GET /v1/settings']);
	});

	test('settings without media fail the build with the package\'s sentence; the editor would still start', async () => {
		fake.settings = { ...fake.settings, github: { repo: 'CaraCodeDev/caracms-git-spike' }, media: { bucket: null, imageHost: 'img.caracms.cloud' } };
		await assert.rejects(cloudSettingsForBuild(ENV), { message: `caracms: ${CLOUD_NO_MEDIA}` });
		const settings = await loadCloudSettings({ key: KEY, url: CLOUD });
		assert.deepEqual(settings.repo, { owner: 'CaraCodeDev', repo: 'caracms-git-spike' });
	});
});

describe('the cloud bucket (Decision 21; Acceptance 16)', () => {
	const bucket = () => cloudBucket({ key: KEY, url: CLOUD }, fake.fetch as typeof fetch);
	const A = 'uploads/aaaaaaaaaaaa/harbour.jpg';
	const B = 'uploads/bbbbbbbbbbbb/kiln.png';
	const C = 'uploads/cccccccccccc/bench.jpg';

	test('list follows the next tokens across pages; first asks for one page', async () => {
		fake.pageSize = 2;
		for (const k of [C, A, B, 'other/x.txt']) fake.seed(k, jpeg(10, 10));
		const listed = await bucket().list('uploads/');
		assert.deepEqual(listed.map((o) => o.key), [A, B, C]);
		assert.deepEqual(listed[0], { key: A, lastModified: '2026-10-25T09:00:00.000Z', size: jpeg(10, 10).byteLength });
		assert.deepEqual(fake.calls, ['GET /v1/media/list', 'GET /v1/media/list']);
		fake.calls.length = 0;
		assert.equal(await bucket().first('uploads/bbbbbbbbbbbb/'), B);
		assert.equal(await bucket().first('uploads/dddddddddddd/'), null);
		assert.deepEqual(fake.calls, ['GET /v1/media/list', 'GET /v1/media/list']);
	});

	test('head is the object route, decoded; not_found is null', async () => {
		fake.seed(A, jpeg(1200, 800), { 'x-amz-meta-w': '1200', 'x-amz-meta-h': '800', 'x-amz-meta-name': encodeURIComponent('Harbour Wall.jpg'), 'x-amz-meta-by': 'aoife@example.com' });
		assert.deepEqual(await bucket().head(A), { w: 1200, h: 800, name: 'Harbour Wall.jpg', by: 'aoife@example.com', contentType: 'image/jpeg', lastModified: '2026-10-25T09:00:00.000Z', size: jpeg(1200, 800).byteLength });
		assert.equal(await bucket().head(B), null);
	});

	test('get streams the bytes through the download URL; a missing key is null', async () => {
		const pdf = new TextEncoder().encode('%PDF-1.7 a price list');
		fake.seed('uploads/dddddddddddd/prices.pdf', pdf, {}, 'application/pdf');
		const got = await bucket().get('uploads/dddddddddddd/prices.pdf');
		assert.ok(got);
		assert.equal(got.size, pdf.byteLength);
		assert.deepEqual(new Uint8Array(await new Response(got.body).arrayBuffer()), pdf);
		assert.deepEqual(fake.calls, ['POST /v1/media/download-url', `GET r2:/caracms-media-dev/${FOLDER}uploads/dddddddddddd/prices.pdf`]);
		assert.equal(await bucket().get('uploads/eeeeeeeeeeee/gone.pdf'), null);
	});

	test('put asks for an upload URL with the key, size, type, hash and metadata, then sends the bytes with exactly its headers', async () => {
		const bytes = jpeg(640, 480, 9);
		await bucket().put({ key: A, body: bytes, contentType: 'image/jpeg', sha256: sha256(bytes), meta: { w: 640, h: 480, name: 'Hárbour.jpg', by: 'Aoife' } });
		assert.deepEqual(fake.uploadRequests, [{ key: A, size: bytes.byteLength, contentType: 'image/jpeg', sha256: sha256(bytes), meta: { w: 640, h: 480, name: 'Hárbour.jpg', by: 'Aoife' } }]);
		const stored = fake.objects.get(A)!;
		assert.deepEqual(stored.body, bytes);
		assert.equal(stored.headers['x-amz-meta-name'], encodeURIComponent('Hárbour.jpg'));
		const file = new TextEncoder().encode('a,b\n1,2\n');
		await bucket().put({ key: 'uploads/ffffffffffff/prices.csv', body: file, contentType: 'text/csv', sha256: sha256(file), meta: { name: 'prices.csv', by: null } });
		assert.deepEqual(fake.uploadRequests[1]!.meta, { name: 'prices.csv', by: null }, 'a file has no w or h');
	});

	test('the cloud\'s refusals go up as sent; an unreachable cloud and the storage\'s own answers are BucketErrors', async () => {
		const bytes = jpeg(10, 10, 3);
		const put = () => bucket().put({ key: A, body: bytes, contentType: 'image/jpeg', sha256: sha256(bytes), meta: { w: 10, h: 10, name: 'a.jpg', by: null } });
		fake.refuse.set('/v1/media/upload-url', { status: 403, error: 'upload_limit', message: LIMIT_SENTENCE });
		await assert.rejects(put(), (e: unknown) => e instanceof CloudRefusal && e.error === 'upload_limit' && e.message === LIMIT_SENTENCE);
		fake.refuse.set('/v1/media/upload-url', { status: 502, error: 'storage_unavailable', message: STORAGE_SENTENCE });
		await assert.rejects(put(), (e: unknown) => e instanceof CloudRefusal && e.message === STORAGE_SENTENCE);
		fake.refuse.clear();
		await put();
		await put(); // R2's 412 (If-None-Match: *) is "already there", not an error
		fake.down = true;
		await assert.rejects(bucket().list('uploads/'), (e: unknown) => e instanceof BucketError && e.status === null && !e.message.includes(KEY));
	});
});

describe('the upload route on a cloud site', () => {
	const root = mkdtempSync(join(tmpdir(), 'caracms-cloud-media-'));
	const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
	writeFileSync(join(root, 'Block.astro'), '---\n---\n');
	after(() => rmSync(root, { recursive: true, force: true }));
	const site = resolveSite(
		defineSite({
			collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } },
			blocks: { hero: { label: 'Hero', component: 'Block.astro', fields: { heading: text({ heading: true }), media: media() } } },
			textStyles: {
				display: {
					family: 'Bricolage Grotesque',
					cssVariable: '--font-display',
					fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') },
					weightRange: '200 800',
					axes: { wght: 700, wdth: 100, opsz: 96 },
					sizePx: 96,
					minSizePx: 28,
					trackingEm: 0.04,
					leading: 1,
				},
			},
			page: 'Block.astro',
		} as unknown as SiteConfig),
		root,
	);
	const ctx = (log: (line: string) => void = () => {}): MediaContext => ({ site, store: localDraftsStore(site), mode: 'local', person: null, env: ENV, production: false, log, fetch: fake.fetch as typeof fetch });
	const upload = (bytes: Uint8Array, name: string) =>
		new Request('http://site.test/_caracms/media/upload', { method: 'POST', headers: { origin: 'http://site.test', [MEDIA_NAME_HEADER]: encodeURIComponent(name), 'content-type': 'image/jpeg' }, body: bytes as BodyInit });

	test('an upload is checked, keyed and deduped as before, and stored through the cloud; the cloud\'s refusal reaches the editor as sent', async () => {
		// The library and its bucket are made once per process, so this test's fake stays the one it talks to.
		const cloud = fake;
		await ensureCloudSettings(ENV);
		const bytes = jpeg(1600, 900, 5);
		const res = await handleMedia(upload(bytes, 'Harbour Wall.JPG'), ctx());
		assert.equal(res.status, 201, await res.clone().text());
		const { image } = (await res.json()) as MediaUploadResponse;
		const key = `uploads/${sha256(bytes).slice(0, 12)}/harbour-wall.jpg`;
		assert.equal(image.key, key);
		assert.deepEqual(cloud.objects.get(key)!.body, bytes);
		assert.match(image.thumbnail ?? '', /\/plain\/s3:\/\/caracms-media-dev\/sites\/m2b-picker\/uploads\//);
		const again = await handleMedia(upload(bytes, 'copy.jpg'), ctx());
		assert.equal(((await again.json()) as MediaUploadResponse).image.key, key, 'the same bytes find the first copy');
		assert.equal(cloud.uploadRequests.length, 1, 'and ask for no upload URL');

		const logged: string[] = [];
		cloud.refuse.set('/v1/media/upload-url', { status: 403, error: 'upload_limit', message: LIMIT_SENTENCE });
		const full = await handleMedia(upload(jpeg(800, 600, 6), 'one-more.jpg'), ctx((l) => logged.push(l)));
		assert.equal(full.status, 502);
		assert.deepEqual(await full.json(), { error: LIMIT_SENTENCE });
		assert.ok(logged.some((l) => l.includes('upload_limit')));
		for (const line of logged) assert.ok(!line.includes(KEY) && !line.includes(PAIR.key) && !line.includes('X-Amz-Signature'));
	});
});
