/**
 * Types the editor's server routes and its browser code share. Types only: the
 * browser imports nothing from config.ts or content.ts at run time (they read the
 * disk), only document.ts and fields.ts, which are pure.
 */
import type { AccentPreset } from './client/accent-presets.ts';
import type { Brand, Fields, ResolvedBlock } from '../config.ts';
import type { DocumentEntry } from '../content.ts';
import type { AnyDocument, DocumentBlock, DocumentKind, Frame, SiteDocument } from '../document.ts';
import type { Person } from '../live/messages.ts';
import type { ResolvedFormField } from '../forms/rules.ts';
import type { CodeRoute } from '../code-routes.ts';
import type { ListedFolders } from '../page-folders.ts';
import type { SubmissionResponse, SubmissionsListResponse, SubmissionsSetup } from '../forms/inbox.ts';

// M6 Decision 9: the inbox's routes and shapes (forms/inbox.ts), for the client.
export type { NotSpamResponse, SubmissionRow, SubmissionsListResponse, SubmissionResponse, SubmissionsSetup, SubmissionsUnset } from '../forms/inbox.ts';
export type { EmailOutcome, StoredFile, StoredSubmission } from '../forms/store.ts';

export type { Person };

/** A document's identity: its collection and its path in it (content.ts → DocumentEntry). */
export interface DocRef {
	collection: string;
	path: string;
}

/** `pages/services/branding`: a document's id, for keys, storage and the Recent list. */
export const docId = (ref: DocRef): string => `${ref.collection}/${ref.path}`;

/**
 * Whether the editor opens a listed document. One whose only trouble is a missing title
 * does (caracms-cloud adversarial review, finding 15): it's kept off the site and marked,
 * and opening it is how the title goes back. Invalid JSON and a nested index.json don't.
 */
export const opensInEditor = (doc: Pick<DocumentEntry, 'warning'>): boolean => !doc.warning || doc.warning.code === 'no-title';

/** The screen reader's words for a listed document's warning mark. */
export const warnedWords = (doc: Pick<DocumentEntry, 'warning'>): string => (doc.warning?.code === 'no-title' ? ', needs a title' : ", can't be opened");

export const sameDoc = (a: DocRef | null | undefined, b: DocRef | null | undefined): boolean =>
	!!a && !!b && a.collection === b.collection && a.path === b.path;

/**
 * A collection as the editor's screens know it (M5a Phase 5: every kind). Kept as its
 * own name for the code that only reads `name`, `label`, `urlBase` and `nested`.
 */
export type EditorCollection = EditorAnyCollection;

/**
 * Any collection as the browser knows it (M5a): the site's section builders and
 * list-of-fields collections, then the reserved `shared` and `settings` (Decision 8).
 * `urlBase` is null for the reserved two; `fields` is a fields collection's (and
 * Site Settings' site-added) fields, labelled.
 */
export interface EditorAnyCollection {
	name: string;
	label: string;
	kind: 'sections' | 'fields' | 'shared' | 'settings';
	urlBase: string | null;
	nested: boolean;
	fields: Fields | null;
	/** The table's columns after the title, as configured; null or absent for the default (pre-M7 polish; columns.ts). */
	columns?: string[] | null;
	/** The view's initial order (posts and tags, Decision 13): `title` or a column, either way; null or absent for the title, A to Z. */
	sort?: import('../columns.ts').SortConfig | null;
	/** Review gaps (Decision 1): `'manual'` for a hand order (its listing comes in Site order); absent for none. */
	order?: 'manual' | null;
	/** A section builder's offered blocks (config.ts); null or absent for every block. */
	blocks?: string[] | null;
	/**
	 * Collections under pages (Decision 7): the nested collection whose page holds this one, set
	 * only on a held collection. Its `urlBase` is then the server's resolved base (the holder's
	 * address + `/`), or null while `problem` says why it has none.
	 */
	heldBy?: string | null;
	/** A held collection's holder (held.ts → HeldBase); null or absent when none holds it, and on any other collection. */
	holder?: { collection: string; path: string } | null;
	/** Decision 13's sentence for a held collection with no addresses (shown on its sidebar entry); null or absent otherwise. */
	problem?: string | null;
}

/**
 * The brand as the editor's chrome shows it (M2's four slots, all Site Settings': M5a
 * Decision 10, M5b Decision 11). `tabIcon` is the tab's icon as it applies: the icon,
 * else the logo, else the neutral mark (the initial on the accent), so the client
 * follows a change without working it out (brand.ts → editorBrand).
 */
export type EditorBrand = Brand & { accentInk: string; accentEdge: string; tabIcon?: string };

/** What the browser knows about the site: the resolved config minus the server's absolute paths. */
export interface EditorSite {
	/**
	 * Every collection, of every kind, in config order with the reserved `shared` and
	 * `settings` last (M5a Phase 5: the editor opens all four kinds). Use `kind` to
	 * tell them apart: the documents level lists `sections` and `fields` collections
	 * under Pages and Collections, and the reserved two under Site-wide.
	 */
	collections: EditorAnyCollection[];
	/** The same list as `collections` (M5a Phase 2's name for it, kept). */
	allCollections: EditorAnyCollection[];
	/** Block type → its schema (the shape document.ts's parse helpers take). `component` is relative. */
	blocks: Record<string, ResolvedBlock>;
	/** Text style → what the editor's warnings read. */
	textStyles: Record<string, { name: string; sizePx: number; minSizePx: number }>;
	/**
	 * The four brand slots (M2), with the accent's ink and edge computed by contrast
	 * (brand.ts). Name and accent are Site Settings' as committed (M5a Decision 10), as
	 * at first paint; in live mode the status poll carries changes (`StatusResponse.brand`).
	 */
	brand: EditorBrand;
	/** Site Settings' accent presets (editor restyle, Decision 12), as brand.ts reads them from tokens.css. */
	presets: AccentPreset[];
	phoneLinesWidth: number;
	/** The document `/admin` opens: Home. */
	home: DocRef;
	/** The dev server's host, for the too-narrow note's address. */
	host: string;
	/** Keeps this site's unsent edits apart from another site's on the same dev port (a hash of its root). */
	storageKey: string;
	/** M6: the site's time zone (`timeZone` in the config), for the inbox's times in local mode (live mode's status has it too). */
	timeZone?: string;
	/** The zone's name as the server words it ("Ireland Time"): the browser shows this one, so a hydrated page reads as the server rendered it (zone-name.ts). */
	timeZoneName?: string;
	/** M8 Decision 10: the URLs the site's own `src/pages/` serves, which a page can't take (code-routes.ts). */
	codeRoutes?: CodeRoute[];
}

/**
 * A listed document, with its file's modification time (null if unreadable). M5a:
 * every kind of document is listed, with `kind`, its public `url` (null for a shared
 * block or Site Settings), a section builder's shared entries (`uses`), and a shared
 * block's `blockType` and `usedOn` (content.ts → DocumentEntry).
 */
export interface ListedDocument extends DocumentEntry {
	mtimeMs: number | null;
}

/**
 * Page folders (Contracts → the listing): the Pages tree's folders as the client draws them,
 * each level's drawn folders in tree order with their rows' paths in order, and the order
 * stamp (page-order.ts → `pageOrderStamp` over `pageOrder` and `pageFolders`) the Apply's
 * `expectOrder` sends back. GET /_caracms/documents?with=folders answers
 * `{ documents, pages }`; the first paint has it in the props.
 */
export interface PagesLayout {
	folders: ListedFolders;
	orderStamp: string;
	/** Every folder id at each level, drawn or not, so a new folder's id steers clear of a hidden one's (check 7). */
	ids?: Record<string, string[]>;
}

/**
 * A document as the editor opens it (GET /_caracms/document). `D` is its document's
 * shape: a section builder's by default (what the editor's screens open today); the
 * route answers any kind (`AnyOpenedDocument`, M5a).
 */
export interface OpenedDocument<D extends AnyDocument = SiteDocument> {
	entry: DocumentEntry;
	/** The file's text as read: the serializer's base for the editing session. */
	text: string;
	document: D;
	mtimeMs: number;
	/**
	 * A short hash of `text`: the file's version. Unsent edits remember the version of
	 * the file they were made against (keeper.ts → "newer than its file").
	 */
	version: string;
	/** Live mode (M4 Decision 11): who last changed it, for re-sending held edits. Absent in local mode. */
	lastChange?: LastChange;
}

/**
 * GET /_caracms/document for any kind (M5a). `document` is, by `entry.kind`:
 * - `sections`: `{ title, blocks }` (a shared entry is a block with `shared`, never known);
 * - `fields`: `{ kind: 'fields', title, data }`, every schema field parsed;
 * - `shared`: `{ kind: 'shared', title, block }`;
 * - `settings`: `{ kind: 'settings', title, data: { editors, brand: { name, accent }, …the site's own } }`.
 * The write route takes the same shapes back (`{ file, base, document }`).
 */
export type AnyOpenedDocument = OpenedDocument<AnyDocument>;

/** Per-browser state the sidebar paints at first paint, kept in a cookie (Decision 20; ui-state.ts). */
export interface UiState {
	/** Pages groups (and pages with children) shown open, by `<collection>:<path>`. Absent: never touched. */
	open: Record<string, boolean>;
	/** Recently opened documents, newest first, by docId. */
	recent: string[];
	/** The sidebar hidden (pre-M7 polish: the bar's button and ⌘\\). Absent: shown. */
	side?: 'hidden';
}

/** Everything /admin server-renders from, and hydrates with. */
export interface AdminProps {
	site: EditorSite;
	documents: ListedDocument[];
	/** Page folders: the Pages tree's folders and order stamp, with `documents`. */
	pages: PagesLayout;
	/** The open document, of any kind (M5a). */
	opened: AnyOpenedDocument;
	ui: UiState;
	/** This browser holds unsent edits for the site (a cookie, ui-state.ts): the bar starts at Keeping. */
	unsent: boolean;
	/**
	 * M4: live mode's start (M4 Decision 13): who is signed in, and the status as the
	 * server read it for this page (no tab yet, so a lock of yours reads as another
	 * tab's until the first poll). Null or absent: local mode, which never polls and
	 * shows none of M4's places (M3's editor, Decision 1).
	 */
	live?: LiveProps | null;
	/**
	 * M5b: whether the media routes are set up here, read as /admin renders (Decision 5),
	 * so a media field shows the 503's sentence in its first paint. Absent: unknown (the
	 * field finds out from the routes).
	 */
	media?: MediaSetup;
	/**
	 * M6 Decision 9: the address opened the inbox (`/admin/submissions`, `{ id: null }`) or a
	 * submission in it (`/admin/submissions/<id>`, the email's link). Null or absent: a
	 * document's address. `opened` is then Home, the page under the inbox.
	 */
	inbox?: { id: string | null } | null;
	/**
	 * Arrange pages (Decision 15): the address opened the arrange screen (`/admin/arrange`),
	 * with nothing arranged. `opened` is then Home, the page under it.
	 */
	arrange?: boolean;
	/**
	 * M6 Decision 9: the unread count for the Site-wide row, read as /admin renders; or,
	 * when the production server has no submissions bucket, the sentence naming what's
	 * missing (`submissions-off`). The documents route carries the count too, in its
	 * `X-Caracms-Unread` header.
	 */
	submissions?: SubmissionsSetup;
	/** M6: the site's forms (id, label, fields in order), for Site Settings' Form emails and the Form block's picker. */
	forms?: EditorForm[];
	/**
	 * M6: with `inbox`, its first page and the submission the address names, read as /admin
	 * renders, so the list and the sheet are in the first paint. Null parts are read by the browser.
	 */
	inboxFirst?: { list: SubmissionsListResponse | null; open: SubmissionResponse | null } | null;
}

/** One of the site's forms, as the editor shows it (M6). */
export interface EditorForm {
	id: string;
	label: string;
	fields: ResolvedFormField[];
}

export interface LiveProps {
	you: Person;
	/** Null when the server couldn't read it (Redis out): the first poll fills it. */
	status: StatusResponse | null;
	/** How often the tab polls (live timings' `pollMs`: POLL_MS, shorter only in tests). */
	pollMs?: number;
	/** Redis diet Decision 8: a visible tab with no input this long polls at `slowPollMs` (live timings'; absent: 2 minutes). */
	idleSlowAfterMs?: number;
	/** Redis diet Decision 8: an idle tab's poll interval (absent: 30 s). */
	slowPollMs?: number;
	/** Redis diet Decision 10: once the tab holds the document, a keep goes this long after the last change (absent: 3 s). */
	keepDelayMs?: number;
	/** Redis diet Decision 10: …and never later than this after the first change not yet sent (absent: 15 s). */
	keepCapMs?: number;
}

/** A block in the editor: a DocumentBlock plus a key that stays with it through moves (never written). */
export interface EditorBlock extends DocumentBlock {
	key: string;
}

/**
 * The open document in the editor's store (document-store.ts). Every kind is held as a
 * list of blocks, so every field is set the same way (by a key and a path):
 * - `sections`: the page's blocks;
 * - `fields` and `settings`: one block, the form (its `data` is the document's
 *   `data`; `type` '' and `known`), never written as a block;
 * - `shared`: one block, the shared block itself.
 */
export interface EditorDocument {
	kind: DocumentKind;
	title: string;
	blocks: EditorBlock[];
	/**
	 * M6 Decision 13: a section builder's or a fields document's own `seo` (title,
	 * description, image), as edited; absent until the file has it or something is set.
	 * Set through `setField(SEO_SCOPE, …)` (document-store.ts).
	 */
	seo?: Record<string, unknown>;
	/**
	 * M6c (G2): a section builder's page fields, as edited; present when its collection
	 * has page fields. Set through `setField(PAGE_SCOPE, …)` (document-store.ts).
	 */
	data?: Record<string, unknown>;
	/** M9 Decision 7: a section builder hidden from the site; absent when the file isn't. Set through `setHidden`. */
	hidden?: boolean;
	/**
	 * Edit in context, Decision 3: a section builder's or a fields document's own picks for its
	 * frame's slots, as edited; absent until the file has one or a picker is set (`{}`: every pick
	 * cleared, which takes the key out of the file). Set through `setFrame`.
	 */
	frame?: Frame;
	/** Edit in context, Decision 3: a slot block that's its slot's default; absent when the file doesn't say. Set through `setDefault`. */
	default?: boolean;
}

/** The preview widths (M2 Decision 3): each iframe at its true width. */
export type Width = 'desktop' | 'tablet' | 'phone';
export const WIDTHS: readonly Width[] = ['desktop', 'tablet', 'phone'];
export const TRUE_WIDTH: Record<Width, number> = { desktop: 1440, tablet: 768, phone: 375 };
export const WIDTH_LABEL: Record<Width, string> = { desktop: 'Desktop', tablet: 'Tablet', phone: 'Phone' };

/**
 * The attribute on a preview's `<html>` (M8 review): the editor's middleware adds it to the
 * preview route's 200 HTML, so a frame that loaded an error page (a 404, a 401, a 500) can
 * tell it isn't a preview (preview/driver.ts).
 */
export const PREVIEW_MARK = 'data-caracms-preview';

/** The editor's endpoints. M4: injected in dev and in the build; live mode needs a session (Decision 14). */
export const ENDPOINTS = {
	preview: '/_caracms/preview',
	document: '/_caracms/document',
	documents: '/_caracms/documents',
	write: '/_caracms/write',
	// M5a Phase 3: creating and deleting documents, both modes (Decisions 11 and 12).
	create: '/_caracms/create',
	delete: '/_caracms/delete',
	// Pre-M7 item 8: changing a document's address, both modes.
	move: '/_caracms/move',
	// Arrange pages (Contracts): the arrange screen's Apply, both modes.
	arrange: '/_caracms/arrange',
	// Review gaps (Decisions 2 and 4): a manual collection's hand order, both modes.
	collectionOrder: '/_caracms/collection-order',
	// Edit in context, Decision 3: a slot block made its slot's default, both modes.
	slotDefault: '/_caracms/slot-default',
	// M5b Phase 2: the media routes, both modes (MEDIA_ENDPOINTS below has each one).
	media: '/_caracms/media',
	// M4 Phase 2 (live mode only; local mode answers 404).
	status: '/_caracms/status',
	lock: '/_caracms/lock',
	publish: '/_caracms/publish',
	history: '/_caracms/history',
	tryAgain: '/_caracms/try-again',
	notice: '/_caracms/notice',
	// Discard changes (live mode only): one document back to what's live.
	discard: '/_caracms/discard',
	// M6 Decision 9: the inbox, both modes (forms/inbox.ts has each route).
	submissions: '/_caracms/submissions',
} as const;

/** M6: the unread count on the documents route's response and the inbox's 204s (forms/inbox.ts → UNREAD_HEADER). */
export const UNREAD_HEADER = 'X-Caracms-Unread';

// ── Live mode's answers (M4 Phase 2), for Phase 4's client ─────────────────────

/** Every editor request from a tab carries its id in this header (Decision 4). */
export const TAB_HEADER = 'X-Caracms-Tab';
/** `1` on the closing tab's last write: release the lock once it's committed (Decision 9). */
export const RELEASE_HEADER = 'X-Caracms-Release';
/**
 * On every write: the tab's own write sequence, rising with each write (never lower than
 * the last, across reloads too: it starts from the clock). The server never lets a write
 * with a lower one replace the same tab's newer autosave.
 */
export const SEQ_HEADER = 'X-Caracms-Seq';

/** An error answer: a plain sentence, and a code for the states the editor tells apart. */
export interface ApiError {
	error: string;
	/** `signed-out` (401), `locked` (409), `unavailable` (503: Redis or GitHub out past its budget), `no-tab` (400), `not-live` (404 in local mode). */
	code?: string;
}

/**
 * Who last changed a document, and the version that change left (Decision 11). A merge
 * from `main`, or the sweep committing someone's own autosave, doesn't change `by`.
 * `by` null (and `known` not false): only merges from `main` are known. `version` null:
 * known from git only (after a flush), so compare by text.
 */
export interface LastChange {
	/**
	 * False: the server can't tell who last changed it (no record, and git names nobody:
	 * never edited here, or Redis lost its data). The keeper treats that as someone
	 * else's change (held, Use mine / Discard mine), never a silent re-send. Absent: known.
	 */
	known?: boolean;
	by: Person | null;
	/** fileVersion of the text that editor's autosave left. */
	version: string | null;
	/** ISO. */
	at: string | null;
	/**
	 * Discard changes: someone put the document back to what's live (within the last week),
	 * and when. Edits held in a browser from before then are dropped, not re-sent (keeper.ts → verdict).
	 */
	discarded?: { by: Person; at: string } | null;
}

/**
 * POST /_caracms/discard `{ file }` (live mode only): put one waiting document back to what's
 * live. A changed one reads as `main` has it, a new one is removed, a deleted one comes back,
 * a moved one goes back to its old address (its file `movedBack`). `{ file, seen: true }`: this
 * tab has let go of its copy of a document someone discarded (`open.discarded`).
 */
export interface DiscardRequest {
	file: string;
	seen?: true;
}

export interface DiscardResponse {
	ok: true;
	file: string;
	/** What it was: `changed`, `new` (now removed) or `deleted` (now back). */
	change: WaitingChange;
	/** Every file put back as `main` has it. */
	files: string[];
	/** A moved document: where it is again (its collection and path), else null. */
	movedBack: { collection: string; path: string; file: string } | null;
}

/**
 * Discard's refusals: `not-waiting` (404: nothing to discard), `locked` (409: someone is
 * editing it now), `publishing` (409), `busy` (409: the sweep is busy on another server),
 * `held-move` (409: it moved with the page that holds it), `bad-request`/`bad-path` (400).
 */
export interface DiscardRefusal extends ApiError {
	code: 'not-waiting' | 'locked' | 'publishing' | 'busy' | 'held-move' | 'swap' | 'bad-request' | 'bad-path' | 'no-tab' | 'signed-out' | 'unavailable';
}

/** 401 from any editor API in live mode with no session (Phase 3's guard, Decision 11). */
export interface SignedOutError extends ApiError {
	code: 'signed-out';
	/** `removed`: the cookie was valid, but the address is no longer on the whitelist. */
	reason: 'signed-out' | 'removed';
	/** Where to sign in again (opened in a new tab). */
	signIn: string;
}

/** A document's lock as a tab sees it (Decision 9). */
export interface LockView {
	file: string;
	person: Person;
	/** ISO: when it was taken. */
	since: string;
	/** The holder's tab is closing: the lock drops once its autosave is committed. */
	releasing: boolean;
	/** `this-tab`: the asking tab holds it. `other-tab`: the same person, another tab (Edit here). null: someone else. */
	mine: 'this-tab' | 'other-tab' | null;
}

/** The open document's lock, from the asking tab's side. */
export type LockState = 'free' | 'yours' | 'yours-elsewhere' | 'theirs';

/** 409 from the write route or `POST /_caracms/lock` (take): another tab holds the lock. */
export interface LockRefusal extends ApiError {
	code: 'locked';
	lock: LockView;
	state: 'yours-elsewhere' | 'theirs';
	lastChange: LastChange;
}

/**
 * What a waiting document is to `main` (M5a Decisions 11 and 12): `new` (main doesn't
 * have it), `deleted` (main has it and the draft removes it), or `changed`. A document
 * created and deleted again before a Publish isn't waiting at all.
 */
export type WaitingChange = 'changed' | 'new' | 'deleted';

export interface WaitingView {
	file: string;
	/** New, Deleted, or changed (M5a). For `deleted`, `editors[0]` is who deleted it. */
	change: WaitingChange;
	/** The document's collection and path, when the file is a document. */
	collection: string | null;
	path: string | null;
	title: string;
	/** Who changed it since the last publish, most recent first (committed and uncommitted). */
	editors: { person: Person; at: string }[];
	changedAt: string | null;
	/** An autosave not yet in `drafts`. */
	uncommitted: boolean;
	/** The merge kept the draft for a key or the file (Decision 7's notice). */
	keptDraft: boolean;
	/** Who holds its lock, when that isn't the asking tab (another person, or your own other tab): "Editing now". Empty otherwise. */
	editingNow: Person[];
	/**
	 * M5b Decision 9: each image in it with no alt text that isn't decorative, read from the
	 * document as it will publish (the `drafts` copy with autosaves on top). Only rendered
	 * slots count (no unknown or skipped blocks, no shared entry on a page, no brand logo or
	 * icon); a deleted document has none. Publish's summary names them; nothing blocks.
	 */
	missingAlt: MissingAltView[];
	/**
	 * Pre-M7 item 8: a document whose address changed, on its new file's entry: its old
	 * address. The old file's own "deleted" entry isn't listed (it's the same document).
	 */
	movedFrom?: string;
	/** With `movedFrom`: Site Settings' redirects send visitors from the old address here (the editor may have taken it out). */
	movedRedirect?: boolean;
	/**
	 * caracms-cloud adversarial review, finding 15: why Publish will leave it waiting ("its title
	 * is empty"), read from the document as it will publish; absent when it will go out.
	 */
	heldBack?: string;
}

/**
 * One image with no alt text in a waiting document (M5b Decision 9), as Publish's summary
 * names it ("Gallery image 3 has no alt text") and Add alt text opens it:
 * `editor.openDocument({ collection, path })`, then `openBlock(doc.keyAt(block) ?? formKey, field)`,
 * expanding `row` when it's in a list.
 */
export interface MissingAltView {
	/** The block's index in a section builder's `blocks` (0 for a shared block's own document); null for a fields document or Site Settings (their form), and for a section builder's page fields (M6c G2). */
	block: number | null;
	/** The slot's top-level field in the block or form: `media`, `images`, `cover`. */
	field: string;
	/** The dotted path to the empty `alt`, from the block's (or form's) data: `media.alt`, `images.2.alt`, `cover.alt`. */
	path: string;
	/** The list row it's in (0-based, as the editor's rows; the outer row, for an inner list's image: M7), or null when the slot isn't in a list. */
	row: number | null;
	/** The slot's label: "Hero image", "Text and media image", "Gallery image 3", "Cover image". */
	label: string;
}

export interface PresenceView {
	file: string;
	people: Person[];
}

export type NoticeView =
	/** "Home was also changed outside the editor. Your draft was kept; check it before publishing" (Decision 7). */
	| { id: string; kind: 'draft-kept'; file: string; title: string }
	/** "Aoife published Home as it stood at 14:20" (Decision 10), for the people who had it open. */
	| { id: string; kind: 'published-as-it-stood'; file: string; title: string; by: Person; at: string }
	/** "Aoife discarded the unpublished changes to About" (Discard changes), for the people who had edits in it or had it open. */
	| { id: string; kind: 'discarded'; file: string; title: string; by: Person; at: string };

export interface PublishRecordView {
	commit: string;
	by: Person;
	at: string;
	files: string[];
	titles: string[];
	tryAgainAt: string | null;
}

export interface PublishView {
	/**
	 * `none`: nothing published since the record began. `slow` (runs-anywhere Decision 10):
	 * still not live 15 minutes after it was made or last tried again, with no failure
	 * known: "taking longer than usual. It may have failed."
	 */
	state: 'none' | 'publishing' | 'live' | 'failed' | 'slow';
	/** A Publish is running now (committing, or moving the refs), before any record. */
	running: boolean;
	record: PublishRecordView | null;
	/** Live only because there's no deploy pipeline (Decision 12). */
	assumed: boolean;
	/** Failed or slow, and Try again can redeploy. */
	canTryAgain: boolean;
	/** A redeployer is set (a deploy hook, or Railway's token). Failed with none: "A developer can redeploy it" (runs-anywhere Decision 11). */
	hasRedeployer: boolean;
}

/** GET /_caracms/status?file=<open document's file> (Decision 13). */
export interface StatusResponse {
	mode: 'live';
	you: Person;
	tab: string | null;
	/** Server time, ISO. */
	now: string;
	/** IANA zone for every time shown (Decision 16). */
	timeZone: string;
	/** The open document as the asking tab sees it; null when the poll named none. */
	open: {
		file: string;
		state: LockState;
		lock: LockView | null;
		lastChange: LastChange;
		/**
		 * M5a Decision 12: the document doesn't exist any more (deleted, or never there):
		 * who deleted it and when, when that's known (`by` null: not known). Null while it exists.
		 */
		deleted: { by: Person | null; at: string | null } | null;
		/**
		 * Discard changes: someone put the document back to what's live while this tab had it
		 * (open, or edits in it), so this tab's copy is stale: it lets go (`POST discard { file,
		 * seen }`) and reads it again. Its writes are refused (409 `discarded`) until then.
		 */
		discarded?: { by: Person; at: string } | null;
	} | null;
	waiting: WaitingView[];
	locks: LockView[];
	presence: PresenceView[];
	notices: NoticeView[];
	publish: PublishView;
	/**
	 * Runs-anywhere Decision 5: what's wrong with the site's GitHub access, for every
	 * person, while it holds (not dismissable, unlike `notices`): a refused credential, a
	 * missing permission, or a token expiring within 14 days. `message` names the fix,
	 * for the developer it's forwarded to. Null when nothing is wrong. `cloud` (caracms-cloud
	 * M2 Decision 14): CaraCMS Cloud refused a token; `message` is the cloud's sentence and
	 * `link` the install link it names, if any, which the note shows as a link. `renamed`
	 * (caracms-cloud adversarial review, finding 7) is information, not a problem: the repo
	 * was renamed or transferred on GitHub and work carries on under the new name, shown
	 * until the server restarts.
	 */
	githubAccess: { kind: 'refused' | 'permission' | 'expiring' | 'cloud' | 'renamed'; title: string; message: string; link?: string | null } | null;
	/**
	 * caracms-cloud adversarial review, finding 4: edits are waiting in Redis and the draft
	 * commits that should carry them to GitHub have failed several times in a row (git.ts →
	 * `COMMIT_TROUBLE_AFTER`). The save bar stops saying Kept and says so; `message` is the
	 * whole sentence. Null otherwise, and again once a commit goes through. (Absent from an
	 * older server: read it as null.)
	 */
	commitTrouble?: { since: string; failures: number; message: string } | null;
	/**
	 * Finding 5: a start found the `drafts` branch gone and could only make it again from
	 * `main`, so what it held since the last Publish is gone. `commit` is its last recorded
	 * head (null: none was recorded). Shown to everyone for a week, or until the next Publish.
	 */
	draftsLost?: { title: string; message: string; commit: string | null; at: string } | null;
	/**
	 * caracms-cloud adversarial review, force-push note: `main` no longer has the last
	 * Publish's commit (`publish`), so its history was rewritten, and what was rolled back is
	 * waiting again. Shown to everyone until the next Publish, or once nothing is waiting.
	 * (Absent from an older server: read it as null.)
	 */
	mainRolledBack?: { title: string; message: string; publish: string; main: string; at: string } | null;
	/**
	 * The brand as committed in Site Settings (M5a Decision 10: read from `drafts`, never
	 * an autosave), so the chrome picks up a change on the next poll with no reload.
	 */
	brand: EditorBrand;
	/**
	 * Arrange pages (Decision 18): a short hash of Site Settings' `pageOrder` and `pageFolders`
	 * (page folders, Decision 12) as they stand in the store (the autosave on top of `drafts`),
	 * and of its `collectionOrder` (review gaps, Decision 2); `""` when there's none. When it changes,
	 * the tab re-reads the listing, as it does when the waiting list's keys change.
	 */
	pageOrderStamp: string;
}

/** POST /_caracms/lock `{ file, action }`. */
export interface LockRequest {
	file: string;
	/** `take`: Edit here (moves your own lock at once, or takes a free one). `release`: a closing tab with nothing unsent. */
	action: 'take' | 'release';
}
export interface LockResponse {
	state: LockState;
	lock: LockView | null;
}

/** POST /_caracms/publish. */
export interface PublishResponse {
	/** `held-back` (finding 15): everything waiting would break the reader, so nothing was published. */
	result: 'published' | 'nothing-waiting' | 'joined' | 'held-back';
	publish: PublishView;
	/** Finding 15: what was left waiting, and why ("its title is empty"); absent or empty when nothing was. */
	held?: { file: string; title: string; reason: string }[];
}

export interface HistoryEntryView {
	commit: string;
	by: Person | null;
	at: string;
	titles: string[];
	files: string[];
	state: 'publishing' | 'live' | 'failed' | 'slow';
}
/** GET /_caracms/history. */
export interface HistoryResponse {
	timeZone: string;
	entries: HistoryEntryView[];
}

/** POST /_caracms/try-again: 200 `{ ok: true }`, or 409/502 `{ ok: false, error }`. */
export type TryAgainResponse = { ok: true } | { ok: false; error: string };

/** POST /_caracms/notice `{ id }` → `{ ok: true }`. */
export interface NoticeRequest {
	id: string;
}

// ── Creating and deleting (M5a Phase 3, Decisions 11 and 12) ──────────────────

/**
 * POST /_caracms/create. `path` is the new document's path in its collection, its
 * address parts made with slug.ts → `slugify` (`studio/visit`; a fields collection's or
 * shared blocks' is one part). `title` is what the document is called. A shared block
 * also names its block's type.
 */
export interface CreateRequest {
	collection: string;
	path: string;
	title: string;
	/** A shared block's block type (required for `shared`, refused otherwise). */
	blockType?: string;
	/**
	 * Page folders (Contracts → Create): New page in <Folder> files the new page at the end of
	 * the folder with this id at its level. The response's `order` says how the filing went.
	 */
	folder?: string;
}

/** 200: the document exists now (on disk; in live mode, as the creator's autosave, the lock theirs). */
export interface CreateResponse {
	ok: true;
	collection: string;
	path: string;
	/** Relative to the site, as everywhere (`content/pages/studio/visit.json`). */
	file: string;
	/** Its public address; null for a shared block. */
	url: string | null;
	/** fileVersion of its first text. */
	version: string;
	/**
	 * Review gaps (Decision 4), a manual collection's new entry: `'first'` once it's first in
	 * the order; `'waiting'` when someone else had Site Settings, which holds the order (live
	 * mode), so it's after the named entries until the editor sends its place
	 * (CollectionOrderRequest's `first`); `'unkept'` when Site Settings can't be read, so the
	 * entry is made but its place isn't written (`orderError` says so). Absent for any other collection.
	 * Page folders: the same for a page made with `folder`: `'first'` once it's filed, `'waiting'`
	 * until the editor sends its filing (CollectionOrderRequest's `first` with `folder`), `'unkept'`
	 * when Site Settings can't be read or the folder is gone (`orderError` says which).
	 */
	order?: 'first' | 'waiting' | 'unkept';
	/** With `order: 'unkept'`: the sentence for the editor. */
	orderError?: string;
}

/**
 * POST /_caracms/collection-order (review gaps, Decisions 2 and 4): a manual collection's
 * hand order, written to Site Settings' `collectionOrder`. One of:
 * - `order`: the collection's whole list after a drag, first to last; it replaces the saved one.
 * - `first`: one entry first in the order as it stands (a new entry whose place waited on the lock).
 * Every path must be one of the collection's documents. Live mode: under Site Settings' lock,
 * as an autosave; someone else holding it refuses it (409 `locked`, naming them).
 */
export interface CollectionOrderRequest {
	collection: string;
	order?: string[];
	first?: string;
	/** Page folders: with `first`, a new page's filing that waited (the Pages collection only): `first` goes at the end of this folder. */
	folder?: string;
}

/** 200: the order is kept. */
export interface CollectionOrderResponse {
	ok: true;
}

/** POST /_caracms/delete. */
export interface DeleteRequest {
	collection: string;
	path: string;
}

/** 200: the document is gone (from disk; in live mode, a "gone" autosave the sweep commits). */
export interface DeleteResponse {
	ok: true;
	collection: string;
	path: string;
	file: string;
}

/**
 * POST /_caracms/move (pre-M7 item 8): change a document's address. `to` is its new
 * path in the same collection (`studio/visit`), its new parts made with slug.ts as a
 * new document's are. Every link and reference to it is rewritten, and a redirect from
 * the old address to the new is added to Site Settings unless `redirect` is false
 * (Change address…'s "Leave a redirect from …", on unless it's unticked).
 */
export interface MoveRequest {
	collection: string;
	path: string;
	to: string;
	/** Whether to leave a redirect from the old address (default true). A document that was never live gets none either way. */
	redirect?: boolean;
}

/** 200: the document is at its new path (live mode: as autosaves, all going out at the next Publish). */
export interface MoveResponse {
	ok: true;
	collection: string;
	/** The new path, file and address. */
	path: string;
	file: string;
	url: string;
	/** Where it was. */
	from: { path: string; file: string; url: string };
	/** The other documents whose links (or references) to it were rewritten, with their titles. */
	relinked: { collection: string; path: string; title: string }[];
	/** The redirect added: null when none was asked for, or for a document that was never live (made since the last Publish). */
	redirect: { from: string; to: string } | null;
	/**
	 * Collections under pages (Decision 9): every address that changed, this document's first,
	 * then the pages under it and the documents of a collection held under it (`from` = `to`:
	 * a held document's file stays where it is).
	 */
	moved: { collection: string; from: string; to: string; title: string; fromUrl: string; toUrl: string }[];
	/** Every redirect added, one per address that was live (none when none was asked for). */
	redirects: { from: string; to: string }[];
}

/**
 * POST /_caracms/arrange (arrange pages, Contracts): the arrangement as its result.
 * - `moves`: the roots only, each page whose path changes and isn't carried by a root above
 *   it (its old path under that root's `fromPath`, its new path that root's `toPath` + the
 *   same rest). The server expands each to everything under it (pages at any depth, a held
 *   collection's documents) except what's under another root, which wins for its own subtree.
 * - `order`: the full child list for every parent whose children or order changed, keyed by
 *   the parent's path after the moves (`""` the top level); an empty list drops the key.
 *   Every other saved list is re-keyed after the moves by the server.
 * - `redirect: false`: no redirects from the old addresses (the review's tick unticked).
 */
export interface ArrangeRequest {
	moves: ArrangeMove[];
	order: Record<string, string[]>;
	redirect?: boolean;
	/**
	 * Collection name → page-order.ts's `listingStamp` of every document path in that
	 * collection (hidden ones included) as the review's listing had them: Pages, and each
	 * collection held by a page that moves. Any difference at Apply refuses with 409
	 * `changed` and nothing is written (Decision 10). Absent: no check.
	 */
	expect?: Record<string, string>;
	/**
	 * Page folders (Decision 12): the order stamp (`PagesLayout.orderStamp`) the review was
	 * planned on. If Site Settings' order or folders changed since, 409 `changed` and nothing
	 * is written. Absent: no check.
	 */
	expectOrder?: string;
	/**
	 * Page folders (Contracts → the Apply request): the full folder list of every level whose
	 * folders change, keyed after the moves like `order` (`[]` drops the level's folders).
	 * `order` lists may carry folder tokens (`(<id>)`). Refused with 400 `bad-folders` when off.
	 */
	folders?: Record<string, ArrangeFolder[]>;
}
export interface ArrangeFolder {
	id: string;
	name: string;
	pages: string[];
}
export interface ArrangeMove {
	collection: string;
	fromPath: string;
	toPath: string;
}
/** 200: the moves and the order landed together (live mode: as autosaves, out at the next Publish). Refused: an ApiError like the move route's (`{ error, code }`, a lock refusal's state with `locked`). */
export interface ArrangeResponse {
	ok: true;
}

/**
 * Why a create or delete was refused: `{ error, code }` with a status.
 * - 400 `bad-request` (the body), `bad-path` (not a document path, outside its
 *   collection, a folder no collection declares, a link out), `bad-name` (a part that
 *   isn't an address `slugify` leaves as it is, or nothing left), `index`,
 *   `reserved-address` (under `/admin` or `/_caracms`), `below-collection` (strictly
 *   under another collection's address), `not-allowed` (Site Settings, Home, a shared
 *   block with no or an unknown block type), `not-held` (collections under pages, Decision 7: a
 *   held collection no page holds, or whose holding is a problem; the message is held.ts's sentence);
 * - 404 `not-found` (delete: no such document);
 * - 409 `changed` (arrange: the listing isn't the one the review was planned on), `exists` (create: the document is already there), `address-taken` (another
 *   document has that address: "There's already a page at /services/packaging"),
 *   `in-use` (a shared block something still uses; `usedOn` says where), `default` (edit in
 *   context, Decision 3: a slot's default: "Footer is the default footer…"), `locked`
 *   (live: someone else holds the document's lock: "Aoife is editing Contact"; the
 *   body is a LockRefusal's);
 * - and the write route's: 401 `signed-out`, 403, 405, 413, 415, 503 `unavailable`, 400 `no-tab`.
 */
export interface CreateDeleteRefusal extends ApiError {
	code?: CreateDeleteCode | string;
	/** `in-use`: the documents that use the shared block, with their titles. */
	usedOn?: { collection: string; path: string; title: string }[];
}

export type CreateDeleteCode =
	| 'bad-request'
	| 'bad-folders'
	| 'bad-path'
	| 'bad-name'
	| 'index'
	| 'reserved-address'
	| 'below-collection'
	| 'not-allowed'
	| 'not-held'
	| 'not-found'
	| 'exists'
	| 'address-taken'
	| 'in-use'
	// Edit in context, Decision 3: a slot's default can't be deleted.
	| 'default'
	| 'holds'
	| 'locked'
	| 'same'
	// Arrange pages (Decision 10): the listing changed since the review (ArrangeRequest.expect).
	| 'changed'
	// Arrange pages: an order-only Apply when Site Settings, which holds the order, isn't valid JSON.
	| 'invalid-json';

// ── Media (M5b Phase 2: Decisions 6, 7 and 12) ────────────────────────────────

/**
 * The media routes, under `/_caracms/media/`, in both modes (live mode: a session, and
 * the same origin for a POST, by the guard's prefix rule; local mode: no sign-in). No
 * lock: nothing here changes a document (Decision 7). Every reply is
 * `Cache-Control: private, no-store`. Unconfigured: 503 `MediaUnset`, images and clips
 * apart (one missing never disables the other).
 *
 * | Route | Takes | Gives |
 * |---|---|---|
 * | `POST upload` | the image's bytes as the body (any Content-Type), its file name in `X-Caracms-File-Name` (URI-encoded) | 201 `MediaUploadResponse` (new), 200 (the same bytes were already there: nothing written), or `MediaRefusal` 400/413/415/422 |
 * | `GET images` | | `MediaImagesResponse`: the library, newest first |
 * | `GET thumbnail?key=&width=` | an image's key, a ladder width (default 320) | 302 to the signed imgproxy URL (for a key the editor has from content) |
 * | `POST video-upload` | `VideoUploadRequest` (JSON) | 201 `VideoUploadResponse`: the browser PUTs the file to `url` (UpChunk) |
 * | `GET video-upload/<id>` | | `VideoUploadStatus` |
 * | `GET clips` | | `MediaClipsResponse`: the whole Mux library, newest first |
 * | `GET clips/<assetId>` | | `LibraryClip` |
 * | `GET playback/<playbackId>` | | `LibraryClip` (another environment's ID, or an unknown one: 404) |
 */
export const MEDIA_ENDPOINTS = {
	upload: '/_caracms/media/upload',
	images: '/_caracms/media/images',
	thumbnail: '/_caracms/media/thumbnail',
	videoUpload: '/_caracms/media/video-upload',
	clips: '/_caracms/media/clips',
	playback: '/_caracms/media/playback',
	/** M6c G4: Replace… on a file (`ReplaceFileRequest` → `ReplaceFileResponse`). */
	replace: '/_caracms/media/replace',
} as const;

/** The upload's file name, `encodeURIComponent`-ed (a header takes no other characters). */
export const MEDIA_NAME_HEADER = 'X-Caracms-File-Name';

/** Decision 6: the largest original the library takes, in bytes (40 MB, as Finder counts them). */
export const MEDIA_MAX_BYTES = 40_000_000;
/** Decision 6: the most pixels (imgproxy's `IMGPROXY_MAX_SRC_RESOLUTION` 50, in megapixels). */
export const MEDIA_MAX_PIXELS = 50_000_000;
/** The types the library takes, as every refusal names them. */
export const MEDIA_TYPES_TEXT = 'JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG';
/** M6c G4: the files the library takes (caracms/files' table, by label), as every refusal names them. */
export const FILE_TYPES_TEXT = 'PDF, Word, Excel, PowerPoint, CSV or Zip';
/** Decision 6: a clip dropped on an image-only slot (the editor says it; the server never sees the clip). */
export const VIDEO_ON_IMAGE_SLOT_MESSAGE = "That's a video, and this slot takes images only.";

/** A document that uses an image or a clip (the store's listing: `drafts` with autosaves in live mode, the disk in local mode). */
export interface MediaUse {
	collection: string;
	path: string;
	/** The document's label in the listing. */
	title: string;
}

/** One image in the library (Decision 7): an object under `uploads/` in the bucket, with its metadata. */
export interface LibraryImage {
	/** M6c G4: the listing's entries say what they are (a file is `LibraryFile`). */
	kind: 'image';
	/** The bucket key, what a slot stores: `uploads/3f9a1c07b2e4/harbour-wall.jpg`. */
	key: string;
	/** The original file name (metadata `name`), or the key's own file name when it has none. */
	name: string;
	/** The pixel size after EXIF orientation (metadata `w`/`h`); null when the object has none. */
	w: number | null;
	h: number | null;
	/** The original's size in bytes, from the listing; null when unknown. */
	bytes: number | null;
	/** ISO: when it was uploaded (the object's Last-Modified). The library is sorted on it, newest first. */
	uploadedAt: string | null;
	/** Who uploaded it (metadata `by`: an address, or `setup`); null in local mode, which has no sign-in. Show nothing then. */
	by: string | null;
	/**
	 * A signed imgproxy URL, `rs:fit:320:0` WebP (a GIF or an SVG passes through as itself).
	 * Always this, never the original: Chrome can't show a HEIC. The signing key stays on the server.
	 */
	thumbnail: string;
	/** The same at 640 wide, for a 2× screen: `srcset="<thumbnail> 1x, <thumbnail2x> 2x"`. */
	thumbnail2x: string;
	/** Every document that uses it, in listing order (empty: unused, for the toggle). */
	usedIn: MediaUse[];
	/** An alt text already used for it (the first non-empty in the listing's document order, decorative ones skipped), or null. Picking fills the slot's alt with it. */
	alt: string | null;
	/** A focal point already set for it (the first in the listing's document order, decorative uses included), or null. Picking brings it along with the alt. */
	focal: [number, number] | null;
}

/** GET /_caracms/media/images. No paging in v1 (Decision 7). M6c G4: the files beside the images, one listing. */
export interface MediaImagesResponse {
	images: LibraryImage[];
	files: LibraryFile[];
}

/** POST /_caracms/media/upload: the image's library entry, ready to place (a file's is `MediaFileUploadResponse`). */
export interface MediaUploadResponse {
	image: LibraryImage;
	/** False: the same bytes were already in the library (under any name), so nothing was written and this is that image. */
	created: boolean;
}

// ── M6c G4: files in the library (the spec's Contracts) ──

/** Where a link to a file is: the document, and how many of its links point at the file. */
export interface FileUse extends MediaUse {
	links: number;
}

/**
 * One file in the library (Decision 8): an object under `uploads/` whose key ends in one of
 * `caracms/files`' types. No size in pixels, no thumbnail, alt or focal point. Its address
 * is `fileAddress(key)`.
 */
export interface LibraryFile {
	kind: 'file';
	key: string;
	/** The original file name (metadata `name`), or the key's own. */
	name: string;
	/** The type's label from the table: `PDF`, `Word`, `Excel`, `PowerPoint`, `CSV`, `Zip`. */
	type: string;
	bytes: number | null;
	uploadedAt: string | null;
	by: string | null;
	/** Every document with a link to it (a link field, a button, rich text: found by schema), in listing order. */
	usedIn: FileUse[];
}

/** M6c G4: POST /_caracms/media/upload of a file: its library entry (`created` as an image's). */
export interface MediaFileUploadResponse {
	file: LibraryFile;
	created: boolean;
}

/**
 * POST /_caracms/media/replace (Decision 9): every link to `from` (a file's key) moves to
 * `to` (a file's key, uploaded first through `upload`), `?download` and any fragment kept,
 * in every document the store lists, Site Settings and shared blocks included. **An image's
 * Replace…** (both keys an image's): every use of `from` (any value with it as its `key`, as
 * where-used counts them) takes `to` and the new image's size, its alt text, decorative
 * flag and focal point kept (`resetFocal` drops the focal points); `links` counts the uses. Live mode:
 * lands whole or rolls back, each rewritten document a waiting change. Local mode: written
 * as a local move writes.
 */
export interface ReplaceFileRequest {
	from: string;
	to: string;
	/** An image's Replace… only: drop every use's focal point (a different shot), instead of keeping each one (a small edit). */
	resetFocal?: boolean;
	/** An image's Replace… only, set by the media route from the new image's metadata (never sent by the editor): each use's `w` and `h`. */
	size?: { w: number | null; h: number | null };
}

/**
 * Edit in context, Decision 3: POST /_caracms/slot-default, `{ path }` (a slot block's path in
 * Shared). Every other block of its slot that's the default stops being it, each a normal save;
 * the block's own `"default": true` is the editor's edit of it. Live mode: someone else editing
 * one refuses it all (409 `locked`, naming them). Local mode: written as a Replace… writes.
 */
export interface SlotDefaultRequest {
	path: string;
}

export interface SlotDefaultResponse {
	ok: true;
	path: string;
	/** The blocks that were the default and aren't any more (usually one). */
	undefaulted: { path: string; title: string }[];
}

export interface ReplaceFileResponse {
	ok: true;
	from: string;
	to: string;
	/** The documents whose links were rewritten, with how many links each (empty: nothing linked to it). */
	relinked: FileUse[];
}

/** Why an upload was refused: the sentence the editor shows (Decision 6), and a code. */
export interface MediaRefusal extends ApiError {
	code: 'not-an-image' | 'unknown-type' | 'too-large' | 'too-many-pixels' | 'no-size' | 'empty' | 'macro-enabled' | 'not-a-csv' | 'unnamed-office' | string;
}

/** 503 from a media route that isn't set up: the sentence names what's missing (Decision 5). */
export interface MediaUnset extends ApiError {
	/** `media-unset`: the image routes (the bucket and imgproxy); `mux-unset`: the clip routes. */
	code: 'media-unset' | 'mux-unset';
	/** The variables that aren't set (empty when something else is wrong, such as memory mode on a production server). */
	missing: string[];
}

/** Whether the image routes and the clip routes are set up: null when they are, else the 503's body (its sentence). */
export interface MediaSetup {
	images: MediaUnset | null;
	clips: MediaUnset | null;
}

/** POST /_caracms/media/video-upload: the file's name becomes the clip's title. */
export interface VideoUploadRequest {
	name: string;
}

/** 201: a Mux direct upload for this site's origin. The browser PUTs the file to `url`, then polls `video-upload/<id>`. */
export interface VideoUploadResponse {
	id: string;
	url: string;
}

/** GET /_caracms/media/video-upload/<id> (Mux's upload, as the template's endpoint gives it). */
export interface VideoUploadStatus {
	id: string;
	/** `waiting` (no file yet), `asset_created` (`assetId` set: poll `clips/<assetId>`), `errored`, `cancelled`, `timed_out`. */
	status: string;
	assetId: string | null;
	/** Mux's short reason when errored, else null. */
	error: string | null;
}

/** One clip from the site's Mux environment (the template's `Clip`, plus its size and where it's used). */
export interface LibraryClip {
	/** The Mux asset id. */
	id: string;
	/** Its first public playback ID: what a slot stores as `video`. Null only on an errored clip. */
	playbackId: string | null;
	/** Mux's asset status: `preparing`, `ready` or `errored`. */
	status: string;
	/** **Placeable**: the asset is ready AND its `highest` MP4 is ready (Decision 12). Only then may a slot store it. */
	ready: boolean;
	/** It can never become ready: Mux's `errored`, or a ready asset whose `highest` MP4 is missing, errored or skipped. */
	errored: boolean;
	/** When errored: a sentence a designer can act on (Mux's short reason, or what to do about the MP4). */
	error: string | null;
	/** The clip's title (the uploaded file's name). */
	title: string | null;
	/** Seconds. */
	duration: number | null;
	/** `16:9`. */
	aspectRatio: string | null;
	/** The video track's size, for the slot's `w`/`h`. */
	w: number | null;
	h: number | null;
	/** ISO. */
	createdAt: string | null;
	/** Every document whose slot holds its playback ID, in listing order. */
	usedIn: MediaUse[];
}

/** GET /_caracms/media/clips: the whole library, following Mux's cursor, newest first. Errored clips always show. */
export interface MediaClipsResponse {
	clips: LibraryClip[];
}

// ── M6c (G5): the grid view ──────────────────────────────────────────────────
// Kept in one block (G4 adds to this file beside it): the fields G5 adds to the shared
// interfaces above are declared here, merged into them.

export type { ResolvedView, ViewMode, CardRatio } from '../cards.ts';

export interface EditorAnyCollection {
	/** The List / Grid switch's view (cards.ts); null or absent when the collection gets no switch (Decision 13). */
	view?: import('../cards.ts').ResolvedView | null;
}

export interface ListedDocument {
	/** The document's card picture, signed (editor/server/cards.ts); absent for a text card, or when the media variables aren't set. */
	card?: CardPicture;
}

export interface UiState {
	/** Each collection's List / Grid choice, by collection name (Decision 18). Absent: the config's default. */
	views?: Record<string, import('../cards.ts').ViewMode>;
}

/**
 * A grid card's picture as the listing carries it (Decision 19): already cropped to the
 * collection's ratio by the server, at one width rung (`src`) and its 2× (`src2x`), so
 * the grid draws without opening a document or asking the thumbnail route.
 * `position` is the focal point as `object-position`, for a GIF or an SVG, which pass
 * through uncropped. A clip's is its Mux poster, cropped the same, with its duration.
 */
export type CardPicture =
	| { kind: 'image'; src: string; src2x: string; alt: string; position: string | null }
	| { kind: 'clip'; src: string; src2x: string; alt: string; duration: number | null };
