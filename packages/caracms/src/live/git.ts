/**
 * The git layer of live mode (M4 Phase 1): the in-memory `drafts` copy, draft
 * commits, keeping `drafts` up to date with `main`, Publish, what's waiting, publish
 * status, history and Try again. No UI and no routes; Phase 2's live drafts store,
 * sweep and status route sit on top of it.
 *
 * **The copy** (Spec → How it maps to git). The server holds `drafts`' site files in
 * memory: downloaded once at startup as an archive, keeping only the files under
 * the declared collection folders plus Site Settings (Decision 3), then kept current
 * by the server's own commits and merges. When `drafts` moved under it (another
 * server, during a deploy), it's refreshed before anything retries.
 *
 * **Two servers at once.** Railway runs the old and new servers side by side during
 * a deploy. Nothing here assumes it's alone: every ref move is compare-and-swap
 * (`expectedHeadOid`, `beforeOid`), a lost race re-reads and refreshes the copy and
 * goes round again, Publish takes a Redis lock, and the newest publish is kept in
 * Redis, so a status read on the new server knows about a publish the old one made.
 *
 * **Rate limits** (M1 → G4: 80 content-creating requests a minute, 500 an hour).
 * One commit per batch; `drafts`' head comes from the copy, so a draft commit is
 * one request; status reads ask GitHub at most once a minute (Decision 8) and the
 * deployments at most every 10 seconds while a publish is in flight (Decision 13).
 *
 * **Deletions** (M5a Decisions 12): a draft entry with `text` null removes the file
 * (`commitDrafts`), merged like any change with the draft winning (a file the editor
 * deleted that `main` changed stays deleted, with `Draft-kept:`). A deleted document
 * is named "Contact (deleted)" in the draft and publish headlines, its title from
 * `main`'s copy, else `drafts`' copy before the removal, else its path. What's
 * waiting knows which files `main` lacks (`SinceMain.absent`), so each waiting file is
 * new, deleted or changed (`changeOf`), and a file made and removed again since the
 * last Publish isn't waiting at all.
 *
 * **Losing `drafts`** (caracms-cloud adversarial review, finding 5). Every head of
 * `drafts` this server makes or finds at start is recorded in Redis (`drafts:head`, no
 * expiry). A start that finds `drafts` gone (a branch tidy-up, a stale-branch bot) makes
 * it again from that commit while GitHub still has it; only when it can't does it fall
 * back to `main`, with a loud log line and a note every editor sees for a week
 * (`drafts:lost`, `draftsLost()`), cleared by the next Publish.
 *
 * **`main` rolled back by a force-push** (caracms-cloud adversarial review, force-push
 * note). A developer resetting `main` to an older commit and force-pushing leaves `drafts`
 * holding what was rolled away, so it all reads as waiting and the next Publish puts it
 * back. Each check asks whether `main` still has the last Publish's commit (one compare per
 * pair of commits): a push on top, a merge or a `git revert` all keep it, so only history
 * being rewritten finds it gone. Then a log line, and a note every editor sees
 * (`main:rolled-back`, `mainRolledBack()`). Nothing works out which waiting changes were
 * rolled back. The note goes with the next Publish, once nothing is waiting (everything
 * discarded: it stays gone for that rollback), or when `main` has the commit again.
 *
 * **Commits that keep failing** (finding 4): `commitTrouble()` says so once
 * `COMMIT_TROUBLE_AFTER` draft commits in a row have failed, until one succeeds; the
 * status poll turns it into the save bar's warning. In-process: the sweep's ticks on this
 * server are what fail, and a restart learns it again within a few ticks.
 *
 * **Holding a document back** (caracms-cloud adversarial review, finding 15). Publish
 * checks every waiting document as the reader will (document-problems.ts): one the reader
 * would refuse (no title) isn't published. `main` gets `drafts`' tree with those files as
 * `main` has them (a new one left out), and `drafts` gets one more commit on top, headed
 * `Held back:`, putting them back as they were, so they're still waiting, with who changed
 * them. A moved document's old file is held with its new one. Nothing publishable: nothing
 * moves (`held-back`).
 *
 * **Discarding a document's changes** (`restoreDrafts`): its files are committed to
 * `drafts` as `main` has them now (a file `main` lacks is removed), headed `Discarded:`,
 * so what's waiting no longer lists them. One commit, compare-and-swap like any other.
 *
 * In-process state here is caches of git and GitHub, and throttles; none of it is
 * the only record of anything.
 */
import { randomBytes } from 'node:crypto';
import { relative, sep } from 'node:path';
import { repoPrefix, SITE_SETTINGS_FILE, type ResolvedSite } from '../config.ts';
import { documentUrl, filesSource, heldBasesOf, type ContentSource } from '../content.ts';
import { withHeldBases, type HeldBase } from '../held.ts';
import { confinePath } from '../editor/server/write.ts';
import { ADDRESS_FIELD, movesKey, splitMoves } from './autosaves.ts';
import type { WaitingChange } from '../editor/types.ts';
import { MissingBranchError, StaleHeadError, type Branch, type CommitSummary, type Comparison, type GitBackend, type Head, type Heads, type TreeChange } from './backend.ts';
import { HttpError } from './github.ts';
import { runningCommitFrom } from './mode.ts';
import { mergeFile } from './merge.ts';
import { discardMessage, draftMessage, heldMessage, mergeMessage, parseMessage, publishMessage, type Person } from './messages.ts';
import { textProblems } from '../document-problems.ts';
import type { RedisClient } from './redis.ts';
import { landed, StatusCache } from './status-cache.ts';
import { DEFAULT_TIMINGS, type LiveTimings } from './timings.ts';
import { publishState, waitingFromCommits, type DeploymentFact, type PublishRecord, type PublishState, type WaitingFile } from './status.ts';

/** One autosave to commit (Decision 6): `text` is `applyEdits(base, document)`. */
export interface DraftEntry {
	/** Site-relative path, `content/pages/index.json`. */
	file: string;
	/** The text the edits were made against: the merge's ancestor. Null for a file that didn't exist. */
	base: string | null;
	/** The autosave as text: the merge's draft side, which wins conflicts. Null: the editor deleted the file (M5a). */
	text: string | null;
	editor: Person;
}

export interface DraftCommitResult {
	/** Null when nothing changed (every entry already matched `drafts`). */
	commit: string | null;
	/** Site-relative files the commit changed. */
	files: string[];
	/** Files where a key or the whole file was decided for the autosave (the notice). */
	keptDraft: string[];
	/** Each entry's file as committed, by file (null: removed). */
	texts: Map<string, string | null>;
	attempts: number;
}

export type CheckResult =
	| { kind: 'current' }
	| { kind: 'fast-forward'; to: string; fromMain: string[] }
	| { kind: 'merged'; commit: string; fromMain: string[]; keptDraft: string[] };

/** A waiting document Publish left waiting (finding 15): its file, its title and why ("its title is empty"). */
export interface HeldBack {
	file: string;
	title: string;
	reason: string;
}

export type PublishResult =
	| { kind: 'nothing-waiting' }
	/**
	 * `fileTitles`: each of `record.files`' own title, in that order (`record.titles` is the headline's items).
	 * `held`: the documents left waiting (finding 15), none of them in `record.files`.
	 */
	| { kind: 'published'; record: PublishRecord; attempts: number; fileTitles: string[]; held: HeldBack[] }
	/** Finding 15: everything waiting would break the reader, so nothing moved. */
	| { kind: 'held-back'; held: HeldBack[] }
	/** A Publish was already running; this press joined it. */
	| { kind: 'joined'; record: PublishRecord | null };

export interface PublishStatus {
	/** `none`: nothing has been published since the record began. */
	state: PublishState | 'none';
	record: PublishRecord | null;
	/** Live only because there's no deploy pipeline to ask (Decision 12; logged). */
	assumed: boolean;
	/** Try again is possible (a Railway token is set and the publish failed). */
	canTryAgain: boolean;
}

export interface HistoryEntry {
	commit: string;
	by: Person | null;
	/** ISO; the editor shows it in the site's time zone (Decision 16). */
	at: string;
	titles: string[];
	files: string[];
	state: PublishState;
}

/**
 * Try again's redeployer (runs-anywhere Decision 11): Railway's API with a project token
 * (`CARACMS_RAILWAY_TOKEN`, M4 Decision 12), or a deploy hook (`CARACMS_DEPLOY_HOOK_URL`):
 * one bare POST, any 2xx a success. The hook's URL is a secret: never logged or sent on.
 */
export type Redeployer =
	| { kind: 'railway'; token: string; serviceId: string; environmentId: string; fetch?: typeof fetch }
	| { kind: 'hook'; url: string; fetch?: typeof fetch; timeoutMs?: number };

/** A deploy hook that hasn't answered in this long has failed (it's one POST; nothing retries by itself). */
export const DEPLOY_HOOK_TIMEOUT_MS = 20_000;

/** Try again's answer when no redeployer is set: no host's name (Decision 11). */
export const NO_REDEPLOYER_REASON = "Try again isn't set up on this site: a developer can redeploy it.";

export interface LiveGitOptions {
	backend: GitBackend;
	site: Pick<ResolvedSite, 'root' | 'collections' | 'repoPath'>;
	redis: RedisClient;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	/** The running server's commit, read on every status (tests move it). Default: mode.ts → `runningCommitFrom` over the environment and `bakedCommit`. */
	runningCommit?: () => string | null;
	/** The commit baked in at build (runs-anywhere Decision 9), for the default `runningCommit`. */
	bakedCommit?: string | null;
	timings?: Partial<LiveTimings>;
	redeployer?: Redeployer | null;
	/** Redis key prefix. Default `caracms:`. */
	keyPrefix?: string;
	/** The status poll's cache (Redis diet), told of the publish lock, the publish record and the moves Publish clears. Default: one of its own. */
	statusCache?: StatusCache;
}

/**
 * Draft commits failing in a row before the editor is told (finding 4): three of the
 * sweep's 30-second ticks, about a minute of failing, so one GitHub blip never shows.
 */
export const COMMIT_TROUBLE_AFTER = 3;

/** Draft commits failing in a row (finding 4): since when, and how many. */
export interface CommitTrouble {
	since: number;
	failures: number;
}

/** `drafts` was made again from `main` and what it held is gone (finding 5): its last recorded head (null: none was), and when. */
export interface DraftsLost {
	commit: string | null;
	at: string;
}

/**
 * `main` no longer has the last Publish's commit (force-push note): that commit, `main`'s head
 * when it was found, and when. `cleared`: nothing was waiting since, so the note is done with.
 */
export interface MainRolledBack {
	publish: string;
	main: string;
	at: string;
	cleared?: boolean;
}

/** The site file that holds Site Settings, relative to the site (Decision 15). Defined in config.ts (M5a: the reserved `settings` collection). */
export { SITE_SETTINGS_FILE };

const MAX_ATTEMPTS = 4;
/** archiveDiff's mark for "changed, sha not known". */
const CHANGED = '(changed)';
const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

const posix = (p: string) => p.split(sep).join('/');

/** The rollback note as kept in Redis; null when there's none or it doesn't read. */
function parseRolledBack(raw: string | null): MainRolledBack | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as MainRolledBack;
		return typeof v.publish === 'string' && typeof v.main === 'string' ? v : null;
	} catch {
		return null;
	}
}

/** What `drafts` holds beyond `main`: from one compare, extended by this server's own commits. */
interface SinceMain {
	main: string;
	drafts: string;
	commits: CommitSummary[];
	/**
	 * Repo paths that differ (a superset: a file changed and changed back stays listed, unless
	 * `mainTexts` knows `main`'s text for it).
	 */
	files: Set<string>;
	/** M5a: those of `files` that `main` doesn't have (new on `drafts`, or made and removed again). */
	absent: Set<string>;
	/**
	 * `main`'s text for files this server's own commits took away from it (null: `main` hasn't
	 * the file), learned without asking GitHub: a file not in `files` is the same on both, so its
	 * text just before that commit is `main`'s. A later commit that puts that text back takes the
	 * file off `files` (a client site's port: an undo back to what's live left "1 waiting"), and
	 * `matchesMain` says so of an autosave. Goes with this compare (a new one starts empty).
	 */
	mainTexts?: Map<string, string | null>;
}

export class LiveGit {
	readonly backend: GitBackend;
	readonly redis: RedisClient;
	readonly timings: LiveTimings;
	readonly now: () => number;
	/**
	 * The status poll's write-through cache (status-cache.ts, Redis diet Decisions 1–5),
	 * one per process: kept here because this module writes some of what it holds; the
	 * live editor's autosaves, locks and notices write through the same one.
	 */
	readonly statusCache: StatusCache;
	/** Phase 2 fills this: commit every pending autosave (Decision 10 step 1; Decision 8 before a merge). */
	commitPending: () => Promise<void> = async () => {};
	/**
	 * Told the site files (and their new text) a fast-forward or merge from `main` just
	 * changed in the copy. Phase 2's editor records "only merges" for any file with no
	 * record of who changed it yet (Decision 11). Its failure never fails the check.
	 */
	tookIn: (files: { file: string; text: string }[]) => Promise<void> = async () => {};

	private readonly site: LiveGitOptions['site'];
	private readonly prefix: string;
	private readonly folders: string[];
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly log: (line: string) => void;
	private readonly runningCommit: () => string | null;
	private readonly redeployer: Redeployer | null;
	private readonly keyPrefix: string;

	private copyHead: Head | null = null;
	private copyFiles = new Map<string, string>();
	private since: SinceMain | null = null;
	private lastCheck = -Infinity;
	private checking: Promise<CheckResult> | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private assumedLogged = false;
	private deploymentsCache: { key: string; at: number; facts: DeploymentFact[]; later: Set<string> } | null = null;
	private includesCache = new Map<string, boolean>();
	private laterCache: { key: string; later: Set<string> } | null = null;
	private historyCache: { at: number; entries: HistoryEntry[] } | null = null;
	private deploymentsDenied = false;
	/** A deleted file's title (M5a): the waiting list's name for it once `drafts` has no copy. Learned when this process deleted it, else from `main`'s copy at a check (`learnDeletedTitles`), so a restart keeps it. */
	private deletedTitles = new Map<string, string>();
	/** Finding 5: the `drafts` head last written to Redis from here, so the same one isn't written twice. */
	private recordedHead: string | null = null;
	/** Finding 5: `drafts` was made again from `main` (read at start; a Publish clears it). */
	private lost: DraftsLost | null = null;
	/** Force-push note: `main` lost the last Publish's commit (read at each check; a Publish clears it). */
	private rolledBack: MainRolledBack | null = null;
	/** Force-push note: the last (publish commit, `main`) pair checked, and an unknown commit already logged. */
	private rollbackPair: string | null = null;
	private rollbackUnknown: string | null = null;
	/** Its own cache, not `includesCache`: that one reads a commit GitHub lacks as "not included". */
	private onMainCache = new Map<string, boolean>();
	/** Finding 4: draft commits failing in a row; null after a success. */
	private failing: CommitTrouble | null = null;
	/** Finding 6: a publish whose refs moved but whose record couldn't be written to Redis. */
	private unkeptRecord: PublishRecord | null = null;

	constructor(options: LiveGitOptions) {
		this.backend = options.backend;
		this.redis = options.redis;
		this.site = options.site;
		this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.log = options.log ?? ((line) => console.log(`[caracms] ${line}`));
		const baked = options.bakedCommit ?? null;
		this.runningCommit = options.runningCommit ?? (() => runningCommitFrom(process.env, baked));
		this.redeployer = options.redeployer ?? null;
		this.keyPrefix = options.keyPrefix ?? 'caracms:';
		this.statusCache = options.statusCache ?? new StatusCache({ redis: this.redis, maxAgeMs: this.timings.statusCacheMs, now: this.now });
		this.prefix = repoPrefix(options.site);
		// Every collection's folder, shared blocks' included (M5a Decision 8); Site Settings is its one file (inScope).
		this.folders = Object.values(options.site.collections)
			.filter((c) => c.kind !== 'settings')
			.map((c) => posix(relative(options.site.root, c.dir)));
	}

	// ── Paths and the copy ──────────────────────────────────────────────────────

	/** Is this repo path one the copy keeps? Collection folders' `.json` files (shared blocks' too), and Site Settings (Decision 3). */
	inScope(repoPath: string): boolean {
		if (!repoPath.startsWith(this.prefix)) return false;
		const rel = repoPath.slice(this.prefix.length);
		if (rel === SITE_SETTINGS_FILE) return true;
		return rel.endsWith('.json') && this.folders.some((f) => rel.startsWith(`${f}/`));
	}
	toSite = (repoPath: string) => repoPath.slice(this.prefix.length);
	toRepo = (sitePath: string) => `${this.prefix}${sitePath}`;

	/** The copy's files, by site-relative path. Phase 3 reads `content/site-settings.json` here. */
	files(): ReadonlyMap<string, string> {
		return this.copyFiles;
	}

	/** One file from the copy, or null. */
	read(sitePath: string): string | null {
		return this.copyFiles.get(sitePath) ?? null;
	}

	/** The copy as a content.ts source: the reader's rules over `drafts` (Current state). */
	contentSource(): ContentSource {
		return filesSource(this.site.root, () => this.copyFiles);
	}

	/** `drafts`' head as the copy has it. */
	head(): Head {
		if (!this.copyHead) throw new Error('caracms: the drafts copy isn\'t loaded yet (call start()).');
		return this.copyHead;
	}

	private key(name: string) {
		return `${this.keyPrefix}${name}`;
	}

	/** The Publish lock's key (one Publish at a time) and the newest publish's record's (Decision 10, 12). */
	get publishLockKey(): string {
		return this.key('publish:lock');
	}
	get publishRecordKey(): string {
		return this.key('publish:last');
	}

	/** Finding 5: the newest head of `drafts` this server made or found, and the note left when it was lost. */
	get draftsHeadKey(): string {
		return this.key('drafts:head');
	}
	get draftsLostKey(): string {
		return this.key('drafts:lost');
	}

	/** Force-push note: `main` was found without the last Publish's commit. */
	get mainRolledBackKey(): string {
		return this.key('main:rolled-back');
	}

	private async setPublishRecord(record: PublishRecord): Promise<void> {
		const raw = JSON.stringify(record);
		await landed(this.statusCache, this.publishRecordKey, () => this.redis.set(this.publishRecordKey, raw));
		this.statusCache.string(this.publishRecordKey, raw);
		this.unkeptRecord = null;
	}

	/**
	 * Finding 6: the newest publish as the status poll read it, unless this server made a
	 * newer one whose record Redis didn't take: that one.
	 */
	publishRecordOr(record: PublishRecord | null): PublishRecord | null {
		const unkept = this.unkeptRecord;
		return unkept && (!record || record.at < unkept.at) ? unkept : record;
	}

	/**
	 * Finding 5: record `drafts`' head in Redis (no expiry), so a start that finds the
	 * branch deleted can make it again from here. Never fails what it follows.
	 */
	private async recordDraftsHead(commit: string): Promise<void> {
		if (this.recordedHead === commit) return;
		try {
			await this.redis.set(this.draftsHeadKey, commit);
			this.recordedHead = commit;
		} catch (error) {
			this.log(`recording drafts' head (${commit.slice(0, 7)}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Finding 5: `drafts` was made again from `main` at a start, losing what it held (for a week, or until the next Publish). */
	draftsLost(): DraftsLost | null {
		return this.lost;
	}

	/** Force-push note: `main` was rolled back past the last Publish, and something is still waiting. */
	mainRolledBack(): MainRolledBack | null {
		return this.rolledBack && !this.rolledBack.cleared ? this.rolledBack : null;
	}

	/** Finding 4: draft commits have failed `COMMIT_TROUBLE_AFTER` times in a row or more, and none has succeeded since. */
	commitTrouble(): CommitTrouble | null {
		return this.failing && this.failing.failures >= COMMIT_TROUBLE_AFTER ? this.failing : null;
	}

	/** Run `fn` alone among this server's git operations, so the copy is never changed by two at once. */
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	// ── Startup ─────────────────────────────────────────────────────────────────

	/**
	 * Create `drafts` from `main` if it's missing, download the copy, and check `main` once
	 * (`check: false` leaves the check to the caller: the runtime does, so the live editor
	 * can run it once `commitPending` is in place, Decision 8).
	 */
	async start(options: { check?: boolean } = {}): Promise<void> {
		// Finding 5: a note left by an earlier start that lost `drafts` (it expires after a week).
		try {
			const raw = await this.redis.get(this.draftsLostKey);
			this.lost = raw ? (JSON.parse(raw) as DraftsLost) : null;
		} catch (error) {
			this.log(`reading the lost-drafts note: ${error instanceof Error ? error.message : String(error)}`);
		}
		await this.backend.tracker.within('start', () =>
			this.exclusive(async () => {
				let heads: Heads;
				try {
					heads = await this.backend.readHeads();
				} catch (error) {
					if (!(error instanceof MissingBranchError) || error.branch !== 'drafts') throw error;
					heads = await this.remakeDrafts();
				}
				await this.download(heads.drafts);
				await this.recordDraftsHead(heads.drafts.commit);
			}),
		);
		if (options.check !== false) await this.check({ force: true });
	}

	/**
	 * `drafts` is missing (finding 5): made again from its last recorded head when GitHub
	 * still has that commit, so nothing unpublished is lost. Otherwise from `main`, as on a
	 * site's first start; with a recorded head, or a publish on record (so it isn't a first
	 * start), that loses every change saved since the last Publish: a loud log line, and the
	 * editor's note (`drafts:lost`). Redis out: this start fails rather than make `drafts`
	 * from `main` and lose what the next start could put back.
	 */
	private async remakeDrafts(): Promise<Heads> {
		const main = await this.mainOnly();
		const recorded = await this.redis.get(this.draftsHeadKey);
		if (recorded) {
			const heads = await this.createDrafts(recorded);
			if (heads) {
				this.log(`the drafts branch was missing: made it again from its last recorded head (${recorded}), so nothing unpublished was lost`);
				return heads;
			}
		}
		const published = recorded === null ? (await this.lastPublish()) !== null : true;
		const heads = await this.createDrafts(main);
		if (!heads) throw new Error(`caracms: couldn't make the drafts branch from main (${main.slice(0, 7)}).`);
		if (!published) {
			this.log(`no drafts branch yet: created it from main (${main.slice(0, 7)})`);
			return heads;
		}
		this.log(
			recorded
				? `UNPUBLISHED CHANGES LOST: the drafts branch was missing on GitHub and its last recorded head (${recorded}) isn't there any more, so drafts was made again from main (${main.slice(0, 7)}). Every change saved since the last Publish, up to that commit, is gone from the editor.`
				: `UNPUBLISHED CHANGES LOST: the drafts branch was missing on GitHub and no head of it was recorded, so drafts was made again from main (${main.slice(0, 7)}). Any change saved since the last Publish is gone from the editor.`,
		);
		this.lost = { commit: recorded, at: new Date(this.now()).toISOString() };
		await this.redis.set(this.draftsLostKey, JSON.stringify(this.lost), { px: this.timings.autosaveTtlMs }).catch((error: unknown) => {
			this.log(`keeping the lost-drafts note: ${error instanceof Error ? error.message : String(error)}`);
		});
		return heads;
	}

	/** Make `drafts` at `commit`; null when GitHub doesn't have that commit. Another server making it first is a success. */
	private async createDrafts(commit: string): Promise<Heads | null> {
		try {
			await this.backend.createBranch('drafts', commit);
		} catch (error) {
			const heads = await this.backend.readHeads().catch((e: unknown) => {
				if (e instanceof MissingBranchError && e.branch === 'drafts') return null;
				throw e;
			});
			if (heads) return heads; // another server made it first
			// GitHub answers 422 for a sha it doesn't have (the memory backend, 404). Anything else fails the start.
			if (error instanceof HttpError && (error.status === 422 || error.status === 404)) return null;
			throw error;
		}
		return this.backend.readHeads();
	}

	/** `main`'s head when `drafts` is missing (readHeads throws then). */
	private async mainOnly(): Promise<string> {
		// listCommits reads main alone; its first entry is the head.
		const [head] = await this.backend.listCommits('main', 1);
		if (!head) throw new MissingBranchError('main');
		return head.sha;
	}

	private async download(head: Head) {
		const files = await this.backend.readArchive(head.commit, (p) => this.inScope(p));
		this.copyFiles = new Map([...files].map(([p, t]) => [this.toSite(p), t]));
		this.copyHead = head;
		this.since = null;
	}

	/** Bring the copy up to `drafts` as GitHub has it: the commits since, or a fresh download. */
	private async refresh(heads: Heads) {
		const copy = this.head();
		if (heads.drafts.commit === copy.commit) return;
		const cmp = await this.backend.compare(copy.commit, heads.drafts.commit);
		if (cmp.status !== 'ahead' || cmp.files === null) {
			this.log(`drafts moved to ${heads.drafts.commit.slice(0, 7)} (not on from the copy): downloading it again`);
			await this.download(heads.drafts);
			return;
		}
		// A file new to the waiting list was the same on main as in the copy, so main has it if the copy did.
		const hadIt = new Map(cmp.files.map((f) => [f.path, this.copyFiles.has(this.toSite(f.path))]));
		await this.applyChanges(heads.drafts, cmp);
		if (this.since && this.since.main === heads.main.commit) {
			this.since.drafts = heads.drafts.commit;
			this.since.commits.push(...cmp.commits);
			for (const f of cmp.files) {
				if (!this.since.files.has(f.path) && !hadIt.get(f.path)) this.since.absent.add(f.path);
				this.since.files.add(f.path);
			}
		} else this.since = null;
	}

	/** Lay a comparison's in-scope files (at `to`) onto the copy. */
	private async applyChanges(to: Head, cmp: Comparison) {
		const changed = (cmp.files ?? []).filter((f) => this.inScope(f.path));
		const reads = changed.filter((f) => f.sha !== null);
		const texts = reads.length ? await this.backend.readFiles(reads.map((f) => ({ commit: to.commit, path: f.path }))) : [];
		reads.forEach((f, i) => {
			const text = texts[i];
			if (text === null || text === undefined) this.copyFiles.delete(this.toSite(f.path));
			else this.copyFiles.set(this.toSite(f.path), text);
		});
		for (const f of changed) if (f.sha === null) this.copyFiles.delete(this.toSite(f.path));
		this.copyHead = to;
	}

	/** Re-read both heads and refresh the copy: after any failed ref move (M1 → G6 (a)). */
	private async reread(): Promise<Heads> {
		const heads = await this.backend.readHeads();
		await this.refresh(heads);
		return heads;
	}

	// ── Draft commits (Decisions 5 and 6) ───────────────────────────────────────

	/**
	 * Commit a batch of autosaves to `drafts` in **one** commit, each merged with the
	 * file in `drafts` now (Decision 6), with who changed what in the message
	 * (Decision 5). Entries for one file apply in order. A lost race refreshes the copy
	 * and merges again.
	 */
	async commitDrafts(entries: DraftEntry[]): Promise<DraftCommitResult> {
		// Finding 4: count the failures in a row (the save bar's warning), and record the new head.
		try {
			const r = await this.commitDraftsOnce(entries);
			this.failing = null;
			if (r.commit) await this.recordDraftsHead(r.commit);
			return r;
		} catch (error) {
			this.failing = { since: this.failing?.since ?? this.now(), failures: (this.failing?.failures ?? 0) + 1 };
			if (this.failing.failures === COMMIT_TROUBLE_AFTER) this.log(`draft commits have failed ${COMMIT_TROUBLE_AFTER} times in a row: the editor now says they aren't reaching GitHub`);
			throw error;
		}
	}

	private async commitDraftsOnce(entries: DraftEntry[]): Promise<DraftCommitResult> {
		return this.backend.tracker.within('draft', () =>
			this.exclusive(async () => {
				for (let attempt = 1; ; attempt++) {
					const head = this.head();
					const texts = new Map<string, string | null>();
					const kept = new Set<string>();
					const edits: { file: string; title: string; editor: Person }[] = [];
					for (const entry of entries) {
						const perKey = entry.file.endsWith('.json');
						const current = texts.has(entry.file) ? texts.get(entry.file)! : this.read(entry.file);
						const merged = mergeFile({ base: entry.base, draft: entry.text, other: current, perKey });
						// The notice is for changes made outside this batch: a later entry for the same file is checked against drafts.
						const outside = texts.has(entry.file) ? mergeFile({ base: entry.base, draft: entry.text, other: this.read(entry.file), perKey }) : merged;
						if (outside.keptDraft) kept.add(entry.file);
						// An editor's autosave never deletes: a null here means "deleted on the other side", and the draft
						// wins it. A deletion (M5a: `text` null) merges like any change, so a removal the draft wins removes it.
						texts.set(entry.file, entry.text === null ? merged.text : (merged.text ?? entry.text));
						edits.push({ file: entry.file, title: '', editor: entry.editor });
					}
					const changed = [...texts].filter(([file, text]) => this.read(file) !== text);
					if (changed.length === 0) return { commit: null, files: [], keptDraft: [], texts, attempts: attempt };
					const changedFiles = new Set(changed.map(([f]) => f));
					const removed = changed.filter(([, text]) => text === null).map(([f]) => f);
					const deletedTitles = await this.titlesBeforeRemoval(removed);
					const titled = edits
						.filter((e) => changedFiles.has(e.file))
						.map((e) => ({ ...e, title: texts.get(e.file) === null ? `${deletedTitles.get(e.file)!} (deleted)` : titleOf(e.file, texts.get(e.file)!) }));
					const { headline, body } = draftMessage(titled, [...kept].filter((f) => changedFiles.has(f)));
					try {
						const next = await this.backend.commitOnBranch(
							'drafts',
							head.commit,
							changed.filter(([, text]) => text !== null).map(([file, contents]) => ({ path: this.toRepo(file), contents: contents! })),
							removed.map(this.toRepo),
							headline,
							body,
						);
						// Before the copy changes: a file new to the waiting list is on main exactly when drafts had it,
						// and drafts' text for it is main's.
						const absentOnMain = changed.filter(([file]) => this.read(file) === null).map(([file]) => this.toRepo(file));
						const before = new Map(changed.map(([file]) => [this.toRepo(file), this.read(file)] as [string, string | null]));
						for (const [file, text] of changed) {
							if (text === null) this.copyFiles.delete(file);
							else this.copyFiles.set(file, text);
						}
						for (const [file, title] of deletedTitles) this.deletedTitles.set(file, title);
						this.copyHead = next;
						if (this.since?.drafts === head.commit) {
							this.since.drafts = next.commit;
							this.since.commits.push({ sha: next.commit, parents: [head.commit], message: `${headline}\n\n${body}`, date: new Date(this.now()).toISOString() });
							const mainTexts = (this.since.mainTexts ??= new Map());
							for (const [file, text] of changed) {
								const repo = this.toRepo(file);
								if (!this.since.files.has(repo)) {
									mainTexts.set(repo, before.get(repo) ?? null);
									if (absentOnMain.includes(repo)) this.since.absent.add(repo);
									this.since.files.add(repo);
								} else if (mainTexts.has(repo) && mainTexts.get(repo) === text) {
									// Back to main's text: not waiting any more.
									this.since.files.delete(repo);
									this.since.absent.delete(repo);
								}
							}
						}
						this.log(`draft ${next.commit.slice(0, 7)}: ${[...changedFiles].join(', ')}`);
						return { commit: next.commit, files: [...changedFiles], keptDraft: [...kept].filter((f) => changedFiles.has(f)), texts, attempts: attempt };
					} catch (error) {
						const heads = await this.backend.readHeads().catch(() => null);
						const moved = heads !== null && heads.drafts.commit !== head.commit;
						if (!(error instanceof StaleHeadError) && !moved) throw error;
						if (attempt >= MAX_ATTEMPTS) throw new Error(`caracms: drafts kept moving; gave up committing after ${attempt} tries.`);
						this.log(`draft: drafts moved under us; refreshing the copy and merging again`);
						await this.refresh(heads ?? (await this.backend.readHeads()));
					}
				}
			}),
		);
	}

	// ── Discard changes ─────────────────────────────────────────────────────────

	/** These files as `main` has them now (null: it hasn't), in one read of the heads and one of the files. */
	async readMain(files: readonly string[]): Promise<Map<string, string | null>> {
		if (files.length === 0) return new Map();
		const heads = await this.backend.readHeads();
		const read = await this.backend.readFiles(files.map((f) => ({ commit: heads.main.commit, path: this.toRepo(f) })));
		return new Map(files.map((f, i) => [f, read[i] ?? null]));
	}

	/**
	 * Put these files on `drafts` back to what `main` has now (removed where `main` has
	 * none), in one commit headed `Discarded: <titles> — by <person>`. Nothing to change:
	 * no commit. The files leave what's waiting (`since`). A lost race refreshes the copy and
	 * goes again. Returns the commit (null when `drafts` already matched) and each file's
	 * text as it now reads (null: gone).
	 */
	async restoreDrafts(files: readonly string[], titles: readonly string[], by: Person): Promise<{ commit: string | null; texts: Map<string, string | null> }> {
		const result = await this.backend.tracker.within('draft', () =>
			this.exclusive(async () => {
				for (let attempt = 1; ; attempt++) {
					const heads = await this.reread();
					const head = this.head();
					const read = await this.backend.readFiles(files.map((f) => ({ commit: heads.main.commit, path: this.toRepo(f) })));
					const texts = new Map(files.map((f, i) => [f, read[i] ?? null] as [string, string | null]));
					const changed = [...texts].filter(([file, text]) => this.read(file) !== text);
					const settle = (commit: string) => {
						// Every one of them matches main now: none is waiting. Only while the compare is of this main.
						if (this.since && this.since.main === heads.main.commit && this.since.drafts === commit) {
							for (const file of files) {
								this.since.files.delete(this.toRepo(file));
								this.since.absent.delete(this.toRepo(file));
							}
						} else this.since = null;
					};
					if (changed.length === 0) {
						settle(head.commit);
						return { commit: null, texts };
					}
					try {
						const removed = changed.filter(([, text]) => text === null).map(([f]) => this.toRepo(f));
						const writes = changed.filter(([, text]) => text !== null).map(([file, contents]) => ({ path: this.toRepo(file), contents: contents! }));
						const message = discardMessage([...titles], [...files], by);
						const [headline, ...body] = message.split('\n');
						const next = await this.backend.commitOnBranch('drafts', head.commit, writes, removed, headline!, body.join('\n').replace(/^\n/, ''));
						for (const [file, text] of changed) {
							if (text === null) this.copyFiles.delete(file);
							else this.copyFiles.set(file, text);
						}
						this.copyHead = next;
						if (this.since?.drafts === head.commit) {
							this.since.drafts = next.commit;
							this.since.commits.push({ sha: next.commit, parents: [head.commit], message, date: new Date(this.now()).toISOString() });
						}
						settle(next.commit);
						this.historyCache = null;
						this.log(`discarded ${next.commit.slice(0, 7)}: ${files.join(', ')}`);
						return { commit: next.commit, texts };
					} catch (error) {
						const now = await this.backend.readHeads().catch(() => null);
						const moved = now !== null && now.drafts.commit !== head.commit;
						if (!(error instanceof StaleHeadError) && !moved) throw error;
						if (attempt >= MAX_ATTEMPTS) throw new Error(`caracms: drafts kept moving; gave up discarding after ${attempt} tries.`);
						this.log('discard: drafts moved under us; refreshing the copy and trying again');
					}
				}
			}),
		);
		if (result.commit) await this.recordDraftsHead(result.commit);
		// Force-push note: everything rolled back may have just been discarded.
		await this.exclusive(() => this.rollbackSettled());
		return result;
	}

	// ── Keeping drafts up to date with main (Decision 8) ────────────────────────

	/**
	 * Is `main` in `drafts`? If `drafts` is only behind, fast-forward it; if they've
	 * diverged, commit every pending autosave and merge per key. Throttled to once a
	 * minute unless `force` (startup, the webhook, Publish). Concurrent calls share one run.
	 */
	async check(options: { force?: boolean } = {}): Promise<CheckResult> {
		// Not throttled while the cached compare is missing (after a refresh), so waiting() comes back soon.
		if (!options.force && this.since && this.now() - this.lastCheck < this.timings.mainCheckMs) return { kind: 'current' };
		if (this.checking) return this.checking;
		this.lastCheck = this.now();
		this.checking = this.backend.tracker
			.within('check', async () => {
				let pendingCommitted = false;
				for (let attempt = 1; attempt <= MAX_ATTEMPTS + 1; attempt++) {
					const r = await this.exclusive(() => this.checkOnce(pendingCommitted));
					if (r !== 'needs-pending') {
						await this.exclusive(() => this.learnDeletedTitles());
						await this.exclusive(() => this.checkRollback());
						return r;
					}
					await this.commitPending();
					pendingCommitted = true;
				}
				throw new Error('caracms: main and drafts kept moving; gave up keeping drafts up to date.');
			})
			.finally(() => {
				this.checking = null;
			});
		return this.checking;
	}

	private async checkOnce(pendingCommitted: boolean): Promise<CheckResult | 'needs-pending'> {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const heads = await this.reread();
			if (this.since && this.since.main === heads.main.commit && this.since.drafts === heads.drafts.commit) return { kind: 'current' };
			const cmp = await this.backend.compare(heads.drafts.commit, heads.main.commit); // main relative to drafts
			if (cmp.status === 'identical' || cmp.status === 'behind') {
				// main is in drafts: just learn what's waiting.
				await this.learnSince(heads);
				return { kind: 'current' };
			}
			if (cmp.status === 'ahead') {
				const done = await this.fastForward(heads, cmp);
				if (done) return done;
				continue;
			}
			if (!pendingCommitted) return 'needs-pending';
			const merged = await this.merge(heads, cmp);
			if (merged) return merged;
		}
		throw new Error('caracms: drafts kept moving; gave up merging main into it.');
	}

	/** What `drafts` holds beyond `main` (Decision 8's cached compare). */
	private async learnSince(heads: Heads) {
		if (heads.main.commit === heads.drafts.commit) {
			this.since = { main: heads.main.commit, drafts: heads.drafts.commit, commits: [], files: new Set(), absent: new Set() };
			return;
		}
		const cmp = await this.backend.compare(heads.main.commit, heads.drafts.commit);
		this.since = {
			main: heads.main.commit,
			drafts: heads.drafts.commit,
			commits: cmp.commits,
			files: new Set((cmp.files ?? this.diffCopyFallback()).map((f) => (typeof f === 'string' ? f : f.path))),
			// Added on drafts: main doesn't have it. (With too many files to list, none is known to be missing.)
			absent: new Set((cmp.files ?? []).filter((f) => f.status === 'added').map((f) => f.path)),
		};
	}

	/** With too many files for GitHub's compare: every in-scope file counts as possibly waiting. */
	private diffCopyFallback(): string[] {
		this.log('compare listed too many files: treating every content file as possibly waiting');
		return [...this.copyFiles.keys()].map(this.toRepo);
	}

	/** `drafts` only behind `main`: move it up, no merge commit (Decision 8). Null when it lost a race. */
	private async fastForward(heads: Heads, cmp: Comparison): Promise<CheckResult | null> {
		if (!(await this.moveRefs([{ branch: 'drafts', before: heads.drafts.commit, after: heads.main.commit, force: false }]))) return null;
		if (cmp.files === null) await this.download(heads.main);
		else await this.applyChanges(heads.main, cmp);
		this.since = { main: heads.main.commit, drafts: heads.main.commit, commits: [], files: new Set(), absent: new Set() };
		const fromMain = (cmp.files ?? []).filter((f) => this.inScope(f.path)).map((f) => this.toSite(f.path));
		this.log(`drafts fast-forwarded to main (${heads.main.commit.slice(0, 7)})`);
		await this.recordDraftsHead(heads.main.commit);
		await this.told(fromMain);
		return { kind: 'fast-forward', to: heads.main.commit, fromMain };
	}

	/**
	 * `main` and `drafts` diverged: a merge commit (parents drafts, main) whose tree is
	 * `main`'s with `drafts`' changes laid over it, and per-key merges (merge.ts) for
	 * content files changed on both sides. Null when it lost a race.
	 */
	private async merge(heads: Heads, mainSide: Comparison): Promise<CheckResult | null> {
		const draftsSide = await this.backend.compare(heads.main.commit, heads.drafts.commit);
		const base = mainSide.mergeBase.commit;

		// Main's in-scope changes since the merge base. Out-of-scope ones come with main's tree.
		let mainChanged: Map<string, string | null>;
		if (mainSide.files) mainChanged = new Map(mainSide.files.filter((f) => this.inScope(f.path)).map((f) => [f.path, f.sha]));
		else mainChanged = await this.archiveDiff(base, heads.main.commit);
		let draftsChanged: Map<string, string | null>;
		if (draftsSide.files) draftsChanged = new Map(draftsSide.files.map((f) => [f.path, f.sha]));
		else {
			this.log('merge: too many drafts-side files to list; only content files are carried over');
			draftsChanged = await this.archiveDiff(base, heads.drafts.commit);
		}
		// archiveDiff knows texts, not blob shas: drafts' side is then written from the copy.
		const fromCopy = (path: string) => draftsChanged.get(path) === CHANGED;

		const both = [...draftsChanged.keys()].filter((p) => mainChanged.has(p));
		const both3 = both.filter((p) => this.inScope(p));
		const mainOnly = [...mainChanged].filter(([p, sha]) => !draftsChanged.has(p) && sha !== null).map(([p]) => p);
		const reads = [
			...both3.flatMap((p) => [
				{ commit: base, path: p },
				{ commit: heads.main.commit, path: p },
			]),
			...mainOnly.map((p) => ({ commit: heads.main.commit, path: p })),
		];
		const texts = reads.length ? await this.backend.readFiles(reads) : [];

		const changes: TreeChange[] = [];
		const writes: { path: string; contents: string }[] = [];
		const copyAfter = new Map<string, string | null>();
		const keptDraft: string[] = [];
		// Changed only on drafts' side: drafts' version over main's tree. (Content files are plain files.)
		for (const [path, sha] of draftsChanged) {
			if (mainChanged.has(path)) continue;
			if (fromCopy(path)) writes.push({ path, contents: this.read(this.toSite(path))! });
			else changes.push({ path, mode: '100644', sha });
		}
		both3.forEach((path, i) => {
			const site = this.toSite(path);
			const result = mergeFile({ base: texts[i * 2] ?? null, other: texts[i * 2 + 1] ?? null, draft: this.read(site), perKey: path.endsWith('.json') });
			if (result.keptDraft) keptDraft.push(site);
			if (result.text === null) changes.push({ path, mode: '100644', sha: null });
			else writes.push({ path, contents: result.text });
			copyAfter.set(site, result.text);
		});
		// Changed on both sides outside the copy (code pushed to drafts): the draft's version, whole.
		for (const path of both.filter((p) => !this.inScope(p))) changes.push({ path, mode: '100644', sha: draftsChanged.get(path)! });
		mainOnly.forEach((path, i) => copyAfter.set(this.toSite(path), texts[both3.length * 2 + i] ?? null));
		for (const [path, sha] of mainChanged) if (sha === null && !draftsChanged.has(path)) copyAfter.set(this.toSite(path), null);

		const tree = changes.length || writes.length ? await this.backend.createTree(heads.main.tree, changes, writes) : heads.main.tree;
		const fromMain = [...mainChanged.keys()].filter((p) => !draftsChanged.has(p)).map(this.toSite);
		const message = mergeMessage(fromMain, keptDraft);
		const commit = await this.backend.createCommit(tree, [heads.drafts.commit, heads.main.commit], message);
		if (!(await this.moveRefs([{ branch: 'drafts', before: heads.drafts.commit, after: commit, force: false }]))) return null;

		for (const [site, text] of copyAfter) {
			if (text === null) this.copyFiles.delete(site);
			else this.copyFiles.set(site, text);
		}
		this.copyHead = { commit, tree };
		// Which of drafts' files main lacks now: one main deleted (the draft kept it), or one drafts added that main didn't.
		const addedOnDrafts = new Set((draftsSide.files ?? []).filter((f) => f.status === 'added').map((f) => f.path));
		const absent = [...draftsChanged.keys()].filter((p) => (mainChanged.has(p) ? mainChanged.get(p) === null : addedOnDrafts.has(p)));
		this.since = {
			main: heads.main.commit,
			drafts: commit,
			commits: [...draftsSide.commits, { sha: commit, parents: [heads.drafts.commit, heads.main.commit], message, date: new Date(this.now()).toISOString() }],
			files: new Set(draftsChanged.keys()),
			absent: new Set(absent),
		};
		this.log(`merged main into drafts (${commit.slice(0, 7)}): from main [${fromMain.join(', ')}], draft kept [${keptDraft.join(', ')}]`);
		await this.recordDraftsHead(commit);
		await this.told([...copyAfter.keys()]);
		return { kind: 'merged', commit, fromMain, keptDraft };
	}

	/** Hand `tookIn` the files a check just changed in the copy (deleted ones left out). */
	private async told(files: string[]) {
		const changed = [...new Set(files)].flatMap((file) => {
			const text = this.read(file);
			return text === null ? [] : [{ file, text }];
		});
		if (!changed.length) return;
		await this.tookIn(changed).catch((error: unknown) => this.log(`recording what main changed: ${error instanceof Error ? error.message : String(error)}`));
	}

	/** In-scope files that differ between two commits, from their archives (when compare can't list them). */
	private async archiveDiff(from: string, to: string): Promise<Map<string, string | null>> {
		const [a, b] = await Promise.all([this.backend.readArchive(from, (p) => this.inScope(p)), this.backend.readArchive(to, (p) => this.inScope(p))]);
		const out = new Map<string, string | null>();
		for (const p of new Set([...a.keys(), ...b.keys()])) {
			if (a.get(p) === b.get(p)) continue;
			out.set(p, b.has(p) ? CHANGED : null);
		}
		return out;
	}

	/**
	 * Move refs, compare-and-swap. **After any error, re-read both heads** (M1 → G6 (a):
	 * GitHub's error for a stale `beforeOid` is generic): if a head moved, it lost a race,
	 * and the copy is refreshed; returns false. Anything else is thrown. **If every ref
	 * already points where this call moved it**, the move landed and only its answer was
	 * lost: that's a success.
	 */
	private async moveRefs(updates: { branch: Branch; before: string; after: string; force: boolean }[]): Promise<boolean> {
		try {
			await this.backend.updateRefs(updates);
			return true;
		} catch (error) {
			const heads = await this.backend.readHeads();
			if (updates.every((u) => heads[u.branch].commit === u.after)) {
				this.log(`the ref move's answer was lost, but ${updates.map((u) => u.branch).join(' and ')} point where it moved them: it landed`);
				return true;
			}
			const moved = updates.some((u) => heads[u.branch].commit !== u.before);
			if (!moved && !(error instanceof StaleHeadError)) throw error;
			this.log(`a ref moved under us (${updates.map((u) => u.branch).join(', ')}); re-reading and trying again`);
			await this.refresh(heads);
			this.since = null;
			return false;
		}
	}

	// ── Publish (Decision 10) ───────────────────────────────────────────────────

	/**
	 * Publish: commit every pending autosave; refuse to go on unless `main` is in
	 * `drafts` (merging inside the retry loop); one squashed commit with `drafts`' tree on
	 * `main`'s head; both refs moved in one `updateRefs`; after any error, re-read and
	 * start again. Nothing waiting: nothing happens. One Publish at a time per site (a
	 * Redis lock); a second press while one runs joins it.
	 */
	async publish(by: Person): Promise<PublishResult> {
		const lock = this.publishLockKey;
		const token = randomBytes(12).toString('base64url');
		const taken = await landed(this.statusCache, lock, () => this.redis.set(lock, token, { nx: true, px: this.timings.publishLockMs }));
		if (taken) this.statusCache.string(lock, token);
		else {
			const until = this.now() + this.timings.publishLockMs;
			while (this.now() < until && (await this.redis.get(lock)) !== null) await this.sleep(500);
			return { kind: 'joined', record: await this.lastPublish() };
		}
		try {
			return await this.backend.tracker.within('publish', async () => {
				for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
					await this.commitPending();
					const r = await this.exclusive(() => this.publishOnce(by, attempt));
					if (r) return r;
				}
				throw new Error(`caracms: publish gave up after ${MAX_ATTEMPTS} tries (main or drafts kept moving).`);
			});
		} finally {
			// Let go: gone when it was still ours; otherwise (it expired and someone else took it, or the call failed) not known here.
			const gone = await this.redis.compareAndDelete(lock, token).catch(() => false);
			if (gone) this.statusCache.string(lock, null);
			else this.statusCache.drop(lock);
		}
	}

	private async publishOnce(by: Person, attempt: number): Promise<PublishResult | null> {
		const heads = await this.reread();
		if (heads.main.tree === heads.drafts.tree) {
			this.log('publish: nothing waiting');
			return { kind: 'nothing-waiting' };
		}
		const cmp = await this.backend.compare(heads.main.commit, heads.drafts.commit);
		if (cmp.status !== 'ahead' && cmp.status !== 'identical') {
			// A push landed on main (M1 → G6 (e)): merge it in (pending autosaves were just committed), then go round.
			this.log(`publish: main isn't in drafts (${cmp.status}); merging it in first`);
			const mainSide = await this.backend.compare(heads.drafts.commit, heads.main.commit);
			await this.merge(heads, mainSide);
			return null;
		}
		const repoFiles = (cmp.files ?? this.diffCopyFallback().map((path) => ({ path }))).map((f) => f.path);
		const waiting = repoFiles.filter((p) => p.startsWith(this.prefix)).map(this.toSite);
		const { records, addresses } = splitMoves(Object.entries(await this.redis.hgetall(movesKey(this.keyPrefix))));
		// Finding 15: a document the reader would refuse stays waiting; the rest go.
		const held = this.heldBack(waiting, records);
		const files = waiting.filter((f) => !held.has(f));
		if (!files.length) {
			this.log(`publish: nothing publishable; held back ${[...held.keys()].join(', ')}`);
			return { kind: 'held-back', held: [...held.values()] };
		}
		// A file drafts no longer has is deleted: "Contact (deleted)", its title from main's copy first (M5a Decision 12).
		const gone = files.filter((f) => this.read(f) === null);
		const goneTitles = await this.titlesBeforeRemoval(gone, heads.main.commit);
		// Collections under pages: a held document's addresses come from its holder's (only `holds` is read, so no blocks are needed).
		const bases = await heldBasesOf({ ...this.site, blocks: {} }, this.contentSource());
		const moves = this.movesIn(files, records, bases, addresses);
		// A held document whose holder moved keeps its file, unchanged: still one moved item in the headline.
		const readdressed = [...moves.from.keys()].filter((f) => !files.includes(f));
		// Each file's own title (a "stood" notice names the document by it), then the headline's items.
		const fileTitles = files.map((f) => {
			const text = this.read(f);
			return text === null ? goneTitles.get(f)! : titleOf(f, text);
		});
		const items = files.map((f, i) => {
			if (this.read(f) === null) return `${fileTitles[i]!} (deleted)`;
			return moves.from.has(f) ? `${fileTitles[i]!} (moved from ${moves.from.get(f)})` : fileTitles[i]!;
		});
		// Pre-M7 item 8: a moved document is one item in the headline, "Visit (moved from /studio/visit)",
		// listed first; its old file is part of that item, not one of its own.
		const titles = [
			...items.filter((_, i) => moves.from.has(files[i]!)),
			...readdressed.map((f) => `${titleOf(f, this.read(f))} (moved from ${moves.from.get(f)})`),
			...items.filter((_, i) => !moves.from.has(files[i]!) && !moves.to.has(files[i]!)),
		];
		// Finding 15: main's tree is drafts' with the held files as main has them, and drafts
		// gets them back in a commit of its own on top, so they stay waiting.
		const heldFiles = [...held.keys()];
		const onMain = heldFiles.length ? await this.backend.readFiles(heldFiles.map((f) => ({ commit: heads.main.commit, path: this.toRepo(f) }))) : [];
		const tree = heldFiles.length
			? await this.backend.createTree(
					heads.drafts.tree,
					heldFiles.flatMap((f, i) => (onMain[i] === null ? [{ path: this.toRepo(f), mode: '100644', sha: null }] : [])),
					heldFiles.flatMap((f, i) => (onMain[i] === null ? [] : [{ path: this.toRepo(f), contents: onMain[i]! }])),
				)
			: heads.drafts.tree;
		const commit = await this.backend.createCommit(tree, [heads.main.commit], publishMessage(titles, files, by));
		const heldBackMessage = heldFiles.length ? heldMessage([...held.values()].map((h) => h.title), heldFiles, waitingFromCommits(heldFiles, cmp.commits)) : null;
		const draftsHead = heldBackMessage ? await this.backend.createCommit(heads.drafts.tree, [commit], heldBackMessage) : commit;
		const moved = await this.moveRefs([
			// main: a fast-forward onto the squash commit. drafts: not a fast-forward, so
			// `force`, but still compare-and-swap on `before` (M1 → G2).
			{ branch: 'main', before: heads.main.commit, after: commit, force: false },
			{ branch: 'drafts', before: heads.drafts.commit, after: draftsHead, force: true },
		]);
		if (!moved) return null; // the squash commit is left orphaned; nothing points at it
		this.copyHead = { commit: draftsHead, tree: heads.drafts.tree };
		this.since = heldBackMessage
			? {
					main: commit,
					drafts: draftsHead,
					commits: [{ sha: draftsHead, parents: [commit], message: heldBackMessage, date: new Date(this.now()).toISOString() }],
					files: new Set(heldFiles.map(this.toRepo)),
					absent: new Set(heldFiles.filter((_, i) => onMain[i] === null).map(this.toRepo)),
				}
			: { main: commit, drafts: commit, commits: [], files: new Set(), absent: new Set() };
		this.deletedTitles.clear();
		this.historyCache = null;
		const record: PublishRecord = { commit, by, at: new Date(this.now()).toISOString(), files, titles, tryAgainAt: null };
		// The refs moved: the Publish has happened, and it's deploying. Nothing after this may
		// fail it (caracms-cloud adversarial review, finding 6): Redis dropping out now is logged,
		// and the answer is `published` with the record made here.
		try {
			await this.afterPublish(record, draftsHead, records, addresses, bases, held);
		} catch (error) {
			this.unkeptRecord = record;
			this.log(`published ${commit.slice(0, 7)}, but what follows a publish in Redis didn't all happen (${error instanceof Error ? error.message : String(error)}): the status shows this publish from this server's memory until the next one`);
		}
		this.log(`published ${commit.slice(0, 7)} (attempt ${attempt}): ${titles.join(', ')}${heldFiles.length ? `; held back ${heldFiles.join(', ')}` : ''}`);
		return { kind: 'published', record, attempts: attempt, fileTitles, held: [...held.values()] };
	}

	/**
	 * Finding 15: the waiting files Publish leaves waiting, by file: each document the reader
	 * would refuse (document-problems.ts), and a moved one's old file with it (its record, old
	 * file → new), so its live page stays where it is. A deletion is never held back.
	 */
	private heldBack(files: readonly string[], records: ReadonlyMap<string, string>): Map<string, HeldBack> {
		const held = new Map<string, HeldBack>();
		for (const file of files) {
			const text = this.read(file);
			if (text === null || !this.isDocument(file)) continue;
			const [problem] = textProblems(text);
			if (problem) held.set(file, { file, title: titleOf(file, text), reason: problem.reason });
		}
		for (const [old, now] of records) {
			const why = held.get(now);
			if (why && files.includes(old) && !held.has(old)) held.set(old, { ...why, file: old });
		}
		return held;
	}

	/** Is this site file a document of a declared collection (Site Settings and shared blocks included)? */
	private isDocument(file: string): boolean {
		try {
			confinePath(this.site as ResolvedSite, file);
			return true;
		} catch {
			return false;
		}
	}

	/** Publish's Redis work once its refs have moved (finding 6: its caller catches what fails). `draftsHead`: where it left `drafts` (finding 5). */
	private async afterPublish(
		record: PublishRecord,
		draftsHead: string,
		records: ReadonlyMap<string, string>,
		addresses: ReadonlyMap<string, string>,
		bases: Readonly<Record<string, HeldBase>>,
		held: ReadonlyMap<string, HeldBack>,
	): Promise<void> {
		const { files } = record;
		await this.recordDraftsHead(draftsHead);
		if (this.lost) {
			// Finding 5: a Publish since `drafts` was lost is the team carrying on; the note goes.
			this.lost = null;
			await this.redis.del(this.draftsLostKey).catch(() => 0);
		}
		if (this.rolledBack) {
			// Force-push note: what was waiting has been published, rolled-back content and all, by choice.
			this.rolledBack = null;
			await this.redis.del(this.mainRolledBackKey).catch(() => 0);
		}
		// The moves this publish took live are done with (a move made since stays waiting).
		const published = [...records].filter(([old]) => files.includes(old)).map(([old]) => old);
		if (published.length) {
			const moves = movesKey(this.keyPrefix);
			const cleared = await this.redis.hdel(moves, ...published).then(
				() => true,
				() => false,
			);
			if (cleared) this.statusCache.hash(moves, {}, published);
			else this.statusCache.drop(moves);
		}
		// Collections under pages: an address this publish took live is done with; one that
		// changed since (still its live address in what was published) stays waiting.
		const live = withHeldBases(this.site, bases);
		const done = [...addresses].filter(([file, was]) => {
			// Finding 15: a held-back document's live address is still the one recorded.
			if (this.read(file) === null || held.has(file)) return false;
			const url = this.urlOf(live, file);
			return url !== null && url !== was;
		}).map(([file]) => `${ADDRESS_FIELD}${file}`);
		if (done.length) {
			const key = movesKey(this.keyPrefix);
			const cleared = await this.redis.hdel(key, ...done).then(
				() => true,
				() => false,
			);
			if (cleared) this.statusCache.hash(key, {}, done);
			else this.statusCache.drop(key);
		}
		await this.setPublishRecord(record);
	}

	/** The newest publish, from Redis (or this server's own newer one Redis didn't take, finding 6). */
	async lastPublish(): Promise<PublishRecord | null> {
		return this.publishRecordOr(LiveGit.publishRecordFrom(await this.redis.get(this.publishRecordKey)));
	}

	/** A publish record from its text as read (the status cache's, on a poll). */
	static publishRecordFrom(raw: string | null): PublishRecord | null {
		if (!raw) return null;
		try {
			return JSON.parse(raw) as PublishRecord;
		} catch {
			return null;
		}
	}

	// ── What's waiting (Decision 8) ─────────────────────────────────────────────

	/**
	 * Files that differ between `main` and `drafts`, with who changed them and when,
	 * from git (the cached compare plus this server's own commits since). **Never asks
	 * GitHub.** Phase 2 lays Redis's uncommitted autosaves on top.
	 */
	waiting(): (WaitingFile & { title: string; change: WaitingChange })[] {
		if (!this.since) return [];
		const files = [...this.since.files].filter((p) => this.inScope(p)).map(this.toSite);
		return waitingFromCommits(files, this.since.commits).flatMap((w) => {
			const change = this.changeOf(w.file, this.read(w.file));
			return change ? [{ ...w, change, title: this.titleFor(w.file) }] : [];
		});
	}

	/**
	 * Is `text` (null: deleted) what `main` has for this file, as far as this server knows
	 * without asking GitHub? True when the file isn't waiting and `drafts` has that text, or
	 * when it's waiting and `SinceMain.mainTexts` knows `main`'s text is that. False when
	 * unknown (a file another server or a restart put on the list): it stays waiting, as before.
	 */
	matchesMain(sitePath: string, text: string | null): boolean {
		if (!this.since) return false;
		const repo = this.toRepo(sitePath);
		if (!this.since.files.has(repo)) return text === this.read(sitePath);
		const known = this.since.mainTexts?.get(repo);
		return known !== undefined && known === text;
	}

	/**
	 * M5a: does `main` have this file? From the cached compare when the file is waiting
	 * (`absent`), else as `drafts` has it (the two are the same there). Never asks GitHub.
	 */
	mainHas(sitePath: string): boolean {
		const repo = this.toRepo(sitePath);
		if (this.since?.files.has(repo)) return !this.since.absent.has(repo);
		return this.read(sitePath) !== null;
	}

	/**
	 * M5a: what a document whose text is now `text` (null: deleted) is to `main`: `new`,
	 * `deleted` or `changed`; null when it's neither on `main` nor here (made and
	 * deleted again since the last Publish: nothing to publish, so not waiting).
	 */
	changeOf(sitePath: string, text: string | null): WaitingChange | null {
		const onMain = this.mainHas(sitePath);
		if (text === null) return onMain ? 'deleted' : null;
		return onMain ? 'changed' : 'new';
	}

	/** Pre-M7 item 8: the documents a publish moves (`movesIn`), over `drafts`' copy. */
	private movesIn(files: string[], records: ReadonlyMap<string, string>, bases: Readonly<Record<string, HeldBase>>, addresses: ReadonlyMap<string, string>): Moves {
		return movesIn(this.site, files, (f) => this.read(f), records, bases, addresses);
	}

	/** A file's document address on a site with its held bases resolved; null when it isn't a document with one. */
	private urlOf(site: Pick<ResolvedSite, 'root' | 'collections'>, file: string): string | null {
		try {
			const c = confinePath(site as ResolvedSite, file);
			return documentUrl(site.collections[c.collection]!, c.path);
		} catch {
			return null;
		}
	}

	/** A file's title for the waiting list and notices: the copy's, else the title it had when it was deleted, else its name. */
	titleFor(sitePath: string): string {
		const text = this.read(sitePath);
		if (text !== null) return titleOf(sitePath, text);
		return this.deletedTitles.get(sitePath) ?? titleOf(sitePath, null);
	}

	/**
	 * M5a: the title of each deletion waiting to publish that this process hasn't heard of
	 * (a restart, another server's commit), from `main`'s copy of the file, which exists for
	 * any deletion still waiting. So the waiting list names it as the document, not its file.
	 * A failed read leaves the file's name (the same fallback as the commit messages) unsaved, so the next check tries again.
	 */
	private async learnDeletedTitles() {
		if (!this.since) return;
		const missing = [...this.since.files]
			.filter((p) => this.inScope(p))
			.map(this.toSite)
			.filter((f) => this.read(f) === null && this.mainHas(f) && !this.deletedTitles.has(f));
		if (missing.length === 0) return;
		const titles = await this.titlesBeforeRemoval(missing, this.since.main);
		for (const [file, title] of titles) if (title !== titleOf(file, null)) this.deletedTitles.set(file, title);
	}

	/**
	 * Deleted files' titles for the commit messages (M5a Decision 12): `main`'s copy
	 * (one read, only for files `main` has), else `drafts`' copy before the removal,
	 * else the file's name. A failed read falls back the same way.
	 */
	private async titlesBeforeRemoval(files: string[], mainCommit?: string): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		if (files.length === 0) return out;
		const onMain = files.filter((f) => this.mainHas(f));
		let mainTexts: (string | null)[] = [];
		if (onMain.length) {
			try {
				const main = mainCommit ?? this.since?.main ?? (await this.backend.readHeads()).main.commit;
				mainTexts = await this.backend.readFiles(onMain.map((f) => ({ commit: main, path: this.toRepo(f) })));
			} catch (error) {
				this.log(`reading main's copy of deleted files for their titles: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const file of files) {
			const fromMain = mainTexts[onMain.indexOf(file)] ?? null;
			const before = this.read(file);
			const title = fromMain !== null ? titleOf(file, fromMain) : before !== null ? titleOf(file, before) : (this.deletedTitles.get(file) ?? titleOf(file, null));
			out.set(file, title);
		}
		return out;
	}

	/**
	 * Phase 2: each waiting file the merge decided for the draft, with the newest commit
	 * that said so (`Draft-kept:`), so a dismissed notice comes back only for a new
	 * conflict. From the cached compare; never asks GitHub.
	 */
	keptDraftNotices(): { file: string; commit: string }[] {
		if (!this.since) return [];
		const waiting = new Set([...this.since.files].filter((p) => this.inScope(p)).map(this.toSite));
		const out = new Map<string, string>();
		for (const c of this.since.commits) {
			const parsed = parseMessage(c.message);
			for (const file of parsed.discardedFiles) out.delete(file); // a discard ends the notice's reason
			for (const file of parsed.keptDraft) if (waiting.has(file)) out.set(file, c.sha);
		}
		return [...out].map(([file, commit]) => ({ file, commit }));
	}

	// ── Publish status (Decision 12) ────────────────────────────────────────────

	/** The newest publish's state. Asks GitHub at most every `deploymentReadMs`, and only while it isn't live. */
	async publishStatus(options: { record?: PublishRecord | null } = {}): Promise<PublishStatus> {
		// `record`: the newest publish as the caller read it (the status poll's cache); otherwise read here.
		const record = options.record !== undefined ? options.record : await this.lastPublish();
		if (!record) return { state: 'none', record: null, assumed: false, canTryAgain: false };
		const running = this.runningCommit();
		if (running === null) {
			if (!this.assumedLogged) {
				this.assumedLogged = true;
				this.log('no running commit known (CARACMS_RUNNING_COMMIT, a host\'s commit variable, or one baked in at build): a publish reads as live once its refs moved');
			}
			return { state: 'live', record, assumed: true, canTryAgain: false };
		}
		return this.backend.tracker.within('status', async () => {
			const includes = running === record.commit ? true : await this.includes(record.commit, running);
			let facts: DeploymentFact[] = [];
			let later = new Set<string>();
			if (!includes) ({ facts, later } = await this.deploymentFacts(record));
			const { state } = publishState({ record, running, runningIncludesPublish: includes, laterOnMain: later, deployments: facts, now: this.now(), slowAfterMs: this.timings.publishSlowMs });
			return { state, record, assumed: false, canTryAgain: (state === 'failed' || state === 'slow') && this.redeployer !== null };
		});
	}

	// ── `main` rolled back (force-push note) ─────────────────────────────────────

	/**
	 * After a check: does `main` still have the last Publish's commit? Only rewritten history
	 * loses it (a push on top, a merge or a revert keeps it). One compare per pair; never
	 * fails the check.
	 */
	private async checkRollback(): Promise<void> {
		try {
			const record = await this.lastPublish();
			if (!record) {
				this.rolledBack = null;
				return;
			}
			const main = this.since?.main ?? (await this.backend.readHeads()).main.commit;
			const pair = `${record.commit}:${main}`;
			if (pair !== this.rollbackPair) {
				const has = await this.mainHasPublish(record.commit, main);
				if (has === null) {
					// GitHub doesn't know the commit (another repo's record, or long gone): can't tell, so no note.
					if (this.rollbackUnknown !== record.commit) this.log(`the last Publish's commit (${record.commit.slice(0, 7)}) isn't on GitHub: can't tell whether main was rolled back`);
					this.rollbackUnknown = record.commit;
					this.rolledBack = null;
				} else if (has) {
					if (this.rolledBack || this.rollbackPair === null) await this.redis.del(this.mainRolledBackKey);
					this.rolledBack = null;
				} else {
					const kept = this.rolledBack?.publish === record.commit ? this.rolledBack : parseRolledBack(await this.redis.get(this.mainRolledBackKey));
					if (kept && kept.publish === record.commit) this.rolledBack = kept;
					else {
						this.rolledBack = { publish: record.commit, main, at: new Date(this.now()).toISOString() };
						await this.redis.set(this.mainRolledBackKey, JSON.stringify(this.rolledBack));
						this.log(
							`MAIN WAS ROLLED BACK: main (${main.slice(0, 7)}) no longer has the last Publish's commit (${record.commit.slice(0, 7)}), so its history was rewritten (a force-push). What was rolled back is waiting in the editor again, and the next Publish puts it back; editors are told to discard what they don't want first.`,
						);
					}
				}
				this.rollbackPair = pair;
			}
			await this.rollbackSettled();
		} catch (error) {
			this.log(`checking whether main was rolled back: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Force-push note: with nothing waiting (all of it discarded), the note is done with for this rollback, on every server. */
	private async rollbackSettled(): Promise<void> {
		const note = this.rolledBack;
		if (!note || note.cleared || !this.since || this.waiting().length > 0) return;
		this.rolledBack = { ...note, cleared: true };
		this.log(`main's rollback: nothing is waiting any more, so the note is done with`);
		await this.redis.set(this.mainRolledBackKey, JSON.stringify(this.rolledBack)).catch((error: unknown) => {
			this.log(`keeping the rollback note's end: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	/** Is the Publish's `commit` in `main`? Null when GitHub doesn't have it. One compare per pair, per server. */
	private async mainHasPublish(commit: string, main: string): Promise<boolean | null> {
		if (commit === main) return true;
		const key = `${commit}:${main}`;
		const known = this.onMainCache.get(key);
		if (known !== undefined) return known;
		try {
			const cmp = await this.backend.compare(commit, main);
			const yes = cmp.status === 'ahead' || cmp.status === 'identical';
			this.onMainCache.set(key, yes); // ancestry never changes
			return yes;
		} catch (error) {
			if (error instanceof HttpError && (error.status === 404 || error.status === 422)) return null;
			throw error;
		}
	}

	/** Is `commit` in `running` (the same, or an ancestor)? One compare per pair, per server. */
	private async includes(commit: string, running: string): Promise<boolean> {
		const key = `${commit}:${running}`;
		const known = this.includesCache.get(key);
		if (known !== undefined) return known;
		let yes = false;
		try {
			const cmp = await this.backend.compare(commit, running);
			yes = cmp.status === 'ahead' || cmp.status === 'identical';
		} catch (error) {
			if (!(error instanceof HttpError && error.status === 404)) throw error; // the running commit isn't in this repo
		}
		this.includesCache.set(key, yes); // ancestry never changes: one compare per pair
		return yes;
	}

	private async deploymentFacts(record: PublishRecord): Promise<{ facts: DeploymentFact[]; later: Set<string> }> {
		const key = `${record.commit}:${record.tryAgainAt ?? ''}`;
		const cached = this.deploymentsCache;
		if (cached && cached.key === key && this.now() - cached.at < this.timings.deploymentReadMs) return cached;
		if (this.deploymentsDenied) return { facts: [], later: new Set() };
		let facts: DeploymentFact[] = [];
		let later = new Set<string>();
		try {
			// main's head from the cached compare when there is one (Decision 8 keeps it fresh), else one ref read.
			const main = this.since?.main ?? (await this.backend.readHeads()).main.commit;
			if (main !== record.commit) {
				if (this.laterCache?.key !== `${record.commit}:${main}`) {
					const cmp = await this.backend.compare(record.commit, main);
					this.laterCache = { key: `${record.commit}:${main}`, later: new Set(cmp.commits.map((c) => c.sha)) };
				}
				later = this.laterCache.later;
			}
			const deployments = (await this.backend.listDeployments(30)).filter((d) => d.sha === record.commit || later.has(d.sha));
			for (const d of deployments.slice(0, 5)) {
				const s = await this.backend.deploymentStatus(d.id);
				facts.push({ sha: d.sha, createdAt: d.createdAt, state: s?.state ?? null });
			}
		} catch (error) {
			if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
				this.deploymentsDenied = true;
				this.log(`can't read GitHub Deployments (${error.status}): the site's GitHub token or App needs "Deployments: read" to tell a failed publish. Without it, a publish shows as publishing until the server runs it, then as taking longer than usual.`);
				return { facts: [], later: new Set() };
			}
			throw error;
		}
		this.deploymentsCache = { key, at: this.now(), facts, later };
		return this.deploymentsCache;
	}

	// ── History (Decision 12) ───────────────────────────────────────────────────

	/** The newest 20 publishes from `main`'s commits, cached; `refresh` asks again at most once a minute. */
	async history(options: { refresh?: boolean } = {}): Promise<HistoryEntry[]> {
		const cached = this.historyCache;
		if (cached && (!options.refresh || this.now() - cached.at < this.timings.historyMs)) return cached.entries;
		return this.backend.tracker.within('history', async () => {
			const commits = await this.backend.listCommits('main', 100);
			const status = await this.publishStatus();
			const running = this.runningCommit();
			const runningAt = running === null ? -1 : commits.findIndex((c) => c.sha === running);
			const entries: HistoryEntry[] = [];
			commits.forEach((c, i) => {
				if (entries.length >= 20) return;
				const parsed = parseMessage(c.message);
				if (parsed.kind !== 'publish') return;
				const live = running === null || (runningAt !== -1 && i >= runningAt) || (status.record?.commit === c.sha && status.state === 'live');
				const pending: PublishState = status.state === 'failed' || status.state === 'slow' ? status.state : 'publishing';
				entries.push({ commit: c.sha, by: parsed.publishedBy, at: c.date, titles: parsed.titles, files: parsed.publishedFiles, state: live ? 'live' : pending });
			});
			this.historyCache = { at: this.now(), entries };
			return entries;
		});
	}

	// ── Try again (Decision 12) ─────────────────────────────────────────────────

	/**
	 * Redeploy through the redeployer (runs-anywhere Decision 11): Railway's API with the
	 * project token, or the deploy hook's one POST. Never publishes again, and never
	 * retries by itself. A success restarts the "taking longer than usual" clock.
	 */
	async tryAgain(): Promise<{ ok: true } | { ok: false; reason: string }> {
		if (!this.redeployer) return { ok: false, reason: NO_REDEPLOYER_REASON };
		const record = await this.lastPublish();
		if (!record) return { ok: false, reason: 'Nothing has been published.' };
		const r = this.redeployer.kind === 'hook' ? await this.callHook(this.redeployer) : await this.redeployOnRailway(this.redeployer);
		if (!r.ok) return r;
		await this.setPublishRecord({ ...record, tryAgainAt: new Date(this.now()).toISOString() });
		this.deploymentsCache = null;
		this.log(`try again: ${this.redeployer.kind === 'hook' ? 'the deploy hook took it' : 'Railway is redeploying'} (publish ${record.commit.slice(0, 7)})`);
		return { ok: true };
	}

	private async redeployOnRailway(railway: Extract<Redeployer, { kind: 'railway' }>): Promise<{ ok: true } | { ok: false; reason: string }> {
		const { token, serviceId, environmentId } = railway;
		const res = await (railway.fetch ?? fetch)(RAILWAY_API, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'project-access-token': token },
			body: JSON.stringify({
				query: 'mutation($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }',
				variables: { serviceId, environmentId },
			}),
		});
		const body = (await res.json().catch(() => ({}))) as { data?: { serviceInstanceRedeploy?: boolean }; errors?: { message: string }[] };
		if (!res.ok || body.errors?.length || !body.data?.serviceInstanceRedeploy) {
			const reason = body.errors?.map((e) => e.message).join('; ') || `the host answered ${res.status}`;
			this.log(`try again: Railway refused the redeploy (${reason})`);
			return { ok: false, reason };
		}
		return { ok: true };
	}

	/** The deploy hook: one POST, no body, no extra headers; any 2xx is success. The URL is never logged or returned. */
	private async callHook(hook: Extract<Redeployer, { kind: 'hook' }>): Promise<{ ok: true } | { ok: false; reason: string }> {
		let reason: string;
		try {
			const res = await (hook.fetch ?? fetch)(hook.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(hook.timeoutMs ?? DEPLOY_HOOK_TIMEOUT_MS) });
			await res.body?.cancel().catch(() => {});
			if (res.status >= 200 && res.status < 300) return { ok: true };
			reason = `the deploy hook answered ${res.status}`;
		} catch (error) {
			const name = error instanceof Error ? error.name : '';
			reason = name === 'TimeoutError' || name === 'AbortError' ? "the deploy hook didn't answer in time" : "the deploy hook couldn't be reached";
		}
		this.log(`try again: ${reason}`);
		return { ok: false, reason };
	}
}

export interface Moves {
	/** The new file → its old address. */
	from: Map<string, string>;
	/** The old file → its new address. */
	to: Map<string, string>;
}

/**
 * Pre-M7 item 8: which of these changed files are documents moved, from the moves
 * recorded as they were made (`records`, old file → new file: autosaves.ts → `moves`),
 * never from Site Settings' redirects, so a move stays a move whether or not the
 * editor keeps its redirect. A record counts while both files are among `files`, the
 * old one gone (`read` null) and the new one there. Publish's headline and the waiting
 * list read it ("Visit (moved from /studio/visit)").
 */
export function movesIn(
	site: Pick<ResolvedSite, 'root' | 'collections'>,
	files: readonly string[],
	read: (file: string) => string | null,
	records: ReadonlyMap<string, string>,
	/** Collections under pages: the held collections' resolved bases (held.ts), so a held document's move has addresses. */
	bases: Readonly<Record<string, HeldBase>> = {},
	/**
	 * Collections under pages: each moved document's live address, by its file now
	 * (autosaves.ts → `recordAddresses`). It wins over one worked out from the old file
	 * (whose holder may have moved too), and names a held document whose holder moved,
	 * whose file stays as it is: that one counts whether or not its file is among `files`.
	 */
	addresses: ReadonlyMap<string, string> = new Map(),
): Moves {
	site = withHeldBases(site, bases);
	const from = new Map<string, string>();
	const to = new Map<string, string>();
	const urlOf = (file: string) => {
		try {
			const c = confinePath(site as ResolvedSite, file);
			return documentUrl(site.collections[c.collection]!, c.path);
		} catch {
			return null;
		}
	};
	const changed = new Set(files);
	for (const [old, moved] of records) {
		if (old === moved || !changed.has(old) || !changed.has(moved) || from.has(moved) || to.has(old)) continue;
		if (read(old) !== null || read(moved) === null) continue;
		const fromUrl = addresses.get(moved) ?? urlOf(old);
		const toUrl = urlOf(moved);
		if (!fromUrl || !toUrl) continue;
		from.set(moved, fromUrl);
		to.set(old, toUrl);
	}
	for (const [file, live] of addresses) {
		if (from.has(file) || to.has(file) || read(file) === null) continue;
		const url = urlOf(file);
		if (url && url !== live) from.set(file, live);
	}
	return { from, to };
}

/** A file's title for messages: the document's `title`, else its name title-cased. */
export function titleOf(file: string, text: string | null): string {
	if (text !== null) {
		try {
			const t = (JSON.parse(text) as { title?: unknown } | null)?.title;
			if (typeof t === 'string' && t.trim()) return t.trim();
		} catch {
			/* not JSON: use the name */
		}
	}
	const name = file.split('/').pop()!.replace(/\.json$/, '');
	return name.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
