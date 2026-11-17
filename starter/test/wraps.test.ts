// Lockups in a real browser, on the built demo (Phase 1 → Verify 2, and the
// mousetrap numbers for Phase 1's Verified note), built from the pinned content
// (helpers/dist.ts).
//
//   pnpm --filter caracms-starter test:wraps
//
// Headless Chromium from Playwright's cache (~/Library/Caches/ms-playwright,
// playwright-core 1.63.0 → chromium 1243). Reads line boxes as M1 did: a line
// wraps if a Range over its text has more than one client rect.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { listDocuments } from 'caracms/content';
import { measureLockup } from 'caracms/measure';
import { serveClient, site } from './helpers/dist.ts';
import { displayFontLoaded, footerProblems, lockupProblems, readLines } from './helpers/lockups.ts';

const WIDTHS = [...new Set([320, 340, 360, 375, 390, 414, 480, 540, 600, 639, 640, 700, 767, 768, 820, 900, 1024, 1180, 1280, 1366, 1440, 1600, 1760, 1920])].sort((a, b) => a - b);

let browser: Browser;
let page: Page;
let origin: string;
let close: () => void;

const fitSize = (p: Page, selector: string) =>
	p.evaluate((s) => parseFloat(getComputedStyle(document.querySelector(s)!).fontSize), selector);

async function open(url: string, width: number) {
	await page.setViewportSize({ width, height: 900 });
	await page.goto(origin + url);
	await page.evaluate(() => document.fonts.ready);
	// M7: the display style's family (Inter), whatever name the font pipeline gives it.
	assert.ok(await displayFontLoaded(page, site.textStyles.display!.family), 'the display font loaded');
}

describe('lockups in the browser', () => {
	before(async () => {
		const served = await serveClient();
		origin = served.origin;
		close = () => served.server.close();
		browser = await chromium.launch();
		page = await browser.newPage();
		// Only the test's own server: the Google tag and the made-up image host never answer.
		await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
	});
	after(async () => {
		await browser?.close();
		close?.();
	});

	test('no line wraps or overflows its set at any width from 320 to 1920, on every page', async () => {
		// Shared blocks and Site Settings have no page of their own (M5a: url null).
		const urls = (await listDocuments(site)).filter((e) => !e.warning && e.url).map((e) => e.url!);
		await open(urls[0]!, WIDTHS[0]!);
		assert.deepEqual(await lockupProblems(page, origin, [...urls, '/404.html'], WIDTHS), []);
	});

	test('no word in the footer breaks mid-word at any width from 320 to 1920 (the email may break before its @)', async () => {
		assert.deepEqual(await footerProblems(page, origin, '/', WIDTHS), []);
	});

	test('M7 Acceptance 17: a lockup with phone lines shows them at 375, the main lines at 768 and 1440 (About\'s hero; phoneLinesWidth 768)', async () => {
		const shown = async (width: number) => {
			await open('/about', width);
			const lines = (await readLines(page)).filter((l) => ['A small', 'studio with', 'big ideas', 'A small studio', 'with big ideas'].includes(l.text!));
			return { sets: [...new Set(lines.map((l) => l.set))], text: lines.map((l) => l.text) };
		};
		assert.deepEqual(await shown(375), { sets: ['phone'], text: ['A small', 'studio with', 'big ideas'] });
		assert.deepEqual(await shown(768), { sets: ['main'], text: ['A small studio', 'with big ideas'] });
		assert.deepEqual(await shown(1440), { sets: ['main'], text: ['A small studio', 'with big ideas'] });
		// The phone set fits its own longest line, not the main lines' (each set measured on its own).
		await open('/about', 375);
		const phone = await fitSize(page, 'h1 .cms-lockup-phone .cms-lockup-fit');
		const main = await page.evaluate(() => getComputedStyle(document.querySelector('h1 .cms-lockup-main')!).display);
		assert.equal(main, 'none');
		assert.ok(phone > 0);
	});

	test('the mousetrap at 375: one line computes below the style\'s minimum, two lines above it', async (t) => {
		const style = site.textStyles.display!;
		await open('/', 375);
		const hero = 'main section:first-child h1 .cms-lockup-main';
		assert.deepEqual(
			await page.evaluate((s) => [...document.querySelectorAll(`${s} .cms-lockup-line`)].map((l) => l.textContent), hero),
			['Building a better mousetrap', 'For You'],
		);
		const container = await page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().width, hero);
		const oneLine = await fitSize(page, `${hero} .cms-lockup-fit`);

		// The same hero with the line split, the way the editor's preview would render it:
		// the lines replaced and --longest-line set to the split lines' measurement.
		const split = measureLockup(['Building a', 'better mousetrap', 'For You'], style).longest;
		await page.evaluate(
			({ s, longest }) => {
				const set = document.querySelector<HTMLElement>(s)!;
				set.style.setProperty('--longest-line', longest);
				set.querySelector('.cms-lockup-fit')!.innerHTML =
					'<span class="cms-lockup-line">Building a</span> <span class="cms-lockup-line">better mousetrap</span> <span class="cms-lockup-line">For You</span>';
			},
			{ s: hero, longest: (Math.ceil(split * 1e4) / 1e4).toFixed(4) },
		);
		const twoLines = await fitSize(page, `${hero} .cms-lockup-fit`);

		t.diagnostic(
			`375 preview: container ${container}px; "Building a better mousetrap" ${oneLine.toFixed(2)}px, ` +
				`"Building a / better mousetrap" ${twoLines.toFixed(2)}px; style minimum ${style.minSizePx}px`,
		);
		assert.ok(oneLine < style.minSizePx, `${oneLine} should be below ${style.minSizePx}`);
		assert.ok(twoLines > style.minSizePx, `${twoLines} should be above ${style.minSizePx}`);
		for (const line of await readLines(page)) assert.equal(line.fragments, 1, `"${line.text}" wraps`);
	});
});
