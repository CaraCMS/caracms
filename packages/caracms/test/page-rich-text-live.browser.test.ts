// On-page rich text and the lock (Decision 10; Exit step 8), in live mode on the
// in-memory GitHub (helpers/live-site.ts; `CARACMS_GITHUB=memory`, never a real repo):
// one person, two tabs. The first types the Text block's body on the page; the second
// takes over ("Edit here"). The first's page editor goes at once, the typed text is
// kept, and a read-only tab never mounts one.
//
//   node --test --experimental-strip-types test/page-rich-text-live.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { browserSkip } from './helpers/dev-site.ts';
import { AOIFE, eventually, keepState, openAdmin, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';
import { BODY, charPoint, fieldState, revealBody } from './helpers/rich-on-page.ts';

const TIMINGS = { sweepIdleMs: 1500, sweepTickMs: 500, sweepCapMs: 10_000, lockLapseMs: 20_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500 };
const SHOWN = '.side-level:not([hidden])';

let live: LiveSite;
let browser: Browser;

describe('on-page rich text, live', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('page-rich-text-live', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('going read-only mid-typing tears the page editor down and keeps the text; read-only never mounts it', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, AOIFE);
		const one = await openAdmin(context, site, '/admin');
		await revealBody(one);
		const at = await charPoint(one, 'clients');
		await one.mouse.move(at.x, at.y);
		await one.mouse.click(at.x, at.y);
		await eventually(async () => (await fieldState(one)).focused, 5000, 'tab one: typing in the body');
		await one.keyboard.type('loyal ');
		assert.equal((await fieldState(one)).mounted, true);
		await eventually(async () => (await keepState(one)) === 'kept', 10_000, 'tab one: Kept');

		const two = await openAdmin(context, site, '/admin');
		await eventually(async () => (await two.locator(`${SHOWN} [data-note="elsewhere"]`).count()) === 1, 8000, 'tab two: "editing in another tab"');
		// Tab two is read-only: the pointer on the body mounts nothing.
		await revealBody(two);
		const there = await charPoint(two, 'clients');
		await two.mouse.move(there.x, there.y);
		await two.mouse.move(there.x + 3, there.y);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal((await fieldState(two)).mounted, false, 'tab two (read-only): no page editor');
		assert.match((await fieldState(two)).html, /Most of our loyal clients/, 'tab two has tab one\'s text');
		// A focus (a tap, Tab) mounts nothing in a read-only tab either: the field is blurred at once, and keys change nothing.
		const before = (await fieldState(two)).outer;
		await two.frameLocator('.frame.on iframe').locator(BODY).focus();
		await new Promise((r) => setTimeout(r, 300)); // a negative wait: nothing should happen
		const focused = await fieldState(two);
		assert.equal(focused.mounted, false, 'tab two (read-only): focus mounts no page editor');
		assert.equal(focused.focused, false, 'and the field does not keep focus');
		await two.keyboard.type('ZZ');
		await new Promise((r) => setTimeout(r, 300));
		assert.equal((await fieldState(two)).outer, before, 'typing in a read-only tab changes nothing');
		assert.equal(await two.locator(`${SHOWN} [data-ff="body"] .chip.typing`).count(), 0, 'no "Typing on the page"');

		await two.click('[data-act="edit-here"]');
		await eventually(async () => (await two.locator(`${SHOWN} [data-note="elsewhere"]`).count()) === 0, 5000, 'tab two: editable');
		// Tab one learns on its next poll: its page editor goes, with the pointer still on the body.
		await eventually(async () => (await one.locator(`${SHOWN} [data-note="elsewhere"]`).count()) === 1, 8000, 'tab one: read-only');
		await eventually(async () => !(await fieldState(one)).mounted, 4000, 'tab one: the page editor is gone');
		const left = await fieldState(one);
		assert.match(left.html, /Most of our loyal clients/, 'the typed text is kept');
		assert.doesNotMatch(left.outer, /contenteditable|ProseMirror/);
		assert.equal(left.focused, false);
		await one.mouse.move(at.x + 2, at.y);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal((await fieldState(one)).mounted, false, 'and it isn\'t mounted again while read-only');
		await context.close();
	});
});
