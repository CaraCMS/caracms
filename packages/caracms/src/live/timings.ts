/** Live mode's timings (M4 Phase 1). */

/**
 * Every timing live mode uses, in one place so tests shorten them (Decision 2). The
 * sweep's and the locks' are Phase 2's; they're defined here so the runtime carries one set.
 */
export interface LiveTimings {
	/** Decision 8: status reads check `main` at most this often. */
	mainCheckMs: number;
	/** Decision 13: the deployments are read at most this often while a publish is in flight. */
	deploymentReadMs: number;
	/** Decision 12: history is refreshed at most this often. */
	historyMs: number;
	/** How long the Publish lock lasts if its holder dies (Decision 10: one Publish at a time). */
	publishLockMs: number;
	/** Phase 2 (Decision 5): the sweep's tick. */
	sweepTickMs: number;
	/** Phase 2 (Decision 5): an autosave is committed once its document has been idle this long. */
	sweepIdleMs: number;
	/** Phase 2 (Decision 5): …and at least this often while someone keeps typing. */
	sweepCapMs: number;
	/** Phase 2 (Decision 9): a lock lapses this long after the last heartbeat (once committed). */
	lockLapseMs: number;
	/** Take over (2026-10-15): a tab renews its lock only while someone typed, clicked or scrolled in it this recently. */
	lockIdleMs: number;
	/** Phase 2 (Decision 9): someone is "on" a document while they polled with it this recently. */
	presenceMs: number;
	/** Decision 4: autosaves expire after this long, as a backstop. */
	autosaveTtlMs: number;
	/** Decision 13: each tab polls the status this often (the editor's POLL_MS; /admin passes it to the page). */
	pollMs: number;
	/** Runs-anywhere Decision 10: a publish not live this long after it was made (or its last Try again) reads as taking longer than usual. */
	publishSlowMs: number;
	/** Runs-anywhere (Watch-outs): Publish's request answers by this long, well inside Cloudflare's 100 s; the Publish carries on past it. */
	publishAnswerMs: number;
	/** Redis diet Decision 1: the status poll's cached reads are re-read from Redis once this old (counted from the last Redis read). */
	statusCacheMs: number;
	/** Redis diet Decision 6: a tab's heartbeat goes only once its lock's last beat is this old (or to take the lock back). */
	beatEveryMs: number;
	/** Redis diet Decision 8: a visible tab with no input this long polls at `slowPollMs` (/admin passes it to the page). */
	idleSlowAfterMs: number;
	/** Redis diet Decision 8: an idle tab's poll interval (/admin passes it to the page). */
	slowPollMs: number;
	/** Redis diet Decision 10: once the tab holds the document, a keep goes this long after the last change (/admin passes it to the page). */
	keepDelayMs: number;
	/** Redis diet Decision 10: …and never later than this after the first change not yet sent (/admin passes it to the page). */
	keepCapMs: number;
}

export const DEFAULT_TIMINGS: LiveTimings = {
	mainCheckMs: 60_000,
	deploymentReadMs: 10_000,
	historyMs: 60_000,
	publishLockMs: 120_000,
	sweepTickMs: 30_000,
	sweepIdleMs: 60_000,
	sweepCapMs: 5 * 60_000,
	lockLapseMs: 2 * 60_000,
	lockIdleMs: 10 * 60_000,
	presenceMs: 15_000,
	autosaveTtlMs: 7 * 24 * 60 * 60_000,
	pollMs: 5000,
	publishSlowMs: 15 * 60_000,
	publishAnswerMs: 60_000,
	statusCacheMs: 30_000,
	beatEveryMs: 30_000,
	idleSlowAfterMs: 2 * 60_000,
	slowPollMs: 30_000,
	keepDelayMs: 3000,
	keepCapMs: 15_000,
};
