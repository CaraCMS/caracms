// M6 Decision 17 in a real browser: the public form's files field, with its script (Form.astro,
// form-client.ts), on a throwaway copy of the demo under `astro dev` (the pinned fixture's
// Contact, whose form takes files) and the in-memory submissions store.
//
// 1. Two files in two picks: both listed (name and size), and both sent.
// 2. Remove one: it leaves the list, and only the other is sent.
// 3. A sixth file is refused with the endpoint's sentence; the five stay. A kind it can't
//    take is refused by name. The same file picked again isn't listed twice.
//
//   node --test --experimental-strip-types test/form-files.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { resetSubmissions, submissionStore, type SubmissionStore } from '../src/forms/store.ts';

let site: DevSite;
let browser: Browser;

const FORM = 'form[data-caracms-form="contact"]';
const INPUT = `${FORM} input[type="file"]`;
const LIST = `${FORM} [data-caracms-files]`;
const STATUS = `${FORM} [data-caracms-form-status]`;
const store = (): SubmissionStore => submissionStore({ kind: 'memory' }) as SubmissionStore;
const pdf = (name: string, bytes = 2048) => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(bytes, 37) });

async function contact(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(`${site.origin}/contact`);
	await page.waitForSelector(`${FORM}[data-caracms-form-ready]`);
	await page.fill(`${FORM} [name="name"]`, 'Saoirse');
	await page.fill(`${FORM} [name="email"]`, 'saoirse@example.com');
	await page.selectOption(`${FORM} [name="kind"]`, 'website');
	await page.fill(`${FORM} [name="message"]`, 'Our brief is attached.');
	return page;
}

async function send(page: Page) {
	await page.click(`${FORM} button[type="submit"]`);
	await page.waitForFunction((s) => document.querySelector(s)?.textContent?.includes('Thanks'), STATUS, { timeout: 10000 });
}

/** The one stored submission's file names. */
async function sentFiles(): Promise<string[]> {
	const { items } = await store().list();
	assert.equal(items.length, 1, 'one submission stored');
	return (items[0]!.files ?? []).map((f) => f.name);
}

describe('the public form: files picked add up (M6 Decision 17)', { skip: browserSkip }, () => {
	before(async () => {
		process.env.CARACMS_SUBMISSIONS = 'memory';
		// A 0.10.0 site's Site Settings, no sent heading (the pinned content seeds one), so a send keeps the status line.
		site = await startDevSite('form-files', {
			edit: (root) => {
				const settings = join(root, 'content/site-settings.json');
				const { formWords: _seeded, ...rest } = JSON.parse(readFileSync(settings, 'utf8'));
				writeFileSync(settings, `${JSON.stringify(rest, null, 2)}\n`);
			},
		});
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
		resetSubmissions();
		delete process.env.CARACMS_SUBMISSIONS;
	});
	beforeEach(() => resetSubmissions());

	test('1. two files in two picks are both listed, and both sent', { timeout: 60000 }, async () => {
		const page = await contact();
		assert.equal(await page.locator(LIST).isHidden(), true, 'no list before a pick');
		await page.setInputFiles(INPUT, [pdf('Surf shop brief.pdf', 1_500_000)]);
		await page.setInputFiles(INPUT, [pdf('Van photos.pdf', 2048)]);
		assert.deepEqual(await page.locator(`${LIST} .cms-form-file-name`).allTextContents(), ['Surf shop brief.pdf', 'Van photos.pdf']);
		assert.deepEqual(await page.locator(`${LIST} .cms-form-file-size`).allTextContents(), ['1.4 MB', '2 KB']);
		assert.equal(await page.locator(INPUT).evaluate((el: HTMLInputElement) => el.files?.length), 2, 'the input holds both');
		// The same file again isn't listed twice.
		await page.setInputFiles(INPUT, [pdf('Van photos.pdf', 2048)]);
		assert.equal(await page.locator(`${LIST} .cms-form-file`).count(), 2);
		await send(page);
		assert.deepEqual(await sentFiles(), ['Surf shop brief.pdf', 'Van photos.pdf']);
		assert.equal(await page.locator(LIST).isHidden(), true, 'the list empties with the form');
		await page.close();
	});

	test('2. Remove takes one out: only the other is sent', { timeout: 60000 }, async () => {
		const page = await contact();
		await page.setInputFiles(INPUT, [pdf('a.pdf')]);
		await page.setInputFiles(INPUT, [pdf('b.pdf')]);
		const remove = page.getByRole('button', { name: 'Remove a.pdf' });
		await remove.focus();
		await page.keyboard.press('Enter');
		assert.deepEqual(await page.locator(`${LIST} .cms-form-file-name`).allTextContents(), ['b.pdf']);
		assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Remove b.pdf', 'focus stays in the list');
		await send(page);
		assert.deepEqual(await sentFiles(), ['b.pdf']);
		await page.close();
	});

	test('3. a sixth file, or a kind it can’t take, is refused with the endpoint’s sentence; the rest stay', { timeout: 60000 }, async () => {
		const page = await contact();
		await page.setInputFiles(INPUT, ['1', '2', '3'].map((n) => pdf(`${n}.pdf`)));
		await page.setInputFiles(INPUT, ['4', '5', '6'].map((n) => pdf(`${n}.pdf`)));
		assert.deepEqual(await page.locator(`${LIST} .cms-form-file-name`).allTextContents(), ['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf']);
		assert.equal((await page.textContent(STATUS))?.trim(), 'Attach up to 5 files (you chose 6).');
		await page.getByRole('button', { name: 'Remove 5.pdf' }).click();
		await page.setInputFiles(INPUT, [{ name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10) }]);
		assert.equal((await page.textContent(STATUS))?.trim(), "setup.exe: we can't take that kind of file. Send JPEG, PNG, WebP, HEIC, PDF, Word or Excel files.");
		assert.equal(await page.locator(`${LIST} .cms-form-file`).count(), 4);
		// A good pick clears the line.
		await page.setInputFiles(INPUT, [pdf('5.pdf')]);
		assert.equal((await page.textContent(STATUS))?.trim(), '');
		await send(page);
		assert.deepEqual(await sentFiles(), ['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf']);
		await page.close();
	});
});
