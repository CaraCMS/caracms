// The GitHub access note in the editor (runs-anywhere Decision 5; acceptance checks 5–7, the
// editor's half), in a real browser on the in-memory GitHub (helpers/live-site.ts). The note
// shows for everyone, on every level, while GitHub's answers say the site's access is wrong,
// and the sentence is the server's. The status response is rewritten on its way to the page
// (`githubAccess`), so each variant shows without a real token; the server's own sentences are
// github-access.test.ts's.
//
//   node --test --experimental-strip-types test/github-access-note.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { StatusResponse } from '../src/editor/types.ts';
import { browserSkip } from './helpers/dev-site.ts';
import { COMMIT_TROUBLE_MESSAGE } from '../src/live/editor.ts';
import { AOIFE, eventually, keepState, openAdmin, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

// A fast poll, so the note follows the stub within a second or two.
const TIMINGS = { sweepIdleMs: 120_000, sweepCapMs: 300_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 500 };

type Access = StatusResponse['githubAccess'];
const REFUSED: NonNullable<Access> = {
	kind: 'refused',
	title: 'GitHub refused this site',
	message: "GitHub refused this site's GitHub token (CARACMS_GITHUB_TOKEN): it may have expired or been revoked. Changes can't be saved to GitHub until a developer makes a new fine-grained token and sets it.",
};
const PERMISSION: NonNullable<Access> = {
	kind: 'permission',
	title: 'GitHub refused a change',
	message: 'GitHub refused a change because this site\'s GitHub token (CARACMS_GITHUB_TOKEN) lacks the "Contents: Read and write" permission. A developer can add it in the token\'s settings.',
};
const EXPIRING: NonNullable<Access> = {
	kind: 'expiring',
	title: "This site's GitHub token expires soon",
	message: "This site's GitHub token (CARACMS_GITHUB_TOKEN) expires on 3 November 2026. After that, changes can't be saved to GitHub: a developer can regenerate it, or make a new one, and set it before then.",
};

let live: LiveSite;
let browser: Browser;
/** What the stubbed status response says about GitHub access. */
let access: Access = null;
/** …and about draft commits failing (caracms-cloud adversarial review, finding 4). */
let trouble: StatusResponse['commitTrouble'] = null;

const NOTE = '[data-note="github-access"]';

/** Every status response goes through, with `githubAccess` replaced by the current stub. */
async function stubStatus(page: Page) {
	await page.route(/\/_caracms\/status(\?|$)/, async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as StatusResponse;
		await route.fulfill({ response, json: { ...body, githubAccess: access, commitTrouble: trouble } });
	});
}

describe('the GitHub access note, live', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('github-access-note', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	/** A fresh tab whose status polls say `variant` about GitHub access (the page's own first status says nothing). */
	async function openWith(variant: Access, failing: StatusResponse['commitTrouble'] = null): Promise<Page> {
		access = variant;
		trouble = failing;
		const page = await openAdmin(await signedIn(browser, live.site, AOIFE), live.site);
		await stubStatus(page);
		return page;
	}

	test('no note when githubAccess is null, polls and all', async () => {
		const page = await openWith(null);
		await page.waitForTimeout(1500); // a few polls go by
		assert.equal(await page.locator(NOTE).count(), 0);
		await page.close();
	});

	for (const variant of [REFUSED, PERMISSION, EXPIRING]) {
		test(`${variant.kind}: ${variant.kind === 'expiring' ? 'a warning' : 'a danger alert'}, with the server's title and sentence`, async () => {
			const page = await openWith(variant);
			await eventually(async () => (await page.locator(NOTE).count()) > 0, 10_000, `the ${variant.kind} note`);
			// Every level the pane has rendered carries its own copy of the note (only the current level's is
			// on screen), each the same.
			const notes = await page.locator(NOTE).all();
			const warn = variant.kind === 'expiring';
			for (const note of notes) {
				assert.equal(await note.getAttribute('data-kind'), variant.kind);
				assert.equal(await note.locator('b').textContent(), variant.title);
				assert.equal(await note.locator('p').textContent(), variant.message);
				const classes = (await note.getAttribute('class'))!.split(' ');
				assert.ok(classes.includes('note') && classes.includes(warn ? 'warn' : 'danger'), `classes: ${classes.join(' ')}`);
				assert.ok(!classes.includes(warn ? 'danger' : 'warn'), `classes: ${classes.join(' ')}`);
				assert.equal(await note.getAttribute('role'), warn ? 'status' : 'alert');
				assert.equal(await note.locator('button').count(), 0, 'no way to dismiss it');
			}
			assert.equal(await page.locator(NOTE).and(page.locator(':visible')).count(), 1, 'exactly one is on screen');
			await page.close();
		});
	}

	test('it shows on every level: the list, then a block\'s pane', async () => {
		const page = await openWith(PERMISSION);
		await eventually(async () => (await page.locator(NOTE).count()) > 0, 10_000, 'the note on the list');

		await page.click('.brow-main >> nth=0');
		await page.waitForSelector('[data-pane-level="block"]');
		const inBlock = page.locator(`[data-pane-level="block"] ${NOTE}`);
		await eventually(async () => (await inBlock.count()) > 0, 10_000, 'the note inside the block pane');
		assert.equal(await inBlock.first().getAttribute('data-kind'), 'permission');
		assert.equal(await inBlock.and(page.locator(':visible')).count(), 1, 'on screen in the block pane');
		await page.close();
	});

	test('commits failing: the save bar stops saying Kept, the pane says who can fix it, and both clear when a commit goes through', async () => {
		const page = await openWith(null, { since: new Date().toISOString(), failures: 3, message: COMMIT_TROUBLE_MESSAGE });
		await eventually(async () => (await keepState(page)) === 'not-reaching', 10_000, 'the bar\'s warning');
		const keep = page.locator('[data-keep]');
		assert.equal((await keep.textContent())?.trim(), 'Saved here, not reaching GitHub');
		assert.equal(await keep.getAttribute('title'), COMMIT_TROUBLE_MESSAGE);
		assert.ok((await keep.getAttribute('class'))!.split(' ').includes('loud'));
		const note = page.locator('[data-note="commit-trouble"]').and(page.locator(':visible'));
		assert.equal(await note.count(), 1);
		assert.equal(await note.locator('p').textContent(), COMMIT_TROUBLE_MESSAGE);

		// With the access note up, that one says what's wrong: no second note, the bar still warns.
		access = REFUSED;
		await eventually(async () => (await page.locator(NOTE).count()) > 0, 10_000, 'the access note');
		assert.equal(await page.locator('[data-note="commit-trouble"]').count(), 0);
		assert.equal(await keepState(page), 'not-reaching');

		access = null;
		trouble = null;
		await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept again');
		assert.equal(await page.locator('[data-note="commit-trouble"]').count(), 0);
		await page.close();
	});
});
