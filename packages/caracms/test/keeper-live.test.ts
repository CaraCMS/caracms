// The keeper in live mode (M4 Phase 4; Decisions 4, 9 and 11): the tab header and the
// release on every closing write, a 409 held (not refused), a 401 signed out, the retry
// timer only while offline with its countdown and the unsent count, and the re-send
// rule decided by the server's `lastChange`. Local mode's behaviour is
// editor-state.test.ts's and keeper-recovery.test.ts's, unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { createKeeper, holdsEdits, verdict, type KeeperStorage } from '../src/editor/client/state/keeper.ts';
import { ENDPOINTS, RELEASE_HEADER, SEQ_HEADER, TAB_HEADER, type LockRefusal, type SignedOutError } from '../src/editor/types.ts';
import { parseAnyDocument, parseDocumentText, type SiteDocument } from '../src/document.ts';
import { resolveSite, select, text } from '../src/config.ts';
import { applyDocumentEdits, applyEdits } from '../src/serialize.ts';
import { config, fixtures, site, siteRoot, variant } from './helpers/site.ts';

const base = readFileSync(`${fixtures}round-trip.json`, 'utf8');
const HOME = 'content/pages/index.json';
const AOIFE = { email: 'aoife@example.com' };
const NIAMH = { email: 'niamh@example.com' };

class MemoryStorage implements KeeperStorage {
	map = new Map<string, string>();
	get length() {
		return this.map.size;
	}
	key(i: number) {
		return [...this.map.keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.map.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.map.set(k, v);
	}
	removeItem(k: string) {
		this.map.delete(k);
	}
}

function clock() {
	let now = 1_000_000;
	const timers = new Map<number, { at: number; fn: () => void }>();
	let id = 0;
	return {
		now: () => now,
		setTimer: (fn: () => void, ms: number) => {
			timers.set(++id, { at: now + ms, fn });
			return id;
		},
		clearTimer: (t: unknown) => void timers.delete(t as number),
		pending: () => timers.size,
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				now = next[1].at;
				timers.delete(next[0]);
				next[1].fn();
				await new Promise((r) => setTimeout(r, 0));
			}
			now = end;
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
		},
	};
}

interface Call {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
	keepalive: boolean;
}

function harness(answer: (call: Call, n: number) => Response | Promise<Response>, options: { storage?: MemoryStorage; locked?: string[] } = {}) {
	const storage = options.storage ?? new MemoryStorage();
	const t = clock();
	const calls: Call[] = [];
	const locked: { file: string; refusal: LockRefusal }[] = [];
	const signedOut: SignedOutError[] = [];
	const keeper = createKeeper({
		site,
		storage,
		storageKey: 'site',
		setTimer: t.setTimer,
		clearTimer: t.clearTimer,
		now: t.now,
		log: () => {},
		tab: 'tab-1',
		retryDelays: [3000, 6000, 12000],
		you: () => NIAMH,
		lockedFiles: () => options.locked ?? [],
		onLocked: (file, refusal) => locked.push({ file, refusal }),
		onSignedOut: (body) => signedOut.push(body),
		fetch: (async (url: string, init: RequestInit) => {
			const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)), keepalive: !!init.keepalive };
			calls.push(call);
			return answer(call, calls.length);
		}) as typeof fetch,
	});
	return { keeper, storage, t, calls, locked, signedOut };
}

const ok = (version = 'v1') => new Response(JSON.stringify({ ok: true, changed: true, mtimeMs: 1, version }), { status: 200 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const edit = (title: string) => ({ file: HOME, base, document: { ...parseDocumentText(base, site).document, title } });
const refusal = (state: 'theirs' | 'yours-elsewhere'): LockRefusal => ({
	error: 'This document is being edited by aoife, so your changes weren\'t kept.',
	code: 'locked',
	state,
	lock: { file: HOME, person: state === 'theirs' ? AOIFE : NIAMH, since: new Date().toISOString(), releasing: false, mine: state === 'theirs' ? null : 'other-tab' },
	lastChange: { by: state === 'theirs' ? AOIFE : NIAMH, version: 'theirs-v', at: new Date().toISOString() },
});

describe('the keeper, live mode', () => {
	test('every write names its tab; Kept once the server has it', async () => {
		const { keeper, t, calls } = harness(() => ok());
		keeper.opened('pages/index', HOME, 'v0');
		keeper.change('pages/index', edit('A'));
		await t.advance(1000);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.headers[TAB_HEADER], 'tab-1');
		assert.equal(calls[0]!.headers[RELEASE_HEADER], undefined, 'only the closing write releases');
		assert.equal(keeper.status.get().state, 'kept');
	});

	test('pagehide: the last write carries the release; a locked file with nothing unsent gets a keepalive release of its own', async () => {
		const { keeper, calls } = harness(() => ok(), { locked: [HOME, 'content/pages/about.json'] });
		keeper.opened('pages/index', HOME, 'v0');
		keeper.change('pages/index', edit('A'));
		keeper.pagehide();
		await new Promise((r) => setTimeout(r, 0));
		const write = calls.find((c) => c.url === ENDPOINTS.write)!;
		assert.equal(write.keepalive, true);
		assert.equal(write.headers[TAB_HEADER], 'tab-1');
		assert.equal(write.headers[RELEASE_HEADER], '1');
		const releases = calls.filter((c) => c.url === ENDPOINTS.lock);
		assert.deepEqual(
			releases.map((c) => [c.body.file, c.body.action, c.keepalive, c.headers[TAB_HEADER]]),
			[['content/pages/about.json', 'release', true, 'tab-1']],
			'Home is released by its own write; About, with nothing unsent, by a release',
		);
	});

	test('a 409 locked is held, not refused: the editor hears it, the next change doesn\'t retry it, Use mine sends it', async () => {
		let lockedOut = true;
		const { keeper, t, calls, locked, storage } = harness((c) => (lockedOut && c.body.file === HOME ? json(409, refusal('theirs')) : ok('v2')));
		keeper.opened('pages/index', HOME, 'v0');
		keeper.change('pages/index', edit('A'));
		await t.advance(1000);
		assert.equal(keeper.status.get().state, 'held');
		assert.deepEqual(keeper.status.get().held, [{ id: 'pages/index', file: HOME, reason: 'locked', by: AOIFE, elsewhere: false }]);
		assert.equal(locked.length, 1);
		assert.equal(locked[0]!.refusal.state, 'theirs');
		assert.equal(storage.map.size, 1, 'held in storage');
		keeper.change('pages/other', { ...edit('B'), file: 'content/pages/other.json' });
		await t.advance(1000);
		assert.equal(calls.filter((c) => c.body.file === HOME).length, 1, 'not retried by another change');
		assert.equal(t.pending(), 0, 'no retry timer for a lock');
		lockedOut = false;
		keeper.useMine('pages/index');
		await t.advance(0);
		assert.equal(calls.filter((c) => c.body.file === HOME).length, 2);
		assert.equal(keeper.status.get().state, 'kept');
		assert.equal(storage.map.size, 0);
	});

	test('your own lock in another tab: held, marked elsewhere (Use mine at once)', async () => {
		const { keeper, t } = harness(() => json(409, refusal('yours-elsewhere')));
		keeper.opened('pages/index', HOME, 'v0');
		keeper.change('pages/index', edit('A'));
		await t.advance(1000);
		assert.equal(keeper.status.get().held?.[0]?.elsewhere, true);
	});

	test('a 401 is signed out, edits held; once the session is back, recheck sends them', async () => {
		let out = true;
		const body: SignedOutError = { error: "You're signed out.", code: 'signed-out', reason: 'signed-out', signIn: '/admin/login' };
		const { keeper, t, calls, signedOut } = harness(() => (out ? json(401, body) : ok('v2')));
		keeper.opened('pages/index', HOME, 'v0');
		keeper.change('pages/index', edit('A'));
		keeper.change('pages/index', edit('AB'));
		await t.advance(1000);
		assert.equal(keeper.status.get().state, 'signedout');
		assert.equal(keeper.status.get().unsent, 2, 'two changes the server doesn\'t have');
		assert.deepEqual(signedOut, [body]);
		assert.deepEqual(keeper.blocked(), [{ id: 'pages/index', file: HOME, failure: 'signedout' }]);
		await t.advance(60_000);
		assert.equal(calls.length, 1, 'nothing retries while signed out');
		out = false;
		// The server's copy is still the one these edits were made on: re-sent.
		assert.equal(keeper.recheck('pages/index', { version: 'v0', text: base, lastChange: { by: null, version: null, at: null } }), 'send');
		await t.advance(0);
		assert.equal(calls.length, 2);
		assert.equal(keeper.status.get().state, 'kept');
	});

	test('offline: the retry timer runs only while offline, backing off, with the countdown; Try now; the unsent count', async () => {
		let down = true;
		const { keeper, t, calls } = harness(() => {
			if (down) throw new TypeError('Failed to fetch');
			return ok();
		});
		keeper.opened('pages/index', HOME, 'v0');
		keeper.change('pages/index', edit('A'));
		keeper.change('pages/index', edit('AB'));
		keeper.change('pages/index', edit('ABC'));
		await t.advance(1000);
		let s = keeper.status.get();
		assert.equal(s.state, 'offline');
		assert.equal(s.unsent, 3);
		assert.equal(s.retryAt, t.now() + 3000, 'the first retry in 3 s');
		await t.advance(3000);
		assert.equal(calls.length, 2, 'the timer retried');
		s = keeper.status.get();
		assert.equal(s.retryAt, t.now() + 6000, 'then 6 s');
		keeper.tryNow();
		await t.advance(0);
		assert.equal(calls.length, 3, 'Try now retries at once');
		down = false;
		keeper.tryNow();
		await t.advance(0);
		s = keeper.status.get();
		assert.equal(s.state, 'kept');
		assert.equal(s.retryAt, null);
		assert.equal(t.pending(), 0, 'no timer once the server answers');
		await t.advance(120_000);
		assert.equal(calls.length, 4, 'and nothing after');
	});

	test('the re-send rule decided with lastChange (Decision 11)', () => {
		const document = { ...parseDocumentText(base, site).document, title: 'Mine' };
		const held = { base, document, fileVersion: 'made-on' };
		const other = base.replace('"title": "', '"title": "Changed ');
		const lc = (by: { email: string } | null, version: string | null = 'x') => ({ by, version, at: null });
		assert.equal(verdict(held, { version: 'made-on', text: other, lastChange: lc(AOIFE) }, site, NIAMH), 'send', 'still at its version');
		assert.equal(verdict(held, { version: 'moved', text: applyEdits(base, document, site), lastChange: lc(AOIFE) }, site, NIAMH), 'drop', 'the server holds them');
		assert.equal(verdict(held, { version: 'moved', text: other, lastChange: lc(null) }, site, NIAMH), 'send', 'only merges known');
		assert.equal(verdict(held, { version: 'moved', text: other, lastChange: lc(NIAMH) }, site, NIAMH), 'send', 'your own change');
		assert.equal(verdict(held, { version: 'moved', text: other, lastChange: lc(AOIFE, 'made-on') }, site, NIAMH), 'send', 'their change is what these were made on');
		assert.deepEqual(verdict(held, { version: 'moved', text: other, lastChange: lc(AOIFE) }, site, NIAMH), { conflict: AOIFE }, 'another editor since');
		assert.deepEqual(verdict(held, { version: 'moved', text: other, lastChange: lc(AOIFE, null) }, site, NIAMH), { conflict: AOIFE }, 'known from git only: compared by text');
		assert.equal(verdict(held, { version: 'moved', text: other }, site, NIAMH), 'send', 'local mode: M3\'s rule');
	});

	test('M6c G2: a page-field edit already written is held by the server text, so another editor\'s later change drops it', () => {
		const g2 = resolveSite(
			variant({ collections: { ...config.collections, games: { kind: 'sections', folder: 'content/games', urlBase: '/games/', fields: { tagline: text(), side: select({ options: ['left', 'right'] }) } } } }),
			siteRoot,
		);
		const games = g2.collections.games!;
		const gameBase = '{\n  "title": "Kites",\n  "tagline": "Fly one",\n  "side": "left",\n  "blocks": []\n}\n';
		const opened = parseAnyDocument(JSON.parse(gameBase), g2, games) as SiteDocument;
		const document = { ...opened, data: { ...opened.data, tagline: 'Fly two' } };
		const written = applyDocumentEdits(gameBase, document, g2, games);
		assert.notEqual(written, gameBase);
		const held = { base: gameBase, document, fileVersion: 'made-on' };
		assert.equal(holdsEdits(written, held, g2), true, 'the written text holds the page-field edit');
		assert.equal(holdsEdits(gameBase, held, g2), false, 'the base does not');
		const lastChange = { by: AOIFE, version: 'moved', at: null };
		assert.equal(verdict(held, { version: 'moved', text: written, lastChange }, g2, NIAMH), 'drop', 'already on the server: dropped, not a conflict');
		assert.deepEqual(verdict(held, { version: 'moved', text: gameBase.replace('"Kites"', '"Theirs"'), lastChange }, g2, NIAMH), { conflict: AOIFE }, 'not held: still a conflict');
	});

	test('on load, another editor\'s change since holds the edits for Use mine or Discard mine', async () => {
		const storage = new MemoryStorage();
		const document = { ...parseDocumentText(base, site).document, title: 'Mine' };
		storage.setItem('caracms:unsent:site:pages/index', JSON.stringify({ v: 1, file: HOME, base, document, fileVersion: 'made-on' }));
		const { keeper, t, calls } = harness(() => ok(), { storage });
		const now = { version: 'moved', text: base.replace('"title": "', '"title": "Theirs '), lastChange: { by: AOIFE, version: 'moved', at: null } };
		keeper.opened('pages/index', HOME, 'moved');
		const found = keeper.recover('pages/index', now)!;
		assert.equal(found.send, false);
		assert.deepEqual(found.by, AOIFE);
		keeper.hold('pages/index', found.stored, found.by);
		await t.advance(5000);
		assert.equal(calls.length, 0, 'not re-sent over someone else\'s work');
		assert.equal(keeper.status.get().held?.[0]?.reason, 'conflict');
		keeper.discard('pages/index');
		assert.equal(storage.map.size, 0, 'Discard mine drops them');
		assert.equal(keeper.status.get().state, 'kept');
	});

	test('recoverOthers leaves a conflict in storage, unsent', async () => {
		const storage = new MemoryStorage();
		const document = { ...parseDocumentText(base, site).document, title: 'Mine' };
		storage.setItem('caracms:unsent:site:pages/about', JSON.stringify({ v: 1, file: 'content/pages/about.json', base, document, fileVersion: 'made-on' }));
		const { keeper, t, calls } = harness(() => ok(), { storage });
		await keeper.recoverOthers('pages/index', async () => ({ version: 'moved', text: '{}', lastChange: { by: AOIFE, version: 'moved', at: null } }));
		await t.advance(0);
		assert.equal(calls.length, 0);
		assert.equal(storage.map.size, 1);
	});

	test('unknown (the server can\'t tell who changed it): held as a conflict, never re-sent', async () => {
		const document = { ...parseDocumentText(base, site).document, title: 'Mine' };
		const held = { base, document, fileVersion: 'made-on' };
		const other = base.replace('"title": "', '"title": "Changed ');
		const unknown = { by: null, version: null, at: null, known: false };
		assert.deepEqual(verdict(held, { version: 'moved', text: other, lastChange: unknown }, site, NIAMH), { conflict: null });
		assert.equal(verdict(held, { version: 'made-on', text: other, lastChange: unknown }, site, NIAMH), 'send', 'still at its version: nothing wrote it since');
		assert.equal(verdict(held, { version: 'moved', text: applyEdits(base, document, site), lastChange: unknown }, site, NIAMH), 'drop', 'the server already holds them');
		// The keeper: recheck holds them (Use mine / Discard mine), and sends nothing.
		const { keeper, t, calls } = harness(() => json(401, { error: 'signed-out', code: 'signed-out', reason: 'signed-out', signIn: '/admin/login' }));
		keeper.opened('pages/index', HOME, 'made-on');
		keeper.change('pages/index', edit('Mine'));
		await t.advance(1000);
		assert.equal(calls.length, 1);
		assert.equal(keeper.recheck('pages/index', { version: 'moved', text: other, lastChange: unknown }), 'conflict');
		await t.advance(10_000);
		assert.equal(calls.length, 1, 'not re-sent');
		assert.equal(keeper.status.get().state, 'held');
		assert.deepEqual(keeper.status.get().held?.map((h) => [h.reason, h.by]), [['conflict', null]]);
	});

	test('every write carries the tab\'s write sequence, rising (the pagehide write too)', async () => {
		const { keeper, t, calls } = harness(() => ok());
		keeper.opened('pages/index', HOME, 'v0');
		keeper.change('pages/index', edit('A'));
		await t.advance(1000);
		keeper.change('pages/index', edit('AB'));
		await t.advance(1000);
		keeper.change('pages/index', edit('ABC'));
		keeper.pagehide();
		const seqs = calls.filter((c) => c.url === ENDPOINTS.write).map((c) => Number(c.headers[SEQ_HEADER]));
		assert.equal(seqs.length, 3);
		assert.ok(seqs.every((n) => Number.isSafeInteger(n) && n > 0));
		assert.ok(seqs[0]! < seqs[1]! && seqs[1]! < seqs[2]!, `rising: ${seqs.join(', ')}`);
	});
});

describe('the keeper, live timing (Redis diet Decision 10)', () => {
	/** As the editor wires it: the tab holds a file once a write for it was Kept (or `held` says so). */
	function timed(answer: (call: Call, n: number) => Response | Promise<Response> = () => ok(), held = new Set<string>()) {
		const t = clock();
		const calls: Call[] = [];
		const keeper = createKeeper({
			site,
			storage: new MemoryStorage(),
			storageKey: 'site',
			setTimer: t.setTimer,
			clearTimer: t.clearTimer,
			now: t.now,
			log: () => {},
			tab: 'tab-1',
			retryDelays: [3000],
			you: () => NIAMH,
			holds: (file) => held.has(file),
			onKept: (file) => held.add(file),
			keepDelay: 3000,
			keepCap: 15_000,
			fetch: (async (url: string, init: RequestInit) => {
				const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)), keepalive: !!init.keepalive };
				calls.push(call);
				return answer(call, calls.length);
			}) as typeof fetch,
		});
		keeper.opened('pages/index', HOME, 'v0');
		return { keeper, t, calls, held };
	}
	const writes = (calls: Call[]) => calls.filter((c) => c.url === ENDPOINTS.write);

	test('the first change goes at once (it takes the lock); once Kept, the next goes 3 s after the last change', async () => {
		const { keeper, t, calls } = timed();
		keeper.change('pages/index', edit('A'));
		await t.advance(0);
		assert.equal(writes(calls).length, 1, 'at once');
		keeper.change('pages/index', edit('AB'));
		await t.advance(2999);
		assert.equal(writes(calls).length, 1);
		await t.advance(1);
		assert.equal(writes(calls).length, 2, '3 s after the last change');
		assert.equal(writes(calls)[1]!.body.document && (writes(calls)[1]!.body.document as { title: string }).title, 'AB');
	});

	test('typing steadily: a keep at least every 15 s; stopping: one keep 3 s later', async () => {
		const at: number[] = [];
		const { keeper, t, calls } = timed(() => {
			at.push(t.now());
			return ok();
		}, new Set([HOME]));
		const start = t.now();
		for (let i = 0; i < 40; i++) {
			keeper.change('pages/index', edit(`T${i}`));
			await t.advance(1000);
		}
		assert.ok(at.length >= 2, `keeps while typing: ${at.length}`);
		let last = start;
		for (const a of at) {
			assert.ok(a - last <= 15_000, `a gap of ${a - last} ms`);
			last = a;
		}
		const stopped = t.now() - 1000; // the last change
		const before = writes(calls).length;
		await t.advance(5000);
		assert.equal(writes(calls).length, before + 1, 'one keep after stopping');
		assert.equal(at.at(-1), stopped + 3000);
	});

	test('changes during the first write (not yet Kept) wait by the same rule, not one write per change', async () => {
		let release!: () => void;
		const { keeper, t, calls } = timed((_c, n) => (n === 1 ? new Promise<Response>((r) => (release = () => r(ok()))) : ok()));
		keeper.change('pages/index', edit('A'));
		await t.advance(0);
		assert.equal(writes(calls).length, 1);
		keeper.change('pages/index', edit('AB'));
		await t.advance(500);
		keeper.change('pages/index', edit('ABC'));
		release();
		await t.advance(0);
		assert.equal(writes(calls).length, 1, 'the write returned with the document changed again: it waits');
		await t.advance(2999);
		assert.equal(writes(calls).length, 1);
		await t.advance(1);
		assert.equal(writes(calls).length, 2, '3 s after the last change');
		await t.advance(10_000);
		assert.equal(writes(calls).length, 2);
	});

	test('a write held up past the delay: the change waiting goes when it returns', async () => {
		let release!: () => void;
		const { keeper, t, calls } = timed((_c, n) => (n === 2 ? new Promise<Response>((r) => (release = () => r(ok()))) : ok()), new Set([HOME]));
		keeper.change('pages/index', edit('A'));
		await t.advance(3000);
		assert.equal(writes(calls).length, 1);
		keeper.change('pages/index', edit('AB'));
		await t.advance(3000);
		assert.equal(writes(calls).length, 2, 'in flight');
		keeper.change('pages/index', edit('ABC'));
		await t.advance(4000);
		assert.equal(writes(calls).length, 2, 'one write per document in flight');
		release();
		await t.advance(0);
		assert.equal(writes(calls).length, 3, 'its 3 s had passed: at once');
	});

	test('a document not held and nothing in flight: at once, every time (a 409 never makes it held)', async () => {
		const { keeper, t, calls } = timed((_c) => json(409, refusal('theirs')));
		keeper.change('pages/index', edit('A'));
		await t.advance(0);
		assert.equal(writes(calls).length, 1);
		assert.equal(keeper.status.get().state, 'held');
	});

	test('local mode (no holds) keeps its 1 s after the last change', async () => {
		const t = clock();
		const calls: string[] = [];
		const keeper = createKeeper({
			site,
			storage: new MemoryStorage(),
			storageKey: 'site',
			setTimer: t.setTimer,
			clearTimer: t.clearTimer,
			now: t.now,
			log: () => {},
			fetch: (async (url: string) => {
				calls.push(url);
				return ok();
			}) as typeof fetch,
		});
		keeper.opened('pages/index', HOME, 'v0');
		keeper.change('pages/index', edit('A'));
		await t.advance(999);
		assert.equal(calls.length, 0);
		await t.advance(1);
		assert.equal(calls.length, 1);
	});
});
