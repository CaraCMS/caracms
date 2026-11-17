/**
 * The form endpoint's rate limit (M6 Decision 5): 5 hits per visitor IP per 10 minutes.
 *
 * - **In Redis** whenever the server has `REDIS_URL` (live mode always does in
 *   production), as expiring counters, so the count survives a deploy. One window per
 *   IP starts with its first hit (sign-in's limits do the same, live/auth/links.ts).
 * - **In memory** without it (local mode, tests).
 * - **Redis out fails open**, with a log line: the limit is spam control, and a
 *   visitor's message matters more than a counter (the honeypot and Turnstile stand).
 *
 * `peek` only looks (the check before a large body is read); `hit` counts one and says
 * whether that one is over the limit.
 *
 * **One limiter per use** (M6c Decision 6): each instance has its own key prefix, limit
 * and window (`LimitSettings`), so the public file route's downloads (files-route.ts,
 * `caracms:files:rl:`) never use up a visitor's contact-form allowance. The forms' own
 * settings are `FORM_LIMIT`, unchanged.
 */
import { createHash } from 'node:crypto';
import { connectRedis, type RedisClient } from '../live/redis.ts';

export const RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 } as const;

/** One limiter's settings: its Redis key prefix, its limit and window, and what its log line calls a hit. */
export interface LimitSettings {
	/** Ends in `:`; the hashed IP follows. */
	prefix: string;
	max: number;
	windowMs: number;
	/** The log line's words: `forms` / `submission`. */
	area: string;
	hitName: string;
}

/** The forms' limiter (M6 Decision 5). */
export const FORM_LIMIT: LimitSettings = { prefix: 'caracms:forms:rl:', ...RATE_LIMIT, area: 'forms', hitName: 'submission' };

export interface RateLimiter {
	/** Already at the limit? Records nothing. */
	peek(ip: string): Promise<boolean>;
	/** Count a hit: true when this one is over the limit. */
	hit(ip: string): Promise<boolean>;
}

/** The forms' name for it, kept. */
export type FormRateLimiter = RateLimiter;

export function memoryLimiter(options: { now?: () => number; max?: number; windowMs?: number } = {}): RateLimiter {
	const now = options.now ?? Date.now;
	const max = options.max ?? FORM_LIMIT.max;
	const windowMs = options.windowMs ?? FORM_LIMIT.windowMs;
	const hits = new Map<string, number[]>();
	const recent = (ip: string) => (hits.get(ip) ?? []).filter((t) => t > now() - windowMs);
	return {
		async peek(ip) {
			return recent(ip).length >= max;
		},
		async hit(ip) {
			if (hits.size > 1000) for (const [k] of hits) if (recent(k).length === 0) hits.delete(k);
			const times = recent(ip);
			times.push(now());
			hits.set(ip, times);
			return times.length > max;
		},
	};
}

/** `options` defaults to the forms' settings. */
export function redisLimiter(redis: RedisClient, log: (line: string) => void = (l) => console.error(l), options: Partial<LimitSettings> = {}): RateLimiter {
	const { prefix, max, windowMs, area, hitName } = { ...FORM_LIMIT, ...options };
	const key = (ip: string) => `${prefix}${createHash('sha256').update(ip).digest('hex')}`;
	const failOpen = (error: unknown) => {
		log(`[caracms] ${area}: couldn't reach Redis for the rate limit, so this ${hitName} wasn't counted: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	};
	return {
		async peek(ip) {
			try {
				return Number((await redis.get(key(ip))) ?? 0) >= max;
			} catch (error) {
				return failOpen(error);
			}
		},
		async hit(ip) {
			try {
				const k = key(ip);
				const count = await redis.incr(k);
				// The first hit starts the window; a key left with no expiry (a crash between the calls) gets one now.
				if (count === 1 || (await redis.pttl(k)) === -1) await redis.pexpire(k, windowMs);
				return count > max;
			} catch (error) {
				return failOpen(error);
			}
		},
	};
}

type Shared = Record<symbol, { url: string | null; limiter: RateLimiter } | undefined>;

/**
 * The process's limiter for one use, kept on `globalThis` under `name` (a `Symbol.for`
 * key, so Vite's module copies share it): Redis at `REDIS_URL` when it's set, else memory.
 */
export function processLimiter(name: string, settings: LimitSettings, env: Record<string, string | undefined> = process.env): RateLimiter {
	const slot = Symbol.for(name);
	const url = env['REDIS_URL']?.trim() || null;
	const g = globalThis as Shared;
	const held = g[slot];
	if (held && held.url === url) return held.limiter;
	const limiter = url ? redisLimiter(connectRedis(url), undefined, settings) : memoryLimiter({ max: settings.max, windowMs: settings.windowMs });
	g[slot] = { url, limiter };
	return limiter;
}

/** Forget one use's process limiter (tests). */
export function resetProcessLimiter(name: string): void {
	delete (globalThis as Shared)[Symbol.for(name)];
}

const FORMS = 'caracms.formLimiter';

/** The forms' process limiter. */
export function formLimiter(env: Record<string, string | undefined> = process.env): FormRateLimiter {
	return processLimiter(FORMS, FORM_LIMIT, env);
}

/** Forget the forms' process limiter (tests). */
export function resetFormLimiter(): void {
	resetProcessLimiter(FORMS);
}
