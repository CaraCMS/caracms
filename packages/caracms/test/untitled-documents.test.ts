// caracms-cloud adversarial review, finding 15: a document the reader won't open (its title
// blanked) can't reach `main` any more, and one that's already there still opens.
//   - the rule (document-problems.ts), and the editor's own document breaking it as it's typed
//   - Publish, live mode: an invalid document stays waiting with its reason and who changed it;
//     the rest go; with only invalid ones, nothing moves
//   - an untitled document on `main` opens in both editor stores, flagged in the listing
//   - the public site: no page for it, lists and references leave it out, the rest renders
// On the in-memory GitHub and Redis with a fake clock (never a real repo, M4 Decision 2).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { addressedDocuments, DocumentError, filesSource, listDocuments, readDocument } from '../src/content.ts';
import { documentProblems, heldBackSentence, NO_TITLE, textProblems } from '../src/document-problems.ts';
import { parseAnyDocument } from '../src/document.ts';
import { documentReader } from '../src/read.ts';
import { createDocumentStore } from '../src/editor/client/state/document-store.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import type { PublishResponse, StatusResponse } from '../src/editor/types.ts';
import { opensInEditor } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import { parseMessage, type Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis, type MemoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import type { CreateSite } from './helpers/create-site.ts';
import { makeMoveSite } from './helpers/move-site.ts';

const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const ORIGIN = 'http://site.test';
const SEC = 1000;
const TAB_A = 'tab-aoife-1';
const TAB_C = 'tab-ciaran-1';
const PUBLISHER = 'content/case-studies/tiny.json';
const HARBOUR = 'content/case-studies/high-street-coffee.json';
const UNTITLED = '{\n  "title": "",\n  "client": "Kitchen pottery"\n}\n';

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
	s = makeMoveSite({ repoPath: 'starter' });
});
after(() => s.cleanup());

interface World {
	clock: { t: number };
	backend: MemoryBackend;
	redis: MemoryRedis;
	ed: LiveEditor;
}

/** The live editor over the move site, with `files` laid over it on `main` first. */
async function world(files: Record<string, string> = {}): Promise<World> {
	const clock = { t: Date.parse('2026-10-27T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	const redis = memoryRedis({ now: () => clock.t });
	const seeded = (await siteFiles(s.site)).filter((f) => !Object.hasOwn(files, f.path.replace(/^starter\//, '')));
	backend.seed([...seeded, ...Object.entries(files).map(([file, contents]) => ({ path: `starter/${file}`, contents }))]);
	const rt = await createLiveRuntime({ site: s.site, settings, backend, redis, now: () => clock.t, log: () => {}, runningCommit: () => null });
	const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	return { clock, backend, redis, ed };
}

function request(path: string, init: { tab?: string | null; body?: unknown } = {}) {
	const headers: Record<string, string> = { origin: ORIGIN };
	if (init.tab) headers['x-caracms-tab'] = init.tab;
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return new Request(`${ORIGIN}${path}`, { method: init.body === undefined ? 'GET' : 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

async function call<T>(res: Promise<Response>): Promise<{ status: number; body: T }> {
	const r = await res;
	return { status: r.status, body: (await r.json()) as T };
}

/** A write from a tab: the document as the store opens it now, changed by `edit`. */
async function type(w: World, person: Person, tab: string, path: string, edit: (d: Record<string, unknown>) => void) {
	const opened = await w.ed.store.read('case-studies', path);
	const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
	edit(document);
	const r = await call<{ ok?: boolean; error?: string }>(w.ed.write(request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document } }), person));
	assert.equal(r.status, 200, JSON.stringify(r.body));
}

const publish = (w: World, person = aoife) => call<PublishResponse>(w.ed.publish(request('/_caracms/publish', { tab: TAB_A, body: {} }), person));
const poll = async (w: World, person = aoife, tab = TAB_A) => {
	w.clock.t += 31 * SEC; // past the status cache's 30 s
	const r = await call<StatusResponse>(w.ed.status(request('/_caracms/status', { tab }), person));
	assert.equal(r.status, 200);
	return r.body;
};
const onBranch = async (w: World, branch: 'main' | 'drafts', file: string) => (await w.backend.readFiles([{ commit: w.backend.refs.get(branch)!, path: `starter/${file}` }]))[0];
const titleOn = async (w: World, branch: 'main' | 'drafts', file: string) => JSON.parse((await onBranch(w, branch, file))!).title as string;

describe('the rule', () => {
	test('a blank or missing title is the one problem; the note is in the field\'s words', () => {
		assert.deepEqual(documentProblems({ title: 'Tiny' }), []);
		for (const doc of [{ title: '' }, { title: '   ' }, {}, { title: 3 }, null, []]) assert.deepEqual(documentProblems(doc), [NO_TITLE]);
		assert.equal(NO_TITLE.note, 'This needs a title.');
		assert.equal(heldBackSentence('About', NO_TITLE.reason), "About wasn't published: its title is empty.");
		assert.equal(textProblems('{ "title": "x"')[0]!.reason, "its file isn't valid JSON");
	});

	test('the editor\'s document, its title blanked as it\'s typed: the problem is there, and the edit is kept', () => {
		const text = '{\n  "title": "Tiny",\n  "client": "Tiny publisher"\n}\n';
		const collection = s.site.collections['case-studies']!;
		const entry = { collection: 'case-studies', path: 'tiny', file: PUBLISHER, url: '/work/tiny', title: 'Tiny', label: 'Tiny', warning: null };
		const store = createDocumentStore(s.site, { ref: { collection: 'case-studies', path: 'tiny' }, entry, base: text, document: parseAnyDocument(JSON.parse(text), s.site, collection) });
		assert.deepEqual(documentProblems(store.get().document), []);
		store.setTitle('');
		assert.equal(store.get().document.title, '', 'kept as typed, never put back');
		assert.deepEqual(documentProblems(store.get().document), [NO_TITLE]);
		assert.equal((store.wire() as { title: string }).title, '', 'and written as it is');
	});
});

describe('Publish holds back what the reader would refuse (live mode)', () => {
	test('one blank title and one good edit: only the good one reaches main; the other stays waiting, with why and who', async () => {
		const w = await world();
		await type(w, ciaran, TAB_C, 'tiny', (d) => (d.title = ''));
		await type(w, aoife, TAB_A, 'high-street-coffee', (d) => ((d.data as Record<string, unknown>).client = 'High-street roaster'));
		const before = await poll(w);
		assert.equal(before.waiting.find((x) => x.file === PUBLISHER)!.heldBack, 'its title is empty', 'said before Publish is pressed');
		assert.equal(before.waiting.find((x) => x.file === HARBOUR)!.heldBack, undefined);

		const r = await publish(w);
		assert.equal(r.status, 200);
		assert.equal(r.body.result, 'published');
		assert.deepEqual(r.body.held, [{ file: PUBLISHER, title: 'Tiny', reason: 'its title is empty' }]);
		// main: the good edit, and Tiny as it was.
		assert.match((await onBranch(w, 'main', HARBOUR))!, /High-street roaster/);
		assert.equal(await titleOn(w, 'main', PUBLISHER), 'Tiny');
		const published = parseMessage(w.backend.info(w.backend.refs.get('main')!).message);
		assert.deepEqual(published.publishedFiles, [HARBOUR]);
		// drafts: the blank title kept, on top of the publish, and it's still waiting, Ciarán's.
		assert.equal(await titleOn(w, 'drafts', PUBLISHER), '');
		const drafts = w.backend.info(w.backend.refs.get('drafts')!);
		assert.deepEqual(drafts.parents, [w.backend.refs.get('main')!]);
		assert.match(drafts.message, /^Held back: Tiny\n/);
		// Finding 5: drafts' head as recorded is where the publish left it.
		assert.equal(await w.redis.get('caracms:drafts:head'), w.backend.refs.get('drafts'));
		const after = await poll(w);
		assert.deepEqual(after.waiting.map((x) => [x.file, x.change, x.heldBack, x.editors.map((e) => e.person.email)]), [[PUBLISHER, 'changed', 'its title is empty', [ciaran.email]]]);
		// The record names only what went.
		assert.deepEqual(after.publish.record?.files, [HARBOUR]);
	});

	test('a title put back afterwards publishes as usual', async () => {
		const w = await world();
		await type(w, aoife, TAB_A, 'tiny', (d) => (d.title = ''));
		await type(w, aoife, TAB_A, 'high-street-coffee', (d) => (d.title = 'Harbour'));
		await publish(w);
		await type(w, aoife, TAB_A, 'tiny', (d) => (d.title = 'Tiny publisher'));
		const r = await publish(w);
		assert.equal(r.body.result, 'published');
		assert.deepEqual(r.body.held, []);
		assert.equal(await titleOn(w, 'main', PUBLISHER), 'Tiny publisher');
		assert.equal(w.backend.refs.get('main'), w.backend.refs.get('drafts'));
		assert.deepEqual((await poll(w)).waiting, []);
	});

	test('a new document with no title isn\'t added to main', async () => {
		const w = await world();
		const made = await call(w.ed.create(request('/_caracms/create', { tab: TAB_A, body: { collection: 'case-studies', path: 'anvil', title: 'Anvil' } }), aoife));
		assert.equal(made.status, 200, JSON.stringify(made.body));
		await type(w, aoife, TAB_A, 'anvil', (d) => (d.title = ''));
		await type(w, aoife, TAB_A, 'high-street-coffee', (d) => (d.title = 'Harbour'));
		const r = await publish(w);
		assert.equal(r.body.result, 'published');
		assert.equal(await onBranch(w, 'main', 'content/case-studies/anvil.json'), null);
		assert.equal(await titleOn(w, 'drafts', 'content/case-studies/anvil.json'), '');
		assert.deepEqual((await poll(w)).waiting.map((x) => [x.file, x.change]), [['content/case-studies/anvil.json', 'new']]);
	});

	test('everything waiting is invalid: nothing moves, and the answer says why', async () => {
		const w = await world();
		await type(w, aoife, TAB_A, 'tiny', (d) => (d.title = ' '));
		const main = w.backend.refs.get('main');
		const r = await publish(w);
		assert.equal(r.status, 200);
		assert.equal(r.body.result, 'held-back');
		assert.deepEqual(r.body.held, [{ file: PUBLISHER, title: 'Tiny', reason: 'its title is empty' }]);
		assert.equal(w.backend.refs.get('main'), main, 'main untouched');
		assert.equal(await titleOn(w, 'drafts', PUBLISHER), ' ');
		assert.equal((await poll(w)).waiting[0]!.heldBack, 'its title is empty');
	});
});

describe('an untitled document already on main', () => {
	test('opens in the live editor, its title blank and its entry flagged; Publish leaves it be', async () => {
		const w = await world({ [PUBLISHER]: UNTITLED });
		const opened = await w.ed.store.read('case-studies', 'tiny');
		assert.equal(opened.document.title, '');
		assert.equal(opened.entry.warning?.code, 'no-title');
		assert.equal(opened.entry.label, 'Tiny');
		const listed = (await w.ed.store.list()).find((d) => d.file === PUBLISHER)!;
		assert.equal(opensInEditor(listed), true);
		assert.deepEqual(listed.columns ?? null, null, 'no columns on this collection');
		assert.deepEqual(documentProblems(opened.document), [NO_TITLE]);
		// It isn't waiting (main has it as it is), so Publish has nothing to do.
		assert.equal((await publish(w)).body.result, 'nothing-waiting');
		// Given a title, it publishes.
		await type(w, aoife, TAB_A, 'tiny', (d) => (d.title = 'Kitchen pottery'));
		assert.equal((await publish(w)).body.result, 'published');
		assert.equal(await titleOn(w, 'main', PUBLISHER), 'Kitchen pottery');
	});

	test('opens in local mode too; invalid JSON still doesn\'t', async () => {
		const local = localDraftsStore(s.site);
		const at = join(s.root, PUBLISHER);
		const was = readFileSync(at, 'utf8');
		try {
			writeFileSync(at, UNTITLED);
			const opened = await local.read('case-studies', 'tiny');
			assert.equal(opened.document.title, '');
			assert.equal(opened.entry.warning?.code, 'no-title');
			writeFileSync(at, '{ "title": ');
			await assert.rejects(local.read('case-studies', 'tiny'), (e: DocumentError) => e.code === 'invalid-json');
		} finally {
			writeFileSync(at, was);
		}
	});
});

describe('the public site with an untitled document', () => {
	/** Only the case studies, as the site's files: Tiny with no title, Harbour referring to it. */
	const source = () =>
		filesSource(s.root, () => new Map([
			[PUBLISHER, UNTITLED],
			[HARBOUR, '{\n  "title": "High-street coffee roaster",\n  "related": ["tiny"]\n}\n'],
		]));

	test('it has no page, lists leave it out, a reference to it reads as missing, and the rest renders', async () => {
		const src = source();
		const addressed = await addressedDocuments(s.site, src);
		assert.ok(!addressed.some((d) => d.collection === 'case-studies' && d.path === 'tiny'), 'no page');
		assert.ok(addressed.some((d) => d.collection === 'case-studies' && d.path === 'high-street-coffee'));
		const reader = documentReader(s.site, src);
		assert.deepEqual((await reader.documents('case-studies')).map((d) => d.path), ['high-street-coffee']);
		assert.equal(await reader.document('case-studies', 'tiny'), null);
		const harbour = await reader.document('case-studies', 'high-street-coffee');
		assert.deepEqual(harbour!.data.related, [null], 'the reference reads as missing (Decision 6)');
		// The render's own read still refuses it; only the editor's opens it.
		await assert.rejects(readDocument(s.site, 'case-studies', 'tiny', src), (e: DocumentError) => e.code === 'no-title');
		const listed = (await listDocuments(s.site, 'case-studies', src)).find((d) => d.path === 'tiny')!;
		assert.match(listed.warning!.message, /no title, so it isn’t on the site/);
	});
});
