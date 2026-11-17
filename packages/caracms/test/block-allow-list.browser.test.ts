// A section builder's offered blocks (typed list items) in a real
// browser, on a throwaway copy of the demo under `astro dev` whose journal offers only
// the text and cta blocks (the demo itself is untouched). Its entries each hold a hero.
//
// 1. A journal entry's picker offers only Text and CTA, and no shared block (the footer's
//    type isn't offered); its hero row says "Not offered here", its text row doesn't, and
//    the hero still renders on the page.
// 2. A page's picker offers every block and the shared footer; no row is marked.
//
//   node --test --experimental-strip-types test/block-allow-list.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, footerInBody, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

const DOC = '[data-pane-level="document"]';
const JOURNAL = "journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages', fields: journalFields },";

function edit(root: string) {
	const file = join(root, 'caracms.config.ts');
	const config = readFileSync(file, 'utf8');
	if (!config.includes(JOURNAL)) throw new Error('the demo config\'s journal line has changed: update this test');
	writeFileSync(file, config.replace(JOURNAL, JOURNAL.replace(" },", ", blocks: ['text', 'cta'] },")));
	// The footer as a plain shared block in the body (helpers/dev-site.ts), so a page's picker has one to offer.
	footerInBody(root);
}

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	return page;
}

async function picker(page: Page) {
	await page.click(`${DOC} .add-row`);
	await page.waitForSelector('[data-picker-at]');
	return {
		types: await page.$$eval('[data-picker-at] .ptype', (els) => els.map((e) => e.getAttribute('data-type'))),
		shared: await page.locator('[data-picker-at] [data-shared]').count(),
	};
}

describe('a section builder\'s offered blocks in the editor', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('block-allow-list', { edit });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('1. a journal entry offers only its blocks; the hero it holds is marked and still on the page', { timeout: 60000 }, async () => {
		const page = await open('/admin/journal/notes-from-the-ridge');
		const hero = page.locator(`${DOC} .blist > .brow[data-block-type="hero"]`);
		await hero.locator('[data-chip="not-offered"]').filter({ hasText: 'Not offered here' }).waitFor();
		assert.equal(await page.locator(`${DOC} .blist > .brow[data-block-type="text"] [data-chip="not-offered"]`).count(), 0);
		assert.ok((await page.frameLocator('.frame.on iframe').locator('[data-cms-block]').count()) >= 2, 'the hero still renders');
		assert.deepEqual(await picker(page), { types: ['text', 'cta'], shared: 0 });
		await page.close();
	});

	test('2. a page offers every block and the shared footer; nothing is marked', { timeout: 60000 }, async () => {
		const page = await open('/admin/pages/about');
		await page.waitForSelector(`${DOC} .blist > .brow`);
		assert.equal(await page.locator('[data-chip="not-offered"]').count(), 0);
		const { types, shared } = await picker(page);
		assert.ok(types.includes('hero') && types.includes('text') && types.includes('cta') && types.length > 3, types.join(', '));
		assert.ok(shared >= 1, 'the shared footer is offered');
		await page.close();
	});
});
