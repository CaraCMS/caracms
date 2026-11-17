// M5b Phase 1: media values (Decision 3), list bounds (Decision 10), the signed URL
// builder (Decision 2), the variables (Decision 5), the loading rule (Decision 4) and
// the brand's logo and icon (Decision 11).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { brandMediaRefusal, list, media, resolveSite, richText, select, text, type SiteConfig } from '../src/config.ts';
import { blockContexts, parseDocumentText, parseSettingsBrand } from '../src/document.ts';
import { brandFrom } from '../src/editor/brand.ts';
import { fieldToJson, fieldWarnings, firstImagePath, parseField, renderValue } from '../src/fields.ts';
import { copyMediaEnv, emptyCloudKeyWarning, MEDIA_ENV_NAMES, virtualModules } from '../src/index.ts';
import {
	IMAGE_WIDTHS,
	MEMORY_MEDIA,
	fixedImage,
	fluidImage,
	imageUrl,
	imageWidths,
	mediaUnsetMessage,
	readMediaConfig,
	signPath,
	thumbnailUrl,
	type MediaSettings,
} from '../src/media.ts';
import { MISSING_ALT_MESSAGE, mediaLine, parseFocal, parseMedia, pickMedia, renderMedia } from '../src/media-value.ts';
import { applyEdits, applyKeyedEdits, fieldText } from '../src/serialize.ts';
import { config, siteRoot, variant } from './helpers/site.ts';

const SETTINGS: MediaSettings = { origin: 'https://img.test', key: MEMORY_MEDIA.key, salt: MEMORY_MEDIA.salt, bucket: 'bucket', memory: true };
const KEY = 'uploads/3f9a1c07b2e4/harbour-wall.jpg';
/** The URL's path after its signature, and checks the signature. */
const unsigned = (url: string, s = SETTINGS) => {
	assert.ok(url.startsWith(`${s.origin}/`), url);
	const rest = url.slice(s.origin.length + 1);
	const sig = rest.slice(0, rest.indexOf('/'));
	const path = rest.slice(sig.length);
	assert.equal(sig, signPath(path, s.key, s.salt), `signed: ${url}`);
	assert.doesNotMatch(url, /unsafe|insecure/);
	return path;
};

const IMAGE = { key: KEY, alt: 'The harbour wall at low tide', focal: [0.4, 0.3], w: 4000, h: 2667 };
const CLIP = { video: 'a4nOgmxGWg6gULfcBbAa00gXyfcwPnAFldF8RdsNyk8M', play: 'loop', poster: 1.5, name: 'The kiln at dusk', duration: 12.4, w: 1920, h: 1080 };

describe('signing (Decision 2)', () => {
	test("imgproxy's documented example: key \"secret\", salt \"hello\"", () => {
		const path = '/rs:fill:300:400:0/g:sm/aHR0cDovL2V4YW1w/bGUuY29tL2ltYWdl/cy9jdXJpb3NpdHku/anBn.png';
		assert.equal(signPath(path, '736563726574', '68656C6C6F'), 'oKfUtW34Dvo2BGQehJFR4Nr0_rIjOtdtzJ3QFsUcXH8');
	});

	test('the same image at the same size is always the same URL; another size or key, another signature', () => {
		assert.equal(imageUrl(SETTINGS, KEY, { width: 640 }), imageUrl(SETTINGS, KEY, { width: 640 }));
		const sig = (u: string) => u.split('/')[3];
		assert.notEqual(sig(imageUrl(SETTINGS, KEY, { width: 640 })), sig(imageUrl(SETTINGS, KEY, { width: 960 })));
		assert.notEqual(sig(imageUrl(SETTINGS, KEY, { width: 640 })), sig(imageUrl({ ...SETTINGS, salt: '00' }, KEY, { width: 640 })));
	});
});

describe('the URL shape (the template\'s tests, signed)', () => {
	test('one side is fit, both are fill; q:80, plain s3 source, @webp', () => {
		assert.equal(unsigned(imageUrl(SETTINGS, KEY, { width: 640 })), `/rs:fit:640:0/q:80/plain/s3://bucket/${KEY}@webp`);
		assert.equal(unsigned(imageUrl(SETTINGS, KEY, { height: 64 })), `/rs:fit:0:64/q:80/plain/s3://bucket/${KEY}@webp`);
		assert.equal(unsigned(imageUrl(SETTINGS, KEY, { width: 960, height: 640 })), `/rs:fill:960:640/q:80/plain/s3://bucket/${KEY}@webp`);
		assert.equal(unsigned(imageUrl(SETTINGS, KEY, { width: 48, height: 48, resize: 'fit' })), `/rs:fit:48:48/q:80/plain/s3://bucket/${KEY}@webp`);
	});

	test('gravity only on a fill with a focal point', () => {
		assert.equal(unsigned(imageUrl(SETTINGS, KEY, { width: 1920, height: 1280, focal: [0.7, 0.5] })), `/rs:fill:1920:1280/g:fp:0.7:0.5/q:80/plain/s3://bucket/${KEY}@webp`);
		assert.doesNotMatch(imageUrl(SETTINGS, KEY, { width: 1920, focal: [0.7, 0.5] }), /g:fp/);
		assert.doesNotMatch(imageUrl(SETTINGS, KEY, { width: 1920, height: 1280 }), /g:fp/);
	});

	test('sides are rounded and capped at 4000; a nonsense side is not set; no side at all throws', () => {
		assert.match(imageUrl(SETTINGS, KEY, { width: 9000 }), /rs:fit:4000:0\//);
		assert.match(imageUrl(SETTINGS, KEY, { width: 640.4, height: Number.NaN }), /rs:fit:640:0\//);
		assert.match(imageUrl(SETTINGS, KEY, { width: -5, height: 300 }), /rs:fit:0:300\//);
		assert.throws(() => imageUrl(SETTINGS, KEY, {}), /needs a width or a height/);
	});

	test('a GIF and an SVG pass through, signed and plain, with no resize and no format, for every option', () => {
		for (const key of ['uploads/a/spin.gif', 'uploads/b/mark.SVG']) {
			for (const options of [{}, { width: 640 }, { width: 640, height: 480, focal: [0.2, 0.2] as [number, number] }]) {
				assert.equal(unsigned(imageUrl(SETTINGS, key, options)), `/plain/s3://bucket/${key}`);
			}
			const fluid = fluidImage(SETTINGS, { key, focal: null, w: 800, h: 1000 }, { sizes: '100vw', ratio: 4 / 5 });
			assert.equal(fluid.srcset, undefined);
			assert.equal(fluid.sizes, undefined);
		}
	});

	test('a fixed GIF or SVG passes through too: one signed plain URL, no srcset, its box kept', () => {
		for (const key of ['uploads/a/spin.gif', 'uploads/b/mark.svg']) {
			const fixed = fixedImage(SETTINGS, { key, focal: [0.2, 0.2], w: 64, h: 32 }, { height: 32 });
			assert.equal(unsigned(fixed.src), `/plain/s3://bucket/${key}`);
			assert.equal(fixed.srcset, undefined);
			assert.deepEqual([fixed.width, fixed.height], [64, 32]);
			const both = fixedImage(SETTINGS, { key, focal: null, w: 64, h: 32 }, { width: 100, height: 100 });
			assert.equal(both.srcset, undefined);
		}
	});

	test('a key is percent-encoded part by part in the source', () => {
		assert.match(imageUrl(SETTINGS, 'uploads/x/a b@2.jpg', { width: 160 }), /\/plain\/s3:\/\/bucket\/uploads\/x\/a%20b%402\.jpg@webp$/);
	});
});

describe('the ladder', () => {
	test('one constant, ascending, topping out at 1920, below the cap; a slot takes a contiguous slice', () => {
		assert.deepEqual(IMAGE_WIDTHS, [160, 320, 480, 640, 960, 1280, 1920]);
		assert.deepEqual(imageWidths(), [...IMAGE_WIDTHS]);
		assert.deepEqual(imageWidths(480, 1280), [480, 640, 960, 1280]);
		assert.throws(() => imageWidths(2000, 3000));
	});

	test('fluid with a ratio: a fill at every rung, holding the ratio, with gravity; width/height scaled to the ratio', () => {
		const out = fluidImage(SETTINGS, { key: KEY, focal: [0.4, 0.3], w: 4000, h: 2667 }, { sizes: '50vw', ratio: 3 / 2 });
		const entries = out.srcset!.split(', ').map((e) => e.split(' '));
		assert.deepEqual(entries.map(([, w]) => w), IMAGE_WIDTHS.map((w) => `${w}w`));
		for (const [url, w] of entries) assert.match(unsigned(url!), new RegExp(`^/rs:fill:${parseInt(w!)}:${Math.round(parseInt(w!) / 1.5)}/g:fp:0.4:0.3/`));
		assert.equal(unsigned(out.src), `/rs:fill:1920:1280/g:fp:0.4:0.3/q:80/plain/s3://bucket/${KEY}@webp`);
		assert.deepEqual([out.width, out.height, out.sizes], [1920, 1280, '50vw']);
	});

	test('fluid with no ratio: fit, natural height; a small original reserves its own size', () => {
		const out = fluidImage(SETTINGS, { key: KEY, focal: [0.4, 0.3], w: 4000, h: 2000 }, { sizes: '100vw' });
		assert.match(out.src, /rs:fit:1920:0\//);
		assert.doesNotMatch(out.srcset!, /g:fp/);
		assert.deepEqual([out.width, out.height], [1920, 960]);
		const small = fluidImage(SETTINGS, { key: KEY, focal: null, w: 800, h: 600 }, { sizes: '100vw' });
		assert.deepEqual([small.width, small.height], [800, 600]);
		const unknown = fluidImage(SETTINGS, { key: KEY, focal: null, w: null, h: null }, { sizes: '100vw' });
		assert.deepEqual([unknown.width, unknown.height], [undefined, undefined]);
	});

	test('fixed: one side is fit at 1×, 2×, 3×; both sides fill; contain is fit at the box', () => {
		const tall = fixedImage(SETTINGS, { key: KEY, focal: null, w: 400, h: 100 }, { height: 32 });
		assert.deepEqual(tall.srcset!.split(', ').map((e) => unsigned(e.split(' ')[0]!).split('/')[1]), ['rs:fit:0:32', 'rs:fit:0:64', 'rs:fit:0:96']);
		assert.deepEqual(tall.srcset!.split(', ').map((e) => e.split(' ')[1]), ['1x', '2x', '3x']);
		assert.deepEqual([tall.width, tall.height, tall.sizes], [128, 32, undefined]);
		const square = fixedImage(SETTINGS, { key: KEY, focal: [0.2, 0.8], w: 400, h: 100 }, { width: 48, height: 48 });
		assert.match(square.src, /rs:fill:48:48\/g:fp:0.2:0.8\//);
		const contain = fixedImage(SETTINGS, { key: KEY, focal: [0.2, 0.8], w: 400, h: 100 }, { width: 48, height: 48, fit: 'contain' });
		assert.match(contain.src, /rs:fit:48:48\/q:80/);
	});

	test('a library thumbnail is a rung of the ladder (Phase 2)', () => {
		assert.equal(unsigned(thumbnailUrl(SETTINGS, KEY)), `/rs:fit:320:0/q:80/plain/s3://bucket/${KEY}@webp`);
	});
});

describe('the variables (Decision 5)', () => {
	test('memory: its own host, key, salt and bucket in dev and tests; refused on a production server', () => {
		const dev = readMediaConfig({ CARACMS_MEDIA: 'memory' }, false);
		assert.equal(dev.kind, 'ready');
		assert.deepEqual(dev.kind === 'ready' && dev.settings, { ...MEMORY_MEDIA, memory: true });
		const prod = readMediaConfig({ CARACMS_MEDIA: 'memory', CARACMS_MEDIA_URL: 'https://img.x', IMGPROXY_KEY: 'aa', IMGPROXY_SALT: 'bb', S3_BUCKET: 'b' }, true);
		assert.equal(prod.kind, 'unset');
		assert.match(prod.kind === 'unset' ? prod.problems[0]! : '', /never uses the in-memory media/);
	});

	test('the real variables, trimmed, the origin without its slash; missing ones named in one sentence', () => {
		const ok = readMediaConfig({ CARACMS_MEDIA_URL: ' https://img.example.com/ ', IMGPROXY_KEY: 'abcd', IMGPROXY_SALT: '01ef', S3_BUCKET: 'media' }, true);
		assert.deepEqual(ok, { kind: 'ready', settings: { origin: 'https://img.example.com', key: 'abcd', salt: '01ef', bucket: 'media', memory: false } });
		const none = readMediaConfig({}, true);
		assert.equal(none.kind, 'unset');
		assert.equal(
			none.kind === 'unset' && mediaUnsetMessage(none),
			"Images can't be built without CARACMS_MEDIA_URL, IMGPROXY_KEY, IMGPROXY_SALT and S3_BUCKET: set them to the site's imgproxy and media bucket.",
		);
		const bad = readMediaConfig({ CARACMS_MEDIA_URL: 'img.example.com', IMGPROXY_KEY: 'not hex', IMGPROXY_SALT: '01', S3_BUCKET: 'b' }, false);
		assert.equal(bad.kind, 'unset');
		assert.equal(bad.kind === 'unset' && bad.problems.length, 2);
	});

	test('the site\'s .env: only Decision 5\'s names are copied, into unset ones only', () => {
		const env: Record<string, string | undefined> = { CARACMS_MEDIA: 'memory', IMGPROXY_KEY: '', S3_BUCKET: 'from-the-environment' };
		const copied = copyMediaEnv(
			{
				CARACMS_MEDIA: 'nope',
				CARACMS_MEDIA_URL: 'https://img.example.com',
				IMGPROXY_KEY: 'aa',
				IMGPROXY_SALT: 'bb',
				S3_BUCKET: 'from-the-file',
				MUX_TOKEN_ID: 'mux',
				GITHUB_APP_ID: '123',
				CARACMS_SECRET: 's',
				REDIS_URL: 'redis://x',
			},
			env,
		);
		assert.deepEqual(copied, ['CARACMS_MEDIA_URL', 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'MUX_TOKEN_ID']);
		assert.deepEqual(env, {
			CARACMS_MEDIA: 'memory',
			IMGPROXY_KEY: 'aa',
			S3_BUCKET: 'from-the-environment',
			CARACMS_MEDIA_URL: 'https://img.example.com',
			IMGPROXY_SALT: 'bb',
			MUX_TOKEN_ID: 'mux',
		});
		assert.deepEqual(copyMediaEnv({ S3_REGION: '' }, {}), [], 'an empty value in the file sets nothing');
		assert.deepEqual([...MEDIA_ENV_NAMES], ['CARACMS_CLOUD_KEY', 'CARACMS_CLOUD_URL', 'CARACMS_MEDIA', 'CARACMS_MEDIA_URL', 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'MUX_TOKEN_ID', 'MUX_TOKEN_SECRET']);
	});

	test("the site's .env: the cloud key's address comes with it, so astro dev and the CLI use the same cloud", () => {
		const env: Record<string, string | undefined> = {};
		const copied = copyMediaEnv({ CARACMS_CLOUD_KEY: 'cck_k', CARACMS_CLOUD_URL: 'https://dev-deployment.convex.site' }, env);
		assert.deepEqual(copied, ['CARACMS_CLOUD_KEY', 'CARACMS_CLOUD_URL']);
		assert.equal(env.CARACMS_CLOUD_URL, 'https://dev-deployment.convex.site');
		const shell: Record<string, string | undefined> = { CARACMS_CLOUD_URL: 'http://127.0.0.1:3211' };
		copyMediaEnv({ CARACMS_CLOUD_URL: 'https://dev-deployment.convex.site' }, shell);
		assert.equal(shell.CARACMS_CLOUD_URL, 'http://127.0.0.1:3211', 'one exported in the shell still wins');
	});

	test('a cloud key set but empty in the env files: one warning naming the file, never on a self-hosted site', () => {
		const root = mkdtempSync(join(tmpdir(), 'caracms-env-'));
		try {
			writeFileSync(join(root, '.env'), 'CARACMS_CLOUD_KEY=ck_real\n');
			writeFileSync(join(root, '.env.development.local'), '# local\nCARACMS_CLOUD_KEY=\n');
			const warning = emptyCloudKeyWarning({ CARACMS_CLOUD_KEY: '' }, {}, null, root, 'development');
			assert.equal(
				warning,
				"CARACMS_CLOUD_KEY is set but empty in .env.development.local, so this site's images, uploads and video from CaraCMS Cloud are off. The usual cause is a .env.*.local file overriding the key in .env: remove the empty line or put the key there.",
			);
			assert.match(emptyCloudKeyWarning({ CARACMS_CLOUD_KEY: '  ' }, {}, 'cloud', root, 'development') ?? '', /set but empty in \.env\.development\.local/, 'whitespace is empty too');
			assert.equal(emptyCloudKeyWarning({ CARACMS_CLOUD_KEY: '' }, {}, 'self-hosted', root, 'development'), null, 'not on a self-hosted site');
			assert.equal(emptyCloudKeyWarning({ CARACMS_CLOUD_KEY: '' }, { CARACMS_CLOUD_KEY: 'ck_env' }, 'cloud', root, 'development'), null, 'a real key in the environment wins');
			assert.equal(emptyCloudKeyWarning({}, {}, 'cloud', root, 'development'), null, 'not set at all is the setup check\'s business');
			assert.equal(emptyCloudKeyWarning({ CARACMS_CLOUD_KEY: 'ck_real' }, {}, 'cloud', root, 'development'), null);
			// Empty from the shell (loadEnv's '' prefix), the files' last line a real key: no file named.
			assert.match(emptyCloudKeyWarning({ CARACMS_CLOUD_KEY: '' }, { CARACMS_CLOUD_KEY: '' }, null, root, 'production') ?? '', /^CARACMS_CLOUD_KEY is set but empty, so/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('the key and salt never reach virtual:caracms/config', () => {
		process.env.IMGPROXY_KEY = 'deadbeefdeadbeef';
		process.env.IMGPROXY_SALT = 'cafebabecafebabe';
		try {
			const site = resolveSite(withMedia, siteRoot);
			const modules = Object.values(virtualModules(site)).join('\n');
			assert.doesNotMatch(modules, /deadbeefdeadbeef|cafebabecafebabe|IMGPROXY/);
		} finally {
			delete process.env.IMGPROXY_KEY;
			delete process.env.IMGPROXY_SALT;
		}
	});
});

describe('media values (Decision 3)', () => {
	test('an image and a clip parse to their stored shape, and write back in its key order', () => {
		assert.deepEqual(parseMedia(IMAGE), IMAGE);
		assert.deepEqual(parseMedia(CLIP), CLIP);
		assert.equal(mediaLine(IMAGE), '{ "key": "uploads/3f9a1c07b2e4/harbour-wall.jpg", "alt": "The harbour wall at low tide", "focal": [0.4, 0.3], "w": 4000, "h": 2667 }');
		assert.equal(mediaLine(CLIP), `{ "video": "${CLIP.video}", "play": "loop", "poster": 1.5, "name": "The kiln at dusk", "duration": 12.4, "w": 1920, "h": 1080 }`);
		// Keys in Decision 3's order, whatever order they're given in.
		assert.equal(mediaLine({ h: 2, w: 1, alt: 'x', key: 'k.jpg' }), '{ "key": "k.jpg", "alt": "x", "w": 1, "h": 2 }');
		// Parsing is idempotent (the serializer's "touched?" test relies on it).
		for (const v of [IMAGE, CLIP, { key: 'a.jpg' }, { video: 'v' }]) assert.deepEqual(parseMedia(parseMedia(v)), parseMedia(v));
	});

	test('alt is always written; decorative only when true, after alt, with alt ""', () => {
		assert.deepEqual(fieldToJson(media(), { key: 'a.jpg' }), { key: 'a.jpg', alt: '' });
		assert.equal(mediaLine({ key: 'a.jpg', alt: 'Kept until edited', decorative: true, w: 3, h: 4 }), '{ "key": "a.jpg", "alt": "", "decorative": true, "w": 3, "h": 4 }');
		assert.equal(mediaLine({ key: 'a.jpg', alt: 'x', decorative: false }), '{ "key": "a.jpg", "alt": "x" }');
		// Read as typed: the alt stays in the parsed value (and so in the file until the field is written).
		assert.equal((parseMedia({ key: 'a.jpg', alt: 'Kept', decorative: true }) as { key: string }).key, 'a.jpg');
		assert.deepEqual(parseMedia({ key: 'a.jpg', alt: 'Kept', decorative: true }), { key: 'a.jpg', alt: 'Kept', decorative: true });
	});

	test('focal: a pair in 0–1, rounded to two places; half a pair, out of range or nonsense is unset', () => {
		assert.deepEqual(parseFocal([0.123, 0.987]), [0.12, 0.99]);
		assert.deepEqual(parseFocal([0, 1]), [0, 1]);
		for (const bad of [[0.5], [0.5, null], [1.2, 0.5], [-0.1, 0.5], ['0.5', 0.5], [0.5, 0.5, 0.5], { x: 0.5, y: 0.5 }, 'centre', null]) assert.equal(parseFocal(bad), undefined, JSON.stringify(bad));
		assert.deepEqual(parseMedia({ key: 'a.jpg', focal: [2, 0.5] }), { key: 'a.jpg', alt: '' });
		assert.equal(fieldWarnings(media(), { key: 'a.jpg', alt: 'x', focal: [2, 0.5] }).length, 0, 'not warned');
	});

	test('anything that isn\'t an object with a string key or video parses empty (and is warned unreadable)', () => {
		for (const raw of [null, 'uploads/a.jpg', 42, [], {}, { key: '' }, { key: 3 }, { video: ' ' }, { src: 'x.jpg' }]) {
			assert.equal(parseMedia(raw), null, JSON.stringify(raw));
			assert.equal(parseField(media(), raw), null);
		}
		assert.deepEqual(fieldWarnings(media(), 'uploads/a.jpg').map((w) => w.code), ['unreadable']);
		assert.deepEqual(fieldWarnings(media(), undefined), []);
		assert.deepEqual(fieldWarnings(media(), null), []);
	});

	test('a clip: play is loop unless it says player; poster, name, duration kept only when sensible', () => {
		assert.deepEqual(parseMedia({ video: 'v', play: 'autoplay', poster: -1, name: '', duration: 0 }), { video: 'v', play: 'loop' });
		assert.deepEqual(parseMedia({ video: 'v', play: 'player' }), { video: 'v', play: 'player' });
	});

	test('picking an image takes the given alt and focal point (none: the centre) and clears decorative; a clip swap keeps play and name and resets the poster', () => {
		assert.deepEqual(pickMedia({ ...IMAGE, decorative: true }, { key: 'uploads/b/new.jpg', w: 10, h: 20 }), { key: 'uploads/b/new.jpg', alt: '', w: 10, h: 20 });
		assert.deepEqual(pickMedia(IMAGE, { key: 'uploads/b/new.jpg', alt: 'Used before' }), { key: 'uploads/b/new.jpg', alt: 'Used before' }, 'the old picture\'s focal point never carries over');
		assert.deepEqual(pickMedia(IMAGE, { key: 'uploads/b/new.jpg', alt: 'Used before', focal: [0.92, 0.33], w: 10, h: 20 }), { key: 'uploads/b/new.jpg', alt: 'Used before', focal: [0.92, 0.33], w: 10, h: 20 });
		assert.deepEqual(pickMedia(IMAGE, { key: 'uploads/b/new.jpg', focal: null }), { key: 'uploads/b/new.jpg', alt: '' });
		assert.deepEqual(Object.keys(pickMedia(null, { key: 'k', alt: 'a', focal: [0.1, 0.2], w: 1, h: 2 })), ['key', 'alt', 'focal', 'w', 'h']);
		assert.deepEqual(pickMedia({ ...CLIP, play: 'player' }, { video: 'other', duration: 3 }), { video: 'other', play: 'player', name: 'The kiln at dusk', duration: 3 });
		assert.deepEqual(pickMedia(IMAGE, { video: 'other' }), { video: 'other', play: 'loop' });
	});
});

describe('the render value', () => {
	test('an image: decorative wins (alt ""), position from the focal point, null without one', () => {
		const r = renderMedia({ key: 'a.jpg', alt: 'Words', decorative: true, focal: [0.4, 0.3], w: 4, h: 5 });
		assert.deepEqual(r, { kind: 'image', key: 'a.jpg', alt: '', decorative: true, focal: [0.4, 0.3], position: '40% 30%', w: 4, h: 5 });
		assert.equal(renderMedia({ key: 'a.jpg', alt: ' Words ' })?.kind === 'image' && (renderMedia({ key: 'a.jpg', alt: ' Words ' }) as { position: null; alt: string }).position, null);
	});

	test('a clip: Mux MP4 and WebP poster at 1920 (time 0 when unset); a loop-only slot forces loop', () => {
		const r = renderValue(media({ play: 'loop' }), { video: 'abc', play: 'player', name: 'N' });
		assert.deepEqual(r, {
			kind: 'video',
			playbackId: 'abc',
			play: 'loop',
			name: 'N',
			mp4: 'https://stream.mux.com/abc/highest.mp4',
			poster: 'https://image.mux.com/abc/thumbnail.webp?width=1920&time=0',
			duration: null,
			w: null,
			h: null,
		});
		assert.equal((renderValue(media(), { video: 'abc', play: 'player', poster: 2.5 }) as { poster: string; play: string }).poster, 'https://image.mux.com/abc/thumbnail.webp?width=1920&time=2.5');
		assert.equal((renderValue(media(), { video: 'abc', play: 'player' }) as { play: string }).play, 'player');
		// Already resolved: taken as is (the loop still forced).
		assert.equal((renderMedia(r, { play: 'loop' }) as { play: string }).play, 'loop');
	});

	test('a kind the slot doesn\'t take is null at render, kept in the value, and warned', () => {
		assert.equal(renderValue(media({ only: 'image' }), CLIP), null);
		assert.equal(renderValue(media({ only: 'video' }), IMAGE), null);
		assert.deepEqual(parseField(media({ only: 'image' }), CLIP), CLIP);
		assert.deepEqual(fieldWarnings(media({ only: 'image' }), CLIP).map((w) => [w.path, w.code]), [['', 'wrong-kind']]);
		assert.deepEqual(fieldWarnings(media({ only: 'video' }), IMAGE).map((w) => w.code), ['wrong-kind']);
		assert.deepEqual(fieldWarnings(media({ only: 'image' }), IMAGE), []);
		assert.equal(renderValue(media(), null), null);
	});
});

describe('the missing alt text (Decision 9)', () => {
	test('an image with an empty alt that isn\'t decorative is warned at its alt, with Decision 9\'s message', () => {
		assert.deepEqual(fieldWarnings(media(), { key: 'a.jpg', alt: '' }), [{ path: 'alt', code: 'missing-alt', message: MISSING_ALT_MESSAGE }]);
		assert.deepEqual(fieldWarnings(media(), { key: 'a.jpg', alt: '   ' }).map((w) => w.code), ['missing-alt']);
		assert.equal(MISSING_ALT_MESSAGE, "No alt text yet: people who can't see the picture get nothing");
	});

	test('decorative is exempt; a clip has none', () => {
		assert.deepEqual(fieldWarnings(media(), { key: 'a.jpg', alt: '', decorative: true }), []);
		assert.deepEqual(fieldWarnings(media(), CLIP), []);
	});

	test('it reads the current value, so it stays after an edit while the alt is still empty (and inside a list)', () => {
		const field = media();
		const edited = parseField(field, { key: 'uploads/b/new.jpg', w: 10, h: 20 });
		assert.deepEqual(fieldWarnings(field, edited).map((w) => w.code), ['missing-alt']);
		const gallery = list(media({ only: 'image' }));
		assert.deepEqual(
			fieldWarnings(gallery, [{ key: 'a.jpg', alt: 'x' }, { key: 'b.jpg', alt: '' }, { key: 'c.jpg', alt: '', decorative: true }], {}, 'images').map((w) => w.path),
			['images.1.alt'],
		);
	});
});

describe('list min and max (Decision 10)', () => {
	const gallery = list(media({ only: 'image' }), { min: 3, max: 9 });
	const images = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}.jpg`, alt: 'x' }));

	test('outside the bounds is warned, never blocked; inside is quiet', () => {
		assert.deepEqual(fieldWarnings(gallery, images(2)).map((w) => [w.code, w.message]), [['too-few', 'This takes at least 3: add 1 more.']]);
		assert.deepEqual(fieldWarnings(gallery, images(10)).map((w) => [w.code, w.message]), [['too-many', 'This takes up to 9: remove 1. Until then they all show.']]);
		assert.deepEqual(fieldWarnings(gallery, images(3)), []);
		assert.deepEqual(fieldWarnings(gallery, images(9)), []);
		assert.deepEqual(fieldWarnings(gallery, undefined).map((w) => w.code), ['too-few']);
		// Every item still renders past max.
		assert.equal((renderValue(gallery, images(10).map((v) => parseField(media(), v))) as unknown[]).length, 10);
	});

	test('the config refuses min above max and bounds that aren\'t whole numbers; a media slot\'s options are checked', () => {
		const withBlock = (field: unknown) => variant({ blocks: { ...config.blocks, g: { component: 'Block.astro', fields: { f: field as never } } } });
		assert.throws(() => resolveSite(withBlock(list(text(), { min: 5, max: 2 })), siteRoot), /min \(5\) is above max \(2\)/);
		assert.throws(() => resolveSite(withBlock(list(text(), { min: 1.5 })), siteRoot), /min must be a whole number/);
		assert.throws(() => resolveSite(withBlock({ kind: 'media', only: 'pdf' }), siteRoot), /only must be 'image' or 'video'/);
		assert.throws(() => resolveSite(withBlock({ kind: 'media', play: 'player' }), siteRoot), /play can only be 'loop'/);
		assert.throws(() => resolveSite(withBlock(media({ only: 'image', play: 'loop' })), siteRoot), /takes images only/);
		assert.doesNotThrow(() => resolveSite(withBlock(gallery), siteRoot));
		assert.doesNotThrow(() => resolveSite(withBlock(list({ caption: text(), image: media() })), siteRoot));
	});
});

const withMedia = variant({
	blocks: {
		...config.blocks,
		tm: { component: 'Block.astro', fields: { body: richText({ headings: ['h2'] }), media: media(), side: select({ options: ['left', 'right'] }) } },
		gallery: { component: 'Block.astro', fields: { heading: text({ heading: true }), images: list(media({ only: 'image' }), { min: 3, max: 9 }) } },
		hero: { component: 'Block.astro', fields: { ...config.blocks.hero.fields, media: media({ play: 'loop' }) } },
	},
}) as SiteConfig;

describe('writing a document with media (byte for byte)', () => {
	const site = resolveSite(withMedia, siteRoot);
	const FILE = `{
  "title": "Visit",
  "blocks": [
    {
      "type": "tm",
      "body": [{ "p": "The studio." }],
      "media": {"alt":"The harbour wall at low tide","key":"uploads/3f9a1c07b2e4/harbour-wall.jpg","focal":[0.4,0.3],"w":4000,"h":2667,"extra":"kept"},
      "side": "left"
    },
    {
      "type": "hero",
      "heading": ["Come"],
      "intro": "",
      "layout": "left",
      "background": "dark",
      "media": { "video": "abc", "play": "player", "poster": 1.5, "name": "Kiln", "duration": 12.4, "w": 1920, "h": 1080 }
    },
    {
      "type": "gallery",
      "heading": "Around",
      "images": [
        { "key": "uploads/a/one.jpg", "alt": "", "w": 1, "h": 2 },
        "not an image",
        { "key": "uploads/c/three.jpg", "alt": "", "decorative": true }
      ]
    },
    {
      "type": "tm",
      "body": [],
      "media": "uploads/nonsense.jpg",
      "side": "right"
    }
  ]
}
`;

	test('untouched, every value (an odd key order, an extra key, a string where an image goes) writes back byte for byte', () => {
		const { document } = parseDocumentText(FILE, site);
		assert.equal(applyEdits(FILE, document, site), FILE);
	});

	test('decorative with alt text in the file: it renders alt "", and the alt text stays in the file until the field is edited', () => {
		const file = '{\n  "title": "Visit",\n  "blocks": [\n    {\n      "type": "tm",\n      "body": [],\n      "media": { "key": "uploads/a/texture.jpg", "alt": "Rough plaster", "decorative": true, "w": 30, "h": 20 },\n      "side": "left"\n    }\n  ]\n}\n';
		const { document } = parseDocumentText(file, site);
		const value = document.blocks[0]!.data.media;
		assert.deepEqual(value, { key: 'uploads/a/texture.jpg', alt: 'Rough plaster', decorative: true, w: 30, h: 20 }, 'read as written');
		const rendered = renderValue(site.blocks.tm!.fields.media!, value) as { alt: string; decorative: boolean };
		assert.equal(rendered.alt, '', 'decorative wins');
		assert.equal(rendered.decorative, true);
		assert.deepEqual(fieldWarnings(site.blocks.tm!.fields.media!, value), [], 'no warning for a decorative image, whatever its alt');
		assert.equal(applyEdits(file, document, site), file, 'untouched: byte for byte, the alt text kept');
		// Another field edited: the media value is left as written.
		const other = structuredClone(document);
		other.blocks[0]!.data.side = 'right';
		assert.ok(applyEdits(file, other, site).includes('"alt": "Rough plaster", "decorative": true'));
		// The field edited: the one-line form writes alt "" (the checkbox empties it).
		const edited = structuredClone(document);
		edited.blocks[0]!.data.media = { ...(value as object), alt: '' };
		assert.ok(applyEdits(file, edited, site).includes('"media": { "key": "uploads/a/texture.jpg", "alt": "", "decorative": true, "w": 30, "h": 20 }'));
	});

	test('editing another field of the block leaves the media value as written', () => {
		const { document } = parseDocumentText(FILE, site);
		const edited = structuredClone(document);
		edited.blocks[0]!.data.side = 'right';
		edited.blocks[3]!.data.side = 'left';
		const out = applyEdits(FILE, edited, site);
		assert.ok(out.includes('"media": {"alt":"The harbour wall at low tide","key":"uploads/3f9a1c07b2e4/harbour-wall.jpg","focal":[0.4,0.3],"w":4000,"h":2667,"extra":"kept"}'));
		assert.ok(out.includes('"media": "uploads/nonsense.jpg"'));
	});

	test('a touched media value takes the one-line form; a touched gallery writes each image on its line', () => {
		const { document } = parseDocumentText(FILE, site);
		const edited = structuredClone(document);
		edited.blocks[0]!.data.media = { ...(edited.blocks[0]!.data.media as object), focal: [0.5, 0.5] };
		edited.blocks[2]!.data.images = [...(edited.blocks[2]!.data.images as unknown[]).filter(Boolean), { key: 'uploads/d/four.jpg', alt: 'Four' }];
		const out = applyEdits(FILE, edited, site);
		assert.ok(out.includes('      "media": { "key": "uploads/3f9a1c07b2e4/harbour-wall.jpg", "alt": "The harbour wall at low tide", "focal": [0.5, 0.5], "w": 4000, "h": 2667 },\n'));
		assert.ok(
			out.includes(
				'      "images": [\n        { "key": "uploads/a/one.jpg", "alt": "", "w": 1, "h": 2 },\n        { "key": "uploads/c/three.jpg", "alt": "", "decorative": true },\n        { "key": "uploads/d/four.jpg", "alt": "Four" }\n      ]\n',
			),
			out,
		);
		// The written text parses back to the same values, and writes back unchanged.
		const again = parseDocumentText(out, site);
		assert.equal(applyEdits(out, again.document, site), out);
		assert.equal(fieldText(media(), again.document.blocks[0]!.data.media, 3), mediaLine(again.document.blocks[0]!.data.media));
	});

	test('the loading rule: eager in the first two rendered blocks; high on the first image of the first rendered block', () => {
		const { document } = parseDocumentText(FILE, site);
		const contexts = blockContexts(document, site, false);
		assert.deepEqual(contexts.map((c) => c && [c.eager, c.priority]), [[true, 'media'], [true, null], [false, null], [false, null]]);
		// An unknown block first doesn't count; a gallery first marks only its first image.
		const unknownFirst = parseDocumentText(FILE.replace('"type": "tm",\n      "body": [{', '"type": "gone",\n      "body": [{'), site).document;
		const c2 = blockContexts(unknownFirst, site, false);
		assert.equal(c2[0], null);
		assert.deepEqual([c2[1]!.eager, c2[1]!.priority, c2[2]!.eager, c2[3]!.eager], [true, null, true, false], 'the hero is first: its clip plays as a loop, no <img>');
		const galleryFields = site.blocks.gallery!.fields;
		assert.equal(firstImagePath(galleryFields, { images: [null, { key: 'b.jpg', alt: '' }] }), 'images.1');
		assert.equal(firstImagePath(galleryFields, { images: [{ video: 'v' }] }), null, 'a clip in an image-only slot shows nothing');
		assert.equal(firstImagePath(site.blocks.tm!.fields, { media: { video: 'v', play: 'player' } }), 'media', "a player's poster is an <img>");
	});
});

describe('the brand\'s logo and icon (Decision 11)', () => {
	const ready = readMediaConfig({ CARACMS_MEDIA: 'memory' }, false);
	const settings = (brand: object) => JSON.stringify({ title: 'Site Settings', brand });

	test('Site Settings holds image-only values with no alt; a clip or nonsense is no image', () => {
		assert.deepEqual(parseSettingsBrand({ name: 'F', accent: '#123', logo: { key: 'uploads/0d/mark.svg', alt: 'ignored', w: 64, h: 64 }, icon: { video: 'v' } }), {
			name: 'F',
			accent: '#123',
			logo: { key: 'uploads/0d/mark.svg', w: 64, h: 64 },
			icon: null,
		});
	});

	test('brandFrom gives the editor signed fixed-mode URLs, never keys; an SVG passes through', () => {
		const brand = brandFrom(settings({ name: 'CaraCMS', accent: '#1f3a2e', logo: { key: 'uploads/0d/mark.png', w: 200, h: 100 }, icon: { key: 'uploads/1e/icon.svg' } }), { brand: { logo: '/old.svg' } }, ready);
		assert.equal(unsigned(brand.logo!, { ...MEMORY_MEDIA, memory: true }), '/rs:fit:0:56/q:80/plain/s3://caracms-test-media/uploads/0d/mark.png@webp');
		assert.equal(unsigned(brand.icon!, { ...MEMORY_MEDIA, memory: true }), '/plain/s3://caracms-test-media/uploads/1e/icon.svg');
	});

	test('what the editor gets holds no key, no salt and no bucket credential, only the signed URLs', () => {
		const KEY_HEX = '5f1c3a9d77b04e2c8a6e91d0c4b7a3f2e8d6c5b4a39281706f5e4d3c2b1a0918';
		const SALT_HEX = 'a7c3e9150b8d2f64e1a9c7b5d3f08e26b4d1a7c9e3f5082d6b4a1c7e9f3d5b02';
		const env = { CARACMS_MEDIA_URL: 'https://img.example.com', IMGPROXY_KEY: KEY_HEX, IMGPROXY_SALT: SALT_HEX, S3_BUCKET: 'real-bucket', S3_ACCESS_KEY_ID: 'AKIAEXAMPLE', S3_SECRET_ACCESS_KEY: 'sekrit-access-value' };
		const real = readMediaConfig(env, false);
		assert.equal(real.kind, 'ready');
		const brand = brandFrom(settings({ name: 'CaraCMS', accent: '#1f3a2e', logo: { key: 'uploads/0d/mark.png', w: 200, h: 100 }, icon: { key: 'uploads/1e/icon.png' } }), { brand: {} }, real);
		assert.match(brand.logo!, /^https:\/\/img\.example\.com\/[A-Za-z0-9_-]{43}\/rs:fit:0:56\//, 'a signed URL on the image host');
		const sent = JSON.stringify(brand);
		for (const secret of [KEY_HEX, SALT_HEX, 'AKIAEXAMPLE', 'sekrit-access-value']) assert.ok(!sent.includes(secret), `the brand the client gets has no ${secret.slice(0, 6)}…`);
		// Nothing on it is a bare key: the logo and icon are URLs.
		for (const value of Object.values(brand)) if (typeof value === 'string' && value.includes('uploads/')) assert.match(value, /^https:\/\//);
		// And an unset config gives the client nothing to sign with either.
		assert.ok(!JSON.stringify(brandFrom(settings({ name: 'F', accent: '#123456', logo: { key: 'uploads/0d/mark.png' } }), { brand: {} }, readMediaConfig({}, false))).includes('uploads/'));
	});

	test('without the media variables, or without a value, there is no Site Settings URL (brandFrom keeps whatever site.brand has, which resolveSite leaves empty)', () => {
		const unset = readMediaConfig({}, false);
		const text = settings({ name: 'CaraCMS', accent: '#1f3a2e', logo: { key: 'uploads/0d/mark.png' } });
		assert.equal(brandFrom(text, { brand: { logo: '/old.svg', icon: '/i.svg' } }, unset).logo, '/old.svg');
		assert.equal(brandFrom(settings({ name: 'F', accent: '#123456' }), { brand: { icon: '/i.svg' } }, ready).icon, '/i.svg');
		assert.equal(brandFrom(settings({ name: 'F', accent: '#123456' }), { brand: {} }, ready).logo, undefined);
	});

	test('Site Settings writes the logo and icon after the name and accent, each on one line; untouched, byte for byte', () => {
		const collection = { kind: 'settings' as const, fields: {} };
		const base = '{\n  "title": "Site Settings",\n  "brand": {"logo":{"key":"uploads/0d/mark.svg"},"name":"CaraCMS","accent":"#1f3a2e"}\n}\n';
		const brand = parseSettingsBrand(JSON.parse(base).brand);
		assert.equal(applyKeyedEdits(base, { title: 'Site Settings', data: { brand } }, collection), base);
		const out = applyKeyedEdits(base, { title: 'Site Settings', data: { brand: { ...brand, icon: { key: 'uploads/1e/icon.png', w: 32, h: 32 } } } }, collection);
		assert.equal(
			out,
			'{\n  "title": "Site Settings",\n  "brand": {\n    "name": "CaraCMS",\n    "accent": "#1f3a2e",\n    "logo": { "key": "uploads/0d/mark.svg" },\n    "icon": { "key": "uploads/1e/icon.png", "w": 32, "h": 32 }\n  }\n}\n',
		);
	});

	test('the config\'s refusal is ready for Phase 4, pointing at Site Settings', () => {
		assert.equal(brandMediaRefusal(undefined), null);
		assert.equal(brandMediaRefusal({}), null);
		assert.match(brandMediaRefusal({ logo: '/l.svg' })!, /^brand\.logo has moved to Site Settings/);
		assert.match(brandMediaRefusal({ icon: '/i.svg' })!, /^brand\.icon has moved to Site Settings/);
	});
});
