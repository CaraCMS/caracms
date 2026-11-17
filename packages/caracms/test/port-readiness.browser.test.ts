// M6c (port readiness) in a real browser, on a throwaway copy of the demo under `astro dev`
// (helpers/dev-site.ts, the pinned fixture's content) whose config is changed for these
// tests only (the demo itself is untouched):
//
// G2, page fields on a section builder (the journal gets `tagline` and `side`):
// 1. A journal entry shows "Journal entry details" under its blocks, above Search and
//    sharing. Typing the tagline writes it after `title`, before `blocks`; the rest of the
//    file keeps its text. The page component gets it as `data` (the preview shows it).
//
// G1, a collection with no pages of its own (a `team`, no urlBase, beside Case studies):
// 2. Its level says it has no pages of its own, with no Address column. New shows no
//    address and makes a file from the name; the document opens with no address in its
//    header, no Search and sharing, and a menu with Delete only; the preview renders it
//    through its component. A link's picker doesn't offer it.
//
// G8, help text (the text block, its heading, the journal's tagline, a credit's role):
// 3. A block's help sits at the top of its level, a field's under its label, an item
//    field's under its sub-label, a page field's in its group. None of it is on the page.
//
// G9, a link that's only an address (the text block gets `more: link({ addressOnly: true })`):
// 4. The field is where it goes alone (no Label box), written as `{ "href" }`; a `/path`
//    to no page says so, one to a page shows the page; never a half-link warning.
//
//   node --test --experimental-strip-types test/port-readiness.browser.test.ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { edit } from './helpers/port-site.ts';

let site: DevSite;
let browser: Browser;

const DOC = '[data-pane-level="document"]';

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

describe('M6c in the editor', { skip: browserSkip }, () => {
	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		site = await startDevSite('port-readiness', { edit });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
		delete process.env.CARACMS_MEDIA;
	});

	test('1. G2: a journal entry’s page fields sit under its blocks; the tagline is written before `blocks` and reaches the page component', { timeout: 60000 }, async () => {
		const FILE = 'content/journal/notes-from-the-ridge.json';
		const before = site.read(FILE);
		const page = await open('/admin/journal/notes-from-the-ridge');
		const group = page.locator(`${DOC} details.page-fields`);
		await group.waitFor();
		assert.match((await group.locator('summary').textContent()) ?? '', /Journal entry details/);
		assert.equal(await group.getAttribute('open'), '', 'open by default');
		// Under the blocks, above Search and sharing.
		const order = await page.$$eval(`${DOC} .side-body > *`, (els) => els.map((e) => e.className));
		const at = (c: string) => order.findIndex((x) => x.split(' ').includes(c));
		assert.ok(at('page-fields') > -1 && at('page-fields') < at('seo'), order.join(' | '));
		await group.locator('input[data-path="tagline"]').fill('Up on the ridge');
		await eventually(() => site.read(FILE).includes('Up on the ridge'), 10000, 'the tagline kept');
		const title = before.match(/\n {2}"title": [^\n]*\n/)![0];
		assert.equal(site.read(FILE), before.replace(title, `${title.slice(0, -1).replace(/,?$/, ',')}\n  "tagline": "Up on the ridge",\n`), 'after title, before blocks; the rest as it was');
		await page.frameLocator('.frame.on iframe').locator('[data-test-tagline]').filter({ hasText: 'Up on the ridge' }).waitFor({ timeout: 10000 });
		await page.close();
	});

	test('2. G1: a collection with no pages of its own: no address anywhere, Delete only, previewed through its component, not a link target', { timeout: 60000 }, async () => {
		const page = await open('/admin/team/aoife');
		await page.frameLocator('.frame.on iframe').locator('[data-test-person]').filter({ hasText: 'Aoife' }).waitFor({ timeout: 10000 });
		assert.doesNotMatch((await page.locator(`${DOC} .cur`).textContent()) ?? '', /localhost|127\.0\.0\.1/, 'no address in the header');
		assert.equal(await page.locator(`${DOC} details.seo`).count(), 0, 'no Search and sharing');
		await page.click(`${DOC} [data-act="doc-menu"]`);
		const items = await page.locator(`${DOC} .menu [role="menuitem"]`).allTextContents();
		assert.deepEqual(items.map((t) => t.trim()), ['Delete team entry…']);
		await page.keyboard.press('Escape');

		// Its collection: no pages, no Address column.
		await page.click(`${DOC} button[aria-label="Back to team"]`);
		const level = page.locator('[data-pane-level="collection"]');
		await level.waitFor({ timeout: 10000 });
		assert.match((await level.textContent()) ?? '', /Shown on other pages; no pages of their own/);
		const table = page.locator('[data-collection-table="team"]');
		await table.waitFor({ timeout: 10000 });
		assert.match((await table.textContent()) ?? '', /Last edited/);
		assert.doesNotMatch((await table.textContent()) ?? '', /Address|localhost|127\.0\.0\.1/, 'no Address column, no address under the name');
		await page.click('[data-pane-level="collection"] [data-act="new-document"]');
		const dialog = page.locator('[role="dialog"], dialog').first();
		await dialog.waitFor();
		assert.equal(await dialog.locator('[data-address]').count(), 0, 'no address in New');
		await dialog.locator('#np-name').fill('Seán Óg');
		await dialog.locator('[data-act="create"]').click();
		await eventually(() => existsSync(join(site.root, 'content/team/sean-og.json')), 10000, 'the new file');
		assert.equal(site.read('content/team/sean-og.json'), '{\n  "$schema": "../../schemas/team.schema.json",\n  "title": "Seán Óg"\n}\n');
		await page.close();

		// Listed with no URL, which the link pickers leave out (fields/parts.tsx → useLinkable, linkHits).
		const home = await open('/admin/pages/contact');
		const rows = await home.evaluate(async () => {
			const r = await fetch('/_caracms/documents', { headers: { Accept: 'application/json' } });
			const listed = (await r.json()) as { collection: string; url: string | null }[];
			return listed.filter((d) => d.collection === 'team');
		});
		assert.ok(rows.length >= 1 && rows.every((d) => d.url === null), 'listed with no URL, so no picker offers them');
		await home.close();
	});

	test('3. G8: help under a block’s level, a field’s label, an item field’s sub-label and a page field’s; never on the page', { timeout: 60000 }, async () => {
		const page = await open('/admin/pages/about');
		const textRow = page.locator(`${DOC} .blist .brow-main`).filter({ hasText: 'Text' }).first();
		await textRow.click();
		const block = page.locator('[data-pane-level="block"]');
		await block.locator('[data-block-help]').filter({ hasText: 'A heading and a few paragraphs, on a plain band.' }).waitFor();
		const heading = block.locator('.field-frame[data-ff="heading"]');
		assert.equal(await heading.locator('[data-help]').textContent(), 'Optional. The first heading on a page is its h1.');
		// Under the label, before the input.
		assert.deepEqual(await heading.locator('.field > *').evaluateAll((els) => els.map((e) => e.className || e.tagName)), ['field-head', 'field-help', 'input']);
		const frame = page.frameLocator('.frame.on iframe');
		assert.doesNotMatch((await frame.locator('body').textContent()) ?? '', /first heading on a page|a few paragraphs, on a plain band/);
		await page.close();

		const cs = await open('/admin/case-studies/high-street-coffee');
		await cs.locator(`${DOC} [data-list="credits"] .item-sum >> nth=0`).click();
		assert.equal(await cs.locator(`${DOC} [data-list="credits"] [data-row="0"] [data-help]`).textContent(), 'What they did, in a word or two.');
		await cs.close();

		const entry = await open('/admin/journal/notes-from-the-ridge');
		assert.equal(await entry.locator(`${DOC} details.page-fields .field-frame[data-ff="tagline"] [data-help]`).textContent(), 'Under the title on the journal cards.');
		await entry.close();
	});

	test('4. G9: an address-only link is where it goes alone: `{ "href" }` written, no half-link, a missing page said', { timeout: 60000 }, async () => {
		const FILE = 'content/pages/about.json';
		const page = await open('/admin/pages/about');
		await page.locator(`${DOC} .blist .brow-main`).filter({ hasText: 'Text' }).first().click();
		const field = page.locator('[data-pane-level="block"] .field-frame[data-ff="more"]');
		await field.waitFor();
		assert.equal(await field.locator('input[data-path="more.label"]').count(), 0, 'no Label box');
		// A /path to no page: kept, and said.
		await field.locator('input[data-path="more.href"]').fill('/nowhere');
		await field.locator('.lnk.is-missing').waitFor({ timeout: 8000 });
		await eventually(() => /"more": \{\n\s*"href": "\/nowhere"\n\s*\}/.test(site.read(FILE)), 10000, 'the href kept, as { "href" }');
		// An address that's a page: shown as the page.
		await field.locator('button[aria-label="Change where it goes"]').click();
		await field.locator('input[data-path="more.href"]').fill('/contact');
		await field.locator('.lnk-doc').filter({ hasText: 'Contact' }).waitFor({ timeout: 8000 });
		await eventually(() => /"more": \{\n\s*"href": "\/contact"\n\s*\}/.test(site.read(FILE)), 10000, 'the page kept');
		assert.equal(await field.locator('text=shows only once').count(), 0, 'never half a link');
		await page.close();
	});
});
