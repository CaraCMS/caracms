// M5a Phase 5's screens in live mode, in two browsers: a copy of the demo under `astro
// dev` on the in-memory GitHub and the Redis stand-in (`CARACMS_GITHUB=memory`), with
// short sweep times (helpers/live-site.ts), never a real repo. A new page and a deleted
// one in the waiting list, a viewer's "deleted by", a delete refused under someone
// else's lock, and Site Settings' accent and editors applying without a Publish.
//
//   node --test --experimental-strip-types test/m5a-live.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip } from './helpers/dev-site.ts';
import { AOIFE, CIARAN, cookieFor, eventually, keepState, openAdmin, runtime, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

const TIMINGS = { sweepIdleMs: 1500, sweepTickMs: 500, sweepCapMs: 10_000, lockLapseMs: 20_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 1000 };

let live: LiveSite;
let browser: Browser;

const SHOWN = '.side-level:not([hidden])';
const DOCS = '[data-pane-level="documents"]';
const INTRO = '[data-pane-level="block"] [data-ff="intro"] textarea';
const PRESETS = '[data-pane-level="document"]:not([hidden]) .presets[role="radiogroup"]';
const SETTINGS_FILE = 'content/site-settings.json';
const accentOf = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent').trim().toLowerCase());

async function waitingRows(page: Page): Promise<Record<string, string>> {
	if (!(await page.$('[data-pop="waiting"]'))) await page.click('button.pub');
	await page.waitForSelector('[data-pop="waiting"]');
	return page.$$eval('[data-waiting]', (rows) =>
		Object.fromEntries(rows.map((r) => [r.getAttribute('data-waiting')!, r.querySelector('[data-change]')?.getAttribute('data-change') ?? 'changed'])),
	);
}

/** Discard changes on Site Settings, from the waiting list. */
async function discard(page: Page): Promise<void> {
	await eventually(async () => SETTINGS_FILE in (await waitingRows(page)), 15_000, 'Site Settings is waiting');
	await page.locator(`[data-waiting="${SETTINGS_FILE}"] [data-act="discard"]`).click();
	await page.locator('[data-dialog="discard"] [data-act="confirm-discard"]').click();
	await page.locator('[data-dialog="discard"]').waitFor({ state: 'detached' });
}

describe('M5a screens, live', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('m5a-live', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('a new page: the creator holds it and it opens; the other tab lists it on its next poll; the waiting list says New page', async () => {
		const { site } = live;
		const a = await openAdmin(await signedIn(browser, site, AOIFE), site);
		const b = await openAdmin(await signedIn(browser, site, CIARAN), site, '/admin/pages/contact');
		await a.keyboard.press('Escape');
		await a.click(`${DOCS} [data-act="new-page"]`);
		await a.click('#np-inside');
		await a.click('[data-inside-pick="__new"]');
		await a.fill('#np-group', 'Studio');
		await a.fill('#np-name', 'Visit');
		assert.equal(await a.getAttribute('[data-dialog="new"] [data-address]', 'data-address'), '/studio/visit');
		await a.click('[data-dialog="new"] [data-act="create"]');
		await eventually(() => new URL(a.url()).pathname === '/admin/pages/studio/visit', 10_000, 'A: it opens');
		await a.waitForSelector(`${SHOWN} [data-empty="page"]`);
		await eventually(async () => (await a.locator(`${SHOWN} .cur .chip.waiting`).count()) === 1, 10_000, 'A: the New chip');

		// B: in the listing within a poll or two, with no reload (in its Studio group, closed for B).
		await eventually(async () => (await b.locator(`${DOCS} [data-group="pages:studio"]`).count()) === 1, 15_000, 'B lists Studio');
		const rows = await eventually(async () => {
			const r = await waitingRows(b);
			return r['content/pages/studio/visit.json'] === 'new' ? r : null;
		}, 15_000, 'B: Visit waiting as New page');
		assert.equal(rows!['content/pages/studio/visit.json'], 'new');
		assert.match((await b.textContent('[data-waiting="content/pages/studio/visit.json"] [data-change]'))!, /New page/);
		await a.context().close();
		await b.context().close();
	});

	test('a delete: refused while someone else is editing, saying who; then a viewer sees who deleted it, and the waiting list says Deleted', async () => {
		const { site } = live;
		const b = await openAdmin(await signedIn(browser, site, CIARAN), site, '/admin/pages/services/print');
		// B edits Print: B holds its lock.
		await b.click('.brow-main >> nth=0');
		await b.waitForSelector(INTRO);
		await b.fill(INTRO, 'Ciarán was here.');
		await eventually(async () => (await keepState(b)) === 'kept', 10_000, 'B: Kept');

		const a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/pages/services/print');
		await eventually(async () => (await a.locator(`${SHOWN} [data-note="locked"]`).count()) === 1, 10_000, 'A: Ciarán is editing');
		await a.click(`${SHOWN} [data-act="doc-menu"]`);
		assert.equal(await a.isDisabled('[data-act="delete-document"]'), true);
		assert.match((await a.textContent('[data-why="delete"]'))!, /ciaran is editing Print\. It can be deleted once they're done\./i);
		await a.keyboard.press('Escape');

		// B leaves (the lock goes with the tab's last write); then A deletes it.
		await b.close({ runBeforeUnload: true });
		await eventually(async () => (await a.locator(`${SHOWN} [data-note="locked"]`).count()) === 0, 30_000, 'A: the lock lapses');
		const viewer = await openAdmin(await signedIn(browser, site, CIARAN), site, '/admin/pages/services/print');
		await a.click(`${SHOWN} [data-act="doc-menu"]`);
		await a.click('[data-act="delete-document"]');
		await a.waitForSelector('[data-dialog="delete"]');
		assert.match((await a.textContent('[data-dialog="delete"] #dlg-d'))!, /stops working at the next Publish\./);
		await a.click('[data-act="confirm-delete"]');
		await a.waitForSelector('[data-dialog="delete"]', { state: 'detached' });
		await eventually(async () => (await a.getAttribute('#side', 'data-level')) === 'documents', 8000, 'A: the documents level');
		assert.equal(await a.locator(`${DOCS} [data-doc="pages/services/print"]`).count(), 0, 'A: not in the tree');
		assert.match((await a.textContent('#toast-root'))!, /Deleted Print\./);

		// The viewer: read-only, saying who deleted it.
		await eventually(async () => (await viewer.locator(`${SHOWN} [data-note="deleted"]`).count()) === 1, 15_000, 'the viewer: deleted');
		assert.match((await viewer.textContent(`${SHOWN} [data-note="deleted"]`))!, /aoife deleted Print/i);
		assert.equal(await viewer.locator('.add-row').isDisabled(), true, 'the viewer: read-only');

		const rows = await eventually(async () => {
			const r = await waitingRows(a);
			return r['content/pages/services/print.json'] === 'deleted' ? r : null;
		}, 15_000, 'A: Print waiting as Deleted');
		assert.equal(rows!['content/pages/services/print.json'], 'deleted');
		// Services still holds Branding and Websites.
		await a.keyboard.press('Escape');
		const group = `${DOCS} [data-group="pages:services"]`;
		if ((await a.getAttribute(group, 'aria-expanded')) !== 'true') await a.click(group);
		await a.waitForSelector(`${DOCS} [data-doc="pages/services/branding"]`);
		await a.waitForSelector(`${DOCS} [data-doc="pages/services/websites"]`);
		await a.context().close();
		await viewer.context().close();
	});

	test('Exit 5: Site Settings\' accent reaches the chrome with no Publish; @gmail.com gives its reason and lets nobody at Gmail in', async () => {
		const { site } = live;
		const a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/settings');
		const b = await openAdmin(await signedIn(browser, site, CIARAN), site);
		// Edit in context, Decision 9: Site Settings opens over Home, undimmed (no `is-aside`).
		await a.waitForSelector(`${PRESETS}`);
		const before = await accentOf(b);
		const rt = await runtime();
		const mainBefore = (await rt.backend.readHeads()).main;
		// Editor restyle, Decision 12: a pick paints this tab at once; another tab only once it's kept (the brand poll).
		await a.click(`${PRESETS} .preset[data-hex="#6e2f72"]`);
		assert.equal(await accentOf(a), '#6e2f72', 'this tab, at once');
		assert.equal(await accentOf(b), before, 'another tab: unchanged until it is kept');
		const started = Date.now();
		await eventually(async () => (await accentOf(b)) === '#6e2f72', 60_000, "the other tab's accent");
		console.log(`[exit 5] the accent reached another tab ${Date.now() - started} ms after it was picked (was ${before})`);
		assert.deepEqual((await rt.backend.readHeads()).main, mainBefore, 'main is unchanged: no Publish');
		await b.context().close();

		await a.fill('#ed-new', '@gmail.com');
		assert.match((await a.textContent('#ed-err'))!, /Public mail domains let nobody in/);
		await a.click('[data-form="editor"] button[type="submit"]');
		await a.waitForSelector('.ed[data-editor="@gmail.com"][data-warned]');
		await eventually(async () => (await keepState(a)) === 'kept', 10_000, 'Kept');
		// Committed to drafts at the sweep's next tick, and still nobody at Gmail gets in.
		await eventually(() => /@gmail\.com/.test(rt.git.read('content/site-settings.json') ?? ''), 15_000, 'drafts has the entry');
		const { name, value } = cookieFor(site, 'someone@gmail.com');
		const response = await fetch(`${site.origin}/_caracms/documents`, { headers: { cookie: `${name}=${value}`, accept: 'application/json' } });
		assert.equal(response.status, 401, 'someone@gmail.com is not let in');
		await a.context().close();
	});
	test('editor restyle, check 16: the accent is a radio group of presets with "Current" first; the arrows pick and paint at once; Discard puts it back', async () => {
		const { site } = live;
		let a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/settings');
		// Exit 5 kept Plum; put the fixture's own colour back, as a site from before the presets has it.
		const rt = await runtime();
		const fixture = rt.backend.file('main', `starter/${SETTINGS_FILE}`)!;
		const stored = /"accent":\s*"(#[0-9a-f]{6})"/i.exec(fixture)![1]!.toLowerCase();
		if (rt.git.read(SETTINGS_FILE) !== fixture) {
			await discard(a);
			await eventually(async () => (await accentOf(a)) === stored, 15_000, 'Site Settings back to what is live');
			await a.context().close();
			a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/settings');
		}
		// The closed tabs' lock on Site Settings lapses first (until then this tab only reads it, the swatches disabled).
		await a.waitForSelector(`${PRESETS} [aria-checked="true"]:not(:disabled)`, { timeout: 40_000 });
		const radios = () =>
			a.$$eval(`${PRESETS} [role="radio"]`, (els) => els.map((el) => `${el.getAttribute('aria-label')} ${el.getAttribute('aria-checked')} ${el.getAttribute('tabindex')}`));
		assert.deepEqual(await radios(), [
			`Current, ${stored.toUpperCase()} true 0`,
			'Navy, #1F2F57 false -1',
			'Slate, #46607A false -1',
			'Petrol, #1D4E63 false -1',
			'Plum, #6E2F72 false -1',
			'Walnut, #5C3D2A false -1',
			'Ink, #2E2A24 false -1',
		]);
		assert.equal(await a.locator(`${PRESETS} .presets-sep`).count(), 1, 'Current is set apart');
		assert.equal(await accentOf(a), stored);

		// The keyboard: the checked one takes Tab's focus; the arrows move and pick, Home and End jump.
		await a.focus(`${PRESETS} [aria-checked="true"]`);
		const focused = () => a.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
		await a.keyboard.press('ArrowRight');
		assert.equal(await focused(), 'Navy, #1F2F57');
		assert.equal(await a.getAttribute(`${PRESETS} [data-hex="#1f2f57"]`, 'aria-checked'), 'true');
		assert.equal(await accentOf(a), '#1f2f57', 'a pick paints this tab at once');
		assert.match((await a.textContent('#set-accent-n'))!, /Navy · #1F2F57/);
		await a.keyboard.press('End');
		assert.equal(await focused(), 'Ink, #2E2A24');
		assert.equal(await accentOf(a), '#2e2a24');
		// A branded .btn.ink follows the root (Decision 12): the sample's computed fill is the pick.
		const inkFill = await a.evaluate(() => {
			const probe = document.createElement('button');
			probe.className = 'btn ink';
			document.body.append(probe);
			const fill = getComputedStyle(probe).backgroundColor;
			probe.remove();
			return fill;
		});
		assert.equal(inkFill, 'rgb(46, 42, 36)', '.btn.ink wears the pick');
		await a.keyboard.press('Home');
		assert.equal(await focused(), `Current, ${stored.toUpperCase()}`);
		assert.equal(await accentOf(a), stored, '"Current" puts back the committed accent');
		await a.keyboard.press('ArrowLeft');
		assert.equal(await focused(), 'Ink, #2E2A24', 'the arrows wrap');
		assert.equal(await accentOf(a), '#2e2a24');

		// Kept, so Site Settings is waiting; Discard puts the editor back to the committed colour.
		await eventually(async () => /#2e2a24/i.test(rt.git.read(SETTINGS_FILE) ?? ''), 15_000, 'drafts has Ink');
		assert.equal(await a.locator(`${PRESETS} .presets-sep`).count(), 1, 'Current stays while Site Settings is open');
		// Once the poll carries the kept Ink into the brand store, "Current" still paints the colour the level mounted
		// with, not the brand store's (review fix, 2026-11-03). Another tab seeing Ink says the poll has it; then a's next polls.
		const b = await openAdmin(await signedIn(browser, site, CIARAN), site);
		await eventually(async () => (await accentOf(b)) === '#2e2a24', 15_000, "the other tab's accent is the kept Ink");
		await b.context().close();
		await a.waitForTimeout(TIMINGS.pollMs * 3);
		await a.focus(`${PRESETS} [aria-checked="true"]`);
		await a.keyboard.press('Home');
		assert.equal(await accentOf(a), stored, '"Current" paints the committed accent once a pick was kept');
		await a.keyboard.press('End');
		assert.equal(await accentOf(a), '#2e2a24');
		await discard(a);
		await eventually(async () => (await accentOf(a)) === stored, 15_000, 'Discard: the accent is back');
		await eventually(async () => (await a.getAttribute(`${PRESETS} [data-hex="${stored}"]`, 'aria-checked')) === 'true', 10_000, 'Current is checked again');
		await a.context().close();
	});

	test('pre-M7 item 8: Change address… moves Contact into Studio; the footer\'s link follows it, and the waiting list says Moved, from /contact', async () => {
		const { site } = live;
		const a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/pages/contact');
		await a.click(`${SHOWN} [data-act="doc-menu"]`);
		await a.click('[data-act="move-document"]');
		await a.waitForSelector('[data-dialog="move"]');
		assert.equal(await a.isDisabled('[data-act="confirm-move"]'), true, 'its own address: nothing to change');
		// "Leave a redirect from /contact", ticked to start with; unticked, it says what that means.
		assert.equal(await a.isChecked('#mv-redirect'), true);
		assert.match((await a.textContent('#mv-redirect-h'))!, /Anyone with the old address lands here\. Goes live at the next Publish\./);
		await a.click('#mv-redirect');
		assert.match((await a.textContent('#mv-redirect-h'))!, /Nothing will be at \/contact/);
		await a.click('#mv-redirect');
		// Inside offers a page with nothing under it yet (Websites), but never Contact itself.
		await a.click('#mv-inside');
		const inside = await a.$$eval('#mv-inside-list [data-inside-pick]', (os) => os.map((o) => o.getAttribute('data-inside-pick')!));
		assert.ok(inside.includes('services/websites'), inside.join(' | '));
		assert.ok(!inside.includes('contact'), inside.join(' | '));
		await a.click('[data-inside-pick="studio"]');
		assert.equal(await a.getAttribute('[data-dialog="move"] [data-address]', 'data-address'), '/studio/contact');
		await a.click('[data-dialog="move"] [data-act="confirm-move"]');
		await eventually(() => new URL(a.url()).pathname === '/admin/pages/studio/contact', 10_000, 'it opens at its new address');
		const footer = await a.evaluate(async () => ((await (await fetch('/_caracms/document?collection=shared&path=footer')).json()) as { text: string }).text);
		assert.match(footer, /"href": "\/studio\/contact"/);
		const settings = await a.evaluate(async () => ((await (await fetch('/_caracms/document?collection=settings&path=site-settings')).json()) as { text: string }).text);
		assert.match(settings, /\{ "from": "\/contact", "to": "\/studio\/contact" \}/);
		const rows = await eventually(async () => {
			const r = await waitingRows(a);
			return r['content/pages/studio/contact.json'] === 'moved' ? r : null;
		}, 15_000, 'Contact waiting as Moved');
		assert.equal(rows!['content/pages/contact.json'], undefined, 'one entry for the move');
		assert.match((await a.textContent('[data-waiting="content/pages/studio/contact.json"] [data-moved-from]'))!, /\/contact redirects here\./);
		await a.context().close();
	});
});

// Its own site: Site Settings is as on main once the redirect is out (the tests above edit it).
// The sweep's short tick here commits the move first; move-live.test.ts covers every order.
describe('a move\'s redirect, removed and put back with ⌘Z, live', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('m5a-live-undo', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('the redirect removed in Site Settings, then ⌘Z: back for good (after a reload too), Site Settings waiting, and Contact reads "/contact redirects here."', async () => {
		const { site } = live;
		const FILE = 'content/site-settings.json';
		const a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/pages/contact');
		await a.click(`${SHOWN} [data-act="doc-menu"]`);
		await a.click('[data-act="move-document"]');
		await a.waitForSelector('[data-dialog="move"]');
		await a.click('#mv-inside');
		await a.click('[data-inside-pick="services"]');
		await a.click('[data-dialog="move"] [data-act="confirm-move"]');
		await eventually(() => new URL(a.url()).pathname === '/admin/pages/services/contact', 10_000, 'it opens at its new address');
		const rt = await runtime();
		const pending = async () => (await a.evaluate(async () => ((await (await fetch('/_caracms/status')).json()) as { waiting: unknown[] }).waiting)) as { file: string; movedRedirect?: boolean; uncommitted: boolean }[];
		const REDIRECT = /\{ "from": "\/contact", "to": "\/services\/contact" \}/;
		await eventually(() => REDIRECT.test(rt.git.read(FILE) ?? ''), 15_000, 'the move\'s redirect in drafts');

		await a.goto(`${site.origin}/admin/settings`);
		await a.waitForSelector('[data-redirect="/contact"]');
		await a.click('[data-redirect="/contact"] button.ib');
		await a.waitForSelector('[data-redirect="/contact"]', { state: 'detached' });
		await eventually(async () => (await keepState(a)) === 'kept', 10_000, 'the removal Kept');
		await eventually(async () => !REDIRECT.test(rt.git.read(FILE) ?? '') && !(await pending()).some((w) => w.file === FILE && w.uncommitted), 15_000, 'the removal committed: Site Settings as on main');

		await a.keyboard.press('ControlOrMeta+z');
		await a.waitForSelector('[data-redirect="/contact"]');
		await eventually(async () => (await keepState(a)) === 'kept', 10_000, 'the undo Kept');
		await eventually(() => REDIRECT.test(rt.git.read(FILE) ?? ''), 15_000, 'the redirect back in drafts');
		// A few sweep ticks on, it's still there, and Site Settings is waiting again.
		await new Promise((r) => setTimeout(r, 3000));
		assert.match(rt.git.read(FILE) ?? '', REDIRECT, 'still in drafts a few ticks on');
		const st = await pending();
		assert.ok(st.some((w) => w.file === FILE), 'Site Settings is waiting');
		assert.equal(st.find((w) => w.file === 'content/pages/services/contact.json')?.movedRedirect, true);
		await waitingRows(a);
		assert.match((await a.textContent('[data-waiting="content/pages/services/contact.json"] [data-moved-from]'))!, /\/contact redirects here\./);
		// And after a reload, the Redirects panel has it.
		await a.reload();
		await a.waitForSelector('[data-redirect="/contact"]');
		await a.context().close();
	});
});
