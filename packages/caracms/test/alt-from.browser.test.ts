// media({ altFrom }) in a real browser (Acceptance 12): on a throwaway copy of the
// demo whose Text and media block gains a "What to capture" text field (`capture`) and
// `media({ altFrom: 'capture' })`, with the in-memory bucket (CARACMS_MEDIA=memory).
//
// 1. In an existing block with an empty slot: an image picked with no alt of its own starts
//    with the capture text as its alt (and so isn't asked for one). A typed alt then stays when
//    the capture text changes. An image that brings an alt from the library keeps that one.
// 2. In a block just added from the block picker: the capture text typed first is the alt of
//    the image picked after it.
//
//   node --test --experimental-strip-types test/alt-from.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { eventually } from './helpers/live-site.ts';

const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const SIDE = '#side';
const FILE = 'content/pages/visit.json';

/** Used on Visit's first text-and-media block with alt text (the fixture). */
const HARBOUR = 'uploads/3f9a1c07b2e4/harbour-wall.jpg';
const HARBOUR_ALT = 'The harbour wall at low tide';
/** Never used anywhere, so they bring no alt text. */
const KILN = 'uploads/bbbbbbbbbbbb/kiln-door.jpg';
const BENCH = 'uploads/cccccccccccc/bench.jpg';

function seed() {
	const media = memoryMedia();
	media.reset();
	media.bucket.seed(HARBOUR, { w: 4000, h: 2667, name: 'Harbour wall.jpg', uploadedAt: '2026-10-10T09:00:00Z' });
	media.bucket.seed(KILN, { w: 1200, h: 800, name: 'Kiln door.jpg', uploadedAt: '2026-10-11T09:00:00Z' });
	media.bucket.seed(BENCH, { w: 900, h: 1200, name: 'Bench.jpg', uploadedAt: '2026-10-12T09:00:00Z' });
	return media;
}

/** The copy's Text and media block: a capture field after the slot, which names it. */
function withCapture(root: string) {
	const file = join(root, 'src/blocks/tm.ts');
	const source = readFileSync(file, 'utf8')
		.replace("import { media, richText, select,", "import { media, richText, select, text,")
		.replace("media: media({ label: 'Image or video' }),", "media: media({ label: 'Image or video', altFrom: 'capture' }),\n\t\tcapture: text({ label: 'What to capture' }),");
	assert.match(source, /altFrom: 'capture'/);
	writeFileSync(file, source);
}

async function pick(page: Page, slot: string, tile: string) {
	const choose = page.locator(`${slot} .mdrop .btn, ${slot} .media .btn:has-text("Replace…")`).first();
	await choose.click();
	await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
	await page.click(`${SIDE} ${tile}`);
}

describe("media's altFrom: an image starts with its sibling's words as alt", { skip: browserSkip }, () => {
	let site: DevSite;
	let browser: Browser;
	const blocks = () => (JSON.parse(site.read(FILE)) as { blocks: Record<string, unknown>[] }).blocks;
	const alt = (index: number) => (blocks()[index]?.media as { alt?: string } | undefined)?.alt;

	async function open(path: string): Promise<Page> {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.on('pageerror', (error) => console.error('[page]', error.message));
		await page.goto(site.origin + path);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
		return page;
	}

	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		seed();
		site = await startDevSite('alt-from', { edit: withCapture });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
		memoryMedia().reset();
		delete process.env.CARACMS_MEDIA;
	});

	test('an existing empty block: the capture text starts the alt; a typed alt stays; a library alt wins', async () => {
		const page = await open('/admin/pages/visit');
		await page.click(`${DOC} .blist .brow-main >> nth=3`);
		await page.waitForSelector(`${BLOCK} .field-frame`);
		const field = `${BLOCK} [data-ff="media"]`;
		const input = `${field} input[data-alt="media"]`;
		const capture = `${BLOCK} [data-ff="capture"] input, ${BLOCK} [data-ff="capture"] textarea`;
		await page.fill(capture, 'The kiln door, open');
		await eventually(() => blocks()[3]!.capture === 'The kiln door, open', 10000, 'capture written');

		await pick(page, field, `.mtile[data-key="${KILN}"]`);
		await eventually(() => alt(3) === 'The kiln door, open', 10000, 'the alt starts as the capture text');
		await eventually(async () => (await page.inputValue(input).catch(() => '')) === 'The kiln door, open', 8000, 'shown in the alt input');
		assert.equal(await page.locator(`${field} [data-ask]`).count(), 0, 'not asked: it has an alt');

		// Typed by the editor: a later capture edit leaves it alone.
		await page.fill(input, 'The kiln door, ajar at dawn');
		await eventually(() => alt(3) === 'The kiln door, ajar at dawn', 10000, 'typed alt written');
		await page.fill(capture, 'Something else');
		await eventually(() => blocks()[3]!.capture === 'Something else', 10000, 'capture changed');
		assert.equal(alt(3), 'The kiln door, ajar at dawn');
		assert.equal(await page.inputValue(input), 'The kiln door, ajar at dawn');

		// An image that brings its own alt from the library keeps it.
		await pick(page, field, `.mtile[data-key="${HARBOUR}"]`);
		await eventually(() => alt(3) === HARBOUR_ALT, 10000, 'the library alt');
		await page.close();
	});

	test('a block added from the block picker: capture typed first, then the image picked', async () => {
		const page = await open('/admin/pages/visit');
		await page.waitForSelector(`${DOC} .blist`);
		const before = blocks().length;
		await page.click(`${DOC} .add-row, ${DOC} [data-act="add-block"]`);
		await page.waitForSelector('[data-picker-at]');
		await page.click('[data-picker-at] .ptype[data-type="tm"]');
		await page.waitForSelector(`${BLOCK} [data-ff="capture"]`);
		await eventually(() => blocks().length === before + 1, 10000, 'the block added');

		const capture = `${BLOCK} [data-ff="capture"] input, ${BLOCK} [data-ff="capture"] textarea`;
		await page.fill(capture, 'The bench by the window');
		const field = `${BLOCK} [data-ff="media"]`;
		await eventually(() => blocks().some((b) => b.capture === 'The bench by the window'), 10000, 'capture written');
		await pick(page, field, `.mtile[data-key="${BENCH}"]`);
		await eventually(() => blocks().some((b) => b.capture === 'The bench by the window' && (b.media as { key?: string; alt?: string } | undefined)?.alt === 'The bench by the window'), 10000, 'the alt starts as the capture text');
		await page.close();
	});
});
