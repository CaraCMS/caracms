/**
 * Creating and deleting documents from the editor (M5a Decisions 11 and 12), on Phase
 * 3's routes (`POST /_caracms/create`, `POST /_caracms/delete`). Nothing here decides a
 * rule: the dialogs pre-check what they can (slug.ts) and show the server's own
 * sentence when it refuses.
 *
 *   createDocument(editor, request)   → the new document opens at once (its level)
 *   deleteDocument(editor, ref)       → the tab goes to the level it was listed in
 *
 * plus the small pure helpers the dialogs and menus share: what a new page's "Inside"
 * offers, a collection's singular word, a document's public address.
 */
import { titleCase } from '../../../fields.ts';
import { RESERVED_SLUG, slugify } from '../../../slug.ts';
import type { Editor } from '../editor.ts';
import { displayName } from '../../../live/messages.ts';
import { noteWaiting } from '../collections/hand-order.ts';
import { docId, ENDPOINTS, MEDIA_ENDPOINTS, TAB_HEADER, sameDoc, type CreateDeleteRefusal, type CreateRequest, type CreateResponse, type DeleteResponse, type DocRef, type MoveResponse, type EditorAnyCollection, type ListedDocument, type Person, type ReplaceFileResponse, type SlotDefaultResponse, type WaitingView } from '../../types.ts';

export type Refused = { ok: false; status: number; error: string; code: string | null; usedOn: CreateDeleteRefusal['usedOn'] | null };

export async function post<T>(editor: Editor, url: string, body: unknown): Promise<{ ok: true; body: T } | Refused> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
	if (editor.liveSession) headers[TAB_HEADER] = editor.liveSession.tab;
	let response: Response;
	try {
		response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
	} catch {
		return { ok: false, status: 0, error: "The server can't be reached. Nothing was changed; try again in a moment.", code: 'offline', usedOn: null };
	}
	const said = (await response.json().catch(() => ({}))) as CreateDeleteRefusal & T;
	if (response.status === 401 && editor.liveSession) editor.liveState.update({ signedOut: said as never });
	if (!response.ok) {
		return { ok: false, status: response.status, error: said.error ?? `The server said no (${response.status}).`, code: said.code ?? null, usedOn: said.usedOn ?? null };
	}
	return { ok: true, body: said as T };
}

/** Create a document; on success the list is read again and the new document opens (Decision 11). */
export async function createDocument(editor: Editor, request: CreateRequest): Promise<{ ok: true; body: CreateResponse } | Refused> {
	const answer = await post<CreateResponse>(editor, ENDPOINTS.create, request);
	if (!answer.ok) return answer;
	// Review gaps (Decision 4): someone else had Site Settings, so the new entry's first place waits for it.
	if (answer.body.order === 'waiting') noteWaiting(editor, answer.body.collection, answer.body.path, request.folder);
	// Site Settings couldn't be read, so its place wasn't kept: said as a refused drag is (hand-order.ts).
	if (answer.body.order === 'unkept' && answer.body.orderError) editor.toast(answer.body.orderError, 'warn');
	await editor.refreshDocuments().catch(() => undefined);
	await editor.openDocument({ collection: answer.body.collection, path: answer.body.path });
	editor.announce(`Created ${request.title}.`);
	return answer;
}

/**
 * Delete a document (Decision 12). Its unsent edits are dropped first (they'd only be
 * refused), then, if it was open, Home opens behind and the pane goes to the level it
 * was listed in: Pages' documents level, or its collection's own level.
 */
export async function deleteDocument(editor: Editor, ref: DocRef, title: string): Promise<{ ok: true; body: DeleteResponse } | Refused> {
	const id = docId(ref);
	const open = sameDoc(editor.doc.get().ref, ref);
	// Its last edits go first (in live mode the lock is this tab's), so nothing is in flight after.
	await editor.keeper?.flush(id).catch(() => undefined);
	const answer = await post<DeleteResponse>(editor, ENDPOINTS.delete, { collection: ref.collection, path: ref.path });
	if (!answer.ok) return answer;
	editor.keeper?.discard(id);
	const collection = editor.site.collections.find((c) => c.name === ref.collection);
	await editor.refreshDocuments().catch(() => undefined);
	if (open) await editor.openDocument(editor.site.home, { history: 'push' });
	if (collection && !collection.nested && collection.kind !== 'settings') editor.openCollection(collection.name);
	else editor.goTo('documents');
	editor.toast(`Deleted ${title}.`);
	editor.announce(`Deleted ${title}.`);
	return answer;
}

/**
 * Change a document's address (pre-M7 item 8). Its unsent edits go first (the move
 * carries them), then the document opens at its new address in place of the old one,
 * and the list is read again (other documents' links changed too). `redirect` false: no
 * redirect from the old address.
 */
export async function moveDocument(editor: Editor, ref: DocRef, to: string, title: string, redirect = true): Promise<{ ok: true; body: MoveResponse } | Refused> {
	// Everything under it moves with it (collections under pages, Decision 9): each of those documents' unsent edits too.
	const moving = addressesMoving(editor.site?.collections ?? [], ref, to, editor.documents?.get() ?? []).map((m) => ({ collection: m.doc.collection, path: m.doc.path }));
	const refs = moving.some((m) => sameDoc(m, ref)) ? moving : [ref, ...moving];
	// Nothing moves while the keeper still holds edits the server hasn't got (a held conflict, a
	// signed-out session, a refused write): the move would discard them.
	for (const r of refs) {
		const id = docId(r);
		let flushed = true;
		await editor.keeper?.flush(id).catch(() => {
			flushed = false;
		});
		if (!flushed || editor.keeper?.dirty(id)) {
			const what = sameDoc(r, ref) ? title : (editor.documents?.get().find((d) => sameDoc(d, r))?.label ?? r.path);
			return { ok: false, status: 0, error: `${what} has changes that haven't been saved yet, so ${sameDoc(r, ref) ? 'its' : `${title}'s`} address can't change. Sort those out first (Use mine or Discard mine, or sign in again), then try again.`, code: 'unsent', usedOn: null };
		}
	}
	const answer = await post<MoveResponse>(editor, ENDPOINTS.move, { collection: ref.collection, path: ref.path, to, ...(redirect ? {} : { redirect: false }) });
	if (!answer.ok) return answer;
	const { url, from } = answer.body;
	const moved = answer.body.moved ?? [];
	for (const r of refs) editor.keeper?.discard(docId(r));
	await editor.refreshDocuments().catch(() => undefined);
	// The open document goes with it when it's under it.
	const openRef = editor.doc.get().ref;
	const opened = sameDoc(openRef, ref) ? { collection: answer.body.collection, from: ref.path, to: answer.body.path } : moved.find((m) => m.collection === openRef.collection && m.from === openRef.path);
	if (opened && opened.from !== opened.to) await editor.openDocument({ collection: opened.collection, path: opened.to }, { history: 'replace' });
	else if (opened) await editor.reloadOpen();
	const more = Math.max(moved.length - 1, 0);
	editor.toast(more ? `Moved ${title} to ${url}, with ${more} more under it.` : `Moved ${title} to ${url}.`, 'check');
	editor.announce(more ? `Moved ${title} from ${from.url} to ${url}, and ${more} more addresses under it.` : `Moved ${title} from ${from.url} to ${url}.`);
	return answer;
}

/** One address Change address… changes (collections under pages, Decision 9). */
export interface AddressChange {
	doc: ListedDocument;
	/** Its new address; null while the new path isn't one yet. */
	toUrl: string | null;
	/** A document of a collection a page in the move holds (its file stays; only its address changes). */
	held: boolean;
}

/**
 * Every address Change address… on `ref` changes once it's at `to` (Decision 9): the
 * document, the pages under it at any depth, and the documents of each collection held by
 * it or a page under it. move.ts → `movesUnder` and `planMoves` work out the same, so the
 * dialog lists them before asking.
 */
export function addressesMoving(collections: readonly EditorAnyCollection[], ref: DocRef, to: string, documents: readonly ListedDocument[]): AddressChange[] {
	const collection = collections.find((c) => c.name === ref.collection);
	const root = documents.find((d) => d.collection === ref.collection && d.path === ref.path);
	if (!collection || !root) return [];
	const newPath = (path: string) => (path === ref.path ? to : `${to}${path.slice(ref.path.length)}`);
	const pages = [root, ...(collection.nested ? pagesUnder(collection.name, ref.path, documents) : [])];
	const out: AddressChange[] = pages.map((d) => ({ doc: d, toUrl: addressFor(collection, newPath(d.path)), held: false }));
	for (const held of collections) {
		const holder = held.holder;
		if (!held.heldBy || !holder || holder.collection !== ref.collection) continue;
		if (holder.path !== ref.path && !holder.path.startsWith(`${ref.path}/`)) continue;
		const holderUrl = addressFor(collection, newPath(holder.path));
		const base = holderUrl === null ? null : `${holderUrl.replace(/\/+$/, '')}/`;
		for (const d of documents) if (d.collection === held.name && d.url !== null && !d.warning) out.push({ doc: d, toUrl: base === null ? null : base + d.path, held: true });
	}
	return out;
}

/**
 * M6c G4 (Decision 9): Replace… on a file, or on an image (every use takes the new one,
 * `resetFocal` dropping their focal points). Every unsent edit in this tab goes first, and
 * nothing is replaced while any is still held (a conflict, a refusal, a signed-out
 * session): Replace changes other documents, so this tab has to be up to date (`unsent`).
 * Then every link to `from` moves to `to`; the list is read again, and the open document
 * too when it was one of them (its text changed under it).
 */
export async function replaceFile(editor: Editor, from: string, to: string, options: { resetFocal?: boolean } = {}): Promise<{ ok: true; body: ReplaceFileResponse } | Refused> {
	await editor.keeper?.flush().catch(() => undefined);
	const keep = editor.keeper?.status.get();
	if (keep && keep.state !== 'kept') {
		const n = keep.unsent ?? 0;
		return { ok: false, status: 0, error: n > 1 ? `Your last ${n} changes haven't reached the server yet` : n === 1 ? "Your last change hasn't reached the server yet" : "This tab has changes that haven't reached the server yet", code: 'unsent', usedOn: null };
	}
	const answer = await post<ReplaceFileResponse>(editor, MEDIA_ENDPOINTS.replace, options.resetFocal ? { from, to, resetFocal: true } : { from, to });
	if (!answer.ok) return answer;
	await editor.refreshDocuments().catch(() => undefined);
	const open = editor.doc.get().ref;
	if (answer.body.relinked.some((r) => sameDoc(r, open))) await editor.reloadOpen().catch(() => undefined);
	return answer;
}

/**
 * Edit in context, Decision 3: make the open slot block its slot's default. The server first
 * takes the default off every other block of the slot, each a normal save (refused, naming the
 * holder, while someone else is editing one); then this block's own `"default": true` is set
 * as any edit is, kept at once, and the list is read again so the chips and counts follow.
 */
export async function makeDefault(editor: Editor, ref: DocRef): Promise<{ ok: true; body: SlotDefaultResponse } | Refused> {
	const answer = await post<SlotDefaultResponse>(editor, ENDPOINTS.slotDefault, { path: ref.path });
	if (!answer.ok) return answer;
	if (sameDoc(editor.doc.get().ref, ref)) editor.doc.setDefault(true);
	await editor.keeper?.flush(docId(ref)).catch(() => undefined);
	await editor.refreshDocuments().catch(() => undefined);
	return answer;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** A collection's word for one of its documents: "page", "shared block", "case study", "journal entry". */
export function singular(collection: Pick<EditorAnyCollection, 'kind' | 'nested' | 'label'>): string {
	if (collection.kind === 'shared') return 'shared block';
	if (collection.nested) return 'page';
	const label = collection.label.toLowerCase();
	if (/ies$/.test(label)) return label.replace(/ies$/, 'y');
	if (/[^s]s$/.test(label)) return label.slice(0, -1);
	return `${label} entry`;
}

/** M6c (G1): a collection with no pages of its own, under its name (as shared blocks' "Edited in one place…"). */
export const PAGELESS_SUB = 'Shown on other pages; no pages of their own';

/** M6c (G2): the name of a section builder's page fields group: "Page details", "Game details". */
export function pageFieldsLabel(collection: Pick<EditorAnyCollection, 'kind' | 'nested' | 'label'>): string {
	const one = singular(collection);
	return `${one.charAt(0).toUpperCase()}${one.slice(1)} details`;
}

/** A document's public address in a collection (`/studio/visit`, `/work/kitchen-pottery`, Home `/`), or null. */
export function addressFor(collection: Pick<EditorAnyCollection, 'urlBase'>, path: string): string | null {
	if (collection.urlBase === null) return null;
	if (path === 'index') return collection.urlBase;
	if (path.endsWith('/index')) return `${collection.urlBase}${path.slice(0, -'/index'.length)}`;
	return `${collection.urlBase}${path}`;
}

export interface InsideOption {
	/** The folder's path in the collection ('' for the top level). */
	path: string;
	/** Its whole name, ancestors first: `Services / Advisory`. */
	label: string;
	/** Its own name: `Advisory` (`Top level` for the top level). */
	name: string;
	/** How deep it sits: 0 for the top level, 1 for what's straight under it. */
	depth: number;
	/** A page sits at this address (otherwise it's a group: a folder with no page of its own). */
	page: boolean;
	/** Pages sit under it already. */
	holds: boolean;
	/** The address a page inside it starts with (`/services/`). */
	base: string;
}

/**
 * New page's "Inside" (Decision 11): the top level, then every group and every page, at
 * any depth, in tree order. A page with nothing under it yet is offered too, so a page can
 * go under it; Home isn't, since no address goes under `/index/`.
 * At each level, the Pages tree's order (arrange pages, Decision 19): `documents` is the
 * listing, already in that order (Home, the saved order, then what holds pages, then A–Z).
 */
export function insideOptions(collection: Pick<EditorAnyCollection, 'name' | 'urlBase'>, documents: readonly ListedDocument[]): InsideOption[] {
	const base = collection.urlBase ?? '/';
	const docs = documents.filter((d) => d.collection === collection.name);
	const folders = new Set<string>();
	for (const d of docs) {
		const parts = d.path.split('/');
		for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
	}
	for (const f of folders) if (f.split('/').includes(RESERVED_SLUG)) folders.delete(f);
	const labelOf = (path: string) => docs.find((d) => d.path === path)?.label ?? titleCase(path.split('/').pop()!);
	const holds = (path: string) => docs.some((d) => d.path.startsWith(`${path}/`));
	const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
	// Arrange pages (Decision 19): the tree's order, as the listing gives it (content.ts → pageTree,
	// page-order.ts's rule): a folder sits where its page, or its first page down, is listed.
	const first = new Map<string, number>();
	docs.forEach((d, i) => {
		const parts = d.path.split('/');
		for (let n = 1; n <= parts.length; n++) {
			const at = parts.slice(0, n).join('/');
			if (!first.has(at)) first.set(at, i);
		}
	});
	const rank = (path: string) => first.get(path) ?? Number.MAX_SAFE_INTEGER;
	const children = new Map<string, string[]>();
	for (const f of folders) children.set(parentOf(f), [...(children.get(parentOf(f)) ?? []), f]);
	const out: InsideOption[] = [{ path: '', label: 'Top level', name: 'Top level', depth: 0, page: false, holds: true, base }];
	const walk = (parent: string) => {
		const kids = (children.get(parent) ?? []).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
		for (const path of kids) {
			const parts = path.split('/');
			out.push({
				path,
				label: parts.map((_, i) => labelOf(parts.slice(0, i + 1).join('/'))).join(' / '),
				name: labelOf(path),
				depth: parts.length,
				page: docs.some((d) => d.path === path),
				holds: holds(path),
				base: `${base}${path}/`,
			});
			walk(path);
		}
	};
	walk('');
	return out;
}

/** The pages under a folder (any depth), for "its pages stay" lines. */
export function pagesUnder(collection: string, path: string, documents: readonly ListedDocument[]): ListedDocument[] {
	return documents.filter((d) => d.collection === collection && d.path.startsWith(`${path}/`));
}

/** "A, B and C". */
export function andList(names: readonly string[]): string {
	if (names.length <= 1) return names.join('');
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** An address part from what's typed, by the name rule (slug.ts). */
export const partFrom = (typed: string) => slugify(typed);

/**
 * Discard changes' words (the waiting list's Discard…, the document menu's item, the
 * confirmation), from the waiting entry: who else changed it is named ("…including Ann's?").
 */
export function discardWording(
	item: Pick<WaitingView, 'title' | 'change' | 'editors' | 'movedFrom'>,
	you: Person | null,
	noun: string,
): { heading: string; body: string; confirm: string; menu: string } {
	const others = item.editors.filter((e) => !you || e.person.email.toLowerCase() !== you.email.toLowerCase()).map((e) => `${displayName(e.person)}'s`);
	const names = others.length < 2 ? others.join('') : `${others.slice(0, -1).join(', ')} and ${others.at(-1)}`;
	// A moved document waits as new on its new file; it's the move that goes.
	if (item.change === 'new' && !item.movedFrom) {
		return {
			heading: names ? `Discard this new ${noun}, including ${names} changes?` : `Discard this new ${noun}?`,
			body: `${item.title} isn't on the live site yet, so it's removed.`,
			confirm: `Discard this new ${noun}`,
			menu: `Discard this new ${noun}…`,
		};
	}
	return {
		heading: names ? `Discard the unpublished changes to ${item.title}, including ${names}?` : `Discard the unpublished changes to ${item.title}?`,
		body: item.movedFrom ? `It goes back to ${item.movedFrom}, as it is on the live site.` : item.change === 'deleted' ? 'It comes back, as it is on the live site.' : "It goes back to what's live.",
		confirm: 'Discard changes',
		menu: 'Discard changes…',
	};
}
