// M5b Phase 2: the media server (Decisions 6, 7, 9 and 12) on the memory backends
// (`CARACMS_MEDIA=memory`: the in-memory bucket and the fake Mux), never the real bucket
// or Mux. The routes' handler is called directly, in local mode (a site on disk) and in
// live mode (the in-memory GitHub and the Redis stand-in). media-routes.test.ts serves
// the same routes from a dev server, behind the guard.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defineSite, list, media, resolveSite, text, type SiteConfig } from '../src/config.ts';
import { parseDocumentText } from '../src/document.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { missingAltIn } from '../src/editor/server/media/alt.ts';
import { BucketError, MemoryBucket } from '../src/editor/server/media/bucket.ts';
import { readImagesConfig, readMuxConfig } from '../src/editor/server/media/config.ts';
import { handleMedia, type MediaContext } from '../src/editor/server/media/handler.ts';
import { Library, mediaUses } from '../src/editor/server/media/library.ts';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { NEW_ASSET_SETTINGS, planLimitMessage } from '../src/editor/server/media/mux.ts';
import { sniffImage } from '../src/editor/server/media/sniff.ts';
import { readCapped, uploadName } from '../src/editor/server/media/upload.ts';
import type { LibraryClip, LibraryImage, MediaClipsResponse, MediaImagesResponse, MediaUnset, MediaUploadResponse, OpenedDocument, StatusResponse, VideoUploadStatus } from '../src/editor/types.ts';
import { MEDIA_NAME_HEADER } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { IMAGE_WIDTHS, MEMORY_MEDIA, signPath } from '../src/media.ts';

// ── Bytes ─────────────────────────────────────────────────────────────────────

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (...parts: (Uint8Array | number[])[]) => {
	const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
	const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
	let at = 0;
	for (const a of arrays) {
		out.set(a, at);
		at += a.length;
	}
	return out;
};
const u16 = (n: number) => [n >> 8, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A JPEG's headers (no pixels: the server never decodes), `orientation` in an EXIF APP1, `tag` in a comment to vary the bytes. */
function jpeg(w: number, h: number, options: { orientation?: number; tag?: string } = {}): Uint8Array {
	const parts: (Uint8Array | number[])[] = [[0xff, 0xd8]];
	if (options.orientation) {
		const tiff = [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, options.orientation, 0, 0, 0, 0, 0, 0, 0];
		const payload = concat(ascii('Exif\0\0'), tiff);
		parts.push([0xff, 0xe1, ...u16(payload.length + 2)], payload);
	}
	if (options.tag) {
		const c = ascii(options.tag);
		parts.push([0xff, 0xfe, ...u16(c.length + 2)], c);
	}
	parts.push([0xff, 0xc0, 0, 17, 8, ...u16(h), ...u16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
	parts.push([0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 1, 2, 3, 0xff, 0xd9]);
	return concat(...parts);
}

function png(w: number, h: number): Uint8Array {
	return concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32(13), ascii('IHDR'), u32(w), u32(h), [8, 6, 0, 0, 0], u32(0), u32(0), ascii('IEND'), u32(0));
}

const box = (type: string, ...parts: (Uint8Array | number[])[]) => {
	const body = concat(...parts);
	return concat(u32(8 + body.length), ascii(type), body);
};
const fullBox = (type: string, ...parts: (Uint8Array | number[])[]) => box(type, [0, 0, 0, 0], ...parts);

/** A HEIC's boxes: a 320×240 thumbnail item and the 4032×3024 primary, turned a quarter by `irot`. */
function heic(): Uint8Array {
	const ftyp = box('ftyp', ascii('heic'), u32(0), ascii('mif1'), ascii('heic'));
	const ipco = box('ipco', fullBox('ispe', u32(320), u32(240)), fullBox('ispe', u32(4032), u32(3024)), box('irot', [1]));
	const ipma = fullBox('ipma', u32(2), u16(1), [2, 0x82, 0x83], u16(2), [1, 0x81]);
	const meta = fullBox('meta', fullBox('hdlr', u32(0), ascii('pict'), new Uint8Array(13)), fullBox('pitm', u16(1)), box('iprp', ipco, ipma));
	return concat(ftyp, meta, box('mdat', ascii('not really hevc')));
}

const svg = (attrs: string) => new TextEncoder().encode(`<?xml version="1.0"?>\n<!-- a mark -->\n<!DOCTYPE svg [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]>\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><path d="M0 0h1"/></svg>\n`);

// ── A site ────────────────────────────────────────────────────────────────────

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'caracms-media-'));
after(() => rmSync(root, { recursive: true, force: true }));

const A = 'uploads/aaaaaaaaaaaa/harbour.jpg';
const B = 'uploads/bbbbbbbbbbbb/kiln.png';
const D = 'uploads/dddddddddddd/bench.jpg';
const E = 'uploads/eeeeeeeeeeee/shopfront.jpg';
const LOGO = 'uploads/111111111111/mark.svg';

const files: Record<string, unknown> = {
	'content/pages/index.json': {
		title: 'Home',
		blocks: [
			{ type: 'hero', heading: 'Hello', media: { key: A, alt: 'The harbour wall', w: 4000, h: 2667 } },
			{ type: 'carousel', images: [{ key: D, alt: '' }] },
		],
	},
	'content/pages/about.json': {
		title: 'About',
		blocks: [
			{ type: 'tm', body: 'Above the harbour', media: { video: 'pbReady0001', play: 'loop' } },
			{
				type: 'gallery',
				heading: 'Around the studio',
				images: [
					{ key: A, alt: '', focal: [0.92, 0.33] },
					{ key: B, alt: '', decorative: true, focal: [0.1, 0.9] },
					{ key: D, alt: '' },
				],
			},
			{ shared: 'footer' },
		],
	},
	'content/case-studies/harbour.json': { title: 'High-street coffee roaster', cover: { key: E, alt: '' }, summary: 'A shop' },
	'content/case-studies/wheels.json': { title: 'Weekend bike shop', cover: { key: E, alt: 'The shop at dusk' }, summary: 'Bikes' },
	'content/shared/footer.json': { title: 'Footer', block: { type: 'tm', body: 'Bye', media: { key: D, alt: '', focal: [0.5, 0.2] } } },
	'content/site-settings.json': { title: 'Site Settings', editors: ['aoife@example.com'], brand: { name: 'CaraCMS', accent: '#1f3a2e', logo: { key: LOGO, w: 32, h: 32 } } },
};
for (const [file, value] of Object.entries(files)) {
	mkdirSync(join(root, file, '..'), { recursive: true });
	writeFileSync(join(root, file), JSON.stringify(value, null, 2) + '\n');
}
writeFileSync(join(root, 'Block.astro'), '---\n---\n');

const display = {
	family: 'Bricolage Grotesque',
	cssVariable: '--font-display',
	fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') },
	weightRange: '200 800',
	axes: { wght: 700, wdth: 100, opsz: 96 },
	sizePx: 96,
	minSizePx: 28,
	trackingEm: 0.04,
	leading: 1,
	textTransform: 'uppercase',
} as const;

const site = resolveSite(
	defineSite({
		repoPath: 'starter',
		collections: {
			pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
			'case-studies': { kind: 'fields', folder: 'content/case-studies', urlBase: '/work/', component: 'Block.astro', fields: { cover: media({ only: 'image', label: 'Cover image' }), summary: text() } },
		},
		blocks: {
			hero: { label: 'Hero', component: 'Block.astro', fields: { heading: text({ heading: true }), media: media({ play: 'loop' }) } },
			tm: { label: 'Text and media', component: 'Block.astro', fields: { body: text({ multiline: true }), media: media() } },
			gallery: { label: 'Gallery', component: 'Block.astro', fields: { heading: text(), images: list(media({ only: 'image' }), { min: 3, max: 9 }) } },
		},
		textStyles: { display },
		page: 'Block.astro',
	} as SiteConfig),
	root,
);

const ORIGIN = 'http://site.test';
const MEMORY = { CARACMS_MEDIA: 'memory' };
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const mem = memoryMedia();
beforeEach(() => mem.reset());

const local = (env: Record<string, string> = MEMORY, extra: Partial<MediaContext> = {}): MediaContext => ({ site, store: localDraftsStore(site), mode: 'local', person: null, env, production: false, log: () => {}, ...extra });

function request(path: string, init: { method?: string; body?: BodyInit | null; headers?: Record<string, string>; origin?: string | null } = {}): Request {
	const headers: Record<string, string> = { ...init.headers };
	if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
	return new Request(`${ORIGIN}/_caracms/media/${path}`, { method: init.method ?? (init.body ? 'POST' : 'GET'), headers, body: init.body ?? null });
}
const upload = (bytes: Uint8Array, name: string, init: { headers?: Record<string, string>; origin?: string | null } = {}) =>
	request('upload', { body: bytes as BodyInit, headers: { [MEDIA_NAME_HEADER]: encodeURIComponent(name), 'content-type': 'image/jpeg', ...init.headers }, origin: init.origin });

async function call<T>(req: Request, ctx: MediaContext = local()): Promise<{ status: number; body: T; res: Response }> {
	const res = await handleMedia(req, ctx);
	const text = await res.text();
	return { status: res.status, body: (text ? JSON.parse(text) : null) as T, res };
}

// ── Sniffing (Decision 6: by the bytes) ───────────────────────────────────────

describe('the type and the size come from the bytes', () => {
	test('each type the library takes, with its pixel size', () => {
		assert.deepEqual(sniffImage(jpeg(400, 300)), { ok: true, format: 'jpeg', ext: 'jpg', mime: 'image/jpeg', w: 400, h: 300 });
		assert.deepEqual(sniffImage(png(64, 48)), { ok: true, format: 'png', ext: 'png', mime: 'image/png', w: 64, h: 48 });
		assert.deepEqual(sniffImage(concat(ascii('GIF89a'), [0x20, 0x03, 0xe8, 0x03], new Uint8Array(8))), { ok: true, format: 'gif', ext: 'gif', mime: 'image/gif', w: 800, h: 1000 });
		const vp8x = concat(ascii('RIFF'), u32(0), ascii('WEBPVP8X'), [10, 0, 0, 0, 0, 0, 0, 0], [0x7f, 0x07, 0x00], [0x37, 0x04, 0x00]);
		assert.deepEqual(sniffImage(vp8x), { ok: true, format: 'webp', ext: 'webp', mime: 'image/webp', w: 1920, h: 1080 });
		const avif = concat(box('ftyp', ascii('avif'), u32(0), ascii('mif1'), ascii('avif')), fullBox('meta', fullBox('pitm', u16(1)), box('iprp', box('ipco', fullBox('ispe', u32(1200), u32(800))), fullBox('ipma', u32(1), u16(1), [1, 0x81]))));
		assert.deepEqual(sniffImage(avif), { ok: true, format: 'avif', ext: 'avif', mime: 'image/avif', w: 1200, h: 800 });
		assert.deepEqual(sniffImage(svg('viewBox="0 0 32 24"')), { ok: true, format: 'svg', ext: 'svg', mime: 'image/svg+xml', w: 32, h: 24 }, 'the doctype and its entity are skipped, never resolved');
		assert.deepEqual(sniffImage(svg('width="120px" height="40"')), { ok: true, format: 'svg', ext: 'svg', mime: 'image/svg+xml', w: 120, h: 40 });
	});

	test('Verify 1: EXIF orientation 6 swaps w and h; a HEIC is sized from its primary item, turned by irot', () => {
		const turned = sniffImage(jpeg(4000, 3000, { orientation: 6 }));
		assert.equal(turned.ok && `${turned.w}×${turned.h}`, '3000×4000');
		const upright = sniffImage(jpeg(4000, 3000, { orientation: 3 }));
		assert.equal(upright.ok && `${upright.w}×${upright.h}`, '4000×3000', 'a half turn keeps the shape');
		const h = sniffImage(heic());
		assert.equal(h.ok && `${h.format} ${h.w}×${h.h}`, 'heic 3024×4032', 'the primary item, not the thumbnail; irot 90° swaps');
	});

	test('what the bytes can name is refused with Decision 6\'s sentence; what they can\'t, with the other', () => {
		const pdf = sniffImage(ascii('%PDF-1.7\n%âãÏÓ\n1 0 obj'));
		assert.deepEqual(pdf, { ok: false, code: 'not-an-image', message: 'This is a PDF. The library takes images (JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG) and files (PDF, Word, Excel, PowerPoint, CSV or Zip).' }, 'the image sniffer alone; sniffUpload takes it as a file');
		const mp4 = sniffImage(box('ftyp', ascii('isom'), u32(512), ascii('isomiso2avc1mp41')));
		assert.equal(!mp4.ok && mp4.message, 'This is a video. The library takes images (JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG) and files (PDF, Word, Excel, PowerPoint, CSV or Zip).');
		assert.equal(!sniffImage(ascii('just some text')).ok && (sniffImage(ascii('just some text')) as { message: string }).message, "This file isn't one the library can take. It takes images (JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG) and files (PDF, Word, Excel, PowerPoint, CSV or Zip).");
		assert.equal((sniffImage(new TextEncoder().encode('<?xml version="1.0"?><note/>')) as { code: string }).code, 'unknown-type', 'XML that isn\'t an SVG');
		assert.equal((sniffImage(svg('')) as { code: string }).code, 'no-size');
		assert.equal((sniffImage(jpeg(400, 300).subarray(0, 6)) as { code: string }).code, 'unknown-type', 'a truncated JPEG reads as no image, never a throw');
	});
});

// ── Upload (Decision 6) ───────────────────────────────────────────────────────

describe('POST /_caracms/media/upload', () => {
	test('Verify 1: a JPEG with EXIF orientation 6 is stored with w and h swapped, under the key rule, with its metadata', async () => {
		const bytes = jpeg(4000, 3000, { orientation: 6 });
		const r = await call<MediaUploadResponse>(upload(bytes, 'Harbour Wall (final).JPG'));
		assert.equal(r.status, 201);
		assert.equal(r.res.headers.get('cache-control'), 'private, no-store');
		const { image, created } = r.body;
		assert.equal(created, true);
		const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
		assert.equal(image.key, `uploads/${hash}/harbour-wall-final.jpg`);
		assert.equal(`${image.w}×${image.h}`, '3000×4000');
		assert.equal(image.name, 'Harbour Wall (final).JPG');
		assert.equal(image.by, null, 'local mode has no sign-in, so no `by`');
		assert.deepEqual(image.usedIn, []);
		const stored = mem.bucket.objects.get(image.key)!;
		assert.deepEqual({ w: stored.meta.w, h: stored.meta.h, name: stored.meta.name, by: stored.meta.by, type: stored.meta.contentType }, { w: 3000, h: 4000, name: 'Harbour Wall (final).JPG', by: null, type: 'image/jpeg' });
		assert.deepEqual(mem.bucket.calls.slice(0, 2), [`first:uploads/${hash}/`, `put:${image.key}`], 'existence is checked before the write');
	});

	test('Verify 2: a program named .jpg is refused with the sentence, and nothing is written (M6c: a PDF is a file now)', async () => {
		const r = await call<{ error: string; code: string }>(upload(ascii('MZ\x90\x00\x03\x00'), 'photo.jpg'));
		assert.equal(r.status, 415);
		assert.deepEqual(r.body, { error: 'This is a program. The library takes images (JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG) and files (PDF, Word, Excel, PowerPoint, CSV or Zip).', code: 'not-an-image' });
		assert.equal(mem.bucket.objects.size, 0);
	});

	test('Verify 2: 41 MB is refused, from the Content-Length before a byte is read, and by the read itself without one', async () => {
		const said = await call<{ error: string; code: string }>(upload(jpeg(10, 10), 'big.jpg', { headers: { 'content-length': '41000000' } }));
		assert.equal(said.status, 413);
		assert.equal(said.body.error, 'This file is 41 MB. The library takes up to 40 MB.');

		// No Content-Length (a chunked body): the read stops as soon as it passes 40 MB.
		let pulled = 0;
		let cancelled = false;
		const chunk = new Uint8Array(1_000_000);
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				if (pulled > 100) controller.close();
				else controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		const req = new Request(`${ORIGIN}/_caracms/media/upload`, { method: 'POST', body: stream, headers: { origin: ORIGIN }, duplex: 'half' } as RequestInit);
		const r = await call<{ error: string }>(req);
		assert.equal(r.status, 413);
		assert.equal(r.body.error, 'This file is over 40 MB. The library takes up to 40 MB.');
		assert.ok(pulled <= 43, `stopped early (${pulled} MB pulled, of 100)`);
		assert.ok(cancelled, 'the rest of the body is cancelled');
		assert.equal(mem.bucket.objects.size, 0);
	});

	test('readCapped keeps a body at the cap and refuses one byte over', async () => {
		const at = await readCapped(new Request(ORIGIN, { method: 'POST', body: new Uint8Array(10) }), 10);
		assert.equal(at.ok && at.bytes.byteLength, 10);
		const over = await readCapped(new Request(ORIGIN, { method: 'POST', body: new Uint8Array(11) }), 10);
		assert.equal(over.ok, false);
	});

	test('Verify 2: a 60-megapixel PNG is refused with the sentence', async () => {
		const r = await call<{ error: string; code: string }>(upload(png(10000, 6000), 'huge.png'));
		assert.equal(r.status, 422);
		assert.deepEqual(r.body, { error: 'This image is 60 megapixels. The library takes up to 50.', code: 'too-many-pixels' });
		const edge = await call<{ error: string }>(upload(png(7072, 7072), 'edge.png'));
		assert.equal(edge.body.error, 'This image is 50.1 megapixels. The library takes up to 50.', 'just over never reads as allowed');
		assert.equal((await call(upload(svg('viewBox="0 0 20000 20000"'), 'big.svg'))).status, 201, 'an SVG has no pixels to count');
	});

	test('Verify 3: the same bytes twice under two names give one object; the second gets the first\'s key and writes nothing', async () => {
		const bytes = jpeg(1200, 800, { tag: 'same' });
		const first = await call<MediaUploadResponse>(upload(bytes, 'Kiln.jpg'));
		const second = await call<MediaUploadResponse>(upload(bytes, 'another name.jpeg'));
		assert.equal(first.status, 201);
		assert.equal(second.status, 200);
		assert.equal(second.body.created, false);
		assert.equal(second.body.image.key, first.body.image.key);
		assert.equal(second.body.image.name, 'Kiln.jpg', 'the stored object, whatever this one was called');
		assert.equal(mem.bucket.objects.size, 1);
		assert.equal(mem.bucket.calls.filter((c) => c.startsWith('put:')).length, 1);
		// At the same time, in one process: still one object.
		const bytes2 = jpeg(1200, 800, { tag: 'race' });
		const [x, y] = await Promise.all([call<MediaUploadResponse>(upload(bytes2, 'a.jpg')), call<MediaUploadResponse>(upload(bytes2, 'b.jpg'))]);
		assert.equal(x.body.image.key, y.body.image.key);
		assert.deepEqual([x.body.created, y.body.created].sort(), [false, true]);
	});

	test('Verify 3: a HEIC named photo.jpg is stored as .heic, sized as shown', async () => {
		const r = await call<MediaUploadResponse>(upload(heic(), 'photo.jpg'));
		assert.equal(r.status, 201);
		assert.match(r.body.image.key, /^uploads\/[0-9a-f]{12}\/photo\.heic$/);
		assert.equal(`${r.body.image.w}×${r.body.image.h}`, '3024×4032');
		assert.equal(mem.bucket.objects.get(r.body.image.key)!.meta.contentType, 'image/heic');
		assert.match(r.body.image.thumbnail, /\/rs:fit:320:0\/q:80\/plain\/s3:\/\/caracms-test-media\/uploads\/[0-9a-f]{12}\/photo\.heic@webp$/, 'the thumbnail is always imgproxy\'s WebP (Chrome can\'t show a HEIC)');
	});

	test('a bucket that answers with a 4xx refusal says so, one that cannot be reached says it did not answer; neither shows the bucket\'s own words', async () => {
		const logged: string[] = [];
		const put = mem.bucket.put.bind(mem.bucket);
		try {
			mem.bucket.put = async () => {
				throw new BucketError('put: 403 AccessDenied: secret-bucket-detail', 403);
			};
			const refused = await call<{ error: string }>(upload(jpeg(900, 600, { tag: 'refused' }), 'a.jpg'), local(MEMORY, { log: (m: string) => logged.push(m) }));
			assert.equal(refused.status, 502);
			assert.equal(refused.body.error, 'The media bucket refused that, so nothing was stored.');
			mem.bucket.put = async () => {
				throw new BucketError('put: ECONNRESET secret-bucket-detail', null);
			};
			const down = await call<{ error: string }>(upload(jpeg(900, 600, { tag: 'down' }), 'b.jpg'), local(MEMORY, { log: (m: string) => logged.push(m) }));
			assert.equal(down.status, 502);
			assert.match(down.body.error, /^The media bucket didn't answer, so nothing was stored\./);
			mem.bucket.put = async () => {
				throw new BucketError('put: 503 SlowDown', 503);
			};
			const slow = await call<{ error: string }>(upload(jpeg(900, 600, { tag: 'slow' }), 'c.jpg'), local(MEMORY, { log: (m: string) => logged.push(m) }));
			assert.match(slow.body.error, /didn't answer/, 'a 5xx is the bucket being down, not a refusal');
			for (const r of [refused, down, slow]) assert.doesNotMatch(JSON.stringify(r.body), /secret-bucket-detail|AccessDenied|ECONNRESET/);
			assert.equal(logged.filter((m) => m.includes('secret-bucket-detail')).length, 2, 'the bucket\'s words go to the server log');
		} finally {
			mem.bucket.put = put;
		}
		assert.equal(mem.bucket.objects.size, 0, 'nothing was stored');
	});

	test('an object already under the hash is the answer even when its metadata cannot be read, and nothing is written', async () => {
		const bytes = jpeg(640, 480, { tag: 'unreadable' });
		const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
		const old = `uploads/${hash}/old-name.jpg`;
		mem.bucket.seed(old, { w: 1, h: 1, name: 'Old name.jpg' });
		const head = mem.bucket.head.bind(mem.bucket);
		mem.bucket.head = async () => null;
		try {
			const r = await call<MediaUploadResponse>(upload(bytes, 'new-name.jpg'));
			assert.equal(r.status, 200);
			assert.equal(r.body.created, false);
			assert.equal(r.body.image.key, old);
		} finally {
			mem.bucket.head = head;
		}
		assert.equal(mem.bucket.calls.filter((c) => c.startsWith('put:')).length, 0);
		assert.equal(mem.bucket.objects.size, 1);
	});

	test('a name that slugifies to nothing is "image"; a path in the name is dropped', async () => {
		const r = await call<MediaUploadResponse>(upload(png(10, 10), 'C:\\fakepath\\###.png'));
		assert.match(r.body.image.key, /\/image\.png$/);
		assert.equal(r.body.image.name, '###.png');
	});

	test('the upload response is the library entry, with where it\'s used and an alt text already used', async () => {
		const bytes = jpeg(4000, 2667, { tag: 'placed already' });
		const key = `uploads/${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}/harbour.jpg`;
		// A store whose one page already names this key (as if placed from another place the site runs).
		const page = { title: 'Visit', blocks: [{ type: 'tm', media: { key, alt: 'Already written' } }] };
		const base = localDraftsStore(site);
		const store = {
			...base,
			list: async () => [{ collection: 'pages', kind: 'sections' as const, path: 'visit', file: 'content/pages/visit.json', url: '/visit', title: 'Visit', label: 'Visit', warning: null, mtimeMs: 0 }],
			source: async () => ({ readText: async () => JSON.stringify(page), listJson: async () => [] }),
		};
		const r = await call<MediaUploadResponse>(upload(bytes, 'harbour.jpg'), local(MEMORY, { store }));
		assert.equal(r.body.image.key, key);
		assert.deepEqual(r.body.image.usedIn, [{ collection: 'pages', path: 'visit', title: 'Visit' }]);
		assert.equal(r.body.image.alt, 'Already written', 'picking it fills the slot\'s alt with this');
	});
});

// ── The library (Decision 7) ──────────────────────────────────────────────────

describe('GET /_caracms/media/images', () => {
	test('newest first, with where-used (unknown blocks and the brand count), the first alt text, and signed thumbnails', async () => {
		mem.bucket.seed(A, { w: 4000, h: 2667, name: 'Harbour.jpg', by: 'setup', uploadedAt: '2026-10-14T09:00:00Z' });
		mem.bucket.seed(B, { w: 800, h: 600, name: 'Kiln.png', uploadedAt: '2026-10-16T09:00:00Z' });
		mem.bucket.seed(D, { w: 3000, h: 4000, uploadedAt: '2026-10-15T09:00:00Z' });
		mem.bucket.seed('uploads/ffffffffffff/unused.jpg', { w: 10, h: 10, uploadedAt: '2026-10-13T09:00:00Z' });
		mem.bucket.seed('uploads/ffffffffffff/notes.txt', {}); // not an image key: left out
		const r = await call<MediaImagesResponse>(request('images'));
		assert.equal(r.status, 200);
		assert.equal(r.res.headers.get('cache-control'), 'private, no-store');
		const byKey = Object.fromEntries(r.body.images.map((i) => [i.key, i]));
		assert.deepEqual(r.body.images.map((i) => i.key), [B, D, A, 'uploads/ffffffffffff/unused.jpg']);
		assert.deepEqual(byKey[A]!.usedIn.map((u) => u.title), ['Home', 'About'], 'the listing\'s order: Home first');
		assert.equal(byKey[A]!.alt, 'The harbour wall', 'the first non-empty alt text');
		assert.deepEqual(byKey[A]!.focal, [0.92, 0.33], 'the first focal point, though its use has no alt (Home\'s has the alt and no focal point)');
		assert.deepEqual(byKey[B]!.focal, [0.1, 0.9], 'a decorative use\'s focal point is offered');
		assert.equal(byKey[A]!.by, 'setup');
		assert.deepEqual(byKey[B]!.usedIn.map((u) => u.title), ['About'], 'a decorative image is used');
		assert.equal(byKey[B]!.alt, null, 'a decorative image\'s alt is never offered');
		assert.deepEqual(byKey[D]!.usedIn.map((u) => u.title).sort(), ['About', 'Footer', 'Home'], 'an unknown block and a shared block still name it');
		assert.deepEqual(byKey[D]!.focal, [0.5, 0.2], 'a shared block\'s focal point counts');
		assert.equal(byKey[D]!.name, 'bench.jpg', 'no name in its metadata: the key\'s');
		assert.deepEqual(byKey['uploads/ffffffffffff/unused.jpg']!.usedIn, []);
		assert.equal(byKey['uploads/ffffffffffff/unused.jpg']!.focal, null);
		const thumb = new URL(byKey[A]!.thumbnail);
		assert.equal(thumb.origin, MEMORY_MEDIA.origin);
		const [, sig, ...rest] = thumb.pathname.split('/');
		const path = `/${rest.join('/')}`;
		assert.equal(path, `/rs:fit:320:0/q:80/plain/s3://${MEMORY_MEDIA.bucket}/${A}@webp`);
		assert.equal(sig, signPath(path, MEMORY_MEDIA.key, MEMORY_MEDIA.salt), 'signed on the server');
		assert.match(byKey[A]!.thumbnail2x, /\/rs:fit:640:0\//);
		const raw = JSON.stringify(r.body);
		assert.ok(!raw.includes(MEMORY_MEDIA.key) && !raw.includes(MEMORY_MEDIA.salt), 'the signing key and salt never leave the server');
	});

	test('the listing is kept 60 s, with this process\'s uploads added at once; metadata is read once per key', async () => {
		const bucket = new MemoryBucket();
		const clock = { t: Date.parse('2026-10-16T10:00:00Z') };
		const library = new Library(bucket, () => clock.t);
		bucket.seed(A, { w: 1, h: 1 });
		const uses = await mediaUses(localDraftsStore(site), site);
		assert.equal((await library.images(MEMORY_MEDIA as never, uses)).length, 1);
		bucket.seed(B, { w: 1, h: 1 }); // from another place the site runs
		library.added(D, { w: 2, h: 2, name: 'd.jpg', by: null, contentType: 'image/jpeg', lastModified: new Date(clock.t).toISOString(), size: 3 });
		assert.deepEqual((await library.images(MEMORY_MEDIA as never, uses)).map((i) => i.key).sort(), [A, D], 'own upload at once; the other place\'s not yet');
		clock.t += 60_000;
		assert.deepEqual((await library.images(MEMORY_MEDIA as never, uses)).map((i) => i.key).sort(), [A, B, D], 'within a minute');
		assert.equal(bucket.calls.filter((c) => c.startsWith('list:')).length, 2);
		assert.equal(bucket.calls.filter((c) => c === `head:${A}`).length, 1, 'a key never changes, so its metadata is read once');
	});

	test('unconfigured: 503 with the sentence naming what\'s missing; memory mode is refused in production', async () => {
		const r = await call<MediaUnset>(request('images'), local({}));
		assert.equal(r.status, 503);
		assert.equal(r.body.code, 'media-unset');
		assert.deepEqual(r.body.missing, ['CARACMS_MEDIA_URL', 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
		assert.equal(r.body.error, "The media library isn't set up here: set CARACMS_MEDIA_URL, IMGPROXY_KEY, IMGPROXY_SALT, S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to the site's media bucket and imgproxy.");
		const upl = await call<MediaUnset>(upload(png(4, 4), 'a.png'), local({}));
		assert.equal(upl.status, 503);
		const prod = await call<MediaUnset>(request('images'), local(MEMORY, { production: true }));
		assert.equal(prod.status, 503);
		assert.equal(prod.body.error, 'CARACMS_MEDIA=memory is for tests and local runs; a production server never uses the in-memory media.');
		assert.equal((await call<MediaUnset>(request('clips'), local(MEMORY, { production: true }))).status, 503);
	});

	test('one missing never disables the other: images without Mux, clips without the bucket', async () => {
		const imagesOnly = { CARACMS_MEDIA_URL: 'https://img.test', IMGPROXY_KEY: 'aa', IMGPROXY_SALT: 'bb', S3_BUCKET: 'b', S3_ENDPOINT: 'https://s3.test', S3_REGION: 'ams', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' };
		assert.equal(readImagesConfig(imagesOnly, false).kind, 's3');
		const mux = readMuxConfig(imagesOnly, false);
		assert.deepEqual(mux, { kind: 'unset', message: "Video isn't set up here: set MUX_TOKEN_ID and MUX_TOKEN_SECRET to the site's Mux environment's token.", missing: ['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET'] });
		const clipsOnly = { MUX_TOKEN_ID: 'id', MUX_TOKEN_SECRET: 'secret' };
		assert.equal(readMuxConfig(clipsOnly, false).kind, 'mux');
		assert.equal(readImagesConfig(clipsOnly, false).kind, 'unset');
		const r = await call<MediaUnset>(request('clips'), local(imagesOnly));
		assert.equal(r.status, 503);
		assert.equal(r.body.code, 'mux-unset');
	});

	test('memory mode always wins, whatever else is set', () => {
		const everything = { CARACMS_MEDIA: 'memory', CARACMS_MEDIA_URL: 'https://img.test', IMGPROXY_KEY: 'aa', IMGPROXY_SALT: 'bb', S3_BUCKET: 'real', S3_ENDPOINT: 'https://t3.storageapi.dev', S3_REGION: 'ams', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', MUX_TOKEN_ID: 'id', MUX_TOKEN_SECRET: 'secret' };
		assert.equal(readImagesConfig(everything, false).kind, 'memory');
		assert.equal(readMuxConfig(everything, false).kind, 'memory');
	});

	test('the thumbnail route redirects to the signed URL, for an upload\'s key and a ladder width only', async () => {
		const r = await handleMedia(request(`thumbnail?key=${encodeURIComponent(A)}&width=640`), local());
		assert.equal(r.status, 302);
		assert.equal(r.headers.get('cache-control'), 'private, no-store');
		assert.match(r.headers.get('location')!, /^https:\/\/img\.test\/[A-Za-z0-9_-]{43}\/rs:fit:640:0\/q:80\/plain\/s3:\/\/caracms-test-media\/uploads\/aaaaaaaaaaaa\/harbour\.jpg@webp$/);
		assert.equal((await handleMedia(request(`thumbnail?key=${encodeURIComponent('forms/x/y.jpg')}`), local())).status, 400);
		assert.equal((await handleMedia(request(`thumbnail?key=${encodeURIComponent('uploads/aaaaaaaaaaaa/../../x')}`), local())).status, 400);
		assert.equal((await handleMedia(request(`thumbnail?key=${encodeURIComponent(A)}&width=333`), local())).status, 400);
	});

	test('the thumbnail route refuses a file\'s key (a PDF has no thumbnail; nothing is signed)', async () => {
		for (const key of ['uploads/aaaaaaaaaaaa/rule-book.pdf', 'uploads/aaaaaaaaaaaa/brief.docx', 'uploads/aaaaaaaaaaaa/data.csv']) {
			const r = await handleMedia(request(`thumbnail?key=${encodeURIComponent(key)}&width=320`), local());
			assert.equal(r.status, 400, key);
			assert.equal(r.headers.get('location'), null, key);
		}
	});

	test('the thumbnail route takes every rung of the ladder and nothing between; a key outside uploads/ is refused whatever the width', async () => {
		const key = encodeURIComponent(A);
		for (const width of IMAGE_WIDTHS) {
			const r = await handleMedia(request(`thumbnail?key=${key}&width=${width}`), local());
			assert.equal(r.status, 302, `width ${width}`);
			assert.match(r.headers.get('location')!, new RegExp(`/rs:fit:${width}:0/`));
		}
		for (const width of ['0', '-320', '321', '3840', 'abc', '320.5', '']) assert.equal((await handleMedia(request(`thumbnail?key=${key}&width=${encodeURIComponent(width)}`), local())).status, 400, `width "${width}"`);
		for (const bad of ['forms/abc/x.jpg', 'uploads/', 'uploads', '/uploads/aaaaaaaaaaaa/harbour.jpg', 'http://evil.test/uploads/aaaaaaaaaaaa/x.jpg', 'x/uploads/aaaaaaaaaaaa/x.jpg']) {
			assert.equal((await handleMedia(request(`thumbnail?key=${encodeURIComponent(bad)}&width=320`), local())).status, 400, bad);
		}
		assert.equal((await handleMedia(request('thumbnail?width=320'), local())).status, 400, 'no key');
	});

	test('a cross-origin POST is refused (403), in local mode too; a GET\'s method is checked', async () => {
		const r = await call<{ error: string }>(upload(png(4, 4), 'a.png', { origin: 'https://evil.test' }));
		assert.equal(r.status, 403);
		assert.equal(mem.bucket.objects.size, 0);
		assert.equal((await call(upload(png(4, 4), 'a.png', { headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
		assert.equal((await call(request('images', { method: 'POST', body: '{}' }))).status, 405);
		assert.equal((await call(request('upload'))).status, 405);
		assert.equal((await call(request('nothing-here'))).status, 404);
	});
});

// ── Mux (Decision 12) ─────────────────────────────────────────────────────────

describe('the Mux routes', () => {
	test('a direct upload gets exactly the template\'s settings, and the request\'s own origin as cors_origin', async () => {
		const r = await call<{ id: string; url: string }>(request('video-upload', { body: JSON.stringify({ name: 'C:\\clips\\Kiln at dusk.mov' }), headers: { 'content-type': 'application/json' }, origin: 'http://site.test' }));
		assert.equal(r.status, 201);
		assert.match(r.body.id, /^[A-Za-z0-9]+$/);
		const sent = mem.mux.requests.find((q) => q.method === 'POST')!;
		assert.deepEqual(sent.body, {
			cors_origin: 'http://site.test',
			new_asset_settings: {
				playback_policy: ['public'],
				video_quality: 'basic',
				max_resolution_tier: '1080p',
				static_renditions: [{ resolution: 'highest' }],
				inputs: [{ generated_subtitles: [{ language_code: 'en', name: 'English (generated)' }] }],
				meta: { title: 'Kiln at dusk.mov' },
			},
		});
		const { meta: _meta, ...settingsSent } = sent.body.new_asset_settings;
		assert.deepEqual(settingsSent, NEW_ASSET_SETTINGS, 'the one settings object every upload uses');
		assert.equal((await call(request('video-upload', { body: JSON.stringify({ name: 'x.mov' }), headers: { 'content-type': 'application/json' }, origin: null }))).status, 403, 'no Origin, no upload');
		assert.equal((await call(request('video-upload', { body: JSON.stringify({ name: 'x.mov' }), headers: { 'content-type': 'application/json' }, origin: 'https://evil.test' }))).status, 403);
		assert.equal((await call(request('video-upload', { body: 'name=x', headers: { 'content-type': 'text/plain' } }))).status, 415);
		assert.equal((await call(request('video-upload', { body: JSON.stringify({ name: '' }), headers: { 'content-type': 'application/json' } }))).status, 400);
	});

	test('an upload\'s status, then its clip; Verify 6: a clip whose MP4 isn\'t ready isn\'t placeable', async () => {
		const made = await call<{ id: string }>(request('video-upload', { body: JSON.stringify({ name: 'Kiln.mov' }), headers: { 'content-type': 'application/json' } }));
		const waiting = await call<VideoUploadStatus>(request(`video-upload/${made.body.id}`));
		assert.deepEqual(waiting.body, { id: made.body.id, status: 'waiting', assetId: null, error: null });
		const assetId = mem.mux.receive(made.body.id);
		const created = await call<VideoUploadStatus>(request(`video-upload/${made.body.id}`));
		assert.equal(created.body.assetId, assetId);
		const preparing = await call<LibraryClip>(request(`clips/${assetId}`));
		assert.equal(preparing.body.ready, false);
		mem.mux.ready(assetId, { status: 'ready', mp4: 'preparing' });
		const assetReady = await call<LibraryClip>(request(`clips/${assetId}`));
		assert.equal(assetReady.body.status, 'ready');
		assert.equal(assetReady.body.ready, false, 'the asset is ready, its MP4 isn\'t: not placeable');
		assert.equal(assetReady.body.errored, false);
		mem.mux.ready(assetId);
		const ready = await call<LibraryClip>(request(`clips/${assetId}`));
		assert.equal(ready.body.ready, true);
		assert.deepEqual([ready.body.title, ready.body.w, ready.body.h], ['Kiln.mov', 1920, 1080]);
		const byPlayback = await call<LibraryClip>(request(`playback/${ready.body.playbackId}`));
		assert.equal(byPlayback.body.id, assetId);
	});

	test('the whole library follows Mux\'s cursor, newest first, errored clips shown with what to do, with where-used by playback ID', async () => {
		mem.mux.pageSize = 2;
		mem.mux.seedClip({ playbackId: 'pbReady0001', title: 'Used', createdAt: '2026-10-10T10:00:00Z' });
		mem.mux.seedClip({ playbackId: 'pbProcessing1', mp4: 'preparing', status: 'preparing', title: 'Processing', createdAt: '2026-10-12T10:00:00Z' });
		mem.mux.seedClip({ playbackId: null, status: 'errored', error: { type: 'invalid_input', messages: ['no video track'] }, title: 'Broken', createdAt: '2026-10-13T10:00:00Z' });
		mem.mux.seedClip({ playbackId: 'pbNoMp4', mp4: 'none', title: 'From the dashboard', createdAt: '2026-10-11T10:00:00Z' });
		mem.mux.seedClip({ playbackId: null, title: 'No public id', createdAt: '2026-10-14T10:00:00Z' });
		const r = await call<MediaClipsResponse>(request('clips'));
		assert.equal(r.status, 200);
		assert.deepEqual(r.body.clips.map((c) => c.title), ['Broken', 'Processing', 'From the dashboard', 'Used'], 'every page; no public ID and not errored: left out');
		assert.equal(mem.mux.requests.filter((q) => q.path.startsWith('/video/v1/assets?')).length, 3);
		const [broken, processing, noMp4, used] = r.body.clips as [LibraryClip, LibraryClip, LibraryClip, LibraryClip];
		assert.deepEqual([broken.errored, broken.error, broken.ready], [true, 'invalid_input: no video track', false]);
		assert.deepEqual([processing.ready, processing.errored], [false, false]);
		assert.deepEqual([noMp4.ready, noMp4.errored, noMp4.error], [false, true, 'No MP4 version of this clip. Upload it through the editor, or turn on MP4 (static renditions) for it in Mux.']);
		assert.deepEqual(used.usedIn.map((u) => u.title), ['About']);
		assert.deepEqual(processing.usedIn, []);
	});

	test('ids are checked; another environment\'s playback ID is a 404; every reply is private, no-store', async () => {
		for (const path of ['clips/abc-def', 'clips/..%2F..%2Fvideo', `clips/${'a'.repeat(129)}`, 'playback', 'video-upload/x/y']) {
			const r = await call<{ error: string }>(request(path));
			assert.equal(r.status, 404, path);
			assert.equal(r.res.headers.get('cache-control'), 'private, no-store');
		}
		assert.equal(mem.mux.requests.length, 0, 'nothing bad reached Mux');
		assert.equal((await call(request('playback/someoneElses01'))).status, 404);
		assert.equal((await call(request('clips/unknownAsset1'))).status, 404);
	});

	test('Mux\'s error bodies go to the server log only; a full plan says so', async () => {
		const logged: string[] = [];
		mem.mux.failNext = { status: 500, body: '{"error":{"type":"internal","messages":["trace 7f3a internal detail"]}}' };
		const r = await call<{ error: string }>(request('clips'), local(MEMORY, { log: (l) => logged.push(l) }));
		assert.equal(r.status, 502);
		assert.equal(r.body.error, 'Mux request failed (500).');
		assert.ok(!JSON.stringify(r.body).includes('7f3a'));
		assert.ok(logged.some((l) => l.includes('trace 7f3a internal detail')), 'logged on the server');
		mem.mux.failNext = { status: 400, body: '{"error":{"type":"invalid_parameters","messages":["Free plan is limited to 10 assets."]}}' };
		const full = await call<{ error: string }>(request('video-upload', { body: JSON.stringify({ name: 'x.mov' }), headers: { 'content-type': 'application/json' } }), local(MEMORY, { log: () => {} }));
		assert.equal(full.body.error, 'The Mux plan is full. Ask your developer.');
		assert.equal(planLimitMessage('not json'), null);
	});

	test('the token never reaches the browser: a real token is only ever in the Authorization header to Mux', async () => {
		const sent: { url: string; auth: string | null }[] = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			sent.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
			return new Response(JSON.stringify({ data: [], next_cursor: null }), { status: 200 });
		};
		const env = { MUX_TOKEN_ID: 'tok-id', MUX_TOKEN_SECRET: 'tok-secret-value' };
		const r = await call<MediaClipsResponse>(request('clips'), local(env, { fetch: fakeFetch }));
		assert.equal(r.status, 200);
		assert.equal(sent[0]!.url, 'https://api.mux.com/video/v1/assets?limit=100');
		assert.equal(sent[0]!.auth, `Basic ${Buffer.from('tok-id:tok-secret-value').toString('base64')}`);
		assert.ok(!JSON.stringify(r.body).includes('tok-secret'));
	});
});

// ── Live mode: where-used from drafts with autosaves, and WaitingView's alt list ──

const settings: LiveSettings = {
	github: { kind: 'memory' },
	redisUrl: null,
	secret: 's'.repeat(32),
	allow: [],
	webhookSecret: null,
	railway: null,
	backup: null,
	runningCommit: null,
	timings: { ...DEFAULT_TIMINGS },
	production: false,
};

async function liveServer(): Promise<LiveEditor> {
	const clock = { t: Date.parse('2026-10-16T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	backend.seed(await siteFiles(site));
	const rt = await createLiveRuntime({ site, settings, backend, redis: memoryRedis({ now: () => clock.t }), now: () => clock.t, log: () => {}, runningCommit: () => null });
	return createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
}

const liveRequest = (path: string, body: unknown, tab = 'tab-aoife-0001') =>
	new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-caracms-tab': tab }, body: JSON.stringify(body) });

async function liveWrite(ed: LiveEditor, collection: string, path: string, edit: (doc: Record<string, unknown>) => void) {
	const opened = (await ed.store.read(collection, path)) as OpenedDocument<never>;
	const document = JSON.parse(JSON.stringify(opened.document)) as Record<string, unknown>;
	edit(document);
	const res = await ed.write(liveRequest('/_caracms/write', { file: opened.entry.file, base: opened.text, document }), aoife);
	assert.equal(res.status, 200, await res.clone().text());
}

describe('live mode', () => {
	test('Verify 4: without a session every media route answers 401 (the handler\'s own check, behind the guard\'s)', async () => {
		const ed = await liveServer();
		const ctx: MediaContext = { site, store: ed.store, mode: 'live', person: null, env: MEMORY, production: false, log: () => {} };
		for (const [path, method] of [['upload', 'POST'], ['images', 'GET'], ['thumbnail?key=x', 'GET'], ['video-upload', 'POST'], ['video-upload/abc', 'GET'], ['clips', 'GET'], ['clips/abc', 'GET'], ['playback/abc', 'GET']] as const) {
			const r = await call<{ code: string }>(request(path, { method, body: method === 'POST' ? '{}' : null }), ctx);
			assert.equal(r.status, 401, path);
			assert.equal(r.body.code, 'signed-out');
		}
		assert.equal(mem.bucket.calls.length + mem.mux.requests.length, 0);
	});

	test('an upload records the signed-in address as `by`', async () => {
		const ed = await liveServer();
		const r = await call<MediaUploadResponse>(upload(png(20, 10), 'mark.png'), { site, store: ed.store, mode: 'live', person: aoife, env: MEMORY, production: false, log: () => {} });
		assert.equal(r.status, 201);
		assert.equal(r.body.image.by, 'aoife@example.com');
		assert.equal(mem.bucket.objects.get(r.body.image.key)!.meta.by, 'aoife@example.com');
	});

	test('Verify 5: a key used on one page is used, others unused; an autosave that removes it makes it unused on the next listing', async () => {
		const ed = await liveServer();
		const ctx: MediaContext = { site, store: ed.store, mode: 'live', person: aoife, env: MEMORY, production: false, log: () => {} };
		const ONLY_HOME = 'uploads/cccccccccccc/only-home.jpg';
		mem.bucket.seed(ONLY_HOME, { w: 10, h: 10 });
		mem.bucket.seed('uploads/999999999999/nowhere.jpg', { w: 10, h: 10 });
		await liveWrite(ed, 'pages', 'index', (doc) => {
			const blocks = doc.blocks as { data: Record<string, unknown> }[];
			blocks[0]!.data.media = { key: ONLY_HOME, alt: 'Only on Home' };
		});
		const before = await call<MediaImagesResponse>(request('images'), ctx);
		const at = (r: typeof before, key: string) => r.body.images.find((i: LibraryImage) => i.key === key)!;
		assert.deepEqual(at(before, ONLY_HOME).usedIn.map((u) => u.title), ['Home'], 'the autosave counts before it\'s committed');
		assert.deepEqual(at(before, 'uploads/999999999999/nowhere.jpg').usedIn, []);
		await liveWrite(ed, 'pages', 'index', (doc) => {
			const blocks = doc.blocks as { data: Record<string, unknown> }[];
			blocks[0]!.data.media = null;
		});
		const afterRemove = await call<MediaImagesResponse>(request('images'), ctx);
		assert.deepEqual(at(afterRemove, ONLY_HOME).usedIn, [], 'unused on the next listing');
	});

	test('Verify 7: a waiting page lists each image with no alt text, with its path and label; unknown blocks, shared entries and decorative images don\'t count', async () => {
		const ed = await liveServer();
		// Touch both pages and a case study, so they're waiting (autosaves on top of drafts).
		await liveWrite(ed, 'pages', 'about', (doc) => {
			doc.title = 'About us';
		});
		await liveWrite(ed, 'pages', 'index', (doc) => {
			doc.title = 'Home page';
		});
		await liveWrite(ed, 'case-studies', 'harbour', (doc) => {
			doc.title = 'High-street coffee roaster Co';
		});
		const res = await ed.status(new Request(`${ORIGIN}/_caracms/status`, { headers: { 'x-caracms-tab': 'tab-aoife-0001' } }), aoife);
		const status = (await res.json()) as StatusResponse;
		const of = (file: string) => status.waiting.find((w) => w.file === file)!.missingAlt;
		assert.deepEqual(of('content/pages/about.json'), [
			{ block: 1, field: 'images', path: 'images.0.alt', row: 0, label: 'Gallery image 1' },
			{ block: 1, field: 'images', path: 'images.2.alt', row: 2, label: 'Gallery image 3' },
		]);
		assert.deepEqual(of('content/pages/index.json'), [], 'the hero has alt text; the unknown carousel doesn\'t count');
		assert.deepEqual(of('content/case-studies/harbour.json'), [{ block: null, field: 'cover', path: 'cover.alt', row: null, label: 'Cover image' }]);
	});

	test('the list reads the document as it will publish, and a deleted document has none', async () => {
		const ed = await liveServer();
		await liveWrite(ed, 'pages', 'about', (doc) => {
			const blocks = doc.blocks as { data: Record<string, unknown> }[];
			(blocks[1]!.data.images as Record<string, unknown>[])[0]!.alt = 'Now written';
		});
		const del = await ed.delete(liveRequest('/_caracms/delete', { collection: 'case-studies', path: 'harbour' }, 'tab-aoife-0002'), aoife);
		assert.equal(del.status, 200, await del.clone().text());
		const status = (await (await ed.status(new Request(`${ORIGIN}/_caracms/status`, { headers: { 'x-caracms-tab': 'tab-aoife-0001' } }), aoife)).json()) as StatusResponse;
		assert.deepEqual(status.waiting.find((w) => w.file === 'content/pages/about.json')!.missingAlt.map((m) => m.label), ['Gallery image 3']);
		const gone = status.waiting.find((w) => w.file === 'content/case-studies/harbour.json')!;
		assert.equal(gone.change, 'deleted');
		assert.deepEqual(gone.missingAlt, []);
	});
});

describe('missingAltIn', () => {
	const doc = (value: unknown) => JSON.stringify(value);
	test('labels: the block\'s name plus image, a list\'s position, a fields document\'s own label; a shared block\'s own document', () => {
		assert.deepEqual(missingAltIn(site, 'pages', doc({ title: 'T', blocks: [{ type: 'hero', media: { key: A, alt: '' } }, { type: 'tm', media: { key: A, alt: ' ' } }] })).map((m) => [m.block, m.label, m.path]), [
			[0, 'Hero image', 'media.alt'],
			[1, 'Text and media image', 'media.alt'],
		]);
		assert.deepEqual(missingAltIn(site, 'shared', doc({ title: 'Footer', block: { type: 'tm', media: { key: D, alt: '' } } })).map((m) => [m.block, m.label]), [[0, 'Text and media image']]);
		assert.deepEqual(missingAltIn(site, 'pages', doc({ title: 'T', blocks: [{ type: 'tm', media: { video: 'abc', play: 'loop' } }] })), [], 'a clip has no alt text');
		assert.deepEqual(missingAltIn(site, 'pages', doc({ title: 'T', blocks: [{ type: 'gallery', images: [{ video: 'abc' }] }] })), [], 'a kind the slot doesn\'t take isn\'t shown, so isn\'t counted');
		assert.deepEqual(missingAltIn(site, 'settings', doc(files['content/site-settings.json'])), [], 'the brand\'s logo has no alt');
		assert.deepEqual(missingAltIn(site, 'pages', 'not json'), []);
		assert.deepEqual(missingAltIn(site, null, doc({})), []);
		// The document parser agrees on what's a block.
		assert.equal(parseDocumentText(doc(files['content/pages/index.json']), site).document.blocks[1]!.known, false);
	});
});

describe('the stored file name fits S3\'s metadata', () => {
	test('a long non-ASCII name is cut to 1 KB encoded, at a character', () => {
		const name = `${'港'.repeat(300)}.jpg`;
		const request = new Request('http://localhost/_caracms/media/upload', { method: 'POST', headers: { [MEDIA_NAME_HEADER]: encodeURIComponent(name) } });
		const kept = uploadName(request);
		assert.ok(encodeURIComponent(kept).length <= 1024, `${encodeURIComponent(kept).length} encoded`);
		assert.ok(kept.length > 0 && [...kept].every((c) => c === '港'));
	});
	test('an ordinary name is kept whole', () => {
		const request = new Request('http://localhost/_caracms/media/upload', { method: 'POST', headers: { [MEDIA_NAME_HEADER]: encodeURIComponent('Harbour wall.jpg') } });
		assert.equal(uploadName(request), 'Harbour wall.jpg');
	});
});
