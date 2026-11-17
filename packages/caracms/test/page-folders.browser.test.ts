// Page folders: the Arrange screen's folders and the sidebar's
// folder rows, on a throwaway copy of the demo (helpers/dev-site.ts), local mode. Each test starts
// from the pinned demo content (the folders a test needs are written into its Site Settings first).
//
//   checks 1, 2, 3    New folder: empty, Review… off with the reason; filled by dragging; the folder-only review
//                     (no tick); Apply writes pageFolders and the token only; the sidebar's folder row with its
//                     count opens, closes and stays as left across a reload; the pages still answer at their addresses
//   check 4           a folder can't go in a folder; a page dragged into a folder at another level shows its
//                     address change and the tick
//   check 6           Rename… on a folder: a clash with a drawn folder refused at the row, a page's name allowed,
//                     only the name changes (no address change, no redirect, the id kept)
//   check 18          Take out of the addresses refused at the row (a page, and a folder, in the way); not offered
//                     on a page with pages under it
//   check 10          ··· → New page in <Folder>: made at the folder's level, filed at the end, the count in the sidebar
//
//   node --test --experimental-strip-types test/page-folders.browser.test.ts
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, demoContent, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;
const DOCS = '[data-pane-level="documents"]';
const PANE = '[data-pane-level="arrange"]';
const TREE = '#atree';

async function open(path = '/admin', viewport = { width: 1440, height: 900 }): Promise<Page> {
	const page = await browser.newPage({ viewport });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
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

const row = (id: string) => `${TREE} .arow[data-id="${id}"]`;
const exists = (file: string) => existsSync(join(site.root, file));
type Folder = { id: string; name: string; pages: string[] };
const settings = () => JSON.parse(site.read('content/site-settings.json')) as { redirects?: { from: string; to: string }[]; pageOrder?: Record<string, string[]>; pageFolders?: Record<string, Folder[]> };
const page_ = (title: string) => `${JSON.stringify({ title, blocks: [] }, null, 2)}\n`;
const write = (file: string, text: string) => {
	mkdirSync(dirname(join(site.root, file)), { recursive: true });
	site.write(file, text);
};
/** Site Settings with folders already saved (the demo's own keys kept). */
function saveFolders(pageFolders: Record<string, Folder[]>, pageOrder: Record<string, string[]>) {
	write('content/site-settings.json', `${JSON.stringify({ ...settings(), pageFolders, pageOrder }, null, 2)}\n`);
}
/** About (Team under it) and Contact in Company, and Visit alone in Extras, both after Journal and Services. */
const TWO = () =>
	saveFolders(
		{ '': [{ id: 'company', name: 'Company', pages: ['about', 'contact'] }, { id: 'extras', name: 'Extras', pages: ['visit'] }] },
		{ '': ['journal', 'services', 'work', '(company)', '(extras)'] },
	);

/** The screen from the documents level. */
async function arrange(page: Page) {
	if (!(await page.isVisible(DOCS))) await page.click('.side-level:not([hidden]) .lv >> nth=0');
	await page.click(`${DOCS} [data-act="open-arrange"]`);
	await page.waitForSelector(`${PANE} [data-act="review"]`);
	await page.waitForSelector(row('index'));
}

/** Drag a row by the mouse onto another row's top quarter, middle or bottom quarter. Leaves the button down when `hold`. */
async function drag(page: Page, from: string, to: string, where: 'top' | 'mid' | 'bottom', hold = false) {
	const a = (await page.locator(row(from)).boundingBox())!;
	await page.mouse.move(a.x + 120, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + 130, a.y + a.height / 2 + 8, { steps: 3 });
	await page.waitForSelector(`${row(from)}.is-src`);
	const b = (await page.locator(row(to)).boundingBox())!;
	const y = where === 'top' ? b.y + 4 : where === 'bottom' ? b.y + b.height - 4 : b.y + b.height / 2;
	await page.mouse.move(b.x + 200, y, { steps: 6 });
	if (!hold) await page.mouse.up();
}

const reviewText = (page: Page) => page.textContent(`${PANE} .side-body`).then((t) => (t ?? '').replace(/\s+/g, ' '));
/** The names the sidebar's Pages tree shows, top to bottom. */
const sideNames = (page: Page) => page.$$eval(`${DOCS} section[data-collection="pages"] .drow:not(.is-held) .nm`, (els) => els.map((e) => e.textContent?.trim()));
const FOLDER = (id: string) => `${DOCS} [data-folder="${id}"]`;

describe('page folders: the Arrange screen and the sidebar, local mode', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('page-folders');
		browser = await chromium.launch();
	});
	beforeEach(() => {
		rmSync(join(site.root, 'content'), { recursive: true, force: true });
		cpSync(demoContent, join(site.root, 'content'), { recursive: true });
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('a folder made and filled (checks 1, 2, 3): empty and Review… off, then a folder-only Apply; the sidebar row opens, closes and survives a reload', async () => {
		const page = await open();
		const filesBefore = await page.evaluate(async () => ((await (await fetch('/_caracms/documents')).json()) as { file: string }[]).map((d) => d.file).sort());
		await arrange(page);
		// New folder "Company": a row at the end of the top level, marked empty, Review… off with the reason.
		await page.click('[data-act="new-folder"]');
		await page.fill('#ng-in', 'Company');
		assert.match((await page.textContent('.arow[data-id="naming"] .aa'))!, /Not in the addresses/);
		await page.press('#ng-in', 'Enter');
		await page.waitForSelector(row('newf:1'));
		assert.match((await page.textContent(row('newf:1')))!, /New folder/);
		assert.ok(await page.locator(`${row('newf:1')}.is-empty`).count(), 'marked empty');
		assert.equal(await page.isDisabled(`${PANE} [data-act="review"]`), true);
		assert.match((await page.textContent('#rv-why'))!, /Company is empty: add a page to it or remove it\./);
		assert.equal(await page.locator(`${row('newf:1')} .aa`).evaluate((e) => e.classList.contains('plain')), true, 'no address shown for a folder');
		// About (Team comes with it) and Contact into it.
		await drag(page, 'about', 'newf:1', 'mid');
		await page.waitForSelector(`${row('newf:1')}:not(.is-empty)`);
		await drag(page, 'contact', 'newf:1', 'mid');
		assert.equal(await page.isDisabled(`${PANE} [data-act="review"]`), false);
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} [data-review="order-only"]`);
		assert.match(await reviewText(page), /No address changes; the Pages tree’s folders and order change/);
		assert.equal(await page.locator('#rv-tick').count(), 0, 'no tick');
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${DOCS}:not([hidden]) [data-act="open-arrange"]`);
		// Site Settings alone: pageFolders and Company's token; no redirect; no file moved.
		const saved = (await eventually(() => {
			const s = settings();
			return s.pageFolders ? s : null;
		}, 8000, 'the folder written'))!;
		assert.deepEqual(saved.pageFolders, { '': [{ id: 'company', name: 'Company', pages: ['about', 'contact'] }] });
		assert.ok(saved.pageOrder?.['']?.includes('(company)'), JSON.stringify(saved.pageOrder));
		assert.equal((saved.redirects ?? []).length, 0, 'no redirect');
		const filesAfter = await page.evaluate(async () => ((await (await fetch('/_caracms/documents')).json()) as { file: string }[]).map((d) => d.file).sort());
		assert.deepEqual(filesAfter, filesBefore, 'no file moved');
		assert.ok(exists('content/pages/about/team.json') && exists('content/pages/contact.json'));
		// The sidebar: Company with its count, closed; it opens to About then Contact, closes, and its state outlives a reload.
		await page.waitForSelector(FOLDER('company'));
		assert.equal((await page.textContent(`${FOLDER('company')} .cnt`))!.trim(), '2', 'the rows filed in it, not the pages under them');
		assert.equal(await page.getAttribute(FOLDER('company'), 'aria-expanded'), 'false');
		assert.ok(!(await sideNames(page)).includes('About'), 'its rows hidden while it is closed');
		await page.click(FOLDER('company'));
		await page.waitForSelector(`${FOLDER('company')}[aria-expanded="true"]`);
		const names = (await sideNames(page)) as string[];
		assert.equal(names[names.indexOf('Company') + 1], 'About');
		assert.equal(names[names.indexOf('Company') + 2], 'Contact', 'About is closed: Team stays under it');
		await page.click(FOLDER('company'));
		await page.waitForSelector(`${FOLDER('company')}[aria-expanded="false"]`);
		await page.click(FOLDER('company'));
		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]');
		if (!(await page.isVisible(DOCS))) await page.click('.side-level:not([hidden]) .lv >> nth=0');
		await page.waitForSelector(`${FOLDER('company')}[aria-expanded="true"]`);
		assert.equal((await page.textContent(`${FOLDER('company')} .cnt`))!.trim(), '2');
		// The pages still answer at the same addresses.
		for (const path of ['/about', '/about/team', '/contact']) assert.equal((await fetch(site.origin + path)).status, 200, path);
		await page.close();
	});

	test('what a drop can do (check 4): a folder can\'t go in a folder; a page from another level shows its address change and the tick', async () => {
		TWO();
		const page = await open();
		await arrange(page);
		await page.waitForSelector(row('folder:(company)'));
		await drag(page, 'folder:(extras)', 'folder:(company)', 'mid', true);
		await page.waitForSelector(`${row('folder:(company)')}.is-refused`);
		assert.match((await page.textContent(`${row('folder:(company)')} .arow-why`))!, /A folder can’t go in a folder/);
		await page.mouse.up();
		await page.waitForSelector(`${row('folder:(company)')}:not(.is-refused)`);
		assert.match((await page.textContent(`${PANE} .side-body`))!, /None yet/, 'nothing changed');
		// Print is under Services: filed in Company it goes to the top level, and says so.
		await drag(page, 'services/print', 'folder:(company)', 'mid');
		await page.waitForSelector(`${PANE} .chg li`);
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} .rv`);
		assert.ok((await reviewText(page)).includes('/services/print→becomes/print'), await reviewText(page));
		assert.equal(await page.isChecked('#rv-tick'), true, 'the tick');
		// Cancel: it asks, and leaving writes nothing.
		const before = site.read('content/site-settings.json');
		await page.click(`${PANE} [data-act="back"]`);
		await page.click(`${PANE} [data-act="cancel"]`);
		await page.waitForSelector('[data-dialog="arrange-leave"]');
		await page.click('[data-act="leave-go"]');
		await page.waitForSelector(PANE, { state: 'detached' });
		assert.equal(site.read('content/site-settings.json'), before, 'nothing written');
		await page.close();
	});

	test('Rename… on a folder (check 6): a drawn folder\'s name refused at the row, a page\'s name allowed; only the name changes', async () => {
		TWO();
		const page = await open();
		await arrange(page);
		await page.hover(row('folder:(extras)'));
		await page.click(`${row('folder:(extras)')} [data-act="rename"]`);
		await page.fill('#rn-in', 'company');
		assert.match((await page.textContent('#rn-sub'))!, /There’s already a folder called Company here\./);
		assert.equal(await page.isDisabled('#rn-ok'), true);
		// A page is no clash: a folder may share a name with a page.
		await page.fill('#rn-in', 'Contact');
		assert.equal(await page.isDisabled('#rn-ok'), false);
		await page.fill('#rn-in', 'More things');
		await page.click('#rn-ok');
		await page.waitForSelector(`${row('folder:(extras)')} .chip.select`);
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} [data-review="order-only"]`);
		assert.match(await reviewText(page), /No address changes; the Pages tree’s folders and order change/);
		assert.equal(await page.locator('#rv-tick').count(), 0);
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${DOCS}:not([hidden]) [data-act="open-arrange"]`);
		await eventually(() => settings().pageFolders?.['']?.some((f) => f.name === 'More things'), 8000, 'the new name written');
		const s = settings();
		assert.deepEqual(s.pageFolders, { '': [{ id: 'company', name: 'Company', pages: ['about', 'contact'] }, { id: 'extras', name: 'More things', pages: ['visit'] }] }, 'the id kept');
		assert.deepEqual(s.pageOrder, { '': ['journal', 'services', 'work', '(company)', '(extras)'] }, 'its place kept');
		assert.equal((s.redirects ?? []).length, 0);
		assert.ok(exists('content/pages/visit.json'));
		await page.waitForSelector(FOLDER('extras'));
		assert.match((await page.textContent(FOLDER('extras')))!, /More things/);
		await page.close();
	});

	test('Take out of the addresses refused (check 18): a page in the way, then a folder; not offered on a page with pages under it', async () => {
		// Services' Print would land on a top-level page called Print.
		write('content/pages/print.json', page_('Print'));
		let page = await open();
		await arrange(page);
		await page.hover(row('services'));
		await page.click(`${row('services')} [data-act="row-menu"]`);
		await page.click('[data-act="take-out"]');
		await page.waitForSelector('[data-sub="take-out"]');
		assert.match((await page.textContent('[data-sub="take-out"]'))!, /Can’t take Services out of the addresses: there’s already a page called Print here\./);
		assert.match((await page.textContent(`${PANE} .side-body`))!, /None yet/, 'nothing planned');
		// About has pages under it: no such action on its row.
		await page.hover(row('about'));
		if (await page.locator(`${row('about')} [data-act="row-menu"]`).count()) {
			await page.click(`${row('about')} [data-act="row-menu"]`);
			assert.equal(await page.locator('[data-act="take-out"]').count(), 0, 'not offered on a page with pages under it');
		}
		await page.close();
		// A folder at the level above with the group's name.
		rmSync(join(site.root, 'content/pages/print.json'));
		saveFolders({ '': [{ id: 'services', name: 'Services', pages: ['contact'] }] }, { '': ['(services)'] });
		page = await open();
		await arrange(page);
		await page.hover(row('services'));
		await page.click(`${row('services')} [data-act="row-menu"]`);
		await page.click('[data-act="take-out"]');
		await page.waitForSelector('[data-sub="take-out"]');
		assert.match((await page.textContent('[data-sub="take-out"]'))!, /there’s already a folder called Services here\./);
		await page.close();
	});

	test('··· → New page in <Folder> (check 10): made at the folder\'s level, filed at the end of it, the count in the sidebar', async () => {
		TWO();
		const page = await open();
		await page.click('[data-pane-level="document"] .cur .ib.boxed');
		await page.waitForSelector(FOLDER('company'));
		assert.equal((await page.textContent(`${FOLDER('company')} .cnt`))!.trim(), '2');
		await page.hover(FOLDER('company'));
		await page.click(`${DOCS} [data-tnode-folder="(company)"] [data-act="folder-menu"]`);
		await page.waitForSelector('[data-act="new-in-folder"]');
		assert.match((await page.textContent('[data-act="new-in-folder"]'))!, /New page in Company/);
		assert.ok(await page.locator('[data-act="folder-arrange"]').count(), 'Arrange pages… beside it');
		await page.click('[data-act="new-in-folder"]');
		await page.waitForSelector('[data-dialog="new"]');
		await page.fill('#np-name', 'Careers');
		assert.equal(await page.getAttribute('[data-dialog="new"] [data-address]', 'data-address'), '/careers', 'the address is at the folder\'s level');
		await page.click('[data-dialog="new"] [data-act="create"]');
		await page.waitForSelector('[data-dialog="new"]', { state: 'detached' });
		await eventually(() => exists('content/pages/careers.json'), 8000, 'the page made');
		await eventually(() => settings().pageFolders?.['']?.find((f) => f.id === 'company')?.pages.includes('careers'), 8000, 'filed in Company');
		assert.deepEqual(settings().pageFolders?.['']?.find((f) => f.id === 'company')?.pages, ['about', 'contact', 'careers'], 'at the end');
		// Back to the documents level: Company counts 3, Careers last in it.
		await page.click('[data-pane-level="document"] .cur .ib.boxed');
		await page.waitForSelector(`${FOLDER('company')} .cnt`);
		await eventually(async () => (await page.textContent(`${FOLDER('company')} .cnt`))!.trim() === '3', 8000, 'count 3');
		if ((await page.getAttribute(FOLDER('company'), 'aria-expanded')) !== 'true') await page.click(FOLDER('company'));
		const names = (await sideNames(page)) as string[];
		assert.deepEqual(names.slice(names.indexOf('Company') + 1, names.indexOf('Company') + 4), ['About', 'Contact', 'Careers']);
		await page.close();
	});
});
