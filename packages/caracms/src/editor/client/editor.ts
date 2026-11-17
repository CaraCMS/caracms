/**
 * The editor: its state containers and the actions the pane, the bar and the stage
 * call. Built the same way on the server (to render the chrome, Decision 2) and in
 * the browser (to hydrate it): `createEditor(props, { client })`. Only the browser
 * gets the keeper and the preview driver, and only `start()` touches the window.
 *
 * ## The extension points (Phases 3 and 4 build on these; see editor/README.md)
 *
 *   editor.doc                 the open document's editing state and its operations
 *                              (state/document-store.ts)
 *   editor.view                where the pane is: { level, collection, block, field, picked, width, pop }
 *   editor.openDocument(ref)   open a document inside the editor (address, Recent, old preview held)
 *   editor.openBlock(key, field?, { picked })   the block level, optionally with a field picked
 *   editor.openCollection(name) / goTo(level) / goUp()
 *   editor.preview             the preview driver (preview/driver.ts), browser only
 *   editor.previewStatus       { painted, failed, showing, opening, warnings }
 *   editor.documents           the document list; refreshDocuments() re-reads it
 *   editor.pages               page folders: the Pages tree's folders and order stamp, read with the list
 *   editor.ui                  per-browser sidebar state in a cookie (ui-state.ts): toggleGroup(), setSideHidden()
 *   editor.keep                the bar's keep state (state/keeper.ts)
 *   editor.announce(text)      a polite screen-reader announcement
 *
 * ## Live mode (M4 Phase 4)
 *
 *   editor.mode                'local' (M3: no polling, none of M4's places) or 'live'
 *   editor.liveSession         the poll and the server calls (state/live.ts), null in local mode
 *   editor.liveState           the last status, whether the server answers, signed out
 *   editor.access              the open document as this tab may use it: its lock, held
 *                              edits, signed out; `readOnly` and `veil` (Decisions 9 and 11)
 *   editor.marks               presence, locks, waiting and notices by file, for navigation
 *   editor.editHere() / useMine() / discardMine() / publish() / tryAgain() /
 *   dismissNotice(id) / signOut() / signInAgain()
 */
import { heldBackSentence } from '../../document-problems.ts';
import { ARRANGE_ADDRESS, addressOf, inboxAddress, inboxFromAddress, isArrangeAddress, refFromAddress } from '../addresses.ts';
import { heldBases } from '../../held.ts';
import { SITE_SETTINGS_FILE } from '../../reserved.ts';
import {
	docId,
	ENDPOINTS,
	sameDoc,
	UNREAD_HEADER,
	type AdminProps,
	type DocRef,
	type EditorForm,
	type EditorBrand,
	type EditorSite,
	type ListedDocument,
	type PagesLayout,
	type LockState,
	type LockView,
	type AnyOpenedDocument as OpenedDocument,
	type Person,
	type SignedOutError,
	type MediaSetup,
	type SubmissionsSetup,
	type UiState,
	type ViewMode,
	type WaitingView,
	type Width,
} from '../types.ts';
import type { MediaOnly } from '../../media-value.ts';
import { displayName } from '../../live/messages.ts';
import { isOrderedCollection } from '../../page-order.ts';
import { uiCookieString, unsentCookieString, withOpenAncestors, withRecent, withSide, withToggled, withViewMode } from '../ui-state.ts';
import type { StageLayout } from './preview/layout.ts';
import { createPreviewDriver, type PreviewDriver, type PreviewStatus } from './preview/driver.ts';
import { createDocumentStore, formKey, type DocumentStore } from './state/document-store.ts';
import { pageFieldPath, sourceIdOf } from './preview/places.ts';
import { createKeeper, type HeldView, type Keeper, type KeepStatus } from './state/keeper.ts';
import { createLiveSession, tabId, type LiveSession, type LiveState } from './state/live.ts';
import { createStore, type Store } from './state/store.ts';
import { zoneName } from '../zone-name.ts';

export type PaneLevel = 'documents' | 'collection' | 'document' | 'block' | 'media' | 'submissions' | 'arrange';

/**
 * M5b: Choose… (or Replace…, or a list's Add image) opened the library as a picker for
 * one slot (the mockup's #library-pick): `scope` and `path` are the host's (the block's
 * key, or a form's, and a dotted path: `media`, `images.6`, `cover`), so placing is
 * `doc.setField(scope, path, value)`. The page stays on the stage with the slot ringed.
 */
export interface MediaPick {
	scope: string;
	path: string;
	only?: MediaOnly;
	/** A loop-only slot (the hero): a clip placed there stores `"play": "loop"`. */
	play?: 'loop';
	/** The media field's `altFrom` (a sibling text field): an image placed with no alt starts with its words. */
	altFrom?: string;
	/** The picker's sub line: "Text and media · Image or video", "Gallery · Images, image 7". */
	label: string;
	/** Where Choose… was pressed (the level tab above the picker, and Back): "Text and media". */
	owner: string;
	/** A list's Add image: each pick adds a row (at `path`'s index, then the next), and the picker stays open. */
	multi: boolean;
	/** The level the picker goes back to. */
	back: 'block' | 'document';
	/**
	 * M6c G4 (Decision 7): File… in a link field or a button: the library opens on Files
	 * only, and picking writes the file's address to `path` (the link's `href`, as a string).
	 */
	link?: boolean;
}

/** M5b: the library level (Site-wide → Media, or a slot's picker). */
export interface MediaView {
	pick: MediaPick | null;
	/** An image's (its key) or a clip's (`clip:<asset id>`) own level, from the library. */
	item: string | null;
	/** M6c G4: `files`, the library's files. */
	tab: 'images' | 'clips' | 'files';
}

export interface View {
	level: PaneLevel;
	/** The collection level's collection. */
	collection: string | null;
	/** The block level's block (its key in the document store). */
	block: string | null;
	/** The field picked in the block level (Phase 3), or null. */
	field: string | null;
	/** The field was picked by clicking the page ("Picked from the page"). */
	picked: boolean;
	/** The preview width on screen. All three stay rendered (Decision 13). */
	width: Width;
	/** An open popover over the bar: 'switcher' (Phase 4), 'preview-trouble', or a later phase's. */
	pop: string | null;
	/** A document being read before it opens: the bar says "Opening …". */
	opening: DocRef | null;
	/** M5b: the library level's state (level `media`); null otherwise. Optional so older callers' views still type. */
	media?: MediaView | null;
	/** M6: the inbox (level `submissions`): the submission open on its sheet, or null for the list alone. */
	inbox?: { id: string | null } | null;
}

/** The open document as this tab may use it (M4 Decisions 9 and 11). Local mode: always editable. */
export interface Access {
	/** Its lock, from this tab's side: `free`, `yours`, `yours-elsewhere` (Edit here) or `theirs`. */
	lock: LockState;
	/** Who holds it (null when free). */
	holder: LockView | null;
	/** This document's held edits (a 409, or another editor's change since: Use mine / Discard mine). */
	held: HeldView | null;
	/** The session ended (or the person was removed): edits stay in the tab. */
	signedOut: SignedOutError | null;
	/** No typing, no overlays, disabled fields. */
	readOnly: boolean;
	/** The lock's veil over the preview: only a lock gives it (Decision 9). */
	veil: boolean;
	/**
	 * M5a Decision 12: someone deleted the open document (the poll's `open.deleted`): who
	 * and when, when that's known. Read-only, with a note saying so. Null while it exists.
	 */
	deleted: { by: Person | null; at: string | null } | null;
}

/**
 * Edit in context (Decisions 6, 8, 9): a document open over a page. The store holds the
 * opened document (its form is the sidebar, its lock is the one taken); the preview keeps
 * the page, rendered with the opened document's copy on top (the driver's `overlay`).
 * Opening another document over it replaces the opened one (no stack); Back returns to the
 * page with its selection as it was left, within the session.
 */
export interface Over {
	/** The page shown under the opened document. */
	page: DocRef;
	/** The page's selected block (its index) when it was left, or null. */
	block: number | null;
	/** The field picked then: in the block, or a page field as `page.<path>`. */
	field: string | null;
	/** How many blocks the page had, for its tab in the sidebar's trail (null when it wasn't known). */
	blocks: number | null;
}

/**
 * Review gaps (Decision 7): the block state the preview shows, chosen in the switch over the
 * selected block. A view, never saved: it goes when another block is selected, another
 * document opens on its own, or the page reloads. It stays through the block's own
 * re-renders and through a document opened over the page (a form word opening Site Settings).
 */
export interface BlockStateView {
	/** The page it's drawn on: the open document, or the page under a document open over it. */
	page: DocRef;
	/**
	 * The block's key in the document store while its page is the open document, so a reorder keeps
	 * it on the same block; null while a document is open over the page (the page's keys are made
	 * afresh when it opens again, so the index finds it then).
	 */
	key: string | null;
	/** The block's index among the page's own blocks when it was chosen (0: a shared block's own render). */
	block: number;
	/** The state's key (one of the block's `states`). */
	name: string;
	/** Chosen, its render not morphed in yet: the switch pulses and the bar says "Showing …". */
	waiting: boolean;
	/**
	 * The state the preview last drew for this block (null: its first look). A render that fails
	 * goes back to it, so the switch stays on what's showing, the last good render.
	 */
	drawn: string | null;
}

/** What navigation shows for a document (by file), live mode only. */
export interface DocMarks {
	/** Someone else's lock: "Aoife is editing". */
	editing: Person | null;
	/** Other people with it open (presence, Decision 9), the lock's holder not repeated. */
	present: Person[];
	/** Changes waiting for the next Publish. */
	waiting: boolean;
	/** The merge kept the draft (Decision 7's notice, until it's dismissed). */
	kept: boolean;
}

/** Live mode's retry timer while offline (keeper.ts): it backs off, and the last repeats. */
export const RETRY_DELAYS = [3000, 6000, 12000, 24000, 30000] as const;

/** A message for the toast (not an Undo): a lock lapsing. `id` rises, so the same text shows again. */
export interface ToastMessage {
	id: number;
	text: string;
	/** An icon from the sprite (`check`), or none. */
	icon: string | null;
}

/**
 * The lapse toast (the mockup's #lapsed, now just "About is free to edit."):
 * when someone else's lock on the open document goes and the document opens up. Not
 * for Edit here (your own lock), nor for opening another document.
 */
export function lapsedToast(previous: Access, next: Access, openFile: string, title: string): string | null {
	if (previous.lock !== 'theirs' || !previous.holder || previous.holder.file !== openFile) return null;
	if (next.lock !== 'free' || next.veil || next.signedOut) return null;
	return `${title} is free to edit.`;
}

/**
 * Take over's toast, for the tab that lost the lock: someone else now holds the open
 * document's lock that this tab held. Its changes so far were committed under its name.
 */
export function takenOverToast(previous: Access, next: Access, openFile: string, title: string): string | null {
	if (previous.lock !== 'yours' || next.lock !== 'theirs' || !next.holder || next.holder.file !== openFile) return null;
	return `${displayName(next.holder.person)} took over ${title}.`;
}

const EDITABLE: Access = { lock: 'free', holder: null, held: null, signedOut: null, readOnly: false, veil: false, deleted: null };
const NO_LIVE: LiveState = { status: null, reachable: true, signedOut: null, polled: false, seq: 0 };

export interface Editor {
	site: EditorSite;
	/** M4: `local` (M3's editor, on disk) or `live` (sign-in, locks, Publish). */
	mode: 'local' | 'live';
	/** Who is signed in (live mode), else null. */
	you: Person | null;
	liveSession: LiveSession | null;
	/** Live mode's last status; constant and empty in local mode. */
	liveState: Store<LiveState>;
	access: Store<Access>;
	/** By file. Empty in local mode. */
	marks: Store<ReadonlyMap<string, DocMarks>>;
	documents: Store<ListedDocument[]>;
	/** Page folders (Contracts → the listing): the Pages tree's folders and the order stamp, re-read with `documents`. */
	pages: Store<PagesLayout>;
	doc: DocumentStore;
	view: Store<View>;
	ui: Store<UiState>;
	keep: Store<KeepStatus>;
	previewStatus: Store<PreviewStatus>;
	/** Browser only (null while rendering on the server). */
	preview: PreviewDriver | null;
	keeper: Keeper | null;
	/** The latest polite announcement (the #live region). */
	live: Store<string>;
	/** The latest message toast (shell/Toast.tsx), e.g. a lock lapsing; null until there's one. */
	message: Store<ToastMessage | null>;
	/** Where the Stage put each frame (layout.ts), once it has measured itself; null on the server. */
	stageLayout: Store<StageLayout | null>;
	/**
	 * The brand as it applies now (M5a Decision 10): Site Settings' name and accent as
	 * committed. Starts as the page's (`site.brand`); in live mode the status poll
	 * replaces it, so a change shows within a minute with no reload (the accent's CSS
	 * variables and the tab title follow it).
	 */
	brand: Store<EditorBrand>;
	/**
	 * Paints the accent's CSS variables on the root (editor restyle, Decision 12): a preset
	 * picked in Site Settings applies to this tab at once, before it's kept (amending M5a
	 * Decision 10; a preset can't be half-typed). `null` puts back the brand store's, as
	 * Discard and "Current" do; the brand store changing paints itself too.
	 */
	paintAccent(colours: { accent: string; ink: string; edge: string } | null): void;
	/**
	 * M5b: whether the media routes are set up (Decision 5), from /admin's props; a route
	 * that later answers 503 updates it (client/media/store.ts).
	 */
	mediaSetup: Store<MediaSetup>;
	/** M5b: the library level: to browse (no `pick`) or as a slot's picker. */
	openMedia(options?: { pick?: MediaPick | null; item?: string | null; tab?: MediaView['tab'] }): void;
	/** M6: the site's forms (id, label, fields in order), for Site Settings' Form emails and the Form block's picker. */
	forms: EditorForm[];
	/**
	 * M6 Decision 9: the inbox's unread count for the Site-wide row, or why there's none
	 * (`submissions-off`). From /admin's props, then every submissions response and the
	 * documents list's `X-Caracms-Unread` (client/inbox/store.ts sets it too).
	 */
	submissions: Store<SubmissionsSetup>;
	/** M6: the inbox's first page and open submission as /admin rendered them (client/inbox/store.ts starts from it). */
	inboxFirst: AdminProps['inboxFirst'];
	/**
	 * M6: the inbox level (Site-wide → Submissions), with a submission open on its sheet
	 * when `id` is given. The address follows (`/admin/submissions[/<id>]`): pushed when
	 * coming from elsewhere, replaced within the inbox.
	 */
	openInbox(id?: string | null, options?: { history?: 'push' | 'replace' | 'none' }): void;
	/**
	 * Arrange pages (Decisions 2, 15, 16): the arrange screen in the preview's place, its level
	 * in the pane, at `/admin/arrange` (pushed when coming from elsewhere). It starts from the
	 * listing as it is each time (client/arrange/store.ts).
	 */
	openArrange(options?: { history?: 'push' | 'replace' | 'none' }): void;
	/**
	 * Arrange pages (Decision 15): the screen's say when the tab would leave it, set by
	 * client/arrange/store.ts. `ask(go)` returns true when it took over (anything arranged:
	 * it asks first, then calls `go`); `up()` is Esc there. Null until the screen is first shown.
	 */
	arrangeGuard: { ask(go: () => void): boolean; up(): void } | null;

	openDocument(ref: DocRef, options?: { history?: 'push' | 'replace' | 'none' }): Promise<void>;
	/**
	 * Edit in context: the document open over a page, or null (the page is the open document,
	 * or the open document is shown on its own). Site Settings is always over a page; a shared
	 * block is over the last page when that page draws it (Decision 9).
	 */
	over: Store<Over | null>;
	/**
	 * Open a document over the page shown (Decision 6): a click on its source on the page.
	 * `field`, the field clicked: picked ("Picked from the page"), else the form's top.
	 */
	openOver(ref: DocRef, options?: { field?: string | null }): Promise<void>;
	/**
	 * Back to the page under the opened document (Decision 8). `then` runs once the page is
	 * open again (a click on the page's own block picks it); without it, the selection the
	 * page had when it was left comes back.
	 */
	backToPage(then?: (() => void) | null, options?: { history?: 'push' | 'replace' | 'none' }): Promise<void>;
	/** The document open over a page, shown on its own page instead (its form's menu, Decision 7). */
	showOwnPage(): Promise<void>;
	openBlock(key: string, field?: string | null, options?: { picked?: boolean }): void;
	/** Review gaps (Decision 7): the block state the preview shows, or null (its first look). */
	blockState: Store<BlockStateView | null>;
	/**
	 * Show the block at `index` of the page shown in the state `name` (null: its first look),
	 * re-rendering the preview at all three widths through the render sequencer (latest wins, so a
	 * choice made while an edit renders goes out next).
	 */
	showState(index: number, name: string | null): void;
	openCollection(name: string): void;
	goTo(level: PaneLevel): void;
	/** Esc: block → document → documents (a collection → documents; a case study or shared block → its collection). False when already at the top. */
	goUp(): boolean;
	/**
	 * Whether fields are open for picking at this view: the block level, or (M5a) the
	 * document level of a form (a fields document, a shared block, Site Settings), where
	 * `view.block` is the form's one block and `view.field` the picked field.
	 */
	fieldsOpen(view?: View): boolean;
	setWidth(width: Width): void;
	setPop(pop: string | null): void;
	toggleGroup(key: string, open?: boolean): void;
	/** Hide or show the sidebar (pre-M7 polish), remembered in the ui cookie; the preview takes the width. */
	setSideHidden(hidden: boolean): void;
	/** M6c (G5, Decision 18): show a flat collection as a list or a grid, remembered in the UI cookie. */
	setViewMode(collection: string, mode: ViewMode): void;
	refreshDocuments(): Promise<void>;
	/** M6c G4: read the open document again, as the server has it now (Replace… rewrote its links). Not while this tab has changes the server doesn't. */
	reloadOpen(): Promise<void>;
	announce(text: string): void;
	/** Show a message in the toast for a few seconds (the mockup's `toast(text, false, icon)`). */
	toast(text: string, icon?: string): void;
	/** The address of a document in /admin (Decision 19). */
	addressOf(ref: DocRef): string;
	/** Browser only: wire up history, keeping, recovery and pagehide. Returns a stop. */
	start(): () => void;

	// Live mode (M4). No-ops in local mode.
	/** Edit here: move your own lock from another tab to this one (Decision 9). */
	editHere(): Promise<void>;
	/** Take over: move someone else's lock to this tab; their changes so far are committed under their name. */
	takeOver(): Promise<void>;
	/** Use mine: send this document's held edits, merged (Decision 11). Off while someone else holds the lock. */
	useMine(): Promise<void>;
	/** Discard mine: drop them and show the document as the server has it. */
	discardMine(): Promise<void>;
	/**
	 * Discard changes (live mode): put one waiting document back to what's live. This tab's own
	 * unsent edits in it go first, and its held copy goes from this browser; an open document is
	 * read again (a new one closes, a moved one opens at its old address). The server's
	 * sentence when it refuses.
	 */
	discardChanges(item: Pick<WaitingView, 'file' | 'collection' | 'path' | 'title' | 'change'>): Promise<{ ok: true } | { ok: false; error: string }>;
	/** Publish. `ok: false` with the reason when it didn't publish (the Publish popover says so; press again to retry). */
	publish(): Promise<{ ok: boolean; error?: string }>;
	tryAgain(): Promise<{ ok: boolean; error?: string }>;
	dismissNotice(id: string): void;
	signOut(): Promise<void>;
	/** Signed out: open sign-in in a new tab; this tab sends its edits once the session is back. */
	signInAgain(): void;
	/** The site's time zone (Decision 16), from the status. */
	timeZone(): string;
	/** The zone's name as the server worded it (zone-name.ts); the browser's own wording only when the server sent none. */
	timeZoneName(): string;
}

/**
 * Collections under pages (Decision 7): each held collection's base, worked out again from a
 * fresh listing (held.ts), so a holder that moved takes its collection's addresses with it in
 * every dialog and table without a reload. The payload's own objects are updated in place.
 */
export function followHolders(site: Pick<EditorSite, 'collections' | 'allCollections'>, listed: readonly ListedDocument[]): void {
	if (!site.collections.some((c) => c.heldBy)) return;
	const bases = heldBases(Object.fromEntries(site.collections.map((c) => [c.name, c])), listed);
	for (const b of Object.values(bases)) {
		for (const c of [...site.collections, ...(site.allCollections ?? [])]) {
			if (c.name !== b.collection) continue;
			c.urlBase = b.base;
			c.holder = b.holder ? { collection: b.holder.collection, path: b.holder.path } : null;
			c.problem = b.problem;
		}
	}
}

export function createEditor(props: AdminProps, options: { client: boolean }): Editor {
	const { site } = props;
	const opened = props.opened;
	const liveProps = props.live ?? null;
	// Read-only (someone else's lock, held edits, signed out) makes the store refuse changes too.
	let readOnly = () => false;
	const doc = createDocumentStore(
		site,
		{
			ref: { collection: opened.entry.collection, path: opened.entry.path },
			entry: opened.entry,
			base: opened.text,
			document: opened.document,
		},
		{ canEdit: () => !readOnly() },
	);
	const documents = createStore(props.documents);
	const pages = createStore<PagesLayout>(props.pages ?? { folders: {}, orderStamp: '' });
	const view = createStore<View>({ level: 'document', collection: null, block: null, field: null, picked: false, width: 'desktop', pop: null, opening: null });
	const ui = createStore<UiState>(props.ui);
	const live = createStore('');
	const message = createStore<ToastMessage | null>(null);
	const stageLayout = createStore<StageLayout | null>(null);
	const brand = createStore<EditorBrand>(site.brand);
	/** The accent's slots on the root; --edge-accent follows --accent there in CSS (Decision 3). */
	function paintRoot(c: { accent: string; ink: string; edge: string }): void {
		const root = document.documentElement.style;
		root.setProperty('--accent', c.accent);
		root.setProperty('--accent-ink', c.ink);
		root.setProperty('--accent-edge', c.edge);
	}
	const mediaSetup = createStore<MediaSetup>(props.media ?? { images: null, clips: null });
	const submissions = createStore<SubmissionsSetup>(props.submissions ?? { unread: 0 });
	// M6: /admin/submissions[/<id>] opens on the inbox, with Home under it.
	if (props.inbox) view.update({ level: 'submissions', inbox: { id: props.inbox.id } });
	// Arrange pages: /admin/arrange opens on the screen, with Home under it.
	if (props.arrange) view.update({ level: 'arrange' });

	// Live mode (M4): the poll and the server calls; a tab id that lasts the tab's life.
	const tab = liveProps ? (options.client ? tabId() : 'server') : null;
	const liveSession = liveProps
		? createLiveSession({ fetch: (...a) => fetch(...a), props: liveProps, tab: tab!, openFile: () => doc.get().entry.file })
		: null;
	const liveState = liveSession?.state ?? createStore<LiveState>(NO_LIVE);
	const you = () => liveState.get().status?.you ?? liveProps?.you ?? null;
	/** A lock answer (a 409, or Edit here) shown at once, until a poll started after it answers. */
	const lockOverride = createStore<{ file: string; state: LockState; lock: LockView | null; after: number } | null>(null);

	/**
	 * Redis diet Decision 10: files a write from this tab was Kept for, with the poll count
	 * then. The write took (or kept) the lock, so the tab holds it until a poll started
	 * after that write answers: the poll is the word from then on.
	 */
	const keptAfter = new Map<string, number>();
	/** Files this tab holds the lock on: the last poll's, a lock answer's (Edit here), and those a write just took. */
	const lockedFiles = (): string[] => {
		const files = new Set((liveState.get().status?.locks ?? []).filter((l) => l.mine === 'this-tab').map((l) => l.file));
		const o = lockOverride.get();
		if (o?.state === 'yours') files.add(o.file);
		const seq = liveState.get().seq;
		for (const [file, after] of keptAfter) {
			if (seq > after) keptAfter.delete(file);
			else files.add(file);
		}
		return [...files];
	};

	// Edit in context: a reloaded Site Settings shows over Home, and so does a shared block Home
	// uses (a slot block is taken to: what fills Home's slot isn't known before the preview loads).
	const kindOf = (ref: DocRef) => site.collections.find((c) => c.name === ref.collection)?.kind;
	const listedUses = (page: DocRef, ref: DocRef, listed: readonly ListedDocument[]) =>
		!!listed.find((d) => d.collection === ref.collection && d.path === ref.path)?.usedOn?.some((u) => sameDoc(u, page));
	const over = createStore<Over | null>(
		(() => {
			const ref = { collection: opened.entry.collection, path: opened.entry.path };
			const kind = opened.document.kind;
			if (kind === 'settings') return { page: site.home, block: null, field: null, blocks: null };
			if (kind !== 'shared') return null;
			const block = opened.document.block;
			const slot = block.known && site.blocks[block.type]?.slot;
			return slot || listedUses(site.home, ref, props.documents) ? { page: site.home, block: null, field: null, blocks: null } : null;
		})(),
	);

	// Unsent edits held in this browser (the cookie says so): the bar starts at Keeping.
	const initialKeep = props.unsent ? 'keeping' : 'kept';
	const keeper = options.client
		? createKeeper({
				fetch: (...a) => fetch(...a),
				site,
				storage: safeStorage(),
				storageKey: site.storageKey,
				initial: initialKeep,
				onHeld: (held) => (document.cookie = unsentCookieString(site.storageKey, held)),
				...(liveSession
					? {
							tab,
							retryDelays: RETRY_DELAYS,
							you,
							lockedFiles,
							holds: (file: string) => lockedFiles().includes(file),
							onKept: (file: string) => keptAfter.set(file, liveSession.started()),
							...(liveProps?.keepDelayMs !== undefined ? { keepDelay: liveProps.keepDelayMs } : {}),
							...(liveProps?.keepCapMs !== undefined ? { keepCap: liveProps.keepCapMs } : {}),
							onLocked: (file, refusal) => lockOverride.set({ file, state: refusal.state, lock: refusal.lock, after: liveSession.started() }),
							onDiscarded: (file, body) => void letGo(file, body.by && body.at ? { by: body.by, at: body.at } : null),
							onSignedOut: (body) => liveState.update({ signedOut: body }),
						}
					: {}),
			})
		: null;
	const keep = keeper?.status ?? createStore<KeepStatus>({ state: initialKeep, error: null });
	const blockState = createStore<BlockStateView | null>(null);
	/** The page the preview shows for the open document: the page it's over, else its own. */
	const shownPage = (): DocRef => over.get()?.page ?? doc.get().ref;
	const preview = options.client
		? createPreviewDriver({
				store: doc,
				site,
				home: site.home,
				over: () => over.get()?.page ?? null,
				// Review gaps (Decision 7): the chosen state, while its page is the one shown. Over the page its
				// blocks can't change, so the index it was chosen at holds; on the page, the block's index now.
				state: () => {
					const s = blockState.get();
					if (!s || !sameDoc(s.page, shownPage())) return null;
					const block = over.get() || s.key === null ? s.block : doc.indexOf(s.key);
					return block >= 0 ? { block, name: s.name } : null;
				},
				// Live mode: a 401 is the signed-out state, not "Preview not updated". The keeper's
				// pending writes go first, so the signed-out note counts what didn't reach the server.
				...(liveSession
					? {
							onActivity: () => liveSession.active(),
							onSignedOut: (body: unknown) =>
								void (keeper?.flush() ?? Promise.resolve()).finally(() => {
									if (!liveState.get().signedOut) liveState.update({ signedOut: signedOutFrom(body) });
								}),
						}
					: {}),
			})
		: null;
	const previewStatus =
		preview?.status ?? createStore<PreviewStatus>({ painted: false, failed: false, showing: over.get()?.page ?? doc.get().ref, opening: null, warnings: [] });

	// ── Access: the open document's lock, held edits, the session (live mode) ────
	const sameAccess = (a: Access, b: Access) =>
		a.lock === b.lock &&
		a.readOnly === b.readOnly &&
		a.veil === b.veil &&
		a.signedOut === b.signedOut &&
		a.held === b.held &&
		JSON.stringify(a.holder) === JSON.stringify(b.holder);
	function computeAccess(): Access {
		if (!liveSession) return EDITABLE;
		const s = liveState.get();
		const file = doc.get().entry.file;
		let lock: LockState = 'free';
		let holder: LockView | null = null;
		const o = lockOverride.get();
		if (o && o.file === file && s.seq <= o.after) {
			lock = o.state;
			holder = o.lock;
		} else {
			const l = s.status?.locks.find((x) => x.file === file) ?? null;
			if (l) {
				holder = l;
				// The page's first status had no tab: a lock of yours may be this very tab's (a reload), so wait for the first poll.
				lock = l.mine === 'this-tab' ? 'yours' : l.mine === 'other-tab' ? (s.polled ? 'yours-elsewhere' : 'free') : 'theirs';
				if (lock === 'free') holder = null;
			}
		}
		const id = docId(doc.get().ref);
		const held = keeper?.status.get().held?.find((h) => h.id === id) ?? null;
		const veil = lock === 'theirs' || lock === 'yours-elsewhere';
		const open = s.status?.open;
		const deleted = open && open.file === file && open.deleted ? open.deleted : null;
		return { lock, holder, held, signedOut: s.signedOut, readOnly: veil || !!held || !!s.signedOut || !!deleted, veil, deleted };
	}
	const access = createStore<Access>(computeAccess());
	readOnly = () => access.get().readOnly;
	const recomputeAccess = () => {
		const next = computeAccess();
		if (!sameAccess(next, access.get())) access.set(next);
	};
	if (liveSession) {
		liveState.subscribe(recomputeAccess);
		lockOverride.subscribe(recomputeAccess);
		keeper?.status.subscribe(recomputeAccess);
		doc.state.subscribe((s, previous) => s.ref !== previous.ref && recomputeAccess());
	}

	// ── Marks for navigation: presence, locks, waiting, the merge notice (by file) ──
	function computeMarks(): ReadonlyMap<string, DocMarks> {
		const out = new Map<string, DocMarks>();
		const status = liveState.get().status;
		if (!status) return out;
		const me = (p: Person) => p.email.toLowerCase() === status.you.email.toLowerCase();
		const of = (file: string) => {
			let m = out.get(file);
			if (!m) out.set(file, (m = { editing: null, present: [], waiting: false, kept: false }));
			return m;
		};
		for (const l of status.locks) if (l.mine === null && !me(l.person)) of(l.file).editing = l.person;
		for (const p of status.presence) {
			const m = of(p.file);
			m.present = p.people.filter((x) => !me(x) && (!m.editing || x.email.toLowerCase() !== m.editing.email.toLowerCase()));
		}
		for (const w of status.waiting) of(w.file).waiting = true;
		for (const n of status.notices) if (n.kind === 'draft-kept') of(n.file).kept = true;
		return out;
	}
	const marks = createStore<ReadonlyMap<string, DocMarks>>(computeMarks());
	if (liveSession) liveState.subscribe((s, previous) => s.status !== previous.status && marks.set(computeMarks()));

	// Every change to the document is kept (keeper.ts); opening one isn't a change.
	doc.subscribe((session, change) => {
		if (change.kind === 'load' || !keeper) return;
		keeper.change(docId(session.ref), { file: session.entry.file, base: session.base, document: doc.wire() });
	});

	/** The latest openDocument call wins. */
	let opening = 0;

	async function readDocument(ref: DocRef): Promise<OpenedDocument> {
		const url = `${ENDPOINTS.document}?collection=${encodeURIComponent(ref.collection)}&path=${encodeURIComponent(ref.path)}`;
		const response = await fetch(url, { headers: { Accept: 'application/json' } });
		const body = await response.json();
		if (response.status === 401 && liveSession) liveState.update({ signedOut: body as SignedOutError });
		if (!response.ok) throw new Error(body?.error ?? `couldn't open ${docId(ref)}`);
		return body as OpenedDocument;
	}

	/** The version of the open document as last read, and the last change the poll reported for it: someone else's change while it's locked. */
	let loadedVersion = opened.version;
	let seenChange: string | null = opened.lastChange?.version ?? null;

	/** Load an opened document into the store, adopting unsent edits that are newer than its file. */
	/**
	 * A document whose fields are edited in the sidebar (Site Settings, a case study, a shared
	 * block) is no use with the sidebar hidden, so opening one brings it back. A section-builder
	 * page keeps it hidden: the preview is the point there.
	 */
	function bringSideBack() {
		if (doc.get().document.kind !== 'sections') editor.setSideHidden(false);
	}

	function load(openedDoc: OpenedDocument) {
		const ref = { collection: openedDoc.entry.collection, path: openedDoc.entry.path };
		const id = docId(ref);
		loadedVersion = openedDoc.version;
		seenChange = openedDoc.lastChange?.version ?? null;
		if (keeper && adoptHeld(id, ref, openedDoc)) return;
		doc.load({ ref, entry: openedDoc.entry, base: openedDoc.text, document: openedDoc.document });
	}

	/**
	 * Unsent edits held for a document being opened (keeper.ts → the re-send rule): sent
	 * when the server's copy doesn't have them and nobody else changed it since; held
	 * for Use mine / Discard mine when someone did (Decision 11). True when adopted.
	 */
	function adoptHeld(id: string, ref: DocRef, openedDoc: OpenedDocument): boolean {
		if (!keeper) return false;
		keeper.opened(id, openedDoc.entry.file, openedDoc.version);
		const found = keeper.recover(id, openedDoc);
		if (!found) return false;
		doc.load({ ref, entry: openedDoc.entry, base: found.stored.base, document: found.stored.document }, { adopted: true });
		if (found.send) keeper.resend(id, found.stored);
		else keeper.hold(id, found.stored, found.by);
		return true;
	}

	/**
	 * Read the open document again and show it as the server has it now (a lock lapsed,
	 * Edit here, Discard mine), keeping the block that was open. Not while this tab has
	 * changes the server doesn't.
	 */
	async function refreshOpen(): Promise<void> {
		const ref = doc.get().ref;
		const id = docId(ref);
		let fresh: OpenedDocument;
		try {
			fresh = await readDocument(ref);
		} catch {
			return;
		}
		if (!sameDoc(doc.get().ref, ref) || keeper?.dirty(id)) return;
		const before = view.get();
		const index = before.block ? doc.indexOf(before.block) : -1;
		load(fresh);
		if (before.level === 'block' && index >= 0) {
			const key = doc.keyAt(index);
			if (key) view.update({ block: key });
		}
	}

	/** Wait until nothing for this document is in flight (at most a few seconds). */
	async function settled(id: string): Promise<void> {
		for (let i = 0; i < 100 && keeper?.dirty(id); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	}

	/**
	 * Discard changes, from another tab's side: someone put this document back to what's live
	 * while this tab had it (the poll's `open.discarded`, or a write refused as `discarded`). This
	 * tab's copy is stale: its edits in it are dropped, the server is told it let go, and the
	 * document is read again (Home opens if it's gone: a new page discarded, or one moved back).
	 */
	const lettingGo = new Set<string>();
	async function letGo(file: string, discarded: { by: Person; at: string } | null): Promise<void> {
		if (!liveSession || !keeper) return;
		const key = `${file}:${discarded?.at ?? ''}`;
		if (lettingGo.has(key)) return;
		lettingGo.add(key);
		const open = doc.get().entry.file === file;
		const id = open ? docId(doc.get().ref) : null;
		const title = open ? doc.get().document.title || doc.get().entry.label : null;
		if (id) {
			keeper.discard(id);
			await settled(id);
		}
		await liveSession.discardSeen(file);
		if (file === SITE_SETTINGS_FILE) editor.paintAccent(null);
		if (open && doc.get().entry.file === file) {
			let gone = false;
			try {
				await readDocument(doc.get().ref);
			} catch {
				gone = true;
			}
			if (gone) await editor.openDocument(site.home, { history: 'replace' });
			else await refreshOpen();
		}
		if (title) {
			const who = discarded ? displayName(discarded.by) : 'Someone';
			editor.toast(`${who} discarded the unpublished changes to ${title}. It's back to what's live.`, 'check');
		}
		void liveSession.poll();
	}

	/** Held edits looked at again against the document as it is now (Decision 11). */
	async function recheck(id: string): Promise<void> {
		if (!keeper) return;
		const slash = id.indexOf('/');
		let fresh: OpenedDocument;
		try {
			fresh = await readDocument({ collection: id.slice(0, slash), path: id.slice(slash + 1) });
		} catch {
			return;
		}
		const result = keeper.recheck(id, fresh);
		if (result === 'drop' && id === docId(doc.get().ref)) await refreshOpen();
	}

	function setTitle() {
		if (typeof document === 'undefined') return;
		const level = view.get().level;
		const what = level === 'submissions' ? 'Submissions' : level === 'arrange' ? 'Arrange pages' : doc.get().document.title || doc.get().entry.label;
		document.title = `${what} · ${brand.get().name}`;
	}

	/** Whether the page shown draws a shared block: in the preview (a slot marked as its source), or as a body entry (the listing). */
	function pageUses(page: DocRef, ref: DocRef): boolean {
		if (preview && sameDoc(previewStatus.get().showing, page)) {
			const shown = preview.frames().find((f) => f.document)?.document;
			if (shown?.querySelector(`[data-cms-source="${CSS.escape(sourceIdOf(ref))}"]`)) return true;
		}
		return listedUses(page, ref, documents.get());
	}

	/** The page's selection, to come back to (only while the store holds the page itself). */
	function pageSelection(page: DocRef): Pick<Over, 'block' | 'field' | 'blocks'> {
		const s = doc.get();
		const v = view.get();
		if (!sameDoc(s.ref, page)) return { block: null, field: null, blocks: null };
		if (s.document.kind !== 'sections') return { block: null, field: null, blocks: s.document.blocks.length };
		const index = v.block ? doc.indexOf(v.block) : -1;
		const field = v.level === 'block' || v.level === 'document' ? v.field : null;
		return { block: index >= 0 ? index : null, field: index >= 0 || field?.startsWith(pageFieldPath('')) ? field : null, blocks: s.document.blocks.length };
	}

	/**
	 * Decision 9: Site Settings shows over the last page, always; a shared block over the last
	 * page when that page draws it (else its own preview). Anything else opens on its own.
	 */
	function overFor(ref: DocRef): Over | null {
		const kind = kindOf(ref);
		if (kind !== 'settings' && kind !== 'shared') return null;
		const now = over.get();
		const page = now?.page ?? previewStatus.get().showing;
		if (kind === 'shared' && !pageUses(page, ref)) return null;
		return now && sameDoc(now.page, page) ? now : { page, ...pageSelection(page) };
	}

	/** Pick a field of the open document from the page (`field`), or show its form's top (null). */
	function pickOwn(field: string | null) {
		const s = doc.get();
		if (s.document.kind === 'sections') {
			view.update({ level: 'document', block: null, field: field ? pageFieldPath(field) : null, picked: !!field, pop: null });
			editor.setSideHidden(false);
			return;
		}
		const key = formKey(s);
		if (key) editor.openBlock(key, field, { picked: !!field });
	}

	/** Put the page's selection back as it was left (Back, Esc). */
	function restorePage(left: Pick<Over, 'block' | 'field'>) {
		if (left.block !== null) {
			const key = doc.keyAt(left.block);
			if (key) editor.openBlock(key, left.field && !left.field.startsWith(pageFieldPath('')) ? left.field : null);
			return;
		}
		if (left.field) view.update({ level: 'document', field: left.field, picked: false });
	}

	/**
	 * Open a document: the one shared path of openDocument, openOver and backToPage. `over` is
	 * the page it's shown over (null: on its own); `then` runs once it's open.
	 */
	async function open(ref: DocRef, how: { history: 'push' | 'replace' | 'none'; over: Over | null; then?: (() => void) | null; again?: boolean }): Promise<void> {
		const { history } = how;
		const current = doc.get().ref;
		if (sameDoc(ref, current) && !view.get().opening && !how.again) {
			if (how.then) {
				how.then();
				return;
			}
			view.update({ level: 'document', block: null, field: null, picked: false, pop: null, inbox: null });
			// Leaving the inbox for the page under it: the address names the page again.
			if (history !== 'none' && typeof window !== 'undefined' && location.pathname !== addressOf(ref, site.home)) {
				if (history === 'push') window.history.pushState({ caracms: docId(ref) }, '', addressOf(ref, site.home));
				else window.history.replaceState({ caracms: docId(ref) }, '', addressOf(ref, site.home));
			}
			setTitle();
			bringSideBack();
			return;
		}
		const ticket = ++opening;
		view.update({ opening: ref, pop: null });
		// Decision 9: over a page, the page is rendered from what's kept, so what's pending is kept first.
		const flushing = keeper ? keeper.flush(docId(current)).catch(() => {}) : Promise.resolve();
		let openedDoc: OpenedDocument;
		try {
			openedDoc = await readDocument(ref);
			// Leaving Site Settings or a shared block, the page's first render draws it: its write lands first.
			const leaving = kindOf(current);
			if (how.over || leaving === 'settings' || leaving === 'shared') await flushing;
		} catch (error) {
			if (ticket === opening) view.update({ opening: null });
			console.warn('[caracms]', error);
			editor.announce(`${docId(ref)} couldn't be opened`);
			return;
		}
		if (ticket !== opening) return;
		// Before the load: the driver reads it to render the page with this document over it.
		over.set(how.over);
		load(openedDoc);
		view.update({ level: 'document', block: null, field: null, picked: false, opening: null, collection: null, inbox: null });
		// The new document's lock and presence at once, not in up to five seconds.
		if (liveSession && options.client) void liveSession.poll();
		// Page folders: the folders holding it (or a row above it) open too.
		const inPages = site.collections.some((c) => c.name === ref.collection && isOrderedCollection(c));
		ui.set((state) => withRecent(withOpenAncestors(state, ref, inPages ? pages.get().folders : {}), ref));
		if (history !== 'none' && typeof window !== 'undefined') {
			const address = addressOf(ref, site.home);
			if (history === 'push') window.history.pushState({ caracms: docId(ref) }, '', address);
			else window.history.replaceState({ caracms: docId(ref) }, '', address);
		}
		setTitle();
		bringSideBack();
		how.then?.();
	}

	const editor: Editor = {
		site,
		mode: liveSession ? 'live' : 'local',
		you: liveProps?.you ?? null,
		liveSession,
		liveState,
		access,
		marks,
		documents,
		pages,
		doc,
		view,
		ui,
		keep,
		previewStatus,
		preview,
		keeper,
		live,
		message,
		stageLayout,
		brand,
		paintAccent(colours) {
			const b = brand.get();
			paintRoot(colours ?? { accent: b.accent, ink: b.accentInk, edge: b.accentEdge });
		},
		mediaSetup,
		forms: props.forms ?? [],
		submissions,
		inboxFirst: props.inboxFirst ?? null,

		arrangeGuard: null,

		openArrange({ history = 'push' } = {}) {
			view.update({ level: 'arrange', inbox: null, media: null, collection: null, block: null, field: null, picked: false, pop: null });
			if (history !== 'none' && typeof window !== 'undefined' && location.pathname !== ARRANGE_ADDRESS) {
				if (history === 'push') window.history.pushState({ caracms: 'arrange' }, '', ARRANGE_ADDRESS);
				else window.history.replaceState({ caracms: 'arrange' }, '', ARRANGE_ADDRESS);
			}
			setTitle();
		},

		openInbox(id = null, { history } = {}) {
			// Leaving the arrange screen with something arranged asks first (Decision 15).
			if (editor.arrangeGuard?.ask(() => editor.openInbox(id, { history }))) return;
			const before = view.get();
			const within = before.level === 'submissions';
			view.update({ level: 'submissions', inbox: { id }, block: null, field: null, picked: false, pop: null, media: null });
			const how = history ?? (within ? 'replace' : 'push');
			if (how !== 'none' && typeof window !== 'undefined') {
				const address = inboxAddress(id);
				if (location.pathname !== address) {
					if (how === 'push') window.history.pushState({ caracms: 'submissions' }, '', address);
					else window.history.replaceState({ caracms: 'submissions' }, '', address);
				}
			}
			setTitle();
		},

		openMedia({ pick = null, item = null, tab } = {}) {
			const before = view.get();
			const media: MediaView = { pick, item, tab: tab ?? (pick?.link ? 'files' : pick?.only === 'image' ? 'images' : (before.media?.tab ?? 'images')) };
			// A picker keeps the block and the slot picked, so the page rings it (editor-marks.ts).
			if (pick) view.update({ level: 'media', media, block: pick.scope, field: pick.multi ? listOf(pick.path) : pick.path, picked: false, pop: null });
			else view.update({ level: 'media', media, field: null, picked: false, pop: null });
		},

		async openDocument(ref, { history = 'push' } = {}) {
			if (editor.arrangeGuard?.ask(() => void editor.openDocument(ref, { history }))) return;
			// The browser's Back to the page under an opened document: its selection comes back (opened any other way, it opens as usual).
			const now = over.get();
			if (now && history === 'none' && sameDoc(ref, now.page) && !sameDoc(ref, doc.get().ref)) return editor.backToPage(null, { history });
			await open(ref, { history, over: overFor(ref) });
		},

		over,

		async openOver(ref, { field = null } = {}) {
			if (editor.arrangeGuard?.ask(() => void editor.openOver(ref, { field }))) return;
			const now = over.get();
			const page = now?.page ?? previewStatus.get().showing;
			const next = now && sameDoc(now.page, page) ? now : { page, ...pageSelection(page) };
			await open(ref, { history: 'push', over: next, then: () => pickOwn(field) });
		},

		async showOwnPage() {
			if (!over.get()) return;
			await open(doc.get().ref, { history: 'replace', over: null, again: true });
		},

		async backToPage(then = null, { history = 'push' } = {}) {
			const now = over.get();
			if (!now) return;
			await open(now.page, { history, over: null, then: then ?? (() => restorePage(now)) });
		},

		openBlock(key, field = null, { picked = false } = {}) {
			if (!doc.block(key)) return;
			// A form (a fields document, a shared block, Site Settings: M5a) is its own document
			// level: its fields are picked there, with the form's one block as `view.block`.
			const level = doc.get().document.kind === 'sections' ? 'block' : 'document';
			view.update({ level, block: key, field, picked, pop: null });
			// A block opened from the preview (a click on it) brings a hidden sidebar back: its fields are there.
			editor.setSideHidden(false);
		},

		blockState,
		showState(index, name) {
			const key = over.get() ? null : (doc.keyAt(index) ?? null);
			const before = blockState.get();
			const drawn = before && before.block === index && sameDoc(before.page, shownPage()) ? before.drawn : null;
			blockState.set(name ? { page: shownPage(), key, block: index, name, waiting: true, drawn } : null);
			preview?.retry();
		},

		openCollection(name) {
			view.update({ level: 'collection', collection: name, pop: null });
		},

		goTo(level) {
			if (level === 'block' && !view.get().block) return;
			if (level === 'collection' && !view.get().collection) return;
			view.update({ level, ...(level !== 'block' ? { field: null, picked: false } : {}) });
		},

		fieldsOpen(v = view.get()) {
			return v.level === 'block' || (v.level === 'document' && doc.get().document.kind !== 'sections');
		},

		goUp() {
			const { level, media, inbox } = view.get();
			// Arrange pages: the review → arranging; arranging → leave (asking first when anything is arranged).
			if (level === 'arrange') {
				editor.arrangeGuard?.up();
				return true;
			}
			const { kind } = doc.get().document;
			// M6: the inbox: an open submission → the list; the list → documents.
			if (level === 'submissions') {
				if (inbox?.id) editor.openInbox(null);
				else view.update({ level: 'documents', inbox: null });
				return true;
			}
			// The library: an item's own level → the library; a picker → where Choose… was pressed; else documents.
			if (level === 'media') {
				if (media?.item) view.update({ media: { ...media, item: null } });
				else if (media?.pick) view.update({ level: media.pick.back, media: null, field: media.pick.multi ? listOf(media.pick.path) : media.pick.path, picked: false });
				else view.update({ level: 'documents', media: null });
				return true;
			}
			if (level === 'block') view.update({ level: 'document', field: null, picked: false });
			// Edit in context (Decision 8): over a page, a picked field lets go first, then Back to the page.
			else if (level === 'document' && over.get()) {
				if (view.get().field) view.update({ field: null, picked: false });
				else void editor.backToPage();
			}
			// A case study or a shared block goes up to its collection's level, where it's listed (M5a).
			else if (level === 'document' && (kind === 'fields' || kind === 'shared')) view.update({ level: 'collection', collection: doc.get().ref.collection, field: null, picked: false });
			else if (level === 'document' || level === 'collection') view.update({ level: 'documents' });
			else return false;
			return true;
		},

		setWidth(width) {
			if (view.get().width === width) return;
			view.update({ width });
			editor.announce(`Preview at ${width} width`);
		},

		setPop(pop) {
			view.update({ pop });
		},

		setSideHidden(hidden) {
			if ((ui.get().side === 'hidden') === hidden) return;
			// Hiding it takes focus with it (display:none drops it to the body): the sidebar's button, which stays to bring it back.
			if (hidden && typeof document !== 'undefined' && document.getElementById('side')?.contains(document.activeElement)) {
				document.querySelector<HTMLElement>('#editor > .side-toggle')?.focus();
			}
			ui.set((state) => withSide(state, hidden));
			editor.announce(hidden ? 'Sidebar hidden.' : 'Sidebar shown.');
		},

		setViewMode(collection, mode) {
			ui.set((state) => withViewMode(state, collection, mode));
		},

		toggleGroup(key, open) {
			ui.set((state) => withToggled(state, key, open ?? !state.open[key]));
		},

		reloadOpen: () => refreshOpen(),

		async refreshDocuments() {
			const response = await fetch(`${ENDPOINTS.documents}?with=folders`, { headers: { Accept: 'application/json' } });
			if (!response.ok) return;
			const body = (await response.json()) as { documents: ListedDocument[]; pages: PagesLayout };
			const listed = body.documents;
			followHolders(site, listed);
			pages.set(body.pages);
			documents.set(listed);
			// M6 Decision 9: the unread count rides along (absent when it couldn't be read).
			const unread = response.headers.get(UNREAD_HEADER);
			if (unread !== null && /^\d+$/.test(unread)) submissions.set({ unread: Number(unread) });
		},

		announce(text) {
			live.set('');
			if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => live.set(text));
			else live.set(text);
		},

		toast(text, icon) {
			message.set({ id: (message.get()?.id ?? 0) + 1, text, icon: icon ?? null });
		},

		addressOf: (ref) => addressOf(ref, site.home),

		async editHere() {
			if (!liveSession) return;
			const file = doc.get().entry.file;
			const id = docId(doc.get().ref);
			const answer = await liveSession.take(file);
			if (answer.ok) {
				lockOverride.set({ file, state: 'yours', lock: answer.lock.lock, after: liveSession.started() });
				editor.announce("You're editing this here now.");
				// The other tab's latest, unless this tab has edits of its own waiting.
				if (!keeper?.blocked().some((b) => b.id === id) && !keeper?.dirty(id)) await refreshOpen();
			} else if (answer.refusal) {
				lockOverride.set({ file, state: answer.refusal.state, lock: answer.refusal.lock, after: liveSession.started() });
			}
			void liveSession.poll();
		},

		async takeOver() {
			if (!liveSession) return;
			const file = doc.get().entry.file;
			const answer = await liveSession.takeOver(file);
			if (!answer.ok) {
				editor.announce("It didn't take over. Try again in a moment.");
				return;
			}
			lockOverride.set({ file, state: 'yours', lock: answer.lock.lock, after: liveSession.started() });
			// Open it as `drafts` has it now, with their changes committed.
			await refreshOpen();
			editor.announce('Taken over.');
		},

		async useMine() {
			if (!liveSession || !keeper) return;
			const a = access.get();
			if (!a.held || a.lock === 'theirs') return;
			if (a.lock === 'yours-elsewhere') {
				const file = doc.get().entry.file;
				const answer = await liveSession.take(file);
				if (!answer.ok) return;
				lockOverride.set({ file, state: 'yours', lock: answer.lock.lock, after: liveSession.started() });
			}
			keeper.useMine(docId(doc.get().ref));
		},

		async discardMine() {
			if (!keeper) return;
			keeper.discard(docId(doc.get().ref));
			await refreshOpen();
			editor.announce('Your held changes were discarded.');
		},

		async discardChanges(item) {
			if (!liveSession) return { ok: false, error: 'Discarding changes needs live mode.' };
			const id = item.collection && item.path ? docId({ collection: item.collection, path: item.path }) : null;
			const openId = docId(doc.get().ref);
			const isOpen = doc.get().entry.file === item.file || (id !== null && id === openId);
			// This tab's own edits in it reach the server first, so nothing is in flight while it's discarded.
			for (const one of new Set([id, isOpen ? openId : null])) {
				if (!one) continue;
				await keeper?.flush(one).catch(() => undefined);
				await settled(one);
			}
			const answer = await liveSession.discard(item.file);
			if (!answer.ok) return { ok: false, error: answer.error };
			const back = answer.body.movedBack;
			// This browser's held copies of it go too.
			for (const one of new Set([id, isOpen ? openId : null, back ? docId(back) : null])) if (one) keeper?.discard(one);
			await editor.refreshDocuments().catch(() => undefined);
			if (isOpen) {
				if (back) await editor.openDocument({ collection: back.collection, path: back.path }, { history: 'replace' });
				else if (answer.body.change === 'new') {
					await editor.openDocument(site.home, { history: 'push' });
					const collection = site.collections.find((c) => c.name === item.collection);
					if (collection && !collection.nested && collection.kind !== 'settings') editor.openCollection(collection.name);
					else editor.goTo('documents');
				} else await refreshOpen();
			}
			// A preset picked in this tab and never kept goes with it (Decision 12).
			if (item.file === SITE_SETTINGS_FILE) editor.paintAccent(null);
			const said = answer.body.change === 'new' ? `Discarded ${item.title}.` : `Discarded the changes to ${item.title}. It's back to what's live.`;
			editor.toast(said, 'check');
			editor.announce(said);
			return { ok: true };
		},

		async publish() {
			if (!liveSession) return { ok: false };
			await keeper?.flush();
			const answer = await liveSession.publish();
			if (!answer.ok) {
				editor.announce("It didn't publish. Nothing went live.");
				return { ok: false, error: answer.error };
			}
			// caracms-cloud adversarial review, finding 15: what was left waiting, and why, in the toast.
			const held = (answer.body.held ?? []).map((h) => heldBackSentence(h.title, h.reason)).join(' ');
			if (answer.body.result === 'held-back') {
				const said = `Nothing was published. ${held}`;
				editor.toast(said, 'warn');
				editor.announce(said);
			} else if (answer.body.result === 'nothing-waiting') editor.announce('Nothing to publish.');
			else if (held) {
				const said = `Publishing the rest. ${held}`;
				editor.toast(said, 'warn');
				editor.announce(said);
			} else editor.announce('Publishing.');
			return { ok: true };
		},

		async tryAgain() {
			if (!liveSession) return { ok: false };
			const answer = await liveSession.tryAgain();
			if (answer.ok) editor.announce('Trying again.');
			return answer.ok ? { ok: true } : { ok: false, error: answer.error };
		},

		dismissNotice(id) {
			void liveSession?.dismiss(id);
		},

		async signOut() {
			if (!liveSession) return;
			await keeper?.flush();
			const location = await liveSession.signOut();
			window.location.assign(location);
		},

		signInAgain() {
			const out = liveState.get().signedOut;
			window.open(out?.signIn ?? '/admin/login', '_blank', 'noopener');
		},

		timeZone: () => liveState.get().status?.timeZone ?? site.timeZone ?? 'UTC',
		timeZoneName: () => site.timeZoneName ?? zoneName(liveState.get().status?.timeZone ?? site.timeZone ?? 'UTC'),

		start() {
			const stops: (() => void)[] = [];
			const id = docId(doc.get().ref);

			// Keeping: this document's file and version; then unsent edits newer than their files.
			if (keeper) {
				adoptHeld(id, doc.get().ref, opened);
				const fileOf = async (other: string): Promise<{ version: string; text: string; lastChange?: OpenedDocument['lastChange'] } | null> => {
					const slash = other.indexOf('/');
					const response = await fetch(
						`${ENDPOINTS.document}?collection=${encodeURIComponent(other.slice(0, slash))}&path=${encodeURIComponent(other.slice(slash + 1))}`,
					);
					if (response.status === 404 || response.status === 400) return null;
					if (!response.ok) throw new Error(String(response.status));
					const { version, text, lastChange } = (await response.json()) as OpenedDocument;
					return { version, text, lastChange };
				};
				void keeper.recoverOthers(id, fileOf).finally(() => keeper.settle());
				const onPageHide = () => keeper.pagehide();
				window.addEventListener('pagehide', onPageHide);
				stops.push(() => window.removeEventListener('pagehide', onPageHide));
			}

			// Live mode: the poll, and what its answers set off.
			if (liveSession && keeper) {
				stops.push(liveSession.start());
				stops.push(
					access.subscribe((next, previous) => {
						const openId = docId(doc.get().ref);
						// Someone else's lock lapsed: say so (the mockup's #lapsed toast).
						const title = doc.get().document.title || doc.get().entry.label;
						const lapsed = lapsedToast(previous, next, doc.get().entry.file, title);
						if (lapsed) editor.toast(lapsed, 'check');
						const taken = takenOverToast(previous, next, doc.get().entry.file, title);
						if (taken) editor.toast(taken, 'lock');
						// The lock lapsed, or Edit here took it: editable again, without a reload (Decision 9).
						if (previous.veil && !next.veil) {
							if (keeper.blocked().some((b) => b.id === openId && b.failure === 'locked')) void recheck(openId);
							else if (!keeper.dirty(openId)) void refreshOpen();
						}
						// Signed in again (from another tab): held edits go out under the re-send rule (Decision 11).
						if (previous.signedOut && !next.signedOut) {
							for (const b of keeper.blocked()) if (b.failure === 'signedout') void recheck(b.id);
							preview?.retry(); // a render dropped while signed out goes now
							editor.announce('Signed in again.');
						}
					}),
				);
				stops.push(
					liveState.subscribe((next, previous) => {
						// The server answers again (a deploy finished): what couldn't reach it goes now.
						if (next.reachable && !previous.reachable && keeper.status.get().state === 'offline') keeper.tryNow();
						// Someone else is changing the locked document: show their latest.
						const open = next.status?.open;
						const openId = docId(doc.get().ref);
						if (!open || open.file !== doc.get().entry.file) return;
						const change = open.lastChange.version;
						const seen = seenChange;
						seenChange = change;
						if (access.get().veil && change && change !== seen && change !== loadedVersion && !keeper.dirty(openId)) void refreshOpen();
						// Discard changes: someone put it back to what's live while this tab had it.
						if (open.discarded) void letGo(open.file, open.discarded);
					}),
				);
			}

			// The brand (M5a Decision 10): the poll carries Site Settings' as committed; the chrome follows it.
			if (liveSession) {
				stops.push(
					liveState.subscribe((next) => {
						const b = next.status?.brand;
						const now = brand.get();
						if (b && (b.name !== now.name || b.accent !== now.accent || b.logo !== now.logo || b.icon !== now.icon || b.tabIcon !== now.tabIcon)) brand.set(b);
					}),
				);
			}
			stops.push(
				brand.subscribe((b, was) => {
					// Only when the accent itself changed: another brand field kept (a site name, a logo) mustn't wipe a
					// preset picked in this tab and not yet kept (editor restyle, Decision 12).
					if (b.accent !== was.accent || b.accentInk !== was.accentInk || b.accentEdge !== was.accentEdge) {
						paintRoot({ accent: b.accent, ink: b.accentInk, edge: b.accentEdge });
					}
					// The tab's icon follows Site Settings' icon or logo (M5b Decision 11).
					const tab = b.tabIcon ?? b.icon ?? b.logo;
					const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
					if (tab && link && link.getAttribute('href') !== tab) link.setAttribute('href', tab);
					setTitle();
				}),
			);

			// The document list follows what changes it (M5a Phase 5): in live mode another
			// tab's new or deleted document (the waiting list's files and changes move), a
			// Publish; in both modes this tab's own changes once kept (titles, a shared block's
			// "Used on"). The last list stays on screen while it's read again (no flicker).
			let refreshing = false;
			let again = false;
			const refresh = () => {
				if (refreshing) {
					again = true;
					return;
				}
				refreshing = true;
				void editor
					.refreshDocuments()
					.catch(() => undefined)
					.finally(() => {
						refreshing = false;
						if (again) {
							again = false;
							refresh();
						}
					});
			};
			const waitingKey = (st: LiveState) => (st.status?.waiting ?? []).map((w) => `${w.file}:${w.change}`).sort().join('\n');
			// Arrange pages (Decision 18): an order-only Apply elsewhere changes no waiting key when Site Settings was
			// already waiting, so the saved order's stamp is watched too.
			const orderKey = (st: LiveState) => st.status?.pageOrderStamp ?? '';
			if (liveSession) stops.push(liveState.subscribe((next, previous) => next.status && previous.status && (waitingKey(next) !== waitingKey(previous) || orderKey(next) !== orderKey(previous)) && refresh()));
			stops.push(keep.subscribe((next, previous) => next.state === 'kept' && previous.state !== 'kept' && refresh()));

			// The cookie follows the sidebar's per-browser state (Decision 20).
			stops.push(ui.subscribe((state) => (document.cookie = uiCookieString(state))));
			document.cookie = uiCookieString(ui.get());

			// Addresses (Decision 19): the address names the open document; back and forward open theirs.
			// M6: the inbox's own address (`/admin/submissions[/<id>]`) stays as it is.
			const canonical = view.get().level === 'submissions' ? inboxAddress(view.get().inbox?.id ?? null) : view.get().level === 'arrange' ? ARRANGE_ADDRESS : addressOf(doc.get().ref, site.home);
			if (location.pathname !== canonical) history.replaceState({ caracms: id }, '', canonical + location.search);
			const onPopState = () => {
				if (isArrangeAddress(location.pathname)) {
					editor.openArrange({ history: 'none' });
					return;
				}
				// Back from the arrange screen with something arranged: it stays, and asks first (Decision 15).
				if (view.get().level === 'arrange' && editor.arrangeGuard) {
					// The screen's entry is put back while it asks; leaving steps back off it again, so the
					// history is as a plain Back leaves it (the arrangement is gone by then, so it doesn't ask twice).
					const asked = editor.arrangeGuard.ask(() => history.back());
					if (asked) {
						history.pushState({ caracms: 'arrange' }, '', ARRANGE_ADDRESS);
						return;
					}
				}
				const inbox = inboxFromAddress(location.pathname);
				if (inbox && inbox !== 'bad') {
					editor.openInbox(inbox.id, { history: 'none' });
					return;
				}
				const ref = refFromAddress(location.pathname, site.collections.map((c) => c.name), site.home);
				if (ref && site.collections.some((c) => c.name === ref.collection)) void editor.openDocument(ref, { history: 'none' });
			};
			window.addEventListener('popstate', onPopState);
			stops.push(() => window.removeEventListener('popstate', onPopState));
			setTitle();
			stops.push(doc.state.subscribe(setTitle));
			stops.push(view.subscribe((next, previous) => next.level !== previous.level && setTitle()));

			return () => stops.forEach((stop) => stop());
		},
	};
	// Review gaps (Decision 7): a block state goes when its block stops being the selected one on its page
	// (another block, Esc, another document opened on its own); a document opened over that page keeps it.
	// Checked once a change settles (a microtask), so the steps of going back to the page, which selects
	// the block again, don't drop it on the way.
	let stateCheck = false;
	/** Drop the state; when its page is the one shown, draw it in its first look again. */
	const dropState = (s: BlockStateView) => {
		blockState.set(null);
		if (sameDoc(s.page, shownPage())) preview?.retry();
	};
	const checkState = () => {
		if (stateCheck || !blockState.get()) return;
		stateCheck = true;
		queueMicrotask(() => {
			stateCheck = false;
			const s = blockState.get();
			if (!s) return;
			const o = over.get();
			if (o) {
				if (!sameDoc(o.page, s.page)) dropState(s);
				return;
			}
			const session = doc.get();
			if (!sameDoc(session.ref, s.page)) return dropState(s);
			// Back on its page (its keys made afresh), the block is the one at its index; on it, its key follows a reorder.
			const at = s.key === null ? -1 : doc.indexOf(s.key);
			const key = at >= 0 ? s.key : (doc.keyAt(s.block) ?? null);
			const v = view.get();
			const selected = session.document.kind === 'sections' ? v.level === 'block' && !!key && v.block === key : editor.fieldsOpen(v);
			if (!selected || key === null) return dropState(s);
			const block = doc.indexOf(key);
			if (key !== s.key || block !== s.block) blockState.set({ ...s, key, block });
		});
	};
	view.subscribe(checkState);
	doc.state.subscribe(checkState);
	over.subscribe(checkState);
	// The switch's pulse and the bar's "Showing …" last until the render lands, or fails. A failed one
	// goes back to the state last drawn, so the switch stays on what the page shows (the last good
	// render); choosing the state again retries it.
	preview?.onMorph(() => {
		const s = blockState.get();
		if (s && (s.waiting || s.drawn !== s.name)) blockState.set({ ...s, waiting: false, drawn: s.name });
	});
	preview?.onFail(() => {
		const s = blockState.get();
		if (!s?.waiting) return;
		blockState.set(s.drawn === null ? null : { ...s, name: s.drawn, waiting: false });
	});

	return editor;
}

/** A 401's body as the signed-out state (as live.ts reads it). */
function signedOutFrom(body: unknown): SignedOutError {
	const b = (body && typeof body === 'object' ? body : {}) as Partial<SignedOutError>;
	return { error: b.error ?? 'signed-out', code: 'signed-out', reason: b.reason === 'removed' ? 'removed' : 'signed-out', signIn: b.signIn ?? '/admin/login' };
}

/** A list row's path → the list's: `images.6` → `images`. */
const listOf = (path: string) => (path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : path);

function safeStorage(): Storage | null {
	try {
		const s = window.localStorage;
		s.getItem('caracms:probe');
		return s;
	} catch {
		return null;
	}
}
