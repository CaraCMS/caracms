/**
 * What's waiting, and whether a publish went live (M4 Decisions 5, 8, 12), as pure
 * functions over facts read from git and GitHub, so they can be tested from
 * fixtures. git.ts gathers the facts.
 */
import type { CommitSummary } from './backend.ts';
import { parseMessage, type Person } from './messages.ts';

// ── Waiting ───────────────────────────────────────────────────────────────────

export interface WaitingFile {
	/** Site-relative path. */
	file: string;
	/** Who changed it since the last publish, most recent first, each once. */
	editors: { person: Person; at: string }[];
	/** The newest of those changes (ISO); null when no commit names an editor (a push straight to drafts). */
	changedAt: string | null;
	/** A merge or a commit decided a key or the file for the draft: the merge notice's data (Decision 7). */
	keptDraft: boolean;
}

/**
 * The waiting list from git alone: `files` are the files that differ between `main`
 * and `drafts`, `commits` the commits on `drafts` since `main` (oldest first), whose
 * messages (messages.ts) say who changed what. Newest change first.
 */
export function waitingFromCommits(files: Iterable<string>, commits: CommitSummary[]): WaitingFile[] {
	const out = new Map<string, WaitingFile>();
	for (const file of files) out.set(file, { file, editors: [], changedAt: null, keptDraft: false });
	for (const commit of commits) {
		const parsed = parseMessage(commit.message);
		// A discard: what came before about its files no longer counts (they matched `main` after it).
		for (const file of parsed.discardedFiles) {
			const w = out.get(file);
			if (w) Object.assign(w, { editors: [], changedAt: null, keptDraft: false });
		}
		for (const edit of parsed.edits) {
			for (const file of edit.files) {
				const w = out.get(file);
				if (!w) continue;
				const email = edit.person.email.toLowerCase();
				w.editors = [{ person: edit.person, at: commit.date }, ...w.editors.filter((e) => e.person.email.toLowerCase() !== email)];
				if (!w.changedAt || commit.date >= w.changedAt) w.changedAt = commit.date;
			}
		}
		for (const file of parsed.keptDraft) {
			const w = out.get(file);
			if (w) w.keptDraft = true;
		}
	}
	return [...out.values()].sort((a, b) => (b.changedAt ?? '').localeCompare(a.changedAt ?? '') || a.file.localeCompare(b.file));
}

// ── Publish status ────────────────────────────────────────────────────────────

/** The newest publish, kept in Redis so a server replaced mid-publish still knows it (Watch-outs). */
export interface PublishRecord {
	/** The squashed commit on `main`. */
	commit: string;
	by: Person;
	/** ISO. */
	at: string;
	/** Site-relative paths published. */
	files: string[];
	titles: string[];
	/** When Try again last redeployed (ISO): deployments older than this don't count. */
	tryAgainAt: string | null;
}

/**
 * `slow` (runs-anywhere Decision 10): still not live well after it was made, or after its
 * last Try again, with no failure known: "taking longer than usual. It may have failed."
 */
export type PublishState = 'publishing' | 'live' | 'failed' | 'slow';

/** One GitHub Deployment and its newest status (null: no status yet). */
export interface DeploymentFact {
	sha: string;
	createdAt: string;
	state: string | null;
}

/** Statuses that are an answer. `in_progress`, `queued` and `pending` aren't: Railway leaves skipped deploys `in_progress` for good. */
const FINAL = new Set(['success', 'failure', 'error', 'inactive']);

export interface PublishFacts {
	record: PublishRecord;
	/** The running server's commit (mode.ts → `runningCommitFrom`), or null with none known. */
	running: string | null;
	/** Is `running` the publish commit or a descendant of it? null when not known (not asked). */
	runningIncludesPublish: boolean | null;
	/** Commits on `main` after the publish commit. */
	laterOnMain: ReadonlySet<string>;
	/** The repo's deployments, any order. */
	deployments: DeploymentFact[];
	/** Now (ms), and how long a publish may take before it reads as `slow` (`LiveTimings.publishSlowMs`). Either unset: never slow. */
	now?: number;
	slowAfterMs?: number;
}

/**
 * Decision 12:
 * - **live**: the running server's commit is the publish commit or after it; or, on a
 *   server with no running commit at all (no deploy pipeline), once the refs moved,
 *   which they had for a publish record to exist.
 * - **failed**: the newest deployment that has *answered*, for the publish commit or
 *   a later commit on `main` (since the last Try again), says `failure` or `error`.
 *   A deployment stuck `in_progress` is never read as finished or failed.
 * - **slow** (runs-anywhere Decision 10): not live and not failed, `slowAfterMs` after the
 *   publish was made, or after its last Try again (`tryAgainAt`). Without deployments a
 *   failure can never be known, and on Railway a skipped deploy stays `in_progress` for
 *   good; a running commit that isn't in the repo never includes the publish either.
 * - **publishing**: otherwise.
 */
export function publishState(f: PublishFacts): { state: PublishState; assumed: boolean } {
	if (f.running === null) return { state: 'live', assumed: true };
	if (f.running === f.record.commit || f.runningIncludesPublish) return { state: 'live', assumed: false };
	const since = f.record.tryAgainAt ?? '';
	const answered = f.deployments
		.filter((d) => (d.sha === f.record.commit || f.laterOnMain.has(d.sha)) && d.createdAt >= since && d.state !== null && FINAL.has(d.state))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const newest = answered[0];
	if (newest && (newest.state === 'failure' || newest.state === 'error')) return { state: 'failed', assumed: false };
	if (f.now !== undefined && f.slowAfterMs !== undefined && f.now - Date.parse(f.record.tryAgainAt ?? f.record.at) >= f.slowAfterMs) return { state: 'slow', assumed: false };
	return { state: 'publishing', assumed: false };
}
