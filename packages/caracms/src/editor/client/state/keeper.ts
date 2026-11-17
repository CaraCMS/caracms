/**
 * Keeping: getting the editor's copy of each document to the server (M3 Decisions 5
 * and 6; M4 Decisions 4, 9 and 11).
 *
 * - **About a second after the last change** (local mode), the whole document is POSTed to the
 *   write route with the base it was made against: `{ file, base, document }`. Live mode
 *   (Redis diet Decision 10, `holds`): at once while the tab doesn't hold the document's
 *   lock and no write for it is in flight; otherwise 3 s after the last change, at most
 *   15 s after the first change not yet sent
 *   (server/write.ts). One write per document in flight; a change made meanwhile
 *   goes in the next one. In live mode every write carries the tab's id
 *   (`X-Caracms-Tab`) and its place in the tab's order (`X-Caracms-Seq`, rising, from
 *   the clock so a reload keeps rising), and **Kept means the server has it** (Redis's
 *   autosave; an older write that lands late never replaces a newer one).
 * - **The bar's keep state** (`status`): `kept` when the server has every change,
 *   `keeping` while a write is pending or in flight, `offline` ("can't reach the
 *   server") once a write fails on the network or with a 5xx (503 `unavailable`
 *   included), **until a write succeeds**. A 4xx is the server answering, not an
 *   outage: `refused`, with the server's own message in `error`. Live mode adds two:
 *   a 409 `locked` (someone else's lock, or your own in another tab) is `held`, and a
 *   401 is `signedout`. Whatever the state, **the edits stay held**.
 * - **Retrying.** In local mode (M3) there's no timer: the next change, or a reload,
 *   retries. In live mode (`retryDelays`) **a retry timer runs only while offline**,
 *   backing off, with its time in `status.retryAt` for the countdown, and `tryNow()`
 *   for Try now. `unsent` counts the changes the server doesn't have yet.
 * - **Unsent edits are held in the browser's storage**, per document, from the
 *   change until the server has them: `{ file, base, document, fileVersion }`. The
 *   base travels with them, because the blocks' `source` indexes point into it
 *   (serialize.ts; M3 → Watch-outs). They're flushed on `pagehide` too (a keepalive
 *   write; in live mode with `X-Caracms-Release: 1`, and a keepalive release of any
 *   other lock the tab holds with nothing unsent), since closing the tab inside the
 *   second would lose the last change.
 *
 * **The re-send rule (`verdict`): a stored copy is dropped only when the server's text
 * already holds those edits** (never lose work silently: Spec → Non-functional, M2
 * Decision 11). Stored edits remember the version of the file they were made against
 * (a hash of its text, server/write.ts → fileVersion).
 *   1. The file is still at that version: nothing has written it since. Re-sent.
 *   2. It has moved on: the keeper runs the serializer here in the browser,
 *      `applyEdits(base, document)` exactly as the write route does, and compares
 *      with the server's text (the file in local mode; the autosave or `drafts` in
 *      live mode). **Equal, the copy is dropped** (the keepalive write never updates
 *      the stored version and may have been refused, and an earlier write can land
 *      after a later one, so a moved version alone proves nothing).
 *   3. Otherwise, in local mode, re-sent (M3: the last write wins). In live mode **the
 *      server decides (M4 Decision 11)** with `lastChange`: no editor known (`by:
 *      null`: only merges), you, or an editor change that left exactly the version
 *      these edits were made against: re-sent (the server merges, Decision 6).
 *      **Another editor changed it since, or the server can't tell who did (`known:
 *      false`): not re-sent**, held as a `conflict` until Use mine (`useMine`) or
 *      Discard mine (`discard`).
 *   Discard changes: when the server says someone put the document back to what's live
 *   (`lastChange.discarded`), edits stored from before then (`at`, when they were last changed)
 *   are dropped, not re-sent, so a discard doesn't come undone from a browser that missed it.
 *   A write the server refuses as `discarded` (this tab had the document when it was put back)
 *   is dropped the same way, and `onDiscarded` tells the editor to read it again.
 * Versions are compared for equality, never as times; only the discard rule compares a time.
 */
import { documentKind, normaliseAnyDocument, type AnyDocument } from '../../../document.ts';
import { applyDocumentEdits } from '../../../serialize.ts';
import type { Fields } from '../../../fields.ts';
import { ENDPOINTS, RELEASE_HEADER, SEQ_HEADER, TAB_HEADER, type EditorSite, type LastChange, type LockRefusal, type Person, type SignedOutError } from '../../types.ts';
import { createStore, type Store } from './store.ts';

/**
 * `refused`: the server answered a write with a 4xx (its message is the status's
 * `error`). `held` (live): a 409, or edits another editor's change overtook (Decision
 * 11). `signedout` (live): a 401.
 */
export type KeepState = 'kept' | 'keeping' | 'offline' | 'refused' | 'held' | 'signedout';

/** A document's edits that are held, not sent, until the person decides (Decision 11). */
export interface HeldView {
	id: string;
	file: string;
	/** `locked`: a write got 409 (the lock's another tab's). `conflict`: someone else changed it since. */
	reason: 'locked' | 'conflict';
	/** Who changed it, or holds it. */
	by: Person | null;
	/** It's your own lock in another tab (Use mine is offered at once). */
	elsewhere: boolean;
}

export interface KeepStatus {
	state: KeepState;
	/**
	 * Offline: the last failed write's error, for the console and a tooltip. Refused:
	 * the server's own message, which the bar shows. Null otherwise.
	 */
	error: string | null;
	/** Changes the server doesn't have yet (the offline note's "your last 3 changes"). */
	unsent?: number;
	/** Live mode, offline: when the retry timer fires next (ms since the epoch). Null otherwise. */
	retryAt?: number | null;
	/** Documents whose edits are held until the person decides. */
	held?: readonly HeldView[];
}

/** A file as the server has it now: its version and its text, and in live mode who last changed it. */
export interface FileNow {
	version: string;
	text: string;
	lastChange?: LastChange;
}

/** What's held in the browser's storage for a document until the file has it. */
export interface StoredUnsent {
	v: 1;
	file: string;
	base: string;
	document: AnyDocument;
	/** The version of the file these edits were made against (see above). */
	fileVersion: string;
	/** ms since the epoch: the newest change in them (the discard rule). Absent in copies stored before it was added. */
	at?: number;
}

/** The parts of Storage the keeper uses (localStorage, or a fake in tests). */
export type KeeperStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export interface KeeperOptions {
	fetch: typeof fetch;
	/** The block schemas, for running the serializer on load (the re-send rule above). */
	site: KeeperSite;
	/** null: no storage available (a private window that refuses it). */
	storage: KeeperStorage | null;
	/** Storage keys are `caracms:unsent:<storageKey>:<docId>`, so two sites on one dev port don't mix. */
	storageKey: string;
	/** ms after the last change. Default 1000 (local mode; live mode's timing is `holds`'s, below). */
	delay?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	/** Errors go here too (default console.warn). */
	log?: (message: string) => void;
	/**
	 * Told whether any unsent edits are held, whenever that changes: the editor puts it
	 * in a cookie, so after a reload the server renders the bar as Keeping from the
	 * first paint instead of a Kept that isn't true yet (Decision 20's reason).
	 */
	onHeld?: (held: boolean) => void;
	/** The state the bar starts in (the server rendered it from that cookie). Default 'kept'. */
	initial?: KeepState;

	// ── Live mode (M4) ───────────────────────────────────────────────────────────
	/** The tab's id, sent as `X-Caracms-Tab` on every write. Absent: local mode. */
	tab?: string | null;
	/** The retry timer's delays while offline, in ms (the last repeats). Absent: no timer (M3). */
	retryDelays?: readonly number[];
	now?: () => number;
	/** Files this tab holds the lock on (from the last poll): pagehide releases them. */
	lockedFiles?: () => readonly string[];
	/** A write got 409 `locked`: the editor shows the lock at once. */
	onLocked?: (file: string, refusal: LockRefusal) => void;
	/** A write got 401: the editor shows it's signed out. */
	onSignedOut?: (body: SignedOutError) => void;
	/** Who is signed in, for the re-send rule ("your own commits"). */
	you?: () => Person | null;
	/**
	 * Redis diet Decision 10: whether this tab holds the document's lock (a write for it
	 * was Kept, or a poll says so). Given, live mode's timing applies: a change goes at
	 * once while the document isn't held and no write for it is in flight (that write
	 * takes the lock); otherwise `keepDelay` after the last change, and never later than
	 * `keepCap` after the first change not yet sent. Absent: `delay` after the last change.
	 */
	holds?: (file: string) => boolean;
	/** Decision 10: ms after the last change, once held. Default 3000. */
	keepDelay?: number;
	/** Decision 10: …and at most this long after the first change not yet sent. Default 15000. */
	keepCap?: number;
	/** A write for this file was Kept (the server has it, and the write took or kept the lock). */
	onKept?: (file: string) => void;
	/** A write got 409 `discarded`: someone put the document back to what's live; this tab's edits in it are dropped. */
	onDiscarded?: (file: string, body: { error?: string; by?: Person; at?: string }) => void;
}

/** A held record the editor may need to look at again: once the lock lapses, or the session is back. */
export interface Blocked {
	id: string;
	file: string;
	failure: 'locked' | 'conflict' | 'signedout';
}

export interface Keeper {
	readonly status: Store<KeepStatus>;
	/** A document was opened: remember its file and the version it's at. */
	opened(id: string, file: string, fileVersion: string): void;
	/** The document changed: store it, and write it a second from now. */
	change(id: string, edit: { file: string; base: string; document: AnyDocument }): void;
	/** Write now whatever is waiting (one document, or all). */
	flush(id?: string): Promise<void>;
	/** Stored unsent edits for a document, if any. */
	stored(id: string): StoredUnsent | null;
	/**
	 * The re-send rule for a document being opened, with its file as it is now: its
	 * stored edits unless the file already holds them, else null (and that copy is
	 * dropped).
	 */
	recoverable(id: string, file: FileNow): StoredUnsent | null;
	/** The same, saying whether they're to be sent (`send`) or held for the person (`by` changed it since). */
	recover(id: string, file: FileNow): { stored: StoredUnsent; send: boolean; by: Person | null } | null;
	/** Adopt stored edits and send them now (the bar shows Keeping until they land). */
	resend(id: string, stored: StoredUnsent): void;
	/** Adopt stored edits and hold them, unsent (another editor changed the document since). */
	hold(id: string, stored: StoredUnsent, by: Person | null): void;
	/**
	 * On load: every other document with stored edits, by the same rule. `fileOf` reads
	 * its file as it is now (null: it's gone, so its edits are kept but not sent; a
	 * rejection: the server couldn't be asked, so they wait for the next load).
	 */
	recoverOthers(exceptId: string, fileOf: (id: string) => Promise<FileNow | null>): Promise<void>;
	/** pagehide: send whatever is waiting with keepalive requests. */
	pagehide(): void;
	/** Recovery on load is done: show the real state (Kept when nothing was waiting after all). */
	settle(): void;

	// ── Live mode (M4) ───────────────────────────────────────────────────────────
	/** Try now: retry every write that couldn't reach the server, at once. */
	tryNow(): void;
	/** Use mine: send a document's held edits (the server merges them, Decision 6). */
	useMine(id: string): void;
	/** Discard mine: drop a document's held edits, from the tab and the browser's storage. */
	discard(id: string): void;
	/** Held records (locked, conflict, signed out) to look at again. */
	blocked(): Blocked[];
	/** Apply the re-send rule to a held record against the file as it is now (the lock lapsed; signed in again). */
	recheck(id: string, file: FileNow): 'send' | 'drop' | 'conflict' | null;
	/** Whether a document has changes the server doesn't have. */
	dirty(id: string): boolean;
}

type Failure = 'offline' | 'refused' | 'locked' | 'conflict' | 'signedout';

interface Record {
	id: string;
	file: string;
	base: string;
	document: AnyDocument | null;
	fileVersion: string;
	/** Bumped by every change. */
	revision: number;
	/** The revision the file is known to have. */
	written: number;
	inFlight: boolean;
	/** How the last write failed, until one succeeds. */
	failure: Failure | null;
	/** The server's message when it refused the last write. */
	refusal: string | null;
	/** Held: who changed it or holds it, and whether it's your own other tab. */
	by: Person | null;
	elsewhere: boolean;
	timer: unknown;
	/** Live timing: when the last change came, and the first change not yet sent (null: none). */
	lastChange: number;
	firstUnsent: number | null;
}

const PREFIX = 'caracms:unsent:';

/** Failures the next change or the retry timer don't retry: the person (or the session) decides. */
const WAITS: ReadonlySet<Failure> = new Set(['locked', 'conflict', 'signedout']);

/** A write the server answered with a 4xx: it was reached, and said no. */
class Refused extends Error {
	readonly status: number;
	readonly body: Record_<string, unknown>;
	constructor(message: string, status: number, body: Record_<string, unknown>) {
		super(message);
		this.status = status;
		this.body = body;
	}
}
type Record_<K extends string, V> = { [key in K]: V };

/**
 * What the keeper needs of the site: the block schemas, and (M5a) the collections, so a
 * fields document's or Site Settings' edits are run through their own writer.
 */
export type KeeperSite = Pick<EditorSite, 'blocks'> & {
	/** The editor's list, or a resolved site's record (tests). */
	collections?: readonly KeeperCollection[] | { readonly [name: string]: KeeperCollection };
};
type KeeperCollection = { kind: 'sections' | 'fields' | 'shared' | 'settings'; fields: Fields | null };

/**
 * The collection a held document is written to, by its kind: a shared block's writer
 * needs only the block schemas; a fields document's, Site Settings' and (M6c G2) a
 * section builder's with page fields need their fields (the first collection of that
 * kind whose fields match the document's `data` keys, else the first of that kind). A
 * section builder's document without `data` has no page fields to write.
 */
function collectionFor(document: AnyDocument, site: KeeperSite): { kind: 'sections' | 'fields' | 'shared' | 'settings'; fields: Fields | null } {
	const kind = documentKind(document);
	const data = (document as { data?: { [key: string]: unknown } }).data;
	if (kind === 'shared' || (kind === 'sections' && data === undefined)) return { kind, fields: null };
	const candidates = Object.values(site.collections ?? {}).filter((c: KeeperCollection) => c.kind === kind && (kind !== 'sections' || c.fields));
	const own = (keys: string[]) => keys.filter((k) => kind !== 'settings' || (k !== 'editors' && k !== 'brand')).sort().join('\n');
	const keys = own(Object.keys(data ?? {}));
	const match = candidates.find((c) => own(Object.keys(c.fields ?? {})) === keys) ?? candidates[0];
	return { kind, fields: match?.fields ?? (kind === 'sections' ? null : {}) };
}

const sameEmail = (a: Person | null | undefined, b: Person | null | undefined) => !!a && !!b && a.email.toLowerCase() === b.email.toLowerCase();

/** Whether the server's text is already what writing these edits would make it. */
export function holdsEdits(text: string, stored: Pick<StoredUnsent, 'base' | 'document'>, site: KeeperSite): boolean {
	try {
		const collection = collectionFor(stored.document, site);
		return applyDocumentEdits(stored.base, normaliseAnyDocument(stored.document, site, collection), site, collection) === text;
	} catch {
		return false; // the edits don't fit their base: re-sent, and the server's refusal shows
	}
}

/**
 * The re-send rule (see the header): `send`, `drop` (the server's text holds them), or
 * `{ conflict: by }` (another editor changed the document since, Decision 11).
 */
export function verdict(
	stored: Pick<StoredUnsent, 'base' | 'document' | 'fileVersion' | 'at'>,
	file: FileNow,
	site: KeeperSite,
	you: Person | null,
): 'send' | 'drop' | { conflict: Person | null } {
	if (stored.fileVersion === file.version) return 'send'; // nothing has written it since
	if (holdsEdits(file.text, stored, site)) return 'drop';
	const last = file.lastChange;
	// Discard changes: edits from before someone put it back to what's live are what was discarded.
	const discarded = last?.discarded;
	if (discarded && !(typeof stored.at === 'number' && stored.at > Date.parse(discarded.at))) return 'drop';
	if (!last) return 'send'; // local mode (M3): the last write wins
	if (last.known === false) return { conflict: null }; // the server can't tell who changed it: never re-sent over unknown work
	if (!last.by) return 'send'; // only merges from main are known
	if (sameEmail(last.by, you)) return 'send'; // your own autosave or commit
	if (last.version !== null && last.version === stored.fileVersion) return 'send'; // that change is what these edits were made on
	return { conflict: last.by };
}

export function createKeeper(options: KeeperOptions): Keeper {
	const delay = options.delay ?? 1000;
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
	const log = options.log ?? ((message) => console.warn(`[caracms] ${message}`));
	const now = options.now ?? Date.now;
	const live = options.holds ? { holds: options.holds, delay: options.keepDelay ?? 3000, cap: options.keepCap ?? 15_000 } : null;
	const prefix = `${PREFIX}${options.storageKey}:`;
	const records = new Map<string, Record>();
	let offline = false;
	let offlineError: string | null = null;
	const status = createStore<KeepStatus>({ state: options.initial ?? 'kept', error: null, unsent: 0, retryAt: null, held: [] });
	let held: boolean | null = null;
	// The retry timer (live mode only, and only while offline).
	let retryTimer: unknown = null;
	let retryAt: number | null = null;
	let retryStep = 0;

	const storage = {
		/** Tell onHeld when whether anything is held changes. */
		check() {
			const now = storage.ids().length > 0;
			if (now !== held) {
				held = now;
				options.onHeld?.(now);
			}
		},
		get(id: string): StoredUnsent | null {
			try {
				const raw = options.storage?.getItem(prefix + id);
				if (!raw) return null;
				const value = JSON.parse(raw) as StoredUnsent;
				return value && value.v === 1 && typeof value.base === 'string' && typeof value.fileVersion === 'string' && value.document ? value : null;
			} catch {
				return null;
			}
		},
		set(id: string, value: StoredUnsent) {
			try {
				options.storage?.setItem(prefix + id, JSON.stringify(value));
			} catch (error) {
				log(`couldn't hold unsent edits in this browser's storage (${String(error)})`);
			}
			storage.check();
		},
		remove(id: string) {
			try {
				options.storage?.removeItem(prefix + id);
			} catch {
				/* nothing to do */
			}
			storage.check();
		},
		ids(): string[] {
			const out: string[] = [];
			try {
				const s = options.storage;
				if (!s) return out;
				for (let i = 0; i < s.length; i++) {
					const key = s.key(i);
					if (key?.startsWith(prefix)) out.push(key.slice(prefix.length));
				}
			} catch {
				/* none */
			}
			return out;
		},
	};

	const dirty = (r: Record) => r.revision !== r.written;
	let heldViews: readonly HeldView[] = [];
	const refresh = () => {
		const all = [...records.values()];
		const busy = all.some((r) => dirty(r) || r.inFlight);
		const refused = all.find((r) => r.failure === 'refused' && dirty(r));
		const signedOut = all.some((r) => r.failure === 'signedout' && dirty(r));
		const nextHeld = all
			.filter((r) => dirty(r) && (r.failure === 'locked' || r.failure === 'conflict'))
			.map((r): HeldView => ({ id: r.id, file: r.file, reason: r.failure as 'locked' | 'conflict', by: r.by, elsewhere: r.elsewhere }));
		if (JSON.stringify(nextHeld) !== JSON.stringify(heldViews)) heldViews = nextHeld;
		// Live mode's extras (the count shows only while offline or signed out); local mode's status is M3's.
		const unsent = offline || signedOut ? all.reduce((n, r) => n + (dirty(r) ? r.revision - r.written : 0), 0) : 0;
		const common = options.tab ? { unsent, retryAt, held: heldViews } : {};
		if (offline) status.update({ state: 'offline', error: offlineError, ...common });
		else if (signedOut) status.update({ state: 'signedout', error: null, ...common });
		else if (refused) status.update({ state: 'refused', error: refused.refusal, ...common });
		else if (heldViews.length) status.update({ state: 'held', error: null, ...common });
		else status.update({ state: busy ? 'keeping' : 'kept', error: null, ...common });
	};
	const record = (id: string, file: string, fileVersion: string): Record => {
		let r = records.get(id);
		if (!r) {
			r = { id, file, base: '', document: null, fileVersion, revision: 0, written: 0, inFlight: false, failure: null, refusal: null, by: null, elsewhere: false, timer: null, lastChange: 0, firstUnsent: null };
			records.set(id, r);
		}
		return r;
	};
	const stash = (r: Record) => {
		if (r.document) storage.set(r.id, { v: 1, file: r.file, base: r.base, document: r.document, fileVersion: r.fileVersion, ...(r.lastChange ? { at: r.lastChange } : {}) });
	};
	/** Decision 10 (live): ms until the change waiting goes, once the document is held: the delay after the last change, capped from the first unsent one. */
	const due = (r: Record) => {
		if (!live) return delay;
		const at = Math.min(r.lastChange + live.delay, (r.firstUnsent ?? r.lastChange) + live.cap);
		return Math.max(0, at - now());
	};
	const schedule = (r: Record, ms = delay) => {
		if (r.timer !== null) clearTimer(r.timer);
		r.timer = setTimer(() => {
			r.timer = null;
			void send(r);
		}, ms);
	};
	/** Live mode: each write's place in this tab's order (from the clock, so a reload keeps rising). */
	let writeSeq = 0;
	const headers = (release = false, write = false): Record_<string, string> => {
		const h: Record_<string, string> = { 'Content-Type': 'application/json' };
		if (options.tab) h[TAB_HEADER] = options.tab;
		if (options.tab && release) h[RELEASE_HEADER] = '1';
		if (options.tab && write) h[SEQ_HEADER] = String((writeSeq = Math.max(writeSeq + 1, Math.floor(Date.now()))));
		return h;
	};

	const stopRetry = () => {
		if (retryTimer !== null) clearTimer(retryTimer);
		retryTimer = null;
		retryAt = null;
		retryStep = 0;
	};
	const retryAll = () => {
		for (const r of records.values()) if (r.failure === 'offline' && dirty(r)) void send(r);
	};
	/** Live mode: while offline, try again later, backing off. */
	const scheduleRetry = () => {
		const delays = options.retryDelays;
		if (!delays?.length || retryTimer !== null) return;
		const ms = delays[Math.min(retryStep, delays.length - 1)]!;
		retryStep += 1;
		retryAt = now() + ms;
		retryTimer = setTimer(() => {
			retryTimer = null;
			retryAt = null;
			retryAll();
			refresh();
		}, ms);
	};

	async function send(r: Record): Promise<void> {
		if (!dirty(r) || !r.document) return;
		if (r.inFlight) return; // the change waits; it's sent when this write returns
		const revision = r.revision;
		// Every change so far goes in this write; the cap counts again from the next one.
		const firstUnsent = r.firstUnsent;
		r.firstUnsent = null;
		r.inFlight = true;
		refresh();
		let ok = false;
		try {
			const response = await options.fetch(ENDPOINTS.write, {
				method: 'POST',
				headers: headers(false, true),
				body: JSON.stringify({ file: r.file, base: r.base, document: r.document }),
			});
			const body = (await response.json().catch(() => ({}))) as { error?: string; version?: string };
			if (response.status >= 400 && response.status < 500) {
				throw new Refused(typeof body.error === 'string' && body.error ? body.error : `The server refused the write (${response.status}).`, response.status, body);
			}
			if (!response.ok) throw new Error(body.error ?? `the write route answered ${response.status}`);
			ok = true;
			offline = false;
			offlineError = null;
			r.failure = null;
			r.refusal = null;
			r.by = null;
			r.elsewhere = false;
			if (typeof body.version === 'string') r.fileVersion = body.version;
			r.written = Math.max(r.written, revision);
			options.onKept?.(r.file);
			if (dirty(r)) stash(r); // newer edits wait: they're now against the version just written
			else storage.remove(r.id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof Refused) {
				// The server answered, so it isn't unreachable; the edits stay held.
				offline = false;
				offlineError = null;
				const code = (error.body as { code?: unknown }).code;
				if (options.tab && error.status === 401) {
					r.failure = 'signedout';
					r.refusal = null;
					log(`signed out: ${r.file} is held in this tab`);
					options.onSignedOut?.(error.body as unknown as SignedOutError);
				} else if (options.tab && error.status === 409 && code === 'locked') {
					const refusal = error.body as unknown as LockRefusal;
					r.failure = 'locked';
					r.refusal = message;
					r.elsewhere = refusal.state === 'yours-elsewhere';
					r.by = refusal.lastChange?.by ?? refusal.lock?.person ?? null;
					log(`${r.file} is locked: ${message}`);
					options.onLocked?.(r.file, refusal);
				} else if (options.tab && error.status === 409 && code === 'discarded') {
					// Someone put the document back to what's live while this tab had it: these edits were discarded.
					r.written = r.revision;
					r.document = null;
					r.failure = null;
					r.refusal = null;
					r.by = null;
					storage.remove(r.id);
					log(`${r.file}: ${message}`);
					options.onDiscarded?.(r.file, error.body as { error?: string; by?: Person; at?: string });
				} else {
					r.failure = 'refused';
					r.refusal = message;
					log(`the server refused to keep ${r.file}: ${message}`);
				}
			} else {
				offline = true;
				offlineError = message;
				r.failure = 'offline';
				log(`couldn't keep ${r.file}: ${message}`);
			}
		} finally {
			r.inFlight = false;
			// Not sent after all: the cap still counts from the earliest change waiting.
			if (!ok && firstUnsent !== null) r.firstUnsent = Math.min(firstUnsent, r.firstUnsent ?? firstUnsent);
			if (ok && !offline) {
				stopRetry();
				// Live mode: the server is back, so whatever else couldn't reach it goes now.
				if (options.retryDelays) for (const other of records.values()) if (other !== r && other.failure === 'offline' && dirty(other)) schedule(other, 0);
			}
			if (offline) scheduleRetry();
			refresh();
		}
		// A change that came in during the write goes out now, unless its own timer is still running.
		// Live mode (Decision 10): it waits by the same rule as any change to a held document.
		if (ok && dirty(r) && r.timer === null && !r.failure) {
			const ms = live ? due(r) : 0;
			if (ms > 0) schedule(r, ms);
			else void send(r);
		}
	}

	function adopt(id: string, stored: StoredUnsent): Record {
		const r = record(id, stored.file, stored.fileVersion);
		r.file = stored.file;
		r.base = stored.base;
		r.document = stored.document;
		r.fileVersion = stored.fileVersion;
		r.revision += 1;
		// The discard rule reads when they were made, not when they were adopted.
		if (typeof stored.at === 'number') r.lastChange = stored.at;
		return r;
	}

	function resend(id: string, stored: StoredUnsent) {
		const r = adopt(id, stored);
		r.failure = null;
		refresh();
		schedule(r, 0);
	}

	function recover(id: string, file: FileNow) {
		const stored = storage.get(id);
		if (!stored) return null;
		const v = verdict(stored, file, options.site, options.you?.() ?? null);
		if (v === 'drop') {
			storage.remove(id); // the server's text already holds them
			return null;
		}
		return v === 'send' ? { stored, send: true, by: null } : { stored, send: false, by: v.conflict };
	}

	return {
		status,
		opened(id, file, fileVersion) {
			const r = record(id, file, fileVersion);
			if (!dirty(r) && !r.inFlight) {
				r.file = file;
				r.fileVersion = fileVersion;
				r.document = null;
			}
		},
		change(id, edit) {
			const r = record(id, edit.file, '');
			r.file = edit.file;
			r.base = edit.base;
			r.document = edit.document;
			r.revision += 1;
			const t = now();
			r.lastChange = t;
			if (r.firstUnsent === null) r.firstUnsent = t;
			stash(r);
			if (!r.failure || !WAITS.has(r.failure)) {
				// Decision 10: the first write to a document goes at once, since it's what takes the lock.
				if (live && !r.inFlight && !live.holds(r.file)) schedule(r, 0);
				else schedule(r, due(r));
			}
			// After a failed write (unreachable or refused), the next change retries everything waiting.
			for (const other of records.values()) if (other !== r && other.failure && !WAITS.has(other.failure) && dirty(other)) schedule(other, 0);
			refresh();
		},
		async flush(id) {
			const targets = id ? [records.get(id)].filter((r): r is Record => !!r) : [...records.values()];
			await Promise.all(
				targets.map((r) => {
					if (r.failure && WAITS.has(r.failure)) return undefined;
					if (r.timer !== null) {
						clearTimer(r.timer);
						r.timer = null;
					}
					return send(r);
				}),
			);
		},
		stored: (id) => storage.get(id),
		recoverable: (id, file) => recover(id, file)?.stored ?? null,
		recover,
		resend,
		hold(id, stored, by) {
			const r = adopt(id, stored);
			r.failure = 'conflict';
			r.by = by;
			r.elsewhere = false;
			refresh();
		},
		async recoverOthers(exceptId, fileOf) {
			for (const id of storage.ids()) {
				if (id === exceptId || records.has(id)) continue;
				const stored = storage.get(id);
				if (!stored) continue;
				const file = await fileOf(id).catch(() => undefined);
				if (file === undefined) continue; // couldn't ask (the server is away): leave them for the next load
				if (file === null) {
					log(`unsent edits for ${stored.file} are kept in this browser, but the document is gone, so they weren't sent`);
					continue;
				}
				const v = verdict(stored, file, options.site, options.you?.() ?? null);
				if (v === 'send') resend(id, stored);
				else if (v === 'drop') storage.remove(id); // the file already holds them
				// A conflict stays in storage, unsent: opening that document shows it (Decision 11).
			}
		},
		settle() {
			storage.check();
			refresh();
		},
		pagehide() {
			const written = new Set<string>();
			for (const r of records.values()) {
				if (!dirty(r) || !r.document) continue;
				stash(r);
				if (r.failure && WAITS.has(r.failure)) continue; // it would be refused; it's re-sent from storage later
				written.add(r.file);
				try {
					void options
						.fetch(ENDPOINTS.write, {
							method: 'POST',
							keepalive: true,
							// Live mode: the last write releases the lock once its autosave is committed (Decision 9).
							headers: headers(true, true),
							body: JSON.stringify({ file: r.file, base: r.base, document: r.document }),
						})
						.catch(() => {});
				} catch {
					/* the stored copy is re-sent on the next load */
				}
			}
			// Live mode: a lock with nothing unsent is released on its own.
			if (!options.tab) return;
			for (const file of options.lockedFiles?.() ?? []) {
				if (written.has(file)) continue;
				try {
					void options
						.fetch(ENDPOINTS.lock, { method: 'POST', keepalive: true, headers: headers(), body: JSON.stringify({ file, action: 'release' }) })
						.catch(() => {});
				} catch {
					/* it lapses on its own */
				}
			}
		},
		tryNow() {
			stopRetry();
			retryAll();
			refresh();
		},
		useMine(id) {
			const r = records.get(id);
			if (!r || !dirty(r)) return;
			r.failure = null;
			r.by = null;
			r.elsewhere = false;
			refresh();
			schedule(r, 0);
		},
		discard(id) {
			const r = records.get(id);
			if (r) {
				if (r.timer !== null) clearTimer(r.timer);
				r.timer = null;
				r.written = r.revision;
				r.document = null;
				r.failure = null;
				r.by = null;
				r.elsewhere = false;
			}
			storage.remove(id);
			refresh();
		},
		blocked() {
			return [...records.values()]
				.filter((r) => dirty(r) && r.failure && WAITS.has(r.failure))
				.map((r) => ({ id: r.id, file: r.file, failure: r.failure as Blocked['failure'] }));
		},
		recheck(id, file) {
			const r = records.get(id);
			if (!r || !dirty(r) || !r.document) return null;
			const v = verdict({ base: r.base, document: r.document, fileVersion: r.fileVersion, at: r.lastChange || undefined }, file, options.site, options.you?.() ?? null);
			if (v === 'drop') {
				r.written = r.revision;
				r.failure = null;
				r.by = null;
				storage.remove(id);
				refresh();
				return 'drop';
			}
			if (v === 'send') {
				r.failure = null;
				r.by = null;
				r.elsewhere = false;
				refresh();
				schedule(r, 0);
				return 'send';
			}
			r.failure = 'conflict';
			r.by = v.conflict;
			r.elsewhere = false;
			refresh();
			return 'conflict';
		},
		dirty: (id) => {
			const r = records.get(id);
			return !!r && (dirty(r) || r.inFlight);
		},
	};
}
