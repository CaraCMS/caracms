// M5b Phase 4 in a real browser: alt text asked for twice (Decision 9) and the brand's logo
// in Site Settings (Decision 11), on throwaway copies of the demo under `astro dev` (the
// pinned fixture's content) with the in-memory bucket and fake Mux (CARACMS_MEDIA=memory),
// first in local mode, then live on the in-memory GitHub (CARACMS_GITHUB=memory). Nothing
// here touches the real bucket, Mux or a real repo; images don't load (https://img.test),
// so the tests read attributes.
//
// Local:
// 1. A picked image with no alt text yet focuses its alt input with the ask (blue); left
//    empty it turns into the amber warning, which stays while the alt is empty, edited or not.
//    Decorative ends the ask; a clip, an image that brings an alt text, and a brand slot get none.
//    Several picked into a gallery are asked for in turn (Done, then Enter, Tab or Skip),
//    passing over one that brings its alt; leaving for another field ends the run.
// 2. Site Settings' logo: image-only, no alt input, no focal point, written as { key, w, h }.
// Live:
// 3. Publish's summary names "Hero image has no alt text" and "Gallery image 2"; the bar's
//    Publish has the warning dot. Add alt text on a document someone else holds opens it
//    read-only with the field shown; once free, it opens the row expanded with the alt
//    focused. Publish stays enabled, publishes, and after it the warning is gone.
// 4. A logo set in Site Settings reaches the bar's brand and the tab icon on the sweep's
//    next tick, with no Publish.
// 5. Page details closed by hand reopens each time Publish's "Add alt text" is pressed for an
//    image in it, even twice for the same one (GroupField.tsx → useReveal: a popover closing
//    onto a path inside the section counts as a pick). The copy's Contact page gets two page
//    fields, a cover and a thumbnail, holding images with no alt text.
// And: a config with brand.logo (or brand.icon) is refused, pointing at Site Settings.
//
//   node --test --experimental-strip-types test/media-alt.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { resolveSite } from '../src/config.ts';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { AOIFE, CIARAN, eventually, keepState, openAdmin, runtime, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';
import { siteRoot, variant } from './helpers/site.ts';

const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const SIDE = '#side';
const SHOWN = '.side-level:not([hidden])';
const INTRO = `${BLOCK} [data-ff="intro"] textarea`;

/** Used on Visit's first text-and-media block with alt text (the fixture). */
const HARBOUR = 'uploads/3f9a1c07b2e4/harbour-wall.jpg';
const HARBOUR_ALT = 'The harbour wall at low tide';
/** Never used anywhere, so it brings no alt text. */
const KILN = 'uploads/bbbbbbbbbbbb/kiln-door.jpg';
const BENCH = 'uploads/cccccccccccc/bench.jpg';
const DOOR = 'uploads/dddddddddddd/studio-door.jpg';
const SHELF = 'uploads/eeeeeeeeeeee/glaze-shelf.jpg';
/** Phase 0's upload of the demo's mark. */
const MARK = 'uploads/1fb083002e3a/mark.svg';
/** The memory host's signed URL for the mark: it passes through imgproxy's `plain` source. */
const MARK_URL = /^https:\/\/img\.test\/[A-Za-z0-9_-]+\/plain\/s3:\/\/caracms-test-media\/uploads\/1fb083002e3a\/mark\.svg$/;

function seed() {
	const media = memoryMedia();
	media.reset();
	media.bucket.seed(HARBOUR, { w: 4000, h: 2667, name: 'Harbour wall.jpg', uploadedAt: '2026-10-10T09:00:00Z' });
	media.bucket.seed(KILN, { w: 1200, h: 800, name: 'Kiln door.jpg', uploadedAt: '2026-10-11T09:00:00Z' });
	media.bucket.seed(BENCH, { w: 900, h: 1200, name: 'Bench.jpg', uploadedAt: '2026-10-12T09:00:00Z' });
	media.bucket.seed(DOOR, { w: 1200, h: 1500, name: 'Studio door.jpg', uploadedAt: '2026-10-13T09:00:00Z' });
	media.bucket.seed(SHELF, { w: 1200, h: 1500, name: 'Glaze shelf.jpg', uploadedAt: '2026-10-14T09:00:00Z' });
	media.bucket.seed(MARK, { w: 32, h: 32, name: 'mark.svg', uploadedAt: '2026-10-16T09:00:00Z' });
	return media;
}

const activeAlt = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-alt') ?? null);

/** Pick a library tile into a slot: press the slot's Choose… (or Replace…), then the tile. */
async function pick(page: Page, slot: string, tile: string) {
	const choose = page.locator(`${slot} .mdrop .btn, ${slot} .media .btn:has-text("Replace…")`).first();
	await choose.click();
	await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
	await page.click(`${SIDE} ${tile}`);
}

describe('alt text and the brand, local (M5b Phase 4)', { skip: browserSkip }, () => {
	let site: DevSite;
	let browser: Browser;
	const FILE = 'content/pages/visit.json';
	const stored = (index: number, field: string): unknown => (JSON.parse(site.read(FILE)) as { blocks: Record<string, unknown>[] }).blocks[index]![field];
	const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

	async function open(path: string): Promise<Page> {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.on('pageerror', (error) => console.error('[page]', error.message));
		await page.goto(site.origin + path);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
		return page;
	}
	async function openBlock(page: Page, index: number) {
		if (!(await page.isVisible(DOC))) await page.click(`${SIDE} .lv >> nth=-1`);
		await page.click(`${DOC} .blist .brow-main >> nth=${index}`);
		await page.waitForSelector(`${BLOCK} .field-frame`);
	}

	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		const media = seed();
		media.mux.seedClip({ playbackId: 'kilnclip01', title: 'Kiln at dusk', mp4: 'ready', duration: 9.6, w: 1920, h: 1080 });
		site = await startDevSite('media-alt-local');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
		memoryMedia().reset();
		delete process.env.CARACMS_MEDIA;
	});

	test('a picked image with no alt text focuses its alt input with the ask; left empty, the amber warning stays', async () => {
		const page = await open('/admin/pages/visit');
		await openBlock(page, 3);
		const field = `${BLOCK} [data-ff="media"]`;
		await pick(page, field, `.mtile[data-key="${KILN}"]`);
		await eventually(() => sameJson(stored(3, 'media'), { key: KILN, alt: '', w: 1200, h: 800 }), 10000, 'placed');
		await eventually(async () => (await activeAlt(page)) === 'media', 4000, 'the alt input focused');
		const ask = (await page.textContent(`${field} [data-altmsg][data-ask] .field-ask`))!;
		assert.match(ask, /^Describe the picture in a sentence, or tick Decorative\./);
		assert.equal(await page.getAttribute(`${field} input[data-alt="media"]`, 'aria-invalid'), null, 'asking is blue, not a warning');
		assert.equal(await page.locator(`${field} [data-altmsg] .field-warn`).count(), 0);

		// Skipped (focus leaves with it empty): the amber warning.
		await page.keyboard.press('Tab');
		await page.waitForSelector(`${field} [data-altmsg] .field-warn >> text=No alt text yet`);
		assert.equal(await page.locator(`${field} [data-ask]`).count(), 0);
		assert.equal(await page.getAttribute(`${field} input[data-alt="media"]`, 'aria-invalid'), 'true');

		// Written, then emptied again: the warning goes, then comes back (edited or not).
		await page.fill(`${field} input[data-alt="media"]`, 'The kiln door, open');
		await page.waitForSelector(`${field} [data-altmsg] .field-warn`, { state: 'detached' });
		await page.fill(`${field} input[data-alt="media"]`, '');
		await page.waitForSelector(`${field} [data-altmsg] .field-warn >> text=No alt text yet`);
		await eventually(() => sameJson(stored(3, 'media'), { key: KILN, alt: '', w: 1200, h: 800 }), 10000, 'empty again in the file');
		await page.close();
	});

	test('Decorative ends the ask; an image that brings its alt text and a clip get none', async () => {
		const page = await open('/admin/pages/visit');
		await openBlock(page, 3);
		const field = `${BLOCK} [data-ff="media"]`;
		// A new image: asked again; ticking Decorative answers it, with no warning.
		await pick(page, field, `.mtile[data-key="${BENCH}"]`);
		await page.waitForSelector(`${field} [data-ask] .field-ask`);
		await page.check(`${field} .deco input`);
		await page.waitForSelector(`${field} [data-altmsg] .field-hint >> text=screen readers skip it`);
		assert.equal(await page.locator(`${field} [data-ask]`).count(), 0);
		assert.equal(await page.locator(`${field} .field-warn`).count(), 0);
		await eventually(() => sameJson(stored(3, 'media'), { key: BENCH, alt: '', decorative: true, w: 900, h: 1200 }), 10000, 'decorative');

		// An image already used with alt text brings it: no ask, no warning.
		await pick(page, field, `.mtile[data-key="${HARBOUR}"]`);
		await eventually(async () => (await page.inputValue(`${field} input[data-alt="media"]`).catch(() => '')) === HARBOUR_ALT, 8000, 'the alt it brings');
		assert.equal(await page.locator(`${field} [data-ask]`).count(), 0);
		assert.notEqual(await activeAlt(page), 'media');

		// A clip has no alt text: nothing asks.
		await pick(page, field, '.lib-bar [role="radio"][data-v="clips"]');
		await page.click(`${SIDE} .mtile[data-clip]:not([disabled])`);
		await eventually(() => (stored(3, 'media') as { video?: string }).video === 'kilnclip01', 10000, 'the clip placed');
		await page.waitForSelector(`${field} [role="radiogroup"]`);
		assert.equal(await page.locator(`${field} input[data-alt]`).count(), 0);
		assert.equal(await page.locator(`${field} [data-ask]`).count(), 0);
		await page.close();
	});

	test('several picked into a gallery are asked for in turn: Done opens the first, Enter or Tab the next; one bringing its alt is passed over', async () => {
		const page = await open('/admin/pages/visit');
		await openBlock(page, 4);
		const n = (stored(4, 'images') as unknown[]).length;
		const row = (i: number) => `${BLOCK} [data-list="images"] [data-row="${i}"]`;
		const asked = (i: number) => `${row(i)}.is-open [data-altmsg][data-ask] .field-ask`;
		const addImages = async (keys: string[]) => {
			await page.click(`${BLOCK} [data-ff="images"] .list-foot .linkbtn`);
			await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
			for (const key of keys) await page.click(`${SIDE} .mtile[data-key="${key}"]`);
			await page.click(`${SIDE} [data-act="pick-done"]`);
		};
		// The harbour wall brings its alt text; the door and the shelf don't.
		await addImages([DOOR, HARBOUR, SHELF]);
		await eventually(() => (stored(4, 'images') as unknown[]).length === n + 3, 10000, 'three rows');
		await page.waitForSelector(asked(n));
		await eventually(async () => (await activeAlt(page)) === `images.${n}`, 4000, 'the first one’s alt focused');
		await page.keyboard.type('The studio door, ajar');
		await page.keyboard.press('Enter');
		// The harbour wall is passed over: the shelf's row opens, asking.
		await page.waitForSelector(asked(n + 2));
		await eventually(async () => (await activeAlt(page)) === `images.${n + 2}`, 4000, 'the third one’s alt focused');
		assert.equal(await page.locator(`${row(n)}.is-open`).count(), 0, 'the first row closed');
		await eventually(() => (stored(4, 'images') as { alt: string }[])[n]!.alt === 'The studio door, ajar', 10000, 'the first alt written');
		assert.equal((stored(4, 'images') as { alt: string }[])[n + 1]!.alt, HARBOUR_ALT);
		// The last one skipped: the run ends with its amber warning.
		await page.click(`${row(n + 2)} [data-act="alt-skip"]`);
		await page.waitForSelector(`${row(n + 2)} [data-altmsg] .field-warn >> text=No alt text yet`);
		assert.equal(await page.locator(`${BLOCK} [data-ask]`).count(), 0);

		// Again with two that need it: Tab moves on too, and leaving for another field ends the run.
		await addImages([BENCH, KILN]);
		await eventually(() => (stored(4, 'images') as unknown[]).length === n + 5, 10000, 'five rows');
		await page.waitForSelector(asked(n + 3));
		await eventually(async () => (await activeAlt(page)) === `images.${n + 3}`, 4000, 'the bench’s alt focused');
		await page.keyboard.press('Tab');
		await page.waitForSelector(asked(n + 4));
		await eventually(async () => (await activeAlt(page)) === `images.${n + 4}`, 4000, 'the kiln door’s alt focused');
		await page.click(`${BLOCK} [data-ff="heading"] :is(input, textarea)`);
		await page.waitForSelector(`${row(n + 4)} [data-altmsg] .field-warn >> text=No alt text yet`);
		assert.equal(await page.locator(`${BLOCK} [data-ask]`).count(), 0, 'the run ended');
		// The bench, skipped with Tab, is amber on its row and not asked when opened again.
		assert.equal(await page.locator(`${row(n + 3)}.is-warn`).count(), 1);
		await page.click(`${row(n + 3)} .item-sum`);
		await page.waitForSelector(`${row(n + 3)}.is-open [data-altmsg] .field-warn`);
		assert.equal(await page.locator(`${BLOCK} [data-ask]`).count(), 0);
		await page.close();
	});

	test('Site Settings’ logo: image-only, no alt input and no focal point, written as { key, w, h }; the next request has it', async () => {
		const page = await open('/admin/settings');
		const slot = `${SHOWN} [data-ff="brand.logo"]`;
		await page.waitForSelector(`${slot} .mdrop.sm`);
		assert.match((await page.textContent(`${slot} .field-help`))!, /None yet: the editor shows its own plain mark\./);
		assert.match((await page.textContent(`${SHOWN} [data-ff="brand.icon"] .field-help`))!, /None yet: the tab uses the logo\./);
		await page.click(`${slot} .mdrop .btn`);
		await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		assert.equal(await page.locator(`${SIDE} .lib-bar [role="radio"][data-v="clips"]`).count(), 0, 'images only');
		await page.click(`${SIDE} .mtile[data-key="${MARK}"]`);
		await page.waitForSelector(`${slot} .media.compact`);
		await eventually(async () => /Logo updated/.test((await page.textContent('#toast-root')) ?? ''), 4000, 'the toast');
		assert.equal(await page.locator(`${slot} input[data-alt]`).count(), 0, 'no alt input');
		assert.equal(await page.locator(`${slot} .fp, ${slot} [aria-label="Focal point"]`).count(), 0, 'no focal point');
		assert.equal(await page.locator(`${SHOWN} [data-ask]`).count(), 0, 'nothing asks');
		await eventually(() => {
			const brand = (JSON.parse(site.read('content/site-settings.json')) as { brand: { logo?: unknown } }).brand;
			return sameJson(brand.logo, { key: MARK, w: 32, h: 32 });
		}, 10000, 'the file has { key, w, h }');
		// Local mode applies on the next request: the bar's brand and the tab (no icon: the logo).
		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]');
		assert.match((await page.getAttribute('#bar .logo-slot img', 'src'))!, MARK_URL);
		assert.match((await page.getAttribute('link[rel="icon"]', 'href'))!, MARK_URL);
		await page.close();
	});
});

describe('alt text at Publish and the brand, live (M5b Phase 4)', { skip: browserSkip }, () => {
	const TIMINGS = { sweepIdleMs: 1500, sweepTickMs: 500, sweepCapMs: 10_000, lockLapseMs: 20_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 1000 };
	let live: LiveSite;
	let browser: Browser;

	const waitingNote = (file: string) => `[data-pop="waiting"] [data-waiting="${file}"] [data-note="alt-text"]`;
	async function openPublish(page: Page) {
		if (!(await page.$('[data-pop="waiting"]'))) await page.click('#bar button.pub');
		await page.waitForSelector('[data-pop="waiting"]');
	}
	const kept = (page: Page) => eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');

	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		seed();
		live = await startLiveSite('media-alt-live', { CARACMS_TIMINGS: JSON.stringify(TIMINGS), CARACMS_MEDIA: 'memory' });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
		memoryMedia().reset();
		delete process.env.CARACMS_MEDIA;
	});

	test('Publish names each image without alt text; Add alt text opens it (read-only while held); Publish goes through and the warning goes', async () => {
		const { site } = live;
		const a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin');
		// Home's hero gets an image with no alt text (the ask shows, and it's skipped).
		await a.click('.brow-main >> nth=0');
		await a.waitForSelector(`${BLOCK} [data-ff="media"]`);
		await pick(a, `${BLOCK} [data-ff="media"]`, `.mtile[data-key="${KILN}"]`);
		await a.waitForSelector(`${BLOCK} [data-ff="media"] [data-ask]`);
		await kept(a);
		// Visit's gallery image 2 is no longer decorative, so it has no alt text either (image 3 has none in the fixture).
		await a.goto(`${site.origin}/admin/pages/visit`);
		await a.waitForSelector('#stage[data-painted="true"]');
		await a.click(`${DOC} .blist .brow-main >> nth=4`);
		await a.click(`${BLOCK} [data-list="images"] [data-row="1"] .item-sum`);
		await a.uncheck(`${BLOCK} [data-list="images"] [data-row="1"] .deco input`);
		await kept(a);
		await a.goto(`${site.origin}/admin`);
		await a.waitForSelector('#stage[data-painted="true"]');

		// Ciarán is in Visit: he holds it.
		const b = await openAdmin(await signedIn(browser, site, CIARAN), site, '/admin/pages/visit');
		await b.click('.brow-main >> nth=0');
		await b.waitForSelector(INTRO);
		await b.fill(INTRO, 'Up the stairs beside the bakery. Ciarán was here.');
		await kept(b);

		// The bar: a warning dot on the count, and Publish still on.
		await eventually(async () => (await a.locator('#bar [data-dot="alt"]').count()) === 1, 15_000, 'the warning dot');
		assert.match((await a.getAttribute('#bar button.pub', 'aria-label'))!, /, 3 images without alt text\. Publish$/);
		await openPublish(a);
		await eventually(async () => (await a.locator(waitingNote('content/pages/visit.json')).count()) === 1, 15_000, 'Visit marked');
		assert.match((await a.textContent(waitingNote('content/pages/index.json')))!, /^Hero image has no alt text/);
		const visit = (await a.textContent(waitingNote('content/pages/visit.json')))!;
		assert.match(visit, /^2 images have no alt text/);
		await eventually(async () => /ciaran is editing Visit, so it opens read-only for now\./i.test((await a.textContent(waitingNote('content/pages/visit.json'))) ?? ''), 15_000, 'Visit held by Ciarán');
		assert.deepEqual(await a.locator(`${waitingNote('content/pages/visit.json')} .alt-row .t`).allTextContents(), ['Gallery image 2', 'Gallery image 3']);
		assert.equal(await a.isDisabled('[data-pop="waiting"] [data-act="publish"]'), false, 'Publish stays on');
		assert.equal(await a.locator('[data-pop="waiting"] [data-slot="alt-text-blocks"]').count(), 0, 'the line under Publish is cut (copy scrub)');

		// Held by Ciarán: Visit opens read-only, the row open and the alt shown, not focused.
		await a.click(`${waitingNote('content/pages/visit.json')} [data-alt-row="images.1.alt"] [data-act="fix-alt"]`);
		await eventually(() => new URL(a.url()).pathname === '/admin/pages/visit', 10_000, 'Visit opens');
		await a.waitForSelector(`${BLOCK} [data-list="images"] [data-row="1"].is-open input[data-alt="images.1"]`);
		await eventually(() => a.isDisabled(`${BLOCK} input[data-alt="images.1"]`), 10_000, 'read-only: Ciarán is editing');
		assert.notEqual(await activeAlt(a), 'images.1');

		// Ciarán leaves; now Add alt text opens the row expanded with the alt focused.
		await b.close({ runBeforeUnload: true });
		await eventually(async () => !(await a.isDisabled(`${BLOCK} input[data-alt="images.1"]`)), 30_000, 'the lock goes');
		await openPublish(a);
		await eventually(async () => (await a.locator(`${waitingNote('content/pages/visit.json')} [data-held]`).count()) === 0, 15_000, 'no longer held');
		await openPublish(a);
		await a.click(`${waitingNote('content/pages/visit.json')} [data-alt-row="images.1.alt"] [data-act="fix-alt"]`);
		await a.waitForSelector(`${BLOCK} [data-list="images"] [data-row="1"].is-open`);
		await eventually(async () => (await activeAlt(a)) === 'images.1', 6000, 'the gallery alt focused');
		await a.keyboard.type('A glaze test tile');
		await kept(a);

		// And Home's hero, from Visit.
		await openPublish(a);
		await a.click(`${waitingNote('content/pages/index.json')} [data-act="fix-alt"]`);
		await eventually(() => new URL(a.url()).pathname === '/admin', 10_000, 'Home opens');
		await eventually(async () => (await activeAlt(a)) === 'media', 6000, 'the hero alt focused');
		await a.keyboard.type('The kiln door, open');
		await kept(a);

		// One image is still without alt text; Publish goes through all the same.
		await openPublish(a);
		await eventually(async () => (await a.locator(waitingNote('content/pages/index.json')).count()) === 0, 15_000, 'Home has its alt text');
		assert.match((await a.textContent(waitingNote('content/pages/visit.json')))!, /^Gallery image 3 has no alt text/);
		const rt = await runtime();
		const mainBefore = rt.backend.refs.get('main');
		await a.click('[data-pop="waiting"] [data-act="publish"]');
		await eventually(() => rt.backend.refs.get('main') !== mainBefore, 15_000, 'published to main');
		assert.match(rt.backend.file('main', 'starter/content/pages/visit.json')!, /"alt": "A glaze test tile"/);
		assert.match(rt.backend.file('main', 'starter/content/pages/index.json')!, /"alt": "The kiln door, open"/);
		await eventually(async () => (await a.getAttribute('#bar [data-slot="publish"]', 'data-pub')) !== 'waiting', 15_000, 'nothing waiting');
		assert.equal(await a.locator('#bar [data-dot="alt"]').count(), 0, 'the dot is gone');
		assert.equal(await a.locator('[data-note="alt-text"]').count(), 0, 'the summary is gone');
		await a.context().close();
	});

	test('a logo set in Site Settings reaches the bar’s brand and the tab icon on the sweep’s next tick, with no Publish', async () => {
		const { site } = live;
		const a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/settings');
		const rt = await runtime();
		const mainBefore = rt.backend.refs.get('main');
		assert.equal(await a.locator('#bar .logo-slot img').count(), 0, 'the neutral mark first');
		await a.click(`${SHOWN} [data-ff="brand.logo"] .mdrop .btn`);
		await a.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		await a.click(`${SIDE} .mtile[data-key="${MARK}"]`);
		await a.waitForSelector(`${SHOWN} [data-ff="brand.logo"] .media.compact`);
		const started = Date.now();
		await eventually(async () => MARK_URL.test((await a.getAttribute('#bar .logo-slot img', 'src').catch(() => null)) ?? ''), 60_000, 'the bar\'s logo');
		console.log(`[brand] the logo applied ${Date.now() - started} ms after it was placed`);
		assert.match((await a.getAttribute('link[rel="icon"]', 'href'))!, MARK_URL, 'no icon: the tab uses the logo');
		assert.match(rt.git.read('content/site-settings.json')!, /"logo": \{ "key": "uploads\/1fb083002e3a\/mark\.svg", "w": 32, "h": 32 \}/);
		assert.equal(rt.backend.refs.get('main'), mainBefore, 'main is unchanged: no Publish');
		await a.context().close();
	});
});

describe('Add alt text reopens a closed Page details (editor friction, item 5)', { skip: browserSkip }, () => {
	const TIMINGS = { sweepIdleMs: 1500, sweepTickMs: 500, sweepCapMs: 10_000, lockLapseMs: 20_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 1000 };
	let live: LiveSite;
	let browser: Browser;

	/** The copy's pages get two image page fields, and Contact fills both with an image and no alt text (the pinned fixture is untouched). */
	function edit(root: string) {
		const file = join(root, 'caracms.config.ts');
		const config = readFileSync(file, 'utf8')
			.replace("import { defineSite } from 'caracms/config';", "import { defineSite, media } from 'caracms/config';")
			.replace(
				"pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },",
				"pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true, fields: { cover: media({ only: 'image', label: 'Cover image' }), thumb: media({ only: 'image', label: 'Thumbnail image' }) } },",
			);
		if (!config.includes('thumb: media(')) throw new Error("the copy's config didn't take its page fields");
		writeFileSync(file, config);
		const contact = join(root, 'content/pages/contact.json');
		const doc = JSON.parse(readFileSync(contact, 'utf8')) as Record<string, unknown>;
		const { title, blocks, ...rest } = doc;
		writeFileSync(
			contact,
			JSON.stringify({ title, cover: { key: KILN, alt: '', w: 1200, h: 800 }, thumb: { key: BENCH, alt: '', w: 900, h: 1200 }, blocks, ...rest }, null, 2),
		);
	}

	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		seed();
		live = await startLiveSite('media-alt-page-live', { CARACMS_TIMINGS: JSON.stringify(TIMINGS), CARACMS_MEDIA: 'memory' }, { edit });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
		memoryMedia().reset();
		delete process.env.CARACMS_MEDIA;
	});

	test('Add alt text twice for the same page-field image, with Page details closed by hand in between, opens it both times', async () => {
		const { site } = live;
		const a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/pages/contact');
		// Make Contact waiting, so Publish lists it with its two images.
		await a.click('.brow-main >> nth=0');
		await a.waitForSelector(INTRO);
		await a.fill(INTRO, 'hello@example.com\n+353 1 555 0142\nOr drop in.');
		await eventually(async () => (await keepState(a)) === 'kept', 10_000, 'Kept');

		const details = a.locator(`${DOC} details.page-fields`);
		const row = '[data-pop="waiting"] [data-note="alt-text"] [data-alt-row="cover.alt"] [data-act="fix-alt"]';
		const addAltText = async () => {
			if (!(await a.$('[data-pop="waiting"]'))) await a.click('#bar button.pub');
			await a.waitForSelector(row);
			await a.click(row);
		};
		const isOpen = () => details.evaluate((el) => (el as HTMLDetailsElement).open);

		await addAltText();
		await eventually(async () => (await details.count()) === 1 && (await isOpen()), 6000, 'Page details open the first time');
		await eventually(async () => (await activeAlt(a)) === 'cover', 6000, 'the cover alt focused');

		// Closed by hand: it stays closed, with the warnings marked on it.
		await details.locator('> summary').click();
		await eventually(async () => !(await isOpen()), 4000, 'Page details closed by hand');
		await a.waitForSelector(`${DOC} details.page-fields > summary [data-wmark="2"]`);

		// The same image again, nothing typed: the popover closing onto the same path opens it.
		await addAltText();
		await eventually(isOpen, 6000, 'Page details open the second time');
		await eventually(async () => (await activeAlt(a)) === 'cover', 6000, 'the cover alt focused again');
		await a.context().close();
	});
});

describe('the config\'s logo and icon (M5b Decision 11)', () => {
	test('a config with brand.logo or brand.icon is refused, pointing at Site Settings', () => {
		assert.throws(() => resolveSite(variant({ brand: { logo: '/mark.svg' } }), siteRoot), /brand\.logo has moved to Site Settings \(content\/site-settings\.json → "brand": \{ "logo", "icon" \}, uploaded in the editor's Site Settings\), so the editor can change it; take it out of the config\./);
		assert.throws(() => resolveSite(variant({ brand: { icon: '/mark.svg' } }), siteRoot), /brand\.icon has moved to Site Settings/);
	});
});
