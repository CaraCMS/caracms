// Navigation in a real browser (Phase 4 → Verify 1, 2, 5, 6), on a throwaway copy of
// the demo under `astro dev` (helpers/dev-site.ts). Fixtures are written into the
// copy and removed again, never into starter/content. Headless Chromium from
// Playwright's cache; skipped without it.
//
//   node --test --experimental-strip-types test/navigation.browser.test.ts
import assert from 'node:assert/strict';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
	return page;
}

async function eventually<T>(check: () => T | Promise<T>, timeout = 8000, what = 'the condition'): Promise<T> {
	const end = Date.now() + timeout;
	let last: unknown;
	while (Date.now() < end) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

const DOCS = '[data-pane-level="documents"]';

/** The Pages tree's rows as shown: a group as [Label], a page by its label. */
const treeLabels = (page: Page) =>
	page.$$eval(`${DOCS} section[data-collection="pages"] .tnode > .drow`, (rows) =>
		rows.map((r) => (r.classList.contains('is-group') ? `[${r.querySelector('.nm')!.textContent}]` : r.classList.contains('is-held') ? `{${r.querySelector('.nm')!.textContent}}` : r.querySelector('.nm')!.textContent)),
	);

const toDocuments = async (page: Page) => {
	if (await page.isVisible(DOCS)) return;
	await page.click('.side-level:not([hidden]) .lv >> nth=0');
	await page.waitForSelector(DOCS, { state: 'visible' });
};

describe('navigation in the browser', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('navigation');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('Verify 1: the Pages tree in order; Services stays collapsed through a reload; opening Branding opens it; Journal drills in', async () => {
		const page = await open('/admin');
		await toDocuments(page);
		// Nothing touched: groups closed. (M5b Phase 1 added the fixture's /visit page; collections under pages, the Journal page that holds the posts, and a {row} under each holder.) Arrange pages, Decision 7: with no saved order, what has pages or a held
		// collection under it first, A–Z, then the rest A–Z.
		assert.deepEqual(await treeLabels(page), ['Home', 'About', 'Journal', '{Journal}', '[Services]', 'Work', '{Case studies}', 'Contact', 'Visit']);
		// The chevron at the row's end shows About's Team; the group row shows Services' pages.
		await page.click(`${DOCS} .twisty[data-group="pages:about"]`);
		await page.click(`${DOCS} .drow.is-group[data-group="pages:services"]`);
		assert.deepEqual(await treeLabels(page), ['Home', 'About', 'Team', 'Journal', '{Journal}', '[Services]', 'Branding', 'Print', 'Websites', 'Work', '{Case studies}', 'Contact', 'Visit']);
		const chevronEnd = await page.$eval(`${DOCS} .twisty[data-group="pages:about"]`, (t) => {
			const row = t.parentElement!.querySelector('.drow')!;
			return t.getBoundingClientRect().left >= row.querySelector('.nm')!.getBoundingClientRect().right - 1;
		});
		assert.ok(chevronEnd, 'the show/hide chevron sits at the row\'s end, after the name');
		// No chevron column: a page's icon lines up with a site-wide row's.
		const iconsLine = await page.evaluate(() => {
			const x = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().left;
			return Math.abs(x('[data-pane-level="documents"] .drow[data-doc="pages/index"] .i') - x('[data-pane-level="documents"] .drow.coll:not(.is-held) .i')) < 1;
		});
		assert.ok(iconsLine, 'page icons line up with the site-wide rows');
		// Journal and (M5a) Case studies; Shared blocks and Site Settings are under Site-wide.
		assert.equal(await page.textContent(`${DOCS} .grp[aria-label="Collections"] .grp-h`), 'Collections 2');

		// Collapse Services, reload: still collapsed (the cookie, Decision 20), in the server's HTML too.
		await page.click(`${DOCS} .drow.is-group[data-group="pages:services"]`);
		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]');
		await toDocuments(page);
		assert.equal(await page.getAttribute(`${DOCS} [data-group="pages:services"]`, 'aria-expanded'), 'false');
		assert.deepEqual(await treeLabels(page), ['Home', 'About', 'Team', 'Journal', '{Journal}', '[Services]', 'Work', '{Case studies}', 'Contact', 'Visit']);

		// Open Branding (through Find): Services is open.
		await page.fill(`${DOCS} input[data-filter="docs"]`, 'branding');
		await page.click(`${DOCS} [data-results="pages"] [data-doc="pages/services/branding"]`);
		await page.waitForURL('**/admin/pages/services/branding');
		assert.equal(await page.textContent('[data-pane-level="document"] .cur-title .crumbp'), 'Services /');
		await toDocuments(page);
		await page.fill(`${DOCS} input[data-filter="docs"]`, '');
		assert.equal(await page.getAttribute(`${DOCS} [data-group="pages:services"]`, 'aria-expanded'), 'true');
		assert.ok(await page.isVisible(`${DOCS} .drow.is-current[data-doc="pages/services/branding"]`));

		// Journal: its row shows 3, and drills into its own level with + New (active since M5a Phase 5).
		assert.equal(await page.textContent(`${DOCS} .drow.coll[data-coll="journal"] .cnt`), '3');
		await page.click(`${DOCS} .drow.coll[data-coll="journal"]`);
		const level = '[data-pane-level="collection"]';
		await page.waitForSelector(level);
		assert.equal(await page.locator(`${level} #coll-list .drow`).count(), 3);
		assert.equal(await page.isDisabled(`${level} [data-act="new-document"]`), false);
		await page.fill(`${level} input[data-filter="collection"]`, 'ridge');
		assert.deepEqual(await page.$$eval(`${level} #coll-list .drow .nm`, (r) => r.map((x) => x.textContent)), ['Notes from the Ridge']);
		await page.press(`${level} input[data-filter="collection"]`, 'Enter');
		await page.waitForURL('**/admin/journal/notes-from-the-ridge');
		await page.close();
	});

	test('Verify 2: "Find a document" and ⌘K find Branding and a Journal post by name, grouped by collection', async () => {
		const page = await open('/admin');
		await toDocuments(page);
		await page.fill(`${DOCS} input[data-filter="docs"]`, 'bran');
		assert.deepEqual(await page.$$eval(`${DOCS} [data-results] .drow .nm`, (r) => r.map((x) => x.textContent)), ['Services / Branding']);
		await page.fill(`${DOCS} input[data-filter="docs"]`, 'ridge');
		assert.deepEqual(await page.$$eval(`${DOCS} [data-results]`, (g) => g.map((x) => x.getAttribute('data-results'))), ['journal']);
		// Matching the parent's name finds its pages; matching nothing says so.
		await page.fill(`${DOCS} input[data-filter="docs"]`, 'services');
		assert.equal(await page.locator(`${DOCS} [data-results="pages"] .drow`).count(), 3);
		await page.fill(`${DOCS} input[data-filter="docs"]`, 'qqqq');
		assert.match((await page.textContent(`${DOCS} .no-hits`))!, /Nothing called “qqqq”/);
		await page.fill(`${DOCS} input[data-filter="docs"]`, '');

		// ⌘K: the switcher, focused, grouped; Enter opens the highlighted hit.
		await page.keyboard.press('ControlOrMeta+k');
		await page.waitForSelector('#pops .pop.switcher');
		assert.equal(await page.evaluate(() => document.activeElement?.id), 'swq');
		const unfiltered = await page.$$eval('#swlist [data-sw-group]', (g) => g.map((x) => x.getAttribute('data-sw-group')));
		// M5a: case studies, shared blocks and Site Settings too.
		assert.deepEqual(unfiltered, ['recent', 'pages', 'journal', 'case-studies', 'shared', 'settings']);
		await page.keyboard.type('branding');
		assert.deepEqual(await page.$$eval('#swlist .drow .nm', (r) => r.map((x) => x.textContent)), ['Services / Branding']);
		await page.keyboard.press('Enter');
		await page.waitForURL('**/admin/pages/services/branding');
		assert.equal(await page.locator('#pops .pop.switcher').count(), 0, 'it closes on opening');

		await page.click('.docbtn');
		await page.waitForSelector('#swq');
		await page.keyboard.type('type that holds');
		assert.equal(await page.textContent('#swlist [data-sw-group="journal"] .sw-h'), 'Journal · 1 of 3');
		await page.keyboard.press('Enter');
		await page.waitForURL('**/admin/journal/type-that-holds-its-lines');

		// Esc closes it without opening anything.
		await page.keyboard.press('ControlOrMeta+k');
		await page.waitForSelector('#swq');
		await page.keyboard.press('Escape');
		assert.equal(await page.locator('#pops .pop.switcher').count(), 0);
		assert.match(page.url(), /type-that-holds-its-lines$/);
		await page.close();
	});

	test('Verify 5: an empty collection\'s state on its own level, and an empty page inviting its first block', async () => {
		const journal = join(site.root, 'content/journal');
		const moved = ['a-new-home-for-caracms', 'notes-from-the-ridge', 'type-that-holds-its-lines'];
		for (const name of moved) renameSync(join(journal, `${name}.json`), join(journal, `${name}.json.off`));
		site.write('content/pages/blank.json', '{\n  "title": "Blank",\n  "blocks": []\n}\n');
		try {
			const page = await open('/admin');
			await toDocuments(page);
			assert.equal(await page.textContent(`${DOCS} .drow.coll[data-coll="journal"] .cnt`), '0');
			await page.click(`${DOCS} .drow.coll[data-coll="journal"]`);
			const empty = '[data-pane-level="collection"] [data-empty="collection"]';
			await page.waitForSelector(empty);
			assert.match((await page.textContent(empty))!, /Nothing in Journal yet/);
			assert.equal(await page.isDisabled(`${empty} .btn`), false, '+ New is active (M5a Phase 5)');
			assert.match((await page.textContent(`${empty} .btn`))!, /New journal entry/);

			await page.goto(`${site.origin}/admin/pages/blank`);
			await page.waitForSelector('#stage[data-painted="true"]');
			const invite = '[data-pane-level="document"] [data-empty="page"]';
			await page.waitForSelector(invite);
			assert.match((await page.textContent(invite))!, /No blocks yet/);
			await page.click(`${invite} .btn`);
			await page.waitForSelector('[data-picker-at="0"]');
			assert.equal(await page.textContent('[data-pane-level="document"] .cur .sub'), 'The first block on the page');
			await page.click('[data-picker-at] .ptype[data-type="text"]');
			await page.waitForSelector('[data-pane-level="block"]');
			await eventually(() => /"type": "text"/.test(site.read('content/pages/blank.json')), 8000, 'the new block on disk');
			await page.close();
		} finally {
			for (const name of moved) renameSync(join(journal, `${name}.json.off`), join(journal, `${name}.json`));
			rmSync(join(site.root, 'content/pages/blank.json'), { force: true });
		}
	});

	test('Verify 6: invalid JSON and a nested index.json are listed with a warning and don\'t open', async () => {
		site.write('content/pages/broken.json', '{ "title": "Broken", "blocks": [ }\n');
		site.write('content/pages/services/index.json', '{\n  "title": "Services",\n  "blocks": []\n}\n');
		try {
			const page = await open('/admin');
			await toDocuments(page);
			if ((await page.getAttribute(`${DOCS} [data-group="pages:services"]`, 'aria-expanded')) !== 'true') {
				await page.click(`${DOCS} [data-group="pages:services"]`);
			}
			for (const [doc, code] of [
				['pages/broken', 'invalid-json'],
				['pages/services/index', 'nested-index'],
			] as const) {
				const row = `${DOCS} .drow[data-doc="${doc}"]`;
				assert.match((await page.getAttribute(row, 'class'))!, /is-warned/, `${doc} is marked`);
				assert.equal(await page.getAttribute(`${row} .wmark`, 'data-warning'), code);
				await page.click(row);
				await page.waitForSelector(`${DOCS} [data-why="${doc}"]`);
				assert.match(page.url(), /\/admin\/pages\/index$|\/admin$/, `${doc} didn't open`);
			}
			assert.match((await page.textContent(`${DOCS} [data-why="pages/services/index"]`))!, /Rename it to services\.json/);
			assert.equal((await fetch(`${site.origin}/admin/pages/broken`)).status, 400);

			// The switcher lists them too, and Enter on one doesn't open it.
			await page.keyboard.press('ControlOrMeta+k');
			await page.keyboard.type('broken');
			await page.keyboard.press('Enter');
			assert.equal(await page.locator('#pops .pop.switcher').count(), 1, 'still open: nothing opened');
			await page.close();
		} finally {
			rmSync(join(site.root, 'content/pages/broken.json'), { force: true });
			rmSync(join(site.root, 'content/pages/services/index.json'), { force: true });
		}
		assert.equal(existsSync(join(site.root, 'content/pages/broken.json')), false);
	});
});
