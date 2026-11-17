// Change address… must never discard unsent edits (pre-M7 item 8 review): moveDocument
// refuses, moves nothing and discards nothing while the keeper still holds edits for the
// document after the flush (a held conflict, a signed-out session) or the flush failed.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { moveDocument } from '../src/editor/client/documents/actions.ts';
import type { Editor } from '../src/editor/client/editor.ts';

const ref = { collection: 'pages', path: 'studio/visit' };
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function fakeEditor(keeper: { flush: () => Promise<void>; dirty: () => boolean }) {
	const calls = { discard: 0, fetch: 0 };
	globalThis.fetch = (async () => {
		calls.fetch += 1;
		return new Response(JSON.stringify({ collection: 'pages', path: 'studio/new', url: '/studio/new', from: { url: '/studio/visit' }, relinked: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	const editor = {
		liveSession: null,
		doc: { get: () => ({ ref: { collection: 'pages', path: 'other' } }) },
		keeper: { ...keeper, discard: () => void (calls.discard += 1) },
		refreshDocuments: async () => undefined,
		openDocument: async () => undefined,
		toast: () => undefined,
		announce: () => undefined,
	} as unknown as Editor;
	return { editor, calls };
}

describe('moveDocument and unsent edits', () => {
	test('refuses, moves nothing and discards nothing while edits are still held after the flush', async () => {
		const { editor, calls } = fakeEditor({ flush: async () => undefined, dirty: () => true });
		const answer = await moveDocument(editor, ref, 'studio/new', 'Visit');
		assert.equal(answer.ok, false);
		if (!answer.ok) assert.match(answer.error, /changes that haven't been saved/);
		assert.equal(calls.fetch, 0, 'no request is sent');
		assert.equal(calls.discard, 0, 'the held edits stay');
	});

	test('refuses when the flush itself fails', async () => {
		const { editor, calls } = fakeEditor({ flush: async () => Promise.reject(new Error('refused')), dirty: () => false });
		const answer = await moveDocument(editor, ref, 'studio/new', 'Visit');
		assert.equal(answer.ok, false);
		assert.equal(calls.fetch, 0);
		assert.equal(calls.discard, 0);
	});

	test('moves, and clears the keeper, when everything was sent', async () => {
		const { editor, calls } = fakeEditor({ flush: async () => undefined, dirty: () => false });
		const answer = await moveDocument(editor, ref, 'studio/new', 'Visit');
		assert.equal(answer.ok, true);
		assert.equal(calls.fetch, 1);
		assert.equal(calls.discard, 1);
	});
});
