// Page folders, the Apply and the stores (the spec's Acceptance checks),
// without a browser, driven through the stores on a temp site as arrange-pages.test.ts does:
// - local: a folder-only Apply (check 2), Remove and an emptied folder (8, 9), Change address…
//   (9, 12), Delete… and a reused slug (13), putting a folder in and taking it out of the
//   addresses with no self-redirect or cycle (15–17), a group taken out with a folder inside it or
//   itself filed (19), a stale `expectOrder` (20), each Apply refusal (21), the listing's order
//   with folders flattened (22), New page in <Folder> (10);
// - live: the order stamp changes when only folders do (3), a New page in <Folder> waiting on
//   Site Settings and the hand-order route filing it (10), a stale `expectOrder` over the wire (20).
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { resolveSite, SITE_SETTINGS_FILE, type ResolvedSite, type SiteConfig } from '../src/config.ts';
import { listDocuments } from '../src/content.ts';
import { FOLDER_GONE_MESSAGE, FOLDER_UNKEPT_MESSAGE, handleArrange, pagesLayout } from '../src/editor/server/arrange.ts';
import { handleCollectionOrder, handleCreate } from '../src/editor/server/create.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { handleMove } from '../src/editor/server/move.ts';
import type { CreateDeleteRefusal, CreateResponse, StatusResponse } from '../src/editor/types.ts';
import { MemoryBackend } from '../src/live/backend.ts';
import { createLiveEditor, type LiveEditor } from '../src/live/editor.ts';
import { Tracker } from '../src/live/github.ts';
import type { Person } from '../src/live/messages.ts';
import type { LiveSettings } from '../src/live/mode.ts';
import { memoryRedis } from '../src/live/redis.ts';
import { createLiveRuntime, siteFiles } from '../src/live/runtime.ts';
import { DEFAULT_TIMINGS } from '../src/live/timings.ts';
import { pageOrderStamp } from '../src/page-order.ts';
import type { PageFolders } from '../src/page-folders.ts';
import { parseRedirects } from '../src/redirects.ts';
import { config, display, fixtures, siteRoot } from './helpers/site.ts';

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
type Answer = { ok?: true } & Partial<CreateDeleteRefusal> & { error?: string; code?: string };

// ── The site ─────────────────────────────────────────────────────────────────

const page = (title: string) => `${JSON.stringify({ title, blocks: [] }, null, 2)}\n`;
const FILES: Record<string, string> = {
	'content/pages/index.json': page('Home'),
	'content/pages/about.json': page('About'),
	'content/pages/about/team.json': page('Team'),
	'content/pages/contact.json': page('Contact'),
	'content/pages/privacy.json': page('Privacy'),
	'content/pages/services/branding.json': page('Branding'),
	'content/pages/services/websites.json': page('Websites'),
};
const settings = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ title: 'Site Settings', editors: [], ...extra }, null, 2)}\n`;
const folder = (id: string, name: string, pages: string[]) => ({ id, name, pages });
/** About (with Team under it) and Contact filed in Company, which sits first. */
const COMPANY = { pageOrder: { '': ['(company)', 'services', 'privacy'] }, pageFolders: { '': [folder('company', 'Company', ['about', 'contact'])] } };

interface Saved {
	pageOrder?: Record<string, string[]>;
	pageFolders?: Record<string, { id: string; name: string; pages: string[] }[]>;
	redirects?: { from: string; to: string }[];
}

function makeSite(settingsText: string, files: Record<string, string> = {}, options: { repoPath?: string } = {}) {
	const tmp = mkdtempSync(join(tmpdir(), 'caracms-folders-apply-'));
	const root = join(tmp, 'site');
	cpSync(siteRoot, root, { recursive: true });
	rmSync(join(root, 'content'), { recursive: true, force: true });
	const write = (file: string, text: string) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	};
	for (const [file, text] of Object.entries({ ...FILES, ...files, [SITE_SETTINGS_FILE]: settingsText })) write(file, text);
	const site: ResolvedSite = resolveSite(
		{
			...(config as SiteConfig),
			...(options.repoPath ? { repoPath: options.repoPath } : {}),
			collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } },
			textStyles: { display: { ...display, fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') } } },
		} as SiteConfig,
		root,
	);
	const text = () => readFileSync(join(root, SITE_SETTINGS_FILE), 'utf8');
	return { root, site, write, text, saved: () => JSON.parse(text()) as Saved, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function local(settingsText: string, files: Record<string, string> = {}) {
	const s = makeSite(settingsText, files);
	const store = localDraftsStore(s.site);
	const arrange = (body: unknown) => call<Answer>(handleArrange(request('/_caracms/arrange', { body }), store));
	const move = (body: Record<string, unknown>) => call<Answer>(handleMove(request('/_caracms/move', { body }), store));
	const create = (body: Record<string, unknown>) => call<CreateResponse & Answer>(handleCreate(request('/_caracms/create', { body }), store));
	const paths = async () => (await listDocuments(s.site, 'pages')).map((d) => d.path);
	/** The listing's folders and order stamp, as the client reads them. */
	const layout = async () => pagesLayout(s.site, await store.list(), await store.source());
	return { s, store, arrange, move, create, paths, layout };
}
const root = (fromPath: string, toPath: string) => ({ collection: 'pages', fromPath, toPath });
const rowsOf = (folders: Record<string, { id: string; rows: string[] }[]>) => Object.fromEntries(Object.entries(folders).map(([level, list]) => [level, list.map((f) => [f.id, f.rows])]));

// ── Local ────────────────────────────────────────────────────────────────────

describe('local: a folder-only Apply (check 2, 22)', () => {
	test('writes pageFolders and the token, no other file, no redirect; the listing shows the folder with its rows in the tree order', async () => {
		const { s, arrange, paths, layout } = local(settings());
		try {
			const before = new Map(Object.keys(FILES).map((f) => [f, readFileSync(join(s.root, f), 'utf8')]));
			const r = await arrange({ moves: [], order: { '': ['(company)', 'services', 'privacy'] }, folders: { '': [folder('company', 'Company', ['about', 'contact'])] } });
			assert.deepEqual(r, { status: 200, body: { ok: true } });
			for (const [file, text] of before) assert.equal(readFileSync(join(s.root, file), 'utf8'), text, file);
			const saved = s.saved();
			assert.deepEqual(saved.pageFolders, { '': [folder('company', 'Company', ['about', 'contact'])] });
			assert.deepEqual(saved.pageOrder, { '': ['(company)', 'services', 'privacy'] });
			assert.equal(saved.redirects, undefined);
			assert.deepEqual(Object.keys(saved).sort(), ['editors', 'pageFolders', 'pageOrder', 'title']);
			// Check 22: documents() lists the tree's order with the folder's rows in its place, no folder rows.
			assert.deepEqual(await paths(), ['index', 'about', 'about/team', 'contact', 'services/branding', 'services/websites', 'privacy']);
			const listed = await layout();
			assert.deepEqual(rowsOf(listed.folders), { '': [['company', ['about', 'contact']]] });
			assert.equal(listed.orderStamp, pageOrderStamp(saved.pageOrder, saved.pageFolders));
			assert.deepEqual(listed.ids, { '': ['company'] });
			// The same again changes nothing.
			const text = s.text();
			assert.equal((await arrange({ moves: [], order: { '': ['(company)', 'services', 'privacy'] }, folders: { '': [folder('company', 'Company', ['about', 'contact'])] } })).status, 200);
			assert.equal(s.text(), text);
		} finally {
			s.cleanup();
		}
	});
	test('a folder\'s own order: its rows stay together in its place, whatever the level\'s others do (check 22)', async () => {
		const { s, arrange, paths } = local(settings());
		try {
			await arrange({ moves: [], order: { '': ['services', '(company)', 'privacy'] }, folders: { '': [folder('company', 'Company', ['contact', 'about'])] } });
			assert.deepEqual(await paths(), ['index', 'services/branding', 'services/websites', 'contact', 'about', 'about/team', 'privacy']);
		} finally {
			s.cleanup();
		}
	});
	test('a folder under a group: the group\'s level key, the token in that level\'s list', async () => {
		const { s, arrange, layout } = local(settings());
		try {
			const r = await arrange({ moves: [], order: { services: ['(extras)', 'branding'] }, folders: { services: [folder('extras', 'Extras', ['websites'])] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(s.saved().pageFolders, { services: [folder('extras', 'Extras', ['websites'])] });
			assert.deepEqual(rowsOf((await layout()).folders), { services: [['extras', ['services/websites']]] });
		} finally {
			s.cleanup();
		}
	});
});

describe('local: Remove, an emptied folder, Change address… (checks 8, 9, 12)', () => {
	test('Remove (an Apply sending the level with no folders): its rows back in place, the folder and its token gone', async () => {
		const { s, arrange, paths, layout } = local(settings(COMPANY));
		try {
			const r = await arrange({ moves: [], order: { '': ['about', 'contact', 'services', 'privacy'] }, folders: { '': [] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const saved = s.saved();
			assert.equal(saved.pageFolders, undefined);
			assert.deepEqual(saved.pageOrder, { '': ['about', 'contact', 'services', 'privacy'] });
			assert.deepEqual(await paths(), ['index', 'about', 'about/team', 'contact', 'services/branding', 'services/websites', 'privacy']);
			assert.deepEqual((await layout()).folders, {});
		} finally {
			s.cleanup();
		}
	});
	test('an existing folder emptied by an Apply goes with its token, in the same write', async () => {
		const { s, arrange } = local(settings(COMPANY));
		try {
			// Both rows leave the top level for Services; the request never names the folder.
			const r = await arrange({ moves: [root('about', 'services/about'), root('contact', 'services/contact')], order: { services: ['about', 'contact', 'branding', 'websites'] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const saved = s.saved();
			assert.equal(saved.pageFolders, undefined);
			assert.ok(!(saved.pageOrder?.[''] ?? []).includes('(company)'), JSON.stringify(saved.pageOrder));
			assert.ok(saved.redirects && saved.redirects.length > 0, 'the moves\' own redirects are in that write');
		} finally {
			s.cleanup();
		}
	});
	test('Change address… moving the last page out of a folder drops the folder and its token in the move\'s write (check 9)', async () => {
		const one = { pageOrder: { '': ['(company)', 'services'] }, pageFolders: { '': [folder('company', 'Company', ['contact'])] } };
		const { s, move } = local(settings(one));
		try {
			const r = await move({ collection: 'pages', path: 'contact', to: 'services/contact' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const saved = s.saved();
			assert.equal(saved.pageFolders, undefined);
			assert.ok(!JSON.stringify(saved.pageOrder ?? {}).includes('(company)'), JSON.stringify(saved.pageOrder));
			assert.deepEqual(saved.redirects, [{ from: '/contact', to: '/services/contact' }]);
		} finally {
			s.cleanup();
		}
	});
	test('Change address… keeping the parent keeps the page in its folder, in place; to another level takes it out (check 12)', async () => {
		const { s, move } = local(settings(COMPANY));
		try {
			const r = await move({ collection: 'pages', path: 'contact', to: 'get-in-touch' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(s.saved().pageFolders, { '': [folder('company', 'Company', ['about', 'get-in-touch'])] });
			assert.deepEqual(s.saved().redirects, [{ from: '/contact', to: '/get-in-touch' }], 'the one write carries the redirect too');
			const out = await move({ collection: 'pages', path: 'get-in-touch', to: 'services/get-in-touch' });
			assert.equal(out.status, 200, JSON.stringify(out.body));
			assert.deepEqual(s.saved().pageFolders, { '': [folder('company', 'Company', ['about'])] });
			assert.deepEqual(s.saved().pageOrder, COMPANY.pageOrder);
		} finally {
			s.cleanup();
		}
	});
});

describe('local: Delete… and a reused slug (check 13)', () => {
	test('Delete… of a filed page doesn\'t write Site Settings; the folder\'s count drops; a folder with every row deleted isn\'t drawn', async () => {
		const { s, store, layout } = local(settings(COMPANY));
		try {
			const text = s.text();
			await store.delete({ collection: 'pages', path: 'contact' });
			assert.equal(s.text(), text, 'Site Settings untouched');
			assert.deepEqual(rowsOf((await layout()).folders), { '': [['company', ['about']]] });
			// Team keeps About's place as a group while it's there; once both are gone nothing is left to show.
			await store.delete({ collection: 'pages', path: 'about' });
			assert.deepEqual(rowsOf((await layout()).folders), { '': [['company', ['about']]] }, 'About is still a group, for Team');
			await store.delete({ collection: 'pages', path: 'about/team' });
			assert.equal(s.text(), text);
			assert.deepEqual((await layout()).folders, {}, 'nothing left to show: not drawn');
		} finally {
			s.cleanup();
		}
	});
	test('a new page at a deleted filed page\'s slug is not put back in the folder; the dead slug is cleared in the create\'s write', async () => {
		const { s, store, create, layout } = local(settings(COMPANY));
		try {
			await store.delete({ collection: 'pages', path: 'contact' });
			const r = await create({ collection: 'pages', path: 'contact', title: 'Contact again' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(s.saved().pageFolders, { '': [folder('company', 'Company', ['about'])] });
			assert.deepEqual(rowsOf((await layout()).folders), { '': [['company', ['about']]] });
			// Deleting the folder's other row too, then a create at its slug: the folder empties and goes with its token.
			await store.delete({ collection: 'pages', path: 'about' });
			await store.delete({ collection: 'pages', path: 'about/team' });
			await create({ collection: 'pages', path: 'about', title: 'About again' });
			assert.equal(s.saved().pageFolders, undefined);
			assert.ok(!JSON.stringify(s.saved().pageOrder ?? {}).includes('(company)'));
		} finally {
			s.cleanup();
		}
	});
});

/** Every redirect from → to, the raw entries (parseRedirects would drop a self-redirect before it could be seen). */
const rawRedirects = (s: { saved(): Saved }) => (s.saved().redirects ?? []).map((r) => [r.from, r.to] as const);
/** Where a request for `address` ends up following redirects: the address of a live page, or fails on a cycle or a dead end. */
function resolve(address: string, redirects: readonly (readonly [string, string])[], live: ReadonlySet<string>): string {
	const seen = new Set<string>();
	let at = address;
	while (!live.has(at)) {
		assert.ok(!seen.has(at), `a redirect cycle through ${at}`);
		seen.add(at);
		const hop = redirects.find(([from]) => from === at);
		assert.ok(hop, `${address} goes nowhere (stopped at ${at})`);
		at = hop[1];
	}
	return at;
}

describe('local: a folder into the addresses and back (checks 15–17)', () => {
	const PUT_IN = {
		moves: [root('about', 'company/about'), root('contact', 'company/contact')],
		order: { '': ['company', 'services', 'privacy'], company: ['about', 'contact'] },
		folders: { '': [] },
	};
	const TAKE_OUT = {
		moves: [root('company/about', 'about'), root('company/contact', 'contact')],
		order: { '': ['(company)', 'services', 'privacy'] },
		folders: { '': [folder('company', 'Company', ['about', 'contact'])] },
	};
	test('Put in: every address moves under Company with the tick; the group takes the folder\'s place; /contact answers 301 to /company/contact', async () => {
		const { s, arrange, paths, layout } = local(settings(COMPANY));
		try {
			const r = await arrange(PUT_IN);
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(await paths(), ['index', 'company/about', 'company/about/team', 'company/contact', 'services/branding', 'services/websites', 'privacy']);
			const saved = s.saved();
			assert.equal(saved.pageFolders, undefined);
			assert.deepEqual(saved.pageOrder, { '': ['company', 'services', 'privacy'], company: ['about', 'contact'] });
			const redirects = parseRedirects(saved.redirects).map((x) => `${x.from} → ${x.to}`);
			for (const x of ['/about → /company/about', '/about/team → /company/about/team', '/contact → /company/contact']) assert.ok(redirects.includes(x), `${x} in ${redirects.join(', ')}`);
			assert.deepEqual((await layout()).folders, {});
		} finally {
			s.cleanup();
		}
	});
	test('Take out right after: every address goes back, a Company folder in the group\'s place, and no redirect is left that points at itself or round a cycle', async () => {
		const { s, arrange, paths, layout } = local(settings(COMPANY));
		try {
			assert.equal((await arrange(PUT_IN)).status, 200);
			const r = await arrange(TAKE_OUT);
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(await paths(), ['index', 'about', 'about/team', 'contact', 'services/branding', 'services/websites', 'privacy']);
			assert.deepEqual(s.saved().pageFolders, { '': [folder('company', 'Company', ['about', 'contact'])] });
			assert.deepEqual(s.saved().pageOrder, COMPANY.pageOrder);
			assert.deepEqual(rowsOf((await layout()).folders), { '': [['company', ['about', 'contact']]] });
			const live = new Set((await listDocuments(s.site, 'pages')).map((d) => d.url as string));
			const redirects = rawRedirects(s);
			for (const [from, to] of redirects) {
				assert.notEqual(from, to, `a redirect from ${from} to itself`);
				assert.ok(!live.has(from), `${from} is a live page and also redirects (to ${to})`);
			}
			for (const address of ['/about', '/about/team', '/contact']) assert.equal(resolve(address, redirects, live), address, `${address} answers its own page, no hop`);
			// The addresses the folder briefly had still answer, at the page.
			assert.equal(resolve('/company/contact', redirects, live), '/contact');
			assert.equal(resolve('/company/about/team', redirects, live), '/about/team');
		} finally {
			s.cleanup();
		}
	});
});

describe('local: taking a group out with a folder inside it, or itself filed (check 19)', () => {
	const GROUP_FILES = { 'content/pages/company/story.json': page('Story'), 'content/pages/company/jobs.json': page('Jobs'), 'content/pages/company/team.json': page('Company team') };
	test('the folder inside the group dissolves into the new Company folder: its level and token are gone, the rows join in place', async () => {
		const inner = { pageOrder: { '': ['about', 'contact', 'company', 'privacy'], company: ['story', '(inner)'] }, pageFolders: { company: [folder('inner', 'Inner', ['jobs'])] } };
		const { s, arrange, paths, layout } = local(settings(inner), GROUP_FILES);
		try {
			const r = await arrange({
				moves: [root('company/story', 'story'), root('company/jobs', 'jobs'), root('company/team', 'company-team')],
				order: { '': ['about', 'contact', '(company)', 'privacy'] },
				folders: { '': [folder('company', 'Company', ['story', 'jobs', 'company-team'])] },
			});
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const saved = s.saved();
			assert.deepEqual(saved.pageFolders, { '': [folder('company', 'Company', ['story', 'jobs', 'company-team'])] }, 'the inner folder\'s level went with the group');
			assert.ok(!JSON.stringify(saved.pageOrder).includes('(inner)'));
			assert.deepEqual(saved.pageOrder?.[''], ['about', 'contact', '(company)', 'privacy']);
			assert.deepEqual((await paths()).filter((p) => !p.includes('/')), ['index', 'about', 'contact', 'story', 'jobs', 'company-team', 'privacy']);
			assert.deepEqual(rowsOf((await layout()).folders), { '': [['company', ['story', 'jobs', 'company-team']]] });
		} finally {
			s.cleanup();
		}
	});
	test('a group filed in a folder: its rows join the outer folder in its place, no new folder', async () => {
		const outer = { pageOrder: { '': ['(main)', 'privacy'] }, pageFolders: { '': [folder('main', 'Main', ['about', 'company', 'contact'])] } };
		const { s, arrange, layout } = local(settings(outer), GROUP_FILES);
		try {
			const r = await arrange({
				moves: [root('company/story', 'story'), root('company/jobs', 'jobs'), root('company/team', 'company-team')],
				order: { '': ['(main)', 'privacy'] },
				folders: { '': [folder('main', 'Main', ['about', 'story', 'jobs', 'company-team', 'contact'])] },
			});
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(s.saved().pageFolders, { '': [folder('main', 'Main', ['about', 'story', 'jobs', 'company-team', 'contact'])] });
			assert.deepEqual(rowsOf((await layout()).folders), { '': [['main', ['about', 'story', 'jobs', 'company-team', 'contact']]] });
		} finally {
			s.cleanup();
		}
	});
	test('a folder whose group is gone and which the request leaves out is dropped by the merge, not kept as a ghost', async () => {
		const outer = { pageOrder: { '': ['(main)', 'privacy'] }, pageFolders: { '': [folder('main', 'Main', ['about', 'company'])] } };
		const { s, arrange } = local(settings(outer), GROUP_FILES);
		try {
			// The Apply moves everything out of Company and says nothing of Main: the slug "company" names nothing now.
			const r = await arrange({ moves: [root('company/story', 'story'), root('company/jobs', 'jobs'), root('company/team', 'company-team')], order: {} });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(s.saved().pageFolders, { '': [folder('main', 'Main', ['about'])] });
		} finally {
			s.cleanup();
		}
	});
});

describe('local: two arrangers (check 20)', () => {
	test('the first Apply lands; the second, planned on the same order, is refused 409 changed, nothing written', async () => {
		const { s, arrange, layout } = local(settings(COMPANY));
		try {
			const stamp = (await layout()).orderStamp;
			const first = await arrange({ moves: [], order: { '': ['services', '(company)', 'privacy'] }, folders: { '': [folder('company', 'Company', ['about', 'contact'])] }, expectOrder: stamp });
			assert.equal(first.status, 200, JSON.stringify(first.body));
			const text = s.text();
			const second = await arrange({ moves: [], order: { '': ['privacy', '(company)', 'services'] }, folders: { '': [folder('company', 'Company', ['about', 'contact'])] }, expectOrder: stamp });
			assert.equal(second.status, 409, JSON.stringify(second.body));
			assert.equal(second.body.code, 'changed');
			assert.equal(second.body.error, 'The pages changed since you opened the review.');
			assert.equal(s.text(), text);
		} finally {
			s.cleanup();
		}
	});
	test('also when the only difference is the saved folders (a rename, a row filed): the order list is the same', async () => {
		const { s, arrange, layout } = local(settings(COMPANY));
		try {
			const stamp = (await layout()).orderStamp;
			assert.equal((await arrange({ moves: [], order: {}, folders: { '': [folder('company', 'Company', ['about'])] }, expectOrder: stamp })).status, 200);
			assert.deepEqual(s.saved().pageOrder, COMPANY.pageOrder, 'the order itself didn\'t change');
			const text = s.text();
			const stale = await arrange({ moves: [], order: { '': ['privacy', '(company)', 'services'] }, expectOrder: stamp });
			assert.equal(stale.status, 409);
			assert.equal(stale.body.code, 'changed');
			assert.equal(s.text(), text);
			// Fresh stamp: lands.
			assert.equal((await arrange({ moves: [], order: { '': ['privacy', '(company)', 'services'] }, expectOrder: (await layout()).orderStamp })).status, 200);
		} finally {
			s.cleanup();
		}
	});
	test('a site with no folders: the stamp is the order\'s alone (as before), and a stale order is refused too', async () => {
		const { s, arrange, layout } = local(settings({ pageOrder: { '': ['privacy', 'about'] } }));
		try {
			const stamp = (await layout()).orderStamp;
			assert.equal(stamp, pageOrderStamp({ '': ['privacy', 'about'] }));
			assert.equal((await arrange({ moves: [], order: { '': ['about', 'privacy'] }, expectOrder: stamp })).status, 200);
			assert.equal((await arrange({ moves: [], order: { '': ['privacy', 'about'] }, expectOrder: stamp })).status, 409);
		} finally {
			s.cleanup();
		}
	});
});

describe('local: the Apply refuses a bad folders list (check 21), 400 bad-folders, nothing written', () => {
	const ok = folder('company', 'Company', ['about', 'contact']);
	const bad: [string, Record<string, unknown>, RegExp?][] = [
		['an id that isn\'t a slug', { '': [{ ...ok, id: 'Not A Slug!' }] }, /isn’t an address part/],
		['an empty name', { '': [{ ...ok, name: '   ' }] }, /1 to 60 characters/],
		['a name over 60 characters', { '': [{ ...ok, name: 'x'.repeat(61) }] }, /1 to 60 characters/],
		['two folders with one id', { '': [ok, folder('company', 'Other', ['privacy'])] }, /two folders have the id/],
		['two folders with one name, any case', { '': [ok, folder('other', 'COMPANY', ['privacy'])] }, /two folders are called/],
		['a member that doesn\'t exist at that level', { '': [folder('company', 'Company', ['about', 'nothing'])] }, /no page or group at \/nothing/],
		['a member that is a page a level down (not at its level)', { '': [folder('company', 'Company', ['team'])] }, /no page or group at \/team/],
		['a slug in two folders', { '': [ok, folder('other', 'Other', ['contact', 'privacy'])] }, /in two folders/],
		['index', { '': [folder('company', 'Company', ['index', 'about'])] }, /Home can’t go in a folder/],
		['an empty folder', { '': [{ ...ok, pages: [] }] }, /has nothing in it/],
		['a level that names no page or group', { nowhere: [folder('x', 'X', ['y'])] }, /there’s no page or group at \/nowhere/],
	];
	for (const [label, folders, why] of bad) {
		test(label, async () => {
			const { s, arrange } = local(settings(COMPANY));
			try {
				const before = s.text();
				const r = await arrange({ moves: [], order: {}, folders });
				assert.equal(r.status, 400, JSON.stringify(r.body));
				assert.equal(r.body.code, 'bad-folders');
				if (why) assert.match(r.body.error ?? '', why);
				assert.equal(s.text(), before);
			} finally {
				s.cleanup();
			}
		});
	}
	test('a member that exists only after the moves is fine; one that left its level in the moves is refused', async () => {
		const { s, arrange } = local(settings());
		try {
			const good = await arrange({ moves: [root('contact', 'get-in-touch')], order: { '': ['(f)'] }, folders: { '': [folder('f', 'F', ['get-in-touch'])] } });
			assert.equal(good.status, 200, JSON.stringify(good.body));
			const before = s.text();
			const gone = await arrange({ moves: [root('privacy', 'services/privacy')], order: {}, folders: { '': [folder('g', 'G', ['privacy'])] } });
			assert.equal(gone.status, 400, JSON.stringify(gone.body));
			assert.equal(gone.body.code, 'bad-folders');
			assert.equal(s.text(), before);
		} finally {
			s.cleanup();
		}
	});
	test('a token in `order` naming no folder in the result is dropped in the same write, not refused', async () => {
		const { s, arrange } = local(settings());
		try {
			const r = await arrange({ moves: [], order: { '': ['(ghost)', 'privacy', '(company)'] }, folders: { '': [folder('company', 'Company', ['about'])] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(s.saved().pageOrder, { '': ['privacy', '(company)'] });
			assert.deepEqual(s.saved().pageFolders, { '': [folder('company', 'Company', ['about'])] });
		} finally {
			s.cleanup();
		}
	});
});

describe('local: New page in <Folder> (check 10)', () => {
	test('made at the folder\'s level and filed at the end of the folder', async () => {
		const { s, create, paths, layout } = local(settings(COMPANY));
		try {
			const r = await create({ collection: 'pages', path: 'careers', title: 'Careers', folder: 'company' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.equal(r.body.order, 'first');
			assert.deepEqual(s.saved().pageFolders, { '': [folder('company', 'Company', ['about', 'contact', 'careers'])] });
			assert.deepEqual(await paths(), ['index', 'about', 'about/team', 'contact', 'careers', 'services/branding', 'services/websites', 'privacy']);
			assert.deepEqual(rowsOf((await layout()).folders), { '': [['company', ['about', 'contact', 'careers']]] });
		} finally {
			s.cleanup();
		}
	});
	test('a folder under a group: the page is made at that level and filed there', async () => {
		const extras = { pageOrder: { services: ['(extras)', 'branding'] }, pageFolders: { services: [folder('extras', 'Extras', ['websites'])] } };
		const { s, create } = local(settings(extras));
		try {
			const r = await create({ collection: 'pages', path: 'services/print', title: 'Print', folder: 'extras' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.equal(r.body.order, 'first');
			assert.deepEqual(s.saved().pageFolders, { services: [folder('extras', 'Extras', ['websites', 'print'])] });
		} finally {
			s.cleanup();
		}
	});
	test('the folder gone by then: the page is made unfiled, unkept, with the sentence', async () => {
		const { s, create, paths } = local(settings(COMPANY));
		try {
			const before = s.text();
			const r = await create({ collection: 'pages', path: 'careers', title: 'Careers', folder: 'removed-meanwhile' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.equal(r.body.order, 'unkept');
			assert.equal(r.body.orderError, FOLDER_GONE_MESSAGE);
			assert.ok((await paths()).includes('careers'), 'the page was made');
			assert.deepEqual(s.saved().pageFolders, COMPANY.pageFolders);
			assert.equal(s.text(), before);
		} finally {
			s.cleanup();
		}
	});
	test('Site Settings unreadable: made unfiled, unkept, with the sentence, nothing written to it', async () => {
		const broken = '{ "title": "Site Settings", ';
		const { s, create, paths } = local(broken);
		try {
			const r = await create({ collection: 'pages', path: 'careers', title: 'Careers', folder: 'company' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.equal(r.body.order, 'unkept');
			assert.equal(r.body.orderError, FOLDER_UNKEPT_MESSAGE);
			assert.ok((await paths()).includes('careers'));
			assert.equal(s.text(), broken);
		} finally {
			s.cleanup();
		}
	});
});

// ── Live ─────────────────────────────────────────────────────────────────────

const liveSettings: LiveSettings = {
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
	ed: LiveEditor;
	s: ReturnType<typeof makeSite>;
}

async function world(settingsText: string): Promise<World> {
	const s = makeSite(settingsText, {}, { repoPath: 'starter' });
	const clock = { t: Date.parse('2026-11-13T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	backend.seed([...(await siteFiles(s.site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const rt = await createLiveRuntime({ site: s.site, settings: liveSettings, backend, redis: memoryRedis({ now: () => clock.t }), now: () => clock.t, log: () => {}, runningCommit: () => null });
	const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	return { clock, ed, s };
}
const arrangeLive = (w: World, body: unknown, tab = TAB_A, person = aoife) => call<Answer>(handleArrange(request('/_caracms/arrange', { tab, body }), w.ed.store, { person }));
const createLive = (w: World, body: unknown, tab = TAB_A, person = aoife) => call<CreateResponse & Answer>(handleCreate(request('/_caracms/create', { tab, body }), w.ed.store, { person }));
const orderLive = (w: World, body: unknown, tab = TAB_A, person = aoife) => call<Answer>(handleCollectionOrder(request('/_caracms/collection-order', { tab, body }), w.ed.store, { person }));
const poll = async (w: World, person: Person, tab: string) => (await call<StatusResponse>(w.ed.status(request('/_caracms/status', { tab }), person))).body;
async function type(w: World, collection: string, path: string, person: Person, tab: string, edit: (d: Record<string, unknown>) => void, release = false) {
	const opened = await w.ed.store.read(collection, path);
	const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
	edit(document);
	return call(w.ed.write(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-caracms-tab': tab, ...(release ? { 'x-caracms-release': '1' } : {}) }, body: JSON.stringify({ file: opened.entry.file, base: opened.text, document }) }), person));
}
const savedNow = async (w: World) => JSON.parse((await w.ed.store.read('settings', 'site-settings')).text) as Saved;

describe('live: folders in the status stamp and New page in <Folder> (checks 3, 10, 20)', () => {
	test('the stamp another tab polls changes when only the folders change (a rename; the order list is the same)', async () => {
		const w = await world(settings(COMPANY));
		try {
			const before = await poll(w, ciaran, TAB_C);
			assert.equal(before.pageOrderStamp, pageOrderStamp(COMPANY.pageOrder, COMPANY.pageFolders as PageFolders));
			const r = await arrangeLive(w, { moves: [], order: {}, folders: { '': [folder('company', 'Company', ['about'])] }, expectOrder: before.pageOrderStamp });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const now = await savedNow(w);
			assert.deepEqual(now.pageOrder, COMPANY.pageOrder);
			assert.deepEqual(now.pageFolders, { '': [folder('company', 'Company', ['about'])] });
			const after = await poll(w, ciaran, TAB_C);
			assert.notEqual(after.pageOrderStamp, before.pageOrderStamp);
			assert.equal(after.pageOrderStamp, pageOrderStamp(now.pageOrder, now.pageFolders as PageFolders));
			// A second arrange, planned on the old stamp, is refused over the wire, and nothing is written.
			const text = (await w.ed.store.read('settings', 'site-settings')).text;
			const stale = await arrangeLive(w, { moves: [], order: { '': ['privacy', '(company)', 'services'] }, expectOrder: before.pageOrderStamp });
			assert.equal(stale.status, 409, JSON.stringify(stale.body));
			assert.equal(stale.body.code, 'changed');
			assert.equal((await w.ed.store.read('settings', 'site-settings')).text, text);
		} finally {
			w.s.cleanup();
		}
	});
	test('New page in a folder, Site Settings free: filed at the end at once', async () => {
		const w = await world(settings(COMPANY));
		try {
			const made = await createLive(w, { collection: 'pages', path: 'careers', title: 'Careers', folder: 'company' });
			assert.equal(made.status, 200, JSON.stringify(made.body));
			assert.equal(made.body.order, 'first');
			assert.deepEqual((await savedNow(w)).pageFolders, { '': [folder('company', 'Company', ['about', 'contact', 'careers'])] });
		} finally {
			w.s.cleanup();
		}
	});
	test('Site Settings held by someone else: the page is made, the answer is waiting, and the hand-order route files it once Site Settings is free', async () => {
		const w = await world(settings(COMPANY));
		try {
			assert.equal((await type(w, 'settings', 'site-settings', ciaran, TAB_C, (d) => (d.title = 'Mine'))).status, 200);
			const made = await createLive(w, { collection: 'pages', path: 'careers', title: 'Careers', folder: 'company' });
			assert.equal(made.status, 200, JSON.stringify(made.body));
			assert.equal(made.body.order, 'waiting');
			assert.equal(made.body.orderError, undefined, 'no line shows while it waits');
			const listed = async () => (await w.ed.store.list()).filter((d) => d.collection === 'pages').map((d) => d.path);
			assert.ok((await listed()).includes('careers'), 'the page is made');
			// Ciarán finishes; the editor sends the page's filing.
			const theirs = await w.ed.store.read('settings', 'site-settings');
			assert.equal((await call(w.ed.write(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-caracms-tab': TAB_C, 'x-caracms-release': '1' }, body: JSON.stringify({ file: theirs.entry.file, base: theirs.text, document: theirs.document }) }), ciaran))).status, 200);
			assert.equal((await orderLive(w, { collection: 'pages', first: 'careers', folder: 'company' })).status, 409, 'still theirs while their lock is let go');
			w.clock.t += 6_000;
			await w.ed.sweep.tick();
			const placed = await orderLive(w, { collection: 'pages', first: 'careers', folder: 'company' });
			assert.equal(placed.status, 200, JSON.stringify(placed.body));
			assert.deepEqual((await savedNow(w)).pageFolders, { '': [folder('company', 'Company', ['about', 'contact', 'careers'])] });
			assert.equal(((await w.ed.store.read('settings', 'site-settings')).document as { title: string }).title, 'Mine', 'their change kept');
		} finally {
			w.s.cleanup();
		}
	});
	test('the folder gone by the time the filing is sent: refused 404 with the sentence, nothing written', async () => {
		const w = await world(settings(COMPANY));
		try {
			assert.equal((await type(w, 'settings', 'site-settings', ciaran, TAB_C, (d) => (d.title = 'Mine'))).status, 200);
			const made = await createLive(w, { collection: 'pages', path: 'careers', title: 'Careers', folder: 'company' });
			assert.equal(made.body.order, 'waiting');
			const theirs = await w.ed.store.read('settings', 'site-settings');
			assert.equal((await call(w.ed.write(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-caracms-tab': TAB_C, 'x-caracms-release': '1' }, body: JSON.stringify({ file: theirs.entry.file, base: theirs.text, document: theirs.document }) }), ciaran))).status, 200);
			w.clock.t += 6_000;
			await w.ed.sweep.tick();
			// Someone removes the folder meanwhile (the Arrange screen's Remove).
			assert.equal((await arrangeLive(w, { moves: [], order: { '': ['about', 'contact', 'services', 'privacy'] }, folders: { '': [] } })).status, 200);
			const before = (await w.ed.store.read('settings', 'site-settings')).text;
			const placed = await orderLive(w, { collection: 'pages', first: 'careers', folder: 'company' });
			assert.equal(placed.status, 404, JSON.stringify(placed.body));
			assert.equal(placed.body.error, FOLDER_GONE_MESSAGE);
			assert.equal((await w.ed.store.read('settings', 'site-settings')).text, before);
		} finally {
			w.s.cleanup();
		}
	});
});
