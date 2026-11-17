/**
 * `POST /_caracms/media/upload` (M5b Decision 6): one image, or (M6c G4) one file, through the site's server.
 * A security boundary: it takes bytes and a name from the browser and writes to the
 * bucket that every place the site runs shares, append-only.
 *
 * 1. **The body is buffered in memory up to 40 MB and refused the moment it passes**:
 *    a Content-Length over the cap is refused before a byte is read, and the read itself
 *    stops at the cap whatever the header said (it's not trusted). Not streamed to the
 *    bucket: the key comes from the file's hash, known only at the last byte.
 * 2. **The type is the bytes'** (sniff.ts), never the name's or the Content-Type's
 *    (save Decision 1's two narrow exceptions, a legacy Office file and a CSV, sniff.ts).
 * 3. **At most 50 megapixels** (imgproxy's limit), counted as shown; an SVG has no pixels.
 * 4. **The key is `uploads/<first 12 hex of SHA-256>/<the name, slugified>.<ext>`**, with
 *    `<ext>` from the detected type (a HEIC called `photo.jpg` is `photo.heic`).
 * 5. **If anything exists under `uploads/<hash>/`, nothing is written** and that object is
 *    the answer, whatever it was called: the same bytes are stored once, and a key never
 *    changes what it points at (the CDN keeps every copy for a year). Two uploads of the
 *    same bytes in this process at once are one.
 * 6. The metadata: `w`, `h` (an image's; a file has neither), `name` (the file name as
 *    sent) and `by` (the signed-in address; none in local mode).
 */
import { createHash } from 'node:crypto';
import { slugify } from '../../../slug.ts';
import { MEDIA_MAX_BYTES, MEDIA_MAX_PIXELS, MEDIA_NAME_HEADER, type MediaRefusal } from '../../types.ts';
import type { Bucket, ObjectMeta } from './bucket.ts';
import { countsPixels, sniffUpload } from './sniff.ts';

// The capped read moved to body.ts (caracms-cloud adversarial review, finding 10), for every route that takes a body.
export { readCapped, type CappedBody, type OverCap } from '../../../body.ts';

/** "52", or "40.3" when rounding would land on the cap itself (so it never reads as allowed). */
function amount(value: number, cap: number): string {
	const whole = Math.round(value);
	return whole > cap ? String(whole) : (Math.ceil(value * 10 - 1e-9) / 10).toFixed(1);
}

export const tooLargeMessage = (bytes: number | null) =>
	bytes === null
		? `This file is over ${MEDIA_MAX_BYTES / 1e6} MB. The library takes up to ${MEDIA_MAX_BYTES / 1e6} MB.`
		: `This file is ${amount(bytes / 1e6, MEDIA_MAX_BYTES / 1e6)} MB. The library takes up to ${MEDIA_MAX_BYTES / 1e6} MB.`;
export const tooManyPixelsMessage = (pixels: number) => `This image is ${amount(pixels / 1e6, MEDIA_MAX_PIXELS / 1e6)} megapixels. The library takes up to ${MEDIA_MAX_PIXELS / 1e6}.`;

/** An upload refused: the status and Decision 6's sentence. */
export class UploadRefused extends Error {
	readonly status: number;
	readonly code: MediaRefusal['code'];
	constructor(status: number, code: MediaRefusal['code'], message: string) {
		super(message);
		this.name = 'UploadRefused';
		this.status = status;
		this.code = code;
	}
}

/** The most a name may take URI-encoded: S3 holds all of an object's metadata to 2 KB, and `name` is stored encoded. */
const NAME_ENCODED_MAX = 1024;

/** The file name from the header: URI-decoded, no path, no control characters, at most 255 characters and 1 KB encoded. */
export function uploadName(request: Request): string {
	const raw = request.headers.get(MEDIA_NAME_HEADER) ?? '';
	let name = raw;
	try {
		name = decodeURIComponent(raw);
	} catch {
		/* as sent */
	}
	name = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
	const chars = [...name].slice(0, 255);
	while (chars.length > 0 && encodeURIComponent(chars.join('')).length > NAME_ENCODED_MAX) chars.pop();
	return chars.join('');
}

/** The key's file part: the name without its extension, slugified (`image`, or a file's `file`, when nothing's left). */
export function keyName(name: string, fallback = 'image'): string {
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	return slugify(stem) || fallback;
}

export interface Stored {
	key: string;
	meta: ObjectMeta;
	created: boolean;
}

const inFlight = new Map<string, Promise<Stored>>();

/**
 * Take an upload's bytes into the bucket by Decision 6's rules. Throws UploadRefused for
 * anything the library doesn't take; a bucket failure throws its BucketError (a 502).
 */
export async function storeUpload(
	bucket: Bucket,
	upload: { bytes: Uint8Array; name: string; by: string | null },
	options: { now?: () => number; head?: (key: string) => Promise<ObjectMeta | null> } = {},
): Promise<Stored> {
	const { bytes, name, by } = upload;
	if (bytes.byteLength === 0) throw new UploadRefused(400, 'empty', 'That file is empty.');
	if (bytes.byteLength > MEDIA_MAX_BYTES) throw new UploadRefused(413, 'too-large', tooLargeMessage(bytes.byteLength));
	const sniffed = sniffUpload(bytes, name);
	if (!sniffed.ok) throw new UploadRefused(415, sniffed.code, sniffed.message);
	const size = sniffed.format === 'file' ? null : { w: sniffed.w, h: sniffed.h };
	if (size && sniffed.format !== 'file' && countsPixels(sniffed.format) && size.w * size.h > MEDIA_MAX_PIXELS) throw new UploadRefused(422, 'too-many-pixels', tooManyPixelsMessage(size.w * size.h));
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const hash = sha256.slice(0, 12);
	const head = options.head ?? ((key: string) => bucket.head(key));
	const now = options.now ?? (() => Date.now());

	const run = async (): Promise<Stored> => {
		// Existence first, always: anything under the hash's folder is these bytes already.
		// It's the answer even when its metadata can't be read: writing anyway could land on its key.
		const existing = await bucket.first(`uploads/${hash}/`);
		if (existing) {
			const meta = (await head(existing)) ?? { w: size?.w ?? null, h: size?.h ?? null, name: null, by: null, contentType: sniffed.mime, lastModified: new Date(now()).toISOString(), size: bytes.byteLength };
			return { key: existing, meta, created: false };
		}
		const stem = keyName(name, size ? 'image' : 'file');
		const key = `uploads/${hash}/${stem}.${sniffed.ext}`;
		const named = { name: name || `${stem}.${sniffed.ext}`, by };
		await bucket.put({ key, body: bytes, contentType: sniffed.mime, sha256, meta: size ? { ...size, ...named } : named });
		return {
			key,
			meta: { w: size?.w ?? null, h: size?.h ?? null, ...named, contentType: sniffed.mime, lastModified: new Date(now()).toISOString(), size: bytes.byteLength },
			created: true,
		};
	};
	let pending = inFlight.get(hash);
	if (!pending) {
		pending = run().finally(() => inFlight.delete(hash));
		inFlight.set(hash, pending);
		return pending;
	}
	// The same bytes, already on their way in this process: one object, so this one wrote nothing.
	const first = await pending;
	return { ...first, created: false };
}
