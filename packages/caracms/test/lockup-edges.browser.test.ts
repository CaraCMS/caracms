// Two lockup rules that need a browser, on throwaway copies of the demo under `astro dev`
// (helpers/dev-site.ts); headless Chromium from Playwright's cache, skipped without it.
//
//   Decision 11  the phone-lines width is a viewport width, "below W". At the edges the
//                config allows (376 and 768) the Phone preview (375) always shows phone
//                lines, and Tablet (768) and Desktop (1440) never do.
//   Decision 15  a character the font doesn't cover gets a warning in the lockup field,
//                and never blocks the edit.
//
//   node --test --experimental-strip-types test/lockup-edges.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let browser: Browser;

const withWidth = (width: number) => (root: string) => {
	const file = join(root, 'caracms.config.ts');
	const before = readFileSync(file, 'utf8');
	const after = before.replace('phoneLinesWidth: 640', `phoneLinesWidth: ${width}`);
	assert.notEqual(after, before);
	writeFileSync(file, after);
};

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

/** Which line set of the page's first heading is shown (the other is display: none). */
const shownOnPage = (page: Page) =>
	page.evaluate(() => {
		const h1 = document.querySelector('h1.cms-lockup')!;
		return [...h1.querySelectorAll<HTMLElement>('.cms-lockup-set')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => (s.classList.contains('cms-lockup-phone') ? 'phone' : 'main'));
	});

describe('Decision 11: the phone-lines width at the edges the config allows', { skip: browserSkip }, () => {
	before(async () => {
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
	});

	for (const [width, expected] of [
		[376, { 320: 'phone', 375: 'phone', 376: 'main', 768: 'main', 1440: 'main' }],
		[768, { 320: 'phone', 375: 'phone', 640: 'phone', 767: 'phone', 768: 'main', 1440: 'main' }],
	] as const) {
		test(`${width}: the public page switches exactly at ${width}, and the editor's three previews agree`, async () => {
			// One dev server at a time per process: a second one starting beside the first loses its fonts.
			const site = await startDevSite(`lockup-edges-${width}`, { edit: withWidth(width) });
			try {
				await check(site, width, expected);
			} finally {
				await site.close();
			}
		});
	}

	async function check(site: DevSite, width: number, expected: Record<number, string>) {
		// The public page (About's hero has phone lines): "below W" is a phone.
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		await page.goto(`${site.origin}/about`);
		for (const [viewport, set] of Object.entries(expected)) {
			await page.setViewportSize({ width: Number(viewport), height: 900 });
			assert.deepEqual(await shownOnPage(page), [set], `/about at ${viewport} with phone lines below ${width}`);
		}
		// Always one set to a screen reader or a crawler: one h1, holding both sets' words.
		assert.equal(await page.locator('h1').count(), 1);
		await page.close();

		// The editor's iframes: Phone (375) shows phone lines, Tablet (768) and Desktop (1440) the main lines.
		const admin = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		await admin.goto(`${site.origin}/admin/pages/about`);
		await admin.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		const shown = () =>
			admin.evaluate(() =>
				Object.fromEntries(
					[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => {
						const win = f.contentWindow!;
						const sets = [...f.contentDocument!.querySelectorAll<HTMLElement>('[data-cms-block="0"] [data-cms-lines]')]
							.filter((s) => win.getComputedStyle(s).display !== 'none')
							.map((s) => s.dataset.cmsLines);
						return [f.dataset.width, sets.join(',')];
					}),
				),
			);
		await eventually(async () => (await shown())['375'] !== undefined, 6000, 'the previews');
		assert.deepEqual(await shown(), { '1440': 'main', '768': 'main', '375': 'phone' });
		await admin.close();
	}
});

describe('Decision 15: an uncovered character warns and never blocks', { skip: browserSkip }, () => {
	let site: DevSite;
	before(async () => {
		site = await startDevSite('lockup-uncovered');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('typing a character the font lacks shows which one, the edit still lands on disk, and removing it clears the warning', async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		await page.goto(`${site.origin}/admin`);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		await page.frameLocator('.frame.on iframe').locator('[data-cms-block="0"] [data-cms-kind="lockup"]').click();
		const heading = '[data-pane-level="block"] [data-ff="heading"]';
		await page.waitForSelector(`${heading} input[data-line="1"]`);
		assert.equal(await page.locator(`${heading} [data-warning="uncovered"]`).count(), 0, 'no warning for a covered line');

		const second = page.locator(`${heading} input[data-line="1"]`);
		await second.focus();
		await second.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));
		await page.keyboard.type(' ✨');
		const note = page.locator(`${heading} [data-warning="uncovered"]`);
		await note.waitFor({ timeout: 6000 });
		assert.match((await note.textContent()) ?? '', /✨.*isn.t in this font, so this line may not fit/);

		// It never blocks: the edit reaches the file with the character in it.
		await eventually(() => /For You ✨/.test(site.read('content/pages/index.json')), 6000, 'the file to hold the line');
		assert.equal(await page.getAttribute('[data-keep]', 'data-keep'), 'kept');

		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await eventually(async () => (await page.locator(`${heading} [data-warning="uncovered"]`).count()) === 0, 6000, 'the warning to go');
		await eventually(() => !/✨/.test(site.read('content/pages/index.json')), 6000, 'the file without it');
		await page.close();
	});
});
