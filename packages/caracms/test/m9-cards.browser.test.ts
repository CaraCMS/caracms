// M9 Decision 9 (check 14's package side): blocks inside `<Blocks wrap>`'s runs in /admin's preview,
// on a throwaway copy of the demo whose page component wraps the `cards` page's blocks 1–3 in a
// band of two cards (helpers/m9-site.ts → addCards), under `astro dev` (helpers/dev-site.ts).
//
//   - a click on a block inside a card selects that block (its own index)
//   - typing its heading on the page stores it, and after the morph the cards hold the same blocks
//   - a sidebar edit re-renders with the card intact
//
//   node --test --experimental-strip-types test/m9-cards.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { addCards, CARDS_PAGE } from './helpers/m9-site.ts';

let site: DevSite;
let browser: Browser;
const FILE = `content/pages/${CARDS_PAGE}.json`;
const BLOCK = '[data-pane-level="block"]';

async function open(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(`${site.origin}/admin/pages/${CARDS_PAGE}`);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	return page;
}

async function eventually<T>(check: () => T | Promise<T>, timeout = 8000, what = 'the condition'): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Each card's blocks (their data-cms-block) and headings, in the wide frame. */
const cardsIn = (page: Page) =>
	page.evaluate(() => {
		const doc = document.querySelector<HTMLIFrameElement>('#stage iframe[data-width="1440"]')!.contentDocument!;
		return [...doc.querySelectorAll('.band-of-cards article.card')].map((card) => ({
			id: card.id,
			blocks: [...card.querySelectorAll('[data-cms-block]')].map((b) => `${b.getAttribute('data-cms-block')}:${b.querySelector('[data-cms-field="heading"]')?.textContent}`),
		}));
	});

describe('M9: blocks inside runs in the preview', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('m9-cards', { edit: addCards });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('the preview draws the band of cards; a click inside a card selects that block; typing on the page keeps the cards', async () => {
		const page = await open();
		assert.deepEqual(await cardsIn(page), [
			{ id: 'story', blocks: ['1:Story one', '2:Story two'] },
			{ id: 'team', blocks: ['3:Team'] },
		]);
		const frame = page.frameLocator('.frame.on iframe');
		const heading = frame.locator('#story [data-cms-block="2"] [data-cms-field="heading"]');
		await heading.scrollIntoViewIfNeeded();
		const box = (await heading.boundingBox())!;
		await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
		await page.waitForSelector(`${BLOCK} [data-ff="heading"] input`);
		assert.equal(await page.inputValue(`${BLOCK} [data-ff="heading"] input`), 'Story two', 'block 2 is the one selected');
		await page.keyboard.press('End');
		await page.keyboard.type(' told');
		await eventually(() => (JSON.parse(site.read(FILE)) as { blocks: { heading: string }[] }).blocks[2]!.heading === 'Story two told', 8000, 'the heading in the file');
		await eventually(async () => JSON.stringify(await cardsIn(page)) === JSON.stringify([{ id: 'story', blocks: ['1:Story one', '2:Story two told'] }, { id: 'team', blocks: ['3:Team'] }]), 8000, 'the cards after the morph');
		await page.close();
	});

	test('a sidebar edit to a block in the second card re-renders it there', async () => {
		const page = await open();
		await page.click('[data-pane-level="document"] .blist .brow-main >> nth=3');
		const input = `${BLOCK} [data-ff="heading"] input`;
		await page.waitForSelector(input);
		await page.fill(input, 'The team');
		await eventually(async () => (await cardsIn(page))[1]?.blocks.join() === '3:The team', 8000, 'the second card to show the edit');
		assert.deepEqual((await cardsIn(page))[0]!.blocks.map((b) => b.split(':')[0]), ['1', '2']);
		await page.close();
	});
});
