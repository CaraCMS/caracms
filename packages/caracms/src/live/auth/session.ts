/**
 * The session, the backup account and `next` (M4 Decision 14; the template's
 * `server/auth-options.mjs`, without Auth.js).
 *
 * **The session is a cookie the site signs itself**: `<payload>.<mac>`, the payload
 * base64url JSON, the mac HMAC-SHA256 over it under a key derived from
 * `CARACMS_SECRET`, compared in constant time. `HttpOnly`, `Secure` in production,
 * `SameSite=Lax`, `Path=/`, no `Domain`. It lasts **30 days from last use**: the guard
 * renews it (a new `renewed` and `expires`) when it's more than an hour old, so a
 * poll every 5 s doesn't set a cookie every 5 s. In production the name has the
 * `__Host-` prefix, so no other host can plant one. Changing `CARACMS_SECRET` signs
 * everyone out.
 *
 * Two kinds:
 * - `link`: an address that spent a link. **The whitelist is checked again on every
 *   request** (guard.ts), so removing an address signs that person out on their next one.
 * - `backup`: the backup account. It carries a fingerprint of the password it signed
 *   in with (an HMAC under the secret, never the password), so **changing the password
 *   signs backup sessions out**.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Person } from '../messages.ts';

export const LOGIN_PATH = '/admin/login';
export const DEFAULT_NEXT = '/admin';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
/** Renew the cookie once it's this old, so it stays 30 days from last use. */
export const SESSION_RENEW_MS = 60 * 60 * 1000;
/** Shorter means no backup sign-in, and no link to it. */
export const BACKUP_MIN_PASSWORD = 24;

/** The cookie's name: `__Host-` prefixed when it's `Secure` (production). */
export const sessionCookieName = (secure: boolean) => (secure ? '__Host-caracms_session' : 'caracms_session');

export type SessionPayload =
	| { v: 1; kind: 'link'; email: string; renewed: number; expires: number }
	| { v: 1; kind: 'backup'; user: string; fingerprint: string; renewed: number; expires: number };

const macKey = (secret: string) => createHmac('sha256', secret).update('caracms session v1').digest();

/** Constant-time string comparison: both sides hashed first, so lengths never leak. */
export function safeEqual(a: unknown, b: string): boolean {
	const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
	return timingSafeEqual(digest(typeof a === 'string' ? a : ''), digest(b));
}

export function signSession(payload: SessionPayload, secret: string): string {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const mac = createHmac('sha256', macKey(secret)).update(body).digest('base64url');
	return `${body}.${mac}`;
}

/** The payload, if the cookie is ours, intact and not expired; else null. */
export function verifySession(value: string | undefined | null, secret: string, now: number): SessionPayload | null {
	if (!value || value.length > 4096) return null;
	const dot = value.indexOf('.');
	if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
	const body = value.slice(0, dot);
	const given = Buffer.from(value.slice(dot + 1), 'base64url');
	const expected = createHmac('sha256', macKey(secret)).update(body).digest();
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	const p = payload as Partial<SessionPayload> & Record<string, unknown>;
	if (!p || p.v !== 1 || typeof p.expires !== 'number' || typeof p.renewed !== 'number' || !(p.expires > now)) return null;
	if (p.kind === 'link' && typeof p.email === 'string') return p as SessionPayload;
	if (p.kind === 'backup' && typeof p.user === 'string' && typeof p.fingerprint === 'string') return p as SessionPayload;
	return null;
}

/** A fresh payload for a sign-in, or a renewal of an existing one. */
export function freshPayload(
	identity: { kind: 'link'; email: string } | { kind: 'backup'; user: string; fingerprint: string },
	now: number,
): SessionPayload {
	return { v: 1, ...identity, renewed: now, expires: now + SESSION_MAX_AGE_S * 1000 } as SessionPayload;
}

export interface CookieOptions {
	secure: boolean;
}

/** The Set-Cookie value for a session. */
export function sessionCookie(value: string, { secure }: CookieOptions): string {
	return `${sessionCookieName(secure)}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The Set-Cookie value that clears it (sign out). */
export function clearedSessionCookie({ secure }: CookieOptions): string {
	return `${sessionCookieName(secure)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** One cookie's value out of a Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

// ── The backup account ────────────────────────────────────────────────────────

export type BackupConfig = { enabled: true; user: string; password: string; fingerprint: string } | { enabled: false };

/**
 * The backup account as configured: both variables, and a password of at least 24
 * characters. **Under 24 characters means no backup sign-in and no link to it**, with
 * one line in the log. Neither set: off, silently.
 */
export function backupConfig(backup: { user: string; password: string } | null, secret: string, log: (line: string) => void): BackupConfig {
	if (!backup) return { enabled: false };
	if (backup.password.length < BACKUP_MIN_PASSWORD) {
		log(`CARACMS_BACKUP_PASSWORD is shorter than ${BACKUP_MIN_PASSWORD} characters: the backup account is off.`);
		return { enabled: false };
	}
	return { enabled: true, user: backup.user, password: backup.password, fingerprint: passwordFingerprint(backup.user, backup.password, secret) };
}

/** The backup password's fingerprint for the session: an HMAC under the secret, never the password. */
export function passwordFingerprint(user: string, password: string, secret: string): string {
	return createHmac('sha256', secret).update(`caracms backup\u0000${user}\u0000${password}`, 'utf8').digest('base64url').slice(0, 22);
}

/** The backup account as a person: an address that can't be anyone's (`.invalid`), named by its username. */
export function backupPerson(user: string): Person {
	return { email: `${user.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}@backup.invalid`, name: user };
}

// ── `next` ────────────────────────────────────────────────────────────────────

/**
 * **`next` must be a same-origin path under `/admin`**, else `/admin`. Refused:
 * protocol-relative (`//evil.test`, `/\evil.test`), absolute URLs (`https://evil.test/admin`),
 * paths outside `/admin` (`/x`), backslashes and control characters anywhere,
 * percent-encoded slashes or backslashes (`%2f`, `%5c`), dot segments that leave
 * `/admin` once resolved, and the sign-in pages themselves.
 */
export function cleanNext(value: unknown): string {
	if (typeof value !== 'string') return DEFAULT_NEXT;
	const raw = value.trim();
	if (!raw || raw.length > 2048) return DEFAULT_NEXT;
	if (/[\\\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_NEXT;
	if (/%(?:2f|5c|00)/i.test(raw)) return DEFAULT_NEXT;
	if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT_NEXT;
	const base = 'http://next.invalid';
	let url: URL;
	try {
		url = new URL(raw, base);
	} catch {
		return DEFAULT_NEXT;
	}
	if (url.origin !== base) return DEFAULT_NEXT;
	const { pathname } = url;
	if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return DEFAULT_NEXT;
	if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) return DEFAULT_NEXT;
	return `${pathname}${url.search}${url.hash}`;
}

/** `/admin/login?next=…`, with `next` left off when it's the default. */
export function loginHref(params: Record<string, string> = {}, next = DEFAULT_NEXT): string {
	const search = new URLSearchParams(params);
	if (next && next !== DEFAULT_NEXT) search.set('next', next);
	const query = search.toString();
	return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}

/**
 * A `Cookie` header value for a link session as this person (tests, and Phase 2's
 * route tests over HTTP). The address must also be on the whitelist to pass the guard.
 */
export function sessionCookieFor(person: Pick<Person, 'email'>, secret: string, options: { secure?: boolean; now?: number } = {}): string {
	const value = signSession(freshPayload({ kind: 'link', email: person.email.trim().toLowerCase() }, options.now ?? Date.now()), secret);
	return `${sessionCookieName(options.secure ?? false)}=${value}`;
}
