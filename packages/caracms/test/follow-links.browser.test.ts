// Following links from the preview (commit 889d408; preview/follow-links.ts, link-target.ts):
// a click on a header link opens that document; a link in a block follows only once the
// block is selected; the chip shows where a hovered link goes; a typed field still takes
// the caret; mailto: is shown and not followed; another site opens in a new tab. On a
// throwaway copy of the demo under `astro dev` (helpers/dev-site.ts), headless Chromium
// from Playwright's cache, skipped without it.
//
//   node --test --experimental-strip-types test/follow-links.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, footerInBody, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
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

const frameOn = (page: Page) => page.frameLocator('.frame.on iframe');
const CHIP = '#cms-overlays .cms-go';
/** The visible frame's chip(s), as {text, kind, tag}. */
const chips = (page: Page) =>
	page.evaluate((sel) => {
		const frame = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!;
		return [...frame.contentDocument!.querySelectorAll<HTMLElement>(sel)].map((el) => ({
			text: el.textContent,
			kind: el.dataset.go,
			tag: el.tagName,
			off: el.classList.contains('off'),
		}));
	}, CHIP);
const pathname = (page: Page) => new URL(page.url()).pathname;
/** The block list's row for block `index`: select it in the sidebar. */
async function selectBlock(page: Page, index: number) {
	await page.click(`.brow-main >> nth=${index}`);
	await page.waitForSelector('[data-pane-level="block"]');
	// The selection reaches the preview's overlays (the blocks outline) before a link is hovered.
	await page.waitForTimeout(200);
}
/**
 * Home's blocks: 0 hero, 1 text, 2 cta (a link to /contact), 3 cases, 4 the shared footer, 5 a copy of the
 * footer's block as Home's own. Its links are Home's (a mailto:, another site); the shared footer's are the
 * shared block's fields, picked over the page, never followed (Decision 8, amended 2026-11-16).
 */
const CTA = 2;
const FOOTER = 5;

/** `footerInBody`, then the footer's block again as Home's own last block. */
function withOwnFooter(root: string): void {
	footerInBody(root);
	const block = JSON.parse(readFileSync(join(root, 'content/shared/footer.json'), 'utf8')).block;
	const home = join(root, 'content/pages/index.json');
	const raw = readFileSync(home, 'utf8');
	const at = raw.indexOf('\n  ]', raw.indexOf('"blocks": ['));
	writeFileSync(home, `${raw.slice(0, at)},\n    ${JSON.stringify(block)}${raw.slice(at)}`);
}

describe('following links from the preview', { skip: browserSkip }, () => {
	before(async () => {
		// Home's blocks as these tests know them, the shared footer last (helpers/dev-site.ts → footerInBody: not the footer slot).
		site = await startDevSite('follow-links', { edit: withOwnFooter });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('a: a click on a header link opens that document, and Back returns', async () => {
		const page = await open('/admin');
		const start = pathname(page);
		assert.equal(start, '/admin');
		await frameOn(page).locator('header.site-header nav a[href="/about"]').click();
		await eventually(() => pathname(page) === '/admin/pages/about', 8000, 'the address to become /admin/pages/about');
		await page.waitForSelector('[data-pane-level="document"]');
		await eventually(
			() => page.evaluate(() => [...document.querySelectorAll('iframe')].every((f) => f.contentWindow!.location.search.includes('path=about') && /big ideas/i.test(f.contentDocument!.body.innerText))),
			8000,
			'the preview to show About',
		);
		// The sidebar shows About (its blocks: the hero, "How we work", the footer).
		await eventually(async () => (await page.textContent('[data-pane-level="document"]'))?.includes('About'), 6000, 'the sidebar to show About');
		await page.goBack();
		await eventually(() => pathname(page) === start, 8000, 'Back to the previous document');
		await eventually(
			() => page.evaluate(() => [...document.querySelectorAll('iframe')].every((f) => /better mousetrap/i.test(f.contentDocument!.body.innerText))),
			8000,
			'the preview back on Home',
		);
		await page.close();
	});

	test('b: a click on a link in a block that is not selected selects the block and does not navigate', async () => {
		const page = await open('/admin');
		assert.equal(await page.locator('[data-pane-level="block"]').count(), 0, 'no block is selected');
		await frameOn(page).locator('[data-cms-block="2"] a.cta-button').click({ position: { x: 10, y: 25 } });
		await page.waitForSelector('[data-pane-level="block"]');
		assert.equal(pathname(page), '/admin', 'the editor stayed on Home');
		assert.equal(await page.locator('[data-pane-level="block"]').count(), 1);
		await page.close();
	});

	test('c: with the block selected, hovering the link shows the chip, and a click goes to the document', async () => {
		const page = await open('/admin');
		await selectBlock(page, CTA);
		await frameOn(page).locator('[data-cms-block="2"] a.cta-button').hover({ position: { x: 10, y: 25 } });
		await eventually(async () => (await chips(page)).length > 0, 4000, 'the chip');
		const [chip] = await chips(page);
		assert.deepEqual(chip, { text: 'Go to /contact →', kind: 'document', tag: 'BUTTON', off: false });
		// A click on the link itself follows it.
		await frameOn(page).locator('[data-cms-block="2"] a.cta-button').click({ position: { x: 10, y: 25 } });
		await eventually(() => pathname(page) === '/admin/pages/contact', 8000, 'the address to become /admin/pages/contact');
		await page.close();
	});

	test('c2: the chip is itself a button that follows the link', async () => {
		const page = await open('/admin');
		await selectBlock(page, CTA);
		await frameOn(page).locator('[data-cms-block="2"] a.cta-button').hover({ position: { x: 10, y: 25 } });
		await eventually(async () => (await chips(page)).length > 0, 4000, 'the chip');
		await frameOn(page).locator(CHIP).click();
		await eventually(() => pathname(page) === '/admin/pages/contact', 8000, 'the address to become /admin/pages/contact');
		await page.close();
	});

	test('d: a click in a plain-text field typed on the page, inside a selected block\'s link, places the caret and does not navigate', async () => {
		const page = await open('/admin');
		await selectBlock(page, CTA);
		const field = frameOn(page).locator('[data-cms-block="2"] a.cta-button [data-cms-field="button"][contenteditable]');
		await field.click();
		await page.waitForTimeout(500);
		assert.equal(pathname(page), '/admin', 'no navigation');
		const caret = await page.evaluate(() => {
			const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
			const active = doc.activeElement as HTMLElement | null;
			return { active: active?.getAttribute('data-cms-field') ?? null, editable: doc.getSelection()?.rangeCount ?? 0 };
		});
		assert.equal(caret.active, 'button', 'the field has focus');
		assert.ok(caret.editable > 0, 'there is a caret');
		// Typing goes into the field.
		await page.keyboard.type('!');
		await eventually(() => site.read('content/pages/index.json').includes('Start a project!') || page.evaluate(() => document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!.querySelector('[data-cms-block="2"] [data-cms-field="button"]')!.textContent?.includes('!')), 6000, 'the typed character');
		assert.equal(pathname(page), '/admin');
		await page.close();
	});

	test('d2: hovering the typed field inside a selected block\'s link shows the chip too, and the chip follows it', async () => {
		const page = await open('/admin');
		await selectBlock(page, CTA);
		await frameOn(page).locator('[data-cms-block="2"] a.cta-button [data-cms-field="button"]').hover();
		await eventually(async () => (await chips(page)).length > 0, 4000, 'the chip');
		assert.deepEqual((await chips(page))[0], { text: 'Go to /contact →', kind: 'document', tag: 'BUTTON', off: false });
		await frameOn(page).locator(CHIP).click();
		await eventually(() => pathname(page) === '/admin/pages/contact', 8000, 'the address to become /admin/pages/contact');
		await page.close();
	});

	test('g: a link to the document that is already open is not followed: the chip says so and the selection stays', async () => {
		// Header: on About, the nav link to /about.
		const about = await open('/admin/pages/about');
		const nav = frameOn(about).locator('header.site-header nav a[href="/about"]');
		await nav.hover();
		await eventually(async () => (await chips(about)).length > 0, 4000, 'the chip');
		assert.deepEqual(await chips(about), [{ text: 'A link on this page', kind: 'none', tag: 'SPAN', off: true }]);
		await nav.click();
		await about.waitForTimeout(500);
		assert.equal(pathname(about), '/admin/pages/about', 'the address did not change');
		await about.close();

		// A block's link to its own page: on Contact, the call to action's "/contact", with the block selected.
		const page = await open('/admin/pages/contact');
		await selectBlock(page, 2);
		const link = frameOn(page).locator('[data-cms-block="2"] a.cta-button');
		await link.hover({ position: { x: 10, y: 25 } });
		await eventually(async () => (await chips(page)).length > 0, 4000, 'the chip');
		assert.deepEqual(await chips(page), [{ text: 'A link on this page', kind: 'none', tag: 'SPAN', off: true }]);
		// With a fragment too: `/contact#team`.
		await link.evaluate((a) => a.setAttribute('href', '/contact#team'));
		await link.click({ position: { x: 10, y: 25 } });
		await page.waitForTimeout(500);
		assert.equal(pathname(page), '/admin/pages/contact', 'no navigation');
		assert.equal(await page.locator('[data-pane-level="block"]').count(), 1, 'the block is still selected');
		assert.equal(await page.locator('[data-pane-level="document"]').count(), 0);
		await page.close();
	});

	test('h: the chip stays while the pointer moves from the link into it, and a click on it follows', async () => {
		const page = await open('/admin');
		await selectBlock(page, CTA);
		const link = frameOn(page).locator('[data-cms-block="2"] a.cta-button');
		await link.hover({ position: { x: 10, y: 25 } });
		await eventually(async () => (await chips(page)).length > 0, 4000, 'the chip');
		// Page coordinates (the iframe is scaled) of the link's top left area and of the chip's middle.
		const spots = () =>
			page.evaluate((sel) => {
				const iframe = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!;
				const box = iframe.getBoundingClientRect();
				const scale = box.width / iframe.clientWidth;
				const doc = iframe.contentDocument!;
				const chip = doc.querySelector(sel)!.getBoundingClientRect();
				const a = doc.querySelector('[data-cms-block="2"] a.cta-button')!.getBoundingClientRect();
				const at = (x: number, y: number) => ({ x: box.left + x * scale, y: box.top + y * scale });
				return { link: at(a.left + 10, a.top + 5), chip: at(chip.left + chip.width / 2, chip.top + chip.height / 2), gap: chip.bottom < a.top ? a.top - chip.bottom : 0 };
			}, CHIP);
		const { link: from, chip: to, gap } = await spots();
		assert.ok(gap > 0, `there is a gap between the chip and the link (${gap}px): the case under test`);
		await page.mouse.move(from.x, from.y);
		// In small steps, checking the chip is there at every one.
		const steps = 24;
		for (let i = 1; i <= steps; i++) {
			await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
			assert.equal((await chips(page)).length, 1, `the chip is still there at step ${i} of ${steps}`);
		}
		await page.mouse.click(to.x, to.y);
		await eventually(() => pathname(page) === '/admin/pages/contact', 8000, 'the address to become /admin/pages/contact');
		await page.close();
	});

	test('e: a mailto: link in the footer shows a chip that is not a button, and a click does nothing', async () => {
		const page = await open('/admin');
		await selectBlock(page, FOOTER);
		const email = frameOn(page).locator(`[data-cms-block="${FOOTER}"] a.footer-email`);
		await email.scrollIntoViewIfNeeded();
		await email.hover();
		await eventually(async () => (await chips(page)).length > 0, 4000, 'the chip');
		assert.deepEqual(await chips(page), [{ text: 'hello@example.com · not opened from the editor', kind: 'contact', tag: 'SPAN', off: true }]);
		// Capture any navigation or new tab.
		await page.evaluate(() => {
			(window as any).__opened = [];
			// The preview opens tabs from the frame's own window (its click's activation is there): stub those too.
			const stub = ((...args: unknown[]) => ((window as any).__opened.push(args), null)) as typeof window.open;
			window.open = stub;
			for (const iframe of document.querySelectorAll('iframe')) if (iframe.contentWindow) iframe.contentWindow.open = stub;
		});
		const context = page.context();
		let popups = 0;
		context.on('page', () => popups++);
		await email.click();
		await page.waitForTimeout(500);
		assert.equal(pathname(page), '/admin');
		assert.equal(popups, 0, 'no new tab');
		assert.deepEqual(await page.evaluate(() => (window as any).__opened), [], 'window.open was not called');
		await page.close();
	});

	test('f: an external link\'s chip opens it in a new tab and the editor stays put', async () => {
		const page = await open('/admin');
		await selectBlock(page, FOOTER);
		await page.evaluate(() => {
			(window as any).__opened = [];
			// The preview opens tabs from the frame's own window (its click's activation is there): stub those too.
			const stub = ((...args: unknown[]) => ((window as any).__opened.push(args), null)) as typeof window.open;
			window.open = stub;
			for (const iframe of document.querySelectorAll('iframe')) if (iframe.contentWindow) iframe.contentWindow.open = stub;
		});
		const link = frameOn(page).locator(`[data-cms-block="${FOOTER}"] a[href="https://instagram.com/example"]`);
		await link.scrollIntoViewIfNeeded();
		await link.hover();
		await eventually(async () => (await chips(page)).length > 0, 4000, 'the chip');
		assert.deepEqual(await chips(page), [{ text: 'Open instagram.com ↗', kind: 'external', tag: 'BUTTON', off: false }]);
		// It's a link field of the selected block: a click on it picks the field, and its chip follows it (as c2).
		await frameOn(page).locator(CHIP).click();
		await eventually(() => page.evaluate(() => (window as any).__opened.length === 1), 4000, 'window.open to be called');
		assert.deepEqual(await page.evaluate(() => (window as any).__opened), [['https://instagram.com/example', '_blank', 'noopener,noreferrer']]);
		assert.equal(pathname(page), '/admin', 'the editor stayed put');
		await page.close();
	});
});
