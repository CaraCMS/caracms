/**
 * Lockups in a real browser (headless Chromium from Playwright's cache): reads line boxes
 * as M1 did, so a line wraps if a Range over its text has more than one client rect.
 * Shared by the wraps test (the plain build) and the look test (the second look).
 */
import type { Page } from 'playwright-core';

/** Every visible lockup line on the page, with whether it wraps or overflows its set. */
export const readLines = (p: Page) =>
	p.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('.cms-lockup-line')]
			.filter((line) => line.checkVisibility())
			.map((line) => {
				const range = document.createRange();
				range.selectNodeContents(line);
				const set = line.closest('.cms-lockup-set')!.getBoundingClientRect();
				const box = line.getBoundingClientRect();
				return {
					text: line.textContent,
					fragments: range.getClientRects().length,
					overflow: box.right - set.right,
					set: line.closest('.cms-lockup-set')!.classList.contains('cms-lockup-phone') ? 'phone' : 'main',
				};
			}),
	);

/** Whether a font of the display style's family (whatever name the font pipeline gives it) has loaded. */
export const displayFontLoaded = (p: Page, family: string) =>
	p.evaluate((name) => [...document.fonts].some((f) => f.status === 'loaded' && f.family.replaceAll('"', '').replaceAll('_', ' ').startsWith(name)), family);

/** Each page at each width: every lockup line that wraps or overflows its set. */
export async function lockupProblems(page: Page, origin: string, urls: string[], widths: number[]): Promise<string[]> {
	const problems: string[] = [];
	for (const url of urls) {
		await page.setViewportSize({ width: widths[0]!, height: 900 });
		await page.goto(origin + url);
		await page.evaluate(() => document.fonts.ready);
		for (const width of widths) {
			await page.setViewportSize({ width, height: 900 });
			for (const line of await readLines(page)) {
				if (line.fragments !== 1) problems.push(`${url} @${width}: "${line.text}" wraps into ${line.fragments}`);
				if (line.overflow > 0.5) problems.push(`${url} @${width}: "${line.text}" overflows by ${line.overflow.toFixed(2)}px`);
			}
		}
	}
	return problems;
}

/**
 * The footer at each width: every word that breaks across lines (2026-10-20: the email
 * broke "studio@example.co / m" at 375). A word is a run of non-space text in one text
 * node, so the email's two halves, either side of its <wbr>, are a word each and may sit
 * on two lines, but neither half may break.
 */
export async function footerProblems(page: Page, origin: string, url: string, widths: number[]): Promise<string[]> {
	const problems: string[] = [];
	await page.setViewportSize({ width: widths[0]!, height: 900 });
	await page.goto(origin + url);
	await page.evaluate(() => document.fonts.ready);
	for (const width of widths) {
		await page.setViewportSize({ width, height: 900 });
		const broken = await page.evaluate(() => {
			const out: string[] = [];
			const walker = document.createTreeWalker(document.querySelector('[data-site-footer]')!, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (!node.parentElement?.checkVisibility()) continue;
				for (const word of node.textContent!.matchAll(/\S+/g)) {
					const range = document.createRange();
					range.setStart(node, word.index);
					range.setEnd(node, word.index + word[0].length);
					if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1) out.push(word[0]);
				}
			}
			return out;
		});
		for (const word of broken) problems.push(`${url} @${width}: the footer's "${word}" breaks mid-word`);
	}
	return problems;
}
