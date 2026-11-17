// Collections under pages, carrier B: the many-move engine, without a browser.
// - Change address… on a holder takes the page, the pages under it and its held documents
//   (checks 10, 10a): one plan, each linking file rewritten once, one redirect per live address;
// - the plan is checked as a whole: a held document landing on a taken address or a code route
//   refuses everything (check 12); a swap is fine; the caller's Site Settings edit rides along;
// - local mode puts every file back when a write fails part way;
// - live mode: every lock up front, someone else's on any file refuses it all (check 11),
//   a failure part way leaves nothing behind, and Publish names every moved document (check 15);
// - deleting a holder is refused (check 14).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { SITE_SETTINGS_FILE } from '../src/config.ts';
import { listDocuments } from '../src/content.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { handleMove, planMoves } from '../src/editor/server/move.ts';
import { WriteRefused } from '../src/editor/server/write.ts';
import type { CreateDeleteRefusal, MoveResponse, StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import { parseMessage, type Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { parseRedirects } from '../src/redirects.ts';
import type { CreateSite } from './helpers/create-site.ts';
import { makeHolderSite } from './helpers/move-site.ts';

const ORIGIN = 'http://site.test';
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const TAB_A = 'tab-aoife-1';
const TAB_C = 'tab-ciaran-1';

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
const redirectsOf = (text: string) => parseRedirects(JSON.parse(text).redirects);
const moves = (body: MoveResponse) => body.moved.map((m) => `${m.fromUrl} → ${m.toUrl}`);

function local(files?: Record<string, string>) {
	const s = makeHolderSite({ files });
	const store = localDraftsStore(s.site);
	const move = (body: Record<string, unknown>) => call<MoveResponse & CreateDeleteRefusal>(handleMove(request('/_caracms/move', { body }), store));
	return { s, store, move, read: (file: string) => readFileSync(join(s.root, file), 'utf8') };
}

describe('local: Change address… on a holder (checks 10, 10a)', () => {
	test('Work to /studio: the page, the page under it and every case study, each relinked once, one redirect each', async () => {
		const { s, move, read } = local();
		try {
			const homeBefore = read('content/pages/index.json');
			const r = await move({ collection: 'pages', path: 'work', to: 'studio' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(moves(r.body), ['/work → /studio', '/work/kiln → /studio/kiln', '/work/high-street-coffee → /studio/high-street-coffee', '/work/tiny → /studio/tiny']);
			assert.ok(existsSync(join(s.root, 'content/pages/studio.json')) && existsSync(join(s.root, 'content/pages/studio/kiln.json')));
			assert.ok(!existsSync(join(s.root, 'content/pages/work.json')) && !existsSync(join(s.root, 'content/pages/work')), 'no Work page or group left behind');
			assert.match(read('content/pages/studio.json'), /"holds": "case-studies"/);
			// The held documents keep their files; links to them follow; references never change (check 18).
			assert.match(read('content/case-studies/tiny.json'), /\[the roaster\]\(\/studio\/high-street-coffee\)/);
			assert.match(read('content/case-studies/tiny.json'), /"related": \["high-street-coffee", "nobody"\]/);
			const home = read('content/pages/index.json');
			assert.notEqual(home, homeBefore);
			assert.match(home, /"href": "\/studio"/);
			assert.match(home, /"href": "\/studio\/high-street-coffee"/);
			assert.match(home, /\[Kiln\]\(\/studio\/kiln\)/);
			assert.deepEqual(r.body.relinked.map((d) => d.title).sort(), ['Home', 'Tiny']);
			assert.deepEqual(r.body.redirects.map((x) => x.from), ['/work', '/work/kiln', '/work/high-street-coffee', '/work/tiny']);
			const redirects = redirectsOf(read(SITE_SETTINGS_FILE));
			for (const from of ['/work', '/work/kiln', '/work/high-street-coffee', '/work/tiny']) assert.ok(redirects.some((x) => x.from === from), from);
			// And the listing gives the new addresses at once.
			const listed = await listDocuments(s.site);
			assert.equal(listed.find((d) => d.collection === 'case-studies' && d.path === 'tiny')?.url, '/studio/tiny');
		} finally {
			s.cleanup();
		}
	});

	test('redirect: false adds none, and chains to the old addresses still collapse', async () => {
		const { s, move, read } = local({ [SITE_SETTINGS_FILE]: '{\n  "title": "Site Settings",\n  "editors": [],\n  "redirects": [{ "from": "/old-tiny", "to": "/work/tiny" }]\n}\n' });
		try {
			const r = await move({ collection: 'pages', path: 'work', to: 'studio', redirect: false });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(r.body.redirects, []);
			assert.deepEqual(redirectsOf(read(SITE_SETTINGS_FILE)), [{ from: '/old-tiny', to: '/studio/tiny' }]);
		} finally {
			s.cleanup();
		}
	});

	test('a held document that would land on a page refuses the whole move, naming it; nothing changes', async () => {
		const { s, move, read } = local({ 'content/pages/studio/tiny.json': '{\n  "title": "Tiny page",\n  "blocks": []\n}\n' });
		try {
			const home = read('content/pages/index.json');
			const r = await move({ collection: 'pages', path: 'work', to: 'studio' });
			assert.equal(r.status, 409, JSON.stringify(r.body));
			assert.equal(r.body.code, 'address-taken');
			assert.match(r.body.error, /^Tiny would move to \/studio\/tiny\. There's already a page at \/studio\/tiny/);
			assert.ok(existsSync(join(s.root, 'content/pages/work.json')) && !existsSync(join(s.root, 'content/pages/studio.json')));
			assert.equal(read('content/pages/index.json'), home);
		} finally {
			s.cleanup();
		}
	});

	test('a held document that would land on a code route refuses the whole move (check 12)', async () => {
		const s = makeHolderSite();
		try {
			const site = { ...s.site, codeRoutes: [{ file: 'src/pages/studio/tiny.astro', url: '/studio/tiny', dynamic: false, rest: false }] };
			const documents = await listDocuments(s.site);
			assert.throws(
				() => planMoves(site, [{ collection: 'pages', path: 'work', to: 'studio' }], documents),
				(e: unknown) => e instanceof WriteRefused && e.body.code === 'reserved-address' && /^Tiny would move to \/studio\/tiny\./.test(e.message),
			);
		} finally {
			s.cleanup();
		}
	});

	test('the engine itself: a swap lands, and the caller\'s Site Settings edit rides the same write', async () => {
		const { s, store, read } = local();
		try {
			const r = await store.moveMany({
				moves: [
					{ collection: 'pages', path: 'contact', to: 'visit' },
					{ collection: 'pages', path: 'visit', to: 'contact' },
				],
				editSettings: (text) => text.replace('"editors": []', '"editors": [],\n  "order": "saved"'),
			});
			assert.deepEqual(moves(r), ['/contact → /visit', '/visit → /contact']);
			assert.match(read('content/pages/visit.json'), /"title": "Contact"/);
			assert.match(read('content/pages/contact.json'), /"title": "Visit"/);
			assert.match(read('content/pages/index.json'), /\[Visit\]\(\/contact\)/);
			assert.match(read(SITE_SETTINGS_FILE), /"order": "saved"/);
		} finally {
			s.cleanup();
		}
	});

	test('a write failing part way puts every file back', async () => {
		const { s, move, read } = local();
		const folder = join(s.root, 'content/case-studies');
		try {
			const home = read('content/pages/index.json');
			const settings = read(SITE_SETTINGS_FILE);
			chmodSync(folder, 0o555); // Tiny's relink can't be written
			const r = await move({ collection: 'pages', path: 'work', to: 'studio' });
			chmodSync(folder, 0o755);
			assert.equal(r.status, 500, JSON.stringify(r.body));
			assert.ok(existsSync(join(s.root, 'content/pages/work.json')) && existsSync(join(s.root, 'content/pages/work/kiln.json')));
			assert.ok(!existsSync(join(s.root, 'content/pages/studio.json')) && !existsSync(join(s.root, 'content/pages/studio')));
			assert.equal(read('content/pages/index.json'), home);
			assert.equal(read(SITE_SETTINGS_FILE), settings);
		} finally {
			chmodSync(folder, 0o755);
			s.cleanup();
		}
	});
});

describe('local: deleting a holder (check 14)', () => {
	test('is refused with Decision 12\'s sentence; its pages and documents are untouched', async () => {
		const { s, store } = local();
		try {
			await assert.rejects(
				() => store.delete({ collection: 'pages', path: 'work' }),
				(e: unknown) => e instanceof WriteRefused && e.body.code === 'holds' && e.message === 'Work holds the case studies. Delete the “holds” line in its file, or move the case studies to another page, first.',
			);
			assert.ok(existsSync(join(s.root, 'content/pages/work.json')) && existsSync(join(s.root, 'content/case-studies/tiny.json')));
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
	clock: { t: number };
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
	return { clock, backend, ed, s };
}
const move = (w: World, body: Record<string, unknown>, tab = TAB_A, person = aoife) => call<MoveResponse & CreateDeleteRefusal>(handleMove(request('/_caracms/move', { tab, body }), w.ed.store, { person }));
const publish = (w: World) => call<{ result: string }>(w.ed.publish(request('/_caracms/publish', { body: {} }), aoife));
const poll = async (w: World, person: Person, tab: string) => (await call<StatusResponse>(w.ed.status(request('/_caracms/status', { tab }), person))).body;
const headMessage = (w: World) => w.backend.info(w.backend.refs.get('main')!).message;
async function type(w: World, collection: string, path: string, person: Person, tab: string, edit: (d: Record<string, unknown>) => void) {
	const opened = await w.ed.store.read(collection, path);
	const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
	edit(document);
	return call(w.ed.write(request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document } }), person));
}

describe('live: a holder move (checks 11, 15)', () => {
	test('lands as autosaves, waits as one move per document, and Publish names them and sends the redirects', async () => {
		const w = await world();
		try {
			const r = await move(w, { collection: 'pages', path: 'work', to: 'studio' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.equal(r.body.redirects.length, 4);
			const listed = await w.ed.store.list();
			assert.equal(listed.find((d) => d.collection === 'case-studies' && d.path === 'high-street-coffee')?.url, '/studio/high-street-coffee');

			const st = await poll(w, ciaran, TAB_C);
			const from = (file: string) => st.waiting.find((x) => x.file === file)?.movedFrom;
			assert.equal(from('content/pages/studio.json'), '/work');
			assert.equal(from('content/pages/studio/kiln.json'), '/work/kiln');
			assert.equal(from('content/case-studies/tiny.json'), '/work/tiny', 'relinked, and moved');
			assert.equal(from('content/case-studies/high-street-coffee.json'), '/work/high-street-coffee', 'its file unchanged, still a move');
			assert.equal(st.waiting.find((x) => x.file === 'content/pages/work.json'), undefined, 'the old file is part of the move');

			assert.equal((await publish(w)).body.result, 'published');
			const head = headMessage(w);
			for (const item of ['Work (moved from /work)', 'Kiln (by hand) (moved from /work/kiln)', 'High-street coffee roaster (moved from /work/high-street-coffee)', 'Tiny (moved from /work/tiny)']) {
				assert.ok(parseMessage(head).titles.includes(item) || head.includes(item) || /and \d+ more/.test(head.split('\n')[0]!), `${item}: ${head.split('\n')[0]}`);
			}
			const record = (await poll(w, ciaran, TAB_C)).publish.record!;
			for (const item of ['Work (moved from /work)', 'High-street coffee roaster (moved from /work/high-street-coffee)', 'Tiny (moved from /work/tiny)']) assert.ok(record.titles.includes(item), record.titles.join(' | '));
			const redirects = redirectsOf(w.backend.file('main', `starter/${SITE_SETTINGS_FILE}`)!);
			for (const from of ['/work', '/work/kiln', '/work/high-street-coffee', '/work/tiny']) assert.ok(redirects.some((x) => x.from === from), from);
			// Published: nothing waits as a move any more.
			assert.deepEqual((await poll(w, ciaran, TAB_C)).waiting.filter((x) => x.movedFrom), []);
		} finally {
			w.s.cleanup();
		}
	});

	test('moved twice before a Publish: one move from the live address, and no redirect from the in-between one', async () => {
		const w = await world();
		try {
			assert.equal((await move(w, { collection: 'pages', path: 'work', to: 'studio' })).status, 200);
			const again = await move(w, { collection: 'pages', path: 'studio', to: 'projects' });
			assert.equal(again.status, 200, JSON.stringify(again.body));
			assert.deepEqual(again.body.redirects, [], 'none of the in-between addresses was live');
			const st = await poll(w, ciaran, TAB_C);
			assert.equal(st.waiting.find((x) => x.file === 'content/case-studies/high-street-coffee.json')?.movedFrom, '/work/high-street-coffee');
			const redirects = redirectsOf((await w.ed.store.read('settings', 'site-settings')).text);
			assert.ok(redirects.some((x) => x.from === '/work/high-street-coffee' && x.to === '/projects/high-street-coffee'), JSON.stringify(redirects));
			assert.ok(!redirects.some((x) => x.from === '/studio/high-street-coffee'));
			// Moved back: no move waits.
			assert.equal((await move(w, { collection: 'pages', path: 'projects', to: 'work' })).status, 200);
			assert.deepEqual((await poll(w, ciaran, TAB_C)).waiting.filter((x) => x.movedFrom), []);
		} finally {
			w.s.cleanup();
		}
	});

	test('someone editing a case study that moves with it: the whole move is refused, naming them, and nothing changes', async () => {
		const w = await world();
		try {
			assert.equal((await type(w, 'case-studies', 'tiny', ciaran, TAB_C, (d) => (d.client = 'Tiny & co'))).status, 200);
			const r = await move(w, { collection: 'pages', path: 'work', to: 'studio' });
			assert.equal(r.status, 409, JSON.stringify(r.body));
			assert.equal(r.body.code, 'locked');
			assert.match(r.body.error, /^Ciarán is editing Tiny, which moves with Work/);
			const listed = (await w.ed.store.list()).filter((d) => d.collection === 'pages').map((d) => d.path);
			assert.ok(listed.includes('work') && !listed.includes('studio'), listed.join(', '));
			assert.equal(await w.ed.autosaves.get('content/pages/studio.json'), null);
		} finally {
			w.s.cleanup();
		}
	});

	test('a failure part way puts every autosave back and releases every lock', async () => {
		const w = await world();
		try {
			const putIf = w.ed.autosaves.putIf.bind(w.ed.autosaves);
			let writes = 0;
			w.ed.autosaves.putIf = async (read, autosave) => {
				if (++writes === 4) throw new Error('the store went away');
				return putIf(read, autosave);
			};
			const home = (await w.ed.store.read('pages', 'index')).text;
			const r = await move(w, { collection: 'pages', path: 'work', to: 'studio' });
			w.ed.autosaves.putIf = putIf;
			assert.equal(r.status, 500, JSON.stringify(r.body));
			for (const file of ['content/pages/studio.json', 'content/pages/studio/kiln.json', 'content/pages/work.json', 'content/pages/index.json', 'content/case-studies/tiny.json', SITE_SETTINGS_FILE]) {
				assert.equal(await w.ed.autosaves.get(file), null, file);
			}
			assert.equal((await w.ed.store.read('pages', 'index')).text, home);
			w.clock.t += 6_000;
			assert.deepEqual((await poll(w, ciaran, TAB_C)).locks, []);
			assert.equal((await move(w, { collection: 'pages', path: 'work', to: 'studio' })).status, 200, 'a retry lands');
		} finally {
			w.s.cleanup();
		}
	});
});
