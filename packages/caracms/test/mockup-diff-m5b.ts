/**
 * The M5b states for the visual pass's check (M5b Phase 5), run by mockup-diff.ts beside
 * M3's, M4's, M5a's and RT's (`--m5b`): every state the mockup's switcher tags M5b,
 * including `alt-missing` and `publish-alt` (the old `blocked`, which M4's group used to
 * compare and M5a's left out), against /admin in the same state. Their accepted
 * differences, each with its reason, are `ALLOW_M5B`.
 *
 * Every state runs with the in-memory bucket and fake Mux (`CARACMS_MEDIA=memory`, set
 * by mockup-diff.ts for the whole run), never the real ones: before each state the
 * bucket is emptied and seeded with the library below (`seedLibrary`), and the clips
 * with the fixture's playback IDs. Images never load (the memory host is
 * https://img.test, answered with a blank pixel), so, as everywhere in the diff, it's
 * computed style that's compared, not pixels. The demo's content is never changed: a
 * state that needs other sample content (Home's hero with an image, a gallery like the
 * mockup's) writes it into the throwaway copy in its `setup`.
 *
 * Most run in local mode. Two need live mode (helpers/live-site.ts, as M4's):
 * `publish-alt` (Publish's summary) and `fix-alt-locked` (someone else holds the page).
 * The stage-only states (`hero-image`, `hero-loop`, `tm-right`, `gallery`, `case-cover`,
 * `case-cards`) compare what the editor's side and the overlays show; the page itself is
 * the starter's (Phase 1), whose blocks are its own and not the mockup's drawing.
 */
import type { BrowserContext, Page } from 'playwright-core';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import type { DevSite } from './helpers/dev-site.ts';
import { AOIFE, cookieFor, eventually, keepState, openAdmin } from './helpers/live-site.ts';
import type { Allow, Ctx, Root, State } from './mockup-diff.ts';
import { ALLOW_REVIEW_GAPS } from './mockup-diff-m5a.ts';

const SHOWN = '.side-level:not([hidden])';
const SIDE = '#side';
const DOCS = '[data-pane-level="documents"]';
const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const FORM = `${SHOWN} [data-form]`;
const desktop = (page: Page) => page.frameLocator('#stage .frame[data-w="desktop"] iframe');

const EDITOR: Root[] = ['side', 'bar', 'pops', 'toast', 'stage'];
const WITH_OVERLAYS: Root[] = [...EDITOR, 'overlays'];

// ─── The sample library (the memory bucket and fake Mux) ────────────────────

/** The fixture's images, and a few the library has that nothing uses (the mockup's library has both). */
export const LIB = {
	harbour: 'uploads/3f9a1c07b2e4/harbour-wall.jpg',
	bench: 'uploads/9c21d0e4aa13/bench.heic',
	glaze: 'uploads/51be7a2c09d4/glaze-texture.jpg',
	kiln: 'uploads/77ab03fe5c90/kiln.jpg',
	spinning: 'uploads/0b6e2f91c4d8/spinning.gif',
	shopfront: 'uploads/6d1f0a93be27/harbour-shopfront.jpg',
	studio: 'uploads/2a7c5e1d90b3/studio-floor.jpg',
	door: 'uploads/4e8b1f6a2c7d/blue-door.heic',
	drum: 'uploads/8d3a6c0e1f52/riso-drum.jpg',
	never: 'uploads/aaaaaaaaaaaa/sketch-wall.jpg',
	mark: 'uploads/1fb083002e3a/mark.svg',
} as const;
/** The fixture's two clips (Visit's hero and its second text and media). */
export const CLIP = { kiln: 'a4nOgmxGWg6gULfcBbAa00gXyfcwPnAFldF8RdsNyk8M', firing: 'Qm3bXy02lTc6Zk4w8d9fJ00p1rSx7vU2gHn5aE6iKoL' } as const;

/** Empty the memory bucket and Mux, then seed the library every state starts from (newest first by upload time). */
export function seedLibrary(): void {
	const media = memoryMedia();
	media.reset();
	const seed = (key: string, w: number, h: number, name: string, uploadedAt: string, by?: string) =>
		media.bucket.seed(key, { w, h, name, uploadedAt, ...(by ? { by } : {}) });
	seed(LIB.door, 3024, 4032, 'IMG_4471.HEIC', '2026-10-16T13:47:00Z', 'niamh@example.com');
	seed(LIB.drum, 2400, 3000, 'riso-drum.jpg', '2026-10-15T16:20:00Z', 'ciaran@example.com');
	seed(LIB.harbour, 4000, 2667, 'harbour-wall.jpg', '2026-10-11T17:12:00Z', 'aoife@example.com');
	seed(LIB.bench, 3024, 4032, 'bench.heic', '2026-10-10T10:05:00Z', 'aoife@example.com');
	seed(LIB.glaze, 3000, 3750, 'glaze-texture.jpg', '2026-10-09T12:40:00Z', 'aoife@example.com');
	seed(LIB.kiln, 2400, 3000, 'kiln.jpg', '2026-10-08T11:30:00Z', 'niamh@example.com');
	seed(LIB.spinning, 800, 1000, 'spinning.gif', '2026-10-05T09:14:00Z', 'niamh@example.com');
	seed(LIB.studio, 2400, 1600, 'studio-floor.jpg', '2026-10-02T09:14:00Z', 'niamh@example.com');
	seed(LIB.never, 1800, 1350, 'sketch-wall.jpg', '2026-09-28T15:30:00Z', 'aoife@example.com');
	seed(LIB.shopfront, 4000, 2667, 'harbour-shopfront.jpg', '2026-09-20T16:45:00Z', 'aoife@example.com');
	seed(LIB.mark, 32, 32, 'mark.svg', '2026-09-14T10:00:00Z');
	media.mux.seedClip({ playbackId: CLIP.kiln, title: 'Riso run, two colours.mov', duration: 12.4, createdAt: '2026-10-16T13:40:00Z' });
	media.mux.seedClip({ playbackId: CLIP.firing, title: 'First pull.mov', duration: 74.6, createdAt: '2026-10-12T11:02:00Z' });
}

/** A blank pixel: what the memory media host (https://img.test) and Mux's thumbnails answer, so nothing waits on the network. */
const PIXEL = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
/** Images from the memory host and Mux answered locally; a loop's MP4 refused (images and clips never load from the network in a test). */
export async function mediaOffline(context: BrowserContext) {
	await context.route(/^https:\/\/(img\.test|image\.mux\.com)\//, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PIXEL }));
	await context.route(/^https:\/\/stream\.mux\.com\//, (route) => route.abort());
}

/** The demo's mark in Site Settings, as Phase 4 set it on the demo (the fixture has no logo: M3–M5a's bars then showed the initial). */
export function seedLogo(site: DevSite): void {
	edit(site, SETTINGS, (d) => (d.brand.logo = { key: LIB.mark, w: 32, h: 32 }));
}

// ─── Sample content, written into the throwaway copy only ───────────────────

const edit = (site: DevSite, file: string, change: (doc: Record<string, any>) => void) => {
	const doc = JSON.parse(site.read(file)) as Record<string, any>;
	change(doc);
	site.write(file, `${JSON.stringify(doc, null, 2)}\n`);
};
const HOME = 'content/pages/index.json';
const ABOUT = 'content/pages/about.json';
const VISIT = 'content/pages/visit.json';
const HARBOUR = 'content/case-studies/high-street-coffee.json';
const SETTINGS = 'content/site-settings.json';
const visitBlock = (d: Record<string, any>, i: number) => (d.blocks as Record<string, any>[])[i]!;

/** Home's hero with an image behind the text, as the mockup's Home has it. */
const homeHeroImage = (extra: Record<string, unknown> = {}) => (site: DevSite) =>
	edit(site, HOME, (d) => {
		d.blocks[0].media = { key: LIB.studio, alt: 'The studio floor: a long table, plan chests and the risograph', ...extra, w: 2400, h: 1600 };
	});
/** Visit's gallery as the mockup's: six images, the third with no alt text, the fourth with a focal point, the sixth decorative. */
const mockupGallery = (count = 6) => (site: DevSite) =>
	edit(site, VISIT, (d) => {
		visitBlock(d, 4).images = [
			{ key: LIB.bench, alt: 'A workbench with clay tools', w: 3024, h: 4032 },
			{ key: LIB.harbour, alt: 'The harbour wall at low tide', w: 4000, h: 2667 },
			{ key: LIB.kiln, alt: '', w: 2400, h: 3000 },
			{ key: LIB.drum, alt: "The risograph's pink drum, inked and ready", focal: [0.6, 0.41], w: 2400, h: 3000 },
			{ key: LIB.spinning, alt: 'The wheel turning', w: 800, h: 1000 },
			{ key: LIB.glaze, alt: '', decorative: true, w: 3000, h: 3750 },
		].slice(0, count);
	});
/** Visit's hero as the mockup's: a loop behind the text (the fixture's is a player, which a loop-only slot plays as a loop anyway). */
const visitHeroLoop = (site: DevSite) => edit(site, VISIT, (d) => (visitBlock(d, 0).media = { video: CLIP.kiln, play: 'loop', poster: 3.2, duration: 12.4, w: 1920, h: 1080 }));

// ─── Driving /admin ──────────────────────────────────────────────────────────

async function open(page: Page, origin: string, path = '/admin') {
	await page.goto(origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	await page.evaluate(() => document.fonts.ready);
}
/**
 * Pick a field as the mockup's states do (`s.field`): focus picks it (M5a Decision 13), so
 * its first control is focused. The snapshot blurs it after, and the frame stays picked.
 */
async function pickField(page: Page, frame: string) {
	await page.locator(`${frame} :is(button, input, textarea, select, [tabindex]):not([disabled]) >> nth=0`).focus();
	await page.waitForSelector(`${frame}.is-picked`);
	await page.locator(frame).scrollIntoViewIfNeeded();
}
/** A block of a page, from its document level, with one of its fields picked (`null`: none). */
async function block(ctx: Ctx, path: string, index: number, field: string | null = 'media') {
	await open(ctx.page, ctx.site.origin, path);
	await ctx.page.click(`${DOC} .blist > .brow >> nth=${index} >> .brow-main`);
	await ctx.page.waitForSelector(`${BLOCK} .field-frame`);
	if (field) await pickField(ctx.page, slot(field));
}
const visit = (ctx: Ctx, index: number, field: string | null = index === 4 ? 'images' : 'media') => block(ctx, '/admin/pages/visit', index, field);
const slot = (field = 'media') => `${BLOCK} [data-ff="${field}"]`;
/** High-street coffee roaster's form (a fields document), its cover picked. */
async function harbour(ctx: Ctx) {
	await open(ctx.page, ctx.site.origin, '/admin/case-studies/high-street-coffee');
	await ctx.page.waitForSelector(`${FORM} [data-ff="cover"]`);
	await pickField(ctx.page, `${FORM} [data-ff="cover"]`);
}
/** Site-wide → Media: the library as its own level. */
async function library(ctx: Ctx) {
	await open(ctx.page, ctx.site.origin);
	if (!(await ctx.page.isVisible(DOCS))) await ctx.page.click(`${SHOWN} .lv >> nth=0`);
	await ctx.page.click(`${SIDE} .media-row`);
	await ctx.page.waitForSelector(`${SIDE} [data-media-mode="browse"]`);
	await ctx.page.waitForSelector(`${SIDE} .mtile[data-key]`);
}
/** Files dragged over (and, with `drop`, dropped on) an element, as the browser sends them. */
async function dragFiles(page: Page, selector: string, files: { name: string; type: string }[], drop: boolean) {
	await page.evaluate(
		({ selector, files, drop }) => {
			const target = document.querySelector(selector)!;
			const dt = new DataTransfer();
			for (const f of files) dt.items.add(new File([new Uint8Array(64)], f.name, { type: f.type }));
			for (const type of drop ? ['dragenter', 'dragover', 'drop'] : ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
		},
		{ selector, files, drop },
	);
}
/** Uploads to the bucket wait (forever: the state is caught mid-upload). */
const holdUploads = (page: Page, except?: (name: string) => boolean) =>
	page.route('**/_caracms/media/upload', (route) => {
		const name = decodeURIComponent(route.request().headers()['x-caracms-file-name'] ?? '');
		if (except?.(name)) return route.continue();
		return new Promise(() => {});
	});
/** Mux's direct upload (https://mux.test in memory) takes the file. */
const muxTakes = (page: Page) => page.route('https://mux.test/upload/**', (route) => route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }));
/** A clip dropped on Visit's hero (emptied in setup), sent to Mux; resolves with its asset once Mux has it. */
async function clipToHero(ctx: Ctx, name: string): Promise<string> {
	const mux = memoryMedia().mux;
	await muxTakes(ctx.page);
	await visit(ctx, 0);
	await dragFiles(ctx.page, `${slot()} .mdrop`, [{ name, type: 'video/quicktime' }], true);
	const upload = await eventually(() => [...mux.uploads.keys()][0], 10_000, 'the direct upload');
	await ctx.page.waitForSelector(`${slot()} .mbar.busy`, { timeout: 15_000 });
	return mux.receive(upload, { title: name, duration: 12.4 });
}

/** Another person in their own browser context (closed when the state ends). */
async function as(ctx: Ctx, email: string, path: string): Promise<Page> {
	const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
	ctx.extra.push(context);
	await context.addCookies([cookieFor(ctx.site, email)]);
	return openAdmin(context, ctx.site, path);
}
async function editField(page: Page, selector: string, text: string) {
	await page.fill(selector, text);
	await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');
}

export const STATES_M5B: State[] = [
	// ── The media field ──
	{ id: 'media-empty', m5b: true, roots: WITH_OVERLAYS, ours: (ctx) => visit(ctx, 3) },
	{
		id: 'media-drop',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await visit(ctx, 3);
			await dragFiles(ctx.page, `${slot()} .mdrop`, [{ name: 'IMG_4471.HEIC', type: 'image/heic' }], false);
			await ctx.page.waitForSelector(`${slot()} .mdrop.is-over`);
		},
	},
	{
		id: 'media-upload',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await holdUploads(ctx.page);
			await visit(ctx, 3);
			await dragFiles(ctx.page, `${slot()} .mdrop`, [{ name: 'IMG_4471.HEIC', type: 'image/heic' }], true);
			await ctx.page.waitForSelector(`${slot()} .media-prog`);
		},
	},
	{ id: 'media-image', m5b: true, roots: WITH_OVERLAYS, ours: (ctx) => visit(ctx, 1) },
	{
		id: 'media-decorative',
		m5b: true,
		roots: EDITOR,
		setup: homeHeroImage({ alt: '', decorative: true }),
		ours: (ctx) => block(ctx, '/admin', 0),
	},
	{
		id: 'alt-ask',
		m5b: true,
		roots: EDITOR,
		keepFocus: true,
		ours: async (ctx) => {
			await visit(ctx, 3);
			await ctx.page.click(`${slot()} .mdrop .btn`);
			await ctx.page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
			await ctx.page.click(`${SIDE} .mtile[data-key="${LIB.door}"]`);
			await ctx.page.waitForSelector(`${slot()} [data-altmsg][data-ask] .field-ask`);
			await eventually(() => ctx.page.evaluate(() => document.activeElement?.matches('input[data-alt]') ?? false), 4000, 'the alt input focused');
		},
	},
	{
		id: 'alt-missing',
		m5b: true,
		roots: EDITOR,
		setup: (site) => edit(site, HARBOUR, (d) => (d.cover.alt = '')),
		ours: harbour,
	},
	{
		id: 'focal',
		m5b: true,
		roots: WITH_OVERLAYS,
		ours: async (ctx) => {
			await visit(ctx, 1);
			await ctx.page.click(`${slot()} .media-acts button[aria-expanded]`);
			await ctx.page.waitForSelector(`${slot()} .fp-img`);
		},
	},
	{
		id: 'focal-unset',
		m5b: true,
		roots: WITH_OVERLAYS,
		setup: (site) => edit(site, VISIT, (d) => delete visitBlock(d, 1).media.focal),
		ours: async (ctx) => {
			await visit(ctx, 1);
			await ctx.page.click(`${slot()} .media-acts button[aria-expanded]`);
			await ctx.page.waitForSelector(`${slot()} .fp-img`);
		},
	},
	{
		id: 'media-clip',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await visit(ctx, 2);
			await ctx.page.click(`${slot()} button[aria-label="Poster frame"]`);
			await ctx.page.waitForSelector(`${slot()} .fr-range`);
			// Scrubbed to another frame (the mockup's 41.5 s), so Use this frame is on.
			await ctx.page.evaluate((sel) => {
				const range = document.querySelector<HTMLInputElement>(sel)!;
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '41.5');
				range.dispatchEvent(new Event('input', { bubbles: true }));
			}, `${slot()} .fr-range`);
			await ctx.page.waitForSelector(`${slot()} .fr-row .btn:not([disabled])`);
		},
	},
	{
		id: 'media-processing',
		m5b: true,
		roots: EDITOR,
		setup: (site) => edit(site, VISIT, (d) => delete visitBlock(d, 0).media),
		ours: async (ctx) => {
			await clipToHero(ctx, 'Riso run, two colours.mov');
		},
	},
	{
		id: 'media-failed',
		m5b: true,
		roots: EDITOR,
		setup: (site) => edit(site, VISIT, (d) => delete visitBlock(d, 0).media),
		ours: async (ctx) => {
			const asset = await clipToHero(ctx, 'Opening night.mp4');
			const mux = memoryMedia().mux;
			mux.ready(asset, { status: 'errored', mp4: 'errored' });
			mux.assets.get(asset).errors = { type: 'invalid_input', messages: ['no video track'] };
			await ctx.page.waitForSelector(`${BLOCK} .mslot .note.danger`, { timeout: 15_000 });
		},
	},
	{
		id: 'media-only',
		m5b: true,
		roots: EDITOR,
		setup: (site) => edit(site, HARBOUR, (d) => delete d.cover),
		ours: async (ctx) => {
			await harbour(ctx);
			await dragFiles(ctx.page, `${FORM} [data-ff="cover"] .mdrop`, [{ name: 'Opening night.mov', type: 'video/quicktime' }], true);
			await ctx.page.waitForSelector(`${FORM} [data-ff="cover"] .field-err`);
		},
	},
	{
		id: 'media-unset',
		m5b: true,
		roots: EDITOR,
		env: { CARACMS_MEDIA: undefined },
		ours: async (ctx) => {
			await visit(ctx, 1);
			await ctx.page.waitForSelector(`${slot()} [data-media-unset]`);
		},
	},
	// ── Media on the page (the stage is the starter's; the side and the overlays are compared) ──
	{
		id: 'hero-image',
		m5b: true,
		roots: WITH_OVERLAYS,
		setup: homeHeroImage(),
		ours: (ctx) => block(ctx, '/admin', 0),
	},
	{ id: 'hero-loop', m5b: true, roots: WITH_OVERLAYS, setup: visitHeroLoop, ours: (ctx) => visit(ctx, 0) },
	{
		id: 'tm-right',
		m5b: true,
		roots: WITH_OVERLAYS,
		setup: (site) => edit(site, VISIT, (d) => (visitBlock(d, 1).side = 'right')),
		ours: (ctx) => visit(ctx, 1, 'side'),
	},
	{ id: 'gallery', m5b: true, roots: WITH_OVERLAYS, setup: mockupGallery(), ours: (ctx) => visit(ctx, 4) },
	{
		id: 'gallery-row',
		m5b: true,
		roots: WITH_OVERLAYS,
		setup: mockupGallery(),
		ours: async (ctx) => {
			await visit(ctx, 4);
			await ctx.page.click(`${BLOCK} [data-list="images"] [data-row="3"] .item-sum`);
			await ctx.page.waitForSelector(`${BLOCK} [data-list="images"] [data-row="3"].is-open`);
		},
	},
	{ id: 'gallery-bounds', m5b: true, roots: EDITOR, setup: mockupGallery(2), ours: (ctx) => visit(ctx, 4) },
	{ id: 'case-cover', m5b: true, roots: WITH_OVERLAYS, ours: harbour },
	{
		id: 'case-cards',
		m5b: true,
		roots: WITH_OVERLAYS,
		// Work's case-study list, as the mockup's (its block, with no field picked).
		ours: (ctx) => block(ctx, '/admin/pages/work', 3, null),
	},
	// ── The library ──
	{
		id: 'media-row',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await ctx.page.click(`${SHOWN} .lv >> nth=0`);
			await ctx.page.waitForSelector(`${DOCS} .media-row`);
			for (const g of ['pages:about', 'pages:services']) {
				const el = `${DOCS} [data-group="${g}"]`;
				if ((await ctx.page.getAttribute(el, 'aria-expanded')) !== 'true') await ctx.page.click(el);
			}
			await ctx.page.evaluate(() => {
				const body = document.querySelector<HTMLElement>('.side-level:not([hidden]) .side-body');
				if (body) body.scrollTop = body.scrollHeight;
			});
		},
	},
	{ id: 'library', m5b: true, roots: EDITOR, ours: library },
	{
		id: 'library-clips',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			const mux = memoryMedia().mux;
			mux.seedClip({ playbackId: 'stairs0processing', title: 'Quay stairs.mov', mp4: 'preparing', status: 'preparing', createdAt: '2026-10-16T14:06:00Z' });
			mux.seedClip({ playbackId: 'signs0timelapse', title: 'Window signs, timelapse.mp4', duration: 38, w: 1080, h: 1350, createdAt: '2026-10-03T18:20:00Z' });
			mux.seedClip({ playbackId: null, status: 'errored', mp4: 'none', title: 'Opening night.mp4', createdAt: '2026-10-02T22:41:00Z', error: { type: 'invalid_input', messages: ['no video track'] } });
			// A clip on its way to Mux: the PUT never finishes.
			await ctx.page.route('https://mux.test/upload/**', () => new Promise(() => {}));
			await library(ctx);
			await ctx.page.click(`${SIDE} .mini-seg [role="radio"][data-v="clips"]`);
			await ctx.page.waitForSelector(`${SIDE} [data-lgrid="clips"] .mtile`);
			await ctx.page.locator(`${SIDE} [data-lib-file]`).first().setInputFiles([{ name: 'Studio tour.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(2048, 7) }]);
			await ctx.page.waitForSelector(`${SIDE} [data-lgrid="clips"] [data-upload]`);
		},
	},
	{
		id: 'library-upload',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			// Three images on their way, one just added, and two files refused with their sentences.
			await holdUploads(ctx.page, (name) => /\.(rtf|dat)$|bench-detail/.test(name));
			await library(ctx);
			const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000000c4944415408d763f8cfc0f01f0005fe02fea7d6a4b60000000049454e44ae426082', 'hex');
			await ctx.page.locator(`${SIDE} [data-lib-file]`).first().setInputFiles([
				{ name: 'bench-detail.png', mimeType: 'image/png', buffer: png },
				// M6c G4: a PDF is a file the library takes now, so the refused one is an RTF.
				{ name: 'Rate card 2026.rtf', mimeType: 'application/rtf', buffer: Buffer.from('{\\rtf1\\ansi Rate card 2026}') },
				{ name: 'scan-0042.dat', mimeType: 'application/octet-stream', buffer: Buffer.alloc(64, 3) },
				{ name: 'IMG_4519.HEIC', mimeType: 'image/heic', buffer: Buffer.alloc(64, 1) },
				{ name: 'IMG_4518.HEIC', mimeType: 'image/heic', buffer: Buffer.alloc(64, 2) },
				{ name: 'shopfront-night.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(64, 4) },
			]);
			await ctx.page.waitForSelector(`${SIDE} .refused`);
			await eventually(async () => (await ctx.page.locator(`${SIDE} .refused [role], ${SIDE} .refused > *`).count()) >= 2, 10_000, 'two refusals');
			await ctx.page.locator(`${SIDE} .mtile[data-key]`, { hasText: 'bench-detail.png' }).waitFor();
		},
	},
	{
		id: 'library-image',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await library(ctx);
			await ctx.page.click(`${SIDE} .mtile[data-key="${LIB.harbour}"]`);
			await ctx.page.waitForSelector(`${SIDE} [data-media-item]`);
		},
	},
	{
		id: 'library-unused',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await library(ctx);
			await ctx.page.click(`${SIDE} [data-act="lib-unused"]`);
			await ctx.page.waitForSelector(`${SIDE} [data-act="lib-unused"][aria-checked="false"]`);
		},
	},
	{
		id: 'library-empty',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			memoryMedia().reset();
			await open(ctx.page, ctx.site.origin);
			await ctx.page.click(`${SHOWN} .lv >> nth=0`);
			await ctx.page.click(`${SIDE} .media-row`);
			await ctx.page.waitForSelector(`${SIDE} [data-library-empty]`);
		},
	},
	{
		id: 'library-pick',
		m5b: true,
		roots: WITH_OVERLAYS,
		ours: async (ctx) => {
			await visit(ctx, 1);
			await ctx.page.click(`${slot()} .media-acts .btn >> text=Replace…`);
			await ctx.page.waitForSelector(`${SIDE} [data-media-mode="pick"] .mtile[data-key]`);
		},
	},
	{
		id: 'library-pick-images',
		m5b: true,
		roots: WITH_OVERLAYS,
		setup: mockupGallery(),
		ours: async (ctx) => {
			await visit(ctx, 4);
			await ctx.page.click(`${BLOCK} [data-ff="images"] .list-foot .linkbtn`);
			await ctx.page.waitForSelector(`${SIDE} [data-media-mode="pick"] .mtile[data-key]`);
		},
	},
	{
		id: 'library-picked-alt',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await visit(ctx, 3);
			await ctx.page.click(`${slot()} .mdrop .btn`);
			await ctx.page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
			await ctx.page.click(`${SIDE} .mtile[data-key="${LIB.shopfront}"]`);
			await ctx.page.waitForSelector(`${slot()} [data-altmsg] .field-hint`);
		},
	},
	// ── Publish and alt text ──
	{
		// Live: Visit, About and High-street coffee roaster waiting, each with an image that has no alt text.
		id: 'publish-alt',
		m5b: true,
		live: true,
		// The in-memory media (mockup-diff.ts sets it for its run; the chrome's live checks get it from here).
		env: { CARACMS_MEDIA: 'memory' },
		roots: ['side', 'bar', 'pops'],
		setup: (site) => {
			homeHeroImage()(site);
			mockupGallery()(site);
			edit(site, ABOUT, (d) => (d.blocks[0].media = { key: LIB.studio, alt: '', w: 2400, h: 1600 }));
			edit(site, HARBOUR, (d) => (d.cover.alt = ''));
		},
		ours: async (ctx) => {
			// Aoife changed High-street coffee roaster and has About open with a change; Niamh changed Visit.
			const harbourPage = await as(ctx, AOIFE, '/admin/case-studies/high-street-coffee');
			await editField(harbourPage, `${FORM} [data-ff="summary"] textarea`, 'Signs for a coffee cart on the quay, edited by Aoife.');
			await harbourPage.close({ runBeforeUnload: true });
			const about = await as(ctx, AOIFE, '/admin/pages/about');
			await about.click(`${DOC} .brow-main >> nth=0`);
			await editField(about, `${BLOCK} [data-ff="intro"] textarea`, 'Four people and a long table, edited by Aoife.');
			await open(ctx.page, ctx.site.origin, '/admin/pages/visit');
			await ctx.page.click(`${DOC} .brow-main >> nth=4`);
			await editField(ctx.page, `${BLOCK} [data-ff="heading"] input, ${BLOCK} [data-ff="heading"] textarea`, 'Around the studio, on a Friday');
			await open(ctx.page, ctx.site.origin);
			await desktop(ctx.page).locator('[data-cms-block="0"] [data-cms-field="heading"]').first().click();
			await ctx.page.click(`${BLOCK} [data-ff="intro"] textarea`);
			await eventually(async () => /3 waiting/.test((await ctx.page.textContent('.bar [data-slot="publish"]')) ?? ''), 15_000, '3 waiting');
			await ctx.page.waitForSelector('#bar [data-dot="alt"]', { timeout: 15_000 });
			await ctx.page.click('.bar [data-slot="publish"]');
			await ctx.page.waitForSelector('[data-pop="waiting"] [data-note="alt-text"]');
			await eventually(async () => (await ctx.page.locator('[data-pop="waiting"] [data-note="alt-text"]').count()) === 3, 15_000, 'three documents marked');
		},
	},
	{
		id: 'fix-alt-list',
		m5b: true,
		roots: WITH_OVERLAYS,
		keepFocus: true,
		setup: mockupGallery(),
		ours: async (ctx) => {
			await visit(ctx, 4);
			await ctx.page.click(`${BLOCK} [data-list="images"] [data-row="2"] .item-sum`);
			await ctx.page.waitForSelector(`${BLOCK} [data-list="images"] [data-row="2"].is-open`);
			await ctx.page.focus(`${BLOCK} input[data-alt="images.2"]`);
		},
	},
	{
		// Live: Aoife holds About; Niamh's Add alt text opens it read-only with the hero's image field picked.
		id: 'fix-alt-locked',
		m5b: true,
		live: true,
		// The in-memory media (mockup-diff.ts sets it for its run; the chrome's live checks get it from here).
		env: { CARACMS_MEDIA: 'memory' },
		roots: ['side', 'bar', 'overlays'],
		setup: (site) => edit(site, ABOUT, (d) => (d.blocks[0].media = { key: LIB.studio, alt: '', w: 2400, h: 1600 })),
		ours: async (ctx) => {
			const about = await as(ctx, AOIFE, '/admin/pages/about');
			await about.click(`${DOC} .brow-main >> nth=0`);
			await editField(about, `${BLOCK} [data-ff="intro"] textarea`, 'Four people and a long table, edited by Aoife.');
			await open(ctx.page, ctx.site.origin);
			await ctx.page.waitForSelector('#bar [data-dot="alt"]', { timeout: 15_000 });
			await ctx.page.click('.bar [data-slot="publish"]');
			await ctx.page.waitForSelector('[data-pop="waiting"] [data-held]', { timeout: 15_000 });
			await ctx.page.click('[data-pop="waiting"] [data-act="fix-alt"]');
			await eventually(() => new URL(ctx.page.url()).pathname === '/admin/pages/about', 10_000, 'About opens');
			await ctx.page.waitForSelector(`${BLOCK} fieldset.ro-fields [data-ff="media"]`);
			await ctx.page.waitForSelector(`${SHOWN} [data-note="locked"]`);
		},
	},
	// ── Site Settings ──
	{
		id: 'settings-brand',
		m5b: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/settings');
			await ctx.page.waitForSelector(`${SHOWN} [data-ff="brand.logo"] .media.compact`);
			await ctx.page.locator(`${SHOWN} [data-ff="brand.logo"]`).scrollIntoViewIfNeeded();
		},
	},
];

// ─── Accepted differences ────────────────────────────────────────────────────

const M4 = "an M4 place (presence, waiting, Publish, locks) that local mode leaves empty, as in M3's states";
const SAMPLE = "the mockup's sample content, not a difference in the design (its site has blocks, fields and documents the demo doesn't)";
/** The mockup's sample accent (navy #1f2f57) and the demo's own (its green). */
const NAVY = /rgb\(31, 47, 87\)/;

/** The mockup's pictures are drawn; the editor's are the server's signed thumbnails. */
const PICTURES =
	"the mockup draws its sample pictures in CSS (.ph-in, layered gradients, with the focal dot inside the drawing); the editor shows the server's signed imgproxy thumbnail as one <img class=\"ph-img\"> (never the original: Chrome can't show a HEIC), with the focal dot over it, and the poster editor is the clip's own <video>";
const HARBOUR_SAMPLE = `${SAMPLE}: High-street coffee roaster's other fields, as in M5a's case states`;

export const ALLOW_M5B: Allow[] = [
	...ALLOW_REVIEW_GAPS,
	// ── Edit in context: what the new behaviour changes in M5b's states ──
	{ state: /^settings-brand$/, root: 'stage', key: /^\(root\) > div\.stage-aside$/, kind: 'missing', reason: "edit in context, Decision 9: Site Settings shows over the last page, live and undimmed (edit-in-context.html#settings-top), replacing M5a's dimmed stage and its 'no page of its own' note" },
	{ state: /^settings-brand$/, root: 'side', key: /^\(root\) > div\.trail > button\.lv$/, kind: 'style', prop: /^(background-color|margin-(left|right))$/, reason: "edit in context, Decision 8: over a page, the page's tab stacks above Site Settings' head (edit-in-context.html#settings-top: CaraCMS, then Home · Blocks), so the trail has a second, inner tab" },
	{ state: /^case-cards$/, root: 'side', key: /^\(root\) > div\.side-body > div\.reads$/, kind: 'extra', reason: "edit in context, Decision 12: a block whose render read a collection shows 'Shows entries from Case studies (n) · Open' on its level (edit-in-context.html#cases-block); the earlier mockups don't have the row" },
	// ── M6c (after M5b's mockups): the library's Images / Clips / Files switch (mockup m6c-downloads-grid.html → #library-files) ──
	{ state: /^library(-clips|-upload|-unused|-pick|-pick-images)?$/, key: /lib-bar > button\.sm\.switch( > span( > span\.n)?)?$/, kind: 'style', prop: /^white-space$/, mock: /^normal$/, ours: /^nowrap$/, reason: "M6c (m6c mockup #library-files): with a third tab (Files), the switch's buttons and their counts don't wrap (white-space: nowrap), where M5b's two-tab mockup lets them" },
	{ state: /^settings-(public|self|brand)$/, key: /side-body > section\.set-sec > p\.field-(help|hint)$/, kind: 'extra', reason: "pre-M7 item 8: Site Settings' Redirects section (after the mockups), empty in the fixture: its line and the applies-once-published hint" },
	// ── As in M3's, M4's and M5a's states, for the same reasons ──
	{ key: /\.(av|dot|pub|me|avs|lock|who)\b/, state: /^(?!publish-alt|fix-alt-locked)/, reason: M4 },
	{ key: /(logo-slot|si-logo) > (svg|img)$/, reason: "the site's logo is a file Site Settings names, drawn as an <img> (the mockup inlines its sample SVG)" },
	{ root: 'overlays', prop: /^font-family$/, key: /./, reason: 'the layer loads the editor\'s Instrument Sans under its own name ("caracms UI")' },
	{ key: /rchip/, reason: "Recent is per browser (M3 Decision 20): a fresh browser lists only what it opened; the mockup's strip is a sample" },
	{ key: /note[.\w-]*\.warn[.\w-]* > svg\.i$|wmark > svg|toast > button\.btn\.sm > svg/, kind: 'style', prop: /color$/, reason: "contrast (M3 Phase 5, icons 3:1): the warning mark and a warning note's icon take the strong warning amber; the Undo button's icon is the button's ink" },
	{ key: /span\.nm > span\.chip\.warn$|span\.meta > span\.wmark$/, kind: 'extra', reason: "the \"too long for mobile\" marks are the mockup's own (browHTML, metaFor), but its sidebar isn't redrawn after it measures the phone frame (as in M3's states)" },
	{ kind: 'style', key: /./, mock: NAVY, ours: /rgb\(31, 58, 46\)/, reason: "the demo's own brand accent (its green) where the mockup has its sample navy: the accent's slots" },
	{ kind: 'style', key: /./, prop: /^box-shadow$/, mock: /oklab\(/, ours: /oklab\(/, reason: "the editor restyle (Decision 9 (b)): an accent button's pressed edge is --edge-accent, a color-mix of the accent, which computes as oklab(…) from the mockup's navy and the demo's own green, out of the catch-all accent rule's reach" },
	{ kind: 'style', key: /\.av\b[^>]*$/, prop: /^background-color$/, reason: `${SAMPLE}: a person's colour is picked from their address (format.ts → colourOf)` },
	{ key: /cur-row > div$/, kind: 'missing', reason: `${SAMPLE}: the page's "…" menu is in the head row of a page, not of the mockup's sample` },
	{ key: /field-head > span\.field-meta$/, kind: 'missing', reason: "a field with a maximum shows a count; the demo's fields set none (as in M3's states)" },
	{ key: /field-head > span\.field-label$/, kind: 'extra', reason: "a field that's a group of inputs (a list, Buttons) is named by a span, not a <label> with nothing to point at (as in M5a's states)" },
	{ key: /> p\.field-help$/, kind: 'missing', reason: `${SAMPLE}: the mockup's fields carry help lines that the demo's schema doesn't set (as in M5a's states)` },
	// ── Rich text, as in M5a's states ──
	{ key: /div\.prose\.rt( > [\w.-]+)*$/, kind: 'style', prop: /^white-space$/, mock: /^normal$/, ours: /^pre-wrap$/, reason: "ProseMirror sets white-space: pre-wrap on its editable element (it needs it for spaces and breaks); the mockup's contenteditable is a plain div (as in M5a's states)" },
	{ key: /div\.tb > button > i(\.tb-i)?$/, reason: "the italic button's Georgia is a class (.tb-i), not an inline style: the editor's CSP allows no inline styles (as in M5a's states)" },
	// ── The demo's blocks against the mockup's sample ones ──
	{ key: /side-body > div\.field-frame > div\.field > (input\.input|div\.prose-wrap > div\.tb > button\.tb-style|div\.prose-wrap > div\.prose\.rt > (h2|p))$/, state: /^(media-|alt-|focal|hero-|tm-|library-pick|library-picked)/, reason: `${SAMPLE}: the demo's Text and media keeps its heading as an H2 in its rich text (Decision 10: rich text with H2 and H3 on, so the style menu, and a paragraph after the heading), where the mockup's has a Heading field above a body` },
	// ── M5b's own, each with its reason ──
	{ key: /> span\.ph-in(\.svg)?$/, kind: 'missing', reason: PICTURES },
	{ key: /> img\.ph-img$|thumb > span\.fp-dot$|div\.fr-vid\.ph > video$/, kind: 'extra', reason: PICTURES },
	{ key: /div\.fp-img$/, kind: 'style', prop: /^background-image$/, reason: PICTURES },
	{ key: /field-frame > div\.field > div\.(btnf|list-empty)$/, reason: `${SAMPLE}: the mockup's heroes have a filled button; the demo's have an empty Buttons field ("No buttons."), as in M3's states` },
	{ state: /^(media-empty)$/, root: 'overlays', key: /div\.cms-box\.cms-pick$/, kind: 'missing', reason: "Decision 4 and 10: an empty slot renders nothing (Text and media with no picture is one column of text), so there's nothing on the page to ring; the mockup rings a placeholder" },
	{ state: /^tm-right$/, root: 'overlays', key: /div\.cms-box\.cms-pick$/, kind: 'missing', reason: "a select (Image side, Background) has no element of its own on the page, so picking it rings nothing beyond its block (as M3's and M5a's selects); the mockup rings the picture" },
	{ state: /^(tm-right|gallery|gallery-row|gallery-bounds|fix-alt-list)$/, key: /side-body > div\.field-frame > div\.field > select\.input$/, kind: 'extra', reason: `${SAMPLE}: the demo's Text and media and Gallery have a Background select after their media (the starter's blocks, Decision 10), so the picked field isn't the last` },
	{ state: /^(tm-right|gallery|gallery-row|gallery-bounds|fix-alt-list)$/, key: /^\(root\) > div\.side-body$/, kind: 'order', reason: `${SAMPLE}: the demo's blocks have a Background select after the picked field` },
	{ state: /^media-unset$/, key: /div\.note\.tight > div > p > span\.mono$/, kind: 'missing', reason: "Resolved decisions (Phase 3): the note keeps the mockup's bold title over the server's own sentence, which names the missing variables in plain text" },
	{ state: /^media-unset$/, root: 'bar', key: /logo-slot > (svg|span\.logo-mono)$/, reason: "with media not set up there's no signed URL for the logo, so the bar shows the brand's initial (M2 Decision 5, Decision 11's neutral fallback); the mockup keeps its logo" },
	{ state: /^library-pick-images$/, key: /^\(root\) > div\.side-body > div$/, kind: 'extra', reason: "Resolved decisions (Phase 3): a gallery's Add image takes several (Decision 7), which the mockup doesn't draw, so the picker checks each tile picked and adds Done with a line saying they're added in order" },
	{ state: /^library-picked-alt$/, key: /div\.media-txt > small(\.fp-on| > svg\.i\.i-xs)$/, reason: 'Resolved decisions (Exit walk, 2026-10-16): a picked image brings its focal point along with its alt text (Decision 7 amended), and the shopfront\'s cover has one, so the card says "Focal point set" where the mockup, drawn before, shows "No focal point" with its icon' },
	{ state: /^library-image$/, root: 'side', key: /^\(root\) > div\.side-body > div\.file-acts($| > )/, kind: 'extra', reason: "Replace… on an image (9295752, after the mockups): the image level takes the file level's Replace… row (M6c Decision 9), which no mockup state draws" },
	{ state: /^library-image$/, key: /div\.uses > button\.drow > span\.meta$/, kind: 'missing', reason: 'Resolved decisions (Phase 3): "Used on" names the documents, not the slots, since the library\'s usedIn gives documents' },
	{ state: /^settings-brand$/, key: /div\.eds > div\.ed$/, kind: 'style', prop: /^border-top-(width|style)$/, reason: `${SAMPLE}: the rule is between rows, and the demo's editors list has one person (as in M5a's settings states)` },
	// High-street coffee roaster (a case study), as in M5a's case states.
	{ state: /^(alt-missing|media-only|case-cover)$/, key: /div\.prose\.rt > (h3|h2 > br|p > strong)$|div\.refs > div\.ref > span\.yr$/, reason: HARBOUR_SAMPLE },
	// Live: the mockup's sample people.
	{ state: /^fix-alt-locked$/, key: /lock\.note > div > div\.acts$/, kind: 'extra', reason: "Take over (M4 Decision 9, after the mockup): someone else's lock note offers it (as in M4's locked states)" },
	{ state: /^fix-alt-locked$/, key: /field-head > span\.chip\.phone$|lk-field > div\.lk-phone-sum$/, kind: 'extra', reason: `${SAMPLE}: the demo's About hero has phone lines (as in M4's locked states)` },
	{ state: /^(publish-alt|fix-alt-locked)$/, root: 'bar', key: /span\.avs > span\.av\.sm$/, kind: 'style', prop: /^(margin-left|box-shadow)$/, reason: `${SAMPLE}: the mockup's waiting changes are by two people, so its avatars overlap; here one person has changes waiting (as in M5a's live states)` },
	{ key: /details\.fgroup\.is-later$|mk-later/, reason: "the case study's \"Search and sharing\" group is M6's (the mockup marks it \"M6 · not in M5a\"), so it isn't built (as in M5a's states)" },
	{ key: /side-body > details\.fgroup$/, kind: 'missing', reason: `${SAMPLE}: the mockup's sample blocks have an Advanced group (Anchor, Hide on) that the demo's schema doesn't (a group of fields, M3's M5 slot)` },
];
