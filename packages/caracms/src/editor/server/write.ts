/**
 * The write route's logic: M3's one security boundary (Decision 5, Watch-outs).
 *
 * The route takes a path and writes to disk, so it's treated as a boundary even
 * though it only exists under `astro dev` (Decision 4):
 *
 * - **POST only, JSON only.** Anything else is 405 or 415. A request that says it
 *   comes from another site (`Origin` not this host, or `Sec-Fetch-Site` cross-site
 *   or same-site) is 403, so a page open in another tab can't write through a
 *   developer's dev server. curl and the editor itself send neither and pass.
 * - **Confined** (`confineDocumentFile`): the target is a document file inside a
 *   declared collection's folder, or the request is refused with a 400. Refused: an
 *   absolute path, any `..` or `.` segment (so `../`), a backslash or NUL, a target
 *   that isn't `.json`, a folder no collection declares, a dot-file, a nested
 *   `index.json`, and anything content.ts → resolveDocumentFile refuses. Then the
 *   real path: the target's folder, with symlinks resolved, must still be inside the
 *   collection's folder (also resolved), so a link inside a content folder can't
 *   write outside it; a target that is itself a symlink is refused.
 * - **Existing documents only.** The write route never creates a document, so a
 *   target that doesn't exist is 404. Creating and deleting are their own requests
 *   (M5a Phase 3, create.ts), confined the same way.
 * - **The body** is `{ file, base, document }` and nothing else is accepted: a
 *   malformed body is 400. `document` is normalised by the schema
 *   (document.ts → normaliseDocument), then applied to `base` by the serializer
 *   (serialize.ts → applyEdits); a serializer refusal (a `source` that isn't in the
 *   base, a base that isn't a JSON object) is 400.
 * - **Atomic:** the new text goes to a temp file in the same folder, then is renamed
 *   over the document. A text identical to what's on disk isn't written at all.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SETTINGS_PATH, type ResolvedSite } from '../../config.ts';
import { DocumentError, resolveDocumentFile } from '../../content.ts';
import { normaliseAnyDocument, type AnyDocument } from '../../document.ts';
import type { Person } from '../../live/messages.ts';
import { RELEASE_HEADER, SEQ_HEADER, TAB_HEADER } from '../types.ts';
import { applyDocumentEdits } from '../../serialize.ts';
import { readCappedText } from '../../body.ts';

/** The body the editor POSTs to the write route. */
export interface WriteRequest {
	/** The document's file, relative to the site's root, `/`-separated: DocumentEntry.file. */
	file: string;
	/**
	 * The file's text as the editor first read it: the serializer's base, which the
	 * blocks' `source` indexes point into (serialize.ts). It travels with every write,
	 * including edits re-sent from the browser's storage after a restart.
	 */
	base: string;
	/** The whole document as the editor has it: any kind, the file's collection's (M5a). */
	document: AnyDocument;
}

/** 200: the document is on disk as the editor has it. */
export interface WriteResponse {
	ok: true;
	file: string;
	/** False when the file already held exactly this text (nothing was written). */
	changed: boolean;
	/** The file's modification time after the write, ms since the epoch. */
	mtimeMs: number;
	/** The file's version after the write (fileVersion of its text). */
	version: string;
}

/** Any refusal: `{ error }`, a plain sentence, with a 4xx or 5xx status. */
export interface WriteError {
	error: string;
	/** Live mode: `locked` (409), `signed-out` (401), `unavailable` (503), `no-tab` (400). */
	code?: string;
}

export class WriteRefused extends Error {
	readonly status: number;
	/** More of the answer's body beside `error` (live mode's 409 carries the lock's state). */
	readonly body: Record<string, unknown>;
	constructor(status: number, message: string, body: Record<string, unknown> = {}) {
		super(message);
		this.name = 'WriteRefused';
		this.status = status;
		this.body = body;
	}
}

/** The tab id from the header, or null when it's missing or not an id (8–64 of A–Z, a–z, 0–9, `-`, `_`). */
export function tabOf(request: Request): string | null {
	const tab = request.headers.get(TAB_HEADER)?.trim() ?? '';
	return /^[A-Za-z0-9_-]{8,64}$/.test(tab) ? tab : null;
}

/** Who is writing, from where (M4). Local mode ignores it. */
export interface WriteContext {
	/** The signed-in person (live mode; null in local mode). */
	person: Person | null;
	/** The tab's id (`X-Caracms-Tab`), or null. */
	tab: string | null;
	/** `X-Caracms-Release: 1`: this is the closing tab's last write. */
	release: boolean;
	/** `X-Caracms-Seq`: the tab's own write sequence, rising with every write (null when absent). */
	seq?: number | null;
}

/** The tab's write sequence from the header: a safe non-negative integer, else null. */
export function seqOf(request: Request): number | null {
	const raw = request.headers.get(SEQ_HEADER)?.trim() ?? '';
	if (!/^\d{1,16}$/.test(raw)) return null;
	const n = Number(raw);
	return Number.isSafeInteger(n) ? n : null;
}

/** Largest body accepted. A content file is a few KB; this is generous. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

type Site = Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>;

export interface ConfinedFile {
	collection: string;
	/** The document's path in its collection (content.ts → DocumentEntry.path). */
	path: string;
	/** The absolute file. */
	absolute: string;
}

/**
 * Check a requested file against the site's declared collections and return where
 * it is, or throw WriteRefused (400 for a path that isn't allowed, 404 for a
 * document that doesn't exist). Reads the disk only to resolve symlinks.
 */
export async function confineDocumentFile(site: Site, file: unknown): Promise<ConfinedFile> {
	const { collection: name, path, absolute } = confinePath(site, file);
	const collection = site.collections[name]!;
	return { collection: name, path, absolute: await onDisk(collection, path, absolute, file as string) };
}

/**
 * The path rules alone (no disk): what `confineDocumentFile` checks before it looks at
 * the file. Live mode (M4 Decision 4) uses this, then checks existence against the
 * in-memory `drafts` copy instead of the disk.
 */
export function confinePath(site: Site, file: unknown): ConfinedFile {
	const refuse = (message: string) => new WriteRefused(400, message);
	if (typeof file !== 'string' || file.length === 0) throw refuse('"file" must be the document\'s path, relative to the site.');
	if (file.length > 1024) throw refuse('That path is too long.');
	if (file.includes('\0') || file.includes('\\')) throw refuse(`"${printable(file)}" isn't a document path.`);
	if (isAbsolute(file) || /^[a-zA-Z]:/.test(file)) throw refuse(`"${printable(file)}" is an absolute path; send it relative to the site.`);
	const segments = file.split('/');
	if (segments.some((s) => s === '' || s === '.' || s === '..')) throw refuse(`"${printable(file)}" isn't a document path (no "..", "." or empty parts).`);
	if (!file.endsWith('.json')) throw refuse(`"${printable(file)}" isn't a .json document.`);

	// The collection whose folder holds it (the deepest, if folders sit inside each other).
	const absolute = resolve(site.root, file);
	let match: { name: string; dir: string } | null = null;
	for (const [name, collection] of Object.entries(site.collections)) {
		// Site Settings (M5a Decision 8) is one file, however its folder is shared: only that file is its.
		if (collection.kind === 'settings' && absolute !== resolve(collection.dir, `${SETTINGS_PATH}.json`)) continue;
		const inside = relative(collection.dir, absolute);
		if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue;
		if (!match || collection.dir.length > match.dir.length) match = { name, dir: collection.dir };
	}
	if (!match) throw refuse(`"${printable(file)}" isn't in a folder any collection declares.`);

	const path = relative(match.dir, absolute).split(sep).join('/').slice(0, -'.json'.length);
	let confined: string;
	try {
		confined = resolveDocumentFile(site, match.name, path);
	} catch (error) {
		if (error instanceof DocumentError) throw refuse(error.message);
		throw error;
	}
	if (confined !== absolute) throw refuse(`"${printable(file)}" isn't a document path.`);
	const collection = site.collections[match.name]!;
	if (collection.nested && path.endsWith('/index')) {
		throw refuse(`"${printable(file)}": index.json only means the top of ${collection.label}, so it can't be written.`);
	}
	return { collection: match.name, path, absolute };
}

/** The disk half: the file exists, is a plain file, and no link leads it outside its collection's folder. */
async function onDisk(collection: Site['collections'][string], path: string, absolute: string, file: string): Promise<string> {
	const refuse = (message: string) => new WriteRefused(400, message);
	// Symlinks: the folder the file is in, resolved, must still be inside the collection's folder, resolved.
	let realDir: string;
	let realParent: string;
	try {
		realDir = await realpath(collection.dir);
		realParent = await realpath(dirname(absolute));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WriteRefused(404, `${collection.label}: no document "${path}".`);
		throw error;
	}
	if (realParent !== realDir && !realParent.startsWith(realDir + sep)) {
		throw refuse(`"${printable(file)}" leads outside ${collection.label}'s folder through a link.`);
	}
	const target = join(realParent, basename(absolute));
	let info;
	try {
		info = await lstat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WriteRefused(404, `${collection.label}: no document "${path}".`);
		throw error;
	}
	if (info.isSymbolicLink()) throw refuse(`"${printable(file)}" is a link; the editor only writes plain files.`);
	if (!info.isFile()) throw refuse(`"${printable(file)}" isn't a file.`);
	return target;
}

/** Validate the parsed body's shape. Throws WriteRefused 400 with what's wrong. */
export function parseWriteBody(body: unknown): WriteRequest {
	const refuse = (message: string) => new WriteRefused(400, `Malformed body: ${message} Send { file, base, document }.`);
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('it must be a JSON object.');
	const { file, base, document, ...rest } = body as Record<string, unknown>;
	const extra = Object.keys(rest);
	if (extra.length > 0) throw refuse(`unexpected ${extra.map((k) => `"${printable(k)}"`).join(', ')}.`);
	if (typeof file !== 'string') throw refuse('"file" must be a string.');
	if (typeof base !== 'string') throw refuse('"base" must be the file\'s text as first read.');
	if (!document || typeof document !== 'object' || Array.isArray(document)) throw refuse('"document" must be an object.');
	const doc = document as Record<string, unknown>;
	if (typeof doc.title !== 'string') throw refuse('"document.title" must be a string.');
	const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
	const checkBlock = (b: unknown, i: number | null) => {
		const which = i === null ? '"document.block"' : `block ${i}`;
		if (!isObject(b)) throw refuse(`${which} must be an object.`);
		const block = b as Record<string, unknown>;
		if (i !== null && !(block.source === null || (Number.isSafeInteger(block.source) && (block.source as number) >= 0))) {
			throw refuse(`${which}: "source" must be its index in the file as read, or null.`);
		}
		if (typeof block.type !== 'string') throw refuse(`${which}: "type" must be a string.`);
		if (!isObject(block.data)) throw refuse(`${which}: "data" must be an object.`);
	};
	switch (doc.kind) {
		case undefined:
		case 'sections':
			if (!Array.isArray(doc.blocks)) throw refuse('"document.blocks" must be an array.');
			doc.blocks.forEach((b, i) => checkBlock(b, i));
			break;
		case 'fields':
		case 'settings':
			if (!isObject(doc.data)) throw refuse('"document.data" must be an object.');
			break;
		case 'shared':
			checkBlock(doc.block, null);
			break;
		default:
			throw refuse('"document.kind" must be "fields", "shared", "settings", or absent for a section builder.');
	}
	return { file, base, document: document as AnyDocument };
}

/**
 * The text a write leaves: the request's document, normalised by its collection's
 * schema, applied to its base (M5a: any kind). Throws WriteRefused 400 when it
 * doesn't apply, or isn't the collection's kind.
 */
export function writeText(site: Site, collection: string, request: WriteRequest): string {
	const c = site.collections[collection]!;
	if ((request.document.kind ?? 'sections') !== c.kind) {
		throw new WriteRefused(400, `That's a ${request.document.kind ?? 'sections'} document, but ${c.label} holds ${c.kind} documents.`);
	}
	try {
		return applyDocumentEdits(request.base, normaliseAnyDocument(request.document, site, c), site, c);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WriteRefused(400, `The edits don't apply to the base sent with them (${message}).`);
	}
}

/**
 * Refuse a request that comes from another site. The editor's own requests are
 * same-origin; curl sends neither header.
 */
export function checkOrigin(request: Request): void {
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
		throw new WriteRefused(403, 'Writes are only accepted from the editor on this site.');
	}
	const origin = request.headers.get('origin');
	if (origin === null) return;
	let host: string | null = null;
	try {
		host = new URL(origin).host; // "null" (a sandboxed frame, a file) doesn't parse: refused
	} catch {
		/* refused below */
	}
	if (!host || host !== new URL(request.url).host) {
		throw new WriteRefused(403, 'Writes are only accepted from the editor on this site.');
	}
}

/**
 * A file's version: a short hash of its text. The editor compares versions (equal or
 * not), never times, to tell whether a file changed since it last saw it (keeper.ts).
 */
export function fileVersion(text: string): string {
	return createHash('sha256').update(text).digest('base64url').slice(0, 16);
}

/** Write `text` to `file` atomically: a temp file in the same folder, then a rename over it. */
export async function writeAtomic(file: string, text: string): Promise<void> {
	const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
	const mode = (await stat(file).catch(() => null))?.mode;
	try {
		await writeFile(temp, text, { encoding: 'utf8', flag: 'wx', mode: mode === undefined ? 0o644 : mode & 0o777 });
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/** Apply a validated request: confine, serialise, write. Returns the response body. */
export async function applyWrite(site: Site, request: WriteRequest): Promise<WriteResponse> {
	const target = await confineDocumentFile(site, request.file);
	const text = writeText(site, target.collection, request);
	const current = await readFile(target.absolute, 'utf8');
	const changed = current !== text;
	if (changed) await writeAtomic(target.absolute, text);
	const { mtimeMs } = await stat(target.absolute);
	return { ok: true, file: request.file, changed, mtimeMs, version: fileVersion(text) };
}

const json = (status: number, body: WriteResponse | WriteError, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
	});

/**
 * The whole route: a Request in, a Response out. `store` is the drafts store
 * (drafts-store.ts), whose local `write` is applyWrite above.
 */
export async function handleWrite(
	request: Request,
	store: { write(request: WriteRequest, context?: WriteContext): Promise<WriteResponse> },
	who: { person?: Person | null } = {},
): Promise<Response> {
	try {
		if (request.method !== 'POST') throw new WriteRefused(405, 'The write route only takes POST.');
		checkOrigin(request);
		const type = request.headers.get('content-type') ?? '';
		if (!/^application\/json\s*(;|$)/i.test(type)) throw new WriteRefused(415, 'Send JSON (Content-Type: application/json).');
		// caracms-cloud adversarial review, finding 10: counted as it's read, so a chunked body stops at the cap too.
		const raw = await readCappedText(request, MAX_BODY_BYTES);
		if (raw === null) throw new WriteRefused(413, 'That body is too large for a document.');
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			throw new WriteRefused(400, 'Malformed body: it isn\'t valid JSON. Send { file, base, document }.');
		}
		const context: WriteContext = { person: who.person ?? null, tab: tabOf(request), release: request.headers.get(RELEASE_HEADER) === '1', seq: seqOf(request) };
		return json(200, await store.write(parseWriteBody(body), context));
	} catch (error) {
		if (error instanceof WriteRefused) {
			return json(error.status, { error: error.message, ...error.body } as WriteError, error.status === 405 ? { Allow: 'POST' } : {});
		}
		console.error('[caracms] write failed:', error);
		return json(500, { error: `The document couldn't be written (${error instanceof Error ? error.message : String(error)}).` });
	}
}

/** A path for an error message: control characters shown escaped, long ones cut. */
function printable(value: string): string {
	const shown = JSON.stringify(value).slice(1, -1);
	return shown.length > 120 ? `${shown.slice(0, 117)}...` : shown;
}
