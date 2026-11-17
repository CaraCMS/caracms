// The editor, live (M4 Phase 4 → Verify 1, 2, 4 and 5), in a real browser: a copy of the
// demo under `astro dev` in live mode on the in-memory GitHub and the Redis stand-in,
// with short sweep times (helpers/live-site.ts; Decision 2), never a real repo. People
// are signed in with a session cookie each, in their own browser context.
//
//   node --test --experimental-strip-types test/live-editor.browser.test.ts
//
// Each test works on its own document, so one test's lock never gets in another's way.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip } from './helpers/dev-site.ts';
import { AOIFE, CIARAN, cookieFor, eventually, keepState, openAdmin, runtime, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

const TIMINGS = { sweepIdleMs: 1500, sweepTickMs: 500, sweepCapMs: 10_000, lockLapseMs: 20_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 1000 };

let live: LiveSite;
let browser: Browser;

const INTRO = '[data-pane-level="block"] [data-ff="intro"] textarea';
const frame = (page: Page) => page.frameLocator('#stage iframe[data-width="1440"]');

/** Open the hero (the first block) and type into its intro. */
async function editIntro(page: Page, text: string) {
	if (!(await page.$(INTRO))) await page.click('.brow-main >> nth=0');
	await page.waitForSelector(INTRO);
	await page.fill(INTRO, text);
}

// A lifting veil (`.out`, fading over --dur-slow) no longer counts: it takes no clicks and is about to go.
const veiled = (page: Page) => frame(page).locator('#cms-overlays .cms-veil:not(.out)').count();
/** The pane level on screen (the documents level stays mounted, hidden). */
const SHOWN = '.side-level:not([hidden])';
const note = (page: Page, kind: string) => page.locator(`${SHOWN} [data-note="${kind}"]`).count();

describe('the editor, live', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('live-editor', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('Verify 1: A edits Home; B sees "A is editing" with the veil and disabled fields, can\'t type on the page, and gets Home back without a reload once A closes the tab', async () => {
		const { site } = live;
		const b = await openAdmin(await signedIn(browser, site, CIARAN), site);
		assert.equal(await note(b, 'locked'), 0, 'nobody is editing Home yet');
		const contextA = await signedIn(browser, site, AOIFE);
		const a = await openAdmin(contextA, site);
		const text = 'Aoife was here, in the hero.';
		await editIntro(a, text);
		await eventually(async () => (await keepState(a)) === 'kept', 10_000, 'A: Kept');

		// Within about 5 s (the poll), B's Home is locked: the note, the veil, the chip, the dots in navigation.
		const started = Date.now();
		await eventually(async () => (await note(b, 'locked')) === 1, 8000, 'B: "aoife is editing"');
		console.log(`[verify 1] B saw the lock ${Date.now() - started} ms after A's change was kept`);
		assert.match((await b.textContent(`${SHOWN} [data-note="locked"]`))!, /aoife is editing/);
		assert.equal(await b.locator('[data-chip="read-only"]').count(), 1);
		await eventually(async () => (await veiled(b)) === 1, 5000, 'B: the veil');
		assert.equal(await b.locator('[data-doc="pages/index"] [data-mark="editing"]').count(), 1, 'B: Home\'s row shows A editing');
		assert.equal(await b.locator('.add-row').isDisabled(), true, 'B: Add block is off');
		assert.equal(await b.locator('.brow .brow-more').count(), 0, 'B: no row menus');

		// Disabled fields: the block still opens, read-only.
		await b.click('.brow-main >> nth=0');
		await b.waitForSelector(INTRO);
		assert.equal(await b.isDisabled(INTRO), true, 'B: the intro is disabled');
		assert.equal(await b.inputValue(INTRO), text, 'B sees A\'s latest');

		// No typing on the page: the veil takes the click, and nothing opens or changes.
		const before = await frame(b).locator('[data-cms-block="1"]').textContent();
		await frame(b).locator('#cms-overlays .cms-veil').click({ position: { x: 300, y: 600 } });
		await b.keyboard.type('nope');
		assert.equal(await frame(b).locator('[data-cms-block="1"]').textContent(), before, 'B: the page is unchanged');
		assert.equal(await b.locator('.chip.typing').count(), 0, 'B: no "Typing on the page"');

		// A closes the tab: the last write released the lock, which drops once the autosave is committed.
		await a.close({ runBeforeUnload: true });
		await eventually(async () => !(await b.isDisabled(INTRO)), 30_000, 'B: Home editable again');
		// The mockup's #lapsed toast, with the person's name.
		await eventually(async () => /Home is free to edit\./.test((await b.locator('#toast-root .toast').textContent().catch(() => '')) ?? ''), 5000, 'B: the lapse toast');
		assert.equal(await note(b, 'locked'), 0);
		assert.equal(await veiled(b), 0, 'B: the veil lifted');
		assert.equal(await b.inputValue(INTRO), text, 'B edits A\'s latest');
		const rt = await runtime();
		assert.match(rt.git.read('content/pages/index.json') ?? '', /Aoife was here/, 'drafts has the change');
		await b.context().close();
		await contextA.close();
	});

	test('Verify 2: one person, two tabs: the second says "You\'re editing this in another tab"; Edit here moves the lock, and the first goes read-only', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, AOIFE);
		const one = await openAdmin(context, site, '/admin/pages/about');
		await editIntro(one, 'Edited in tab one.');
		await eventually(async () => (await keepState(one)) === 'kept', 10_000, 'tab one: Kept');

		const two = await openAdmin(context, site, '/admin/pages/about');
		await eventually(async () => (await note(two, 'elsewhere')) === 1, 8000, 'tab two: "You\'re editing this in another tab"');
		assert.match((await two.textContent(`${SHOWN} [data-note="elsewhere"]`))!, /You're editing this in another tab/);
		assert.equal(await veiled(two), 1);

		await two.click('[data-act="edit-here"]');
		await eventually(async () => (await note(two, 'elsewhere')) === 0, 5000, 'tab two: editable');
		await two.click('.brow-main >> nth=0');
		await two.waitForSelector(INTRO);
		assert.equal(await two.isDisabled(INTRO), false);
		assert.equal(await two.inputValue(INTRO), 'Edited in tab one.', 'tab two has tab one\'s latest');

		// The first tab learns on its next poll.
		await eventually(async () => (await note(one, 'elsewhere')) === 1, 8000, 'tab one: read-only');
		assert.equal(await one.isDisabled(INTRO), true);

		// And tab two's edits are kept.
		await two.fill(INTRO, 'Edited in tab two.');
		await eventually(async () => (await keepState(two)) === 'kept', 10_000, 'tab two: Kept');
		await context.close();
	});

	test('Verify 4: the server stops mid-edit: the countdown, Try now and the unsent count show; it comes back, and the edits go through', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, AOIFE);
		const page = await openAdmin(context, site, '/admin/pages/contact');
		await editIntro(page, 'Before the outage.');
		await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');

		await site.stop();
		await page.fill(INTRO, 'Typed while the server was away.');
		await eventually(async () => (await keepState(page)) === 'offline', 10_000, 'offline');
		const offline = page.locator(`${SHOWN} [data-note="offline"]`);
		await eventually(async () => /Trying again in \d+ s\./.test((await offline.textContent()) ?? ''), 5000, 'the countdown');
		assert.match((await offline.textContent())!, /\d+ changes? only in this tab\. Keep it open\./);
		assert.ok(Number(await offline.locator('[data-unsent]').getAttribute('data-unsent')) > 0, 'the unsent count');
		assert.equal(await page.locator(`${SHOWN} [data-act="try-now"]`).count(), 1, 'Try now');
		// Try now while it's still down: still offline, nothing lost.
		await page.click(`${SHOWN} [data-act="try-now"]`);
		await eventually(async () => (await keepState(page)) === 'offline', 5000, 'still offline');

		await site.start();
		await page.click(`${SHOWN} [data-act="try-now"]`);
		await eventually(async () => (await keepState(page)) === 'kept', 20_000, 'Kept once the server is back');
		assert.equal(await page.locator(`${SHOWN} [data-note="offline"]`).count(), 0);
		const doc = await fetch(`${site.origin}/_caracms/document?collection=pages&path=contact`, { headers: { cookie: `${cookieFor(site, AOIFE).name}=${cookieFor(site, AOIFE).value}` } });
		assert.match((await doc.json()).text, /Typed while the server was away\./, 'the server has the edit');
		await context.close();
	});

	test('Verify 5: a merge notice on the document and in the waiting list, gone once dismissed; signed out mid-edit holds the edits, and signing in from another tab sends them', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, AOIFE);
		const page = await openAdmin(context, site, '/admin/pages/work');
		await editIntro(page, 'A draft change to Work.');
		await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');
		const rt = await runtime();
		await eventually(() => /A draft change to Work/.test(rt.git.read('content/pages/work.json') ?? '') && !rt.git.waiting().every((w) => w.file !== 'content/pages/work.json'), 15_000, 'the sweep committed Work');

		// A developer changes the same key (`blocks`) on main: the merge keeps the draft, with a notice.
		const work = rt.backend.file('main', 'starter/content/pages/work.json')!;
		rt.backend.push('main', { 'starter/content/pages/work.json': work.replace(/"intro": "[^"]*"/, '"intro": "Changed on main."') });
		await eventually(async () => (await note(page, 'draft-kept')) === 1, 15_000, 'the merge notice on Work');
		assert.match((await page.textContent(`${SHOWN} [data-note="draft-kept"]`))!, /Work was also changed outside the editor\./);
		assert.equal(await page.locator('[data-doc="pages/work"] [data-mark="kept"]').count(), 1, 'Work\'s row is marked');
		await page.click('.pub');
		await page.waitForSelector('[data-pop="waiting"]');
		assert.equal(await page.locator('[data-pop="waiting"] [data-waiting="content/pages/work.json"] [data-note="draft-kept"]').count(), 1, 'and in the waiting list');
		await page.keyboard.press('Escape');
		await page.click(`${SHOWN} [data-note="draft-kept"] [data-act="dismiss"]`);
		await eventually(async () => (await note(page, 'draft-kept')) === 0, 3000, 'dismissed');
		await page.click('.pub');
		await page.waitForSelector('[data-pop="waiting"]');
		await eventually(async () => (await page.locator('[data-pop="waiting"] [data-note="draft-kept"]').count()) === 0, 8000, 'gone from the list too');
		await page.keyboard.press('Escape');

		// The session ends mid-edit: the edits stay in the tab. (Typed after it ended, so the preview's render answers 401 too.)
		await context.clearCookies();
		await page.fill(INTRO, 'Typed after the session ended.');
		await eventually(async () => (await page.locator('[data-modal="signed-out"]').count()) === 1, 10_000, '"You\'ve been signed out"');
		await eventually(async () => (await keepState(page)) === 'signedout', 5000, 'Not kept: signed out');
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(await page.locator('#bar .bar-warn').count(), 0, 'no "Preview not updated" while signed out (the mockup\'s #signed-out-edit)');
		// The keeper's own write (a second after the change) is what counts the unsent edits.
		await eventually(async () => /haven't reached the server|hasn't reached the server/.test((await page.textContent('[data-modal="signed-out"]')) ?? ''), 5000, 'the modal counts the unsent change');
		assert.equal(await page.isDisabled(INTRO), true, 'read-only while signed out');
		assert.ok(await page.evaluate(() => Object.keys(localStorage).some((k) => k.endsWith(':pages/work'))), 'held in this browser');

		// Signing in again in another tab brings the cookie back; this tab's next poll sends the edits.
		await context.addCookies([cookieFor(site, AOIFE)]);
		await eventually(async () => (await keepState(page)) === 'kept', 15_000, 'Kept after signing in again');
		assert.equal(await page.locator('[data-modal="signed-out"]').count(), 0);
		const doc = await fetch(`${site.origin}/_caracms/document?collection=pages&path=work`, { headers: { cookie: `${cookieFor(site, AOIFE).name}=${cookieFor(site, AOIFE).value}` } });
		assert.match((await doc.json()).text, /Typed after the session ended\./, 'the server has them');
		await context.close();
	});

	test('the account menu: who is signed in, and Sign out', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, CIARAN);
		const page = await openAdmin(context, site, '/admin/pages/services/branding');
		assert.equal(await page.getAttribute('.bar .me', 'aria-label'), 'Signed in as ciaran');
		await page.click('.bar .me');
		const pop = page.locator('[data-pop="account"]');
		await pop.waitFor();
		assert.match((await pop.textContent())!, /ciaran@example\.com/);
		await Promise.all([page.waitForURL(/\/admin\/login/), pop.locator('[data-act="sign-out"]').click()]);
		assert.equal((await context.cookies()).filter((c) => /caracms_session/.test(c.name)).length, 0, 'the session cookie is gone');
		await context.close();
	});
});
