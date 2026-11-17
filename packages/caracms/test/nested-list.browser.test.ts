// M7's package half in a real browser, on a throwaway copy
// of the demo under `astro dev` (helpers/nested-site.ts: Site Settings gets a `menu` with
// Dropdown links and `partners` with Logos; the text block gets the same menu, on /nested;
// the page component prints `settings`).
//
// Local:
// 6.  In Site Settings, opening an outer row shows its inner list. An inner row is added,
//     moved with ⌥↓, removed and brought back with Undo, and dragged, and none of it moves
//     the outer list's rows or another row's inner list.
// 11. A collapsed outer row leads with its own label and counts its inner items.
// 7.  Clicking an inner link's render in the preview opens its outer row, then its inner
//     row, and focuses the link's label.
// 10. An unknown key in an inner item stays in the file when its label is edited.
// Live (the in-memory GitHub, so the public page reads what's published):
// 12. The public page's `settings` holds brand, seo and the site's own fields, links as
//     render values, never editors or googleTag.
// 13. A menu label changed in Site Settings shows in the preview's stand-in header; the
//     public page keeps the published one.
// 9.  The partners' logo with no alt text is in Publish's summary ("Partners image 1, logos
//     1"); Add alt text opens the outer row, then the inner row, with the alt focused.
//
//   node --test --experimental-strip-types test/nested-list.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { AOIFE, keepState, openAdmin, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';
import { edit, LOGO } from './helpers/nested-site.ts';

const SHOWN = '#side .side-level:not([hidden])';
const SETTINGS = 'content/site-settings.json';
const frameOn = (page: Page) => page.frameLocator('.frame.on iframe');
const outerRow = (list: string, i: number) => `${SHOWN} [data-list="${list}"] > [data-row="${i}"]`;

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

type MenuItem = { label: string; href: { href: string }; links: { label: string; href: string }[] };

describe('a list inside a list, local (M7 Decisions 14–15)', { skip: browserSkip }, () => {
	let site: DevSite;
	let browser: Browser;
	const menu = () => (JSON.parse(site.read(SETTINGS)) as { menu: MenuItem[] }).menu;
	const linkLabels = (i: number) => menu()[i]!.links.map((l) => l.label);
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

	async function open(path: string): Promise<Page> {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.on('pageerror', (error) => console.error('[page]', error.message));
		await page.goto(site.origin + path);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
		return page;
	}

	before(async () => {
		site = await startDevSite('nested-list-local', { edit });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('6, 11. an inner list: add, ⌥↓, remove and Undo, drag, each in its own list only', { timeout: 90000 }, async () => {
		const page = await open('/admin/settings');
		const services = outerRow('menu', 1);
		await page.waitForSelector(`${services} > .item-h .item-sum`);
		// 11: a collapsed row leads with its own label and counts its inner items.
		assert.equal(await page.textContent(`${services} > .item-h .item-sum .s`), 'Services · 2 dropdown links');
		assert.equal(await page.textContent(`${outerRow('menu', 0)} > .item-h .item-sum .s`), 'About · /about');

		await page.click(`${services} > .item-h .item-sum`);
		const inner = `${SHOWN} [data-sublist="menu.1.links"]`;
		await page.waitForSelector(inner);
		assert.equal(await page.textContent(`${inner} .sublist-h .sub-label`), 'Dropdown links');
		assert.equal(await page.textContent(`${inner} .sublist-h .field-meta`), '2');
		const innerSums = `${SHOWN} [data-list="menu.1.links"] > [data-row] > .item-h .item-sum .s`;
		assert.deepEqual(await page.$$eval(innerSums, (els) => els.map((e) => e.textContent)), ['Branding · /services/branding', 'Websites · /services/websites']);

		// Add: a third row, open, its label focused.
		await page.click(`${inner} .list-foot button`);
		await eventually(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.path === 'menu.1.links.2.label'), 4000, 'the new row focused');
		await page.keyboard.type('Print');
		await eventually(() => same(linkLabels(1), ['Branding', 'Websites', 'Print']), 10000, 'the file has the new link');
		assert.equal(await page.textContent(`${inner} .sublist-h .field-meta`), '3');

		// ⌥↓ on the first inner row: only the inner list moves.
		await page.focus(`${SHOWN} [data-list="menu.1.links"] > [data-row="0"] > .item-h .item-sum`);
		await page.keyboard.press('Alt+ArrowDown');
		await eventually(() => same(linkLabels(1), ['Websites', 'Branding', 'Print']), 10000, 'moved down');
		assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-row]')?.getAttribute('data-row')), '1', 'focus moves with the row');
		assert.deepEqual(menu().map((m) => m.label), ['About', 'Services'], 'the outer list stays');
		assert.ok(await page.$(`${services}.is-open`), 'the outer row stays open');

		// Remove, then Undo: it comes back in place.
		await page.keyboard.press('Backspace');
		await eventually(() => same(linkLabels(1), ['Websites', 'Print']), 10000, 'removed');
		assert.match((await page.textContent('#toast-root .toast'))!, /Removed dropdown link: Branding/);
		await page.keyboard.press('ControlOrMeta+z');
		await eventually(() => same(linkLabels(1), ['Websites', 'Branding', 'Print']), 10000, 'undone, in place');

		// Drag the last inner row above the first (each event in its own turn, as a real drag's are).
		const fire = (type: string, row: 'first' | 'last') =>
			page.evaluate(
				([type, row]) => {
					const list = document.querySelector('#side .side-level:not([hidden]) [data-list="menu.1.links"]')!;
					const rows = list.querySelectorAll<HTMLElement>(':scope > [data-row]');
					const el = row === 'first' ? rows[0]! : rows[rows.length - 1]!;
					const box = el.getBoundingClientRect();
					el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientY: box.top + 2 }));
				},
				[type, row] as const,
			);
		await fire('dragstart', 'last');
		await page.waitForTimeout(100);
		await fire('dragover', 'first');
		await page.waitForTimeout(100);
		await fire('drop', 'first');
		await fire('dragend', 'last');
		await eventually(() => same(linkLabels(1), ['Print', 'Websites', 'Branding']), 10000, 'dragged to the top');
		assert.deepEqual(menu().map((m) => m.label), ['About', 'Services'], 'the outer list stays');
		assert.deepEqual(menu()[0]!.links, [], "another row's inner list stays");

		// One row open at a time within each list: opening About closes Services, and its (empty) inner list shows.
		await page.click(`${outerRow('menu', 0)} > .item-h .item-sum`);
		await page.waitForSelector(`${SHOWN} [data-sublist="menu.0.links"] .list-empty`);
		assert.equal(await page.$(`${services}.is-open`), null);
		await page.close();
	});

	test("7. clicking an inner link's render opens its outer row, then its inner row, and focuses its label", { timeout: 60000 }, async () => {
		const page = await open('/admin/pages/nested');
		await frameOn(page).locator('[data-cms-field="menu.1.links.1.label"]').click();
		await eventually(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.path === 'menu.1.links.1.label'), 8000, "the inner link's label focused");
		assert.ok(await page.$(`${outerRow('menu', 1)}.is-open`), 'the outer row is open');
		assert.ok(await page.$(`${SHOWN} [data-list="menu.1.links"] > [data-row="1"].is-open`), 'the inner row is open');
		assert.equal(await page.$(`${SHOWN} [data-list="menu.1.links"] > [data-row="0"].is-open`), null, 'only that one');
		assert.equal(await page.inputValue(`${SHOWN} input[data-path="menu.1.links.1.label"]`), 'Websites');
		await page.close();
	});

	test('10. an unknown key in an inner item is kept when the item is edited', { timeout: 60000 }, async () => {
		const page = await open('/admin/pages/nested');
		await page.click('[data-pane-level="document"] .blist .brow-main >> nth=0');
		await page.click(`${outerRow('columns', 0)} > .item-h .item-sum`);
		await page.click(`${SHOWN} [data-list="columns.0.rows"] > [data-row="0"] > .item-h .item-sum`);
		await page.fill(`${SHOWN} input[data-path="columns.0.rows.0.note"]`, 'Identity');
		const file = () => site.read('content/pages/nested.json');
		const item = () => (JSON.parse(file()) as { blocks: { columns: { rows: Record<string, unknown>[] }[] }[] }).blocks[0]!.columns[0]!.rows[0]!;
		await eventually(() => item().note === 'Identity', 10000, 'the edit written');
		assert.deepEqual(item(), { name: 'Aoife', note: 'Identity', legacyId: 7 });
		assert.match(file(), /"note": "Identity",\n\s+"legacyId": 7\n/, 'after the schema keys');
		await page.close();
	});
});

describe('Site Settings render data and an inner list at Publish, live (M7 Decision 13)', { skip: browserSkip }, () => {
	const TIMINGS = { sweepIdleMs: 1500, sweepTickMs: 500, sweepCapMs: 10_000, lockLapseMs: 20_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 1000 };
	let live: LiveSite;
	let browser: Browser;

	const publicSettings = async () => {
		const html = await (await fetch(`${live.site.origin}/`)).text();
		const json = /<script type="application\/json" data-test-settings>([\s\S]*?)<\/script>/.exec(html)?.[1];
		assert.ok(json, 'the page prints its settings');
		return { html, settings: JSON.parse(json!) as Record<string, unknown> };
	};

	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		const media = memoryMedia();
		media.reset();
		media.bucket.seed(LOGO, { w: 400, h: 200, name: 'Harbour logo.png', uploadedAt: '2026-10-19T09:00:00Z' });
		live = await startLiveSite('nested-list-live', { CARACMS_TIMINGS: JSON.stringify(TIMINGS), CARACMS_MEDIA: 'memory' }, { edit });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
		memoryMedia().reset();
		delete process.env.CARACMS_MEDIA;
	});

	test('12. the public page gets brand, seo and the site fields as render data, and nothing private', async () => {
		const { html, settings } = await publicSettings();
		assert.deepEqual(Object.keys(settings).sort(), ['brand', 'menu', 'partners', 'seo']);
		assert.equal((settings.brand as { name: string }).name, 'CaraCMS');
		assert.equal((settings.seo as { title: string }).title, 'CaraCMS, a small design studio');
		const menu = settings.menu as { label: string; href: unknown; links: unknown[] }[];
		assert.deepEqual(menu[0]!.href, { href: '/about' });
		assert.equal(menu[1]!.href, null, 'an empty address-only link renders as null');
		assert.deepEqual(menu[1]!.links, [
			{ label: 'Branding', href: '/services/branding' },
			{ label: 'Websites', href: '/services/websites' },
		]);
		assert.equal(((settings.partners as { logos: { key: string }[] }[])[0]!.logos[0]!).key, LOGO, 'media resolved');
		for (const secret of ['niamh@example.com', 'G-TEST12345', 'editors', 'googleTag', 'formRecipients']) assert.ok(!JSON.stringify(settings).includes(secret), secret);
		assert.match(html, /<span data-test-site-name>CaraCMS<\/span>/);
	});

	test('13 and 9. the preview shows the draft menu, the public page the published one; an inner logo with no alt text at Publish', { timeout: 120000 }, async () => {
		const { site } = live;
		const page = await openAdmin(await signedIn(browser, site, AOIFE), site, '/admin/settings');
		await page.click(`${outerRow('menu', 1)} > .item-h .item-sum`);
		const label = `${SHOWN} input[data-path="menu.1.label"]`;
		await page.fill(label, 'What we do');
		await eventually(async () => (await keepState(page)) === 'kept', 15000, 'Kept');

		// 13: the preview reads the draft (reloaded, as the spec's check has it); the public page the published file.
		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
		await eventually(async () => (await frameOn(page).locator('[data-test-menu-item]').allTextContents()).includes('What we do'), 15000, "the preview's header has the draft label");
		const { settings } = await publicSettings();
		assert.deepEqual((settings.menu as { label: string }[]).map((m) => m.label), ['About', 'Services'], 'the public page keeps the published menu');

		// 9: Publish names the partners' logo, with both rows; Add alt text opens them and focuses the alt.
		await page.click('#bar button.pub');
		await page.waitForSelector('[data-pop="waiting"]');
		const note = `[data-pop="waiting"] [data-waiting="${SETTINGS}"] [data-note="alt-text"]`;
		await eventually(async () => (await page.locator(note).count()) === 1, 15000, 'Site Settings marked');
		assert.match((await page.textContent(note))!, /^Partners image 1, logos 1 has no alt text/);
		await page.click(`${note} [data-act="fix-alt"]`);
		await page.waitForSelector(`${outerRow('partners', 0)}.is-open`, { timeout: 10000 });
		await page.waitForSelector(`${SHOWN} [data-list="partners.0.logos"] > [data-row="0"].is-open`, { timeout: 10000 });
		await eventually(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-alt')), 8000, 'an alt focused');
		assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-alt')), 'partners.0.logos.0');
		await page.close();
	});
});
