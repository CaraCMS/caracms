/**
 * The media routes (M5b Phase 2), one handler behind `/_caracms/media/[...path]`
 * (../../routes/media.ts). The routes, what they take and give: ../../types.ts →
 * `MEDIA_ENDPOINTS`. A security boundary: it takes files and ids from the browser and
 * writes to the bucket and Mux.
 *
 * - **Live mode**: the guard's prefix rule has already required a session (401) and, for
 *   a POST, the same origin (403); this checks both again (defence in depth, as the live
 *   handlers do). **Local mode** works with no sign-in, the origin still checked for a POST.
 * - **No lock** (Decision 7): an upload, or reading the library, changes no document.
 * - **Every reply is `Cache-Control: private, no-store`.**
 * - **Unconfigured: 503 with a sentence naming what's missing**, images (the bucket and
 *   imgproxy) and clips (Mux, or CaraCMS Cloud's: cloud-mux.ts) apart: one missing never
 *   disables the other.
 * - **The Mux token never reaches the browser, nor do Mux's error bodies** (server log
 *   only). Ids are checked against `^[A-Za-z0-9]{1,128}$` before they reach a URL.
 * - **The upload has its own body cap** (40 MB, upload.ts), not the write route's 2 MB or
 *   live mode's 16 KB; the video upload's JSON is held to 16 KB.
 * - **M6c G4: `POST replace`** (Replace… on a file, Decision 9, or on an image) is the one media route that
 *   changes documents: the mode's store does it under the same rules as a move (replace.ts;
 *   live mode takes each document's lock), with the tab's header as a write has it. The new
 *   file must already be in the bucket.
 */
import type { ResolvedSite } from '../../../config.ts';
import type { Person } from '../../../live/messages.ts';
import { IMAGE_WIDTHS, thumbnailUrl, type MediaSettings } from '../../../media.ts';
import type {
	ApiError,
	LibraryClip,
	MediaClipsResponse,
	MediaFileUploadResponse,
	MediaImagesResponse,
	MediaRefusal,
	MediaUnset,
	MediaUploadResponse,
	ReplaceFileResponse,
	VideoUploadResponse,
	VideoUploadStatus,
} from '../../types.ts';
import { MEDIA_MAX_BYTES, RELEASE_HEADER } from '../../types.ts';
import type { DraftsStore } from '../drafts-store.ts';
import { parseReplaceBody } from '../replace.ts';
import { checkOrigin, seqOf, tabOf, WriteRefused } from '../write.ts';
import { BucketError, s3Bucket, type Bucket } from './bucket.ts';
import { cloudBucket } from './cloud-bucket.ts';
import { cloudMux } from './cloud-mux.ts';
import { isCloudRefusal } from '../../../live/cloud.ts';
import { readImagesConfig, readMuxConfig } from './config.ts';
import { isFileKey } from '../../../files.ts';
import { entryOf, fileEntryOf, libraryFor, mediaUses, UPLOADS, type Library, type MediaUses } from './library.ts';
import { memoryMedia } from './memory.ts';
import { clipTitle, muxClient, MuxRouteError, MUX_ID, type Clip, type MuxClient } from './mux.ts';
import { readCapped, storeUpload, tooLargeMessage, UploadRefused, uploadName } from './upload.ts';

export const MEDIA_PREFIX = '/_caracms/media/';
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const JSON_CAP = 16_384;
/** A key the thumbnail route signs: an upload's, nothing else. */
const UPLOAD_KEY = /^uploads\/[0-9a-f]{12}\/[^/\u0000-\u001f\u007f]{1,255}$/;

type Env = Record<string, string | undefined>;

export interface MediaContext {
	site: Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>;
	/** The mode's store (server/mode.ts): where-used reads its listing. */
	store: DraftsStore;
	mode: 'local' | 'live';
	/** The signed-in person (live mode); null in local mode. */
	person: Person | null;
	env?: Env;
	production?: boolean;
	log?: (line: string) => void;
	/** Mux's and the bucket's `fetch` (tests). Memory mode never uses it. */
	fetch?: typeof fetch;
}

/** The image side, ready: the library and the signing settings. */
function images(ctx: MediaContext): { library: Library; signing: MediaSettings } | Response {
	const config = readImagesConfig(ctx.env ?? process.env, ctx.production);
	if (config.kind === 'unset') return json(503, { error: config.message, code: 'media-unset', missing: config.missing } satisfies MediaUnset);
	if (config.kind === 'memory') return { library: libraryFor('memory', () => memoryMedia().bucket), signing: config.signing };
	if (config.kind === 'cloud') return { library: libraryFor(`cloud:${config.connection.url}:${config.signing.prefix}`, (): Bucket => cloudBucket(config.connection, ctx.fetch)), signing: config.signing };
	const b = config.bucket;
	return { library: libraryFor(`s3:${b.endpoint}:${b.bucket}:${b.accessKeyId}`, (): Bucket => s3Bucket(b, ctx.fetch)), signing: config.signing };
}

function mux(ctx: MediaContext): MuxClient | Response {
	const config = readMuxConfig(ctx.env ?? process.env, ctx.production);
	if (config.kind === 'unset') return json(503, { error: config.message, code: 'mux-unset', missing: config.missing } satisfies MediaUnset);
	const log = ctx.log ?? ((line: string) => console.error(line));
	if (config.kind === 'memory') return muxClient({ tokenId: 'memory', tokenSecret: 'memory', fetch: memoryMedia().mux.fetch, log });
	// caracms-cloud M4.5: the cloud's Mux, through the site key; its refusals arrive as MuxRouteErrors.
	if (config.kind === 'cloud') return cloudMux(config.connection, { fetch: ctx.fetch, log });
	return muxClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret, fetch: ctx.fetch, log });
}

const withUses = (clip: Clip, uses: MediaUses): LibraryClip => ({ ...clip, usedIn: clip.playbackId ? (uses.clips.get(clip.playbackId) ?? []) : [] });

async function readJson(request: Request, shape = '{ "name": "<file name>" }'): Promise<Record<string, unknown>> {
	const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
	if (type !== 'application/json') throw new WriteRefused(415, `Send JSON: ${shape}.`);
	const body = await readCapped(request, JSON_CAP);
	if (!body.ok) throw new WriteRefused(413, 'That body is too large.');
	try {
		const value = JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
		if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		/* below */
	}
	throw new WriteRefused(400, `Send JSON: ${shape}.`);
}

/** Answer one request under `/_caracms/media/`. */
export async function handleMedia(request: Request, ctx: MediaContext): Promise<Response> {
	const log = ctx.log ?? ((line: string) => console.error(line));
	const url = new URL(request.url);
	const rest = url.pathname.startsWith(MEDIA_PREFIX) ? url.pathname.slice(MEDIA_PREFIX.length) : null;
	const parts = rest === null ? [] : rest.split('/').filter(Boolean);
	const [route, id, extra] = parts;
	const method = request.method.toUpperCase();
	const only = (allowed: string): Response | null =>
		method === allowed ? null : json(405, { error: `This route takes ${allowed}.` } satisfies ApiError, { Allow: allowed });

	try {
		// Defence in depth: the guard already did both in live mode.
		if (ctx.mode === 'live' && !ctx.person) return json(401, { error: 'signed-out', code: 'signed-out' } satisfies ApiError);
		if (method !== 'GET') checkOrigin(request);
		const by = ctx.mode === 'live' ? (ctx.person?.email ?? null) : null;

		if (route === 'upload' && id === undefined) {
			const refusedMethod = only('POST');
			if (refusedMethod) return refusedMethod;
			const side = images(ctx);
			if (side instanceof Response) {
				await request.body?.cancel().catch(() => {});
				return side;
			}
			const body = await readCapped(request, MEDIA_MAX_BYTES);
			if (!body.ok) return json(413, { error: tooLargeMessage(body.size), code: 'too-large' } satisfies MediaRefusal);
			const stored = await storeUpload(side.library.bucket, { bytes: body.bytes, name: uploadName(request), by }, { head: (key) => side.library.metaOf(key) });
			if (stored.created) side.library.added(stored.key, stored.meta);
			const uses = await mediaUses(ctx.store, ctx.site);
			const status = stored.created ? 201 : 200;
			if (isFileKey(stored.key)) return json(status, { file: fileEntryOf(stored.key, stored.meta, uses), created: stored.created } satisfies MediaFileUploadResponse);
			const image = entryOf(side.signing, stored.key, stored.meta, uses);
			return json(status, { image, created: stored.created } satisfies MediaUploadResponse);
		}

		if (route === 'images' && id === undefined) {
			const refusedMethod = only('GET');
			if (refusedMethod) return refusedMethod;
			const side = images(ctx);
			if (side instanceof Response) return side;
			const uses = await mediaUses(ctx.store, ctx.site);
			const [listed, files] = await Promise.all([side.library.images(side.signing, uses), side.library.files(uses)]);
			return json(200, { images: listed, files } satisfies MediaImagesResponse);
		}

		if (route === 'replace' && id === undefined) {
			const refusedMethod = only('POST');
			if (refusedMethod) return refusedMethod;
			const side = images(ctx);
			if (side instanceof Response) {
				await request.body?.cancel().catch(() => {});
				return side;
			}
			const body = parseReplaceBody(await readJson(request, '{ "from": "<the file\'s or image\'s key>", "to": "<the new one\'s key>" }'));
			const image = !isFileKey(body.to);
			const meta = await side.library.metaOf(body.to);
			if (!meta) return json(404, { error: `The new ${image ? 'image' : 'file'} isn't in the library, so nothing was changed. Upload it again.`, code: 'not-found' } satisfies ApiError);
			const context = { person: ctx.person, tab: tabOf(request), release: request.headers.get(RELEASE_HEADER) === '1', seq: seqOf(request) };
			// An image's uses take its size from the bucket's metadata, never from the editor.
			const asked = image ? { ...body, size: { w: meta.w, h: meta.h } } : body;
			return json(200, (await ctx.store.replaceFile(asked, context)) satisfies ReplaceFileResponse);
		}

		if (route === 'thumbnail' && id === undefined) {
			const refusedMethod = only('GET');
			if (refusedMethod) return refusedMethod;
			const side = images(ctx);
			if (side instanceof Response) return side;
			const key = url.searchParams.get('key') ?? '';
			const width = Number(url.searchParams.get('width') ?? '320');
			if (!UPLOAD_KEY.test(key) || !key.startsWith(UPLOADS) || isFileKey(key)) return json(400, { error: 'key must be an image upload\'s key (uploads/<hash>/<name>); a file has no thumbnail.' } satisfies ApiError);
			if (!IMAGE_WIDTHS.includes(width)) return json(400, { error: `width must be one of ${IMAGE_WIDTHS.join(', ')}.` } satisfies ApiError);
			return new Response(null, { status: 302, headers: { Location: thumbnailUrl(side.signing, key, width), 'Cache-Control': 'private, no-store' } });
		}

		// ── Clips ──
		const known = route === 'video-upload' || route === 'clips' || route === 'playback';
		if (!known || extra !== undefined || (route === 'playback' && id === undefined)) return json(404, { error: 'Not found.' } satisfies ApiError);
		if (id !== undefined && !MUX_ID.test(id)) return json(404, { error: 'Not found.' } satisfies ApiError);

		if (route === 'video-upload' && id === undefined) {
			const refusedMethod = only('POST');
			if (refusedMethod) return refusedMethod;
			const client = mux(ctx);
			if (client instanceof Response) return client;
			// cors_origin is the request's own origin, as the browser sent it (checkOrigin has
			// matched its host to this request's). No Origin, no upload: Mux takes the PUT only from it.
			const origin = request.headers.get('origin');
			if (!origin || origin === 'null') return json(403, { error: 'Video uploads are only accepted from the editor on this site.' } satisfies ApiError);
			const body = await readJson(request);
			const title = clipTitle(body.name);
			if (!title) return json(400, { error: 'Send the file name: { "name": "<file name>" }.' } satisfies ApiError);
			const upload = await client.createUpload(new URL(origin).origin, title);
			return json(201, upload satisfies VideoUploadResponse);
		}

		const refusedMethod = only('GET');
		if (refusedMethod) return refusedMethod;
		const client = mux(ctx);
		if (client instanceof Response) return client;
		if (route === 'video-upload') return json(200, (await client.upload(id!)) satisfies VideoUploadStatus);
		const uses = await mediaUses(ctx.store, ctx.site);
		if (route === 'clips' && id === undefined) return json(200, { clips: (await client.clips()).map((c) => withUses(c, uses)) } satisfies MediaClipsResponse);
		if (route === 'clips') return json(200, withUses(await client.clip(id!), uses) satisfies LibraryClip);
		return json(200, withUses(await client.clipOfPlayback(id!), uses) satisfies LibraryClip);
	} catch (error) {
		if (error instanceof UploadRefused) return json(error.status, { error: error.message, code: error.code } satisfies MediaRefusal);
		if (error instanceof MuxRouteError) return json(error.status, { error: error.message } satisfies ApiError);
		if (error instanceof WriteRefused) return json(error.status, { error: error.message, ...error.body });
		if (isCloudRefusal(error)) {
			// caracms-cloud M3: the cloud's own sentence, as sent (a full site, its storage away).
			log(`[caracms] media bucket: CaraCMS Cloud (${error.error}): ${error.message}`);
			return json(502, { error: error.message } satisfies ApiError);
		}
		if (error instanceof BucketError) {
			log(`[caracms] media bucket: ${error.message}`);
			const said = error.status !== null && error.status >= 400 && error.status < 500;
			return json(502, { error: said ? 'The media bucket refused that, so nothing was stored.' : "The media bucket didn't answer, so nothing was stored. Try again in a moment." } satisfies ApiError);
		}
		log(`[caracms] ${url.pathname} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		return json(500, { error: 'Something went wrong with the media library.' } satisfies ApiError);
	}
}
