// Publish in the editor (M4 Phase 4 → Verify 3), in a real browser, on the in-memory
// GitHub and the Redis stand-in (helpers/live-site.ts; Decision 2), never a real repo.
//
// The list names Home and its editor, an uncommitted change included. Publish goes to
// publishing, then to live once the running commit (`CARACMS_RUNNING_COMMIT`, read on
// every status) is the publish commit, and to failed with a failed deployment pushed
// into the in-memory GitHub. Try again calls Railway's API once (this process's fetch,
// stubbed for Railway's address only); with no redeployer there's no Try again, and the
// line that a developer can redeploy it shows, naming no host (runs-anywhere Decision 11).
//
//   node --test --experimental-strip-types test/live-publish.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { StatusResponse } from '../src/editor/types.ts';
import { browserSkip } from './helpers/dev-site.ts';
import { AOIFE, cookieFor, eventually, keepState, openAdmin, resetLive, runtime, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

// The sweep stays out of the way, so Home's change is still an uncommitted autosave when the list shows it.
const TIMINGS = { sweepIdleMs: 120_000, sweepCapMs: 300_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 1000 };
const NOT_A_COMMIT = '0'.repeat(40);
const RAILWAY = 'https://backboard.railway.com/';

let live: LiveSite;
let browser: Browser;
const realFetch = globalThis.fetch;
let railwayCalls = 0;

const INTRO = '[data-pane-level="block"] [data-ff="intro"] textarea';
const pubState = (page: Page) => page.getAttribute('.bar [data-slot="publish"]', 'data-pub');

async function editIntro(page: Page, text: string) {
	if (!(await page.$(INTRO))) await page.click('.brow-main >> nth=0');
	await page.waitForSelector(INTRO);
	await page.fill(INTRO, text);
	await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');
}

async function status(): Promise<StatusResponse> {
	const c = cookieFor(live.site, AOIFE);
	return (await realFetch(`${live.site.origin}/_caracms/status`, { headers: { cookie: `${c.name}=${c.value}` } })).json() as Promise<StatusResponse>;
}

async function failDeployment(sha: string) {
	const rt = await runtime();
	const at = new Date().toISOString();
	rt.backend.deployments.push({ id: rt.backend.deployments.length + 1, sha, environment: 'caracms-demo / production', createdAt: at, statuses: [{ state: 'failure', createdAt: at }] });
}

describe('Publish, live', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('live-publish', {
			CARACMS_TIMINGS: JSON.stringify(TIMINGS),
			CARACMS_RUNNING_COMMIT: NOT_A_COMMIT,
			CARACMS_RAILWAY_TOKEN: 'a-test-project-token',
			RAILWAY_SERVICE_ID: 'service-1',
			RAILWAY_ENVIRONMENT_ID: 'environment-1',
		});
		browser = await chromium.launch();
		// Railway's API is stubbed here, in the server's own process; everything else goes through.
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url.startsWith(RAILWAY)) {
				railwayCalls += 1;
				return new Response(JSON.stringify({ data: { serviceInstanceRedeploy: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return realFetch(input, init);
		}) as typeof fetch;
	});
	after(async () => {
		globalThis.fetch = realFetch;
		await browser?.close();
		await live?.close();
	});

	test('Verify 3: the list is the summary; publishing, then live; failed, with Try again calling Railway once; no token, no Try again', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, AOIFE);
		const page = await openAdmin(context, site);
		assert.equal(await pubState(page), 'nothing', 'nothing waiting at first');

		await editIntro(page, 'Ready to go live.');
		await eventually(async () => (await pubState(page)) === 'waiting', 8000, '"1 waiting"');
		const waiting = (await status()).waiting;
		assert.deepEqual(
			waiting.map((w) => [w.file, w.title, w.uncommitted, w.editors.map((e) => e.person.email)]),
			[['content/pages/index.json', 'Home', true, [AOIFE]]],
			'Home, by Aoife, still an uncommitted autosave',
		);

		await page.click('.bar [data-slot="publish"]');
		const pop = page.locator('[data-pop="waiting"]');
		await pop.waitFor();
		const item = pop.locator('[data-waiting="content/pages/index.json"]');
		assert.match((await item.textContent())!, /Home/);
		assert.match((await item.textContent())!, /aoife · Today \d\d:\d\d/, 'who and when, in the site\'s zone');
		assert.doesNotMatch((await item.textContent())!, /Editing now/, 'only Aoife, in this very tab: nobody else is in it');
		assert.match((await pop.textContent())!, /1 change waiting/);

		await pop.locator('[data-act="publish"]').click();
		await eventually(async () => (await pubState(page)) === 'publishing', 8000, 'Publishing…');
		await eventually(async () => /Publishing/.test((await page.locator('[data-pop="waiting"] h2').textContent()) ?? ''), 8000, 'the popover says Publishing');
		const rt = await runtime();
		const first = (await rt.git.lastPublish())!;
		assert.deepEqual(first.titles, ['Home']);
		assert.match(rt.backend.file('main', 'starter/content/pages/index.json')!, /Ready to go live\./, 'main has it, uncommitted change included');

		// The deploy finishes: the running commit is the publish commit.
		process.env.CARACMS_RUNNING_COMMIT = first.commit;
		await eventually(async () => (await pubState(page)) === 'live', 15_000, 'Live');
		assert.match((await page.textContent('.bar [data-slot="publish"]'))!, /Live · \d\d:\d\d/);
		await eventually(async () => /Live/.test((await page.locator('[data-pop="waiting"] h2').textContent()) ?? ''), 8000, 'the popover says Live');

		// History: who, when, which documents, and live; the zone named once.
		await page.click('[data-pop="waiting"] [data-act="history"]');
		const history = page.locator('[data-pop="history"]');
		await history.waitFor();
		await eventually(async () => (await history.locator(`[data-history="${first.commit}"]`).count()) === 1, 8000, 'the publish in history');
		const row = (await history.locator(`[data-history="${first.commit}"]`).textContent())!;
		assert.match(row, /Today \d\d:\d\d/);
		assert.match(row, /aoife/);
		assert.match(row, /Home/);
		assert.match(row, /Live/);
		assert.match((await history.locator('.pop-h .sub').textContent())!, /Europe\/Dublin/);
		await page.keyboard.press('Escape');

		// A second publish whose deployment fails.
		await editIntro(page, 'This one fails to deploy.');
		await page.click('.bar [data-slot="publish"]');
		await page.locator('[data-pop="waiting"] [data-act="publish"]').click();
		await eventually(async () => (await pubState(page)) === 'publishing', 8000, 'Publishing… again');
		const second = (await rt.git.lastPublish())!;
		assert.notEqual(second.commit, first.commit);
		await failDeployment(second.commit);
		await eventually(async () => (await pubState(page)) === 'failed', 15_000, 'Publish failed');
		const failed = page.locator('[data-pop="waiting"]');
		await eventually(async () => (await failed.locator('[data-act="try-again"]').count()) === 1, 8000, 'Try again');
		assert.match((await failed.textContent())!, /The publish didn't go live/);
		assert.equal(railwayCalls, 0);
		await failed.locator('[data-act="try-again"]').click();
		await eventually(() => railwayCalls === 1, 8000, 'Railway called');
		await new Promise((r) => setTimeout(r, 1000));
		assert.equal(railwayCalls, 1, 'once');
		await page.keyboard.press('Escape');

		// With no redeployer: the failed state has no Try again, and says a developer can redeploy it.
		delete process.env.CARACMS_RAILWAY_TOKEN;
		process.env.CARACMS_RUNNING_COMMIT = NOT_A_COMMIT;
		await resetLive();
		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]');
		await editIntro(page, 'Published with no token.');
		await page.click('.bar [data-slot="publish"]');
		await page.locator('[data-pop="waiting"] [data-act="publish"]').click();
		await eventually(async () => (await pubState(page)) === 'publishing', 8000, 'Publishing… (no token)');
		const third = (await (await runtime()).git.lastPublish())!;
		await failDeployment(third.commit);
		await eventually(async () => (await pubState(page)) === 'failed', 15_000, 'Publish failed (no token)');
		const noToken = page.locator('[data-pop="waiting"]');
		await eventually(async () => (await noToken.locator('[data-note="no-token"]').count()) === 1, 8000, 'the redeploy line');
		assert.match((await noToken.textContent())!, /A developer can redeploy it/);
		assert.doesNotMatch((await noToken.textContent())!, /railway/i);
		assert.equal(await noToken.locator('[data-act="try-again"]').count(), 0, 'no Try again');
		assert.equal(railwayCalls, 1, 'still only the one call');
		await context.close();
	});

	test('a failed Publish (the server answers 502): the popover says it didn\'t publish, nothing reads as published, and Publish works when pressed again', async () => {
		const { site } = live;
		const context = await signedIn(browser, site, AOIFE);
		const page = await openAdmin(context, site, '/admin/pages/about');
		await editIntro(page, 'Publish this, eventually.');
		await eventually(async () => (await pubState(page)) === 'waiting', 8000, '"1 waiting"');
		const rt = await runtime();
		const before = rt.backend.refs.get('main');
		// GitHub refuses the ref move outright: git.publish throws, and the route answers 502.
		rt.backend.beforeRequest = (endpoint) => {
			if (endpoint === 'graphql updateRefs') throw new Error('GitHub is down');
		};
		await page.click('.bar [data-slot="publish"]');
		const pop = page.locator('[data-pop="waiting"]');
		await pop.waitFor();
		await pop.locator('[data-act="publish"]').click();
		await eventually(async () => (await pop.locator('[data-note="publish-failed"]').count()) === 1, 15_000, 'the failure, said in the popover');
		assert.match((await pop.locator('[data-note="publish-failed"]').textContent())!, /It didn't publish/);
		assert.equal(await pubState(page), 'waiting', 'still waiting: never shown as published');
		assert.equal(rt.backend.refs.get('main'), before, 'main didn\'t move');
		assert.equal(await pop.locator('[data-act="publish"]').isDisabled(), false, 'Publish can be pressed again');

		rt.backend.beforeRequest = null;
		await pop.locator('[data-act="publish"]').click();
		await eventually(async () => (await pubState(page)) === 'publishing' || (await pubState(page)) === 'live', 15_000, 'published the second time');
		assert.notEqual(rt.backend.refs.get('main'), before);
		await context.close();
	});
});
