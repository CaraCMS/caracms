// Check 12's package side: `settingsImageUrl` from
// `caracms/content` turns a Site Settings image into one URL for the page's frame (a header,
// a footer, a layout), by `<Media>`'s rules, with no block's `cms`.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { settingsImageUrl } from '../src/content.ts';
import { IMAGE_WIDTHS, MEMORY_MEDIA, imageUrl, signPath, type MediaSettings } from '../src/media.ts';
import { pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const VARS = ['CARACMS_MEDIA', 'CARACMS_MEDIA_URL', 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'S3_BUCKET'] as const;
const saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
const restore = () => {
	for (const name of VARS) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
};
const clear = () => {
	for (const name of VARS) delete process.env[name];
};

const REAL: MediaSettings = { origin: 'https://img.example.com', key: 'aa11bb22', salt: 'cc33dd44', bucket: 'site-media', memory: false };
const useReal = () => {
	clear();
	process.env.CARACMS_MEDIA_URL = `${REAL.origin}/`;
	process.env.IMGPROXY_KEY = REAL.key;
	process.env.IMGPROXY_SALT = REAL.salt;
	process.env.S3_BUCKET = REAL.bucket;
};

// As siteSettings gives a media() field (M9: resolved), and as it's stored.
const resolved = { kind: 'image', key: 'uploads/ab12cd34ef56/harbour.jpg', alt: 'The harbour', decorative: false, focal: [0.4, 0.3], position: '40% 30%', w: 4000, h: 2667 };
const stored = { key: 'uploads/ab12cd34ef56/harbour.jpg', alt: 'The harbour', focal: [0.4, 0.3], w: 4000, h: 2667 };

describe('settingsImageUrl', () => {
	afterEach(restore);

	test('an empty value is null', () => {
		useReal();
		for (const value of [null, undefined, '', {}, { key: '' }, { kind: 'video', playbackId: 'abc' }, { video: 'abc' }]) {
			assert.equal(settingsImageUrl(value, { width: 400 }), null, JSON.stringify(value));
		}
	});

	test("media that isn't set up is null", () => {
		clear();
		assert.equal(settingsImageUrl(resolved, { width: 400 }), null);
		process.env.CARACMS_MEDIA_URL = REAL.origin;
		assert.equal(settingsImageUrl(resolved, { width: 400 }), null, 'only some of the variables');
	});

	test('both sides: the signed fill at that size, with the focal point', () => {
		useReal();
		const url = settingsImageUrl(resolved, { width: 640, height: 400 })!;
		const path = `/rs:fill:640:400/g:fp:0.4:0.3/q:80/plain/s3://site-media/uploads/ab12cd34ef56/harbour.jpg@webp`;
		assert.equal(url, `${REAL.origin}/${signPath(path, REAL.key, REAL.salt)}${path}`);
		assert.equal(url, imageUrl(REAL, resolved.key, { width: 640, height: 400, focal: [0.4, 0.3] }));
		assert.equal(settingsImageUrl(stored, { width: 640, height: 400 }), url, 'the stored value gives the same URL');
	});

	test('one side: a fit, no gravity', () => {
		useReal();
		assert.equal(settingsImageUrl(resolved, { width: 640 }), imageUrl(REAL, resolved.key, { width: 640 }));
		assert.match(settingsImageUrl(resolved, { width: 640 })!, /\/rs:fit:640:0\/q:80\/plain\//);
		assert.match(settingsImageUrl(resolved, { height: 300 })!, /\/rs:fit:0:300\/q:80\/plain\//);
	});

	test("no size: a fit at the ladder's top rung", () => {
		useReal();
		const top = IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1]!;
		assert.equal(settingsImageUrl(resolved), imageUrl(REAL, resolved.key, { width: top }));
	});

	test('an SVG and a GIF pass through unresized', () => {
		useReal();
		for (const key of ['uploads/ab12cd34ef56/mark.svg', 'uploads/ab12cd34ef56/spin.GIF']) {
			const url = settingsImageUrl({ ...resolved, key }, { width: 640, height: 400 })!;
			const path = `/plain/s3://site-media/${key}`;
			assert.equal(url, `${REAL.origin}/${signPath(path, REAL.key, REAL.salt)}${path}`);
		}
	});

	test("memory media: the in-memory media's URL, as <Media> draws it", () => {
		clear();
		process.env.CARACMS_MEDIA = 'memory';
		const url = settingsImageUrl(resolved, { width: 640, height: 400 })!;
		assert.ok(url.startsWith(`${MEMORY_MEDIA.origin}/`));
		assert.equal(url, imageUrl({ ...MEMORY_MEDIA, memory: true }, resolved.key, { width: 640, height: 400, focal: [0.4, 0.3] }));
	});

	test("a file's key in a media value is no image", () => {
		useReal();
		assert.equal(settingsImageUrl({ key: 'uploads/ab12cd34ef56/brochure.pdf' }, { width: 400 }), null);
	});
});

describe('a component outside a block draws a Site Settings image', () => {
	const copy = pinnedSite('settings-image');
	// The page's frame: no `cms`, just siteSettings and settingsImageUrl, as a site's header would.
	mkdirSync(join(copy.root, 'src/components'), { recursive: true });
	writeFileSync(
		join(copy.root, 'src/components/FrameImage.astro'),
		[
			'---',
			"import { settingsImageUrl, siteSettings } from 'caracms/content';",
			"import { site } from 'virtual:caracms/config';",
			'const settings = await siteSettings(site, Astro.locals);',
			'const seo = settings.seo as { image: unknown };',
			'const url = settingsImageUrl(seo.image, { width: 640, height: 400 });',
			'const none = settingsImageUrl(settings.missing);',
			'---',
			'<nav class="mega" data-image={url} data-none={none ?? "placeholder"}></nav>',
			'',
		].join('\n'),
	);
	let r: Renderer;
	before(async () => {
		clear();
		process.env.CARACMS_MEDIA = 'memory';
		r = await startRenderer(copy.root);
	});
	after(async () => {
		await r?.close();
		copy.close();
		restore();
	});

	test("the header's data-image is the settings image's URL; an empty one falls back", async () => {
		const html = await r.component(join(copy.root, 'src/components/FrameImage.astro'), {});
		// The fixture's seo.image (test/fixtures/demo-content/site-settings.json).
		const expected = imageUrl({ ...MEMORY_MEDIA, memory: true }, 'uploads/3f9a1c07b2e4/harbour-wall.jpg', { width: 640, height: 400, focal: [0.4, 0.3] });
		const attr = html.match(/data-image="([^"]*)"/)?.[1]?.replaceAll('&amp;', '&');
		assert.equal(attr, expected, html);
		assert.match(html, /data-none="placeholder"/);
	});
});
