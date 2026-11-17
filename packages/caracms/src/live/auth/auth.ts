/**
 * Sign-in's pieces, built once per process over the live runtime (M4 Phase 3):
 * the whitelist, link tokens and rate limits in Redis, the backup account and the
 * session. The guard (guard.ts) and the sign-in pages (login.ts) share one of these.
 *
 * `identify()` is the per-request check: the signed cookie, then **the whitelist
 * again** (a `link` session whose address is no longer on it is `removed`, Decision
 * 11), or the backup account with the same username and password as at sign-in.
 * It makes no Redis call: the whitelist's client half is read from the in-memory
 * `drafts` copy, so a guard check never wakes Redis.
 */
import { SITE_SETTINGS_FILE } from '../git.ts';
import type { Person } from '../messages.ts';
import type { RedisClient } from '../redis.ts';
import { createWhitelist, type Whitelist } from './allow.ts';
import { deliverLink, type Delivery } from './email.ts';
import { createLinkStore, createRateLimits, type LinkStore, type RateLimits } from './links.ts';
import {
	backupConfig,
	backupPerson,
	clearedSessionCookie,
	freshPayload,
	readCookie,
	safeEqual,
	SESSION_MAX_AGE_S,
	SESSION_RENEW_MS,
	sessionCookie,
	sessionCookieName,
	signSession,
	verifySession,
	type BackupConfig,
	type SessionPayload,
} from './session.ts';

export type SignedOutReason = 'signed-out' | 'removed';

export type Identity =
	| { state: 'in'; person: Person; payload: SessionPayload; /** A renewed Set-Cookie value, when the cookie is over an hour old. */ renew: string | null }
	| { state: 'out'; reason: SignedOutReason };

export interface AuthOptions {
	secret: string;
	/** CARACMS_ALLOW's entries (mode.ts → LiveSettings.allow). */
	agency: readonly string[];
	backup: { user: string; password: string } | null;
	/** Secure cookies (`__Host-`, `Secure`): a production server. */
	secure: boolean;
	redis: RedisClient;
	/** Site Settings' text from the `drafts` copy, or null. */
	readSettings: () => string | null;
	/** The site's name, for the email and the confirm page: a getter reads Site Settings' brand as committed (M5a Decision 10). */
	siteName: string | (() => string);
	/**
	 * The origin emailed links point at (the site's public address). Required to email
	 * a link: a request's own Host header is never used for an emailed link, or anyone
	 * could have a real token mailed out pointing at their own host.
	 */
	siteOrigin: string | null;
	env: Record<string, string | undefined>;
	now?: () => number;
	log?: (line: string) => void;
	/** Tests: replace the delivery (email or log). */
	deliver?: typeof deliverLink;
}

export interface Auth {
	readonly secure: boolean;
	/** The site's public origin (`AuthOptions.siteOrigin`): the mismatch sentences name it (runs-anywhere Decision 7). */
	readonly siteOrigin: string | null;
	readonly cookieName: string;
	readonly whitelist: Whitelist;
	readonly links: LinkStore;
	readonly limits: RateLimits;
	readonly backup: BackupConfig;
	/** Read on each use: Site Settings' brand name can change while the server runs (M5a). */
	readonly siteName: string;
	readonly now: () => number;
	readonly log: (line: string) => void;
	identify(cookieHeader: string | null): Identity;
	/** The Set-Cookie value for a new session. */
	startSession(identity: { kind: 'link'; email: string } | { kind: 'backup' }): string;
	clearCookie(): string;
	/** Issue and deliver a link, after the response. Never throws. */
	sendLink(email: string, next: string, requestOrigin: string): Promise<Delivery | 'not-sent'>;
	/** Links being sent right now (tests wait on them). */
	readonly sending: Set<Promise<unknown>>;
}

export function createAuth(options: AuthOptions): Auth {
	const now = options.now ?? Date.now;
	const log = options.log ?? ((line: string) => console.log(`[caracms] sign-in: ${line}`));
	const backup = backupConfig(options.backup, options.secret, log);
	const whitelist = createWhitelist({ agency: options.agency, readSettings: options.readSettings, settingsFile: SITE_SETTINGS_FILE, log });
	const links = createLinkStore(options.redis);
	const limits = createRateLimits(options.redis);
	const cookieName = sessionCookieName(options.secure);
	const sending = new Set<Promise<unknown>>();
	const cookieFor = (payload: SessionPayload) => sessionCookie(signSession(payload, options.secret), { secure: options.secure });

	return {
		secure: options.secure,
		siteOrigin: options.siteOrigin,
		cookieName,
		whitelist,
		links,
		limits,
		backup,
		get siteName() {
			return typeof options.siteName === 'function' ? options.siteName() : options.siteName;
		},
		now,
		log,
		sending,
		identify(cookieHeader) {
			const payload = verifySession(readCookie(cookieHeader, cookieName), options.secret, now());
			if (!payload) return { state: 'out', reason: 'signed-out' };
			let person: Person;
			if (payload.kind === 'link') {
				if (!whitelist.allows(payload.email)) return { state: 'out', reason: 'removed' };
				person = { email: payload.email };
			} else {
				// Same username AND the same password as at sign-in, and the account still on.
				const ok = backup.enabled && safeEqual(payload.user, backup.user) && safeEqual(payload.fingerprint, backup.fingerprint);
				if (!ok) return { state: 'out', reason: 'signed-out' };
				person = backupPerson(backup.user);
			}
			const renew = now() - payload.renewed > SESSION_RENEW_MS ? cookieFor({ ...payload, renewed: now(), expires: now() + SESSION_MAX_AGE_S * 1000 }) : null;
			return { state: 'in', person, payload, renew };
		},
		startSession(identity) {
			if (identity.kind === 'link') return cookieFor(freshPayload({ kind: 'link', email: identity.email }, now()));
			if (!backup.enabled) throw new Error('the backup account is off');
			return cookieFor(freshPayload({ kind: 'backup', user: backup.user, fingerprint: backup.fingerprint }, now()));
		},
		clearCookie: () => clearedSessionCookie({ secure: options.secure }),
		sendLink(email, next, requestOrigin) {
			const work = (async (): Promise<Delivery | 'not-sent'> => {
				try {
					const emailing = options.env['NODE_ENV'] === 'production';
					const origin = options.siteOrigin ?? (emailing ? null : requestOrigin);
					if (!origin) {
						log("no sign-in link sent: the site's public address isn't known (set SITE_URL, when the site is built and when it runs).");
						return 'not-sent';
					}
					const token = await links.issue(email, next);
					const link = `${origin}/admin/login/confirm?token=${token}`;
					return await (options.deliver ?? deliverLink)({ to: email, link, siteName: typeof options.siteName === 'function' ? options.siteName() : options.siteName, env: options.env, log });
				} catch (error) {
					log(`could not issue a sign-in link: ${error instanceof Error ? error.message : String(error)}`);
					return 'not-sent';
				}
			})();
			sending.add(work);
			void work.finally(() => sending.delete(work));
			return work;
		},
	};
}
