// Collections under pages, after the review: the many-move engine with swaps and chains.
// Change address… never makes one, but the arrange screen will call `moveMany` with them
// and the Contracts allow swaps. Every move is taken against the state before the plan:
// - the redirect fold (redirects.ts → `redirectsAfterMoves`): a swap adds nothing and
//   leaves no redirect from an address a document now holds; a chain adds only the move
//   whose old address is left empty; earlier redirects follow the document they pointed at;
// - live mode's records (autosaves.ts → `recordAddresses`, `recordMoves`): each document
//   keeps its own live address, so the waiting list names both, and a move after Publish
//   gets the right redirect.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { SITE_SETTINGS_FILE } from '../src/config.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { handleMove } from '../src/editor/server/move.ts';
import type { CreateDeleteRefusal, MoveResponse, StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { parseRedirects, redirectsAfterMove, redirectsAfterMoves, type Redirect } from '../src/redirects.ts';
import type { CreateSite } from './helpers/create-site.ts';
import { makeHolderSite } from './helpers/move-site.ts';

const ORIGIN = 'http://site.test';
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const TAB_A = 'tab-aoife-1';
const TAB_C = 'tab-ciaran-1';

const SWAP = [
	{ collection: 'pages', path: 'contact', to: 'visit' },
	{ collection: 'pages', path: 'visit', to: 'contact' },
];
const CHAIN = [
	{ collection: 'pages', path: 'contact', to: 'visit' },
	{ collection: 'pages', path: 'visit', to: 'hours' },
];

const redirectsOf = (text: string) => parseRedirects(JSON.parse(text).redirects);
const pairs = (list: readonly Redirect[]) => list.map((r) => `${r.from} → ${r.to}`).sort();

describe('the redirect fold, all moves at once', () => {
	const before: Redirect[] = [
		{ from: '/old-visit', to: '/visit' },
		{ from: '/studio/visit', to: '/elsewhere' },
	];

	test('a swap adds nothing; an earlier redirect follows its document; one from a now-taken address goes', () => {
		const swap = [
			{ from: '/contact', to: '/visit', add: true },
			{ from: '/visit', to: '/contact', add: true },
		];
		assert.deepEqual(pairs(redirectsAfterMoves(before, swap)), ['/old-visit → /contact', '/studio/visit → /elsewhere']);
		// A stale entry from an address a document now holds (the per-move fold left `/visit → /contact` behind).
		assert.deepEqual(pairs(redirectsAfterMoves([{ from: '/visit', to: '/contact' }], swap)), []);
	});

	test('a chain: the first move redirects (its old address is empty), the second doesn\'t (a document is there)', () => {
		const chain = [
			{ from: '/contact', to: '/visit', add: true },
			{ from: '/visit', to: '/hours', add: true },
		];
		assert.deepEqual(pairs(redirectsAfterMoves(before, chain)), ['/contact → /visit', '/old-visit → /hours', '/studio/visit → /elsewhere']);
	});

	test('with no address both left and taken, it is the per-move fold, in order', () => {
		const plan = [
			{ from: '/visit', to: '/find-us', add: true },
			{ from: '/work', to: '/studio', add: false },
			{ from: '/work/kiln', to: '/studio/kiln', add: true },
		];
		let sequential: Redirect[] = [...before, { from: '/x', to: '/work' }, { from: '/studio', to: '/gone' }];
		const start = sequential;
		for (const m of plan) sequential = redirectsAfterMove(sequential, m.from, m.to, m.add);
		assert.deepEqual(redirectsAfterMoves(start, plan), sequential);
	});
});

// ── Local ────────────────────────────────────────────────────────────────────

describe('local: swaps and chains', () => {
	test('a swap: both pages trade places, no redirect is added, the earlier one follows Visit', async () => {
		const s = makeHolderSite();
		try {
			const r = await localDraftsStore(s.site).moveMany({ moves: SWAP });
			assert.deepEqual(r.redirects, []);
			assert.match(readFileSync(join(s.root, 'content/pages/visit.json'), 'utf8'), /"title": "Contact"/);
			assert.deepEqual(pairs(redirectsOf(readFileSync(join(s.root, SITE_SETTINGS_FILE), 'utf8'))), ['/old-visit → /contact', '/studio/visit → /elsewhere']);
		} finally {
			s.cleanup();
		}
	});

	test('a chain: Contact to /visit, Visit to /hours', async () => {
		const s = makeHolderSite();
		try {
			const r = await localDraftsStore(s.site).moveMany({ moves: CHAIN });
			assert.deepEqual(pairs(r.redirects), ['/contact → /visit']);
			assert.match(readFileSync(join(s.root, 'content/pages/hours.json'), 'utf8'), /"title": "Visit"/);
			assert.match(readFileSync(join(s.root, 'content/pages/visit.json'), 'utf8'), /"title": "Contact"/);
			assert.deepEqual(pairs(redirectsOf(readFileSync(join(s.root, SITE_SETTINGS_FILE), 'utf8'))), ['/contact → /visit', '/old-visit → /hours', '/studio/visit → /elsewhere']);
		} finally {
			s.cleanup();
		}
	});
});

// ── Live ─────────────────────────────────────────────────────────────────────

const settings: LiveSettings = {
	github: { kind: 'memory' },
	redisUrl: null,
	secret: 's'.repeat(32),
	allow: [],
	webhookSecret: null,
	railway: null,
	backup: null,
	runningCommit: null,
	timings: { ...DEFAULT_TIMINGS },
	production: false,
};

interface World {
	backend: MemoryBackend;
	ed: LiveEditor;
	s: CreateSite;
}

async function world(): Promise<World> {
	const s = makeHolderSite({ repoPath: 'starter' });
	const clock = { t: Date.parse('2026-10-25T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	backend.seed([...(await siteFiles(s.site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const rt = await createLiveRuntime({ site: s.site, settings, backend, redis: memoryRedis({ now: () => clock.t }), now: () => clock.t, log: () => {}, runningCommit: () => null });
	const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	return { backend, ed, s };
}
function request(path: string, init: { tab?: string | null; body?: unknown } = {}) {
	const headers: Record<string, string> = { origin: ORIGIN };
	if (init.tab) headers['x-caracms-tab'] = init.tab;
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return new Request(`${ORIGIN}${path}`, { method: init.body === undefined ? 'GET' : 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
async function call<T = Record<string, unknown>>(res: Promise<Response>): Promise<{ status: number; body: T }> {
	const r = await res;
	return { status: r.status, body: (await r.json()) as T };
}
const move = (w: World, body: Record<string, unknown>) => call<MoveResponse & CreateDeleteRefusal>(handleMove(request('/_caracms/move', { tab: TAB_A, body }), w.ed.store, { person: aoife }));
const publish = (w: World) => call<{ result: string }>(w.ed.publish(request('/_caracms/publish', { body: {} }), aoife));
const poll = async (w: World) => (await call<StatusResponse>(w.ed.status(request('/_caracms/status', { tab: TAB_C }), ciaran))).body;
const movedFrom = async (w: World) =>
	Object.fromEntries(
		(await poll(w)).waiting
			.filter((x) => x.movedFrom)
			.map((x) => [x.file, x.movedFrom])
			.sort(),
	);
const draftRedirects = async (w: World) => pairs(redirectsOf((await w.ed.store.read('settings', 'site-settings')).text));
const mainRedirects = (w: World) => pairs(redirectsOf(w.backend.file('main', `starter/${SITE_SETTINGS_FILE}`)!));

describe('live: swaps and chains', () => {
	test('a swap: each document keeps its own live address; a move before Publish adds no wrong redirect; one after Publish adds the right one', async () => {
		const w = await world();
		try {
			const r = await w.ed.store.moveMany({ moves: SWAP }, { person: aoife, tab: TAB_A, release: false });
			assert.deepEqual(r.redirects, []);
			assert.deepEqual(Object.fromEntries(await w.ed.autosaves.addresses()), { 'content/pages/visit.json': '/contact', 'content/pages/contact.json': '/visit' });
			assert.deepEqual(await movedFrom(w), { 'content/pages/contact.json': '/visit', 'content/pages/visit.json': '/contact' });
			assert.deepEqual(await draftRedirects(w), ['/old-visit → /contact', '/studio/visit → /elsewhere']);

			// Contact (now at /visit) moves on before Publish: /visit was Visit's live address, never Contact's,
			// so it redirects to Visit, where it is now (the chain gap's rule, move-live-chain-gap.test.ts).
			const on = await move(w, { collection: 'pages', path: 'visit', to: 'find-us' });
			assert.equal(on.status, 200, JSON.stringify(on.body));
			assert.deepEqual(pairs(on.body.redirects), ['/visit → /contact']);
			assert.ok(!(await draftRedirects(w)).includes('/visit → /find-us'), (await draftRedirects(w)).join(', '));
			assert.ok((await draftRedirects(w)).includes('/visit → /contact'), (await draftRedirects(w)).join(', '));
			assert.equal((await movedFrom(w))['content/pages/find-us.json'], '/contact');

			assert.equal((await publish(w)).body.result, 'published');
			assert.deepEqual(await movedFrom(w), {});
			// After Publish, Visit lives at /contact: moving it redirects from there.
			const after = await move(w, { collection: 'pages', path: 'contact', to: 'visit-us' });
			assert.equal(after.status, 200, JSON.stringify(after.body));
			assert.deepEqual(pairs(after.body.redirects), ['/contact → /visit-us']);
			assert.ok((await draftRedirects(w)).includes('/old-visit → /visit-us'), (await draftRedirects(w)).join(', '));
		} finally {
			w.s.cleanup();
		}
	});

	test('a chain: each document moved from its own live address, the redirects as they end up, and a move after Publish follows', async () => {
		const w = await world();
		try {
			const r = await w.ed.store.moveMany({ moves: CHAIN }, { person: aoife, tab: TAB_A, release: false });
			assert.deepEqual(pairs(r.redirects), ['/contact → /visit']);
			assert.deepEqual(Object.fromEntries(await w.ed.autosaves.moves()), { 'content/pages/contact.json': 'content/pages/visit.json', 'content/pages/visit.json': 'content/pages/hours.json' });
			assert.deepEqual(Object.fromEntries(await w.ed.autosaves.addresses()), { 'content/pages/visit.json': '/contact', 'content/pages/hours.json': '/visit' });
			assert.deepEqual(await movedFrom(w), { 'content/pages/hours.json': '/visit', 'content/pages/visit.json': '/contact' });
			assert.deepEqual(await draftRedirects(w), ['/contact → /visit', '/old-visit → /hours', '/studio/visit → /elsewhere']);

			assert.equal((await publish(w)).body.result, 'published');
			assert.deepEqual(mainRedirects(w), ['/contact → /visit', '/old-visit → /hours', '/studio/visit → /elsewhere']);
			assert.deepEqual(await movedFrom(w), {});
			const after = await move(w, { collection: 'pages', path: 'hours', to: 'opening' });
			assert.equal(after.status, 200, JSON.stringify(after.body));
			assert.deepEqual(pairs(after.body.redirects), ['/hours → /opening']);
			assert.deepEqual(await draftRedirects(w), ['/contact → /visit', '/hours → /opening', '/old-visit → /opening', '/studio/visit → /elsewhere']);
		} finally {
			w.s.cleanup();
		}
	});
});
