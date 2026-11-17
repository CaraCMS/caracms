/**
 * Mux, as the Tina template does it (M5b Decision 12; its Mux server code and its
 * video notes, whose rules carry over exactly):
 *
 * - **Every upload gets the same settings** (`NEW_ASSET_SETTINGS`): public playback,
 *   `basic` quality, the `1080p` tier, a `highest` static rendition (never `1080p`, which
 *   is billed) and generated English captions.
 * - **A clip is placeable only when it can play**: the asset is `ready` and its `highest`
 *   MP4 is `ready` (`toClip` → `ready`). A ready asset whose MP4 is missing, errored or
 *   skipped can never become ready, so it's errored with a sentence a designer can act on.
 * - **The token never reaches the browser**, and **Mux's error bodies go to the server
 *   log only**: the browser gets a short sentence of our own (a full free plan gets
 *   `planLimitMessage`).
 * - Plain `fetch` with basic auth (no SDK). The fake Mux behind `CARACMS_MEDIA=memory` is
 *   a `fetch` that answers Mux's API (memory.ts → `MemoryMux`), so it runs this same code.
 */
import type { VideoUploadStatus } from '../../types.ts';

export const MUX_API = 'https://api.mux.com';

/** Every upload's asset settings (`video.md` → Upload settings). `meta.title` is added per upload. */
export const NEW_ASSET_SETTINGS = Object.freeze({
	playback_policy: ['public'],
	video_quality: 'basic',
	max_resolution_tier: '1080p',
	static_renditions: [{ resolution: 'highest' }],
	inputs: [{ generated_subtitles: [{ language_code: 'en', name: 'English (generated)' }] }],
});

/** Mux ids are alphanumeric; anything else never reaches Mux's URL. */
export const MUX_ID = /^[A-Za-z0-9]{1,128}$/;
const PAGE_LIMIT = 100;
/** A runaway-cursor guard: 100 pages is 10,000 clips, far past one site's library. */
const MAX_PAGES = 100;
const MUX_TIMEOUT_MS = 15_000;
/** Mux caps meta.title at 512 characters. */
export const TITLE_MAX = 512;

export const NO_MP4_MESSAGE = 'No MP4 version of this clip. Upload it through the editor, or turn on MP4 (static renditions) for it in Mux.';
export const MP4_FAILED_MESSAGE = "Mux couldn't make the MP4 version of this clip. Upload it again through the editor, or delete it in the Mux dashboard.";

/** A Mux call that failed: `status` and `message` are what the browser sees. */
export class MuxRouteError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** A clip as the library gives it, before where-used is added. */
export interface Clip {
	id: string;
	playbackId: string | null;
	status: string;
	ready: boolean;
	errored: boolean;
	error: string | null;
	title: string | null;
	duration: number | null;
	aspectRatio: string | null;
	w: number | null;
	h: number | null;
	createdAt: string | null;
}

export interface MuxClient {
	createUpload(origin: string, title: string): Promise<{ id: string; url: string }>;
	upload(id: string): Promise<VideoUploadStatus>;
	clip(assetId: string): Promise<Clip>;
	/** The clip a playback ID plays; another environment's or an unknown one is a 404. */
	clipOfPlayback(playbackId: string): Promise<Clip>;
	/** The whole library, following Mux's cursor, newest first. */
	clips(): Promise<Clip[]>;
}

type Json = any;

export function muxClient(options: { tokenId: string; tokenSecret: string; fetch?: typeof fetch; log?: (line: string) => void }): MuxClient {
	const auth = 'Basic ' + Buffer.from(`${options.tokenId}:${options.tokenSecret}`).toString('base64');
	const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
	const log = options.log ?? ((line: string) => console.error(line));

	/** One call; resolves Mux's whole JSON reply (`{ data, next_cursor? }`). `notFoundOn`: statuses that mean "no such thing". */
	async function mux(path: string, { method = 'GET', body, notFoundOn = [] as number[] }: { method?: string; body?: unknown; notFoundOn?: number[] } = {}): Promise<Json> {
		const where = `${method} ${path.split('?')[0]}`;
		let res: Response;
		try {
			res = await doFetch(MUX_API + path, {
				method,
				headers: { Authorization: auth, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(MUX_TIMEOUT_MS),
			});
		} catch (error) {
			log(`[caracms] mux ${where} unreachable: ${error instanceof Error ? error.message : String(error)}`);
			throw new MuxRouteError(502, 'Could not reach Mux.');
		}
		const text = await res.text().catch(() => '');
		if (!res.ok) {
			// Mux's body goes to the server log (it never holds the token), never to the browser.
			log(`[caracms] mux ${where} ${res.status} ${text.slice(0, 500)}`);
			if (notFoundOn.includes(res.status)) throw new MuxRouteError(404, 'Not found.');
			if (res.status === 401 || res.status === 403) throw new MuxRouteError(502, 'Mux refused the token (check MUX_TOKEN_ID and MUX_TOKEN_SECRET).');
			const full = planLimitMessage(text);
			if (full) throw new MuxRouteError(502, full);
			throw new MuxRouteError(502, `Mux request failed (${res.status}).`);
		}
		try {
			const json = JSON.parse(text) as Json;
			if (json && typeof json === 'object' && json.data !== undefined) return json;
		} catch {
			/* below */
		}
		log(`[caracms] mux ${where}: unreadable reply`);
		throw new MuxRouteError(502, 'Mux sent an unreadable reply.');
	}

	const clip = async (assetId: string) => toClip((await mux(`/video/v1/assets/${assetId}`, { notFoundOn: [400, 404] })).data);

	return {
		async createUpload(origin, title) {
			const { data } = await mux('/video/v1/uploads', { method: 'POST', body: { cors_origin: origin, new_asset_settings: { ...NEW_ASSET_SETTINGS, meta: { title } } } });
			if (typeof data?.id !== 'string' || typeof data?.url !== 'string') throw new MuxRouteError(502, 'Mux sent an unreadable reply.');
			return { id: data.id, url: data.url };
		},
		async upload(id) {
			const { data } = await mux(`/video/v1/uploads/${id}`, { notFoundOn: [400, 404] });
			return {
				id: String(data?.id ?? id),
				status: typeof data?.status === 'string' ? data.status : 'unknown',
				assetId: typeof data?.asset_id === 'string' ? data.asset_id : null,
				error: data?.status === 'errored' ? shortMessage(data.error) : null,
			};
		},
		clip,
		async clipOfPlayback(playbackId) {
			// 400 is Mux's "mismatching environment": another environment's ID is a 404 here.
			const { data } = await mux(`/video/v1/playback-ids/${playbackId}`, { notFoundOn: [400, 404] });
			if (data?.object?.type !== 'asset' || typeof data.object.id !== 'string' || !MUX_ID.test(data.object.id)) throw new MuxRouteError(404, 'Not found.');
			return clip(data.object.id);
		},
		async clips() {
			const assets: Json[] = [];
			let cursor: string | null = null;
			const seen = new Set<string>();
			for (let page = 0; ; page++) {
				if (page === MAX_PAGES) {
					log(`[caracms] mux: the list stopped after ${MAX_PAGES} pages`);
					break;
				}
				const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
				if (cursor) query.set('cursor', cursor);
				const reply = await mux(`/video/v1/assets?${query}`);
				if (Array.isArray(reply.data)) assets.push(...reply.data);
				cursor = typeof reply.next_cursor === 'string' && reply.next_cursor ? reply.next_cursor : null;
				if (!cursor || seen.has(cursor)) break;
				seen.add(cursor);
			}
			return (
				assets
					.map(toClip)
					// Errored clips stay even without a public playback ID: a failed upload must be visible.
					.filter((c) => c.playbackId !== null || c.errored)
					.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
			);
		},
	};
}

/**
 * Mux's asset → the library's clip (the template's `toClip`, plus the video track's
 * size). `ready` needs both the asset and its `highest` MP4. Failure is the asset's own
 * status, never a track's (a silent clip's generated captions error; it still plays),
 * plus a ready asset whose MP4 is missing, errored or skipped.
 */
export function toClip(asset: Json): Clip {
	const playback = Array.isArray(asset?.playback_ids) ? asset.playback_ids : [];
	const publicId = playback.find((p: Json) => p?.policy === 'public' && typeof p.id === 'string');
	const files = Array.isArray(asset?.static_renditions?.files) ? asset.static_renditions.files : [];
	const highest = files.find((f: Json) => f?.resolution === 'highest');
	const status = typeof asset?.status === 'string' ? asset.status : 'unknown';
	let error: string | null = null;
	if (status === 'errored') error = shortMessage(asset?.errors);
	else if (status === 'ready' && !highest) error = NO_MP4_MESSAGE;
	else if (status === 'ready' && (highest.status === 'errored' || highest.status === 'skipped')) error = MP4_FAILED_MESSAGE;
	const seconds = Number(asset?.created_at);
	const video = (Array.isArray(asset?.tracks) ? asset.tracks : []).find((t: Json) => t?.type === 'video');
	const px = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
	return {
		id: String(asset?.id ?? ''),
		playbackId: publicId ? publicId.id : null,
		status,
		ready: status === 'ready' && highest?.status === 'ready',
		errored: error !== null,
		error,
		title: typeof asset?.meta?.title === 'string' && asset.meta.title ? asset.meta.title : null,
		duration: typeof asset?.duration === 'number' ? asset.duration : null,
		aspectRatio: typeof asset?.aspect_ratio === 'string' ? asset.aspect_ratio : null,
		w: px(video?.max_width),
		h: px(video?.max_height),
		createdAt: asset?.created_at != null && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null,
	};
}

/**
 * What a designer is told when Mux refuses because the plan is full (a new environment
 * starts on the free plan, capped at 10 videos). Mux's own words are matched, not
 * trusted, and none are carried over. Null for any other body.
 */
export function planLimitMessage(text: string): string | null {
	let messages: unknown;
	try {
		messages = (JSON.parse(text) as Json)?.error?.messages;
	} catch {
		return null;
	}
	if (!Array.isArray(messages)) return null;
	for (const message of messages) {
		if (typeof message === 'string' && /plan is limited to \d+ assets/i.test(message)) return 'The Mux plan is full. Ask your developer.';
	}
	return null;
}

/** Mux's reason for a failed asset or upload, short: `type: first message`. */
export function shortMessage(error: Json): string {
	if (!error || typeof error !== 'object') return 'Mux could not process this file.';
	const type = typeof error.type === 'string' ? error.type : '';
	const message = Array.isArray(error.messages) ? error.messages[0] : error.message;
	const text = [type, typeof message === 'string' ? message : ''].filter(Boolean).join(': ');
	return (text || 'Mux could not process this file.').slice(0, 200);
}

/** The upload's title from `{ name }`: the file name, stripped of any path and control characters, capped at Mux's 512. */
export function clipTitle(name: unknown): string {
	const raw = typeof name === 'string' ? name : '';
	return (raw.split(/[\\/]/).pop() ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.trim()
		.slice(0, TITLE_MAX);
}
