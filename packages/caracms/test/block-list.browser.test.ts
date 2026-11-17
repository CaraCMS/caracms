// The block list in a real browser (Phase 4 → Verify 3 and 4), on a throwaway copy of
// the demo under `astro dev` (helpers/dev-site.ts): add from the picker, reorder by
// keys and by drag, remove and Undo, with the file on disk and the preview checked
// each time; and an unknown block kept byte for byte. Fixtures go into the copy only.
//
//   node --test --experimental-strip-types test/block-list.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, footerInBody, startDevSite, type DevSite } from './helpers/dev-site.ts';

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

const LIST = '[data-pane-level="document"] .blist';
const rowMain = (i: number) => `${LIST} > .brow >> nth=${i} >> .brow-main`;

/** The block types in the file on disk, in order; a shared-block entry (M5a Decision 8) as `shared`. */
const fileTypes = (file: string) =>
	(JSON.parse(site.read(file)) as { blocks: { type?: string; shared?: string }[] }).blocks.map((b) => (typeof b.shared === 'string' ? 'shared' : b.type));
/** The block types the desktop preview renders, in order (unknown blocks aren't rendered: a preview leaves only a comment for one, src/skipped.ts). */
const previewTypes = (page: Page) =>
	page.evaluate(() => {
		const doc = document.querySelector<HTMLIFrameElement>('#stage iframe[data-width="1440"]')!.contentDocument!;
		return [...doc.querySelectorAll('[data-cms-type]')].map((el) => (el.hasAttribute('data-cms-shared') ? 'shared' : el.getAttribute('data-cms-type')));
	});
// A shared-block entry's row (M5a Phase 5) carries `data-shared` and its shared block's type: `shared` here.
const listTypes = (page: Page) => page.$$eval(`${LIST} > .brow`, (rows) => rows.map((r) => (r.hasAttribute('data-shared') ? 'shared' : r.getAttribute('data-block-type') || 'shared')));
/** Home since M5a's demo (Phase 2): the case-study list and the shared footer follow the first three blocks. */
const TAIL = ['cases', 'shared'];

/** The file and the preview both reach `types` (the preview without unknown blocks). */
async function settles(page: Page, file: string, types: string[], what: string, known = types) {
	await eventually(() => JSON.stringify(fileTypes(file)) === JSON.stringify(types), 8000, `${what}: the file`);
	await eventually(async () => JSON.stringify(await previewTypes(page)) === JSON.stringify(known), 8000, `${what}: the preview`);
	assert.deepEqual(await listTypes(page), types, `${what}: the list`);
}

const toList = async (page: Page) => {
	if (await page.isVisible(LIST)) return;
	await page.click('[data-pane-level="block"] .lv >> nth=1');
	await page.waitForSelector(LIST);
};

describe('the block list in the browser', { skip: browserSkip }, () => {
	before(async () => {
		// Home's blocks as these tests know them, the shared footer last (helpers/dev-site.ts → footerInBody: not the footer slot).
		site = await startDevSite('block-list', { edit: footerInBody });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('Verify 3: add, reorder by keys and by drag, remove and Undo on Home: the file and the preview follow each time', async () => {
		const file = 'content/pages/index.json';
		const original = site.read(file);
		const heroText = original.slice(original.indexOf('    {\n      "type": "hero"'), original.indexOf('    },\n    {\n      "type": "text"') + 5);
		const page = await open('/admin');
		await page.waitForSelector(LIST);
		assert.deepEqual(await listTypes(page), ['hero', 'text', 'cta', ...TAIL]);

		// Hover links to the store the preview reads: the row is drawn hovered.
		await page.hover(`${LIST} > .brow >> nth=2`);
		assert.match((await page.getAttribute(`${LIST} > .brow >> nth=2`, 'class'))!, /\bhov\b/);

		// Add from the picker, at the end (after the shared entry, named as its row names it).
		const lastName = (await page.getAttribute(`${LIST} > .brow >> nth=4 >> .brow-main`, 'aria-label'))!.split(',')[0];
		await page.click('[data-pane-level="document"] .add-row');
		await page.waitForSelector('[data-picker-at="5"]');
		assert.equal(await page.textContent('[data-pane-level="document"] .cur .sub'), `After ${lastName}`);
		await page.click('[data-picker-at] .ptype[data-type="text"]');
		await page.waitForSelector('[data-pane-level="block"]');
		await toList(page);
		await settles(page, file, ['hero', 'text', 'cta', ...TAIL, 'text'], 'added');

		// Keys: ⌥↑ moves the new block up one row at a time (past the shared entry too), and keeps focus on it.
		await page.focus(rowMain(5));
		await page.keyboard.press('Alt+ArrowUp');
		await settles(page, file, ['hero', 'text', 'cta', 'cases', 'text', 'shared'], 'moved up by keys');
		await page.keyboard.press('Alt+ArrowUp');
		await page.keyboard.press('Alt+ArrowUp');
		await settles(page, file, ['hero', 'text', 'text', 'cta', ...TAIL], 'moved above the CTA by keys');
		assert.equal(await page.evaluate(() => document.activeElement?.closest('.brow')?.querySelector('.bt .sm')?.textContent), 'Nothing in it yet');
		// ↑/↓ move between rows without moving anything.
		await page.keyboard.press('ArrowUp');
		assert.equal(await page.evaluate(() => [...document.querySelectorAll('.blist .brow-main')].indexOf(document.activeElement!)), 1);

		// Drag: the CTA onto the top half of the hero puts it first.
		await page.dragAndDrop(`${LIST} > .brow >> nth=3`, `${LIST} > .brow >> nth=0`, { targetPosition: { x: 60, y: 4 } });
		await settles(page, file, ['cta', 'hero', 'text', 'text', ...TAIL], 'dragged');
		// The hero didn't change, so its text in the file is as read.
		assert.ok(site.read(file).includes(heroText.replace(/\n {4}\},?$/, '')), 'the hero is written back as read');

		// Remove with ⌫ on a focused row, then Undo with ⌘Z.
		await page.focus(rowMain(0));
		await page.keyboard.press('Backspace');
		await settles(page, file, ['hero', 'text', 'text', ...TAIL], 'removed');
		assert.match((await page.textContent('#toast-root .toast'))!, /Removed Call to action/);
		await page.keyboard.press('ControlOrMeta+z');
		await settles(page, file, ['cta', 'hero', 'text', 'text', ...TAIL], 'undone');

		// The row menu: Move down, then Remove, and the toast's Undo.
		await page.click(`${LIST} > .brow >> nth=0 >> .brow-more`);
		await page.click(`${LIST} .menu [role="menuitem"]:has-text("Move down")`);
		await settles(page, file, ['hero', 'cta', 'text', 'text', ...TAIL], 'menu move');
		await page.click(`${LIST} > .brow >> nth=3 >> .brow-more`);
		await page.click(`${LIST} .menu [role="menuitem"]:has-text("Remove")`);
		await settles(page, file, ['hero', 'cta', 'text', ...TAIL], 'menu remove');
		await page.click('#toast-root .toast .btn');
		await settles(page, file, ['hero', 'cta', 'text', 'text', ...TAIL], 'toast undo');
		await page.close();
		site.write(file, original);
	});

	test('no insert points on a selected block (the sidebar adds); an empty page offers its first block', async () => {
		const page = await open('/admin');
		await page.waitForSelector(LIST);
		const desktop = page.frameLocator('#stage iframe[data-width="1440"]');
		await page.click(rowMain(1));
		await page.waitForSelector('[data-pane-level="block"]');
		await eventually(() => desktop.locator('#cms-overlays .cms-sel').count(), 6000, 'the selected block');
		assert.equal(await desktop.locator('#cms-overlays .cms-ins, #cms-overlays [data-ins]').count(), 0);
		await page.close();

		// An empty page: "+ Add the first block" on the page opens the picker at 0.
		site.write('content/pages/blank.json', '{\n  "title": "Blank",\n  "blocks": []\n}\n');
		try {
			const blank = await open('/admin/pages/blank');
			const add = blank.frameLocator('#stage iframe[data-width="1440"]').locator('#cms-overlays .cms-empty .cms-add');
			await eventually(async () => (await add.count()) === 1, 6000, 'the empty page\'s add');
			await add.click();
			await blank.waitForSelector('[data-picker-at="0"]');
			await blank.click('[data-picker-at] .ptype[data-type="hero"]');
			await eventually(() => JSON.stringify(fileTypes('content/pages/blank.json')) === '["hero"]', 8000, 'the first block on disk');
			await blank.close();
		} finally {
			site.write('content/pages/blank.json', '{ "title": "Blank", "blocks": [] }\n');
		}
	});

	test('Verify 4: an unknown block is marked skipped, survives its neighbours\' moves byte for byte, moves itself, and is removed and brought back', async () => {
		const file = 'content/pages/fixture.json';
		const unknown = [
			'    {',
			'      "type": "testimonial-strip",',
			'      "heading": "Kind words",',
			'      "quotes": [{ "who": "A", "said": "Lovely" }, {"who":"B","said":"Grand"}, { "who": "C", "said": "Fine" }],',
			'      "background": "dark",',
			'      "spacing":   12',
			'    }',
		].join('\n');
		const text = (heading: string) => `    {\n      "type": "text",\n      "heading": "${heading}",\n      "body": "Body",\n      "background": "light"\n    }`;
		site.write(file, `{\n  "title": "Fixture",\n  "blocks": [\n${text('One')},\n${unknown},\n${text('Two')}\n  ]\n}\n`);
		try {
			const page = await open('/admin/pages/fixture');
			await page.waitForSelector(LIST);
			const row = `${LIST} > .brow.is-unknown`;
			assert.equal(await page.locator(row).count(), 1);
			assert.match((await page.textContent(`${row} .chip.warn`))!, /Skipped/);
			assert.equal(
				await page.textContent(`${row} .bt .sm`),
				'testimonial-strip · Heading: “Kind words” · Quotes: 3 items · Background: “dark” · Spacing: 12',
			);

			// A neighbour moves past it (⌥↓ on the first text block): it's kept byte for byte.
			await page.focus(rowMain(0));
			await page.keyboard.press('Alt+ArrowDown');
			await settles(page, file, ['testimonial-strip', 'text', 'text'], 'neighbour moved', ['text', 'text']);
			assert.ok(site.read(file).includes(unknown), 'kept as read');

			// It moves itself.
			await page.focus(rowMain(0));
			await page.keyboard.press('Alt+ArrowDown');
			await settles(page, file, ['text', 'testimonial-strip', 'text'], 'moved itself', ['text', 'text']);
			assert.ok(site.read(file).includes(unknown));

			// Removed, then brought back with Undo, as read.
			await page.focus(rowMain(1));
			await page.keyboard.press('Delete');
			await settles(page, file, ['text', 'text'], 'removed');
			await page.keyboard.press('ControlOrMeta+z');
			await settles(page, file, ['text', 'testimonial-strip', 'text'], 'undone', ['text', 'text']);
			assert.ok(site.read(file).includes(unknown), 'back as read');

			// The skipped pill on the page opens it.
			const desktop = page.frameLocator('#stage iframe[data-width="1440"]');
			await desktop.locator('#cms-overlays .cms-skip button').click();
			await page.waitForSelector('[data-pane-level="block"] [data-unknown-block]');
			await toList(page);

			// Opening it goes to the block level (its panel is the block level's), never to fields that would edit it.
			await page.click(`${row} .brow-main`);
			await page.waitForSelector('[data-pane-level="block"]');
			assert.equal(await page.locator('[data-pane-level="block"] input.input, [data-pane-level="block"] textarea').count(), 0);
			await page.close();
		} finally {
			site.write(file, '{ "title": "Fixture", "blocks": [] }\n');
		}
	});
});
