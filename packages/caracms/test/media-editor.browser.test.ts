// M5b Phase 3 in a real browser: the media field and the library in the editor, on a
// throwaway copy of the demo under `astro dev` (helpers/dev-site.ts, the pinned fixture's
// content) with the in-memory bucket and fake Mux (CARACMS_MEDIA=memory). Nothing here
// touches the real bucket or Mux, and images in the preview don't load (the memory host is
// https://img.test), which is expected: the tests read the <img>'s attributes.
//
// 1. Upload two images in the library and pick one into an empty text-and-media block: the
//    file gets Decision 3's value (keys in order, `alt` "", `w`/`h`).
// 2. Set a focal point with the keys: the file's `focal` follows, and the preview's <img>
//    carries the gravity (`g:fp:`) and `object-position`.
// 3. Swap the image: the alt and the focal point are the ones already used for it (the old
//    picture's point never carries over), and Reset to centre still clears it.
// 4. A seeded clip, once ready, is placed as a loop and switched to a player.
// 4b. A loop-only slot (the hero) shows no Plays as, and a clip placed over a player clip is stored as a loop.
// 5. The unused toggle hides the image no document uses, and is remembered.
// 6. Decorative: ticking writes `"decorative": true` with `"alt": ""`; unticking removes it.
// 7. A preview click on a placed image opens its field; on a gallery image, its row.
// 8. A file the library refuses (a PDF) keeps its note while the library is open, and
//    loses it once the library is left or a slot's picker opens.
//
//   node --test --experimental-strip-types test/media-editor.browser.test.ts
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { memoryMedia } from '../src/editor/server/media/memory.ts';

let site: DevSite;
let browser: Browser;

const FILE = 'content/pages/visit.json';
const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const SIDE = '#side';
/** The fixture's harbour wall: used on Visit's first text-and-media block with alt text. */
const HARBOUR = 'uploads/3f9a1c07b2e4/harbour-wall.jpg';
const HARBOUR_ALT = 'The harbour wall at low tide';
const NEVER = 'uploads/aaaaaaaaaaaa/never-placed.jpg';

// ── A real PNG, so the server's sniffing reads its size ──
const CRC = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
})();
function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(4);
	head.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(CRC(body));
	return Buffer.concat([head, body, crc]);
}
function png(w: number, h: number, shade: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const rows = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.fill(shade, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	return page;
}

async function eventually<T>(check: () => T | Promise<T>, timeout = 8000, what = 'the condition'): Promise<T> {
	const end = Date.now() + timeout;
	let last: unknown;
	while (Date.now() < end) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/** Block `index`'s stored field, as the file has it now. */
const stored = (index: number, field: string): unknown => (JSON.parse(site.read(FILE)) as { blocks: Record<string, unknown>[] }).blocks[index]![field];
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Wait until the file's block field is `want` (JSON, keys in order). */
async function fileHas(index: number, field: string, want: unknown, what: string) {
	await eventually(() => sameJson(stored(index, field), want), 10000, `${what}: ${JSON.stringify(want)} (has ${JSON.stringify(stored(index, field))})`);
}

/** Open Visit's block `index` from the document level. */
async function openBlock(page: Page, index: number) {
	if (!(await page.isVisible(DOC))) await page.click(`${SIDE} .lv >> nth=-1`);
	await page.click(`${DOC} .blist .brow-main >> nth=${index}`);
	await page.waitForSelector(`${BLOCK} .field-frame`);
}

/** The desktop preview's element for a field of block `index`. */
const frame = (page: Page) => page.frameLocator('#stage iframe[data-width="1440"]');

describe('the media field and the library (M5b Phase 3)', { skip: browserSkip }, () => {
	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		const media = memoryMedia();
		media.reset();
		media.bucket.seed(HARBOUR, { w: 4000, h: 2667, name: 'Harbour wall.jpg', uploadedAt: '2026-10-10T09:00:00Z' });
		media.bucket.seed(NEVER, { w: 1200, h: 800, name: 'never-placed.jpg', uploadedAt: '2026-10-11T09:00:00Z' });
		site = await startDevSite('media-editor');
		browser = await chromium.launch();
	});

	after(async () => {
		await browser?.close();
		await site?.close();
		memoryMedia().reset();
		delete process.env.CARACMS_MEDIA;
	});

	test('upload two images and pick one into a text-and-media block: Decision 3’s value', async () => {
		const page = await open('/admin/pages/visit');
		// Site-wide → Media, then Upload… with two files at once.
		await page.click(`${SIDE} .lv >> nth=0`);
		await page.click(`${SIDE} .media-row`);
		await page.waitForSelector(`${SIDE} [data-media-mode="browse"]`);
		await page.locator(`${SIDE} [data-lib-file]`).first().setInputFiles([
			{ name: 'kiln-door.png', mimeType: 'image/png', buffer: png(30, 20, 90) },
			{ name: 'bench.png', mimeType: 'image/png', buffer: png(16, 20, 160) },
		]);
		await page.locator(`${SIDE} .mtile[data-key]`, { hasText: 'kiln-door.png' }).waitFor();
		await page.locator(`${SIDE} .mtile[data-key]`, { hasText: 'bench.png' }).waitFor();
		assert.match((await page.locator(`${SIDE} .mtile[data-key]`, { hasText: 'bench.png' }).textContent())!, /Just added/);
		// The stage under the library is dimmed and is the drop target.
		assert.equal(await page.isVisible('#stage-aside [data-drop="lib"]'), true);

		// Back to Visit, its empty text-and-media block (index 3), Choose…, and one click places it.
		await page.click('#stage-aside .btn.ghost');
		await openBlock(page, 3);
		await page.click(`${BLOCK} [data-ff="media"] .mdrop .btn`);
		await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		assert.match((await page.textContent(`${SIDE} [data-pane-level="media"] .cur`))!, /Choose an image or a clip/);
		const tile = page.locator(`${SIDE} .mtile[data-key]`, { hasText: 'bench.png' });
		const key = (await tile.getAttribute('data-key'))!;
		assert.match(key, /^uploads\/[0-9a-f]{12}\/bench\.png$/);
		await tile.click();
		await page.waitForSelector(`${BLOCK} [data-ff="media"] .media`);
		await fileHas(3, 'media', { key, alt: '', w: 16, h: 20 }, 'placed');
		assert.deepEqual(Object.keys(stored(3, 'media') as object), ['key', 'alt', 'w', 'h']);
		// Placed with no alt text, it's asked for (Phase 4); skipped, the warning is the amber missing-alt one, on the alt input.
		await page.waitForSelector(`${BLOCK} [data-ff="media"] [data-altmsg][data-ask] .field-ask`);
		await page.click(`${BLOCK} [data-ff="media"] [data-act="alt-skip"]`);
		assert.match((await page.textContent(`${BLOCK} [data-ff="media"] [data-altmsg] .field-warn`))!, /No alt text yet/);
		assert.equal(await page.getAttribute(`${BLOCK} [data-ff="media"] input[data-alt="media"]`, 'aria-invalid'), 'true');
		await page.close();
	});

	test('the focal point with the keys: the file follows, and the preview’s <img> has the gravity and object-position', async () => {
		const page = await open('/admin/pages/visit');
		await openBlock(page, 3);
		await page.click(`${BLOCK} [data-ff="media"] .media-acts button[aria-expanded]`);
		await page.focus(`${BLOCK} [data-ff="media"] .fp-img`);
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowUp');
		await eventually(async () => (await page.textContent(`${BLOCK} .fp-val`))?.includes('60% across · 45% down'), 2000, 'the ring moved');
		await eventually(() => sameJson((stored(3, 'media') as { focal?: unknown }).focal, [0.6, 0.45]), 10000, 'the focal point in the file');
		assert.deepEqual(Object.keys(stored(3, 'media') as object), ['key', 'alt', 'focal', 'w', 'h']);
		const img = frame(page).locator('[data-cms-block="3"] img[data-cms-field="media"]');
		await eventually(async () => (await img.getAttribute('src'))?.includes('/g:fp:0.6:0.45/'), 10000, 'the gravity in the preview');
		assert.match((await img.getAttribute('srcset'))!, /g:fp:0\.6:0\.45/);
		assert.match((await img.getAttribute('style'))!, /object-position:\s*60% 45%/);
		// The image's own preview in the field is the server's signed thumbnail, never the original.
		assert.match((await page.getAttribute(`${BLOCK} [data-ff="media"] .fp-img img`, 'src'))!, /^\/_caracms\/media\/thumbnail\?key=/);
		await page.close();
	});

	test('swapping the image brings the alt and the focal point already used for it; Reset to centre clears it', async () => {
		const page = await open('/admin/pages/visit');
		await openBlock(page, 3);
		await page.click(`${BLOCK} [data-ff="media"] .media-acts .btn >> text=Replace…`);
		await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		await page.click(`${SIDE} .mtile[data-key="${HARBOUR}"]`);
		// Block 1's harbour wall has [0.4, 0.3]; block 3's own [0.6, 0.45] was the other picture's.
		await fileHas(3, 'media', { key: HARBOUR, alt: HARBOUR_ALT, focal: [0.4, 0.3], w: 4000, h: 2667 }, 'swapped');
		await page.waitForSelector(`${BLOCK} [data-ff="media"] .field-hint >> text=Already used for this image on Visit`);
		const img = frame(page).locator('[data-cms-block="3"] img[data-cms-field="media"]');
		await eventually(async () => (await img.getAttribute('src'))?.includes('/g:fp:0.4:0.3/'), 10000, 'the brought focal point in the preview');
		await page.click(`${BLOCK} [data-ff="media"] .media-acts button[aria-expanded]`);
		await eventually(async () => (await page.textContent(`${BLOCK} .fp-val`))?.includes('40% across · 30% down'), 2000, 'the field shows it');
		await page.click(`${BLOCK} [data-ff="media"] button >> text=Reset to centre`);
		await fileHas(3, 'media', { key: HARBOUR, alt: HARBOUR_ALT, w: 4000, h: 2667 }, 'reset to centre');
		await eventually(async () => !(await img.getAttribute('src'))?.includes('/g:fp:'), 10000, 'no gravity in the preview');
		await page.close();
	});

	test('a seeded clip, once ready, is placed as a loop and switched to a player', async () => {
		const mux = memoryMedia().mux;
		const asset = mux.seedClip({ playbackId: 'kilnclip01', title: 'Kiln at dusk', mp4: 'preparing', duration: 9.6, w: 1920, h: 1080 });
		const page = await open('/admin/pages/visit');
		await openBlock(page, 3);
		await page.click(`${BLOCK} [data-ff="media"] .media-acts .btn >> text=Replace…`);
		await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		await page.click(`${SIDE} .lib-bar [role="radio"][data-v="clips"]`);
		const tile = page.locator(`${SIDE} .mtile[data-clip="${asset}"]`);
		await tile.waitFor();
		assert.equal(await tile.isDisabled(), true, 'not placeable while its MP4 is preparing');
		mux.ready(asset);
		await eventually(async () => !(await tile.isDisabled()), 10000, 'the clip ready (polled)');
		await tile.click();
		await fileHas(3, 'media', { video: 'kilnclip01', play: 'loop', duration: 9.6, w: 1920, h: 1080 }, 'placed as a loop');
		await page.click(`${BLOCK} [data-ff="media"] [role="radio"] >> text=Player`);
		await fileHas(3, 'media', { video: 'kilnclip01', play: 'player', duration: 9.6, w: 1920, h: 1080 }, 'a player');
		await page.fill(`${BLOCK} [data-ff="media"] input[data-clip-name]`, 'The kiln');
		await fileHas(3, 'media', { video: 'kilnclip01', play: 'player', name: 'The kiln', duration: 9.6, w: 1920, h: 1080 }, 'named');
		await page.close();
	});

	test('a loop-only slot (the hero): no Plays as control, and a clip placed over a player clip stores "play": "loop"', async () => {
		// The fixture's hero holds a clip an agent wrote as a player (Decision 10: a hero can't carry one).
		const mux = memoryMedia().mux;
		const asset = mux.seedClip({ playbackId: 'heroclip001', title: 'Hero kiln', duration: 8.2, w: 1920, h: 1080 });
		const page = await open('/admin/pages/visit');
		await openBlock(page, 0);
		const field = `${BLOCK} [data-ff="media"]`;
		assert.equal(await page.locator(`${field} [role="radiogroup"]`).count(), 0, 'no Plays as');
		assert.equal(await page.locator(`${field} input[data-clip-name]`).count(), 0, 'no name for screen readers on a loop');
		assert.match((await page.textContent(`${field} .field-hint`))!, /Silent loop; reduced-motion users see the poster\./);
		await page.click(`${field} .media-acts .btn >> text=Replace…`);
		await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		await page.click(`${SIDE} .lib-bar [role="radio"][data-v="clips"]`);
		const tile = page.locator(`${SIDE} .mtile[data-clip="${asset}"]`);
		await tile.waitFor();
		await eventually(async () => !(await tile.isDisabled()), 10000, 'the clip ready');
		await tile.click();
		// The name carries over from the old clip, the poster resets, and play is forced to loop.
		await fileHas(0, 'media', { video: 'heroclip001', play: 'loop', name: 'The kiln at dusk', duration: 8.2, w: 1920, h: 1080 }, 'a loop in the hero');
		await page.close();
	});

	test('the unused toggle hides the image no document uses, and the browser remembers it', async () => {
		const page = await open('/admin/pages/visit');
		await page.click(`${SIDE} .lv >> nth=0`);
		await page.click(`${SIDE} .media-row`);
		const never = `${SIDE} .mtile[data-key="${NEVER}"]`;
		const harbour = `${SIDE} .mtile[data-key="${HARBOUR}"]`;
		await page.waitForSelector(never);
		assert.equal(await page.getAttribute(`${SIDE} [data-act="lib-unused"]`, 'aria-checked'), 'true', 'on by default');
		assert.match((await page.textContent(never))!, /Unused/);
		await page.click(`${SIDE} [data-act="lib-unused"]`);
		await page.waitForSelector(never, { state: 'detached' });
		assert.equal(await page.isVisible(harbour), true, 'a used image still shows');
		assert.match((await page.textContent(`${SIDE} [data-act="lib-unused"]`))!, /hidden/);
		// Nothing was deleted: it's still in the bucket.
		assert.ok(memoryMedia().bucket.objects.has(NEVER));
		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]');
		await page.click(`${SIDE} .lv >> nth=0`);
		await page.click(`${SIDE} .media-row`);
		await page.waitForSelector(harbour);
		assert.equal(await page.getAttribute(`${SIDE} [data-act="lib-unused"]`, 'aria-checked'), 'false', 'remembered');
		assert.equal(await page.isVisible(never), false);
		await page.click(`${SIDE} [data-act="lib-unused"]`);
		await page.waitForSelector(never);
		await page.close();
	});

	test('Decorative: ticking writes "decorative": true with "alt": ""; unticking removes it and the warning comes back', async () => {
		const page = await open('/admin/pages/visit');
		await openBlock(page, 1);
		const field = `${BLOCK} [data-ff="media"]`;
		await page.check(`${field} .deco input`);
		await fileHas(1, 'media', { key: HARBOUR, alt: '', decorative: true, focal: [0.4, 0.3], w: 4000, h: 2667 }, 'decorative');
		assert.equal(await page.isDisabled(`${field} input[data-alt]`), true, 'the alt input turned off');
		assert.equal(await page.inputValue(`${field} input[data-alt]`), '');
		await page.waitForSelector(`${field} [data-altmsg] .field-hint >> text=screen readers skip it`);
		assert.equal(await page.isVisible(`${field} [data-altmsg] .field-warn`), false, 'no warning');
		await page.uncheck(`${field} .deco input`);
		await fileHas(1, 'media', { key: HARBOUR, alt: '', focal: [0.4, 0.3], w: 4000, h: 2667 }, 'not decorative');
		await page.waitForSelector(`${field} [data-altmsg] .field-warn >> text=No alt text yet`);
		await page.close();
	});

	test('a preview click on a placed image opens its field; on a gallery image, its row', async () => {
		const page = await open('/admin/pages/visit');
		await frame(page).locator('[data-cms-block="1"] img[data-cms-field="media"]').click();
		await page.waitForSelector(`${BLOCK} .field-frame.is-picked[data-ff="media"]`);
		await eventually(() => page.evaluate(() => document.activeElement?.closest('[data-ff]')?.getAttribute('data-ff') === 'media'), 4000, 'focus in the media field');

		await frame(page).locator('[data-cms-block="4"] img[data-cms-field="images.2"]').click();
		await page.waitForSelector(`${BLOCK} [data-list="images"] [data-row="2"].is-open`);
		await page.waitForSelector(`${BLOCK} [data-list="images"] [data-row="2"] [data-path="images.2"] .media`);
		assert.match((await page.getAttribute(`${BLOCK} .field-frame[data-ff="images"]`, 'class'))!, /is-picked/);
		await eventually(() => page.evaluate(() => document.activeElement?.closest('[data-path]')?.getAttribute('data-path') === 'images.2'), 4000, 'focus in row 3');
		await page.close();
	});

	test('a list’s Add image takes several, each added as a row in the order picked; a clip dropped on an image-only slot is refused', async () => {
		const page = await open('/admin/pages/visit');
		await openBlock(page, 4);
		const before = (stored(4, 'images') as unknown[]).length;
		await page.click(`${BLOCK} [data-ff="images"] .list-foot .linkbtn`);
		await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		assert.match((await page.textContent(`${SIDE} [data-pane-level="media"] .lib-bar`))!, /^Images/, 'images only: no Clips tab');
		await page.click(`${SIDE} .mtile[data-key="${NEVER}"]`);
		await page.click(`${SIDE} .mtile[data-key="${HARBOUR}"]`);
		await page.click(`${SIDE} [data-act="pick-done"]`);
		await eventually(() => {
			const images = stored(4, 'images') as { key: string }[];
			return images.length === before + 2 && images[before]!.key === NEVER && images[before + 1]!.key === HARBOUR;
		}, 10000, 'two rows, in order');
		await page.waitForSelector(`${BLOCK} [data-list="images"] [data-row="${before + 1}"]`);

		// A clip dropped on a gallery image (image-only) gets Decision 6's sentence, and nothing uploads.
		await page.click(`${BLOCK} [data-list="images"] [data-row="0"] .item-sum`);
		await page.evaluate(() => {
			const target = document.querySelector('[data-pane-level="block"] [data-list="images"] [data-row="0"] .media')!;
			const dt = new DataTransfer();
			dt.items.add(new File(['not really a video'], 'kiln.mov', { type: 'video/quicktime' }));
			for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
		});
		await page.waitForSelector(`${BLOCK} [data-list="images"] [data-row="0"] .field-err >> text=That's a video, and this slot takes images only.`);
		assert.equal(memoryMedia().mux.uploads.size, 0);
		await page.close();
	});

	test('a refused file’s note stays while the library is open, and goes when it’s left or a slot’s picker opens', async () => {
		const page = await open('/admin/pages/visit');
		// M6c G4: a PDF is a file the library takes now, so the refused one is an RTF.
		const PDF = { name: 'Studio brief.rtf', mimeType: 'application/rtf', buffer: Buffer.from('{\\rtf1\\ansi Studio brief}') };
		const note = `${SIDE} .refused .note >> text=Studio brief.rtf`;
		const browse = async () => {
			if (!(await page.isVisible(`${SIDE} .media-row`))) await page.click(`${SIDE} .lv >> nth=0`);
			await page.click(`${SIDE} .media-row`);
			await page.waitForSelector(`${SIDE} [data-media-mode="browse"]`);
		};
		await browse();
		await page.locator(`${SIDE} [data-lib-file]`).first().setInputFiles([PDF]);
		await page.waitForSelector(note);
		assert.match((await page.textContent(`${SIDE} .refused`))!, /This is a document\. The library takes images \(/);
		// Still in the library (another tab and back): it stays.
		await page.click(`${SIDE} .lib-bar [role="radio"][data-v="clips"]`);
		await page.click(`${SIDE} .lib-bar [role="radio"][data-v="images"]`);
		assert.equal(await page.locator(note).count(), 1);

		// Left for the page, then a slot's Choose…: the picker doesn't carry it.
		await page.click('#stage-aside .btn.ghost');
		await openBlock(page, 3);
		await page.click(`${BLOCK} [data-ff="media"] .mdrop .btn, ${BLOCK} [data-ff="media"] .media .btn:has-text("Replace…")`);
		await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		assert.equal(await page.locator(`${SIDE} .refused`).count(), 0);
		await page.click(`${SIDE} [data-pane-level="media"] .cur .ib.boxed`);
		await page.waitForSelector(`${BLOCK} [data-ff="media"]`);

		// Refused again, then the library left (Back to documents) and opened again: gone.
		await browse();
		await page.locator(`${SIDE} [data-lib-file]`).first().setInputFiles([PDF]);
		await page.waitForSelector(note);
		await page.click(`${SIDE} [data-pane-level="media"] [aria-label="Back to documents"]`);
		await page.waitForSelector(`${SIDE} [data-pane-level="media"]`, { state: 'detached' });
		await browse();
		assert.equal(await page.locator(`${SIDE} .refused`).count(), 0);
		await page.close();
	});

	test('a clip uploaded in the library goes to Mux with UpChunk, shows as processing, then ready', async () => {
		const mux = memoryMedia().mux;
		const page = await open('/admin/pages/visit');
		let put = 0;
		await page.route('https://mux.test/upload/**', async (route) => {
			put += 1;
			await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
		});
		await page.click(`${SIDE} .lv >> nth=0`);
		await page.click(`${SIDE} .media-row`);
		await page.waitForSelector(`${SIDE} [data-media-mode="browse"]`);
		await page.locator(`${SIDE} [data-lib-file]`).first().setInputFiles([{ name: 'Studio tour.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(2048, 7) }]);
		await page.waitForSelector(`${SIDE} [data-lgrid="clips"] [data-upload]`);
		const uploadId = await eventually(() => [...mux.uploads.keys()][0], 10000, 'the direct upload');
		assert.equal(mux.uploads.get(uploadId).new_asset_settings?.meta?.title ?? 'Studio tour.mov', 'Studio tour.mov');
		await eventually(() => put > 0, 10000, 'the PUT to Mux');
		await page.waitForSelector(`${SIDE} [data-upload][aria-label*="processing"]`);
		const asset = mux.receive(uploadId);
		mux.ready(asset);
		await page.waitForSelector(`${SIDE} .mtile[data-clip="${asset}"]:not([disabled])`, { timeout: 15000 });
		assert.match((await page.textContent(`${SIDE} .mtile[data-clip="${asset}"]`))!, /Just added/);
		await page.close();
	});
});
