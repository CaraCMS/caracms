// Arrange pages: the screen, on a throwaway copy of the
// demo (helpers/dev-site.ts), local mode. Each test starts from the pinned demo content.
//
//   check 1, 17, 18   "Arrange pages…" opens /admin/arrange: every row, Home fixed and no drop target, held rows, hidden marks
//   check 3           an order-only Apply: pageOrder for one level, no redirect, the sidebar at once and after a reload
//   checks 5, 6, 7, 8 New group, filled; a group renamed; the review's every address and its one tick; Apply lands it
//   check 8           the last page out of a group: "Studio goes"; Cancel and Back ask first and write nothing; a reload drops it
//   checks 8a, 9      clashes refused at the drop and at the name; a page beside a group with its slug joins it
//   check 10          a holder moves with its documents as one count line with a disclosure
//   check 12          the Apply refused (a page made at a target address, a page deleted since): re-planned and named
//   check 16          under a hidden page "will be hidden", out of it "will be shown"; hidden itself, it stays hidden
//   review fixes      a group holding only groups that go; Back leaves no doubled entry; focus back from the leave
//                     dialog; no Rename… on a group that goes; names cut short beside the address at 1,024px
//
//   node --test --experimental-strip-types test/arrange-pages.browser.test.ts
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
const settings = () => JSON.parse(site.read('content/site-settings.json')) as { redirects?: { from: string; to: string }[]; pageOrder?: Record<string, string[]> };
const page_ = (title: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ title, blocks: [], ...extra }, null, 2)}\n`;
const remove = (file: string) => rmSync(join(site.root, file), { force: true });
const write = (file: string, text: string) => {
	mkdirSync(dirname(join(site.root, file)), { recursive: true });
	site.write(file, text);
};

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
	// Measured once the drag has started: the rows under the dragged one fold away.
	await page.waitForSelector(`${row(from)}.is-src`);
	const b = (await page.locator(row(to)).boundingBox())!;
	const y = where === 'top' ? b.y + 4 : where === 'bottom' ? b.y + b.height - 4 : b.y + b.height / 2;
	await page.mouse.move(b.x + 200, y, { steps: 6 });
	if (!hold) await page.mouse.up();
}

const sideOrder = (page: Page) => page.$$eval(`${DOCS} section[data-collection="pages"] > .tnode > .drow:not(.is-held) .nm`, (els) => els.map((e) => e.textContent?.trim()));
const reviewText = (page: Page) => page.textContent(`${PANE} .side-body`).then((t) => (t ?? '').replace(/\s+/g, ' '));

describe('arrange pages: the screen, local mode', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('arrange-pages');
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

	test('the screen (checks 1, 17, 18): every row, Home fixed and no drop target, held rows not draggable', async () => {
		const page = await open();
		assert.equal((await page.textContent(`${DOCS} [data-act="open-arrange"]`))!.trim(), 'Arrange pages…');
		await arrange(page);
		assert.equal(new URL(page.url()).pathname, '/admin/arrange');
		const ids = await page.$$eval(`${TREE} .arow`, (els) => els.map((e) => (e as HTMLElement).dataset.id));
		assert.deepEqual(ids, ['index', 'about', 'about/team', 'journal', 'held:journal', 'services', 'services/branding', 'services/print', 'services/websites', 'work', 'held:work', 'contact', 'visit']);
		assert.equal(await page.getAttribute(row('index'), 'data-drag'), null, 'Home is not draggable');
		assert.equal(await page.getAttribute(row('index'), 'title'), 'Home stays first, takes no pages and can’t be filed');
		assert.equal(await page.getAttribute(row('held:journal'), 'data-drag'), null, 'a held row is not draggable');
		assert.equal(await page.getAttribute(row('contact'), 'data-drag'), '');
		// Contact onto Home's middle: refused, with the row saying why; let go: nothing changes.
		await drag(page, 'contact', 'index', 'mid', true);
		await page.waitForSelector(`${row('index')}.is-refused`);
		assert.match((await page.textContent(`${row('index')} .arow-why`))!, /Home takes no pages/);
		await page.mouse.up();
		await page.waitForSelector(`${row('index')}:not(.is-refused)`);
		assert.match((await page.textContent(`${PANE} .side-body`))!, /None yet/);
		// Onto a held collection's row: refused too.
		await drag(page, 'contact', 'held:journal', 'mid', true);
		await page.waitForSelector(`${row('held:journal')}.is-refused`);
		assert.match((await page.textContent(`${row('held:journal')} .arow-why`))!, /Moves with Journal: drop on Journal instead/);
		await page.mouse.up();
		// A reload reopens it with nothing arranged (check 18).
		await drag(page, 'contact', 'about', 'top');
		await page.waitForSelector(`${PANE} .chg`);
		await page.reload();
		await page.waitForSelector(row('index'));
		assert.match((await page.textContent(`${PANE} .side-body`))!, /None yet/);
		await page.close();
	});

	test('an order-only Apply (check 3): one level in pageOrder, no redirect, the sidebar at once and after a reload', async () => {
		const page = await open();
		const filesBefore = await page.evaluate(async () => ((await (await fetch('/_caracms/documents')).json()) as { file: string }[]).map((d) => d.file).sort());
		await arrange(page);
		await drag(page, 'journal', 'about', 'top');
		await page.waitForSelector(`${PANE} .chg li`);
		assert.match((await page.textContent(`${PANE} .chg`))!, /The order changes at the top level/);
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} [data-review="order-only"]`);
		assert.match(await reviewText(page), /No address changes; the order of the Pages tree changes/);
		assert.equal(await page.locator('#rv-tick').count(), 0, 'no tick for an order-only Apply');
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${DOCS}:not([hidden]) [data-act="open-arrange"]`);
		assert.deepEqual((await sideOrder(page)).slice(0, 3), ['Home', 'Journal', 'About']);
		const s = settings();
		assert.deepEqual(Object.keys(s.pageOrder ?? {}), ['']);
		assert.deepEqual(s.pageOrder![''].slice(0, 2), ['journal', 'about']);
		assert.equal((s.redirects ?? []).length, 0, 'no redirect');
		const filesAfter = await page.evaluate(async () => ((await (await fetch('/_caracms/documents')).json()) as { file: string }[]).map((d) => d.file).sort());
		assert.deepEqual(filesAfter, filesBefore, 'no file moved');
		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]');
		assert.deepEqual((await sideOrder(page)).slice(0, 3), ['Home', 'Journal', 'About']);
		await page.close();
	});

	test('a new group filled and a group renamed (checks 5, 6, 7, 8): every address, one tick, Apply lands it', async () => {
		const page = await open();
		await arrange(page);
		// New group "Company": at the end of the top level, empty, Review… off with the reason.
		await page.click('[data-act="new-group"]');
		await page.fill('#ng-in', 'Company');
		assert.equal((await page.textContent('#ng-addr'))!.trim(), '/company/');
		await page.press('#ng-in', 'Enter');
		await page.waitForSelector(row('new:1'));
		assert.match((await page.textContent(`${row('new:1')}`))!, /New group/);
		assert.ok(await page.locator(`${row('new:1')}.is-empty`).count());
		assert.equal(await page.isDisabled(`${PANE} [data-act="review"]`), true);
		assert.match((await page.textContent('#rv-why'))!, /Company is empty: add a page to it or remove it\./);
		// About (Team comes with it) into Company.
		await drag(page, 'about', 'new:1', 'mid');
		await page.waitForSelector(`${row('new:1')}:not(.is-empty)`);
		assert.equal(await page.isDisabled(`${PANE} [data-act="review"]`), false);
		// Rename Services → Offerings, inline.
		await page.hover(row('services'));
		await page.click(`${row('services')} [data-act="rename"]`);
		await page.fill('#rn-in', 'Offerings');
		assert.equal((await page.textContent('#rn-addr'))!.trim(), '/offerings/');
		await page.click('#rn-ok');
		await page.waitForSelector(`${row('services')} .chip.select`);
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} .rv`);
		const text = await reviewText(page);
		for (const [a, b] of [
			['/about', '/company/about'],
			['/about/team', '/company/about/team'],
			['/services/branding', '/offerings/branding'],
			['/services/print', '/offerings/print'],
			['/services/websites', '/offerings/websites'],
		]) {
			assert.ok(text.includes(`${a}→becomes${b}`), `${a} → ${b} in: ${text}`);
		}
		assert.equal(await page.isChecked('#rv-tick'), true, 'one tick, ticked to start with');
		assert.equal(await page.locator('#rv-tick').count(), 1);
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${DOCS}:not([hidden]) [data-act="open-arrange"]`);
		await eventually(() => exists('content/pages/company/about/team.json') && exists('content/pages/offerings/branding.json'), 8000, 'the files moved');
		assert.equal(exists('content/pages/about.json'), false);
		const from = (settings().redirects ?? []).map((r) => `${r.from} ${r.to}`);
		assert.ok(from.includes('/about/team /company/about/team'), from.join('\n'));
		assert.ok(from.includes('/services/branding /offerings/branding'), from.join('\n'));
		await page.close();
	});

	test('the last page out of a group (check 8); Cancel and Back ask first and write nothing (check 18)', async () => {
		write('content/pages/studio/visit.json', site.read('content/pages/visit.json'));
		remove('content/pages/visit.json');
		const before = site.read('content/site-settings.json');
		const page = await open();
		await arrange(page);
		await drag(page, 'studio/visit', 'contact', 'top');
		await page.waitForSelector(`${row('studio')}.is-gone`);
		assert.match((await page.textContent(`${PANE} .chg`))!, /Studio goes: no pages left in it/);
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} [data-review="gone"]`);
		assert.match(await reviewText(page), /Studio goes: no pages left in it/);
		// Back to arranging. A new group left empty turns Review… off with the reason; removing it turns it on again.
		await page.click(`${PANE} [data-act="back"]`);
		await page.click('[data-act="new-group"]');
		await page.fill('#ng-in', 'Later');
		await page.press('#ng-in', 'Enter');
		await page.waitForSelector(`${row('new:1')}.is-empty`);
		assert.equal(await page.isDisabled(`${PANE} [data-act="review"]`), true);
		assert.match((await page.textContent('#rv-why'))!, /Later is empty: add a page to it or remove it\./);
		assert.match((await page.textContent('[data-sub="empty"]'))!, /Empty: add a page or remove it/);
		await page.click('[data-sub="empty"] [data-act="remove-group"]');
		await page.waitForSelector(row('new:1'), { state: 'detached' });
		assert.equal(await page.isDisabled(`${PANE} [data-act="review"]`), false);
		// Then Cancel: it asks; Keep arranging keeps it.
		await page.click(`${PANE} [data-act="cancel"]`);
		await page.waitForSelector('[data-dialog="arrange-leave"]');
		await page.click('[data-act="leave-stay"]');
		assert.equal(await page.locator('[data-dialog="arrange-leave"]').count(), 0);
		// The browser's Back: it stays, and asks.
		await page.goBack();
		await page.waitForSelector('[data-dialog="arrange-leave"]');
		assert.equal(new URL(page.url()).pathname, '/admin/arrange');
		await page.click('[data-act="leave-go"]');
		await page.waitForSelector(PANE, { state: 'detached' });
		assert.equal(new URL(page.url()).pathname, '/admin', 'back where it came from');
		assert.equal(site.read('content/site-settings.json'), before, 'nothing written');
		assert.ok(exists('content/pages/studio/visit.json'));
		await page.close();
	});

	test('clashes (checks 8a, 9): refused at the drop and at the name; a page beside a group with its slug joins it', async () => {
		write('content/pages/visit/team.json', page_('Team'));
		write('content/pages/about/services.json', page_('Services'));
		const page = await open();
		await arrange(page);
		await drag(page, 'visit/team', 'about', 'mid', true);
		await page.waitForSelector(`${row('about')}.is-refused`);
		assert.match((await page.textContent(`${row('about')} .arow-why`))!, /There’s already a page called Team here/);
		await page.mouse.up();
		// New group named like a sibling group: refused, with the reason.
		await page.click('[data-act="new-group"]');
		await page.fill('#ng-in', 'Services');
		assert.match((await page.textContent('#ng-sub'))!, /There’s already a group called Services here\./);
		assert.equal(await page.isDisabled('#ng-ok'), true);
		await page.click('[data-act="ng-cancel"]');
		// A page called Services beside the group Services: it becomes the group's own page.
		await drag(page, 'about/services', 'contact', 'top', true);
		await page.waitForSelector('#amark:not([hidden])');
		assert.match((await page.textContent('#amark .tag'))!, /Becomes Services’s own page/);
		await page.mouse.up();
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} [data-review="joined"]`);
		assert.match(await reviewText(page), /Services becomes Services’s own page/);
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${DOCS}:not([hidden]) [data-act="open-arrange"]`);
		await eventually(() => exists('content/pages/services.json'), 8000, 'the page moved');
		assert.ok(exists('content/pages/services/branding.json'), 'the group’s pages stay under it');
		await page.close();
	});

	test('a holder moves with its documents as one count line (check 10)', async () => {
		const page = await open();
		await arrange(page);
		await drag(page, 'journal', 'about', 'mid');
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} [data-review="held"]`);
		assert.match((await page.textContent(`${PANE} [data-review="held"]`))!, /and its 3 journal entries/);
		assert.equal(await page.locator(`${PANE} .rv-docs`).count(), 0);
		await page.click(`${PANE} [data-review="held"] .rv-more`);
		assert.equal(await page.locator(`${PANE} .rv-docs li`).count(), 3);
		assert.match((await page.textContent(`${PANE} .rv-docs`))!, /\/about\/journal\//);
		await page.close();
	});

	test('the Apply refused (check 12): re-planned on the listing as it is, the change named', async () => {
		const page = await open();
		await arrange(page);
		await page.click('[data-act="new-group"]');
		await page.fill('#ng-in', 'Company');
		await page.press('#ng-in', 'Enter');
		await drag(page, 'about', 'new:1', 'mid');
		await drag(page, 'contact', 'new:1', 'mid');
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} .rv`);
		// Since the review: Contact deleted, and a page made where About would land.
		remove('content/pages/contact.json');
		write('content/pages/company/about.json', page_('About us'));
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${PANE} [data-note="arrange-underneath"]`, { timeout: 10000 });
		const note = (await page.textContent(`${PANE} [data-note="arrange-underneath"]`))!;
		assert.match(note, /Contact was deleted since you opened this\./);
		assert.match(note, /About us was added at \/company\/about, where About would go/);
		assert.equal(await page.isDisabled(`${PANE} [data-act="apply"]`), true, 'two pages at one address: arrange again first');
		assert.ok(exists('content/pages/about.json'), 'nothing was applied');
		await page.close();
	});

	test('the Apply refused (check 12): a post added under a moved holder since the review', async () => {
		const page = await open();
		await arrange(page);
		await drag(page, 'journal', 'about', 'mid');
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} [data-review="held"]`);
		const post = (await page.evaluate(async () => ((await (await fetch('/_caracms/documents')).json()) as { collection: string; file: string }[]).find((d) => d.collection === 'journal')!.file))!;
		write('content/journal/the-new-letterpress.json', site.read(post));
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${PANE} [data-note="arrange-underneath"]`, { timeout: 10000 });
		assert.match((await page.textContent(`${PANE} [data-note="arrange-underneath"]`))!, /Journal has a new journal entry since you opened this, so 4 journal entries move with it\./);
		assert.match((await page.textContent(`${PANE} [data-review="held"]`))!, /and its 4 journal entries/);
		assert.match((await page.textContent(`${PANE} [data-review="held"]`))!, /1 added since/);
		assert.equal(await page.locator(`${PANE} .rv-docs li.is-new`).count(), 1, 'the new one marked in the open list');
		assert.ok(exists('content/pages/journal.json'), 'nothing was applied');
		// Apply again: it lands, the new post with the rest.
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${DOCS}:not([hidden]) [data-act="open-arrange"]`);
		await eventually(() => exists('content/pages/about/journal.json'), 8000, 'the holder moved');
		await page.close();
	});

	test('the Apply refused (check 12): a page added inside a renamed group since the review', async () => {
		const page = await open();
		await arrange(page);
		await page.hover(row('services'));
		await page.click(`${row('services')} [data-act="rename"]`);
		await page.fill('#rn-in', 'Offerings');
		await page.click('#rn-ok');
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} .rv`);
		write('content/pages/services/kitchen-pottery.json', page_('Kitchen pottery'));
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${PANE} [data-note="arrange-underneath"]`, { timeout: 10000 });
		assert.match((await page.textContent(`${PANE} [data-note="arrange-underneath"]`))!, /Kitchen pottery was added under Offerings since you opened this\./);
		assert.ok((await reviewText(page)).includes('/services/kitchen-pottery→becomes/offerings/kitchen-pottery'), 'the new page moves with its group');
		assert.ok(exists('content/pages/services/branding.json'), 'nothing was applied');
		// Apply again: the whole group lands, the new page with it.
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${DOCS}:not([hidden]) [data-act="open-arrange"]`);
		await eventually(() => exists('content/pages/offerings/kitchen-pottery.json') && !exists('content/pages/services/kitchen-pottery.json'), 8000, 'the group moved whole');
		await page.close();
	});

	test('under a hidden page it will be hidden, out of it shown (check 16)', async () => {
		const visit = JSON.parse(site.read('content/pages/visit.json')) as Record<string, unknown>;
		write('content/pages/visit.json', `${JSON.stringify({ ...visit, hidden: true }, null, 2)}\n`);
		const page = await open();
		await arrange(page);
		assert.ok(await page.locator(`${row('visit')} .hmark`).count(), 'a hidden page is marked');
		await drag(page, 'contact', 'visit', 'mid');
		await page.waitForSelector(`${row('contact')} .chip.warn`);
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} .rv`);
		assert.match(await reviewText(page), /Contact\s*Will be hidden/);
		await page.click(`${PANE} [data-act="apply"]`);
		await page.waitForSelector(`${DOCS}:not([hidden]) [data-act="open-arrange"]`);
		await eventually(() => exists('content/pages/visit/contact.json'), 8000, 'the page moved');
		assert.equal((await fetch(`${site.origin}/visit/contact`)).status, 404);
		await arrange(page);
		await drag(page, 'visit/contact', 'work', 'top');
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} .rv`);
		assert.match(await reviewText(page), /Contact\s*Will be shown/);
		await page.close();
	});

	test('a page hidden itself, under a hidden page, stays hidden out of it: no "will be shown" (check 16)', async () => {
		write('content/pages/privacy.json', page_('Privacy', { hidden: true }));
		write('content/pages/privacy/faq.json', page_('Questions', { hidden: true }));
		const page = await open();
		await arrange(page);
		await drag(page, 'privacy/faq', 'contact', 'top');
		await page.waitForSelector(`${row('privacy/faq')} .chip.select`);
		assert.equal(await page.locator(`${row('privacy/faq')} .chip.live`).count(), 0, 'no "Will be shown" on the row');
		assert.equal(await page.getAttribute(`${row('privacy/faq')} .hmark`, 'title'), 'Hidden from the site');
		await page.click(`${PANE} [data-act="review"]`);
		await page.waitForSelector(`${PANE} .rv`);
		const text = await reviewText(page);
		assert.doesNotMatch(text, /will be shown/i, text);
		await page.close();
	});

	test('a new group holding only a group that goes is empty, and Review… stays off; a group that goes offers no Rename…', async () => {
		write('content/pages/studio/visit.json', site.read('content/pages/visit.json'));
		remove('content/pages/visit.json');
		const page = await open();
		await arrange(page);
		await page.click('[data-act="new-group"]');
		await page.fill('#ng-in', 'Company');
		await page.press('#ng-in', 'Enter');
		await page.waitForSelector(`${row('new:1')}.is-empty`);
		await drag(page, 'studio', 'new:1', 'mid');
		await page.waitForSelector(`${row('new:1')}:not(.is-empty)`);
		await drag(page, 'studio/visit', 'contact', 'top');
		await page.waitForSelector(`${row('studio')}.is-gone`);
		await page.waitForSelector(`${row('new:1')}.is-empty`);
		assert.equal(await page.isDisabled(`${PANE} [data-act="review"]`), true);
		assert.match((await page.textContent('#rv-why'))!, /Company is empty: add a page to it or remove it\./);
		// Studio goes: no Rename… on it, by hover or by focus; Company, new, still has one.
		await page.hover(row('studio'));
		assert.equal(await page.locator(`${row('studio')} [data-act="rename"]`).count(), 0);
		assert.equal(await page.locator(`${row('new:1')} [data-act="rename"]`).count(), 1);
		await page.close();
	});

	test('Back with something arranged, then Leave: the history is as a plain Back leaves it', async () => {
		const page = await open();
		await page.goto(`${site.origin}/admin/pages/about`);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
		await arrange(page);
		await drag(page, 'contact', 'about', 'top');
		await page.goBack();
		await page.waitForSelector('[data-dialog="arrange-leave"]');
		await page.click('[data-act="leave-go"]');
		await page.waitForSelector(PANE, { state: 'detached' });
		await eventually(() => new URL(page.url()).pathname === '/admin/pages/about', 5000, 'back on About');
		// One more Back goes where it came from before About, not to About again.
		await page.goBack();
		await eventually(() => new URL(page.url()).pathname === '/admin', 8000, `back at /admin (at ${page.url()})`);
		await page.close();
	});

	test('Keep arranging puts focus back on the control that opened the leave dialog, or on Cancel', async () => {
		const page = await open();
		await arrange(page);
		await drag(page, 'contact', 'about', 'top');
		await page.click(`${PANE} [data-act="cancel"]`);
		await page.waitForSelector('[data-dialog="arrange-leave"]');
		await page.click('[data-act="leave-stay"]');
		await page.waitForSelector('[data-dialog="arrange-leave"]', { state: 'detached' });
		await eventually(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.act === 'cancel'), 3000, 'focus on Cancel');
		// Opened by the browser's Back, no control opened it: focus goes to Cancel, not the page body.
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await page.goBack();
		await page.waitForSelector('[data-dialog="arrange-leave"]');
		await page.keyboard.press('Escape');
		await page.waitForSelector('[data-dialog="arrange-leave"]', { state: 'detached' });
		await eventually(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.act === 'cancel'), 3000, 'focus on Cancel after Back');
		await page.close();
	});

	test('at 1,024px, names and marks are cut short beside the address, never over it', async () => {
		const page = await open('/admin', { width: 1024, height: 800 });
		await arrange(page);
		await page.click('[data-act="new-group"]');
		await page.fill('#ng-in', 'Company');
		await page.press('#ng-in', 'Enter');
		await page.waitForSelector(row('new:1'));
		await drag(page, 'journal', 'new:1', 'mid');
		await drag(page, 'about', 'new:1', 'mid');
		await page.hover(row('services'));
		await page.click(`${row('services')} [data-act="rename"]`);
		await page.fill('#rn-in', 'Offerings and everything else we do');
		await page.click('#rn-ok');
		await page.waitForSelector(`${row('services')} .chip.select`);
		const overlaps = await page.$$eval(`${TREE} .arow`, (rows) =>
			rows.flatMap((r) => {
				// Where the name cell's content shows to: each piece's right edge, cut at any box that clips it.
				const cell = r.querySelector('.an')!;
				const shown = (e: Element) => {
					let right = e.getBoundingClientRect().right;
					for (let up: Element | null = e.parentElement; up && up !== r; up = up.parentElement) {
						if (getComputedStyle(up).overflowX !== 'visible') right = Math.min(right, up.getBoundingClientRect().right);
					}
					return right;
				};
				const an = { right: Math.max(cell.getBoundingClientRect().right, ...[...cell.querySelectorAll('*')].map(shown)) };
				const aa = r.querySelector('.aa')?.getBoundingClientRect();
				const ae = r.querySelector('.ae')?.getBoundingClientRect();
				const bad = (aa && an.right > aa.left + 0.5) || (aa && ae && aa.right > ae.left + 0.5);
				return bad ? [`${(r as HTMLElement).dataset.id}: name ends ${an.right}, address ${aa?.left}–${aa?.right}, end ${ae?.left}`] : [];
			}),
		);
		assert.deepEqual(overlaps, []);
		const cut = await page.$eval(`${row('services')} .nm`, (e) => ({ overflow: getComputedStyle(e).textOverflow, clipped: e.scrollWidth > e.clientWidth }));
		assert.equal(cut.overflow, 'ellipsis');
		await page.close();
	});
});
