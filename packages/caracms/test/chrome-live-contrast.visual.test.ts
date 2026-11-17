// M4 Phase 5 → Verify 2–4: chrome.visual.test.ts's checks (helpers/chrome-scans.ts) over
// M4's places, on the demo in live mode (helpers/live-site.ts: the in-memory GitHub and
// the Redis stand-in), driven into the mockup's M4 states by mockup-diff-m4.ts. The mode
// and the live runtime are per process, so each live file runs one site at a time, and
// the visual pass runs the files side by side. This one: contrast with each sample
// accent (the other checks are chrome-live.visual.test.ts).
//
//   node --test --experimental-strip-types test/chrome-live-contrast.visual.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { ACCENTS, contrastScan, park, settle, withAccent, type Accent } from './helpers/chrome-scans.ts';
import { browserSkip } from './helpers/dev-site.ts';
import { startLiveSite, type LiveSite } from './helpers/live-site.ts';
import { LIVE_ENV, liveState, openLiveState } from './mockup-diff-m4.ts';
import { STATES_AP_LIVE } from './mockup-diff-ap.ts';

let browser: Browser;

/** The live states the contrast check walks, and what in each it reads. */
const EDITOR_ROOTS = '#side, #bar, #pops, #toast-root, #modal-root';
const LIVE_CONTRAST: { id: string; roots: string }[] = [
	// The bar's waiting count and Publish, the offline note's countdown and Try now.
	{ id: 'live-kept', roots: EDITOR_ROOTS },
	{ id: 'live-offline', roots: EDITOR_ROOTS },
	// The popovers: waiting (the final Publish button on the accent), nothing, publishing, live, failed, history, the account.
	{ id: 'waiting', roots: EDITOR_ROOTS },
	{ id: 'nothing', roots: EDITOR_ROOTS },
	{ id: 'publishing', roots: EDITOR_ROOTS },
	{ id: 'live', roots: EDITOR_ROOTS },
	{ id: 'failed', roots: EDITOR_ROOTS },
	{ id: 'failed-no-token', roots: EDITOR_ROOTS },
	{ id: 'history', roots: EDITOR_ROOTS },
	{ id: 'account', roots: EDITOR_ROOTS },
	// Locks and notices, the signed-out modal.
	{ id: 'locked', roots: EDITOR_ROOTS },
	{ id: 'elsewhere', roots: EDITOR_ROOTS },
	{ id: 'merge', roots: EDITOR_ROOTS },
	{ id: 'published-over', roots: EDITOR_ROOTS },
	{ id: 'not-kept', roots: EDITOR_ROOTS },
	{ id: 'signed-out-edit', roots: EDITOR_ROOTS },
	{ id: 'signed-out-removed', roots: EDITOR_ROOTS },
	// M5b: Publish's summary with images that have no alt text (Add alt text, the bar's dot), and Add alt text on a held page.
	{ id: 'publish-alt', roots: EDITOR_ROOTS },
	{ id: 'fix-alt-locked', roots: EDITOR_ROOTS },
	// Sign-in, its main button on the accent, at 320, 375 and 1280 as well as 1440.
	{ id: 'si-email', roots: 'body' },
	{ id: 'si-signedout', roots: 'body' },
	{ id: 'si-invalid', roots: 'body' },
	{ id: 'si-sent', roots: 'body' },
	{ id: 'si-confirm', roots: 'body' },
	{ id: 'si-switch', roots: 'body' },
	{ id: 'si-dead', roots: 'body' },
	{ id: 'si-backup', roots: 'body' },
	{ id: 'narrow-signed', roots: 'body' },
	{ id: 'si-email-320', roots: 'body' },
	{ id: 'si-email-375', roots: 'body' },
	{ id: 'si-email-1280', roots: 'body' },
	{ id: 'si-sent-320', roots: 'body' },
	// Arrange pages (check 20): the review with its tick, and the Apply refused by someone else's lock.
	{ id: 'ap-live-review', roots: EDITOR_ROOTS },
	{ id: 'ap-live-lock', roots: EDITOR_ROOTS },
];
const stateOf = (id: string) => STATES_AP_LIVE.find((s) => s.id === id) ?? liveState(id);


describe('the chrome in live mode', { skip: browserSkip }, () => {
	let live: LiveSite | null = null;
	const startLive = async (accent: Accent) => {
		await live?.close();
		live = await startLiveSite(`chrome-live-${accent}`, LIVE_ENV, { edit: withAccent(ACCENTS[accent]) });
		return live.site;
	};
	before(async () => {
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test("Verify 2 (M4): contrast with each sample accent over the waiting count, Publish, the popovers, the notes and sign-in", async (t) => {
		const failures: string[] = [];
		let checked = 0;
		let accentButtons = 0;
		let lowestAccent: { ratio: number; what: string } | null = null;
		for (const accent of Object.keys(ACCENTS) as Accent[]) {
			const site = await startLive(accent);
			const lowest: Record<string, { ratio: number; what: string }> = {};
			for (const { id, roots } of LIVE_CONTRAST) {
				const { page, close } = await openLiveState(stateOf(id), { browser, site });
				try {
					if (roots !== 'body') await park(page);
					await settle(page);
					const results = await page.evaluate(contrastScan, roots);
					checked += results.length;
					// The accent's buttons, and Publish's green (the editor restyle, Decision 9 (c)): .btn.accent, the branded
					// .btn.ink (Decision 12) and .btn.publish (Decision 3), on the button or on its parent's line.
					for (const r of results.filter((x) => /\bbtn(\.[\w-]+)*\.(accent|ink|publish)\b/.test(x.what))) {
						accentButtons += 1;
						if (!lowestAccent || r.ratio < lowestAccent.ratio) lowestAccent = { ratio: r.ratio, what: `${r.what} (${id})` };
					}
					for (const r of results) {
						if (r.ratio < r.need) failures.push(`${accent}, ${id}: ${r.kind} ${r.what} is ${r.ratio}:1 (needs ${r.need}:1)`);
						if (!lowest[r.kind] || r.ratio < lowest[r.kind]!.ratio) lowest[r.kind] = { ratio: r.ratio, what: `${r.what} (${id})` };
					}
				} finally {
					await close();
				}
			}
			for (const [kind, low] of Object.entries(lowest)) t.diagnostic(`${accent}: lowest ${kind} ${low.ratio}:1, ${low.what}`);
			if (lowestAccent) t.diagnostic(`${accent}: lowest text on an accent button ${lowestAccent.ratio}:1, ${lowestAccent.what}`);
			lowestAccent = null;
		}
		assert.ok(checked > 1000, `enough of live mode's chrome was checked (${checked})`);
		assert.ok(accentButtons >= 2 * 12, `the accent's buttons were checked (${accentButtons})`);
		assert.deepEqual(failures, []);
	});

});
