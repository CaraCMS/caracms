// caracms-cloud M4.5, the package's half (Decisions 15–17; Acceptance 14–17): a cloud site's
// clips from CARACMS_CLOUD_KEY alone, against a stubbed API (the spec's Contracts). Mux itself
// is never called: any request off the cloud's address fails the test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defineSite, media, resolveSite, text, type SiteConfig } from '../src/config.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { CLOUD_VIDEO_UNREACHABLE, cloudMux } from '../src/editor/server/media/cloud-mux.ts';
import { MEMORY_IN_PRODUCTION, readMuxConfig } from '../src/editor/server/media/config.ts';
import { handleMedia, type MediaContext } from '../src/editor/server/media/handler.ts';
import { MuxRouteError, type Clip } from '../src/editor/server/media/mux.ts';
import type { LibraryClip, MediaClipsResponse, VideoUploadStatus } from '../src/editor/types.ts';
import { readMode } from '../src/live/mode.ts';
import { mediaToJson, pickMedia, renderMedia } from '../src/media-value.ts';

const KEY = `cck_${'v'.repeat(43)}`;
const CLOUD = 'https://cloud.test';
const ENV = { CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: CLOUD };
const LIMIT_SENTENCE = 'This site has reached its video limit in CaraCMS Cloud (60 minutes). Ask CaraCMS to raise it.';
const UNAVAILABLE_SENTENCE = "CaraCMS Cloud couldn't reach Mux just now. Try again in a minute.";
/** A clip from the site's old Mux environment: placed in content, unknown to the cloud. */
const OLD = 'oldEnvPlayback01';

const clip = (n: number, extra: Partial<Clip> = {}): Clip => ({
	id: `asset${n}`,
	playbackId: `play${n}`,
	status: 'ready',
	ready: true,
	errored: false,
	error: null,
	title: `Clip ${n}.mov`,
	duration: 12.5,
	aspectRatio: '16:9',
	w: 1920,
	h: 1080,
	createdAt: `2026-10-2${n}T09:00:00.000Z`,
	...extra,
});

/** The API's video routes (the spec's Contracts), as one fetch. */
class FakeCloud {
	calls: string[] = [];
	bodies: Record<string, unknown>[] = [];
	clips: Clip[] = [clip(2), clip(1, { status: 'preparing', ready: false })];
	uploads = new Map<string, VideoUploadStatus>([['up1', { id: 'up1', status: 'asset_created', assetId: 'asset2', error: null }]]);
	refuse = new Map<string, { status: number; error: string; message: string }>();
	down = false;

	fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const method = init.method ?? 'GET';
		this.calls.push(`${method} ${url.origin === CLOUD ? url.pathname + url.search : url.href}`);
		if (url.origin !== CLOUD) throw new Error(`a request off the cloud: ${url.href}`);
		if (this.down) throw new TypeError('fetch failed');
		if (new Headers(init.headers).get('authorization') !== `Bearer ${KEY}`) return this.no(401, 'unknown_key', 'That key is not one CaraCMS Cloud knows.');
		const refusal = this.refuse.get(url.pathname);
		if (refusal) return this.no(refusal.status, refusal.error, refusal.message);
		const id = url.searchParams.get('id');
		switch (`${method} ${url.pathname}`) {
			case 'POST /v1/video/upload':
				this.bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
				return Response.json({ id: 'up2', url: 'https://storage.googleapis.com/video-storage-us-east1-uploads/up2?Signature=x' });
			case 'GET /v1/video/upload': {
				const u = id ? this.uploads.get(id) : undefined;
				return u ? Response.json(u) : this.no(404, 'not_found', 'There is no such upload.');
			}
			case 'GET /v1/video/clips':
				return Response.json({ clips: this.clips });
			case 'GET /v1/video/clip':
			case 'GET /v1/video/playback': {
				const found = this.clips.find((c) => (url.pathname.endsWith('/clip') ? c.id : c.playbackId) === id);
				return found ? Response.json(found) : this.no(404, 'not_found', 'There is no such clip.');
			}
		}
		return this.no(404, 'not_found', 'No such route.');
	};

	private no(status: number, error: string, message: string) {
		return Response.json({ error, message }, { status, headers: { 'cache-control': 'no-store' } });
	}
}

let fake = new FakeCloud();
beforeEach(() => {
	fake = new FakeCloud();
});

// ── A site on disk: the hero holds a cloud clip; the about page an old one the cloud doesn't hold ──

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const root = mkdtempSync(join(tmpdir(), 'caracms-cloud-video-'));
after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'Block.astro'), '---\n---\n');
const files: Record<string, unknown> = {
	'content/pages/index.json': { title: 'Home', blocks: [{ type: 'hero', heading: 'Hello', media: { video: 'play2', play: 'loop' } }] },
	'content/pages/about.json': {
		title: 'About',
		blocks: [
			{ type: 'hero', heading: 'Old heading', media: { video: OLD, play: 'player', name: 'Kiln at dusk', poster: 2.5, duration: 31.2, w: 1920, h: 1080 } },
			{ type: 'hero', heading: 'Second', media: null },
		],
	},
};
for (const [file, value] of Object.entries(files)) {
	mkdirSync(join(root, file, '..'), { recursive: true });
	writeFileSync(join(root, file), JSON.stringify(value, null, 2) + '\n');
}
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
const store = localDraftsStore(site);
const ctx = (log: (line: string) => void = () => {}, env: Record<string, string> = ENV): MediaContext => ({ site, store, mode: 'local', person: null, env, production: false, log, fetch: fake.fetch as typeof fetch });
const get = (path: string) => new Request(`http://site.test/_caracms/media/${path}`);
const post = (path: string, body: unknown) =>
	new Request(`http://site.test/_caracms/media/${path}`, { method: 'POST', headers: { origin: 'http://site.test', 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the clip routes through the cloud (Acceptance 14)', () => {
	test('with the key and no MUX_TOKEN_*, an upload, its status, the list with where-used, one clip and a playback lookup all go to the cloud', async () => {
		assert.deepEqual(readMuxConfig(ENV, true), { kind: 'cloud', connection: { key: KEY, url: CLOUD } });

		const made = await handleMedia(post('video-upload', { name: 'C:\\clips\\Kiln at dusk.mov' }), ctx());
		assert.equal(made.status, 201, await made.clone().text());
		assert.equal(made.headers.get('cache-control'), 'private, no-store');
		assert.deepEqual(await made.json(), { id: 'up2', url: 'https://storage.googleapis.com/video-storage-us-east1-uploads/up2?Signature=x' });
		assert.deepEqual(fake.bodies, [{ origin: 'http://site.test', title: 'Kiln at dusk.mov' }], 'only the origin and the title: nothing in the request can name a site');

		const status = await handleMedia(get('video-upload/up1'), ctx());
		assert.deepEqual(await status.json(), { id: 'up1', status: 'asset_created', assetId: 'asset2', error: null });

		const list = (await (await handleMedia(get('clips'), ctx())).json()) as MediaClipsResponse;
		assert.deepEqual(list.clips.map((c) => [c.id, c.ready]), [['asset2', true], ['asset1', false]], 'the cloud\'s order, newest first');
		assert.deepEqual(list.clips[0]!.usedIn.map((u) => u.title), ['Home'], 'where-used is the package\'s, by playback id');
		assert.deepEqual(list.clips[0], { ...clip(2), usedIn: list.clips[0]!.usedIn });

		const one = (await (await handleMedia(get('clips/asset1'), ctx())).json()) as LibraryClip;
		assert.deepEqual([one.id, one.status, one.ready, one.usedIn], ['asset1', 'preparing', false, []]);
		const byPlayback = (await (await handleMedia(get('playback/play2'), ctx())).json()) as LibraryClip;
		assert.equal(byPlayback.id, 'asset2');

		assert.deepEqual(fake.calls, [
			'POST /v1/video/upload',
			'GET /v1/video/upload?id=up1',
			'GET /v1/video/clips',
			'GET /v1/video/clip?id=asset1',
			'GET /v1/video/playback?id=play2',
		]);
	});

	test('a bad id never reaches the cloud', async () => {
		for (const path of ['clips/abc-def', 'playback/..%2Fx', `video-upload/${'a'.repeat(129)}`]) {
			assert.equal((await handleMedia(get(path), ctx())).status, 404, path);
		}
		assert.deepEqual(fake.calls, []);
	});
});

describe('the cloud key is the video credential (Decision 15; Acceptance 15)', () => {
	test('the key with either MUX_TOKEN_* is the sentence naming them, in the clip routes and the editor\'s start', async () => {
		const cases: [Record<string, string>, string][] = [
			[{ MUX_TOKEN_ID: 'id' }, 'MUX_TOKEN_ID'],
			[{ MUX_TOKEN_SECRET: 'secret' }, 'MUX_TOKEN_SECRET'],
			[{ MUX_TOKEN_ID: 'id', MUX_TOKEN_SECRET: 'secret' }, 'MUX_TOKEN_ID and MUX_TOKEN_SECRET'],
		];
		for (const [extra, named] of cases) {
			const sentence = `Set CARACMS_CLOUD_KEY or the site's own Mux variables, not both: remove ${named}.`;
			assert.deepEqual(readMuxConfig({ ...ENV, ...extra }, false), { kind: 'unset', message: sentence, missing: [] });
			const res = await handleMedia(get('clips'), ctx(undefined, { ...ENV, ...extra }));
			assert.equal(res.status, 503);
			assert.deepEqual(await res.json(), { error: sentence, code: 'mux-unset', missing: [] });
			const mode = readMode({ ...ENV, ...extra, SITE_URL: 'https://example.com' }, true);
			assert.equal(mode.kind, 'unconfigured');
			if (mode.kind === 'unconfigured') assert.ok(mode.problems.includes(sentence), mode.problems.join(' | '));
		}
		assert.deepEqual(fake.calls, []);
		assert.ok(!JSON.stringify(readMode({ ...ENV, MUX_TOKEN_ID: 'id', CARACMS_MEDIA: 'memory' }, false)).includes('Mux variables'), 'not under the in-memory media');
	});

	test('CARACMS_MEDIA=memory still wins over the key, and is still refused on a production server', () => {
		assert.deepEqual(readMuxConfig({ ...ENV, CARACMS_MEDIA: 'memory' }, false), { kind: 'memory' });
		assert.deepEqual(readMuxConfig({ ...ENV, CARACMS_MEDIA: 'memory' }, true), { kind: 'unset', message: MEMORY_IN_PRODUCTION, missing: [] });
	});

	test('without the key, the site\'s own Mux is as before; a bad cloud address is the mode\'s sentence', () => {
		assert.equal(readMuxConfig({ MUX_TOKEN_ID: 'id', MUX_TOKEN_SECRET: 'secret' }, true).kind, 'mux');
		const bad = readMuxConfig({ ...ENV, CARACMS_CLOUD_URL: 'http://cloud.test' }, true);
		assert.equal(bad.kind, 'unset');
		if (bad.kind === 'unset') assert.match(bad.message, /^CARACMS_CLOUD_URL must be the cloud's https:\/\/ address/);
	});
});

describe('the cloud client maps the cloud\'s refusals (Decision 16; Acceptance 16)', () => {
	const client = (log: (line: string) => void = () => {}) => cloudMux({ key: KEY, url: CLOUD }, { fetch: fake.fetch as typeof fetch, log });
	const refusedWith = async (run: () => Promise<unknown>) => {
		try {
			await run();
		} catch (error) {
			assert.ok(error instanceof MuxRouteError, String(error));
			return [error.status, error.message];
		}
		assert.fail('not refused');
	};

	test('not_found is the routes\' 404; video_limit a 403 with the cloud\'s sentence unchanged; any other refusal a 502 with its message', async () => {
		const logged: string[] = [];
		const c = client((l) => logged.push(l));
		assert.deepEqual(await refusedWith(() => c.clip('assetNone')), [404, 'Not found.']);
		assert.deepEqual(await refusedWith(() => c.clipOfPlayback(OLD)), [404, 'Not found.']);
		assert.deepEqual(await refusedWith(() => c.upload('upNone')), [404, 'Not found.']);

		fake.refuse.set('/v1/video/upload', { status: 403, error: 'video_limit', message: LIMIT_SENTENCE });
		assert.deepEqual(await refusedWith(() => c.createUpload('http://site.test', 'x.mov')), [403, LIMIT_SENTENCE]);

		fake.refuse.set('/v1/video/clips', { status: 502, error: 'video_unavailable', message: UNAVAILABLE_SENTENCE });
		assert.deepEqual(await refusedWith(() => c.clips()), [502, UNAVAILABLE_SENTENCE]);
		fake.refuse.set('/v1/video/clip', { status: 403, error: 'team_off', message: 'This team is switched off in CaraCMS Cloud.' });
		assert.deepEqual(await refusedWith(() => c.clip('asset1')), [502, 'This team is switched off in CaraCMS Cloud.']);
		const revoked = cloudMux({ key: `cck_${'x'.repeat(43)}`, url: CLOUD }, { fetch: fake.fetch as typeof fetch, log: () => {} });
		assert.deepEqual(await refusedWith(() => revoked.clips()), [502, 'That key is not one CaraCMS Cloud knows.']);

		fake.down = true;
		assert.deepEqual(await refusedWith(() => c.clips()), [502, CLOUD_VIDEO_UNREACHABLE]);
		assert.ok(logged.some((l) => l.includes('video_unavailable')) && logged.some((l) => l.includes('unreachable')));
		for (const line of logged) assert.ok(!line.includes(KEY));
	});

	test('through the handler: the limit reaches the editor as the cloud\'s sentence, at 403', async () => {
		fake.refuse.set('/v1/video/upload', { status: 403, error: 'video_limit', message: LIMIT_SENTENCE });
		const full = await handleMedia(post('video-upload', { name: 'one-more.mov' }), ctx());
		assert.equal(full.status, 403);
		assert.deepEqual(await full.json(), { error: LIMIT_SENTENCE });
		const missing = await handleMedia(get('playback/' + OLD), ctx());
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: 'Not found.' });
	});

	test('uploads_in_flight (two clips already uploading) is a 429 with the cloud\'s sentence, not logged as a failure, and reaches the editor as is', async () => {
		const IN_FLIGHT = "Wait for the clips you're uploading to finish, then try again.";
		const logged: string[] = [];
		fake.refuse.set('/v1/video/upload', { status: 429, error: 'uploads_in_flight', message: IN_FLIGHT });
		assert.deepEqual(await refusedWith(() => client((l) => logged.push(l)).createUpload('http://site.test', 'third.mov')), [429, IN_FLIGHT]);
		assert.deepEqual(logged, [], 'the cloud asking to wait is not a cloud error');
		const third = await handleMedia(post('video-upload', { name: 'third.mov' }), ctx());
		assert.equal(third.status, 429);
		assert.deepEqual(await third.json(), { error: IN_FLIGHT });
	});

	test('an answer that isn\'t the shape is a 502 with the package\'s sentence', async () => {
		const odd = cloudMux({ key: KEY, url: CLOUD }, { fetch: (async () => Response.json({ clips: 'no' })) as typeof fetch, log: () => {} });
		assert.deepEqual(await refusedWith(() => odd.clips()), [502, 'CaraCMS Cloud sent an unreadable reply.']);
		const noUrl = cloudMux({ key: KEY, url: CLOUD }, { fetch: (async () => Response.json({ id: 'up' })) as typeof fetch, log: () => {} });
		assert.deepEqual(await refusedWith(() => noUrl.createUpload('http://site.test', 'x.mov')), [502, 'CaraCMS Cloud sent an unreadable reply.']);
	});
});

describe('a placed clip the cloud doesn\'t hold (Decision 17; Acceptance 17)', () => {
	test('it renders from its playback id alone: the MP4 and the poster are Mux\'s, with no lookup', () => {
		const stored = (files['content/pages/about.json'] as { blocks: { media: unknown }[] }).blocks[0]!.media;
		const rendered = renderMedia(stored);
		assert.equal(rendered?.kind, 'video');
		if (rendered?.kind === 'video') {
			assert.equal(rendered.mp4, `https://stream.mux.com/${OLD}/highest.mp4`);
			assert.match(rendered.poster, new RegExp(`^https://image\\.mux\\.com/${OLD}/`));
			assert.equal(rendered.name, 'Kiln at dusk');
		}
		assert.deepEqual(fake.calls, []);
	});

	test('the library lists only the cloud\'s clips, and an unrelated edit to the same document saves its video unchanged', async () => {
		const list = (await (await handleMedia(get('clips'), ctx())).json()) as MediaClipsResponse;
		assert.ok(!list.clips.some((c) => c.playbackId === OLD), 'the cloud doesn\'t hold it');
		const before = JSON.parse(readFileSync(join(root, 'content/pages/about.json'), 'utf8')).blocks[0].media;

		// Edit the heading.
		let opened = await store.read('pages', 'about');
		let document = structuredClone(opened.document) as any;
		document.blocks[0].data.heading = 'New heading';
		await store.write({ file: 'content/pages/about.json', base: opened.text, document });
		let saved = JSON.parse(readFileSync(join(root, 'content/pages/about.json'), 'utf8'));
		assert.equal(saved.blocks[0].heading, 'New heading');
		assert.deepEqual(saved.blocks[0].media, before);

		// Place a cloud clip in the other hero, as the library does.
		opened = await store.read('pages', 'about');
		document = structuredClone(opened.document) as any;
		document.blocks[1].data.media = pickMedia(document.blocks[1].data.media, { video: 'play2', duration: 12.5, w: 1920, h: 1080 });
		await store.write({ file: 'content/pages/about.json', base: opened.text, document });
		saved = JSON.parse(readFileSync(join(root, 'content/pages/about.json'), 'utf8'));
		assert.deepEqual(saved.blocks[0].media, before, 'the old clip is untouched');
		assert.deepEqual(saved.blocks[1].media, mediaToJson({ video: 'play2', play: 'loop', duration: 12.5, w: 1920, h: 1080 }));
	});
});
