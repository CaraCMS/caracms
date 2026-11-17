/**
 * Mux on CaraCMS Cloud (caracms-cloud M4.5 Decision 16), behind mux.ts's seam, so the clip
 * routes, where-used (`withUses`) and the editor don't change. The site's server holds no
 * Mux token: it asks the API (live/cloud.ts, the site key), which asks the cloud's own
 * Mux environment and answers from the site's own clips only. One route per method:
 *
 * - `createUpload`: `POST /v1/video/upload` `{ origin, title }` → `{ id, url }`.
 * - `upload`: `GET /v1/video/upload?id=` → `VideoUploadStatus`.
 * - `clip`: `GET /v1/video/clip?id=` → `Clip`; `clipOfPlayback`: `GET /v1/video/playback?id=`.
 * - `clips`: `GET /v1/video/clips` → `{ clips }`, newest first (the cloud keeps the order).
 *
 * **The cloud's refusals become `MuxRouteError`s**, so the media handler's own catch answers
 * them: `not_found` is the routes' documented 404 ('Not found.'); `video_limit` is a 403
 * with the cloud's sentence as sent; `uploads_in_flight` (the site already has two clips
 * uploading) is a 429 with the cloud's sentence as sent, not logged: it's the cloud asking
 * the person to wait, not a failure; any other refusal (`video_unavailable`, the key's own
 * refusals…) is a 502 with the cloud's sentence as sent. A cloud that can't be reached, or
 * an answer that isn't the shape, is a 502 with the package's own sentence. Each 502 is
 * logged with the refusal's code. The key is never logged nor put in an error.
 */
import type { VideoUploadStatus } from '../../types.ts';
import { cloudCall, isCloudRefusal, type CloudConnection } from '../../../live/cloud.ts';
import { MuxRouteError, MUX_ID, type Clip, type MuxClient } from './mux.ts';

export const CLOUD_VIDEO_UNREACHABLE = "CaraCMS Cloud couldn't be reached just now. Try again in a minute.";
export const CLOUD_VIDEO_UNREADABLE = 'CaraCMS Cloud sent an unreadable reply.';

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const px = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export function cloudMux(
	connection: Pick<CloudConnection, 'key' | 'url'>,
	options: { fetch?: typeof fetch; log?: (line: string) => void } = {},
): MuxClient {
	const conn: CloudConnection = { ...connection, fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)) };
	const log = options.log ?? ((line: string) => console.error(line));

	async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
		const where = `${method} ${path.split('?')[0]}`;
		try {
			return await cloudCall(conn, method, path, body);
		} catch (error) {
			if (!isCloudRefusal(error)) throw error;
			if (error.error === 'not_found') throw new MuxRouteError(404, 'Not found.');
			if (error.error === 'video_limit') throw new MuxRouteError(403, error.message);
			if (error.error === 'uploads_in_flight') throw new MuxRouteError(429, error.message);
			log(`[caracms] video ${where}: CaraCMS Cloud (${error.error}): ${error.message}`);
			throw new MuxRouteError(502, error.error === 'unreachable' ? CLOUD_VIDEO_UNREACHABLE : error.message);
		}
	}

	const unreadable = (where: string): never => {
		log(`[caracms] video ${where}: CaraCMS Cloud sent an unreadable reply`);
		throw new MuxRouteError(502, CLOUD_VIDEO_UNREADABLE);
	};

	/** The cloud's `Clip`, checked field by field (it passes `toClip`'s shape through). */
	const clipOf = (raw: unknown, where: string): Clip => {
		const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
		const id = str(c?.id);
		if (!c || !id) return unreadable(where);
		const playbackId = str(c.playbackId);
		const errored = c.errored === true;
		return {
			id,
			playbackId: playbackId && MUX_ID.test(playbackId) ? playbackId : null,
			status: str(c.status) ?? 'unknown',
			ready: c.ready === true,
			errored,
			error: errored ? (str(c.error) ?? 'Mux could not process this file.') : null,
			title: str(c.title),
			duration: num(c.duration),
			aspectRatio: str(c.aspectRatio),
			w: px(c.w),
			h: px(c.h),
			createdAt: str(c.createdAt),
		};
	};

	const query = (id: string) => new URLSearchParams({ id }).toString();

	return {
		async createUpload(origin, title) {
			const answer = await api('POST', '/v1/video/upload', { origin, title });
			const id = str(answer.id);
			const url = str(answer.url);
			if (!id || !url || !/^https:\/\//.test(url)) return unreadable('POST /v1/video/upload');
			return { id, url };
		},
		async upload(id): Promise<VideoUploadStatus> {
			const answer = await api('GET', `/v1/video/upload?${query(id)}`);
			const assetId = str(answer.assetId);
			return {
				id: str(answer.id) ?? id,
				status: str(answer.status) ?? 'unknown',
				assetId: assetId && MUX_ID.test(assetId) ? assetId : null,
				error: str(answer.error),
			};
		},
		async clip(assetId) {
			return clipOf(await api('GET', `/v1/video/clip?${query(assetId)}`), 'GET /v1/video/clip');
		},
		async clipOfPlayback(playbackId) {
			return clipOf(await api('GET', `/v1/video/playback?${query(playbackId)}`), 'GET /v1/video/playback');
		},
		async clips() {
			const answer = await api('GET', '/v1/video/clips');
			if (!Array.isArray(answer.clips)) return unreadable('GET /v1/video/clips');
			return answer.clips.map((c) => clipOf(c, 'GET /v1/video/clips'));
		},
	};
}
