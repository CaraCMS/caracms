/**
 * What an uploaded file is, **from its bytes, never its name** (M5b Decision 6), and its
 * pixel size as shown (after EXIF orientation; an SVG's from its `viewBox`; a HEIC's or
 * an AVIF's from the primary item's `ispe`, turned by its `irot`).
 *
 * The library takes JPEG, PNG, WebP, AVIF, HEIC/HEIF, GIF and SVG, and (M6c G4, Decision
 * 1) the files in `caracms/files`' table: PDF, Word, Excel, PowerPoint, CSV and Zip.
 * Anything else is refused with Decision 6's sentence: "This is a video. …" when the
 * bytes say what it is, "This file isn't one the library can take: …" when they don't;
 * both list images and files.
 *
 * **Files** (`sniffFile`): a PDF by `%PDF-`; a zip by its header, read through its
 * central directory, and an Office file when it holds `[Content_Types].xml` and a
 * `word/`, `xl/` or `ppt/` part (a macro-enabled one, by its content types or a
 * `vbaProject.bin`, is refused). **The name decides only two things, and only once the
 * bytes allow it**: which legacy Office type an OLE file is (`.doc`, `.xls`, `.ppt`),
 * and that valid UTF-8 text with no NUL byte is a CSV (`.csv`). Nowhere else.
 *
 * Pure and dependency-free: plain byte reads with bounds checks, so a truncated or
 * hostile file reads as "not an image", never a throw. **An SVG is never parsed as
 * XML**: its prolog is skipped by hand and its root element's attributes read with a
 * regular expression, so nothing here could resolve an entity or fetch anything. It's
 * only ever shown through imgproxy in an `<img>`, where scripts don't run.
 */
import { inflateRawSync } from 'node:zlib';
import { fileTypeOf, type FileType } from '../../../files.ts';
import { FILE_TYPES_TEXT, MEDIA_TYPES_TEXT } from '../../types.ts';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'heic' | 'heif' | 'gif' | 'svg';

export interface SniffedImage {
	ok: true;
	format: ImageFormat;
	/** The key's extension: from the type, never the file's name. */
	ext: string;
	/** The object's Content-Type. */
	mime: string;
	/** As displayed: after EXIF orientation 5–8 (or `irot` 90°/270°) swaps them. */
	w: number;
	h: number;
}

/** M6c G4: a file the library takes (Decision 1), as its row in the file-type table. */
export interface SniffedFile {
	ok: true;
	format: 'file';
	/** The key's extension: from the bytes (and, for a legacy Office file or a CSV, the name once the bytes allow it). */
	ext: string;
	mime: string;
	type: FileType;
}

export interface SniffRefusal {
	ok: false;
	code: 'not-an-image' | 'unknown-type' | 'no-size' | 'macro-enabled' | 'not-a-csv' | 'unnamed-office';
	message: string;
}

const FORMATS: Record<ImageFormat, { ext: string; mime: string }> = {
	jpeg: { ext: 'jpg', mime: 'image/jpeg' },
	png: { ext: 'png', mime: 'image/png' },
	webp: { ext: 'webp', mime: 'image/webp' },
	avif: { ext: 'avif', mime: 'image/avif' },
	heic: { ext: 'heic', mime: 'image/heic' },
	heif: { ext: 'heif', mime: 'image/heif' },
	gif: { ext: 'gif', mime: 'image/gif' },
	svg: { ext: 'svg', mime: 'image/svg+xml' },
};

/** What every refusal says the library takes (M6c G4: images and files). */
const TAKES = `images (${MEDIA_TYPES_TEXT}) and files (${FILE_TYPES_TEXT})`;
/** Decision 6's sentence for a file the bytes can name ("a video"). */
export const namedTypeMessage = (what: string) => `This is ${what}. The library takes ${TAKES}.`;
/** Decision 6's sentence for a file the bytes can't name. */
export const UNKNOWN_TYPE_MESSAGE = `This file isn't one the library can take. It takes ${TAKES}.`;
export const SVG_NO_SIZE_MESSAGE = "This SVG has no size (no viewBox, and no width and height), so the library can't place it. Add a viewBox and upload it again.";

const refuse = (code: SniffRefusal['code'], message: string): SniffRefusal => ({ ok: false, code, message });
const unknown = (): SniffRefusal => refuse('unknown-type', UNKNOWN_TYPE_MESSAGE);
const named = (what: string): SniffRefusal => refuse('not-an-image', namedTypeMessage(what));

function image(format: ImageFormat, w: number, h: number, swap = false): SniffedImage | SniffRefusal {
	if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) return unknown();
	return { ok: true, format, ...FORMATS[format], w: swap ? h : w, h: swap ? w : h };
}

/** Bounds-checked reads: out of range is `undefined`/NaN, which every caller treats as "not this". */
class Bytes {
	readonly b: Uint8Array;
	constructor(b: Uint8Array) {
		this.b = b;
	}
	get length() {
		return this.b.length;
	}
	u8(i: number): number {
		return i >= 0 && i < this.b.length ? this.b[i]! : NaN;
	}
	u16be(i: number) {
		return this.u8(i) * 256 + this.u8(i + 1);
	}
	u16le(i: number) {
		return this.u8(i) + this.u8(i + 1) * 256;
	}
	u24le(i: number) {
		return this.u8(i) + this.u8(i + 1) * 256 + this.u8(i + 2) * 65536;
	}
	u32be(i: number) {
		return this.u16be(i) * 65536 + this.u16be(i + 2);
	}
	u32le(i: number) {
		return this.u16le(i) + this.u16le(i + 2) * 65536;
	}
	ascii(i: number, n: number): string {
		if (i < 0 || i + n > this.b.length) return '';
		let s = '';
		for (let k = 0; k < n; k++) s += String.fromCharCode(this.b[i + k]!);
		return s;
	}
	starts(...bytes: number[]): boolean {
		return bytes.every((v, k) => this.b[k] === v);
	}
}

/** Sniff a whole file. Never throws. */
export function sniffImage(data: Uint8Array): SniffedImage | SniffRefusal {
	const b = new Bytes(data);
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
		return text(data);
	} catch {
		return unknown();
	}
}

// ── JPEG ──────────────────────────────────────────────────────────────────────

function jpeg(b: Bytes): SniffedImage | SniffRefusal {
	let orientation = 1;
	let i = 2;
	while (i + 3 < b.length) {
		if (b.u8(i) !== 0xff) return unknown();
		const marker = b.u8(i + 1);
		if (marker === 0xff) {
			i++; // fill byte
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			i += 2; // markers with no length
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) break; // end of image, or the scan, before any frame header
		const len = b.u16be(i + 2);
		if (!(len >= 2)) break;
		if (marker === 0xe1 && b.ascii(i + 4, 6) === 'Exif\0\0') orientation = exifOrientation(b, i + 10, i + 2 + len) ?? orientation;
		// SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC): height then width.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return image('jpeg', b.u16be(i + 7), b.u16be(i + 5), swaps(orientation));
		}
		i += 2 + len;
	}
	return unknown();
}

/** EXIF orientations 5–8 turn the picture a quarter, so the shown width is the stored height. */
const swaps = (orientation: number) => orientation >= 5 && orientation <= 8;

/** The orientation tag (0x0112) in IFD0 of a TIFF structure at `tiff`, within `end`; null when there's none. */
function exifOrientation(b: Bytes, tiff: number, end: number): number | null {
	const order = b.ascii(tiff, 2);
	if (order !== 'II' && order !== 'MM') return null;
	const le = order === 'II';
	const u16 = (o: number) => (o + 2 <= end ? (le ? b.u16le(o) : b.u16be(o)) : NaN);
	const u32 = (o: number) => (o + 4 <= end ? (le ? b.u32le(o) : b.u32be(o)) : NaN);
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

// ── PNG ───────────────────────────────────────────────────────────────────────

function png(b: Bytes): SniffedImage | SniffRefusal {
	if (b.ascii(12, 4) !== 'IHDR') return unknown();
	const w = b.u32be(16);
	const h = b.u32be(20);
	// An eXIf chunk's orientation (imgproxy rotates by it, as for a JPEG). It must come before IDAT.
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

// ── WebP ──────────────────────────────────────────────────────────────────────

function webp(b: Bytes): SniffedImage | SniffRefusal {
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
	// An extended file's EXIF chunk (orientation), wherever it sits.
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

// ── AVIF and HEIC/HEIF (ISO base media) ───────────────────────────────────────

const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);
const VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'qt  ', 'M4V ', 'M4VP', '3gp4', '3gp5', '3gp6', '3g2a', 'avc1', 'dash', 'MSNV', 'f4v ', 'crx ']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ']);

interface Box {
	type: string;
	/** The box's content (after its header). */
	start: number;
	end: number;
}

/** The boxes in [from, to). */
function boxes(b: Bytes, from: number, to: number): Box[] {
	const out: Box[] = [];
	for (let i = from; i + 8 <= to && out.length < 4096; ) {
		let size = b.u32be(i);
		const type = b.ascii(i + 4, 4);
		let header = 8;
		if (size === 1) {
			const high = b.u32be(i + 8);
			const low = b.u32be(i + 12);
			if (high !== 0) break; // over 4 GB: not in a 40 MB file
			size = low;
			header = 16;
		} else if (size === 0) size = to - i;
		if (!(size >= header) || i + size > to || type === '') break;
		out.push({ type, start: i + header, end: i + size });
		i += size;
	}
	return out;
}

function isoMedia(b: Bytes): SniffedImage | SniffRefusal {
	const top = boxes(b, 0, b.length);
	const ftyp = top[0];
	if (!ftyp || ftyp.type !== 'ftyp') return unknown();
	const brands = new Set<string>([b.ascii(ftyp.start, 4)]);
	for (let i = ftyp.start + 8; i + 4 <= ftyp.end; i += 4) brands.add(b.ascii(i, 4));
	const has = (set: Set<string>) => [...brands].some((x) => set.has(x));
	const format: ImageFormat | null = has(AVIF_BRANDS) ? 'avif' : has(HEIC_BRANDS) ? 'heic' : has(HEIF_BRANDS) ? 'heif' : null;
	if (!format) {
		if (has(VIDEO_BRANDS)) return named('a video');
		if (has(AUDIO_BRANDS)) return named('an audio file');
		return unknown();
	}
	const meta = top.find((x) => x.type === 'meta');
	if (!meta) return unknown();
	const size = primarySize(b, meta.start + 4, meta.end); // meta is a full box: skip version and flags
	return size ? image(format, size.w, size.h, size.quarter) : unknown();
}

/** The primary item's `ispe` and `irot` (HEIF's own rotation; EXIF's isn't used for HEIF). */
function primarySize(b: Bytes, from: number, to: number): { w: number; h: number; quarter: boolean } | null {
	const children = boxes(b, from, to);
	const pitm = children.find((x) => x.type === 'pitm');
	const primary = pitm ? (b.u8(pitm.start) === 0 ? b.u16be(pitm.start + 4) : b.u32be(pitm.start + 4)) : NaN;
	const iprp = children.find((x) => x.type === 'iprp');
	if (!iprp) return null;
	const inner = boxes(b, iprp.start, iprp.end);
	const ipco = inner.find((x) => x.type === 'ipco');
	if (!ipco) return null;
	const props = boxes(b, ipco.start, ipco.end); // 1-based in ipma
	// The primary item's property indexes, from every ipma box.
	const mine = new Set<number>();
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
	const ispeOf = (p: Box) => ({ w: b.u32be(p.start + 4), h: b.u32be(p.start + 8) });
	let size: { w: number; h: number } | null = null;
	let quarter = false;
	props.forEach((p, k) => {
		if (!mine.has(k + 1)) return;
		if (p.type === 'ispe') size = ispeOf(p);
		if (p.type === 'irot') quarter = (b.u8(p.start) & 3) % 2 === 1;
	});
	if (!size) {
		// No association read: the largest ispe is the full picture (the others are tiles and thumbnails).
		for (const p of props) {
			if (p.type !== 'ispe') continue;
			const s = ispeOf(p);
			if (!size || s.w * s.h > size.w * size.h) size = s;
		}
		if (!size) return null;
		quarter = props.some((p) => p.type === 'irot' && (b.u8(p.start) & 3) % 2 === 1);
	}
	const found = size as { w: number; h: number };
	return { w: found.w, h: found.h, quarter };
}

// ── Other files the bytes can name ────────────────────────────────────────────

function otherType(b: Bytes): string | null {
	if (b.ascii(0, 5) === '%PDF-') return 'a PDF';
	if (b.starts(0x50, 0x4b, 0x03, 0x04) || b.starts(0x50, 0x4b, 0x05, 0x06)) return 'a ZIP file';
	if (b.ascii(0, 2) === 'MZ' || b.starts(0x7f, 0x45, 0x4c, 0x46) || isMachO(b) || b.ascii(0, 2) === '#!') return 'a program';
	if (b.starts(0x1a, 0x45, 0xdf, 0xa3)) return 'a video'; // WebM, MKV
	if (b.ascii(0, 4) === 'OggS' || b.ascii(0, 4) === 'fLaC' || b.ascii(0, 3) === 'ID3') return 'an audio file';
	if (b.starts(0x49, 0x49, 0x2a, 0x00) || b.starts(0x4d, 0x4d, 0x00, 0x2a)) return 'a TIFF or camera raw image';
	if (b.ascii(0, 4) === '8BPS') return 'a Photoshop file';
	if (b.starts(0xff, 0x0a) || (b.u32be(0) === 12 && b.ascii(4, 4) === 'JXL ')) return 'a JPEG XL image';
	if (b.ascii(0, 2) === 'BM' && b.u32le(2) > 26 && b.u16le(26) === 1) return 'a BMP image';
	if (b.starts(0x00, 0x00, 0x01, 0x00) && b.u16le(4) > 0) return 'an icon file';
	if (b.ascii(0, 4) === 'Rar!' || b.starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) || b.starts(0x1f, 0x8b)) return 'a compressed file';
	if (b.starts(0xd0, 0xcf, 0x11, 0xe0)) return 'an Office document';
	if (b.ascii(0, 5) === '{\\rtf') return 'a document';
	if (b.u8(0) === 0xff && (b.u8(1) & 0xe0) === 0xe0) return 'an audio file'; // an MP3 frame
	return null;
}

/** A Mach-O binary (32- or 64-bit, either byte order, or a universal one with a small arch count: CAFEBABE is also a Java class). */
function isMachO(b: Bytes): boolean {
	const m = b.u32be(0);
	if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe) return true;
	return m === 0xcafebabe && b.u32be(4) > 0 && b.u32be(4) < 20;
}

// ── Files (M6c G4, Decision 1) ────────────────────────────────────────────────

const typeOf = (ext: string): FileType => fileTypeOf(`x.${ext}`)!;
const file = (ext: string): SniffedFile => {
	const type = typeOf(ext);
	return { ok: true, format: 'file', ext: type.ext, mime: type.contentType, type };
};

/** The ordinary format to save as, for a macro-enabled one's sentence. */
const ORDINARY: Record<string, string> = {
	docx: 'This Word document has macros, which the library doesn’t take. Save it as an ordinary Word document (.docx) and upload that.',
	xlsx: 'This Excel file has macros, which the library doesn’t take. Save it as an ordinary Excel workbook (.xlsx) and upload that.',
	pptx: 'This PowerPoint file has macros, which the library doesn’t take. Save it as an ordinary PowerPoint presentation (.pptx) and upload that.',
};

export const NOT_A_CSV_MESSAGE = 'Not plain-text CSV. Export as CSV (UTF-8).';
export const UNNAMED_OFFICE_MESSAGE = 'This is an older Office file, and its name doesn’t say which kind (.doc, .xls or .ppt). Save it in the current format (.docx, .xlsx or .pptx) and upload that.';

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const LEGACY = new Set(['doc', 'xls', 'ppt']);
/** How much of `[Content_Types].xml` is read: far more than any real one. */
const CONTENT_TYPES_CAP = 1_000_000;

/**
 * A file the library takes, a refusal that's a file's own (macros, a CSV that isn't text,
 * an unnamed legacy Office file), or null when the bytes aren't a file of the table's
 * (the image sniffer's sentence stands). Never throws.
 */
export function sniffFile(data: Uint8Array, name: string): SniffedFile | SniffRefusal | null {
	const b = new Bytes(data);
	if (b.length === 0) return null;
	try {
		if (b.ascii(0, 5) === '%PDF-') return file('pdf');
		if (b.starts(0x50, 0x4b, 0x03, 0x04) || b.starts(0x50, 0x4b, 0x05, 0x06)) return zipOrOffice(b);
		const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
		if (b.starts(...OLE)) {
			// The name's narrow exception (1): an OLE file is a legacy Office one only by its name's extension.
			return LEGACY.has(ext) ? file(ext) : refuse('unnamed-office', UNNAMED_OFFICE_MESSAGE);
		}
		// The name's narrow exception (2): text is a CSV only when it's called one.
		if (ext === 'csv') return isText(data) ? file('csv') : refuse('not-a-csv', NOT_A_CSV_MESSAGE);
		return null;
	} catch {
		return null;
	}
}

/** Valid UTF-8 (a BOM allowed) with no NUL byte. */
function isText(data: Uint8Array): boolean {
	if (data.includes(0)) return false;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(data);
		return true;
	} catch {
		return false;
	}
}

interface ZipEntry {
	name: string;
	method: number;
	compressed: number;
	size: number;
	local: number;
}

/** The zip's entries, from its central directory; null when it can't be read (a damaged or truncated file). */
function zipEntries(b: Bytes): ZipEntry[] | null {
	// The end-of-central-directory record: the last 22 bytes, or up to 64 KB more of comment before them.
	let eocd = -1;
	for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 0xffff; i--) {
		if (b.u32le(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return null;
	const count = b.u16le(eocd + 10);
	const offset = b.u32le(eocd + 16);
	if (!(offset >= 0) || offset > eocd) return null;
	const out: ZipEntry[] = [];
	for (let i = offset, n = 0; n < count && n < 65535; n++) {
		if (b.u32le(i) !== 0x02014b50) return null;
		const nameLength = b.u16le(i + 28);
		const extra = b.u16le(i + 30);
		const comment = b.u16le(i + 32);
		const name = b.ascii(i + 46, nameLength);
		if (!(nameLength >= 0) || (nameLength > 0 && name === '')) return null;
		out.push({ name, method: b.u16le(i + 10), compressed: b.u32le(i + 20), size: b.u32le(i + 24), local: b.u32le(i + 42) });
		i += 46 + nameLength + extra + comment;
	}
	return out;
}

/** One entry's bytes (stored or deflated), up to `cap`; null when they can't be read. */
function zipRead(b: Bytes, entry: ZipEntry, cap: number): Uint8Array | null {
	const at = entry.local;
	if (b.u32le(at) !== 0x04034b50) return null;
	const start = at + 30 + b.u16le(at + 26) + b.u16le(at + 28);
	const end = start + entry.compressed;
	if (!(start >= 0) || !(end <= b.length)) return null;
	const raw = b.b.subarray(start, end);
	if (entry.method === 0) return raw.subarray(0, cap);
	if (entry.method !== 8) return null;
	try {
		return new Uint8Array(inflateRawSync(raw, { maxOutputLength: cap }));
	} catch {
		return null;
	}
}

function zipOrOffice(b: Bytes): SniffedFile | SniffRefusal {
	const entries = zipEntries(b);
	if (!entries) return unknown();
	const names = entries.map((e) => e.name);
	const types = entries.find((e) => e.name === '[Content_Types].xml');
	const office = !types ? null : names.some((n) => n.startsWith('word/')) ? 'docx' : names.some((n) => n.startsWith('xl/')) ? 'xlsx' : names.some((n) => n.startsWith('ppt/')) ? 'pptx' : null;
	if (!office) return file('zip');
	const xml = zipRead(b, types!, CONTENT_TYPES_CAP);
	const macros = (xml && /macroEnabled/i.test(new TextDecoder('utf-8', { fatal: false }).decode(xml))) || names.some((n) => /^(word|xl|ppt)\/vbaProject\.bin$/i.test(n));
	if (macros) return refuse('macro-enabled', ORDINARY[office]!);
	return file(office);
}

/**
 * What an upload is (M6c G4): an image, else a file of the table's, else the image
 * sniffer's refusal (which names what the bytes are when they say). `name` is the
 * uploaded file's name, read only for Decision 1's two narrow exceptions.
 */
export function sniffUpload(data: Uint8Array, name: string): SniffedImage | SniffedFile | SniffRefusal {
	const image = sniffImage(data);
	if (image.ok || image.code === 'no-size') return image;
	return sniffFile(data, name) ?? image;
}

// ── SVG (text) ────────────────────────────────────────────────────────────────

/** How far into a text file the root element is looked for. */
const TEXT_SCAN = 1_000_000;

function text(data: Uint8Array): SniffedImage | SniffRefusal {
	const head = data.subarray(0, Math.min(data.length, TEXT_SCAN));
	if (head.includes(0)) return unknown(); // binary
	let s = new TextDecoder('utf-8', { fatal: false }).decode(head);
	if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	let i = 0;
	const skipSpace = () => {
		while (i < s.length && /\s/.test(s[i]!)) i++;
	};
	// The prolog: an XML declaration, processing instructions, comments and a doctype.
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
			// Skipped, internal subset and all: nothing in it is ever read, let alone resolved.
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
	const local = root[2]!.toLowerCase();
	if (local === 'html') return named('a web page');
	if (root[2] !== 'svg') return unknown();
	// The root's attributes, up to its first unquoted `>`.
	const attrs: Record<string, string> = {};
	const re = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
	let j = i + root[0].length;
	for (let guard = 0; guard < 1000; guard++) {
		re.lastIndex = j;
		const m = re.exec(s);
		if (!m) break;
		attrs[m[1]!] = m[2] ?? m[3] ?? '';
		j = re.lastIndex;
	}
	if (!/^\s*\/?>/.test(s.slice(j, j + 64))) return unknown();
	const viewBox = attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
	if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0) {
		return image('svg', Math.max(1, Math.round(viewBox[2]!)), Math.max(1, Math.round(viewBox[3]!)));
	}
	const px = (v: string | undefined) => {
		const m = v?.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/);
		return m ? Math.max(1, Math.round(Number(m[1]))) : NaN;
	};
	const w = px(attrs.width);
	const h = px(attrs.height);
	if (w > 0 && h > 0) return image('svg', w, h);
	return refuse('no-size', SVG_NO_SIZE_MESSAGE);
}

/** Does the 50-megapixel cap apply? Not to an SVG: it's drawn at any size, and imgproxy passes it through. */
export const countsPixels = (format: ImageFormat) => format !== 'svg';
