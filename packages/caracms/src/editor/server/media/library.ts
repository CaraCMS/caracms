/**
 * The library (M5b Decision 7): the bucket's `uploads/` as `LibraryImage`s, newest first,
 * each with where it's used and an alt text already used for it.
 *
 * - **Where it's used** is worked out from the store on every listing (`mediaUses`): each
 *   document in the store's listing (the `drafts` copy with autosaves in live mode, the
 *   disk in local mode), read whole, any value with an image `key` or a clip `video` in
 *   it, in any block, a kept unknown one and the brand's logo included (the content still
 *   names it, so it's used). **An alt text already used** is the first non-empty one in
 *   the listing's document order, decorative ones skipped (nothing records which was
 *   written last).
 *   **A focal point already set** is chosen the same way, on its own: the first one in the
 *   listing's document order, whether or not that use has the alt text, decorative ones
 *   included (a focal point is a spot on the photo, not on a crop or a meaning).
 * - **Cost:** the bucket's listing is kept per process for 60 seconds, and this process's
 *   own uploads are added at once (an upload from another place the site runs shows within
 *   a minute). **An object's metadata is kept by key for the life of the process**: a key
 *   never changes what it points at. No paging in v1.
 * - **M6c G4: files** (`caracms/files`' types) are listed beside the images, each with the
 *   documents that **link** to it, found by schema (relink.ts → `fileLinksIn`: link fields,
 *   buttons and rich text, in blocks, page fields, fields documents, shared blocks and
 *   Site Settings), so a plain-text mention of its address doesn't count (Decision 8).
 * - **Thumbnails are signed URLs in the listing** (`thumbnail`, `thumbnail2x`: `rs:fit` at
 *   320 and 640, rungs of the page's ladder, so they share its cache). The signing key
 *   never leaves the server; the bucket key is in every image path anyway.
 */
import { join } from 'node:path';
import type { ResolvedSite } from '../../../config.ts';
import { fileTypeOf, isFileKey } from '../../../files.ts';
import { isClipValue, isImageValue, parseFocal } from '../../../media-value.ts';
import { thumbnailUrl, type MediaSettings } from '../../../media.ts';
import { fileLinksIn } from '../../../relink.ts';
import type { FileUse, LibraryFile, LibraryImage, MediaUse } from '../../types.ts';
import type { DraftsStore } from '../drafts-store.ts';
import type { Bucket, BucketObject, ObjectMeta } from './bucket.ts';
import { onMediaReset } from './memory.ts';

/** The prefix every upload goes under (Decision 6). */
export const UPLOADS = 'uploads/';
export const LISTING_TTL_MS = 60_000;
const IMAGE_KEY = /^uploads\/[^/]+\/[^/]+\.(?:jpe?g|png|webp|avif|heic|heif|gif|svg)$/i;
const HEAD_CONCURRENCY = 8;

export interface MediaUses {
	/** Image key → the documents that use it, the first non-empty alt text and the first focal point. */
	images: Map<string, { usedIn: MediaUse[]; alt: string | null; focal: [number, number] | null }>;
	/** Playback ID → the documents that use it. */
	clips: Map<string, MediaUse[]>;
	/** M6c G4: a file's key → the documents that link to it (by schema), with how many links each. */
	files: Map<string, FileUse[]>;
}

/** Every image and clip the store's documents name, and every file they link to, in the listing's order. */
export async function mediaUses(store: DraftsStore, site: Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>): Promise<MediaUses> {
	const entries = await store.list();
	const source = await store.source();
	const texts = await Promise.all(entries.map((e) => source.readText(join(site.root, e.file)).catch(() => null)));
	const images: MediaUses['images'] = new Map();
	const clips: MediaUses['clips'] = new Map();
	const files: MediaUses['files'] = new Map();
	entries.forEach((entry, i) => {
		const text = texts[i];
		if (!text) return;
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return;
		}
		const use: MediaUse = { collection: entry.collection, path: entry.path, title: entry.label };
		const collection = site.collections[entry.collection];
		if (collection) {
			for (const link of fileLinksIn(text, site, collection)) {
				let list = files.get(link.key);
				if (!list) files.set(link.key, (list = []));
				const mine = list.find((u) => u.collection === use.collection && u.path === use.path);
				if (mine) mine.links++;
				else list.push({ ...use, links: 1 });
			}
		}
		const add = (list: MediaUse[]) => {
			if (!list.some((u) => u.collection === use.collection && u.path === use.path)) list.push(use);
		};
		walk(raw, (value) => {
			if (isImageValue(value)) {
				const key = value.key.trim();
				let found = images.get(key);
				if (!found) images.set(key, (found = { usedIn: [], alt: null, focal: null }));
				add(found.usedIn);
				const alt = typeof value.alt === 'string' ? value.alt.trim() : '';
				if (found.alt === null && alt && value.decorative !== true) found.alt = alt;
				found.focal ??= parseFocal(value.focal) ?? null;
				return true;
			}
			if (isClipValue(value)) {
				const playbackId = value.video.trim();
				let found = clips.get(playbackId);
				if (!found) clips.set(playbackId, (found = []));
				add(found);
				return true;
			}
			return false;
		});
	});
	return { images, clips, files };
}

/** Every object and array in `value`, depth first in document order; `visit` returning true stops the descent there. */
function walk(value: unknown, visit: (value: Record<string, unknown>) => boolean, depth = 0): void {
	if (depth > 64 || !value || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit, depth + 1);
		return;
	}
	const object = value as Record<string, unknown>;
	if (visit(object)) return;
	for (const child of Object.values(object)) walk(child, visit, depth + 1);
}

/** The bucket's listing and metadata, cached as Decision 7 says. One per bucket, per process. */
export class Library {
	private listing: { at: number; objects: Map<string, BucketObject> } | null = null;
	private loading: Promise<Map<string, BucketObject>> | null = null;
	private readonly meta = new Map<string, ObjectMeta>();

	readonly bucket: Bucket;
	private readonly now: () => number;

	constructor(bucket: Bucket, now: () => number = () => Date.now()) {
		this.bucket = bucket;
		this.now = now;
	}

	/** The objects under `uploads/`: the bucket's listing, at most 60 s old, with this process's uploads in it. */
	async objects(): Promise<BucketObject[]> {
		if (!this.listing || this.now() - this.listing.at >= LISTING_TTL_MS) {
			this.loading ??= this.bucket
				.list(UPLOADS)
				.then((list) => {
					const objects = new Map(list.filter((o) => IMAGE_KEY.test(o.key) || isFileKey(o.key)).map((o) => [o.key, o]));
					// An upload this process made while the listing was on its way stays in it.
					for (const [key, o] of this.listing?.objects ?? []) if (!objects.has(key) && this.meta.has(key)) objects.set(key, o);
					this.listing = { at: this.now(), objects };
					return objects;
				})
				.finally(() => {
					this.loading = null;
				});
			await this.loading;
		}
		return [...this.listing!.objects.values()];
	}

	/** An object's metadata: kept for the process once read (a key never changes). Null: no such object. */
	async metaOf(key: string): Promise<ObjectMeta | null> {
		const kept = this.meta.get(key);
		if (kept) return kept;
		const meta = await this.bucket.head(key);
		if (meta) this.meta.set(key, meta);
		return meta;
	}

	/** This process's own upload: in the listing and the metadata at once. */
	added(key: string, meta: ObjectMeta): void {
		this.meta.set(key, meta);
		this.listing?.objects.set(key, { key, lastModified: meta.lastModified, size: meta.size });
	}

	/** The library's images, newest first, each with where it's used. */
	async images(signing: MediaSettings, uses: MediaUses): Promise<LibraryImage[]> {
		return (await this.read((key) => !isFileKey(key))).map(([key, meta]) => entryOf(signing, key, meta, uses));
	}

	/** M6c G4: the library's files, newest first, each with what links to it. */
	async files(uses: MediaUses): Promise<LibraryFile[]> {
		return (await this.read(isFileKey)).map(([key, meta]) => fileEntryOf(key, meta, uses));
	}

	/** The listing's objects that `which` keeps, with their metadata, newest first (one gone since the listing is left out). */
	private async read(which: (key: string) => boolean): Promise<[string, ObjectMeta][]> {
		const objects = (await this.objects()).filter((o) => which(o.key));
		const metas = await mapLimit(objects, HEAD_CONCURRENCY, (o) => this.metaOf(o.key));
		const out: [string, ObjectMeta][] = [];
		objects.forEach((o, i) => {
			const meta = metas[i];
			if (meta === null) return; // gone between listing and reading: not shown
			out.push([o.key, { ...meta!, lastModified: o.lastModified ?? meta!.lastModified, size: o.size ?? meta!.size }]);
		});
		return out.sort(([ak, a], [bk, b]) => (b.lastModified ?? '').localeCompare(a.lastModified ?? '') || ak.localeCompare(bk));
	}
}

/** M6c G4: one file's library entry. */
export function fileEntryOf(key: string, meta: ObjectMeta, uses: MediaUses): LibraryFile {
	return {
		kind: 'file',
		key,
		name: meta.name || key.slice(key.lastIndexOf('/') + 1),
		type: fileTypeOf(key)?.label ?? '',
		bytes: meta.size,
		uploadedAt: meta.lastModified,
		by: meta.by || null,
		usedIn: uses.files.get(key) ?? [],
	};
}

/** One image's library entry. */
export function entryOf(signing: MediaSettings, key: string, meta: ObjectMeta, uses: MediaUses): LibraryImage {
	const used = uses.images.get(key);
	return {
		kind: 'image',
		key,
		name: meta.name || key.slice(key.lastIndexOf('/') + 1),
		w: meta.w,
		h: meta.h,
		bytes: meta.size,
		uploadedAt: meta.lastModified,
		by: meta.by || null,
		thumbnail: thumbnailUrl(signing, key, 320),
		thumbnail2x: thumbnailUrl(signing, key, 640),
		usedIn: used?.usedIn ?? [],
		alt: used?.alt ?? null,
		focal: used?.focal ?? null,
	};
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

const SHARED = Symbol.for('caracms.mediaLibraries');
type Shared = { [SHARED]?: Map<string, Library> };

/** The process's library for a bucket (by `id`: `memory`, or the endpoint, bucket and access key). */
export function libraryFor(id: string, make: () => Bucket): Library {
	const g = globalThis as Shared;
	if (!g[SHARED]) {
		g[SHARED] = new Map();
		const libraries = g[SHARED];
		onMediaReset(() => libraries.clear());
	}
	let library = g[SHARED].get(id);
	if (!library) g[SHARED].set(id, (library = new Library(make())));
	return library;
}
