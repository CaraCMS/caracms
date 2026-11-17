// Collections under pages, carrier B: the editor's three new bits and Change address… taking
// everything under a page, on a throwaway copy of the demo (helpers/dev-site.ts), local mode.
//
//   Decision 4 / check 6    the Pages tree: a row under Journal and under Work, name and count, opening the table
//   Decision 5 / check 7    "Holds Journal (3)" in the holder's settings group, with no control
//   Decision 12 / check 14  Delete… on a holder says why it can't, instead of asking
//   Decision 8 / check 8    New page under Journal at a post's address: address-taken, naming the post
//   Decision 9 / check 10a  Change address… on About lists About and Team, and moves both
//   Decision 9 / check 10   Change address… on Journal lists every post, moves them all, the row follows
//   Decision 11 / check 13  the holder hidden: the table marks its posts "Hidden: Journal is hidden" (Change address… keeps its title)
//
//   node --test --experimental-strip-types test/collections-under-pages.browser.test.ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;
const SHOWN = '.side-level:not([hidden])';
const DOCS = '[data-pane-level="documents"]';

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

const exists = (file: string) => existsSync(join(site.root, file));
const redirects = () => (JSON.parse(site.read('content/site-settings.json')) as { redirects?: { from: string; to: string }[] }).redirects ?? [];
const listed = (page: Page) => page.evaluate(async () => (await (await fetch('/_caracms/documents')).json()) as { collection: string; path: string; url: string | null; hidden?: true }[]);

describe('collections under pages: the editor, local mode', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('collections-under-pages');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('the tree row (check 6), the Holds line (check 7) and Delete… refused (check 14)', async () => {
		const page = await open('/admin/pages/journal');
		// The Holds line, beside Hidden, with nothing to click.
		await page.waitForSelector(`${SHOWN} .page-holds[data-holds="journal"]`);
		assert.equal((await page.textContent(`${SHOWN} .page-holds`))!.trim(), 'Holds Journal (3)');
		assert.equal(await page.locator(`${SHOWN} .page-holds button, ${SHOWN} .page-holds input`).count(), 0);

		// Delete… says why it can't.
		await page.click(`${SHOWN} [data-act="doc-menu"]`);
		await page.click('[data-act="delete-document"]');
		await page.waitForSelector('[data-dialog="holds"]');
		assert.match((await page.textContent('[data-dialog="holds"]'))!, /Journal holds the journal entries\. Delete the “holds” line in its file, or move the journal entries to another page, first\./);
		assert.equal(await page.locator('[data-act="confirm-delete"]').count(), 0, 'nothing to confirm');
		await page.click('[data-act="holds-ok"]');

		// The tree: a row under Journal and under Work, the collection still in the sidebar list, no post in the tree.
		await page.click('[data-pane-level="document"] .cur .ib.boxed');
		const row = `${DOCS} [data-held="journal"]`;
		await page.waitForSelector(row);
		assert.deepEqual([(await page.textContent(`${row} .nm`))!.trim(), (await page.textContent(`${row} .cnt`))!.trim()], ['Journal', '3']);
		assert.equal((await page.textContent(`${DOCS} [data-held="case-studies"] .cnt`))!.trim(), '6');
		const order = await page.$$eval(`${DOCS} [data-collection="pages"] .tnode`, (ns) => ns.map((n) => n.querySelector('[data-held]')?.getAttribute('data-held') ?? n.querySelector('[data-doc]')?.getAttribute('data-doc') ?? ''));
		assert.equal(order[order.indexOf('pages/journal') + 1], 'journal', `the first row under Journal: ${order.join(', ')}`);
		assert.equal(await page.locator(`${DOCS} .drow.coll[data-coll="journal"]`).count(), 1, 'still in the sidebar list');
		assert.equal(await page.locator(`${DOCS} [data-collection="pages"] [data-doc^="journal/"]`).count(), 0, 'no post in the tree');
		// A page under Journal at a post's address is refused before asking, naming the post (check 8).
		await page.click(`${DOCS} [data-act="new-page"]`);
		await page.waitForSelector('[data-dialog="new"]');
		await page.click('#np-inside');
		await page.click('[data-inside-pick="journal"]');
		await page.fill('#np-name', 'Notes from the Ridge');
		assert.match((await page.textContent('#np-err'))!, /There's already a page at \/journal\/notes-from-the-ridge: “Notes from the Ridge” in Journal\./);
		await page.keyboard.press('Escape');
		await page.click(row);
		await page.waitForSelector('[data-doc="journal/notes-from-the-ridge"]');
		await page.close();
	});

	test('Change address… on About (check 10a): it lists About and Team, moves both, and no About group is left', async () => {
		const page = await open('/admin/pages/about');
		await page.click(`${SHOWN} [data-act="doc-menu"]`);
		await page.click('[data-act="move-document"]');
		await page.waitForSelector('[data-dialog="move"] [data-moving="2"]');
		await page.fill('#mv-part', 'who-we-are');
		assert.match((await page.textContent('[data-dialog="move"] [data-moving]'))!, /Its 1 page moves with it\./);
		assert.deepEqual(await page.$$eval('[data-dialog="move"] .mv-list li', (ls) => ls.map((l) => l.textContent)), ['/who-we-are', '/who-we-are/team']);
		assert.match((await page.textContent('[data-dialog="move"] label.check'))!, /Leave redirects from the old addresses/);
		assert.equal(await page.isChecked('#mv-redirect'), true);
		await page.click('[data-dialog="move"] [data-act="confirm-move"]');
		await eventually(() => new URL(page.url()).pathname === '/admin/pages/who-we-are', 10_000, 'it opens at its new address');
		assert.ok(exists('content/pages/who-we-are.json') && exists('content/pages/who-we-are/team.json'));
		assert.ok(!exists('content/pages/about.json') && !exists('content/pages/about'), 'no About page or group left');
		assert.ok(redirects().some((r) => r.from === '/about/team' && r.to === '/who-we-are/team'), JSON.stringify(redirects()));
		await page.close();
	});

	test('Change address… on Journal (check 10): every post moves, the row follows, and hiding it marks its posts, naming it (check 13)', async () => {
		const page = await open('/admin/pages/journal');
		await page.click(`${SHOWN} [data-act="doc-menu"]`);
		await page.click('[data-act="move-document"]');
		await page.waitForSelector('[data-dialog="move"] [data-moving="4"]');
		await page.fill('#mv-part', 'blog');
		assert.match((await page.textContent('[data-dialog="move"] [data-moving]'))!, /Its 3 journal entries move with it\./);
		// A short window: the list gives, and the buttons stay inside it (1024 × 480).
		await page.setViewportSize({ width: 1024, height: 480 });
		const fits = await page.evaluate(() => {
			const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
			return { dialog: box('[data-dialog="move"]').bottom, confirm: box('[data-dialog="move"] [data-act="confirm-move"]').bottom, list: box('[data-dialog="move"] .mv-list').height, height: window.innerHeight };
		});
		assert.ok(fits.dialog <= fits.height && fits.confirm <= fits.height, JSON.stringify(fits));
		assert.ok(fits.list >= 40, `the list keeps a couple of addresses: ${JSON.stringify(fits)}`);
		await page.setViewportSize({ width: 1440, height: 900 });
		const list = await page.$$eval('[data-dialog="move"] .mv-list li', (ls) => ls.map((l) => l.textContent));
		assert.equal(list[0], '/blog');
		assert.ok(list.includes('/blog/notes-from-the-ridge'), list.join(', '));
		await page.click('[data-dialog="move"] [data-act="confirm-move"]');
		await eventually(() => new URL(page.url()).pathname === '/admin/pages/blog', 10_000, 'it opens at its new address');
		const after = await listed(page);
		assert.equal(after.find((d) => d.collection === 'journal' && d.path === 'notes-from-the-ridge')?.url, '/blog/notes-from-the-ridge');
		assert.ok(exists('content/journal/notes-from-the-ridge.json'), 'the post\'s file stays');
		assert.ok(redirects().some((r) => r.from === '/journal/notes-from-the-ridge' && r.to === '/blog/notes-from-the-ridge'));

		// Hidden on: the posts are hidden with it, and the table names Blog.
		await page.click(`${SHOWN} #f-page-hidden-hidden`);
		await eventually(() => (JSON.parse(site.read('content/pages/blog.json')) as { hidden?: boolean }).hidden === true, 10_000, 'blog.json hidden');
		await page.click('[data-pane-level="document"] .cur .ib.boxed');
		await page.waitForSelector(`${DOCS} [data-held="journal"]`);
		await page.click(`${DOCS} [data-held="journal"]`);
		const mark = 'tr[data-doc="journal/notes-from-the-ridge"] .hmark[data-mark="hidden"]';
		await page.waitForSelector(mark);
		assert.equal((await page.textContent(mark))!.trim(), 'Hidden: Journal is hidden', 'the page that hides it, to a screen reader');
		// The sidebar's short mark: the word on show, small and grey; the rest for a screen reader.
		assert.deepEqual(
			await page.$eval(mark, (el) => ({ shown: el.firstChild?.textContent?.trim(), sr: el.querySelector('.sr') !== null, size: getComputedStyle(el).fontSize })),
			{ shown: 'Hidden', sr: true, size: '11px' },
		);
		assert.equal(await page.getAttribute(mark, 'title'), 'Journal is hidden');
		// It doesn't widen the table: no sideways scroll at 1024 wide.
		await page.setViewportSize({ width: 1024, height: 768 });
		const scroll = await page.$eval('.ct-scroll', (el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
		assert.ok(scroll.scrollWidth <= scroll.clientWidth, JSON.stringify(scroll));
		await page.setViewportSize({ width: 1440, height: 900 });
		// The sidebar's row says it too, on hover.
		assert.equal(await page.getAttribute(`${SHOWN} .drow[data-doc="journal/notes-from-the-ridge"] .hmark`, 'title'), 'Journal is hidden');
		await page.close();
	});
});
