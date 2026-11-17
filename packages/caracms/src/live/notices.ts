/**
 * The editor's notices in Redis (M4 Decision 7 and 10 step 1), in one place so the
 * status cache hears of every write (Redis diet Decision 2).
 *
 * - **"Published as it stood"** (`caracms:notices`, a hash by notice id): Publish leaves
 *   one for each person who had a published document open; dismissing it deletes it.
 * - **"Discarded"** (Discard changes), in the same hash: one for each person who had edits in
 *   the document or had it open, but didn't discard it; dismissing it deletes it.
 * - **Dismissed "draft kept" notices** (`caracms:dismissed`, a set of ids): those are
 *   shared, worked out from git (`git.keptDraftNotices()`), so a dismissal is remembered
 *   here; a new conflict has a new id and shows again.
 *
 * Both expire a week after their last write (`autosaveTtlMs`), as a backstop.
 */
import type { NoticeView } from '../editor/types.ts';
import type { Person } from './messages.ts';
import type { RedisClient } from './redis.ts';
import { landed, type StatusCache } from './status-cache.ts';
import type { LiveTimings } from './timings.ts';

/** "Aoife published Home as it stood at 14:20", for one person. */
export interface StoodNotice {
	id: string;
	/** The person it's for, lower-cased. */
	for: string;
	file: string;
	title: string;
	by: Person;
	at: string;
	/** Absent: "published as it stood". `discarded`: "Aoife discarded the unpublished changes to About". */
	kind?: 'discarded';
}

export class Notices {
	readonly redis: RedisClient;
	readonly timings: LiveTimings;
	private readonly cache: StatusCache | null;
	readonly noticesKey: string;
	readonly dismissedKey: string;

	constructor(redis: RedisClient, timings: LiveTimings, prefix = 'caracms:', cache: StatusCache | null = null) {
		this.redis = redis;
		this.timings = timings;
		this.cache = cache;
		this.noticesKey = `${prefix}notices`;
		this.dismissedKey = `${prefix}dismissed`;
	}

	/** Leave these "published as it stood" notices. */
	async addStood(notices: readonly StoodNotice[]): Promise<void> {
		if (notices.length === 0) return;
		const fields = Object.fromEntries(notices.map((n) => [n.id, JSON.stringify(n)]));
		await landed(this.cache, this.noticesKey, () => this.redis.hset(this.noticesKey, fields));
		this.cache?.hash(this.noticesKey, fields);
		await this.redis.pexpire(this.noticesKey, this.timings.autosaveTtlMs);
	}

	/** A "published as it stood" notice is done with. */
	async remove(id: string): Promise<void> {
		await landed(this.cache, this.noticesKey, () => this.redis.hdel(this.noticesKey, id));
		this.cache?.hash(this.noticesKey, {}, [id]);
	}

	/** A shared "draft kept" notice was dismissed. */
	async dismiss(id: string): Promise<void> {
		await landed(this.cache, this.dismissedKey, () => this.redis.sadd(this.dismissedKey, id));
		this.cache?.add(this.dismissedKey, id);
		await this.redis.pexpire(this.dismissedKey, this.timings.autosaveTtlMs);
	}

	/** This person's notices, read from Redis now. `kept` and `titleFor` are git's (`keptDraftNotices`, `titleFor`). */
	async of(person: Person, kept: readonly { file: string; commit: string }[], titleFor: (file: string) => string): Promise<NoticeView[]> {
		const [dismissed, stood] = await this.redis.batch([
			['smembers', this.dismissedKey],
			['hgetall', this.noticesKey],
		] as const);
		return Notices.forPerson(person, kept, titleFor, new Set(dismissed), Object.values(stood));
	}

	/** This person's notices from what was read: the dismissed ids, and the stood notices' values. */
	static forPerson(
		person: Person,
		kept: readonly { file: string; commit: string }[],
		titleFor: (file: string) => string,
		dismissed: ReadonlySet<string>,
		stood: Iterable<string>,
	): NoticeView[] {
		const out: NoticeView[] = [];
		for (const n of kept) {
			const id = `kept:${n.file}:${n.commit}`;
			if (!dismissed.has(id)) out.push({ id, kind: 'draft-kept', file: n.file, title: titleFor(n.file) });
		}
		const email = person.email.toLowerCase();
		for (const raw of stood) {
			try {
				const n = JSON.parse(raw) as StoodNotice;
				if (n.for === email) out.push({ id: n.id, kind: n.kind === 'discarded' ? 'discarded' : 'published-as-it-stood', file: n.file, title: n.title, by: n.by, at: n.at });
			} catch {
				/* skip */
			}
		}
		return out;
	}
}
