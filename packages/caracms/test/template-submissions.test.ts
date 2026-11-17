// M9 Decision 17 (Acceptance 7): a submission stored in the Tina template's format reads in caracms's inbox.
//
// The fixture (`fixtures/template-submissions/`) is the template's bucket as the template's server writes it
// (`server/submission-store.mjs`, its submissions bucket): one `<id>.json` per submission at the top
// level, `JSON.stringify(record, null, 2)` plus a newline, the files beside it at `<id>/<n>-<safe name>`.
// The record is `{ v: 1, id, form, receivedAt, fields, files?, readAt, email?, onSubmit? }`. Two are the site's
// own forms (`contact`, `newsletter`); the third is the template at its widest: a form no longer in the
// config, a site field type's non-string value, a file, and `onSubmit`, which caracms doesn't write.
// The inbox reads the folder through the store's folder backend, the same `<id>.json` keys the bucket has.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveSite } from '../src/config.ts';
import { handleSubmissions, type InboxContext, type SubmissionResponse, type SubmissionsListResponse } from '../src/forms/inbox.ts';
import { folderBackend, storeOver } from '../src/forms/store.ts';
import { siteRoot, variant } from './helpers/site.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/template-submissions/', import.meta.url));
const ORIGIN = 'http://template.test';
const CONTACT = '2026-10-20T08-12-45-301Z_q7m2xa';
const NEWSLETTER = '2026-10-21T19-03-11-904Z_b4k8pz';
const QUOTE = '2026-09-30T14-22-08-517Z_m1x4c9';

// The site's two forms (`forms.config.mjs`) in caracms's config.
const site = resolveSite(
	variant({
		forms: {
			contact: {
				label: 'Contact',
				email: { subject: 'New contact enquiry' },
				fields: {
					firstName: { label: 'First Name', autocomplete: 'given-name' },
					lastName: { label: 'Last Name', autocomplete: 'family-name' },
					email: { label: 'Email Address', type: 'email', autocomplete: 'email' },
					message: { label: 'Message', type: 'textarea' },
				},
			},
			newsletter: {
				label: 'Newsletter',
				email: { subject: 'New newsletter sign-up' },
				fields: {
					firstName: { label: 'First Name', autocomplete: 'given-name', optional: true },
					lastName: { label: 'Last Name', autocomplete: 'family-name', optional: true },
					email: { label: 'Email Address', type: 'email', autocomplete: 'email' },
				},
			},
		},
	}),
	siteRoot,
);

const ctxOver = (dir: string): InboxContext => ({ site, mode: 'local', person: null, store: storeOver(folderBackend(dir)), log: () => {} });
const get = (path: string, ctx: InboxContext) => handleSubmissions(new Request(`${ORIGIN}${path}`), ctx);

describe("the template's stored submissions in the inbox (M9 Acceptance 7)", () => {
	const fixture = ctxOver(FIXTURE);

	test('they are listed newest first, with the rows the inbox shows', async () => {
		const res = await get('/_caracms/submissions', fixture);
		assert.equal(res.status, 200);
		const list = (await res.json()) as SubmissionsListResponse;
		assert.deepEqual(
			list.items.map((r) => [r.id, r.formLabel, r.name, r.email, r.snippet, r.readAt, r.files, r.emailStatus]),
			[
				[NEWSLETTER, 'Newsletter', 'sam@example.org', 'sam@example.org', '', '2026-10-21T20:00:00.000Z', 0, 'failed'],
				[CONTACT, 'Contact', 'Ana R.', 'ana@example.com', 'Hi CaraCMS team, we would love to book a games night for twenty people in November.', null, 0, 'sent'],
				[QUOTE, 'quote', 'jo@example.org', 'jo@example.org', '', '2026-10-01T09:00:00.000Z', 1, 'skipped'],
			],
		);
		assert.equal(list.unread, 1);
		assert.equal(list.older, null);
	});

	test('one opens with its fields, its email outcome and its form as the config has it', async () => {
		const res = await get(`/_caracms/submissions/${CONTACT}`, fixture);
		assert.equal(res.status, 200);
		const { submission, form } = (await res.json()) as SubmissionResponse;
		const stored = JSON.parse(await readFile(join(FIXTURE, `${CONTACT}.json`), 'utf8'));
		assert.deepEqual(submission, stored, 'the record as the template stored it');
		assert.equal(form!.label, 'Contact');
		assert.deepEqual(form!.fields.map((f) => f.name), ['firstName', 'lastName', 'email', 'message']);
	});

	test("a form gone from the config, a site type's value, onSubmit and a file: shown by name, and the file downloads", async () => {
		const { submission, form } = (await (await get(`/_caracms/submissions/${QUOTE}`, fixture)).json()) as SubmissionResponse;
		assert.equal(form, null, 'shown by the stored field names');
		assert.deepEqual(submission.fields, { name: 'Jo', email: 'jo@example.org', budget: { min: 500, max: 900 } });
		assert.deepEqual((submission as unknown as { onSubmit: unknown }).onSubmit, { status: 'done', at: '2026-09-30T14:22:08.590Z' });
		const file = await get(`/_caracms/submissions/${QUOTE}/files/1`, fixture);
		assert.equal(file.status, 200);
		assert.equal(file.headers.get('content-type'), 'application/pdf');
		assert.equal(file.headers.get('content-disposition'), 'attachment; filename="Site plan.pdf"');
		assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(await readFile(join(FIXTURE, QUOTE, '1-Site-plan.pdf'))));
	});

	describe('marked read on a copy', () => {
		let dir = '';
		after(() => (dir ? rm(dir, { recursive: true, force: true }) : undefined));

		test("caracms's rewrite keeps the template's keys, onSubmit included", async () => {
			dir = await mkdtemp(join(tmpdir(), 'caracms-template-submissions-'));
			await cp(FIXTURE, dir, { recursive: true });
			const ctx = ctxOver(dir);
			const before = JSON.parse(await readFile(join(dir, `${QUOTE}.json`), 'utf8'));
			const unread = await handleSubmissions(new Request(`${ORIGIN}/_caracms/submissions/${QUOTE}/unread`, { method: 'POST', headers: { Origin: ORIGIN } }), ctx);
			assert.equal(unread.status, 204);
			const afterUnread = JSON.parse(await readFile(join(dir, `${QUOTE}.json`), 'utf8'));
			assert.deepEqual(afterUnread, { ...before, readAt: null });
			assert.equal(((await (await get('/_caracms/submissions', ctx)).json()) as SubmissionsListResponse).unread, 2);
		});
	});
});
