/**
 * Files in the library (M6c G4; the spec's Contracts): the
 * one table of file types, and a file's public address as a pure function of its key.
 * **Browser-safe** (no imports): the sniffer, the public route, the link picker, the
 * library, Replace, the missing-file check, `mediaUses` and `<Link>` all read these, and
 * none of them parses a `/files/` address its own way.
 *
 * - A file is stored as `uploads/<12 hex>/<name>.<ext>` (Decisions 1–2), `<ext>` one of
 *   the table's, from the sniffed bytes.
 * - Its address is the key without `uploads/`: `/files/<hash>/<name>.<ext>`, each segment
 *   percent-encoded (slugs keep non-ASCII letters), and `?download` when a PDF link should
 *   download rather than open in a tab (Decisions 3 and 5).
 * - **A file link** is an address under `/files/` of a key's exact shape, with or without
 *   `?download` or a fragment (Decision 4). `/brochure.pdf` from `public/` is not one.
 */

export interface FileType {
	/** The key's extension, lower case, no dot. */
	ext: string;
	/** The `Content-Type` the public route answers with. */
	contentType: string;
	/** What the editor calls it: "PDF", "Word", … */
	label: string;
	/** Opens in a browser tab (PDF only), so its links get the New tab / Download toggle (Decision 5). */
	opensInTab: boolean;
}

/** Decision 1's types, in the order the editor lists them. */
export const FILE_TYPES: readonly FileType[] = [
	{ ext: 'pdf', contentType: 'application/pdf', label: 'PDF', opensInTab: true },
	{ ext: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word', opensInTab: false },
	{ ext: 'doc', contentType: 'application/msword', label: 'Word', opensInTab: false },
	{ ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel', opensInTab: false },
	{ ext: 'xls', contentType: 'application/vnd.ms-excel', label: 'Excel', opensInTab: false },
	{ ext: 'pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint', opensInTab: false },
	{ ext: 'ppt', contentType: 'application/vnd.ms-powerpoint', label: 'PowerPoint', opensInTab: false },
	{ ext: 'csv', contentType: 'text/csv; charset=utf-8', label: 'CSV', opensInTab: false },
	{ ext: 'zip', contentType: 'application/zip', label: 'Zip', opensInTab: false },
];

const BY_EXT = new Map(FILE_TYPES.map((t) => [t.ext, t]));

/** The type a key or name ends in, or null when it isn't one of the table's. */
export function fileTypeOf(keyOrName: string): FileType | null {
	const m = /\.([a-z0-9]+)$/i.exec(keyOrName);
	return m ? (BY_EXT.get(m[1]!.toLowerCase()) ?? null) : null;
}

/** The address prefix, and the folder every key lives in. */
export const FILES_BASE = '/files/';
export const UPLOADS_PREFIX = 'uploads/';

/** A file's name part: no slash, backslash or control character, something before a table extension. */
const NAME = /^[^/\\\u0000-\u001f\u007f]+\.([a-z0-9]+)$/;
const HASH = /^[0-9a-f]{12}$/;

/** Is this a file's key (`uploads/<hash>/<name>.<ext>`, `<ext>` in the table)? Images and submissions aren't. */
export function isFileKey(key: unknown): key is string {
	if (typeof key !== 'string' || !key.startsWith(UPLOADS_PREFIX)) return false;
	const parts = key.slice(UPLOADS_PREFIX.length).split('/');
	if (parts.length !== 2 || !HASH.test(parts[0]!)) return false;
	const m = NAME.exec(parts[1]!);
	return !!m && BY_EXT.has(m[1]!) && parts[1] !== `.${m[1]}`;
}

/** A file key's public address: `/files/<hash>/<name>.<ext>`, each segment encoded, `?download` when asked. */
export function fileAddress(key: string, options: { download?: boolean } = {}): string {
	if (!isFileKey(key)) throw new Error(`Not a file key: ${key}`);
	const [hash, name] = key.slice(UPLOADS_PREFIX.length).split('/') as [string, string];
	return `${FILES_BASE}${hash}/${encodeURIComponent(name)}${options.download ? '?download' : ''}`;
}

/**
 * The inverse: the key and download flag an address names, or null when it isn't a file
 * link. A fragment is ignored; the query must be empty or exactly `download`. The name is
 * decoded once; an encoded slash, a malformed escape or anything not of a key's shape is
 * null. (The public route answers other queries with a 301 first; this is the link side.)
 */
export function fileKeyOf(address: unknown): { key: string; download: boolean } | null {
	if (typeof address !== 'string' || !address.startsWith(FILES_BASE)) return null;
	let rest = address.slice(FILES_BASE.length);
	const hashAt = rest.indexOf('#');
	if (hashAt !== -1) rest = rest.slice(0, hashAt);
	let download = false;
	const q = rest.indexOf('?');
	if (q !== -1) {
		const query = rest.slice(q + 1);
		if (query !== 'download') return null;
		download = true;
		rest = rest.slice(0, q);
	}
	const parts = rest.split('/');
	if (parts.length !== 2) return null;
	let name: string;
	try {
		name = decodeURIComponent(parts[1]!);
	} catch {
		return null;
	}
	const key = `${UPLOADS_PREFIX}${parts[0]}/${name}`;
	return isFileKey(key) ? { key, download } : null;
}

/** Is this address a file link (Decision 4)? */
export const isFileLink = (address: unknown): boolean => fileKeyOf(address) !== null;

/**
 * How a file link behaves on the site (Decision 11), or null for any other address: a PDF
 * without `?download` opens in a new tab; every other file link downloads. `<Link>` and
 * rich text's render use this; a site's own markup can too.
 */
export function fileLinkBehaviour(address: unknown): 'new-tab' | 'download' | null {
	const file = fileKeyOf(address);
	if (!file) return null;
	return fileTypeOf(file.key)?.opensInTab && !file.download ? 'new-tab' : 'download';
}
