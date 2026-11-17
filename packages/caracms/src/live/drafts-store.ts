/**
 * The live drafts store (M4 Decision 4), behind M3's `DraftsStore` seam
 * (editor/server/drafts-store.ts).
 *
 * - **`list` and `read`** come from the in-memory `drafts` copy with each document's
 *   Redis autosave on top, through content.ts's reader, so a document reads the same
 *   in both modes. `read` also says who last changed the document and the version
 *   that change left (Decision 11).
 * - **`write`** keeps M3's path rules (write.ts → `confinePath`), with existence checked
 *   against the copy, not the disk (which holds `main` from the build). It takes the
 *   lock (Decision 9: the first write takes it, atomically; anyone else's is a 409),
 *   then stores the whole document with its base as the autosave, with its editor
 *   and tab. **That's when the answer says Kept.** The sweep commits it later.
 * - Redis out past its 30-second budget is a 503 (`unavailable`): the keeper holds the
 *   edits and shows "can't reach the server".
 * - **Every kind of document** (M5a): the reserved `shared` and `settings` collections
 *   go through here like any other (Decision 8). **Site Settings' autosave is ready for
 *   the sweep at once** (`Autosave.sweepAtOnce`, Decision 10): no idle wait, so its
 *   `editors` and `brand` apply on the sweep's next tick, read from the copy.
 * - `source()`: the copy with every autosave on top, what a preview's render reads
 *   other documents from (Decision 9).
 * - **Creating and deleting** (M5a Decisions 11 and 12) go through the same pipeline as
 *   typing, with editor/server/create.ts's rules over this store's own listing.
 *   **`create`**: the creator's tab takes the lock, and the new document is its
 *   autosave (`created: { over }`, no base in `drafts`); from then on the listing, the
 *   waiting count and Publish see it. **`delete`**: the lock (someone else's refuses:
 *   "Aoife is editing Contact"), then a "gone" autosave (autosaves.ts), and the lock is
 *   marked releasing so it drops once the sweep has committed the removal. The copy
 *   with autosaves on top leaves a gone document out, so it leaves the listing and
 *   can't be opened or written. A document deleted since the last Publish can be made
 *   again: the new autosave replaces the pending deletion. `caracms:changed:` records
 *   both, a deletion with `gone`, so a viewer's poll can say who deleted it.
 */
import { join, relative, sep } from 'node:path';
import { SITE_SETTINGS_FILE, type ResolvedSite } from '../config.ts';
import { filesSource, listDocuments, readDocument, resolveDocumentFile } from '../content.ts';
import { assertSettingsReadable, FOLDER_GONE_MESSAGE, FOLDER_MISSHAPEN_MESSAGE, FOLDER_UNKEPT_MESSAGE, orderEdit, pageFilingEdit, planArrange, UNREADABLE_HAND_ORDER_MESSAGE } from '../editor/server/arrange.ts';
import { firstEdit, planCollectionOrder, settingsUnreadable, UNKEPT_PLACE_MESSAGE } from '../editor/server/collection-order.ts';
import { planCreate, planDelete, refused, target } from '../editor/server/create.ts';
import { movesChanges, moveResponse, movesUnder, planMoves, settingsWithoutRedirectFrom, type ManyMoveRequest, type MovePlan } from '../editor/server/move.ts';
import { isImageKey, replaceChanges, replaceResponse } from '../editor/server/replace.ts';
import { slotDefaultChanges, slotDefaultResponse } from '../editor/server/slot-default.ts';
import { parseAnyDocument } from '../document.ts';
import type { DraftsStore } from '../editor/server/drafts-store.ts';
import { confinePath, fileVersion, WriteRefused, writeText, type WriteContext, type WriteRequest, type WriteResponse } from '../editor/server/write.ts';
import type { CreateResponse, DeleteResponse, LastChange, LockRefusal, MoveResponse, ReplaceFileResponse, SlotDefaultResponse } from '../editor/types.ts';
import type { Autosave, Autosaves, ChangeRecord, Read } from './autosaves.ts';
import { titleOf, type LiveGit } from './git.ts';
import type { LockRecord, Locks } from './locks.ts';
import { displayName, type Person } from './messages.ts';
import { RedisUnavailableError } from './redis.ts';
import type { Sweep } from './sweep.ts';

type Site = Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>;

/** One autosave a write stored, and the one it replaced (none: there was none), so a move that fails part way can put it back. */
interface Written {
	prior: Read<Autosave> | null;
	wrote: Read<Autosave>;
}

export interface LiveStoreParts {
	site: Site;
	git: Pick<LiveGit, 'files' | 'read' | 'waiting' | 'changeOf'>;
	autosaves: Autosaves;
	locks: Locks;
	sweep: Pick<Sweep, 'poke' | 'commitFiles'>;
	now: () => number;
}

const posix = (p: string) => p.split(sep).join('/');

/** A Redis outage as the write route's answer: 503, so the keeper says "can't reach the server" and holds the edits. */
export function unavailable(error: unknown): WriteRefused {
	const what = error instanceof Error ? error.message : String(error);
	return new WriteRefused(503, `The server can't reach its store right now, so your changes are held in this browser (${what}).`, { code: 'unavailable' });
}

/**
 * Who last changed a file (Decision 11): Redis's record, else the newest editor git names
 * (Redis flushed while it waits). **Neither: unknown** (`known: false`). The records never
 * expire, so a file with none was never changed in the editor or Redis lost its data, and
 * the server can't tell which: the keeper holds edits on unknown rather than re-send them.
 */
/**
 * `known`: the file's change record as the caller already read it (the status poll's cache); otherwise read here.
 * Discard changes: its `discard` is `discarded`, so a browser drops edits held from before it.
 */
export async function lastChangeOf(parts: Pick<LiveStoreParts, 'git' | 'autosaves'>, file: string, known?: ChangeRecord | null): Promise<LastChange> {
	const record = known !== undefined ? known : await parts.autosaves.changed(file);
	const discarded = record?.discard ? { discarded: { by: record.discard.by, at: record.discard.at } } : {};
	if (record) return { by: record.by, version: record.version, at: record.at, ...discarded };
	const editor = parts.git.waiting().find((w) => w.file === file)?.editors[0];
	return editor ? { by: editor.person, version: null, at: editor.at, ...discarded } : { by: null, version: null, at: null, known: false, ...discarded };
}

export function liveDraftsStore(parts: LiveStoreParts): DraftsStore {
	const { site, git, autosaves, locks, sweep, now } = parts;

	/** The copy with these autosaves laid over it. */
	const overlay = (saves: Autosave[]) => {
		const files = new Map(git.files());
		for (const a of saves) {
			if (a.text === null) files.delete(a.file); // deleted (M5a): gone from the listing, can't be opened
			else files.set(a.file, a.text);
		}
		return filesSource(site.root, () => files);
	};

	const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
		try {
			return await fn();
		} catch (error) {
			if (error instanceof RedisUnavailableError) throw unavailable(error);
			throw error;
		}
	};

	/** The copy with every autosave on top, listed (create, delete and move check against it). */
	const listed = async () => listDocuments(site, undefined, overlay((await autosaves.all()).map((r) => r.value)));

	/**
	 * The documents list, each with when it was last edited (`mtimeMs`, the table's "Last
	 * edited"): its autosave's time while one waits, else its change record's (Decision 11:
	 * every write, create, delete and move sets one, and a change taken in from `main` sets
	 * one if there's none), all in one MGET with the autosaves' SCAN + MGET, so the time
	 * comes with the list. None of either (never changed in the editor, or Redis lost its
	 * data): null, shown as a dash.
	 */
	const list = async () => {
		const saves = (await autosaves.all()).map((r) => r.value);
		const entries = await listDocuments(site, undefined, overlay(saves));
		const pending = new Map(saves.map((a) => [a.file, a.updatedAt]));
		const records = await autosaves.changedMany(entries.map((e) => e.file));
		return entries.map((entry, i) => {
			const recorded = records[i]?.at ? Date.parse(records[i]!.at) : NaN;
			return { ...entry, mtimeMs: pending.get(entry.file) ?? (Number.isFinite(recorded) ? recorded : null) };
		});
	};

	/** A create's or delete's person and tab (defence in depth: the guard is the real check). */
	const who = (context: WriteContext | undefined) => {
		const person = context?.person ?? null;
		if (!person) throw new WriteRefused(401, 'signed-out', { code: 'signed-out' });
		const tab = context?.tab ?? null;
		if (!tab) throw new WriteRefused(400, 'Every request names its tab (X-Caracms-Tab).', { code: 'no-tab' });
		return { person, tab };
	};

	/**
	 * 409 `locked` with the lock's state (a LockRefusal). A delete: "Aoife is editing Contact."
	 * A create (someone's deletion of that document is still being committed): "Aoife is
	 * working on /contact right now, so it can't be created yet."
	 */
	const lockRefusal = async (file: string, held: LockRecord, tab: string, person: Person, what: { title: string } | { address: string }): Promise<never> => {
		const lock = locks.view(file, held, tab, person);
		const body: Omit<LockRefusal, 'error'> = {
			code: 'locked',
			lock,
			state: lock.mine === 'other-tab' ? 'yours-elsewhere' : 'theirs',
			lastChange: await lastChangeOf(parts, file),
		};
		const message =
			'title' in what
				? lock.mine
					? `You're editing ${what.title} in another tab.`
					: `${displayName(lock.person)} is editing ${what.title}.`
				: `${lock.mine ? 'You are' : `${displayName(lock.person)} is`} working on ${what.address} right now, so it can't be created yet.`;
		throw new WriteRefused(409, message, body);
	};

	/**
	 * One file's autosave, as a write stores it (pre-M7 item 8's move, and a create's
	 * redirect): this tab's own autosave's base kept, another tab's committed first.
	 * The caller holds the file's lock.
	 */
	const stash = async (file: string, tab: string, make: (prior: Autosave | null, current: string | null) => Autosave): Promise<Written> => {
		let committed: string | null = null;
		for (let attempt = 1; ; attempt++) {
			if (attempt > 6) throw new Error('caracms: the autosave kept changing under the move.');
			const existing = await autosaves.get(file);
			if (existing && existing.value.tab !== tab && !existing.value.gone && existing.raw !== committed) {
				committed = existing.raw;
				await sweep.commitFiles([file]);
				continue;
			}
			const next = make(existing && existing.value.tab === tab ? existing.value : null, git.read(file));
			if (await autosaves.putIf(existing, next)) return { prior: existing, wrote: { raw: JSON.stringify(next), value: next } };
		}
	};
	/** A same-tab autosave's `ancestor`, kept with its `base` (autosaves.ts). */
	const carried = (prior: Autosave | null): Pick<Autosave, 'ancestor'> => (prior?.ancestor !== undefined ? { ancestor: prior.ancestor } : {});
	/** A whole new text for a file, as its autosave (for `stash`). */
	const saved =
		(file: string, text: string, collection: string, person: Person, tab: string, t: number) =>
		(prior: Autosave | null, current: string | null): Autosave => ({
			file,
			base: prior ? prior.base : (current ?? text),
			...carried(prior),
			document: parseAnyDocument(JSON.parse(text), site, site.collections[collection]!),
			text,
			editor: person,
			tab,
			firstAt: prior?.firstAt ?? t,
			updatedAt: t,
			seq: null,
			...(file === SITE_SETTINGS_FILE ? { sweepAtOnce: true } : {}),
			// Made since the last Publish (or Site Settings made by a move): still new until it's committed.
			...(prior?.created ? { created: prior.created } : current === null ? { created: { over: null } } : {}),
		});

	/**
	 * A failed move's rollback: each autosave it stored goes back to the one it replaced
	 * (newest first), only while it's still the move's (a newer write wins), and every lock
	 * it took is released. Best effort: one step failing (Redis down) doesn't stop the rest,
	 * and the move's own error is what the caller sees.
	 */
	const undo = async (written: Written[], took: string[], tab: string, person: Person) => {
		for (const w of [...written].reverse()) {
			try {
				if (w.prior) await autosaves.replaceIf(w.wrote, w.prior.value);
				else await autosaves.removeIf(w.wrote);
			} catch {
				// Left as the move wrote it: nothing more can be done without the store.
			}
		}
		for (const f of took) {
			try {
				await locks.release(f, tab, person);
			} catch {
				// The lock's own expiry drops it.
			}
		}
	};

	/**
	 * Every file a move (or a Replace…) writes, this tab's before anything is written:
	 * someone else's lock on one refuses the whole change with `why`'s sentence (nothing is
	 * changed); your own lock in another tab moves here, as Edit here moves it. Each lock
	 * this took is pushed onto `took` as it's taken, so a refusal part way can release them.
	 */
	const takeAll = async (files: readonly string[], tab: string, person: Person, took: string[], why: (file: string, who: string, mine: boolean) => string) => {
		for (const file of files) {
			const before = await locks.read(file);
			let taken = await locks.acquire(file, tab, person);
			// Your own lock in another tab (one left open, or just closed) moves here, as Edit here moves it.
			if (!taken.ok && taken.lock.person.email.toLowerCase() === person.email.toLowerCase()) taken = await locks.take(file, tab, person);
			if (!taken.ok) {
				const lock = locks.view(file, taken.lock, tab, person);
				const body: Omit<LockRefusal, 'error'> = { code: 'locked', lock, state: lock.mine === 'other-tab' ? 'yours-elsewhere' : 'theirs', lastChange: await lastChangeOf(parts, file) };
				throw new WriteRefused(409, why(file, lock.mine ? 'You are' : `${displayName(lock.person)} is`, !!lock.mine), body);
			}
			if (!(before && before.lock.tab === tab)) took.push(file);
		}
	};

	/**
	 * A create's Site Settings edit, as an autosave of this tab's, when Site Settings is free:
	 * pre-M7 item 8, a new page at an address that redirected takes the redirect out; review
	 * gaps (Decision 4), a manual collection's new entry goes first in its order. `edit` gives
	 * null for no change. Someone else editing Site Settings leaves it as it is (the page wins
	 * over a redirect anyway: the server only redirects a 404) and answers false.
	 */
	const editSettingsIfFree = async (edit: (text: string | null) => string | null, person: Person, tab: string, t: number): Promise<boolean> => {
		const current = (await autosaves.get(SITE_SETTINGS_FILE))?.value;
		const text = current ? current.text : git.read(SITE_SETTINGS_FILE);
		if (edit(text) === null) return true;
		const before = await locks.read(SITE_SETTINGS_FILE);
		if (!(await locks.acquire(SITE_SETTINGS_FILE, tab, person)).ok) return false;
		let after: string | null = null;
		await stash(SITE_SETTINGS_FILE, tab, (prior, drafts) => {
			const now = prior ? prior.text : drafts;
			after = edit(now) ?? now;
			return saved(SITE_SETTINGS_FILE, after!, 'settings', person, tab, t)(prior, drafts);
		});
		if (after !== null) await autosaves.setChanged(SITE_SETTINGS_FILE, { by: person, version: fileVersion(after), at: new Date(t).toISOString() });
		if (!(before && before.lock.tab === tab)) await locks.release(SITE_SETTINGS_FILE, tab, person);
		return true;
	};

	/**
	 * A write of Site Settings alone (an order-only Apply, Decision 21; a hand order, review
	 * gaps Decision 2): its lock taken (someone else's refuses it, saying it holds `what`),
	 * the text checked readable, `edit` stored as one autosave of this tab's, the lock let go
	 * again unless this tab already had it. A failure puts the autosave back.
	 */
	const settingsAlone = async (edit: (text: string | null) => string | null, person: Person, tab: string, what: string, unreadable?: string) => {
		const took: string[] = [];
		const written: Written[] = [];
		try {
			await takeAll([SITE_SETTINGS_FILE], tab, person, took, (_file, who, mine) => `${who} editing Site Settings${mine ? ' in another tab' : ''}, which holds ${what}, so the order can't change until ${mine ? 'that tab is closed' : "they're done"}.`);
			const current = (await autosaves.get(SITE_SETTINGS_FILE))?.value.text ?? git.read(SITE_SETTINGS_FILE);
			assertSettingsReadable(site, current, unreadable);
			const next = edit(current);
			if (next !== null && next !== current) {
				const t = now();
				let after = next;
				written.push(
					await stash(SITE_SETTINGS_FILE, tab, (prior, drafts) => {
						const base = prior ? prior.text : drafts;
						after = edit(base) ?? base ?? next;
						return saved(SITE_SETTINGS_FILE, after, 'settings', person, tab, t)(prior, drafts);
					}),
				);
				await autosaves.setChanged(SITE_SETTINGS_FILE, { by: person, version: fileVersion(after), at: new Date(t).toISOString() });
			}
		} catch (error) {
			await undo(written, took, tab, person);
			throw error;
		}
		for (const f of took) await locks.release(f, tab, person);
		sweep.poke();
	};

	/**
	 * The many-move engine (collections under pages, Contracts; pre-M7 item 8's move, for any
	 * number of documents): the plan is checked as a whole against the listing with every
	 * autosave on top (move.ts → `planMoves`), then:
	 *
	 * - **Every file it writes is this tab's before anything is written** (`takeAll`): each
	 *   moved document's old and new file, every linking file, Site Settings. Someone else's
	 *   lock on any one refuses the whole move (nothing is changed), naming them and the
	 *   document; the mover's own lock in another tab moves to this one. A held document whose
	 *   file stays (its holder moved) is written, and locked, only when its own links change.
	 * - **It lands whole or leaves nothing behind.** Each autosave it stores is noted with the
	 *   one it replaced; any failure puts them back newest first, compare-and-set against what
	 *   the move wrote, and releases every lock it took. The new documents first, then the
	 *   linking files, a file another move vacates written over (a swap), the old files gone,
	 *   and Site Settings (the one autosave the sweep commits at once) last, so a sweep tick
	 *   can't commit a redirect for a move that then fails.
	 * - **A document that was never live gets no redirect**: one made since the last Publish,
	 *   or one already moved since then (its live address already redirects, and follows).
	 *   But when a move vacates an address that is another document's live address (a chain
	 *   before the Publish: A → B, then B's document to C, so B had none), it redirects to
	 *   where that document is now, so the old public address still finds it.
	 *   Each refiled document's move is recorded for Publish ("Moved from"), and every changed
	 *   address's live one (autosaves.ts → `recordAddresses`), so a held document whose file
	 *   stays is named too.
	 */
	const moveMany = (request: ManyMoveRequest, context?: WriteContext): Promise<MoveResponse> =>
		guard(async () => {
			const { person, tab } = who(context);
			const documents = await listed();
			const plans = planMoves(site, request.moves, documents);
			const source = overlay((await autosaves.all()).map((r) => r.value));
			const addresses = await autosaves.addresses();
			const onMain = (file: string) => git.changeOf(file, '') === 'changed';
			const wasLive = (p: MovePlan) => onMain(p.from.file) && !addresses.has(p.from.file);
			// A live address a chain left without a redirect gets one once a move vacates it (move.ts → `movesChanges`).
			const liveAddressOf = request.redirect === false ? undefined : (file: string) => addresses.get(file) ?? null;
			const changes = await movesChanges(site, plans, documents, (file) => source.readText(join(site.root, file)), (p) => request.redirect !== false && wasLive(p), request.editSettings, liveAddressOf);
			const refiled = plans.filter((p) => p.refiled);
			const vacated = new Set(refiled.map((p) => p.from.file));
			const targets = new Set(refiled.map((p) => p.to.file));
			const files = [...new Set([...refiled.flatMap((p) => [p.from.file, p.to.file]), ...changes.relinked.map((r) => r.file), ...(changes.settings ? [SITE_SETTINGS_FILE] : [])])];
			const root = plans[0]!;
			const movingWith = new Map(plans.filter((p) => !p.refiled).map((p) => [p.from.file, p]));

			const took: string[] = [];
			const written: Written[] = [];
			try {
				await takeAll(files, tab, person, took, (file, who, mine) => {
					const elsewhere = mine ? ' in another tab' : '';
					const until = `so the address can't change until ${mine ? 'that tab is closed' : "they're done"}.`;
					const from = refiled.find((p) => p.from.file === file);
					if (from) return `${who} editing ${from.title}${elsewhere}, so ${from === root ? 'its' : `${root.title}'s`} address can't change yet.`;
					const to = refiled.find((p) => p.to.file === file);
					if (to) return `${who} working on ${to.to.url} right now, so ${to.title} can't move there yet.`;
					if (file === SITE_SETTINGS_FILE) return `${who} editing Site Settings${elsewhere}, which holds the redirects, ${until}`;
					const name = changes.relinked.find((r) => r.file === file)?.title ?? file;
					return movingWith.has(file) ? `${who} editing ${name}${elsewhere}, which moves with ${root.title}, ${until}` : `${who} editing ${name}${elsewhere}, which links to ${plans.length === 1 ? root.from.url : 'an address that changes'}, ${until}`;
				});

				const t = now();
				const at = new Date(t).toISOString();
				// The new documents first, as a create makes one: an autosave with no base in drafts.
				// Made there since the listing was read: it exists. A pending deletion there is replaced.
				for (const { plan, text } of changes.moved) {
					if (vacated.has(plan.to.file)) continue;
					for (let attempt = 1; ; attempt++) {
						if (attempt > 6) throw new Error('caracms: the autosave kept changing under the move.');
						const existing = await autosaves.get(plan.to.file);
						const over = git.read(plan.to.file);
						if ((existing && !existing.value.gone) || (!existing && over !== null)) throw refused(409, 'address-taken', `There's already a page at ${plan.to.url}.`);
						const next: Autosave = { ...saved(plan.to.file, text, plan.to.collection, person, tab, t)(null, null), base: text, created: { over } };
						if (await autosaves.putIf(existing, next)) {
							written.push({ prior: existing, wrote: { raw: JSON.stringify(next), value: next } });
							break;
						}
					}
				}
				for (const r of changes.relinked) written.push(await stash(r.file, tab, saved(r.file, r.text, r.collection, person, tab, t)));
				// A file another move in the plan vacates (a swap) is written over, as an edit.
				for (const { plan, text } of changes.moved) if (vacated.has(plan.to.file)) written.push(await stash(plan.to.file, tab, saved(plan.to.file, text, plan.to.collection, person, tab, t)));
				// Then the old ones go, as a delete removes one.
				for (const plan of refiled) {
					if (targets.has(plan.from.file)) continue;
					const oldTitle = titleOf(plan.from.file, git.read(plan.from.file) ?? (await source.readText(join(site.root, plan.from.file))));
					written.push(
						await stash(plan.from.file, tab, (prior, current) => ({
							file: plan.from.file,
							base: prior ? prior.base : (current ?? ''),
							...carried(prior),
							document: null,
							text: null,
							editor: person,
							tab,
							firstAt: prior?.firstAt ?? t,
							updatedAt: t,
							seq: null,
							...(prior?.created ? { created: prior.created } : {}),
							gone: { title: oldTitle },
						})),
					);
				}
				// The redirects last (see above).
				if (changes.settings) written.push(await stash(SITE_SETTINGS_FILE, tab, saved(SITE_SETTINGS_FILE, changes.settings.after, 'settings', person, tab, t)));

				const texts: [string, string][] = [...changes.moved.map((m): [string, string] => [m.plan.to.file, m.text]), ...changes.relinked.map((r): [string, string] => [r.file, r.text]), ...(changes.settings ? [[SITE_SETTINGS_FILE, changes.settings.after] as [string, string]] : [])];
				for (const [file, text] of texts) await autosaves.setChanged(file, { by: person, version: fileVersion(text), at });
				for (const plan of refiled) if (!targets.has(plan.from.file)) await autosaves.setChanged(plan.from.file, { by: person, version: '', at, gone: true });
				// The moves themselves, kept until they're published: the waiting list and Publish read them, not the redirects.
				await autosaves.recordMoves(refiled.map((plan) => ({ from: plan.from.file, to: plan.to.file, wasLive: onMain(plan.from.file) })));
				await autosaves.recordAddresses(plans.map((p) => ({ from: p.from.file, to: p.to.file, fromUrl: p.from.url, toUrl: p.to.url, wasLive: onMain(p.from.file) })));
			} catch (error) {
				await undo(written, took, tab, person);
				throw error;
			}
			// The tab moves on to the asked-for document's new address, keeping its lock there; the others go once committed.
			for (const plan of refiled) if (!targets.has(plan.from.file)) await locks.release(plan.from.file, tab, person, { deleted: true });
			for (const f of took) if (f !== root.to.file && !(vacated.has(f) && !targets.has(f))) await locks.release(f, tab, person);
			sweep.poke();
			return moveResponse(plans, changes);
		});

	return {
		source: () =>
			guard(async () => overlay((await autosaves.all()).map((r) => r.value))),

		list: () => guard(list),

		read: (collection, path) =>
			guard(async () => {
				const file = posix(relative(site.root, resolveDocumentFile(site, collection, path)));
				const save = (await autosaves.get(file))?.value ?? null;
				const read = await readDocument(site, collection, path, overlay(save ? [save] : []), { untitled: true });
				return { ...read, mtimeMs: save?.updatedAt ?? 0, version: fileVersion(read.text), lastChange: await lastChangeOf(parts, file) };
			}),

		write: (request: WriteRequest, context?: WriteContext): Promise<WriteResponse> =>
			guard(async () => {
				const person = context?.person ?? null;
				if (!person) throw new WriteRefused(401, 'signed-out', { code: 'signed-out' });
				const tab = context?.tab ?? null;
				if (!tab) throw new WriteRefused(400, 'Every write names its tab (X-Caracms-Tab).', { code: 'no-tab' });

				const target = confinePath(site, request.file);
				const current = git.read(request.file);
				// It exists: in the copy, or as a new document's autosave (M5a); a "gone" autosave is a deletion.
				const missing = () => new WriteRefused(404, `${site.collections[target.collection]!.label}: no document "${target.path}".`);
				const [saved, changed] = await autosaves.getWithChange(request.file);
				if (saved?.value.gone || (current === null && !saved)) throw missing();
				// Discard changes: a tab that had the document when someone put it back to what's live
				// can't write until it has let go of its copy (it's stale: its edits would come back).
				const discard = changed?.discard;
				if (discard && discard.tabs.includes(tab)) {
					const title = saved?.value.text ? titleOf(request.file, saved.value.text) : titleOf(request.file, current);
					throw new WriteRefused(409, `${displayName(discard.by)} discarded the unpublished changes to ${title}, so these edits weren't kept.`, { code: 'discarded', by: discard.by, at: discard.at });
				}

				const text = writeText(site, target.collection, request);

				const refuse = async (held: LockRecord): Promise<never> => {
					const lock = locks.view(request.file, held, tab, person);
					const body: Omit<LockRefusal, 'error'> = {
						code: 'locked',
						lock,
						state: lock.mine === 'other-tab' ? 'yours-elsewhere' : 'theirs',
						lastChange: await lastChangeOf(parts, request.file),
					};
					const who = lock.mine ? 'you, in another tab' : displayName(lock.person);
					throw new WriteRefused(409, `This document is being edited by ${who}, so your changes weren't kept.`, body);
				};
				const taken = await locks.acquire(request.file, tab, person);
				if (!taken.ok) await refuse(taken.lock);

				// Compare-and-set against the autosave as read, so a write that lands late never
				// replaces a newer one: from this tab, a lower `seq` is older (its pagehide write
				// and a normal write racing); from another tab, it's stored only while this tab
				// still holds the lock (an old tab's write that got past `acquire` before Edit
				// here moved the lock is refused, not answered Kept).
				const seq = context?.seq ?? null;
				let existing: Read<Autosave> | null = null;
				let committed: string | null = null;
				let t = now();
				for (let attempt = 1; ; attempt++) {
					if (attempt > 6) throw new Error('caracms: the autosave kept changing under the write.');
					existing = await autosaves.get(request.file);
					if (existing?.value.gone || (current === null && !existing)) throw missing(); // deleted meanwhile
					if (existing && existing.value.tab !== tab) {
						const held = await locks.read(request.file);
						if (!held) {
							// The lock went meanwhile: take it again (or be refused), then look again.
							const again = await locks.acquire(request.file, tab, person);
							if (!again.ok) await refuse(again.lock);
							continue;
						}
						if (held.lock.tab !== tab || held.lock.person.email.toLowerCase() !== person.email.toLowerCase()) await refuse(held.lock);
						// The lock moved (Edit here) over an autosave from another tab that this tab's document may not hold: commit it first.
						if (existing.value.text !== request.base && existing.raw !== committed) {
							committed = existing.raw;
							await sweep.commitFiles([request.file]);
							continue;
						}
					}
					const prior = existing?.value;
					if (prior && prior.tab === tab && seq !== null && typeof prior.seq === 'number' && prior.seq > seq) {
						// This tab already stored a newer write: this one is older and changes nothing. The tab's own newer document is what's kept.
						if (context?.release) await locks.release(request.file, tab, person);
						return { ok: true, file: request.file, changed: false, mtimeMs: prior.updatedAt, version: fileVersion(prior.text ?? '') };
					}
					t = now();
					// The merge's ancestor stays what `drafts` had under the autosave this write replaces, when
					// this write's base is something else: it can be that autosave's own text, opened before the
					// sweep committed it (a move's redirect in Site Settings, then edits on top), and as the
					// ancestor that text would read the uncommitted change as one `drafts` made, and undo it.
					const under = prior && (prior.tab === tab || prior.text === request.base) ? (prior.ancestor ?? prior.base) : request.base;
					const next: Autosave = {
						file: request.file,
						base: request.base,
						...(under !== request.base ? { ancestor: under } : {}),
						document: request.document,
						text,
						editor: person,
						tab,
						firstAt: prior?.firstAt ?? t, // the first write since the last commit (the cap)
						updatedAt: t,
						seq,
						// Decision 10: Site Settings' editors and brand apply on the sweep's next tick, never after an idle wait.
						...(request.file === SITE_SETTINGS_FILE ? { sweepAtOnce: true } : {}),
						// M5a: a new document stays one (its ancestor `drafts`' file then) until the sweep commits it.
						...(prior?.created ? { created: prior.created } : {}),
					};
					if (await autosaves.putIf(existing, next)) break;
				}
				const version = fileVersion(text);
				await autosaves.setChanged(request.file, { by: person, version, at: new Date(t).toISOString(), ...autosaves.carryDiscard(changed) });
				if (context?.release) await locks.release(request.file, tab, person);
				sweep.poke();
				return { ok: true, file: request.file, changed: text !== (existing?.value.text ?? current), mtimeMs: t, version };
			}),

		create: (request, context): Promise<CreateResponse> =>
			guard(async () => {
				const { person, tab } = who(context);
				const documents = await listed();
				const plan = planCreate(site, request, documents);
				const taken = await locks.acquire(plan.file, tab, person);
				if (!taken.ok) await lockRefusal(plan.file, taken.lock, tab, person, { address: plan.url ?? plan.path });
				const t = now();
				for (let attempt = 1; ; attempt++) {
					if (attempt > 6) throw new Error('caracms: the autosave kept changing under the create.');
					const existing = await autosaves.get(plan.file);
					const over = git.read(plan.file);
					// Made since the listing was read (or there all along): it exists. A pending deletion is replaced.
					if ((existing && !existing.value.gone) || (!existing && over !== null)) {
						throw refused(409, 'exists', plan.url ? `There's already a page at ${plan.url}.` : `There's already a document called "${plan.path}".`);
					}
					const next: Autosave = {
						file: plan.file,
						base: plan.text,
						document: plan.document,
						text: plan.text,
						editor: person,
						tab,
						firstAt: t,
						updatedAt: t,
						seq: null,
						created: { over },
					};
					if (await autosaves.putIf(existing, next)) break;
				}
				const version = fileVersion(plan.text);
				await autosaves.setChanged(plan.file, { by: person, version, at: new Date(t).toISOString() });
				const first = firstEdit(site, plan.collection, plan.path);
				// Page folders: a new page's slug leaves any folder it's still listed in, and New page in <Folder> files it.
				const filing = pageFilingEdit(site, plan.collection, plan.path, request.folder, documents.filter((d) => d.collection === plan.collection).map((d) => d.path));
				// Site Settings that can't be read keeps no place: the entry is made, and the editor is told (as a drag is refused).
				let unreadable = false;
				const edit = (text: string | null) => {
					unreadable = settingsUnreadable(site, text);
					const base = settingsWithoutRedirectFrom(site, text, plan.url) ?? text;
					const placed = first && !unreadable ? (first(base) ?? base) : base;
					const after = filing && !unreadable ? (filing.edit(placed) ?? placed) : placed;
					return after === text ? null : after;
				};
				const free = await editSettingsIfFree(edit, person, tab, t);
				sweep.poke();
				const placedAs = (gone: boolean) =>
					unreadable ? { order: 'unkept' as const, orderError: first ? UNKEPT_PLACE_MESSAGE : FOLDER_UNKEPT_MESSAGE } : gone ? { order: 'unkept' as const, orderError: FOLDER_GONE_MESSAGE } : { order: free ? ('first' as const) : ('waiting' as const) };
				const filed = request.folder !== undefined && filing ? (free && !unreadable && filing.misshapen() ? { order: 'unkept' as const, orderError: FOLDER_MISSHAPEN_MESSAGE } : placedAs(free && filing.gone())) : {};
				return { ok: true, collection: plan.collection, path: plan.path, file: plan.file, url: plan.url, version, ...(first ? placedAs(false) : {}), ...filed };
			}),

		move: async (request, context): Promise<MoveResponse> => {
			const documents = await listed();
			const moves = movesUnder(site, request, documents);
			// Arrange pages (Decision 6): a saved order follows the move, in the same Site Settings write.
			return moveMany({ moves, ...(request.redirect === false ? { redirect: false } : {}), editSettings: orderEdit(site, moves, documents) }, context);
		},

		moveMany: (request, context) => moveMany(request, context),

		/**
		 * Arrange pages (Contracts): the plan against the listing with every autosave on top,
		 * then the moves through `moveMany` (every lock up front, someone else's on any file
		 * refuses it all, a rollback on any failure) with the arranged order riding its Site
		 * Settings write. The engine keeps the first document's lock, as Change address…'s tab
		 * moves on to it; the arrange screen has no document open, so it's let go here. With no
		 * moves (Decision 21), Site Settings alone, under its lock, as one autosave.
		 */
		arrange: (request, context) =>
			guard(async () => {
				const { person, tab } = who(context);
				const plan = planArrange(site, request, await listed());
				// An unreadable Site Settings would drop the order and the redirects without a word: refuse every Apply.
				if (plan.moves.length) assertSettingsReadable(site, (await autosaves.get(SITE_SETTINGS_FILE))?.value.text ?? git.read(SITE_SETTINGS_FILE));
				if (plan.moves.length) {
					const first = plan.moves[0]!;
					const kept = target(site, first.collection, first.to).file;
					const before = await locks.read(kept);
					await moveMany({ moves: plan.moves, ...(request.redirect === false ? { redirect: false } : {}), editSettings: (text) => plan.edit(text) ?? text }, context);
					if (!(before && before.lock.tab === tab)) await locks.release(kept, tab, person);
					return { ok: true as const };
				}
				await settingsAlone(plan.edit, person, tab, 'the order of the Pages tree');
				return { ok: true as const };
			}),

		/**
		 * Review gaps (Decisions 2 and 4): a manual collection's hand order, checked against the
		 * listing with every autosave on top, then Site Settings alone, under its lock, as one
		 * autosave (the order-only Apply's way).
		 */
		collectionOrder: (request, context) =>
			guard(async () => {
				const { person, tab } = who(context);
				const plan = planCollectionOrder(site, request, await listed());
				await settingsAlone(plan.edit, person, tab, `the order of ${site.collections[plan.collection]!.label}`, UNREADABLE_HAND_ORDER_MESSAGE);
				return { ok: true as const };
			}),

		/**
		 * M6c G4 (Decision 9): Replace… on a file. Every document with a link to the old file
		 * (replace.ts, read with the autosaves on top) is this tab's before anything is written,
		 * as a move's are (takeAll); then each rewritten text is its autosave (stash), noted with
		 * the one it replaced, so a failure part way puts them all back (undo) and releases the
		 * locks: **it lands whole or leaves every document as it was**. The rewritten documents
		 * are waiting changes, going live with the next Publish.
		 */
		replaceFile: (request, context): Promise<ReplaceFileResponse> =>
			guard(async () => {
				const { person, tab } = who(context);
				const documents = await listed();
				const source = overlay((await autosaves.all()).map((r) => r.value));
				const changes = await replaceChanges(site, request, documents, (file) => source.readText(join(site.root, file)));
				const took: string[] = [];
				const written: Written[] = [];
				try {
					await takeAll(
						changes.map((c) => c.file),
						tab,
						person,
						took,
						(file, who, mine) => `${who} editing ${changes.find((c) => c.file === file)?.title ?? file}${mine ? ' in another tab' : ''}, which ${isImageKey(request.from) ? 'uses this image' : 'links here'}. Try once ${mine ? 'that tab is closed' : "they're done"}.`,
					);
					const t = now();
					const at = new Date(t).toISOString();
					// Site Settings (the one autosave the sweep commits at once) last, as a move stores its redirect last.
					const ordered = [...changes.filter((c) => c.file !== SITE_SETTINGS_FILE), ...changes.filter((c) => c.file === SITE_SETTINGS_FILE)];
					for (const c of ordered) written.push(await stash(c.file, tab, saved(c.file, c.text, c.collection, person, tab, t)));
					for (const c of ordered) await autosaves.setChanged(c.file, { by: person, version: fileVersion(c.text), at });
				} catch (error) {
					await undo(written, took, tab, person);
					throw error;
				}
				for (const f of took) await locks.release(f, tab, person);
				sweep.poke();
				return replaceResponse(request, changes);
			}),

		/**
		 * Edit in context, Decision 3: a slot block made its slot's default. The other defaults of
		 * that slot (slot-default.ts, read with the autosaves on top) are this tab's before anything
		 * is written, as Replace…'s are (takeAll): someone else editing one refuses it all, naming
		 * them. Each is then stored as an autosave without its `default`, landing whole or rolled back.
		 */
		slotDefault: (request, context): Promise<SlotDefaultResponse> =>
			guard(async () => {
				const { person, tab } = who(context);
				const documents = await listed();
				const source = overlay((await autosaves.all()).map((r) => r.value));
				const changes = await slotDefaultChanges(site, request, documents, (file) => source.readText(join(site.root, file)));
				const title = documents.find((d) => d.collection === 'shared' && d.path === request.path)?.label ?? request.path;
				const took: string[] = [];
				const written: Written[] = [];
				try {
					await takeAll(
						changes.map((c) => c.file),
						tab,
						person,
						took,
						(file, who, mine) => `${who} editing ${changes.find((c) => c.file === file)?.title ?? file}${mine ? ' in another tab' : ''}, so ${title} can't be the default yet. Try once ${mine ? 'that tab is closed' : "they're done"}.`,
					);
					const t = now();
					const at = new Date(t).toISOString();
					for (const c of changes) written.push(await stash(c.file, tab, saved(c.file, c.text, c.collection, person, tab, t)));
					for (const c of changes) await autosaves.setChanged(c.file, { by: person, version: fileVersion(c.text), at });
				} catch (error) {
					await undo(written, took, tab, person);
					throw error;
				}
				for (const f of took) await locks.release(f, tab, person);
				sweep.poke();
				return slotDefaultResponse(request, changes);
			}),

		delete: (request, context): Promise<DeleteResponse> =>
			guard(async () => {
				const { person, tab } = who(context);
				const plan = planDelete(site, request, await listed());
				const title = plan.entry.label;
				const taken = await locks.acquire(plan.file, tab, person);
				if (!taken.ok) await lockRefusal(plan.file, taken.lock, tab, person, { title });
				let committed: string | null = null;
				const t = now();
				for (let attempt = 1; ; attempt++) {
					if (attempt > 6) throw new Error('caracms: the autosave kept changing under the delete.');
					const existing = await autosaves.get(plan.file);
					const current = git.read(plan.file);
					if (existing?.value.gone || (!existing && current === null)) throw refused(404, 'not-found', `${site.collections[plan.collection]!.label}: no document "${plan.path}".`);
					if (existing && existing.value.tab !== tab && existing.raw !== committed) {
						// Another tab's autosave under a lock this tab now holds: commit it first, under its editor's name.
						committed = existing.raw;
						await sweep.commitFiles([plan.file]);
						continue;
					}
					const prior = existing && existing.value.tab === tab ? existing.value : null;
					const next: Autosave = {
						file: plan.file,
						// The text this tab's session was on (its own autosave's base), else drafts' copy:
						// the sweep works out the merge's ancestor from it as for any autosave.
						base: prior ? prior.base : (current ?? ''),
						...carried(prior),
						document: null,
						text: null,
						editor: person,
						tab,
						firstAt: prior?.firstAt ?? t,
						updatedAt: t,
						seq: null,
						...(prior?.created ? { created: prior.created } : {}),
						// The title before the removal: drafts' copy, else the new document's own.
						gone: { title: titleOf(plan.file, current ?? prior?.text ?? null) },
					};
					if (await autosaves.putIf(existing, next)) break;
				}
				await autosaves.setChanged(plan.file, { by: person, version: '', at: new Date(t).toISOString(), gone: true });
				await autosaves.forgetMoveTo(plan.file);
				// The deleter's tab moves on: the lock drops once the sweep has committed the removal.
				await locks.release(plan.file, tab, person, { deleted: true });
				sweep.poke();
				return { ok: true, collection: plan.collection, path: plan.path, file: plan.file };
			}),
	};
}
