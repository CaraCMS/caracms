/**
 * The guard (M4 Decision 14): **one check on path prefixes**, `/admin` and
 * `/_caracms/`, in live mode only. It knows no list of the editor's routes, so every
 * route Phase 2 adds under those prefixes is covered without this file changing.
 *
 * - **Let through**: the sign-in pages, exactly (`/admin/login` and its own subpages,
 *   letters and hyphens only, no encoding), `POST /_caracms/github` (the webhook,
 *   which checks GitHub's signature instead, Decision 14), and `POST /_caracms/form`
 *   (the public forms' endpoint, M6 Decision 5: anyone, from anywhere).
 * - **Every write** (any method but GET and HEAD) **also requires the same origin**
 *   (request.ts → isSameOrigin), else 403, checked before the session.
 * - **No session**: a page (`/admin…`) redirects to sign-in with `next`; an API
 *   (`/_caracms/…`) answers 401 JSON, `{ error, code: 'signed-out', reason, signIn }`. **When the cookie is
 *   valid but the address is no longer on the whitelist, `reason` is `removed`**
 *   (Decision 11); otherwise `signed-out`. The page redirect is the same for everyone.
 * - **A pass** gives the person (the caller records it with `setPerson`) and, when the
 *   cookie is over an hour old, a renewed one to set.
 *
 * Which paths count is decided on a normalised path (percent-decoded, lower-cased,
 * repeated slashes collapsed), so `/ADMIN`, `/%61dmin` and `//admin` are guarded too.
 * A path that won't decode is guarded. The let-through is decided on the raw path.
 */
import type { Person } from '../messages.ts';
import type { Auth, SignedOutReason } from './auth.ts';
import { addressMismatch, isRead, isSameOrigin } from './request.ts';
import { cleanNext, LOGIN_PATH, loginHref } from './session.ts';

/** Whether the guard looks at this path at all. */
export function isGuardedPath(rawPathname: string): boolean {
	let path: string;
	try {
		path = decodeURIComponent(rawPathname);
	} catch {
		return true;
	}
	path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
	return path === '/admin' || path.startsWith('/admin/') || path.startsWith('/admin.') || path === '/_caracms' || path.startsWith('/_caracms/');
}

const LOGIN_RE = /^\/admin\/login(?:\/[a-z-]+)?\/?$/;

/** The sign-in pages, the webhook and the form endpoint: reached with no session. */
export function isLetThrough(rawPathname: string, method: string): boolean {
	if (LOGIN_RE.test(rawPathname)) return true;
	if (method !== 'POST') return false;
	return rawPathname === '/_caracms/github' || rawPathname === '/_caracms/github/' || isFormEndpoint(rawPathname);
}

/** `/_caracms/form`, exactly (a trailing slash allowed, no encoding): public in every mode (M6 Decision 5). */
export const isFormEndpoint = (rawPathname: string): boolean => rawPathname === '/_caracms/form' || rawPathname === '/_caracms/form/';

/** An API path: answered with JSON, never a redirect. */
const isApi = (rawPathname: string) => !/^\/+admin(?:[/.]|$)/i.test(safeDecode(rawPathname));
const safeDecode = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

/** The 401 body an API answers with no session. Phase 4's signed-out state reads it. */
export interface SignedOutBody {
	error: string;
	/** Always `signed-out`: types.ts → ApiError's code for a 401. */
	code: 'signed-out';
	/** `removed`: the cookie was valid but the address is no longer on the whitelist (Decision 11). */
	reason: SignedOutReason;
	/** Where "Sign in again" goes (opened in a new tab). */
	signIn: string;
}

export interface ForbiddenBody {
	error: string;
	code: 'cross-origin';
}

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE } });

export const SIGNED_OUT_MESSAGE: Record<SignedOutReason, string> = {
	'signed-out': "You're signed out. Sign in again to keep editing.",
	removed: "You can no longer sign in to this site, so your latest changes couldn't be kept.",
};

export type GuardResult = { kind: 'skip' } | { kind: 'pass'; person: Person; setCookie: string | null } | { kind: 'respond'; response: Response };

export function guard(request: Request, auth: Auth): GuardResult {
	const url = new URL(request.url);
	const raw = url.pathname;
	if (!isGuardedPath(raw) || isLetThrough(raw, request.method)) return { kind: 'skip' };
	const api = isApi(raw);

	if (!isRead(request.method) && !isSameOrigin(request)) {
		// Runs-anywhere Decision 7: the editor's own write, refused because the site's address isn't the one in use.
		const error = addressMismatch(request, auth.siteOrigin) ?? 'This only takes requests from the editor on this site.';
		if (api) return { kind: 'respond', response: json(403, { error, code: 'cross-origin' } satisfies ForbiddenBody) };
		return { kind: 'respond', response: new Response(error, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE } }) };
	}

	const who = auth.identify(request.headers.get('cookie'));
	if (who.state === 'in') return { kind: 'pass', person: who.person, setCookie: who.renew };

	if (api) {
		const body: SignedOutBody = { error: SIGNED_OUT_MESSAGE[who.reason], code: 'signed-out', reason: who.reason, signIn: LOGIN_PATH };
		return { kind: 'respond', response: json(401, body) };
	}
	// A page: the same redirect for everyone (the sign-in pages never say why).
	const next = cleanNext(`${raw}${url.search}`);
	return { kind: 'respond', response: new Response(null, { status: 303, headers: { Location: loginHref({}, next), ...NO_STORE } }) };
}
