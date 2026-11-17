/**
 * Live mode's editor server (M4 Phase 2): the live drafts store, the sweep, locks and
 * presence, and the handlers behind `/_caracms/status`, `lock`, `publish`, `history`,
 * `try-again`, `notice` and `discard` (the routes in ../editor/routes/ are one line each).
 *
 * **Discard changes** (`discard`): one waiting document back to what's live. Its autosave,
 * committed record and move records go and its files on `drafts` are committed as `main` has
 * them (git.ts → `restoreDrafts`), all under the sweep's locks (sweep.ts → `exclusively`), so
 * no tick commits the edit meanwhile. A moved document first moves back through the move
 * engine (its links and redirects too), unredirected. Every other tab that had it open or
 * was editing it is listed in its discard record (autosaves.ts): their writes are refused
 * until they let go (`{ file, seen: true }`), and each other person who edited it or had it
 * open gets a "discarded" notice. Refused while someone else is editing it now (a fresh
 * lock), while a Publish runs, and for nothing waiting.
 *
 * One per process, beside the runtime (`liveEditor`), or made by tests
 * (`createLiveEditor`) on a runtime from `createLiveRuntime` with the in-memory
 * backend, the Redis stand-in and a fake clock.
 *
 * Every handler takes the request and the signed-in person (Phase 3's guard puts it
 * in `locals`; locals.ts). **No person is a 401 `{ error: 'signed-out' }`**: defence in
 * depth, the guard is the real check. A request that isn't GET also has to come from
 * this site (write.ts → checkOrigin). Redis out past its budget is a 503 `unavailable`.
 *
 * **A poll asks GitHub for nothing** beyond `git.check()` (once a minute) and the
 * deployment reads while a publish is in flight (git.ts, every 10 s at most).
 *
 * **A poll asks Redis for little** (Redis diet): its reads come from the status cache
 * (status-cache.ts, `git.statusCache`), refreshed from Redis once 30 s old; it writes
 * only its presence, and a heartbeat when the lock needs one. The other handlers read
 * Redis directly (Decision 3).
 *
 * State lives in Redis and git (two servers run during a deploy); what's held here
 * is the sweep's "am I ticking" and git.ts's caches.
 */
import { layoutStampIn } from '../editor/server/arrange.ts';
import { collectionOrderIn } from '../editor/server/collection-order.ts';
import { pageOrderStamp } from '../page-order.ts';
import { SITE_SETTINGS_FILE, type ResolvedSite } from '../config.ts';
import { filesSource, heldBasesOf } from '../content.ts';
import { brandFrom, editorBrand } from '../editor/brand.ts';
import type { DraftsStore } from '../editor/server/drafts-store.ts';
import { handleCreate, handleDelete } from '../editor/server/create.ts';
import { checkOrigin, confinePath, fileVersion, handleWrite, tabOf, WriteRefused } from '../editor/server/write.ts';
import { missingAltIn } from '../editor/server/media/alt.ts';
import { settingsWithRedirectsBack } from '../editor/server/move.ts';
import { parseAnyDocument } from '../document.ts';
import type {
	ApiError,
	DiscardResponse,
	HistoryResponse,
	LockRefusal,
	LockResponse,
	MissingAltView,
	NoticeView,
	PublishResponse,
	PublishView,
	StatusResponse,
	TryAgainResponse,
	WaitingView,
} from '../editor/types.ts';
import { Autosaves, splitMoves } from './autosaves.ts';
import { lastChangeOf, liveDraftsStore, unavailable } from './drafts-store.ts';
import { LiveGit, movesIn, NO_REDEPLOYER_REASON, titleOf, type DraftsLost } from './git.ts';
import { accessProblemMessage, type GitHubAccessProblem } from './github.ts';
import { parseRedirects, type Redirect } from '../redirects.ts';
import { Locks } from './locks.ts';
import { displayName, type Person } from './messages.ts';
import type { LiveSettings } from './mode.ts';
import { Notices, type StoodNotice } from './notices.ts';
import { RedisUnavailableError } from './redis.ts';
import { liveRuntime, type LiveRuntime } from './runtime.ts';
import { Sweep, SweepBusyError, type Schedule } from './sweep.ts';
import { readCappedText } from '../body.ts';
import { textProblems } from '../document-problems.ts';

type Handler = (request: Request, person: Person | null) => Promise<Response>;


/** The heading of the editor's GitHub access note (runs-anywhere Decision 5); the sentence says what to fix. */
const ACCESS_TITLE: Record<GitHubAccessProblem['kind'], string> = {
	refused: 'GitHub refused this site',
	permission: 'GitHub refused a change',
	expiring: "This site's GitHub token expires soon",
	cloud: 'No GitHub access through CaraCMS Cloud',
	// caracms-cloud adversarial review, finding 7: information, not a problem.
	renamed: "This site's repo has a new name",
};

/** Arrange pages (Decision 18) and review gaps (Decision 2): the saved orders' stamp (page folders' included, Decision 12), the hand orders' after the pages' when there are any; `""` for none. */
function ordersStamp(text: string | null): string {
	const hand = pageOrderStamp(collectionOrderIn(text));
	return layoutStampIn(text) + (hand ? `:${hand}` : '');
}

/** Finding 4: the save bar's sentence while draft commits keep failing. */
export const COMMIT_TROUBLE_MESSAGE = "Saved here, but not reaching GitHub. Ask your developer to check the site's GitHub access.";

/** Finding 5: the note's sentence once `drafts` had to be made again from `main`. */
export function draftsLostMessage(lost: DraftsLost): string {
	const lastCommit = lost.commit ? `its last commit (${lost.commit.slice(0, 7)}) couldn't be found` : 'no record of its last commit was kept';
	return `The drafts branch went missing on GitHub and ${lastCommit}, so it was made again from the live site. Changes saved since the last Publish are gone from the editor. Ask your developer to protect the drafts branch from deletion.`;
}

/** Force-push note (caracms-cloud adversarial review): `main` was rolled back past the last Publish. */
export const MAIN_ROLLED_BACK_TITLE = 'The live site was rolled back on GitHub';
export const MAIN_ROLLED_BACK_MESSAGE =
	"The changes waiting here include what was rolled back, and publishing will put it back. Discard what you don't want first: each waiting document has Discard… in the Publish list.";

/**
 * A Redis outage before a Publish's refs move (finding 6): nothing went out, and nothing is
 * held in the browser either (that's the write route's sentence, `unavailable`).
 */
export function publishUnavailable(error: unknown): WriteRefused {
	const what = error instanceof Error ? error.message : String(error);
	return new WriteRefused(503, `The server can't reach its store right now, so it couldn't publish. Your changes are still waiting: try again in a minute (${what}).`, { code: 'unavailable' });
}

export interface LiveEditor {
	readonly runtime: Pick<LiveRuntime, 'site' | 'settings' | 'git' | 'redis' | 'timings' | 'now'>;
	readonly autosaves: Autosaves;
	readonly locks: Locks;
	readonly sweep: Sweep;
	readonly store: DraftsStore;
	write: Handler;
	/** M5a Phase 3: POST /_caracms/create and /_caracms/delete over the live store (the routes call the store the same way). */
	create: Handler;
	delete: Handler;
	status: Handler;
	lock: Handler;
	publish: Handler;
	history: Handler;
	tryAgain: Handler;
	notice: Handler;
	/** Discard changes: POST /_caracms/discard `{ file }` (types.ts → DiscardRequest). */
	discard: Handler;
}

export interface LiveEditorOptions {
	/** The sweep's timer (tests drive it by hand). */
	schedule?: Schedule;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	prefix?: string;
}

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const sameEmail = (a: Person, b: Person) => a.email.toLowerCase() === b.email.toLowerCase();

/** A notice id: `kept:<file>:<commit>`, `stood:<commit>:<file>:<email>` or `discarded:<at>:<file>:<email>`, no spaces or controls, capped. */
const NOTICE_ID = /^(kept|stood|discarded):[^\s\p{C}]+$/u;
const NOTICE_ID_MAX = 512;

/** Map a site file to its document (collection and path), or nulls. */
/** Site Settings' redirects, from its text (none when it's missing or unreadable). */
function redirectsIn(text: string | null): Redirect[] {
	try {
		return parseRedirects((JSON.parse(text ?? '{}') as { redirects?: unknown }).redirects);
	} catch {
		return [];
	}
}

function docOf(site: Pick<ResolvedSite, 'root' | 'collections'>, file: string): { collection: string | null; path: string | null } {
	try {
		const c = confinePath(site as ResolvedSite, file);
		return { collection: c.collection, path: c.path };
	} catch {
		return { collection: null, path: null };
	}
}

export async function createLiveEditor(
	runtime: Pick<LiveRuntime, 'site' | 'settings' | 'git' | 'redis' | 'timings' | 'now'>,
	options: LiveEditorOptions = {},
): Promise<LiveEditor> {
	const { site, settings, git, redis, timings, now } = runtime;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const prefix = options.prefix ?? 'caracms:';
	const log = options.log ?? ((line: string) => console.log(`[caracms] ${line}`));
	// Redis diet Decision 2: every module that writes what the status poll reads tells its cache.
	const cache = git.statusCache;
	const autosaves = new Autosaves(redis, timings, now, prefix, cache);
	const locks = new Locks(redis, timings, now, async (file) => (await autosaves.get(file)) !== null, prefix, cache);
	const noticeStore = new Notices(redis, timings, prefix, cache);
	const sweep = new Sweep({ redis, git, autosaves, locks, timings, now, schedule: options.schedule, sleep: options.sleep, log, prefix });
	const store = liveDraftsStore({ site, git, autosaves, locks, sweep, now });
	// Publish's step 1 and Decision 8's "commit every pending autosave first".
	git.commitPending = async () => {
		await sweep.commitAll();
	};
	// Decision 11: a file main changed that no editor has a record for reads "only merges"
	// (`by: null`, known), not unknown. An editor's record is never overwritten.
	git.tookIn = async (files) => {
		const at = new Date(now()).toISOString();
		for (const { file, text } of files) await autosaves.setChangedIfAbsent(file, { by: null, version: fileVersion(text), at });
	};
	await sweep.start().catch((error: unknown) => log(`sweep: the startup check failed (${error instanceof Error ? error.message : String(error)}); the next autosave starts it`));
	// Decision 8's startup check, here and not in the runtime's start: only now is the
	// hook above in place, so a merge from main commits every pending autosave first.
	await git.check({ force: true }).catch((error: unknown) => log(`check at startup: ${error instanceof Error ? error.message : String(error)}`));

	/** Common gate: a person, the same origin for anything but GET, Redis outages as 503 (`outage`: that route's sentence for one). */
	const handler =
		(methods: string[], fn: (request: Request, person: Person) => Promise<Response>, outage: (error: unknown) => WriteRefused = unavailable): Handler =>
		async (request, person) => {
			try {
				if (!methods.includes(request.method)) {
					return new Response(JSON.stringify({ error: `This route takes ${methods.join(' or ')}.` } satisfies ApiError), {
						status: 405,
						headers: { ...HEADERS, Allow: methods.join(', ') },
					});
				}
				if (!person) return json(401, { error: 'signed-out', code: 'signed-out' } satisfies ApiError);
				if (request.method !== 'GET') checkOrigin(request);
				return await fn(request, person);
			} catch (error) {
				const refused = error instanceof RedisUnavailableError ? outage(error) : error;
				if (refused instanceof WriteRefused) return json(refused.status, { error: refused.message, ...refused.body });
				log(`${new URL(request.url).pathname} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
				return json(502, { error: `That didn't work (${error instanceof Error ? error.message : String(error)}).` } satisfies ApiError);
			}
		};

	const readBody = async (request: Request): Promise<Record<string, unknown>> => {
		// caracms-cloud adversarial review, finding 10: 16 KB counted as it's read, never the whole body first.
		const raw = await readCappedText(request, 16_384);
		if (raw === null) throw new WriteRefused(413, 'That body is too large.');
		try {
			const body = JSON.parse(raw || '{}') as unknown;
			if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
		} catch {
			/* below */
		}
		throw new WriteRefused(400, 'Send a JSON object.');
	};

	/** Is there a document at this file: in the copy, or a new one's autosave, and not deleted (M5a)? */
	const exists = async (file: string): Promise<boolean> => {
		const save = (await autosaves.get(file))?.value;
		return save ? !save.gone : git.read(file) !== null;
	};

	/** A document file that exists (the copy, or a new document's autosave), or a 400/404. */
	const documentFile = async (file: unknown): Promise<string> => {
		const target = confinePath(site, file);
		if (!(await exists(file as string))) throw new WriteRefused(404, `${site.collections[target.collection]!.label}: no document "${target.path}".`);
		return file as string;
	};

	// The alt list per waiting document, kept while its text stays the same (the poll asks every 5 s).
	const altKept = new Map<string, { text: string; list: MissingAltView[] }>();
	const missingAltOf = (file: string, collection: string | null, text: string | null): MissingAltView[] => {
		if (text === null) return [];
		const kept = altKept.get(file);
		if (kept && kept.text === text) return kept.list;
		const list = missingAltIn(site, collection, text);
		if (altKept.size > 500) altKept.clear();
		altKept.set(file, { text, list });
		return list;
	};

	/** `read`: the Publish lock and record as the status poll's cache has them; otherwise read from Redis. */
	const publishView = async (read?: { running: boolean; record: PublishView['record'] }): Promise<PublishView> => {
		const running = read ? read.running : (await redis.get(git.publishLockKey)) !== null;
		let st;
		try {
			st = await git.publishStatus(read ? { record: read.record } : {});
		} catch (error) {
			log(`publish status: ${error instanceof Error ? error.message : String(error)}`);
			const record = read ? read.record : await git.lastPublish();
			st = { state: record ? ('publishing' as const) : ('none' as const), record, assumed: false, canTryAgain: false };
		}
		return { state: st.state, running, record: st.record, assumed: st.assumed, canTryAgain: st.canTryAgain, hasRedeployer: Boolean(settings.deployHook) || settings.railway !== null };
	};

	const titleFor = (file: string) => git.titleFor(file);
	const notices = (person: Person): Promise<NoticeView[]> => noticeStore.of(person, git.keptDraftNotices(), titleFor);

	// The write route: M3's handler over the live store, which answers 401 with no person.
	const write: Handler = (request, person) => handleWrite(request, store, { person });
	// M5a Phase 3: creating and deleting, the same way (editor/server/create.ts over the live store).
	const create: Handler = (request, person) => handleCreate(request, store, { person });
	const remove: Handler = (request, person) => handleDelete(request, store, { person });

	const status = handler(['GET'], async (request, person) => {
		const url = new URL(request.url);
		const tab = tabOf(request);
		const asked = url.searchParams.get('file');
		let file: string | null = null;
		// Any document path: one deleted since the tab opened it is answered with who deleted it (M5a), not a 404.
		if (asked) {
			confinePath(site, asked);
			file = asked;
		}
		// The heartbeat and presence ride on the poll (Decisions 9 and 13). `input` is how long
		// ago someone typed, clicked or scrolled in the tab: an idle tab stops renewing its lock,
		// so it lapses by itself (Take over, 2026-10-15). A tab that doesn't say is treated as active.
		const input = Number(url.searchParams.get('input'));
		const active = !url.searchParams.has('input') || !(input >= timings.lockIdleMs);
		// Redis diet Contracts: `interval` is how long until the tab's next poll, which its
		// presence holds by (Decision 9). None, or not a number: a 5-second tab (an old page).
		const every = Number(url.searchParams.get('interval'));
		const interval = Number.isFinite(every) && every > 0 ? Math.min(every, Math.max(timings.pollMs, timings.slowPollMs)) : timings.pollMs;

		// Every read from the status cache (Decision 1): memory, or Redis once 30 s old.
		const snap = await cache.read({
			scans: [autosaves.keyPrefix, locks.keyPrefix],
			hashes: [locks.presenceKey(), autosaves.movesKey(), noticeStore.noticesKey],
			sets: [noticeStore.dismissedKey],
			strings: [git.publishLockKey, git.publishRecordKey, ...(file ? [autosaves.changedKey(file)] : [])],
		});
		if (tab) {
			await locks.present(tab, person, file, interval);
			// Decision 6: a beat only when the lock (as cached) is this tab's and needs one.
			if (file && active) {
				const cached = locks.allFrom(snap.scan(locks.keyPrefix)).get(file) ?? null;
				if (locks.needsBeat(cached, tab, person)) await locks.beat(file, tab, person, cached);
			}
		}
		// Decision 8's check, throttled to once a minute and shared inside git.ts. Started, not
		// awaited: the poll answers with what's known, and never waits on GitHub.
		void git.check().catch((error: unknown) => log(`check: ${error instanceof Error ? error.message : String(error)}`));

		// From the snapshot after this poll's own writes landed in it (its presence, its beat).
		const saves = Autosaves.allFrom(snap.scan(autosaves.keyPrefix).values()).map((r) => r.value);
		if (saves.length) sweep.poke(); // they may have come in on the other server during a deploy
		const pending = new Set(saves.map((a) => a.file));
		const presence = await locks.presenceFrom(snap.hash(locks.presenceKey()));
		const lockViews = [...locks.allFrom(snap.scan(locks.keyPrefix))]
			.filter(([f, r]) => locks.holds(r.lock, pending.has(f)))
			.map(([f, r]) => locks.view(f, r.lock, tab, person));

		// "Editing now" (the mockup's "Aoife is still in it"): someone other than this tab holds the lock.
		const editingNow = (f: string): Person[] => {
			const l = lockViews.find((x) => x.file === f);
			return l && l.mine !== 'this-tab' ? [l.person] : [];
		};
		const waiting = new Map<string, WaitingView>();
		for (const w of git.waiting()) waiting.set(w.file, { ...w, ...docOf(site, w.file), uncommitted: false, editingNow: editingNow(w.file), missingAlt: [] });
		for (const a of saves) {
			// M5a: new, deleted or changed, against main. Made and deleted again since the last Publish: not waiting;
			// nor is an autosave that's back to what's live (an undo to main's text, a client site's port).
			const change = git.changeOf(a.file, a.text);
			if (change === null || git.matchesMain(a.file, a.text)) {
				waiting.delete(a.file);
				continue;
			}
			const at = new Date(a.updatedAt).toISOString();
			const w: WaitingView = waiting.get(a.file) ?? {
				file: a.file,
				change,
				...docOf(site, a.file),
				title: '',
				editors: [],
				changedAt: null,
				keptDraft: false,
				uncommitted: false,
				editingNow: editingNow(a.file),
				missingAlt: [],
			};
			w.change = change;
			w.title = a.gone ? a.gone.title : titleOf(a.file, a.text);
			w.uncommitted = true;
			w.editors = [{ person: a.editor, at }, ...w.editors.filter((e) => !sameEmail(e.person, a.editor))];
			if (!w.changedAt || at > w.changedAt) w.changedAt = at;
			waiting.set(a.file, w);
		}
		// M5b Decision 9: each image with no alt text, from the document as it will publish (the
		// autosave's text, else the copy's). A deleted document has none.
		const textNow = new Map(saves.map((a) => [a.file, a.text]));
		for (const w of waiting.values()) {
			const text = textNow.has(w.file) ? (textNow.get(w.file) ?? null) : git.read(w.file);
			w.missingAlt = w.change === 'deleted' ? [] : missingAltOf(w.file, w.collection, text);
			// caracms-cloud adversarial review, finding 15: what Publish will leave waiting, by the same rule (git.ts → heldBack).
			const [problem] = w.change !== 'deleted' && w.collection !== null && text !== null ? textProblems(text) : [];
			if (problem) w.heldBack = problem.reason;
		}
		// Pre-M7 item 8: a moved document is one entry, on its new file, with its old address.
		// Read from the moves as recorded, not Site Settings' redirects: removing the redirect leaves it a move.
		const readNow = (f: string) => (textNow.has(f) ? (textNow.get(f) ?? null) : git.read(f));
		// The copy with every autosave on top: where a holder is now, moved or not committed yet.
		const nowSource = () => {
			const files = new Map(git.files());
			for (const a of saves) {
				if (a.text === null) files.delete(a.file);
				else files.set(a.file, a.text);
			}
			return filesSource(site.root, () => files);
		};
		const { records, addresses } = splitMoves(snap.hash(autosaves.movesKey()));
		// Collections under pages: a held document's addresses come from its holder (read only when something moved).
		const moved = records.size || addresses.size;
		const moves = movesIn(site, [...waiting.keys()], readNow, records, moved ? await heldBasesOf(site, nowSource()) : {}, addresses);
		const redirects = moves.from.size ? redirectsIn(readNow(SITE_SETTINGS_FILE)) : [];
		for (const [file, from] of moves.from) {
			// A held document whose holder moved keeps its file, unchanged: it waits as a move all the same.
			const w = waiting.get(file) ?? { file, change: 'changed' as const, ...docOf(site, file), title: titleOf(file, readNow(file)), editors: [], changedAt: null, keptDraft: false, uncommitted: false, editingNow: editingNow(file), missingAlt: [] };
			waiting.set(file, w);
			w.movedFrom = from;
			w.movedRedirect = redirects.some((r) => r.from === from);
		}
		for (const file of moves.to.keys()) waiting.delete(file);
		const list = [...waiting.values()].sort((a, b) => (b.changedAt ?? '').localeCompare(a.changedAt ?? '') || a.file.localeCompare(b.file));

		let open: StatusResponse['open'] = null;
		if (file) {
			const lock = lockViews.find((l) => l.file === file) ?? null;
			// M5a Decision 12: a viewer learns the document was deleted, and by whom, on this poll.
			let deleted: NonNullable<StatusResponse['open']>['deleted'] = null;
			const save = saves.find((a) => a.file === file);
			const record = Autosaves.changedFrom(snap.string(autosaves.changedKey(file)));
			if (save ? save.gone : git.read(file) === null) {
				deleted = record?.gone ? { by: record.by, at: record.at } : { by: null, at: null };
			}
			// Discard changes: this tab had it when someone put it back to what's live (its copy is stale).
			const discard = record?.discard;
			const discarded = discard && tab && discard.tabs.includes(tab) ? { by: discard.by, at: discard.at } : null;
			open = { file, state: Locks.state(lock), lock, lastChange: await lastChangeOf({ git, autosaves }, file, record), deleted, discarded };
		}
		const access = git.backend.accessProblem();
		// Finding 4: only while something is waiting to reach GitHub.
		const trouble = saves.length ? git.commitTrouble() : null;
		const lost = git.draftsLost();
		const rolledBack = git.mainRolledBack();
		const body: StatusResponse = {
			mode: 'live',
			you: person,
			tab,
			now: new Date(now()).toISOString(),
			timeZone: site.timeZone,
			open,
			waiting: list,
			locks: lockViews,
			presence,
			notices: Notices.forPerson(person, git.keptDraftNotices(), titleFor, snap.set(noticeStore.dismissedKey), snap.hash(noticeStore.noticesKey).values()),
			publish: await publishView({ running: snap.string(git.publishLockKey) !== null, record: git.publishRecordOr(LiveGit.publishRecordFrom(snap.string(git.publishRecordKey))) }),
			// Runs-anywhere Decision 5: while it holds, not dismissable.
			githubAccess: access
				? { kind: access.kind, title: ACCESS_TITLE[access.kind], message: accessProblemMessage(access), link: access.kind === 'cloud' ? access.installUrl : null }
				: null,
			commitTrouble: trouble ? { since: new Date(trouble.since).toISOString(), failures: trouble.failures, message: COMMIT_TROUBLE_MESSAGE } : null,
			draftsLost: lost ? { title: 'Unpublished changes were lost', message: draftsLostMessage(lost), commit: lost.commit, at: lost.at } : null,
			mainRolledBack: rolledBack ? { title: MAIN_ROLLED_BACK_TITLE, message: MAIN_ROLLED_BACK_MESSAGE, publish: rolledBack.publish, main: rolledBack.main, at: rolledBack.at } : null,
			// M5a Decision 10: from the committed copy, never an autosave.
			brand: editorBrand(brandFrom(git.read(SITE_SETTINGS_FILE), site)),
			// Arrange pages (Decision 18): from the autosaves already in the snapshot, else the copy; no Redis command of its own.
			// Review gaps (Decision 2): the hand orders ride the same stamp, so a drag elsewhere re-reads the listing too.
			pageOrderStamp: ordersStamp(readNow(SITE_SETTINGS_FILE)),
		};
		return json(200, body);
	});

	const lock = handler(['POST'], async (request, person) => {
		const tab = tabOf(request);
		if (!tab) throw new WriteRefused(400, 'Lock requests name their tab (X-Caracms-Tab).', { code: 'no-tab' });
		const body = await readBody(request);
		// A release needs no document (a deleter's tab lets go of one it deleted, M5a); take and take over do.
		const file = body.action === 'release' ? (confinePath(site, body.file), body.file as string) : await documentFile(body.file);
		if (body.action === 'release') {
			const r = await locks.release(file, tab, person);
			const view = r && locks.holds(r.lock, (await autosaves.get(file)) !== null) ? locks.view(file, r.lock, tab, person) : null;
			return json(200, { state: Locks.state(view), lock: view } satisfies LockResponse);
		}
		if (body.action === 'take-over') {
			// Take over: the lock moves first, so the old holder's tab can't write again; then
			// their autosave is committed under their name, and this tab opens from `drafts`.
			const r = await locks.takeOver(file, tab, person);
			if (r.from && !sameEmail(r.from.person, person)) log(`${person.email} took over ${file} from ${r.from.person.email}`);
			// Another server mid-sweep (a deploy) makes a commit a no-op: try a few times, or
			// this tab's first write would replace their autosave and their name with it.
			for (let attempt = 0; attempt < 5 && (await autosaves.get(file)) !== null; attempt++) {
				if ((await sweep.commitFiles([file])).ran) break;
				await sleep(500);
			}
			return json(200, { state: 'yours', lock: locks.view(file, r.lock, tab, person) } satisfies LockResponse);
		}
		if (body.action !== 'take') throw new WriteRefused(400, 'action must be "take", "take-over" or "release".');
		const r = await locks.take(file, tab, person);
		const view = locks.view(file, r.lock, tab, person);
		if (!r.ok) {
			return json(409, {
				error: `${displayName(view.person)} is editing this document.`,
				code: 'locked',
				lock: view,
				state: 'theirs',
				lastChange: await lastChangeOf({ git, autosaves }, file),
			} satisfies LockRefusal);
		}
		return json(200, { state: 'yours', lock: view } satisfies LockResponse);
	});

	const publish = handler(['POST'], async (_request, person) => {
		const before = await locks.presence();
		const work = git.publish(person).then(async (result) => {
			// Finding 6: the notices are kept in Redis, so with Redis gone they can't be sent; the Publish happened all the same.
			await stoodNotices(result, before, person).catch((error: unknown) => {
				log(`publish: the "published as it stood" notices weren't sent (${error instanceof Error ? error.message : String(error)})`);
			});
			return result;
		});
		// Runs-anywhere (Watch-outs): Cloudflare gives up on an answer after 100 s, and a
		// Publish whose GitHub calls are slow can take longer. Past `publishAnswerMs` the
		// request answers "joined" with the status (the Publish lock shows it running) and
		// the Publish carries on; the panel follows it on the poll.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), timings.publishAnswerMs);
		});
		const result = await Promise.race([work, late]).finally(() => clearTimeout(timer));
		if (result === null) {
			work.catch((error: unknown) => log(`publish (answered early): ${error instanceof Error ? error.message : String(error)}`));
			return json(200, { result: 'joined', publish: await publishView() } satisfies PublishResponse);
		}
		if (result.kind === 'published') {
			// Finding 6: the record as made, not as Redis has it (it may not have taken it); the lock read is the only Redis call, and its failure isn't the Publish's.
			const running = await redis.get(git.publishLockKey).then(
				(v) => v !== null,
				() => false,
			);
			return json(200, { result: result.kind, publish: await publishView({ running, record: result.record }), held: result.held } satisfies PublishResponse);
		}
		if (result.kind === 'held-back') return json(200, { result: result.kind, publish: await publishView(), held: result.held } satisfies PublishResponse);
		return json(200, { result: result.kind, publish: await publishView() } satisfies PublishResponse);
	}, publishUnavailable);

	/** "Aoife published Home as it stood at 14:20" for whoever had a published document open (Decision 10 step 1). */
	const stoodNotices = async (result: Awaited<ReturnType<typeof git.publish>>, before: Awaited<ReturnType<typeof locks.presence>>, person: Person) => {
		if (result.kind === 'published') {
			// "Aoife published Home as it stood at 14:20" for whoever had a published document open (Decision 10 step 1).
			const { record } = result;
			const stood: StoodNotice[] = [];
			for (const p of before) {
				const i = record.files.indexOf(p.file);
				if (i === -1) continue;
				for (const someone of p.people) {
					if (sameEmail(someone, person)) continue;
					const id = `stood:${record.commit}:${p.file}:${someone.email.toLowerCase()}`;
					stood.push({ id, for: someone.email.toLowerCase(), file: p.file, title: result.fileTitles[i] ?? titleOf(p.file, null), by: person, at: record.at });
				}
			}
			await noticeStore.addStood(stood);
		}
	};

	const history = handler(['GET'], async () => {
		const entries = await git.history({ refresh: true });
		return json(200, { timeZone: site.timeZone, entries } satisfies HistoryResponse);
	});

	const tryAgain = handler(['POST'], async () => {
		if (!settings.deployHook && !settings.railway) return json(409, { ok: false, error: NO_REDEPLOYER_REASON } satisfies TryAgainResponse);
		const st = await publishView();
		// Runs-anywhere Decision 10: taking longer than usual offers it too. One click, one call (the editor's button waits for the answer).
		if (st.state !== 'failed' && st.state !== 'slow') return json(409, { ok: false, error: 'The last publish hasn\'t failed, so there\'s nothing to try again.' } satisfies TryAgainResponse);
		const r = await git.tryAgain();
		return r.ok ? json(200, { ok: true } satisfies TryAgainResponse) : json(502, { ok: false, error: r.reason } satisfies TryAgainResponse);
	});

	// Dismiss: only a notice this person is shown now (a draft-kept notice is shared, so
	// anyone signed in sees it and may dismiss it; "published as it stood" is per person).
	const notice = handler(['POST'], async (request, person) => {
		const body = await readBody(request);
		const id = body.id;
		if (typeof id !== 'string' || id.length > NOTICE_ID_MAX || !NOTICE_ID.test(id)) throw new WriteRefused(400, '"id" must be a notice\'s id.');
		const shown = (await notices(person)).find((n) => n.id === id);
		if (!shown) throw new WriteRefused(404, 'There\'s no such notice for you to dismiss.');
		if (shown.kind === 'draft-kept') await noticeStore.dismiss(id);
		else await noticeStore.remove(id);
		return json(200, { ok: true });
	});

	/**
	 * Discard changes (see the header). `{ file }`: the document's file now (a moved one's new
	 * file). `{ file, seen: true }`: this tab has let go of its copy of a discarded document.
	 */
	const discard = handler(['POST'], async (request, person) => {
		const tab = tabOf(request);
		if (!tab) throw new WriteRefused(400, 'Discard requests name their tab (X-Caracms-Tab).', { code: 'no-tab' });
		const body = await readBody(request);
		const extra = Object.keys(body).filter((k) => k !== 'file' && k !== 'seen');
		if (extra.length || typeof body.file !== 'string' || (body.seen !== undefined && body.seen !== true)) {
			throw new WriteRefused(400, 'Malformed body: send { file } (or { file, seen: true }).', { code: 'bad-request' });
		}
		const file = body.file;
		confinePath(site, file);
		if (body.seen === true) {
			await autosaves.ackDiscard(file, tab);
			return json(200, { ok: true });
		}
		if ((await redis.get(git.publishLockKey)) !== null) throw new WriteRefused(409, "A Publish is running. Try again once it's done.", { code: 'publishing' });

		// What's waiting for it: an autosave, a commit on drafts that main hasn't got, or a move to it.
		const save = (await autosaves.get(file))?.value ?? null;
		const textNow = save ? save.text : git.read(file);
		const fromGit = git.waiting().find((w) => w.file === file) ?? null;
		const moves = await autosaves.moves();
		const from = [...moves].find(([, to]) => to === file)?.[0] ?? null;
		const change = git.changeOf(file, textNow);
		const title = save?.gone ? save.gone.title : textNow !== null ? titleOf(file, textNow) : git.titleFor(file);
		if (!change || (!save && !fromGit && !from)) {
			if (!from && (await autosaves.addresses()).has(file)) {
				throw new WriteRefused(409, `${title} moved with the page that holds it. Discard that page's changes to put it back.`, { code: 'held-move' });
			}
			throw new WriteRefused(404, `${title} has no unpublished changes.`, { code: 'not-waiting' });
		}

		// Someone else editing it right now (a fresh lock, not one held only until their autosave is committed).
		const own = [file, ...(from ? [from] : [])];
		for (const f of own) {
			const held = await locks.read(f);
			if (held && !sameEmail(held.lock.person, person) && held.lock.releasing === null && now() - held.lock.beat < timings.lockLapseMs) {
				throw new WriteRefused(409, `${displayName(held.lock.person)} is editing ${title} right now, so its changes can't be discarded yet.`, { code: 'locked' });
			}
		}

		const t0 = now();
		let movedBack: DiscardResponse['movedBack'] = null;
		if (from && git.mainHas(from)) {
			// Back to its old address first, through the move engine (its links, the redirects, what
			// moved with it), with no redirect. A swap (it took a live document's place) isn't undone here.
			const there = docOf(site, file);
			const back = docOf(site, from);
			if (git.mainHas(file)) throw new WriteRefused(409, `${title} took the place of a page that's live, so it can't be discarded on its own.`, { code: 'swap' });
			if (!there.collection || !there.path || !back.path || back.collection !== there.collection) {
				throw new WriteRefused(409, `${title} can't go back to its old address from here.`, { code: 'swap' });
			}
			// Any lock someone left on it (only held until their autosave is committed) goes, so the move can take it.
			for (const f of own) {
				const held = await locks.read(f);
				if (held && held.lock.tab !== tab) await locks.drop(held, f);
			}
			const context = { person, tab, release: false, seq: null };
			const moved = await store.move({ collection: there.collection, path: there.path, to: back.path, redirect: false }, context);
			// A redirect the move took out of Site Settings (from the address it took) comes back, as it is live.
			const vacated = moved.moved.filter((m) => m.fromUrl !== m.toUrl).map((m) => m.fromUrl);
			const current = (await autosaves.get(SITE_SETTINGS_FILE))?.value.text ?? git.read(SITE_SETTINGS_FILE);
			const restored = settingsWithRedirectsBack(site, current, (await git.readMain([SITE_SETTINGS_FILE])).get(SITE_SETTINGS_FILE) ?? null, vacated);
			if (restored !== null && current !== null) {
				const settings = site.collections.settings ?? Object.values(site.collections).find((c) => c.kind === 'settings');
				if (settings) {
					await store.write({ file: SITE_SETTINGS_FILE, base: current, document: parseAnyDocument(JSON.parse(restored), site, settings) }, context);
					await locks.release(SITE_SETTINGS_FILE, tab, person);
				}
			}
			await locks.release(from, tab, person);
			movedBack = { collection: back.collection, path: back.path, file: from };
		}

		const result = await sweep
			.exclusively(async () => {
				// The document's files, and any file the move back left exactly as main has it (a link put back).
				const files = new Set(own);
				if (movedBack) {
					const mine = (await autosaves.all()).map((r) => r.value).filter((a) => a.tab === tab && sameEmail(a.editor, person) && a.updatedAt >= t0 && !files.has(a.file));
					const main = await git.readMain(mine.map((a) => a.file));
					for (const a of mine) if (a.text === (main.get(a.file) ?? null)) files.add(a.file);
				}
				const list = [...files];
				// Every tab that has it or had edits in it, but this one: their copies are stale from now.
				const tabs = new Set<string>();
				const people = new Map<string, Person>();
				const note = (p: Person) => {
					if (!sameEmail(p, person)) people.set(p.email.toLowerCase(), p);
				};
				for (const e of fromGit?.editors ?? []) note(e.person);
				for (const f of list) {
					const a = (await autosaves.get(f))?.value;
					if (a) {
						tabs.add(a.tab);
						note(a.editor);
					}
					const c = await autosaves.committed(f);
					if (c) tabs.add(c.tab);
					const l = await locks.read(f);
					if (l) tabs.add(l.lock.tab);
					for (const p of await locks.tabsOn(f)) {
						tabs.add(p.tab);
						note(p.person);
					}
				}
				tabs.delete(tab);
				const at = new Date(now()).toISOString();
				const titles = [title];
				const restored = await git.restoreDrafts(list, titles, person);
				// Who changed it last, as it reads now, with the discard and the tabs that had it.
				const changeOf = (f: string) => {
					const text = restored.texts.get(f) ?? null;
					const discard = { by: person, at, tabs: [...tabs] };
					return text === null ? { by: person, version: '', at, gone: true, discard } : { by: person, version: fileVersion(text), at, discard };
				};
				for (const f of list) await autosaves.setChanged(f, changeOf(f));
				for (const f of list) {
					for (const gone of await autosaves.removeAll(f)) if (gone.tab !== tab) tabs.add(gone.tab);
					await autosaves.forgetCommitted(f);
				}
				await autosaves.forgetMovesOf(list);
				for (const f of list) {
					await autosaves.setChanged(f, changeOf(f)); // any tab whose autosave was removed just now too
					// This tab's lock lets go; one left by a tab that's gone is dropped; a live one (your other tab) stays, and that tab is told.
					const l = await locks.read(f);
					const fresh = !!l && l.lock.releasing === null && now() - l.lock.beat < timings.lockLapseMs;
					if (l && l.lock.tab === tab) await locks.release(f, tab, person);
					else if (l && !fresh) await locks.drop(l, f);
				}
				// "Aoife discarded the unpublished changes to About", for everyone else who had it.
				await noticeStore
					.addStood([...people.values()].map((p) => ({ id: `discarded:${at}:${file}:${p.email.toLowerCase()}`, for: p.email.toLowerCase(), file: movedBack?.file ?? file, title, by: person, at, kind: 'discarded' as const })))
					.catch((error: unknown) => log(`discard: the notices weren't left (${error instanceof Error ? error.message : String(error)})`));
				log(`${person.email} discarded the unpublished changes to ${list.join(', ')}`);
				return { files: list };
			})
			.catch((error: unknown) => {
				if (error instanceof SweepBusyError) throw new WriteRefused(409, 'The server is busy saving changes. Try again in a moment.', { code: 'busy' });
				throw error;
			});
		return json(200, { ok: true, file, change, files: result.files, movedBack } satisfies DiscardResponse);
	});

	return { runtime, autosaves, locks, sweep, store, write, create, delete: remove, status, lock, publish, history, tryAgain, notice, discard };
}

const SHARED = Symbol.for('caracms.liveEditor');
type Shared = { [SHARED]?: Promise<LiveEditor> };

/** The process's live editor, beside the shared runtime (runtime.ts → liveRuntime). */
export function liveEditor(site: ResolvedSite, settings: LiveSettings): Promise<LiveEditor> {
	const g = globalThis as Shared;
	g[SHARED] ??= liveRuntime(site, settings)
		.then((rt) => createLiveEditor(rt))
		.catch((error: unknown) => {
			delete g[SHARED];
			throw error;
		});
	return g[SHARED];
}
