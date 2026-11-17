// M4 Phase 5 → Verify 2–4: chrome.visual.test.ts's checks (helpers/chrome-scans.ts) over
// M4's places, on the demo in live mode (helpers/live-site.ts: the in-memory GitHub and
// the Redis stand-in), driven into the mockup's M4 states by mockup-diff-m4.ts. The mode
// and the live runtime are per process, so each live file runs one site at a time, and
// the visual pass runs the files side by side. This one: side rails, motion, the veil
// and focus, on the navy accent (contrast with each is chrome-live-contrast.visual.test.ts).
//
//   node --test --experimental-strip-types test/chrome-live.visual.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { ACCENTS, frameScan, layerMoving, moving, pressLook, railScan, settle, withAccent } from './helpers/chrome-scans.ts';
import { browserSkip } from './helpers/dev-site.ts';
import { startLiveSite, type LiveSite } from './helpers/live-site.ts';
import { STATES_AP_LIVE } from './mockup-diff-ap.ts';
import { LIVE_ENV, liveState, openLiveState } from './mockup-diff-m4.ts';

let browser: Browser;

describe('the chrome in live mode', { skip: browserSkip }, () => {
	// One site for every test here (each state starts from a fresh runtime).
	let live: LiveSite | null = null;
	before(async () => {
		browser = await chromium.launch();
		live = await startLiveSite('chrome-live-navy', LIVE_ENV, { edit: withAccent(ACCENTS.navy) });
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('Verify 3 (M4): no side rails on locked, waiting, noticed or failed rows', async () => {
		const site = live!.site;
		const found: string[] = [];
		// M5b's live states too: Publish's alt text rows and the bar's dot, and Add alt text on a held page.
		// Arrange pages (check 20): its live review and the Apply refused by a lock.
		for (const id of ['locked', 'locked-block', 'elsewhere', 'waiting', 'merge', 'not-kept', 'published-over', 'failed', 'failed-no-token', 'history', 'live-offline', 'signed-out-edit', 'signed-out-removed', 'publish-alt', 'fix-alt-locked', 'ap-live-review', 'ap-live-lock']) {
			const { page, close } = await openLiveState(STATES_AP_LIVE.find((s) => s.id === id) ?? liveState(id), { browser, site });
			try {
				await settle(page);
				for (const f of await page.evaluate(railScan, '#app *')) found.push(`${id}: ${f}`);
			} finally {
				await close();
			}
		}
		for (const id of ['si-email', 'si-sent', 'si-confirm', 'narrow-signed']) {
			const { page, close } = await openLiveState(liveState(id), { browser, site });
			try {
				for (const f of await page.evaluate(railScan, 'body *')) found.push(`${id}: ${f}`);
			} finally {
				await close();
			}
		}
		assert.deepEqual(found, []);
	});

	test('Verify 4 (M4): under prefers-reduced-motion the veil and the running bar have no animation or transition (and without it, they do)', async () => {
		const site = live!.site;
		const veilMotion = () => {
			const doc = document.querySelector<HTMLIFrameElement>('#stage .frame.on iframe')!.contentDocument!;
			const veil = doc.querySelector('#cms-overlays .cms-veil');
			if (!veil) return null;
			const cs = doc.defaultView!.getComputedStyle(veil);
			return { transition: cs.transitionProperty === 'none' ? 0 : parseFloat(cs.transitionDuration) * 1000, animation: cs.animationName };
		};
		const barMotion = () => {
			const bar = document.querySelector('.pub .prog');
			if (!bar) return null;
			const cs = getComputedStyle(bar, '::after');
			return { animation: cs.animationName, ms: parseFloat(cs.animationDuration) * 1000 };
		};
		const found: string[] = [];
		for (const id of ['locked', 'publishing', 'waiting', 'account', 'signed-out-edit', 'publish-alt']) {
			const { page, close } = await openLiveState(liveState(id), { browser, site, reducedMotion: 'reduce' });
			try {
				for (const f of await page.evaluate(moving)) found.push(`${id}: ${f}`);
				for (const f of await page.evaluate(layerMoving).catch(() => [] as string[])) found.push(`${id}: ${f}`);
				if (id === 'locked') {
					const veil = await page.evaluate(veilMotion);
					assert.ok(veil, 'the veil is drawn');
					assert.equal(veil.transition, 0, 'the veil has no transition');
					assert.equal(veil.animation, 'none');
				}
				if (id === 'publishing') {
					const bar = await page.evaluate(barMotion);
					assert.ok(bar, 'the running bar is drawn');
					assert.equal(bar.animation, 'none', 'the running bar stands still');
				}
			} finally {
				await close();
			}
		}
		assert.deepEqual(found, []);

		// Without the preference: the veil lifts over --dur-slow, and the bar runs (so the checks can see motion).
		const locked = await openLiveState(liveState('locked'), { browser, site, reducedMotion: 'no-preference' });
		try {
			const veil = await locked.page.evaluate(veilMotion);
			assert.equal(veil?.transition, 320, 'the veil lifts over --dur-slow');
		} finally {
			await locked.close();
		}
		const publishing = await openLiveState(liveState('publishing'), { browser, site, reducedMotion: 'no-preference' });
		try {
			const bar = await publishing.page.evaluate(barMotion);
			assert.equal(bar?.animation, 'prog', 'the running bar runs');
			assert.ok((bar?.ms ?? 0) > 0);
		} finally {
			await publishing.close();
		}
	});

	test('the veil lifts: when the lock goes it fades out (`.out`) before it is removed', async () => {
		const site = live!.site;
		// The lapse, caught as it happens: watch the veil's class from the page.
		const state = liveState('locked');
		const { page, ctx, close } = await openLiveState(state, { browser, site, reducedMotion: 'no-preference' });
		try {
			await page.evaluate(() => {
				const doc = document.querySelector<HTMLIFrameElement>('#stage .frame.on iframe')!.contentDocument!;
				(window as unknown as { lifted: boolean }).lifted = false;
				new MutationObserver(() => {
					if (doc.querySelector('#cms-overlays .cms-veil.out')) (window as unknown as { lifted: boolean }).lifted = true;
				}).observe(doc.documentElement, { subtree: true, attributes: true, childList: true });
			});
			// Closing Aoife's tab releases her lock.
			const about = ctx.extra.flatMap((c) => c.pages()).find((p) => /pages\/about/.test(p.url()));
			assert.ok(about, "Aoife's tab on About");
			await about.close({ runBeforeUnload: true });
			const end = Date.now() + 45_000;
			while (Date.now() < end && (await page.locator('[data-note="locked"]').count()) > 0) await page.waitForTimeout(250);
			await page.waitForTimeout(600);
			assert.equal(await page.evaluate(() => (window as unknown as { lifted: boolean }).lifted), true, 'the veil faded out');
			assert.equal(await page.frameLocator('#stage .frame.on iframe').locator('#cms-overlays .cms-veil').count(), 0, 'and is gone');
		} finally {
			await close();
		}
	});

	test('check 9 (live): the frame is on the failures and nothing calm - locks, draft-kept merges, Publish with drafts, and the sign-in pages’ notices', async () => {
		const site = live!.site;
		const found: string[] = [];
		const seen: Record<string, number> = {};
		const walk = async (id: string, roots: string) => {
			const { page, close } = await openLiveState(liveState(id), { browser, site });
			try {
				await settle(page);
				const r = await page.evaluate(frameScan, roots);
				for (const f of r.failures) found.push(`${id}: ${f}`);
				for (const [k, n] of Object.entries(r.seen)) seen[k] = (seen[k] ?? 0) + n;
			} finally {
				await close();
			}
		};
		for (const id of ['locked', 'locked-block', 'elsewhere', 'waiting', 'merge', 'not-kept', 'published-over', 'failed', 'failed-no-token', 'history', 'live-offline', 'signed-out-edit', 'signed-out-removed']) await walk(id, '#app, #pops, #toast-root, #modal-root');
		for (const id of ['si-email', 'si-sent', 'si-confirm', 'si-dead', 'si-backup', 'si-invalid', 'narrow-signed']) await walk(id, 'body');
		assert.deepEqual(found, []);
		for (const kind of ['.note.warn', '.note.danger', '.note.lock', 'the draft-kept notice', '.pub.fail', 'the bar’s Publish', 'a block or document row']) assert.ok(seen[kind], `the scan met ${kind} (${JSON.stringify(seen)})`);
	});

	test("check 7 (live): sign-in's main button sinks into its accent edge on :active, and has no edge when disabled", async () => {
		const { page, close } = await openLiveState(liveState('si-email'), { browser, site: live!.site });
		try {
			const button = page.locator('.btn.accent').first();
			await button.waitFor();
			const { rest, down, up } = await pressLook(page, button);
			assert.ok(rest.edge && rest.edge.y === 2 && rest.edge.x === 0, `an edge at rest (${JSON.stringify(rest.edge)})`);
			assert.equal(rest.translate, 'none');
			assert.equal(down.translate, '0px 2px', 'it sinks by the press depth');
			assert.deepEqual(down.edge && [down.edge.x, down.edge.y], [0, 0], 'the edge is gone while pressed');
			assert.equal(down.edge?.colour, rest.edge.colour, 'the pressed edge is the same accent edge');
			assert.equal(up.translate, 'none');
			assert.deepEqual(up.edge, rest.edge, 'back at rest on release');
			assert.ok([rest, down].every((l) => l.transition.split(',').every((t) => parseFloat(t) === 0)), 'under reduced motion the change is instant');
			await button.evaluate((el) => ((el as HTMLButtonElement).disabled = true));
			const gone = await pressLook(page, button);
			assert.equal(gone.rest.edge, null, 'a disabled button has no edge');
			assert.equal(gone.down.translate, 'none');
		} finally {
			await close();
		}
	});

	test('focus shows on the sign-in pages: a 2px ring on every stop (a text box rings itself)', async () => {
		const site = live!.site;
		const failures: string[] = [];
		let stops = 0;
		for (const id of ['si-email', 'si-sent', 'si-confirm', 'si-dead', 'si-backup', 'narrow-signed', 'si-email-320']) {
			const { page, close } = await openLiveState(liveState(id), { browser, site });
			try {
				await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
				for (let i = 0; i < 12; i++) {
					await page.keyboard.press('Tab');
					const r = await page.evaluate(() => {
						const el = document.activeElement as HTMLElement | null;
						if (!el || el === document.body) return null;
						const probe = document.createElement('i');
						probe.style.color = 'var(--focus)';
						document.body.append(probe);
						const want = getComputedStyle(probe).color;
						probe.style.color = 'var(--select)';
						const select = getComputedStyle(probe).color;
						probe.remove();
						const cs = getComputedStyle(el);
						const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && cs.outlineColor === want;
						const box = el.matches('input') && cs.borderColor === select && cs.boxShadow !== 'none';
						return { id: `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join('')} “${(el.textContent || '').trim().slice(0, 24)}”`, ok: ring || box, detail: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} (want ${want})` };
					});
					if (!r) continue;
					stops += 1;
					if (!r.ok) failures.push(`${id}: ${r.id}: ${r.detail}`);
				}
			} finally {
				await close();
			}
		}
		assert.ok(stops > 20, `enough focus stops (${stops})`);
		assert.deepEqual(failures, []);
	});
});
