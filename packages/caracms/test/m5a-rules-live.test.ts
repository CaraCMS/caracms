// M5a's test pass, live mode's half of the gaps (the disk half: m5a-rules.test.ts).
// On the in-memory GitHub and Redis with a fake clock (never a real repo, M4 Decision 2).
//   - Decision 8: "used on" counts every collection, with autosaves on top.
//   - Decision 9: a preview reads the store (autosaves on top); the build reads the disk.
//   - Decision 12: a deleted document's title in the commit messages and the waiting list
//     comes from `main`'s copy, else `drafts`' copy before the removal, else its path.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { diskSource } from '../src/content.ts';
import type { CreateDeleteRefusal, StatusResponse, WaitingView } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { titleOf } from '../src/live/git.ts';
import { Tracker } from '../src/live/github.ts';
import { parseMessage, publishMessage, titleList, type Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { documentReader } from '../src/read.ts';
import { makeCreateSite, type CreateSite } from './helpers/create-site.ts';

const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const ORIGIN = 'http://site.test';
const TAB_A = 'tab-aoife-1';
const TAB_C = 'tab-ciaran-1';
const CONTACT = 'content/pages/contact.json';

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

let s: CreateSite;
before(() => {
	s = makeCreateSite({ repoPath: 'starter', link: false });
});
after(() => s.cleanup());

interface World {
	clock: { t: number };
	backend: MemoryBackend;
	ed: LiveEditor;
}

async function world(): Promise<World> {
	const clock = { t: Date.parse('2026-10-15T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	backend.seed([...(await siteFiles(s.site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const rt = await createLiveRuntime({ site: s.site, settings, backend, redis: memoryRedis({ now: () => clock.t }), now: () => clock.t, log: () => {}, runningCommit: () => null });
	const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	return { clock, backend, ed };
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

const create = (w: World, body: Record<string, unknown>) => call<CreateDeleteRefusal & Record<string, unknown>>(w.ed.create(request('/_caracms/create', { tab: TAB_A, body }), aoife));
const remove = (w: World, body: Record<string, unknown>) => call<CreateDeleteRefusal & Record<string, unknown>>(w.ed.delete(request('/_caracms/delete', { tab: TAB_A, body }), aoife));
const publish = (w: World) => call<{ result: string }>(w.ed.publish(request('/_caracms/publish', { body: {} }), aoife));
const repo = (file: string) => `starter/${file}`;
const headMessage = (w: World, branch: 'main' | 'drafts') => w.backend.info(w.backend.refs.get(branch)!).message;

async function poll(w: World, person: Person, tab: string): Promise<StatusResponse> {
	const r = await call<StatusResponse>(w.ed.status(request('/_caracms/status', { tab }), person));
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return r.body;
}
const waitingFor = (st: StatusResponse, file: string): WaitingView | undefined => st.waiting.find((x) => x.file === file);

async function type(w: World, collection: string, path: string, edit: (d: Record<string, unknown>) => void) {
	const opened = await w.ed.store.read(collection, path);
	const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
	edit(document);
	return call(w.ed.write(request('/_caracms/write', { tab: TAB_A, body: { file: opened.entry.file, base: opened.text, document } }), aoife));
}

async function sweep(w: World) {
	w.clock.t += 61_000;
	return w.ed.sweep.tick();
}

describe('Decision 8, live: "used on" counts every collection, autosaves included', () => {
	test('a Journal entry that takes the footer in an autosave is on the footer\'s list at once, and blocks its deletion', async () => {
		const w = await world();
		const usedOn = async () => (await w.ed.store.list()).find((d) => d.collection === 'shared' && d.path === 'footer')!.usedOn!.map((u) => `${u.collection}/${u.path}`).sort();
		assert.deepEqual(await usedOn(), ['pages/about', 'pages/index']);
		const r = await type(w, 'journal', 'apples', (d) => (d.blocks as unknown[]).push({ source: null, type: '', known: false, data: { shared: 'footer' } }));
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.deepEqual(await usedOn(), ['journal/apples', 'pages/about', 'pages/index'], 'before any sweep');
		const refused = await remove(w, { collection: 'shared', path: 'footer' });
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, 'in-use');
		assert.ok(refused.body.usedOn!.some((u) => u.collection === 'journal' && u.path === 'apples'));
		await sweep(w);
		assert.deepEqual(await usedOn(), ['journal/apples', 'pages/about', 'pages/index'], 'and once committed to drafts');
	});
});

describe('Decision 9: a preview reads the store with autosaves on top; the build reads the disk', () => {
	test('an autosaved case study shows in the live source, never in the disk source (main as deployed)', async () => {
		const w = await world();
		const r = await type(w, 'case-studies', 'high-street-coffee', (d) => ((d.data as Record<string, unknown>).client = 'High-street roaster'));
		assert.equal(r.status, 200, JSON.stringify(r.body));
		const live = documentReader(s.site, await w.ed.store.source());
		const disk = documentReader(s.site, diskSource);
		assert.equal((await live.document('case-studies', 'high-street-coffee'))!.data.client, 'High-street roaster');
		assert.equal((await disk.document('case-studies', 'high-street-coffee'))!.data.client, 'High-street coffee roaster');
		// A list block reading the collection sees the same difference.
		assert.equal((await live.documents('case-studies')).find((d) => d.path === 'high-street-coffee')!.title, 'High-street coffee roaster');
		// Once committed to drafts the live source still has it; the disk (what a build reads) is unchanged until a deploy.
		await sweep(w);
		assert.equal((await documentReader(s.site, await w.ed.store.source()).document('case-studies', 'high-street-coffee'))!.data.client, 'High-street roaster');
		assert.equal((await disk.document('case-studies', 'high-street-coffee'))!.data.client, 'High-street coffee roaster');
	});

	test('a document deleted in the editor is gone from the live source and still on the disk', async () => {
		const w = await world();
		assert.equal((await remove(w, { collection: 'case-studies', path: 'high-street-coffee' })).status, 200);
		assert.equal(await documentReader(s.site, await w.ed.store.source()).exists('case-studies', 'high-street-coffee'), false);
		assert.equal(await documentReader(s.site, diskSource).exists('case-studies', 'high-street-coffee'), true);
	});
});

describe('Decision 12: the title a deleted document goes by in drafts and Publish', () => {
	test('main\'s copy first: renamed in drafts and then deleted, it is still "Contact (deleted)"', async () => {
		const w = await world();
		assert.equal((await type(w, 'pages', 'contact', (d) => (d.title = 'Contact us'))).status, 200);
		await sweep(w);
		assert.match(headMessage(w, 'drafts'), /^Draft: Contact us\n/);
		assert.equal((await remove(w, { collection: 'pages', path: 'contact' })).status, 200);
		await sweep(w);
		assert.match(headMessage(w, 'drafts'), /^Draft: Contact \(deleted\)\n/);
		assert.equal(waitingFor(await poll(w, ciaran, TAB_C), CONTACT)?.title, 'Contact');
		assert.equal((await publish(w)).body.result, 'published');
		assert.match(headMessage(w, 'main'), /^Published: Contact \(deleted\) — by Aoife\n/);
		assert.equal(w.backend.file('main', repo(CONTACT)), null);
	});

	test('drafts\' copy before the removal when main has none: a new document, swept, then deleted', async () => {
		const w = await world();
		assert.equal((await create(w, { collection: 'case-studies', path: 'pots-and-pans-etc', title: 'Pots & Pans etc.' })).status, 200);
		await sweep(w);
		const DOC = 'content/case-studies/pots-and-pans-etc.json';
		assert.notEqual(w.backend.file('drafts', repo(DOC)), null);
		assert.equal((await remove(w, { collection: 'case-studies', path: 'pots-and-pans-etc' })).status, 200);
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(DOC)), null);
		assert.match(headMessage(w, 'drafts'), /^Draft: Pots & Pans etc\. \(deleted\)\n/);
		assert.deepEqual(parseMessage(headMessage(w, 'drafts')).titles, ['Pots & Pans etc. (deleted)']);
		// It was never on main: nothing to publish, so nothing waits.
		assert.equal(waitingFor(await poll(w, ciaran, TAB_C), DOC), undefined);
	});

	test('a changed page and a deleted one published together: the message names both, the deleted one "(deleted)"', async () => {
		const w = await world();
		assert.equal((await type(w, 'pages', 'index', (d) => (d.title = 'Welcome home'))).status, 200);
		assert.equal((await remove(w, { collection: 'pages', path: 'contact' })).status, 200);
		await sweep(w);
		assert.equal((await publish(w)).body.result, 'published');
		const head = headMessage(w, 'main');
		const headline = head.split('\n')[0]!;
		assert.match(headline, /^Published: .* — by Aoife$/);
		assert.ok(headline.includes('Contact (deleted)') && headline.includes('Welcome home'), headline);
		assert.ok(!headline.includes('Welcome home (deleted)'), 'only the removed one is marked');
		assert.deepEqual(parseMessage(head).publishedFiles.sort(), [CONTACT, 'content/pages/index.json'].sort());
	});

	test('without a copy anywhere the file\'s own name is used (titleOf), and the list reads "Home, Contact (deleted)"', () => {
		assert.equal(titleOf('content/pages/studio/visit.json', null), 'Visit');
		assert.equal(titleOf('content/case-studies/pots-and-pans-etc.json', null), 'Pots and pans etc');
		assert.equal(titleOf('content/case-studies/pots-and-pans-etc.json', '{ "title": "  Pots & Pans etc.  " }'), 'Pots & Pans etc.');
		assert.equal(titleOf('content/pages/x-y.json', '{ "nope": 1 }'), 'X y');
		assert.equal(titleOf('content/pages/x-y.json', 'not json'), 'X y');
		assert.equal(titleList(['Home', 'Contact (deleted)']), 'Home, Contact (deleted)');
		assert.equal(publishMessage(['Home', 'Contact (deleted)'], ['a.json', 'b.json'], aoife).split('\n')[0], 'Published: Home, Contact (deleted) — by Aoife');
	});
});
