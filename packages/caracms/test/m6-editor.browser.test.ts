// M6 in a real browser: the inbox (Decision 9), Search and sharing (Decision 13) and Site
// Settings' publish-time fields (Decision 14), on a throwaway copy of the demo under
// `astro dev` (helpers/dev-site.ts, the pinned fixture's content) with the in-memory
// submissions store (CARACMS_SUBMISSIONS=memory) and media (CARACMS_MEDIA=memory).
//
// The inbox (Acceptance 22–28; 22, signed out, is the routes' own test):
// 1. The Site-wide row carries the unread count; the list is newest first, 50 at a time, and
//    Older reaches the 51st and the rest (23).
// 2. Opening one marks it read with a POST …/read; a GET of its route alone doesn't (24).
// 3. Mark unread closes it, and it's unread again (24).
// 4. Delete asks first; Cancel keeps it; Delete for good removes its files, then its JSON (27).
// 5. A field value `<img src=x onerror=alert(1)>` and a file named `<script>.pdf` show as text (26).
// 6. Times are in the site's zone (Europe/Dublin), the email's outcome as the sheet words it (28);
//    6b. a held one (the cloud's, finding 20) is quiet in the list and calm on the sheet.
//    6d. possibly spam (the cloud's spam check): quiet in the list, and "Not spam, send it" lifts it.
// 7. `/admin/submissions/<id>` (the email's link) opens on that submission, in the first paint.
//
// Search and sharing (32):
// 8. Editing a page's search title writes `seo.title` only (every other key's text and place
//    as they were); clearing the last part removes `seo`; a file with no `seo` stays without one.
// 9. A case study's group ends its form, and its title writes the document's own `seo`.
//
// Site Settings (Decision 14):
// 10. The Google tag, pasted as Google's script, offers "Use G-…" and writes the ID.
// 11. Form emails: trimmed, a duplicate isn't added, an invalid address is kept as typed with
//     "Gets no email".
// 13. Delete that doesn't complete leaves it listed (Acceptance 27): a 500 from the route, and a
//     404 that isn't the app's (a proxy's, as Railway's edge answers while a deploy switches),
//     each say so and keep the row; a double click on Delete for good sends one delete.
// 14. Delete one, then straight on to the other (the walk): A's answer held back while its dialog is
//     left and B is opened and confirmed. A's late answer closes nothing of B's; a failed B is said;
//     and the list ends as the server has it.
// 12. The Form block's hint follows Site Settings: seen first with no one, then a recipient
//     added in Site Settings, the hint names it on coming back (the walk's stale hint).
//
//   node --test --experimental-strip-types test/m6-editor.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { memorySubmissions, resetSubmissions, submissionStore, type StoredSubmission, type SubmissionStore } from '../src/forms/store.ts';

let site: DevSite;
let browser: Browser;

const SIDE = '#side';
const INBOX = '[data-pane-level="submissions"]';
const DOC = '[data-pane-level="document"]';
const SHEET = '#stage-aside .sub-sheet';

const store = (): SubmissionStore => submissionStore({ kind: 'memory' }) as SubmissionStore;

/** A contact message received at `at` (ISO), unread, with an email outcome unless `email: null`. */
async function contact(at: string, values: Partial<Record<string, string>> = {}, extra: { files?: { name: string; data: string }[]; email?: StoredSubmission['email'] | null } = {}): Promise<StoredSubmission> {
	const s = await store().create({
		form: 'contact',
		receivedAt: at,
		fields: { name: 'Saoirse', email: 'saoirse@example.com', phone: '', kind: 'website', message: 'We run a surf school in Lahinch.', ...values } as Record<string, string>,
		files: (extra.files ?? []).map((f) => ({ name: f.name, type: 'application/pdf', data: new TextEncoder().encode(f.data) })),
	});
	if (extra.email !== null) await store().update(s.id, { email: extra.email ?? { status: 'sent', at, to: ['niamh@example.com'] } });
	return (await store().get(s.id))!;
}

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	// A script the visitor typed must never run: any dialog fails the test.
	page.on('dialog', (dialog) => {
		throw new Error(`a dialog opened: ${dialog.message()}`);
	});
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

const json = (file: string) => JSON.parse(site.read(file)) as Record<string, unknown>;

describe('M6 in the editor: the inbox, Search and sharing, Site Settings', { skip: browserSkip }, () => {
	before(async () => {
		process.env.CARACMS_SUBMISSIONS = 'memory';
		process.env.CARACMS_MEDIA = 'memory';
		site = await startDevSite('m6-editor');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
		resetSubmissions();
		delete process.env.CARACMS_SUBMISSIONS;
		delete process.env.CARACMS_MEDIA;
	});
	beforeEach(() => resetSubmissions());

	test('1. the Site-wide row counts the unread; the list is newest first, 50 at a time, Older reaches the rest', { timeout: 60000 }, async () => {
		// 55 messages a minute apart; the newest is the 55th.
		for (let i = 1; i <= 55; i++) await contact(new Date(Date.UTC(2026, 9, 14, 9, i)).toISOString(), { name: `Visitor ${i}` });
		await store().update((await store().list({ limit: 1 })).items[0]!.id, { readAt: new Date().toISOString() });
		const page = await open('/admin');
		await page.click(`${SIDE} .lv >> nth=0`).catch(() => undefined);
		const row = page.locator(`${SIDE} [data-act="open-subs"]`);
		await row.waitFor();
		assert.equal((await row.locator('.ucnt').textContent())?.trim(), '54', 'the unread pill');
		assert.equal(await row.getAttribute('aria-label'), 'Submissions, 54 unread');
		await row.click();
		await page.waitForSelector(`${INBOX} .srow`);
		assert.equal(new URL(page.url()).pathname, '/admin/submissions');
		const names = async () => page.locator(`${INBOX} .srow .who`).allTextContents();
		const first = await names();
		assert.equal(first.length, 50, '50 at a time');
		assert.equal(first[0], 'Visitor 55', 'newest first');
		assert.equal(first[49], 'Visitor 6');
		assert.equal(await page.locator(`${INBOX} .srow >> nth=0`).getAttribute('class'), 'srow', 'the newest was read');
		assert.match((await page.locator(`${INBOX} .srow >> nth=1`).getAttribute('class')) ?? '', /is-unread/);
		assert.equal((await page.locator(`${INBOX} .n-chip`).textContent())?.trim(), '54 unread');
		await page.click(`${INBOX} [data-act="subs-older"]`);
		await eventually(async () => (await names()).length === 55, 8000, 'the next page');
		assert.equal((await names())[50], 'Visitor 5', 'the 51st');
		assert.equal((await page.locator(`${INBOX} .subs-foot .kb-hint`).textContent())?.trim(), 'No older messages.');
		await page.close();
	});

	test('2–3. opening one marks it read (a POST, not the GET); Mark unread closes it and makes it unread again', { timeout: 60000 }, async () => {
		const s = await contact('2026-10-15T13:12:00.000Z', {}, { files: [{ name: 'Surf shop brief.pdf', data: '%PDF-1.4 brief' }] });
		await contact('2026-10-14T09:00:00.000Z', { name: 'Older one' });
		const page = await open('/admin/submissions');
		await page.waitForSelector(`${INBOX} .srow`);
		// A GET of its route alone changes nothing.
		const got = await page.evaluate(async (id) => (await (await fetch(`/_caracms/submissions/${id}`)).json()).submission.readAt, s.id);
		assert.equal(got, null);
		assert.equal((await store().get(s.id))!.readAt, null, 'still unread after the GET');
		const reads: string[] = [];
		page.on('request', (r) => r.method() === 'POST' && reads.push(new URL(r.url()).pathname));
		await page.click(`${INBOX} .srow[data-id="${s.id}"]`);
		await page.waitForSelector(SHEET);
		assert.equal(new URL(page.url()).pathname, `/admin/submissions/${s.id}`);
		await eventually(async () => (await store().get(s.id))!.readAt !== null, 8000, 'marked read');
		assert.deepEqual(reads, [`/_caracms/submissions/${s.id}/read`]);
		assert.match((await page.locator(`${INBOX} .srow[data-id="${s.id}"]`).getAttribute('class')) ?? '', /is-current/);
		assert.doesNotMatch((await page.locator(`${INBOX} .srow[data-id="${s.id}"]`).getAttribute('class')) ?? '', /is-unread/);
		await eventually(async () => (await page.locator(`${INBOX} .n-chip`).textContent())?.trim() === '1 unread', 8000, 'the count dropped');
		// The sheet: the form, who, the address, the file with its size, Reply by email.
		assert.equal((await page.locator(`${SHEET} h2`).textContent())?.trim(), 'Saoirse');
		assert.equal((await page.locator(`${SHEET} .from`).textContent())?.trim(), 'saoirse@example.com');
		assert.equal(await page.locator(`${SHEET} .frow`).getAttribute('href'), `/_caracms/submissions/${s.id}/files/1`);
		assert.match((await page.locator(`${SHEET} .frow small`).textContent()) ?? '', /^14 bytes · PDF$/);
		assert.equal(await page.locator(`${SHEET} [data-act="reply"]`).getAttribute('href'), 'mailto:saoirse%40example.com?subject=Re%3A%20your%20enquiry%20to%20CaraCMS');
		assert.equal((await page.locator(`${SHEET} dd[data-value="kind"]`).textContent())?.trim(), 'A website', "a select's label, not its value");
		// Mark unread: it closes, and it's unread again.
		await page.click(`${SHEET} [data-act="sub-unread"]`);
		await page.waitForSelector(SHEET, { state: 'detached' });
		await eventually(async () => (await store().get(s.id))!.readAt === null, 8000, 'unread again');
		assert.match((await page.locator(`${INBOX} .srow[data-id="${s.id}"]`).getAttribute('class')) ?? '', /is-unread/);
		assert.equal(new URL(page.url()).pathname, '/admin/submissions');
		await eventually(async () => (await page.locator('#toast-root').textContent())?.includes('Marked unread'), 4000, 'the toast');
		assert.equal((await page.locator(`${INBOX} .n-chip`).textContent())?.trim(), '2 unread');
		await page.close();
	});

	test('4. Delete asks first, then removes its files and its JSON', { timeout: 60000 }, async () => {
		const s = await contact('2026-10-15T13:12:00.000Z', {}, { files: [{ name: 'a.pdf', data: 'A' }, { name: 'b.pdf', data: 'B' }] });
		const page = await open(`/admin/submissions/${s.id}`);
		await page.waitForSelector(SHEET);
		await page.click(`${SHEET} [data-act="sub-delete"]`);
		const dialog = page.locator('#modal-root [data-dialog="sub-delete"]');
		await dialog.waitFor();
		assert.match((await dialog.textContent()) ?? '', /Delete Saoirse’s message\?/);
		assert.match((await dialog.textContent()) ?? '', /with its 2 files/);
		await dialog.locator('button', { hasText: 'Cancel' }).click();
		await dialog.waitFor({ state: 'detached' });
		assert.ok(await store().get(s.id), 'Cancel keeps it');
		await page.click(`${SHEET} [data-act="sub-delete"]`);
		await page.click('#modal-root [data-act="sub-delete-confirm"]');
		await page.waitForSelector(SHEET, { state: 'detached' });
		await eventually(async () => (await store().get(s.id)) === null, 8000, 'deleted');
		const calls = memorySubmissions().calls.filter((c) => c.startsWith('remove:'));
		assert.deepEqual(calls, [`remove:${s.id}/1-a.pdf`, `remove:${s.id}/2-b.pdf`, `remove:${s.id}.json`], 'files first, then the JSON');
		assert.equal(await page.locator(`${INBOX} .srow`).count(), 0);
		assert.equal((await page.locator(`${INBOX} .empty b`).textContent())?.trim(), 'No messages yet');
		await eventually(async () => (await page.locator('#toast-root').textContent())?.includes('and its 2 files'), 4000, 'the toast');
		await page.close();
	});

	test('5. what a visitor typed is shown as text, never as HTML', { timeout: 60000 }, async () => {
		const s = await contact('2026-10-15T13:12:00.000Z', { name: '<img src=x onerror=alert(1)>', message: '<script>alert(2)</script><b>bold</b>' }, { files: [{ name: '<script>.pdf', data: 'x' }] });
		const page = await open(`/admin/submissions/${s.id}`);
		await page.waitForSelector(SHEET);
		assert.equal((await page.locator(`${SHEET} h2`).textContent())?.trim(), '<img src=x onerror=alert(1)>');
		assert.equal((await page.locator(`${SHEET} dd[data-value="message"]`).textContent())?.trim(), '<script>alert(2)</script><b>bold</b>');
		assert.equal((await page.locator(`${SHEET} .frow b`).textContent())?.trim(), '<script>.pdf');
		assert.equal((await page.locator(`${INBOX} .srow .who`).textContent())?.trim(), '<img src=x onerror=alert(1)>');
		assert.equal(await page.locator(`${SHEET} img, ${SHEET} script, ${INBOX} .srow img`).count(), 0, 'no element made from it');
		assert.equal(await page.locator(`${SHEET} dd[data-value="message"] *`).count(), 0, 'the message is one text node');
		await page.close();
	});

	test('6–7. times in the site’s zone, the email’s four outcomes, and the email’s link opens on its submission', { timeout: 60000 }, async () => {
		// 13:12 UTC on 15 October is 14:12 in Dublin (summer time).
		const sent = await contact('2026-10-15T13:12:00.000Z', {}, { email: { status: 'sent', at: '2026-10-15T13:12:05.000Z', to: ['niamh@example.com', 'studio@example.com'] } });
		const failed = await contact('2026-10-15T12:00:00.000Z', { name: 'Failed one' }, { email: { status: 'failed', at: '2026-10-15T12:00:01.000Z', to: ['niamh@example.com'], error: 'The example.com domain is not verified.' } });
		const skipped = await contact('2026-10-15T11:00:00.000Z', { name: 'Skipped one' }, { email: { status: 'skipped', at: '2026-10-15T11:00:01.000Z', to: [], error: "No one is set to get the Contact form's emails (Site Settings → Form emails)." } });
		const unknown = await contact('2026-10-15T10:00:00.000Z', { name: 'Unknown one' }, { email: null });
		const page = await open(`/admin/submissions/${sent.id}`);
		// In the first paint: the sheet is the server's.
		assert.equal(await page.locator(SHEET).count(), 1);
		// The zone's name is the server's wording (src/editor/zone-name.ts), which this Node shares; a browser's ICU may word it differently ("Ireland Time", "Irish Time").
		const dublin = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')!.value;
		assert.ok((await page.locator(`${SHEET} .sub-meta`).textContent())?.includes(`Thursday 15 October 2026, 14:12 ${dublin}`), `the sheet's time ends with the server's zone name, ${dublin}`);
		assert.match((await page.locator(`${SHEET} [data-mail="sent"]`).textContent()) ?? '', /Emailed to niamh@example\.com and studio@example\.com at 15 Oct, 14:12\./);
		assert.match((await page.locator(`${INBOX} .srow[data-id="${failed.id}"] .chip.danger`).textContent()) ?? '', /Email failed/);
		assert.equal(await page.locator(`${INBOX} .srow .chip.danger`).count(), 1, 'only a failed email is tagged');
		await page.click(`${INBOX} .srow[data-id="${failed.id}"]`);
		await page.waitForSelector(`${SHEET}[data-submission="${failed.id}"] [data-mail="failed"]`);
		assert.match((await page.locator(`${SHEET} [data-mail="failed"] q`).textContent()) ?? '', /domain is not verified/);
		await page.click(`${INBOX} .srow[data-id="${skipped.id}"]`);
		await page.waitForSelector(`${SHEET}[data-submission="${skipped.id}"] [data-mail="skipped"] [data-act="open-settings"]`);
		await page.click(`${INBOX} .srow[data-id="${unknown.id}"]`);
		await page.waitForSelector(`${SHEET}[data-submission="${unknown.id}"] [data-mail="unknown"]`);
		// Esc closes the sheet, then leaves the inbox.
		await page.keyboard.press('Escape');
		await page.waitForSelector(SHEET, { state: 'detached' });
		await page.keyboard.press('Escape');
		await page.waitForSelector('[data-pane-level="documents"]:not([hidden])');
		await page.close();
	});

	test('6b. a held email (the cloud’s, behind its daily limit; finding 20) is calm: quiet in the list, the cloud’s sentence on the sheet', { timeout: 60000 }, async () => {
		const sentence = "Not emailed yet: this site reached its daily email limit in CaraCMS Cloud (100). It's held, and goes out when CaraCMS raises the limit or tomorrow.";
		const held = await contact('2026-10-15T13:12:00.000Z', { name: 'Held one' }, { email: { status: 'held', at: '2026-10-15T13:12:05.000Z', to: ['niamh@example.com'], error: sentence } });
		const page = await open('/admin/submissions');
		const row = page.locator(`${INBOX} .srow[data-id="${held.id}"]`);
		await row.waitFor();
		assert.equal((await row.locator('.l3 [data-mail="held"]').textContent())?.trim(), 'Email held');
		assert.equal(await row.locator('.chip').count(), 0, 'not tagged as failed');
		assert.match((await row.getAttribute('aria-label')) ?? '', /email held/);
		await row.click();
		const note = page.locator(`${SHEET}[data-submission="${held.id}"] [data-mail="held"]`);
		await note.waitFor();
		assert.equal((await note.getAttribute('class'))?.trim(), 'note', 'the plain note: not warn, not danger');
		assert.equal((await note.locator('b').textContent())?.trim(), 'Email held');
		assert.equal((await note.locator('p').textContent())?.trim(), sentence);
		assert.equal(await page.locator(`${SHEET} [data-mail="skipped"], ${SHEET} [data-mail="failed"]`).count(), 0);
		await page.close();
	});

	test('6c. attachments the cloud didn’t keep (its daily attachment limit): quiet in the list, the cloud’s sentence in place of "No files"', { timeout: 60000 }, async () => {
		const sentence = 'Attachments not kept: this site reached its daily attachment limit in CaraCMS Cloud.';
		const s = await contact('2026-10-15T13:14:00.000Z', { name: 'Files not kept' });
		// Only the cloud's store sets it; the memory store takes it the same way here.
		await store().update(s.id, { filesNote: sentence } as Parameters<SubmissionStore['update']>[1]);
		const page = await open('/admin/submissions');
		const row = page.locator(`${INBOX} .srow[data-id="${s.id}"]`);
		await row.waitFor();
		assert.equal((await row.locator('.l3 [data-files="not-kept"]').textContent())?.trim(), 'Attachments not kept');
		assert.equal(await row.locator('.chip').count(), 0, 'not tagged as a problem');
		assert.match((await row.getAttribute('aria-label')) ?? '', /attachments not kept/);
		await row.click();
		const note = page.locator(`${SHEET}[data-submission="${s.id}"] [data-files="not-kept"]`);
		await note.waitFor();
		assert.equal((await note.getAttribute('class'))?.trim(), 'note', 'the plain note: not warn, not danger');
		assert.equal((await note.locator('p').textContent())?.trim(), sentence);
		assert.equal(await page.locator(`${SHEET} dd.none`).filter({ hasText: 'No files' }).count(), 0, 'in place of "No files"');
		await page.close();
	});

	test('6d. possibly spam (the cloud’s spam check): quiet in the list; "Not spam, send it" lifts the flag and the email goes', { timeout: 60000 }, async () => {
		const sentence = 'Not emailed: CaraCMS marked this enquiry as possibly spam.';
		const at = '2026-10-15T13:16:05.000Z';
		const s = await contact('2026-10-15T13:16:00.000Z', { name: 'Maybe spam' }, { email: { status: 'held', at, to: ['niamh@example.com'], error: sentence } });
		// Only the cloud's store sets it; the memory store takes it the same way here, and lifts it as the cloud does.
		await store().update(s.id, { spam: { at } } as Parameters<SubmissionStore['update']>[1]);
		const page = await open('/admin/submissions');
		const row = page.locator(`${INBOX} .srow[data-id="${s.id}"]`);
		await row.waitFor();
		assert.equal((await row.locator('.l3 [data-mail="spam"]').textContent())?.trim(), 'Possibly spam');
		assert.equal(await row.locator('.l3 [data-mail="held"]').count(), 0, 'said once, as spam, not also as held');
		assert.equal(await row.locator('.chip').count(), 0, 'not tagged as a problem');
		assert.match((await row.getAttribute('aria-label')) ?? '', /possibly spam/);
		await row.click();
		const note = page.locator(`${SHEET}[data-submission="${s.id}"] [data-mail="spam"]`);
		await note.waitFor();
		assert.equal((await note.getAttribute('class'))?.trim(), 'note', 'the plain note: not warn, not danger');
		assert.match((await note.textContent()) ?? '', /CaraCMS marked this enquiry as possibly spam, so the email about it wasn’t sent\./);
		assert.doesNotMatch((await note.textContent()) ?? '', /Haiku|Anthropic|Claude/);
		assert.equal(await page.locator(`${SHEET} [data-mail="held"]`).count(), 0);

		await note.locator('[data-act="sub-not-spam"]').click();
		await page.locator(`${SHEET}[data-submission="${s.id}"] [data-mail="sending"]`).waitFor();
		assert.equal(await page.locator(`${SHEET} [data-mail="spam"]`).count(), 0, 'the flag is gone from the sheet');
		await eventually(async () => (await row.locator('.l3 [data-mail="spam"]').count()) === 0, 8000, 'the row’s label to go');
		assert.doesNotMatch((await row.getAttribute('aria-label')) ?? '', /possibly spam/);
		const stored = (await store().get(s.id))!;
		assert.equal(stored.spam, undefined, 'the store has it as not spam');
		assert.equal(stored.email, undefined, 'its email on its way (the memory store sends nothing)');
		await page.close();
	});

	test('8. a page’s search title writes `seo.title` only; clearing the last part removes `seo`; a page with none stays without', { timeout: 60000 }, async () => {
		const FILE = 'content/pages/contact.json';
		const before = site.read(FILE);
		const page = await open('/admin/pages/contact');
		const group = page.locator(`${DOC} details.seo`);
		await group.waitFor();
		assert.match((await group.locator('summary').textContent()) ?? '', /Title and description set/);
		await group.locator('summary').click();
		const title = page.locator(`${DOC} details.seo input[data-path="title"]`);
		await title.fill('Contact the CaraCMS studio');
		await eventually(() => (json(FILE).seo as Record<string, string>).title === 'Contact the CaraCMS studio', 10000, 'the title kept');
		// Everything but seo.title is as it was, text and place.
		assert.equal(site.read(FILE), before.replace('"title": "Contact CaraCMS"', '"title": "Contact the CaraCMS studio"'));
		// Over 60: amber, kept as written.
		await title.fill('Contact CaraCMS: a small design and print studio on the quay, Cork');
		await page.waitForSelector(`${DOC} details.seo .field-meta.soft-over`);
		await page.waitForSelector(`${DOC} details.seo [data-over]`);
		// Clear both parts: the key goes.
		await title.fill('');
		await page.locator(`${DOC} details.seo textarea[data-path="description"]`).fill('');
		await eventually(() => !Object.hasOwn(json(FILE), 'seo'), 10000, 'seo removed');
		assert.match((await group.locator('summary').textContent()) ?? '', /Uses the site’s defaults/);
		await page.close();

		// Home has no seo: a change to a block keeps it that way.
		const HOME = 'content/pages/index.json';
		assert.equal(Object.hasOwn(json(HOME), 'seo'), false);
		const home = await open('/admin');
		await home.locator(`${DOC} details.seo summary`).click();
		assert.equal(await home.locator(`${DOC} details.seo input[data-path="title"]`).getAttribute('placeholder'), 'CaraCMS, a small design studio', "Home's fallback: Site Settings' title");
		await home.locator(`${DOC} details.seo input[data-path="title"]`).fill('x');
		await home.locator(`${DOC} details.seo input[data-path="title"]`).fill('');
		await home.click(`${DOC} .blist .brow-main >> nth=0`);
		await home.waitForTimeout(2500);
		assert.equal(Object.hasOwn(json(HOME), 'seo'), false, 'no seo key appears');
		await home.close();
	});

	test('9. a case study’s Search and sharing ends its form and writes its own seo', { timeout: 60000 }, async () => {
		const FILE = 'content/case-studies/high-street-coffee.json';
		const page = await open('/admin/case-studies/high-street-coffee');
		const group = page.locator(`${DOC} [data-form] details.seo`);
		await group.waitFor();
		assert.equal(await page.locator(`${DOC} [data-form] > :last-child`).evaluate((el) => el.matches('details.seo')), true, 'at the end of the form');
		await group.locator('summary').click();
		assert.equal(await group.locator('input[data-path="title"]').getAttribute('placeholder'), 'High-street coffee roaster · CaraCMS');
		await group.locator('input[data-path="title"]').fill('High-street coffee roaster: a new identity');
		await eventually(() => (json(FILE).seo as Record<string, string> | undefined)?.title === 'High-street coffee roaster: a new identity', 10000, 'the case study’s seo');
		// The form's own Title isn't the one picked.
		assert.equal(await page.locator(`${DOC} [data-form] > .field-frame[data-ff="title"].is-picked`).count(), 0);
		assert.equal(await page.locator(`${DOC} details.seo .field-frame[data-ff="title"].is-picked`).count(), 1);
		await page.close();
	});

	test('10–11. Site Settings: the Google tag from a pasted script, and Form emails', { timeout: 60000 }, async () => {
		const FILE = 'content/site-settings.json';
		const page = await open('/admin/settings');
		const tag = page.locator('#set-gtag');
		await tag.fill('<script async src="https://www.googletagmanager.com/gtag/js?id=G-8XK2M4QZ1P"></script>');
		assert.equal(await tag.getAttribute('aria-invalid'), 'true');
		await page.click(`${SIDE} [data-act="gtag-fix"]`);
		assert.equal(await tag.inputValue(), 'G-8XK2M4QZ1P');
		assert.equal((await page.locator('#gtag-w').textContent())?.trim(), 'Loads Google Analytics on the live site');
		await eventually(() => json(FILE).googleTag === 'G-8XK2M4QZ1P', 10000, 'the tag kept');

		const contact = page.locator(`${SIDE} [data-field="rcpt-contact"]`);
		// Review gaps (Decision 9): each list sits in its form's group under Forms (closed until opened), as "Who gets its emails".
		await page.click(`${SIDE} details[data-form-words="contact"] > summary`);
		assert.equal((await contact.locator('.field-label').textContent())?.trim(), 'Who gets its emails');
		assert.ok(await page.locator(`${SIDE} details[data-form-words="contact"] [data-field="rcpt-contact"]`).count());
		assert.ok(await page.locator(`${SIDE} details[data-form-words="workshop"] [data-field="rcpt-workshop"]`).count());
		const add = async (v: string) => {
			await contact.locator('input[data-rcpt]').fill(v);
			await contact.locator('button[type="submit"]').click();
		};
		await add('  niamh@example.com  ');
		await add('NIAMH@example.com');
		assert.match((await contact.locator('.field-warn.quiet').textContent()) ?? '', /already on the list/);
		await contact.locator('input[data-rcpt]').fill('aoife@example');
		await contact.locator('.field-warn').first().waitFor();
		await contact.locator('button[type="submit"]').click();
		await eventually(() => JSON.stringify((json(FILE).formRecipients as Record<string, string[]>)?.contact) === JSON.stringify(['niamh@example.com', 'aoife@example']), 10000, 'the recipients kept');
		assert.equal((await contact.locator('[data-recipient="aoife@example"] small').textContent())?.trim(), 'Gets no email');
		assert.equal((await contact.locator('.field-meta').textContent())?.trim(), '1 address');
		assert.equal(await contact.locator('.field-hint').count(), 0, 'the helper line under the recipients is cut (copy scrub)');
		await page.close();
	});

	test('13. a delete that doesn’t complete leaves it listed; a double click sends one delete', { timeout: 60000 }, async () => {
		const one = await contact('2026-10-15T13:12:00.000Z', { name: 'First one' });
		const two = await contact('2026-10-15T12:12:00.000Z', { name: 'Second one' });
		const page = await open('/admin/submissions');
		await page.waitForSelector(`${INBOX} .srow`);
		const deletes: string[] = [];
		page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/delete') && deletes.push(new URL(r.url()).pathname));
		const confirmDelete = async (id: string, how: 'click' | 'dblclick' = 'click') => {
			await page.click(`${INBOX} .srow[data-id="${id}"]`);
			await page.waitForSelector(`${SHEET}[data-submission="${id}"]`);
			await page.click(`${SHEET} [data-act="sub-delete"]`);
			await page[how]('#modal-root [data-act="sub-delete-confirm"]');
		};
		// A 500 from the route: said in the dialog, the row stays.
		await page.route('**/_caracms/submissions/*/delete', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The bucket said no.' }) }), { times: 1 });
		await confirmDelete(one.id);
		await page.waitForSelector('#modal-root [data-dialog="sub-delete"] .field-err');
		await page.keyboard.press('Escape');
		assert.equal(await page.locator(`${INBOX} .srow[data-id="${one.id}"]`).count(), 1, 'kept after a 500');
		// A 404 that isn't the app's (a proxy's page, not the route's JSON): not taken for "already gone".
		await page.route('**/_caracms/submissions/*/delete', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' }), { times: 1 });
		await confirmDelete(two.id);
		await page.waitForSelector('#modal-root [data-dialog="sub-delete"] .field-err');
		await page.keyboard.press('Escape');
		assert.equal(await page.locator(`${INBOX} .srow[data-id="${two.id}"]`).count(), 1, 'kept after a proxy’s 404');
		assert.ok(await store().get(two.id), 'and still stored');
		// Both deleted for real, the second with a double click: one delete each.
		deletes.length = 0;
		await confirmDelete(one.id);
		await page.waitForSelector(`${INBOX} .srow[data-id="${one.id}"]`, { state: 'detached' });
		await confirmDelete(two.id, 'dblclick');
		await page.waitForSelector(`${INBOX} .srow[data-id="${two.id}"]`, { state: 'detached' });
		assert.deepEqual(deletes, [`/_caracms/submissions/${one.id}/delete`, `/_caracms/submissions/${two.id}/delete`]);
		assert.equal(await store().get(one.id), null);
		assert.equal(await store().get(two.id), null);
		await page.close();
	});

	test('14. delete one, then straight on to the other: A’s late answer leaves B alone, and the list ends as stored', { timeout: 60000 }, async () => {
		const a = await contact('2026-10-15T13:12:00.000Z', { name: 'First one' });
		const b = await contact('2026-10-15T12:12:00.000Z', { name: 'Second one' });
		const page = await open('/admin/submissions');
		await page.waitForSelector(`${INBOX} .srow`);
		// A's delete reaches the server, but its answer is held back until released.
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		await page.route(`**/_caracms/submissions/${a.id}/delete`, async (route) => {
			const response = await route.fetch();
			await held;
			await route.fulfill({ response });
		});
		const openAndDelete = async (id: string) => {
			await page.click(`${INBOX} .srow[data-id="${id}"]`);
			await page.waitForSelector(`${SHEET}[data-submission="${id}"]`);
			await page.click(`${SHEET} [data-act="sub-delete"]`);
			await page.waitForSelector(`#modal-root [data-dialog="sub-delete"]`);
		};
		await openAndDelete(a.id);
		await page.click('#modal-root [data-act="sub-delete-confirm"]');
		await eventually(async () => (await store().get(a.id)) === null, 8000, 'A deleted on the server');
		// Straight on: leave A's dialog while its answer is out, open B, ask to delete it.
		await page.keyboard.press('Escape');
		await openAndDelete(b.id);
		// A's answer arrives now: B's sheet and B's dialog stay.
		release();
		await page.waitForSelector(`${INBOX} .srow[data-id="${a.id}"]`, { state: 'detached' });
		await page.waitForTimeout(300);
		assert.equal(await page.locator('#modal-root [data-dialog="sub-delete"]').count(), 1, "B's dialog is still open");
		assert.match((await page.locator('#modal-root [data-dialog="sub-delete"]').textContent()) ?? '', /Second one/);
		assert.equal(await page.locator(`${SHEET}[data-submission="${b.id}"]`).count(), 1, "B's sheet is still open");
		// B's delete fails (a 500): said, and B stays listed and stored.
		await page.route(`**/_caracms/submissions/${b.id}/delete`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The bucket said no.' }) }), { times: 1 });
		await page.click('#modal-root [data-act="sub-delete-confirm"]');
		await page.waitForSelector('#modal-root [data-dialog="sub-delete"] .field-err');
		assert.equal(await page.locator(`${INBOX} .srow[data-id="${b.id}"]`).count(), 1);
		// Pressed again, it goes.
		await page.click('#modal-root [data-act="sub-delete-confirm"]');
		await page.waitForSelector(`${INBOX} .srow[data-id="${b.id}"]`, { state: 'detached' });
		assert.equal(await store().get(b.id), null);
		// The list ends as the server has it.
		await page.waitForTimeout(500);
		const shown = await page.locator(`${INBOX} .srow`).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-id')));
		assert.deepEqual(shown, (await store().list()).items.map((x) => x.id));
		await page.close();
	});

	test('12. the Form block’s hint follows Site Settings’ recipients as drafted', { timeout: 60000 }, async () => {
		// No recipients yet (test 10–11 added some to this copy).
		const settings = json('content/site-settings.json');
		delete settings.formRecipients;
		site.write('content/site-settings.json', `${JSON.stringify(settings, null, 2)}\n`);
		const page = await open('/admin/pages/contact');
		const formBlock = async () => {
			await page.click(`${DOC} .blist > .brow >> nth=1 >> .brow-main`);
			await page.waitForSelector('[data-pane-level="block"] [data-form-hint="contact"]');
		};
		await formBlock();
		await eventually(async () => (await page.locator('[data-form-hint="contact"]').textContent())?.includes('its email goes to no one yet'), 8000, 'no one yet');
		// Site Settings from the documents level, inside the editor (no reload), one recipient added.
		await page.click(`${SIDE} .side-level:not([hidden]) .lv >> nth=0`);
		await page.click(`${SIDE} [data-section="site-wide"] .drow:has-text("Site Settings")`);
		await page.click(`${SIDE} details[data-form-words="contact"] > summary`);
		await page.waitForSelector(`${SIDE} [data-field="rcpt-contact"]`);
		const contact = page.locator(`${SIDE} [data-field="rcpt-contact"]`);
		await contact.locator('input[data-rcpt]').fill('orla@example.com');
		await contact.locator('button[type="submit"]').click();
		// Straight back to Contact, inside the editor (no reload): the hint names the address.
		await page.click(`${SIDE} .side-level:not([hidden]) .rchip:has-text("Contact")`);
		await page.waitForSelector(`${DOC} .blist`);
		await formBlock();
		await eventually(async () => (await page.locator('[data-form-hint="contact"]').textContent())?.includes('its email goes to orla@example.com'), 8000, 'the hint names the address');
		await page.close();
	});
});
