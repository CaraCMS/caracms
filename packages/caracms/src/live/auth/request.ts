/**
 * Two things read off a request: the client's IP (for rate limits) and whether a write
 * came from this site.
 */

const first = (value: string | null) => (value ?? '').split(',')[0]!.trim();

/**
 * The header `caracms start`'s gate sets on every request, replacing any copy the request
 * brought (runs-anywhere Decision 8, the spec's Contracts): the visitor's IP, decided from
 * the one source `CARACMS_CLIENT_IP_HEADER` names.
 */
export const CLIENT_IP_HEADER = 'x-caracms-client-ip';

/**
 * The mark `caracms start` puts on its own process before importing the built site, which
 * runs in that same process (`bin/gate.mjs` → `GATED_MARK`, `markProcessGated()`):
 * `globalThis[Symbol.for('caracms.gated')] === true`. It's what makes the header above
 * trustworthy: with the mark there, every request reached the site through the gate, which
 * replaced any copy the visitor sent. Without it (`node dist/server/entry.mjs`), nothing
 * replaced it, so the header is the visitor's to choose and is never read.
 */
export const GATED_MARK = Symbol.for('caracms.gated');

/** Whether this process was started by `caracms start` (the mark above). */
export const isGatedProcess = (): boolean => (globalThis as Record<symbol, unknown>)[GATED_MARK] === true;

/** The 503 on sign-in, forms and downloads of a production server with no gate (Decision 8; acceptance check 17). */
export const NO_GATE_MESSAGE =
	"This site wasn't started with `caracms start`, so it can't tell its visitors apart for the limits on signing in, forms and downloads. A developer can start it with `caracms start` (the site's start script).";

/**
 * The client's IP, which keys the per-IP rate limits (sign-in, forms, downloads).
 *
 * **In production, only `x-caracms-client-ip`**, which `caracms start`'s gate sets on
 * every request from the one trusted source, and only in a process the gate marked
 * (`GATED_MARK`). Null when the mark is missing, whatever the request carries: the server
 * wasn't started by `caracms start`, so a header there is one the visitor sent. Null too
 * when the header is absent. Either way the caller answers 503 with `NO_GATE_MESSAGE`.
 * Nothing else on the request is trusted there: Astro's Node adapter reports the first
 * `X-Forwarded-For` entry as `clientAddress` whenever the Host is trusted, which caracms
 * always arranges for its own domain, so the adapter's address is the visitor's to choose
 * (`node_modules/astro/dist/core/app/node.js`), and `X-Real-IP` is trustworthy only behind
 * a proxy that overwrites it.
 *
 * **Under `astro dev`** (no gate, and nothing to protect), as before: `X-Real-IP`, then
 * the socket's address as the adapter gives it, then the first `X-Forwarded-For` hop.
 * A spoofed one only rate-limits the spoofer's own requests.
 */
export function clientIp(request: Request, clientAddress: () => string | undefined, production = false): string | null {
	if (production) {
		if (!isGatedProcess()) return null;
		const gated = request.headers.get(CLIENT_IP_HEADER)?.trim();
		return gated ? gated.slice(0, 64) : null;
	}
	const real = first(request.headers.get('x-real-ip'));
	if (real) return real.slice(0, 64);
	let socket: string | undefined;
	try {
		socket = clientAddress();
	} catch {
		/* not available here */
	}
	if (socket) return socket.slice(0, 64);
	return first(request.headers.get('x-forwarded-for')).slice(0, 64) || 'unknown';
}

/**
 * Whether a write (any non-GET/HEAD) came from this site: **an `Origin` whose host is
 * the request's own host**, and no `Sec-Fetch-Site` saying otherwise. A missing
 * `Origin`, or the opaque `null` (a sandboxed frame, `Referrer-Policy: no-referrer`
 * form posts), is refused: every current browser sends `Origin` on a POST.
 *
 * Host only, not the scheme, as M3's write route does: behind Railway's edge the
 * server itself sees plain http while the page is https.
 */
export function isSameOrigin(request: Request): boolean {
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite && fetchSite !== 'same-origin') return false;
	const origin = request.headers.get('origin');
	if (!origin || origin === 'null') return false;
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		return false;
	}
}

/**
 * Runs-anywhere Decision 7: the sentence for a site reached at an address that isn't its
 * own, naming SITE_URL. The likeliest setup mistake: SITE_URL at www while people use the
 * apex (or the other way round), or set differently at build and at run time.
 */
export function addressMismatchMessage(reached: string, address: string | null): string {
	return address
		? `This site's address is set to ${address} (SITE_URL), but it was opened at ${reached}, so signing in and saving are refused here. Open it at ${address}, or set SITE_URL to ${reached} where the site is built and where it runs.`
		: `This site's address isn't set, so signing in and saving are refused. Set SITE_URL to ${reached} where the site is built and where it runs.`;
}

/** The address the visitor typed (the proxy's forwarded host, else Host), when it isn't the one Astro read the request as. */
export function reachedElsewhere(request: Request): string | null {
	const host = first(request.headers.get('x-forwarded-host')) || first(request.headers.get('host'));
	if (!host) return null;
	const url = new URL(request.url);
	if (host === url.host) return null;
	const proto = first(request.headers.get('x-forwarded-proto')) || url.protocol.replace(':', '');
	return `${proto}://${host}`;
}

/**
 * For a write refused by `isSameOrigin`: the mismatch sentence when the browser was on
 * this site all along (it says `Sec-Fetch-Site: same-origin`, or its `Origin` is the
 * request's own Host) but Astro, trusting only the site's address, read the request as
 * another host. Null for a real cross-site request.
 */
export function addressMismatch(request: Request, address: string | null): string | null {
	let origin: URL;
	try {
		origin = new URL(request.headers.get('origin') ?? '');
	} catch {
		return null;
	}
	if (origin.host === new URL(request.url).host) return null;
	const fetchSite = request.headers.get('sec-fetch-site');
	const host = first(request.headers.get('x-forwarded-host')) || first(request.headers.get('host'));
	if (fetchSite !== 'same-origin' && !(!fetchSite && origin.host === host)) return null;
	return addressMismatchMessage(origin.origin, address);
}

/** On a page with no `Origin` (the sign-in form's GET): the sentence when the site is opened at an address that isn't its own. */
export function addressNotice(request: Request, address: string | null): string | null {
	const reached = reachedElsewhere(request);
	if (!reached || (address && new URL(address).host === new URL(reached).host)) return null;
	return addressMismatchMessage(reached, address);
}

export const isRead = (method: string) => method === 'GET' || method === 'HEAD';
