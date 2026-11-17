// M9 Decision 7: hidden pages in /admin (checks 2 and 3), on a throwaway copy of the demo with
// About hidden (Team, under it, hidden with it), under `astro dev` (helpers/dev-site.ts).
//
//   - the pages list marks About as hidden; it opens and previews
//   - page settings' "Hidden from the site" switch writes `"hidden": true` after the title and takes
//     it out again; there's none on the home page; under a hidden page it's on and can't be changed
//   - the link popover doesn't offer a hidden page; a link to one keeps its chip, with a warning
//   - a reference to a hidden page warns, naming it; the reference picker offers it, marked Hidden
//
//   node --test --experimental-strip-types test/m9-hidden.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;
const BLOCK = '[data-pane-level="block"]';
const SWITCH = '[data-page-hidden] button[role="switch"]';

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	return page;
}

async function eventually<T>(check: () => T | Promise<T>, timeout = 8000, what = 'the condition'): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe('M9: hidden pages in the editor', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('m9-hidden', {
			edit: (root) => {
				const about = join(root, 'content/pages/about.json');
				writeFileSync(about, readFileSync(about, 'utf8').replace('"title": "About",', '"title": "About",\n  "hidden": true,'));
				// A list of references to pages on the call to action (a client site's Games block, review finding 1): Contact's picks Visit and Team.
				const cta = join(root, 'src/blocks/cta.ts');
				writeFileSync(cta, readFileSync(cta, 'utf8').replace('import { lockup, text,', 'import { list, lockup, reference, text,').replace('background: background(),', "background: background(),\n\t\tpicks: list(reference({ to: 'pages', label: 'Picks' })),"));
				const contact = join(root, 'content/pages/contact.json');
				writeFileSync(contact, readFileSync(contact, 'utf8').replace('"background": "photo"\n', '"background": "photo",\n      "picks": ["visit", "about/team"]\n'));
			},
		});
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('the pages list marks About hidden; it opens and previews; its switch is on; Team\'s is on and locked', async () => {
		const page = await open('/admin');
		await page.click('button[aria-label="Back to documents"]');
		await page.waitForSelector('.drow[data-doc="pages/about"] [data-mark="hidden"]');
		assert.equal(await page.locator('.drow[data-doc="pages/contact"] [data-mark="hidden"]').count(), 0);
		await page.click('.drow[data-doc="pages/about"]');
		await page.waitForSelector(SWITCH);
		assert.equal(await page.getAttribute(SWITCH, 'aria-checked'), 'true');
		await eventually(
			() => page.evaluate(() => !!document.querySelector<HTMLIFrameElement>('#stage iframe[data-width="1440"]')?.contentDocument?.querySelector('[data-cms-block="0"]')),
			8000,
			'About in the preview',
		);
		await page.goto(`${site.origin}/admin/pages/about/team`);
		await page.waitForSelector(SWITCH);
		assert.equal(await page.getAttribute(SWITCH, 'aria-checked'), 'true');
		assert.equal(await page.isDisabled(SWITCH), true);
		assert.match((await page.textContent('[data-page-hidden] [data-help]'))!, /Hidden with About/);
		await page.close();
	});

	test('the switch hides Contact (the key after its title) and shows it again; the home page has none', async () => {
		const page = await open('/admin/pages/contact');
		await page.waitForSelector(SWITCH);
		assert.equal(await page.getAttribute(SWITCH, 'aria-checked'), 'false');
		await page.click(SWITCH);
		await eventually(() => site.read('content/pages/contact.json').includes('"title": "Contact",\n  "hidden": true,\n'), 8000, 'the file to say hidden');
		await page.waitForSelector('.drow[data-doc="pages/contact"] [data-mark="hidden"]', { timeout: 8000 }).catch(() => {});
		await page.click(SWITCH);
		await eventually(() => !site.read('content/pages/contact.json').includes('"hidden"'), 8000, 'the key to go');
		await page.goto(`${site.origin}/admin`);
		await page.waitForSelector('#stage[data-painted="true"]');
		await page.waitForSelector('[data-pane-level="document"] .blist');
		assert.equal(await page.locator(SWITCH).count(), 0, 'no switch on the home page');
		await page.close();
	});

	test('a reference to Team (under About) warns, naming it; the picker offers About, marked Hidden', async () => {
		const doc = JSON.parse(site.read('content/pages/contact.json')) as { blocks: Record<string, unknown>[] };
		const cta = doc.blocks.findIndex((b) => b.type === 'cta');
		const page = await open('/admin/pages/contact');
		await page.click(`[data-pane-level="document"] .blist .brow-main >> nth=${cta}`);
		const frame = `${BLOCK} .field-frame[data-ff="picks"]`;
		await page.locator(`${frame} .field-warn`, { hasText: 'Points at /about/team, the Team page, which is hidden from the site' }).waitFor();
		assert.equal(await page.locator(`${frame} .field-warn`).count(), 1, 'the shown one (Visit) isn’t warned');
		await page.click(`${frame} .lnk button[aria-expanded]`);
		await page.fill(`${frame} [data-ref-find]`, 'abou');
		const about = `${frame} .drow[data-path-pick="about"]`;
		await page.waitForSelector(about);
		assert.equal(await page.isEnabled(about), true, 'still offered');
		assert.equal((await page.textContent(`${about} [data-mark="hidden"]`))?.trim(), 'Hidden');
		assert.equal(await page.getAttribute(`${frame} .drow[data-path-pick="about/team"] [data-mark="hidden"]`, 'title'), 'Hidden from the site with the page it’s under');
		await page.fill(`${frame} [data-ref-find]`, 'visi');
		await page.waitForSelector(`${frame} .drow[data-path-pick="visit"]`);
		assert.equal(await page.locator(`${frame} .drow[data-path-pick="visit"] [data-mark="hidden"]`).count(), 0, 'a shown page has no mark');
		await page.close();
	});

	test('the link popover doesn\'t offer About; a link to it keeps its chip and warns, naming it', async () => {
		const page = await open('/admin');
		await page.click('[data-pane-level="document"] .blist .brow-main >> nth=1');
		const body = `${BLOCK} [data-rich-text="body"] [contenteditable="true"]`;
		await page.waitForSelector(body);
		await page.click(body);
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.press('ControlOrMeta+k');
		const find = `${BLOCK} [data-rich-text="body"] .lpop [data-link-find]`;
		await page.waitForSelector(find);
		await page.fill(find, 'abou');
		await page.fill(find, 'cont');
		await page.waitForSelector(`${BLOCK} .lpop .drow[data-href="/contact"]`);
		await page.fill(find, 'abou');
		await eventually(async () => (await page.locator(`${BLOCK} .lpop .drow[data-href="/contact"]`).count()) === 0, 4000, 'the list to follow the query');
		assert.equal(await page.locator(`${BLOCK} .lpop .drow[data-href="/about"]`).count(), 0, 'About isn’t offered');
		assert.equal(await page.locator(`${BLOCK} .lpop .drow[data-href="/about/team"]`).count(), 0, 'nor Team, under it');
		await page.keyboard.press('Escape');
		await page.close();

		// A link field holding /about: the chip, and the warning under it.
		const contact = site.read('content/pages/contact.json');
		const doc = JSON.parse(contact) as { blocks: Record<string, unknown>[] };
		const hero = doc.blocks.findIndex((b) => b.type === 'hero');
		site.write('content/pages/contact.json', contact.replace('"background": "light"\n    },', '"background": "light",\n      "buttons": [{ "label": "About us", "href": "/about", "style": "primary" }]\n    },'));
		const linked = await open('/admin/pages/contact');
		await linked.click(`[data-pane-level="document"] .blist .brow-main >> nth=${hero}`);
		await linked.waitForSelector(`${BLOCK} [data-link-hidden]`);
		assert.match((await linked.textContent(`${BLOCK} [data-link-hidden] .lnk-doc`))!, /About/);
		await linked.locator(`${BLOCK} .field-warn`, { hasText: 'Links to /about, the About page, which is hidden from the site' }).waitFor();
		await linked.close();
	});
});
