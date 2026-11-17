// `caracms media import <files…>` (M8 Decision 18): local images into the site's media
// bucket, by the editor's upload route's own rules, for a port to point its content at.
// It's `scripts/media-setup.ts` made a command.
//
// Plain JavaScript with Node built-ins only: it runs on Node 22.12 with no flags, so
// nothing here may import the package's TypeScript. That's why the upload route's rules
// are written out again below, and why `test/media-import.test.ts` runs both on the same
// inputs, so the two can't drift:
//
// - **The type and size are the bytes'** (src/editor/server/media/sniff.ts, `sniffImage`):
//   JPEG, PNG, WebP, AVIF, HEIC/HEIF, GIF and SVG; the size as shown (EXIF orientation
//   5–8, or HEIF's `irot`, swaps it; an SVG's from its viewBox, else width and height).
//   At most 40 MB and 50 megapixels (an SVG has no pixels), as the route.
// - **The key is `uploads/<first 12 hex of SHA-256>/<the name, slugified>.<ext>`**
//   (src/editor/server/media/upload.ts, `keyName`; src/slug.ts, `slugify`), `<ext>` from
//   the bytes.
// - **If anything exists under `uploads/<hash>/`, nothing is written**, and that key is
//   the answer (`"existed": true`), whatever it was called. Nothing here ever deletes.
// - Metadata: `w`, `h`, `name` (the file's name, URI-encoded) and `by=import`.
// - Credentials: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
//   `S3_SECRET_ACCESS_KEY`, from the environment, else the site's `.env` in the cwd.
// - S3's SigV4 by hand, path-style requests (Railway's endpoint takes both styles).
// - **On CaraCMS Cloud** (caracms-cloud M3 Decision 6): with `CARACMS_CLOUD_KEY` (and
//   `CARACMS_CLOUD_URL` for another deployment; both read as the `S3_*` are) it checks
//   and uploads through the cloud's media API instead (the list, object and upload-URL
//   routes), with the same rules, output and exit codes. The key with any of the site's
//   own media variables is refused with the running site's sentence: one credential.
//
// Output: one JSON array on stdout, `[{ "file", "key", "w", "h", "existed" }]`, `file`
// as given. Messages go to stderr. Exit codes: 0 fine, 1 failed, 2 bad usage.
//
// `caracms media push` (caracms-cloud M3 Decision 6a) moves a site's originals into the
// cloud, keeping every key: it reads the site's own bucket with `S3_*` and writes each
// `uploads/` object into the site's cloud folder through upload URLs with
// `CARACMS_CLOUD_KEY` (the one command that takes both). Each object's bytes are checked
// against the hash in its key; one already in the cloud is skipped, so it can be stopped
// and run again. A key not of the upload shape is left, counted and named, not failed: a
// Tina site's bucket keeps its old Tina-shaped originals (the live site serves them until
// the switch), and the conversion script copied each one the content uses to an
// upload-shaped key, which push sends. Its metadata (`w`, `h`, `name`, `by`) is carried
// over. Nothing in the source bucket is changed.
// Output: `{ "copied", "skipped", "left", "failed": [{ "key", "reason" }] }` (counts, and
// the failures), progress on stderr; exit 0 when nothing failed, 1 otherwise (the cloud's
// `upload_limit` stops the run there, with its sentence), 2 for bad usage.

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const USAGE = 'Usage: caracms media import <files…>\n       caracms media push';

/** The production API's address (src/live/cloud.ts `DEFAULT_CLOUD_URL`; a test keeps the two equal). */
export const DEFAULT_CLOUD_URL = 'https://glad-bird-412.ap-southeast-2.convex.site';

/** What the upload route takes (src/editor/types.ts: MEDIA_MAX_BYTES, MEDIA_MAX_PIXELS). */
export const MAX_BYTES = 40_000_000;
export const MAX_PIXELS = 50_000_000;

export const ENV_NAMES = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
/** The site's own media variables, which the cloud key replaces (src/live/mode.ts `OWN_MEDIA_VARIABLES`). */
export const OWN_MEDIA_NAMES = [...ENV_NAMES, 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'CARACMS_MEDIA_URL'];

// ── The key rule (upload.ts keyName, slug.ts slugify) ───────────────────────────

const SLUG_MAX = 60;
const FOLD = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

/** src/slug.ts `slugify`, written out again. */
export function slugify(name) {
	let s = String(name).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
	s = s.replace(/[ßæœøłđðþı]/g, (c) => FOLD[c]);
	s = s.replace(/&/g, ' and ');
	s = s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
	s = s.normalize('NFC');
	const chars = [...s];
	if (chars.length > SLUG_MAX) s = chars.slice(0, SLUG_MAX).join('').replace(/-+$/, '');
	return s;
}

/** src/editor/server/media/upload.ts `keyName`: the name without its extension, slugified. */
export function keyName(name, fallback = 'image') {
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	return slugify(stem) || fallback;
}

/** The name as the route keeps it (`uploadName`): no path, no control characters, 255 characters, 1 KB encoded. */
export function cleanName(file) {
	const name = (String(file).split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
	const chars = [...name].slice(0, 255);
	while (chars.length > 0 && encodeURIComponent(chars.join('')).length > 1024) chars.pop();
	return chars.join('');
}

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

/** The key an image's bytes and name get, or the sniff's refusal. */
export function keyFor(bytes, name) {
	const sniffed = sniffImage(bytes);
	if (!sniffed.ok) return sniffed;
	const hash = sha256hex(bytes).slice(0, 12);
	return { ok: true, key: `uploads/${hash}/${keyName(cleanName(name))}.${sniffed.ext}`, hash, sniffed };
}

// ── The type and size from the bytes (sniff.ts sniffImage, images only) ─────────

const FORMATS = {
	jpeg: { ext: 'jpg', mime: 'image/jpeg' },
	png: { ext: 'png', mime: 'image/png' },
	webp: { ext: 'webp', mime: 'image/webp' },
	avif: { ext: 'avif', mime: 'image/avif' },
	heic: { ext: 'heic', mime: 'image/heic' },
	heif: { ext: 'heif', mime: 'image/heif' },
	gif: { ext: 'gif', mime: 'image/gif' },
	svg: { ext: 'svg', mime: 'image/svg+xml' },
};

const TAKES = 'The library takes JPEG, PNG, WebP, AVIF, HEIC, GIF and SVG images.';
const unknown = () => ({ ok: false, code: 'unknown-type', message: `This isn't an image the library can take. ${TAKES}` });
const named = (what) => ({ ok: false, code: 'not-an-image', message: `This is ${what}. ${TAKES}` });
const SVG_NO_SIZE_MESSAGE = 'This SVG has no size (no viewBox, and no width and height). Add a viewBox and import it again.';

function image(format, w, h, swap = false) {
	if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) return unknown();
	return { ok: true, format, ...FORMATS[format], w: swap ? h : w, h: swap ? w : h };
}

/** Bounds-checked reads: out of range is NaN or '', which every caller treats as "not this". */
class Bytes {
	constructor(b) {
		this.b = b;
	}
	get length() {
		return this.b.length;
	}
	u8(i) {
		return i >= 0 && i < this.b.length ? this.b[i] : NaN;
	}
	u16be(i) {
		return this.u8(i) * 256 + this.u8(i + 1);
	}
	u16le(i) {
		return this.u8(i) + this.u8(i + 1) * 256;
	}
	u24le(i) {
		return this.u8(i) + this.u8(i + 1) * 256 + this.u8(i + 2) * 65536;
	}
	u32be(i) {
		return this.u16be(i) * 65536 + this.u16be(i + 2);
	}
	u32le(i) {
		return this.u16le(i) + this.u16le(i + 2) * 65536;
	}
	ascii(i, n) {
		if (i < 0 || i + n > this.b.length) return '';
		let s = '';
		for (let k = 0; k < n; k++) s += String.fromCharCode(this.b[i + k]);
		return s;
	}
	starts(...bytes) {
		return bytes.every((v, k) => this.b[k] === v);
	}
}

/** An image's type and size as shown, from its bytes. Never throws. */
export function sniffImage(data) {
	const b = new Bytes(data instanceof Uint8Array ? data : new Uint8Array(data));
	if (b.length === 0) return unknown();
	try {
		if (b.starts(0xff, 0xd8, 0xff)) return jpeg(b);
		if (b.starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return png(b);
		const head6 = b.ascii(0, 6);
		if (head6 === 'GIF87a' || head6 === 'GIF89a') return image('gif', b.u16le(6), b.u16le(8));
		if (b.ascii(0, 4) === 'RIFF') {
			const kind = b.ascii(8, 4);
			if (kind === 'WEBP') return webp(b);
			if (kind === 'AVI ') return named('a video');
			if (kind === 'WAVE') return named('an audio file');
			return unknown();
		}
		if (b.ascii(4, 4) === 'ftyp') return isoMedia(b);
		const other = otherType(b);
		if (other) return named(other);
		return svg(b.b);
	} catch {
		return unknown();
	}
}

function jpeg(b) {
	let orientation = 1;
	let i = 2;
	while (i + 3 < b.length) {
		if (b.u8(i) !== 0xff) return unknown();
		const marker = b.u8(i + 1);
		if (marker === 0xff) {
			i++;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			i += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) break;
		const len = b.u16be(i + 2);
		if (!(len >= 2)) break;
		if (marker === 0xe1 && b.ascii(i + 4, 6) === 'Exif\0\0') orientation = exifOrientation(b, i + 10, i + 2 + len) ?? orientation;
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return image('jpeg', b.u16be(i + 7), b.u16be(i + 5), swaps(orientation));
		}
		i += 2 + len;
	}
	return unknown();
}

const swaps = (orientation) => orientation >= 5 && orientation <= 8;

function exifOrientation(b, tiff, end) {
	const order = b.ascii(tiff, 2);
	if (order !== 'II' && order !== 'MM') return null;
	const le = order === 'II';
	const u16 = (o) => (o + 2 <= end ? (le ? b.u16le(o) : b.u16be(o)) : NaN);
	const u32 = (o) => (o + 4 <= end ? (le ? b.u32le(o) : b.u32be(o)) : NaN);
	if (u16(tiff + 2) !== 42) return null;
	const ifd = tiff + u32(tiff + 4);
	const count = u16(ifd);
	if (!(count >= 0) || count > 1000) return null;
	for (let n = 0, e = ifd + 2; n < count; n++, e += 12) {
		if (u16(e) === 0x0112) {
			const value = u16(e + 8);
			return value >= 1 && value <= 8 ? value : null;
		}
	}
	return null;
}

function png(b) {
	if (b.ascii(12, 4) !== 'IHDR') return unknown();
	const w = b.u32be(16);
	const h = b.u32be(20);
	let orientation = 1;
	for (let i = 8; i + 8 <= b.length; ) {
		const len = b.u32be(i);
		const type = b.ascii(i + 4, 4);
		if (!(len >= 0) || type === 'IDAT' || type === 'IEND' || type === '') break;
		if (type === 'eXIf') orientation = exifOrientation(b, i + 8, i + 8 + len) ?? orientation;
		i += 12 + len;
	}
	return image('png', w, h, swaps(orientation));
}

function webp(b) {
	const chunk = b.ascii(12, 4);
	let w = NaN;
	let h = NaN;
	if (chunk === 'VP8X') {
		w = b.u24le(24) + 1;
		h = b.u24le(27) + 1;
	} else if (chunk === 'VP8L') {
		if (b.u8(20) !== 0x2f) return unknown();
		const bits = b.u32le(21);
		w = (bits & 0x3fff) + 1;
		h = ((bits >>> 14) & 0x3fff) + 1;
	} else if (chunk === 'VP8 ') {
		if (!(b.u8(23) === 0x9d && b.u8(24) === 0x01 && b.u8(25) === 0x2a)) return unknown();
		w = b.u16le(26) & 0x3fff;
		h = b.u16le(28) & 0x3fff;
	} else return unknown();
	let orientation = 1;
	if (chunk === 'VP8X') {
		for (let i = 12; i + 8 <= b.length; ) {
			const type = b.ascii(i, 4);
			const len = b.u32le(i + 4);
			if (!(len >= 0) || type === '') break;
			if (type === 'EXIF') {
				const start = b.ascii(i + 8, 6) === 'Exif\0\0' ? i + 14 : i + 8;
				orientation = exifOrientation(b, start, i + 8 + len) ?? orientation;
				break;
			}
			i += 8 + len + (len % 2);
		}
	}
	return image('webp', w, h, swaps(orientation));
}

const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);
const VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'qt  ', 'M4V ', 'M4VP', '3gp4', '3gp5', '3gp6', '3g2a', 'avc1', 'dash', 'MSNV', 'f4v ', 'crx ']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ']);

function boxes(b, from, to) {
	const out = [];
	for (let i = from; i + 8 <= to && out.length < 4096; ) {
		let size = b.u32be(i);
		const type = b.ascii(i + 4, 4);
		let header = 8;
		if (size === 1) {
			const high = b.u32be(i + 8);
			const low = b.u32be(i + 12);
			if (high !== 0) break;
			size = low;
			header = 16;
		} else if (size === 0) size = to - i;
		if (!(size >= header) || i + size > to || type === '') break;
		out.push({ type, start: i + header, end: i + size });
		i += size;
	}
	return out;
}

function isoMedia(b) {
	const top = boxes(b, 0, b.length);
	const ftyp = top[0];
	if (!ftyp || ftyp.type !== 'ftyp') return unknown();
	const brands = new Set([b.ascii(ftyp.start, 4)]);
	for (let i = ftyp.start + 8; i + 4 <= ftyp.end; i += 4) brands.add(b.ascii(i, 4));
	const has = (set) => [...brands].some((x) => set.has(x));
	const format = has(AVIF_BRANDS) ? 'avif' : has(HEIC_BRANDS) ? 'heic' : has(HEIF_BRANDS) ? 'heif' : null;
	if (!format) {
		if (has(VIDEO_BRANDS)) return named('a video');
		if (has(AUDIO_BRANDS)) return named('an audio file');
		return unknown();
	}
	const meta = top.find((x) => x.type === 'meta');
	if (!meta) return unknown();
	const size = primarySize(b, meta.start + 4, meta.end);
	return size ? image(format, size.w, size.h, size.quarter) : unknown();
}

function primarySize(b, from, to) {
	const children = boxes(b, from, to);
	const pitm = children.find((x) => x.type === 'pitm');
	const primary = pitm ? (b.u8(pitm.start) === 0 ? b.u16be(pitm.start + 4) : b.u32be(pitm.start + 4)) : NaN;
	const iprp = children.find((x) => x.type === 'iprp');
	if (!iprp) return null;
	const inner = boxes(b, iprp.start, iprp.end);
	const ipco = inner.find((x) => x.type === 'ipco');
	if (!ipco) return null;
	const props = boxes(b, ipco.start, ipco.end);
	const mine = new Set();
	for (const ipma of inner.filter((x) => x.type === 'ipma')) {
		const version = b.u8(ipma.start);
		const wide = (b.u8(ipma.start + 3) & 1) === 1;
		let i = ipma.start + 4;
		const count = b.u32be(i);
		i += 4;
		for (let n = 0; n < count && i < ipma.end; n++) {
			const item = version < 1 ? b.u16be(i) : b.u32be(i);
			i += version < 1 ? 2 : 4;
			const associations = b.u8(i);
			i += 1;
			for (let k = 0; k < associations; k++) {
				const index = wide ? b.u16be(i) & 0x7fff : b.u8(i) & 0x7f;
				i += wide ? 2 : 1;
				if (item === primary) mine.add(index);
			}
		}
	}
	const ispeOf = (p) => ({ w: b.u32be(p.start + 4), h: b.u32be(p.start + 8) });
	let size = null;
	let quarter = false;
	props.forEach((p, k) => {
		if (!mine.has(k + 1)) return;
		if (p.type === 'ispe') size = ispeOf(p);
		if (p.type === 'irot') quarter = (b.u8(p.start) & 3) % 2 === 1;
	});
	if (!size) {
		for (const p of props) {
			if (p.type !== 'ispe') continue;
			const s = ispeOf(p);
			if (!size || s.w * s.h > size.w * size.h) size = s;
		}
		if (!size) return null;
		quarter = props.some((p) => p.type === 'irot' && (b.u8(p.start) & 3) % 2 === 1);
	}
	return { w: size.w, h: size.h, quarter };
}

function otherType(b) {
	if (b.ascii(0, 5) === '%PDF-') return 'a PDF';
	if (b.starts(0x50, 0x4b, 0x03, 0x04) || b.starts(0x50, 0x4b, 0x05, 0x06)) return 'a ZIP file';
	if (b.ascii(0, 2) === 'MZ' || b.starts(0x7f, 0x45, 0x4c, 0x46) || isMachO(b) || b.ascii(0, 2) === '#!') return 'a program';
	if (b.starts(0x1a, 0x45, 0xdf, 0xa3)) return 'a video';
	if (b.ascii(0, 4) === 'OggS' || b.ascii(0, 4) === 'fLaC' || b.ascii(0, 3) === 'ID3') return 'an audio file';
	if (b.starts(0x49, 0x49, 0x2a, 0x00) || b.starts(0x4d, 0x4d, 0x00, 0x2a)) return 'a TIFF or camera raw image';
	if (b.ascii(0, 4) === '8BPS') return 'a Photoshop file';
	if (b.starts(0xff, 0x0a) || (b.u32be(0) === 12 && b.ascii(4, 4) === 'JXL ')) return 'a JPEG XL image';
	if (b.ascii(0, 2) === 'BM' && b.u32le(2) > 26 && b.u16le(26) === 1) return 'a BMP image';
	if (b.starts(0x00, 0x00, 0x01, 0x00) && b.u16le(4) > 0) return 'an icon file';
	if (b.ascii(0, 4) === 'Rar!' || b.starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) || b.starts(0x1f, 0x8b)) return 'a compressed file';
	if (b.starts(0xd0, 0xcf, 0x11, 0xe0)) return 'an Office document';
	if (b.ascii(0, 5) === '{\\rtf') return 'a document';
	if (b.u8(0) === 0xff && (b.u8(1) & 0xe0) === 0xe0) return 'an audio file';
	return null;
}

function isMachO(b) {
	const m = b.u32be(0);
	if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe) return true;
	return m === 0xcafebabe && b.u32be(4) > 0 && b.u32be(4) < 20;
}

/** An SVG's size, its root element's attributes read by hand: never parsed as XML. */
function svg(data) {
	const head = data.subarray(0, Math.min(data.length, 1_000_000));
	if (head.includes(0)) return unknown();
	let s = new TextDecoder('utf-8', { fatal: false }).decode(head);
	if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	let i = 0;
	const skipSpace = () => {
		while (i < s.length && /\s/.test(s[i])) i++;
	};
	for (let guard = 0; guard < 10_000; guard++) {
		skipSpace();
		if (s.startsWith('<?', i)) {
			const end = s.indexOf('?>', i + 2);
			if (end < 0) return unknown();
			i = end + 2;
		} else if (s.startsWith('<!--', i)) {
			const end = s.indexOf('-->', i + 4);
			if (end < 0) return unknown();
			i = end + 3;
		} else if (s.slice(i, i + 9).toUpperCase() === '<!DOCTYPE') {
			let depth = 0;
			let j = i + 9;
			for (; j < s.length; j++) {
				const c = s[j];
				if (c === '[') depth++;
				else if (c === ']') depth--;
				else if (c === '>' && depth <= 0) break;
			}
			if (j >= s.length) return unknown();
			if (/^<!DOCTYPE\s+html/i.test(s.slice(i, i + 20))) return named('a web page');
			i = j + 1;
		} else break;
	}
	const root = /^<((?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*))(?=[\s/>])/.exec(s.slice(i, i + 256));
	if (!root) return unknown();
	if (root[2].toLowerCase() === 'html') return named('a web page');
	if (root[2] !== 'svg') return unknown();
	const attrs = {};
	const re = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
	let j = i + root[0].length;
	for (let guard = 0; guard < 1000; guard++) {
		re.lastIndex = j;
		const m = re.exec(s);
		if (!m) break;
		attrs[m[1]] = m[2] ?? m[3] ?? '';
		j = re.lastIndex;
	}
	if (!/^\s*\/?>/.test(s.slice(j, j + 64))) return unknown();
	const viewBox = attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
	if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
		return image('svg', Math.max(1, Math.round(viewBox[2])), Math.max(1, Math.round(viewBox[3])));
	}
	const px = (v) => {
		const m = v?.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/);
		return m ? Math.max(1, Math.round(Number(m[1]))) : NaN;
	};
	const w = px(attrs.width);
	const h = px(attrs.height);
	if (w > 0 && h > 0) return image('svg', w, h);
	return { ok: false, code: 'no-size', message: SVG_NO_SIZE_MESSAGE };
}

// ── The credentials ────────────────────────────────────────────────────────────

/** `KEY=value` lines of a `.env` (an `export ` prefix, quotes and `#` comments allowed). */
export function parseDotenv(text) {
	const out = {};
	for (const raw of text.split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
		if (!m) continue;
		let v = m[2].trim();
		const q = v[0];
		if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
		else v = v.replace(/\s+#.*$/, '');
		out[m[1]] = v;
	}
	return out;
}

/** A variable's value: the environment's, else `.env`'s in `cwd` (read once, when first needed). */
function envReader(env, cwd) {
	let file = null;
	return (name) => {
		if (env[name]) return env[name];
		if (!file) {
			try {
				file = parseDotenv(readFileSync(join(cwd, '.env'), 'utf8'));
			} catch {
				file = {};
			}
		}
		return file[name] || '';
	};
}

/** The five `S3_*` values: the environment's, else `.env`'s in `cwd`. Names what's missing. */
export function readS3Env(env, cwd) {
	const get = envReader(env, cwd);
	const values = {};
	const missing = [];
	for (const name of ENV_NAMES) {
		const v = get(name);
		if (v) values[name] = v;
		else missing.push(name);
	}
	return { values, missing };
}

const listed = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Every variable the cloud key replaces, in the Contracts' order (src/live/services.ts `REPLACED_VARIABLES`; a test keeps the two equal). */
export const REPLACED_NAMES = [
	...OWN_MEDIA_NAMES,
	'MUX_TOKEN_ID',
	'MUX_TOKEN_SECRET',
	'SUBMISSIONS_S3_BUCKET',
	'SUBMISSIONS_S3_ACCESS_KEY_ID',
	'SUBMISSIONS_S3_SECRET_ACCESS_KEY',
	'RESEND_API_KEY',
	'FORMS_FROM',
	'CARACMS_GITHUB_TOKEN',
	'GITHUB_APP_ID',
	'GITHUB_APP_PRIVATE_KEY',
	'GITHUB_REPO',
];

/** Decision 4's sentence (src/live/services.ts `CLOUD_KEY_MISSING_PROBLEM`). */
export const CLOUD_KEY_MISSING = "This site runs on CaraCMS Cloud (caracms.config.ts), but CARACMS_CLOUD_KEY isn't set. Make a key for it in app.caracms.com.";

/**
 * The cloud key and address, as the `S3_*` are read, or null without a key; `own` names the
 * site's own media variables also set (the running site's "not both", src/media.ts).
 * With the config's `services` (caracms-cloud M5 Decision 2) the other mode's variables are
 * ignored instead, each named once in `ignored`: on `'cloud'` `own` is always empty, on
 * `'self-hosted'` the key is never read and this is null.
 */
export function readCloudEnv(env, cwd, services = null) {
	const get = envReader(env, cwd);
	const key = services === 'self-hosted' ? '' : get('CARACMS_CLOUD_KEY').trim();
	if (!key) return null;
	const url = (get('CARACMS_CLOUD_URL').trim() || DEFAULT_CLOUD_URL).replace(/\/+$/, '');
	if (services === 'cloud') return { key, url, own: [], ignored: REPLACED_NAMES.filter((name) => get(name)) };
	return { key, url, own: OWN_MEDIA_NAMES.filter((name) => get(name)), ignored: [] };
}

/** The line naming what a cloud or self-hosted site ignores: src/live/services.ts `ignoredMessage` without a group, word for word (a test keeps the two equal; this file can't import the TypeScript). */
export function ignoredLine(names, services) {
	const one = names.length === 1;
	const where = services === 'self-hosted' ? 'this site is self-hosted' : 'this site runs on CaraCMS Cloud';
	const tail = services === 'self-hosted' ? `Remove ${one ? 'it' : 'them'}, or run \`caracms init --cloud\` to move the site to CaraCMS Cloud.` : `Remove ${one ? 'it' : 'them'} once the move is done.`;
	return `${listed(names)} ${one ? 'is' : 'are'} set, but ${where} (caracms.config.ts): ${one ? "it's" : "they're"} ignored. ${tail}`;
}

/** The config file names, in the order they're looked for (src/cli/site.ts `CONFIG_FILES`). */
const CONFIG_FILES = ['ts', 'mts', 'mjs', 'js'].map((ext) => `caracms.config.${ext}`);

/** The config's `services` (caracms-cloud M5 Decision 1), through the site's own Vite; null without a config. */
export async function readServices(cwd) {
	if (!CONFIG_FILES.some((name) => existsSync(join(cwd, name)))) return null;
	const { withPackageModule } = await import('./site-runner.mjs');
	return withPackageModule(cwd, 'site', async (m) => (await m.loadSite(cwd)).services);
}

export const bothMessage = (names) => `Set CARACMS_CLOUD_KEY or the site's own media variables, not both: remove ${listed(names)}.`;

// ── S3 (SigV4 by hand, path style) ─────────────────────────────────────────────

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
// Each segment RFC 3986-encoded, as S3 expects in the canonical request: plain
// encodeURIComponent leaves `! ' ( ) *` raw, and a key like `photo (1).jpg` got a 403.
const encodePath = (key) => key.split('/').map(rfc3986).join('/');

/**
 * Sign one request: the URL to fetch and its headers, `authorization` included.
 * `now` is for the test that checks it against another signer.
 *
 * @param {Record<string, string>} creds the five `S3_*` values
 * @param {{ method: string, key?: string, query?: Record<string, string>, body?: Uint8Array, headers?: Record<string, string>, now?: Date }} request
 * @returns {{ url: string, headers: Record<string, string> }}
 */
export function signS3(creds, { method, key = '', query = {}, body, headers = {}, now = new Date() }) {
	const endpoint = creds.S3_ENDPOINT.replace(/\/+$/, '');
	const url = new URL(`${endpoint}/${encodeURIComponent(creds.S3_BUCKET)}${key ? `/${encodePath(key)}` : ''}`);
	const qs = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`).join('&');
	const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
	const day = stamp.slice(0, 8);
	const payloadHash = sha256hex(body ?? '');
	const all = { ...headers, host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
	const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v)]));
	const names = Object.keys(lower).sort();
	const canonical = [method, url.pathname, qs, names.map((n) => `${n}:${lower[n].trim()}\n`).join(''), names.join(';'), payloadHash].join('\n');
	const scope = `${day}/${creds.S3_REGION}/s3/aws4_request`;
	const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonical)].join('\n');
	const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.S3_SECRET_ACCESS_KEY}`, day), creds.S3_REGION), 's3'), 'aws4_request');
	const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
	const authorization = `AWS4-HMAC-SHA256 Credential=${creds.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
	const { host: _host, ...sent } = lower;
	return { url: `${url.origin}${url.pathname}${qs ? `?${qs}` : ''}`, headers: { ...sent, authorization } };
}

/** One signed request. Only GET (a listing), HEAD and PUT: nothing here deletes. */
async function s3(creds, method, key, { query, body, headers, bytes = false } = {}) {
	if (method !== 'GET' && method !== 'HEAD' && method !== 'PUT') throw new Error(`No ${method} here.`);
	const signed = signS3(creds, { method, key, query, body, headers });
	const res = await fetch(signed.url, { method, headers: signed.headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(bytes ? 120_000 : 60_000) });
	if (bytes) return { res, text: '', bytes: res.ok ? Buffer.from(await res.arrayBuffer()) : (await res.body?.cancel().catch(() => {}), null) };
	const text = method === 'HEAD' ? '' : await res.text();
	return { res, text };
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The first key under a prefix, as the route's `bucket.first`. */
async function first(creds, prefix) {
	const { res, text } = await s3(creds, 'GET', '', { query: { 'list-type': '2', prefix, 'max-keys': '1' } });
	if (!res.ok) throw new Error(`listing ${prefix} failed: ${res.status} ${text.slice(0, 300)}`);
	const m = /<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>/.exec(text);
	return m ? unxml(m[1]) : null;
}

/** Every key under a prefix, following S3's continuation tokens (`push`'s source). */
async function listAll(creds, prefix) {
	const keys = [];
	let token = null;
	for (let n = 0; n < 1000; n++) {
		const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
		const { res, text } = await s3(creds, 'GET', '', { query });
		if (!res.ok) throw new Error(`listing ${prefix} failed: ${res.status} ${text.slice(0, 300)}`);
		for (const m of text.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>/g)) keys.push(unxml(m[1]));
		const next = /<IsTruncated>true<\/IsTruncated>/.test(text) ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text)?.[1] : null;
		if (!next || next === token) break;
		token = unxml(next);
	}
	return keys;
}

/** An existing object's stored `w` and `h`, when it has them. */
async function storedSize(creds, key) {
	const { res } = await s3(creds, 'HEAD', key);
	if (!res.ok) return null;
	const num = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);
	const w = num(res.headers.get('x-amz-meta-w'));
	const h = num(res.headers.get('x-amz-meta-h'));
	return w && h ? { w, h } : null;
}

// ── CaraCMS Cloud's media API (the M3 spec's Contracts) ─────────────────────────

/** The cloud said no, with its sentence (`message`, shown as sent), or couldn't be reached (`error: 'unreachable'`). */
export class CloudRefused extends Error {
	constructor(error, message) {
		super(message);
		this.error = error;
	}
}

/** One call: the site key as the bearer, a JSON body for a POST, the answer's JSON or a CloudRefused. */
async function cloudApi(cloud, method, path, body) {
	let res;
	let answer;
	try {
		res = await fetch(`${cloud.url}${path}`, {
			method,
			headers: { authorization: `Bearer ${cloud.key}`, accept: 'application/json', 'user-agent': 'caracms', ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(60_000),
		});
		answer = await res.json();
	} catch {
		throw new CloudRefused('unreachable', "CaraCMS Cloud couldn't be reached. Try again in a minute.");
	}
	if (!answer || typeof answer !== 'object') throw new CloudRefused('unreachable', "CaraCMS Cloud couldn't be reached. Try again in a minute.");
	if (!res.ok) {
		if (typeof answer.error !== 'string' || typeof answer.message !== 'string') throw new CloudRefused('unreachable', `CaraCMS Cloud answered ${res.status}.`);
		throw new CloudRefused(answer.error, answer.message);
	}
	return answer;
}

/** The first key under a prefix in the site's cloud folder. */
async function cloudFirst(cloud, prefix) {
	const answer = await cloudApi(cloud, 'GET', `/v1/media/list?${new URLSearchParams({ prefix })}`);
	return Array.isArray(answer.objects) && typeof answer.objects[0]?.key === 'string' ? answer.objects[0].key : null;
}

/** An object's details in the cloud, or null for `not_found`. */
async function cloudObject(cloud, key) {
	try {
		return await cloudApi(cloud, 'GET', `/v1/media/object?${new URLSearchParams({ key })}`);
	} catch (error) {
		if (error instanceof CloudRefused && error.error === 'not_found') return null;
		throw error;
	}
}

/**
 * Write a new object: an upload URL for exactly these bytes, then the PUT with the headers it
 * names (Content-Length is fetch's own). Returns the storage's status: 200s are stored, 412
 * means the key is already there.
 */
async function cloudPut(cloud, { key, body, contentType, meta }) {
	const answer = await cloudApi(cloud, 'POST', '/v1/media/upload-url', { key, size: body.byteLength, contentType, sha256: sha256hex(body), meta });
	if (typeof answer.url !== 'string' || !answer.headers || typeof answer.headers !== 'object') throw new CloudRefused('unreachable', 'CaraCMS Cloud gave no upload URL.');
	const headers = Object.fromEntries(Object.entries(answer.headers).filter(([name, v]) => typeof v === 'string' && !/^(content-length|host)$/i.test(name)));
	let res;
	try {
		res = await fetch(answer.url, { method: 'PUT', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(120_000) });
	} catch {
		throw new CloudRefused('unreachable', "CaraCMS Cloud's storage couldn't be reached. Try again in a minute.");
	}
	await res.body?.cancel().catch(() => {});
	return res.status;
}

// ── The command ────────────────────────────────────────────────────────────────

/**
 * `caracms media …`. `argv` is what follows `media`; returns the exit code.
 * `io` is for tests: the environment, the working directory and the two streams.
 */
export async function run(argv, io = {}) {
	const env = io.env ?? process.env;
	const cwd = io.cwd ?? process.cwd();
	const out = io.stdout ?? process.stdout;
	const err = io.stderr ?? process.stderr;
	const say = (line) => err.write(`${line}\n`);

	const [sub, ...rest] = argv;
	if (sub === 'help' || sub === '--help' || sub === '-h') {
		out.write(`${USAGE}\n`);
		return 0;
	}
	if (sub === 'push') {
		const extra = rest.filter((a) => a !== '--');
		if (extra.length > 0) {
			say(extra[0].startsWith('-') ? `Unknown option: ${extra[0]}` : 'media push takes no arguments: it copies everything under uploads/.');
			say(USAGE);
			return 2;
		}
		return push({ env, cwd, out, say });
	}
	if (sub !== 'import') {
		say(sub ? `Unknown media command: ${sub}` : 'Which media command?');
		say(USAGE);
		return 2;
	}
	const files = rest.filter((a) => a !== '--');
	const flag = files.find((a) => a.startsWith('-'));
	if (flag) {
		say(`Unknown option: ${flag}`);
		say(USAGE);
		return 2;
	}
	if (files.length === 0) {
		say('No files given.');
		say(USAGE);
		return 2;
	}

	// caracms-cloud M5: the config's `services` decides; without one, the key does (M3 Decisions 6 and 19).
	let services;
	try {
		services = io.services !== undefined ? io.services : await readServices(cwd);
	} catch (error) {
		say(`The site's caracms.config.ts couldn't be read, so it isn't known whether the images go to CaraCMS Cloud: ${error.message}`);
		return 1;
	}
	const cloud = readCloudEnv(env, cwd, services);
	if (services === 'cloud' && !cloud) {
		say(CLOUD_KEY_MISSING);
		return 1;
	}
	if (services === 'self-hosted' && envReader(env, cwd)('CARACMS_CLOUD_KEY').trim()) say(ignoredLine(['CARACMS_CLOUD_KEY'], services));
	if (cloud?.ignored.length) say(ignoredLine(cloud.ignored, services));
	if (cloud && cloud.own.length > 0) {
		say(bothMessage(cloud.own));
		return 1;
	}
	let creds = null;
	if (!cloud) {
		const { values, missing } = readS3Env(env, cwd);
		if (missing.length > 0) {
			say(`Missing ${missing.join(', ')}: set ${missing.length === 1 ? 'it' : 'them'} in the environment or in this site's .env (or set CARACMS_CLOUD_KEY for a site on CaraCMS Cloud).`);
			return 1;
		}
		creds = values;
	}

	// Every file read and checked before anything is written.
	const items = [];
	let bad = 0;
	for (const file of files) {
		let bytes;
		try {
			bytes = await readFile(resolve(cwd, file));
		} catch (error) {
			say(`${file}: can't read it (${error?.code ?? error?.message ?? error}).`);
			bad++;
			continue;
		}
		if (bytes.byteLength === 0) {
			say(`${file}: it's empty.`);
			bad++;
			continue;
		}
		if (bytes.byteLength > MAX_BYTES) {
			say(`${file}: it's ${(bytes.byteLength / 1e6).toFixed(1)} MB. The library takes up to ${MAX_BYTES / 1e6} MB.`);
			bad++;
			continue;
		}
		const keyed = keyFor(bytes, basename(file));
		if (!keyed.ok) {
			say(`${file}: ${keyed.message}`);
			bad++;
			continue;
		}
		const { sniffed } = keyed;
		if (sniffed.format !== 'svg' && sniffed.w * sniffed.h > MAX_PIXELS) {
			say(`${file}: it's ${(sniffed.w * sniffed.h / 1e6).toFixed(1)} megapixels. The library takes up to ${MAX_PIXELS / 1e6}.`);
			bad++;
			continue;
		}
		items.push({ file, bytes, ...keyed });
	}
	if (bad > 0) {
		say(`Nothing imported: ${bad} of ${files.length} file${files.length === 1 ? '' : 's'} can't go in.`);
		return 1;
	}

	const results = [];
	try {
		for (const item of items) {
			const { file, bytes, key, hash, sniffed } = item;
			const existing = cloud ? await cloudFirst(cloud, `uploads/${hash}/`) : await first(creds, `uploads/${hash}/`);
			if (existing) {
				const size = (cloud ? sizeOf(await cloudObject(cloud, existing)) : await storedSize(creds, existing)) ?? { w: sniffed.w, h: sniffed.h };
				results.push({ file, key: existing, w: size.w, h: size.h, existed: true });
				say(`${file}: already there, ${existing}`);
				continue;
			}
			const name = cleanName(basename(file)) || key.slice(key.lastIndexOf('/') + 1);
			if (cloud) {
				const status = await cloudPut(cloud, { key, body: bytes, contentType: sniffed.mime, meta: { w: sniffed.w, h: sniffed.h, name, by: 'import' } });
				// 412: the key (and so these bytes) is already there; it went in between the check and the write.
				if (status === 412) {
					results.push({ file, key, w: sniffed.w, h: sniffed.h, existed: true });
					say(`${file}: already there, ${key}`);
					continue;
				}
				if (status < 200 || status >= 300) throw new Error(`writing ${key} failed: the storage answered ${status}`);
			} else {
				const { res, text } = await s3(creds, 'PUT', key, {
					body: bytes,
					headers: {
						'content-type': sniffed.mime,
						'x-amz-meta-w': String(sniffed.w),
						'x-amz-meta-h': String(sniffed.h),
						'x-amz-meta-name': encodeURIComponent(name),
						'x-amz-meta-by': 'import',
					},
				});
				if (!res.ok) throw new Error(`writing ${key} failed: ${res.status} ${text.slice(0, 300)}`);
			}
			results.push({ file, key, w: sniffed.w, h: sniffed.h, existed: false });
			say(`${file}: ${key} (${sniffed.w}×${sniffed.h})`);
		}
	} catch (error) {
		// The cloud's own sentence as sent (a full site, a revoked key); anything else as before.
		say(error instanceof CloudRefused ? error.message : `The bucket refused or didn't answer: ${error?.message ?? error}`);
		if (results.length > 0) say(`These went in before it stopped: ${JSON.stringify(results)}`);
		return 1;
	}
	out.write(`${JSON.stringify(results, null, 2)}\n`);
	return 0;
}

/** A cloud object's `w` and `h`, when it has them. */
const sizeOf = (object) => (object && Number.isInteger(object.w) && object.w > 0 && Number.isInteger(object.h) && object.h > 0 ? { w: object.w, h: object.h } : null);

// ── media push (caracms-cloud M3 Decision 6a) ──────────────────────────────────

/** The upload route's key shape (the M3 spec's Decision 15): the hash, the slugified name, an extension the library takes. */
const UPLOAD_KEY = /^uploads\/([0-9a-f]{12})\/([\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*)\.(jpg|png|webp|avif|heic|heif|gif|svg|pdf|docx|doc|xlsx|xls|pptx|ppt|csv|zip)$/u;
/** A type for an object whose source has none (src/editor/server/media/sniff.ts and src/files.ts name the same). */
const TYPES = {
	jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', gif: 'image/gif', svg: 'image/svg+xml',
	pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint', csv: 'text/csv', zip: 'application/zip',
};
/** Refusals about one key: report it and carry on. Any other (the cap, a revoked key, the storage away) stops the run. */
const PER_KEY = new Set(['bad_key', 'bad_request', 'too_large', 'exists']);

const decoded = (v) => {
	if (!v) return null;
	try {
		return decodeURIComponent(v);
	} catch {
		return v;
	}
};
const metaSide = (v) => (v != null && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined);

async function push({ env, cwd, out, say }) {
	const cloud = readCloudEnv(env, cwd);
	const { values: creds, missing } = readS3Env(env, cwd);
	if (!cloud || missing.length > 0) {
		const need = [...(cloud ? [] : ['CARACMS_CLOUD_KEY']), ...missing];
		say(`Missing ${listed(need)}: media push reads the site's own bucket (S3_*) and writes to its CaraCMS Cloud folder (CARACMS_CLOUD_KEY). Set ${need.length === 1 ? 'it' : 'them'} in the environment or in this site's .env.`);
		return 1;
	}

	let copied = 0;
	let skipped = 0;
	/** Keys not of the upload shape: never sent, and not a failure (a Tina site's old keys). */
	let left = 0;
	const failed = [];
	const done = (code) => {
		out.write(`${JSON.stringify({ copied, skipped, left, failed }, null, 2)}\n`);
		return code;
	};

	let keys;
	try {
		keys = (await listAll(creds, 'uploads/')).sort();
	} catch (error) {
		say(`The site's bucket refused or didn't answer: ${error?.message ?? error}`);
		return 1;
	}
	say(`${keys.length} object${keys.length === 1 ? '' : 's'} under uploads/ in ${creds.S3_BUCKET}.`);

	for (const key of keys) {
		const shape = UPLOAD_KEY.exec(key);
		if (!shape) {
			left++;
			say(`left ${key}: not of the upload key's shape`);
			continue;
		}
		try {
			if (await cloudObject(cloud, key)) {
				skipped++;
				say(`skipped ${key} (already in the cloud)`);
				continue;
			}
			const { res, bytes } = await s3(creds, 'GET', key, { bytes: true });
			if (!bytes) {
				failed.push({ key, reason: `The site's bucket answered ${res.status} for it.` });
				say(`failed ${key}: the site's bucket answered ${res.status}`);
				continue;
			}
			if (bytes.byteLength > MAX_BYTES) {
				failed.push({ key, reason: `It's ${(bytes.byteLength / 1e6).toFixed(1)} MB; the library takes up to ${MAX_BYTES / 1e6} MB.` });
				say(`failed ${key}: over ${MAX_BYTES / 1e6} MB`);
				continue;
			}
			if (sha256hex(bytes).slice(0, 12) !== shape[1]) {
				failed.push({ key, reason: "Its bytes don't match the hash in its key, so it wasn't sent." });
				say(`failed ${key}: its bytes don't match the hash in its key`);
				continue;
			}
			const h = res.headers;
			const meta = {
				...(metaSide(h.get('x-amz-meta-w')) ? { w: metaSide(h.get('x-amz-meta-w')) } : {}),
				...(metaSide(h.get('x-amz-meta-h')) ? { h: metaSide(h.get('x-amz-meta-h')) } : {}),
				name: decoded(h.get('x-amz-meta-name')) || key.slice(key.lastIndexOf('/') + 1),
				by: decoded(h.get('x-amz-meta-by')),
			};
			const contentType = h.get('content-type') && h.get('content-type') !== 'application/octet-stream' ? h.get('content-type') : TYPES[shape[3]];
			const status = await cloudPut(cloud, { key, body: bytes, contentType, meta });
			if (status === 412) {
				skipped++;
				say(`skipped ${key} (already in the cloud)`);
			} else if (status >= 200 && status < 300) {
				copied++;
				say(`copied ${key}`);
			} else {
				failed.push({ key, reason: `The cloud's storage answered ${status}.` });
				say(`failed ${key}: the cloud's storage answered ${status}`);
			}
		} catch (error) {
			if (error instanceof CloudRefused && PER_KEY.has(error.error)) {
				failed.push({ key, reason: error.message });
				say(`failed ${key}: ${error.message}`);
				continue;
			}
			// The cap (upload_limit), a key that stopped working, the cloud or its storage away: stop here.
			const reason = error instanceof CloudRefused ? error.message : `The site's bucket didn't answer: ${error?.message ?? error}`;
			failed.push({ key, reason });
			say(`Stopped at ${key}, after copying ${copied}: ${reason}`);
			return done(1);
		}
	}
	if (left > 0) {
		say(
			`Left ${left} object${left === 1 ? '' : 's'} not of the upload key's shape (uploads/<12 hex>/<name>.<ext>, an extension the library takes): the cloud takes only that shape. On a site moved from Tina these are its old originals, which the conversion copied to upload-shaped keys; content that still names one won't show on the cloud.`,
		);
	}
	say(`Done: ${copied} copied, ${skipped} already there, ${left} left, ${failed.length} failed.`);
	return done(failed.length === 0 ? 0 : 1);
}
