// The Redis diet, the poll's side (the spec's checks 9, 10 and 13's
// client side), in a real browser: a copy of the demo under `astro dev` in live mode on the
// in-memory GitHub, with the timings scaled down (helpers/redis-diet.ts).
//
//   node --test --experimental-strip-types test/redis-diet-poll.browser.test.ts
//
// Each test works on its own document.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { browserSkip } from './helpers/dev-site.ts';
import { AOIFE, CIARAN, eventually, keepState, openAdmin, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';
import { INTRO, TIMINGS, focusIntro, gaps, note, record, sleep } from './helpers/redis-diet.ts';

let live: LiveSite;
let browser: Browser;
const { pollMs, slowPollMs, idleSlowAfterMs } = TIMINGS;

describe('the Redis diet: idle tabs slow down', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('redis-diet-poll', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('check 9: a visible tab with no input polls at the slow interval and says so; a key press polls at once and it is back to the fast one', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, CIARAN);
		const page = await openAdmin(context, site, '/admin/pages/visit');
		const { polls } = record(page);
		await eventually(() => polls.some((p) => p.interval === pollMs), 5000, 'a fast poll, saying 1000');
		const slowAt = (await eventually(() => polls.find((p) => p.interval === slowPollMs), idleSlowAfterMs + 3 * pollMs, 'a poll saying the slow interval'))!.at;
		await eventually(() => polls.filter((p) => p.at >= slowAt).length >= 3, 3 * slowPollMs, 'two more slow polls');
		for (const gap of gaps(polls, slowAt).slice(0, 2)) assert.ok(gap > slowPollMs - 600 && gap < slowPollMs + 1500, `slow gap ${gap} ms`);
		for (const p of polls.filter((x) => x.at > slowAt)) assert.equal(p.interval, slowPollMs);

		const before = polls.length;
		const pressed = Date.now();
		await page.keyboard.press('Shift');
		const back = await eventually(() => polls[before], 1500, 'a poll at once after the key press');
		assert.ok(back.at - pressed < 1000, `polled ${back.at - pressed} ms after the key press`);
		assert.equal(back.interval, pollMs);
		assert.ok(back.input !== null && back.input < 1000, 'the poll says the tab was just used');
		await eventually(() => polls.length >= before + 3, 4 * pollMs, 'two more fast polls');
		for (const gap of gaps(polls, back.at).slice(0, 2)) assert.ok(gap < pollMs + 800, `fast gap ${gap} ms`);
		await context.close();
	});

	test('check 10: a slow tab whose poll shows another person holding its document is back to fast polls; that person only having it open is not enough', async () => {
		const { site } = live;
		const contextB = await signedIn(browser, site, CIARAN);
		const b = await openAdmin(contextB, site, '/admin/pages/work');
		const { polls, answers } = record(b);
		await eventually(() => polls.find((p) => p.interval === slowPollMs), idleSlowAfterMs + 3 * pollMs, 'B slows down');

		// A opens the page: B's answers show A there, and B stays slow.
		const contextA = await signedIn(browser, site, AOIFE);
		const a = await openAdmin(contextA, site, '/admin/pages/work');
		const present = (await eventually(
			() => answers.find((x) => x.body.presence.some((p) => p.file === 'content/pages/work.json' && p.people.some((who) => who.email === AOIFE))),
			2 * slowPollMs + 2000,
			'B\'s answer shows A on the page',
		))!.at;
		await eventually(() => polls.some((p) => p.at > present), slowPollMs + 2000, 'B\'s next poll');
		const next = polls.find((p) => p.at > present)!;
		const last = polls.filter((p) => p.at <= present).at(-1)!;
		assert.ok(next.at - last.at > slowPollMs - 600, `presence alone: still slow (${next.at - last.at} ms)`);
		assert.equal(next.interval, slowPollMs);

		// A types: the write takes the lock, and B's next answer shows it.
		await focusIntro(a);
		await a.keyboard.type('Aoife takes Work.');
		await eventually(async () => (await keepState(a)) === 'kept', 10_000, 'A: Kept');
		const locked = (await eventually(() => answers.find((x) => x.body.open?.lock?.person.email === AOIFE), 2 * slowPollMs + 2000, 'B\'s answer shows A\'s lock'))!.at;
		await eventually(async () => (await note(b, 'locked')) === 1, 3000, 'B: "aoife is editing"');
		await eventually(() => polls.filter((p) => p.at > locked).length >= 3, 5 * pollMs, 'B polls fast again');
		const after = polls.filter((p) => p.at > locked);
		assert.ok(after[0]!.at - locked < pollMs + 800, `B's first poll after the lock came ${after[0]!.at - locked} ms later`);
		for (const p of after) assert.equal(p.interval, pollMs, 'B says 1000');
		for (const gap of gaps(polls, after[0]!.at).slice(0, 2)) assert.ok(gap < pollMs + 800, `fast gap ${gap} ms`);
		await contextA.close();
		await contextB.close();
	});

	test('check 13 (client side): a long-idle tab with an unsent autosave still holds its lock and still shows on the document to a second editor', async () => {
		const { site } = live;
		const file = 'content/pages/about/team.json';
		const contextA = await signedIn(browser, site, AOIFE);
		const a = await openAdmin(contextA, site, '/admin/pages/about/team');
		const aRec = record(a);
		const contextB = await signedIn(browser, site, CIARAN);
		const b = await openAdmin(contextB, site, '/admin/pages/about/team');
		const { answers } = record(b);
		await focusIntro(a);
		await a.keyboard.type(' Idle after this.');
		await eventually(async () => (await keepState(a)) === 'kept', 10_000, 'A: Kept');
		const idleFrom = Date.now();
		// Idle for twice the lock's lapse and four times its idle rule; A slows down meanwhile.
		await sleep(2 * TIMINGS.lockLapseMs + 1000);
		assert.ok(aRec.polls.some((p) => p.at > idleFrom && p.interval === slowPollMs), 'A slowed down');
		const late = answers.filter((x) => x.at > idleFrom + TIMINGS.lockLapseMs);
		assert.ok(late.length >= 3, `B polled ${late.length} times in the last stretch`);
		for (const x of late) {
			assert.equal(x.body.open?.lock?.person.email, AOIFE, 'A still holds the lock');
			assert.ok(
				x.body.presence.some((p) => p.file === file && p.people.some((who) => who.email === AOIFE)),
				'A still shows on the document',
			);
		}
		assert.equal(await note(b, 'locked'), 1, 'B still sees "aoife is editing"');
		assert.equal(await b.isDisabled(INTRO).catch(() => true), true);
		await contextA.close();
		await contextB.close();
	});
});
