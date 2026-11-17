/**
 * Redis for live mode (M4 Decision 17, M1 → R1/R2): one small interface, two
 * implementations.
 *
 * - `connectRedis(url)`: the real client, over ioredis. Railway's Redis sleeps after
 *   a few minutes with no traffic and wakes on the first connection, which is
 *   refused for about a second meanwhile. So:
 *   - **Connect-phase errors and timeouts are retried**, backing off from 250 ms,
 *     doubling, capped at 2 s, **within a 30-second budget** per command. A command
 *     that waits for Redis to wake just takes about a second longer.
 *   - ioredis's own reconnects, retries and offline queue are off, so nothing
 *     reconnects behind our back and keeps Redis awake. `family: 0`, since Railway's
 *     private network is dual-stack.
 *   - **ioredis hides the real connect error** behind "Connection is closed."; the
 *     code (`ECONNREFUSED`…) arrives on the `error` event, so it's kept from there.
 *   - The handshake (ready check) has its own timeout: ioredis's `connectTimeout`
 *     only covers the TCP connect.
 *   - **The connection closes after 30 s idle**, so Redis can sleep.
 *   - A command that fails after it was sent (a timeout, or the connection dropping)
 *     is retried only when sending it twice is harmless (`get`, plain `set`…), never
 *     for `incr`, `getdel`, `set NX` or the compare-and-swap calls.
 * - `memoryRedis()`: the in-memory stand-in for tests and dev without `REDIS_URL`
 *   (Core framing). Same interface and semantics, an injectable clock, and a call
 *   count, so a test can check that something made no Redis call at all.
 *
 * The interface is what M4 needs and no more: strings with expiry, SET NX PX,
 * GETDEL, INCR and expiry for rate limits, hashes, sets, a key scan, and two
 * compare-and-swap calls for locks. Values are strings; store JSON as text.
 */
import IORedis from 'ioredis';

export interface SetOptions {
	/** Expire after this many milliseconds. */
	px?: number;
	/** Only set when the key doesn't exist (SET NX). */
	nx?: boolean;
}

export interface RedisClient {
	get(key: string): Promise<string | null>;
	mget(keys: string[]): Promise<(string | null)[]>;
	/** SET. Returns false only when `nx` was asked for and the key already existed. */
	set(key: string, value: string, options?: SetOptions): Promise<boolean>;
	/** GETDEL: read and delete in one step (spending a sign-in link). */
	getdel(key: string): Promise<string | null>;
	/** How many of the keys existed. */
	del(...keys: string[]): Promise<number>;
	incr(key: string): Promise<number>;
	/** False when the key doesn't exist. */
	pexpire(key: string, ms: number): Promise<boolean>;
	/** Milliseconds left; -1 with no expiry, -2 when missing (Redis's PTTL). */
	pttl(key: string): Promise<number>;
	hget(key: string, field: string): Promise<string | null>;
	/** HSET: how many fields were new. */
	hset(key: string, fields: Record<string, string>): Promise<number>;
	hdel(key: string, ...fields: string[]): Promise<number>;
	/** Every field; `{}` when the key is missing. */
	hgetall(key: string): Promise<Record<string, string>>;
	sadd(key: string, ...members: string[]): Promise<number>;
	srem(key: string, ...members: string[]): Promise<number>;
	smembers(key: string): Promise<string[]>;
	/** Every key matching a glob pattern (`caracms:autosave:*`), via SCAN. Order unspecified. */
	scan(pattern: string): Promise<string[]>;
	/**
	 * Set `key` to `value` only if it currently holds `expected` (`null`: only if it's
	 * missing). Atomic. For moving a lock (Edit here) and renewing one.
	 */
	compareAndSet(key: string, expected: string | null, value: string, options?: { px?: number }): Promise<boolean>;
	/** Delete `key` only if it holds `expected`. Atomic. For releasing a lock you hold. */
	compareAndDelete(key: string, expected: string): Promise<boolean>;
	/**
	 * Several commands sent together (Redis diet Decision 7): ioredis's pipeline, one
	 * round trip; the stand-in runs them in order. Replies come back in the commands'
	 * order. Each command is billed and counted as one. A batch that failed in flight is
	 * sent again only when every command in it is safe to send twice (see `connectRedis`).
	 * A command that needs another's answer (an MGET of what a SCAN found) goes in the next batch.
	 */
	batch<const C extends readonly BatchCommand[]>(commands: C): Promise<BatchReplies<C>>;
	/** Close the connection, if any. The client stays usable: the next command reconnects. */
	close(): Promise<void>;
}

type BatchName = Exclude<keyof RedisClient, 'batch' | 'close'>;
/** One command of a batch: its method's name and arguments, `['mget', keys]`, `['hgetall', key]`. */
export type BatchCommand = { [K in BatchName]: readonly [K, ...Parameters<RedisClient[K]>] }[BatchName];
/** The replies to a batch, as the methods of the same names give them. */
export type BatchReplies<C extends readonly BatchCommand[]> = { -readonly [I in keyof C]: C[I] extends readonly [infer K extends BatchName, ...unknown[]] ? Awaited<ReturnType<RedisClient[K]>> : never };

/** Redis couldn't be reached within the budget, or refused a command. `code` is the real socket error's. */
export class RedisUnavailableError extends Error {
	readonly code: string | null;
	constructor(message: string, code: string | null) {
		super(message);
		this.name = 'RedisUnavailableError';
		this.code = code;
	}
}

export interface RedisOptions {
	/** The whole wait for one command, retries included. Default 30 s (Decision 17). */
	budgetMs?: number;
	/** First backoff; it doubles up to `maxBackoffMs`. Defaults 250 ms and 2 s. */
	backoffMs?: number;
	maxBackoffMs?: number;
	/** One attempt's TCP connect plus handshake. Default 5 s (never more than the budget left). */
	handshakeTimeoutMs?: number;
	/** One command's reply. Default 5 s. */
	commandTimeoutMs?: number;
	/** Close the connection after this long with nothing sent. Default 30 s. */
	idleCloseMs?: number;
	/** Where retries and closes are reported. Default: nothing. */
	log?: (line: string) => void;
}

const CAS_SET = `local cur = redis.call('GET', KEYS[1])
local ok
if ARGV[1] == '1' then ok = (cur == false) else ok = (cur == ARGV[2]) end
if not ok then return 0 end
if ARGV[4] ~= '' then redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4]) else redis.call('SET', KEYS[1], ARGV[3]) end
return 1`;

const CAS_DEL = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/** Socket errors that mean "not reachable yet": what a sleeping Railway Redis gives (M1 → R2). */
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'CARACMS_TIMEOUT']);

const errorCode = (error: unknown): string | null => {
	const e = error as { code?: unknown; errors?: unknown[] } | null;
	if (typeof e?.code === 'string') return e.code;
	// Node's dual-stack connect fails with an AggregateError of one error per address.
	if (Array.isArray(e?.errors)) for (const inner of e.errors) {
		const code = errorCode(inner);
		if (code) return code;
	}
	return null;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error(`${what} gave no answer in ${ms} ms`), { code: 'CARACMS_TIMEOUT' })), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type Ioredis = InstanceType<typeof IORedis>;
/** The client or a pipeline: the same calls, which a pipeline queues. */
type Target = Record<string, (...args: unknown[]) => unknown>;

/**
 * How one command goes to ioredis: whether sending it twice is harmless, the call (to the
 * client, or queued on a pipeline), and how its reply reads. `send: null`: the answer is
 * known without asking (`answer`), so nothing is sent.
 */
interface Spec {
	safe: boolean;
	send: ((t: Target) => unknown) | null;
	read: (c: Ioredis, reply: unknown) => unknown;
	answer?: unknown;
}

const px = (ms: number) => Math.max(1, Math.round(ms));
const asIs = (_c: Ioredis, reply: unknown) => reply;
const isOne = (_c: Ioredis, reply: unknown) => reply === 1;
const known = (answer: unknown): Spec => ({ safe: true, send: null, read: asIs, answer });
const spec = (safe: boolean, name: string, args: unknown[], read: Spec['read'] = asIs): Spec => ({ safe, send: (t) => t[name]!(...args), read });

function specOf(command: BatchCommand): Spec {
	switch (command[0]) {
		case 'get':
		case 'pttl':
		case 'hgetall':
		case 'smembers':
			return spec(true, command[0], [command[1]]);
		case 'getdel':
			return spec(false, 'getdel', [command[1]]);
		case 'incr':
			return spec(false, 'incr', [command[1]]);
		case 'mget':
			return command[1].length ? spec(true, 'mget', [...command[1]]) : known([]);
		case 'set': {
			const [, key, value, o = {}] = command;
			const args: unknown[] = [key, value];
			if (o.px !== undefined) args.push('PX', px(o.px));
			if (o.nx) args.push('NX');
			return spec(!o.nx, 'set', args, (_c, reply) => reply === 'OK');
		}
		case 'del': {
			const [, ...keys] = command;
			return keys.length ? spec(true, 'del', keys) : known(0);
		}
		case 'pexpire':
			return spec(true, 'pexpire', [command[1], px(command[2])], isOne);
		case 'hget':
			return spec(true, 'hget', [command[1], command[2]]);
		case 'hset':
			return spec(true, 'hset', [command[1], command[2]]);
		case 'hdel':
		case 'sadd':
		case 'srem': {
			const [name, key, ...rest] = command;
			return rest.length ? spec(true, name, [key, ...rest]) : known(0);
		}
		case 'scan': {
			const pattern = command[1];
			// The first page goes with the rest of a batch; any further pages follow on the same connection.
			return spec(true, 'scan', ['0', 'MATCH', pattern, 'COUNT', SCAN_COUNT], async (c, reply) => {
				let [cursor, page] = reply as [string, string[]];
				const keys = new Set(page);
				while (cursor !== '0') {
					[cursor, page] = await c.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
					for (const k of page) keys.add(k);
				}
				return [...keys];
			});
		}
		case 'compareAndSet': {
			const [, key, expected, value, o = {}] = command;
			return spec(false, 'eval', [CAS_SET, 1, key, expected === null ? '1' : '0', expected ?? '', value, o.px === undefined ? '' : String(px(o.px))], isOne);
		}
		case 'compareAndDelete':
			return spec(false, 'eval', [CAS_DEL, 1, command[1], command[2]], isOne);
	}
}

const SCAN_COUNT = 200;

/**
 * The real client. Nothing connects until the first command, and the connection
 * closes again after `idleCloseMs` with nothing sent.
 */
export function connectRedis(url: string, options: RedisOptions = {}): RedisClient {
	const budgetMs = options.budgetMs ?? 30_000;
	const backoffMs = options.backoffMs ?? 250;
	const maxBackoffMs = options.maxBackoffMs ?? 2_000;
	const handshakeMs = options.handshakeTimeoutMs ?? 5_000;
	const commandMs = options.commandTimeoutMs ?? 5_000;
	const idleMs = options.idleCloseMs ?? 30_000;
	const log = options.log ?? (() => {});

	let client: Ioredis | null = null;
	let connecting: Promise<Ioredis> | null = null;
	let inFlight = 0;
	let idleTimer: NodeJS.Timeout | null = null;

	const drop = (c: Ioredis) => {
		if (client === c) client = null;
		try {
			c.disconnect(false);
		} catch {
			/* already gone */
		}
	};

	/** One connect attempt. Rejects with the real socket error when there is one. */
	const attemptConnect = async (timeoutMs: number): Promise<Ioredis> => {
		const c = new IORedis(url, {
			family: 0,
			lazyConnect: true,
			connectTimeout: timeoutMs,
			commandTimeout: commandMs,
			enableOfflineQueue: false,
			maxRetriesPerRequest: 0,
			retryStrategy: () => null,
			reconnectOnError: () => false,
			enableReadyCheck: true,
			autoResubscribe: false,
			autoResendUnfulfilledCommands: false,
		});
		const socketErrors: unknown[] = [];
		c.on('error', (error: unknown) => socketErrors.push(error));
		c.on('end', () => {
			if (client === c) client = null;
		});
		try {
			await withTimeout(c.connect(), timeoutMs, 'Redis connect and handshake');
			return c;
		} catch (error) {
			drop(c);
			// "Connection is closed." hides the cause; the socket error has the code.
			const real = socketErrors.find((e) => errorCode(e)) ?? error;
			throw real;
		}
	};

	const connect = (deadline: number): Promise<Ioredis> => {
		if (client && client.status === 'ready') return Promise.resolve(client);
		if (client) drop(client);
		connecting ??= (async () => {
			let delay = backoffMs;
			for (let attempt = 1; ; attempt++) {
				const left = deadline - Date.now();
				try {
					const c = await attemptConnect(Math.max(250, Math.min(handshakeMs, left)));
					if (attempt > 1) log(`[caracms] Redis connected after ${attempt} attempts`);
					client = c;
					return c;
				} catch (error) {
					const code = errorCode(error);
					const retryable = code ? CONNECT_CODES.has(code) : /connection is closed/i.test(String((error as Error)?.message));
					if (!retryable) throw new RedisUnavailableError(`Redis refused the connection: ${(error as Error)?.message ?? error}`, code);
					if (Date.now() + delay > deadline) {
						throw new RedisUnavailableError(`Redis wasn't reachable within ${Math.round(budgetMs / 1000)} s (${code ?? (error as Error)?.message}).`, code);
					}
					await sleep(delay);
					delay = Math.min(delay * 2, maxBackoffMs);
				}
			}
		})().finally(() => {
			connecting = null;
		});
		return connecting;
	};

	const armIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
		if (inFlight > 0 || !client) return;
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (inFlight === 0 && client) {
				const c = client;
				client = null;
				log('[caracms] Redis idle: closing the connection so it can sleep');
				void withTimeout(c.quit(), 2_000, 'QUIT').catch(() => {}).finally(() => drop(c));
			}
		}, idleMs);
		idleTimer.unref?.();
	};

	/** Run one command: connect (with retries), send, and retry a harmless command that failed in flight. */
	const run = async <T>(idempotent: boolean, send: (c: Ioredis) => Promise<T>): Promise<T> => {
		inFlight++;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
		const deadline = Date.now() + budgetMs;
		try {
			for (;;) {
				const c = await connect(deadline);
				try {
					return await withTimeout(send(c), commandMs, 'Redis command');
				} catch (error) {
					const code = errorCode(error);
					// A pipeline answered part way: ioredis aborts the rest ("Command aborted due to connection close").
					const lost = code === 'CARACMS_TIMEOUT' || /connection is closed|stream isn't writeable|command timed out|aborted due to connection close/i.test(String((error as Error)?.message));
					if (!lost) throw error; // Redis answered with an error: not ours to retry
					drop(c);
					if (!idempotent || Date.now() + backoffMs > deadline) {
						throw new RedisUnavailableError(`Redis didn't answer (${(error as Error)?.message}).`, code);
					}
					await sleep(backoffMs);
				}
			}
		} finally {
			inFlight--;
			armIdle();
		}
	};

	/** One command, through `run`; one whose answer is known without asking (an MGET of no keys) isn't sent. */
	const one = <T>(command: BatchCommand): Promise<T> => {
		const s = specOf(command);
		if (s.send === null) return Promise.resolve(s.answer as T);
		return run(s.safe, async (c) => (await s.read(c, await s.send!(c as unknown as Target))) as T);
	};

	return {
		get: (key) => one(['get', key]),
		mget: (keys) => one(['mget', keys]),
		set: (key, value, o) => one(['set', key, value, o]),
		getdel: (key) => one(['getdel', key]),
		del: (...keys) => one(['del', ...keys]),
		incr: (key) => one(['incr', key]),
		pexpire: (key, ms) => one(['pexpire', key, ms]),
		pttl: (key) => one(['pttl', key]),
		hget: (key, field) => one(['hget', key, field]),
		hset: (key, fields) => one(['hset', key, fields]),
		hdel: (key, ...fields) => one(['hdel', key, ...fields]),
		hgetall: (key) => one(['hgetall', key]),
		sadd: (key, ...members) => one(['sadd', key, ...members]),
		srem: (key, ...members) => one(['srem', key, ...members]),
		smembers: (key) => one(['smembers', key]),
		scan: (pattern) => one(['scan', pattern]),
		compareAndSet: (key, expected, value, o) => one(['compareAndSet', key, expected, value, o]),
		compareAndDelete: (key, expected) => one(['compareAndDelete', key, expected]),
		// Redis diet Decision 7. ioredis answers a pipeline per command, `[error, reply]`, and
		// a connection lost part way fills every unanswered one with "Connection is closed.":
		// it can't say whether those ran (the command may have arrived, its answer not). So
		// the batch is the unit: sent again whole when every command in it is safe to send
		// twice, never when any isn't, and then it fails as a single unsafe command does.
		batch: <const C extends readonly BatchCommand[]>(commands: C): Promise<BatchReplies<C>> => {
			const specs = commands.map(specOf);
			const sent = specs.filter((s) => s.send !== null);
			if (sent.length === 0) return Promise.resolve(specs.map((s) => s.answer) as BatchReplies<C>);
			return run(
				sent.every((s) => s.safe),
				async (c) => {
					const pipeline = c.pipeline();
					for (const s of sent) s.send!(pipeline as unknown as Target);
					const results = await pipeline.exec();
					if (!results) throw new Error('Redis gave no answer to the batch.');
					const failed = results.find(([error]) => error);
					if (failed) throw failed[0];
					const out: unknown[] = [];
					let i = 0;
					for (const s of specs) out.push(s.send === null ? s.answer : await s.read(c, results[i++]![1]));
					return out as BatchReplies<C>;
				},
			);
		},
		async close() {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = null;
			const c = client;
			client = null;
			if (c) await withTimeout(c.quit(), 2_000, 'QUIT').catch(() => {}).finally(() => drop(c));
		},
	};
}

// ── The in-memory stand-in ────────────────────────────────────────────────────

type Value = { kind: 'string'; value: string } | { kind: 'hash'; value: Map<string, string> } | { kind: 'set'; value: Set<string> };

export interface MemoryRedis extends RedisClient {
	/** Every command run so far (a test resets it to 0 and checks it stays there). */
	calls: number;
	/** Empty it, as a Redis flush would. */
	flush(): void;
}

class WrongType extends Error {
	constructor() {
		super('WRONGTYPE Operation against a key holding the wrong kind of value');
	}
}

/** Redis's glob, for SCAN MATCH: `*`, `?` and `[...]`; `\` escapes. */
function globToRegExp(pattern: string): RegExp {
	let out = '';
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		if (ch === '\\' && i + 1 < pattern.length) out += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		else if (ch === '*') out += '.*';
		else if (ch === '?') out += '.';
		else if (ch === '[') {
			const end = pattern.indexOf(']', i + 1);
			if (end === -1) out += '\\[';
			else {
				out += `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
				i = end;
			}
		} else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${out}$`, 's');
}

/** The in-memory stand-in. `now` is the clock expiry is measured against (default Date.now). */
export function memoryRedis(options: { now?: () => number } = {}): MemoryRedis {
	const now = options.now ?? Date.now;
	const data = new Map<string, Value>();
	const expires = new Map<string, number>();

	const alive = (key: string): Value | undefined => {
		const at = expires.get(key);
		if (at !== undefined && at <= now()) {
			data.delete(key);
			expires.delete(key);
		}
		return data.get(key);
	};
	const str = (key: string) => {
		const v = alive(key);
		if (v && v.kind !== 'string') throw new WrongType();
		return v?.value ?? null;
	};
	const hash = (key: string, create: boolean) => {
		const v = alive(key);
		if (v && v.kind !== 'hash') throw new WrongType();
		if (!v && create) {
			const h = { kind: 'hash' as const, value: new Map<string, string>() };
			data.set(key, h);
			return h.value;
		}
		return v?.value ?? null;
	};
	const set = (key: string, create: boolean) => {
		const v = alive(key);
		if (v && v.kind !== 'set') throw new WrongType();
		if (!v && create) {
			const s = { kind: 'set' as const, value: new Set<string>() };
			data.set(key, s);
			return s.value;
		}
		return v?.value ?? null;
	};
	const putString = (key: string, value: string, px?: number) => {
		data.set(key, { kind: 'string', value });
		if (px === undefined) expires.delete(key);
		else expires.set(key, now() + Math.max(1, Math.round(px)));
	};
	const remove = (key: string) => {
		const had = alive(key) !== undefined;
		data.delete(key);
		expires.delete(key);
		return had;
	};
	const dropIfEmpty = (key: string) => {
		const v = data.get(key);
		if (v && v.kind !== 'string' && v.value.size === 0) remove(key);
	};

	const r: MemoryRedis = {
		calls: 0,
		flush() {
			data.clear();
			expires.clear();
		},
		async get(key) {
			r.calls++;
			return str(key);
		},
		async mget(keys) {
			r.calls++;
			return keys.map((k) => {
				const v = alive(k);
				return v?.kind === 'string' ? v.value : null;
			});
		},
		async set(key, value, o = {}) {
			r.calls++;
			if (o.nx && alive(key) !== undefined) return false;
			putString(key, value, o.px);
			return true;
		},
		async getdel(key) {
			r.calls++;
			const v = str(key);
			if (v !== null) remove(key);
			return v;
		},
		async del(...keys) {
			r.calls++;
			return keys.filter(remove).length;
		},
		async incr(key) {
			r.calls++;
			const v = str(key);
			const n = v === null ? 0 : Number(v);
			if (!Number.isSafeInteger(n)) throw new Error('ERR value is not an integer or out of range');
			const at = expires.get(key);
			data.set(key, { kind: 'string', value: String(n + 1) });
			if (at === undefined) expires.delete(key); // INCR keeps an existing expiry
			return n + 1;
		},
		async pexpire(key, ms) {
			r.calls++;
			if (alive(key) === undefined) return false;
			expires.set(key, now() + Math.max(1, Math.round(ms)));
			return true;
		},
		async pttl(key) {
			r.calls++;
			if (alive(key) === undefined) return -2;
			const at = expires.get(key);
			return at === undefined ? -1 : Math.max(0, at - now());
		},
		async hget(key, field) {
			r.calls++;
			return hash(key, false)?.get(field) ?? null;
		},
		async hset(key, fields) {
			r.calls++;
			const h = hash(key, true)!;
			let added = 0;
			for (const [f, v] of Object.entries(fields)) {
				if (!h.has(f)) added++;
				h.set(f, v);
			}
			return added;
		},
		async hdel(key, ...fields) {
			r.calls++;
			const h = hash(key, false);
			if (!h) return 0;
			const n = fields.filter((f) => h.delete(f)).length;
			dropIfEmpty(key);
			return n;
		},
		async hgetall(key) {
			r.calls++;
			return Object.fromEntries(hash(key, false) ?? []);
		},
		async sadd(key, ...members) {
			r.calls++;
			const s = set(key, true)!;
			let added = 0;
			for (const m of members) {
				if (s.has(m)) continue;
				s.add(m);
				added++;
			}
			return added;
		},
		async srem(key, ...members) {
			r.calls++;
			const s = set(key, false);
			if (!s) return 0;
			const n = members.filter((m) => s.delete(m)).length;
			dropIfEmpty(key);
			return n;
		},
		async smembers(key) {
			r.calls++;
			return [...(set(key, false) ?? [])];
		},
		async scan(pattern) {
			r.calls++;
			const re = globToRegExp(pattern);
			return [...data.keys()].filter((k) => alive(k) !== undefined && re.test(k));
		},
		async compareAndSet(key, expected, value, o = {}) {
			r.calls++;
			const cur = str(key);
			if (expected === null ? cur !== null : cur !== expected) return false;
			putString(key, value, o.px);
			return true;
		},
		async compareAndDelete(key, expected) {
			r.calls++;
			if (str(key) !== expected) return false;
			remove(key);
			return true;
		},
		// Run in order, each counted; like a pipeline, every command runs and the first error is thrown after.
		async batch<const C extends readonly BatchCommand[]>(commands: C): Promise<BatchReplies<C>> {
			const out: unknown[] = [];
			let failure: { error: unknown } | null = null;
			for (const [name, ...args] of commands) {
				try {
					out.push(await (r[name] as (...a: unknown[]) => Promise<unknown>)(...args));
				} catch (error) {
					failure ??= { error };
					out.push(null);
				}
			}
			if (failure) throw failure.error;
			return out as BatchReplies<C>;
		},
		async close() {},
	};
	return r;
}
