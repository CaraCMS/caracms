/**
 * The image URL builder (M5b Decision 2): the ONE place that knows imgproxy's URL
 * shape and signs it. **Server-only** (node:crypto, the signing key): the build and
 * the preview's server render call it, never the browser. Nothing here is ever put
 * in `virtual:caracms/config` or an editor prop: only the URLs it returns leave the
 * server.
 *
 *   https://<CARACMS_MEDIA_URL>/<sig>/rs:<fit|fill>:<w>:<h>[/g:fp:<x>:<y>]/q:80/plain/s3://<bucket>/<key>@webp
 *
 * - `<sig>` is imgproxy's HMAC-SHA256 over the salt then the path, in base64url
 *   (docs.imgproxy.net → Signing the URL). A path with no signature, or a wrong one,
 *   is refused (403).
 * - A gravity goes only on a `fill` (a `fit` crops nothing; a gravity there would only
 *   make a second URL for the same file). Quality 80. WebP, always in the URL (never
 *   imgproxy's auto-format: Railway's CDN ignores `Vary: Accept`); `@png` when the
 *   media field says `format: 'png'` (M9 Decision 8).
 * - Sides are rounded and capped at 4000 (imgproxy's `IMGPROXY_MAX_RESULT_DIMENSION`).
 * - GIFs and SVGs pass through: `/<sig>/plain/s3://<bucket>/<key>`, no resize, no
 *   format, still signed (a GIF resize drops its animation; an SVG is sharp at any size).
 *
 * The variables (Decision 5): `CARACMS_MEDIA_URL` (imgproxy's public origin),
 * `IMGPROXY_KEY` and `IMGPROXY_SALT` (hex, the values imgproxy has), `S3_BUCKET` (the
 * bucket in the `s3://` source). `CARACMS_MEDIA=memory` supplies `https://img.test`, a
 * fixed test key and salt and a test bucket, and is refused on a production server.
 *
 * **On CaraCMS Cloud** (caracms-cloud M3 Decisions 19–20) `CARACMS_CLOUD_KEY` replaces all
 * of them: the origin (`https://<media.imageHost>`), the pair, the bucket and the site's
 * folder come from the cloud's settings, fetched once per process (live/cloud.ts →
 * `loadCloudSettings`, at the build's start and by a server's first request) and read here
 * from that held copy. The folder goes before the key in the source,
 * `s3://<bucket>/sites/<folder>/<key>`; content keeps `uploads/…`. The key with any of the
 * site's own media variables is a problem sentence (one credential, not two).
 */
import { createHmac } from 'node:crypto';
import type { ImageFormat } from './fields.ts';
import { CLOUD_NO_MEDIA, heldCloudSettings, type CloudConnection } from './live/cloud.ts';
import { CLOUD_AND_MEDIA_PROBLEM, OWN_MEDIA_VARIABLES, readCloudUrl } from './live/mode.ts';
import { bakedServices, CLOUD_KEY_MISSING_PROBLEM, servicesEnv, type Services } from './live/services.ts';
import { renderMedia, type RenderImage } from './media-value.ts';

/** The srcset width ladder every fluid image draws from (Decision 2). 1920 at the top: imgproxy doesn't upscale. */
export const IMAGE_WIDTHS: readonly number[] = [160, 320, 480, 640, 960, 1280, 1920];
/** imgproxy's IMGPROXY_MAX_RESULT_DIMENSION: a side is never asked for above it. */
export const IMAGE_MAX_DIMENSION = 4000;
export const IMAGE_QUALITY = 80;
/** Pinned in every resized URL, unless the media field asks for PNG (M9 Decision 8). */
export const IMAGE_FORMAT: ImageFormat = 'webp';
/** Fixed mode's densities (Decision 4: 1×, 2×, 3×). */
export const IMAGE_DENSITIES: readonly number[] = [1, 2, 3];

/** `CARACMS_MEDIA=memory`'s host, key, salt and bucket (tests only; Decision 5). */
export const MEMORY_MEDIA = {
	origin: 'https://img.test',
	key: '7465737420696d6770726f7879206b6579',
	salt: '7465737420696d6770726f78792073616c74',
	bucket: 'caracms-test-media',
} as const;

export interface MediaSettings {
	/** imgproxy's public origin, no trailing slash. */
	origin: string;
	/** Hex, as imgproxy takes them. */
	key: string;
	salt: string;
	bucket: string;
	/** Before every key in the source: the site's folder on CaraCMS Cloud (`sites/<folder>/`), else none. */
	prefix?: string;
	memory: boolean;
}

export type MediaConfig =
	| { kind: 'ready'; settings: MediaSettings }
	/** `missing` names the variables that aren't set; `problems` are sentences for anything else wrong. */
	| { kind: 'unset'; missing: string[]; problems: string[] };

declare const __CARACMS_PRODUCTION__: boolean | undefined;

/** True in the build and the built server (the integration's define), false under `astro dev` and in plain Node. */
export function isProductionBuild(): boolean {
	return typeof __CARACMS_PRODUCTION__ === 'boolean' ? __CARACMS_PRODUCTION__ : false;
}

type Env = Record<string, string | undefined>;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;

export { CLOUD_AND_MEDIA_PROBLEM, OWN_MEDIA_VARIABLES };
/** No settings held yet: nothing has fetched them in this process (the middleware and the build's start do). */
export const CLOUD_MEDIA_NOT_FETCHED = "The site's media settings haven't come from CaraCMS Cloud yet.";
/** A held fetch that couldn't reach the cloud, in the media's words (the cloud's own refusals are shown as sent). */
export const CLOUD_MEDIA_UNREACHABLE = "CaraCMS Cloud couldn't be reached, so images can't be shown. Try again in a minute.";

/**
 * The cloud as the media credential: the connection when `CARACMS_CLOUD_KEY` is set and
 * `CARACMS_MEDIA` isn't `memory` (which wins over everything), with any problems (the
 * site's own media variables beside it, a bad `CARACMS_CLOUD_URL`). Null: not a cloud site's media.
 * With the config's `services` (caracms-cloud M5), the other mode's variables aren't read.
 */
export function cloudMedia(env: Env = process.env, services: Services | null = bakedServices()): { connection: Pick<CloudConnection, 'key' | 'url'>; problems: string[] } | null {
	env = servicesEnv(env, services);
	const get = (name: string) => env[name]?.trim() || null;
	const key = get('CARACMS_CLOUD_KEY');
	if (!key || get('CARACMS_MEDIA') === 'memory') return null;
	const problems: string[] = [];
	const both = OWN_MEDIA_VARIABLES.filter((name) => get(name));
	if (both.length) problems.push(CLOUD_AND_MEDIA_PROBLEM(both));
	const url = readCloudUrl(get('CARACMS_CLOUD_URL'), problems);
	return { connection: { key, url }, problems };
}

/** The media settings from the held cloud settings (or why there are none). */
function cloudMediaConfig(cloud: NonNullable<ReturnType<typeof cloudMedia>>, problems: string[]): MediaConfig {
	problems.push(...cloud.problems);
	if (problems.length) return { kind: 'unset', missing: [], problems };
	const held = heldCloudSettings(cloud.connection);
	if (!held) return { kind: 'unset', missing: [], problems: [CLOUD_MEDIA_NOT_FETCHED] };
	if (held.kind === 'failed') return { kind: 'unset', missing: [], problems: [held.refusal.error === 'unreachable' ? CLOUD_MEDIA_UNREACHABLE : held.refusal.message] };
	const media = held.settings.media;
	if (!media) return { kind: 'unset', missing: [], problems: [CLOUD_NO_MEDIA] };
	return { kind: 'ready', settings: { origin: `https://${media.imageHost}`, key: media.key, salt: media.salt, bucket: media.bucket, prefix: media.folder, memory: false } };
}

/** The media variables (Decision 5). Read on each call (cheap), so tests can change them. */
export function readMediaConfig(env: Env = process.env, production = isProductionBuild(), services: Services | null = bakedServices()): MediaConfig {
	env = servicesEnv(env, services);
	const get = (name: string) => {
		const v = env[name]?.trim();
		return v ? v : null;
	};
	const problems: string[] = [];
	const mode = get('CARACMS_MEDIA');
	if (mode === 'memory') {
		if (production) return { kind: 'unset', missing: [], problems: ['CARACMS_MEDIA=memory is for tests and local runs; a production server never uses the in-memory media.'] };
		return { kind: 'ready', settings: { ...MEMORY_MEDIA, memory: true } };
	}
	if (mode) problems.push(`CARACMS_MEDIA must be "memory" or unset (got "${mode}").`);
	// M5 Decision 4: a cloud site without its key has no media, never the site's own instead.
	if (services === 'cloud' && !get('CARACMS_CLOUD_KEY')) return { kind: 'unset', missing: [], problems: [...problems, CLOUD_KEY_MISSING_PROBLEM] };
	const cloud = cloudMedia(env, services);
	if (cloud) return cloudMediaConfig(cloud, problems);
	const missing: string[] = [];
	const need = (name: string) => {
		const v = get(name);
		if (!v) missing.push(name);
		return v ?? '';
	};
	const origin = need('CARACMS_MEDIA_URL').replace(/\/+$/, '');
	const key = need('IMGPROXY_KEY');
	const salt = need('IMGPROXY_SALT');
	const bucket = need('S3_BUCKET');
	if (origin && !/^https?:\/\/[^/]+$/.test(origin)) problems.push(`CARACMS_MEDIA_URL must be an origin like https://img.example.com (got "${origin}").`);
	if (key && !HEX.test(key)) problems.push('IMGPROXY_KEY must be hex (the same value imgproxy has).');
	if (salt && !HEX.test(salt)) problems.push('IMGPROXY_SALT must be hex (the same value imgproxy has).');
	if (missing.length || problems.length) return { kind: 'unset', missing, problems };
	return { kind: 'ready', settings: { origin, key, salt, bucket, memory: false } };
}

const FAILED = Symbol.for('caracms.mediaUnsetThrown');
/** True after the first call in this process: a build without the variables throws its sentence once (Media.astro). */
export function failedOnce(): boolean {
	const g = globalThis as { [FAILED]?: true };
	if (g[FAILED]) return true;
	g[FAILED] = true;
	return false;
}

/** The one sentence a render without the variables gives (Decision 5). */
export function mediaUnsetMessage(config: Extract<MediaConfig, { kind: 'unset' }>): string {
	const names = config.missing;
	const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
	const missing = names.length ? `Images can't be built without ${list}: set ${names.length === 1 ? 'it' : 'them'} to the site's imgproxy and media bucket.` : '';
	return [missing, ...config.problems].filter(Boolean).join(' ');
}

/** imgproxy's signature for a path: HMAC-SHA256 with the key, over the salt then the path, base64url. */
export function signPath(path: string, keyHex: string, saltHex: string): string {
	return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(Buffer.from(saltHex, 'hex')).update(path).digest('base64url');
}

/** Does imgproxy resize this key at all? GIFs and SVGs pass through (Decision 2). */
export const isResizable = (key: string): boolean => !/\.(gif|svg)$/i.test(key);

/** A side, rounded and capped; 0 for "not set". */
function side(value: number | undefined): number {
	if (!value || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Math.round(value), IMAGE_MAX_DIMENSION);
}

/** A key as imgproxy's `plain` source takes it, after the cloud folder when there is one: each part percent-encoded, slashes kept. */
const sourceOf = (settings: MediaSettings, key: string) => `s3://${settings.bucket}/${`${settings.prefix ?? ''}${key}`.split('/').map(encodeURIComponent).join('/')}`;

const signed = (settings: MediaSettings, path: string) => `${settings.origin}/${signPath(path, settings.key, settings.salt)}${path}`;

export interface ImageUrlOptions {
	width?: number;
	height?: number;
	/** Default: `fill` with both sides, else `fit`. */
	resize?: 'fit' | 'fill';
	/** The focal point, fractions; used only on a `fill`. */
	focal?: readonly [number, number] | null;
	/** Default: WebP (M9 Decision 8). */
	format?: ImageFormat;
}

/**
 * One signed URL for a key at one size and shape. A GIF or an SVG gets its
 * pass-through URL whatever the options; anything else needs a width or a height.
 */
export function imageUrl(settings: MediaSettings, key: string, options: ImageUrlOptions = {}): string {
	if (!isResizable(key)) return signed(settings, `/plain/${sourceOf(settings, key)}`);
	const width = side(options.width);
	const height = side(options.height);
	if (!width && !height) throw new Error(`An image URL needs a width or a height (${key}).`);
	const resize = options.resize ?? (width && height ? 'fill' : 'fit');
	const gravity = resize === 'fill' && options.focal ? `/g:fp:${options.focal[0]}:${options.focal[1]}` : '';
	return signed(settings, `/rs:${resize}:${width}:${height}${gravity}/q:${IMAGE_QUALITY}/plain/${sourceOf(settings, key)}@${options.format ?? IMAGE_FORMAT}`);
}

/** A slot's part of the ladder: every rung from `min` to `max`, inclusive. */
export function imageWidths(min = IMAGE_WIDTHS[0]!, max = IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1]!): number[] {
	const widths = IMAGE_WIDTHS.filter((w) => w >= min && w <= max);
	if (widths.length === 0) throw new Error(`No ladder width between ${min} and ${max} (ladder: ${IMAGE_WIDTHS.join(', ')}).`);
	return widths;
}

/** A library thumbnail (Phase 2): a `fit` at one rung of the ladder (320 by default), so it shares the page's cache. */
export function thumbnailUrl(settings: MediaSettings, key: string, width = 320): string {
	return imageUrl(settings, key, { width });
}

/** What an `<img>` gets: `src`, the `srcset` and `sizes` (none for a pass-through), and its `width`/`height`. */
export interface ImageAttributes {
	src: string;
	srcset?: string;
	sizes?: string;
	width?: number;
	height?: number;
}

export interface FluidOptions {
	sizes: string;
	/** width / height: crop every rung to it (`rs:fill` with the focal point's gravity). None: `rs:fit`. */
	ratio?: number;
	minWidth?: number;
	maxWidth?: number;
	format?: ImageFormat;
}

export interface FixedOptions {
	/** CSS px. One side: `fit`. Both: `fill`, or `fit` with `fit: 'contain'`. */
	width?: number;
	height?: number;
	fit?: 'cover' | 'contain';
	densities?: readonly number[];
	format?: ImageFormat;
}

const naturalHeight = (image: Pick<RenderImage, 'w' | 'h'>, width: number) => (image.w && image.h ? Math.round((width * image.h) / image.w) : undefined);
const naturalWidth = (image: Pick<RenderImage, 'w' | 'h'>, height: number) => (image.w && image.h ? Math.round((height * image.w) / image.h) : undefined);

/**
 * A fluid image (the width follows the viewport): a `w` srcset over the ladder.
 * `width`/`height` are the stored size, capped at the top rung and scaled to the ratio,
 * so the browser reserves the box (Decision 4).
 */
export function fluidImage(settings: MediaSettings, image: Pick<RenderImage, 'key' | 'focal' | 'w' | 'h'>, options: FluidOptions): ImageAttributes {
	const widths = imageWidths(options.minWidth, options.maxWidth);
	const top = widths[widths.length - 1]!;
	const shownWidth = image.w ? Math.min(image.w, top) : options.ratio ? top : undefined;
	const dims = (w: number | undefined) => {
		if (!w) return {};
		const h = options.ratio ? Math.round(w / options.ratio) : naturalHeight(image, w);
		return h ? { width: w, height: h } : {};
	};
	if (!isResizable(image.key)) return { src: imageUrl(settings, image.key), ...dims(image.w ?? undefined) };
	const at = (w: number) =>
		options.ratio
			? imageUrl(settings, image.key, { width: w, height: Math.round(w / options.ratio), focal: image.focal, format: options.format })
			: imageUrl(settings, image.key, { width: w, format: options.format });
	return {
		src: at(top),
		srcset: widths.map((w) => `${at(w)} ${w}w`).join(', '),
		sizes: options.sizes,
		...dims(shownWidth),
	};
}

/** A fixed image (a set CSS size: a logo, an icon): an `x` srcset at 1×, 2×, 3×. */
export function fixedImage(settings: MediaSettings, image: Pick<RenderImage, 'key' | 'focal' | 'w' | 'h'>, options: FixedOptions): ImageAttributes {
	const { width, height } = options;
	if (!width && !height) throw new Error(`A fixed image needs a width or a height (${image.key}).`);
	const box = { width: width ?? naturalWidth(image, height!), height: height ?? naturalHeight(image, width!) };
	const dims = box.width && box.height ? { width: box.width, height: box.height } : {};
	if (!isResizable(image.key)) return { src: imageUrl(settings, image.key), ...dims };
	const both = !!width && !!height;
	const resize = both && options.fit !== 'contain' ? 'fill' : 'fit';
	const at = (d: number) => imageUrl(settings, image.key, { width: width ? width * d : 0, height: height ? height * d : 0, resize, focal: image.focal, format: options.format });
	const densities = options.densities ?? IMAGE_DENSITIES;
	return { src: at(densities[0] ?? 1), srcset: densities.map((d) => `${at(d)} ${d}x`).join(', '), ...dims };
}

/**
 * One fixed-mode URL for a brand slot (Decision 11): the logo or the tab icon, `fit`
 * at `cssHeight` × 2 (sharp on a 2× screen; the editor's `<img src>` and the icon's
 * `href` take one URL). An SVG passes through. Null when the media isn't set up.
 */
export function brandImageUrl(key: string, cssHeight: number, config: MediaConfig = readMediaConfig()): string | null {
	if (config.kind !== 'ready') return null;
	return imageUrl(config.settings, key, { height: cssHeight * 2 });
}

/**
 * One URL for a Site Settings image, for the page's frame
 * (a header, a footer, a layout), which has no block's `cms` for `<Media>`. Exported from
 * `caracms/content`:
 *
 *   const settings = await siteSettings(site, Astro.locals);
 *   const url = settingsImageUrl(settings.megaPhoto, { width: 640, height: 400 });
 *
 * `value` is the field as `siteSettings` gives it (resolved, M9), or the stored value. The
 * rules are `<Media>`'s: the signed imgproxy URL, `fit` to one side, `fill` to both with the
 * focal point's gravity, a GIF or an SVG passed through unresized, WebP; under
 * `CARACMS_MEDIA=memory` the in-memory media's URL. No size: `fit` at the ladder's top rung.
 * Null for an empty value (or a clip, or a file's key) and when the media isn't set up.
 */
export function settingsImageUrl(value: unknown, options: { width?: number; height?: number } = {}): string | null {
	const image = renderMedia(value, { only: 'image' });
	if (!image || image.kind !== 'image') return null;
	const config = readMediaConfig();
	if (config.kind !== 'ready') return null;
	const width = options.width ?? 0;
	const height = options.height ?? 0;
	const sized = width > 0 || height > 0 ? { width, height } : { width: IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1]! };
	return imageUrl(config.settings, image.key, { ...sized, focal: image.focal });
}
