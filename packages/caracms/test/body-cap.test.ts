// Every route that takes a body reads it under its cap (caracms-cloud adversarial review,
// finding 10; the review's proof, turned round into regression tests): the bytes are counted as
// they're read, and the read stops at the cap whether or not a Content-Length came, or told the
// truth. The webhook (no sign-in in front of it) and the editor's write routes.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { readCappedText } from '../src/body.ts';
import { handleCreate, MAX_CREATE_BODY_BYTES } from '../src/editor/server/create.ts';
import { handleWrite, MAX_BODY_BYTES } from '../src/editor/server/write.ts';
import { handleGithubWebhook } from '../src/live/webhook.ts';

const MB = 1024 * 1024;
const CHUNK = 64 * 1024;
const SECRET = 'webhook-secret-under-test';
const WEBHOOK_CAP = 25 * MB;

/**
 * A POST whose body streams `bytes` (zeroes, or `text` as it is) in 64 KB chunks, counting how
 * many are pulled. No Content-Length unless `headers` gives one (a stream body is chunked).
 */
function streaming(url: string, bytes: number | string, headers: Record<string, string> = {}): { request: Request; pulled: () => number } {
	const source = typeof bytes === 'string' ? Buffer.from(bytes) : null;
	const total = source ? source.length : (bytes as number);
	const zeroes = new Uint8Array(CHUNK);
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= total) return controller.close();
			const n = Math.min(CHUNK, total - sent);
			controller.enqueue(source ? new Uint8Array(source.subarray(sent, sent + n)) : zeroes.subarray(0, n));
			sent += n;
		},
	});
	// @ts-expect-error duplex isn't in the lib DOM types yet (undici needs it for a stream body)
	const request = new Request(url, { method: 'POST', headers, body, duplex: 'half' });
	return { request, pulled: () => sent };
}

/** Read no further than the cap and a few chunks past it (the stream's own read-ahead). */
const nearCap = (pulled: number, cap: number) => assert.ok(pulled <= cap + 4 * CHUNK, `read ${(pulled / MB).toFixed(2)} MB against a ${(cap / MB).toFixed(2)} MB cap`);

describe('finding 10: the webhook reads at most 25 MB', () => {
	const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
	const webhook = (request: Request) => handleGithubWebhook(request, { secret: SECRET, trigger: async () => {} });

	test('a chunked body with no Content-Length over the cap is refused at the cap, not read in full', async () => {
		const { request, pulled } = streaming('http://site.test/_caracms/github', 40 * MB, { 'x-hub-signature-256': 'sha256=deadbeef' });
		const res = await webhook(request);
		assert.equal(res.status, 413);
		assert.equal(await res.text(), 'Too large.');
		nearCap(pulled(), WEBHOOK_CAP);
	});

	test('a Content-Length that lies (small, with 40 MB behind it) is refused at the cap too', async () => {
		const { request, pulled } = streaming('http://site.test/_caracms/github', 40 * MB, { 'x-hub-signature-256': 'sha256=deadbeef', 'content-length': '100' });
		assert.equal((await webhook(request)).status, 413);
		nearCap(pulled(), WEBHOOK_CAP);
	});

	test('a Content-Length over the cap is refused before the body is read', async () => {
		const { request, pulled } = streaming('http://site.test/_caracms/github', 40 * MB, { 'x-hub-signature-256': 'sha256=deadbeef', 'content-length': String(40 * MB) });
		assert.equal((await webhook(request)).status, 413);
		assert.ok(pulled() <= 2 * CHUNK, `read ${pulled()} bytes`);
	});

	test('a signed push, chunked or with its length, is checked as before; a bad signature is still 401', async () => {
		const payload = JSON.stringify({ ref: 'refs/heads/main', padding: 'x'.repeat(200_000) });
		let triggered = 0;
		const run = (request: Request) => handleGithubWebhook(request, { secret: SECRET, trigger: async () => void triggered++ });
		assert.equal((await run(streaming('http://site.test/_caracms/github', payload, { 'x-hub-signature-256': sign(payload) }).request)).status, 202);
		const withLength = new Request('http://site.test/_caracms/github', { method: 'POST', headers: { 'x-hub-signature-256': sign(payload), 'content-length': String(Buffer.byteLength(payload)) }, body: payload });
		assert.equal((await run(withLength)).status, 202);
		assert.equal((await run(streaming('http://site.test/_caracms/github', payload, { 'x-hub-signature-256': sign('other') }).request)).status, 401);
		assert.equal(triggered, 2);
	});
});

describe('finding 10: the editor write routes read at most their cap', () => {
	const json = { origin: 'http://site.test', 'content-type': 'application/json' };
	let writes = 0;
	const store = { write: async () => (writes++, { ok: true }) as never };

	test(`write: a chunked body over ${MAX_BODY_BYTES / MB} MB with no Content-Length is the route's 413, read no further than the cap`, async () => {
		const { request, pulled } = streaming('http://site.test/_caracms/write', 40 * MB, json);
		const res = await handleWrite(request, store);
		assert.equal(res.status, 413);
		assert.deepEqual(await res.json(), { error: 'That body is too large for a document.' });
		nearCap(pulled(), MAX_BODY_BYTES);
	});

	test('write: a Content-Length that lies is no way past the cap', async () => {
		const { request, pulled } = streaming('http://site.test/_caracms/write', 40 * MB, { ...json, 'content-length': '10' });
		assert.equal((await handleWrite(request, store)).status, 413);
		nearCap(pulled(), MAX_BODY_BYTES);
	});

	test('write: a document under the cap, chunked, is written as before', async () => {
		const body = JSON.stringify({ file: 'content/pages/index.json', base: '{}', document: { title: 'Home', blocks: [] } });
		const before = writes;
		const res = await handleWrite(streaming('http://site.test/_caracms/write', body, json).request, store);
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal(writes, before + 1);
	});

	test('create: a chunked body over its 16 KB cap is its 413, read no further than the cap', async () => {
		const { request, pulled } = streaming('http://site.test/_caracms/create', 4 * MB, json);
		const res = await handleCreate(request, { create: async () => ({}) } as never);
		assert.equal(res.status, 413);
		nearCap(pulled(), MAX_CREATE_BODY_BYTES);
	});

	test('the shared read: exactly the cap is kept, one byte over is null, UTF-8 comes back as text', async () => {
		assert.equal(await readCappedText(new Request('http://site.test', { method: 'POST', body: 'é'.repeat(5) }), 10), 'é'.repeat(5));
		assert.equal(await readCappedText(new Request('http://site.test', { method: 'POST', body: `${'é'.repeat(5)}x` }), 10), null);
		assert.equal(await readCappedText(new Request('http://site.test', { method: 'POST' }), 10), '');
	});
});
