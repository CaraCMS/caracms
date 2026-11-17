// Arrange pages, the server half, without a browser:
// - page-order.ts: the tree's order rule (checks 2, 4), the re-keying after moves (Decision 6),
//   the Apply's merge, the stamp;
// - the listing follows Site Settings' `pageOrder` (check 2 on the demo fixture, check 4);
// - POST /_caracms/arrange in local mode: order only (check 3), a group rename (checks 6, 7),
//   a page merged into a group (check 9), a holder (check 10), a swap (check 11), the plan
//   checked again (check 12), nested roots;
// - Change address… keeps the order current, Delete… doesn't touch it (check 15); `pageOrder`
//   is a reserved key (check 21); validate warns and --fix prunes;
// - live mode: locks (check 13), a failure part way (check 14), the order stamp (check 15a),
//   a redirect only for an address that was live (check 7).
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { link, resolveSite, richText, SITE_SETTINGS_FILE, text, type ResolvedSite, type SiteConfig } from '../src/config.ts';
import { listDocuments } from '../src/content.ts';
import { handleArrange } from '../src/editor/server/arrange.ts';
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
import { arrangedOrder, listingStamp, orderAfterMoves, orderSiblings, pageOrderStamp, prunedOrder, unknownOrderEntries } from '../src/page-order.ts';
import { parseRedirects } from '../src/redirects.ts';
import { makeCliSite } from './helpers/cli-site.ts';
import { demoContent } from './helpers/dev-site.ts';
import { config, display, fixtures, siteRoot } from './helpers/site.ts';

const ORIGIN = 'http://site.test';
const aoife: Person = { email: 'aoife@example.com', name: 'Aoife' };
const ciaran: Person = { email: 'ciaran@example.com', name: 'Ciarán' };
const TAB_A = 'tab-aoife-1';
const TAB_A2 = 'tab-aoife-2';
const TAB_C = 'tab-ciaran-1';

function request(path: string, init: { tab?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
	const headers: Record<string, string> = { origin: ORIGIN, ...(init.headers ?? {}) };
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

const page = (title: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ title, ...extra, blocks: [] }, null, 2)}\n`;
const SETTINGS = '{\n  "title": "Site Settings",\n  "editors": []\n}\n';
const FILES: Record<string, string> = {
	'content/pages/index.json': `${JSON.stringify(
		{ title: 'Home', blocks: [{ type: 'links', link: { label: 'Branding', href: '/services/branding' }, body: [{ p: 'Meet [the team](/about/team) and [the journal](/journal/first-post).' }] }] },
		null,
		2,
	)}\n`,
	'content/pages/about.json': page('About'),
	'content/pages/about/team.json': page('Team'),
	'content/pages/contact.json': page('Contact'),
	'content/pages/offerings.json': page('Offerings'),
	'content/pages/services/branding.json': page('Branding'),
	'content/pages/services/websites.json': page('Websites'),
	'content/pages/studio/visit.json': page('Visit'),
	'content/pages/journal.json': page('Journal', { holds: 'journal' }),
	'content/journal/first-post.json': page('First post'),
	'content/journal/second-post.json': page('Second post'),
	[SITE_SETTINGS_FILE]: SETTINGS,
};

const siteConfig = (extra: Partial<SiteConfig> = {}): SiteConfig =>
	({
		...(config as SiteConfig),
		collections: {
			pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
			journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages' },
		},
		blocks: { ...(config as SiteConfig).blocks, links: { component: 'Block.astro', fields: { link: link(), body: richText() } } },
		textStyles: { display: { ...display, fontFile: { measure: join(fixtures, 'fonts/BricolageGrotesque.ttf'), web: join(fixtures, 'fonts/BricolageGrotesque.ttf') } } },
		...extra,
	}) as SiteConfig;

interface TestSite {
	root: string;
	site: ResolvedSite;
	read(file: string): string;
	write(file: string, text: string): void;
	exists(file: string): boolean;
	/** Every content file and its text. */
	snapshot(): Map<string, string>;
	cleanup(): void;
}

function makeSite(options: { files?: Record<string, string>; repoPath?: string } = {}): TestSite {
	const tmp = mkdtempSync(join(tmpdir(), 'caracms-arrange-'));
	const root = join(tmp, 'site');
	cpSync(siteRoot, root, { recursive: true });
	rmSync(join(root, 'content'), { recursive: true, force: true });
	const write = (file: string, text: string) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	};
	for (const [file, text] of Object.entries({ ...FILES, ...(options.files ?? {}) })) write(file, text);
	const site = resolveSite(siteConfig(options.repoPath ? { repoPath: options.repoPath } : {}), root);
	const snapshot = () => {
		const out = new Map<string, string>();
		const walk = (dir: string) => {
			for (const name of readdirSync(join(root, dir))) {
				const rel = `${dir}/${name}`;
				if (statSync(join(root, rel)).isDirectory()) walk(rel);
				else out.set(rel, readFileSync(join(root, rel), 'utf8'));
			}
		};
		walk('content');
		return out;
	};
	return { root, site, read: (f) => readFileSync(join(root, f), 'utf8'), write, exists: (f) => existsSync(join(root, f)), snapshot, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

const settingsOf = (text: string) => JSON.parse(text) as { pageOrder?: Record<string, string[]>; redirects?: unknown };
const tree = async (site: ResolvedSite, source?: Parameters<typeof listDocuments>[2]) => (await listDocuments(site, 'pages', source)).map((d) => d.path);
const top = async (site: ResolvedSite) => {
	const seen: string[] = [];
	for (const p of await tree(site)) {
		const first = p.split('/')[0]!;
		if (!seen.includes(first)) seen.push(first);
	}
	return seen;
};

function local(files?: Record<string, string>) {
	const s = makeSite({ files });
	const store = localDraftsStore(s.site);
	const arrange = (body: unknown) => call<Answer>(handleArrange(request('/_caracms/arrange', { body }), store));
	const move = (body: Record<string, unknown>) => call<MoveResponse & CreateDeleteRefusal>(handleMove(request('/_caracms/move', { body }), store));
	return { s, store, arrange, move };
}
const root = (fromPath: string, toPath: string) => ({ collection: 'pages', fromPath, toPath });

// ── page-order.ts ───────────────────────────────────────────────────────────

describe('the order rule (Decision 7; checks 2, 4)', () => {
	const items = [
		{ path: 'contact', label: 'Contact', filled: false },
		{ path: 'services', label: 'Services', filled: true },
		{ path: 'index', label: 'Home', filled: false },
		{ path: 'about', label: 'About', filled: true },
		{ path: 'privacy', label: 'Privacy', filled: false },
		{ path: 'field-notes', label: 'Field notes', filled: false },
	];
	const order = (saved?: string[]) => orderSiblings(items, saved, (i) => i.filled).map((i) => i.path);
	test('nothing saved: Home, then what has pages under it A–Z, then the rest A–Z', () => {
		assert.deepEqual(order(), ['index', 'about', 'services', 'contact', 'field-notes', 'privacy']);
	});
	test('a saved list: Home still first, the listed ones in its order, the rest by the rule; unknown slugs ignored', () => {
		assert.deepEqual(order(['privacy', 'gone', 'services', 'index']), ['index', 'privacy', 'services', 'about', 'contact', 'field-notes']);
	});
});

describe('the saved order after moves (Decision 6)', () => {
	test('a page moved under another parent leaves its list and goes at the end of the new one; its own key is re-keyed at any depth', () => {
		const order = { '': ['contact', 'about', 'services'], about: ['team'], 'about/team': ['x'], company: ['one'] };
		const after = orderAfterMoves(order, [{ from: 'about', to: 'company/about' }, { from: 'about/team', to: 'company/about/team' }, { from: 'about/team/x', to: 'company/about/team/x' }], ['about', 'about/team', 'about/team/x', 'company/one', 'contact']);
		assert.deepEqual(after, { '': ['contact', 'services'], 'company/about': ['team'], 'company/about/team': ['x'], company: ['one', 'about'] });
	});
	test('a new parent with no saved list gets none (the rule places it); an emptied list is dropped', () => {
		const after = orderAfterMoves({ '': ['studio', 'about'], studio: ['visit'] }, [{ from: 'studio/visit', to: 'about/visit' }], ['about', 'studio/visit']);
		assert.deepEqual(after, { '': ['studio', 'about'] });
	});
	test('a group rename changes its key and its slug in place', () => {
		const after = orderAfterMoves({ '': ['contact', 'services', 'about'], services: ['websites', 'branding'] }, [{ from: 'services/branding', to: 'expertise/branding' }, { from: 'services/websites', to: 'expertise/websites' }], ['about', 'contact', 'services/branding', 'services/websites']);
		assert.deepEqual(after, { '': ['contact', 'expertise', 'about'], expertise: ['websites', 'branding'] });
	});
	test('a swap: group services → offerings while the page offerings moves under About (check 11)', () => {
		const after = orderAfterMoves(
			{ '': ['offerings', 'services', 'about'], services: ['websites', 'branding'], about: ['team'] },
			[{ from: 'services/branding', to: 'offerings/branding' }, { from: 'services/websites', to: 'offerings/websites' }, { from: 'offerings', to: 'about/offerings' }],
			['about', 'about/team', 'offerings', 'services/branding', 'services/websites'],
		);
		assert.deepEqual(after, { '': ['offerings', 'about'], offerings: ['websites', 'branding'], about: ['team', 'offerings'] });
	});
	test("the Apply's merge: the request's lists replace theirs, the rest re-keyed, empty lists dropped", () => {
		const merged = arrangedOrder({ '': ['about', 'contact'], about: ['team'], studio: ['visit'] }, { '': ['contact', 'company'], company: ['about'], studio: [] }, [{ from: 'about', to: 'company/about' }, { from: 'about/team', to: 'company/about/team' }], ['about', 'about/team', 'contact', 'studio/visit']);
		assert.deepEqual(merged, { '': ['contact', 'company'], 'company/about': ['team'], company: ['about'] });
	});
	test('unknown entries are found and pruned; the stamp follows the order', () => {
		const order = { '': ['about', 'gone'], nowhere: ['x'], about: ['team'] };
		assert.deepEqual(unknownOrderEntries(order, ['index', 'about', 'about/team']), [{ key: '', slug: 'gone' }, { key: 'nowhere', slug: null }]);
		assert.deepEqual(prunedOrder(order, ['index', 'about', 'about/team']), { order: { '': ['about'], about: ['team'] }, pruned: 2 });
		assert.equal(pageOrderStamp({}), '');
		assert.equal(pageOrderStamp(undefined), '');
		assert.notEqual(pageOrderStamp({ '': ['a', 'b'] }), pageOrderStamp({ '': ['b', 'a'] }));
		assert.equal(pageOrderStamp({ a: ['x'], '': ['b'] }), pageOrderStamp({ '': ['b'], a: ['x'] }));
		assert.equal(listingStamp(['b', 'a']), listingStamp(['a', 'b']), 'the listing stamp ignores order');
		assert.notEqual(listingStamp(['a', 'b']), listingStamp(['a', 'b', 'c']));
	});
});

// ── The listing ─────────────────────────────────────────────────────────────

describe('the listing follows the saved order (checks 2, 4)', () => {
	test('the demo fixture with nothing saved: Home, those with pages or a held collection under them, then the rest', async () => {
		const tmp = mkdtempSync(join(tmpdir(), 'caracms-arrange-demo-'));
		try {
			cpSync(siteRoot, tmp, { recursive: true });
			rmSync(join(tmp, 'content'), { recursive: true, force: true });
			cpSync(demoContent, join(tmp, 'content'), { recursive: true });
			const demo = resolveSite(
				{
					...siteConfig(),
					collections: {
						pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
						journal: { kind: 'sections', folder: 'content/journal', heldBy: 'pages' },
						'case-studies': { kind: 'fields', label: 'Case studies', folder: 'content/case-studies', heldBy: 'pages', component: 'Block.astro', fields: { client: text() } },
					},
				} as SiteConfig,
				tmp,
			);
			assert.deepEqual(await top(demo), ['index', 'about', 'journal', 'services', 'work', 'contact', 'visit']);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
	test('this site with nothing saved, then with a saved order naming some siblings', async () => {
		const s = makeSite();
		try {
			assert.deepEqual(await top(s.site), ['index', 'about', 'journal', 'services', 'studio', 'contact', 'offerings']);
			s.write(SITE_SETTINGS_FILE, '{\n  "title": "Site Settings",\n  "editors": [],\n  "pageOrder": { "": ["contact", "gone", "studio"], "services": ["websites"] }\n}\n');
			assert.deepEqual(await top(s.site), ['index', 'contact', 'studio', 'about', 'journal', 'services', 'offerings']);
			assert.deepEqual((await tree(s.site)).filter((p) => p.startsWith('services/')), ['services/websites', 'services/branding']);
		} finally {
			s.cleanup();
		}
	});
});

// ── The Apply, local mode ────────────────────────────────────────────────────

describe('local: POST /_caracms/arrange', () => {
	test('the listing keeps a page\'s own hidden flag apart from the one it has from a hidden page above (hiddenSelf)', async () => {
		const { s } = local({ 'content/pages/privacy.json': page('Privacy', { hidden: true }), 'content/pages/privacy/faq.json': page('Questions', { hidden: true }), 'content/pages/privacy/terms.json': page('Terms') });
		try {
			const listed = await listDocuments(s.site, 'pages');
			const of = (p: string) => listed.find((d) => d.path === p)!;
			assert.deepEqual([of('privacy').hidden, of('privacy').hiddenSelf, of('privacy').hiddenBy], [true, true, undefined]);
			assert.deepEqual([of('privacy/faq').hidden, of('privacy/faq').hiddenSelf, of('privacy/faq').hiddenBy], [true, true, 'privacy']);
			assert.deepEqual([of('privacy/terms').hidden, of('privacy/terms').hiddenSelf, of('privacy/terms').hiddenBy], [true, undefined, 'privacy']);
		} finally {
			s.cleanup();
		}
	});

	test('order only (check 3): writes pageOrder for that parent only, no other file, no redirect', async () => {
		const { s, arrange } = local();
		try {
			const before = s.snapshot();
			const r = await arrange({ moves: [], order: { '': ['journal', 'about'] } });
			assert.deepEqual(r, { status: 200, body: { ok: true } });
			const after = s.snapshot();
			for (const [file, text] of before) if (file !== SITE_SETTINGS_FILE) assert.equal(after.get(file), text, file);
			const settings = settingsOf(s.read(SITE_SETTINGS_FILE));
			assert.deepEqual(settings.pageOrder, { '': ['journal', 'about'] });
			assert.equal(settings.redirects, undefined);
			assert.deepEqual((await top(s.site)).slice(0, 3), ['index', 'journal', 'about']);
			// The same again changes nothing.
			const text = s.read(SITE_SETTINGS_FILE);
			assert.equal((await arrange({ moves: [], order: { '': ['journal', 'about'] } })).status, 200);
			assert.equal(s.read(SITE_SETTINGS_FILE), text);
		} finally {
			s.cleanup();
		}
	});

	test('a group rename (checks 6, 7): one move per page under it, every link rewritten, one redirect each with the tick, none without', async () => {
		for (const redirect of [true, false]) {
			const { s, arrange } = local({ [SITE_SETTINGS_FILE]: '{\n  "title": "Site Settings",\n  "editors": [],\n  "pageOrder": { "": ["services", "about"], "services": ["websites", "branding"] }\n}\n' });
			try {
				const r = await arrange({ moves: [root('services/branding', 'expertise/branding'), root('services/websites', 'expertise/websites')], order: { '': ['expertise', 'about'] }, ...(redirect ? {} : { redirect: false }) });
				assert.equal(r.status, 200, JSON.stringify(r.body));
				assert.ok(s.exists('content/pages/expertise/branding.json') && !s.exists('content/pages/services/branding.json'));
				assert.match(s.read('content/pages/index.json'), /"href": "\/expertise\/branding"/);
				const settings = settingsOf(s.read(SITE_SETTINGS_FILE));
				assert.deepEqual(settings.pageOrder, { '': ['expertise', 'about'], expertise: ['websites', 'branding'] }, 'the group\'s own list re-keyed');
				const redirects = parseRedirects(settings.redirects);
				assert.deepEqual(
					redirects.map((x) => `${x.from} → ${x.to}`),
					redirect ? ['/services/branding → /expertise/branding', '/services/websites → /expertise/websites'] : [],
				);
			} finally {
				s.cleanup();
			}
		}
	});

	test('a page dropped beside a group with its slug becomes that group\'s page (check 9)', async () => {
		const { s, arrange } = local();
		try {
			const r = await arrange({ moves: [root('contact', 'services')], order: { '': ['services', 'about'] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const listed = await listDocuments(s.site, 'pages');
			assert.equal(listed.find((d) => d.path === 'services')?.label, 'Contact');
			assert.deepEqual(listed.filter((d) => d.path.startsWith('services')).map((d) => d.path), ['services', 'services/branding', 'services/websites']);
			assert.deepEqual(settingsOf(s.read(SITE_SETTINGS_FILE)).pageOrder, { '': ['services', 'about'] });
		} finally {
			s.cleanup();
		}
	});

	test('a holder moves with its documents (check 10): their old addresses redirect', async () => {
		const { s, arrange } = local();
		try {
			const r = await arrange({ moves: [root('journal', 'about/journal')], order: { about: ['journal', 'team'] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const posts = (await listDocuments(s.site, 'journal')).map((d) => d.url);
			assert.deepEqual(posts.sort(), ['/about/journal/first-post', '/about/journal/second-post']);
			const redirects = parseRedirects(settingsOf(s.read(SITE_SETTINGS_FILE)).redirects).map((x) => `${x.from} → ${x.to}`);
			for (const x of ['/journal → /about/journal', '/journal/first-post → /about/journal/first-post', '/journal/second-post → /about/journal/second-post']) assert.ok(redirects.includes(x), x);
			assert.match(s.read('content/pages/index.json'), /\(\/about\/journal\/first-post\)/);
			assert.deepEqual(settingsOf(s.read(SITE_SETTINGS_FILE)).pageOrder, { about: ['journal', 'team'] });
		} finally {
			s.cleanup();
		}
	});

	test('a swap within one Apply (check 11): group services → offerings while the page offerings moves under About', async () => {
		// offerings/branding is taken by the page Offerings' own child, so the rename only works if Offerings leaves in the same Apply.
		const files = { 'content/pages/offerings/branding.json': page('Offerings branding') };
		const rename = [root('services/branding', 'offerings/branding'), root('services/websites', 'offerings/websites')];
		{
			// Checked one move at a time, the rename is refused: /offerings/branding is taken.
			const { s, arrange, move } = local(files);
			try {
				const alone = await move({ collection: 'pages', path: 'services/branding', to: 'offerings/branding' });
				assert.equal(alone.status, 409, JSON.stringify(alone.body));
				assert.equal(alone.body.code, 'address-taken');
				const renameOnly = await arrange({ moves: rename, order: {} });
				assert.equal(renameOnly.status, 409, JSON.stringify(renameOnly.body));
				assert.equal(renameOnly.body.code, 'address-taken');
				assert.ok(s.exists('content/pages/services/branding.json') && s.exists('content/pages/offerings/branding.json'), 'nothing moved');
			} finally {
				s.cleanup();
			}
		}
		const { s, arrange } = local(files);
		try {
			const r = await arrange({ moves: [...rename, root('offerings', 'about/offerings')], order: { '': ['offerings', 'about'], about: ['team', 'offerings'] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.ok(s.exists('content/pages/about/offerings.json') && s.exists('content/pages/about/offerings/branding.json'), 'Offerings moved with its page under it');
			assert.ok(s.exists('content/pages/offerings/branding.json') && s.exists('content/pages/offerings/websites.json') && !s.exists('content/pages/offerings.json'), 'the group renamed into the address it left');
			assert.equal(JSON.parse(s.read('content/pages/offerings/branding.json')).title, 'Branding');
			assert.deepEqual(settingsOf(s.read(SITE_SETTINGS_FILE)).pageOrder, { '': ['offerings', 'about'], about: ['team', 'offerings'] });
		} finally {
			s.cleanup();
		}
	});

	test('order only, Site Settings not valid JSON: refused with a sentence, nothing written', async () => {
		const { s, arrange } = local({ [SITE_SETTINGS_FILE]: '{ "title": "Site Settings", ' });
		try {
			const before = s.snapshot();
			const r = await arrange({ moves: [], order: { '': ['journal', 'about'] } });
			assert.equal(r.status, 422, JSON.stringify(r.body));
			assert.equal(r.body.code, 'invalid-json');
			assert.match(r.body.error ?? '', /Site Settings isn't valid JSON, so the new order can't be saved/);
			assert.deepEqual(s.snapshot(), before);
		} finally {
			s.cleanup();
		}
	});

	test('with moves, Site Settings not valid JSON: refused too, nothing moved', async () => {
		const { s, arrange } = local({ [SITE_SETTINGS_FILE]: '{ "title": "Site Settings", ' });
		try {
			const before = s.snapshot();
			const r = await arrange({ moves: [{ collection: 'pages', fromPath: 'about', toPath: 'who' }], order: {} });
			assert.equal(r.status, 422, JSON.stringify(r.body));
			assert.equal(r.body.code, 'invalid-json');
			assert.deepEqual(s.snapshot(), before);
		} finally {
			s.cleanup();
		}
	});

	test('nested roots: About → company/about and Team, under it, → contact/team; an inner root wins for its own subtree', async () => {
		const { s, arrange } = local({ 'content/pages/about/team/bios.json': page('Bios'), 'content/pages/about/history.json': page('History') });
		try {
			const r = await arrange({ moves: [root('about', 'company/about'), root('about/team', 'contact/team')], order: { '': ['company', 'contact'], company: ['about'], contact: ['team'], 'company/about': ['history'] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const paths = await tree(s.site);
			for (const p of ['company/about', 'company/about/history', 'contact/team', 'contact/team/bios']) assert.ok(paths.includes(p), `${p} in ${paths.join(', ')}`);
			assert.ok(!paths.some((p) => p.startsWith('about') || p === 'company/about/team'), paths.join(', '));
			assert.match(s.read('content/pages/index.json'), /\(\/contact\/team\)/);
		} finally {
			s.cleanup();
		}
	});

	test('an empty list drops its key (a parent left with no children)', async () => {
		const { s, arrange } = local({ [SITE_SETTINGS_FILE]: '{\n  "title": "Site Settings",\n  "editors": [],\n  "pageOrder": { "about": ["team"] }\n}\n' });
		try {
			const r = await arrange({ moves: [root('about/team', 'team')], order: { '': ['team', 'about'], about: [] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(settingsOf(s.read(SITE_SETTINGS_FILE)).pageOrder, { '': ['team', 'about'] });
		} finally {
			s.cleanup();
		}
	});

	const stampOf = async (site: ResolvedSite, collection: string) => listingStamp((await listDocuments(site, collection)).map((d) => d.path));
	test('the plan is checked again at Apply (check 12): nothing is applied when it no longer fits', async () => {
		const plan = { moves: [root('about', 'company/about')], order: { '': ['company', 'contact'], company: ['about'] } };
		// A page made at a target address since the review.
		{
			const { s, arrange } = local({ 'content/pages/company/about.json': page('Someone else\'s About') });
			try {
				const before = s.snapshot();
				const r = await arrange(plan);
				assert.equal(r.status, 409, JSON.stringify(r.body));
				assert.equal(r.body.code, 'address-taken');
				assert.deepEqual(s.snapshot(), before);
			} finally {
				s.cleanup();
			}
		}
		// A page in the plan deleted since.
		{
			const { s, arrange } = local();
			try {
				rmSync(join(s.root, 'content/pages/about.json'));
				const before = s.snapshot();
				const r = await arrange(plan);
				assert.equal(r.status, 404, JSON.stringify(r.body));
				assert.equal(r.body.code, 'not-found');
				assert.deepEqual(s.snapshot(), before);
			} finally {
				s.cleanup();
			}
		}
		// An order entry that names a page that's gone.
		{
			const { s, arrange } = local();
			try {
				rmSync(join(s.root, 'content/pages/contact.json'));
				const before = s.snapshot();
				const r = await arrange(plan);
				assert.deepEqual(r, { status: 404, body: { error: "There's no page or group at /contact any more.", code: 'not-found' } });
				assert.deepEqual(s.snapshot(), before);
			} finally {
				s.cleanup();
			}
		}
		// A post added under a moved holder since the review: the listing changed, so nothing is applied.
		{
			const { s, arrange } = local();
			try {
				const expect = { pages: await stampOf(s.site, 'pages'), journal: await stampOf(s.site, 'journal') };
				s.write('content/journal/third-post.json', page('Third post'));
				const before = s.snapshot();
				const r = await arrange({ moves: [root('journal', 'about/journal')], order: {}, expect });
				assert.deepEqual(r, { status: 409, body: { error: 'The pages changed since you opened the review.', code: 'changed' } });
				assert.deepEqual(s.snapshot(), before);
			} finally {
				s.cleanup();
			}
		}
		// A page added inside a group being renamed since the review: it would be left behind, so nothing is applied.
		{
			const { s, arrange } = local();
			try {
				const expect = { pages: await stampOf(s.site, 'pages') };
				s.write('content/pages/services/print.json', page('Print'));
				const before = s.snapshot();
				const r = await arrange({ moves: [root('services/branding', 'expertise/branding'), root('services/websites', 'expertise/websites')], order: { '': ['expertise'] }, expect });
				assert.equal(r.status, 409, JSON.stringify(r.body));
				assert.equal(r.body.code, 'changed');
				assert.deepEqual(s.snapshot(), before);
			} finally {
				s.cleanup();
			}
		}
		// The same Apply with the listing as it was planned on lands; without `expect` there's no check.
		{
			const { s, arrange } = local();
			try {
				const expect = { pages: await stampOf(s.site, 'pages'), journal: await stampOf(s.site, 'journal') };
				const r = await arrange({ moves: [root('journal', 'about/journal')], order: {}, expect });
				assert.equal(r.status, 200, JSON.stringify(r.body));
				const again = await arrange({ moves: [root('about/journal', 'journal')], order: {} });
				assert.equal(again.status, 200, JSON.stringify(again.body));
			} finally {
				s.cleanup();
			}
		}
	});

	test('malformed bodies are refused before anything is read', async () => {
		const { s, arrange } = local();
		try {
			for (const body of [[], { moves: [] }, { moves: {}, order: {} }, { moves: [{ collection: 'pages', fromPath: 'about' }], order: {} }, { moves: [], order: { '': 'about' } }, { moves: [], order: {}, extra: 1 }, { moves: [], order: {}, redirect: 'no' }, { moves: [], order: {}, expect: { pages: 1 } }, { moves: [], order: {}, expect: [] }]) {
				const r = await arrange(body);
				assert.equal(r.status, 400, JSON.stringify(body));
				assert.equal(r.body.code, 'bad-request');
			}
			const out = await arrange({ moves: [root('../outside', 'x')], order: {} });
			assert.equal(out.status, 400);
			assert.equal(out.body.code, 'bad-path');
			const wrong = await call(handleArrange(new Request(`${ORIGIN}/_caracms/arrange`, { method: 'POST', headers: { origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{"moves":[],"order":{}}' }), localDraftsStore(s.site)));
			assert.equal(wrong.status, 403);
		} finally {
			s.cleanup();
		}
	});
});

// ── Change address…, Delete…, the config, validate ──────────────────────────

describe('Change address… and Delete… (check 15)', () => {
	test('Change address… moves the slug to the new parent\'s list and re-keys every list under it, in the redirects\' write; Delete… leaves the order alone', async () => {
		const { s, move, store } = local({ [SITE_SETTINGS_FILE]: '{\n  "title": "Site Settings",\n  "editors": [],\n  "pageOrder": { "": ["contact", "about", "studio"], "about": ["team"], "studio": ["visit"] }\n}\n' });
		try {
			const r = await move({ collection: 'pages', path: 'about', to: 'studio/about' });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const settings = settingsOf(s.read(SITE_SETTINGS_FILE));
			assert.deepEqual(settings.pageOrder, { '': ['contact', 'studio'], 'studio/about': ['team'], studio: ['visit', 'about'] });
			assert.equal(parseRedirects(settings.redirects).length, 2, 'the same write carries the redirects');
			const text = s.read(SITE_SETTINGS_FILE);
			await store.delete({ collection: 'pages', path: 'studio/about' });
			assert.equal(s.read(SITE_SETTINGS_FILE), text, 'Delete… never writes Site Settings');
			assert.deepEqual((await tree(s.site)).filter((p) => p.startsWith('studio')), ['studio/visit', 'studio/about/team'], 'the deleted page\'s children keep its place as a group');
		} finally {
			s.cleanup();
		}
	});
	test('with nothing saved, Change address… adds no pageOrder', async () => {
		const { s, move } = local();
		try {
			assert.equal((await move({ collection: 'pages', path: 'contact', to: 'about/contact' })).status, 200);
			assert.equal(settingsOf(s.read(SITE_SETTINGS_FILE)).pageOrder, undefined);
		} finally {
			s.cleanup();
		}
	});
});

describe('pageOrder is reserved (check 21)', () => {
	test('a site field named pageOrder is refused with the reserved-keys sentence', () => {
		assert.throws(() => resolveSite(siteConfig({ settings: { fields: { pageOrder: text() } } } as Partial<SiteConfig>), siteRoot), /settings: "pageOrder" is one of Site Settings' own keys \(title, editors, brand, seo, googleTag, formRecipients, redirects, pageOrder, pageFolders, collectionOrder, formWords\); name the field something else\./);
	});
});

describe('caracms validate (check 15)', () => {
	test('warns on an entry naming nothing; --fix prunes them and says how many', () => {
		const cli = makeCliSite('arrange');
		try {
			const settings = JSON.parse(cli.read(SITE_SETTINGS_FILE)) as Record<string, unknown>;
			settings.pageOrder = { '': ['contact', 'gone', 'about'], nowhere: ['x', 'y'] };
			cli.write(SITE_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
			const warned = cli.run('validate');
			assert.match(warned.stdout, /content\/site-settings\.json › pageOrder\[""\]: The Pages tree's order names "gone" in the top level/);
			assert.match(warned.stdout, /pageOrder\["nowhere"\]: The Pages tree's order names \/nowhere, where there are no pages/);
			const fixed = cli.run('validate', '--fix');
			assert.match(fixed.stdout, /pruned 3 page-order entries/);
			assert.deepEqual((JSON.parse(cli.read(SITE_SETTINGS_FILE)) as Record<string, unknown>).pageOrder, { '': ['contact', 'about'] });
			assert.doesNotMatch(cli.run('validate').stdout, /page-order|pageOrder/);
		} finally {
			cli.cleanup();
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
	s: TestSite;
}

async function world(files?: Record<string, string>): Promise<World> {
	const s = makeSite({ repoPath: 'starter', files });
	const clock = { t: Date.parse('2026-10-25T10:00:00Z') };
	const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
	backend.seed([...(await siteFiles(s.site)), { path: 'starter/src/Page.astro', contents: 'page\n' }]);
	const rt = await createLiveRuntime({ site: s.site, settings, backend, redis: memoryRedis({ now: () => clock.t }), now: () => clock.t, log: () => {}, runningCommit: () => null });
	const ed = await createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	return { clock, backend, ed, s };
}
const arrangeLive = (w: World, body: unknown, tab = TAB_A, person = aoife) => call<Answer>(handleArrange(request('/_caracms/arrange', { tab, body }), w.ed.store, { person }));
const poll = async (w: World, person: Person, tab: string) => (await call<StatusResponse>(w.ed.status(request('/_caracms/status', { tab }), person))).body;
async function type(w: World, collection: string, path: string, person: Person, tab: string, edit: (d: Record<string, unknown>) => void, release = false) {
	const opened = await w.ed.store.read(collection, path);
	const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
	edit(document);
	return call(w.ed.write(request('/_caracms/write', { tab, body: { file: opened.entry.file, base: opened.text, document }, ...(release ? { headers: { 'x-caracms-release': '1' } } : {}) }), person));
}
const settingsNow = async (w: World) => settingsOf((await w.ed.store.read('settings', 'site-settings')).text);

describe('live: POST /_caracms/arrange', () => {
	test('order only: Site Settings as one autosave, its lock let go, and the stamp changes for another tab (checks 3, 15a)', async () => {
		const w = await world();
		try {
			// Site Settings already waits with a change (this tab's own, its lock still held).
			assert.equal((await type(w, 'settings', 'site-settings', aoife, TAB_A, (d) => (d.title = 'CaraCMS settings'))).status, 200);
			const before = await poll(w, ciaran, TAB_C);
			assert.equal(before.pageOrderStamp, '');
			assert.ok(before.waiting.some((x) => x.file === SITE_SETTINGS_FILE));
			const r = await arrangeLive(w, { moves: [], order: { '': ['journal', 'about'] } });
			assert.deepEqual(r, { status: 200, body: { ok: true } });
			const now = await settingsNow(w);
			assert.deepEqual(now.pageOrder, { '': ['journal', 'about'] });
			assert.equal((JSON.parse((await w.ed.store.read('settings', 'site-settings')).text) as { title: string }).title, 'CaraCMS settings', 'their change kept');
			const after = await poll(w, ciaran, TAB_C);
			assert.equal(after.pageOrderStamp, pageOrderStamp({ '': ['journal', 'about'] }));
			assert.notEqual(after.pageOrderStamp, before.pageOrderStamp);
			assert.deepEqual(after.waiting.map((x) => x.file).sort(), before.waiting.map((x) => x.file).sort(), 'the waiting list\'s keys are the same: only the stamp tells');
			assert.ok(after.locks.every((l) => l.file === SITE_SETTINGS_FILE && l.person.email === aoife.email), 'only the lock the tab already had');
			const listed = (await w.ed.store.list()).filter((d) => d.collection === 'pages').map((d) => d.path);
			assert.deepEqual(listed.slice(0, 3), ['index', 'journal', 'about']);
		} finally {
			w.s.cleanup();
		}
	});

	test('order only, Site Settings not valid JSON: refused with a sentence, no lock kept', async () => {
		const w = await world({ [SITE_SETTINGS_FILE]: '{ "title": "Site Settings", ' });
		try {
			const r = await arrangeLive(w, { moves: [], order: { '': ['journal', 'about'] } });
			assert.equal(r.status, 422, JSON.stringify(r.body));
			assert.equal(r.body.code, 'invalid-json');
			assert.match(r.body.error ?? '', /Site Settings isn't valid JSON/);
			const after = await poll(w, ciaran, TAB_C);
			assert.ok(after.locks.every((l) => l.releasing), `its lock let go (${JSON.stringify(after.locks)})`);
			assert.equal(after.pageOrderStamp, '');
		} finally {
			w.s.cleanup();
		}
	});

	test('someone else\'s lock on Site Settings refuses an order-only Apply, naming them; your own in another tab moves here (check 13)', async () => {
		const w = await world();
		try {
			assert.equal((await type(w, 'settings', 'site-settings', ciaran, TAB_C, (d) => (d.title = 'Mine'))).status, 200);
			const r = await arrangeLive(w, { moves: [], order: { '': ['journal'] } });
			assert.equal(r.status, 409, JSON.stringify(r.body));
			assert.equal(r.body.code, 'locked');
			assert.equal(r.body.error, "Ciarán is editing Site Settings, which holds the order of the Pages tree, so the order can't change until they're done.");
			assert.equal((await settingsNow(w)).pageOrder, undefined);
		} finally {
			w.s.cleanup();
		}
		const v = await world();
		try {
			assert.equal((await type(v, 'settings', 'site-settings', aoife, TAB_A2, (d) => (d.title = 'Mine'))).status, 200);
			const r = await arrangeLive(v, { moves: [], order: { '': ['journal'] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual((await settingsNow(v)).pageOrder, { '': ['journal'] });
		} finally {
			v.s.cleanup();
		}
	});

	test('someone else\'s lock on a page that moves refuses the whole Apply, naming them and the page, and nothing is written (check 13)', async () => {
		const w = await world();
		try {
			assert.equal((await type(w, 'pages', 'services/websites', ciaran, TAB_C, (d) => (d.title = 'Web'))).status, 200);
			const r = await arrangeLive(w, { moves: [root('services/branding', 'expertise/branding'), root('services/websites', 'expertise/websites')], order: { '': ['expertise'] } });
			assert.equal(r.status, 409, JSON.stringify(r.body));
			assert.equal(r.body.code, 'locked');
			assert.match(r.body.error!, /^Ciarán is editing Web/);
			assert.equal(await w.ed.autosaves.get('content/pages/expertise/branding.json'), null);
			assert.equal(await w.ed.autosaves.get(SITE_SETTINGS_FILE), null);
			w.clock.t += 6_000;
			assert.deepEqual((await poll(w, aoife, TAB_A)).locks.filter((l) => l.person.email === aoife.email), []);
		} finally {
			w.s.cleanup();
		}
	});

	test('moves and order land together; a redirect only for an address that was live (check 7); no lock kept', async () => {
		const w = await world();
		try {
			// A page made since the last Publish: never live.
			const made = await call(w.ed.store.create({ collection: 'pages', path: 'services/print', title: 'Print' }, { person: aoife, tab: TAB_A, release: false, seq: null }).then((x) => new Response(JSON.stringify(x))));
			assert.equal(made.status, 200);
			await call(w.ed.lock(request('/_caracms/lock', { tab: TAB_A, body: { file: 'content/pages/services/print.json', action: 'release' } }), aoife));
			const r = await arrangeLive(w, { moves: [root('services/branding', 'expertise/branding'), root('services/print', 'expertise/print'), root('services/websites', 'expertise/websites')], order: { '': ['expertise', 'about'] } });
			assert.equal(r.status, 200, JSON.stringify(r.body));
			const now = await settingsNow(w);
			assert.deepEqual(now.pageOrder, { '': ['expertise', 'about'] });
			assert.deepEqual(parseRedirects(now.redirects).map((x) => x.from).sort(), ['/services/branding', '/services/websites']);
			const held = (await poll(w, aoife, TAB_A)).locks.filter((l) => l.person.email === aoife.email);
			assert.ok(held.length > 0 && held.every((l) => l.releasing), `the Apply keeps no lock: each goes once committed (${JSON.stringify(held)})`);
		} finally {
			w.s.cleanup();
		}
	});

	test('a page made since the review (an autosave, not yet committed) refuses with changed (check 12)', async () => {
		const w = await world();
		try {
			const expect = { pages: listingStamp((await w.ed.store.list()).filter((d) => d.collection === 'pages').map((d) => d.path)) };
			assert.equal((await w.ed.store.create({ collection: 'pages', path: 'services/print', title: 'Print' }, { person: ciaran, tab: TAB_C, release: false, seq: null })).ok, true);
			const r = await arrangeLive(w, { moves: [root('services/branding', 'expertise/branding'), root('services/websites', 'expertise/websites')], order: { '': ['expertise'] }, expect });
			assert.equal(r.status, 409, JSON.stringify(r.body));
			assert.deepEqual([r.body.code, r.body.error], ['changed', 'The pages changed since you opened the review.']);
			assert.equal(await w.ed.autosaves.get('content/pages/expertise/branding.json'), null);
			assert.equal(await w.ed.autosaves.get(SITE_SETTINGS_FILE), null);
		} finally {
			w.s.cleanup();
		}
	});

	test('a failure part way puts every autosave back and releases every lock (check 14)', async () => {
		const w = await world();
		try {
			const putIf = w.ed.autosaves.putIf.bind(w.ed.autosaves);
			let writes = 0;
			w.ed.autosaves.putIf = async (read, autosave) => {
				if (++writes === 3) throw new Error('the store went away');
				return putIf(read, autosave);
			};
			const body = { moves: [root('about', 'company/about'), root('contact', 'company/contact')], order: { '': ['company'], company: ['about', 'contact'] } };
			const r = await arrangeLive(w, body);
			w.ed.autosaves.putIf = putIf;
			assert.equal(r.status, 500, JSON.stringify(r.body));
			for (const file of ['content/pages/company/about.json', 'content/pages/company/about/team.json', 'content/pages/company/contact.json', 'content/pages/about.json', 'content/pages/contact.json', 'content/pages/index.json', SITE_SETTINGS_FILE]) {
				assert.equal(await w.ed.autosaves.get(file), null, file);
			}
			w.clock.t += 6_000;
			assert.deepEqual((await poll(w, ciaran, TAB_C)).locks, []);
			assert.equal((await arrangeLive(w, body)).status, 200, 'a retry lands');
			assert.deepEqual((await settingsNow(w)).pageOrder, { '': ['company'], company: ['about', 'contact'] });
		} finally {
			w.s.cleanup();
		}
	});
});
