// Review gaps, hand order (Decisions 3–5a), in a real browser: a copy of the demo under
// `astro dev`, local mode, where Case studies is manual (its order seeded newest launch
// first in the fixture's Site Settings) and the Work page's Cases block is "In order", 6.
// - the sidebar list in Site order, grips on, ⌥↓ moves a row at once and Site Settings follows,
//   a drag moves one to the top, and Work's grid follows (checks 2, 3);
// - the stage's table: a numbered Site order column; sorted by another column, the grips go
//   and a line says dragging happens in Site order, back again with its button; a find takes
//   the grips too; the grid's order select starts at Site order (check 7);
// - a new case study goes first, in the list and on the Work page (check 4).
//
//   node --test --experimental-strip-types test/hand-order.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { eventually } from './helpers/live-site.ts';

const VIEWPORT = { width: 1440, height: 900 };
const SHOWN = '.side-level:not([hidden])';
const DOCS = '[data-pane-level="documents"]';
const LIST = '[data-pane-level="collection"] #coll-list';
const TABLE = '#stage .ctable[data-collection-table="case-studies"]';
const SEEDED = ['nature-films', 'tiny-publisher', 'oak-furniture', 'high-street-coffee', 'sourdough-bakery', 'weekend-bikes'];

let site: DevSite;
let browser: Browser;

async function open(path = '/admin'): Promise<Page> {
	const page = await browser.newPage({ viewport: VIEWPORT });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
	return page;
}

async function caseStudies(page: Page) {
	await page.keyboard.press('Escape');
	await page.click(`${DOCS} [data-coll="case-studies"]`);
	await page.waitForSelector(`${LIST} .olist`);
}

const rows = (page: Page) => page.$$eval(`${LIST} .orow`, (els) => els.map((e) => e.getAttribute('data-path')));
const saved = () => (JSON.parse(readFileSync(join(site.root, 'content/site-settings.json'), 'utf8')) as { collectionOrder?: Record<string, string[]> }).collectionOrder?.['case-studies'];
/** The Work page's case-study cards, by their links, as the public site renders it. */
const workCards = async () => {
	const html = await (await fetch(`${site.origin}/work`)).text();
	return [...html.matchAll(/href="\/work\/([a-z0-9-]+)"/g)].map((m) => m[1]!).filter((p, i, all) => all.indexOf(p) === i);
};

describe('hand order in the browser', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('hand-order');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('checks 2, 3: Site order with grips; ⌥↓ and a drag move rows at once; Site Settings and the Work page follow', async () => {
		const page = await open();
		await caseStudies(page);
		assert.deepEqual(await rows(page), SEEDED, 'the seeded order');
		assert.match((await page.textContent(`${LIST} .ord-h`))!, /Site order/);
		assert.equal(await page.locator(`${LIST} .ogrip`).count(), SEEDED.length, 'a grip on every row');
		assert.equal(await page.locator(`${LIST} .olist.is-off`).count(), 0);
		assert.deepEqual(await workCards(), SEEDED, 'Work shows them in Site order (In order, 6)');

		// ⌥↓ on the first row: it's second at once, and keeps the focus.
		await page.focus(`${LIST} .orow[data-path="nature-films"] .drow`);
		await page.keyboard.press('Alt+ArrowDown');
		assert.deepEqual((await rows(page)).slice(0, 2), ['tiny-publisher', 'nature-films']);
		assert.equal(await page.evaluate(() => document.activeElement?.closest('.orow')?.getAttribute('data-path')), 'nature-films');
		await eventually(() => saved()?.[1] === 'nature-films', 8000, 'Site Settings has the new order');

		// A drag: Weekend bike shop to the top.
		await page.dragAndDrop(`${LIST} .orow[data-path="weekend-bikes"]`, `${LIST} .orow[data-path="tiny-publisher"]`, { targetPosition: { x: 40, y: 2 } });
		await eventually(async () => (await rows(page))[0] === 'weekend-bikes', 4000, 'Weekend bike shop first in the list');
		await eventually(() => saved()?.[0] === 'weekend-bikes', 8000, 'and in Site Settings');
		assert.equal((await workCards())[0], 'weekend-bikes', 'the Work page shows it first');
		await page.close();
	});

	test('check 7: the table has a Site order column; sorted another way the grips go and a line says so; a find too; the grid starts at Site order', async () => {
		const page = await open();
		await caseStudies(page);
		await page.waitForSelector(`${TABLE} th.ct-pos`);
		assert.equal((await page.textContent(`${TABLE} th.ct-pos`))!.trim(), 'Site order');
		assert.equal(await page.getAttribute(`${TABLE} th.ct-pos`, 'aria-sort'), 'ascending');
		const positions = await page.$$eval(`${TABLE} tbody td.ct-pos`, (els) => els.map((e) => e.textContent));
		assert.deepEqual(positions, ['1', '2', '3', '4', '5', '6']);

		// Sorted by Launched: no grips, the line, and back.
		await page.click(`${TABLE} th.ct-date .ct-sort`);
		await page.waitForSelector(`${LIST} .order-line[data-line="sorted"]`);
		assert.equal(await page.locator(`${LIST} .ogrip`).count(), 0, 'no grips');
		assert.match((await page.textContent(`${LIST} .order-line`))!, /Sorted by Launched, oldest first\. Dragging happens in Site order\./);
		assert.equal(await page.locator(`${TABLE} .order-line[data-line="sorted"]`).count(), 1, 'the table says it too');
		assert.equal((await rows(page))[0], 'weekend-bikes', 'oldest first');
		// Each row shows the column it's sorted by, on its right (#order-sorted).
		assert.equal((await page.textContent(`${LIST} .orow[data-path="weekend-bikes"] .meta .when[data-sorted-by="launched"]`))?.trim(), '1 Jun 2022');
		assert.equal(await page.locator(`${LIST} .orow .meta .when`).count(), 6, 'every row');
		await page.click(`${LIST} [data-act="site-order"]`);
		await page.waitForSelector(`${LIST} .ord-h`);
		assert.equal(await page.locator(`${LIST} .orow .meta .when`).count(), 0, 'Site order shows no value');
		assert.equal(await page.locator(`${LIST} .ogrip`).count(), 6, 'the grips are back');
		assert.equal(await page.locator(`${TABLE} .order-line`).count(), 0);

		// A find: no grips, the line says how many and to clear it.
		await page.fill(`[data-pane-level="collection"] input[data-filter="collection"]`, 'we');
		await page.waitForSelector(`${LIST} .order-line[data-line="found"]`);
		assert.equal(await page.locator(`${LIST} .ogrip`).count(), 0);
		assert.match((await page.textContent(`${LIST} .order-line`))!, /Showing 1 of 6\. Clear the find to drag\./);
		await page.click(`${LIST} [data-act="clear-find"]`);
		await page.waitForSelector(`${LIST} .ord-h`);

		// The grid: its order select starts at Site order, and the cards say their place.
		await page.click(`${TABLE} [data-view-mode="grid"]`);
		await page.waitForSelector(`${TABLE} .card`);
		assert.equal(await page.inputValue(`${TABLE} select[data-order]`), '$order:asc');
		assert.match((await page.textContent(`${TABLE} select[data-order] option:first-child`))!, /Site order/);
		assert.equal(await page.getAttribute(`${TABLE} .card:first-child [data-position]`, 'data-position'), '1');
		assert.equal(await page.locator(`${TABLE} .card[draggable="true"]`).count(), 0, 'no drag in the grid');
		await page.click(`${TABLE} [data-view-mode="list"]`);
		await page.close();
	});

	test('check 4: a new case study goes first, in the list and on the Work page', async () => {
		const page = await open();
		await caseStudies(page);
		await page.click('[data-pane-level="collection"] [data-act="new-document"]');
		await page.fill('#np-name', 'Seaweed Baths');
		await page.click('[data-dialog="new"] [data-act="create"]');
		await eventually(() => new URL(page.url()).pathname === '/admin/case-studies/seaweed-baths', 8000, 'it opens');
		await eventually(() => saved()?.[0] === 'seaweed-baths', 8000, 'first in Site Settings');
		await page.click(`${SHOWN} .cur .ib.boxed`);
		await page.waitForSelector(`${LIST} .orow[data-path="seaweed-baths"]`);
		assert.equal((await rows(page))[0], 'seaweed-baths', 'first in the list');
		assert.equal((await workCards())[0], 'seaweed-baths', 'first on the Work page');
		await page.close();
	});
});
