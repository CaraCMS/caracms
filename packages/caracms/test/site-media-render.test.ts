// M7 Decision 2: moved from starter/test. It checks a package feature through a site, so it runs on the
// package's fixture site (test/fixtures/demo-site, the pre-M7 demo) and pinned content (helpers/site-render.ts).
// M5b Phase 1: the media blocks through the demo's real components (Astro's container,
// as fields-render.test.ts does): preview markers by path, an empty slot, a preview
// without the media variables (the slot renders nothing and nothing throws), and the
// in-memory media's host. Nothing here fetches an image.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { count, pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const demo = pinnedSite('media-render');
let r: Renderer;
let site: any;
let parseDocumentText: (text: string, site: unknown) => { document: any };
before(async () => {
	r = await startRenderer(demo.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseDocumentText } = await r.load('caracms/document'));
});
after(async () => {
	await r.close();
	demo.close();
});

const render = (document: unknown, preview = false) => r.page('caracms/components/RenderDocument.astro', { document, collection: 'pages', preview });
const doc = (blocks: unknown[]) => parseDocumentText(JSON.stringify({ title: 'Test', blocks }), site).document;
const IMAGE = { key: 'uploads/3f9a1c07b2e4/harbour-wall.jpg', alt: 'The harbour wall', focal: [0.4, 0.3], w: 4000, h: 2667 };
const tm = (media: unknown, side = 'left') => ({ type: 'tm', body: [{ p: 'Words.' }], media, side, background: 'light' });
const gallery = (images: unknown[]) => ({ type: 'gallery', heading: 'Around', images, background: 'light' });
const withMedia = async <T>(env: Record<string, string> | null, run: () => Promise<T>): Promise<T> => {
	const names = ['CARACMS_MEDIA', 'CARACMS_MEDIA_URL', 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'S3_BUCKET'];
	const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
	for (const n of names) delete process.env[n];
	Object.assign(process.env, env ?? {});
	try {
		return await run();
	} finally {
		for (const n of names) delete process.env[n];
		for (const [n, v] of Object.entries(saved)) if (v !== undefined) process.env[n] = v;
	}
};

describe('the media blocks', () => {
	test('a preview marks each slot by its path (a gallery image as images.<i>); the public render has no markers', async () => {
		await withMedia({ CARACMS_MEDIA: 'memory' }, async () => {
			const page = doc([tm(IMAGE), gallery([{ key: 'uploads/a/one.jpg', alt: 'One' }, { key: 'uploads/b/two.jpg', alt: '', decorative: true }])]);
			const preview = await render(page, true);
			assert.match(preview, /<img[^>]*src="https:\/\/img\.test\/[^"]+\/rs:fill:1920:1280\/g:fp:0\.4:0\.3\/q:80\/plain\/s3:\/\/caracms-test-media\/uploads\/3f9a1c07b2e4\/harbour-wall\.jpg@webp"[^>]*data-cms-field="media" data-cms-kind="media"/);
			assert.match(preview, /<img[^>]*class="gallery-image"[^>]*data-cms-field="images\.0" data-cms-kind="media"/);
			assert.match(preview, /<img[^>]*data-cms-field="images\.1" data-cms-kind="media"/);
			const pub = await render(page);
			assert.equal(count(pub, /data-cms-/g), 0);
			assert.equal(count(pub, /<img/g), 3);
		});
	});

	test('text and media: an empty slot is one column of text; the side select puts the media right', async () => {
		await withMedia({ CARACMS_MEDIA: 'memory' }, async () => {
			const empty = await render(doc([tm(null)]));
			assert.match(empty, /class="band bg-light tm tm--left tm--text"/);
			assert.equal(count(empty, /<img/g), 0);
			assert.match(await render(doc([tm(IMAGE, 'right')])), /class="band bg-light tm tm--right"/);
		});
	});

	test('a preview without the media variables renders an image slot as nothing and doesn\'t throw; a clip still shows', async () => {
		await withMedia(null, async () => {
			const html = await render(doc([{ type: 'hero', heading: ['Hi'], media: { video: 'abc', play: 'loop' } }, tm(IMAGE), gallery([IMAGE, IMAGE, IMAGE])]), true);
			assert.equal(count(html, /<img/g), 0);
			assert.match(html, /<video [^>]*data-cms-field="media" data-cms-kind="media"/);
		});
	});

	test('the hero: an image fills the band behind the text (fit, 100vw); a player clip there plays as a loop', async () => {
		await withMedia({ CARACMS_MEDIA: 'memory' }, async () => {
			const image = await render(doc([{ type: 'hero', heading: ['Hi'], media: IMAGE }]));
			assert.match(image, /class="band bg-light hero hero--left hero--media"/);
			assert.match(image, /<img[^>]*rs:fit:1920:0\/q:80[^>]*sizes="100vw"[^>]*loading="eager" fetchpriority="high"[^>]*class="hero-media"[^>]*style="object-position: 40% 30%"/);
			const clip = await render(doc([{ type: 'hero', heading: ['Hi'], media: { video: 'abc', play: 'player', name: 'Kiln' } }]));
			assert.match(clip, /<video autoplay muted loop playsinline/);
			assert.doesNotMatch(clip, /Play video/);
		});
	});

	test('a decorative image with alt text in its file renders alt="" and never says the alt text; a GIF and an SVG are one signed plain URL with no srcset', async () => {
		await withMedia({ CARACMS_MEDIA: 'memory' }, async () => {
			const html = await render(
				doc([
					gallery([
						{ key: 'uploads/a/texture.jpg', alt: 'Rough plaster', decorative: true, w: 3000, h: 3750 },
						{ key: 'uploads/b/spin.gif', alt: 'The wheel turning', w: 800, h: 1000 },
						{ key: 'uploads/c/mark.svg', alt: 'A mark', w: 64, h: 64 },
					]),
				]),
			);
			const imgs = html.match(/<img[^>]*>/g) ?? [];
			assert.equal(imgs.length, 3);
			// Astro writes an empty attribute bare (`alt`), which is `alt=""`.
			assert.match(imgs[0]!, /\salt(=""|\s|>)/);
			assert.doesNotMatch(imgs[0]!, /\salt="[^"]/);
			assert.doesNotMatch(html, /Rough plaster/);
			assert.match(imgs[0]!, /srcset=/, 'a JPEG is resized');
			for (const [i, name] of [[1, 'spin.gif'], [2, 'mark.svg']] as const) {
				assert.match(imgs[i]!, new RegExp(`src="https://img\\.test/[A-Za-z0-9_-]{43}/plain/s3://caracms-test-media/uploads/[a-c]/${name.replace('.', '\\.')}"`));
				assert.doesNotMatch(imgs[i]!, /srcset=|rs:/);
				assert.match(imgs[i]!, /width="\d+" height="\d+"/, 'the box is still reserved');
			}
			assert.match(imgs[1]!, /alt="The wheel turning"/);
		});
	});
});
