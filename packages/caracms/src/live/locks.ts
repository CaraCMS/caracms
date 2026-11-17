/**
 * Locks and presence (M4 Decision 9).
 *
 * **A lock belongs to a tab**, held for a person: `caracms:lock:<file>` →
 * `{ tab, person, since, beat, releasing }`. Every change to it is a compare-and-swap
 * on the text read, so two servers (a deploy) and two tabs can't both win.
 *
 * - **The first write takes it, atomically** (`acquire`); browsing never locks. A write
 *   from a tab that doesn't hold it is refused (the route's 409).
 * - **The heartbeat** rides on the status poll (`beat`), and on every write. A tab back
 *   from hidden re-takes its own lapsed lock on its first poll, if nobody took it.
 * - **The lapse comes only after the autosave is committed**: a lock whose heartbeat
 *   is older than `lockLapseMs` is still held while its document has an autosave.
 *   The sweep commits first; the lock is then free.
 * - **Releasing** (`X-Caracms-Release: 1` on the last write, or a lone release): the lock
 *   still accepts that tab's writes, and drops once the document has no autosave. A
 *   short grace keeps it while no autosave has arrived yet, because a closing tab's
 *   two keepalive requests come in no set order (a release can overtake the last write).
 * - **Edit here** (`take`) moves your own lock to this tab at once.
 * - **Take over** (`takeOver`) moves anyone's lock to this tab at once. The route then
 *   commits the old holder's autosave under their name; their tab goes read-only.
 * - **Idle** tabs stop renewing: the status route beats only for a tab someone typed,
 *   clicked or scrolled in within `lockIdleMs`, so a forgotten tab lapses by itself.
 *
 * Nothing here drops a lock key on a timer: whether a lock still holds is worked out
 * when it's read (`holds`), so no process has to be running for a lock to lapse,
 * and Redis gets no traffic for it. The sweep deletes the keys it can.
 *
 * **Presence** (`caracms:presence`, a hash by tab): each poll records the person and the
 * document their tab has open; someone is "on" a document while a tab of theirs
 * polled with it within that record's hold: twice the tab's poll interval plus 3 s
 * (Redis diet Decision 9), so a slow tab stays on and a closed fast one goes quickly.
 *
 * **The status cache** (status-cache.ts, Redis diet Decision 2): every write here tells
 * it what landed, so the status poll can read locks and presence from memory.
 */
import type { LockState, LockView, PresenceView } from '../editor/types.ts';
import type { Person } from './messages.ts';
import type { RedisClient } from './redis.ts';
import { landed, type StatusCache } from './status-cache.ts';
import type { LiveTimings } from './timings.ts';

export interface LockRecord {
	tab: string;
	person: Person;
	/** ms: when it was taken. */
	since: number;
	/** ms: the last heartbeat (a poll or a write). */
	beat: number;
	/** ms: when the tab said it was closing; null while it isn't. */
	releasing: number | null;
	/** The document was deleted (M5a): the tab's own polls don't clear `releasing`, so the lock drops once the removal is committed. */
	deleted?: true;
}

export interface ReadLock {
	raw: string;
	lock: LockRecord;
}

interface PresenceRecord {
	person: Person;
	file: string | null;
	at: number;
	/** ms the record holds after `at` (Redis diet Decision 9). Absent (written before it was added): `presenceMs`. */
	hold?: number;
}

/** How long a releasing lock with no autosave yet waits for the tab's last write. */
export const RELEASE_GRACE_MS = 5_000;

/** Redis diet Decision 9: a presence record holds for twice the tab's poll interval plus this. */
export const PRESENCE_SLACK_MS = 3_000;

const sameEmail = (a: Person, b: Person) => a.email.toLowerCase() === b.email.toLowerCase();

export type AcquireResult = { ok: true; lock: LockRecord } | { ok: false; lock: LockRecord };

export class Locks {
	readonly redis: RedisClient;
	readonly timings: LiveTimings;
	readonly now: () => number;
	readonly prefix: string;
	/** Whether the document has an autosave not yet committed. */
	private readonly pending: (file: string) => Promise<boolean>;
	private readonly cache: StatusCache | null;

	constructor(
		redis: RedisClient,
		timings: LiveTimings,
		now: () => number,
		pending: (file: string) => Promise<boolean>,
		prefix = 'caracms:',
		cache: StatusCache | null = null,
	) {
		this.redis = redis;
		this.timings = timings;
		this.now = now;
		this.pending = pending;
		this.prefix = prefix;
		this.cache = cache;
	}

	key = (file: string) => `${this.prefix}lock:${file}`;
	/** What every lock key starts with (the status cache scans it). */
	get keyPrefix(): string {
		return this.key('');
	}
	readonly presenceKey = () => `${this.prefix}presence`;

	/** A compare-and-swap on a lock key, and the status cache told what came of it. */
	private async swap(file: string, expected: string | null, raw: string): Promise<boolean> {
		const ok = await landed(this.cache, this.key(file), () => this.redis.compareAndSet(this.key(file), expected, raw, { px: this.timings.autosaveTtlMs }));
		if (ok) this.cache?.string(this.key(file), raw);
		else this.cache?.drop(this.key(file));
		return ok;
	}

	private parse(raw: string | null): ReadLock | null {
		if (raw === null) return null;
		try {
			const lock = JSON.parse(raw) as LockRecord;
			return lock && typeof lock.tab === 'string' && lock.person ? { raw, lock } : null;
		} catch {
			return null;
		}
	}

	async read(file: string): Promise<ReadLock | null> {
		return this.parse(await this.redis.get(this.key(file)));
	}

	/** Every lock key: one SCAN and one MGET. */
	async all(): Promise<Map<string, ReadLock>> {
		const keys = await this.redis.scan(`${this.keyPrefix}*`);
		if (keys.length === 0) return new Map();
		const raws = await this.redis.mget(keys);
		return this.allFrom(keys.map((k, i) => [k, raws[i] ?? null]));
	}

	/** The locks among these keys and values (a scan of `keyPrefix`), by file. */
	allFrom(entries: Iterable<readonly [string, string | null]>): Map<string, ReadLock> {
		const out = new Map<string, ReadLock>();
		for (const [k, raw] of entries) {
			const read = this.parse(raw);
			if (read) out.set(k.slice(this.keyPrefix.length), read);
		}
		return out;
	}

	/** Does this lock still hold? `pending`: the document has an uncommitted autosave. */
	holds(lock: LockRecord, pending: boolean): boolean {
		if (pending) return true; // commit first, then release
		const now = this.now();
		if (lock.releasing !== null) return now - lock.releasing < Math.min(RELEASE_GRACE_MS, this.timings.lockLapseMs);
		return now - lock.beat < this.timings.lockLapseMs;
	}

	private async live(read: ReadLock | null, file: string): Promise<boolean> {
		return read !== null && this.holds(read.lock, await this.pending(file));
	}

	private put(file: string, expected: string | null, lock: LockRecord): Promise<boolean> {
		return this.swap(file, expected, JSON.stringify(lock));
	}

	private static mine(lock: LockRecord, tab: string, person: Person) {
		return lock.tab === tab && sameEmail(lock.person, person);
	}

	/**
	 * A write's lock (Decision 9): the tab's own lock is renewed (a releasing one stays
	 * releasing); a free or lapsed one is taken, atomically; anyone else's refuses.
	 */
	async acquire(file: string, tab: string, person: Person): Promise<AcquireResult> {
		for (let attempt = 0; attempt < 5; attempt++) {
			const cur = await this.read(file);
			const now = this.now();
			if (cur && Locks.mine(cur.lock, tab, person)) {
				// A tab that deleted the document and now writes to it again (a re-create) is back: no longer releasing.
				const { deleted: _deleted, ...kept } = cur.lock;
				const next: LockRecord = { ...kept, person, beat: now, ...(cur.lock.deleted ? { releasing: null } : {}) };
				if (await this.put(file, cur.raw, next)) return { ok: true, lock: next };
				continue;
			}
			if (cur && (await this.live(cur, file))) return { ok: false, lock: cur.lock };
			const next: LockRecord = { tab, person, since: now, beat: now, releasing: null };
			if (await this.put(file, cur?.raw ?? null, next)) return { ok: true, lock: next };
		}
		const cur = await this.read(file);
		if (cur) return { ok: false, lock: cur.lock };
		throw new Error('caracms: the lock kept changing under the write.');
	}

	/**
	 * The status poll's heartbeat: renew the tab's own lock and clear "releasing" (the tab
	 * is still here), except for a lock the tab's own delete released. A lapsed lock that still names this tab is re-taken (a tab back
	 * from hidden). Nothing is taken that the tab never held.
	 */
	async beat(file: string, tab: string, person: Person, known?: ReadLock | null): Promise<ReadLock | null> {
		for (let attempt = 0; attempt < 3; attempt++) {
			// `known`: the lock as the status cache has it, the first try's expected value (Redis diet Decision 6).
			const cur = attempt === 0 && known !== undefined ? known : await this.read(file);
			if (!cur || !Locks.mine(cur.lock, tab, person)) return cur;
			// A poll in flight when the tab deleted the document must not un-release its lock (M5a).
			const next = { ...cur.lock, beat: this.now(), releasing: cur.lock.deleted ? cur.lock.releasing : null };
			const raw = JSON.stringify(next);
			if (await this.swap(file, cur.raw, raw)) return { raw, lock: next };
		}
		return this.read(file);
	}

	/**
	 * Redis diet Decision 6: does the status poll need to beat for this tab? Only when the
	 * lock (as the cache has it) is the tab's own and its last beat is `beatEveryMs` old
	 * (a lapsed one is older still: it's taken back), or it's marked releasing and not
	 * deleted (a tab back from `pagehide`: the beat clears it). A lock that isn't the
	 * tab's, or none, needs no beat: the beat takes nothing the tab never held.
	 */
	needsBeat(cached: ReadLock | null, tab: string, person: Person): boolean {
		if (!cached || !Locks.mine(cached.lock, tab, person)) return false;
		if (cached.lock.releasing !== null && !cached.lock.deleted) return true;
		return this.now() - cached.lock.beat >= this.timings.beatEveryMs;
	}

	/** Edit here: move your own lock to this tab at once, or take a free one. Someone else's refuses. */
	async take(file: string, tab: string, person: Person): Promise<AcquireResult> {
		for (let attempt = 0; attempt < 5; attempt++) {
			const cur = await this.read(file);
			if (cur && !sameEmail(cur.lock.person, person) && (await this.live(cur, file))) return { ok: false, lock: cur.lock };
			const now = this.now();
			const next: LockRecord = { tab, person, since: cur && Locks.mine(cur.lock, tab, person) ? cur.lock.since : now, beat: now, releasing: null };
			if (await this.put(file, cur?.raw ?? null, next)) return { ok: true, lock: next };
		}
		throw new Error('caracms: the lock kept changing under Edit here.');
	}

	/**
	 * Take over: move the lock to this tab whoever holds it, at once. Returns the lock
	 * it replaced (null if it was free or lapsed), so the route can commit their autosave.
	 */
	async takeOver(file: string, tab: string, person: Person): Promise<{ lock: LockRecord; from: LockRecord | null }> {
		for (let attempt = 0; attempt < 5; attempt++) {
			const cur = await this.read(file);
			const now = this.now();
			const next: LockRecord = { tab, person, since: now, beat: now, releasing: null };
			if (await this.put(file, cur?.raw ?? null, next)) return { lock: next, from: cur && (await this.live(cur, file)) ? cur.lock : null };
		}
		throw new Error('caracms: the lock kept changing under Take over.');
	}

	/**
	 * The tab is closing: mark its lock releasing. Another tab's lock is left alone.
	 * `deleted`: the tab deleted the document, so its later polls leave the lock releasing (`beat`).
	 */
	async release(file: string, tab: string, person: Person, options: { deleted?: boolean } = {}): Promise<ReadLock | null> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const cur = await this.read(file);
			if (!cur || !Locks.mine(cur.lock, tab, person)) return cur;
			if (cur.lock.releasing !== null && (!options.deleted || cur.lock.deleted)) return cur;
			const next: LockRecord = { ...cur.lock, releasing: cur.lock.releasing ?? this.now(), ...(options.deleted ? { deleted: true as const } : {}) };
			const raw = JSON.stringify(next);
			if (await this.put(file, cur.raw, next)) return { raw, lock: next };
		}
		return this.read(file);
	}

	/** Delete a lock that no longer holds (the sweep, after a commit). */
	async dropIfFree(file: string): Promise<void> {
		const cur = await this.read(file);
		if (cur && !(await this.live(cur, file))) {
			if (await landed(this.cache, this.key(file), () => this.redis.compareAndDelete(this.key(file), cur.raw))) this.cache?.string(this.key(file), null);
			else this.cache?.drop(this.key(file));
		}
	}

	view(file: string, lock: LockRecord, tab: string | null, person: Person): LockView {
		return {
			file,
			person: lock.person,
			since: new Date(lock.since).toISOString(),
			releasing: lock.releasing !== null,
			mine: !sameEmail(lock.person, person) ? null : lock.tab === tab ? 'this-tab' : 'other-tab',
		};
	}

	static state(view: LockView | null): LockState {
		if (!view) return 'free';
		return view.mine === 'this-tab' ? 'yours' : view.mine === 'other-tab' ? 'yours-elsewhere' : 'theirs';
	}

	// ── Presence ────────────────────────────────────────────────────────────────

	/**
	 * Record a poll: this tab, this person, this document (or none). `intervalMs`: how long
	 * until the tab's next poll; the record holds for twice that plus 3 s (Decision 9).
	 */
	async present(tab: string, person: Person, file: string | null, intervalMs = this.timings.pollMs): Promise<void> {
		const record: PresenceRecord = { person, file, at: this.now(), hold: 2 * intervalMs + PRESENCE_SLACK_MS };
		const fields = { [tab]: JSON.stringify(record) };
		await landed(this.cache, this.presenceKey(), () => this.redis.hset(this.presenceKey(), fields));
		this.cache?.hash(this.presenceKey(), fields);
	}

	/** The tabs on this document now (polled with it within their record's hold), with their people (Discard changes). */
	async tabsOn(file: string): Promise<{ tab: string; person: Person }[]> {
		const now = this.now();
		const out: { tab: string; person: Person }[] = [];
		for (const [tab, raw] of Object.entries(await this.redis.hgetall(this.presenceKey()))) {
			try {
				const r = JSON.parse(raw) as PresenceRecord;
				const hold = typeof r.hold === 'number' ? r.hold : this.timings.presenceMs;
				if (r.file === file && now - r.at <= hold) out.push({ tab, person: r.person });
			} catch {
				/* skip */
			}
		}
		return out;
	}

	/** Discard changes: let go of a lock whoever holds it (only while it's still what was read). */
	async drop(read: ReadLock, file: string): Promise<void> {
		if (await landed(this.cache, this.key(file), () => this.redis.compareAndDelete(this.key(file), read.raw))) this.cache?.string(this.key(file), null);
		else this.cache?.drop(this.key(file));
	}

	/** Who is on which document now (polled with it within the record's hold). Long-gone tabs are pruned. */
	async presence(): Promise<PresenceView[]> {
		return this.presenceFrom(Object.entries(await this.redis.hgetall(this.presenceKey())));
	}

	/** `presence()` over the hash's fields as read (the status cache's, on a poll). */
	async presenceFrom(fields: Iterable<readonly [string, string]>): Promise<PresenceView[]> {
		const now = this.now();
		const byFile = new Map<string, Person[]>();
		const gone: string[] = [];
		for (const [tab, raw] of fields) {
			let r: PresenceRecord;
			try {
				r = JSON.parse(raw) as PresenceRecord;
			} catch {
				gone.push(tab);
				continue;
			}
			const hold = typeof r.hold === 'number' ? r.hold : this.timings.presenceMs;
			if (now - r.at > hold) {
				if (now - r.at > Math.max(hold, this.timings.lockLapseMs)) gone.push(tab);
				continue;
			}
			if (!r.file) continue;
			const people = byFile.get(r.file) ?? [];
			if (!people.some((p) => sameEmail(p, r.person))) people.push(r.person);
			byFile.set(r.file, people);
		}
		if (gone.length) {
			await landed(this.cache, this.presenceKey(), () => this.redis.hdel(this.presenceKey(), ...gone));
			this.cache?.hash(this.presenceKey(), {}, gone);
		}
		return [...byFile].map(([file, people]) => ({ file, people }));
	}
}
