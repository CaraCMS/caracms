/**
 * `CARACMS_MEDIA=memory` (M5b Decision 5): an in-memory bucket and a fake Mux, one of
 * each per process, so a test (or a browser test, whose dev server runs in the test's
 * process) can seed them and look at what the routes did. **Refused on a production
 * server** (config.ts), and **it always wins**: with it set, nothing touches the real
 * bucket or Mux, whatever else is set.
 *
 *   const media = memoryMedia();
 *   media.bucket.seed('uploads/3f9a1c07b2e4/harbour-wall.jpg', { w: 4000, h: 2667, name: 'Harbour wall.jpg', uploadedAt: '2026-10-16T09:00:00Z' });
 *   media.mux.seedClip({ playbackId: 'abc', title: 'Kiln', mp4: 'ready' });           // placeable
 *   media.mux.seedClip({ playbackId: 'def', mp4: 'preparing' });                       // processing
 *   media.mux.seedClip({ status: 'errored', error: { type: 'invalid_input', messages: ['no video track'] } });
 *   media.reset();                                                                     // empty again, caches dropped
 *
 * The fake Mux is a `fetch` that answers Mux's API (`/video/v1/uploads`, `/assets`,
 * `/playback-ids`), paging the list with `next_cursor`, so the real client (mux.ts) runs
 * against it. A direct upload's `url` is `https://mux.test/upload/<id>`: a browser test
 * routes that PUT itself, then calls `receive(id)` (the file arrived: an asset, preparing)
 * and `ready(assetId)` (the asset and its MP4 are ready).
 */
import { MemoryBucket } from './bucket.ts';
import { MUX_API } from './mux.ts';

type Json = any;

export interface SeedClip {
	id?: string;
	playbackId?: string | null;
	/** Mux's asset status. Default `ready`. */
	status?: 'preparing' | 'ready' | 'errored';
	/** The `highest` MP4's status; `none` for an asset with no static rendition. Default `ready`. */
	mp4?: 'ready' | 'preparing' | 'errored' | 'skipped' | 'none';
	title?: string | null;
	duration?: number;
	w?: number;
	h?: number;
	/** ISO. Default now. */
	createdAt?: string;
	error?: { type?: string; messages?: string[] };
}

let counter = 0;
const id = (prefix: string) => `${prefix}${(++counter).toString(36).padStart(6, '0')}${Math.random().toString(36).slice(2, 10)}`.replace(/[^A-Za-z0-9]/g, '');

export class MemoryMux {
	readonly assets = new Map<string, Json>();
	readonly uploads = new Map<string, Json>();
	/** Every request the fake answered: `{ method, path, body }` (the upload settings and `cors_origin` are checked from here). */
	readonly requests: { method: string; path: string; body: Json }[] = [];
	/** The next request answers this instead (a full plan, a refused token). */
	failNext: { status: number; body: string } | null = null;
	/** The list's page size (Mux's is up to 100), small in tests of the cursor. */
	pageSize = 100;
	now: () => number = () => Date.now();

	seedClip(seed: SeedClip = {}): string {
		const assetId = seed.id ?? id('asset');
		const playbackId = seed.playbackId === undefined ? id('pb') : seed.playbackId;
		const mp4 = seed.mp4 ?? 'ready';
		this.assets.set(assetId, {
			id: assetId,
			status: seed.status ?? 'ready',
			created_at: String(Math.floor((seed.createdAt ? Date.parse(seed.createdAt) : this.now()) / 1000)),
			duration: seed.duration ?? 12.5,
			aspect_ratio: '16:9',
			playback_ids: playbackId ? [{ id: playbackId, policy: 'public' }] : [],
			static_renditions: mp4 === 'none' ? undefined : { files: [{ resolution: 'highest', name: 'highest.mp4', status: mp4 }] },
			tracks: [{ type: 'video', max_width: seed.w ?? 1920, max_height: seed.h ?? 1080 }],
			meta: seed.title === null ? {} : { title: seed.title ?? 'A clip' },
			...(seed.error ? { errors: seed.error } : {}),
		});
		return assetId;
	}

	/** An upload's file has arrived: Mux makes its asset, preparing, with its MP4 to come. Returns the asset id. */
	receive(uploadId: string, seed: Omit<SeedClip, 'id' | 'status' | 'mp4'> = {}): string {
		const upload = this.uploads.get(uploadId);
		if (!upload) throw new Error(`no upload ${uploadId}`);
		const assetId = this.seedClip({ ...seed, title: seed.title ?? upload.new_asset_settings?.meta?.title ?? null, status: 'preparing', mp4: 'preparing' });
		upload.status = 'asset_created';
		upload.asset_id = assetId;
		return assetId;
	}

	/** The asset and its MP4 are ready (or set any part: `{ status, mp4 }`). */
	ready(assetId: string, to: { status?: SeedClip['status']; mp4?: Exclude<SeedClip['mp4'], 'none'> } = {}): void {
		const asset = this.assets.get(assetId);
		if (!asset) throw new Error(`no asset ${assetId}`);
		asset.status = to.status ?? 'ready';
		asset.static_renditions = { files: [{ resolution: 'highest', name: 'highest.mp4', status: to.mp4 ?? 'ready' }] };
	}

	clear(): void {
		this.assets.clear();
		this.uploads.clear();
		this.requests.length = 0;
		this.failNext = null;
		this.pageSize = 100;
	}

	/** Mux's API, in memory: what the client (mux.ts) is given as its `fetch`. */
	readonly fetch: typeof fetch = async (input, init) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? 'GET').toUpperCase();
		const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : null;
		const path = url.pathname;
		this.requests.push({ method, path: path + url.search, body });
		const reply = (status: number, value: unknown) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
		if (url.origin !== MUX_API) return reply(404, { error: { type: 'not_found', messages: ['not Mux'] } });
		if (this.failNext) {
			const { status, body: text } = this.failNext;
			this.failNext = null;
			return reply(status, text);
		}
		const notFound = () => reply(404, { error: { type: 'not_found', messages: ['The requested resource does not exist.'] } });
		let m: RegExpExecArray | null;
		if (path === '/video/v1/uploads' && method === 'POST') {
			const uploadId = id('up');
			const upload = { id: uploadId, url: `https://mux.test/upload/${uploadId}`, status: 'waiting', cors_origin: body?.cors_origin, new_asset_settings: body?.new_asset_settings, asset_id: undefined as string | undefined };
			this.uploads.set(uploadId, upload);
			return reply(201, { data: upload });
		}
		if ((m = /^\/video\/v1\/uploads\/([^/]+)$/.exec(path)) && method === 'GET') {
			const upload = this.uploads.get(m[1]!);
			return upload ? reply(200, { data: upload }) : notFound();
		}
		if (path === '/video/v1/assets' && method === 'GET') {
			const all = [...this.assets.values()];
			const start = Number(url.searchParams.get('cursor') ?? '0') || 0;
			const size = Math.min(this.pageSize, Number(url.searchParams.get('limit') ?? '100') || 100);
			const page = all.slice(start, start + size);
			const next = start + size < all.length ? String(start + size) : null;
			return reply(200, { data: page, next_cursor: next });
		}
		if ((m = /^\/video\/v1\/assets\/([^/]+)$/.exec(path)) && method === 'GET') {
			const asset = this.assets.get(m[1]!);
			return asset ? reply(200, { data: asset }) : notFound();
		}
		if ((m = /^\/video\/v1\/playback-ids\/([^/]+)$/.exec(path)) && method === 'GET') {
			for (const asset of this.assets.values()) {
				if ((asset.playback_ids as Json[]).some((p) => p.id === m![1])) return reply(200, { data: { id: m[1], policy: 'public', object: { type: 'asset', id: asset.id } } });
			}
			// Mux's answer for an ID from another environment.
			return reply(400, { error: { type: 'invalid_parameters', messages: ['Playback ID belongs to a mismatching environment'] } });
		}
		return notFound();
	};
}

export interface MemoryMedia {
	bucket: MemoryBucket;
	mux: MemoryMux;
	/** Empty both, and drop the library's caches (library.ts). */
	reset(): void;
}

const SHARED = Symbol.for('caracms.memoryMedia');
const RESETS = Symbol.for('caracms.mediaCaches');
type Shared = { [SHARED]?: MemoryMedia; [RESETS]?: Set<() => void> };

/** Register a cache to drop on `reset()` (library.ts's listing and metadata caches). */
export function onMediaReset(fn: () => void): void {
	const g = globalThis as Shared;
	(g[RESETS] ??= new Set()).add(fn);
}

/** The process's in-memory bucket and fake Mux. */
export function memoryMedia(): MemoryMedia {
	const g = globalThis as Shared;
	if (!g[SHARED]) {
		const bucket = new MemoryBucket();
		const mux = new MemoryMux();
		g[SHARED] = {
			bucket,
			mux,
			reset() {
				bucket.clear();
				mux.clear();
				for (const fn of g[RESETS] ?? []) fn();
			},
		};
	}
	return g[SHARED];
}
