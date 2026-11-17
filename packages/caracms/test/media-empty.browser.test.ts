// M9 port friction, item 12: an empty media slot in the preview draws a placeholder carrying
// the field's markers, so it can be clicked on the page; the visitors' page is unchanged.
// On a throwaway copy of the demo with M9's `lines` block (helpers/m9-site.ts), whose
// `<Media>`s are called whatever their value, under `astro dev` with the in-memory media.
//
// 1. In the preview, the empty `art` slot is a <span data-cms-placeholder> with the field's
//    markers and the caller's class, with a box to click; clicking it picks the field in the
//    sidebar and moves focus there, as a click on a placed image does.
// 2. The public render of the same page has no placeholder and nothing for the empty slots.
//
//   node --test --experimental-strip-types test/media-empty.browser.test.ts
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { addM9 } from './helpers/m9-site.ts';
import { memoryMedia } from '../src/editor/server/media/memory.ts';

const PAGE = 'empty-media';
const DOCUMENT = { title: 'Empty media', blocks: [{ type: 'lines', heading: 'Nothing placed yet' }] };
const BLOCK = '[data-pane-level="block"]';

let site: DevSite;
let browser: Browser;

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

describe('an empty media slot in the preview (M9 port friction 12)', { skip: browserSkip }, () => {
	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		memoryMedia().reset();
		site = await startDevSite('media-empty', {
			edit: (root) => {
				addM9(root);
				writeFileSync(join(root, `content/pages/${PAGE}.json`), `${JSON.stringify(DOCUMENT, null, 2)}\n`);
			},
		});
		browser = await chromium.launch();
	});

	after(async () => {
		await browser?.close();
		await site?.close();
		memoryMedia().reset();
		delete process.env.CARACMS_MEDIA;
	});

	test('the empty slot is a placeholder with the markers; a click on it picks the field', async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.on('pageerror', (error) => console.error('[page]', error.message));
		await page.goto(`${site.origin}/admin/pages/${PAGE}`);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });

		const slot = page.frameLocator('#stage iframe[data-width="1440"]').locator('[data-cms-block="0"] [data-cms-field="art"][data-cms-kind="media"]');
		const seen = await slot.evaluate((el) => ({ tag: el.tagName, placeholder: el.hasAttribute('data-cms-placeholder'), hidden: el.getAttribute('aria-hidden'), cls: el.className, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }));
		assert.equal(seen.tag, 'SPAN');
		assert.ok(seen.placeholder);
		assert.equal(seen.hidden, 'true');
		assert.equal(seen.cls, 'lines-art');
		assert.ok(seen.w >= 90 && seen.h >= 90, `a box to click: ${seen.w} × ${seen.h}`);

		await slot.click();
		await page.waitForSelector(`${BLOCK} .field-frame.is-picked[data-ff="art"]`);
		await eventually(() => page.evaluate(() => document.activeElement?.closest('[data-ff]')?.getAttribute('data-ff') === 'art'), 4000, 'focus in the art field');
		await page.close();
	});

	test('the public render has no placeholder and nothing for the empty slots', async () => {
		const html = await (await fetch(`${site.origin}/${PAGE}`)).text();
		assert.match(html, /Nothing placed yet/);
		assert.doesNotMatch(html, /data-cms-placeholder/);
		assert.doesNotMatch(html, /lines-art|lines-photo/);
	});
});
