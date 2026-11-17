// M9 port friction 10 in a real browser: a site's own thanks and failure lines reach the
// form's script (Form.astro → data-thanks / data-failed → form-client.ts), and with
// `actions` the status line is written inside `.cms-form-actions`, beside the button.
// A throwaway copy of the demo under `astro dev` whose Form block passes the hooks (the
// demo's own block is untouched), with the in-memory submissions store.
//
// 1. A send shows the site's thanks line, in the actions wrapper.
// 2. A failed send with no sentence from the endpoint shows the site's failure line.
//
//   node --test --experimental-strip-types test/form-hooks.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { resetSubmissions } from '../src/forms/store.ts';

let site: DevSite;
let browser: Browser;

const FORM = 'form[data-caracms-form="contact"]';
const STATUS = `${FORM} .cms-form-actions [data-caracms-form-status]`;
const THANKS = 'Thanks — we’ll be in touch.';
const FAILED = 'That didn’t send. Email hello@example.com.';

async function contact(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(`${site.origin}/contact`);
	await page.waitForSelector(`${FORM}[data-caracms-form-ready]`);
	await page.fill(`${FORM} [name="name"]`, 'Saoirse');
	await page.fill(`${FORM} [name="email"]`, 'saoirse@example.com');
	await page.selectOption(`${FORM} [name="kind"]`, 'website');
	await page.fill(`${FORM} [name="message"]`, 'A new site, please.');
	return page;
}

describe('the public form: a site\'s own lines and the actions row (M9 port friction 10)', { skip: browserSkip }, () => {
	before(async () => {
		process.env.CARACMS_SUBMISSIONS = 'memory';
		site = await startDevSite('form-hooks', {
			edit: (root) => {
				const file = join(root, 'src/blocks/Form.astro');
				const source = readFileSync(file, 'utf8');
				const hooked = source.replace(
					'<Form form={block.form} preview={cms.preview} state={cms.state} />',
					`<Form form={block.form} preview={cms.preview} state={cms.state} actions submitClass="btn" thanks=${JSON.stringify(THANKS)} failed=${JSON.stringify(FAILED)} />`,
				);
				assert.notEqual(hooked, source, "the copy's Form block was given the hooks");
				writeFileSync(file, hooked);
				// A 0.10.0 site's Site Settings, no sent heading (the pinned content seeds one), so a send keeps the status line.
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

	test('1. a send shows the site\'s thanks line, inside .cms-form-actions beside the button', { timeout: 60000 }, async () => {
		const page = await contact();
		assert.equal(await page.locator(`${FORM} .cms-form-actions > button.cms-form-submit.btn`).count(), 1);
		await page.click(`${FORM} button[type="submit"]`);
		await page.waitForFunction(([s, t]) => document.querySelector(s!)?.textContent === t, [STATUS, THANKS] as const, { timeout: 10000 });
		await page.close();
	});

	test('2. a failed send with no sentence of the endpoint\'s shows the site\'s failure line', { timeout: 60000 }, async () => {
		const page = await contact();
		await page.route('**/_caracms/form', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }));
		await page.click(`${FORM} button[type="submit"]`);
		await page.waitForFunction(([s, t]) => document.querySelector(s!)?.textContent === t, [STATUS, FAILED] as const, { timeout: 10000 });
		assert.equal(await page.locator(STATUS).evaluate((el) => el.classList.contains('cms-form-failed')), true);
		await page.close();
	});
});
