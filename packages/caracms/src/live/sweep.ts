/**
 * The sweep (M4 Decisions 5 and 6): it carries autosaves from Redis into `drafts`.
 *
 * - **A document's autosave is committed once it has been idle for `sweepIdleMs`**, and
 *   at least every `sweepCapMs` while someone keeps typing (measured from the first
 *   write since its last commit). **One marked `sweepAtOnce`** (Site Settings', M5a
 *   Decision 10) is ready on the next tick, with no idle wait.
 * - **One commit per tick for everything ready** (`git.commitDrafts`), never one per
 *   editor or per document (M1 → G4). Each autosave is merged with `drafts` (Decision
 *   6); its ancestor is the session's last commit, else its base (autosaves.ts).
 * - **It ticks every `sweepTickMs`, but only while something is pending**: from the
 *   first autosave this server sees until nothing is left. **With nothing pending it
 *   makes no Redis call at all**, so Railway's Redis can sleep (Decision 17, M1 → R1).
 *   One check at startup (`start`) picks up what a previous server left behind; the
 *   status route `poke`s it when a poll sees autosaves, in case they came in on the
 *   other server during a deploy and that server went away.
 * - **Each tick takes a short Redis lock first**: during a deploy two servers sweep.
 * - `commitAll` commits everything pending now, idle or not: Publish's step 1
 *   (Decision 10) through `git.commitPending`, and Decision 8's merge.
 * - After a commit an autosave is deleted only if no newer write replaced it (a
 *   compare-and-delete); a newer one stays, with its cap restarted. Then a lock whose
 *   only reason to hold was that autosave is dropped (Decision 9: commit, then release).
 * - **New and deleted documents** (M5a) are autosaves like any other: a new one's text
 *   is committed as an added file (its ancestor is what `drafts` had there, autosaves.ts
 *   → `ancestorFor`), a "gone" one as a removed file (git.ts → `commitDrafts`). A newer
 *   write that came in while a new document was being committed is no longer a new
 *   document: its `created` mark is dropped (retried if a write beats the swap), so its ancestor is that commit.
 * - **`exclusively`** runs other work under the sweep's own locks (this process's queue and
 *   the Redis lock): Discard changes, so no tick commits the edit being thrown away while
 *   it's being thrown away. It waits a few seconds for another server's tick, then gives
 *   up (`SweepBusyError`) rather than go ahead without the lock.
 */
import { randomBytes } from 'node:crypto';
import type { DraftEntry, LiveGit } from './git.ts';
import type { Autosaves, Read, Autosave } from './autosaves.ts';
import type { Locks } from './locks.ts';
import type { RedisClient } from './redis.ts';
import type { LiveTimings } from './timings.ts';

export type Schedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (fn, ms) => {
	const t = setTimeout(fn, ms);
	t.unref?.();
	return () => clearTimeout(t);
};

export interface SweepOptions {
	redis: RedisClient;
	git: Pick<LiveGit, 'commitDrafts'>;
	autosaves: Autosaves;
	locks: Locks;
	timings: LiveTimings;
	now: () => number;
	schedule?: Schedule;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	prefix?: string;
}

export interface SweepResult {
	commit: string | null;
	/** Files committed (or found already in `drafts`). */
	files: string[];
	/** False when another server held the sweep's lock and this tick did nothing. */
	ran: boolean;
}

type Select = 'ready' | 'all' | { files: string[] };

/** `exclusively` couldn't get the sweep's Redis lock: another server's tick held it throughout. */
export class SweepBusyError extends Error {
	constructor() {
		super('the sweep is busy on another server');
		this.name = 'SweepBusyError';
	}
}

/** Is an autosave ready for a tick: marked to go at once, idle long enough, or past the cap? */
export function ready(a: Autosave, now: number, timings: Pick<LiveTimings, 'sweepIdleMs' | 'sweepCapMs'>): boolean {
	return a.sweepAtOnce === true || now - a.updatedAt >= timings.sweepIdleMs || now - a.firstAt >= timings.sweepCapMs;
}

export class Sweep {
	/** Ticking: something is (or may be) pending. */
	active = false;
	/** Bumped by every poke, so a run that found nothing doesn't stop a sweep a write started meanwhile. */
	private pokes = 0;
	private cancel: (() => void) | null = null;
	private running: Promise<unknown> = Promise.resolve();
	private readonly o: SweepOptions;
	private readonly schedule: Schedule;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly log: (line: string) => void;
	private readonly lockKey: string;

	constructor(options: SweepOptions) {
		this.o = options;
		this.schedule = options.schedule ?? defaultSchedule;
		this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.log = options.log ?? ((line) => console.log(`[caracms] ${line}`));
		this.lockKey = `${options.prefix ?? 'caracms:'}sweep:lock`;
	}

	/**
	 * The startup check: anything a previous server left behind starts the ticking. An
	 * autosave that still carries the week's expiry older versions gave it loses it
	 * (caracms-cloud adversarial review, finding 4: an uncommitted edit never expires).
	 */
	async start(): Promise<void> {
		const pending = await this.o.autosaves.all();
		if (pending.length) {
			this.log(`sweep: ${pending.length} autosave(s) waiting from before this server started`);
			for (const a of pending) await this.o.autosaves.keepForever(a);
			this.poke();
		}
	}

	/** An autosave arrived (or was seen): tick until nothing is pending. */
	poke(): void {
		this.pokes++;
		if (this.active) return;
		this.active = true;
		this.arm();
	}

	/** Stop ticking (tests, shutdown). */
	stop(): void {
		this.cancel?.();
		this.cancel = null;
		this.active = false;
	}

	private arm() {
		this.cancel?.();
		this.cancel = this.schedule(() => {
			this.cancel = null;
			void this.tick().catch((error: unknown) => this.log(`sweep: ${error instanceof Error ? error.message : String(error)}`));
		}, this.o.timings.sweepTickMs);
	}

	/** One tick: commit what's ready. Keeps ticking while anything is left; goes quiet when nothing is. */
	async tick(): Promise<SweepResult> {
		let left = true;
		const pokes = this.pokes;
		try {
			const r = await this.run('ready');
			left = r.left;
			return r.result;
		} finally {
			if (this.active) {
				if (left || this.pokes !== pokes) this.arm();
				else this.stop();
			}
		}
	}

	/** Commit every pending autosave now (Publish's step 1, Decision 8's merge). */
	async commitAll(): Promise<SweepResult> {
		const pokes = this.pokes;
		const r = await this.run('all');
		if (!r.left && this.active && this.pokes === pokes) this.stop();
		return r.result;
	}

	/** Commit these files' autosaves now (a lock moved under an autosave from another tab). */
	async commitFiles(files: string[]): Promise<SweepResult> {
		return (await this.run({ files })).result;
	}

	/**
	 * Run `fn` holding the sweep's locks: after any run of this process's in flight, and with
	 * the Redis lock (waiting up to about 5 s for another server's tick, else SweepBusyError).
	 */
	exclusively<T>(fn: () => Promise<T>): Promise<T> {
		const work = async (): Promise<T> => {
			const { redis, timings } = this.o;
			const token = randomBytes(9).toString('base64url');
			const lockMs = Math.max(30_000, timings.sweepTickMs);
			let locked = await redis.set(this.lockKey, token, { nx: true, px: lockMs });
			for (let i = 0; i < 20 && !locked; i++) {
				await this.sleep(250);
				locked = await redis.set(this.lockKey, token, { nx: true, px: lockMs });
			}
			if (!locked) throw new SweepBusyError();
			try {
				return await fn();
			} finally {
				await redis.compareAndDelete(this.lockKey, token).catch(() => false);
			}
		};
		const next = this.running.then(work, work);
		this.running = next.catch(() => {});
		return next;
	}

	/** Runs one at a time in this process; the Redis lock keeps two servers apart. */
	private run(select: Select): Promise<{ result: SweepResult; left: boolean }> {
		const next = this.running.then(
			() => this.once(select),
			() => this.once(select),
		);
		this.running = next.catch(() => {});
		return next;
	}

	private async once(select: Select): Promise<{ result: SweepResult; left: boolean }> {
		const { redis, autosaves, timings, now } = this.o;
		const token = randomBytes(9).toString('base64url');
		const lockMs = Math.max(30_000, timings.sweepTickMs);
		let locked = await redis.set(this.lockKey, token, { nx: true, px: lockMs });
		if (!locked) {
			// Another server is sweeping. A tick leaves it to them; a commit-everything waits briefly, then goes anyway (commits are compare-and-swap).
			if (select === 'ready') return { result: { commit: null, files: [], ran: false }, left: true };
			for (let i = 0; i < 20 && !locked; i++) {
				await this.sleep(250);
				locked = await redis.set(this.lockKey, token, { nx: true, px: lockMs });
			}
		}
		try {
			const all = await autosaves.all();
			const t = now();
			const chosen =
				select === 'all'
					? all
					: select === 'ready'
						? all.filter((a) => ready(a.value, t, timings))
						: all.filter((a) => select.files.includes(a.value.file));
			if (chosen.length === 0) return { result: { commit: null, files: [], ran: true }, left: all.length > 0 };
			const result = await this.commit(chosen);
			return { result, left: all.length > result.removed };
		} finally {
			if (locked) await redis.compareAndDelete(this.lockKey, token).catch(() => false);
		}
	}

	private async commit(chosen: Read<Autosave>[]): Promise<SweepResult & { removed: number }> {
		const { autosaves, locks, git, now } = this.o;
		// (M5a) `text` is null for a deletion, which commitDrafts commits as a removed file.
		const entries: DraftEntry[] = [];
		for (const a of chosen) {
			const ancestor = await autosaves.ancestorFor(a.value);
			// Worth a line when an editing session's record exists but wasn't used whole: the "kept draft" notice turns on it.
			if (ancestor.from !== 'session' && ancestor.from !== 'base') this.log(`sweep: ${a.value.file} merged against ${ancestor.from}`);
			entries.push({ file: a.value.file, base: ancestor.text, text: a.value.text, editor: a.value.editor });
		}
		const r = await git.commitDrafts(entries);
		let removed = 0;
		const at = now();
		for (const a of chosen) {
			const { file, tab, base, text, editor } = a.value;
			await autosaves.setCommitted(file, { tab, base, text, at, editor: editor.email.toLowerCase() });
			if (await autosaves.removeIf(a)) {
				removed++;
				await locks.dropIfFree(file);
				continue;
			}
			// A newer write came in while committing: it stays, and its cap starts again from this commit.
			// A document this commit created isn't new any more (M5a): the commit is the newer write's ancestor
			// (so is any `ancestor` it carried from before the commit).
			// A write can land between the get and the replaceIf (it copies `created` forward again), so look again until it takes or the autosave is gone.
			for (let attempt = 0; attempt < 8; attempt++) {
				const newer = await autosaves.get(file);
				if (!newer) break;
				const { created: _created, ancestor: _ancestor, ...rest } = newer.value;
				if (await autosaves.replaceIf(newer, { ...rest, firstAt: at })) break;
			}
		}
		return { commit: r.commit, files: chosen.map((a) => a.value.file), ran: true, removed };
	}
}
