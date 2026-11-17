// Page folders, the server's edges, driven through the local
// store on a temp site, as arrange-pages.test.ts does:
// - a live group keeps its folder when a page arrives at its address (create, Change address…,
//   an Apply); a dead slug is still cleared (Decision 9);
// - check 21: a member must be one address part naming something directly at its level; the
//   reader and `validate` treat any other member as naming nothing; Home is never filed, by the
//   waiting filing either;
// - a `pageFolders` level with a shape problem survives every editor write, with its tokens.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { resolveSite, SITE_SETTINGS_FILE, type SiteConfig } from '../src/config.ts';
import { pageLayout } from '../src/cli/validate.ts';
import { FOLDER_MISSHAPEN_MESSAGE, MISSHAPEN_FOLDERS_MESSAGE, parseArrangeBody } from '../src/editor/server/arrange.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { foldersAfterMoves, listedFolders, readPageFolders, settleLayout } from '../src/page-folders.ts';
import { config, display, fixtures, siteRoot } from './helpers/site.ts';

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
const settings = (extra: Record<string, unknown>) => `${JSON.stringify({ title: 'Site Settings', editors: [], ...extra }, null, 2)}\n`;

function makeSite(settingsText: string) {
	const tmp = mkdtempSync(join(tmpdir(), 'caracms-folders-'));
	const root = join(tmp, 'site');
	cpSync(siteRoot, root, { recursive: true });
	rmSync(join(root, 'content'), { recursive: true, force: true });
	for (const [file, text] of Object.entries({ ...FILES, [SITE_SETTINGS_FILE]: settingsText })) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	const site = resolveSite(
		{
			...(config as SiteConfig),
			collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true } },
			textStyles: { display: { ...display, fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') } } },
		} as SiteConfig,
		root,
	);
	const store = localDraftsStore(site);
	const text = () => readFileSync(join(root, SITE_SETTINGS_FILE), 'utf8');
	const saved = () => JSON.parse(text()) as { pageOrder?: Record<string, string[]>; pageFolders?: Record<string, unknown[]> };
	return { store, text, saved, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}
type Site = ReturnType<typeof makeSite>;

async function refusal(run: () => Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
	try {
		await run();
	} catch (e) {
		const err = e as { status: number; body?: { code?: string }; message: string };
		return { status: err.status, code: err.body?.code, message: err.message };
	}
	assert.fail('expected a refusal');
}
const arrange = (s: Site, body: unknown) => s.store.arrange(parseArrangeBody(JSON.parse(JSON.stringify(body))));

// ── 1. A live group keeps its folder ──────────────────────────────────────────

const WHAT = { pageOrder: { '': ['(what)', 'privacy'] }, pageFolders: { '': [{ id: 'what', name: 'What we do', pages: ['services', 'about'] }] } };

describe('a page arriving at a filed group’s address leaves the group in its folder', () => {
	test('New page at /services (the group’s menu)', async () => {
		const s = makeSite(settings(WHAT));
		try {
			await s.store.create({ collection: 'pages', path: 'services', title: 'Services' });
			assert.deepEqual(s.saved().pageFolders, WHAT.pageFolders);
			assert.deepEqual(s.saved().pageOrder, WHAT.pageOrder);
		} finally {
			s.cleanup();
		}
	});
	test('Change address… onto the group’s slug', async () => {
		const s = makeSite(settings(WHAT));
		try {
			await s.store.move({ collection: 'pages', path: 'contact', to: 'services' });
			assert.deepEqual(s.saved().pageFolders, WHAT.pageFolders);
		} finally {
			s.cleanup();
		}
	});
	test('an Apply moving a page onto the group’s address', async () => {
		const s = makeSite(settings(WHAT));
		try {
			await arrange(s, { moves: [{ collection: 'pages', fromPath: 'contact', toPath: 'services' }], order: {} });
			assert.deepEqual(s.saved().pageFolders, WHAT.pageFolders);
		} finally {
			s.cleanup();
		}
	});
	test('a dead slug is still cleared: New page and Change address… at a deleted page’s address', async () => {
		const dead = { pageOrder: { '': ['(co)', 'privacy'] }, pageFolders: { '': [{ id: 'co', name: 'Company', pages: ['about', 'careers', 'jobs'] }] } };
		const s = makeSite(settings(dead));
		try {
			await s.store.create({ collection: 'pages', path: 'careers', title: 'Careers' });
			assert.deepEqual(s.saved().pageFolders, { '': [{ id: 'co', name: 'Company', pages: ['about', 'jobs'] }] });
			await s.store.move({ collection: 'pages', path: 'contact', to: 'jobs' });
			assert.deepEqual(s.saved().pageFolders, { '': [{ id: 'co', name: 'Company', pages: ['about'] }] });
		} finally {
			s.cleanup();
		}
	});
	test('New page in a folder at a filed group’s address files it there, out of its old folder', async () => {
		const two = { pageOrder: { '': ['(what)', '(more)'] }, pageFolders: { '': [{ id: 'what', name: 'What we do', pages: ['services', 'about'] }, { id: 'more', name: 'More', pages: ['privacy'] }] } };
		const s = makeSite(settings(two));
		try {
			const r = await s.store.create({ collection: 'pages', path: 'services', title: 'Services', folder: 'more' });
			assert.equal(r.order, 'first');
			assert.deepEqual(s.saved().pageFolders, { '': [{ id: 'what', name: 'What we do', pages: ['about'] }, { id: 'more', name: 'More', pages: ['privacy', 'services'] }] });
		} finally {
			s.cleanup();
		}
	});
	test('foldersAfterMoves: only a slug arriving where nothing was is cleared', () => {
		const folders = { '': [{ id: 'f', name: 'F', pages: ['services', 'gone'] }] };
		const before = ['index', 'contact', 'services/branding', 'privacy'];
		assert.deepEqual(foldersAfterMoves(folders, [{ from: 'contact', to: 'services' }], before), folders);
		assert.deepEqual(foldersAfterMoves(folders, [{ from: 'contact', to: 'gone' }], before), { '': [{ id: 'f', name: 'F', pages: ['services'] }] });
	});
});

// ── 2. Check 21's members, and the reader's ───────────────────────────────────

const COMPANY = { pageOrder: { '': ['(company)', 'privacy'] }, pageFolders: { '': [{ id: 'company', name: 'Company', pages: ['about', 'contact'] }] } };

describe('a folder member is one address part naming a page or group at its level', () => {
	for (const [label, pages] of [
		['an empty member', ['about', '']],
		['a member with a "/" (a page a level down)', ['about/team', 'contact']],
	] as const) {
		test(`the Apply refuses ${label} (400 bad-folders), nothing written`, async () => {
			const s = makeSite(settings(COMPANY));
			try {
				const before = s.text();
				const r = await refusal(() => arrange(s, { moves: [], order: {}, folders: { '': [{ id: 'company', name: 'Company', pages }] } }));
				assert.equal(r.status, 400);
				assert.equal(r.code, 'bad-folders');
				assert.equal(s.text(), before);
			} finally {
				s.cleanup();
			}
		});
	}
	test('the reader, the settle and validate treat such a member as naming nothing', () => {
		const raw = { '': [{ id: 'company', name: 'Company', pages: ['about/team', '', 'contact'] }] };
		const { folders, problems } = readPageFolders(raw);
		assert.deepEqual(problems, []);
		const paths = ['index', 'about', 'about/team', 'contact', 'privacy'];
		assert.deepEqual(listedFolders(paths, folders), { '': [{ id: 'company', name: 'Company', rows: ['contact'] }] });
		assert.deepEqual(settleLayout({ '': ['(company)'] }, folders, paths).folders, { '': [{ id: 'company', name: 'Company', pages: ['contact'] }] });
		const layout = pageLayout({ '': ['(company)'] }, raw, paths);
		assert.equal(layout.warnings.filter((w) => /isn't one address part/.test(w.message)).length, 2);
		assert.deepEqual(layout.folders, { '': [{ id: 'company', name: 'Company', pages: ['contact'] }] });
	});
	test('the waiting filing refuses Home', async () => {
		const s = makeSite(settings(COMPANY));
		try {
			const before = s.text();
			const r = await refusal(() => s.store.collectionOrder({ collection: 'pages', first: 'index', folder: 'company' }));
			assert.equal(r.status, 400);
			assert.equal(s.text(), before);
		} finally {
			s.cleanup();
		}
	});
});

// ── 3. A level with a shape problem survives editor writes ────────────────────

const BROKEN = {
	pageOrder: { '': ['(company)', 'privacy'], services: ['(web)', 'branding'] },
	pageFolders: { '': [{ id: 'company', name: 'Company', pages: ['about', 'contact'] }], services: [{ id: 'web', name: 'Web', pages: ['websites'], note: 'x' }] },
};
const keepsBrokenLevel = (s: Site) => {
	const saved = s.saved();
	assert.deepEqual(saved.pageFolders?.services, BROKEN.pageFolders.services);
	assert.deepEqual(saved.pageOrder?.services, BROKEN.pageOrder.services);
};

describe('a pageFolders level with a shape problem is left as written', () => {
	test('Change address… elsewhere: the bad level and its tokens stay; the folders aren’t touched', async () => {
		const s = makeSite(settings(BROKEN));
		try {
			await s.store.move({ collection: 'pages', path: 'contact', to: 'get-in-touch' });
			keepsBrokenLevel(s);
			assert.deepEqual(s.saved().pageFolders?.[''], BROKEN.pageFolders['']);
			assert.deepEqual(s.saved().pageOrder?.[''], BROKEN.pageOrder['']);
		} finally {
			s.cleanup();
		}
	});
	test('a new page: the bad level and its tokens stay', async () => {
		const s = makeSite(settings(BROKEN));
		try {
			await s.store.create({ collection: 'pages', path: 'careers', title: 'Careers' });
			keepsBrokenLevel(s);
		} finally {
			s.cleanup();
		}
	});
	test('New page in <Folder>: made outside it, with the sentence; nothing written', async () => {
		const s = makeSite(settings(BROKEN));
		try {
			const before = s.text();
			const r = await s.store.create({ collection: 'pages', path: 'careers', title: 'Careers', folder: 'company' });
			assert.equal(r.order, 'unkept');
			assert.equal(r.orderError, FOLDER_MISSHAPEN_MESSAGE);
			assert.equal(s.text(), before);
			const w = await refusal(() => s.store.collectionOrder({ collection: 'pages', first: 'careers', folder: 'company' }));
			assert.equal(w.status, 422);
			assert.equal(w.message, FOLDER_MISSHAPEN_MESSAGE);
			assert.equal(s.text(), before);
		} finally {
			s.cleanup();
		}
	});
	test('an Apply that changes folders is refused, nothing written', async () => {
		const s = makeSite(settings(BROKEN));
		try {
			const before = s.text();
			const r = await refusal(() => arrange(s, { moves: [], order: {}, folders: { '': [{ id: 'company', name: 'Company', pages: ['about'] }] } }));
			assert.equal(r.status, 422);
			assert.equal(r.message, MISSHAPEN_FOLDERS_MESSAGE);
			assert.equal(s.text(), before);
			// A move taking a filed page out of its level changes folders too.
			const m = await refusal(() => arrange(s, { moves: [{ collection: 'pages', fromPath: 'contact', toPath: 'services/contact' }], order: {} }));
			assert.equal(m.status, 422);
			assert.equal(s.text(), before);
		} finally {
			s.cleanup();
		}
	});
	test('an Apply reordering the bad level is refused; one reordering another level writes the order alone', async () => {
		const s = makeSite(settings(BROKEN));
		try {
			const before = s.text();
			const r = await refusal(() => arrange(s, { moves: [], order: { services: ['websites', 'branding'] } }));
			assert.equal(r.status, 422);
			assert.equal(s.text(), before);
			await arrange(s, { moves: [], order: { '': ['privacy', '(company)'] } });
			keepsBrokenLevel(s);
			assert.deepEqual(s.saved().pageOrder?.[''], ['privacy', '(company)']);
			assert.deepEqual(s.saved().pageFolders?.[''], BROKEN.pageFolders['']);
		} finally {
			s.cleanup();
		}
	});
	test('the whole value wrong: tokens stay through a reorder elsewhere', async () => {
		const whole = { pageOrder: { '': ['(company)', 'privacy'], services: ['websites'] }, pageFolders: 'nope' };
		const s = makeSite(settings(whole));
		try {
			await arrange(s, { moves: [], order: { services: ['branding', 'websites'] } });
			const saved = s.saved();
			assert.equal(saved.pageFolders, 'nope');
			assert.deepEqual(saved.pageOrder, { '': ['(company)', 'privacy'], services: ['branding', 'websites'] });
		} finally {
			s.cleanup();
		}
	});
});
