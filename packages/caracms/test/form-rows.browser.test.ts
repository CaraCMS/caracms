// Form rows and sourced selects, the page in a
// real browser, on a throwaway copy of the demo under `astro dev` run on the rows config
// (`useRowsConfig`: the workshops collection and the booking form), whose Contact page's Form block
// is set to `booking` (no fixture page shows it), with the in-memory submissions store.
//
// Acceptance 20: without JavaScript the form is one row, its narrowed select offering every option,
//   and that row posts and is accepted (the native post and its 303).
// Acceptance 21: with the form script: Add adds a row up to max, then the at-most line shows and Add
//   goes; Remove takes a row out and the rest still post in order; a pick in the source column changes
//   the narrowed column's choices in that row only, keeping the value when still allowed; a blank added
//   row doesn't stop the form sending.
// Acceptance 22: in the editor's preview, a rows field's words are typed on the page (they open
//   Site Settings › Forms at that word, and typing saves it), and Invalid shows each column's error line.
// Acceptance 17 and 19 (the inbox sheet, in the same editor site): a rows value as lines in the
//   field's place, "Not given" with no rows, a list of a form that's gone as `column: value` lines.
//
//   node --test --experimental-strip-types test/form-rows.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, useRowsConfig, type DevSite } from './helpers/dev-site.ts';
import { resetSubmissions, submissionStore, type SubmissionStore } from '../src/forms/store.ts';

let site: DevSite;
let browser: Browser;

const FORM = 'form[data-caracms-form="booking"]';
const FIELD = `${FORM} [data-caracms-rows="bookings"]`;
const ROWS = `${FIELD} [data-caracms-row]`;
const ADD = `${FIELD} [data-caracms-add]`;
const AT_MOST = `${FIELD} [data-caracms-at-most]`;
const STATUS = `${FORM} [data-caracms-form-status]`;
const store = (): SubmissionStore => submissionStore({ kind: 'memory' }) as SubmissionStore;
const cell = (row: number, column: string) => `${FIELD} [name="bookings[${row}][${column}]"]`;

/** The booking form on the Contact page, its name and email filled in. */
async function booking(context: { newPage(): Promise<Page> } = browser): Promise<Page> {
	const page = await (context as Browser).newPage({ viewport: { width: 1280, height: 1000 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(`${site.origin}/contact`);
	await page.waitForSelector(`${FORM}[data-caracms-form-ready]`);
	await page.waitForSelector(`${FORM}[data-caracms-rows-ready]`);
	await page.fill(`${FORM} [name="name"]`, 'Saoirse');
	await page.fill(`${FORM} [name="email"]`, 'saoirse@example.com');
	return page;
}

const optionsOf = (page: Page, selector: string) => page.locator(`${selector} option`).evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value));
const namesOf = (page: Page) => page.locator(`${ROWS}`).evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].map((c) => c.name)));

async function send(page: Page) {
	await page.click(`${FORM} button[type="submit"]`);
	await page.waitForFunction((s) => /Thanks/.test(document.querySelector(s)?.textContent ?? ''), STATUS, { timeout: 10000 });
}

/** The one stored submission's bookings. */
async function sentBookings(): Promise<unknown> {
	const { items } = await store().list();
	assert.equal(items.length, 1, 'one submission stored');
	return items[0]!.fields.bookings;
}

describe('the public booking form: a rows field in a browser (form rows 20, 21)', { skip: browserSkip }, () => {
	before(async () => {
		process.env.CARACMS_SUBMISSIONS = 'memory';
		site = await startDevSite('form-rows', {
			edit: (root) => {
				useRowsConfig(root);
				// The Contact page's Form block shows the booking form.
				const page = join(root, 'content/pages/contact.json');
				const source = readFileSync(page, 'utf8');
				const edited = source.replace('"form": "contact"', '"form": "booking"');
				assert.notEqual(edited, source, "the copy's Contact page shows the booking form");
				writeFileSync(page, edited);
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

	test('20. without JavaScript: one row, the narrowed select offers every option, and the row posts and is accepted', { timeout: 60000 }, async () => {
		const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 1000 } });
		const page = await context.newPage();
		await page.goto(`${site.origin}/contact`);
		assert.equal(await page.locator(ROWS).count(), 1, 'one row');
		assert.equal(await page.locator(`${FORM}[data-caracms-form-ready]`).count(), 0, 'no script ran');
		assert.deepEqual(await optionsOf(page, cell(0, 'session')), ['morning', 'afternoon'], 'every option, whichever workshop');
		assert.deepEqual(await optionsOf(page, cell(0, 'workshop')), ['', 'riso-basics', 'two-colour-posters'], 'the open workshops, after the blank choice');
		for (const column of ['workshop', 'places', 'session']) assert.equal(await page.locator(cell(0, column)).evaluate((el) => (el as HTMLInputElement).required), true, `${column} is required (the rows field is)`);
		await page.fill(`${FORM} [name="name"]`, 'Saoirse');
		await page.fill(`${FORM} [name="email"]`, 'saoirse@example.com');
		await page.selectOption(cell(0, 'workshop'), 'two-colour-posters');
		await page.fill(cell(0, 'places'), '2.5');
		await page.selectOption(cell(0, 'session'), 'afternoon');
		await Promise.all([page.waitForURL('**/contact?sent=1'), page.click(`${FORM} button[type="submit"]`)]);
		assert.deepEqual(await sentBookings(), [{ workshop: 'two-colour-posters', places: '2.5', session: 'afternoon' }]);
		await context.close();
	});

	test('21. Add adds a row up to max (4); then the at-most line shows and Add goes; Remove brings both back', { timeout: 60000 }, async () => {
		const page = await booking();
		assert.equal(await page.locator(ROWS).count(), 1);
		assert.equal(await page.locator(ADD).isVisible(), true, 'Add shows');
		assert.equal(await page.locator(AT_MOST).isHidden(), true, 'no at-most line yet');
		assert.equal(await page.locator(`${ROWS} .cms-form-row-remove`).count(), 0, 'no Remove on the first row');
		for (let n = 2; n <= 4; n++) {
			await page.click(ADD);
			assert.equal(await page.locator(ROWS).count(), n);
			assert.equal(await page.locator(`${ROWS} .cms-form-row-n`).last().textContent(), String(n), 'the row is numbered');
		}
		assert.equal(await page.locator(ADD).isHidden(), true, 'Add goes at max');
		assert.equal(await page.locator(AT_MOST).isVisible(), true, 'the at-most line shows');
		assert.equal((await page.locator(AT_MOST).textContent())?.trim(), 'That’s the most this form takes.');
		assert.equal(await page.locator(`${ROWS} .cms-form-row-remove`).count(), 3, 'a Remove on each row from the second');
		// Added rows' controls are never required; the first row's are.
		assert.deepEqual(await page.locator(`${ROWS} select, ${ROWS} input`).evaluateAll((cs) => (cs as HTMLInputElement[]).map((c) => c.required)), [true, true, true, ...Array(9).fill(false)]);
		await page.locator(`${ROWS} .cms-form-row-remove`).last().click();
		assert.equal(await page.locator(ROWS).count(), 3);
		assert.equal(await page.locator(ADD).isVisible(), true, 'Add is back');
		assert.equal(await page.locator(AT_MOST).isHidden(), true, 'the at-most line goes');
		await page.close();
	});

	test('21. Remove takes a row out and the rest still post, renumbered, in order', { timeout: 60000 }, async () => {
		const page = await booking();
		await page.selectOption(cell(0, 'workshop'), 'riso-basics');
		await page.fill(cell(0, 'places'), '2');
		await page.click(ADD);
		await page.selectOption(cell(1, 'workshop'), 'two-colour-posters');
		await page.fill(cell(1, 'places'), '3');
		await page.selectOption(cell(1, 'session'), 'afternoon');
		await page.click(ADD);
		await page.selectOption(cell(2, 'workshop'), 'riso-basics');
		await page.fill(cell(2, 'places'), '1');
		// Take the middle one out: the third becomes the second.
		await page.locator(`${ROWS} .cms-form-row-remove`).first().click();
		assert.equal(await page.locator(ROWS).count(), 2);
		assert.deepEqual(await namesOf(page), [
			['bookings[0][workshop]', 'bookings[0][places]', 'bookings[0][session]'],
			['bookings[1][workshop]', 'bookings[1][places]', 'bookings[1][session]'],
		]);
		assert.deepEqual(await page.locator(`${ROWS} .cms-form-row-n`).allTextContents(), ['1', '2']);
		await send(page);
		assert.deepEqual(await sentBookings(), [
			{ workshop: 'riso-basics', places: '2', session: 'morning' },
			{ workshop: 'riso-basics', places: '1', session: 'morning' },
		]);
		await page.close();
	});

	test('21. a pick in the source column changes the narrowed column in that row only, and keeps the value when still allowed', { timeout: 60000 }, async () => {
		const page = await booking();
		await page.click(ADD);
		await page.click(ADD);
		// Before a pick: the config's else (both), in every row.
		for (const row of [0, 1, 2]) assert.deepEqual(await optionsOf(page, cell(row, 'session')), ['morning', 'afternoon'], `row ${row + 1} before a pick`);
		// Row 1 is set to afternoon, and row 3 is left alone.
		await page.selectOption(cell(0, 'session'), 'afternoon');
		await page.selectOption(cell(2, 'session'), 'afternoon');
		// Row 2 picks the workshop that runs mornings only: its Session narrows, and takes the first allowed.
		await page.selectOption(cell(1, 'session'), 'afternoon');
		await page.selectOption(cell(1, 'workshop'), 'riso-basics');
		assert.deepEqual(await optionsOf(page, cell(1, 'session')), ['morning'], 'row 2 narrowed');
		assert.equal(await page.locator(cell(1, 'session')).inputValue(), 'morning', 'afternoon is no longer allowed, so the first allowed');
		assert.deepEqual(await optionsOf(page, cell(0, 'session')), ['morning', 'afternoon'], 'row 1 untouched');
		assert.deepEqual(await optionsOf(page, cell(2, 'session')), ['morning', 'afternoon'], 'row 3 untouched');
		assert.equal(await page.locator(cell(0, 'session')).inputValue(), 'afternoon', 'row 1 keeps its value');
		assert.equal(await page.locator(cell(2, 'session')).inputValue(), 'afternoon', 'row 3 keeps its value');
		// The workshop that names no sessions offers both again; the value stays when still allowed.
		await page.selectOption(cell(1, 'workshop'), 'two-colour-posters');
		assert.deepEqual(await optionsOf(page, cell(1, 'session')), ['morning', 'afternoon']);
		assert.equal(await page.locator(cell(1, 'session')).inputValue(), 'morning');
		await page.selectOption(cell(1, 'session'), 'afternoon');
		await page.selectOption(cell(1, 'workshop'), 'two-colour-posters');
		assert.equal(await page.locator(cell(1, 'session')).inputValue(), 'afternoon', 'still allowed: kept');
		// Back to the blank choice: the else again, the value kept.
		await page.selectOption(cell(1, 'workshop'), '');
		assert.deepEqual(await optionsOf(page, cell(1, 'session')), ['morning', 'afternoon']);
		assert.equal(await page.locator(cell(1, 'session')).inputValue(), 'afternoon');
		// A row added after a pick starts on the else, not on another row's pick.
		await page.selectOption(cell(0, 'workshop'), 'riso-basics');
		await page.click(ADD);
		assert.deepEqual(await optionsOf(page, cell(3, 'session')), ['morning', 'afternoon']);
		assert.deepEqual(await optionsOf(page, cell(0, 'session')), ['morning']);
		await page.close();
	});

	test('21. a blank added row doesn\'t stop the form sending, and is not stored', { timeout: 60000 }, async () => {
		const page = await booking();
		await page.selectOption(cell(0, 'workshop'), 'riso-basics');
		await page.fill(cell(0, 'places'), '4');
		await page.click(ADD);
		await page.click(ADD);
		// Row 2 is filled; row 3 is left blank (its Session still posts its first choice).
		await page.selectOption(cell(1, 'workshop'), 'two-colour-posters');
		await page.fill(cell(1, 'places'), '1');
		await send(page);
		assert.deepEqual(await sentBookings(), [
			{ workshop: 'riso-basics', places: '4', session: 'morning' },
			{ workshop: 'two-colour-posters', places: '1', session: 'morning' },
		]);
		// The form went back to one row, as the form's reset does.
		await page.waitForFunction((s) => document.querySelectorAll(s).length === 1, ROWS);
		await page.close();
	});

	test('21. the first row still stops a send with nothing in it (it is required); a server refusal shows in the status line', { timeout: 60000 }, async () => {
		const page = await booking();
		await page.click(`${FORM} button[type="submit"]`);
		assert.equal(await page.locator(cell(0, 'workshop')).evaluate((el) => (el as HTMLSelectElement).validity.valueMissing), true, 'the browser stops it');
		assert.equal((await store().list()).items.length, 0, 'nothing posted');
		// A workshop closed since the page was loaded: the server's sentence, naming the row.
		await page.selectOption(cell(0, 'workshop'), 'riso-basics');
		await page.fill(cell(0, 'places'), '2');
		const content = join(site.root, 'content/workshops/riso-basics.json');
		const original = readFileSync(content, 'utf8');
		writeFileSync(content, original.replace('"open": true', '"open": false'));
		try {
			await page.click(`${FORM} button[type="submit"]`);
			await page.waitForFunction((s) => /Booking 1: Workshop: choose one of the options\./.test(document.querySelector(s)?.textContent ?? ''), STATUS, { timeout: 10000 });
		} finally {
			writeFileSync(content, original);
		}
		assert.equal((await store().list()).items.length, 0, 'nothing stored');
		await page.close();
	});
});

describe('the editor\'s preview: a rows field\'s words (form rows 22)', { skip: browserSkip }, () => {
	const DOC = '[data-pane-level="document"]';
	const BLOCK = '[data-pane-level="block"]';
	const SETTINGS = 'content/site-settings.json';
	const frameOn = (page: Page) => page.frameLocator('.frame.on iframe');
	const switchIn = (page: Page) => frameOn(page).locator('#cms-overlays [data-mark="states"]');
	const formSettings = () => JSON.parse(site.read(SETTINGS)).formWords as Record<string, any> | undefined;

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

	/** The Contact page with its Form block (the booking form) selected. */
	async function formSelected(): Promise<Page> {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		page.on('pageerror', (error) => console.error('[page]', error.message));
		await page.goto(`${site.origin}/admin/pages/contact`);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		await frameOn(page).locator('[data-cms-block="1"] [data-cms-field="intro"]').click();
		await page.waitForSelector(BLOCK);
		await eventually(async () => (await switchIn(page).count()) > 0, 8000, 'the switch');
		return page;
	}

	before(async () => {
		// Its own copy: the first describe's site and browser were closed in its `after`.
		process.env.CARACMS_SUBMISSIONS = 'memory';
		site = await startDevSite('form-rows-editor', {
			edit: (root) => {
				useRowsConfig(root);
				const page = join(root, 'content/pages/contact.json');
				const source = readFileSync(page, 'utf8');
				const edited = source.replace('"form": "contact"', '"form": "booking"');
				assert.notEqual(edited, source);
				writeFileSync(page, edited);
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

	test('17, 19. the inbox sheet shows a rows value as lines, "Not given" with none, and a list of a form that is gone as column: value', { timeout: 60000 }, async () => {
		const create = (form: string, fields: Record<string, unknown>, at: string) => store().create({ form, receivedAt: at, fields: fields as never });
		const base = { name: 'Aoife', email: 'aoife@example.org', notes: '' };
		const withRows = await create('booking', { ...base, bookings: [{ workshop: 'riso-basics', places: '2', session: 'morning' }, { workshop: 'two-colour-posters', places: '3', session: 'afternoon' }] }, '2026-11-11T10:00:00.000Z');
		const noRows = await create('booking', { ...base, name: 'Ciaran', bookings: [] }, '2026-11-11T09:00:00.000Z');
		const gone = await create('retired', { name: 'Dara', lines: [{ product: 'paint', amount: '2', unit: 'l' }] }, '2026-11-11T08:00:00.000Z');
		const SHEET = '#stage-aside .sub-sheet';
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		// A sheet opened by its URL is rendered on the server and hydrated: the two must read the
		// same (the zone's name once didn't: one runtime's "Ireland Time", the other's "Irish Time").
		const hydration: string[] = [];
		const note = (text: string) => {
			if (/hydrat|did(?: not|n't) match|Minified React error #(?:418|419|421|422|423|425)\b/i.test(text)) hydration.push(text.split('\n')[0]!);
		};
		page.on('pageerror', (error) => {
			console.error('[page]', error.message);
			note(error.message);
		});
		page.on('console', (message) => {
			if (message.type() === 'error') note(message.text());
		});
		await page.goto(`${site.origin}/admin/submissions/${withRows.id}`);
		await page.waitForSelector(SHEET, { timeout: 20000 });
		const lines = async (name: string) => (await page.locator(`${SHEET} dd[data-value="${name}"]`).innerText()).split('\n').map((l) => l.trim());
		assert.deepEqual(await lines('bookings'), ['Riso basics — 2 Morning', 'Two-colour posters — 3 Afternoon']);
		assert.equal((await page.locator(`${SHEET} h2`).textContent())?.trim(), 'Aoife', 'the list name is unchanged by a rows field');
		await page.goto(`${site.origin}/admin/submissions/${noRows.id}`);
		await page.waitForSelector(SHEET, { timeout: 20000 });
		const bookingsDt = page.locator(`${SHEET} dt`, { hasText: 'Bookings' });
		assert.equal(await bookingsDt.count(), 1);
		assert.equal((await bookingsDt.locator('xpath=following-sibling::dd[1]').textContent())?.trim(), 'Not given');
		await page.goto(`${site.origin}/admin/submissions/${gone.id}`);
		await page.waitForSelector(SHEET, { timeout: 20000 });
		const text = await page.locator(SHEET).innerText();
		assert.match(text, /product: paint, amount: 2, unit: l/);
		assert.doesNotMatch(text, /object Object/);
		assert.match(await page.locator(`${SHEET} .sub-meta`).innerText(), /Wednesday 11 November 2026, 08:00 \S/, 'the full time, in the site\'s zone');
		assert.deepEqual(hydration, [], 'no hydration error on a sheet opened by its URL');
		await page.close();
	});

	test('22. the row word typed on the page opens Site Settings at that word and saves there; Remove and the at-most line are typed there too', async () => {
		const page = await formSelected();
		const word = 'formWords.booking.fields.bookings.rowLabel';
		await frameOn(page).locator(`[data-cms-field="${word}"]`).click();
		await page.waitForSelector(`${DOC} .field-frame.is-picked[data-ff="${word}"]`);
		await page.keyboard.type('!');
		await eventually(() => /!/.test(formSettings()?.booking?.fields?.bookings?.rowLabel ?? ''), 10000, 'the row word in Site Settings');
		// The other words of the field are typed on the page too, each its own Site Settings field.
		for (const path of ['add', 'remove', 'atMost', 'columns.places.label', 'columns.session.error']) {
			assert.equal(await frameOn(page).locator(`[data-cms-field="formWords.booking.fields.bookings.${path}"]`).count(), 1, `${path} is typed on the page`);
		}
		await page.close();
	});

	test('22. Invalid shows each column\'s error line, and the line is the column\'s word', async () => {
		const page = await formSelected();
		await switchIn(page).locator('.cms-states:not(.compact) button[data-state="invalid"]').click();
		const errors = () =>
			page.evaluate(() => {
				const doc = (document.querySelector('#stage .frame[data-w="desktop"] iframe') as HTMLIFrameElement).contentDocument!;
				return [...doc.querySelectorAll('form[data-caracms-form="booking"] .cms-form-rows .cms-form-cell')].map((c) => {
					const e = c.querySelector('.cms-form-error') as HTMLElement;
					const r = e.getBoundingClientRect();
					return { id: e.id, shown: getComputedStyle(e).display !== 'none' && r.height > 0, text: e.textContent?.trim() ?? '', aria: c.querySelector('input, select')!.getAttribute('aria-invalid') };
				});
			});
		await eventually(async () => (await errors()).length === 3 && (await errors()).every((e) => e.shown), 10000, 'every column\'s error line showing');
		const lines = await errors();
		assert.deepEqual(lines.map((l) => l.aria), ['true', 'true', 'true']);
		assert.ok(lines.every((l) => l.text.length > 0), 'each says something');
		assert.equal(lines.find((l) => l.id.endsWith('-places-error'))!.text, 'Please enter a number above 0.');
		await page.close();
	});
});
