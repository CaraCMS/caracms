// The editor's state, without a browser: the document store (the operations Phases
// 3 and 4 call), the keeper (Decisions 5 and 6: writes, the keep state, unsent edits
// and the "newer than its file" rule), the sidebar cookie, addresses and the brand ink.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { addressOf, refFromAddress } from '../src/editor/addresses.ts';
import { brandColours, contrast } from '../src/editor/brand.ts';
import { createDocumentStore, type DocumentChange } from '../src/editor/client/state/document-store.ts';
import { createKeeper, type KeeperStorage, type KeepState } from '../src/editor/client/state/keeper.ts';
import { parseDocumentText, type SiteDocument } from '../src/document.ts';
import { applyEdits } from '../src/serialize.ts';
import { groupKey, parseUiState, serializeUiState, withOpenAncestors, withRecent, withSide, withToggled } from '../src/editor/ui-state.ts';
import { fixtures, site } from './helpers/site.ts';

const base = readFileSync(`${fixtures}round-trip.json`, 'utf8');
const entry = { collection: 'pages', path: 'index', file: 'content/pages/index.json', url: '/', title: 'Home', label: 'Home', warning: null };
const newStore = () => createDocumentStore(site, { ref: { collection: 'pages', path: 'index' }, entry, base, document: parseDocumentText(base, site).document });

describe('the document store', () => {
	test('blocks get keys in file order, and the same keys every time (the server and the browser agree)', () => {
		const a = newStore().get().document.blocks.map((b) => b.key);
		const b = newStore().get().document.blocks.map((b) => b.key);
		assert.deepEqual(a, b);
		assert.equal(new Set(a).size, a.length);
	});

	test('setField: a new snapshot, the revision bumped, subscribers told; an equal value is no change', () => {
		const store = newStore();
		const changes: DocumentChange[] = [];
		store.subscribe((_, change) => changes.push(change));
		const before = store.get();
		const hero = before.document.blocks.find((b) => b.type === 'hero')!;
		store.setField(hero.key, 'intro', 'New intro', { origin: 'page' });
		assert.notEqual(store.get(), before);
		assert.equal(store.get().revision, 1);
		assert.equal(store.block(hero.key)!.data.intro, 'New intro');
		assert.equal(before.document.blocks.find((b) => b.key === hero.key)!.data.intro !== 'New intro', true, 'the old snapshot is untouched');
		assert.deepEqual(changes, [{ kind: 'field', key: hero.key, field: 'intro', origin: 'page' }]);
		store.setField(hero.key, 'intro', 'New intro');
		assert.equal(store.get().revision, 1);
	});

	test('an unknown block is not editable (Decision 21)', () => {
		const store = newStore();
		const unknown = store.get().document.blocks.find((b) => !b.known)!;
		store.setField(unknown.key, 'heading', 'x');
		assert.equal(store.get().revision, 0);
	});

	test('add, move, remove and Undo follow the serializer\'s model (source kept through moves, back on restore)', () => {
		const store = newStore();
		const start = store.wire();
		const [first, second] = store.get().document.blocks;
		store.moveBlock(first!.key, 1);
		assert.deepEqual(store.get().document.blocks.slice(0, 2).map((b) => b.key), [second!.key, first!.key]);
		assert.equal(store.block(first!.key)!.source, first!.source);
		const added = store.addBlock('text', 0);
		assert.equal(store.block(added)!.source, null);
		assert.equal(store.indexOf(added), 0);
		const entry = store.removeBlock(first!.key)!;
		assert.match(entry.label, /^Removed /);
		assert.equal(store.indexOf(first!.key), -1);
		assert.equal(store.undo(), entry);
		assert.equal(store.block(first!.key)!.source, first!.source);
		store.removeBlock(added);
		store.moveBlock(first!.key, 0);
		// Back to the start: the file comes back byte for byte.
		assert.deepEqual(store.wire(), start);
		assert.equal(applyEdits(base, store.wire() as SiteDocument, site), base);
	});

	test('a field change with an Undo label (dropping phone lines) can be undone', () => {
		const store = newStore();
		const hero = store.get().document.blocks.find((b) => b.type === 'hero')!;
		const was = hero.data.heading;
		store.setField(hero.key, 'heading', { lines: ['A'], phone: null }, { undoLabel: 'Phone uses the main lines again' });
		assert.equal(store.get().undo.at(-1)!.label, 'Phone uses the main lines again');
		store.undo();
		assert.deepEqual(store.block(hero.key)!.data.heading, was);
		assert.equal(store.undo(), null);
	});

	test('addBlock refuses a type the site doesn\'t declare', () => {
		assert.throws(() => newStore().addBlock('nope'), /isn't a block type/);
	});

	test('load starts a new session: new keys from b1, empty Undo, revision 0', () => {
		const store = newStore();
		store.removeBlock(store.keyAt(0)!);
		const changes: DocumentChange[] = [];
		store.subscribe((_, c) => changes.push(c));
		store.load({ ref: { collection: 'pages', path: 'about' }, entry, base, document: parseDocumentText(base, site).document }, { adopted: true });
		assert.equal(store.get().revision, 0);
		assert.deepEqual(store.get().undo, []);
		assert.equal(store.keyAt(0), 'b1');
		assert.deepEqual(changes, [{ kind: 'load', adopted: true }]);
	});
});

// ── The keeper ─────────────────────────────────────────────────────────────────

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

/** Manual timers. */
function clock() {
	let now = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	let id = 0;
	return {
		setTimer: (fn: () => void, ms: number) => {
			timers.set(++id, { at: now + ms, fn });
			return id;
		},
		clearTimer: (t: unknown) => void timers.delete(t as number),
		async advance(ms: number) {
			now += ms;
			for (const [key, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(key);
					timer.fn();
				}
			}
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
		},
	};
}

type Call = { body: { file: string; base: string; document: unknown } };

function harness(options: { fail?: () => boolean; storage?: MemoryStorage } = {}) {
	const storage = options.storage ?? new MemoryStorage();
	const calls: Call[] = [];
	const t = clock();
	let version = 0;
	const held: boolean[] = [];
	const keeper = createKeeper({
		site,
		storage,
		storageKey: 'site',
		setTimer: t.setTimer,
		clearTimer: t.clearTimer,
		log: () => {},
		onHeld: (h) => held.push(h),
		fetch: (async (_url: string, init: RequestInit) => {
			calls.push({ body: JSON.parse(String(init.body)) });
			if (options.fail?.()) throw new TypeError('Failed to fetch');
			return new Response(JSON.stringify({ ok: true, changed: true, mtimeMs: 1, version: `v${++version}` }), { status: 200 });
		}) as typeof fetch,
	});
	const states: KeepState[] = [];
	keeper.status.subscribe((s) => states.push(s.state));
	return { keeper, storage, calls, t, states, held };
}

const edit = (title: string) => ({ file: 'content/pages/index.json', base: 'BASE', document: { title, blocks: [] } });

describe('the keeper', () => {
	test('writes about a second after the last change, the whole document with its base; Keeping, then Kept', async () => {
		const { keeper, calls, t, states, storage } = harness();
		keeper.opened('pages/index', 'content/pages/index.json', 'v0');
		keeper.change('pages/index', edit('A'));
		await t.advance(500);
		keeper.change('pages/index', edit('AB'));
		await t.advance(900);
		assert.equal(calls.length, 0, 'not yet: a second after the last change');
		assert.equal(keeper.status.get().state, 'keeping');
		assert.equal(storage.map.size, 1, 'held in storage until the file has it');
		await t.advance(200);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0]!.body, edit('AB'));
		assert.equal(keeper.status.get().state, 'kept');
		assert.deepEqual(states, ['keeping', 'kept']);
		assert.equal(storage.map.size, 0, 'cleared once written');
	});

	test('a failed write: "can\'t reach the server" until a write succeeds; no timer retries; the next change does', async () => {
		let down = true;
		const { keeper, calls, t, storage } = harness({ fail: () => down });
		keeper.opened('pages/index', 'content/pages/index.json', 'v0');
		keeper.change('pages/index', edit('A'));
		await t.advance(1000);
		assert.equal(keeper.status.get().state, 'offline');
		await t.advance(60_000);
		assert.equal(calls.length, 1, 'nothing retries on its own');
		assert.equal(keeper.status.get().state, 'offline');
		const stored = JSON.parse(storage.map.get('caracms:unsent:site:pages/index')!);
		assert.deepEqual({ base: stored.base, title: stored.document.title, fileVersion: stored.fileVersion }, { base: 'BASE', title: 'A', fileVersion: 'v0' });
		down = false;
		keeper.change('pages/index', edit('AB'));
		assert.equal(keeper.status.get().state, 'offline', 'still saying so while the retry is pending');
		await t.advance(1000);
		assert.equal(calls.length, 2);
		assert.equal(keeper.status.get().state, 'kept');
		assert.equal(storage.map.size, 0);
	});

	test('a change made while a write is in flight goes out after it, against the version just written', async () => {
		const storage = new MemoryStorage();
		const bodies: string[] = [];
		let release: () => void = () => {};
		const t = clock();
		const keeper = createKeeper({
			site,
			storage,
			storageKey: 'site',
			setTimer: t.setTimer,
			clearTimer: t.clearTimer,
			log: () => {},
			fetch: (async (_u: string, init: RequestInit) => {
				bodies.push(JSON.parse(String(init.body)).document.title);
				if (bodies.length === 1) await new Promise<void>((r) => (release = r));
				return new Response(JSON.stringify({ ok: true, version: `v${bodies.length}` }));
			}) as typeof fetch,
		});
		keeper.opened('pages/index', 'content/pages/index.json', 'v0');
		keeper.change('pages/index', edit('A'));
		await t.advance(1000); // A is in flight, held at the server
		keeper.change('pages/index', edit('AB'));
		await t.advance(1000); // AB's timer fires during the flight: it waits
		assert.deepEqual(bodies, ['A']);
		release();
		await t.advance(0);
		assert.deepEqual(bodies, ['A', 'AB'], 'sent as soon as A returned');
		assert.equal(keeper.status.get().state, 'kept');
		assert.equal(storage.map.size, 0);
	});

	test('the re-send rule: a stored copy is dropped only when the file already holds it (keeper-recovery.test.ts has the full cases)', () => {
		const storage = new MemoryStorage();
		const document = { ...parseDocumentText(base, site).document, title: 'Held' };
		const held = JSON.stringify({ v: 1, file: 'content/pages/index.json', base, document, fileVersion: 'v7' });
		storage.setItem('caracms:unsent:site:pages/index', held);
		const { keeper } = harness({ storage });
		assert.equal(keeper.recoverable('pages/index', { version: 'v7', text: base })!.document.title, 'Held', 'the file is still at its version: re-sent');
		assert.equal(keeper.recoverable('pages/index', { version: 'v8', text: base })!.document.title, 'Held', 'the file moved on without them: re-sent, not dropped');
		assert.equal(storage.map.size, 1);
		assert.equal(keeper.recoverable('pages/index', { version: 'v8', text: applyEdits(base, document, site) }), null, 'the file holds them: dropped');
		assert.equal(storage.map.size, 0);
	});

	test('resend: adopted edits go out at once (Keeping until they land)', async () => {
		const storage = new MemoryStorage();
		storage.setItem('caracms:unsent:site:pages/index', JSON.stringify({ v: 1, ...edit('Held'), fileVersion: 'v7' }));
		const { keeper, calls, t } = harness({ storage });
		keeper.opened('pages/index', 'content/pages/index.json', 'v7');
		keeper.resend('pages/index', keeper.recoverable('pages/index', { version: 'v7', text: 'BASE' })!);
		assert.equal(keeper.status.get().state, 'keeping');
		await t.advance(0);
		assert.deepEqual(calls[0]!.body, edit('Held'));
		assert.equal(keeper.status.get().state, 'kept');
		assert.equal(storage.map.size, 0);
	});

	test('recoverOthers re-sends other documents\' edits the files don\'t hold, drops the ones they do, keeps a gone document\'s', async () => {
		const storage = new MemoryStorage();
		const fileBase = '{\n  "title": "Was",\n  "blocks": []\n}\n';
		const put = (id: string, fileVersion: string) =>
			storage.setItem(`caracms:unsent:site:${id}`, JSON.stringify({ v: 1, file: `content/${id}.json`, base: fileBase, document: { title: id, blocks: [] }, fileVersion }));
		put('pages/a', 'same');
		put('pages/b', 'old');
		put('pages/gone', 'x');
		storage.setItem('caracms:unsent:another-site:pages/a', '{}');
		const { keeper, calls, t } = harness({ storage });
		await keeper.recoverOthers('pages/index', async (id) =>
			id === 'pages/gone' ? null : id === 'pages/a' ? { version: 'same', text: fileBase } : { version: 'new', text: fileBase.replace('Was', id) },
		);
		await t.advance(0);
		assert.deepEqual(calls.map((c) => c.body.file), ['content/pages/a.json']);
		assert.deepEqual([...storage.map.keys()].sort(), ['caracms:unsent:another-site:pages/a', 'caracms:unsent:site:pages/gone']);
	});

	test('onHeld tells the editor when unsent edits start and stop being held (the cookie)', async () => {
		const { keeper, t, held } = harness();
		keeper.opened('pages/index', 'content/pages/index.json', 'v0');
		keeper.change('pages/index', edit('A'));
		await t.advance(1000);
		assert.deepEqual(held, [true, false]);
	});

	test('pagehide sends what\'s waiting with keepalive', async () => {
		const sent: RequestInit[] = [];
		const keeper = createKeeper({
			site,
			storage: new MemoryStorage(),
			storageKey: 'site',
			setTimer: () => 0,
			clearTimer: () => {},
			fetch: (async (_u: string, init: RequestInit) => {
				sent.push(init);
				return new Response('{}');
			}) as typeof fetch,
		});
		keeper.opened('pages/index', 'content/pages/index.json', 'v0');
		keeper.change('pages/index', edit('A'));
		keeper.pagehide();
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.keepalive, true);
	});
});

describe('the sidebar cookie (Decision 20)', () => {
	test('round-trips, and survives junk', () => {
		const state = { open: { 'pages:services': true, 'pages:about': false }, recent: ['pages/index'] };
		assert.deepEqual(parseUiState(serializeUiState(state)), state);
		assert.deepEqual(parseUiState(JSON.stringify(state)), state);
		assert.deepEqual(parseUiState('not json'), { open: {}, recent: [] });
		assert.deepEqual(parseUiState('{"open":{"x":"yes"},"recent":[1,"a"]}'), { open: {}, recent: ['a'] });
	});

	test('a hidden sidebar is kept (pre-M7 polish); shown leaves no key', () => {
		const hidden = withSide({ open: {}, recent: [] }, true);
		assert.deepEqual(hidden, { open: {}, recent: [], side: 'hidden' });
		assert.deepEqual(parseUiState(serializeUiState(hidden)), hidden);
		assert.deepEqual(withSide(hidden, false), { open: {}, recent: [] });
		assert.equal(withSide(hidden, true), hidden, 'no change, the same state');
		assert.deepEqual(parseUiState('{"open":{},"recent":[],"side":"sideways"}'), { open: {}, recent: [] });
	});

	test('opening a document opens the folders above it; toggles stick; Recent is newest first', () => {
		let state = withOpenAncestors({ open: { 'pages:services': false }, recent: [] }, { collection: 'pages', path: 'services/branding' });
		assert.equal(state.open[groupKey('pages', 'services')], true);
		state = withToggled(state, 'pages:services', false);
		assert.equal(state.open['pages:services'], false);
		state = withRecent(withRecent(state, { collection: 'pages', path: 'index' }), { collection: 'journal', path: 'x' });
		assert.deepEqual(state.recent, ['journal/x', 'pages/index']);
	});
});

describe('addresses (Decision 19)', () => {
	const home = { collection: 'pages', path: 'index' };
	test('/admin is Home; /admin/<collection>/<path> is a document', () => {
		assert.equal(addressOf(home, home), '/admin');
		assert.equal(addressOf({ collection: 'pages', path: 'services/branding' }, home), '/admin/pages/services/branding');
		assert.deepEqual(refFromAddress('/admin', ['pages', 'journal'], home), home);
		assert.deepEqual(refFromAddress('/admin/', ['pages', 'journal'], home), home);
		assert.deepEqual(refFromAddress('/admin/pages/services/branding', ['pages', 'journal'], home), { collection: 'pages', path: 'services/branding' });
		assert.deepEqual(refFromAddress('/admin/journal/my-post', ['pages', 'journal'], home), { collection: 'journal', path: 'my-post' });
		assert.equal(refFromAddress('/admin/nope/x', ['pages'], home), null);
		assert.equal(refFromAddress('/admin/pages', ['pages'], home), null);
		assert.equal(refFromAddress('/admin/pages/%E0%A4%A', ['pages'], home), null);
	});
});

describe('the brand accent (M2 Decision 5)', () => {
	test('ink by contrast; a pale accent gets a darker edge', () => {
		const navy = brandColours('#1f2f57');
		assert.deepEqual(navy, { accent: '#1f2f57', accentInk: '#ffffff', accentEdge: '#1f2f57' });
		const yellow = brandColours('#f6e27f');
		assert.equal(yellow.accentInk, '#26231c');
		assert.notEqual(yellow.accentEdge, '#f6e27f');
		assert.ok(contrast(yellow.accentEdge, '#ffffff') > contrast('#f6e27f', '#ffffff'));
		assert.equal(brandColours('#abc').accent, '#aabbcc');
	});
});
