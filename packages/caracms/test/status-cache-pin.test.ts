/**
 * Redis diet review (2026-10-24): a poll's snapshot is pinned when its read answers, so a
 * drop landing while the poll is still in its writes (its own beat losing a swap, another
 * lock's swap lost) leaves it the records it read, never an empty answer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRedis } from '../src/live/redis.ts';
import { StatusCache } from '../src/live/status-cache.ts';

test('a drop after a poll has read leaves that poll the records it read', async () => {
	const clock = { t: 0 };
	const redis = memoryRedis({ now: () => clock.t });
	await redis.set('caracms:lock:a', '{"tab":"a"}');
	await redis.set('caracms:lock:b', '{"tab":"b"}');
	const cache = new StatusCache({ redis, maxAgeMs: 30_000, now: () => clock.t });
	await cache.read({ scans: ['caracms:lock:'], strings: ['caracms:changed:home'] });
	const snap = await cache.read({ scans: ['caracms:lock:'], strings: ['caracms:changed:home'] });
	cache.drop('caracms:lock:b');
	assert.equal(snap.scan('caracms:lock:').size, 2);
	// …and the next poll reads Redis again.
	const calls = redis.calls;
	const next = await cache.read({ scans: ['caracms:lock:'] });
	assert.equal(next.scan('caracms:lock:').size, 2);
	assert.ok(redis.calls > calls);
});
