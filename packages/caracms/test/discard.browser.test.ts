// Discard changes in the editor, in a real browser, on the in-memory GitHub and the Redis
// stand-in (helpers/live-site.ts; never a real repo). From the waiting list: Discard… asks
// first ("Discard the unpublished changes to Home?"), Cancel leaves it, the confirmation puts
// Home back to what's live and the list empties. From the document's menu: Discard changes….
// Another tab with Home open (Ciarán, another browser) is told, and shows it as live.
//
//   node --test --experimental-strip-types test/discard.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip } from './helpers/dev-site.ts';
import { AOIFE, CIARAN, eventually, keepState, openAdmin, runtime, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

const TIMINGS = { sweepIdleMs: 2000, sweepCapMs: 300_000, sweepTickMs: 500, mainCheckMs: 1000, pollMs: 1000 };
const HOME = 'content/pages/index.json';
const INTRO = '[data-pane-level="block"] [data-ff="intro"] textarea';

let live: LiveSite;
let browser: Browser;

const pubState = (page: Page) => page.getAttribute('.bar [data-slot="publish"]', 'data-pub');

async function openIntro(page: Page) {
	if (!(await page.$(INTRO))) await page.click('.brow-main >> nth=0');
	await page.waitForSelector(INTRO);
}

async function editIntro(page: Page, text: string) {
	await openIntro(page);
	await page.fill(INTRO, text);
	await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');
}

describe('Discard changes, live', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('discard', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('from the waiting list: it asks, Cancel leaves it, Discard puts Home back to what\'s live; another browser with Home open follows', async () => {
		const { site } = live;
		const page = await openAdmin(await signedIn(browser, site, AOIFE), site);
		const other = await openAdmin(await signedIn(browser, site, CIARAN), site);
		await openIntro(page);
		const liveIntro = await page.inputValue(INTRO);
		await openIntro(other);

		await editIntro(page, 'Something to throw away.');
		await eventually(async () => (await pubState(page)) === 'waiting', 8000, '"1 waiting"');
		await page.click('.bar [data-slot="publish"]');
		const pop = page.locator('[data-pop="waiting"]');
		await pop.waitFor();
		const item = pop.locator(`[data-waiting="${HOME}"]`);
		await item.locator('[data-act="discard"]').click();

		const dialog = page.locator('[data-dialog="discard"]');
		await dialog.waitFor();
		assert.equal(await dialog.locator('h2').textContent(), 'Discard the unpublished changes to Home?');
		assert.equal(await dialog.locator('#dlg-d').textContent(), "It goes back to what's live.");
		await dialog.locator('button', { hasText: 'Cancel' }).click();
		await dialog.waitFor({ state: 'detached' });
		assert.equal(await pubState(page), 'waiting', 'Cancel changes nothing');
		assert.equal(await page.inputValue(INTRO), 'Something to throw away.');

		// Again, from the document's own menu this time (its level's head: Esc goes up from the block).
		const menu = page.locator('.side-level:not([hidden]) [data-act="doc-menu"]');
		for (let i = 0; i < 2 && !(await menu.isVisible()); i++) {
			await page.locator('.side-level:not([hidden])').first().click({ position: { x: 4, y: 4 } }).catch(() => undefined);
			await page.keyboard.press('Escape');
		}
		await menu.click();
		const menuItem = page.locator('[data-act="discard-document"]');
		await menuItem.waitFor();
		assert.match((await menuItem.textContent())!, /Discard changes…/);
		await menuItem.click();
		await dialog.waitFor();
		await dialog.locator('[data-act="confirm-discard"]').click();
		await dialog.waitFor({ state: 'detached' });

		await eventually(async () => (await pubState(page)) === 'nothing', 8000, 'nothing waiting');
		await eventually(async () => /Discarded the changes to Home/.test((await page.textContent('body')) ?? ''), 5000, 'the toast');
		const rt = await runtime();
		assert.equal(await rt.redis.get(`caracms:autosave:${HOME}`), null, 'the autosave is gone');
		assert.equal(rt.backend.file('drafts', `starter/${HOME}`), rt.backend.file('main', `starter/${HOME}`), 'drafts has the live file');
		await openIntro(page);
		assert.equal(await page.inputValue(INTRO), liveIntro, 'the page reads as live');
		// Nothing comes back on a reload (this browser's held copy went too).
		await page.reload();
		await openIntro(page);
		await eventually(async () => (await pubState(page)) === 'nothing', 8000, 'still nothing waiting');
		assert.equal(await page.inputValue(INTRO), liveIntro);

		// Ciarán's tab had Home open: it's told, and shows it as live.
		await eventually(async () => /aoife discarded the unpublished changes to Home/.test((await other.textContent('body')) ?? ''), 10_000, 'the other browser is told');
		await openIntro(other);
		assert.equal(await other.inputValue(INTRO), liveIntro);
	});
});
