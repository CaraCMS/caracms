/**
 * Sign-in for the running server (M4 Phase 3): one `Auth` per process over the live
 * runtime, shared by the guard (middleware.ts) and the sign-in route
 * (`../../editor/routes/login/login.ts`). Map of this folder:
 *
 * | File | What |
 * |---|---|
 * | `allow.ts` | The whitelist: `PUBLIC_MAIL_DOMAINS`, entries, `createWhitelist` (CARACMS_ALLOW + Site Settings' `editors`) |
 * | `session.ts` | The signed cookie, the backup account's config and fingerprint, `cleanNext` |
 * | `links.ts` | Link tokens (SHA-256 only, 15 min, GETDEL) and rate limits, in Redis |
 * | `email.ts` | The link email: Resend in production, the server log otherwise |
 * | `request.ts` | The client IP (X-Real-IP first), same-origin |
 * | `auth.ts` | `createAuth`: the pieces together, `identify()` per request |
 * | `guard.ts` | The one check on `/admin` and `/_caracms/` |
 * | `login.ts` | The `/admin/login…` pages |
 * | `views.ts` | Their HTML, CSS and the one script |
 * | `middleware.ts` | The guard as Astro middleware |
 * | `routes.ts` | `LOGIN_ROUTES`, for the integration |
 */
import { SITE_SETTINGS_FILE, type ResolvedSite } from '../../config.ts';
import { brandFrom } from '../../editor/brand.ts';
import { addressFrom, type LiveSettings } from '../mode.ts';
import { liveRuntime } from '../runtime.ts';
import { createAuth, type Auth } from './auth.ts';

const SHARED = Symbol.for('caracms.auth');
type Shared = { [SHARED]?: Promise<Auth> };

/**
 * The site's public origin for emailed links: Astro's `site`, then SITE_URL, then
 * Railway's public domain (runs-anywhere Decision 7: the chain is mode.ts → `addressFrom`).
 * Never a request's Host header (auth.ts → `siteOrigin`).
 */
export function publicOrigin(astroSite: URL | undefined, env: Record<string, string | undefined> = process.env): string | null {
	return addressFrom(env, astroSite?.href);
}

/** The process's Auth, built on first use over the shared live runtime. */
export function authFor(site: ResolvedSite, settings: LiveSettings, astroSite?: URL): Promise<Auth> {
	const g = globalThis as Shared;
	g[SHARED] ??= liveRuntime(site, settings)
		.then((rt) =>
			createAuth({
				secret: settings.secret,
				agency: settings.allow,
				backup: settings.backup,
				secure: settings.production,
				redis: rt.redis,
				readSettings: () => rt.git.read(SITE_SETTINGS_FILE),
				// M5a Decision 10: Site Settings' brand name as committed in `drafts`.
				siteName: () => brandFrom(rt.git.read(SITE_SETTINGS_FILE), site).name,
				siteOrigin: settings.address ?? publicOrigin(astroSite),
				env: process.env,
				now: rt.now,
			}),
		)
		.catch((error: unknown) => {
			delete g[SHARED];
			throw error;
		});
	return g[SHARED];
}

/** Forget the shared Auth (tests). */
export function resetAuth(): void {
	delete (globalThis as Shared)[SHARED];
}
