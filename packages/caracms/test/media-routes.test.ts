// M5b Phase 2 → Verify 4, served: the media routes on a copy of the demo under `astro dev`,
// in live mode on the in-memory GitHub (CARACMS_GITHUB=memory) with the in-memory bucket
// and fake Mux (CARACMS_MEDIA=memory), never the real ones. Plain HTTP, no browser: the
// guard's prefix rule (401 with no session, 403 for a cross-origin POST) covers every media
// route, and an unconfigured server answers 503 with the sentence.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { MEDIA_NAME_HEADER, type MediaImagesResponse, type MediaUnset, type MediaUploadResponse } from '../src/editor/types.ts';
import { MEDIA_ENV_NAMES } from '../src/index.ts';
import { AOIFE, cookieFor, startLiveSite, type LiveSite } from './helpers/live-site.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 30, 8, 6, 0, 0, 0, 0, 0, 0, 0]);

const ROUTES: [string, string][] = [
	['POST', '/_caracms/media/upload'],
	['GET', '/_caracms/media/images'],
	['GET', '/_caracms/media/thumbnail?key=uploads/aaaaaaaaaaaa/a.jpg'],
	['POST', '/_caracms/media/video-upload'],
	['GET', '/_caracms/media/video-upload/abc123'],
	['GET', '/_caracms/media/clips'],
	['GET', '/_caracms/media/clips/abc123'],
	['GET', '/_caracms/media/playback/abc123'],
];

describe('the media routes, served in live mode', () => {
	let live: LiveSite;
	let origin: string;
	let cookie: string;
	before(async () => {
		live = await startLiveSite('media-routes', { CARACMS_MEDIA: 'memory' });
		origin = live.site.origin;
		const c = cookieFor(live.site, AOIFE);
		cookie = `${c.name}=${c.value}`;
		memoryMedia().reset();
	});
	after(() => live?.close());

	const req = (method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}) =>
		fetch(origin + path, { method, redirect: 'manual', headers: init.headers, body: init.body ?? (method === 'POST' ? '{}' : undefined) });

	test('without a session, every media route answers 401 (the guard\'s prefix rule)', async () => {
		for (const [method, path] of ROUTES) {
			const res = await req(method, path, { headers: { origin } });
			assert.equal(res.status, 401, `${method} ${path}`);
			assert.equal(((await res.json()) as { code: string }).code, 'signed-out');
		}
		assert.equal(memoryMedia().bucket.calls.length + memoryMedia().mux.requests.length, 0);
	});

	test('a cross-origin POST is refused (403) before the session is looked at', async () => {
		for (const path of ['/_caracms/media/upload', '/_caracms/media/video-upload']) {
			const res = await req('POST', path, { headers: { cookie, origin: 'https://evil.test', 'content-type': path === '/_caracms/media/upload' ? 'image/png' : 'application/json' }, body: PNG });
			assert.equal(res.status, 403, path);
			assert.equal(((await res.json()) as { code: string }).code, 'cross-origin');
			// With no Content-Type, Astro's own origin check answers first (403, as plain text): refused either way.
			assert.equal((await req('POST', path, { headers: { cookie, origin: 'https://evil.test' }, body: PNG })).status, 403);
		}
		assert.equal(memoryMedia().bucket.objects.size, 0);
	});

	test('signed in: an upload lands in the library with its uploader, every reply private, no-store', async () => {
		const up = await req('POST', '/_caracms/media/upload', { headers: { cookie, origin, [MEDIA_NAME_HEADER]: encodeURIComponent('Logo mark.png') }, body: PNG });
		assert.equal(up.status, 201, await up.clone().text());
		assert.equal(up.headers.get('cache-control'), 'private, no-store');
		const { image } = (await up.json()) as MediaUploadResponse;
		assert.match(image.key, /^uploads\/[0-9a-f]{12}\/logo-mark\.png$/);
		assert.equal(image.by, AOIFE);
		assert.equal(`${image.w}×${image.h}`, '40×30');
		const list = await req('GET', '/_caracms/media/images', { headers: { cookie } });
		assert.equal(list.status, 200);
		assert.equal(list.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(((await list.json()) as MediaImagesResponse).images.map((i) => i.key), [image.key]);
		const clips = await req('GET', '/_caracms/media/clips', { headers: { cookie } });
		assert.equal(clips.status, 200);
	});

	test('unconfigured: 503 with a sentence naming what\'s missing, images and clips apart', async () => {
		const saved = Object.fromEntries(MEDIA_ENV_NAMES.map((n) => [n, process.env[n]]));
		// Every media variable empty (read per request), so nothing real can be reached either.
		for (const n of MEDIA_ENV_NAMES) process.env[n] = '';
		try {
			const images = await req('GET', '/_caracms/media/images', { headers: { cookie } });
			assert.equal(images.status, 503);
			const body = (await images.json()) as MediaUnset;
			assert.equal(body.code, 'media-unset');
			assert.match(body.error, /^The media library isn't set up here: set CARACMS_MEDIA_URL, IMGPROXY_KEY, IMGPROXY_SALT, S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
			const clips = await req('GET', '/_caracms/media/clips', { headers: { cookie } });
			assert.equal(clips.status, 503);
			assert.equal(((await clips.json()) as MediaUnset).code, 'mux-unset');
			// Only Mux set: clips work (well, would reach Mux), images still don't. Checked without calling anything:
			process.env.MUX_TOKEN_ID = 'x';
			process.env.MUX_TOKEN_SECRET = 'y';
			const stillNoImages = await req('GET', '/_caracms/media/images', { headers: { cookie } });
			assert.equal(stillNoImages.status, 503);
		} finally {
			for (const [n, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[n];
				else process.env[n] = v;
			}
		}
	});
});
