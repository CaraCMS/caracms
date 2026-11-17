// The gate in front of the Node adapter's handler (M6 Decisions 2, 10, 11).
//
// Plain JavaScript with Node built-ins only: `caracms start` must run on Node 22.12
// with no flags, so nothing here may import the package's TypeScript.
//
// Its order, per request:
//   0. The visitor's IP, from the one source `CARACMS_CLIENT_IP_HEADER` names (or the
//      host's default), set as `x-caracms-client-ip` on every request, replacing any
//      copy the request brought (runs-anywhere spec, Decision 8 and Contracts). The
//      header is trusted only in a process `caracms start` marked (`GATED_MARK`).
//   1. `/robots.txt` is answered here, before the password.
//   2. The pre-launch password (`CARACMS_PRELAUNCH`), except for the editor and its
//      API, `/_astro/…` and `/health`.
//   3. `X-Robots-Tag` on the way out, kept whatever the adapter writes.
//   4. A page beside a folder of the same name (`services/advisory.html` and
//      `services/advisory/`) is asked for by its file: the adapter would look in the
//      folder for an index.html and answer 404.
//   5. Site Settings' redirects, on what would be a 404: a prerendered 404 page never
//      reaches Astro's middleware (redirect-middleware.ts, which serves them in dev).
//   6. The adapter's own handler (static files first, then Astro).

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from './cloudflare-ips.mjs';

/** The header the gate owns. */
const ROBOTS_HEADER = 'X-Robots-Tag';
const NOINDEX = 'noindex';
const NOINDEX_NOFOLLOW = 'noindex, nofollow';

/** Used when Site Settings has no brand name, or none that survives cleaning. */
export const NEUTRAL_REALM_NAME = 'This site';

// ── Paths ───────────────────────────────────────────────────────────────────────

/** The path part of a request target, or null for anything but origin-form (`/…`). */
function rawPathOf(url) {
	if (typeof url !== 'string' || !url.startsWith('/')) return null;
	const end = url.search(/[?#]/);
	return end === -1 ? url : url.slice(0, end);
}

const safeDecode = (s) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return null;
	}
};

/** Resolves `.` and `..` segments on an absolute path, never above the root. */
function resolveDots(path) {
	const out = [];
	const parts = path.split('/');
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		if (part === '.') {
			if (i === parts.length - 1) out.push('');
		} else if (part === '..') {
			out.pop();
			if (i === parts.length - 1) out.push('');
		} else out.push(part);
	}
	return '/' + out.join('/');
}

/**
 * Two views of a path, and the gate only exempts what both agree on:
 * - `app`: what Astro's router and the guard see. The adapter builds the request's
 *   URL from the raw target (WHATWG resolves dot segments, `%2e` ones too), then the
 *   guard decodes, turns backslashes into slashes and collapses repeated slashes.
 * - `full`: decoded first, then slashes collapsed and dot segments resolved, so
 *   `/_astro/..%2Fcontact` is `/contact`.
 * Either is null when the path won't decode (or isn't a path at all).
 */
export function pathViews(url) {
	const raw = rawPathOf(url);
	if (raw === null) return { app: null, full: null };
	let app = null;
	try {
		const decoded = safeDecode(new URL('http://gate.invalid' + raw).pathname);
		if (decoded !== null) app = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	} catch {}
	const decoded = safeDecode(raw);
	const full = decoded === null ? null : resolveDots(decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/'));
	return { app, full };
}

/** The guard's prefix rule (`live/auth/guard.ts` → isGuardedPath) on a normalised path. */
function isGuardedView(view) {
	const path = view.toLowerCase();
	return path === '/admin' || path.startsWith('/admin/') || path.startsWith('/admin.') || path === '/_caracms' || path.startsWith('/_caracms/');
}

/** The editor and its API: a path that won't decode counts, as in the guard. */
export function isGuarded(views) {
	if (views.app === null || views.full === null) return true;
	return isGuardedView(views.app) || isGuardedView(views.full);
}

function isExemptView(view) {
	return isGuardedView(view) || view.startsWith('/_astro/') || view === '/health';
}

/** Reached without the site's password: only when both views agree. */
export function isPasswordExempt(views) {
	if (views.app === null || views.full === null) return false;
	return isExemptView(views.app) && isExemptView(views.full);
}

const isRobotsTxt = (views) => views.full === '/robots.txt';

// ── Settings, read once at start ────────────────────────────────────────────────

/** Strips what can't go in a quoted header value: quotes, backslashes, controls, non-ASCII. */
export function cleanRealmName(name) {
	if (typeof name !== 'string') return '';
	return name
		.replace(/[^\x20-\x7e]/g, '')
		.replace(/["\\]/g, '')
		.replace(/ {2,}/g, ' ')
		.trim();
}

/** The pre-launch value with surrounding whitespace and newlines dropped (as `SITE_URL` is trimmed), or '' when it isn't a string. */
const trimPrelaunch = (value) => (typeof value === 'string' ? value.trim() : '');

/** `user:password`, split at the first colon, after trimming the whole value. Null (the site is public) unless both are there. */
export function parsePrelaunch(raw) {
	const value = trimPrelaunch(raw);
	if (value === '') return null;
	const colon = value.indexOf(':');
	if (colon <= 0 || colon === value.length - 1) return null;
	return { user: value.slice(0, colon) };
}

/**
 * The file the build writes beside the server's entry (`BUILD_INFO_FILE` in the package's
 * src/index, runs-anywhere Decisions 7 and 9): `{ "site": "https://…" | null, "commit": … }`,
 * `site` being Astro's `site` as built. Read by path, since this file imports only built-ins.
 */
export const BUILD_INFO_FILE = 'caracms-build.json';

/**
 * `dist/server/caracms-build.json` under `root`, or null when it's missing, unreadable or
 * not an object (a site built before the file existed): the address chain then starts at
 * `SITE_URL`.
 * @returns {{ site: string | null, commit: string | null } | null}
 */
export function readBuildInfo(root) {
	let info;
	try {
		info = JSON.parse(readFileSync(join(root, 'dist/server', BUILD_INFO_FILE), 'utf8'));
	} catch {
		return null;
	}
	if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
	const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
	return { site: text(info.site), commit: text(info.commit) };
}

/**
 * The site's public address at run time, by Decision 7's whole chain: Astro's `site` as
 * built (from `caracms-build.json`: the config's `site`, else `SITE_URL` at build), then
 * `SITE_URL`, then Railway's `RAILWAY_PUBLIC_DOMAIN`. The same order as `addressFrom()` in
 * the package's src/live/mode, which takes the built `site` through a define instead. A
 * built `site` that isn't an http(s) URL is passed over, as `addressFrom()` does.
 * @param {{ site?: string | null } | null} [built] what `readBuildInfo()` read
 * @returns {{ value: string, from: "Astro's site" | 'SITE_URL' | 'RAILWAY_PUBLIC_DOMAIN' } | null}
 */
export function publicAddress(env = process.env, built = null) {
	const astroSite = typeof built?.site === 'string' ? built.site.trim() : '';
	if (astroSite && parseSiteUrl(astroSite)) return { value: astroSite, from: "Astro's site" };
	const siteUrl = typeof env.SITE_URL === 'string' ? env.SITE_URL.trim() : '';
	if (siteUrl) return { value: siteUrl, from: 'SITE_URL' };
	const railway = typeof env.RAILWAY_PUBLIC_DOMAIN === 'string' ? env.RAILWAY_PUBLIC_DOMAIN.trim() : '';
	if (railway) return { value: `https://${railway}`, from: 'RAILWAY_PUBLIC_DOMAIN' };
	return null;
}

/** Hosts' own addresses, never indexable whatever `SITE_URL` says (Decision 13): the domain itself or any name under it. */
const PLATFORM_DOMAINS = ['localhost', 'up.railway.app', 'onrender.com', 'fly.dev'];

/** True for a hostname a search engine should never index: localhost, a host's platform address, or a bare IP. */
export function isNeverIndexableHostname(hostname) {
	const name = String(hostname).toLowerCase().replace(/\.+$/, '');
	if (name === '' || isIP(name.replace(/^\[|\]$/g, '')) !== 0) return true;
	return PLATFORM_DOMAINS.some((domain) => name === domain || name.endsWith('.' + domain));
}

/** `SITE_URL`'s host and origin, or null when it's unset or not an http(s) URL. */
export function parseSiteUrl(value) {
	if (typeof value !== 'string' || value.trim() === '') return null;
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	const indexable = !isNeverIndexableHostname(url.hostname);
	return { host: url.host.toLowerCase(), origin: url.origin, indexable };
}

// ── Pages beside a folder, and redirects ────────────────────────────────────────

const isFile = (path) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};
const isDirectory = (path) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/**
 * The file to serve for a page whose address is also a folder: with `build.format:
 * 'file'`, `/services/advisory` is `services/advisory.html`, beside a `services/advisory/`
 * folder of the pages under it. The adapter sees the folder, looks for its index.html
 * and answers 404, so the gate asks for the `.html` itself. Null for anything else: a
 * path the two views don't agree on, `/`, a trailing slash, a file extension, a folder
 * with its own index.html, or no such file under `clientDir`.
 */
export function pageBesideFolder(clientDir, views) {
	const path = views.full;
	if (!clientDir || path === null || views.app !== path || path === '/' || path.endsWith('/')) return null;
	if (/\.[^/]*$/.test(path.slice(path.lastIndexOf('/')))) return null;
	const root = resolve(clientDir);
	const folder = resolve(root, '.' + path);
	if (!folder.startsWith(root + sep)) return null;
	if (!isDirectory(folder) || isFile(join(folder, 'index.html')) || !isFile(folder + '.html')) return null;
	return path + '.html';
}

/**
 * Site Settings' redirects, as the package reads them (src/redirects.ts; kept in step by
 * gate.test.ts): `/path` addresses without a trailing slash; an entry that isn't two of
 * them, goes nowhere or repeats a `from` is dropped.
 */
export function redirectAddress(value) {
	if (typeof value !== 'string') return null;
	const v = value.trim();
	if (!/^\/(?!\/)[^\s?#]*$/.test(v)) return null;
	const trimmed = v.replace(/\/+$/, '');
	return trimmed === '' ? '/' : trimmed;
}

export function parseRedirects(raw) {
	if (!Array.isArray(raw)) return [];
	const same = (a, b) => a.toLowerCase() === b.toLowerCase();
	const out = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const from = redirectAddress(entry.from);
		const to = redirectAddress(entry.to);
		if (!from || !to || same(from, to) || out.some((r) => same(r.from, from))) continue;
		out.push({ from, to });
	}
	return out;
}

/** Where a request for `pathname` (as sent) goes, or null: matched decoded, without a trailing slash; letter case counts. */
export function redirectFor(list, pathname) {
	let path = pathname;
	try {
		path = decodeURI(pathname);
	} catch {}
	path = path.replace(/\/+$/, '') || '/';
	return list.find((r) => r.from === path)?.to ?? null;
}

/** `content/site-settings.json` → `redirects` under `root`, read once at start (the file is the build's). Empty when it's missing or unreadable. */
export function readRedirects(root) {
	try {
		return parseRedirects(JSON.parse(readFileSync(join(root, 'content/site-settings.json'), 'utf8'))?.redirects);
	} catch {
		return [];
	}
}

// ── The visitor's IP (Decision 8) ───────────────────────────────────────────────

/** The header the gate sets on every request; `clientIp()` (src/live/auth/request.ts) reads only this in production. */
export const CLIENT_IP_HEADER = 'x-caracms-client-ip';

/**
 * The mark that says this process is behind the gate: `globalThis[Symbol.for('caracms.gated')] === true`.
 * `caracms start` sets it (`markProcessGated()`) before it imports the built site, which
 * runs in this same process, and `clientIp()` (src/live/auth/request.ts, `GATED_MARK`)
 * trusts `x-caracms-client-ip` in production only when it's there. Without it, a server
 * started some other way (`node dist/server/entry.mjs`) has nothing replacing the header,
 * so a visitor could send their own copy and pick their IP for the limits; with the mark
 * off, that server answers 503 instead, whatever the request carries. A request can't set
 * it: it lives in the process, not on the wire.
 */
export const GATED_MARK = Symbol.for('caracms.gated');

/** Marks this process as gated. Only `caracms start` calls it, and only once the adapter's own server is off, so every request reaches the site through the gate. */
export function markProcessGated() {
	globalThis[GATED_MARK] = true;
}

/** The exact fix, printed when no source is known or the one set isn't allowed. `caracms init` and the hosting docs print the same. */
export const CLIENT_IP_FIX =
	'Set CARACMS_CLIENT_IP_HEADER to the header your proxy sets: x-real-ip for nginx with `proxy_set_header X-Real-IP $remote_addr`, x-forwarded-for for Caddy, or socket if nothing sits in front of this server.';

/**
 * Where the IP may come from. `socket`: the connection's own address. `x-forwarded-for`:
 * its last entry, the one the nearest proxy added. Any other: a header the nearest proxy
 * sets and overwrites. (Render documents no such header, so it has none here.)
 */
export const CLIENT_IP_SOURCES = ['socket', 'x-forwarded-for', 'x-real-ip', 'fly-client-ip', 'cf-connecting-ip'];

/**
 * Hosts detected from a variable they set, with their default source.
 * - Railway: its edge overwrites X-Real-IP (relied on since M4).
 * - Fly: its proxy sets Fly-Client-IP (docs.fly.io/networking/request-headers) and
 *   replaces a forged one (checked against debug.fly.dev, 2026-10-24). Its
 *   X-Forwarded-For can't be used: Fly's docs say the last entry is the app's own address.
 * - Render: no overwritten header is documented, so the spec's fallback: X-Forwarded-For's last entry.
 */
export const HOST_DEFAULTS = [
	{ variable: 'RAILWAY_ENVIRONMENT_ID', host: 'Railway', source: 'x-real-ip' },
	{ variable: 'FLY_APP_NAME', host: 'Fly', source: 'fly-client-ip' },
	{ variable: 'RENDER', host: 'Render', source: 'x-forwarded-for' },
];

/**
 * Hosts a platform's own health check sends as `Host`. A health check reaches the server from
 * inside the platform, not through its edge, so it never carries the client-IP header: it
 * still gets its socket's address, but isn't what the "came without" line is about.
 * - Railway: docs.railway.com/deployments/healthchecks#healthcheck-hostname (checked 2026-11-10).
 */
export const HEALTH_CHECK_HOSTS = new Set(['healthcheck.railway.app']);

const isHealthCheck = (req) => typeof req.headers.host === 'string' && HEALTH_CHECK_HOSTS.has(req.headers.host.toLowerCase());

const isSet = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Reads `CARACMS_CLIENT_IP_HEADER`, or the detected host's default. A set value always
 * wins. `problem` is the sentence `caracms start` exits with.
 * @returns {{ source: string, from: string, problem: null } | { source: null, from: null, problem: string }}
 */
export function readClientIpSource(env = process.env) {
	const raw = env.CARACMS_CLIENT_IP_HEADER;
	if (raw !== undefined && raw.trim() !== '') {
		const source = raw.trim().toLowerCase();
		if (!CLIENT_IP_SOURCES.includes(source)) {
			return { source: null, from: null, problem: `CARACMS_CLIENT_IP_HEADER is "${raw.trim()}", which isn't one caracms can use. ${CLIENT_IP_FIX}` };
		}
		return { source, from: 'CARACMS_CLIENT_IP_HEADER', problem: null };
	}
	const detected = HOST_DEFAULTS.find((h) => isSet(env[h.variable]));
	if (detected) return { source: detected.source, from: `${detected.host}'s default, from ${detected.variable}`, problem: null };
	return { source: null, from: null, problem: `no host was detected, so caracms can't tell where a visitor's IP comes from. ${CLIENT_IP_FIX}` };
}

/** The line `caracms start` prints. */
export function describeClientIpSource({ source, from }) {
	const where = source === 'socket' ? 'the socket' : source === 'x-forwarded-for' ? "X-Forwarded-For's last entry" : headerName(source);
	return source === 'cf-connecting-ip' ? `${where} (${from})` : `${where} (${from}); CF-Connecting-IP when that address is Cloudflare's, on the site's own domain`;
}

const headerName = (lower) => lower.replace(/(^|-)([a-z])/g, (_, dash, c) => dash + c.toUpperCase()).replace(/\bIp\b/, 'IP').replace(/^Cf-/, 'CF-');

/** An address in canonical form (IPv4-mapped IPv6 as IPv4, IPv6 lowercased), or null when it isn't one. Brackets and an IPv4 port are dropped. */
export function normaliseIp(value) {
	if (typeof value !== 'string') return null;
	let text = value.trim();
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
	if (bracketed) text = bracketed[1];
	else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(':'));
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
	if (mapped) text = mapped[1];
	const kind = isIP(text);
	if (kind === 4) return text;
	if (kind === 6) return text.toLowerCase();
	return null;
}

function ipv4ToInt(ip) {
	return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function ipv6ToBigInt(ip) {
	let text = ip;
	// A trailing dotted quad (`::1.2.3.4`) as two groups.
	const quad = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
	if (quad) {
		const n = ipv4ToInt(quad[1]);
		text = text.slice(0, -quad[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
	}
	const [head, tail] = text.split('::');
	const headParts = head ? head.split(':') : [];
	const tailParts = tail === undefined ? [] : tail ? tail.split(':') : [];
	const groups = tail === undefined ? headParts : [...headParts, ...Array(8 - headParts.length - tailParts.length).fill('0'), ...tailParts];
	return groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g, 16)), 0n);
}

const V4_RANGES = CLOUDFLARE_IPV4.map((cidr) => {
	const [base, bits] = cidr.split('/');
	const size = 2 ** (32 - Number(bits));
	const start = Math.floor(ipv4ToInt(base) / size) * size;
	return [start, start + size];
});
const V6_RANGES = CLOUDFLARE_IPV6.map((cidr) => {
	const [base, bits] = cidr.split('/');
	const shift = BigInt(128 - Number(bits));
	return [ipv6ToBigInt(base) >> shift, shift];
});

/** True when a normalised address is in Cloudflare's published ranges (cloudflare-ips.mjs). */
export function isCloudflareIp(ip) {
	const kind = isIP(ip);
	if (kind === 4) {
		const n = ipv4ToInt(ip);
		return V4_RANGES.some(([start, end]) => n >= start && n < end);
	}
	if (kind === 6) {
		const n = ipv6ToBigInt(ip);
		return V6_RANGES.some(([prefix, shift]) => n >> shift === prefix);
	}
	return false;
}

/** The last comma-separated entry of a header (Node joins repeated lines with ", "), normalised. */
function lastEntry(value) {
	if (Array.isArray(value)) value = value.join(',');
	if (typeof value !== 'string') return null;
	const entries = value.split(',');
	return normaliseIp(entries[entries.length - 1]);
}

/**
 * True when the request's Host is a host's own address (Decision 13's list: localhost,
 * `*.up.railway.app`, `*.onrender.com`, `*.fly.dev`, a bare IP), or missing or unreadable.
 */
export function isPlatformHost(host) {
	if (typeof host !== 'string' || host.trim() === '') return true;
	let hostname;
	try {
		hostname = new URL(`http://${host.trim()}`).hostname;
	} catch {
		return true;
	}
	return isNeverIndexableHostname(hostname);
}

/**
 * The visitor's IP for one request: from `source`; then, when that address is
 * Cloudflare's and the request's Host isn't a host's own address, from CF-Connecting-IP
 * (kept as the Cloudflare address if that's missing or not an address). `missing` is
 * true when the source header was missing or held no address, so the socket's address
 * was used instead.
 *
 * Why the Host matters: a Cloudflare Worker's fetch to an origin outside Cloudflare
 * leaves from Cloudflare's ranges and may set CF-Connecting-IP to anything
 * (developers.cloudflare.com/fundamentals/reference/http-headers/). So anyone's Worker
 * calling `x.up.railway.app` or `x.fly.dev` directly arrives with a Cloudflare address in
 * the host's header and a CF-Connecting-IP of its choosing. A site behind Cloudflare's
 * proxy is reached at its own domain, where the request passes through the site's zone
 * and Cloudflare sets CF-Connecting-IP itself, a Worker's fetch included. On a host's own
 * address the Cloudflare address is kept: those requests share one bucket, which is
 * what a Worker hammering it deserves.
 * @param {{ headers: Record<string, string | string[] | undefined>, socket?: { remoteAddress?: string } }} req
 */
export function resolveClientIp(req, source) {
	const socketIp = normaliseIp(req.socket?.remoteAddress) ?? 'unknown';
	let ip = source === 'socket' ? socketIp : lastEntry(req.headers[source]);
	const missing = ip === null;
	if (missing) ip = socketIp;
	if (source !== 'cf-connecting-ip' && isCloudflareIp(ip) && !isPlatformHost(req.headers.host)) {
		const viaCloudflare = lastEntry(req.headers['cf-connecting-ip']);
		if (viaCloudflare) ip = viaCloudflare;
	}
	return { ip, missing };
}

/** Puts the IP on the request as the only `x-caracms-client-ip`, in `headers` and `rawHeaders` alike. */
function setClientIp(req, ip) {
	req.headers[CLIENT_IP_HEADER] = ip;
	const raw = req.rawHeaders;
	if (Array.isArray(raw)) {
		const kept = [];
		for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() !== CLIENT_IP_HEADER) kept.push(raw[i], raw[i + 1]);
		kept.push(CLIENT_IP_HEADER, ip);
		raw.splice(0, raw.length, ...kept);
	}
}

const sha256 = (buf) => createHash('sha256').update(buf).digest();

/**
 * The gate, as `(req, res) => void` around the adapter's `handler`.
 * @param {{ handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => unknown,
 *   clientIpSource: string, siteUrl?: string, prelaunch?: string, brandName?: string,
 *   clientDir?: string, redirects?: { from: string, to: string }[], log?: (line: string) => void }} options
 */
export function createGate({ handler, clientIpSource, siteUrl, prelaunch, brandName, clientDir, redirects = [], log = (line) => console.error(line) }) {
	if (!CLIENT_IP_SOURCES.includes(clientIpSource)) throw new Error(`createGate: clientIpSource must be one of ${CLIENT_IP_SOURCES.join(', ')}.`);
	let warnedMissing = false;
	const site = parseSiteUrl(siteUrl);
	const password = parsePrelaunch(prelaunch) ? sha256(Buffer.from(trimPrelaunch(prelaunch), 'utf8')) : null;
	const realm = `${cleanRealmName(brandName) || NEUTRAL_REALM_NAME} (not launched yet)`;

	const robotsIndexable = site ? `User-agent: *\nDisallow: /admin\nDisallow: /_caracms/\nSitemap: ${site.origin}/sitemap.xml\n` : '';
	const robotsClosed = 'User-agent: *\nDisallow: /\n';

	const isIndexableHost = (req) => {
		if (!site || !site.indexable) return false;
		const host = req.headers.host;
		return typeof host === 'string' && host.toLowerCase() === site.host;
	};

	const hasPassword = (req) => {
		const header = req.headers.authorization;
		if (typeof header !== 'string') return false;
		const match = /^\s*basic\s+(\S+)\s*$/i.exec(header);
		if (!match) return false;
		// Hashing both sides first gives equal lengths, so the comparison is constant-time
		// whatever was sent.
		return timingSafeEqual(sha256(Buffer.from(match[1], 'base64')), password);
	};

	const gate = (req, res) => {
		// 0. The visitor's IP, before anything can answer.
		const { ip, missing } = resolveClientIp(req, clientIpSource);
		setClientIp(req, ip);
		if (missing && !warnedMissing && !isHealthCheck(req)) {
			warnedMissing = true;
			log(`caracms start: a request came without ${headerName(clientIpSource)}, so its socket's address was used. If every request says so, CARACMS_CLIENT_IP_HEADER doesn't match the proxy in front. (Said once.)`);
		}

		const views = pathViews(req.url);
		const indexable = isIndexableHost(req);

		// 1. robots.txt, before the password.
		if (isRobotsTxt(views)) {
			const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' };
			if (!indexable) headers[ROBOTS_HEADER] = NOINDEX;
			if (req.method !== 'GET' && req.method !== 'HEAD') {
				res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
				res.end();
				return;
			}
			const body = indexable ? robotsIndexable : robotsClosed;
			res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(body) });
			res.end(req.method === 'HEAD' ? undefined : body);
			return;
		}

		const guarded = isGuarded(views);

		// 2. The password.
		if (password && !isPasswordExempt(views) && !hasPassword(req)) {
			const body = "This site isn't launched yet.\n";
			res.writeHead(401, {
				'WWW-Authenticate': `Basic realm="${realm}"`,
				[ROBOTS_HEADER]: guarded ? NOINDEX_NOFOLLOW : NOINDEX,
				'Content-Type': 'text/plain; charset=utf-8',
				'Content-Length': Buffer.byteLength(body),
				'Cache-Control': 'no-store',
			});
			res.end(req.method === 'HEAD' ? undefined : body);
			return;
		}

		// 3. The header, kept on whatever the adapter writes.
		const robots = guarded ? NOINDEX_NOFOLLOW : indexable ? null : NOINDEX;
		if (robots) holdHeader(res, ROBOTS_HEADER, robots);

		if (req.method === 'GET' || req.method === 'HEAD') {
			// 4. A page beside a folder of the same name, by its file.
			// (As sent, plus `.html`: the views are decoded, the request target mustn't be.)
			const file = guarded ? null : pageBesideFolder(clientDir, views);
			const raw = rawPathOf(req.url);
			if (file && raw !== null) {
				req.url = raw + '.html' + req.url.slice(raw.length);
			} else if (!guarded && redirects.length) {
				// 5. A redirect, only where the site answers 404: a real page always wins.
				const to = raw === null ? null : redirectFor(redirects, raw);
				if (to) {
					const query = req.url.indexOf('?');
					redirectOn404(res, to + (query === -1 ? '' : req.url.slice(query)));
				}
			}
		}

		// 6. The adapter.
		try {
			const result = handler(req, res);
			if (result && typeof result.catch === 'function') result.catch((err) => fail(res, err));
		} catch (err) {
			fail(res, err);
		}
	};
	return gate;
}

/**
 * Turns the response into a 301 to `location` if the handler answers 404, however it
 * writes it (`writeHead`, or a status and an implicit head on the first write or end).
 * The 404's own headers and body are dropped; the held robots header stays.
 */
function redirectOn404(res, location) {
	const writeHead = res.writeHead.bind(res);
	const write = res.write.bind(res);
	const end = res.end.bind(res);
	let redirected = false;
	const redirect = () => {
		redirected = true;
		for (const name of res.getHeaderNames()) res.removeHeader(name);
		writeHead(301, { Location: location, 'Cache-Control': 'no-cache', 'Content-Length': 0 });
		end();
	};
	const callback = (args) => {
		const cb = args.find((a) => typeof a === 'function');
		if (cb) queueMicrotask(cb);
	};
	const is404 = () => !res.headersSent && res.statusCode === 404;
	res.writeHead = (status, ...rest) => {
		if (redirected) return res;
		if (status === 404 && !res.headersSent) {
			redirect();
			return res;
		}
		return writeHead(status, ...rest);
	};
	res.write = (...args) => {
		if (!redirected && is404()) redirect();
		if (redirected) {
			callback(args);
			return true;
		}
		return write(...args);
	};
	res.end = (...args) => {
		if (!redirected && is404()) redirect();
		if (redirected) {
			callback(args);
			return res;
		}
		return end(...args);
	};
}

function fail(res, err) {
	console.error('caracms start: the request failed:', err);
	if (!res.headersSent) {
		res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Internal server error');
	} else res.destroy();
}

/**
 * Sets a header and keeps it: whatever the handler sets, appends, removes or passes
 * to `writeHead` under that name is replaced by this value.
 */
function holdHeader(res, name, value) {
	const lower = name.toLowerCase();
	const isIt = (key) => typeof key === 'string' && key.toLowerCase() === lower;
	const setHeader = res.setHeader.bind(res);
	setHeader(name, value);

	res.setHeader = (key, v) => (isIt(key) ? setHeader(name, value) : setHeader(key, v));
	if (typeof res.appendHeader === 'function') {
		const appendHeader = res.appendHeader.bind(res);
		res.appendHeader = (key, v) => (isIt(key) ? setHeader(name, value) : appendHeader(key, v));
	}
	const removeHeader = res.removeHeader.bind(res);
	res.removeHeader = (key) => (isIt(key) ? undefined : removeHeader(key));

	const writeHead = res.writeHead.bind(res);
	res.writeHead = (status, ...rest) => {
		const i = rest.findIndex((a) => a !== undefined && typeof a !== 'string');
		if (i !== -1) rest[i] = withHeader(rest[i], name, value, isIt);
		if (!res.headersSent) setHeader(name, value);
		return writeHead(status, ...rest);
	};
}

/** A `writeHead` headers argument (object, `[k, v]` pairs or a flat list) with the held value. */
function withHeader(headers, name, value, isIt) {
	if (Array.isArray(headers)) {
		if (headers.length > 0 && Array.isArray(headers[0])) {
			return [...headers.filter(([k]) => !isIt(k)), [name, value]];
		}
		const out = [];
		for (let i = 0; i < headers.length; i += 2) if (!isIt(headers[i])) out.push(headers[i], headers[i + 1]);
		out.push(name, value);
		return out;
	}
	if (headers && typeof headers === 'object') {
		const out = {};
		for (const key of Object.keys(headers)) if (!isIt(key)) out[key] = headers[key];
		out[name] = value;
		return out;
	}
	return headers;
}
