/**
 * A media slot's stored value (M5b Decision 3): an image or a Mux clip, parsed,
 * written and resolved for the render. Browser-safe (only caracms/files, itself import-free): the editor's
 * fields read it as the server does. URLs that need signing are NOT built here
 * (that's `media.ts`, server-only); a clip's Mux URLs are fixed hosts, so they are.
 *
 *   an image  { "key": "uploads/…/harbour-wall.jpg", "alt": "…", "focal": [0.4, 0.3], "w": 4000, "h": 2667 }
 *   a clip    { "video": "<playback ID>", "play": "loop", "poster": 2.5, "name": "…", "duration": 14.2, "w": 1920, "h": 1080 }
 *
 * - An image is an object with a non-empty string `key`; a clip one with a non-empty
 *   string `video`. Anything else parses as `null` (empty), and the serializer leaves
 *   it in the file untouched unless the field is edited (M3 Decision 7).
 * - `alt` is always written (`""` when there's none). `decorative: true` only when
 *   true, after `alt`, and then `alt` is written as `""` (the alt kept as read until
 *   the field is written; decorative wins at render).
 * - `focal` is `[x, y]`, fractions from the left and the top, 0–1, rounded to two
 *   places; half a pair, a value out of 0–1 or nonsense reads as unset (no warning).
 * - A clip's `play` is `loop` (also what a missing or unknown value reads as) or `player`.
 *
 * Parsing is idempotent (a parsed value parses to itself), which the serializer's
 * "touched?" comparison relies on.
 */
import { isFileKey } from './files.ts';

export type MediaOnly = 'image' | 'video';
export type PlayAs = 'loop' | 'player';

export interface ImageValue {
	key: string;
	alt: string;
	decorative?: true;
	focal?: [number, number];
	w?: number;
	h?: number;
}

export interface ClipValue {
	video: string;
	play: PlayAs;
	poster?: number;
	name?: string;
	duration?: number;
	w?: number;
	h?: number;
}

export type MediaValue = ImageValue | ClipValue;

/** What a block component gets for an image slot (fields.ts → renderValue). */
export interface RenderImage {
	kind: 'image';
	key: string;
	/** `""` for a decorative image, whatever the file says (decorative wins). */
	alt: string;
	decorative: boolean;
	focal: [number, number] | null;
	/** `"40% 30%"` when there's a focal point, else null (no `object-position`). */
	position: string | null;
	w: number | null;
	h: number | null;
}

/** What a block component gets for a clip slot. */
export interface RenderClip {
	kind: 'video';
	playbackId: string;
	/** `loop` whenever the slot is loop-only (`media({ play: 'loop' })`). */
	play: PlayAs;
	name: string;
	/** The MP4 a loop plays: Mux's `highest` static rendition. */
	mp4: string;
	/** Mux's still at `poster` seconds (0, the first frame, when unset), WebP at 1920. */
	poster: string;
	duration: number | null;
	w: number | null;
	h: number | null;
}

export type RenderMedia = RenderImage | RenderClip;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const size = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A focal point as stored: both numbers finite and within 0–1, rounded to two places; otherwise unset. */
export function parseFocal(value: unknown): [number, number] | undefined {
	if (!Array.isArray(value) || value.length !== 2) return undefined;
	const [x, y] = value;
	const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
	return ok(x) && ok(y) ? [round2(x), round2(y)] : undefined;
}

/** Is this an image value (an object with a string `key`)? */
export const isImageValue = (value: unknown): value is ImageValue => isObject(value) && nonEmpty(value.key);
/** Is this a clip value (an object with a string `video`, and no `key`)? */
export const isClipValue = (value: unknown): value is ClipValue => isObject(value) && !nonEmpty(value.key) && nonEmpty(value.video);

/** A raw value as a media value, or null for anything that isn't one. Never throws. */
export function parseMedia(raw: unknown): MediaValue | null {
	if (!isObject(raw)) return null;
	if (nonEmpty(raw.key)) {
		const out: ImageValue = { key: raw.key.trim(), alt: typeof raw.alt === 'string' ? raw.alt : '' };
		if (raw.decorative === true) out.decorative = true;
		const focal = parseFocal(raw.focal);
		if (focal) out.focal = focal;
		const w = size(raw.w);
		const h = size(raw.h);
		if (w !== undefined) out.w = w;
		if (h !== undefined) out.h = h;
		return out;
	}
	if (nonEmpty(raw.video)) {
		const out: ClipValue = { video: raw.video.trim(), play: raw.play === 'player' ? 'player' : 'loop' };
		if (typeof raw.poster === 'number' && Number.isFinite(raw.poster) && raw.poster >= 0) out.poster = raw.poster;
		if (nonEmpty(raw.name)) out.name = raw.name;
		const duration = size(raw.duration);
		const w = size(raw.w);
		const h = size(raw.h);
		if (duration !== undefined) out.duration = duration;
		if (w !== undefined) out.w = w;
		if (h !== undefined) out.h = h;
		return out;
	}
	return null;
}

/** A media value in the order the file stores it (Decision 3): `null` for an empty slot. */
export function mediaToJson(value: unknown): Record<string, unknown> | null {
	const v = parseMedia(value);
	if (!v) return null;
	if ('key' in v) {
		const out: Record<string, unknown> = { key: v.key, alt: v.decorative ? '' : v.alt };
		if (v.decorative) out.decorative = true;
		if (v.focal) out.focal = v.focal;
		if (v.w !== undefined) out.w = v.w;
		if (v.h !== undefined) out.h = v.h;
		return out;
	}
	const out: Record<string, unknown> = { video: v.video, play: v.play };
	if (v.poster !== undefined) out.poster = v.poster;
	if (v.name !== undefined) out.name = v.name;
	if (v.duration !== undefined) out.duration = v.duration;
	if (v.w !== undefined) out.w = v.w;
	if (v.h !== undefined) out.h = v.h;
	return out;
}

/**
 * A media value as one line of JSON, the way the demo's files hold it:
 * `{ "key": "…", "alt": "…", "focal": [0.4, 0.3], "w": 4000, "h": 2667 }`; `null` when empty.
 */
export function mediaLine(value: unknown): string {
	const stored = mediaToJson(value);
	if (!stored) return 'null';
	const part = (v: unknown) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
	return `{ ${Object.entries(stored)
		.map(([k, v]) => `${JSON.stringify(k)}: ${part(v)}`)
		.join(', ')} }`;
}

/** Which kind a value is: `'image'`, `'video'`, or null when empty. */
export function mediaKind(value: unknown): MediaOnly | null {
	const v = parseMedia(value);
	return v ? ('key' in v ? 'image' : 'video') : null;
}

/**
 * The slot's value after picking something new (Decision 3): an image replaces the
 * whole value, not decorative (a new picture may carry meaning), its alt text and
 * focal point the ones given (already used for it, Decision 7) or `""` and none. A clip swapped for a clip keeps its play mode and name (`video.md`) and
 * resets its poster; a clip in an image's slot starts as a loop.
 */
export function pickMedia(previous: unknown, picked: { key: string; w?: number; h?: number; alt?: string; focal?: [number, number] | null } | { video: string; duration?: number; w?: number; h?: number }): MediaValue {
	if ('key' in picked) {
		return parseMedia({ key: picked.key, alt: picked.alt ?? '', focal: picked.focal ?? undefined, w: picked.w, h: picked.h })!;
	}
	const prev = parseMedia(previous);
	const clip = prev && 'video' in prev ? prev : null;
	return parseMedia({ video: picked.video, play: clip?.play ?? 'loop', name: clip?.name, duration: picked.duration, w: picked.w, h: picked.h })!;
}

/** Mux's delivery and thumbnail hosts (fixed for every account). */
export const MUX_STREAM_URL = 'https://stream.mux.com';
export const MUX_IMAGE_URL = 'https://image.mux.com';
/** The poster's width: the ladder's top (Mux upscales on request, so it's a cap too). */
export const MUX_POSTER_WIDTH = 1920;

/** A clip's MP4: the `highest` static rendition (never `1080p`, which is billed). */
export const muxMp4 = (playbackId: string) => `${MUX_STREAM_URL}/${encodeURIComponent(playbackId)}/highest.mp4`;
/** A clip's poster: WebP at 1920, at `time` seconds (0, the first frame, when unset). Never the default PNG. */
export const muxPoster = (playbackId: string, time?: number) =>
	`${MUX_IMAGE_URL}/${encodeURIComponent(playbackId)}/thumbnail.webp?width=${MUX_POSTER_WIDTH}&time=${typeof time === 'number' && Number.isFinite(time) && time >= 0 ? time : 0}`;

/**
 * The render's value for a slot: an image or a clip resolved for the page, or null
 * when the slot is empty or holds a kind it doesn't take (`only`). `play: 'loop'`
 * forces a clip to loop. Takes a stored value, or an already-resolved one.
 */
export function renderMedia(value: unknown, slot: { only?: MediaOnly; play?: 'loop' } = {}): RenderMedia | null {
	// M6c G4 (Decision 4): a file's key written into a media value by hand is no image: nothing, never an imgproxy URL for a PDF.
	if (isObject(value) && isFileKey(typeof value.key === 'string' ? value.key.trim() : null)) return null;
	if (isObject(value) && (value.kind === 'image' || value.kind === 'video') && (typeof value.key === 'string' || typeof value.playbackId === 'string')) {
		const resolved = value as unknown as RenderMedia;
		if (slot.only && slot.only !== resolved.kind) return null;
		return resolved.kind === 'video' && slot.play === 'loop' ? { ...resolved, play: 'loop' } : resolved;
	}
	const v = parseMedia(value);
	if (!v) return null;
	if ('key' in v) {
		if (slot.only === 'video') return null;
		const focal = v.focal ?? null;
		return {
			kind: 'image',
			key: v.key,
			alt: v.decorative ? '' : v.alt.trim(),
			decorative: !!v.decorative,
			focal,
			position: focal ? `${Math.round(focal[0] * 100)}% ${Math.round(focal[1] * 100)}%` : null,
			w: v.w ?? null,
			h: v.h ?? null,
		};
	}
	if (slot.only === 'image') return null;
	return {
		kind: 'video',
		playbackId: v.video,
		play: slot.play === 'loop' ? 'loop' : v.play,
		name: v.name?.trim() ?? '',
		mp4: muxMp4(v.video),
		poster: muxPoster(v.video, v.poster),
		duration: v.duration ?? null,
		w: v.w ?? null,
		h: v.h ?? null,
	};
}

/** The message on an image with no alt text (Decision 9). */
export const MISSING_ALT_MESSAGE = "No alt text yet: people who can't see the picture get nothing";
