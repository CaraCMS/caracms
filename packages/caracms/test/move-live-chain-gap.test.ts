// Collections under pages, the chain gap (2026-10-25): in live mode, when a move
// vacates an address that is some document's live address (the one the public site serves
// now), it redirects to where that document is now, as the move's redirect tick says.
// After a chain before a Publish (Visit /visit → /hours, then Contact /contact → /visit),
// Visit has no redirect from /visit (Contact sits there); Contact moving on from /visit
// must leave `/visit → /hours`, or /visit 404s after the Publish. Through Change address…
// and POST /_caracms/arrange (the same engine); a swap still adds none; a document moved
// back to its live address drops its redirect; the tick off adds none.
//
// Local mode has no gap: every move redirects from the address it leaves at once (the disk
// is the site), so a vacated address always redirects to the document that was last there.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SITE_SETTINGS_FILE } from '../src/config.ts';
import { handleArrange } from '../src/editor/server/arrange.ts';
import { handleMove } from '../src/editor/server/move.ts';
import type { CreateDeleteRefusal, MoveResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { parseRedirects, redirectsAddedBy, redirectsAfterMoves, type Redirect } from '../src/redirects.ts';
import type { CreateSite } from './helpers/create-site.ts';
import { makeHolderSite } from './helpers/move-site.ts';

const ORIGIN = 'http://site.test';
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const TAB_A = 'tab-aoife-1';

const pairs = (list: readonly Redirect[]) => list.map((r) => `${r.from} → ${r.to}`).sort();

describe('the fold: a vacated live address (homes)', () => {
	const list: Redirect[] = [{ from: '/contact', to: '/visit' }];
	const homes = [
		{ live: '/visit', now: '/hours' },
		{ live: '/contact', now: '/find-us' },
	];

	test('a move vacating a live address adds `live → now`; the chain to it follows its own document', () => {
		const moves = [{ from: '/visit', to: '/find-us', add: false }];
		assert.deepEqual(pairs(redirectsAfterMoves(list, moves, homes)), ['/contact → /find-us', '/visit → /hours']);
		assert.deepEqual(pairs(redirectsAddedBy(moves, homes)), ['/visit → /hours']);
	});

	test('nothing when the address is taken again, or no move here vacates it', () => {
		const swap = [
			{ from: '/visit', to: '/find-us', add: false },
			{ from: '/hours', to: '/visit', add: false },
		];
		assert.deepEqual(pairs(redirectsAddedBy(swap, homes)), []);
		assert.deepEqual(pairs(redirectsAddedBy([{ from: '/elsewhere', to: '/other', add: false }], homes)), []);
		// A document at its live address has no home to go to.
		assert.deepEqual(pairs(redirectsAddedBy([{ from: '/visit', to: '/x', add: false }], [{ live: '/visit', now: '/visit' }])), []);
	});

	test('it replaces a stale entry from the vacated address', () => {
		const moves = [{ from: '/visit', to: '/find-us', add: false }];
		assert.deepEqual(pairs(redirectsAfterMoves([{ from: '/visit', to: '/somewhere' }], moves, homes)), ['/visit → /hours']);
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
function request(path: string, body: unknown) {
	return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'x-caracms-tab': TAB_A, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function call<T>(res: Promise<Response>): Promise<{ status: number; body: T }> {
	const r = await res;
	return { status: r.status, body: (await r.json()) as T };
}
type Answer = Partial<MoveResponse> & CreateDeleteRefusal;
const move = (w: World, path: string, to: string, extra: Record<string, unknown> = {}) => call<Answer>(handleMove(request('/_caracms/move', { collection: 'pages', path, to, ...extra }), w.ed.store, { person: aoife }));
const arrange = (w: World, moves: [string, string][], extra: Record<string, unknown> = {}) =>
	call<Answer>(handleArrange(request('/_caracms/arrange', { moves: moves.map(([fromPath, toPath]) => ({ collection: 'pages', fromPath, toPath })), order: {}, ...extra }), w.ed.store, { person: aoife }));
const ok = (r: { status: number; body: unknown }) => assert.equal(r.status, 200, JSON.stringify(r.body));
const draftRedirects = async (w: World) => pairs(parseRedirects(JSON.parse((await w.ed.store.read('settings', 'site-settings')).text).redirects));
const mainRedirects = (w: World) => pairs(parseRedirects(JSON.parse(w.backend.file('main', `starter/${SITE_SETTINGS_FILE}`)!).redirects));
const publish = async (w: World) => assert.equal((await call<{ result: string }>(w.ed.publish(request('/_caracms/publish', {}), aoife))).body.result, 'published');

// Visit /visit → /hours, Contact /contact → /visit: the chain, as two moves.
async function chain(w: World, via: 'move' | 'arrange') {
	if (via === 'move') {
		ok(await move(w, 'visit', 'hours'));
		ok(await move(w, 'contact', 'visit'));
	} else {
		ok(await arrange(w, [['visit', 'hours']]));
		ok(await arrange(w, [['contact', 'visit']]));
	}
	// Visit has no redirect from /visit: Contact sits there.
	assert.deepEqual(await draftRedirects(w), ['/contact → /visit', '/old-visit → /hours', '/studio/visit → /elsewhere']);
}

describe('live: the chain gap', () => {
	for (const via of ['move', 'arrange'] as const) {
		test(`the chain then a third move: /visit redirects to Visit, where it is now (${via === 'move' ? 'Change address…' : 'the arrange endpoint'})`, async () => {
			const w = await world();
			try {
				await chain(w, via);
				const third = via === 'move' ? await move(w, 'visit', 'find-us') : await arrange(w, [['visit', 'find-us']]);
				ok(third);
				// The arrange endpoint answers { ok } only; Change address… names the redirects it added.
				if (via === 'move') assert.deepEqual(pairs(third.body.redirects!), ['/visit → /hours']);
				const expected = ['/contact → /find-us', '/old-visit → /hours', '/studio/visit → /elsewhere', '/visit → /hours'];
				assert.deepEqual(await draftRedirects(w), expected);
				await publish(w);
				// Every address live at the last Publish that has no document now redirects to the one that was there.
				assert.deepEqual(mainRedirects(w), expected);
			} finally {
				w.s.cleanup();
			}
		});
	}

	test('a held document: its holder moved, a page took its live address, then moved on', async () => {
		const w = await world();
		try {
			ok(await move(w, 'work', 'studio'));
			assert.equal((await w.ed.autosaves.addresses()).get('content/case-studies/tiny.json'), '/work/tiny');
			ok(await move(w, 'contact', 'work/tiny'));
			assert.ok(!(await draftRedirects(w)).some((x) => x.startsWith('/work/tiny →')));
			const on = await move(w, 'work/tiny', 'contact-us');
			ok(on);
			assert.deepEqual(pairs(on.body.redirects!), ['/work/tiny → /studio/tiny']);
			assert.ok((await draftRedirects(w)).includes('/work/tiny → /studio/tiny'), (await draftRedirects(w)).join(', '));
		} finally {
			w.s.cleanup();
		}
	});

	test('the tick off adds none', async () => {
		const w = await world();
		try {
			await chain(w, 'move');
			const third = await move(w, 'visit', 'find-us', { redirect: false });
			ok(third);
			assert.deepEqual(third.body.redirects, []);
			assert.deepEqual(await draftRedirects(w), ['/contact → /find-us', '/old-visit → /hours', '/studio/visit → /elsewhere']);
		} finally {
			w.s.cleanup();
		}
	});

	test('through the arrange endpoint with the tick off, none either', async () => {
		const w = await world();
		try {
			await chain(w, 'arrange');
			ok(await arrange(w, [['visit', 'find-us']], { redirect: false }));
			assert.ok(!(await draftRedirects(w)).some((x) => x.startsWith('/visit →')));
		} finally {
			w.s.cleanup();
		}
	});

	test('a swap after the chain adds none (/visit is taken again)', async () => {
		const w = await world();
		try {
			await chain(w, 'arrange');
			// Contact (at /visit) and Visit (at /hours) trade places: Visit is back at its live address.
			const swap = await arrange(w, [
				['visit', 'hours'],
				['hours', 'visit'],
			]);
			ok(swap);
			assert.deepEqual(await draftRedirects(w), ['/contact → /hours', '/old-visit → /visit', '/studio/visit → /elsewhere']);
		} finally {
			w.s.cleanup();
		}
	});

	test('a document moved back to its live address drops its redirect, and no home is left for it', async () => {
		const w = await world();
		try {
			ok(await move(w, 'visit', 'hours'));
			assert.ok((await draftRedirects(w)).includes('/visit → /hours'));
			const back = await move(w, 'hours', 'visit');
			ok(back);
			assert.deepEqual(back.body.redirects, []);
			assert.ok(!(await draftRedirects(w)).some((x) => x.startsWith('/visit →')), (await draftRedirects(w)).join(', '));
			assert.equal((await w.ed.autosaves.addresses()).size, 0);
			// Moved away again: an ordinary move from its live address.
			const again = await move(w, 'visit', 'find-us');
			ok(again);
			assert.deepEqual(pairs(again.body.redirects!), ['/visit → /find-us']);
		} finally {
			w.s.cleanup();
		}
	});
});
