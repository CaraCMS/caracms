// Arrange pages, live mode (the spec's check 15a, Decision 18): the order stamp
// in the status response, seen from a second person's tab. A copy of the demo under `astro dev` in live
// mode on the in-memory GitHub (helpers/live-site.ts), never a real repo; one browser context per person.
//
//   node --test --experimental-strip-types test/arrange-pages-live.browser.test.ts
//
// After an order-only Apply while Site Settings already has a waiting change, the waiting list's keys
// are the same as before, so only the stamp tells the other tab to re-read the listing.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip } from './helpers/dev-site.ts';
import { AOIFE, CIARAN, eventually, keepState, openAdmin, runtime, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

const TIMINGS = { sweepIdleMs: 1500, sweepTickMs: 500, sweepCapMs: 10_000, lockLapseMs: 20_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 1000 };
const DOCS = '[data-pane-level="documents"]';
const PANE = '[data-pane-level="arrange"]';
const row = (id: string) => `#atree .arow[data-id="${id}"]`;
/** The top level of the Pages tree in the sidebar, in the order shown. */
const sideOrder = (page: Page) => page.$$eval(`${DOCS} section[data-collection="pages"] > .tnode > .drow:not(.is-held) .nm`, (els) => els.map((e) => e.textContent?.trim()));

let live: LiveSite;
let browser: Browser;

describe('arrange pages, live', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('arrange-pages-live', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('check 15a: an order-only Apply with Site Settings already waiting reaches a second person\'s tree on its next poll', async () => {
		const { site } = live;

		// Site Settings gets a waiting change of its own (the accent), kept in this person's tab.
		const aoife = await signedIn(browser, site, AOIFE);
		const settingsTab = await openAdmin(aoife, site, '/admin/settings');
		// Edit in context, Decision 9: Site Settings opens over Home, undimmed (no `is-aside`).
		await settingsTab.waitForSelector('[data-pane-level="document"] .presets[role="radiogroup"]');
		await settingsTab.click('.presets .preset[data-hex="#6e2f72"]');
		await eventually(async () => (await keepState(settingsTab)) === 'kept', 10_000, 'Site Settings: Kept');
		const rt = await runtime();
		await eventually(() => /#6e2f72/i.test(rt.git.read('content/site-settings.json') ?? ''), 15_000, 'drafts has the accent: Site Settings is waiting');

		// The second person opens the editor now: Site Settings is already on their waiting list.
		const ciaran = await signedIn(browser, site, CIARAN);
		const other = await openAdmin(ciaran, site);
		await other.waitForSelector(`${DOCS} section[data-collection="pages"]`, { state: 'attached' });
		const before = await eventually(async () => {
			const order = await sideOrder(other);
			return order.length > 3 ? order : null;
		}, 10_000, 'the second tab\'s Pages tree');
		const aboutAt = before!.indexOf('About');
		const journalAt = before!.indexOf('Journal');
		assert.ok(aboutAt > 0 && journalAt > aboutAt, `About then Journal to start with: ${before!.join(', ')}`);

		await other.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));

		// The first person arranges in another tab: Journal above About, Review…, Apply (an order only).
		const arrangeTab = await openAdmin(aoife, site);
		if (!(await arrangeTab.isVisible(DOCS))) await arrangeTab.click('.side-level:not([hidden]) .lv >> nth=0');
		await arrangeTab.click(`${DOCS} [data-act="open-arrange"]`);
		await arrangeTab.waitForSelector(`${PANE} [data-act="review"]`);
		await arrangeTab.waitForSelector(row('index'));
		const a = (await arrangeTab.locator(row('journal')).boundingBox())!;
		await arrangeTab.mouse.move(a.x + 120, a.y + a.height / 2);
		await arrangeTab.mouse.down();
		await arrangeTab.mouse.move(a.x + 130, a.y + a.height / 2 + 8, { steps: 3 });
		await arrangeTab.waitForSelector(`${row('journal')}.is-src`);
		const b = (await arrangeTab.locator(row('about')).boundingBox())!;
		await arrangeTab.mouse.move(b.x + 200, b.y + 4, { steps: 6 });
		await arrangeTab.mouse.up();
		await arrangeTab.click(`${PANE} [data-act="review"]`);
		await arrangeTab.waitForSelector(`${PANE} [data-act="apply"]`);
		assert.match(((await arrangeTab.textContent(`${PANE} .side-body`)) ?? '').replace(/\s+/g, ' '), /No address changes; the order of the Pages tree changes/);
		await arrangeTab.click(`${PANE} [data-act="apply"]`);
		await arrangeTab.waitForSelector(`${DOCS}:not([hidden]) [data-act="open-arrange"]`);
		assert.deepEqual((await sideOrder(arrangeTab)).slice(0, 3), ['Home', 'Journal', 'About'], 'the arranging tab at once');

		// The other tab never reloads; its next poll brings the new order.
		await eventually(async () => {
			const order = await sideOrder(other);
			return order.indexOf('Journal') === 1 && order.indexOf('About') === 2;
		}, 15_000, 'the second tab\'s tree in the new order');
		assert.deepEqual((await sideOrder(other)).slice(0, 3), ['Home', 'Journal', 'About']);

		assert.equal(await other.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), true, 'the second tab never reloaded');

		await aoife.close();
		await ciaran.close();
	});
});
