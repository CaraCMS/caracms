/**
 * The sign-in pages under `/admin/login` (M4 Decision 14; the template's
 * `server/admin-login.mjs`, without Auth.js). A Request in, a Response out.
 *
 *   GET  /admin/login[?next=][&backup=1][&signedout=1]
 *        The email form. `?backup=1` swaps in the backup form (only while the backup
 *        account is on); `?signedout=1` adds "You're signed out".
 *   POST /admin/login                (form: email, next[, again])
 *        **Request a link: a plain form POST.** Rate limits (3 per address, 10 per IP,
 *        per 15 minutes), then the whitelist; the link is issued and emailed (or
 *        logged) AFTER the response, so **every path answers the same "Check your
 *        email" page** in about the same time. A malformed address is the one other
 *        answer (400, the form's own error), which says nothing about the whitelist.
 *   POST /admin/login?backup=1       Script off: shows the backup form again. Reads nothing.
 *   GET  /admin/login/confirm?token=…
 *        Where the emailed link lands. **Read-only** (GET, never GETDEL: mail scanners
 *        open links): "Sign in as …"; "Switch to …?" when this browser is signed in as
 *        someone else; straight to `next` with the token left unspent when it's
 *        already signed in as that address; or the one dead-link page (410).
 *   POST /admin/login/confirm        Script off: 303 back to the GET. Spends nothing.
 *   POST /admin/login/signin         (JSON: `{ kind: 'link', token }` or
 *        `{ kind: 'backup', username, password, next }`) The press. **The token is
 *        spent here only**, with GETDEL, and the address checked against the whitelist
 *        again. Answers `{ location }` with the session cookie, or `{ error, reason }`
 *        (`dead-link` 410, `wrong` 401, `limited` 429, `failed`).
 *   POST /admin/login/signout        Clears the cookie; 303 to `?signedout=1`, or
 *        `{ ok, location }` to a JSON request.
 *   GET  /admin/login/signed-in?next=
 *        After signing in on a narrow window (M2 Decision 8): signed in, open the
 *        editor on a larger screen, with Sign out.
 *
 * Every POST requires the same origin (403 otherwise): the guard lets these paths
 * through, so they check it themselves. Responses are `Cache-Control: private,
 * no-store`, `X-Robots-Tag: noindex, nofollow`, `nosniff`, `Referrer-Policy:
 * same-origin` (not `no-referrer`, under which browsers send `Origin: null` on the
 * form POSTs) and a CSP with only the page's own style and script, by hash.
 */
import type { Auth } from './auth.ts';
import { normaliseEmail } from './allow.ts';
import { addressMismatch, addressNotice, clientIp, isRead, isSameOrigin, NO_GATE_MESSAGE } from './request.ts';
import { backupPerson, cleanNext, DEFAULT_NEXT, LOGIN_PATH, loginHref, safeEqual } from './session.ts';
import {
	backupView,
	confirmView,
	deadLinkView,
	emailView,
	layout,
	messageView,
	sentView,
	signedInNarrowView,
	SIGNED_IN_PATH,
	SIGNIN_PATH,
	type Brand,
	type PageAssets,
	type SafeHtml,
} from './views.ts';
import { readCappedText } from '../../body.ts';

export const CONFIRM_PATH = `${LOGIN_PATH}/confirm`;
export const SIGNOUT_PATH = `${LOGIN_PATH}/signout`;
export { SIGNIN_PATH, SIGNED_IN_PATH };

/** Largest form or JSON body read. An address and a password are tiny. */
const MAX_BODY_BYTES = 8 * 1024;

export interface LoginContext {
	auth: Auth;
	brand: Brand;
	assets: PageAssets;
	/** The adapter's socket address (Astro's `clientAddress`), read lazily: it can throw. */
	clientAddress: () => string | undefined;
}

const BASE_HEADERS = {
	'Cache-Control': 'private, no-store',
	'X-Robots-Tag': 'noindex, nofollow',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'same-origin',
};

class BodyTooLarge extends Error {}

async function readBody(request: Request): Promise<string> {
	// caracms-cloud adversarial review, finding 10: counted as it's read, so a chunked body stops at the cap too.
	const text = await readCappedText(request, MAX_BODY_BYTES);
	if (text === null) throw new BodyTooLarge();
	return text;
}

export async function handleLogin(request: Request, ctx: LoginContext): Promise<Response> {
	const { auth, brand, assets } = ctx;
	const url = new URL(request.url);
	const pathname = url.pathname.replace(/\/+$/, '') || '/';
	const method = request.method;
	const query = url.searchParams;
	const extra: Record<string, string> = {};

	const page = (status: number, title: string, body: SafeHtml, opts: { script?: boolean; quiet?: boolean; bare?: boolean } = {}) => {
		const { html, csp } = layout({ title, brand, assets, body, home: url.host, ...opts });
		return new Response(method === 'HEAD' ? null : html, {
			status,
			headers: { ...BASE_HEADERS, ...extra, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp },
		});
	};
	const redirect = (location: string, cookie?: string) => {
		const headers = new Headers({ ...BASE_HEADERS, Location: location });
		if (cookie) headers.append('Set-Cookie', cookie);
		return new Response(null, { status: 303, headers });
	};
	const json = (status: number, body: unknown, cookie?: string) => {
		const headers = new Headers({ ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
		if (cookie) headers.append('Set-Cookie', cookie);
		return new Response(JSON.stringify(body), { status, headers });
	};
	const notAllowed = (allow: string) => {
		extra.Allow = allow;
		return page(405, 'Not allowed', messageView('Not allowed', 'Use the form on the sign-in page.'));
	};
	// Runs-anywhere Decision 7: refused because the site's address isn't the one in use, the sentence says so, naming SITE_URL.
	const mismatch = () => addressMismatch(request, auth.siteOrigin);
	const crossOrigin = () => page(403, 'Not allowed', messageView('Not allowed', mismatch() ?? 'Send the form from the sign-in page.'));
	const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
	// Runs-anywhere Decision 8: on a production server (`auth.secure` is production), the IP
	// comes from `caracms start`'s gate alone; without it, no sign-in at all (acceptance check 17).
	const ip = clientIp(request, ctx.clientAddress, auth.secure);
	if (ip === null) {
		if (pathname === SIGNIN_PATH || wantsJson) return json(503, { error: NO_GATE_MESSAGE, reason: 'failed' });
		return page(503, 'Sign-in is off', messageView('Sign-in is off', NO_GATE_MESSAGE));
	}

	try {
		// ────────────────────────────────────────────────────────────── confirm
		if (pathname === CONFIRM_PATH) {
			if (method === 'POST') return redirect(`${CONFIRM_PATH}${url.search}`);
			if (!isRead(method)) return notAllowed('GET, HEAD, POST');
			const record = await auth.links.peek(query.get('token'));
			if (!record) return page(410, 'Link expired', deadLinkView());
			const next = cleanNext(record.next);
			const who = auth.identify(request.headers.get('cookie'));
			if (who.state === 'in' && who.payload.kind === 'link' && who.person.email === record.email) {
				// Already in as this address: go on, and leave the token unspent.
				return redirect(next);
			}
			const current = who.state !== 'in' ? null : who.payload.kind === 'backup' ? 'the backup account' : who.person.email;
			return page(200, 'Sign in', confirmView({ email: record.email, next, siteName: auth.siteName, current }), { script: true, quiet: true });
		}

		// ─────────────────────────────────────────────────────────────── signin
		if (pathname === SIGNIN_PATH) {
			if (method !== 'POST') return notAllowed('POST');
			if (!isSameOrigin(request)) return json(403, { error: mismatch() ?? 'Sign in from the sign-in page.', reason: 'failed' });
			let body: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(await readBody(request));
				if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
				body = parsed as Record<string, unknown>;
			} catch {
				return json(400, { error: 'Send { kind, … } as JSON.', reason: 'failed' });
			}
			if (body.kind === 'link') {
				const record = await auth.links.spend(body.token);
				const email = normaliseEmail(record?.email);
				// Spent, and the address still on the whitelist (it may have been removed since).
				if (!record || !email || !auth.whitelist.allows(email)) return json(410, { error: 'This link has expired or was already used.', reason: 'dead-link' });
				auth.log(`signed in: ${email}`);
				return json(200, { location: cleanNext(record.next) }, auth.startSession({ kind: 'link', email }));
			}
			if (body.kind === 'backup') {
				const { backup } = auth;
				if (!backup.enabled) return json(404, { error: 'There is no backup account on this site.', reason: 'failed' });
				// Every attempt counts, the right password included, so the limit can't confirm a guess.
				let over = true;
				try {
					over = await auth.limits.backupAttemptOver(ip);
				} catch (error) {
					auth.log(`could not count a backup sign-in attempt, so it was refused: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (over) return json(429, { error: 'Too many attempts. Try again in 15 minutes.', reason: 'limited' });
				// Both compared every time: no early exit on a wrong username.
				const userOk = safeEqual(body.username, backup.user);
				const passwordOk = safeEqual(body.password, backup.password);
				if (!(userOk && passwordOk)) return json(401, { error: "That username and password didn't work.", reason: 'wrong' });
				auth.log(`signed in: the backup account (${backupPerson(backup.user).name})`);
				return json(200, { location: cleanNext(body.next) }, auth.startSession({ kind: 'backup' }));
			}
			return json(400, { error: 'Unknown kind of sign-in.', reason: 'failed' });
		}

		// ────────────────────────────────────────────────────────────── signout
		if (pathname === SIGNOUT_PATH) {
			if (method !== 'POST') return notAllowed('POST');
			if (!isSameOrigin(request)) return wantsJson ? json(403, { error: mismatch() ?? 'Sign out from the editor.', reason: 'cross-origin' }) : crossOrigin();
			const location = loginHref({ signedout: '1' });
			return wantsJson ? json(200, { ok: true, location }, auth.clearCookie()) : redirect(location, auth.clearCookie());
		}

		// ──────────────────────────────────────────────────────────── signed-in
		if (pathname === SIGNED_IN_PATH) {
			if (!isRead(method)) return notAllowed('GET, HEAD');
			const who = auth.identify(request.headers.get('cookie'));
			if (who.state !== 'in') return redirect(LOGIN_PATH);
			const shown = who.payload.kind === 'backup' ? 'the backup account' : who.person.email;
			return page(200, 'Signed in', signedInNarrowView({ brand, who: shown, host: url.host }), { script: true, bare: true });
		}

		if (pathname !== LOGIN_PATH) return page(404, 'Not found', messageView('Not found', 'There is no page at this address.'));

		// ──────────────────────────────────────────────────────────────── login
		const showBackup = query.get('backup') === '1' && auth.backup.enabled;
		if (isRead(method)) {
			const next = cleanNext(query.get('next'));
			const notice = addressNotice(request, auth.siteOrigin);
			if (showBackup) return page(200, 'Backup account', backupView({ next, notice }), { script: true });
			return page(200, 'Sign in', emailView({ next, signedOut: query.get('signedout') === '1', backupEnabled: auth.backup.enabled, notice }));
		}
		if (method !== 'POST') return notAllowed('GET, HEAD, POST');
		if (!isSameOrigin(request)) return crossOrigin();
		if (showBackup) return page(200, 'Backup account', backupView({ next: cleanNext(query.get('next')) }), { script: true });

		let form: URLSearchParams;
		try {
			form = new URLSearchParams(await readBody(request));
		} catch {
			return page(400, 'Sign in', emailView({ next: DEFAULT_NEXT, invalid: 'Enter your email address.', backupEnabled: auth.backup.enabled }));
		}
		const next = cleanNext(form.get('next'));
		const typed = (form.get('email') ?? '').trim().slice(0, 320);
		const email = normaliseEmail(typed);
		if (!email) {
			const invalid = typed ? 'Enter a full email address.' : 'Enter your email address.';
			return page(400, 'Sign in', emailView({ next, value: typed, invalid, backupEnabled: auth.backup.enabled }));
		}

		// Every address counts against the limits, allowed or not, so the time taken is the same.
		let over = true;
		try {
			over = await auth.limits.linkRequestOver(email, ip);
		} catch (error) {
			// No counters, no link: fail closed.
			auth.log(`could not check the rate limits, so no link was sent: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (over) auth.log(`link request refused by the rate limit (ip ${ip})`);
		else if (auth.whitelist.allows(email)) void auth.sendLink(email, next, url.origin);
		else auth.log(`no link sent: ${email} isn't on the whitelist`);
		return page(200, 'Check your email', sentView({ email, next, again: form.get('again') === '1', backupEnabled: auth.backup.enabled }));
	} catch (error) {
		auth.log(`sign-in page failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		return page(500, 'Something went wrong', messageView('Something went wrong', "Couldn't finish that. Try again in a moment."));
	}
}

/** Local mode has no sign-in (Decision 1): every sign-in page goes to the editor. */
export function localLoginRedirect(): Response {
	return new Response(null, { status: 303, headers: { Location: DEFAULT_NEXT, 'Cache-Control': 'private, no-store' } });
}
