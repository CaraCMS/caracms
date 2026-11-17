/**
 * The media bucket (M5b Decision 6), behind one small seam: list, head, get, put. **No
 * delete and no overwrite anywhere** (Spec → Media): `put` is only ever called after the
 * upload route has checked that nothing exists under the key's `uploads/<hash>/`.
 *
 * - **`s3Bucket`**: S3's REST API over `fetch`, signed with **aws4fetch** (a standard,
 *   dependency-free SigV4 signer, ~6 KB). Path-style requests (`<endpoint>/<bucket>/<key>`),
 *   which Railway's endpoint (`https://t3.storageapi.dev`, region `ams`) takes. The
 *   payload hash is signed (the route has the bytes in memory anyway).
 * - **`MemoryBucket`**: the in-memory stand-in behind `CARACMS_MEDIA=memory` (memory.ts).
 *
 * The object metadata's names are fixed (M5b → Resolved decisions, Phase 0's script):
 * `x-amz-meta-w`, `-h`, `-name` (URI-encoded, so any file name fits a header) and `-by`.
 */
import { AwsClient } from 'aws4fetch';
import type { BucketSettings } from './config.ts';

export interface BucketObject {
	key: string;
	/** ISO: S3's LastModified. */
	lastModified: string | null;
	size: number | null;
}

/** An object's metadata, as stored (strings decoded). */
export interface ObjectMeta {
	w: number | null;
	h: number | null;
	/** The original file name, or null. */
	name: string | null;
	/** Who uploaded it, or null (local mode). */
	by: string | null;
	contentType: string | null;
	lastModified: string | null;
	size: number | null;
}

export interface PutObject {
	key: string;
	body: Uint8Array;
	contentType: string;
	/** Hex SHA-256 of `body` (the route has it already). */
	sha256: string;
	/** `w` and `h` are an image's; a file (M6c G4) has neither. */
	meta: { w?: number; h?: number; name: string; by: string | null };
}

/** An object's bytes, streamed (M6c G4: the public file route), and its length when the bucket says. */
export interface ObjectBody {
	body: ReadableStream<Uint8Array>;
	size: number | null;
}

export interface Bucket {
	/** Every object under `prefix`, following S3's continuation tokens. */
	list(prefix: string): Promise<BucketObject[]>;
	/** The first key under `prefix`, or null: the upload's existence check. */
	first(prefix: string): Promise<string | null>;
	/** An object's metadata, or null when there's no such object. */
	head(key: string): Promise<ObjectMeta | null>;
	/**
	 * An object's bytes as a stream, or null when there's no such object. Only the public
	 * file route (files-route.ts) calls it, and only for a key its allow-list passed.
	 */
	get(key: string): Promise<ObjectBody | null>;
	/** Write a new object. Never called for a key that exists. */
	put(object: PutObject): Promise<void>;
}

/** A bucket call that failed: its message is for the server log, never the browser. */
export class BucketError extends Error {
	/** The bucket's HTTP status when it answered with a refusal; null when it couldn't be reached. */
	readonly status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = 'BucketError';
		this.status = status;
	}
}

const metaNumber = (v: string | null | undefined) => {
	const n = Number(v);
	return v && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const decodeName = (v: string | null | undefined) => {
	if (!v) return null;
	try {
		return decodeURIComponent(v);
	} catch {
		return v;
	}
};

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string) =>
	s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
		e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e]!,
	);
const tag = (xml: string, name: string) => {
	const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
	return m ? unxml(m[1]!) : null;
};

const S3_TIMEOUT_MS = 20_000;
/** A runaway-token guard: 1000 pages of 1000 is far past one site's library. */
const MAX_PAGES = 1000;

export function s3Bucket(settings: BucketSettings, fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)): Bucket {
	const client = new AwsClient({ accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, service: 's3', region: settings.region });
	const base = `${settings.endpoint}/${encodeURIComponent(settings.bucket)}`;
	const objectUrl = (key: string) => `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;

	/**
	 * One signed request. The timeout covers the whole exchange, except with `stream`
	 * (`get`'s body, up to 40 MB to a slow visitor), where it covers only the wait for the
	 * bucket's headers.
	 */
	async function call(method: string, url: string, init: { headers?: Record<string, string>; body?: Uint8Array; stream?: boolean } = {}): Promise<Response> {
		const request = await client.sign(url, {
			method,
			headers: { 'X-Amz-Content-Sha256': init.headers?.['X-Amz-Content-Sha256'] ?? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', ...init.headers },
			body: init.body as BodyInit | undefined,
		});
		const controller = init.stream ? new AbortController() : null;
		const timer = controller ? setTimeout(() => controller.abort(new Error(`no answer in ${S3_TIMEOUT_MS / 1000} s`)), S3_TIMEOUT_MS) : null;
		try {
			return await fetchImpl(request, { signal: controller ? controller.signal : AbortSignal.timeout(S3_TIMEOUT_MS) });
		} catch (error) {
			throw new BucketError(`${method} ${new URL(url).pathname}: unreachable (${error instanceof Error ? error.message : String(error)})`);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async function page(prefix: string, token: string | null, max?: number) {
		const query = new URLSearchParams({ 'list-type': '2', prefix });
		if (max) query.set('max-keys', String(max));
		if (token) query.set('continuation-token', token);
		const res = await call('GET', `${base}?${query}`);
		const text = await res.text();
		if (!res.ok) throw new BucketError(`list ${prefix}: ${res.status} ${text.slice(0, 300)}`, res.status);
		const objects: BucketObject[] = [];
		for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
			const key = tag(m[1]!, 'Key');
			if (!key) continue;
			const modified = tag(m[1]!, 'LastModified');
			const size = Number(tag(m[1]!, 'Size'));
			objects.push({ key, lastModified: modified && !Number.isNaN(Date.parse(modified)) ? new Date(modified).toISOString() : null, size: Number.isFinite(size) ? size : null });
		}
		const truncated = tag(text, 'IsTruncated') === 'true';
		return { objects, next: truncated ? tag(text, 'NextContinuationToken') : null };
	}

	return {
		async list(prefix) {
			const out: BucketObject[] = [];
			const seen = new Set<string>();
			let token: string | null = null;
			for (let n = 0; n < MAX_PAGES; n++) {
				const { objects, next } = await page(prefix, token);
				out.push(...objects);
				if (!next || seen.has(next)) break;
				seen.add(next);
				token = next;
			}
			return out;
		},
		async first(prefix) {
			const { objects } = await page(prefix, null, 1);
			return objects[0]?.key ?? null;
		},
		async head(key) {
			const res = await call('HEAD', objectUrl(key));
			if (res.status === 404) return null;
			if (!res.ok) throw new BucketError(`head ${key}: ${res.status}`, res.status);
			const h = res.headers;
			const modified = h.get('last-modified');
			const size = Number(h.get('content-length'));
			return {
				w: metaNumber(h.get('x-amz-meta-w')),
				h: metaNumber(h.get('x-amz-meta-h')),
				name: decodeName(h.get('x-amz-meta-name')),
				by: decodeName(h.get('x-amz-meta-by')),
				contentType: h.get('content-type'),
				lastModified: modified && !Number.isNaN(Date.parse(modified)) ? new Date(modified).toISOString() : null,
				size: Number.isFinite(size) ? size : null,
			};
		},
		async get(key) {
			const res = await call('GET', objectUrl(key), { stream: true });
			if (res.status === 404) {
				await res.body?.cancel().catch(() => {});
				return null;
			}
			if (!res.ok || !res.body) {
				const text = await res.text().catch(() => '');
				throw new BucketError(`get ${key}: ${res.status} ${text.slice(0, 300)}`, res.status);
			}
			const size = Number(res.headers.get('content-length'));
			return { body: res.body, size: res.headers.has('content-length') && Number.isFinite(size) ? size : null };
		},
		async put({ key, body, contentType, sha256, meta }) {
			const headers: Record<string, string> = {
				'Content-Type': contentType,
				'X-Amz-Content-Sha256': sha256,
				...(meta.w !== undefined ? { 'x-amz-meta-w': String(meta.w) } : {}),
				...(meta.h !== undefined ? { 'x-amz-meta-h': String(meta.h) } : {}),
				'x-amz-meta-name': encodeURIComponent(meta.name),
			};
			// An address as it is (Phase 0 wrote `setup` so); anything a header can't carry, URI-encoded as `name` is.
			if (meta.by) headers['x-amz-meta-by'] = /^[\x21-\x7e]+$/.test(meta.by) && !meta.by.includes('%') ? meta.by : encodeURIComponent(meta.by);
			const res = await call('PUT', objectUrl(key), { headers, body });
			if (!res.ok) throw new BucketError(`put ${key}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`, res.status);
			await res.body?.cancel().catch(() => {});
		},
	};
}

// ── The in-memory bucket (CARACMS_MEDIA=memory) ────────────────────────────────

export interface MemoryObject {
	body: Uint8Array | null;
	meta: ObjectMeta;
}

/** A bucket in memory, for tests and local runs. `seed` puts objects in as Phase 0's script or another place would. */
export class MemoryBucket implements Bucket {
	readonly objects = new Map<string, MemoryObject>();
	/** Every call, in order (`list:<prefix>`, `head:<key>`, `get:<key>`, `put:<key>`), for tests that count them. */
	readonly calls: string[] = [];
	now: () => number = () => Date.now();

	async list(prefix: string): Promise<BucketObject[]> {
		this.calls.push(`list:${prefix}`);
		return [...this.objects]
			.filter(([key]) => key.startsWith(prefix))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, o]) => ({ key, lastModified: o.meta.lastModified, size: o.meta.size }));
	}
	async first(prefix: string): Promise<string | null> {
		this.calls.push(`first:${prefix}`);
		return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()[0] ?? null;
	}
	async head(key: string): Promise<ObjectMeta | null> {
		this.calls.push(`head:${key}`);
		const o = this.objects.get(key);
		return o ? { ...o.meta } : null;
	}
	/** A seeded object with no bytes (the library's tests seed most so) answers as missing. */
	async get(key: string): Promise<ObjectBody | null> {
		this.calls.push(`get:${key}`);
		const bytes = this.objects.get(key)?.body;
		if (!bytes) return null;
		const copy = new Uint8Array(bytes);
		return {
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(copy);
					controller.close();
				},
			}),
			size: copy.byteLength,
		};
	}
	async put({ key, body, contentType, meta }: PutObject): Promise<void> {
		this.calls.push(`put:${key}`);
		if (this.objects.has(key)) throw new BucketError(`put ${key}: the key exists, and nothing in caracms overwrites`);
		this.objects.set(key, {
			body: new Uint8Array(body),
			meta: { w: meta.w ?? null, h: meta.h ?? null, name: meta.name, by: meta.by, contentType, lastModified: new Date(this.now()).toISOString(), size: body.byteLength },
		});
	}
	/**
	 * Put an object straight in (a test's or a browser test's library): no bytes needed.
	 * `uploadedAt` (ISO) orders the library; default now.
	 */
	seed(key: string, meta: { w?: number | null; h?: number | null; name?: string | null; by?: string | null; uploadedAt?: string; size?: number; contentType?: string } = {}, body: Uint8Array | null = null): void {
		this.objects.set(key, {
			body,
			meta: {
				w: meta.w ?? null,
				h: meta.h ?? null,
				name: meta.name ?? null,
				by: meta.by ?? null,
				contentType: meta.contentType ?? null,
				lastModified: meta.uploadedAt ?? new Date(this.now()).toISOString(),
				size: meta.size ?? body?.byteLength ?? null,
			},
		});
	}
	clear(): void {
		this.objects.clear();
		this.calls.length = 0;
	}
}
