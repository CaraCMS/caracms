/**
 * What sign-in keeps in Redis: one-time link tokens and the rate-limit counters (M4
 * Decision 14; the template's `server/login-store.mjs`, over our RedisClient).
 *
 * Every key starts with `caracms:auth:` and has an expiry, so nothing here outlives
 * 15 minutes.
 *
 * **Link tokens:** 32 random bytes, base64url (43 characters) in the link. **Only the
 * token's SHA-256 is stored**, `caracms:auth:link:<hash>` → `{ email, next }`, for 15
 * minutes, so a leaked Redis yields no usable link. `peek` is a plain GET: loading the
 * confirm page never spends a token (mail scanners load every link). **`spend` is
 * GETDEL**: atomic, so two presses can't both sign in.
 *
 * **Rate limits:** a fixed 15-minute window per key, started by the first hit and never
 * extended. Link requests: **3 per address and 10 per IP**. Backup sign-in: 5 attempts
 * per IP, counting every attempt (the template's `BACKUP_LIMIT`). The address and the IP
 * are SHA-256'd in the key names, so no address sits in Redis in the clear and a header
 * can't put arbitrary text into a key.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { RedisClient } from '../redis.ts';

export const LINK_TTL_MS = 15 * 60 * 1000;
export const RATE_WINDOW_MS = 15 * 60 * 1000;
export const LINK_LIMITS = { perAddress: 3, perIp: 10 } as const;
export const BACKUP_LIMIT = 5;
const PREFIX = 'caracms:auth:';

export const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const newLinkToken = () => randomBytes(32).toString('base64url');
/** Only tokens this module could have minted reach Redis. */
export const isTokenShape = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
export const linkKey = (token: string) => `${PREFIX}link:${sha256Hex(token)}`;

export interface LinkRecord {
	email: string;
	next: string;
}

function parse(raw: string | null): LinkRecord | null {
	if (raw === null) return null;
	try {
		const record = JSON.parse(raw) as Partial<LinkRecord>;
		return typeof record?.email === 'string' ? { email: record.email, next: typeof record.next === 'string' ? record.next : '' } : null;
	} catch {
		return null;
	}
}

export interface LinkStore {
	/** Store a new token for this (normalised) address; returns the token for the link. */
	issue(email: string, next: string): Promise<string>;
	/** Read without spending (the confirm page). Null for missing, expired, used or malformed. */
	peek(token: unknown): Promise<LinkRecord | null>;
	/** Read and delete in one step (the press). Null if it was already gone. */
	spend(token: unknown): Promise<LinkRecord | null>;
}

export function createLinkStore(redis: RedisClient): LinkStore {
	return {
		async issue(email, next) {
			const token = newLinkToken();
			await redis.set(linkKey(token), JSON.stringify({ email, next }), { px: LINK_TTL_MS });
			return token;
		},
		async peek(token) {
			return isTokenShape(token) ? parse(await redis.get(linkKey(token))) : null;
		},
		async spend(token) {
			return isTokenShape(token) ? parse(await redis.getdel(linkKey(token))) : null;
		},
	};
}

export interface RateLimits {
	/** One link request: counts against both the address and the IP; whether either is now over. */
	linkRequestOver(email: string, ip: string): Promise<boolean>;
	/** One backup sign-in attempt from this IP: whether it's over. */
	backupAttemptOver(ip: string): Promise<boolean>;
}

export function createRateLimits(redis: RedisClient): RateLimits {
	/** Count one hit; the window starts with the first and isn't extended by later ones. */
	const hit = async (name: string) => {
		const key = `${PREFIX}rl:${name}`;
		const count = await redis.incr(key);
		// The first hit starts the window. A key left with no expiry (a crash between the
		// two calls) is given one on its next hit, so a counter can never stick.
		if (count === 1 || (await redis.pttl(key)) === -1) await redis.pexpire(key, RATE_WINDOW_MS);
		return count;
	};
	return {
		async linkRequestOver(email, ip) {
			const [byAddress, byIp] = await Promise.all([hit(`link-address:${sha256Hex(email)}`), hit(`link-ip:${sha256Hex(ip)}`)]);
			return byAddress > LINK_LIMITS.perAddress || byIp > LINK_LIMITS.perIp;
		},
		async backupAttemptOver(ip) {
			return (await hit(`backup-ip:${sha256Hex(ip)}`)) > BACKUP_LIMIT;
		},
	};
}
