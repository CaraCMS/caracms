/**
 * Autosaves in Redis (M4 Decision 4), and the two small records beside them.
 *
 * - **`caracms:autosave:<file>`**: the whole document as the tab last sent it, with the
 *   base it was edited from, its text (`applyEdits(base, document)`), its editor and
 *   tab, and two times for the sweep: the first write since the last commit (the
 *   five-minute cap) and the newest write (the idle time). **It never expires**: it's an
 *   edit that hasn't reached GitHub, so while commits fail (a lost token, an uninstalled
 *   App) it waits for the sweep however long that takes (caracms-cloud adversarial review,
 *   finding 4). Once committed it's deleted, and what's left of it, the committed record
 *   below, expires a week later as before.
 * - **`caracms:committed:<file>`**: what the sweep last committed from a tab's editing
 *   session (its tab, its base, and the text it committed). The next commit from the
 *   same session merges against that text, not the session's first base, so the
 *   session's own earlier commit isn't mistaken for a change made elsewhere (no false
 *   "also changed outside the editor" notice).
 * - **`caracms:changed:<file>`**: who last changed the document and the version their
 *   autosave left (Decision 11). Set by every autosave; a merge from `main` or the sweep
 *   committing that person's own autosave leaves it alone. **It never expires** (one
 *   small key per file), so it outlives Publish; only a flush loses it.
 *
 * **Creating and deleting** (M5a Decisions 11 and 12) go through the same autosave:
 *
 * - **A new document** is an autosave with `created: { over }`: `over` is what `drafts`
 *   had at that path when it was created (null; or the file a pending deletion was
 *   removing, when a document deleted since the last Publish is made again). Until the
 *   sweep commits it, `over` is the merge's ancestor, not `base` (which is the new
 *   document's first text, the base the creator's tab edits against). Later writes
 *   carry `created` on until the commit.
 * - **A deletion** is a "gone" autosave: `text` and `document` are null, and
 *   `gone: { title }` keeps the document's title from before the removal (the waiting
 *   list's and the commit message's name for it when `main` can't say). `base` is the
 *   text the deleter's tab was on, so the merge's ancestor is worked out as for any
 *   autosave. The sweep commits it as a removed file.
 * - **`caracms:changed:`** records a deletion too (`gone: true`), so a viewer's tab
 *   learns who deleted the document after the sweep has committed it.
 *
 * **Moves** (pre-M7 item 8): **`caracms:moves`**, a hash from a moved document's old
 * file to its new file, kept until the move is published (`movesKey`). A move records
 * itself here rather than being read off Site Settings' redirects, so it stays one
 * "Moved" entry (and one headline item) whether or not the editor keeps the redirect.
 * A move of a document moved since the last Publish extends its record (old → newest);
 * moving it back to where it was drops the record, as does deleting it. A record only
 * counts while its old file is gone and its new file is there (`movesIn`, git.ts).
 *
 * **Discards** (Discard changes) ride on **`caracms:changed:<file>`** (`ChangeRecord.discard`),
 * which every poll on the document and every write to it already read, so a discard costs
 * them no command of their own: who put the document back to what's live, when, and the tabs
 * that had it open or were editing it then. Those tabs' writes are refused until each says it
 * has let go of its copy (`ackDiscard`), so a tab that hasn't heard yet can't bring the
 * discarded edits back. A write carries the discard forward for a week (`carryDiscard`).
 *
 * Paths are site-relative (`content/pages/index.json`). Values are JSON text.
 *
 * **The status cache** (status-cache.ts, Redis diet Decision 2): every write here of a
 * key the status poll reads (autosaves, change records, moves) tells it what landed.
 */
import type { AnyDocument } from '../document.ts';
import type { Person } from './messages.ts';
import type { RedisClient } from './redis.ts';
import { landed, type StatusCache } from './status-cache.ts';
import type { LiveTimings } from './timings.ts';

export interface Autosave {
	file: string;
	/** The text the tab's edits were made against (the write body's `base`). */
	base: string;
	/**
	 * What `drafts` had under this autosave, when `base` isn't it: a write made against
	 * the text of an autosave the sweep hadn't committed yet (opened over it: a move's
	 * Site Settings, say) keeps the replaced autosave's ancestor here. The merge's
	 * ancestor when no session record applies (`ancestorFor`); absent, it's `base`.
	 */
	ancestor?: string;
	/** Any kind of document (M5a). Null: the document is deleted (`gone`). */
	document: AnyDocument | null;
	/** `applyEdits(base, document)`: what the document reads as now. Null: deleted (`gone`). */
	text: string | null;
	editor: Person;
	tab: string;
	/** ms since the epoch: the first write since the last commit. */
	firstAt: number;
	/** ms since the epoch: the newest write. */
	updatedAt: number;
	/** The tab's own write sequence (`X-Caracms-Seq`), when it sent one: a lower one from the same tab is older. */
	seq?: number | null;
	/**
	 * Ready for the sweep at once, with no idle wait (M5a Decision 10): Site Settings'
	 * autosave, so `editors` and `brand` apply on the sweep's next tick. The sweep
	 * commits it on that tick whatever its age (sweep.ts → `ready`).
	 */
	sweepAtOnce?: boolean;
	/**
	 * M5a: this autosave creates the document (Decision 11). `over` is the file `drafts`
	 * had at that path then (usually null): the merge's ancestor until it's committed.
	 */
	created?: { over: string | null };
	/** M5a: the document is deleted (Decision 12): `text` and `document` are null. `title` is its title before the removal. */
	gone?: { title: string };
}

export interface Committed {
	tab: string;
	base: string;
	/** The session's own text as committed (before any merge); null for a deletion. */
	text: string | null;
	at: number;
	/** The editor's address, lower-cased (absent on records written before it was added). */
	editor?: string;
}

/** Where an autosave's merge ancestor came from (sweep.ts logs anything but `session`/`base`). */
export type AncestorFrom = 'session' | 'own-commit' | 'base' | 'created' | 'base, record from another tab' | 'base, record from someone else';

export interface ChangeRecord {
	/** Null: only merges from `main` have changed it (no editor has, since the record began). */
	by: Person | null;
	version: string;
	/** ISO. */
	at: string;
	/** M5a: this change deleted the document (`by` deleted it). */
	gone?: boolean;
	/** Discard changes: the last time someone put the document back to what's live (see the header). */
	discard?: DiscardRecord;
}

/** A document put back to what's live (Discard changes): `tabs` are the tabs whose copies are stale until they let go. */
export interface DiscardRecord {
	by: Person;
	/** ISO. */
	at: string;
	tabs: string[];
}

/** A value with the raw text it was read as, for compare-and-swap. */
export interface Read<T> {
	raw: string;
	value: T;
}

/** The Redis hash of moves waiting to publish (old file → new file). */
export const movesKey = (prefix: string) => `${prefix}moves`;
/**
 * Collections under pages: the moves hash also holds each moved document's live address,
 * as `@<file now>` → the address (see `recordAddresses`), so the status poll reads no more
 * keys than before (Redis diet). `splitMoves` parts the two.
 */
export const ADDRESS_FIELD = '@';
export function splitMoves(fields: Iterable<[string, string]>): { records: Map<string, string>; addresses: Map<string, string> } {
	const records = new Map<string, string>();
	const addresses = new Map<string, string>();
	for (const [k, v] of fields) {
		if (k.startsWith(ADDRESS_FIELD)) addresses.set(k.slice(ADDRESS_FIELD.length), v);
		else records.set(k, v);
	}
	return { records, addresses };
}

const parse = <T>(raw: string | null): T | null => {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
};

export class Autosaves {
	readonly redis: RedisClient;
	readonly timings: LiveTimings;
	readonly now: () => number;
	readonly prefix: string;
	private readonly cache: StatusCache | null;

	constructor(redis: RedisClient, timings: LiveTimings, now: () => number, prefix = 'caracms:', cache: StatusCache | null = null) {
		this.redis = redis;
		this.timings = timings;
		this.now = now;
		this.prefix = prefix;
		this.cache = cache;
	}

	key = (file: string) => `${this.prefix}autosave:${file}`;
	/** What every autosave key starts with (the status cache scans it). */
	get keyPrefix(): string {
		return this.key('');
	}
	private committedKey = (file: string) => `${this.prefix}committed:${file}`;
	readonly changedKey = (file: string) => `${this.prefix}changed:${file}`;
	readonly movesKey = () => movesKey(this.prefix);

	/** A compare-and-swap (or delete) on an autosave key, and the status cache told what came of it. No expiry: a SET without PX also clears one an older version left. */
	private async swap(key: string, expected: string | null, raw: string | null): Promise<boolean> {
		const ok = await landed(this.cache, key, () => (raw === null ? this.redis.compareAndDelete(key, expected!) : this.redis.compareAndSet(key, expected, raw)));
		if (ok) this.cache?.string(key, raw);
		else this.cache?.drop(key);
		return ok;
	}

	async get(file: string): Promise<Read<Autosave> | null> {
		const raw = await this.redis.get(this.key(file));
		const value = parse<Autosave>(raw);
		return raw !== null && value ? { raw, value } : null;
	}

	/** Every autosave: one SCAN and one MGET. */
	async all(): Promise<Read<Autosave>[]> {
		const keys = await this.redis.scan(`${this.keyPrefix}*`);
		if (keys.length === 0) return [];
		return Autosaves.allFrom(await this.redis.mget(keys));
	}

	/** The autosaves among these values (a scan of `keyPrefix`'s, read). */
	static allFrom(raws: Iterable<string | null>): Read<Autosave>[] {
		const out: Read<Autosave>[] = [];
		for (const raw of raws) {
			const value = parse<Autosave>(raw);
			if (raw !== null && value) out.push({ raw, value });
		}
		return out;
	}

	/** Store it only if the autosave is still what was read (`null`: only if there's none), so a write that read an older one never replaces a newer. */
	putIf(read: Read<Autosave> | null, autosave: Autosave): Promise<boolean> {
		return this.swap(this.key(autosave.file), read?.raw ?? null, JSON.stringify(autosave));
	}

	/** Delete it only if it's still what was read (a newer write wins). */
	removeIf(read: Read<Autosave>): Promise<boolean> {
		return this.swap(this.key(read.value.file), read.raw, null);
	}

	/**
	 * An autosave written by caracms 0.8.0 or before, with the week's expiry it set: written
	 * again as it is, with none (the sweep's startup check). Only if it's still what was read.
	 */
	async keepForever(read: Read<Autosave>): Promise<boolean> {
		if ((await this.redis.pttl(this.key(read.value.file))) < 0) return false;
		return this.swap(this.key(read.value.file), read.raw, read.raw);
	}

	/** Replace it only if it's still what was read. */
	replaceIf(read: Read<Autosave>, next: Autosave): Promise<boolean> {
		return this.swap(this.key(next.file), read.raw, JSON.stringify(next));
	}

	/**
	 * Discard changes: delete the autosave whatever it holds (a newer write is deleted too),
	 * returning each one deleted, so the caller knows whose tabs had it.
	 */
	async removeAll(file: string): Promise<Autosave[]> {
		const gone: Autosave[] = [];
		for (let attempt = 0; attempt < 8; attempt++) {
			const read = await this.get(file);
			if (!read) return gone;
			if (await this.removeIf(read)) gone.push(read.value);
		}
		throw new Error(`caracms: the autosave for ${file} kept changing under the discard.`);
	}

	/** Discard changes: the session's committed record goes with the edit it recorded. */
	async forgetCommitted(file: string): Promise<void> {
		await this.redis.del(this.committedKey(file));
	}

	/** Discard changes: every move record from or to these files, and their live addresses, go. */
	async forgetMovesOf(files: readonly string[]): Promise<void> {
		const key = movesKey(this.prefix);
		const all = Object.entries(await this.redis.hgetall(key));
		const drop = all
			.filter(([k, v]) => (k.startsWith(ADDRESS_FIELD) ? files.includes(k.slice(ADDRESS_FIELD.length)) : files.includes(k) || files.includes(v)))
			.map(([k]) => k);
		if (drop.length === 0) return;
		await landed(this.cache, key, () => this.redis.hdel(key, ...drop));
		this.cache?.hash(key, {}, drop);
	}

	/** The autosave and the change record in one MGET (the write route reads both: Discard changes costs it no command). */
	async getWithChange(file: string): Promise<[Read<Autosave> | null, ChangeRecord | null]> {
		const [raw, changed] = await this.redis.mget([this.key(file), this.changedKey(file)]);
		const value = parse<Autosave>(raw ?? null);
		return [raw !== null && raw !== undefined && value ? { raw, value } : null, Autosaves.changedFrom(changed ?? null)];
	}

	/** The discard a write should keep on the change record it makes: the one there, while under a week old. */
	carryDiscard(record: ChangeRecord | null): Pick<ChangeRecord, 'discard'> {
		const d = record?.discard;
		return d && this.now() - Date.parse(d.at) < this.timings.autosaveTtlMs ? { discard: d } : {};
	}

	/** A tab has let go of its copy of a discarded document: its writes are taken again. */
	async ackDiscard(file: string, tab: string): Promise<void> {
		const key = this.changedKey(file);
		for (let attempt = 0; attempt < 5; attempt++) {
			const raw = await this.redis.get(key);
			const record = Autosaves.changedFrom(raw);
			if (!record?.discard || !record.discard.tabs.includes(tab)) return;
			const next = JSON.stringify({ ...record, discard: { ...record.discard, tabs: record.discard.tabs.filter((t) => t !== tab) } });
			const ok = await landed(this.cache, key, () => this.redis.compareAndSet(key, raw, next));
			if (ok) {
				this.cache?.string(key, next);
				return;
			}
			this.cache?.drop(key);
		}
	}

	async committed(file: string): Promise<Committed | null> {
		return parse<Committed>(await this.redis.get(this.committedKey(file)));
	}

	async setCommitted(file: string, record: Committed): Promise<void> {
		await this.redis.set(this.committedKey(file), JSON.stringify(record), { px: this.timings.autosaveTtlMs });
	}

	async changed(file: string): Promise<ChangeRecord | null> {
		return Autosaves.changedFrom(await this.redis.get(this.changedKey(file)));
	}

	/** A change record from its text as read. */
	static changedFrom(raw: string | null): ChangeRecord | null {
		return parse<ChangeRecord>(raw);
	}

	/** Several files' records in one MGET (the documents list's "Last edited"), in the order asked; none: null. */
	async changedMany(files: readonly string[]): Promise<(ChangeRecord | null)[]> {
		if (files.length === 0) return [];
		return (await this.redis.mget(files.map(this.changedKey))).map((raw) => parse<ChangeRecord>(raw));
	}

	/** No expiry: one small key per file, overwritten on each change, so "who changed it" is never forgotten while Redis keeps its data. */
	async setChanged(file: string, record: ChangeRecord): Promise<void> {
		const raw = JSON.stringify(record);
		await landed(this.cache, this.changedKey(file), () => this.redis.set(this.changedKey(file), raw));
		this.cache?.string(this.changedKey(file), raw);
	}

	/**
	 * Record a change only if the file has no record yet (SET NX): a merge or fast-forward
	 * from `main` leaves `{ by: null }` ("only merges"), and never overwrites an editor's.
	 */
	async setChangedIfAbsent(file: string, record: Omit<ChangeRecord, 'by'> & { by: Person | null }): Promise<void> {
		const raw = JSON.stringify(record);
		if (await landed(this.cache, this.changedKey(file), () => this.redis.set(this.changedKey(file), raw, { nx: true }))) this.cache?.string(this.changedKey(file), raw);
	}

	/** Pre-M7 item 8: the moves waiting to publish, old file → new file. */
	async moves(): Promise<Map<string, string>> {
		return splitMoves(Object.entries(await this.redis.hgetall(movesKey(this.prefix)))).records;
	}

	private async setMove(from: string, to: string): Promise<void> {
		await landed(this.cache, movesKey(this.prefix), () => this.redis.hset(movesKey(this.prefix), { [from]: to }));
		this.cache?.hash(movesKey(this.prefix), { [from]: to });
	}

	private async dropMoves(...from: string[]): Promise<void> {
		await landed(this.cache, movesKey(this.prefix), () => this.redis.hdel(movesKey(this.prefix), ...from));
		this.cache?.hash(movesKey(this.prefix), {}, from);
	}

	/**
	 * A document moved from `from` to `to`. Moved since the last Publish already (a record
	 * ends at `from`): that record now ends at `to`, or goes when `to` is where it started
	 * (moved back). Otherwise a new record, only when `from` is live (`wasLive`): a page
	 * made since the last Publish is just a new page at its new address.
	 */
	async recordMove(from: string, to: string, wasLive: boolean): Promise<void> {
		const moves = await this.moves();
		const earlier = [...moves].find(([, t]) => t === from)?.[0];
		if (earlier !== undefined) {
			if (earlier === to) await this.dropMoves(earlier);
			else await this.setMove(earlier, to);
		} else if (wasLive) await this.setMove(from, to);
	}

	/**
	 * Several documents moved at once (the many-move engine), each as `recordMove` would,
	 * but every one read against the records before the plan: in a chain (A → B, B → C)
	 * the second move's `from` is the first's `to`, and read one at a time it would take
	 * over the first's record. In a swap each gets its record (`movesIn` counts neither
	 * while both files are there).
	 */
	async recordMoves(entries: readonly { from: string; to: string; wasLive: boolean }[]): Promise<void> {
		if (entries.length === 0) return;
		const before = await this.moves();
		const after = new Map(before);
		const origins = entries.map((e) => [...before].find(([, t]) => t === e.from)?.[0] ?? (e.wasLive ? e.from : null));
		for (const origin of origins) if (origin !== null) after.delete(origin);
		entries.forEach((e, i) => {
			const origin = origins[i]!;
			if (origin !== null && origin !== e.to) after.set(origin, e.to);
		});
		const drop = [...before.keys()].filter((f) => !after.has(f));
		if (drop.length) await this.dropMoves(...drop);
		for (const [f, t] of after) if (before.get(f) !== t) await this.setMove(f, t);
	}

	/** Collections under pages: each moved document's live address, by its file now. */
	async addresses(): Promise<Map<string, string>> {
		return splitMoves(Object.entries(await this.redis.hgetall(movesKey(this.prefix)))).addresses;
	}

	/**
	 * Collections under pages (Decision 9): each address a move changed, in one write. The
	 * record is the document's live address, by its file now: a held document keeps its file
	 * when its holder moves, so its old address can't be worked out from a file's move, nor
	 * from its holder's address now. Moved since the last Publish already: the record follows
	 * it to its new file; back at its live address: the record goes. A document that was
	 * never live (`wasLive` false, no record) gets none.
	 */
	async recordAddresses(entries: readonly { from: string; to: string; toUrl: string; fromUrl: string; wasLive: boolean }[]): Promise<void> {
		if (entries.length === 0) return;
		// Every live address from the records as they were before the plan, never from the
		// map being changed: in a swap or a chain one entry's `to` is another's `from`.
		const before = await this.addresses();
		const same = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
		const live = entries.map((e) => before.get(e.from) ?? (e.wasLive ? e.fromUrl : null));
		const after = new Map(before);
		for (const e of entries) if (e.from !== e.to) after.delete(e.from);
		entries.forEach((e, i) => {
			const address = live[i]!;
			if (address === null || same(address, e.toUrl)) after.delete(e.to);
			else after.set(e.to, address);
		});
		const drop = new Set([...before.keys()].filter((f) => !after.has(f)));
		const set: Record<string, string> = {};
		for (const [f, v] of after) if (before.get(f) !== v) set[f] = v;
		const key = movesKey(this.prefix);
		const field = (file: string) => `${ADDRESS_FIELD}${file}`;
		if (drop.size) {
			const fields = [...drop].map(field);
			await landed(this.cache, key, () => this.redis.hdel(key, ...fields));
			this.cache?.hash(key, {}, fields);
		}
		if (Object.keys(set).length) {
			const fields = Object.fromEntries(Object.entries(set).map(([f, v]) => [field(f), v]));
			await landed(this.cache, key, () => this.redis.hset(key, fields));
			this.cache?.hash(key, fields);
		}
	}

	/** A deleted document's move, if it was moved, is no move any more: it's a deletion. */
	async forgetMoveTo(file: string): Promise<void> {
		const moves = await this.moves();
		const olds = [...moves].filter(([, t]) => t === file).map(([o]) => o);
		if (olds.length) await this.dropMoves(...olds);
		if ((await this.addresses()).has(file)) {
			const key = movesKey(this.prefix);
			const field = `${ADDRESS_FIELD}${file}`;
			await landed(this.cache, key, () => this.redis.hdel(key, field));
			this.cache?.hash(key, {}, [field]);
		}
	}

	/** The merge's ancestor for an autosave (Decision 6). See `ancestorFor`. */
	async ancestorOf(autosave: Autosave): Promise<string | null> {
		return (await this.ancestorFor(autosave)).text;
	}

	/**
	 * The merge's ancestor for an autosave (Decision 6), so the editor's own earlier
	 * commit from the same editing session is never read as a change made elsewhere:
	 *
	 * - **The same tab, the same base** (the session's last commit): that commit's text.
	 * - **The same person and base, another tab id** (held edits re-sent from a reloaded
	 *   or new tab, Use mine): per top-level key, the person's own committed value for
	 *   each key this draft changed, and the base's value for every key it didn't. So
	 *   their own commit isn't a conflict, and a key their other tab changed and this
	 *   draft never touched is still taken from `drafts`, not undone.
	 * - Otherwise (no record, another base, someone else): what `drafts` had under it (its
	 *   `ancestor`, else its own base).
	 * - **A new document not committed yet** (M5a, `created`): what `drafts` had at its
	 *   path when it was made (`created.over`, usually null: the file didn't exist).
	 */
	async ancestorFor(autosave: Autosave): Promise<{ text: string | null; from: AncestorFrom }> {
		if (autosave.created) return { text: autosave.created.over, from: 'created' };
		const c = await this.committed(autosave.file);
		const start = autosave.ancestor ?? autosave.base;
		if (!c || c.base !== autosave.base) return { text: start, from: 'base' };
		if (c.tab === autosave.tab) return { text: c.text, from: 'session' };
		if (c.editor !== autosave.editor.email.toLowerCase()) return { text: start, from: 'base, record from someone else' };
		if (autosave.text === null || c.text === null) return { text: start, from: 'base, record from another tab' };
		const own = ownAncestor(autosave.base, autosave.text, c.text);
		return own === null ? { text: start, from: 'base, record from another tab' } : { text: own, from: 'own-commit' };
	}
}

const equal = (x: unknown, y: unknown): boolean => {
	if (x === y) return true;
	if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null || Array.isArray(x) !== Array.isArray(y)) return false;
	const xk = Object.keys(x);
	const yk = Object.keys(y);
	return xk.length === yk.length && xk.every((k) => Object.hasOwn(y, k) && equal((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]));
};

const object = (text: string): Record<string, unknown> | null => {
	try {
		const v = JSON.parse(text) as unknown;
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};

/**
 * The per-key ancestor for a draft whose person already committed from the same base
 * in another tab: the committed value where the draft changed a key, the base's where
 * it didn't. Only values matter (merge.ts reads the ancestor's values, never its text),
 * so it's plain JSON. Null when any side isn't a JSON object.
 */
function ownAncestor(base: string, draft: string, committed: string): string | null {
	const b = object(base);
	const d = object(draft);
	const c = object(committed);
	if (!b || !d || !c) return null;
	const out: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(b), ...Object.keys(c), ...Object.keys(d)])) {
		const changed = Object.hasOwn(d, key) !== Object.hasOwn(b, key) || !equal(d[key], b[key]);
		const from = changed ? c : b;
		if (Object.hasOwn(from, key)) out[key] = from[key];
	}
	return JSON.stringify(out, null, 2);
}
