// M9 (the Tina port): typing on the page in M9's two new renderings, on a throwaway copy of the
// demo with M9's test blocks (helpers/m9-site.ts) under `astro dev` (helpers/dev-site.ts).
//
//   Decision 10 / check 5  the lines rendering: Shift+Enter on the page still stores `\n`, the text
//                          reads back line by line, and a sidebar edit is drawn as lines
//   Decision 11 / check 6  a heading rich-text field: typed on the page with bold and line breaks
//                          only (the bar has Bold alone), drawn with no <p>, stored as paragraphs
//
//   node --test --experimental-strip-types test/m9-editor.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { addM9, M9_PAGE } from './helpers/m9-site.ts';

let site: DevSite;
let browser: Browser;
const FILE = `content/pages/${M9_PAGE}.json`;
const LINES = '[data-cms-block="1"] [data-cms-field="heading"]';
const STATEMENT = '[data-cms-block="0"] [data-cms-field="statement"]';
const blocksInFile = () => (JSON.parse(site.read(FILE)) as { blocks: Record<string, unknown>[] }).blocks;

async function open(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(`${site.origin}/admin/pages/${M9_PAGE}`);
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

/** The field in the wide frame, its markup and whether it has focus. */
const fieldIn = (page: Page, selector: string) =>
	page.evaluate((selector) => {
		const frame = document.querySelector<HTMLIFrameElement>('#stage iframe[data-width="1440"]') ?? document.querySelector<HTMLIFrameElement>('.frame.on iframe')!;
		const el = frame.contentDocument!.querySelector<HTMLElement>(selector);
		return el ? { html: el.innerHTML, tag: el.tagName, focused: frame.contentDocument!.activeElement === el || el.contains(frame.contentDocument!.activeElement) } : null;
	}, selector);

/** Click into the field at the end of its text (hover first, so a rich-text field's page editor is mounted). */
async function clickAtEnd(page: Page, selector: string) {
	const frame = page.frameLocator('.frame.on iframe');
	const el = frame.locator(selector);
	await el.scrollIntoViewIfNeeded();
	const box = (await el.boundingBox())!;
	await page.mouse.move(box.x + box.width - 4, box.y + box.height - 6);
	await page.mouse.click(box.x + box.width - 4, box.y + box.height - 6);
	await eventually(async () => (await fieldIn(page, selector))?.focused, 4000, 'focus in the field');
	await page.keyboard.press('End');
	await page.keyboard.press('Control+End').catch(() => {});
	await page.keyboard.press('Meta+ArrowDown');
	await page.keyboard.press('End');
}

describe('M9: the lines rendering and heading rich text on the page', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('m9-editor', { edit: addM9 });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('lines (check 5): a span per line in the preview; Shift+Enter and typing store `\\n` lines', async () => {
		const page = await open();
		const before = await fieldIn(page, LINES);
		assert.equal(before?.tag, 'H2');
		assert.equal((before?.html.match(/<span class="block text-balance" data-cms-line="">/g) ?? []).length, 2, before?.html);
		await clickAtEnd(page, LINES);
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.type('Third line');
		await eventually(() => blocksInFile()[1]!.heading === 'First line\nSecond line\nThird line', 8000, `the file to store three lines (has ${JSON.stringify(blocksInFile()[1]!.heading)})`);
		await page.close();
	});

	test('lines (check 5): a sidebar edit is drawn as lines, the blank one dropped', async () => {
		const page = await open();
		await page.frameLocator('.frame.on iframe').locator(LINES).click();
		const box = page.locator('[data-pane-level="block"] [data-ff="heading"] textarea');
		await box.waitFor();
		await box.fill('One\n\nTwo');
		await eventually(async () => (await fieldIn(page, LINES))?.html === '<span class="block text-balance" data-cms-line="">One</span><span class="block text-balance" data-cms-line="">Two</span>', 6000, 'the preview to draw two lines');
		await box.fill('Only');
		await eventually(async () => (await fieldIn(page, LINES))?.html === 'Only', 6000, 'one line, bare');
		await page.close();
	});

	test('heading rich text (check 6): typed on the page with Bold and line breaks; no <p>; the bar is Bold alone', async () => {
		const page = await open();
		const before = await fieldIn(page, STATEMENT);
		assert.equal(before?.tag, 'H1', 'the statement block comes first: its heading is the page\'s h1');
		assert.equal(before?.html, 'Play <strong>hard</strong><br>Win softly');
		await clickAtEnd(page, STATEMENT);
		await eventually(async () => (await page.locator('#cms-overlays .cms-rtbar [data-rtc]').count()) > 0 || (await page.frameLocator('.frame.on iframe').locator('#cms-overlays .cms-rtbar [data-rtc]').count()) > 0, 4000, 'the bar');
		const bar = await page.evaluate(() => {
			const frame = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!;
			const docs = [document, frame.contentDocument!];
			return docs.flatMap((d) => [...d.querySelectorAll<HTMLElement>('#cms-overlays .cms-rtbar [data-rtc]')].map((b) => b.dataset.rtc));
		});
		assert.deepEqual(bar, ['bold']);
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.press('Meta+b');
		await page.keyboard.type('Bold');
		await page.keyboard.press('Meta+b');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Plain');
		await page.keyboard.press('Meta+i');
		await page.keyboard.type('X');
		await eventually(
			() => JSON.stringify(blocksInFile()[0]!.statement) === JSON.stringify([{ p: 'Play **hard**' }, { p: 'Win softly' }, { p: '**Bold**' }, { p: 'PlainX' }]),
			8000,
			`the file to store four lines (has ${JSON.stringify(blocksInFile()[0]!.statement)})`,
		);
		const after = await fieldIn(page, STATEMENT);
		assert.doesNotMatch(after!.html, /<p[\s>]|<em>|<ul/);
		await page.close();
	});

	test('heading rich text (check 6): the sidebar\'s toolbar is Bold alone', async () => {
		const page = await open();
		await page.locator('[data-pane-level="document"] [data-block-index="0"], [data-pane-level="document"] li').first().click().catch(() => {});
		await page.frameLocator('.frame.on iframe').locator(STATEMENT).click();
		const toolbar = page.locator('[data-pane-level="block"] [data-rich-text="statement"] [role="toolbar"] button');
		await toolbar.first().waitFor();
		assert.deepEqual(await toolbar.evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label'))), ['Bold']);
		await page.close();
	});
});
