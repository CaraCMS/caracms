/**
 * The drafts store (Decision 5): read a document, list documents, write a document,
 * behind one seam (M5a adds creating and deleting one: create.ts has the rules). M3's implementation, here, is the site's content files on disk
 * (local mode). M4's live mode swaps in Redis autosaves over the `drafts` copy
 * behind the same three calls (../../live/drafts-store.ts); server/mode.ts picks one.
 *
 * Everything reads at request time (never imported, Decision 5), and keeps no state.
 */
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SITE_SETTINGS_FILE, type ResolvedSite } from '../../config.ts';
import { diskSource, listDocuments, readDocument, type ContentSource } from '../../content.ts';
import type { AnyOpenedDocument, ArrangeRequest, ArrangeResponse, CollectionOrderRequest, CollectionOrderResponse, CreateRequest, CreateResponse, DeleteRequest, DeleteResponse, ListedDocument, MoveRequest, MoveResponse, OpenedDocument, ReplaceFileRequest, ReplaceFileResponse, SlotDefaultRequest, SlotDefaultResponse } from '../types.ts';
import { confineOnDisk, createOnDisk, deleteOnDisk, planCreate, planDelete, target } from './create.ts';
import { assertSettingsReadable, FOLDER_GONE_MESSAGE, FOLDER_MISSHAPEN_MESSAGE, FOLDER_UNKEPT_MESSAGE, orderEdit, pageFilingEdit, planArrange, UNREADABLE_HAND_ORDER_MESSAGE } from './arrange.ts';
import { firstEdit, planCollectionOrder, settingsUnreadable, UNKEPT_PLACE_MESSAGE } from './collection-order.ts';
import { movesChanges, movesOnDisk, moveResponse, movesUnder, planMoves, settingsWithoutRedirectFrom, type ManyMoveRequest } from './move.ts';
import { replaceChanges, replaceResponse } from './replace.ts';
import { slotDefaultChanges, slotDefaultResponse } from './slot-default.ts';
import { applyWrite, fileVersion, writeAtomic, type WriteContext, type WriteRequest, type WriteResponse } from './write.ts';

export type { AnyOpenedDocument, ListedDocument, OpenedDocument };

export interface DraftsStore {
	/**
	 * Every document, in the editor's order (content.ts → listDocuments), with warnings:
	 * every collection's, the reserved `shared` and `settings` included (M5a Decision 8),
	 * each with its public URL and its kind; a shared block with its `usedOn`.
	 */
	list(): Promise<ListedDocument[]>;
	/** One document, of any kind (M5a). Throws content.ts's DocumentError ('not-found', 'bad-path', a warning code…); one with no title opens (caracms-cloud adversarial review, finding 15). */
	read(collection: string, path: string): Promise<AnyOpenedDocument>;
	/**
	 * The store's content as a content.ts source (M5a Decision 9): what a preview's
	 * render reads other documents from. Local: the disk. Live: the `drafts` copy
	 * with every autosave on top.
	 */
	source(): Promise<ContentSource>;
	/**
	 * Write one document (write.ts: confined, atomic). Throws WriteRefused. `context`
	 * says who and which tab (M4): the live store needs it, the local one ignores it.
	 */
	write(request: WriteRequest, context?: WriteContext): Promise<WriteResponse>;
	/**
	 * Create a document (M5a Decision 11; create.ts has the rules, the same in both
	 * stores). Local: an exclusive create on disk. Live: the creator's tab takes the lock
	 * and the new document is its autosave, with no base in `drafts`. Throws WriteRefused.
	 */
	create(request: CreateRequest, context?: WriteContext): Promise<CreateResponse>;
	/**
	 * Delete a document (M5a Decision 12). Local: the file goes, then the folders it
	 * leaves empty, up to the collection's. Live: the lock, then a "gone" autosave the
	 * sweep commits as a removed file. Throws WriteRefused.
	 */
	delete(request: DeleteRequest, context?: WriteContext): Promise<DeleteResponse>;
	/**
	 * Change a document's address (pre-M7 item 8; move.ts has the rules, the same in both
	 * stores): the document moves, every link and reference to it is rewritten, and Site
	 * Settings gets a redirect from the old address. Collections under pages (Decision 9):
	 * everything under a page moves with it, through `moveMany`. Throws WriteRefused.
	 */
	move(request: MoveRequest, context?: WriteContext): Promise<MoveResponse>;
	/**
	 * The many-move engine (collections under pages, Contracts): every document in the
	 * request at its new path, and each held document whose holder's address changes,
	 * checked as a whole, then applied all or nothing, each linking file rewritten once and
	 * Site Settings written once and last, with every redirect and the caller's own edit.
	 * Local: on disk, put back on a failure. Live: every lock taken up front, every change an
	 * autosave, all rolled back on a failure, all going out at the next Publish. Throws WriteRefused.
	 */
	moveMany(request: ManyMoveRequest, context?: WriteContext): Promise<MoveResponse>;
	/**
	 * Arrange pages (Contracts → Apply request): the roots expanded and checked (arrange.ts →
	 * `planArrange`), then the moves through `moveMany` with the arranged order as its Site
	 * Settings edit, landing or rolling back together; with no moves, Site Settings alone
	 * (live mode: under its lock, Decision 21). Throws WriteRefused.
	 */
	arrange(request: ArrangeRequest, context?: WriteContext): Promise<ArrangeResponse>;
	/**
	 * Review gaps (Decisions 2 and 4): a manual collection's hand order, checked
	 * (collection-order.ts → `planCollectionOrder`), then Site Settings alone. Local: on disk.
	 * Live: under Site Settings' lock (someone else's refuses it, naming them), as one
	 * autosave, going out at the next Publish. Throws WriteRefused.
	 */
	collectionOrder(request: CollectionOrderRequest, context?: WriteContext): Promise<CollectionOrderResponse>;
	/**
	 * M6c G4 (Decision 9): Replace… on a file. Every link to `from`, in every document, points
	 * at `to` (replace.ts has the rules, the same in both stores). Local: each file written
	 * as a local move writes them (no rollback). Live: autosaves under this tab's locks,
	 * landing whole or rolled back. Throws WriteRefused.
	 */
	replaceFile(request: ReplaceFileRequest, context?: WriteContext): Promise<ReplaceFileResponse>;
	/**
	 * Edit in context, Decision 3: a slot block made its slot's default: every other default of
	 * that slot written without it (slot-default.ts has the rules). Local: each file written as a
	 * Replace… writes it. Live: every lock taken first (someone else's refuses it all, naming
	 * them), each an autosave, landing whole or rolled back. Throws WriteRefused.
	 */
	slotDefault(request: SlotDefaultRequest, context?: WriteContext): Promise<SlotDefaultResponse>;
}

type Site = Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>;

/** The local store: the content files on disk. */
export function localDraftsStore(site: Site): DraftsStore {
	const moveMany = async (request: ManyMoveRequest): Promise<MoveResponse> => {
		for (const m of request.moves) await confineOnDisk(site, target(site, m.collection, m.path).file);
		const documents = await listDocuments(site);
		const plans = planMoves(site, request.moves, documents);
		const read = (file: string) => diskSource.readText(join(site.root, file));
		const changes = await movesChanges(site, plans, documents, read, () => request.redirect !== false, request.editSettings);
		await movesOnDisk(site, changes);
		return moveResponse(plans, changes);
	};
	return {
		async list() {
			const entries = await listDocuments(site);
			return Promise.all(
				entries.map(async (entry) => ({
					...entry,
					mtimeMs: await stat(join(site.root, entry.file)).then((s) => s.mtimeMs, () => null),
				})),
			);
		},
		async read(collection, path) {
			const read = await readDocument(site, collection, path, diskSource, { untitled: true });
			const { mtimeMs } = await stat(join(site.root, read.entry.file));
			return { ...read, mtimeMs, version: fileVersion(read.text) };
		},
		write(request) {
			return applyWrite(site, request);
		},
		async create(request) {
			const documents = await listDocuments(site);
			const plan = planCreate(site, request, documents);
			await createOnDisk(site, plan);
			// Pre-M7 item 8: a redirect from this address goes, now a page is here.
			// Review gaps (Decision 4): a manual collection's new entry goes first in its order, in the same write.
			const settings = join(site.root, SITE_SETTINGS_FILE);
			const before = await diskSource.readText(settings);
			const base = settingsWithoutRedirectFrom(site, before, plan.url) ?? before;
			const first = firstEdit(site, plan.collection, plan.path);
			// Page folders: a new page's slug leaves any folder it's still listed in, and New page in <Folder> files it.
			const filing = pageFilingEdit(site, plan.collection, plan.path, request.folder, documents.filter((d) => d.collection === plan.collection).map((d) => d.path));
			const unreadable = settingsUnreadable(site, before);
			const unkept = !!first && unreadable;
			const placed = first && !unkept ? (first(base) ?? base) : base;
			const after = filing && !unreadable ? (filing.edit(placed) ?? placed) : placed;
			if (after !== null && after !== before) {
				if (before === null) await writeFile(settings, after, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
				else await writeAtomic(settings, after);
			}
			const filed = request.folder === undefined || !filing ? {} : unreadable ? { order: 'unkept' as const, orderError: FOLDER_UNKEPT_MESSAGE } : filing.misshapen() ? { order: 'unkept' as const, orderError: FOLDER_MISSHAPEN_MESSAGE } : filing.gone() ? { order: 'unkept' as const, orderError: FOLDER_GONE_MESSAGE } : { order: 'first' as const };
			return { ok: true, collection: plan.collection, path: plan.path, file: plan.file, url: plan.url, version: fileVersion(plan.text), ...(first ? (unkept ? { order: 'unkept' as const, orderError: UNKEPT_PLACE_MESSAGE } : { order: 'first' as const }) : {}), ...filed };
		},
		async delete(request) {
			// The file first (a link out of the collection is refused before anything else), then the rules.
			await confineOnDisk(site, target(site, request.collection, request.path).file);
			const plan = planDelete(site, request, await listDocuments(site));
			await deleteOnDisk(site, plan);
			return { ok: true, collection: plan.collection, path: plan.path, file: plan.file };
		},
		async move(request) {
			// The file first (a link out of the collection is refused before anything else), then the rules.
			await confineOnDisk(site, target(site, request.collection, request.path).file);
			const documents = await listDocuments(site);
			const moves = movesUnder(site, request, documents);
			// Arrange pages (Decision 6): a saved order follows the move, in the same Site Settings write.
			return moveMany({ moves, ...(request.redirect === false ? { redirect: false } : {}), editSettings: orderEdit(site, moves, documents) });
		},
		moveMany,
		async arrange(request) {
			// The files first (a link out of the collection is refused before anything else), then the plan.
			for (const m of request.moves) await confineOnDisk(site, target(site, m.collection, m.fromPath).file);
			const plan = planArrange(site, request, await listDocuments(site));
			// An unreadable Site Settings would drop the order and the redirects without a word: refuse every Apply.
			assertSettingsReadable(site, await diskSource.readText(join(site.root, SITE_SETTINGS_FILE)));
			if (plan.moves.length) {
				await moveMany({ moves: plan.moves, ...(request.redirect === false ? { redirect: false } : {}), editSettings: (text) => plan.edit(text) ?? text });
				return { ok: true };
			}
			const file = join(site.root, SITE_SETTINGS_FILE);
			const before = await diskSource.readText(file);
			assertSettingsReadable(site, before);
			const after = plan.edit(before);
			if (after !== null && after !== before) {
				if (before === null) await writeFile(file, after, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
				else await writeAtomic(file, after);
			}
			return { ok: true };
		},
		async collectionOrder(request) {
			const plan = planCollectionOrder(site, request, await listDocuments(site));
			const file = join(site.root, SITE_SETTINGS_FILE);
			const before = await diskSource.readText(file);
			assertSettingsReadable(site, before, UNREADABLE_HAND_ORDER_MESSAGE);
			const after = plan.edit(before);
			if (after !== null && after !== before) {
				if (before === null) await writeFile(file, after, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
				else await writeAtomic(file, after);
			}
			return { ok: true };
		},
		async replaceFile(request) {
			const changes = await replaceChanges(site, request, await listDocuments(site), (file) => diskSource.readText(join(site.root, file)));
			// As a local move writes its relinked files: each confined and atomic, in listing order.
			for (const c of changes) await writeAtomic((await confineOnDisk(site, c.file)).absolute, c.text);
			return replaceResponse(request, changes);
		},
		async slotDefault(request) {
			const changes = await slotDefaultChanges(site, request, await listDocuments(site), (file) => diskSource.readText(join(site.root, file)));
			for (const c of changes) await writeAtomic((await confineOnDisk(site, c.file)).absolute, c.text);
			return slotDefaultResponse(request, changes);
		},
		async source() {
			return diskSource;
		},
	};
}
