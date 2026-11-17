// The Redis diet, the keeper's side (the spec's checks 15, 16, 17
// and 22), in a real browser: a copy of the demo under `astro dev` in live mode on the
// in-memory GitHub, with the timings scaled down (helpers/redis-diet.ts: a keep 1.5 s
// after the last change, at most 5 s after the first unsent one).
//
//   node --test --experimental-strip-types test/redis-diet-keeper.browser.test.ts
//
// Each test works on its own document.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { browserSkip } from './helpers/dev-site.ts';
import { AOIFE, CIARAN, eventually, keepState, openAdmin, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';
import { INTRO, TIMINGS, focusIntro, note, record, sleep } from './helpers/redis-diet.ts';

let live: LiveSite;
let browser: Browser;
const { keepDelayMs, keepCapMs } = TIMINGS;

describe('the Redis diet: the keeper', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('redis-diet-keeper', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('check 15: typing steadily keeps at least every cap; stopping keeps once, the delay later', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, AOIFE);
		const page = await openAdmin(context, site, '/admin/pages/contact');
		const { writes } = record(page);
		await focusIntro(page);
		const started = Date.now();
		let lastKey = started;
		const keys: number[] = [];
		while (Date.now() - started < 3 * keepCapMs) {
			await page.keyboard.type('x');
			keys.push((lastKey = Date.now()));
			await sleep(250);
		}
		const typed = writes.filter((w) => w.at <= lastKey);
		assert.ok(typed[0]!.at - started < 800, `the first change went at once (${typed[0]!.at - started} ms)`);
		assert.ok(typed.length >= 3 && typed.length <= 6, `${typed.length} keeps while typing (about one per cap, not one per change)`);
		const times = [...typed.map((w) => w.at), lastKey];
		for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! <= keepCapMs + 1000, `a gap of ${times[i]! - times[i - 1]!} ms while typing`);
		for (let i = 2; i < typed.length; i++) assert.ok(typed[i]!.at - typed[i - 1]!.at >= keepCapMs - 1000, `keeps ${typed[i]!.at - typed[i - 1]!.at} ms apart`);

		await sleep(keepDelayMs + 2000);
		const afterStop = writes.filter((w) => w.at > lastKey);
		assert.equal(afterStop.length, 1, 'one keep after stopping');
		// The delay after the last change, unless the cap from the first change since the last keep comes sooner.
		const firstUnsent = keys.find((k) => k > typed.at(-1)!.at)!;
		const due = Math.min(lastKey + keepDelayMs, firstUnsent + keepCapMs);
		const off = afterStop[0]!.at - due;
		assert.ok(off >= -300 && off < 1000, `the last keep went ${afterStop[0]!.at - lastKey} ms after the last change (${off} ms from when it was due)`);
		await eventually(async () => (await keepState(page)) === 'kept', 5000, 'Kept');
		await context.close();
	});

	test('check 16: the first change is written at once and takes the lock; a second person typing a second later is refused', async () => {
		const { site } = live;
		const contextB = await signedIn(browser, site, CIARAN);
		const b = await openAdmin(contextB, site, '/admin/pages/about');
		const bRec = record(b);
		await focusIntro(b);
		const contextA = await signedIn(browser, site, AOIFE);
		const a = await openAdmin(contextA, site, '/admin/pages/about');
		const aRec = record(a);
		await focusIntro(a);

		const typed = Date.now();
		await a.keyboard.type('A');
		const first = await eventually(() => aRec.writes[0], 2000, 'A\'s write');
		assert.ok(first.at - typed < 600, `A's first change went ${first.at - typed} ms after the key`);
		await eventually(() => first.status !== null, 5000, 'A\'s write answered');
		assert.equal(first.status, 200, 'A\'s write took the lock');

		await sleep(1000 - (Date.now() - typed));
		await b.keyboard.type('B');
		await eventually(async () => (await note(b, 'locked')) === 1, 5000, 'B: "aoife is editing"');
		await sleep(keepDelayMs + 1000);
		assert.equal(bRec.writes.filter((w) => w.status === 200).length, 0, 'nothing of B\'s was kept');
		for (const w of bRec.writes) assert.ok(w.status === 409 || w.status === null, `B's write answered ${w.status}`);
		const shown = await b.inputValue(INTRO);
		assert.match(shown, /A$/, `B shows A's change, not its own: ${JSON.stringify(shown.slice(-40))}, keep ${await keepState(b)}`);
		await contextA.close();
		await contextB.close();
	});

	test('check 17: closing the tab within the delay loses nothing: the pagehide keep lands, and the document shows the change', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, AOIFE);
		const page = await openAdmin(context, site, '/admin/pages/index');
		const { writes } = record(page);
		await focusIntro(page);
		await page.keyboard.type(' First.');
		await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');
		const before = writes.length;
		await page.keyboard.type(' Then closed at once.');
		const typed = Date.now();
		await page.close({ runBeforeUnload: true });
		assert.ok(Date.now() - typed < keepDelayMs, 'closed within the delay');
		assert.equal(writes.length, before, 'no timed keep went before the close (the pagehide keep is sent as the page goes)');
		const expected = /First\. Then closed at once\.$/;

		// Another person, with no copy of A's browser storage, sees the change from the server.
		const other = await signedIn(browser, site, CIARAN);
		await eventually(
			async () => {
				const b = await openAdmin(other, site, '/admin/pages/index');
				try {
					await b.click('.brow-main >> nth=0');
					await b.waitForSelector(INTRO);
					const value = await b.inputValue(INTRO);
					if (!expected.test(value)) console.log('[check 17] the other person sees', JSON.stringify(value.slice(-60)));
					return expected.test(value);
				} finally {
					await b.close();
				}
			},
			15_000,
			'the change on the server',
		);
		// And A, reopening.
		const again = await openAdmin(context, site, '/admin/pages/index');
		await again.click('.brow-main >> nth=0');
		await again.waitForSelector(INTRO);
		assert.match(await again.inputValue(INTRO), expected);
		await other.close();
		await context.close();
	});

	test('check 22: typing steadily straight after the first keep, before any poll says the lock is held, keeps on the delay, not once per change', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, AOIFE);
		const page = await openAdmin(context, site, '/admin/pages/services/print');
		const { writes } = record(page);
		await focusIntro(page);
		// No poll answers from here: only the write itself can tell the tab it holds the lock.
		await page.route('**/_caracms/status**', (route) => route.abort());
		const started = Date.now();
		let changes = 0;
		let lastKey = started;
		while (Date.now() - started < 3000) {
			await page.keyboard.type('y');
			changes += 1;
			lastKey = Date.now();
			await sleep(100);
		}
		await sleep(keepDelayMs + 1500);
		assert.ok(writes[0]!.at - started < 800, 'the first change went at once');
		assert.ok(changes >= 15, `${changes} changes typed`);
		assert.ok(writes.length <= 3, `${writes.length} keeps for ${changes} changes`);
		for (let i = 1; i < writes.length; i++) assert.ok(writes[i]!.at - writes[i - 1]!.at >= keepDelayMs - 300, `keeps ${writes[i]!.at - writes[i - 1]!.at} ms apart`);
		const last = writes.at(-1)!;
		assert.ok(last.at - lastKey >= keepDelayMs - 300, 'the last keep waited the delay');
		for (const w of writes) assert.equal(w.status, 200);
		await page.unroute('**/_caracms/status**');
		await context.close();
	});
});
