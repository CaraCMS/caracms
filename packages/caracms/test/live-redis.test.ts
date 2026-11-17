// The Redis client and its stand-in (M4 Decision 17; Phase 1 → Verify 5).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connectRedis, memoryRedis, RedisUnavailableError } from '../src/live/redis.ts';
import { freePort, respServer } from './helpers/resp-server.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('connectRedis', () => {
	test('refused for 1.5 s, then up: the command succeeds about 1.5 s late', async () => {
		const port = await freePort();
		const server = respServer(port);
		const up = wait(1_500).then(() => server.listen());
		const redis = connectRedis(`redis://127.0.0.1:${port}`, { idleCloseMs: 60_000 });
		try {
			const started = Date.now();
			assert.equal(await redis.set('k', 'v', { px: 60_000 }), true);
			const late = Date.now() - started;
			assert.ok(late >= 1_450 && late < 3_500, `took ${late} ms`);
			assert.equal(await redis.get('k'), 'v');
			assert.equal(await redis.set('k', 'w', { nx: true }), false);
		} finally {
			await up;
			await redis.close();
			await server.close();
		}
	});

	test('down for longer than the 30 s budget: an error with the real code, at about 30 s', { timeout: 40_000 }, async () => {
		const port = await freePort(); // nothing ever listens
		const redis = connectRedis(`redis://127.0.0.1:${port}`);
		const started = Date.now();
		await assert.rejects(redis.get('k'), (error: unknown) => {
			assert.ok(error instanceof RedisUnavailableError);
			assert.equal(error.code, 'ECONNREFUSED', 'the code from the error event, not "Connection is closed."');
			return true;
		});
		const took = Date.now() - started;
		assert.ok(took >= 27_000 && took <= 31_000, `gave up after ${took} ms`);
	});

	test('a shorter budget for tests, and a Redis error is not retried', async () => {
		const port = await freePort();
		const server = respServer(port);
		await server.listen();
		const redis = connectRedis(`redis://127.0.0.1:${port}`, { budgetMs: 1_000 });
		try {
			await assert.rejects(redis.getdel('n'), /unknown command/);
			assert.equal(server.commands.filter((c) => c[0] === 'GETDEL').length, 1);
		} finally {
			await redis.close();
			await server.close();
		}
	});

	test('the connection closes after the idle time, and the next command reconnects', async () => {
		const port = await freePort();
		const server = respServer(port);
		await server.listen();
		const redis = connectRedis(`redis://127.0.0.1:${port}`, { idleCloseMs: 200 });
		try {
			await redis.set('a', '1');
			assert.equal(server.open(), 1);
			await wait(500);
			assert.equal(server.open(), 0, 'closed so Redis can sleep');
			assert.equal(await redis.get('a'), '1');
		} finally {
			await redis.close();
			await server.close();
		}
	});

	// ── Decision 17, the parts nothing measured: the backoff's shape, what is retried, nothing behind our back ──

	/** How many connect attempts it took, read from the client's own log line. */
	async function attemptsUntilUp(backoffMs: number, maxBackoffMs: number, upAfterMs: number): Promise<number> {
		const port = await freePort();
		const server = respServer(port);
		const logs: string[] = [];
		const up = wait(upAfterMs).then(() => server.listen());
		const redis = connectRedis(`redis://127.0.0.1:${port}`, { backoffMs, maxBackoffMs, budgetMs: 10_000, idleCloseMs: 60_000, log: (l) => logs.push(l) });
		try {
			assert.equal(await redis.set('k', 'v'), true);
			const line = logs.find((l) => /connected after \d+ attempts/.test(l));
			assert.ok(line, `the client says how many attempts it took: ${logs.join(' | ')}`);
			return Number(/after (\d+) attempts/.exec(line!)![1]);
		} finally {
			await up;
			await redis.close();
			await server.close();
		}
	}

	test('the backoff doubles from its start: refused attempts come at 0, 40, 120, 280, 600, 1240 ms', async () => {
		// Doubling and uncapped: Redis is up from 700 ms, so the sixth attempt (1240 ms) is the first to connect.
		// A constant 40 ms delay would have connected on about the 19th.
		const attempts = await attemptsUntilUp(40, 10_000, 700);
		assert.ok(attempts >= 5 && attempts <= 7, `${attempts} attempts`);
	});

	test('the backoff is capped: with a cap of 100 ms, 50 ms doubling stops at 100 ms', async () => {
		// Capped: attempts at 0, 50, 150, 250, 350 … so Redis coming up at 700 ms is met on the 8th or 9th.
		// Uncapped doubling (0, 50, 150, 350, 750) would have met it on the 5th.
		const attempts = await attemptsUntilUp(50, 100, 700);
		assert.ok(attempts >= 7 && attempts <= 11, `${attempts} attempts`);
	});

	test('a handshake that never answers is a timeout, which is retried, until the budget runs out', async () => {
		const port = await freePort();
		const server = respServer(port, (args) => (args[0]!.toUpperCase() === 'INFO' ? 'silent' : undefined)); // the ready check gets no answer
		await server.listen();
		const redis = connectRedis(`redis://127.0.0.1:${port}`, { budgetMs: 1_500, handshakeTimeoutMs: 250, backoffMs: 50, maxBackoffMs: 100, idleCloseMs: 60_000 });
		const started = Date.now();
		try {
			await assert.rejects(redis.get('k'), (error: unknown) => {
				assert.ok(error instanceof RedisUnavailableError);
				assert.equal(error.code, 'CARACMS_TIMEOUT');
				return true;
			});
			const took = Date.now() - started;
			assert.ok(took >= 1_100 && took <= 3_000, `gave up after ${took} ms`);
			assert.ok(server.accepted.length >= 3, `tried again: ${server.accepted.length} connections`);
		} finally {
			await redis.close();
			await server.close();
		}
	});

	test('a command that was sent and lost is retried only when sending it twice is harmless', async () => {
		const port = await freePort();
		const drops = { GET: 1, INCR: 1, SET: 1 };
		const server = respServer(port, (args) => {
			const name = args[0]!.toUpperCase() as keyof typeof drops;
			const nx = name === 'SET' && args.some((a) => a.toUpperCase() === 'NX');
			if ((name === 'GET' || name === 'INCR' || nx) && drops[name]-- > 0) return 'drop';
			return undefined;
		});
		await server.listen();
		const redis = connectRedis(`redis://127.0.0.1:${port}`, { backoffMs: 20, idleCloseMs: 60_000 });
		try {
			assert.equal(await redis.set('a', '1'), true);
			assert.equal(await redis.get('a'), '1', 'a plain read is sent again on a new connection');
			assert.equal(server.commands.filter((c) => c[0] === 'GET').length, 2);
			await assert.rejects(redis.incr('n'), RedisUnavailableError);
			assert.equal(server.commands.filter((c) => c[0] === 'INCR').length, 1, 'a counter is never sent twice');
			await assert.rejects(redis.set('lock', 'x', { nx: true }), RedisUnavailableError);
			assert.equal(server.commands.filter((c) => c[0] === 'SET' && c.includes('NX')).length, 1, 'SET NX is never sent twice');
		} finally {
			await redis.close();
			await server.close();
		}
	});

	// Redis diet Decision 7 and acceptance check 18: a pipeline cut off part way.
	test('a batch: one round trip, replies in order, and a SCAN\'s further pages read on the same connection', async () => {
		const port = await freePort();
		const server = respServer(port);
		await server.listen();
		const redis = connectRedis(`redis://127.0.0.1:${port}`, { idleCloseMs: 60_000 });
		try {
			await redis.set('k:1', 'one');
			await redis.set('k:2', 'two');
			const [a, none, found, empty, n] = await redis.batch([['get', 'k:1'], ['get', 'missing'], ['scan', 'k:*'], ['mget', []], ['incr', 'n']] as const);
			assert.deepEqual([a, none, found.sort(), empty, n], ['one', null, ['k:1', 'k:2'], [], 1]);
			assert.deepEqual(await redis.batch([['mget', found.sort()]] as const), [['one', 'two']]);
			assert.equal(server.commands.filter((c) => c[0] === 'MGET').length, 1, 'an MGET of no keys isn\'t sent');
		} finally {
			await redis.close();
			await server.close();
		}
	});

	test('a batch cut off part way is sent again only when every command in it is safe to send twice', async () => {
		const port = await freePort();
		let drops = 0;
		const server = respServer(port, (args) => (args[0]!.toUpperCase() === 'GET' && args[1] === 'second' && drops-- > 0 ? 'drop' : undefined));
		await server.listen();
		const redis = connectRedis(`redis://127.0.0.1:${port}`, { backoffMs: 20, idleCloseMs: 60_000 });
		const sent = (name: string, key: string) => server.commands.filter((c) => c[0] === name && c[1] === key).length;
		try {
			await redis.set('first', '1');
			await redis.set('second', '2');
			// The first GET is answered, the connection drops on the second: the whole batch again.
			drops = 1;
			assert.deepEqual(await redis.batch([['get', 'first'], ['get', 'second']] as const), ['1', '2']);
			assert.deepEqual([sent('GET', 'first'), sent('GET', 'second')], [2, 2]);
			// INCR answered, then the drop: it may not run twice, so the batch fails as a single INCR would.
			drops = 1;
			await assert.rejects(redis.batch([['incr', 'n'], ['get', 'second']] as const), RedisUnavailableError);
			assert.equal(sent('INCR', 'n'), 1, 'the counter went once');
			// A lock's SET NX: the same.
			drops = 1;
			await assert.rejects(redis.batch([['set', 'lock', 'x', { nx: true }], ['get', 'second']] as const), RedisUnavailableError);
			assert.equal(sent('SET', 'lock'), 1, 'SET NX went once');
		} finally {
			await redis.close();
			await server.close();
		}
	});

	test('ioredis does not reconnect behind our back: after a dropped connection nothing connects until the next command', async () => {
		const port = await freePort();
		const server = respServer(port);
		await server.listen();
		const redis = connectRedis(`redis://127.0.0.1:${port}`, { idleCloseMs: 60_000 });
		try {
			await redis.set('a', '1');
			assert.equal(server.accepted.length, 1);
			server.dropAll();
			await wait(1_200); // ioredis's own retryStrategy would have reconnected within 50 ms to 2 s
			assert.equal(server.accepted.length, 1, 'no connection of its own');
			assert.equal(server.open(), 0);
			assert.equal(await redis.get('a'), '1', 'the next command connects again');
			assert.equal(server.accepted.length, 2);
		} finally {
			await redis.close();
			await server.close();
		}
	});
});

describe('memoryRedis: the stand-in', () => {
	test('strings with expiry, SET NX PX, GETDEL, INCR keeping its expiry', async () => {
		let t = 0;
		const r = memoryRedis({ now: () => t });
		assert.equal(await r.set('lock', 'a', { nx: true, px: 1_000 }), true);
		assert.equal(await r.set('lock', 'b', { nx: true, px: 1_000 }), false);
		assert.equal(await r.pttl('lock'), 1_000);
		t = 1_000;
		assert.equal(await r.get('lock'), null);
		assert.equal(await r.set('lock', 'b', { nx: true }), true);
		assert.equal(await r.pttl('lock'), -1);
		assert.equal(await r.getdel('lock'), 'b');
		assert.equal(await r.getdel('lock'), null);
		assert.equal(await r.incr('n'), 1);
		await r.pexpire('n', 500);
		assert.equal(await r.incr('n'), 2);
		assert.equal(await r.pttl('n'), 500);
		t = 1_500;
		assert.equal(await r.get('n'), null);
		assert.deepEqual(await r.mget(['x', 'n']), [null, null]);
	});

	test('hashes, sets, scan and the compare-and-swaps', async () => {
		const r = memoryRedis();
		assert.equal(await r.hset('h', { a: '1', b: '2' }), 2);
		assert.equal(await r.hset('h', { a: '3' }), 0);
		assert.deepEqual(await r.hgetall('h'), { a: '3', b: '2' });
		assert.equal(await r.hdel('h', 'a', 'b'), 2);
		assert.deepEqual(await r.hgetall('h'), {});
		assert.equal(await r.sadd('s', 'x', 'y', 'x'), 2);
		assert.deepEqual((await r.smembers('s')).sort(), ['x', 'y']);
		await r.set('caracms:autosave:pages/index', '{}');
		await r.set('caracms:autosave:pages/about', '{}');
		await r.set('caracms:lock:pages/index', 't');
		assert.deepEqual((await r.scan('caracms:autosave:*')).sort(), ['caracms:autosave:pages/about', 'caracms:autosave:pages/index']);
		assert.equal(await r.compareAndSet('caracms:lock:pages/index', 'wrong', 'u'), false);
		assert.equal(await r.compareAndSet('caracms:lock:pages/index', 't', 'u', { px: 100 }), true);
		assert.equal(await r.compareAndSet('fresh', null, 'v'), true);
		assert.equal(await r.compareAndSet('fresh', null, 'w'), false);
		assert.equal(await r.compareAndDelete('fresh', 'w'), false);
		assert.equal(await r.compareAndDelete('fresh', 'v'), true);
		await assert.rejects(r.hget('caracms:lock:pages/index', 'x'), /WRONGTYPE/);
	});

	test('a batch runs in order and counts each command; an error is thrown once every command has run', async () => {
		const r = memoryRedis();
		await r.set('a', '1');
		await r.hset('h', { f: 'v' });
		r.calls = 0;
		const [keys, h, n] = await r.batch([['scan', 'a*'], ['hgetall', 'h'], ['incr', 'n']] as const);
		assert.deepEqual([keys, h, n, r.calls], [['a'], { f: 'v' }, 1, 3]);
		await assert.rejects(r.batch([['hgetall', 'a'], ['incr', 'n']] as const), /WRONGTYPE/);
		assert.equal(await r.get('n'), '2', 'the command after the failing one still ran, as in a pipeline');
	});

	test('counts calls, so a test can see that nothing touched Redis', async () => {
		const r = memoryRedis();
		await r.get('a');
		await r.set('a', 'b');
		assert.equal(r.calls, 2);
		r.calls = 0;
		r.flush();
		assert.equal(r.calls, 0);
	});
});
