/**
 * The media library in the browser (M5b Phase 3; Decisions 6, 7 and 12): one per editor,
 * `mediaFor(editor)`, made on first use. What the media field, the library level and the
 * stage's drop target read and call.
 *
 *   const media = mediaFor(editor);
 *   media.images / media.clips      the library, newest first: last-known while a refetch runs (never a skeleton)
 *   media.files                     M6c G4: the library's files (PDF, Office, CSV, zip), from the images listing
 *   media.loadImages() / loadClips() read it again (the server keeps its listing 60 s)
 *   media.upload(files, slot?)      images to the bucket (through the site's server, with real progress),
 *                                   clips straight to Mux (UpChunk), then polled until they can play
 *   media.place(slot, entry)        Decision 3's value through `pickMedia`, written with `doc.setField`
 *   media.showUnused                the unused toggle, remembered per browser (localStorage)
 *   media.placed                    the last placement, for Phase 4's ask for alt text
 *   media.refused                   the library's refused files, kept while the library is open
 *
 * - **Signing never reaches the browser**: every image URL here is one the server signed
 *   (the listing's `thumbnail`, or the thumbnail route's redirect, `thumbnailSrc`).
 * - **Nothing is ever deleted**, here or on the server. Remove in a slot only clears it.
 * - **Several files dropped on one slot**: the first the slot takes is placed, the rest go
 *   to the library. A clip on an image-only slot, alone, gets Decision 6's sentence.
 * - **A clip is placeable only when it can play** (`LibraryClip.ready`: the asset and its
 *   `highest` MP4).
 * - Uploads, the library and the toggle need no lock; placing is an edit (the document
 *   store refuses it when the document is read-only).
 */
import { getAtPath } from '../../../fields.ts';
import { fileTypeOf } from '../../../files.ts';
import { pickMedia, type MediaOnly, type MediaValue } from '../../../media-value.ts';
import {
	MEDIA_ENDPOINTS,
	MEDIA_NAME_HEADER,
	VIDEO_ON_IMAGE_SLOT_MESSAGE,
	type LibraryClip,
	type LibraryFile,
	type LibraryImage,
	type MediaClipsResponse,
	type MediaFileUploadResponse,
	type MediaImagesResponse,
	type MediaUnset,
	type MediaUploadResponse,
	type VideoUploadResponse,
	type VideoUploadStatus,
} from '../../types.ts';
import type { Editor } from '../editor.ts';
import { createStore, type Store } from '../state/store.ts';

/** A slot: the host's scope (a block's key, or a form's) and a dotted path in it. */
export interface SlotRef {
	scope: string;
	path: string;
}

/** A slot and what it takes. */
export interface SlotTarget extends SlotRef {
	only?: MediaOnly;
	play?: 'loop';
	/** A list's Add image: one of several picked in a row, each asked for its alt text in turn. */
	multi?: boolean;
	/** The media field's `altFrom`: the text field beside the slot whose words start an image's empty alt. */
	altFrom?: string;
}

/** The words of the text field `name` beside the slot at `path` (`rows.2.image` → `rows.2.<name>`), on one line. */
export function siblingWords(data: Record<string, unknown>, path: string, name: string): string {
	const value = getAtPath(data, `${path.slice(0, path.lastIndexOf('.') + 1)}${name}`);
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export const slotKey = (slot: SlotRef): string => `${slot.scope}\u0000${slot.path}`;

export interface Listing<T> {
	/** Null until the first answer. */
	list: T[] | null;
	/** The route answered 503: its sentence (Decision 5). */
	unset: MediaUnset | null;
	/** The last read failed (the list stays as it was). */
	error: string | null;
}

export interface MediaUpload {
	id: string;
	name: string;
	/** `file`: one of caracms/files' types by its name (M6c G4); the server reads the bytes either way. */
	kind: 'image' | 'clip' | 'file';
	/** Its size in bytes, for a file row's "8.2 MB". */
	bytes: number;
	/** 0–100: real progress (bytes sent), never a skeleton. */
	pct: number;
	/** `up` sending, `proc` Mux getting it ready to play, `failed`. */
	phase: 'up' | 'proc' | 'failed';
	/** An object URL of the file itself when the browser can show it (never a HEIC), else null. */
	preview: string | null;
	/** Why it failed, a sentence to act on. */
	error: string | null;
	/** The slot it goes into when done (slotKey), or null for the library. */
	slot: string | null;
}

export interface Refusal {
	id: string;
	name: string;
	message: string;
}

/** The last placement: Phase 4 asks for alt text on it (focus the slot's alt input). */
export interface Placed {
	scope: string;
	path: string;
	kind: 'image' | 'clip';
	/** The alt text it came with (an alt already used for it), or "". */
	alt: string;
	/** Where that alt came from (a document's title), when it did. */
	altFrom: string | null;
	/** Rises with each placement, so the same slot placed twice is seen twice. */
	n: number;
	/** One of several picked in a row from a list's Add image (the gallery). */
	multi: boolean;
}

export interface MediaLibrary {
	images: Store<Listing<LibraryImage>>;
	clips: Store<Listing<LibraryClip>>;
	/** M6c G4: the library's files, read with the images (one listing). */
	files: Store<Listing<LibraryFile>>;
	uploads: Store<MediaUpload[]>;
	/** Files the library refused (a library drop or Upload…), each with its sentence. */
	refused: Store<Refusal[]>;
	/** A refusal at a slot (a clip on an image-only slot, a PDF), by slotKey. */
	slotNotes: Store<ReadonlyMap<string, string>>;
	showUnused: Store<boolean>;
	/** Keys (and `clip:<asset id>`) uploaded in this tab: always shown, marked "Just added" (a file "Just uploaded"). */
	fresh: Store<ReadonlySet<string>>;
	placed: Store<Placed | null>;
	loadImages(): Promise<void>;
	loadClips(): Promise<void>;
	/** Upload files: into `slot` (the first it takes), the rest into the library. */
	upload(files: readonly File[], slot?: SlotTarget | null): void;
	/**
	 * M6c G4: upload one file for a link's picker or Replace…: real progress in `uploads`
	 * (its row keyed by `tag`), then the file's entry (`created` false: those bytes were
	 * already in the library), or a refusal's sentence.
	 */
	uploadFile(file: File, tag: string): Promise<{ ok: true; file: LibraryFile; created: boolean } | { ok: false; error: string }>;
	/** An image's Replace…: upload one image, real progress in `uploads` (keyed by `tag`), then its entry, or a refusal's sentence (a file is refused). */
	uploadImage(file: File, tag: string): Promise<{ ok: true; image: LibraryImage } | { ok: false; error: string }>;
	/** Put a library entry in a slot (Decision 3's value). False when it can't be placed (a clip not ready, a kind the slot doesn't take, read-only). */
	place(slot: SlotTarget, entry: LibraryImage | LibraryClip): boolean;
	setShowUnused(on: boolean): void;
	dismissRefused(id: string): void;
	/** Stop an upload (Cancel) or forget a failed one (Dismiss). */
	dismissUpload(id: string): void;
	clearSlotNote(slot: SlotRef): void;
}

const made = new WeakMap<Editor, MediaLibrary>();

/** The thumbnail of an image a slot holds, through the server's signing redirect (a ladder width). */
export const thumbnailSrc = (key: string, width = 320): string => `${MEDIA_ENDPOINTS.thumbnail}?key=${encodeURIComponent(key)}&width=${width}`;

/** A clip's still at `time` seconds, small (Mux's thumbnail host; no signing). */
export const clipStill = (playbackId: string, time?: number, width = 320): string =>
	`https://image.mux.com/${encodeURIComponent(playbackId)}/thumbnail.webp?width=${width}&time=${typeof time === 'number' && Number.isFinite(time) && time >= 0 ? time : 0}`;

export const clipId = (clip: Pick<LibraryClip, 'id'>): string => `clip:${clip.id}`;

/** What a dropped or chosen file is, by its type and name (the server checks the bytes). */
export function fileKind(file: Pick<File, 'name' | 'type'>): 'image' | 'clip' | 'file' | null {
	const ext = (/\.(\w+)$/.exec(file.name.toLowerCase()) ?? [, ''])[1];
	const type = file.type || '';
	if (/^(jpe?g|png|webp|avif|heic|heif|gif|svg)$/.test(ext!) || /^image\//.test(type)) return 'image';
	if (/^(mov|mp4|m4v|webm|mkv|avi)$/.test(ext!) || type.startsWith('video/')) return 'clip';
	if (fileTypeOf(file.name)) return 'file';
	return null;
}

/** "1.8 MB", "64 KB": a file's size as the library's rows show it (the 40 MB cap counts 1,000,000 bytes to the MB). */
export function fileSize(bytes: number | null): string {
	if (bytes === null || !Number.isFinite(bytes)) return '';
	if (bytes < 1000) return `${bytes} bytes`;
	if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
	return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** A slot's note for a file dropped on it: it went into the library under Files (a slot never takes a file). */
export const FILE_ON_SLOT = "This slot doesn't take files.";

/** Can the browser show this file as it is (for the upload's own preview)? Never a HEIC; never an SVG inlined. */
const showable = (file: File) => /^image\/(jpeg|png|webp|gif|avif)$/.test(file.type || '');

/** The body's Content-Type: the file's own when it's an image, else octet-stream (Astro's origin check answers a form type first). */
const bodyType = (file: File) => (/^image\//.test(file.type) ? file.type : 'application/octet-stream');

const UPLOAD_POLL_MS = 2000;
const ASSET_POLL_MS = 3000;
const LIBRARY_POLL_MS = 3000;
const UNUSED_KEY = (site: string) => `caracms:media-show-unused:${site}`;

const FAILED_REACH = "The upload didn't reach the server, so nothing was stored. Try again.";

export function mediaFor(editor: Editor): MediaLibrary {
	const existing = made.get(editor);
	if (existing) return existing;

	const images = createStore<Listing<LibraryImage>>({ list: null, unset: editor.mediaSetup.get().images, error: null });
	const clips = createStore<Listing<LibraryClip>>({ list: null, unset: editor.mediaSetup.get().clips, error: null });
	const files = createStore<Listing<LibraryFile>>({ list: null, unset: editor.mediaSetup.get().images, error: null });
	const uploads = createStore<MediaUpload[]>([]);
	const refused = createStore<Refusal[]>([]);
	const slotNotes = createStore<ReadonlyMap<string, string>>(new Map());
	const fresh = createStore<ReadonlySet<string>>(new Set());
	const placed = createStore<Placed | null>(null);
	const showUnused = createStore<boolean>(readShowUnused(editor.site.storageKey));
	const cancels = new Map<string, () => void>();
	let n = 0;
	let placedN = 0;
	const nextId = () => `up-${++n}`;

	const setUnset = (side: 'images' | 'clips', unset: MediaUnset) => {
		editor.mediaSetup.update({ [side]: unset });
		(side === 'images' ? images : clips).update({ unset } as never);
		// Files share the bucket with images: one unset, both.
		if (side === 'images') files.update({ unset });
	};

	let imagesInFlight: Promise<void> | null = null;
	async function loadImages(): Promise<void> {
		if (imagesInFlight) return imagesInFlight;
		imagesInFlight = (async () => {
			try {
				const response = await fetch(MEDIA_ENDPOINTS.images, { credentials: 'same-origin' });
				const body = (await response.json().catch(() => null)) as MediaImagesResponse | MediaUnset | null;
				if (response.status === 503 && body && 'code' in body) return setUnset('images', body as MediaUnset);
				if (!response.ok || !body || !('images' in body)) {
					const error = (body as { error?: string } | null)?.error ?? `The library didn't answer (${response.status}).`;
					images.update({ error });
					files.update({ error });
					return;
				}
				images.set({ list: body.images, unset: null, error: null });
				files.set({ list: body.files ?? [], unset: null, error: null });
			} catch {
				images.update({ error: "Can't reach the server for the library." });
				files.update({ error: "Can't reach the server for the library." });
			} finally {
				imagesInFlight = null;
			}
		})();
		return imagesInFlight;
	}

	let clipsInFlight: Promise<void> | null = null;
	async function loadClips(): Promise<void> {
		if (clipsInFlight) return clipsInFlight;
		clipsInFlight = (async () => {
			try {
				const response = await fetch(MEDIA_ENDPOINTS.clips, { credentials: 'same-origin' });
				const body = (await response.json().catch(() => null)) as MediaClipsResponse | MediaUnset | null;
				if (response.status === 503 && body && 'code' in body) return setUnset('clips', body as MediaUnset);
				if (!response.ok || !body || !('clips' in body)) {
					clips.update({ error: (body as { error?: string } | null)?.error ?? `Mux didn't answer (${response.status}).` });
					return;
				}
				clips.set({ list: body.clips, unset: null, error: null });
			} catch {
				clips.update({ error: "Can't reach the server for the clips." });
			} finally {
				clipsInFlight = null;
				scheduleClipPoll();
			}
		})();
		return clipsInFlight;
	}

	// While the library (or a picker) is open and a clip is still processing at Mux, ask again (the template's poll).
	let clipPoll: ReturnType<typeof setTimeout> | null = null;
	function scheduleClipPoll() {
		if (clipPoll || typeof window === 'undefined') return;
		const processing = (clips.get().list ?? []).some((c) => !c.ready && !c.errored);
		if (!processing || editor.view.get().level !== 'media') return;
		clipPoll = setTimeout(() => {
			clipPoll = null;
			if (editor.view.get().level === 'media') void loadClips();
		}, LIBRARY_POLL_MS);
	}
	editor.view.subscribe((view, before) => {
		if (view.level === 'media' && before.level !== 'media') scheduleClipPoll();
		// A refused file is said where it was dropped: gone once the library is left or a slot's picker opens.
		const left = before.level === 'media' && view.level !== 'media';
		const picking = !!view.media?.pick && !before.media?.pick;
		if ((left || picking) && refused.get().length) refused.set([]);
	});

	// M6c G4 (Decision 10): the first time an opened document holds a /files/ link, the library
	// is read once (the server answers from its cached listing), so its file keys can say which
	// links point at a file that isn't there. Not on every load: most documents link to none.
	let askedForFiles = false;
	const watchFiles = (base: string) => {
		if (askedForFiles || files.get().list || !base.includes('/files/')) return;
		askedForFiles = true;
		void loadImages();
	};
	watchFiles(editor.doc.get().base ?? '');
	editor.doc.subscribe((session) => watchFiles(session.base ?? ''));

	const patchUpload = (id: string, patch: Partial<MediaUpload>) => uploads.set((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));
	const dropUpload = (id: string) => {
		const u = uploads.get().find((x) => x.id === id);
		if (u?.preview) URL.revokeObjectURL(u.preview);
		cancels.delete(id);
		uploads.set((list) => list.filter((x) => x.id !== id));
	};
	const refuse = (name: string, message: string) => refused.set((list) => [{ id: nextId(), name, message }, ...list]);
	const noteSlot = (slot: SlotRef, message: string | null) =>
		slotNotes.set((map) => {
			const next = new Map(map);
			if (message) next.set(slotKey(slot), message);
			else next.delete(slotKey(slot));
			return next;
		});
	const markFresh = (id: string) => fresh.set((set) => new Set([...set, id]));

	function place(slot: SlotTarget, entry: LibraryImage | LibraryClip): boolean {
		if (editor.access.get().readOnly) return false;
		const block = editor.doc.block(slot.scope);
		if (!block) return false;
		const previous = getAtPath(block.data, slot.path);
		let value: MediaValue;
		let alt = '';
		let altFrom: string | null = null;
		if ('key' in entry) {
			if (slot.only === 'video') return false;
			alt = entry.alt ?? '';
			altFrom = entry.alt ? (entry.usedIn[0]?.title ?? null) : null;
			// An image with no alt of its own starts with the field's `altFrom` sibling's words (a screenshot's "What to capture").
			if (!alt && slot.altFrom) alt = siblingWords(block.data, slot.path, slot.altFrom);
			value = pickMedia(previous, { key: entry.key, w: entry.w ?? undefined, h: entry.h ?? undefined, alt, focal: entry.focal });
		} else {
			if (slot.only === 'image' || !entry.ready || !entry.playbackId) return false;
			value = pickMedia(previous, { video: entry.playbackId, duration: entry.duration ?? undefined, w: entry.w ?? undefined, h: entry.h ?? undefined });
			// A loop-only slot (the hero) stores "play": "loop" (Decision 3).
			if (slot.play === 'loop' && 'video' in value) value = { ...value, play: 'loop' };
		}
		editor.doc.setField(slot.scope, slot.path, value);
		noteSlot(slot, null);
		placed.set({ scope: slot.scope, path: slot.path, kind: 'key' in entry ? 'image' : 'clip', alt, altFrom, n: ++placedN, multi: !!slot.multi });
		editor.announce(`${'key' in entry ? entry.name : (entry.title ?? 'The clip')} placed`);
		return true;
	}

	function addImage(image: LibraryImage) {
		const list = images.get().list ?? [];
		images.update({ list: [image, ...list.filter((x) => x.key !== image.key)] });
		markFresh(image.key);
	}

	function addFile(entry: LibraryFile) {
		const list = files.get().list ?? [];
		files.update({ list: [entry, ...list.filter((x) => x.key !== entry.key)] });
		markFresh(entry.key);
	}

	type Sent = { ok: true; image: LibraryImage } | { ok: true; file: LibraryFile; created: boolean } | { ok: false; error: string; aborted?: boolean };

	/**
	 * Send one file's bytes to the upload route, its row in `uploads` showing real progress
	 * (`id`, gone once it answers). The answer: the image or the file the server made of it, or why not.
	 */
	function send(file: File, id: string, slot: SlotTarget | null): Promise<Sent> {
		const kind = fileKind(file) === 'file' ? 'file' : 'image';
		uploads.set((list) => [{ id, name: file.name, kind, bytes: file.size, pct: 0, phase: 'up', preview: kind === 'image' && showable(file) ? URL.createObjectURL(file) : null, error: null, slot: slot ? slotKey(slot) : null }, ...list]);
		return new Promise<Sent>((resolve) => {
			const xhr = new XMLHttpRequest();
			cancels.set(id, () => xhr.abort());
			xhr.open('POST', MEDIA_ENDPOINTS.upload);
			xhr.setRequestHeader('Content-Type', bodyType(file));
			xhr.setRequestHeader(MEDIA_NAME_HEADER, encodeURIComponent(file.name));
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) patchUpload(id, { pct: Math.min(99, Math.round((event.loaded / event.total) * 100)) });
			};
			const done = (sent: Sent) => {
				dropUpload(id);
				resolve(sent);
			};
			xhr.onerror = () => done({ ok: false, error: FAILED_REACH });
			xhr.onabort = () => done({ ok: false, error: '', aborted: true });
			xhr.onload = () => {
				let body: unknown = null;
				try {
					body = JSON.parse(xhr.responseText);
				} catch {
					/* below */
				}
				if (xhr.status === 503 && body && typeof body === 'object' && 'code' in body) {
					setUnset('images', body as MediaUnset);
					return done({ ok: false, error: (body as MediaUnset).error });
				}
				if ((xhr.status === 200 || xhr.status === 201) && body && typeof body === 'object') {
					if ('image' in body) return done({ ok: true, image: (body as MediaUploadResponse).image });
					if ('file' in body) {
						const answer = body as MediaFileUploadResponse;
						return done({ ok: true, file: answer.file, created: answer.created });
					}
				}
				const error = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null;
				done({ ok: false, error: xhr.status === 401 ? 'You were signed out, so nothing was stored. Sign in again, then upload it.' : (error ?? `The server didn't take it (${xhr.status}).`) });
			};
			xhr.send(file);
		});
	}

	function startImage(file: File, slot: SlotTarget | null) {
		void send(file, nextId(), slot).then((sent) => {
			if (!sent.ok) {
				if (sent.aborted) return;
				if (slot) noteSlot(slot, sent.error);
				else refuse(file.name, sent.error);
				return;
			}
			if ('image' in sent) {
				addImage(sent.image);
				if (slot) place(slot, sent.image);
				return;
			}
			// M6c G4: a file. Into the library under Files; a slot says where it went (a slot never takes a file).
			addFile(sent.file);
			if (slot) noteSlot(slot, FILE_ON_SLOT);
			else if (editor.view.get().level === 'media' && !editor.view.get().media?.pick) editor.view.update({ media: { ...(editor.view.get().media ?? { pick: null, item: null, tab: 'files' }), tab: 'files' } });
		});
	}

	async function getJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
		const response = await fetch(url, { credentials: 'same-origin', ...init });
		const body = (await response.json().catch(() => null)) as T | null;
		return { status: response.status, body };
	}

	const wait = (ms: number, signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			if (signal.aborted) return reject(new Error('aborted'));
			const timer = setTimeout(resolve, ms);
			signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
		});

	function startClip(file: File, slot: SlotTarget | null) {
		const id = nextId();
		const controller = new AbortController();
		const { signal } = controller;
		let abortUpload: (() => void) | null = null;
		cancels.set(id, () => {
			controller.abort();
			abortUpload?.();
		});
		uploads.set((list) => [{ id, name: file.name, kind: 'clip', bytes: file.size, pct: 0, phase: 'up', preview: null, error: null, slot: slot ? slotKey(slot) : null }, ...list]);
		const failed = (error: string) => patchUpload(id, { phase: 'failed', error });

		void (async () => {
			// 1. A Mux direct upload for this site's origin; the token stays on the server.
			let created: { status: number; body: (VideoUploadResponse & Partial<MediaUnset>) | null };
			try {
				created = await getJson<VideoUploadResponse & Partial<MediaUnset>>(MEDIA_ENDPOINTS.videoUpload, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: file.name }),
					signal,
				});
			} catch {
				if (!signal.aborted) failed(FAILED_REACH);
				return;
			}
			if (signal.aborted) return;
			if (created.status === 503 && created.body?.code) {
				setUnset('clips', created.body as MediaUnset);
				failed(created.body.error ?? "Clips aren't set up here.");
				return;
			}
			if (created.status !== 201 || !created.body?.url) {
				failed(created.body?.error ?? `The server couldn't start the upload (${created.status}).`);
				return;
			}
			const { id: uploadId, url } = created.body;

			// 2. The file straight to Mux, chunked and resumable (UpChunk, as the template does).
			const sent = await new Promise<boolean>((resolve) => {
				signal.addEventListener('abort', () => resolve(false), { once: true });
				import('@mux/upchunk')
					.then(({ createUpload }) => {
						if (signal.aborted) return resolve(false);
						// 30 MB chunks (UpChunk counts in KB): few requests, and a retried chunk is still small.
						const up = createUpload({ endpoint: url, file, chunkSize: 30 * 1024, attempts: 8, delayBeforeAttempt: 2 });
						abortUpload = () => up.abort();
						up.on('progress', (event) => patchUpload(id, { pct: Math.min(99, Math.round(Number(event.detail) || 0)) }));
						up.on('error', (event) => {
							const detail = event.detail as { message?: unknown } | undefined;
							failed(`The upload to Mux stopped${typeof detail?.message === 'string' && detail.message ? `: ${detail.message}` : ''}. Try again.`);
							resolve(false);
						});
						up.on('success', () => resolve(true));
					})
					.catch(() => {
						failed('The uploader could not start. Reload the editor and try again.');
						resolve(false);
					});
			});
			if (!sent || signal.aborted) return;
			patchUpload(id, { phase: 'proc', pct: 100 });

			// 3. Poll the upload until Mux has made an asset from it, then the asset until it can play.
			let assetId: string | null = null;
			try {
				while (!assetId) {
					await wait(UPLOAD_POLL_MS, signal);
					const status = await getJson<VideoUploadStatus>(`${MEDIA_ENDPOINTS.videoUpload}/${encodeURIComponent(uploadId)}`).catch(() => null);
					if (!status || status.status !== 200 || !status.body) continue;
					if (status.body.assetId) assetId = status.body.assetId;
					else if (status.body.status === 'errored' || status.body.status === 'cancelled' || status.body.status === 'timed_out') {
						failed(status.body.error ? `Mux couldn't take it: ${status.body.error}` : "Mux couldn't read it as a video. Export it again as an MP4 or MOV and upload that.");
						return;
					}
				}
				for (let first = true; ; first = false) {
					if (!first) await wait(ASSET_POLL_MS, signal);
					const result = await getJson<LibraryClip>(`${MEDIA_ENDPOINTS.clips}/${encodeURIComponent(assetId)}`).catch(() => null);
					if (!result || result.status !== 200 || !result.body) continue;
					const clip = result.body;
					if (clip.errored) {
						failed(clip.error ?? "Mux couldn't read it as a video. Export it again as an MP4 or MOV and upload that.");
						return;
					}
					if (!clip.ready) continue;
					dropUpload(id);
					const list = clips.get().list ?? [];
					clips.update({ list: [clip, ...list.filter((c) => c.id !== clip.id)] });
					markFresh(clipId(clip));
					if (slot) place(slot, clip);
					return;
				}
			} catch {
				// Cancelled.
			}
		})();
	}

	const library: MediaLibrary = {
		images,
		clips,
		files,
		uploads,
		refused,
		slotNotes,
		showUnused,
		fresh,
		placed,
		loadImages,
		loadClips,
		upload(files, slot = null) {
			let slotTaken = !slot;
			let refusedAtSlot: string | null = null;
			for (const file of files) {
				const kind = fileKind(file);
				if (!slotTaken && slot) {
					if (kind === 'clip') {
						if (slot.only !== 'image') {
							slotTaken = true;
							noteSlot(slot, null);
							startClip(file, slot);
							continue;
						}
						// A clip on an image-only slot: said at the slot, unless a later file fits. Alone, it goes nowhere.
						refusedAtSlot ??= VIDEO_ON_IMAGE_SLOT_MESSAGE;
						if (files.length === 1) continue;
					} else if (slot.only !== 'video') {
						// An image, or a file whose type the name doesn't say: the server reads its bytes, and its refusal shows at the slot.
						slotTaken = true;
						noteSlot(slot, null);
						startImage(file, slot);
						continue;
					}
				}
				// The library's own: an image to the bucket (the server says why one is refused), a clip to Mux.
				if (kind === 'clip') {
					startClip(file, null);
					if (editor.view.get().level === 'media') editor.view.update({ media: { ...(editor.view.get().media ?? { pick: null, item: null, tab: 'clips' }), tab: 'clips' } });
				} else startImage(file, null);
			}
			if (slot && !slotTaken && refusedAtSlot) noteSlot(slot, refusedAtSlot);
		},
		place,
		async uploadFile(file, tag) {
			const sent = await send(file, tag, null);
			if (!sent.ok) return { ok: false, error: sent.aborted ? '' : sent.error };
			if ('image' in sent) {
				addImage(sent.image);
				return { ok: false, error: 'A link takes a file, not an image.' };
			}
			addFile(sent.file);
			return { ok: true, file: sent.file, created: sent.created };
		},
		async uploadImage(file, tag) {
			if (fileKind(file) !== 'image') return { ok: false, error: 'An image is replaced by an image. Choose a JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG.' };
			const sent = await send(file, tag, null);
			if (!sent.ok) return { ok: false, error: sent.aborted ? '' : sent.error };
			if ('file' in sent) {
				addFile(sent.file);
				return { ok: false, error: 'An image is replaced by an image, not a file.' };
			}
			addImage(sent.image);
			return { ok: true, image: sent.image };
		},
		setShowUnused(on) {
			showUnused.set(on);
			try {
				window.localStorage.setItem(UNUSED_KEY(editor.site.storageKey), on ? '1' : '0');
			} catch {
				/* the toggle still works for this tab */
			}
		},
		dismissRefused(id) {
			refused.set((list) => list.filter((r) => r.id !== id));
		},
		dismissUpload(id) {
			const cancel = cancels.get(id);
			cancel?.();
			dropUpload(id);
		},
		clearSlotNote(slot) {
			noteSlot(slot, null);
		},
	};
	made.set(editor, library);
	return library;
}

/** Show unused: on by default (Decision 7), remembered per browser. */
function readShowUnused(site: string): boolean {
	try {
		return typeof window === 'undefined' ? true : window.localStorage.getItem(UNUSED_KEY(site)) !== '0';
	} catch {
		return true;
	}
}
