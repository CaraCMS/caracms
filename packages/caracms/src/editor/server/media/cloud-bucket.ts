/**
 * The media bucket on CaraCMS Cloud (caracms-cloud M3 Decision 21), behind bucket.ts's
 * seam, so the upload route (checks, key, dedupe, metadata) and the files route don't
 * change. The site's server never holds R2 credentials: it asks the API (live/cloud.ts,
 * the site key) and the API answers for the site's own folder. Keys stay `uploads/…`:
 * the cloud adds `sites/<folder>/` and strips it again.
 *
 * - `list` and `first`: `GET /v1/media/list`, following its `next` tokens (`list`) or one page (`first`).
 * - `head`: `GET /v1/media/object`; `404 not_found` is "no such object".
 * - `get`: `POST /v1/media/download-url`, then the presigned GET, streamed (the files route).
 * - `put`: `POST /v1/media/upload-url`, then the presigned PUT with exactly the headers it names.
 *
 * **The cloud's refusals are shown as sent** (`CloudRefusal`: `upload_limit`'s sentence,
 * `storage_unavailable`'s); the media handler puts the message in its 502. A cloud that
 * can't be reached, and the storage's own answers to the presigned URLs, are BucketErrors
 * (the handler's own sentences). Presigned URLs go nowhere but the fetch here: never in
 * a log line, an error or an answer to the browser.
 */
import { isCloudRefusal, cloudCall, type CloudConnection } from '../../../live/cloud.ts';
import { BucketError, type Bucket, type BucketObject, type ObjectMeta } from './bucket.ts';

const STORAGE_TIMEOUT_MS = 20_000;
/** A runaway-token guard, as s3Bucket's: 1000 pages of 1000 is far past one site's library. */
const MAX_PAGES = 1000;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

export function cloudBucket(connection: Pick<CloudConnection, 'key' | 'url'>, fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)): Bucket {
	const conn: CloudConnection = { ...connection, fetch: fetchImpl };

	/** One API call; a cloud that can't be reached is a BucketError, any other refusal goes up as sent. */
	async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
		try {
			return await cloudCall(conn, method, path, body);
		} catch (error) {
			if (isCloudRefusal(error) && error.error === 'unreachable') throw new BucketError(`${method} ${path.split('?')[0]}: CaraCMS Cloud unreachable`);
			throw error;
		}
	}

	/** A presigned URL's request. The timeout covers the wait for the storage's headers (a `get` streams after). */
	async function storage(what: string, url: string, init: RequestInit): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`no answer in ${STORAGE_TIMEOUT_MS / 1000} s`)), STORAGE_TIMEOUT_MS);
		try {
			return await fetchImpl(url, { ...init, signal: controller.signal });
		} catch (error) {
			throw new BucketError(`${what}: storage unreachable (${error instanceof Error ? error.message : String(error)})`);
		} finally {
			clearTimeout(timer);
		}
	}

	async function page(prefix: string, after: string | null): Promise<{ objects: BucketObject[]; next: string | null }> {
		const query = new URLSearchParams({ prefix });
		if (after) query.set('after', after);
		const answer = await api('GET', `/v1/media/list?${query}`);
		if (!Array.isArray(answer.objects)) throw new BucketError(`list ${prefix}: the answer has no objects`);
		const objects: BucketObject[] = [];
		for (const o of answer.objects as Record<string, unknown>[]) {
			const key = o && typeof o === 'object' ? text(o.key) : null;
			if (!key) continue;
			objects.push({ key, lastModified: iso(o.lastModified), size: typeof o.size === 'number' && Number.isFinite(o.size) ? o.size : null });
		}
		return { objects, next: text(answer.next) };
	}

	return {
		async list(prefix) {
			const out: BucketObject[] = [];
			const seen = new Set<string>();
			let after: string | null = null;
			for (let n = 0; n < MAX_PAGES; n++) {
				const { objects, next } = await page(prefix, after);
				out.push(...objects);
				if (!next || seen.has(next)) break;
				seen.add(next);
				after = next;
			}
			return out;
		},
		async first(prefix) {
			const { objects } = await page(prefix, null);
			return objects[0]?.key ?? null;
		},
		async head(key): Promise<ObjectMeta | null> {
			let answer: Record<string, unknown>;
			try {
				answer = await api('GET', `/v1/media/object?${new URLSearchParams({ key })}`);
			} catch (error) {
				if (isCloudRefusal(error) && error.error === 'not_found') return null;
				throw error;
			}
			return {
				w: num(answer.w),
				h: num(answer.h),
				name: text(answer.name),
				by: text(answer.by),
				contentType: text(answer.contentType),
				lastModified: iso(answer.lastModified),
				size: typeof answer.size === 'number' && Number.isFinite(answer.size) ? answer.size : null,
			};
		},
		async get(key) {
			const { url } = await api('POST', '/v1/media/download-url', { key });
			if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new BucketError(`get ${key}: the answer has no URL`);
			const res = await storage(`get ${key}`, url, { method: 'GET' });
			if (res.status === 404) {
				await res.body?.cancel().catch(() => {});
				return null;
			}
			if (!res.ok || !res.body) {
				await res.body?.cancel().catch(() => {});
				throw new BucketError(`get ${key}: ${res.status}`, res.status);
			}
			const size = Number(res.headers.get('content-length'));
			return { body: res.body, size: res.headers.has('content-length') && Number.isFinite(size) ? size : null };
		},
		async put({ key, body, contentType, sha256, meta }) {
			const answer = await api('POST', '/v1/media/upload-url', {
				key,
				size: body.byteLength,
				contentType,
				sha256,
				meta: { ...(meta.w !== undefined ? { w: meta.w } : {}), ...(meta.h !== undefined ? { h: meta.h } : {}), name: meta.name, by: meta.by },
			});
			const { url, method, headers } = answer;
			if (typeof url !== 'string' || !/^https?:\/\//.test(url) || (method !== undefined && method !== 'PUT') || !headers || typeof headers !== 'object') {
				throw new BucketError(`put ${key}: the upload answer isn't one`);
			}
			// The headers as the cloud named them, verbatim (the URL signs each one). Content-Length and Host
			// are fetch's own to send: the body is exactly the declared size, and the URL's host is the signed one.
			const sent = Object.fromEntries(
				Object.entries(headers as Record<string, unknown>).filter(([name, v]) => typeof v === 'string' && !/^(content-length|host)$/i.test(name)),
			) as Record<string, string>;
			const res = await storage(`put ${key}`, url, { method: 'PUT', headers: sent, body: body as BodyInit });
			await res.body?.cancel().catch(() => {});
			// 412: R2 refused the signed If-None-Match: * because the key is there, and the key carries the bytes' hash: already stored.
			if (!res.ok && res.status !== 412) throw new BucketError(`put ${key}: ${res.status}`, res.status);
		},
	};
}
