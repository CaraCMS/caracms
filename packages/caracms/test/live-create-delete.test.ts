// M5a Phase 3: creating and deleting in live mode (Decisions 11 and 12), through the
// same pipeline as typing: a new document is the creator's autosave with no base in
// `drafts`, a deletion a "gone" autosave; both are locked, swept, waiting and published.
// On the in-memory GitHub, the Redis stand-in and a fake clock (never a real repo, M4
// Decision 2); the sweep's timer is driven by hand. The disk half: create-delete.test.ts.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { CreateDeleteRefusal, LockRefusal, StatusResponse, WaitingView } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import { draftMessage, parseMessage, type Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis, type MemoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { makeCreateSite, REFUSED_CREATES, REFUSED_DELETES, type CreateSite } from './helpers/create-site.ts';

const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const ORIGIN = 'http://site.test';
const SEC = 1000;
const VISIT = 'content/pages/studio/visit.json';
const CONTACT = 'content/pages/contact.json';
const ABOUT = 'content/pages/about.json';
const TAB_A = 'tab-aoife-1';
const TAB_C = 'tab-ciaran-1';

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
	redis: MemoryRedis;
	ed: LiveEditor;
}

async function world(): Promise<World> {
	const clock = { t: Date.parse('2026-10-15T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	const redis = memoryRedis({ now: () => clock.t });
	backend.seed([...(await siteFiles(s.site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const rt = await createLiveRuntime({ site: s.site, settings, backend, redis, now: () => clock.t, log: () => {}, runningCommit: () => null });
	const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	return { clock, backend, redis, ed };
}

function request(path: string, init: { tab?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
	const headers: Record<string, string> = { origin: ORIGIN, ...init.headers };
	if (init.tab) headers['x-caracms-tab'] = init.tab;
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return new Request(`${ORIGIN}${path}`, { method: init.body === undefined ? 'GET' : 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

async function call<T = Record<string, unknown>>(res: Promise<Response>): Promise<{ status: number; body: T }> {
	const r = await res;
	return { status: r.status, body: (await r.json()) as T };
}

const create = (w: World, person: Person | null, tab: string | null, body: Record<string, unknown>) => call<CreateDeleteRefusal & Record<string, unknown>>(w.ed.create(request('/_caracms/create', { tab, body }), person));
const remove = (w: World, person: Person | null, tab: string | null, body: Record<string, unknown>) => call<CreateDeleteRefusal & Record<string, unknown>>(w.ed.delete(request('/_caracms/delete', { tab, body }), person));

async function poll(w: World, person: Person, tab: string, file: string | null = null): Promise<StatusResponse> {
	const r = await call<StatusResponse>(w.ed.status(request(`/_caracms/status${file ? `?file=${encodeURIComponent(file)}` : ''}`, { tab }), person));
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return r.body;
}

/** A write from a tab: the document as the store opens it now, changed by `edit`. */
async function type(w: World, person: Person, tab: string, collection: string, path: string, edit: (d: Record<string, unknown>) => void) {
	const opened = await w.ed.store.read(collection, path);
	const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
	edit(document);
	return call(w.ed.write(request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document } }), person));
}

async function sweep(w: World) {
	w.clock.t += 61 * SEC;
	return w.ed.sweep.tick();
}

const publish = (w: World, person: Person) => call<{ result: string }>(w.ed.publish(request('/_caracms/publish', { body: {} }), person));
const repo = (file: string) => `starter/${file}`;
const headMessage = (w: World, branch: 'main' | 'drafts') => w.backend.info(w.backend.refs.get(branch)!).message;
const waitingFor = (st: StatusResponse, file: string): WaitingView | undefined => st.waiting.find((x) => x.file === file);

describe('create → type → publish (Decision 11)', () => {
	test('the new page is the creator\'s autosave: listed, opened, locked, waiting as New, swept with Edited-by, published', async () => {
		const w = await world();
		const draftsBefore = w.backend.refs.get('drafts');
		const made = await create(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit', title: 'Visit' });
		assert.equal(made.status, 200, JSON.stringify(made.body));
		assert.deepEqual({ ...made.body, version: 'v' }, { ok: true, collection: 'pages', path: 'studio/visit', file: VISIT, url: '/studio/visit', version: 'v' });
		assert.equal(w.backend.refs.get('drafts'), draftsBefore, 'nothing committed yet: it is an autosave');

		// Another tab sees it on its next poll: in the listing, waiting as New, Aoife's lock.
		const st = await poll(w, ciaran, TAB_C, VISIT);
		assert.equal(waitingFor(st, VISIT)?.change, 'new');
		assert.equal(waitingFor(st, VISIT)?.title, 'Visit');
		assert.equal(waitingFor(st, VISIT)?.uncommitted, true);
		assert.equal(st.open?.state, 'theirs');
		assert.equal(st.open?.deleted, null);
		assert.ok((await w.ed.store.list()).some((d) => d.file === VISIT && d.url === '/studio/visit'));
		const opened = await w.ed.store.read('pages', 'studio/visit');
		assert.deepEqual(opened.document, { title: 'Visit', blocks: [] });
		assert.equal(opened.text, '{\n  "$schema": "../../../schemas/pages.schema.json",\n  "title": "Visit",\n  "blocks": []\n}\n');

		// Only the creator's tab can type in it.
		const theirs = await type(w, ciaran, TAB_C, 'pages', 'studio/visit', (d) => (d.title = 'Mine'));
		assert.equal(theirs.status, 409);
		const typed = await type(w, aoife, TAB_A, 'pages', 'studio/visit', (d) => (d.title = 'Visit us'));
		assert.equal(typed.status, 200, JSON.stringify(typed.body));

		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(VISIT)), '{\n  "$schema": "../../../schemas/pages.schema.json",\n  "title": "Visit us",\n  "blocks": []\n}\n');
		const draft = parseMessage(headMessage(w, 'drafts'));
		assert.deepEqual(draft.titles, ['Visit us']);
		assert.deepEqual(draft.edits, [{ person: { email: aoife.email, name: 'Aoife' }, files: [VISIT] }]);
		assert.deepEqual(draft.keptDraft, [], 'a new document is never "also changed outside the editor"');
		const after = await poll(w, ciaran, TAB_C);
		assert.equal(waitingFor(after, VISIT)?.change, 'new');
		assert.equal(waitingFor(after, VISIT)?.uncommitted, false);

		// Typing on after the sweep merges against that commit: still no kept-draft notice.
		await type(w, aoife, TAB_A, 'pages', 'studio/visit', (d) => (d.blocks as unknown[]).push({ source: null, type: 'text', known: true, data: { heading: 'Find us' } }));
		await sweep(w);
		assert.deepEqual(parseMessage(headMessage(w, 'drafts')).keptDraft, []);
		assert.match(w.backend.file('drafts', repo(VISIT))!, /"heading": "Find us"/);

		assert.equal((await publish(w, aoife)).body.result, 'published');
		assert.match(w.backend.file('main', repo(VISIT))!, /"title": "Visit us"/);
		assert.match(headMessage(w, 'main'), /^Published: Visit us — by Aoife/);
		assert.deepEqual((await poll(w, ciaran, TAB_C)).waiting, []);
	});

	test('a fields document and a shared block start as their kind\'s first text', async () => {
		const w = await world();
		assert.equal((await create(w, aoife, TAB_A, { collection: 'case-studies', path: 'pots-and-pans-etc', title: 'Pots & Pans etc.' })).status, 200);
		assert.equal((await create(w, aoife, TAB_A, { collection: 'shared', path: 'banner', title: 'Banner', blockType: 'cta' })).status, 200);
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo('content/case-studies/pots-and-pans-etc.json')), '{\n  "$schema": "../../schemas/case-studies.schema.json",\n  "title": "Pots & Pans etc."\n}\n');
		assert.equal(w.backend.file('drafts', repo('content/shared/banner.json')), '{\n  "$schema": "../../schemas/shared.schema.json",\n  "title": "Banner",\n  "block": {\n    "type": "cta"\n  }\n}\n');
		const st = await poll(w, aoife, TAB_A);
		assert.deepEqual(st.waiting.map((x) => `${x.change} ${x.title}`).sort(), ['new Banner', 'new Pots & Pans etc.']);
	});
});

describe('delete → publish (Decision 12)', () => {
	test('it leaves the listing, a viewer learns who deleted it, it waits as Deleted, and Publish removes it from main', async () => {
		const w = await world();
		const gone = await remove(w, aoife, TAB_A, { collection: 'pages', path: 'contact' });
		assert.equal(gone.status, 200, JSON.stringify(gone.body));
		assert.deepEqual(gone.body, { ok: true, collection: 'pages', path: 'contact', file: CONTACT });
		assert.ok(!(await w.ed.store.list()).some((d) => d.file === CONTACT));
		await assert.rejects(w.ed.store.read('pages', 'contact'), /no document "contact"/);

		// A viewer with it open: told on the next poll, and by whom. Their write is a 404.
		const viewer = await poll(w, ciaran, TAB_C, CONTACT);
		assert.equal(viewer.open?.deleted?.by?.email, aoife.email);
		assert.equal(typeof viewer.open?.deleted?.at, 'string');
		const entry = waitingFor(viewer, CONTACT)!;
		assert.equal(entry.change, 'deleted');
		assert.equal(entry.title, 'Contact');
		assert.equal(entry.editors[0]?.person.email, aoife.email);
		const late = await call(w.ed.write(request('/_caracms/write', { tab: TAB_C, body: { file: CONTACT, base: w.backend.file('drafts', repo(CONTACT)), document: { title: 'Mine', blocks: [] } } }), ciaran));
		assert.equal(late.status, 404);

		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(CONTACT)), null);
		assert.equal(w.backend.file('main', repo(CONTACT)) !== null, true);
		const draft = parseMessage(headMessage(w, 'drafts'));
		assert.match(headMessage(w, 'drafts'), /^Draft: Contact \(deleted\)\n/);
		assert.deepEqual(draft.edits, [{ person: { email: aoife.email, name: 'Aoife' }, files: [CONTACT] }]);
		const later = await poll(w, ciaran, TAB_C, CONTACT);
		assert.equal(later.open?.deleted?.by?.email, aoife.email, 'still known once committed');
		assert.equal(waitingFor(later, CONTACT)?.change, 'deleted');
		assert.equal(waitingFor(later, CONTACT)?.title, 'Contact');
		assert.equal(later.locks.length, 0, 'the deleter\'s lock dropped once the removal was committed');

		assert.equal((await publish(w, aoife)).body.result, 'published');
		assert.equal(w.backend.file('main', repo(CONTACT)), null, 'main loses the file');
		assert.match(headMessage(w, 'main'), /^Published: Contact \(deleted\) — by Aoife\n/);
		assert.deepEqual(parseMessage(headMessage(w, 'main')).publishedFiles, [CONTACT]);
		const history = await call<{ entries: { titles: string[] }[] }>(w.ed.history(request('/_caracms/history'), aoife));
		assert.deepEqual(history.body.entries[0]?.titles, ['Contact (deleted)']);
	});

	test('refused while someone else holds the lock: "Ciarán is editing Contact"', async () => {
		const w = await world();
		assert.equal((await type(w, ciaran, TAB_C, 'pages', 'contact', (d) => (d.title = 'Contact us'))).status, 200);
		const r = await remove(w, aoife, TAB_A, { collection: 'pages', path: 'contact' });
		assert.equal(r.status, 409);
		assert.equal(r.body.code, 'locked');
		assert.equal(r.body.error, 'Ciarán is editing Contact us.');
		assert.equal((r.body as unknown as LockRefusal).lock.person.email, ciaran.email);
		assert.ok((await w.ed.store.list()).some((d) => d.file === CONTACT));
		// Their own other tab: "in another tab".
		const own = await remove(w, ciaran, 'tab-ciaran-2', { collection: 'pages', path: 'contact' });
		assert.equal(own.status, 409);
		assert.equal(own.body.error, "You're editing Contact us in another tab.");
	});

	test('Home, Site Settings and a shared block in use are refused; the rest of the refusals hold too', async () => {
		const w = await world();
		for (const { why, body, status, code } of REFUSED_DELETES.filter((r) => r.why !== 'a link out of the collection')) {
			const r = await remove(w, aoife, TAB_A, body);
			assert.equal(r.status, status, `${why}: ${r.body.error}`);
			assert.equal(r.body.code, code, why);
		}
		const inUse = await remove(w, aoife, TAB_A, { collection: 'shared', path: 'footer' });
		assert.match(inUse.body.error, /^Footer is used on /);
		// A shared block becomes deletable once the last page using it lets it go (the listing has autosaves on top).
		for (const page of ['index', 'about']) {
			const r = await type(w, aoife, TAB_A, 'pages', page, (d) => (d.blocks = (d.blocks as { shared?: string }[]).filter((b) => b.shared !== 'footer')));
			assert.equal(r.status, 200);
		}
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'shared', path: 'footer' })).status, 200);
	});

	test('a page with pages under it can be deleted: they stay', async () => {
		const w = await world();
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'about' })).status, 200);
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(ABOUT)), null);
		assert.notEqual(w.backend.file('drafts', repo('content/pages/about/team.json')), null);
		assert.ok((await w.ed.store.list()).some((d) => d.path === 'about/team'));
	});

	test('no person is 401, no tab 400 (the guard is the real check)', async () => {
		const w = await world();
		assert.equal((await create(w, null, TAB_A, { collection: 'pages', path: 'x', title: 'X' })).status, 401);
		assert.equal((await create(w, aoife, null, { collection: 'pages', path: 'x', title: 'X' })).status, 400);
		assert.equal((await remove(w, null, TAB_A, { collection: 'pages', path: 'contact' })).status, 401);
		assert.equal((await remove(w, aoife, null, { collection: 'pages', path: 'contact' })).body.code, 'no-tab');
		const cross = await call(w.ed.create(request('/_caracms/create', { tab: TAB_A, body: { collection: 'pages', path: 'x', title: 'X' }, headers: { origin: 'https://evil.test' } }), aoife));
		assert.equal(cross.status, 403);
		assert.deepEqual(await w.ed.autosaves.all(), []);
	});
});

describe('merges with a deletion follow "the draft wins" (M4 Decision 7), both ways', () => {
	const pushed = (w: World, file: string, title: string) => {
		const v = JSON.parse(w.backend.file('main', repo(file))!);
		v.title = title;
		return w.backend.push('main', { [repo(file)]: `${JSON.stringify(v, null, 2)}\n` });
	};

	test('a delete racing a push that changed the file: it stays deleted, with the notice and Draft-kept:', async () => {
		const w = await world();
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'contact' })).status, 200);
		pushed(w, CONTACT, 'Contact us');
		await w.ed.runtime.git.check({ force: true }); // drafts fast-forwards to main's change under the pending deletion
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(CONTACT)), null, 'the draft (deleted) wins');
		const message = headMessage(w, 'drafts');
		assert.deepEqual(parseMessage(message).keptDraft, [CONTACT]);
		assert.match(message, /^Draft: Contact us \(deleted\)\n/, "its title from main's copy");
		const st = await poll(w, ciaran, TAB_C);
		assert.deepEqual(st.notices.map((n) => `${n.kind} ${n.file}`), [`draft-kept ${CONTACT}`]);
		assert.equal(waitingFor(st, CONTACT)?.change, 'deleted');
		assert.equal(waitingFor(st, CONTACT)?.keptDraft, true);
	});

	test('a committed deletion and a push that changed the file (diverged): the merge keeps it deleted, with Draft-kept:', async () => {
		const w = await world();
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'contact' })).status, 200);
		await sweep(w);
		pushed(w, CONTACT, 'Contact us');
		const r = await w.ed.runtime.git.check({ force: true });
		assert.equal(r.kind, 'merged');
		assert.equal(w.backend.file('drafts', repo(CONTACT)), null);
		assert.deepEqual(parseMessage(headMessage(w, 'drafts')).keptDraft, [CONTACT]);
		assert.equal(waitingFor(await poll(w, ciaran, TAB_C), CONTACT)?.change, 'deleted');
		assert.equal((await publish(w, aoife)).body.result, 'published');
		assert.equal(w.backend.file('main', repo(CONTACT)), null);
		assert.match(headMessage(w, 'main'), /^Published: Contact us \(deleted\) — by Aoife/);
	});

	test('a file main deleted that the editor changed stays, with Draft-kept:', async () => {
		const w = await world();
		assert.equal((await type(w, aoife, TAB_A, 'pages', 'about', (d) => (d.title = 'About us'))).status, 200);
		w.backend.push('main', { [repo(ABOUT)]: null });
		await w.ed.runtime.git.check({ force: true });
		await sweep(w);
		assert.match(w.backend.file('drafts', repo(ABOUT))!, /"title": "About us"/);
		assert.deepEqual(parseMessage(headMessage(w, 'drafts')).keptDraft, [ABOUT]);
		assert.equal(waitingFor(await poll(w, ciaran, TAB_C), ABOUT)?.change, 'new', 'main no longer has it');
	});
});

describe('addresses and paths (Decision 11), in live mode', () => {
	test('every path a create must refuse is refused, and nothing is stored', async () => {
		const w = await world();
		for (const { why, body, status, code } of REFUSED_CREATES.filter((r) => r.why !== 'a link out of the collection')) {
			const r = await create(w, aoife, TAB_A, body);
			assert.equal(r.status, status, `${why}: ${r.body.error}`);
			assert.equal(r.body.code, code, why);
		}
		assert.deepEqual(await w.ed.autosaves.all(), []);
		assert.deepEqual((await poll(w, aoife, TAB_A)).locks, []);
	});

	test('an address a new document already has is taken, in any collection, until it is deleted', async () => {
		const w = await world();
		assert.equal((await create(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit', title: 'Visit' })).status, 200);
		const again = await create(w, ciaran, TAB_C, { collection: 'pages', path: 'studio/visit', title: 'Visit' });
		assert.equal(again.status, 409);
		assert.equal(again.body.error, "There's already a page at /studio/visit.");
		const fields = await create(w, ciaran, TAB_C, { collection: 'case-studies', path: 'kiln', title: 'Kiln' });
		assert.equal(fields.body.code, 'address-taken');
	});
});

describe('re-creating, and deleting what was never published', () => {
	test('re-creating a document deleted since the last Publish shows as changed, and Publish replaces it', async () => {
		const w = await world();
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'contact' })).status, 200);
		await sweep(w);
		const made = await create(w, ciaran, TAB_C, { collection: 'pages', path: 'contact', title: 'Contact' });
		assert.equal(made.status, 200, JSON.stringify(made.body));
		const st = await poll(w, aoife, TAB_A, CONTACT);
		assert.equal(waitingFor(st, CONTACT)?.change, 'changed', 'main still has it');
		assert.equal(st.open?.deleted, null);
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(CONTACT)), '{\n  "$schema": "../../schemas/pages.schema.json",\n  "title": "Contact",\n  "blocks": []\n}\n');
		assert.match(headMessage(w, 'drafts'), /^Draft: Contact\n/);
		assert.equal(waitingFor(await poll(w, aoife, TAB_A), CONTACT)?.change, 'changed');
		await publish(w, ciaran);
		assert.equal(w.backend.file('main', repo(CONTACT)), '{\n  "$schema": "../../schemas/pages.schema.json",\n  "title": "Contact",\n  "blocks": []\n}\n');
	});

	test('re-creating before the sweep replaces the pending deletion: one commit, the new text, no notice', async () => {
		const w = await world();
		const before = w.backend.refs.get('drafts');
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'contact' })).status, 200);
		assert.equal((await create(w, aoife, TAB_A, { collection: 'pages', path: 'contact', title: 'Say hello' })).status, 200);
		assert.equal(waitingFor(await poll(w, ciaran, TAB_C), CONTACT)?.change, 'changed');
		await sweep(w);
		assert.equal(w.backend.info(w.backend.refs.get('drafts')!).parents[0], before, 'one commit');
		assert.equal(w.backend.file('drafts', repo(CONTACT)), '{\n  "$schema": "../../schemas/pages.schema.json",\n  "title": "Say hello",\n  "blocks": []\n}\n');
		assert.deepEqual(parseMessage(headMessage(w, 'drafts')).keptDraft, []);
	});

	test("someone else's deletion still being committed: a re-create waits for it", async () => {
		const w = await world();
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'contact' })).status, 200);
		const early = await create(w, ciaran, TAB_C, { collection: 'pages', path: 'contact', title: 'Contact' });
		assert.equal(early.status, 409);
		assert.equal(early.body.code, 'locked');
		assert.equal(early.body.error, "Aoife is working on /contact right now, so it can't be created yet.");
		await sweep(w);
		assert.equal((await create(w, ciaran, TAB_C, { collection: 'pages', path: 'contact', title: 'Contact' })).status, 200);
	});

	test('a document made and deleted before the sweep: nothing is committed, nothing waits', async () => {
		const w = await world();
		const before = w.backend.refs.get('drafts');
		assert.equal((await create(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit', title: 'Visit' })).status, 200);
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit' })).status, 200);
		assert.equal(waitingFor(await poll(w, ciaran, TAB_C), VISIT), undefined);
		await sweep(w);
		assert.equal(w.backend.refs.get('drafts'), before);
		assert.deepEqual(await w.ed.autosaves.all(), []);
		assert.deepEqual((await poll(w, ciaran, TAB_C)).waiting, []);
	});

	test('a document made, swept and then deleted: its waiting entry goes, and Publish has nothing to do', async () => {
		const w = await world();
		assert.equal((await create(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit', title: 'Visit' })).status, 200);
		await sweep(w);
		assert.equal(waitingFor(await poll(w, ciaran, TAB_C), VISIT)?.change, 'new');
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit' })).status, 200);
		assert.equal(waitingFor(await poll(w, ciaran, TAB_C), VISIT), undefined, 'the waiting count drops before the sweep');
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(VISIT)), null);
		assert.deepEqual((await poll(w, ciaran, TAB_C)).waiting, []);
		const mainBefore = w.backend.refs.get('main');
		assert.equal((await publish(w, aoife)).body.result, 'nothing-waiting', 'the waiting count and the publish diff agree');
		assert.equal(w.backend.refs.get('main'), mainBefore);
	});

	test('a new document typed into and deleted while the sweep commits it is still deleted', async () => {
		const w = await world();
		assert.equal((await create(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit', title: 'Visit' })).status, 200);
		// The sweep commits the create; the deletion lands while it does (a newer autosave the commit leaves in place).
		const git = w.ed.runtime.git;
		const commit = git.commitDrafts.bind(git);
		let once = true;
		git.commitDrafts = async (entries) => {
			const r = await commit(entries);
			if (once) {
				once = false;
				assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit' })).status, 200);
			}
			return r;
		};
		await sweep(w);
		assert.notEqual(w.backend.file('drafts', repo(VISIT)), null, 'the create was committed');
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(VISIT)), null, 'and then the deletion');
		assert.deepEqual(parseMessage(headMessage(w, 'drafts')).keptDraft, []);
		assert.deepEqual((await poll(w, ciaran, TAB_C)).waiting, []);
	});
});

describe('a write racing the sweep\'s clean-up after a commit (review fix 1)', () => {
	const MADE = '{\n  "$schema": "../../../schemas/pages.schema.json",\n  "title": "Visit",\n  "blocks": []\n}\n';
	/** The tab keeps typing from the text it was created with (its session's base), as the editor does. */
	const retitle = (w: World, title: string) =>
		call(w.ed.write(request('/_caracms/write', { tab: TAB_A, body: { file: VISIT, base: MADE, document: { title, blocks: [] } } }), aoife));
	/** The sweep commits `file`'s create while a newer autosave comes in (so removeIf fails); then its first replaceIf is beaten by `during`. */
	async function race(w: World, during: () => Promise<unknown>) {
		const git = w.ed.runtime.git;
		const commit = git.commitDrafts.bind(git);
		let once = true;
		git.commitDrafts = async (entries) => {
			const r = await commit(entries);
			if (once) {
				once = false;
				assert.equal((await retitle(w, 'Visit us')).status, 200);
			}
			return r;
		};
		const autosaves = w.ed.autosaves;
		const replaceIf = autosaves.replaceIf.bind(autosaves);
		let failed = false;
		autosaves.replaceIf = async (read, next) => {
			if (!failed) {
				failed = true;
				await during();
				return false;
			}
			return replaceIf(read, next);
		};
		await sweep(w);
		autosaves.replaceIf = replaceIf;
		assert.ok(failed, 'the race happened');
	}

	test('a write between the sweep\'s get and replaceIf: the autosave is not a new document any more, so no Draft-kept:', async () => {
		const w = await world();
		assert.equal((await create(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit', title: 'Visit' })).status, 200);
		await race(w, async () => assert.equal((await retitle(w, 'Visit us today')).status, 200));
		assert.equal((await w.ed.autosaves.get(VISIT))?.value.created, undefined);
		await sweep(w);
		assert.match(w.backend.file('drafts', repo(VISIT))!, /Visit us today/);
		assert.deepEqual(parseMessage(headMessage(w, 'drafts')).keptDraft, []);
		assert.deepEqual((await poll(w, ciaran, TAB_C)).notices, []);
	});

	test('a delete between the sweep\'s get and replaceIf: the file still goes from drafts', async () => {
		const w = await world();
		assert.equal((await create(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit', title: 'Visit' })).status, 200);
		await race(w, async () => assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'studio/visit' })).status, 200));
		assert.notEqual(w.backend.file('drafts', repo(VISIT)), null, 'the create was committed');
		await sweep(w);
		assert.equal(w.backend.file('drafts', repo(VISIT)), null, 'and then the deletion');
		assert.deepEqual(parseMessage(headMessage(w, 'drafts')).keptDraft, []);
	});
});

describe('the deleter\'s own status poll (review fix 2)', () => {
	test('a poll of the deleted document after the delete does not keep its lock: someone can re-create it once the sweep has run', async () => {
		const w = await world();
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'contact' })).status, 200);
		await poll(w, aoife, TAB_A, CONTACT); // the poll that was in flight when the delete landed
		await sweep(w);
		assert.deepEqual((await poll(w, ciaran, TAB_C)).locks, [], 'the lock dropped after the commit');
		const made = await create(w, ciaran, TAB_C, { collection: 'pages', path: 'contact', title: 'Contact' });
		assert.equal(made.status, 200, JSON.stringify(made.body));
	});

	test('re-creating it in the same tab is a live lock again, and a poll renews that one', async () => {
		const w = await world();
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'pages', path: 'contact' })).status, 200);
		assert.equal((await create(w, aoife, TAB_A, { collection: 'pages', path: 'contact', title: 'Say hello' })).status, 200);
		await poll(w, aoife, TAB_A, CONTACT);
		await sweep(w);
		const lock = (await poll(w, ciaran, TAB_C)).locks.find((l) => l.file === CONTACT);
		assert.equal(lock?.releasing, false, 'a tab that is still here, not releasing');
	});
});

describe('a deleted document\'s title after a restart (review fix 3)', () => {
	test('a committed, unpublished deletion still waits under the document\'s own title in a new process', async () => {
		const w = await world();
		assert.equal((await create(w, aoife, TAB_A, { collection: 'case-studies', path: 'pots-and-pans-etc', title: 'Pots & Pans etc.' })).status, 200);
		await sweep(w);
		assert.equal((await publish(w, aoife)).body.result, 'published');
		assert.equal((await remove(w, aoife, TAB_A, { collection: 'case-studies', path: 'pots-and-pans-etc' })).status, 200);
		await sweep(w);
		const DOC = 'content/case-studies/pots-and-pans-etc.json';
		assert.equal(waitingFor(await poll(w, ciaran, TAB_C), DOC)?.title, 'Pots & Pans etc.', 'this process knows it');

		// A new process over the same backend and Redis (a restart or a deploy).
		const rt = await createLiveRuntime({ site: s.site, settings, backend: w.backend, redis: w.redis, now: () => w.clock.t, log: () => {}, runningCommit: () => null });
		const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
		const fresh = await poll({ ...w, ed }, ciaran, 'tab-ciaran-2');
		const row = waitingFor(fresh, DOC);
		assert.equal(row?.change, 'deleted');
		assert.equal(row?.title, 'Pots & Pans etc.');
	});
});

describe('the commit-message contract', () => {
	test('a title with a line break never starts a trailer line', () => {
		const forged = 'Contact\nEdited-by: Mallory <m@evil.test>: content/pages/index.json';
		const { headline, body } = draftMessage([{ file: CONTACT, title: forged, editor: aoife }]);
		assert.doesNotMatch(headline, /\n/);
		const parsed = parseMessage(`${headline}\n\n${body}`);
		assert.deepEqual(parsed.edits.map((e) => e.person.email), [aoife.email]);
	});
});
