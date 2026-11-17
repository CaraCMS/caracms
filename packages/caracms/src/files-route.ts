/**
 * `GET`/`HEAD /files/<hash>/<name>.<ext>` (M6c Decision 6): the library's files, streamed
 * from the bucket (never through imgproxy), on every site, in every mode. Injected by the
 * integration as `/files/[...path]`, so everything under `/files` reaches this module and
 * ends at its own answers, whatever Astro's router makes of the path.
 *
 * **It must never become a way to read the bucket** (the spec's Watch-outs). In order:
 *
 * 1. Not `GET`/`HEAD`: `405`.
 * 2. **The path, an allow-list.** The request's own pathname (as the adapter built the
 *    URL, still percent-encoded) must be exactly a file link's: `fileKeyOf` (files.ts)
 *    splits it into two segments, checks the hash raw (`[0-9a-f]{12}`), decodes the name
 *    once, and `isFileKey` takes only `uploads/<hash>/<name>.<ext>` with `<ext>` in the
 *    file-type table and no slash, backslash or control character in the name. So `..`,
 *    `.`, `//`, a trailing `/`, `%2f`, `%5c`, a malformed escape, an image's or a
 *    submission's key and an extension not in the table all fail here: the short `404`
 *    (`no-store`), before anything else is asked.
 * 3. **The query**: none, or exactly `download`. Anything else (`?x=1`, a bare `?`,
 *    `?download&x=1`) is a `301` to the clean address, keeping `?download` when it was
 *    there, cached a day (`public, max-age=86400`) so the CDN keeps the redirect.
 * 4. No media variables: `503`, a neutral sentence; the missing names go to the log only.
 * 5. **The rate limit**, its own instance (`caracms:files:rl:`, 30 per 10 minutes per
 *    visitor, Redis at `REDIS_URL`, failing open): `429` with `Retry-After` the window.
 * 6. The bucket's `get` for that one key: missing (or a memory object with no bytes) is
 *    the same `404`. Otherwise the bytes, with `Content-Type` from the table, `nosniff`,
 *    `inline` for a PDF without `?download` and `attachment` with the key's name for the
 *    rest, and a year's immutable cache (an address never changes content), or
 *    `private, max-age=86400` while the pre-launch password is on (the gate reads
 *    `CARACMS_PRELAUNCH` in this same process), so a shared cache never keeps it.
 */
import type { APIRoute } from 'astro';
import { clientIp, NO_GATE_MESSAGE } from './live/auth/request.ts';
import { fileAddress, fileKeyOf, fileTypeOf } from './files.ts';
import { s3Bucket, type Bucket } from './editor/server/media/bucket.ts';
import { cloudBucket } from './editor/server/media/cloud-bucket.ts';
import { readImagesConfig } from './editor/server/media/config.ts';
import { memoryMedia } from './editor/server/media/memory.ts';
import { isProductionBuild } from './media.ts';
import { processLimiter, resetProcessLimiter, type LimitSettings, type RateLimiter } from './forms/rate-limit.ts';

export const prerender = false;

/** The route's own limiter: 30 downloads per visitor per 10 minutes (Decision 6). */
export const FILES_LIMIT: LimitSettings = { prefix: 'caracms:files:rl:', max: 30, windowMs: 10 * 60 * 1000, area: 'files', hitName: 'download' };
const FILES_LIMITER = 'caracms.filesLimiter';

/** The process's download limiter (Redis at `REDIS_URL`, else memory). */
export function filesLimiter(env: Record<string, string | undefined> = process.env): RateLimiter {
	return processLimiter(FILES_LIMITER, FILES_LIMIT, env);
}

/** Forget it (tests). */
export function resetFilesLimiter(): void {
	resetProcessLimiter(FILES_LIMITER);
}

export const NOT_FOUND_TEXT = 'Not found.\n';
export const UNAVAILABLE_TEXT = "Downloads aren't available right now.\n";
export const RATE_LIMITED_TEXT = 'Too many downloads from here. Try again in a few minutes.\n';

export const CACHE_YEAR = 'public, max-age=31536000, immutable';
export const CACHE_PRELAUNCH = 'private, max-age=86400';
export const CACHE_REDIRECT = 'public, max-age=86400';

type Env = Record<string, string | undefined>;

export interface FileRouteContext {
	/** Default `process.env`, read on each request. */
	env?: Env;
	production?: boolean;
	/** The socket's address (Astro's `clientAddress`), read after `X-Real-IP` under `astro dev`. */
	clientAddress?: () => string | undefined;
	/** Default the process's own (`filesLimiter`). */
	limiter?: RateLimiter;
	/** The S3 bucket's `fetch` (tests). */
	fetch?: typeof fetch;
	/** Server log lines (the 503's missing variables, a bucket failure). */
	log?: (line: string) => void;
}

const text = (status: number, body: string, headers: Record<string, string> = {}, head = false) =>
	new Response(head ? null : body, {
		status,
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers },
	});

/** The query as sent: null for none, `''` for a bare `?`. A fragment never reaches a server, but is dropped if it does. */
function rawQuery(url: string): string | null {
	const q = url.indexOf('?');
	if (q === -1) return null;
	const hash = url.indexOf('#', q);
	return url.slice(q + 1, hash === -1 ? undefined : hash);
}

/** The request's pathname, still percent-encoded (not Astro's decoded view). */
function rawPathname(url: string): string | null {
	try {
		return new URL(url).pathname;
	} catch {
		return null;
	}
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
/** RFC 5987's `attr-char` escapes: encodeURIComponent leaves `'()*` and `!` alone, which `filename*` can't carry raw (`'`, and the rest by caution). */
const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * `attachment; filename="<name>"`. The key's name is a slug, so header-safe as it is;
 * anything a quoted string can't carry (non-ASCII, `"`, `\`) is `_` there, and the
 * real name goes in `filename*` too.
 */
export function attachmentDisposition(name: string): string {
	if (PRINTABLE_ASCII.test(name) && !/["\\]/.test(name)) return `attachment; filename="${name}"`;
	const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(name)}`;
}

const prelaunchOn = (env: Env) => typeof env['CARACMS_PRELAUNCH'] === 'string' && env['CARACMS_PRELAUNCH'].trim() !== '';

const logged = new Set<string>();
const logOnce = (log: (line: string) => void, line: string) => {
	if (logged.has(line)) return;
	logged.add(line);
	log(line);
};

/** The handler, Astro-free so tests call it with a plain `Request`. */
export async function handleFileRequest(request: Request, ctx: FileRouteContext = {}): Promise<Response> {
	const method = request.method.toUpperCase();
	const head = method === 'HEAD';
	if (method !== 'GET' && !head) return text(405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });

	// 2. The path: exactly a file key's shape, or the 404, before anything else is asked.
	const path = rawPathname(request.url);
	const file = path === null ? null : fileKeyOf(path);
	const type = file ? fileTypeOf(file.key) : null;
	if (!file || !type) return text(404, NOT_FOUND_TEXT, {}, head);

	// 3. The query: none, or exactly `download`.
	const query = rawQuery(request.url);
	let download = false;
	if (query !== null) {
		const parts = query.split('&');
		download = parts.some((p) => p.split('=')[0] === 'download');
		if (query !== 'download') {
			return new Response(null, { status: 301, headers: { Location: fileAddress(file.key, { download }), 'Cache-Control': CACHE_REDIRECT } });
		}
	}

	// Runs-anywhere Decision 8: a production server not started by `caracms start` has no gate, so no visitor's IP for the limit.
	const production = ctx.production ?? isProductionBuild();
	const ip = clientIp(request, ctx.clientAddress ?? (() => undefined), production);
	if (ip === null) return text(503, NO_GATE_MESSAGE, {}, head);

	// 4. The media variables.
	const env = ctx.env ?? process.env;
	const log = ctx.log ?? ((line: string) => console.error(line));
	const config = readImagesConfig(env, production);
	if (config.kind === 'unset') {
		logOnce(log, `[caracms] files: /files/ answers 503: ${config.message}${config.missing.length ? ` (missing: ${config.missing.join(', ')})` : ''}`);
		return text(503, UNAVAILABLE_TEXT, {}, head);
	}

	// 5. The visitor's allowance.
	const limiter = ctx.limiter ?? filesLimiter(env);
	if (await limiter.hit(ip)) {
		return text(429, RATE_LIMITED_TEXT, { 'Retry-After': String(Math.ceil(FILES_LIMIT.windowMs / 1000)) }, head);
	}

	// 6. The one key the allow-list passed.
	const bucket: Bucket = config.kind === 'memory' ? memoryMedia().bucket : config.kind === 'cloud' ? cloudBucket(config.connection, ctx.fetch) : s3Bucket(config.bucket, ctx.fetch);
	let object;
	try {
		object = await bucket.get(file.key);
	} catch (error) {
		log(`[caracms] files: couldn't read ${file.key} from the bucket: ${error instanceof Error ? error.message : String(error)}`);
		return text(503, UNAVAILABLE_TEXT, {}, head);
	}
	if (!object) return text(404, NOT_FOUND_TEXT, {}, head);

	const name = file.key.slice(file.key.lastIndexOf('/') + 1);
	const headers: Record<string, string> = {
		'Content-Type': type.contentType,
		'X-Content-Type-Options': 'nosniff',
		'Content-Disposition': type.opensInTab && !download ? 'inline' : attachmentDisposition(name),
		'Cache-Control': prelaunchOn(env) ? CACHE_PRELAUNCH : CACHE_YEAR,
	};
	if (object.size !== null) headers['Content-Length'] = String(object.size);
	if (head) {
		await object.body.cancel().catch(() => {});
		return new Response(null, { status: 200, headers });
	}
	return new Response(object.body, { status: 200, headers });
}

export const ALL: APIRoute = (context) =>
	handleFileRequest(context.request, {
		// Astro's getter throws where the adapter gives no address (tests' containers).
		clientAddress: () => {
			try {
				return context.clientAddress;
			} catch {
				return undefined;
			}
		},
	});
