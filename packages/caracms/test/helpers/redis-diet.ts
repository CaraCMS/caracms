// The Redis diet's browser tests (checks 9, 10, 13, 15,
// 16, 17 and 22): shortened timings, and what a page sent and when.
import type { Page } from 'playwright-core';
import { ENDPOINTS, type StatusResponse } from '../../src/editor/types.ts';

/**
 * The client's new timings, scaled down: 1 s polls, slow after 3 s idle to 6 s polls; a
 * keep 1.5 s after the last change, at most 5 s after the first unsent one. Nothing is
 * committed by the sweep while a test runs (an unsent autosave holds its lock), and the
 * lock rules are short enough that check 13's idle tab outlives them.
 */
export const TIMINGS = {
	pollMs: 1000,
	idleSlowAfterMs: 3000,
	slowPollMs: 6000,
	keepDelayMs: 1500,
	keepCapMs: 5000,
	sweepTickMs: 500,
	sweepIdleMs: 120_000,
	sweepCapMs: 240_000,
	lockIdleMs: 4000,
	lockLapseMs: 8000,
	beatEveryMs: 2000,
	statusCacheMs: 3000,
	mainCheckMs: 1000,
	historyMs: 500,
	deploymentReadMs: 500,
};

export const INTRO = '[data-pane-level="block"] [data-ff="intro"] textarea';
const SHOWN = '.side-level:not([hidden])';
export const note = (page: Page, kind: string) => page.locator(`${SHOWN} [data-note="${kind}"]`).count();

/** Open the hero (the first block) and put the caret at the end of its intro. */
export async function focusIntro(page: Page) {
	if (!(await page.$(INTRO))) await page.click('.brow-main >> nth=0');
	await page.waitForSelector(INTRO);
	await page.focus(INTRO);
	// The very end (End alone stops at the end of the first line).
	await page.$eval(INTRO, (el) => {
		const t = el as HTMLTextAreaElement;
		t.setSelectionRange(t.value.length, t.value.length);
	});
}

export interface Poll {
	at: number;
	interval: number | null;
	input: number | null;
}
export interface Answer {
	at: number;
	body: StatusResponse;
}
export interface Write {
	at: number;
	keepalive: boolean;
	status: number | null;
}

/** Every status poll the page sends (with its `interval`), every answer, and every write with its answer. */
export function record(page: Page) {
	const polls: Poll[] = [];
	const answers: Answer[] = [];
	const writes: Write[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.pathname === ENDPOINTS.status) {
			const n = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : null);
			polls.push({ at: Date.now(), interval: n('interval'), input: n('input') });
		} else if (url.pathname === ENDPOINTS.write && request.method() === 'POST') {
			const write: Write = { at: Date.now(), keepalive: false, status: null };
			writes.push(write);
			request
				.response()
				.then((response) => {
					if (response) write.status = response.status();
				})
				.catch(() => {});
		}
	});
	page.on('response', (response) => {
		if (new URL(response.url()).pathname !== ENDPOINTS.status || response.status() !== 200) return;
		const at = Date.now();
		response
			.json()
			.then((body: StatusResponse) => answers.push({ at, body }))
			.catch(() => {});
	});
	return { polls, answers, writes };
}

/** The gaps between successive polls sent from `from` on. */
export const gaps = (polls: readonly Poll[], from = 0) => {
	const list = polls.filter((p) => p.at >= from);
	return list.slice(1).map((p, i) => p.at - list[i]!.at);
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
