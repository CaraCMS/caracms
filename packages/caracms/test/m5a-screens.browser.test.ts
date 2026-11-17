// M5a Phase 5's screens in a real browser, local mode (the disk store): a throwaway copy
// of the demo under `astro dev` (helpers/dev-site.ts). The Exit's steps as flows: New
// page → Inside → New group; + New in a collection; a case study's form and its preview
// on Work; Edit Footer from Home; Site Settings; Delete. Live mode is
// m5a-live.browser.test.ts.
//
//   node --test --experimental-strip-types test/m5a-screens.browser.test.ts
//
// The tests share one copy and run in order: each works on its own documents.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, footerInBody, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

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

const SHOWN = '.side-level:not([hidden])';
const DOCS = '[data-pane-level="documents"]';
const frame = (page: Page) => page.frameLocator('#stage iframe[data-width="1440"]');
const json = (file: string) => JSON.parse(site.read(file)) as Record<string, unknown>;
const exists = (file: string) => existsSync(join(site.root, file));

/** Wait for the file to say `check` (the keeper writes about a second after a change). */
async function fileSays(file: string, check: (doc: Record<string, unknown>) => boolean, what: string) {
	await eventually(() => exists(file) && check(json(file)), 10_000, what);
}

describe('M5a screens, local mode', { skip: browserSkip }, () => {
	before(async () => {
		// Home's blocks as these tests know them, the shared footer last (helpers/dev-site.ts → footerInBody: not the footer slot).
		site = await startDevSite('m5a-screens', { edit: footerInBody });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('Exit 1: New page → Inside → New group "Studio" with "Visit": /studio/visit shows before creating, and the empty page opens', async () => {
		const page = await open('/admin');
		await page.click('[data-pane-level="document"] .cur .ib.boxed'); // up to the documents level
		await page.click(`${DOCS} [data-act="new-page"]`);
		await page.waitForSelector('[data-dialog="new"]');
		// Inside offers the top level, every group and every page (with pages under it or not, never Home), and New group….
		await page.click('#np-inside');
		const options = await page.$$eval('#np-inside-list [data-inside-pick]', (os) => os.map((o) => o.getAttribute('data-inside-pick')!));
		assert.equal(options[0], '', options.join(' | '));
		assert.ok(options.includes('services'), options.join(' | '));
		assert.ok(options.includes('about'), 'a page with pages under it');
		assert.ok(options.includes('contact'), 'a page with nothing under it yet');
		assert.ok(!options.includes('index'), 'never Home');
		assert.ok(options.indexOf('services') < options.indexOf('contact'), 'what holds pages first');
		assert.equal(options.at(-1), '__new');
		// Typing finds by name: one hit, shown by its whole name, and Esc closes the picker, not the dialog.
		await page.fill('[data-inside-find]', 'webs');
		assert.deepEqual(await page.$$eval('#np-inside-list [data-inside-pick]', (os) => os.map((o) => o.textContent!.trim())), ['Services › Websites/services/websites/', 'New group…']);
		await page.keyboard.press('Escape');
		await page.waitForSelector('[data-inside-find]', { state: 'detached' });
		assert.equal(await page.locator('[data-dialog="new"]').count(), 1, 'the dialog stays');
		await page.click('#np-inside');
		await page.click('[data-inside-pick="__new"]');
		await page.fill('#np-group', 'Studio');
		await page.fill('#np-name', 'Visit');
		assert.equal(await page.getAttribute('[data-dialog="new"] [data-address]', 'data-address'), '/studio/visit');
		assert.match((await page.textContent('[data-dialog="new"] .urlpre'))!, /\/studio\/visit/);
		assert.equal((await page.textContent('[data-dialog="new"] [data-act="create"]'))!.trim(), 'Create group and page');
		await page.click('[data-dialog="new"] [data-act="create"]');
		await page.waitForSelector('[data-dialog="new"]', { state: 'detached' });
		// It exists on disk, empty, and opens at once: its address, its empty state.
		assert.deepEqual(json('content/pages/studio/visit.json'), { $schema: '../../../schemas/pages.schema.json', title: 'Visit', blocks: [] });
		await eventually(() => new URL(page.url()).pathname === '/admin/pages/studio/visit', 8000, 'its address');
		await page.waitForSelector(`${SHOWN} [data-empty="page"]`);
		assert.equal((await page.textContent(`${SHOWN} .cur .t > span:not(.crumbp)`))!.trim(), 'Visit');
		// It's in the Pages tree, under its group.
		assert.equal(await page.locator(`${DOCS} [data-group="pages:studio"]`).count(), 1, 'the Studio group');
		assert.equal(await page.locator(`${DOCS} [data-doc="pages/studio/visit"]`).count(), 1, 'Visit under it');
		await page.close();
	});

	test('the address it gets: a taken one says so (and Create is off), and its last part can be changed', async () => {
		const page = await open('/admin');
		await page.keyboard.press('Escape'); // up to the documents level
		await page.click(`${DOCS} [data-act="new-page"]`);
		await page.click('#np-inside');
		await page.click('[data-inside-pick="services"]');
		await page.fill('#np-name', 'Print');
		await page.waitForSelector('#np-err');
		assert.match((await page.textContent('#np-err'))!, /There's already a page at \/services\/print/);
		assert.equal(await page.isDisabled('[data-dialog="new"] [data-act="create"]'), true);
		// Change the last part: it follows the name rule.
		await page.click('[data-act="edit-address"]');
		await page.fill('#np-part', 'Print Shop!');
		assert.equal(await page.getAttribute('[data-dialog="new"] [data-address]', 'data-address'), '/services/print-shop');
		assert.equal(await page.isDisabled('[data-dialog="new"] [data-act="create"]'), false);
		// Esc closes the dialog only: the pane stays at the documents level.
		await page.keyboard.press('Escape');
		await page.waitForSelector('[data-dialog="new"]', { state: 'detached' });
		assert.equal(await page.getAttribute('#side', 'data-level'), 'documents');
		assert.equal(exists('content/pages/services/print-shop.json'), false);
		await page.close();
	});

	test('Exit 3: + New in Case studies, "Pots & Pans etc.": the form opens at once with its position; fields set reach the file; Work\'s list shows it', async () => {
		const page = await open('/admin');
		await page.keyboard.press('Escape');
		await page.click(`${DOCS} [data-coll="case-studies"]`);
		await page.waitForSelector('[data-pane-level="collection"] [data-act="new-document"]');
		await page.click('[data-pane-level="collection"] [data-act="new-document"]');
		await page.fill('#np-name', 'Pots & Pans etc.');
		assert.equal(await page.getAttribute('[data-dialog="new"] [data-address]', 'data-address'), '/work/pots-and-pans-etc');
		assert.equal((await page.textContent('[data-dialog="new"] [data-act="create"]'))!.trim(), 'Create case study');
		await page.click('[data-dialog="new"] [data-act="create"]');
		await eventually(() => new URL(page.url()).pathname === '/admin/case-studies/pots-and-pans-etc', 8000, 'its address');
		assert.deepEqual(json('content/case-studies/pots-and-pans-etc.json'), { $schema: '../../schemas/case-studies.schema.json', title: 'Pots & Pans etc.' });
		// The form: title first, then the collection's fields in schema order.
		const form = `${SHOWN} [data-form]`;
		await page.waitForSelector(form);
		// The form's own fields; M6's Search and sharing ends it (Decision 13), with fields of its own.
		const order = await page.$$eval(`${form} .field-frame`, (els) => els.filter((e) => !e.closest('details.seo')).map((e) => e.getAttribute('data-ff')));
		assert.equal(await page.locator(`${form} > :last-child`).evaluate((e) => e.matches('details.seo')), true);
		// M5b Decision 10: the case study's `cover` (an image) sits after the summary.
		assert.deepEqual(order, ['title', 'heading', 'client', 'sector', 'featured', 'launched', 'summary', 'cover', 'body', 'credits', 'related']);
		assert.equal(await page.locator(`${SHOWN} .cur .chip.kind`).count(), 0, 'no kind chip: the crumb and the tab say it');
		// Set fields.
		await page.fill(`${form} [data-ff="client"] input`, 'A kitchen shop');
		await page.click(`${form} [data-ff="featured"] [role="switch"]`);
		await page.fill(`${form} [data-ff="launched"] input`, '1 October 2026');
		await page.press(`${form} [data-ff="launched"] input`, 'Enter');
		await page.fill(`${form} [data-ff="summary"] textarea`, 'A wood-fired studio in the hills.');
		await page.click(`${form} [data-ff="credits"] .list-foot .linkbtn`);
		await page.fill(`${form} [data-path="credits.0.role"]`, 'Identity');
		await page.fill(`${form} [data-path="credits.0.name"]`, 'Aoife');
		await fileSays(
			'content/case-studies/pots-and-pans-etc.json',
			(d) => d.client === 'A kitchen shop' && d.featured === true && d.launched === '2026-10-01' && JSON.stringify(d.credits) === JSON.stringify([{ role: 'Identity', name: 'Aoife' }]),
			'the fields in the file',
		);
		// Its preview is its page; a click on a nested value in it opens that field.
		await eventually(async () => (await frame(page).locator('[data-cms-document]').textContent())!.includes('Aoife'), 8000, 'the preview has the credit');
		await page.click(`${form} [data-ff="title"] input`); // move the pick elsewhere first
		await frame(page).locator('[data-cms-field="credits.0.name"]').first().click();
		await eventually(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-path'))) === 'credits.0.name', 6000, 'click to edit: credits.0.name');
		// Esc goes up to the collection's level, where it's listed.
		await page.click(`${SHOWN} .cur .ib.boxed`);
		await page.waitForSelector('[data-pane-level="collection"] [data-doc="case-studies/pots-and-pans-etc"]');
		// Work's case-study list (Latest, 6) shows it.
		await page.click(`[data-pane-level="collection"] .lv`); // the documents level
		await page.click(`${DOCS} [data-doc="pages/work"]`);
		await eventually(async () => (await frame(page).locator('body').textContent())!.includes('Pots & Pans etc.'), 10_000, 'Work shows Pots & Pans etc.');
		await page.close();
	});

	test('Exit 4: Home\'s footer row is Shared, not Unknown; Edit Footer (used on 4 pages) opens it; a changed email shows on About', async () => {
		const page = await open('/admin');
		const row = `${SHOWN} .blist > .brow[data-shared="footer"]`;
		await page.waitForSelector(row);
		assert.equal(await page.locator(`${row} [data-chip="shared"]`).count(), 1, 'marked Shared');
		assert.equal(await page.locator(`${row} .chip.warn`).count(), 0, 'not Skipped');
		assert.match((await page.textContent(`${row} .nm`))!, /^Footer/);
		assert.match((await page.textContent(`${row} .sm`))!, /Used on 4 pages/);
		await page.click(`${row} .brow-main`);
		await page.waitForSelector('[data-shared-panel]');
		assert.equal(await page.locator('[data-pane-level="block"] [data-form] input, [data-pane-level="block"] .field-frame').count(), 0, 'never edited there');
		const edit = '[data-shared-panel] [data-act="edit-shared"]';
		assert.equal((await page.textContent(edit))!.trim(), 'Edit Footer (used on 4 pages)');
		await page.click(edit);
		await eventually(() => new URL(page.url()).pathname === '/admin/shared/footer', 8000, 'the shared block\'s address');
		const used = await page.$$eval(`${SHOWN} [data-note="used-on"] [data-doc]`, (els) => els.map((e) => e.getAttribute('data-doc')).sort());
		assert.deepEqual(used, ['pages/about', 'pages/contact', 'pages/index', 'pages/work']);
		// Edit in context, Decision 9: Home uses it, so it opens over Home (its own preview is for a page that doesn't).
		await eventually(async () => /open over Home/.test((await page.textContent(`${SHOWN} .cur .sub`)) ?? ''), 8000, 'open over Home');
		assert.ok((await frame(page).locator('[data-cms-block]').count()) > 1, 'Home stays on the stage');
		await page.fill(`${SHOWN} [data-form] [data-ff="email"] input`, 'studio@example.com');
		await fileSays('content/shared/footer.json', (d) => (d.block as { email?: string }).email === 'studio@example.com', 'the new email');
		await page.click(`${SHOWN} [data-note="used-on"] [data-doc="pages/about"]`);
		await eventually(async () => (await frame(page).locator('body').textContent())!.includes('studio@example.com'), 10_000, 'About shows the new email');
		await page.close();
	});

	test('the picker\'s Shared blocks section inserts the entry itself; a used shared block\'s Delete names where it\'s used', async () => {
		const page = await open('/admin/pages/about/team');
		await page.click(`${SHOWN} .add-row`);
		await page.waitForSelector('[data-section="shared-blocks"]');
		await page.click('.side-body .drow[data-shared="footer"]');
		await fileSays('content/pages/about/team.json', (d) => JSON.stringify((d.blocks as unknown[]).at(-1)) === '{"shared":"footer"}', 'the entry in the file');
		assert.match(site.read('content/pages/about/team.json'), /\{ "shared": "footer" \}/);
		// It renders: the footer is on the page.
		await eventually(async () => (await frame(page).locator('[data-cms-shared="footer"]').count()) === 1, 8000, 'the footer renders');

		// Delete Footer: refused while used, naming where.
		await page.goto(`${site.origin}/admin/shared/footer`);
		await page.waitForSelector('#stage[data-painted="true"]');
		await eventually(async () => /Used on 5 pages/.test((await page.textContent(`${SHOWN} .cur .sub`)) ?? ''), 8000, 'used on 5');
		await page.click(`${SHOWN} [data-act="doc-menu"]`);
		await page.click('[data-act="delete-document"]');
		await page.waitForSelector('[data-dialog="in-use"]');
		assert.match((await page.textContent('[data-dialog="in-use"] h2'))!, /Footer is still on 5 pages/);
		assert.equal(await page.locator('[data-dialog="in-use"] .dlg-list .drow').count(), 5);
		await page.keyboard.press('Escape');
		assert.equal(exists('content/shared/footer.json'), true);
		await page.close();
	});

	test('+ New shared block asks a type and a name, opens it; unused, it deletes, back to Shared blocks', async () => {
		const page = await open('/admin');
		await page.keyboard.press('Escape');
		await page.click(`${DOCS} [data-section="site-wide"] [data-coll="shared"]`);
		await page.waitForSelector('[data-pane-level="collection"] [data-doc="shared/footer"]');
		assert.match((await page.textContent('[data-pane-level="collection"] [data-doc="shared/footer"]'))!, /Used on \d pages/);
		await page.click('[data-pane-level="collection"] [data-act="new-document"]');
		await page.waitForSelector('[data-dialog="new-shared"]');
		assert.equal(await page.isDisabled('[data-act="create-shared"]'), true);
		await page.click('[data-dialog="new-shared"] [role="radio"][data-type="cta"]');
		await page.fill('#ns-name', 'Client quote');
		await page.click('[data-act="create-shared"]');
		await eventually(() => new URL(page.url()).pathname === '/admin/shared/client-quote', 8000, 'it opens');
		assert.deepEqual(json('content/shared/client-quote.json'), { $schema: '../../schemas/shared.schema.json', title: 'Client quote', block: { type: 'cta' } });
		assert.match((await page.textContent(`${SHOWN} [data-note="used-on"]`))!, /Not on any page yet/);
		await page.click(`${SHOWN} [data-act="doc-menu"]`);
		await page.click('[data-act="delete-document"]');
		await page.waitForSelector('[data-dialog="delete"]');
		await page.click('[data-act="confirm-delete"]');
		await eventually(() => !exists('content/shared/client-quote.json'), 8000, 'the file goes');
		await page.waitForSelector('[data-pane-level="collection"] [data-doc="shared/footer"]');
		assert.equal(await page.locator('[data-pane-level="collection"] [data-doc="shared/client-quote"]').count(), 0);
		await page.close();
	});

	test('Exit 5 (local): Site Settings from Site-wide opens over the last page, undimmed; @gmail.com gives its reason and is kept', async () => {
		const page = await open('/admin');
		await page.keyboard.press('Escape');
		await page.click(`${DOCS} [data-section="site-wide"] [data-doc="settings/site-settings"]`);
		await eventually(() => new URL(page.url()).pathname === '/admin/settings', 8000, '/admin/settings');
		// Edit in context, Decision 9: Site Settings shows over the last page, live and undimmed (M5a's dim is gone).
		await page.waitForSelector('[data-pane-level="document"] .cur .sub');
		assert.match((await page.textContent('[data-pane-level="document"] .cur .sub'))!, /open over Home/);
		assert.equal(await page.locator('#stage.is-aside').count(), 0);
		await page.fill('#ed-new', '@gmail.com');
		assert.match((await page.textContent('#ed-err'))!, /Public mail domains let nobody in/);
		await page.click('[data-form="editor"] button[type="submit"]');
		await page.waitForSelector('.ed[data-editor="@gmail.com"][data-warned]');
		assert.match((await page.textContent('.ed[data-editor="@gmail.com"] [data-why="editor"]'))!, /let nobody in/);
		await fileSays('content/site-settings.json', (d) => (d.editors as string[]).includes('@gmail.com'), 'kept as typed in the file');
		// The brand's name, and the accent's colour input.
		await page.fill('#set-name', 'CaraCMS');
		await fileSays('content/site-settings.json', (d) => (d.brand as { name: string }).name === 'CaraCMS', 'the name');
		// Back to Home (the head's Back): Home is the open document again.
		await page.click('[data-pane-level="document"] .cur button[aria-label="Back to Home"]');
		await eventually(() => new URL(page.url()).pathname === '/admin', 8000, 'back on Home');
		await page.waitForSelector('[data-pane-level="document"] .blist');
		await page.close();
	});

	test('⌘K and Find include shared blocks and Site Settings, grouped by collection', async () => {
		const page = await open('/admin');
		await page.keyboard.press('Meta+k');
		await page.waitForSelector('.pop.switcher');
		const groups = await page.$$eval('[data-sw-group]', (els) => els.map((e) => e.getAttribute('data-sw-group')));
		assert.ok(groups.includes('shared') && groups.includes('settings') && groups.includes('case-studies'), groups.join(','));
		await page.fill('#swq', 'foot');
		await page.waitForSelector('[data-sw-group="shared"] [data-doc="shared/footer"]');
		await page.fill('#swq', 'settings');
		await page.waitForSelector('[data-sw-group="settings"] [data-doc="settings/site-settings"]');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await page.fill(`${DOCS} [data-filter="docs"]`, 'high-street');
		await page.waitForSelector(`${DOCS} [data-results="case-studies"] [data-doc="case-studies/high-street-coffee"]`);
		await page.close();
	});

	test('Exit 6: Delete Services → Print: it leaves the tree, Branding and Websites stay under Services; Home\'s Delete is off', async () => {
		const page = await open('/admin');
		await page.click(`${SHOWN} [data-act="doc-menu"]`);
		assert.equal(await page.isDisabled('[data-act="delete-document"]'), true);
		assert.equal((await page.textContent('[data-why="delete"]'))!.trim(), "The home page can't be deleted.");
		await page.keyboard.press('Escape');
		assert.equal(await page.getAttribute('#side', 'data-level'), 'document', 'Esc closed the menu only');

		await page.goto(`${site.origin}/admin/pages/services/print`);
		await page.waitForSelector('#stage[data-painted="true"]');
		await page.click(`${SHOWN} [data-act="doc-menu"]`);
		await page.click('[data-act="delete-document"]');
		await page.waitForSelector('[data-dialog="delete"]');
		assert.match((await page.textContent('[data-dialog="delete"] h2'))!, /Delete Print\?/);
		await page.click('[data-act="confirm-delete"]');
		await eventually(() => !exists('content/pages/services/print.json'), 8000, 'the file goes');
		// The tab goes to the level it was listed in: the documents level (Pages).
		await eventually(async () => (await page.getAttribute('#side', 'data-level')) === 'documents', 8000, 'the documents level');
		assert.equal(await page.locator(`${DOCS} [data-doc="pages/services/print"]`).count(), 0, 'not in the tree');
		const services = `${DOCS} [data-group="pages:services"]`;
		if ((await page.getAttribute(services, 'aria-expanded')) !== 'true') await page.click(services);
		await page.waitForSelector(`${DOCS} [data-doc="pages/services/branding"]`);
		await page.waitForSelector(`${DOCS} [data-doc="pages/services/websites"]`);
		assert.equal(exists('content/pages/services/branding.json') && exists('content/pages/services/websites.json'), true);
		await page.close();
	});

	test('a page with pages under it: the confirmation says they stay; a group row\'s "Create a page at /services" makes services.json', async () => {
		const page = await open('/admin');
		await page.keyboard.press('Escape');
		const group = `${DOCS} [data-tnode-group="services"]`;
		await page.hover(group);
		await page.click(`${group} [data-act="group-menu"]`);
		assert.match((await page.textContent(`${group} [data-act="group-page"]`))!, /Create a page at \/services/);
		await page.click(`${group} [data-act="group-page"]`);
		await page.waitForSelector('[data-dialog="new"]');
		assert.equal(await page.inputValue('#np-name'), 'Services');
		await page.click('[data-dialog="new"] [data-act="create"]');
		await eventually(() => new URL(page.url()).pathname === '/admin/pages/services', 8000, 'it opens');
		assert.deepEqual(json('content/pages/services.json'), { $schema: '../../schemas/pages.schema.json', title: 'Services', blocks: [] });
		// Its delete confirmation says its pages stay.
		await page.click(`${SHOWN} [data-act="doc-menu"]`);
		await page.click('[data-act="delete-document"]');
		await page.waitForSelector('[data-dialog="delete"] [data-kids]');
		assert.match((await page.textContent('[data-dialog="delete"] [data-kids]'))!, /Its 2 pages stay, in a Services group: Branding and Websites keep their addresses/);
		await page.click('[data-act="confirm-delete"]');
		await eventually(() => !exists('content/pages/services.json'), 8000, 'services.json goes');
		assert.equal(exists('content/pages/services/branding.json'), true);
		await page.close();
	});
});
