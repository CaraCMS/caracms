// Never lose work silently (Spec → Non-functional, M2 Decision 11; M3 Decisions 5–7),
// against a throwaway copy of the fixture site with the real write route behind the
// keeper's fetch:
// - the re-send rule on load drops a stored copy only when the file already holds it;
// - a write the server refuses (a 4xx) is held and shown as refused, not "can't reach";
// - a block whose type is a built-in object name is an unknown block like any other.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { ResolvedSite } from '../src/config.ts';
import { blockContexts, normaliseDocument, parseDocumentText, type SiteDocument } from '../src/document.ts';
import { createKeeper, type KeeperStorage } from '../src/editor/client/state/keeper.ts';
import { localDraftsStore, type OpenedDocument } from '../src/editor/server/drafts-store.ts';
import { handleWrite } from '../src/editor/server/write.ts';
import { applyEdits } from '../src/serialize.ts';
import { site as fixtureSite, siteRoot } from './helpers/site.ts';

let tmp: string;
let root: string;
let site: ResolvedSite;
let store: ReturnType<typeof localDraftsStore>;
/** A section-builder document as the store opens it (M5a: the store reads any kind). */
const readPage = async (collection: string, path: string) => (await store.read(collection, path)) as OpenedDocument;
const originals = new Map<string, string>();
const HOME = 'content/pages/index.json';
const CONTACT = 'content/pages/contact.json';

before(() => {
	tmp = mkdtempSync(join(tmpdir(), 'caracms-keeper-'));
	root = join(tmp, 'site');
	cpSync(join(siteRoot, 'content'), join(root, 'content'), { recursive: true });
	site = {
		...fixtureSite,
		root,
		collections: Object.fromEntries(Object.entries(fixtureSite.collections).map(([name, c]) => [name, { ...c, dir: join(root, c.folder) }])),
	};
	store = localDraftsStore(site);
	for (const file of [HOME, CONTACT]) originals.set(file, readFileSync(join(root, file), 'utf8'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
	rmSync(join(root, 'content/pages/contact-us.json'), { force: true });
	for (const [file, text] of originals) writeFileSync(join(root, file), text);
});

const disk = (file: string) => readFileSync(join(root, file), 'utf8');
const clone = (d: SiteDocument): SiteDocument => JSON.parse(JSON.stringify(d));

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

/** The keeper's fetch, routed to the real write route on the temp site. */
interface Wire {
	calls: { keepalive: boolean; title: string }[];
	/** Writes the route has finished (landed on disk or refused). */
	landed?: number;
	/** The write lands on disk, but its answer never reaches the page (it was reloaded). */
	lose?: boolean;
	/** Keepalive requests are refused by the browser (Chrome: bodies over 64 KB). */
	refuseKeepalive?: boolean;
}

function page(storage: MemoryStorage, wire: Wire) {
	const keeper = createKeeper({
		site,
		storage,
		storageKey: 'site',
		log: () => {},
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
		delay: 5,
		fetch: (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			wire.calls.push({ keepalive: !!init.keepalive, title: body.document.title });
			if (init.keepalive && wire.refuseKeepalive) throw new TypeError('Failed to fetch');
			const response = await handleWrite(
				new Request('http://localhost:4326/_caracms/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: String(init.body) }),
				store,
			);
			wire.landed = (wire.landed ?? 0) + 1;
			if (wire.lose) return new Promise<Response>(() => {});
			return response;
		}) as typeof fetch,
	});
	return keeper;
}

async function until(check: () => boolean, what: string, ms = 2000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe('the re-send rule on load: a stored copy is dropped only when the file already holds it', () => {
	test('the review\'s failure case: the file ends at A, the stored copy holds A+B; B is recovered and written', async () => {
		const storage = new MemoryStorage();
		const wire: Wire = { calls: [] };
		const id = 'pages/index';
		const opened = await readPage('pages', 'index');

		// 1. Type A; the write for A goes out, lands on disk, and its answer is lost (step 4's "lands last").
		const first = page(storage, wire);
		first.opened(id, HOME, opened.version);
		const a = clone(opened.document);
		a.blocks[0]!.data.intro = 'Typed A';
		wire.lose = true;
		first.change(id, { file: HOME, base: opened.text, document: a });
		await until(() => wire.landed === 1, 'the write for A to land');
		// 2. Type B.
		const ab = clone(a);
		ab.title = 'Home, typed B';
		first.change(id, { file: HOME, base: opened.text, document: ab });
		// 3. Reload: pagehide holds A+B against v0 and fires a keepalive, 4. which the browser refuses.
		wire.refuseKeepalive = true;
		first.pagehide();
		assert.deepEqual(wire.calls.map((c) => [c.title, c.keepalive]), [['Home', false], ['Home, typed B', true]]);
		const held = JSON.parse(storage.getItem(`caracms:unsent:site:${id}`)!);
		assert.equal(held.fileVersion, opened.version, 'held against v0');
		assert.equal(held.document.title, 'Home, typed B');

		// 5. The file is at v1: A only.
		const reopened = await readPage('pages', 'index');
		assert.notEqual(reopened.version, opened.version);
		assert.equal(reopened.document.blocks[0]!.data.intro, 'Typed A');
		assert.equal(reopened.document.title, 'Home');

		// The new page: the copy is not dropped; it's adopted and re-sent, Keeping until it lands.
		const wire2: Wire = { calls: [] };
		const second = page(storage, wire2);
		second.opened(id, HOME, reopened.version);
		const recovered = second.recoverable(id, reopened);
		assert.ok(recovered, 'B is recovered');
		assert.equal(recovered.document.title, 'Home, typed B');
		assert.equal(recovered.base, opened.text, 'with the base it was made against');
		second.resend(id, recovered);
		assert.equal(second.status.get().state, 'keeping');
		await until(() => second.status.get().state === 'kept', 'Kept');
		const now = parseDocumentText(disk(HOME), site).document;
		assert.equal(now.title, 'Home, typed B', 'B is written');
		assert.equal(now.blocks[0]!.data.intro, 'Typed A', 'and A with it');
		assert.equal(storage.map.size, 0, 'dropped once the file has it');
	});

	test('a copy the file already holds is still dropped (the keepalive landed, say)', async () => {
		const storage = new MemoryStorage();
		const id = 'pages/index';
		const opened = await readPage('pages', 'index');
		const ab = clone(opened.document);
		ab.title = 'Landed by keepalive';
		storage.setItem(`caracms:unsent:site:${id}`, JSON.stringify({ v: 1, file: HOME, base: opened.text, document: ab, fileVersion: opened.version }));
		await store.write({ file: HOME, base: opened.text, document: ab });
		const reopened = await readPage('pages', 'index');
		assert.notEqual(reopened.version, opened.version);
		const wire: Wire = { calls: [] };
		const keeper = page(storage, wire);
		keeper.opened(id, HOME, reopened.version);
		assert.equal(keeper.recoverable(id, reopened), null);
		assert.equal(storage.map.size, 0);
		assert.equal(wire.calls.length, 0, 'nothing re-sent');
	});

	test('a copy whose file hasn\'t moved is re-sent as before', async () => {
		const storage = new MemoryStorage();
		const opened = await readPage('pages', 'index');
		const edited = clone(opened.document);
		edited.title = 'Held';
		storage.setItem('caracms:unsent:site:pages/index', JSON.stringify({ v: 1, file: HOME, base: opened.text, document: edited, fileVersion: opened.version }));
		const keeper = page(storage, { calls: [] });
		assert.equal(keeper.recoverable('pages/index', opened)!.document.title, 'Held');
	});

	test('recoverOthers: re-sends a copy the file doesn\'t hold, drops one it does, keeps a gone document\'s', async () => {
		const storage = new MemoryStorage();
		const home = await readPage('pages', 'index');
		const contact = await readPage('pages', 'contact');
		const put = (id: string, file: string, base: string, document: SiteDocument, fileVersion: string) =>
			storage.setItem(`caracms:unsent:site:${id}`, JSON.stringify({ v: 1, file, base, document, fileVersion }));
		// Home's copy: made against an older version, and the file doesn't hold it.
		const homeEdit = clone(home.document);
		homeEdit.title = 'Home, held';
		put('pages/index', HOME, home.text, homeEdit, 'older');
		// Contact's copy: the file already holds it.
		const contactEdit = clone(contact.document);
		contactEdit.title = 'Contact, landed';
		await store.write({ file: CONTACT, base: contact.text, document: contactEdit });
		put('pages/contact', CONTACT, contact.text, contactEdit, contact.version);
		put('pages/gone', 'content/pages/gone.json', '{}', { title: 'Gone', blocks: [] }, 'x');

		const wire: Wire = { calls: [] };
		const keeper = page(storage, wire);
		await keeper.recoverOthers('pages/elsewhere', async (id) => {
			if (id === 'pages/gone') return null;
			return readPage('pages', id.slice('pages/'.length));
		});
		await until(() => keeper.status.get().state === 'kept', 'Kept');
		assert.deepEqual(wire.calls.map((c) => c.title), ['Home, held']);
		assert.equal(parseDocumentText(disk(HOME), site).document.title, 'Home, held');
		assert.deepEqual([...storage.map.keys()], ['caracms:unsent:site:pages/gone']);
	});
});

describe('a write the server refuses (a 4xx) is the server answering', () => {
	test('the file is renamed while the document is open: refused with the server\'s message, held, retried on the next change', async () => {
		const storage = new MemoryStorage();
		const wire: Wire = { calls: [] };
		const id = 'pages/contact';
		const opened = await readPage('pages', 'contact');
		const keeper = page(storage, wire);
		keeper.opened(id, CONTACT, opened.version);
		renameSync(join(root, CONTACT), join(root, 'content/pages/contact-us.json'));

		const edited = clone(opened.document);
		edited.title = 'Contact, edited';
		keeper.change(id, { file: CONTACT, base: opened.text, document: edited });
		await until(() => keeper.status.get().state === 'refused', 'refused');
		const status = keeper.status.get();
		assert.match(status.error!, /no document "contact"/, 'the server\'s own message');
		assert.ok(storage.getItem(`caracms:unsent:site:${id}`), 'the edits stay held');

		await new Promise((r) => setTimeout(r, 50));
		assert.equal(wire.calls.length, 1, 'no timer retries');

		edited.title = 'Contact, edited again';
		keeper.change(id, { file: CONTACT, base: opened.text, document: clone(edited) });
		assert.equal(keeper.status.get().state, 'refused', 'still saying so while the retry is pending');
		await until(() => wire.calls.length === 2, 'the retry');
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(keeper.status.get().state, 'refused', 'refused again');
		assert.equal(JSON.parse(storage.getItem(`caracms:unsent:site:${id}`)!).document.title, 'Contact, edited again', 'the latest edits held');

		// The file comes back: the next change gets through.
		renameSync(join(root, 'content/pages/contact-us.json'), join(root, CONTACT));
		keeper.change(id, { file: CONTACT, base: opened.text, document: clone(edited) });
		await until(() => keeper.status.get().state === 'kept', 'Kept');
		assert.equal(keeper.status.get().error, null);
		assert.equal(parseDocumentText(disk(CONTACT), site).document.title, 'Contact, edited again');
		assert.equal(storage.map.size, 0);
	});

	test('edits that don\'t fit their base: a 400, refused, not "can\'t reach"', async () => {
		const storage = new MemoryStorage();
		const keeper = page(storage, { calls: [] });
		const opened = await readPage('pages', 'index');
		const edited = clone(opened.document);
		edited.blocks[0]!.source = 99;
		keeper.opened('pages/index', HOME, opened.version);
		keeper.change('pages/index', { file: HOME, base: opened.text, document: edited });
		await until(() => keeper.status.get().state === 'refused', 'refused');
		assert.match(keeper.status.get().error!, /don't apply to the base/);
		assert.equal(storage.map.size, 1);
		assert.equal(disk(HOME), originals.get(HOME));
	});

	test('a 5xx stays "can\'t reach the server"', async () => {
		const storage = new MemoryStorage();
		const keeper = createKeeper({
			site,
			storage,
			storageKey: 'site',
			log: () => {},
			delay: 1,
			fetch: (async () => new Response(JSON.stringify({ error: 'disk full' }), { status: 500 })) as typeof fetch,
		});
		keeper.opened('pages/index', HOME, 'v0');
		keeper.change('pages/index', { file: HOME, base: '{}', document: { title: 'x', blocks: [] } });
		await until(() => keeper.status.get().state === 'offline', 'offline');
		assert.equal(keeper.status.get().error, 'disk full');
		assert.equal(storage.map.size, 1);
	});
});

describe('a block whose type is a built-in object name (document.ts: own keys only)', () => {
	const odd = `{
  "title": "Odd",
  "blocks": [
    { "type": "constructor", "x": 1 },
    {
      "type": "hero",
      "heading": ["Play Hard"],
      "intro": "Hi"
    },
    { "type": "toString" },
    {
      "type": "__proto__",
      "fields": { "a": [1, 2] }
    },
    { "type": "hasOwnProperty" }
  ]
}
`;

	test('kept in the file and skipped in the render, like any unknown block; round-trips byte for byte', () => {
		const { document } = parseDocumentText(odd, site);
		assert.deepEqual(
			document.blocks.map((b) => [b.type, b.known]),
			[['constructor', false], ['hero', true], ['toString', false], ['__proto__', false], ['hasOwnProperty', false]],
		);
		assert.deepEqual(blockContexts(document, site, false).map((c) => c !== null), [false, true, false, false, false], 'only the hero renders');
		assert.equal(applyEdits(odd, document, site), odd, 'untouched: byte for byte');
		const normalised = normaliseDocument(JSON.parse(JSON.stringify(document)), site);
		assert.deepEqual(normalised.blocks.map((b) => b.known), [false, true, false, false, false]);
		assert.equal(applyEdits(odd, normalised, site), odd);

		// An edit elsewhere leaves them exactly as read.
		const edited = clone(document);
		edited.blocks[1]!.data.intro = 'Hello';
		const written = applyEdits(odd, edited, site);
		assert.ok(written.includes('{ "type": "constructor", "x": 1 }'));
		assert.ok(written.includes('{ "type": "toString" }'));
		assert.ok(written.includes('"type": "__proto__",\n      "fields": { "a": [1, 2] }'));
		assert.equal(parseDocumentText(written, site).document.blocks[1]!.data.intro, 'Hello');
	});

	test('the reader opens such a file (it isn\'t reported as invalid JSON) and the listing has no warning', async () => {
		writeFileSync(join(root, 'content/pages/odd.json'), odd);
		try {
			const read = await readPage('pages', 'odd');
			assert.equal(read.document.title, 'Odd');
			const listed = (await store.list()).find((d) => d.path === 'odd');
			assert.equal(listed?.warning, null);
		} finally {
			rmSync(join(root, 'content/pages/odd.json'));
		}
	});
});
