// Edit in context, the sidebar's lists and forms (carrier C). On a
// copy of the fixture (helpers/dev-site.ts) whose Site Settings has a phone, marked by its footer without
// its value (16a), with a body shared block, "Start a project", beside the slot footer (Acceptance 6).
// The tests run in order: the site starts with one footer, gets a second, and the second becomes the
// default. Headless Chromium from Playwright's cache, skipped without it.
//
//   node --test --experimental-strip-types test/edit-in-context-sidebar.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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

const DOC = '[data-pane-level="document"]';
const DOCS = '[data-pane-level="documents"]';
/** From any level to Shared blocks' own level: the documents tab, then its row. */
async function toShared(page: Page) {
	if (!(await page.isVisible(DOCS))) await page.click('.side-level:not([hidden]) .lv >> nth=0');
	await page.waitForSelector(DOCS, { state: 'visible' });
	await page.click(`${DOCS} .drow.coll[data-coll="shared"]`);
	await page.waitForSelector('[data-pane-level="collection"] #coll-list');
}
const pathname = (page: Page) => new URL(page.url()).pathname;
const file = (path: string) => join(site.root, 'content', path);
const readJson = (path: string) => JSON.parse(readFileSync(file(path), 'utf8')) as Record<string, unknown>;
/** The footer the visible frame draws: its shared block's source id. */
const footerShown = (page: Page) => page.evaluate(() => document.querySelector<HTMLIFrameElement>('.frame.on iframe')?.contentDocument?.querySelector('footer[data-cms-source]')?.getAttribute('data-cms-source') ?? null);

describe('edit in context: the sidebar\'s lists and forms', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('eic-sidebar', {
			edit(root) {
				const configFile = join(root, 'caracms.config.ts');
				const config = readFileSync(configFile, 'utf8')
					.replace("import { defineSite } from 'caracms/config';", "import { defineSite, text } from 'caracms/config';")
					.replace('export default defineSite({', "export default defineSite({\n\tsettings: { fields: { phone: text({ label: 'Phone' }) } },");
				writeFileSync(configFile, config);
				const footerFile = join(root, 'src/blocks/Footer.astro');
				writeFileSync(footerFile, readFileSync(footerFile, 'utf8').replace('<p class="footer-name">CaraCMS</p>', '<p class="footer-name">CaraCMS</p>\n\t\t<Block cms={cms.settings} field="phone" as="p" class="footer-phone">01 234 5678</Block>'));
				const settingsFile = join(root, 'content/site-settings.json');
				writeFileSync(settingsFile, readFileSync(settingsFile, 'utf8').replace('"title": "Site Settings",', '"title": "Site Settings",\n  "phone": "01 234 5678",'));
				writeFileSync(join(root, 'content/shared/start.json'), `${JSON.stringify({ title: 'Start a project', block: { type: 'cta', heading: 'Start a project', buttons: [] } }, null, 2)}\n`);
			},
		});
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('Acceptance 6 and 2: Shared blocks lists the Footer, then the rest by type; with one footer, no "Default" chip and no picker', async () => {
		const page = await open('/admin');
		await toShared(page);
		const groups = await page.$$eval('[data-pane-level="collection"] .grp[data-group]', (els) => els.map((e) => [e.getAttribute('data-group'), [...e.querySelectorAll('.drow .nm')].map((n) => n.textContent)]));
		assert.deepEqual(groups, [
			['footer', ['Footer']],
			['cta', ['Start a project']],
		]);
		assert.equal(await page.locator('[data-pane-level="collection"] [data-chip="default"]').count(), 0);
		assert.match((await page.textContent('[data-pane-level="collection"] .kb-hint[data-hint="shared-blocks"]')) ?? '', /A header or footer fills its place on every page by itself\. The rest are added to a page from Add a block, under Shared blocks\./);
		// The stage's table is grouped the same way.
		assert.deepEqual(await page.$$eval('[data-collection-table="shared"] tbody[data-group]', (els) => els.map((e) => e.getAttribute('data-group'))), ['footer', 'cta']);
		await page.click('[data-pane-level="collection"] .cur .ib.boxed');
		await page.click(`${DOCS} [data-doc="pages/index"]`);
		await page.waitForSelector(`${DOC} .blist`);
		assert.equal(await page.locator(`${DOC} [data-frame-picks]`).count(), 0, 'no picker with one footer');
		await page.close();
	});

	test('Decision 3: the Footer is the default, its switch on; it names where it\'s used; Decision 4: it also shows Site Settings\' Phone, and Open shows Site Settings over the page with the site\'s fields first (16, 16a)', async () => {
		const page = await open('/admin/shared/footer');
		await page.waitForSelector(`${DOC} [data-slot-default]`);
		assert.equal(await page.getAttribute(`${DOC} [data-slot-default] [role="switch"]`, 'aria-checked'), 'true');
		assert.match((await page.textContent(`${DOC} [data-note="used-on"] .used-in`)) ?? '', /^The default footer: every page that doesn't pick another, /);
		assert.match((await page.textContent(`${DOC} [data-note="used-on"] .used-in`)) ?? '', / and \d+ more$/);
		const also = `${DOC} [data-also-shows="settings"]`;
		await eventually(async () => /Also shows from Site Settings: Phone ·\s*Open/.test((await page.textContent(also).catch(() => '')) ?? ''), 10000, 'the Site Settings line');
		await page.click(`${also} [data-act="open-settings"]`);
		await eventually(() => pathname(page) === '/admin/settings', 8000, 'Site Settings opens');
		await eventually(async () => /open over Home/.test((await page.textContent(`${DOC} .cur .sub`).catch(() => '')) ?? ''), 8000, 'over Home');
		assert.equal(await page.locator('#stage.is-aside').count(), 0, 'never dimmed');
		const sections = await page.$$eval(`${DOC} .set-sec`, (els) => els.map((e) => e.getAttribute('data-section') ?? e.querySelector('h3')?.textContent));
		assert.equal(sections[0], 'site-settings', 'the site\'s own fields first');
		assert.equal(sections[1], 'Who can sign in');
		await page.close();
	});

	test('Acceptance 5: the add-block picker offers no slot type and no slot block, only the body\'s shared blocks', async () => {
		const page = await open('/admin');
		await page.waitForSelector(`${DOC} .blist`);
		await page.click(`${DOC} .add-row, ${DOC} [data-act="add-block"]`);
		await page.waitForSelector('[data-picker-at]');
		assert.equal(await page.locator('[data-picker-at] .ptype[data-type="footer"]').count(), 0);
		assert.ok((await page.locator('[data-picker-at] .ptype').count()) > 0);
		assert.deepEqual(await page.$$eval('[data-picker-at] [data-shared]', (els) => els.map((e) => e.getAttribute('data-shared'))), ['start']);
		await page.close();
	});

	test('Acceptance 17: the Cases block shows "Shows entries from Case studies (n)", Open goes there; the hero reads nothing', async () => {
		const page = await open('/admin');
		await page.waitForSelector(`${DOC} .blist`);
		const rows = await page.$$eval(`${DOC} .brow-main .nm`, (els) => els.map((e) => e.textContent?.trim() ?? ''));
		const cases = rows.findIndex((t) => /^Case-study list/.test(t));
		assert.ok(cases >= 0, `a Cases block on Home (${rows.join(', ')})`);
		await page.click(`${DOC} .brow-main >> nth=0`);
		await page.waitForSelector('[data-pane-level="block"]');
		assert.equal(await page.locator('[data-pane-level="block"] [data-reads]').count(), 0, 'the hero shows no row');
		await page.click('[data-pane-level="block"] .cur .ib.boxed');
		await page.click(`${DOC} .brow-main >> nth=${cases}`);
		await page.waitForSelector('[data-pane-level="block"]');
		const row = '[data-pane-level="block"] [data-reads] [data-read="case-studies"]';
		await eventually(async () => /Shows entries from Case studies \(\d+\)/.test((await page.textContent(row).catch(() => '')) ?? ''), 10000, 'the reads row');
		await page.click(`${row} button`);
		await page.waitForSelector('[data-pane-level="collection"] [data-collection="case-studies"]');
		await page.close();
	});

	test('Acceptance 2: with a second footer, every page with an address gets a Footer picker; picking changes that page only; clearing goes back', async () => {
		writeFileSync(file('shared/footer-dark.json'), `${JSON.stringify({ title: 'Footer — dark', block: { type: 'footer', address: 'Dark', email: '', links: [] } }, null, 2)}\n`);
		const page = await open('/admin');
		const picks = `${DOC} [data-frame-picks]`;
		await page.waitForSelector(picks);
		assert.match((await page.textContent(`${picks} [data-frame-pick="footer"] .lnk-box`)) ?? '', /Default: Footer/);
		// "Default" shows once the slot has two.
		await toShared(page);
		await page.waitForSelector('[data-pane-level="collection"] [data-doc="shared/footer"] [data-chip="default"]');
		assert.equal(await page.locator('[data-pane-level="collection"] [data-chip="default"]').count(), 1);
		await page.click('[data-pane-level="collection"] .cur .ib.boxed');
		await page.click(`${DOCS} [data-doc="pages/index"]`);
		await page.waitForSelector(picks);
		await page.click(`${picks} [data-frame-pick="footer"] button[aria-haspopup="listbox"]`);
		await page.click(`${picks} [data-frame-option="footer-dark"]`);
		await eventually(async () => (await footerShown(page)) === 'shared/footer-dark', 10000, 'Home draws the dark footer');
		await eventually(() => (readJson('pages/index.json').frame as Record<string, string> | undefined)?.footer === 'footer-dark', 8000, 'the pick kept');
		assert.equal(readJson('pages/about.json').frame, undefined, 'About doesn\'t change');
		await page.click(`${picks} [data-act="clear-frame"]`);
		await eventually(async () => (await footerShown(page)) === 'shared/footer', 10000, 'back to the default');
		await eventually(() => readJson('pages/index.json').frame === undefined, 8000, 'the pick removed');
		await page.close();
	});

	test('Acceptance 3 and 4: turning "Default footer" on moves the default; a page that picked the first keeps it; the default can\'t be deleted, nor one a page picks', async () => {
		const about = readJson('pages/about.json');
		writeFileSync(file('pages/about.json'), `${JSON.stringify({ ...about, frame: { footer: 'footer' } }, null, 2)}\n`);
		const page = await open('/admin/shared/footer-dark');
		await page.waitForSelector(`${DOC} [data-slot-default="off"]`);
		await page.click(`${DOC} [data-slot-default] [role="switch"]`);
		await page.waitForSelector(`${DOC} [data-slot-default="on"]`);
		await eventually(() => readJson('shared/footer-dark.json').default === true, 8000, 'the dark footer is the default');
		await eventually(() => readJson('shared/footer.json').default === undefined, 8000, 'the first isn\'t');
		assert.deepEqual(readJson('pages/about.json').frame, { footer: 'footer' }, 'About keeps its pick');
		// Deleting the default: refused, saying why.
		await page.click(`${DOC} [data-slot="page-menu"] > button`);
		await page.click('[data-act="delete-document"]');
		await page.waitForSelector('[data-dialog="is-default"]');
		assert.match((await page.textContent('[data-dialog="is-default"] #dlg-d')) ?? '', /Footer — dark is the default footer, so it can't be deleted\. Make another the default first\./);
		await page.click('[data-dialog="is-default"] .btn.ink');
		// The first footer: About picks it, so it's named.
		await page.goto(`${site.origin}/admin/shared/footer`);
		await page.waitForSelector(`${DOC} [data-slot-default="off"]`);
		assert.match((await page.textContent(`${DOC} [data-note="used-on"] .used-in`)) ?? '', /^Picked by About$/);
		await page.click(`${DOC} [data-slot="page-menu"] > button`);
		await page.click('[data-act="delete-document"]');
		await page.waitForSelector('[data-dialog="in-use"]');
		assert.match((await page.textContent('[data-dialog="in-use"] #dlg-h')) ?? '', /1 page picks Footer/);
		assert.deepEqual(await page.$$eval('[data-dialog="in-use"] .dlg-list [data-doc]', (els) => els.map((e) => e.getAttribute('data-doc'))), ['pages/about']);
		await page.close();
	});
});
