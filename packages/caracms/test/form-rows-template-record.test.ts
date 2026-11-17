// Form rows, Acceptance 18: a record the Tina template wrote (`fields.orderLines = [{ product, amount,
// unit }]`, `v: 1`, in the template's `<id>.json`) opens in the inbox of a self-hosted site whose
// form declares that rows field, with its lines shown. Written to a folder in the template's format
// (as template-submissions.test.ts does for the fixture's records) and read through the folder store.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resolveSite } from '../src/config.ts';
import { rowsLines } from '../src/forms/rules.ts';
import { handleSubmissions, type InboxContext, type SubmissionResponse, type SubmissionsListResponse } from '../src/forms/inbox.ts';
import { folderBackend, storeOver } from '../src/forms/store.ts';
import { siteRoot, variant } from './helpers/site.ts';

const ID = '2026-11-02T09-30-00-000Z_o4d3rx';
const site = resolveSite(
	variant({
		forms: {
			order: {
				label: 'Order',
				email: { subject: 'New order' },
				fields: {
					name: { label: 'Name' },
					email: { label: 'Email', type: 'email' },
					orderLines: {
						label: 'Order',
						type: 'rows',
						columns: {
							product: { label: 'Product', type: 'select', options: [{ value: 'paint', label: 'Paint' }, { value: 'primer', label: 'Primer' }] },
							amount: { label: 'Amount', type: 'number' },
							unit: { label: 'Unit', type: 'select', options: [{ value: 'l', label: 'L' }, { value: 'tin', label: '5L Tin' }] },
						},
					},
				},
			},
		},
	}),
	siteRoot,
);

let dir = '';
before(async () => {
	dir = await mkdtemp(join(tmpdir(), 'caracms-template-order-'));
	const record = {
		v: 1,
		id: ID,
		form: 'order',
		receivedAt: '2026-11-02T09:30:00.000Z',
		fields: { name: 'Rua', email: 'rua@example.org', orderLines: [{ product: 'paint', amount: '2.5', unit: 'l' }, { product: 'primer', amount: '4', unit: 'tin' }] },
		readAt: null,
		email: { status: 'sent', at: '2026-11-02T09:30:01.000Z', to: ['orders@example.org'] },
	};
	await writeFile(join(dir, `${ID}.json`), `${JSON.stringify(record, null, 2)}\n`);
});
after(() => rm(dir, { recursive: true, force: true }));

describe("a template's record with order lines in the inbox (Acceptance 18)", () => {
	const ctx = (): InboxContext => ({ site, mode: 'local', person: null, store: storeOver(folderBackend(dir)), log: () => {} });
	const get = (path: string) => handleSubmissions(new Request(`http://order.test${path}`), ctx());

	test('it is listed, and opens with the lines the form shows for them', async () => {
		const list = (await (await get('/_caracms/submissions')).json()) as SubmissionsListResponse;
		assert.deepEqual(list.items.map((r) => [r.id, r.formLabel]), [[ID, 'Order']]);
		const { submission, form } = (await (await get(`/_caracms/submissions/${ID}`)).json()) as SubmissionResponse;
		const field = form!.fields.find((f) => f.name === 'orderLines')!;
		assert.equal(field.type, 'rows');
		assert.deepEqual(rowsLines(field, submission.fields.orderLines), ['Paint — 2.5 L', 'Primer — 4 × 5L Tin']);
	});
});
