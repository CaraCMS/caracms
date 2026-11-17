// Form rows, Acceptance 15: the stored record has `fields[<name>]` as a list of objects whose values
// are all text, in posted order, on each store the package owns: the folder store (local dev), the
// bucket's store over its in-memory backend, and the process's memory store. (The cloud store is the
// fake-cloud seam test's: cloud-forms.test.ts, Acceptance 27.)
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { MemoryBackend, resetSubmissions, storeOver, submissionStore, type SubmissionStore } from '../src/forms/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'caracms-rows-stores-'));
after(() => {
	rmSync(dir, { recursive: true, force: true });
	resetSubmissions();
});

const lines = [
	{ workshop: 'riso-basics', places: '2', session: 'morning' },
	{ workshop: 'two-colour-posters', places: '2.5', session: 'afternoon' },
	{ workshop: 'riso-basics', places: '1', session: 'morning' },
];
const fields = { name: 'Aoife', email: 'aoife@example.org', bookings: lines, none: [] as never[] };

async function roundTrips(store: SubmissionStore) {
	const made = await store.create({ form: 'booking', receivedAt: '2026-11-11T10:00:00.000Z', fields });
	for (const read of [made, (await store.get(made.id))!, (await store.list()).items[0]!]) {
		assert.deepEqual(read.fields.bookings, lines, 'the list, in posted order');
		assert.deepEqual(read.fields.none, [], 'an empty list stays a list');
		for (const row of read.fields.bookings as Record<string, unknown>[]) for (const cell of Object.values(row)) assert.equal(typeof cell, 'string', 'every cell is text');
	}
}

describe('a rows value is stored as a real list (Acceptance 15)', () => {
	test('the folder store', async () => {
		const store = submissionStore({ kind: 'folder', dir: join(dir, 'folder') }) as SubmissionStore;
		await roundTrips(store);
		const [file] = readdirSync(join(dir, 'folder')).filter((n) => n.endsWith('.json'));
		assert.deepEqual(JSON.parse(readFileSync(join(dir, 'folder', file!), 'utf8')).fields.bookings, lines, 'on disk it is a list, not a string');
	});

	test('the bucket store (over its in-memory backend)', async () => {
		const backend = new MemoryBackend();
		await roundTrips(storeOver(backend));
		const [key] = [...backend.objects.keys()].filter((k) => k.endsWith('.json'));
		assert.ok(key, 'one object written');
		assert.deepEqual(JSON.parse(new TextDecoder().decode(backend.objects.get(key!)!)).fields.bookings, lines);
	});

	test('the memory store', async () => {
		resetSubmissions();
		await roundTrips(submissionStore({ kind: 'memory' }) as SubmissionStore);
	});
});
