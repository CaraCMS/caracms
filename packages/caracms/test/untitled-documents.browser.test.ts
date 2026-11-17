// caracms-cloud adversarial review, finding 15, in a real browser on the in-memory GitHub and
// the Redis stand-in (helpers/live-site.ts; never a real repo):
//   - a case study already on main with no title opens, its Title field saying "This needs a title."
//   - blanking a title as you type says the same, and the edit is kept
//   - the Publish panel names it as held back ("… won't be published: its title is empty."),
//     Publish sends the rest ("Publish 1 change"), and the toast says what stayed waiting
//
//   node --test --experimental-strip-types test/untitled-documents.browser.test.ts
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip } from './helpers/dev-site.ts';
import { AOIFE, eventually, keepState, openAdmin, runtime, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

const TIMINGS = { sweepIdleMs: 2000, sweepCapMs: 300_000, sweepTickMs: 500, mainCheckMs: 1000, pollMs: 1000 };
const PUBLISHER = 'content/case-studies/tiny-publisher.json';
const HARBOUR = 'content/case-studies/high-street-coffee.json';
const BIKES = 'content/case-studies/weekend-bikes.json';
const TITLE = '.side-level:not([hidden]) input[data-path="title"]';
const NOTE = '.side-level:not([hidden]) [data-ff="title"] .field-warn';
const CLIENT = '.side-level:not([hidden]) [data-ff="client"] input';

let live: LiveSite;
let browser: Browser;

const pubState = (page: Page) => page.getAttribute('.bar [data-slot="publish"]', 'data-pub');

describe('a document with no title, live', { skip: browserSkip }, () => {
	before(async () => {
		live = await startLiveSite('untitled', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) }, {
			// Already on main with its title gone (a hand edit, or an older version's Publish).
			edit: (root) => writeFileSync(join(root, BIKES), '{\n  "title": "",\n  "client": "Weekend bike shop"\n}\n'),
		});
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('one already on main opens, flagged on its Title field', async () => {
		const page = await openAdmin(await signedIn(browser, live.site, AOIFE), live.site, '/admin/case-studies/weekend-bikes');
		await page.waitForSelector(TITLE);
		assert.equal(await page.inputValue(TITLE), '');
		assert.equal((await page.textContent(NOTE))?.trim(), 'This needs a title.');
		assert.equal(await page.getAttribute(TITLE, 'aria-invalid'), 'true');
		// Given one, the note goes.
		await page.fill(TITLE, 'Weekend bike shop');
		await page.waitForSelector(NOTE, { state: 'detached' });
		await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');
		await page.close();
	});

	test('blanked while editing: the note, the edit kept, and Publish holds it back and sends the rest', async () => {
		const page = await openAdmin(await signedIn(browser, live.site, AOIFE), live.site, '/admin/case-studies/tiny-publisher');
		await page.waitForSelector(TITLE);
		await page.fill(TITLE, '');
		await page.waitForSelector(NOTE);
		assert.equal((await page.textContent(NOTE))?.trim(), 'This needs a title.');
		await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept, title and all');

		await page.goto(`${live.site.origin}/admin/case-studies/high-street-coffee`);
		await page.waitForSelector(CLIENT);
		await page.fill(CLIENT, 'High-street roaster');
		await eventually(async () => (await keepState(page)) === 'kept', 10_000, 'Kept');
		await eventually(async () => (await pubState(page)) === 'waiting', 8000, 'waiting');

		await page.click('.bar [data-slot="publish"]');
		const pop = page.locator('[data-pop="waiting"]');
		await pop.waitFor();
		await eventually(async () => (await pop.locator('[data-waiting]').count()) === 3, 10_000, 'three waiting');
		const held = pop.locator(`[data-waiting="${PUBLISHER}"] [data-note="held-back"]`);
		await held.waitFor();
		assert.equal((await held.locator('b').textContent())?.replace(/\s+/g, ' ').trim(), "Tiny publisher won't be published: its title is empty.");
		assert.equal(await pop.locator(`[data-waiting="${HARBOUR}"] [data-note="held-back"]`).count(), 0);
		// Weekend bike shop was given its title in the first test: it goes too.
		const button = pop.locator('[data-act="publish"]');
		assert.match((await button.textContent())!, /^Publish 2 changes$/);
		await button.click();
		await eventually(async () => /Tiny publisher wasn't published: its title is empty\./.test((await page.textContent('.toast')) ?? ''), 8000, 'the toast');

		const rt = await runtime();
		assert.match(rt.backend.file('main', `starter/${HARBOUR}`) ?? '', /High-street roaster/);
		assert.match(rt.backend.file('main', `starter/${PUBLISHER}`) ?? '', /"title": "Tiny publisher"/i);
		assert.match(rt.backend.file('drafts', `starter/${PUBLISHER}`) ?? '', /"title": ""/);

		// Left waiting, alone: Publish is off and says why.
		if (!(await pop.isVisible())) await page.click('.bar [data-slot="publish"]');
		await eventually(async () => (await pop.locator('[data-waiting]').count()) === 1, 10_000, 'only Tiny waiting');
		await pop.locator('[data-note="all-held"]').waitFor();
		assert.equal(await pop.locator('[data-act="publish"]').isDisabled(), true);
		assert.equal((await pop.locator('[data-act="publish"]').textContent())?.trim(), 'Publish');

		// Add a title opens it on its Title field.
		await pop.locator('[data-act="add-title"]').click();
		await page.waitForSelector(NOTE);
		await page.close();
	});
});
