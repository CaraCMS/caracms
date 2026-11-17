// The site-facing hook (port parity G10), on a throwaway copy of the demo under `astro dev`
// (helpers/dev-site.ts); headless Chromium from Playwright's cache, skipped without it.
//
//   After every morph into a preview frame, the frame's document gets one
//   `caracms:rendered` CustomEvent ({ reason: 'morph' }, made in the frame's own window),
//   with the morphed content already in the DOM. A site listener that throws doesn't
//   stop the driver: the next morph still lands and still announces itself.
//
//   node --test --experimental-strip-types test/preview-rendered.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;
const block = '[data-pane-level="block"]';
const heading = `${block} [data-ff="heading"] input[data-line="0"]`;

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

async function openHero(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(`${site.origin}/admin`);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
	await page.frameLocator('.frame.on iframe').locator('[data-cms-block="0"] [data-cms-kind="lockup"]').click();
	await page.waitForSelector(heading);
	return page;
}

/** In each preview frame: record every caracms:rendered with the hero heading's text at that moment. */
async function listen(page: Page, throwFirst: boolean) {
	await page.evaluate((throwFirst) => {
		for (const f of document.querySelectorAll<HTMLIFrameElement>('#stage iframe')) {
			const win = f.contentWindow as any;
			const doc = f.contentDocument!;
			win.__rendered = [];
			let thrown = false;
			if (throwFirst) {
				// Registered first, so it runs before the recorder.
				doc.addEventListener('caracms:rendered', () => {
					if (thrown) return;
					thrown = true;
					throw new Error('a site script that fails');
				});
			}
			doc.addEventListener('caracms:rendered', (event: Event) => {
				win.__rendered.push({
					reason: (event as CustomEvent).detail?.reason,
					ownWindow: event instanceof win.CustomEvent,
					bubbles: event.bubbles,
					text: doc.querySelector('[data-cms-block="0"] .cms-lockup-line')?.textContent ?? '',
				});
			});
		}
	}, throwFirst);
}

type Seen = { reason: string; ownWindow: boolean; bubbles: boolean; text: string };
const seen = (page: Page) =>
	page.evaluate(() => [...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => (f.contentWindow as any).__rendered as Seen[]));

async function typeAndWait(page: Page, letter: string) {
	await page.keyboard.type(letter);
	await eventually(
		() =>
			page.evaluate(
				(letter) => [...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].every((f) => f.contentDocument!.querySelector('[data-cms-block="0"] .cms-lockup-line')?.textContent?.endsWith(letter)),
				letter,
			),
		6000,
		`the render with ${letter}`,
	);
	// Let any stray second event arrive before counting.
	await new Promise((r) => setTimeout(r, 300));
}

describe('caracms:rendered, the preview hook for site scripts', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('preview-rendered');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('once per frame per morph, after the morphed content is in the DOM', async () => {
		const page = await openHero();
		await listen(page, false);
		const first = page.locator(heading);
		await first.focus();
		await first.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));

		await typeAndWait(page, 'q');
		let frames = await seen(page);
		assert.equal(frames.length, 3, 'three preview frames');
		for (const [i, events] of frames.entries()) {
			assert.equal(events.length, 1, `frame ${i}: one event for one morph`);
			assert.deepEqual(events[0], { reason: 'morph', ownWindow: true, bubbles: false, text: events[0]!.text });
			assert.ok(events[0]!.text.endsWith('q'), `frame ${i}: the morphed heading was already there (${events[0]!.text})`);
		}

		await typeAndWait(page, 'w');
		frames = await seen(page);
		for (const [i, events] of frames.entries()) {
			assert.equal(events.length, 2, `frame ${i}: one more event for the second morph`);
			assert.ok(events[1]!.text.endsWith('w'), `frame ${i}: the second event saw the second render`);
		}
		await page.close();
	});

	test('a listener that throws does not stop the next morph or its event', async () => {
		const page = await openHero();
		await listen(page, true);
		const first = page.locator(heading);
		await first.focus();
		await first.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));

		await typeAndWait(page, 'e');
		await typeAndWait(page, 'r');
		const frames = await seen(page);
		for (const [i, events] of frames.entries()) {
			assert.equal(events.length, 2, `frame ${i}: both morphs announced, the throwing listener notwithstanding`);
			assert.ok(events[0]!.text.endsWith('e') && events[1]!.text.endsWith('r'), `frame ${i}: each event saw its render`);
		}
		await page.close();
	});
});
