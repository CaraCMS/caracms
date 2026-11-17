/**
 * The status poll's write-through cache (Redis diet Decisions 1–5).
 *
 * Every Redis write a site makes goes through its one server, so what the status route
 * reads can be kept here and updated (or dropped) by the writes themselves, instead of
 * being asked of Redis on every poll.
 *
 * - **What it holds is Redis as last read or written here, by key**: strings, hashes,
 *   sets, and scans (every key under a prefix, `caracms:autosave:`, with its value).
 *   Records, never views made from them: whether a lock holds, or which notices are a
 *   person's, is worked out per poll (Watch-outs).
 * - **Only the status route reads it** (Decision 3). Writes, create, delete, move, the
 *   sweep, Publish and sign-in read Redis directly.
 * - **An entry is re-read once it's `statusCacheMs` old, counted from its last Redis
 *   read** (Decision 1): a write-through keeps it current but doesn't make it younger, so
 *   what bypasses this server (the other server during a deploy, a key expiring, a hand
 *   edit) shows within that time (Decision 4).
 * - **The writes are the modules'** (Decision 2): autosaves.ts, locks.ts, git.ts and
 *   notices.ts tell it each write as it lands. A write it can apply exactly (a value just
 *   set, a field just written) updates the entry; anything else (a compare-and-swap that
 *   lost, so the value is unknown) drops it. A write to an entry not held is only noted.
 * - **Refreshes are single-flight** (Decision 5): a poll needing an entry another poll is
 *   already reading waits for that read. The ones it's missing go in one batch (SCANs
 *   with the rest, then their MGETs). A refresh that fails caches nothing, and nothing
 *   refreshes on a timer: with no poll there's no Redis read, so Redis can sleep.
 * - **A write that lands while an entry is being read** may be missing from what the
 *   read brings back: that entry is kept for the polls waiting on it, but as already
 *   old, so the next poll reads it again.
 */
import type { BatchCommand, RedisClient } from './redis.ts';

type Entry =
	| { kind: 'string'; value: string | null; at: number }
	| { kind: 'hash'; value: Map<string, string>; at: number }
	| { kind: 'set'; value: Set<string>; at: number }
	| { kind: 'scan'; value: Map<string, string>; at: number };

type Kind = Entry['kind'];

/** What a poll reads: keys by kind, and scans by key prefix (`caracms:lock:`). */
export interface StatusReads {
	scans?: readonly string[];
	hashes?: readonly string[];
	sets?: readonly string[];
	strings?: readonly string[];
}

/** One poll's view of the cache. Its entries are the cache's own, so the poll's later write-throughs show in it. */
export interface StatusSnapshot {
	/** Every key under the prefix, with its value. */
	scan(prefix: string): ReadonlyMap<string, string>;
	hash(key: string): ReadonlyMap<string, string>;
	set(key: string): ReadonlySet<string>;
	string(key: string): string | null;
}

const name = (kind: Kind, key: string) => `${kind} ${key}`;

export class StatusCache {
	private readonly redis: RedisClient;
	private readonly maxAgeMs: number;
	private readonly now: () => number;
	private readonly entries = new Map<string, Entry>();
	private readonly reading = new Map<string, Promise<Map<string, Entry>>>();
	/** Write-throughs so far, and the count at each entry's latest (for a read that a write overtook). */
	private writes = 0;
	private readonly written = new Map<string, number>();

	constructor(options: { redis: RedisClient; maxAgeMs: number; now: () => number }) {
		this.redis = options.redis;
		this.maxAgeMs = options.maxAgeMs;
		this.now = options.now;
	}

	/** What a poll reads, from memory where it's fresh enough, else from Redis (one batch, shared with any poll waiting on the same). */
	async read(reads: StatusReads): Promise<StatusSnapshot> {
		const wanted: [Kind, string][] = [
			...(reads.scans ?? []).map((k) => ['scan', k] as [Kind, string]),
			...(reads.hashes ?? []).map((k) => ['hash', k] as [Kind, string]),
			...(reads.sets ?? []).map((k) => ['set', k] as [Kind, string]),
			...(reads.strings ?? []).map((k) => ['string', k] as [Kind, string]),
		];
		const now = this.now();
		const waits = new Set<Promise<Map<string, Entry>>>();
		const missing: [Kind, string][] = [];
		for (const [kind, key] of wanted) {
			const n = name(kind, key);
			const inFlight = this.reading.get(n);
			if (inFlight) waits.add(inFlight);
			else {
				const e = this.entries.get(n);
				if (!e || now - e.at >= this.maxAgeMs) missing.push([kind, key]);
			}
		}
		if (missing.length) {
			const read = this.refresh(missing);
			for (const [kind, key] of missing) this.reading.set(name(kind, key), read);
			const done = () => {
				for (const [kind, key] of missing) if (this.reading.get(name(kind, key)) === read) this.reading.delete(name(kind, key));
				if (this.reading.size === 0) this.written.clear();
			};
			read.then(done, done);
			waits.add(read);
		}
		const fetched = new Map<string, Entry>();
		for (const got of await Promise.all(waits)) for (const [n, e] of got) fetched.set(n, e);
		// The cache's own entry where it still has one (later write-throughs land in it), else what the read brought back,
		// pinned now: a drop while the poll is still in its writes leaves it the records it read, never none.
		const pinned = new Map<string, Entry | undefined>(wanted.map(([kind, key]) => [name(kind, key), this.entries.get(name(kind, key)) ?? fetched.get(name(kind, key))]));
		const pick = (kind: Kind, key: string) => pinned.get(name(kind, key));
		return {
			scan: (prefix) => (pick('scan', prefix)?.value as Map<string, string> | undefined) ?? new Map(),
			hash: (key) => (pick('hash', key)?.value as Map<string, string> | undefined) ?? new Map(),
			set: (key) => (pick('set', key)?.value as Set<string> | undefined) ?? new Set(),
			string: (key) => (pick('string', key)?.value as string | null | undefined) ?? null,
		};
	}

	/** Read these entries from Redis: one batch, then one more for the scans' MGETs. */
	private async refresh(entries: [Kind, string][]): Promise<Map<string, Entry>> {
		const started = this.writes;
		const at = this.now();
		const commands = entries.map(([kind, key]): BatchCommand => {
			if (kind === 'scan') return ['scan', `${key}*`];
			if (kind === 'hash') return ['hgetall', key];
			if (kind === 'set') return ['smembers', key];
			return ['get', key];
		});
		const replies = (await this.redis.batch(commands)) as unknown[];
		const scanned = entries.flatMap(([kind], i) => (kind === 'scan' && (replies[i] as string[]).length ? [i] : []));
		const values = scanned.length ? ((await this.redis.batch(scanned.map((i): BatchCommand => ['mget', replies[i] as string[]]))) as (string | null)[][]) : [];
		const out = new Map<string, Entry>();
		entries.forEach(([kind, key], i) => {
			const n = name(kind, key);
			// Written since this read began: kept for now, but already old.
			const age = (this.written.get(n) ?? 0) > started ? -Infinity : at;
			let entry: Entry;
			if (kind === 'scan') {
				const keys = replies[i] as string[];
				const got = values[scanned.indexOf(i)] ?? [];
				const map = new Map<string, string>();
				keys.forEach((k, j) => {
					const v = got[j];
					if (v !== null && v !== undefined) map.set(k, v);
				});
				entry = { kind, value: map, at: age };
			} else if (kind === 'hash') entry = { kind, value: new Map(Object.entries(replies[i] as Record<string, string>)), at: age };
			else if (kind === 'set') entry = { kind, value: new Set(replies[i] as string[]), at: age };
			else entry = { kind, value: replies[i] as string | null, at: age };
			this.entries.set(n, entry);
			out.set(n, entry);
		});
		return out;
	}

	// ── Write-throughs (the modules call these once a write has landed) ─────────────

	/** Note a write to these entry names; return the ones held. */
	private touch(names: string[]): Entry[] {
		this.writes++;
		const held: Entry[] = [];
		for (const n of names) {
			// Only a read in flight needs to know (`refresh`); with none, nothing is remembered.
			if (this.reading.size) this.written.set(n, this.writes);
			const e = this.entries.get(n);
			if (e) held.push(e);
		}
		return held;
	}

	/** The scan entries (held or not) whose prefix this key is under. */
	private scansOf(key: string): string[] {
		const out: string[] = [];
		for (const n of [...this.entries.keys(), ...this.reading.keys()]) if (n.startsWith('scan ') && key.startsWith(n.slice(5))) out.push(n);
		return [...new Set(out)];
	}

	/** A string key now holds `value` (null: deleted). */
	string(key: string, value: string | null): void {
		for (const e of this.touch([name('string', key), ...this.scansOf(key)])) {
			if (e.kind === 'string') e.value = value;
			else if (e.kind === 'scan') {
				if (value === null) e.value.delete(key);
				else e.value.set(key, value);
			}
		}
	}

	/** A hash's fields were set, or deleted. */
	hash(key: string, set: Record<string, string>, del: readonly string[] = []): void {
		for (const e of this.touch([name('hash', key)])) {
			if (e.kind !== 'hash') continue;
			for (const [f, v] of Object.entries(set)) e.value.set(f, v);
			for (const f of del) e.value.delete(f);
		}
	}

	/** Members were added to a set. */
	add(key: string, ...members: string[]): void {
		for (const e of this.touch([name('set', key)])) if (e.kind === 'set') for (const m of members) e.value.add(m);
	}

	/** The key changed in a way not known here (a compare-and-swap that lost): forget it, and any scan it's under. */
	drop(key: string): void {
		const names = [...(['string', 'hash', 'set'] as const).map((k) => name(k, key)), ...this.scansOf(key)];
		this.touch(names);
		for (const n of names) this.entries.delete(n);
	}
}

/** Run a write to `key`; one that fails (lost in flight, so it may or may not have landed) drops the key from the cache. */
export async function landed<T>(cache: StatusCache | null, key: string, write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		cache?.drop(key);
		throw error;
	}
}
