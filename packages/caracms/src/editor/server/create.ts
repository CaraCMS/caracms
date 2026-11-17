/**
 * Creating and deleting documents (M5a Phase 3; Decisions 11 and 12): the rules both
 * stores apply, the disk half (local mode), and the two routes' handling.
 *
 * **A security boundary, as the write route is** (M3 Decision 5): these take a path
 * from the browser and make or remove a file. So:
 *
 * - **POST, JSON, same origin**, a small body (`handleCreateDelete`, beside write.ts's
 *   `checkOrigin`); in live mode the guard also wants a session (M4 Decision 14: its
 *   path-prefix rule covers `/_caracms/create` and `/_caracms/delete` with no list), and
 *   the live store refuses a request with no person (401) or no tab (400).
 * - **Confined exactly as the write route is** (`target`): the path goes through
 *   content.ts → `resolveDocumentFile` (no `..`, `.`, empty parts, backslash, NUL,
 *   absolute path or dot-file; one part in a flat collection), and the file it gives
 *   must come back through write.ts → `confinePath` as the same collection and path
 *   (a folder no collection declares, or one inside another collection's folder, is
 *   refused). On disk, **every folder on the way is checked with symlinks resolved**:
 *   an existing one must resolve inside the collection's folder; a missing one is made
 *   inside the resolved parent (`createOnDisk`); a delete goes through write.ts →
 *   `confineDocumentFile` (the parent resolved inside, the file itself not a link).
 * - **Disk: an exclusive create.** The text is serialised first (nothing is touched if
 *   that fails), written to a temp file beside it, then hard-linked into place, which
 *   fails if a file is already there (409) and never leaves half a file under the
 *   document's name. Folders made for it are removed again if it fails.
 * - **Delete** removes the file, then each folder it leaves empty, walking up **to but
 *   never including** the collection's folder, even if that ends up empty.
 *
 * The rules (`planCreate`, `planDelete`), the same in both stores, over the store's own
 * listing (live mode: the copy with autosaves on top):
 *
 * - **Addresses** (slug.ts, browser-safe, the dialog's too): every new part of the path
 *   is one `slugify` leaves as it is (a folder that already has documents in it may be
 *   named otherwise); no part is `index`; nothing left (only symbols) is refused with
 *   the field's message. The public address must be free in every collection, not
 *   under `/admin` or `/_caracms`, and not strictly below another collection's
 *   non-root `urlBase` (exactly at it is allowed).
 * - **A document that exists is 409.** Site Settings is never created or deleted; a
 *   nested collection's `index` (Home) is never deleted; a shared block anything uses
 *   can't be deleted (409 `in-use`, naming where, from the listing's `usedOn`). A page
 *   with pages under it can be: they stay, as a group. Edit in context, Decision 3: a slot's
 *   default can't be deleted (409 `default`), so a slot keeps one block once it has one; another
 *   slot block a page picks is `in-use`, naming a few and "N more".
 * - **The new document's content:** a page `{ "title", "blocks": [] }`; a fields
 *   document `{ "title" }`; a shared block `{ "title", "block": { "type" } }`, with
 *   `"default": true` when its type fills a slot that has no default yet (the first one made).
 */
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, realpath, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { ResolvedCollection, ResolvedSite } from '../../config.ts';
import { DocumentError, documentUrl, resolveDocumentFile, type DocumentEntry } from '../../content.ts';
import { heldBases, holdsMessage, withHeldBases } from '../../held.ts';
import { own, parseAnyDocument, type AnyDocument } from '../../document.ts';
import type { Person } from '../../live/messages.ts';
import { applyDocumentEdits } from '../../serialize.ts';
import { addressProblem, INDEX_MESSAGE, isSlug, NO_ADDRESS_MESSAGE, RESERVED_SLUG, slugify } from '../../slug.ts';
import { RELEASE_HEADER, type CollectionOrderRequest, type CollectionOrderResponse, type CreateDeleteCode, type CreateRequest, type CreateResponse, type DeleteRequest, type DeleteResponse, type SlotDefaultRequest, type SlotDefaultResponse } from '../types.ts';
import { parseSlotDefaultBody } from './slot-default.ts';
import { parseCollectionOrderBody } from './collection-order.ts';
import { checkOrigin, confineDocumentFile, confinePath, seqOf, tabOf, WriteRefused, type WriteContext } from './write.ts';
import { schemaRef, stampSchema } from '../../schema-key.ts';
import { readCappedText } from '../../body.ts';

type Site = Pick<ResolvedSite, 'root' | 'collections' | 'blocks' | 'codeRoutes'>;

/** Largest create or delete body: a collection, a path and a title. */
export const MAX_CREATE_BODY_BYTES = 16 * 1024;
/** The longest title a new document may have. */
export const MAX_TITLE = 200;

const posix = (p: string) => p.split(sep).join('/');

/** A refusal with its code (types.ts → CreateDeleteRefusal). */
export function refused(status: number, code: CreateDeleteCode, message: string, more: Record<string, unknown> = {}): WriteRefused {
	return new WriteRefused(status, message, { code, ...more });
}

/** A path for a message: control characters shown escaped, long ones cut. */
function printable(value: string): string {
	const shown = JSON.stringify(value).slice(1, -1);
	return shown.length > 120 ? `${shown.slice(0, 117)}...` : shown;
}

/** "Home", "Home and About", "Home, About and Work". */
export function andList(items: string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Edit in context, Decision 3: up to `few` named, then "N more": "Home, About, Work and 9 more" (all of them when one more would be left). */
export function fewList(items: string[], few = 3): string {
	if (items.length <= few + 1) return andList(items);
	const more = items.length - few;
	return `${items.slice(0, few).join(', ')} and ${more} more`;
}

// ── Bodies ──────────────────────────────────────────────────────────────────

const object = (body: unknown, shape: string): Record<string, unknown> => {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw refused(400, 'bad-request', `Malformed body: it must be a JSON object. Send ${shape}.`);
	return body as Record<string, unknown>;
};

const onlyKeys = (body: Record<string, unknown>, keys: string[], shape: string) => {
	const extra = Object.keys(body).filter((k) => !keys.includes(k));
	if (extra.length) throw refused(400, 'bad-request', `Malformed body: unexpected ${extra.map((k) => `"${printable(k)}"`).join(', ')}. Send ${shape}.`);
};

const CREATE_SHAPE = '{ collection, path, title } (and blockType for a shared block)';
const DELETE_SHAPE = '{ collection, path }';

/** Validate a create body's shape. Throws WriteRefused 400. */
export function parseCreateBody(body: unknown): CreateRequest {
	const b = object(body, CREATE_SHAPE);
	onlyKeys(b, ['collection', 'path', 'title', 'blockType', 'folder'], CREATE_SHAPE);
	const bad = (message: string) => refused(400, 'bad-request', `Malformed body: ${message} Send ${CREATE_SHAPE}.`);
	if (typeof b.collection !== 'string' || b.collection === '') throw bad('"collection" must be a collection\'s name.');
	if (typeof b.path !== 'string') throw bad('"path" must be the new document\'s path in its collection.');
	if (b.path.length > 512) throw refused(400, 'bad-path', 'That path is too long.');
	if (typeof b.title !== 'string') throw bad('"title" must be a string.');
	const title = b.title.trim();
	if (title === '') throw refused(400, 'bad-name', 'Give it a name.');
	if (title.length > MAX_TITLE) throw refused(400, 'bad-name', `That name is too long (at most ${MAX_TITLE} characters).`);
	// One line (a title is one-line text): no breaks or control characters, which would also reach the commit headlines.
	if (/\p{Cc}/u.test(title)) throw refused(400, 'bad-name', 'A name is one line, with no breaks or control characters.');
	if (b.blockType !== undefined && typeof b.blockType !== 'string') throw bad('"blockType" must be a block type\'s name.');
	if (b.folder !== undefined && (typeof b.folder !== 'string' || b.folder === '' || b.folder.length > 120)) throw bad('"folder" must be a folder\'s id.');
	return { collection: b.collection, path: b.path, title, ...(b.blockType !== undefined ? { blockType: b.blockType as string } : {}), ...(b.folder !== undefined ? { folder: b.folder as string } : {}) };
}

/** Validate a delete body's shape. Throws WriteRefused 400. */
export function parseDeleteBody(body: unknown): DeleteRequest {
	const b = object(body, DELETE_SHAPE);
	onlyKeys(b, ['collection', 'path'], DELETE_SHAPE);
	if (typeof b.collection !== 'string' || b.collection === '') throw refused(400, 'bad-request', `Malformed body: "collection" must be a collection's name. Send ${DELETE_SHAPE}.`);
	if (typeof b.path !== 'string' || b.path === '') throw refused(400, 'bad-request', `Malformed body: "path" must be the document's path in its collection. Send ${DELETE_SHAPE}.`);
	if (b.path.length > 512) throw refused(400, 'bad-path', 'That path is too long.');
	return { collection: b.collection, path: b.path };
}

// ── Confinement ────────────────────────────────────────────────────────────

export interface Target {
	collection: string;
	path: string;
	/** Relative to the site, `/`-separated. */
	file: string;
	/** Absolute, as configured (not symlink-resolved). */
	absolute: string;
}

/**
 * A collection and path as a file, confined as the write route confines a file: the
 * reader's path rules, then write.ts → `confinePath` must give back the same
 * collection and path. Throws WriteRefused 400 (`bad-path`).
 */
export function target(site: Site, collection: string, path: string): Target {
	if (!own(site.collections, collection)) throw refused(400, 'bad-path', `No collection "${printable(collection)}" is declared.`);
	let absolute: string;
	try {
		absolute = resolveDocumentFile(site, collection, path);
	} catch (error) {
		if (error instanceof DocumentError) throw refused(400, 'bad-path', error.message);
		throw error;
	}
	const file = posix(relative(site.root, absolute));
	let confined;
	try {
		confined = confinePath(site, file);
	} catch (error) {
		if (error instanceof WriteRefused) throw refused(400, 'bad-path', error.message);
		throw error;
	}
	if (confined.collection !== collection || confined.path !== path) {
		throw refused(400, 'bad-path', `"${printable(path)}" isn't a document path in ${site.collections[collection]!.label}.`);
	}
	return { collection, path, file, absolute };
}

// ── The rules ──────────────────────────────────────────────────────────────

export interface CreatePlan extends Target {
	title: string;
	/** Its public address; null for a shared block. */
	url: string | null;
	/** The new file's text. */
	text: string;
	/** The new document, as the reader reads `text`. */
	document: AnyDocument;
}

/** The new document's first text (Decision 11), serialised as the write route would. Throws if it can't be. */
export function initialText(site: Site, collection: ResolvedCollection, title: string, blockType: string | undefined, file: string, isDefault = false): string {
	// M8 Decision 14: a new document names its schema, as its first key.
	return stampSchema(firstText(site, collection, title, blockType, isDefault), schemaRef(collection, file));
}

function firstText(site: Site, collection: ResolvedCollection, title: string, blockType: string | undefined, isDefault: boolean): string {
	switch (collection.kind) {
		case 'sections':
			return applyDocumentEdits(null, { title, blocks: [] }, site, collection);
		case 'fields':
			return applyDocumentEdits(null, { kind: 'fields', title, data: {} }, site, collection);
		case 'shared':
			return `${JSON.stringify({ title, ...(isDefault ? { default: true } : {}), block: { type: blockType } }, null, 2)}\n`;
		default:
			throw new Error(`caracms: a ${collection.kind} document is never created`);
	}
}

/**
 * Check a create against the rules and the store's listing (`documents`: every
 * document in every collection now), and work out the new file. Throws WriteRefused.
 */
export function planCreate(configured: Site, request: CreateRequest, documents: readonly DocumentEntry[]): CreatePlan {
	// Collections under pages (Decision 7): a held collection's base is resolved from the listing.
	const bases = heldBases(configured.collections, documents);
	const site = withHeldBases(configured, bases);
	const collection = own(site.collections, request.collection);
	if (!collection) throw refused(400, 'bad-path', `No collection "${printable(request.collection)}" is declared.`);
	if (collection.kind === 'settings') throw refused(400, 'not-allowed', 'Site Settings is always there, so it\'s never created.');
	const unheld = own(bases, collection.name)?.problem;
	if (unheld) throw refused(400, 'not-held', unheld);
	if (request.path === '') throw refused(400, 'bad-name', NO_ADDRESS_MESSAGE);
	if (request.path.split('/').includes(RESERVED_SLUG)) throw refused(400, 'index', INDEX_MESSAGE);

	const where = target(site, collection.name, request.path);
	const parts = where.path.split('/');
	parts.forEach((part, i) => {
		// A folder that already has documents in it keeps its name, whatever it is.
		const prefix = parts.slice(0, i + 1).join('/');
		const existing = i < parts.length - 1 && documents.some((d) => d.collection === collection.name && d.path.startsWith(`${prefix}/`));
		if (existing || isSlug(part)) return;
		const better = slugify(part);
		throw refused(400, 'bad-name', better ? `"${printable(part)}" can't be part of an address; "${better}" can.` : NO_ADDRESS_MESSAGE);
	});

	if (collection.kind === 'shared') {
		if (request.blockType === undefined || request.blockType === '') throw refused(400, 'not-allowed', 'Choose a block type for the shared block.');
		if (!own(site.blocks, request.blockType)) throw refused(400, 'not-allowed', `There's no block type "${printable(request.blockType)}".`);
	} else if (request.blockType !== undefined) {
		throw refused(400, 'bad-request', `Malformed body: "blockType" is only for a shared block. Send ${CREATE_SHAPE}.`);
	}

	const url = documentUrl(collection, where.path);
	if (documents.some((d) => d.file === where.file)) {
		throw refused(409, 'exists', url ? `There's already a page at ${url}.` : `There's already a ${collection.kind === 'shared' ? 'shared block' : 'document'} called "${where.path}".`);
	}
	if (url !== null) {
		const collections = Object.values(site.collections).map(({ name, label, urlBase, heldBy }) => ({ name, label, urlBase, heldBy }));
		const problem = addressProblem(url, collection.name, collections, documents, site.codeRoutes);
		if (problem) throw refused(problem.code === 'address-taken' ? 409 : 400, problem.code, problem.message);
	}

	// Edit in context, Decision 3: the first block made for a slot is its default.
	const slot = collection.kind === 'shared' ? own(site.blocks, request.blockType!)?.slot : undefined;
	const isDefault = !!slot && !documents.some((d) => d.collection === collection.name && d.slot === slot && d.default);
	const text = initialText(site, collection, request.title, request.blockType, where.file, isDefault);
	const document = parseAnyDocument(JSON.parse(text), site, collection);
	return { ...where, title: request.title, url, text, document };
}

export interface DeletePlan extends Target {
	entry: DocumentEntry;
}

/** Check a delete against the rules and the store's listing. Throws WriteRefused. */
export function planDelete(site: Site, request: DeleteRequest, documents: readonly DocumentEntry[]): DeletePlan {
	const collection = own(site.collections, request.collection);
	if (!collection) throw refused(400, 'bad-path', `No collection "${printable(request.collection)}" is declared.`);
	if (collection.kind === 'settings') throw refused(400, 'not-allowed', 'Site Settings can\'t be deleted.');
	const where = target(site, collection.name, request.path);
	const entry = documents.find((d) => d.file === where.file);
	if (collection.nested && where.path === 'index') {
		throw refused(400, 'not-allowed', collection.urlBase === '/' ? 'Home can\'t be deleted.' : `${entry?.label ?? 'This page'} is the top of ${collection.label}, so it can't be deleted.`);
	}
	if (!entry) throw refused(404, 'not-found', `${collection.label}: no document "${printable(where.path)}".`);
	// Collections under pages (Decision 12): a page that holds a collection stays, as Home does.
	const held = entry.holds ? Object.values(site.collections).find((c) => c.name === entry.holds && c.heldBy === collection.name) : undefined;
	if (held) {
		throw refused(409, 'holds', holdsMessage(entry.label, held.label));
	}
	// Edit in context, Decision 3: a slot keeps its default.
	if (collection.kind === 'shared' && entry.slot && entry.default) {
		throw refused(409, 'default', defaultDeleteMessage(entry.label, entry.slot));
	}
	if (collection.kind === 'shared' && entry.usedOn?.length) {
		const usedOn = entry.usedOn.map((u) => ({ ...u, title: documents.find((d) => d.collection === u.collection && d.path === u.path)?.label ?? u.path }));
		const those = usedOn.length === 1 ? 'that page' : 'those pages';
		throw refused(
			409,
			'in-use',
			entry.slot
				? `${entry.label} is the ${entry.slot} ${fewList(usedOn.map((u) => u.title))} ${usedOn.length === 1 ? 'picks' : 'pick'}, so it can't be deleted. Pick another ${entry.slot} on ${those} first.`
				: `${entry.label} is used on ${andList(usedOn.map((u) => u.title))}, so it can't be deleted. Take it off ${those} first.`,
			{ usedOn },
		);
	}
	return { ...where, entry };
}

/** Edit in context, Decision 3: "Footer is the default footer, so it can't be deleted. Make another the default first." */
export function defaultDeleteMessage(title: string, slot: string): string {
	return `${title} is the default ${slot}, so it can't be deleted. Make another the default first.`;
}

// ── The disk (local mode) ──────────────────────────────────────────────────

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * Make the new file, exclusively: every folder on the way checked with symlinks
 * resolved (inside the collection's folder), missing ones made, the text written to a
 * temp file and hard-linked into place (EEXIST: 409). Folders it made are removed if it fails.
 */
export async function createOnDisk(site: Site, plan: CreatePlan): Promise<void> {
	const collection = site.collections[plan.collection]!;
	const outside = () => refused(400, 'bad-path', `"${printable(plan.file)}" leads outside ${collection.label}'s folder through a link.`);
	await mkdir(collection.dir, { recursive: true }); // the config's own folder (an empty collection may not have it yet)
	const realDir = await realpath(collection.dir);
	const inside = (p: string) => p === realDir || p.startsWith(realDir + sep);
	const made: string[] = [];
	try {
		let at = realDir;
		const folders = plan.path.split('/').slice(0, -1);
		for (const [i, name] of folders.entries()) {
			const next = join(at, name);
			try {
				await mkdir(next);
				made.push(next);
				at = next;
				continue;
			} catch (error) {
				if (code(error) !== 'EEXIST') throw error;
			}
			const info = await lstat(next);
			const real = info.isSymbolicLink() ? await realpath(next) : next;
			if (!inside(real)) throw outside();
			if (!(await stat(real)).isDirectory()) throw refused(400, 'bad-path', `"${printable(folders.slice(0, i + 1).join('/'))}" is a file in ${collection.label}, not a folder.`);
			at = real;
		}
		// Once more, now the folders are there: the file's folder, resolved, is still inside.
		const parent = await realpath(at);
		if (!inside(parent)) throw outside();
		const file = join(parent, basename(plan.absolute));
		const temp = join(parent, `.${basename(plan.absolute)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
		await writeFile(temp, plan.text, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
		try {
			await link(temp, file);
		} catch (error) {
			if (code(error) === 'EEXIST') throw refused(409, 'exists', plan.url ? `There's already a page at ${plan.url}.` : `There's already a document called "${plan.path}".`);
			if (code(error) !== 'EPERM' && code(error) !== 'ENOTSUP' && code(error) !== 'EXDEV') throw error;
			// A filesystem with no hard links: an exclusive write of the whole text at once.
			try {
				await writeFile(file, plan.text, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
			} catch (fallback) {
				if (code(fallback) === 'EEXIST') throw refused(409, 'exists', `There's already a document called "${plan.path}".`);
				throw fallback;
			}
		} finally {
			await rm(temp, { force: true });
		}
	} catch (error) {
		for (const dir of made.reverse()) await rmdir(dir).catch(() => {});
		throw error;
	}
}

/**
 * An existing document's file on disk, through write.ts → `confineDocumentFile` (its
 * folder resolved inside its collection's, the file itself not a link), with this
 * route's codes: 400 `bad-path`, 404 `not-found`.
 */
export async function confineOnDisk(site: Site, file: string) {
	try {
		return await confineDocumentFile(site, file);
	} catch (error) {
		if (error instanceof WriteRefused && !error.body.code) throw refused(error.status, error.status === 404 ? 'not-found' : 'bad-path', error.message);
		throw error;
	}
}

/**
 * Remove the file (write.ts → `confineDocumentFile`: inside its collection's folder with
 * links resolved, and not itself a link), then every folder it leaves empty, up to but
 * never including the collection's folder.
 */
export async function deleteOnDisk(site: Site, plan: DeletePlan): Promise<void> {
	const confined = await confineOnDisk(site, plan.file);
	const collection = site.collections[confined.collection]!;
	const realDir = await realpath(collection.dir);
	try {
		await unlink(confined.absolute);
	} catch (error) {
		if (code(error) === 'ENOENT') throw refused(404, 'not-found', `${collection.label}: no document "${plan.path}".`);
		throw error;
	}
	for (let dir = dirname(confined.absolute); dir !== realDir && dir.startsWith(realDir + sep); dir = dirname(dir)) {
		try {
			await rmdir(dir);
		} catch {
			break; // not empty (or gone): the folders above it stay too
		}
	}
}

// ── The routes ─────────────────────────────────────────────────────────────

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
	});

/** What the slot-default route needs of the drafts store. */
interface DraftsStoreSlots {
	slotDefault(request: SlotDefaultRequest, context?: WriteContext): Promise<SlotDefaultResponse>;
}

/** What the routes need of the drafts store. */
export interface CreatesAndDeletes {
	create(request: CreateRequest, context?: WriteContext): Promise<CreateResponse>;
	delete(request: DeleteRequest, context?: WriteContext): Promise<DeleteResponse>;
}

async function handle(request: Request, who: { person?: Person | null }, run: (body: unknown, context: WriteContext) => Promise<unknown>, name: string): Promise<Response> {
	try {
		if (request.method !== 'POST') throw new WriteRefused(405, `The ${name} route only takes POST.`);
		checkOrigin(request);
		const type = request.headers.get('content-type') ?? '';
		if (!/^application\/json\s*(;|$)/i.test(type)) throw new WriteRefused(415, 'Send JSON (Content-Type: application/json).');
		// caracms-cloud adversarial review, finding 10: counted as it's read, so a chunked body stops at the cap too.
		const raw = await readCappedText(request, MAX_CREATE_BODY_BYTES);
		if (raw === null) throw new WriteRefused(413, 'That body is too large.');
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			throw refused(400, 'bad-request', 'Malformed body: it isn\'t valid JSON.');
		}
		const context: WriteContext = { person: who.person ?? null, tab: tabOf(request), release: request.headers.get(RELEASE_HEADER) === '1', seq: seqOf(request) };
		return json(200, await run(body, context));
	} catch (error) {
		if (error instanceof WriteRefused) return json(error.status, { error: error.message, ...error.body }, error.status === 405 ? { Allow: 'POST' } : {});
		console.error(`[caracms] ${name} failed:`, error);
		return json(500, { error: `That didn't work (${error instanceof Error ? error.message : String(error)}).` });
	}
}

/** Edit in context, Decision 3: POST /_caracms/slot-default, through the mode's store (slot-default.ts has the rules). */
export function handleSlotDefault(request: Request, store: Pick<DraftsStoreSlots, 'slotDefault'>, who: { person?: Person | null } = {}): Promise<Response> {
	return handle(request, who, (body, context) => store.slotDefault(parseSlotDefaultBody(body), context), 'slot-default');
}

/** Review gaps (Decisions 2 and 4): POST /_caracms/collection-order, through the mode's store (collection-order.ts has the rules). */
export function handleCollectionOrder(request: Request, store: { collectionOrder(request: CollectionOrderRequest, context?: WriteContext): Promise<CollectionOrderResponse> }, who: { person?: Person | null } = {}): Promise<Response> {
	return handle(request, who, (body, context) => store.collectionOrder(parseCollectionOrderBody(body), context), 'collection-order');
}

/** POST /_caracms/create: a Request in, a Response out, through the mode's store. */
export function handleCreate(request: Request, store: Pick<CreatesAndDeletes, 'create'>, who: { person?: Person | null } = {}): Promise<Response> {
	return handle(request, who, (body, context) => store.create(parseCreateBody(body), context), 'create');
}

/** POST /_caracms/delete: a Request in, a Response out, through the mode's store. */
export function handleDelete(request: Request, store: Pick<CreatesAndDeletes, 'delete'>, who: { person?: Person | null } = {}): Promise<Response> {
	return handle(request, who, (body, context) => store.delete(parseDeleteBody(body), context), 'delete');
}
