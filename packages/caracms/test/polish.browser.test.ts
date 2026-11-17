// The pre-M7 polish in a real browser, on a throwaway copy of the demo under `astro dev`
// (helpers/dev-site.ts): the sidebar hidden and brought back; a flat collection as a
// table over the stage.
//
//   node --test --experimental-strip-types test/polish.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

const VIEWPORT = { width: 1440, height: 900 };

async function open(path: string, context?: Awaited<ReturnType<Browser['newContext']>>): Promise<Page> {
	const page = context ? await context.newPage() : await browser.newPage({ viewport: VIEWPORT });
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

const sideShown = (page: Page) => page.locator('#side').isVisible();
const stageWidth = (page: Page) => page.locator('#stage').evaluate((el) => el.clientWidth);

describe('the pre-M7 polish in the browser', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('polish');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('the sidebar hides from its own button and with ⌘\\, the preview takes the width, it stays hidden on reload, and a click on a block brings it back', async () => {
		const context = await browser.newContext({ viewport: VIEWPORT });
		const page = await open('/admin', context);
		const narrow = await stageWidth(page);
		const toggle = page.locator('#editor > .side-toggle');
		assert.equal(await toggle.getAttribute('aria-expanded'), 'true');

		await toggle.click();
		await eventually(async () => !(await sideShown(page)), 4000, 'the sidebar hidden');
		assert.equal(await toggle.getAttribute('aria-label'), 'Show the sidebar');
		assert.equal(await stageWidth(page), 1440, 'the stage takes the width');
		assert.ok((await stageWidth(page)) > narrow);
		// Esc still goes up a level, as before (nothing new is on it).
		assert.equal(await page.getAttribute('#side', 'data-level'), 'document');

		// Remembered: the server paints it hidden (no flash of the sidebar).
		const html = await (await context.request.get(`${site.origin}/admin`)).text();
		assert.match(html, /id="editor" data-side="hidden"/);
		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]');
		assert.equal(await sideShown(page), false);

		// A click on a block in the preview opens it, and brings the sidebar back.
		await page.frameLocator('#stage iframe[data-width="1440"]').locator('[data-cms-block="1"] [data-cms-field] >> nth=0').click();
		await page.waitForSelector('[data-pane-level="block"]');
		assert.equal(await sideShown(page), true);
		assert.equal(await page.getAttribute('#editor', 'data-side'), null);

		// ⌘\ (Ctrl+\ elsewhere).
		await page.locator('#bar .docbtn').focus();
		await page.keyboard.press('ControlOrMeta+Backslash');
		await eventually(async () => !(await sideShown(page)), 4000, 'hidden by the key');
		await page.keyboard.press('ControlOrMeta+Backslash');
		await eventually(() => sideShown(page), 4000, 'shown by the key');

		// ⌘\\ and ⌘K work with keyboard focus inside the preview too (a click on a block leaves it there).
		const frame = page.frameLocator('#stage iframe[data-width="1440"]');
		await frame.locator('[data-cms-block="1"] [data-cms-field] >> nth=0').click();
		await page.waitForSelector('[data-pane-level="block"]');
		assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'IFRAME', 'focus is inside the preview');
		await page.keyboard.press('ControlOrMeta+Backslash');
		await eventually(async () => !(await sideShown(page)), 4000, 'hidden by the key from the preview');
		await page.keyboard.press('ControlOrMeta+k');
		await page.waitForSelector('#pops .pop.switcher');
		await eventually(() => page.evaluate(() => document.activeElement?.matches('#pops .pop.switcher input')), 4000, 'the switcher input has focus');
		await page.keyboard.press('Escape');
		await page.waitForSelector('#pops .pop.switcher', { state: 'detached' });
		await page.keyboard.press('ControlOrMeta+Backslash');
		await eventually(() => sideShown(page), 4000, 'shown again from the preview');

		// Hiding it with focus inside it moves focus to the bar's button, not the body.
		await page.locator('#side button:visible').first().focus();
		await page.keyboard.press('ControlOrMeta+Backslash');
		await eventually(async () => !(await sideShown(page)), 4000, 'hidden again');
		assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('side-toggle')), true, 'focus is on the show-sidebar button');

		// A document edited in the sidebar (Site Settings) brings it back when ⌘K opens it...
		await page.keyboard.press('ControlOrMeta+k');
		await page.waitForSelector('#pops .pop.switcher');
		await page.keyboard.type('site settings');
		await page.keyboard.press('Enter');
		await eventually(() => sideShown(page), 4000, 'shown for Site Settings');
		// ...a section-builder page leaves it hidden: the preview is the point.
		await page.keyboard.press('ControlOrMeta+Backslash');
		await eventually(async () => !(await sideShown(page)), 4000, 'hidden before a page');
		await page.keyboard.press('ControlOrMeta+k');
		await page.waitForSelector('#pops .pop.switcher');
		await page.keyboard.type('branding');
		await page.keyboard.press('Enter');
		await page.waitForURL('**/admin/pages/services/branding');
		assert.equal(await sideShown(page), false, 'a page keeps it hidden');

		// A cold load of a document edited in the sidebar paints the sidebar shown even with the
		// hidden-sidebar cookie set (the server's first paint follows the client's bringSideBack
		// rule); a page paints it hidden. Each request puts the hidden cookie back first, since
		// the server answers with the cookie it painted from.
		const [hiddenCookie] = (await context.cookies()).filter((c) => c.name === 'caracms-ui');
		assert.match(decodeURIComponent(hiddenCookie!.value), /"side":"hidden"/, 'the cookie holds the hidden state');
		for (const [address, hidden] of [['/admin/settings', false], ['/admin/case-studies/high-street-coffee', false], ['/admin/pages/services/branding', true]] as const) {
			await context.addCookies([hiddenCookie!]);
			const html = await (await context.request.get(`${site.origin}${address}`)).text();
			assert.equal(/id="editor" data-side="hidden"/.test(html), hidden, `${address} paints ${hidden ? 'hidden' : 'shown'}`);
		}
		await page.close();
		await context.close();
	});

	test('a flat collection\'s level shows a table over the stage: the config\'s columns, sorting, find and filters shared with the sidebar, + New; a row opens its document', async () => {
		const page = await open('/admin');
		await page.keyboard.press('Escape');
		await page.click('[data-pane-level="documents"] [data-coll="case-studies"]');
		const table = '#stage .ctable[data-collection-table="case-studies"]';
		await page.waitForSelector(table);
		assert.match((await page.getAttribute('#stage', 'class')) ?? '', /\bis-table\b/);
		assert.equal(await page.locator('#stage iframe[data-width="1440"]').getAttribute('inert'), '');
		// The title, then the config's columns (test/fixtures/demo-site/src/collections/case-studies.ts).
		const heads = await page.locator(`${table} thead th`).allTextContents();
		// Review gaps (Decision 3): Case studies is manual, so its numbered Site order column comes first.
		assert.deepEqual(heads, ['Site order', 'Title', 'Client', 'Sector', 'Launched', 'Featured']);
		const titles = () => page.locator(`${table} tbody .ct-open .nm`).allTextContents();
		const sidebar = () => page.locator('#coll-list .drow .nm').allTextContents();
		const all = await titles();
		assert.equal(all.length, 6, "the fixture's six");
		assert.deepEqual(all, ['Nature film studio', 'Tiny publisher', 'Oak furniture maker', 'High-street coffee roaster', 'Sourdough bakery', 'Weekend bike shop'], 'in Site order (the fixture seeds it)');
		assert.deepEqual(await sidebar(), all, 'the sidebar lists the same, in the same order');
		const harbour = page.locator(`${table} tbody tr[data-doc="case-studies/high-street-coffee"]`);
		assert.deepEqual((await harbour.locator('td').allTextContents()).slice(0, 4), ['4', 'High-street coffee roaster', 'Food and drink', '2 May 2024']);

		// A header sorts by its column, then the other way; aria-sort says which.
		const launched = page.locator(`${table} thead th`, { hasText: 'Launched' });
		await launched.locator('button').click();
		assert.equal(await launched.getAttribute('aria-sort'), 'ascending');
		const byDay = await titles();
		await launched.locator('button').click();
		assert.equal(await launched.getAttribute('aria-sort'), 'descending');
		const byDayDesc = await titles();
		assert.notDeepEqual(byDayDesc, byDay);
		assert.equal(byDayDesc[0], byDay.at(-1), 'the latest first');
		assert.deepEqual(await sidebar(), await titles(), 'the sidebar follows the order');

		// Filters (a select and a toggle) and the find box narrow both lists.
		await page.selectOption(`${table} select[data-filter-key="sector"]`, { label: 'Food and drink' });
		const food = await titles();
		assert.ok(food.includes('High-street coffee roaster') && food.length < all.length);
		assert.deepEqual(await sidebar(), food);
		await page.fill(`${table} input[data-filter="table"]`, 'high-street');
		assert.deepEqual(await titles(), ['High-street coffee roaster']);
		assert.equal(await page.inputValue('[data-pane-level="collection"] [data-filter="collection"]'), 'high-street', 'one find box with the sidebar');
		// High-street coffee roaster is featured: "off" leaves nothing, and says so, with a way back to all of them.
		await page.selectOption(`${table} select[data-filter-key="featured"]`, { label: 'Featured: off' });
		assert.deepEqual(await titles(), []);
		await page.click(`${table} .ct-none .linkbtn`);
		assert.equal((await titles()).length, all.length);
		assert.equal(await page.inputValue('[data-pane-level="collection"] [data-filter="collection"]'), '');

		// + New is there; a row opens its document in the editor, and the table gives way to the preview.
		assert.equal(await page.locator(`${table} [data-act="table-new"]`).isEnabled(), true);
		await harbour.locator('td >> nth=1').click();
		await page.waitForURL(/\/admin\/case-studies\/high-street-coffee$/);
		await page.waitForSelector('[data-pane-level="document"] [data-form]');
		assert.equal(await page.getAttribute('#stage', 'class').then((c) => c?.includes('is-table')), false);
		// Back at the collection: the open one's row is marked (a wash and a ring, no rail).
		await page.click('[data-pane-level="document"] .cur .ib.boxed');
		await page.waitForSelector(table);
		assert.equal(await page.locator(`${table} tr.is-current`).getAttribute('data-doc'), 'case-studies/high-street-coffee');
		await page.close();
	});

	test('a section builder\'s table has the default columns; shared blocks have no address', async () => {
		const page = await open('/admin');
		await page.keyboard.press('Escape');
		await page.click('[data-pane-level="documents"] [data-coll="journal"]');
		await page.waitForSelector('#stage .ctable[data-collection-table="journal"]');
		assert.deepEqual(await page.locator('#stage .ctable thead th').allTextContents(), ['Title', 'Address', 'Last edited']);
		assert.match((await page.locator('#stage .ctable tbody tr >> nth=0').locator('td.ct-address').textContent()) ?? '', /^\/journal\//);
		await page.click('[data-pane-level="collection"] .cur .ib.boxed');
		await page.click('[data-pane-level="documents"] [data-section="site-wide"] [data-coll="shared"]');
		await page.waitForSelector('#stage .ctable[data-collection-table="shared"]');
		assert.deepEqual(await page.locator('#stage .ctable thead th').allTextContents(), ['Title', 'Last edited']);
		await page.close();
	});
});
