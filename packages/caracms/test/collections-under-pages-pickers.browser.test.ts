// Collections under pages, the rest of the editor's screens (checks 3, 4, 10, 12, 13), on a throwaway
// copy of the demo (helpers/dev-site.ts) under `astro dev`, local mode, then live memory mode:
//
//   check 4         the link popover offers a post at its holder's address, and follows the holder when its file
//                   is renamed on disk, with no restart
//   check 3         the sidebar entry of a held collection no page holds carries the sentence, its documents have no address
//   check 13        a hidden holder's posts are not offered by the link popover; unhidden, they are again
//   check 12        a route of the site's own code under the old address is a warning in the dialog; the move goes ahead
//   check 10        live mode: the tick shows for the first move, and once everything has moved since the last Publish
//                   there is no tick and no redirect
//
//   node --test --experimental-strip-types test/collections-under-pages-pickers.browser.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { AOIFE, eventually as liveEventually, openAdmin, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

let site: DevSite;
let browser: Browser;
const BLOCK = '[data-pane-level="block"]';
const SHOWN = '.side-level:not([hidden])';
const DOCS = '[data-pane-level="documents"]';
const POST = '/journal/notes-from-the-ridge';

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

/** The addresses the link popover offers for `query`, on Home's second block (a text block with a rich-text body). */
async function offered(query: string, wanted?: string): Promise<string[]> {
	const page = await open('/admin');
	try {
		await page.click('[data-pane-level="document"] .blist .brow-main >> nth=1');
		const body = `${BLOCK} [data-rich-text="body"] [contenteditable="true"]`;
		await page.waitForSelector(body);
		await page.click(body);
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('ControlOrMeta+k');
		const find = `${BLOCK} [data-rich-text="body"] .lpop [data-link-find]`;
		await page.waitForSelector(find);
		await page.fill(find, query);
		if (wanted) await page.waitForSelector(`${BLOCK} .lpop .drow[data-href="${wanted}"]`, { timeout: 8000 }).catch(() => {});
		else await page.waitForTimeout(1200);
		return await page.$$eval(`${BLOCK} .lpop .drow[data-href]`, (rows) => rows.map((r) => r.getAttribute('data-href')!));
	} finally {
		await page.close();
	}
}

const listed = (page: Page) => page.evaluate(async () => (await (await fetch('/_caracms/documents')).json()) as { collection: string; path: string; url: string | null }[]);

describe('collections under pages: the link popover and holder problems, local mode', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('collections-under-pages-pickers');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('the link popover offers a post at its holder\'s address, and follows the holder when its file is renamed on disk (check 4)', async () => {
		assert.ok((await offered('ridge', POST)).includes(POST), 'at /journal/…');
		// The holder moves by hand: no restart.
		renameSync(join(site.root, 'content/pages/journal.json'), join(site.root, 'content/pages/blog.json'));
		const gone = await offered('ridge', '/blog/notes-from-the-ridge');
		assert.ok(gone.includes('/blog/notes-from-the-ridge'), gone.join(', '));
		assert.ok(!gone.includes(POST), 'the old address is not offered');
		const page = await open('/admin');
		assert.equal((await listed(page)).find((d) => d.collection === 'journal' && d.path === 'notes-from-the-ridge')?.url, '/blog/notes-from-the-ridge');
		await page.close();
		renameSync(join(site.root, 'content/pages/blog.json'), join(site.root, 'content/pages/journal.json'));
	});

	test('a hidden holder\'s posts are not offered; unhidden, they are again (check 13)', async () => {
		const file = join(site.root, 'content/pages/journal.json');
		const original = site.read('content/pages/journal.json');
		try {
			writeFileSync(file, original.replace('"title": "Journal",', '"title": "Journal",\n  "hidden": true,'));
			const hidden = await offered('ridge');
			assert.ok(!hidden.includes(POST), hidden.join(', '));
		} finally {
			writeFileSync(file, original);
		}
		assert.ok((await offered('ridge', POST)).includes(POST), 'back once unhidden');
	});

	test('no page holds the Journal: its sidebar entry carries the sentence and its documents have no address (check 3)', async () => {
		const file = join(site.root, 'content/pages/journal.json');
		const original = site.read('content/pages/journal.json');
		try {
			writeFileSync(file, original.replace('  "holds": "journal",\n', ''));
			const page = await open('/admin');
			await page.click('[data-pane-level="document"] .cur .ib.boxed');
			const why = `${DOCS} [data-why="coll-journal"]`;
			await page.waitForSelector(why);
			const text = (await page.textContent(why))!;
			assert.match(text, /Journal has no addresses/);
			assert.match(text, /No page holds Journal, so its documents have no addresses and aren't on the site\. Add "holds": "journal" to the page they go under\./);
			// Still a collection with a table: it opens.
			await page.click(`${DOCS} .drow.coll[data-coll="journal"]`);
			await page.waitForSelector('[data-doc="journal/notes-from-the-ridge"]');
			const after = await listed(page);
			assert.equal(after.find((d) => d.collection === 'journal')?.url, null, 'its documents have no address');
			await page.close();
		} finally {
			writeFileSync(file, original);
		}
		const page = await open('/admin');
		await page.click('[data-pane-level="document"] .cur .ib.boxed');
		await eventually(async () => (await page.locator(`${DOCS} [data-why="coll-journal"]`).count()) === 0, 8000, 'the sentence clears when a page holds it again');
		await page.close();
	});
});

describe('collections under pages: a route of the site\'s own code under the old address (check 12)', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('collections-under-pages-route', {
			edit: (root) => {
				mkdirSync(join(root, 'src/pages/journal'), { recursive: true });
				writeFileSync(join(root, 'src/pages/journal/feed.xml.ts'), "export const GET = () => new Response('<feed/>', { headers: { 'content-type': 'application/xml' } });\n");
			},
		});
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('the dialog warns, naming the file; Move goes ahead and the route stays where it is', async () => {
		const page = await open('/admin/pages/journal');
		await page.click(`${SHOWN} [data-act="doc-menu"]`);
		await page.click('[data-act="move-document"]');
		await page.waitForSelector('[data-dialog="move"] [data-moving]');
		await page.fill('#mv-part', 'blog');
		const warning = await page.waitForSelector('[data-dialog="move"] [data-routes]');
		assert.match((await warning.textContent())!, /src\/pages\/journal\/feed\.xml\.ts is the site’s own code under \/journal, so it stays where it is\./);
		await page.click('[data-dialog="move"] [data-act="confirm-move"]');
		await eventually(() => new URL(page.url()).pathname === '/admin/pages/blog', 10_000, 'it opens at its new address');
		assert.ok(existsSync(join(site.root, 'content/pages/blog.json')) && !existsSync(join(site.root, 'content/pages/journal.json')));
		assert.ok(existsSync(join(site.root, 'src/pages/journal/feed.xml.ts')), 'the route stays');
		assert.equal((await listed(page)).find((d) => d.collection === 'journal' && d.path === 'notes-from-the-ridge')?.url, '/blog/notes-from-the-ridge');
		await page.close();
	});
});

describe('collections under pages: the tick in live mode (check 10)', { skip: browserSkip }, () => {
	let live: LiveSite;
	before(async () => {
		live = await startLiveSite('collections-under-pages-live', {});
		site = live.site;
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
	});

	test('the first move offers "Leave redirects from the old addresses"; moved again before a Publish, nothing of it was ever live, so there is no tick and no redirect', async () => {
		const a = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/pages/journal');
		const dialog = '[data-dialog="move"]';
		const openMove = async () => {
			await a.click(`${SHOWN} [data-act="doc-menu"]`);
			await a.click('[data-act="move-document"]');
			await a.waitForSelector(`${dialog} [data-moving]`);
		};
		await openMove();
		await a.fill('#mv-part', 'blog');
		assert.match((await a.textContent(`${dialog} label.check`))!, /Leave redirects from the old addresses/);
		assert.equal(await a.isChecked('#mv-redirect'), true);
		await a.click(`${dialog} [data-act="confirm-move"]`);
		await liveEventually(() => new URL(a.url()).pathname === '/admin/pages/blog', 15_000, 'it opens at /blog');
		const settings = () => a.evaluate(async () => ((await (await fetch('/_caracms/document?collection=settings&path=site-settings')).json()) as { text: string }).text);
		assert.match(await settings(), /\{ "from": "\/journal\/notes-from-the-ridge", "to": "\/blog\/notes-from-the-ridge" \}/);

		// Blog and its posts were all live a minute ago: the redirects from them are already there, so a second move
		// before a Publish has no live address of its own to leave one from.
		await openMove();
		await a.fill('#mv-part', 'notes');
		assert.equal(await a.locator(`${dialog} label.check`).count(), 0, 'no tick');
		await a.click(`${dialog} [data-act="confirm-move"]`);
		await liveEventually(() => new URL(a.url()).pathname === '/admin/pages/notes', 15_000, 'it opens at /notes');
		const text = await settings();
		assert.doesNotMatch(text, /"from": "\/blog\/notes-from-the-ridge"/, 'no redirect from the in-between address');
		assert.match(text, /\{ "from": "\/journal\/notes-from-the-ridge", "to": "\/notes\/notes-from-the-ridge" \}/, 'the first redirect follows the move');
		await a.context().close();
	});
});
