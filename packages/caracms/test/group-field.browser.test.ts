// The group field in a real browser (the editor-friction batch, item 1), on a
// throwaway copy of the demo under `astro dev` (helpers/dev-site.ts, the pinned fixture's
// content, whose Websites page ends with a Two columns block: groups `left` and `right`):
//
// 1. The block's level draws each group as Page details is drawn: a labelled section,
//    open by default. Typing in Left's heading writes `left` on its own lines, in schema
//    order; Right keeps its text.
// 2. A warning inside a closed group puts a mark on its summary; open, the mark goes
//    (the warning itself is inside, with its field).
// 3. A group's text field is typed on the page: the sidebar and the file follow. A click
//    on a closed group's field in the preview opens the group.
//
// Item 5, page-field warnings (the copy's pages get page fields: a link, and a group):
// 4. A warning in a page field marks Page details while it's closed, and one in a group
//    among them marks that group too, counted in Page details' mark. The group is written
//    as the file's top-level key, before `blocks`.
//
// Item 4, buttons with no link (the demo's columns have `allowNoLink`):
// 5. A button with words and no link isn't warned in the sidebar, and the preview draws
//    it as a plain label with the button's classes.
//
// Paths inside a group, where the first path part isn't the field:
// 6. A click on Left's button in the preview focuses its label in the sidebar.
// 7. A group closed by hand opens again when another field in it is picked on the page.
// 8. A render that predates typing on the page puts a group's typed text back in the
//    other widths.
// 9. A group's field changed while the preview can't render says "Not in the preview yet".
//
//   node --test --experimental-strip-types test/group-field.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const FILE = 'content/pages/services/websites.json';
const frameOn = (page: Page) => page.frameLocator('.frame.on iframe');

/** The copy's pages get page fields: a link, and a group with a link in it (the demo itself is untouched). */
function edit(root: string) {
	const file = join(root, 'caracms.config.ts');
	const config = readFileSync(file, 'utf8')
		.replace("import { defineSite } from 'caracms/config';", "import { defineSite, group, link, text } from 'caracms/config';")
		.replace(
			"pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },",
			"pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true, fields: { more: link({ label: 'More' }), extra: group({ note: text(), source: link() }, { label: 'Extra' }) } },",
		);
	if (!config.includes('extra: group(')) throw new Error("the copy's config didn't take its page fields");
	writeFileSync(file, config);
}

async function openColumns(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(`${site.origin}/admin/pages/services/websites`);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	await page.locator(`${DOC} .blist .brow-main`).filter({ hasText: /(Built|Made) for you/ }).click();
	await page.locator(`${BLOCK} details.group-field[data-group="left"]`).waitFor();
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

describe('a group field in the editor', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('group-field', { edit });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('1. each group is a labelled section, open by default; an edit in Left writes `left` whole and leaves Right as it was', { timeout: 60000 }, async () => {
		const original = site.read(FILE);
		const page = await openColumns();
		const groups = page.locator(`${BLOCK} details.fgroup.group-field`);
		assert.deepEqual(await groups.evaluateAll((els) => els.map((e) => [e.getAttribute('data-group'), e.querySelector('summary')!.textContent!.trim(), (e as HTMLDetailsElement).open])), [
			['left', 'Left', true],
			['right', 'Right', true],
		]);
		const left = groups.first();
		// The group's fields are ordinary fields at its paths.
		assert.equal(await left.locator('.field-frame[data-ff="left.heading"] input').inputValue(), 'Built for you');
		assert.equal(await left.locator('.field-frame[data-ff="left.text"]').count(), 1);
		assert.equal(await left.locator('.field-frame[data-ff="left.button"]').count(), 1);

		await left.locator('input[data-path="left.heading"]').fill('Made for you');
		const expected = original
			.replace('"heading": "Built for you"', '"heading": "Made for you"');
		await eventually(() => site.read(FILE) === expected, 10000, 'only the heading changed');
		// It reaches the preview.
		await eventually(() => frameOn(page).locator('[data-cms-field="left.heading"]', { hasText: 'Made for you' }).count(), 8000, 'the preview');
		await page.close();
	});

	test('2. a closed group with a warning inside it carries a mark; open, the warning is with its field', { timeout: 60000 }, async () => {
		const page = await openColumns();
		const right = page.locator(`${BLOCK} details.group-field[data-group="right"]`);
		// A button with a link and no words: half a button.
		await right.locator('input[data-path="right.button.0.label"]').fill('');
		await right.locator('.field-frame[data-ff="right.button"]').locator('text=Button 1 has no label').waitFor({ timeout: 8000 });
		assert.equal(await right.locator('summary .wmark').count(), 0, 'open: no mark, the warning shows itself');

		await right.locator('summary').click();
		assert.equal(await right.evaluate((e) => (e as HTMLDetailsElement).open), false);
		const mark = right.locator('summary .wmark');
		await mark.waitFor();
		assert.equal(await mark.getAttribute('data-wmark'), '1');
		assert.equal(await mark.getAttribute('title'), '1 warning in Right');
		// Left has nothing wrong: closed, no mark.
		const left = page.locator(`${BLOCK} details.group-field[data-group="left"]`);
		await left.locator('summary').click();
		assert.equal(await left.locator('summary .wmark').count(), 0);

		await right.locator('summary').click();
		await eventually(async () => (await mark.count()) === 0, 4000, 'open again: the mark goes');
		await page.close();
	});

	test("3. a group's text is typed on the page, and a click on a closed group's field in the preview opens it", { timeout: 60000 }, async () => {
		const page = await openColumns();
		const right = page.locator(`${BLOCK} details.group-field[data-group="right"]`);
		await right.locator('summary').click();
		assert.equal(await right.evaluate((e) => (e as HTMLDetailsElement).open), false);

		const heading = frameOn(page).locator('[data-cms-field="right.heading"]');
		assert.equal(await heading.getAttribute('contenteditable'), 'plaintext-only', "typed on the page, as a top-level field's is");
		await heading.click();
		await eventually(() => right.evaluate((e) => (e as HTMLDetailsElement).open), 4000, 'the group opened');
		await page.waitForSelector(`${BLOCK} .field-frame.is-picked[data-ff="right.heading"]`);
		await heading.evaluate((el) => {
			const sel = el.ownerDocument.getSelection()!;
			sel.selectAllChildren(el);
			sel.collapseToEnd();
		});
		await page.keyboard.type(', always');
		await page.keyboard.press('Enter');
		assert.equal(await page.inputValue(`${BLOCK} input[data-path="right.heading"]`), 'Looked after, always');
		await eventually(() => site.read(FILE).includes('"heading": "Looked after, always"'), 8000, 'the file');
		await page.close();
	});

	test('4. a warning in a page field marks Page details while it is closed; one in a group among them marks the group too', { timeout: 60000 }, async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.on('pageerror', (error) => console.error('[page]', error.message));
		await page.goto(`${site.origin}/admin/pages/services/websites`);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
		const details = page.locator(`${DOC} details.page-fields`);
		await details.waitFor();
		const extra = details.locator('details.group-field[data-group="extra"]');
		assert.equal(await extra.locator('summary').textContent(), 'Extra');

		// Words and no link: half a link, in a page field.
		await details.locator('input[data-path="more.label"]').fill('Read more');
		await details.locator('.field-frame[data-ff="more"]').locator('text=shows only once').waitFor({ timeout: 8000 });
		await details.locator(':scope > summary').click();
		const mark = details.locator(':scope > summary .wmark');
		await mark.waitFor();
		assert.equal(await mark.getAttribute('data-wmark'), '1');
		assert.equal(await mark.getAttribute('title'), '1 warning in Page details');

		// One more, in the group: the group's mark, and two in Page details'.
		await details.locator(':scope > summary').click();
		await eventually(async () => (await mark.count()) === 0, 4000, 'open: no mark');
		await extra.locator('input[data-path="extra.source.label"]').fill('Source');
		await extra.locator('text=shows only once').waitFor({ timeout: 8000 });
		await extra.locator('summary').click();
		await extra.locator('summary .wmark[data-wmark="1"]').waitFor();
		await details.locator(':scope > summary').click();
		await details.locator(':scope > summary .wmark[data-wmark="2"]').waitFor();

		// Written as top-level keys, after the title, before the blocks.
		const written = /"title": "Websites",\n {2}"more": \{\n {4}"label": "Read more",\n {4}"href": ""\n {2}\},\n {2}"extra": \{\n {4}"note": "",\n {4}"source": \{\n {6}"label": "Source",\n {6}"href": ""\n {4}\}\n {2}\},\n {2}"blocks"/;
		await eventually(() => written.test(site.read(FILE)), 10000, 'the page fields written');
		await page.close();
	});

	test('5. allowNoLink: a button with words and no link is not warned, and shows as a plain label', { timeout: 60000 }, async () => {
		const json = JSON.parse(site.read(FILE));
		json.blocks.find((b: { type: string }) => b.type === 'columns').right.button = [{ label: 'Coming soon', href: '', style: 'secondary' }];
		site.write(FILE, `${JSON.stringify(json, null, 2)}\n`);
		const page = await openColumns();
		const right = page.locator(`${BLOCK} details.group-field[data-group="right"]`);
		assert.equal(await right.locator('input[data-path="right.button.0.label"]').inputValue(), 'Coming soon');
		assert.equal(await right.locator('.btnf.is-half').count(), 0, 'not half a button');
		assert.equal(await right.locator('text=has no link').count(), 0);
		await eventually(() => frameOn(page).locator('span.column-button.column-button--secondary[data-cms-field="right.button.0.label"]', { hasText: 'Coming soon' }).count(), 8000, 'the plain label');
		await right.locator('summary').click();
		assert.equal(await right.locator('summary .wmark').count(), 0, 'closed: no mark');
		await page.close();
	});

	test("6. a click on a group's button in the preview focuses its label in the sidebar", { timeout: 60000 }, async () => {
		const page = await openColumns();
		await frameOn(page).locator('[data-cms-field^="left.button.0"]').first().click();
		await eventually(() => page.evaluate(() => document.activeElement?.getAttribute('data-path') === 'left.button.0.label'), 6000, "the button's label focused");
		assert.equal(await page.inputValue(`${BLOCK} input[data-path="left.button.0.label"]`), 'See our work');
		await page.close();
	});

	test('7. a group closed by hand opens again when another of its fields is picked on the page', { timeout: 60000 }, async () => {
		const page = await openColumns();
		const left = page.locator(`${BLOCK} details.group-field[data-group="left"]`);
		const open = () => left.evaluate((e) => (e as HTMLDetailsElement).open);
		await frameOn(page).locator('[data-cms-field="left.heading"]').click();
		await page.waitForSelector(`${BLOCK} .field-frame.is-picked[data-ff="left.heading"]`);
		assert.equal(await open(), true);
		await left.locator('summary').click();
		assert.equal(await open(), false, 'closed by hand');
		await frameOn(page).locator('[data-cms-field^="left.button.0"]').first().click();
		await eventually(open, 4000, 'Left open again');
		await page.close();
	});

	test("8. a render that predates typing on the page puts a group's typed text back in the other widths", { timeout: 60000 }, async () => {
		const page = await openColumns();
		const before = await page.inputValue(`${BLOCK} input[data-path="left.heading"]`);
		// Hold every render: the one a sidebar edit asks for lands after the page has been typed in.
		await page.route(`${site.origin}/_caracms/preview`, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			await new Promise((r) => setTimeout(r, 1200));
			await route.fulfill({ response: await route.fetch() }).catch(() => {});
		});
		await page.locator(`${BLOCK} input[data-path="right.heading"]`).fill('Looked after well');
		const heading = frameOn(page).locator('[data-cms-field="left.heading"]');
		await heading.click();
		await heading.evaluate((el) => {
			const sel = el.ownerDocument.getSelection()!;
			sel.selectAllChildren(el);
			sel.collapseToEnd();
		});
		await page.keyboard.type(' today');
		const tablet = page.frameLocator('#stage iframe[data-width="768"]');
		await eventually(() => tablet.locator('[data-cms-field="right.heading"]', { hasText: 'Looked after well' }).count(), 8000, 'the slow render in the tablet');
		await new Promise((r) => setTimeout(r, 300));
		for (const width of [768, 375]) {
			const text = await page.frameLocator(`#stage iframe[data-width="${width}"]`).locator('[data-cms-field="left.heading"]').innerText();
			assert.equal(text, `${before} today`, `the ${width} iframe`);
		}
		await page.unrouteAll({ behavior: 'ignoreErrors' });
		await page.close();
	});

	test('9. a group\'s field changed while the preview can\'t render says it isn\'t in the preview yet', { timeout: 60000 }, async () => {
		const page = await openColumns();
		await page.route(`${site.origin}/_caracms/preview`, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			await route.fulfill({ status: 500, body: 'no' });
		});
		await page.locator(`${BLOCK} input[data-path="left.heading"]`).fill('Built for everyone');
		await page.locator(`${BLOCK} .field-frame[data-ff="left.heading"] [data-stale]`).waitFor({ timeout: 8000 });
		assert.equal(await page.locator(`${BLOCK} .field-frame[data-ff="right.heading"] [data-stale]`).count(), 0, 'only the field that changed');
		await page.unrouteAll({ behavior: 'ignoreErrors' });
		await page.close();
	});
});
