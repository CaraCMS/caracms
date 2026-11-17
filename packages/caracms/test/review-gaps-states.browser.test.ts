// Review gaps, block states and a form's words in the editor, on the
// fixture's Contact page (its Form block declares sent, error and invalid):
// - Acceptance 11: selecting the Form block shows the switch over the preview; the Hero shows none.
// - Acceptance 12: choosing a state re-renders the preview with the form in it, at all three widths;
//   the other blocks stay as they were.
// - Acceptance 13: a state's words are typed on the page (they're Site Settings', so Site Settings opens
//   over the page) and saved there; the state keeps showing while they're typed.
// - Acceptance 14: selecting another block, opening another document or reloading puts the form back;
//   nothing is saved.
// - Acceptance 16: Site Settings › Forms, a group per form, a blank word showing the config's in grey.
// - Acceptance 19: a label clicked opens Site Settings over the page at that word, and typing changes
//   it; the email box clicked focuses its placeholder's control, nothing typed in the page's input.
// - Acceptance 21: the button sends nothing; a select doesn't open.
import assert from 'node:assert/strict';
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

const frameOn = (page: Page) => page.frameLocator('.frame.on iframe');
const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const SETTINGS = 'content/site-settings.json';
const CONTACT = 'content/pages/contact.json';
/** Evaluate in one width's frame. */
const inWidth = <T>(page: Page, width: string, fn: (doc: Document) => T) =>
	page.evaluate(`(${fn.toString()})(document.querySelector('#stage .frame[data-w="${width}"] iframe').contentDocument)`) as Promise<T>;
const switchIn = (page: Page) => frameOn(page).locator('#cms-overlays [data-mark="states"]');
/** The status line's words in a width's frame (Couldn't send's line). */
const statusIn = (page: Page, width: string) => inWidth(page, width, (d) => d.querySelector('form[data-caracms-form="contact"] .cms-form-status')?.textContent?.trim() ?? '');
/** The sent panel's heading and line in a width's frame ('' while the form shows): the fixture seeds its heading. */
const sentIn = (page: Page, width: string) => inWidth(page, width, (d) => [...(d.querySelector('form[data-caracms-form="contact"] .cms-form-sent')?.children ?? [])].map((p) => p.textContent?.trim()).join(' '));
const SENT = 'Thanks, it’s sent Thanks, we\'ll be in touch shortly.';
const formSettings = () => JSON.parse(site.read(SETTINGS)).formWords as Record<string, any> | undefined;

/** The Contact page with its Form block selected (a click on its intro). */
async function formSelected(): Promise<Page> {
	const page = await open('/admin/pages/contact');
	await frameOn(page).locator('[data-cms-block="1"] [data-cms-field="intro"]').click();
	await page.waitForSelector(`${BLOCK}`);
	await eventually(async () => (await switchIn(page).count()) > 0, 8000, 'the switch');
	return page;
}

describe('review gaps: block states and a form’s words', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('review-gaps-states');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('Acceptance 11: the Form block has the switch, beside its tag, on First look; the Hero has none', async () => {
		const page = await formSelected();
		const labels = await switchIn(page).locator('.cms-states:not(.compact) button').allTextContents();
		assert.deepEqual(labels.map((l) => l.trim()), ['First look', 'Sent', 'Couldn’t send', 'Invalid']);
		assert.equal(await switchIn(page).locator('.cms-tag').textContent(), 'Form');
		assert.equal(await switchIn(page).locator('button[aria-checked="true"]').first().textContent(), 'First look');
		// The block level names its other states.
		assert.match((await page.textContent(`${BLOCK} [data-states-line]`)) ?? '', /Also shows Sent, Couldn’t send and Invalid\./);
		// Its words are one row, "Words from Site Settings › Forms › Contact", not a label each under "Also shows".
		await eventually(async () => /Words from Site Settings › Forms › Contact/.test((await page.textContent(`${BLOCK} [data-read="words:contact"]`).catch(() => '')) ?? ''), 8000, 'the words row');
		assert.equal(await page.locator(`${BLOCK} [data-also-shows]`).count(), 0);
		await frameOn(page).locator('[data-cms-block="0"] [data-cms-field="heading"]').click();
		await eventually(async () => (await switchIn(page).count()) === 0, 8000, 'no switch on the Hero');
		await page.close();
	});

	test('Acceptance 12 and 14: Sent draws at all three widths, the Hero untouched; another block, then a reload, put it back; nothing saved', async () => {
		const before = site.read(CONTACT);
		const page = await formSelected();
		const hero = await inWidth(page, 'desktop', (d) => d.querySelector('[data-cms-block="0"]')!.outerHTML);
		await switchIn(page).locator('.cms-states:not(.compact) button[data-state="sent"]').click();
		for (const width of ['desktop', 'tablet', 'phone']) {
			await eventually(async () => (await sentIn(page, width)) === SENT, 8000, `Sent in the ${width} frame`);
		}
		// The sent panel is a grey rounded card with a bold heading (#state-sent), in place of the form.
		const look = await inWidth(page, 'desktop', (d) => {
			const card = d.querySelector('form[data-caracms-form="contact"] .cms-form-sent')!;
			const c = getComputedStyle(card);
			return { bg: c.backgroundColor, radius: c.borderTopLeftRadius, weight: getComputedStyle(card.querySelector('.cms-form-sent-heading')!).fontWeight, fields: d.querySelectorAll('form[data-caracms-form="contact"] .cms-form-field').length };
		});
		assert.deepEqual(look, { bg: 'rgb(245, 245, 245)', radius: '4px', weight: '650', fields: 0 });
		assert.equal(await inWidth(page, 'desktop', (d) => d.querySelector('[data-cms-block="0"]')!.outerHTML), hero, 'the Hero as it was');
		assert.equal(await switchIn(page).locator('button[aria-checked="true"]').first().textContent(), 'Sent');
		// Another block: the form's first look again.
		await frameOn(page).locator('[data-cms-block="0"] [data-cms-field="heading"]').click();
		await eventually(async () => (await sentIn(page, 'desktop')) === '', 8000, 'the form back to its first look');
		// Back on the form, Sent again, then a reload: its first look.
		await frameOn(page).locator('[data-cms-block="1"] [data-cms-field="intro"]').click();
		await eventually(async () => (await switchIn(page).count()) > 0, 8000, 'the switch');
		await switchIn(page).locator('.cms-states:not(.compact) button[data-state="sent"]').click();
		await eventually(async () => (await sentIn(page, 'desktop')) !== '', 8000, 'Sent');
		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		assert.equal(await sentIn(page, 'desktop'), '', 'a reload: the first look');
		assert.equal(site.read(CONTACT), before, 'nothing about a state is saved');
		await page.close();
	});

	test('Acceptance 14: opening another document from the sidebar puts the form back, and coming back to it shows its first look', async () => {
		const DOCS = '[data-pane-level="documents"]';
		const page = await formSelected();
		await switchIn(page).locator('.cms-states:not(.compact) button[data-state="sent"]').click();
		await eventually(async () => (await sentIn(page, 'desktop')) !== '', 8000, 'Sent');
		// Up to the documents list, to About, and back to Contact.
		for (let i = 0; i < 3 && !(await page.isVisible(DOCS)); i++) await page.click('.side-level:not([hidden]) .lv >> nth=0');
		await page.waitForSelector(DOCS, { state: 'visible' });
		await page.click(`${DOCS} [data-doc="pages/about"]`);
		await page.waitForURL('**/admin/pages/about');
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		await eventually(async () => (await switchIn(page).count()) === 0, 8000, 'no switch on About');
		for (let i = 0; i < 3 && !(await page.isVisible(DOCS)); i++) await page.click('.side-level:not([hidden]) .lv >> nth=0');
		await page.click(`${DOCS} [data-doc="pages/contact"]`);
		await page.waitForURL('**/admin/pages/contact');
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		assert.equal(await sentIn(page, 'desktop'), '', 'Contact opens on the form’s first look');
		await frameOn(page).locator('[data-cms-block="1"] [data-cms-field="intro"]').click();
		await eventually(async () => (await switchIn(page).count()) > 0, 8000, 'the switch');
		assert.equal(await switchIn(page).locator('button[aria-checked="true"]').first().textContent(), 'First look');
		assert.equal(await sentIn(page, 'desktop'), '');
		await page.close();
	});

	test('Acceptance 13: in Sent, its line typed on the page opens Site Settings over the page, saves there, and Sent stays', async () => {
		const page = await formSelected();
		await switchIn(page).locator('.cms-states:not(.compact) button[data-state="sent"]').click();
		await eventually(async () => (await sentIn(page, 'desktop')) !== '', 8000, 'Sent');
		await frameOn(page).locator('form[data-caracms-form="contact"] .cms-form-sent-line').click();
		await page.waitForSelector(`${DOC} .field-frame.is-picked[data-ff="formWords.contact.sent.line"]`);
		// The line wraps in the card, so End may stop at its first line's end: QX lands somewhere in it.
		await page.keyboard.press('End');
		await page.keyboard.type(' QX');
		await eventually(() => / QX/.test(formSettings()?.contact?.sent?.line ?? ''), 10000, 'the line kept in Site Settings');
		// Still Sent, with the switch kept (quietly) over the page while Site Settings is open.
		assert.match(await sentIn(page, 'desktop'), / QX/);
		assert.equal(await switchIn(page).locator('button[aria-checked="true"]').first().textContent(), 'Sent');
		await page.waitForTimeout(600);
		assert.match(await sentIn(page, 'tablet'), / QX/, 'the other widths too');
		// Couldn't send and Invalid draw their words.
		await switchIn(page).locator('.cms-states:not(.compact) button[data-state="error"]').click();
		await eventually(async () => /Something went wrong/.test(await statusIn(page, 'desktop')), 8000, 'Couldn’t send');
		await switchIn(page).locator('.cms-states:not(.compact) button[data-state="invalid"]').click();
		await eventually(() => inWidth(page, 'desktop', (d) => d.querySelectorAll('.cms-form-field.cms-form-invalid').length === 4), 8000, 'Invalid: the four required fields');
		// Each says so (aria-invalid), with the red edge a real failed submit gives (#state-invalid).
		const invalid = await inWidth(page, 'desktop', (d) =>
			[...d.querySelectorAll('form[data-caracms-form="contact"] .cms-form-field')].map((f) => {
				const control = f.querySelector('input, select, textarea')!;
				return { invalid: f.classList.contains('cms-form-invalid'), aria: control.getAttribute('aria-invalid'), border: getComputedStyle(control).borderTopColor };
			}),
		);
		assert.ok(invalid.some((f) => !f.invalid), 'an optional field among them');
		for (const f of invalid) assert.deepEqual({ aria: f.aria, red: f.border === 'rgb(155, 44, 31)' }, f.invalid ? { aria: 'true', red: true } : { aria: null, red: false });
		await page.close();
	});

	test('Invalid looks as a real failed submit does: the public page, its button pressed with nothing filled in', async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		await page.goto(site.origin + '/contact');
		await page.click('form[data-caracms-form="contact"] .cms-form-submit');
		const name = page.locator('#cms-form-contact-name');
		assert.equal(await name.evaluate((el) => el.matches(':user-invalid')), true);
		assert.equal(await name.evaluate((el) => getComputedStyle(el).borderTopColor), 'rgb(155, 44, 31)');
		assert.equal(await page.locator('#cms-form-contact-name-error').isVisible(), true, 'its error showing');
		await page.close();
	});

	test('a state whose render fails: "Preview not updated", and the switch stays on what the page shows', async () => {
		const page = await formSelected();
		// The render that asks for Sent fails (the state rides in the render's body).
		const failSent = (route: import('playwright-core').Route) => (/"name":"sent"/.test(route.request().postData() ?? '') ? route.fulfill({ status: 500, body: 'boom' }) : route.fallback());
		await page.route('**/_caracms/preview**', failSent);
		await switchIn(page).locator('.cms-states:not(.compact) button[data-state="sent"]').click();
		await eventually(async () => (await switchIn(page).locator('button[aria-checked="true"]').first().textContent()) === 'First look', 10000, 'the switch back on First look');
		assert.equal(await sentIn(page, 'desktop'), '', 'the page keeps its last good render');
		// Choosing it again, once it can render, retries it.
		assert.match((await page.textContent('.bar-warn')) ?? '', /Preview not updated/);
		await page.unroute('**/_caracms/preview**', failSent);
		await switchIn(page).locator('.cms-states:not(.compact) button[data-state="sent"]').click();
		// (an earlier test typed into its line, so only the heading is known)
		await eventually(async () => (await sentIn(page, 'desktop')).startsWith('Thanks, it’s sent '), 10000, 'Sent drawn');
		assert.equal(await switchIn(page).locator('button[aria-checked="true"]').first().textContent(), 'Sent');
		await page.close();
	});

	test('Acceptance 19 and 21: a label is typed in Site Settings over the page; the email box focuses its placeholder’s control; the button sends nothing', async () => {
		const requests: string[] = [];
		// Inside a block, the first click selects it (edit in context, Decision 7): the Form block is selected first.
		const page = await formSelected();
		page.on('request', (r) => requests.push(r.url()));
		await frameOn(page).locator('[data-cms-field="formWords.contact.fields.name.label"]').click();
		await page.waitForSelector(`${DOC} .field-frame.is-picked[data-ff="formWords.contact.fields.name.label"]`);
		// Its tag names the word by its whole path (#word-label).
		await eventually(async () => (await frameOn(page).locator('#cms-overlays [data-field="formWords.contact.fields.name.label"] .cms-chip').first().textContent().catch(() => '')) === 'Site Settings ›Forms › Contact › Your name', 8000, 'the tag “Site Settings › Forms › Contact › Your name”');
		await page.keyboard.type('!');
		await eventually(() => /!/.test(formSettings()?.contact?.fields?.name?.label ?? ''), 10000, 'the label in Site Settings');
		// Only the word set is written (Watch-outs: Site Settings stays empty until one changes).
		assert.doesNotMatch(JSON.stringify(formSettings()), /""|\{\}/, 'no blank word, no empty group');
		assert.equal(formSettings()!.workshop, undefined);
		// The email box: its placeholder's control in the sidebar, nothing typed in the page's input.
		await frameOn(page).locator('#cms-form-contact-email').click();
		await eventually(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.path === 'formWords.contact.fields.email.placeholder'), 8000, 'the placeholder’s control focused');
		await page.keyboard.type('you@');
		assert.equal(await frameOn(page).locator('#cms-form-contact-email').inputValue(), '');
		// The button and the select: no post, no focus taken.
		await frameOn(page).locator('.cms-form-submit').click();
		await frameOn(page).locator('#cms-form-contact-kind').click();
		await page.waitForTimeout(400);
		assert.ok(!requests.some((u) => u.includes('/_caracms/form')), 'nothing sent');
		assert.equal(await inWidth(page, 'desktop', (d) => d.activeElement?.id ?? ''), '', 'the select took no focus');
		await page.close();
	});

	test('Acceptance 16: Site Settings › Forms, a group per form, its words then its emails; a blank word shows the config’s', async () => {
		const page = await open('/admin/settings');
		const contact = page.locator(`${DOC} details[data-form-words="contact"]`);
		assert.equal(await page.locator(`${DOC} [data-sec="forms"] h3`).textContent(), 'Forms');
		assert.equal(await page.locator(`${DOC} details[data-form-words]`).count(), 2);
		await contact.locator('> summary').click();
		await contact.locator('[data-item="contact.email"] .item-sum').click();
		const placeholder = contact.locator('[data-path="formWords.contact.fields.email.label"]');
		assert.equal(await placeholder.getAttribute('placeholder'), 'Email');
		assert.equal(await contact.locator('[data-path="formWords.contact.submit"]').getAttribute('placeholder'), 'Send');
		assert.ok(await contact.locator('[data-field="rcpt-contact"]').count(), 'its emails, after its words');
		await page.close();
	});
});
