/**
 * The visual pass's check (M3 Phase 5 → Verify 1; M4 Phase 5 → Verify 1): every M3
 * state of the mockup (packages/caracms/test/mockups/m2-editor.html) against /admin in the same state,
 * every M4 state against /admin in live mode (mockup-diff-m4.ts, with its own
 * accepted differences), every M5a state (mockup-diff-m5a.ts, M5a Phase 6; most
 * in local mode, some live), every M5b state (mockup-diff-m5b.ts, M5b Phase 5: media,
 * on the in-memory bucket and Mux), every M6 state (mockup-diff-m6.ts: the inbox, Search and
 * sharing, Site Settings' M6 fields, on the in-memory submissions store), and every RT state (mockup-diff-rt.ts, on-page rich text
 * Phase 4: the formatting bar and link popover on the page), compared by the computed
 * styles of corresponding elements, not by eye.
 *
 *   node --experimental-strip-types packages/caracms/test/mockup-diff.ts            every state
 *   node --experimental-strip-types packages/caracms/test/mockup-diff.ts home docs  some states
 *   … --m3, --m4, --m5a, --m5b, --m6, --rt, --ap  only M3's (local mode), M4's (live mode), M5a's, M5b's, M6's, RT's or arrange pages'
 *   … --all     also print the differences explained below, with their reasons
 *   … --unused  also list the accepted differences nothing matched (to prune them)
 *
 * How: the mockup is served from packages/caracms/test/mockups on a free port (its Google Fonts are
 * answered with the package's own font files, so it runs offline); /admin runs on a
 * throwaway copy of the demo (helpers/dev-site.ts). Both at 1440 × 900, reduced
 * motion (so nothing is caught mid-animation). For each state, each root (the pane,
 * the bar, the popovers, the toast, the stage, the narrow note, the overlays in the
 * preview on screen) is snapshotted (helpers/style-snapshot.ts): every element keyed
 * by its class path from the root. Then, per key:
 *
 * - **missing**: the mockup has it, /admin doesn't (a missing element or wrapper,
 *   or a wrong class); **extra**: the other way round. A missing key's descendants
 *   aren't listed again.
 * - **style**: a property whose values differ (font, colour, spacing, border,
 *   radius, shadow; the size of fixed-size parts).
 * - **order**: two children in the opposite order.
 *
 * Differences that are accepted are listed in ALLOW with a reason: an accepted
 * departure (the spec's Resolved decisions), an M4 or M5 slot left empty, or the
 * sample content (the mockup's site has fields and blocks the demo doesn't).
 * Anything else fails the run (exit code 1).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { demoContent, demoSite, footerInBody, footerInBodyContent, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { cookieFor, resetLive, startLiveSite } from './helpers/live-site.ts';
import { ALLOW_M4, LIVE_ENV, NIAMH, STATES_M4 } from './mockup-diff-m4.ts';
import { ALLOW_M5A, STATES_M5A } from './mockup-diff-m5a.ts';
import { ALLOW_M5B, mediaOffline, seedLibrary, seedLogo, STATES_M5B } from './mockup-diff-m5b.ts';
import { ALLOW_M6, ALLOW_M6_ELSEWHERE, STATES_M6 } from './mockup-diff-m6.ts';
import { ALLOW_AP, STATES_AP } from './mockup-diff-ap.ts';
import { ALLOW_SCRUB } from './mockup-diff-scrub.ts';
import { ALLOW_TWEAKS } from './mockup-diff-tweaks.ts';
import { ALLOW_RT, barShape, compareShapes, ROOT_RT, STATES_RT, type BarShape } from './mockup-diff-rt.ts';
import { FIXED_HEIGHT, FIXED_WIDTH, snapshot, STYLE_PROPS, type Snapshot, type SnapshotSpec } from './helpers/style-snapshot.ts';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const mockups = join(repo, 'packages/caracms/test/mockups');
const fonts = join(repo, 'packages/caracms/src/editor/fonts');

export type Root = 'side' | 'bar' | 'pops' | 'toast' | 'stage' | 'narrow' | 'overlays' | 'rt' | 'modal' | 'signin' | 'nwpage' | 'pageshead';
const ROOTS: Record<Root, { mock: string; ours: string }> = {
	modal: { mock: '#modal-root', ours: '#modal-root' },
	// The sign-in pages are their own server-rendered pages; the mockup draws them in #signin and #narrow.
	signin: { mock: '#signin', ours: 'body' },
	nwpage: { mock: '#narrow', ours: 'body' },
	// Arrange pages: the Pages tree's header with "Arrange pages…" (the arrange mockup draws the rest of the documents level in short).
	pageshead: { mock: '#side section.grp[aria-label="Pages"] > .grp-h', ours: '#side [data-pane-level="documents"] section.grp[data-collection="pages"] > .grp-h' },
	side: { mock: '#side', ours: '#side' },
	bar: { mock: '#bar', ours: '#bar' },
	pops: { mock: '#pops', ours: '#pops' },
	toast: { mock: '#toast-root', ours: '#toast-root' },
	stage: { mock: '#stage', ours: '#stage' },
	narrow: { mock: '#narrow', ours: '#narrow' },
	overlays: { mock: 'frame:#cms-layer', ours: 'frame:#cms-overlays' },
	// The formatting bar and link popover on the page (RT states): the mockup's own layer, /admin's `.cms-rt` in the overlay layer.
	...ROOT_RT,
};
/**
 * /admin's wrappers that only group, left out of the class paths. Live mode adds two,
 * both `display: contents` (styles/levels/live.css): a mark's wrapper (`.mk`), and the
 * read-only fields' `fieldset.ro-fields`, which disables every control in it (Phase 4).
 * The sign-in pages add plain forms around their buttons (they work without script,
 * Decision 14) and a `<noscript>` line. M5a's forms (a fields document, a shared
 * block, Site Settings) wrap their fields in `div[data-form]` in local mode, as live
 * mode's `fieldset.ro-fields` does, and rich text mounts its editor (`.prose.rt`, the
 * mockup's) in an unstyled `.rt-mount`. M5b's media slot wraps its body in `.mslot`
 * (`display: block`), the place Publish's Add alt text scrolls to and focuses.
 */
const SKIP = '.side-level, [data-unknown-block], [data-sw-group], .lk-status:empty, .mk, fieldset.ro-fields, div[data-form], .rt-mount, form:not([class]), noscript, .mslot';

// ─── The states ──────────────────────────────────────────────────────────────

export interface Ctx {
	page: Page;
	site: DevSite;
	browser: Browser;
	/** Other people's browser contexts, closed when the state ends. */
	extra: BrowserContext[];
}
export interface State {
	id: string;
	/** The mockup's state, when it isn't `id` (a second look at one, or a state M4 adds). */
	mock?: string;
	/** The mockup's window size for review (its FRAMES), for sign-in at a width. */
	mockFrame?: string;
	/** /admin in live mode (every M4 state, mockup-diff-m4.ts; some of M5a's). */
	live?: boolean;
	/** An M5a state (mockup-diff-m5a.ts), with M5a's accepted differences. */
	m5a?: boolean;
	/** An M5b state (mockup-diff-m5b.ts), with M5b's accepted differences. */
	m5b?: boolean;
	/** An M6 state (mockup-diff-m6.ts: the inbox, Search and sharing, Site Settings' M6 fields), with M6's accepted differences. */
	m6?: boolean;
	/** An RT state (mockup-diff-rt.ts: on-page rich text), with RT's accepted differences; its bar's shape is compared too. */
	rt?: boolean;
	/** An arrange-pages state (mockup-diff-ap.ts), against packages/caracms/test/mockups/arrange-pages.html, with its accepted differences. */
	ap?: boolean;
	/** Leave the mouse where the state put it (a drag held down over its target). */
	holdMouse?: boolean;
	/** Live mode: who the page is signed in as (default Niamh); null for nobody. */
	as?: string | null;
	/** A sign-in page, not the editor. */
	page?: 'signin';
	/** Environment for this state only (undefined: unset), put back after. */
	env?: Record<string, string | undefined>;
	roots: Root[];
	/** Drive /admin into the state. */
	ours: (ctx: Ctx) => Promise<void>;
	/** Keep focus where the state put it (the mockup focuses an input in these). */
	keepFocus?: boolean;
	viewport?: { width: number; height: number };
	/** /admin without scripts: the server's first paint. */
	noScript?: boolean;
	/** Wait in the mockup before the snapshot (ms after its frames are ready). */
	mockWait?: number;
	/** Don't wait for the mockup's frames (first open is caught before they paint). */
	mockNoWait?: boolean;
	setup?: (site: DevSite) => void;
	teardown?: (site: DevSite) => void | Promise<void>;
}

const ALL: Root[] = ['side', 'bar', 'pops', 'toast', 'stage', 'overlays'];
const DOCS = '[data-pane-level="documents"]';
const DOC = '[data-pane-level="document"]';
const desktop = (page: Page) => page.frameLocator('#stage .frame[data-w="desktop"] iframe');

async function open(page: Page, site: DevSite, path = '/admin') {
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	await page.evaluate(() => document.fonts.ready);
}
async function toDocs(page: Page) {
	if (await page.isVisible(DOCS)) return;
	await page.click('.side-level:not([hidden]) .lv >> nth=0');
	await page.waitForSelector(DOCS, { state: 'visible' });
}
/** Open groups so the tree shows as the mockup's (About and Services open). */
async function openGroups(page: Page, groups: string[]) {
	for (const g of groups) {
		const el = `${DOCS} [data-group="${g}"]`;
		if ((await page.getAttribute(el, 'aria-expanded')) !== 'true') await page.click(el);
	}
}
const row = (i: number) => `${DOC} .blist > .brow >> nth=${i} >> .brow-main`;
/** Home's hero, picked from the page (the mockup's default: the block level, its Heading picked). */
async function heroPicked(ctx: Ctx) {
	await open(ctx.page, ctx.site);
	await desktop(ctx.page).locator('[data-cms-block="0"] [data-cms-field="heading"]').first().click();
	await ctx.page.waitForSelector('[data-pane-level="block"] .field-frame.is-picked');
}
async function fieldPicked(ctx: Ctx, name: string) {
	await heroPicked(ctx);
	await ctx.page.click(`[data-pane-level="block"] [data-ff="${name}"] textarea, [data-pane-level="block"] [data-ff="${name}"] input`);
}
const pages = 'content/pages';

const STATES: State[] = [
	{
		id: 'first-open',
		roots: ['bar', 'stage'],
		noScript: true,
		mockNoWait: true,
		ours: async ({ page, site }) => {
			await page.goto(site.origin + '/admin');
		},
	},
	{ id: 'home', roots: ALL, ours: heroPicked },
	{
		id: 'docs',
		roots: ALL,
		ours: async ({ page, site }) => {
			await open(page, site);
			await toDocs(page);
			await openGroups(page, ['pages:about', 'pages:services']);
		},
	},
	{
		id: 'tree-open',
		roots: ALL,
		ours: async ({ page, site }) => {
			await open(page, site, '/admin/pages/services/branding');
			await toDocs(page);
			await openGroups(page, ['pages:about']);
		},
	},
	{
		id: 'tree-closed',
		roots: ALL,
		ours: async ({ page, site }) => {
			await open(page, site);
			await toDocs(page);
			await openGroups(page, ['pages:about']);
		},
	},
	{
		id: 'find',
		roots: ALL,
		keepFocus: true,
		ours: async ({ page, site }) => {
			await open(page, site);
			await toDocs(page);
			await page.fill(`${DOCS} input[data-filter="docs"]`, 'bra');
		},
	},
	{
		// The mockup's collection states keep its default block open behind them; /admin has none open, so no overlays to compare.
		id: 'collection',
		roots: ['side', 'bar', 'pops', 'toast', 'stage'],
		ours: async ({ page, site }) => {
			await open(page, site);
			await toDocs(page);
			await page.click(`${DOCS} .drow.coll[data-coll="journal"]`);
			await page.waitForSelector('[data-pane-level="collection"]');
		},
	},
	{
		id: 'collection-empty',
		roots: ['side', 'bar', 'pops', 'toast', 'stage'],
		setup: (site) => hideJournal(site, true),
		teardown: (site) => hideJournal(site, false),
		ours: async ({ page, site }) => {
			await open(page, site);
			await toDocs(page);
			await page.click(`${DOCS} .drow.coll[data-coll="journal"]`);
			await page.waitForSelector('[data-pane-level="collection"] .empty');
		},
	},
	{
		id: 'switcher',
		roots: ALL,
		keepFocus: true,
		ours: async (ctx) => {
			await heroPicked(ctx);
			await ctx.page.click('#bar .docbtn');
			await ctx.page.waitForSelector('#pops .pop');
		},
	},
	{
		id: 'switcher-find',
		roots: ALL,
		keepFocus: true,
		ours: async (ctx) => {
			await heroPicked(ctx);
			await ctx.page.click('#bar .docbtn');
			await ctx.page.fill('#swq', 'bra');
		},
	},
	{
		id: 'opening',
		roots: ['bar', 'stage'],
		mockWait: 500,
		ours: async ({ page, site }) => {
			await open(page, site);
			await page.route('**/_caracms/document?*', async (route) => {
				await new Promise((r) => setTimeout(r, 4000));
				await route.continue().catch(() => {});
			});
			await toDocs(page);
			await page.click(`${DOCS} .drow[data-doc="pages/contact"]`);
			await page.waitForSelector('#bar .bar-note');
		},
	},
	{
		id: 'blocks',
		roots: ALL,
		ours: async ({ page, site }) => {
			await open(page, site);
			await page.click(row(1));
			await page.click('[data-pane-level="block"] .cur .ib.boxed');
			await page.waitForSelector(`${DOC} .brow.is-current`);
			await page.hover(`${DOC} .blist > .brow >> nth=2`);
			await page.waitForSelector(`${DOC} .brow.hov`);
		},
	},
	{
		id: 'picker',
		roots: ALL,
		ours: async ({ page, site }) => {
			await open(page, site);
			await page.click(row(1));
			await page.click('[data-pane-level="block"] .cur .ib.boxed');
			await page.click(`${DOC} .add-row`);
			await page.waitForSelector(`${DOC} .picker-grid`);
		},
	},
	{
		id: 'removed',
		roots: ALL,
		ours: async ({ page, site }) => {
			await open(page, site);
			await page.focus(row(1));
			await page.keyboard.press('Backspace');
			await page.waitForSelector('#toast-root .toast');
		},
	},
	{
		id: 'drag',
		roots: ['side', 'bar', 'stage', 'overlays'],
		ours: async ({ page, site }) => {
			await open(page, site);
			// A drag in progress, as the mockup's: the case-study list lifted, hovering over the top half of the CTA before it
			// (Home's last row is the shared footer since M5a, so the case-study list is the one before it).
			await page.evaluate((sel) => {
				const rows = [...document.querySelectorAll<HTMLElement>(`${sel} .blist > .brow`)];
				const from = rows.find((r) => r.querySelector('.nm')?.textContent?.startsWith('Case-study list')) ?? rows.at(-1)!;
				const over = rows[rows.indexOf(from) - 1]!;
				const dt = new DataTransfer();
				from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
				const box = over.getBoundingClientRect();
				requestAnimationFrame(() =>
					requestAnimationFrame(() =>
						over.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 20, clientY: box.top + 4 })),
					),
				);
			}, DOC);
			await page.waitForSelector(`${DOC} .brow.drop-before`);
			await page.waitForSelector(`${DOC} .brow.is-ghost`);
		},
	},
	{
		id: 'overlays',
		roots: ['side', 'overlays'],
		ours: async ({ page, site }) => {
			await open(page, site);
			await page.click(row(2));
			await page.waitForSelector('[data-pane-level="block"]');
			await desktop(page).locator('[data-cms-block="1"]').hover();
		},
	},
	{
		id: 'typing',
		roots: ['side', 'bar', 'overlays'],
		keepFocus: true,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site);
			const intro = desktop(ctx.page).locator('[data-cms-block="0"] [data-cms-field="intro"]').first();
			await intro.click();
			await ctx.page.keyboard.press('End');
			await ctx.page.keyboard.type(' x');
			await ctx.page.waitForSelector('[data-pane-level="block"] .chip.typing');
		},
	},
	{
		id: 'too-long',
		roots: ['side', 'bar'],
		ours: async (ctx) => {
			await heroPicked(ctx);
			await ctx.page.hover('#bar .seg button[data-width="phone"]');
		},
	},
	{
		id: 'phone-main',
		roots: ALL,
		ours: async (ctx) => {
			await heroPicked(ctx);
			await ctx.page.click('#bar .seg button[data-width="phone"]');
			await ctx.page.waitForSelector('[data-pane-level="block"] .mini-seg');
		},
	},
	{
		id: 'phone-lines',
		roots: ALL,
		ours: async (ctx) => {
			await heroPicked(ctx);
			await ctx.page.click('#bar .seg button[data-width="phone"]');
			await ctx.page.click('[data-pane-level="block"] [data-warning="too-long"] .btn.phone');
			await ctx.page.waitForSelector('[data-pane-level="block"] .lk-field.phone');
		},
	},
	{
		id: 'has-phone',
		roots: ALL,
		ours: async (ctx) => {
			await heroPicked(ctx);
			await ctx.page.click('[data-pane-level="block"] [data-warning="too-long"] .btn.phone');
			await ctx.page.waitForSelector('[data-pane-level="block"] .lk-field.phone');
			await ctx.page.click('#bar .seg button[data-width="desktop"]');
			await ctx.page.waitForSelector('[data-pane-level="block"] .lk-phone-sum');
		},
	},
	{
		id: 'unknown',
		roots: ALL,
		setup: (site) => site.write(`${pages}/unknown-test.json`, UNKNOWN_PAGE),
		teardown: (site) => removeFile(site, `${pages}/unknown-test.json`),
		ours: async ({ page, site }) => {
			await open(page, site, '/admin/pages/unknown-test');
			await page.click(row(1));
			await page.waitForSelector('[data-pane-level="block"] .panel');
		},
	},
	{
		id: 'empty-page',
		roots: ALL,
		setup: (site) => site.write(`${pages}/services/packaging.json`, '{\n  "title": "Packaging",\n  "blocks": []\n}\n'),
		teardown: (site) => removeFile(site, `${pages}/services/packaging.json`),
		ours: async ({ page, site }) => {
			await open(page, site, '/admin/pages/services/packaging');
			await page.waitForSelector(`${DOC} .empty`);
		},
	},
	{
		id: 'kept',
		roots: ['side', 'bar'],
		ours: async (ctx) => {
			await fieldPicked(ctx, 'intro');
		},
	},
	{
		id: 'keeping',
		roots: ['side', 'bar'],
		ours: async (ctx) => {
			await ctx.page.route('**/_caracms/write', async (route) => {
				await new Promise((r) => setTimeout(r, 6000));
				await route.continue().catch(() => {});
			});
			await fieldPicked(ctx, 'intro');
			await ctx.page.keyboard.type(' x');
			await ctx.page.waitForSelector('#bar [data-keep="keeping"]');
		},
	},
	{
		id: 'offline',
		roots: ['side', 'bar'],
		ours: async (ctx) => {
			await ctx.page.route('**/_caracms/write', (route) => route.abort());
			await fieldPicked(ctx, 'intro');
			await ctx.page.keyboard.type(' x');
			await ctx.page.waitForSelector('#bar [data-keep="offline"]', { timeout: 10000 });
		},
	},
	{
		id: 'preview-failed',
		roots: ['side', 'bar', 'pops'],
		ours: async (ctx) => {
			await ctx.page.route('**/_caracms/preview', (route) =>
				route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'no' }) : route.continue(),
			);
			await fieldPicked(ctx, 'intro');
			await ctx.page.keyboard.type(' x');
			await ctx.page.click('#bar .bar-warn', { timeout: 10000 });
			await ctx.page.waitForSelector('#pops .pop');
		},
	},
	{
		id: 'narrow',
		roots: ['narrow'],
		viewport: { width: 375, height: 812 },
		ours: async ({ page, site }) => {
			await page.goto(site.origin + '/admin');
			await page.waitForSelector('#narrow .nw');
		},
	},
];

const UNKNOWN_PAGE = `${JSON.stringify(
	{
		title: 'Unknown test',
		blocks: [
			{ type: 'text', heading: 'Before it', body: 'A known block.', background: 'light' },
			{ type: 'testimonial-strip', heading: 'Kind words', quotes: ['One', 'Two', 'Three'], background: 'dark' },
			{ type: 'cta', heading: ['Worried?', 'Why Wait?'], text: 'After it.', button: 'Start', background: 'dark' },
		],
	},
	null,
	2,
)}\n`;

function hideJournal(site: DevSite, hide: boolean) {
	const live = join(site.root, 'content/journal');
	const away = join(site.root, 'content/journal-hidden');
	if (hide) {
		if (existsSync(live)) renameSync(live, away);
		mkdirSync(live, { recursive: true });
	} else if (existsSync(away)) {
		rmSync(live, { recursive: true, force: true });
		renameSync(away, live);
	}
}
function removeFile(site: DevSite, file: string) {
	rmSync(join(site.root, file), { force: true });
}

// ─── Accepted differences ────────────────────────────────────────────────────

export interface Allow {
	state?: RegExp;
	root?: Root;
	kind?: Diff['kind'];
	key: RegExp;
	prop?: RegExp;
	/** The mockup's and ours' values (a style difference), when only some values are accepted. */
	mock?: RegExp;
	ours?: RegExp;
	reason: string;
}

const M4 = 'an M4 slot, left empty in M3 (Decision 6; spec → Open questions: build the slot, never fake the data)';
const M5 = 'an M5 slot (Shared blocks, Site Settings, New page, the page menu, the remaining fields), left empty in M3';
const SAMPLE = "the mockup's sample content, not a difference in the design (its site has blocks, fields and documents the demo doesn't)";

const ALLOW: Allow[] = [
	// The editor restyle: since Decision 12 the brand fills every .btn.ink and the on switch.
	{ kind: 'style', key: /./, mock: /rgb\(31, 47, 87\)/, ours: /rgb\(31, 58, 46\)/, reason: "the demo's own brand accent (its green) where the mockup has its sample navy: the accent's slots, which since the restyle's Decision 12 include .btn.ink and the on switch" },
	{ kind: 'style', key: /./, prop: /^box-shadow$/, mock: /oklab\(/, ours: /oklab\(/, reason: "the editor restyle (Decision 9 (b)): an accent button's pressed edge is --edge-accent, a color-mix of the accent, which computes as oklab(…) from the mockup's navy and the demo's own green, out of the catch-all accent rule's reach" },
	// M4: presence, waiting dots, Publish, the avatar, locks, the offline countdown and Try now.
	{ key: /\.(av|dot|pub|me|avs|lock|who)\b/, reason: M4 },
	{ key: /chip\.lock|chip\.waiting/, reason: M4 },
	{ state: /^offline$/, key: /note > div > (div\.acts|p)$/, reason: `${M4}: the countdown ("Trying again in 12 s.") and Try now (Decision 6: no timer in M3)` },
	// M5: the media and the fields the demo's blocks don't have (M5a built Shared blocks, Site Settings, New page and groups, so theirs are compared).
	{ key: /media|with-pre|\.two\b|fgroup|\.prose|\.lrows|\.switch\b/, reason: `${M5} (media, link and button, groups, prose, list, toggle)` },
	{ key: /cur-row > div$/, kind: 'missing', reason: `${M5}: the page's "…" menu (View on the live site, Delete page)` },
	{ state: /^empty-page$/, key: /^\(root\) > div\.trail$/, prop: /^height$/, reason: `${M5}: the mockup's just-made page has a "New" chip in its title` },
	// M5a: the hero's Buttons field (Decision 17). The demo's hero has none, and gets none: a button added to Home would collide with the live demo's drafts.
	{ key: /field-frame > div\.field > div\.(btnf|list-empty)$/, state: /^(home|switcher|switcher-find|typing|too-long|phone-main|phone-lines|has-phone|kept|keeping|offline|preview-failed)$/, reason: `${SAMPLE}: the mockup's hero has a filled button; the demo's hero has an empty Buttons field ("No buttons.")` },
	{ key: /field-head > span\.field-label$/, kind: 'extra', reason: "a field that's a group of inputs (Buttons, a list) is named by a span, not a <label> with nothing to point at (the mockup's buttons field has a <label for> whose input doesn't exist)" },
	// The brand slot: the site's logo is a file its config names.
	{ key: /(logo-slot|si-logo) > (svg|img)$/, reason: "the site's logo is a file its config names, drawn as an <img> (the mockup inlines its sample SVG)" },
	// The overlays' font: the same file under the layer's own name.
	{ root: 'overlays', prop: /^font-family$/, key: /./, reason: "the layer loads the editor's Instrument Sans inside the site's page under its own name (\"caracms UI\"), so the site's fonts can't clash" },
	// Per browser, or the sample's content.
	{ key: /rchip/, reason: "Recent is per browser (Decision 20): a fresh browser lists only what it opened; the mockup's strip is a sample" },
	{ key: /field-head > span\.field-meta$/, kind: 'missing', reason: "a field with a maximum shows a count; the demo's fields set none" },
	{ key: /span\.meta > span$/, kind: 'missing', reason: `${SAMPLE}: a case study's year` },
	{ state: /^first-open$/, key: /seg > button > span\.(wdot|tip|sr)$/, reason: "the Phone toggle's dot is read from the phone iframe once it renders (M2 Decision 4; M1 → E7), so the server's first paint can't have it" },
	{ state: /^too-long$/, key: /seg > button/, reason: "the mockup pins the tooltip open (.show); /admin shows it on hover and focus, so the check hovers the Phone toggle" },
	{ state: /^phone-main$/, root: 'overlays', key: /cms-pick > span\.cms-chip$/, reason: 'Resolved decisions (Phase 3): a warned field on Phone shows only its warn tag' },
	{ state: /^unknown$/, key: /div\.panel > (p|dl\.kept)$/, reason: "Decision 21 (the doc over the mockup): what's kept is listed key by key, each with a short preview" },
	{ state: /^unknown$/, root: 'overlays', key: /cms-skip > (span|button)$/, reason: "Resolved decisions (Phase 3): the skipped block's pill opens its block, so it's a button" },
	{ state: /^unknown$/, key: /tick\.warn$|seg > button > span\.(wdot|tip|sr)$/, reason: `${SAMPLE}: the test page has no lockup too long for mobile` },
	{ state: /^switcher$/, key: /sw-in > input$/, kind: 'style', reason: 'the switcher focuses its search box when it opens (⌘K, then type); the mockup\'s still has no focus' },
	{ state: /^switcher(-find)?$/, root: 'pops', key: /drow\.is-active/, reason: "the switcher's keyboard highlight (Phase 4: ↑/↓ move it, Enter opens), a wash; the mockup's switcher draws none" },
	{ state: /^switcher(-find)?$/, root: 'pops', key: /sw-list > (button\.drow|div\.sw-more)$/, kind: 'missing', reason: `${SAMPLE}: the first row is the keyboard highlight, and the demo's Journal (3) shows whole, with no "N more"` },
	{ key: /span\.nm > span\.chip\.warn$|span\.meta > span\.wmark$/, kind: 'extra', reason: "the \"too long for mobile\" marks on a block's row and the open document's row are the mockup's own (browHTML, metaFor), but its sidebar isn't redrawn after it measures the phone frame, so its snapshot hasn't got them" },
	{ key: /note[.\w-]*\.warn[.\w-]* > svg\.i$|wmark > svg|toast > button\.btn\.sm > svg/, kind: 'style', prop: /color$/, reason: "contrast (Phase 5's check, icons 3:1): the warning dot's amber is 2.4:1 on white, so the warning mark and a warning note's icon take the strong warning amber; the Undo button's icon is the button's ink, not the toast's pale green (1.5:1 on the button)" },
	{ state: /^drag$/, key: /li\.brow\.is-dragging$/, reason: "in a real drag the lifted row is the browser's own drag image; the mockup draws a still one" },
	{ state: /^overlays$/, root: 'overlays', key: /cms-pick/, reason: "the mockup's showcase picks the hero's button to show every outline at once; /admin shows the CTA open, as it is" },
	{ state: /^overlays$/, key: /field > (p\.field-help|input\.input|select\.input)$/, reason: `${SAMPLE}: the demo's CTA has a button and a background, and is the last block` },
	{ state: /^collection(-empty)?$/, root: 'stage', key: /^\(root\) > div\.stage-table$|^\(root\) > div(\.boxed)?\.frame(\.on)?( > iframe)?$/, reason: "pre-M7 polish: a flat collection's level shows its documents as a table over the stage in place of the preview (the 'table over the stage', after the mockup, which has no state for it); the preview's frames are hidden under it" },
];

// ─── The comparison ──────────────────────────────────────────────────────────

interface Diff {
	state: string;
	root: Root;
	kind: 'missing' | 'extra' | 'style' | 'order' | 'root';
	key: string;
	prop?: string;
	mock?: string;
	ours?: string;
	reason?: string;
}

function compare(state: string, root: Root, mock: Snapshot | null, ours: Snapshot | null): Diff[] {
	if (!mock && !ours) return [];
	if (!mock || !ours) return [{ state, root, kind: 'root', key: '(root)', mock: mock ? 'present' : 'absent', ours: ours ? 'present' : 'absent' }];
	const diffs: Diff[] = [];
	const missing = Object.keys(mock).filter((k) => !ours[k]);
	const extra = Object.keys(ours).filter((k) => !mock[k]);
	const top = (keys: string[]) => keys.filter((k) => !keys.some((p) => p !== k && k.startsWith(`${p} > `)));
	for (const key of top(missing)) diffs.push({ state, root, kind: 'missing', key, mock: mock[key]![0]!.text });
	for (const key of top(extra)) diffs.push({ state, root, kind: 'extra', key, ours: ours[key]![0]!.text });
	for (const key of Object.keys(mock)) {
		const o = ours[key];
		if (!o) continue;
		const m = mock[key]!;
		const props = new Set([...Object.keys(m[0]!.styles), ...Object.keys(o[0]!.styles)]);
		for (const prop of props) {
			const values = (rs: typeof m) => [...new Set(rs.map((r) => r.styles[prop]).filter((v): v is string => v !== undefined))].sort();
			const mv = values(m);
			const ov = values(o);
			if (!mv.length || !ov.length) continue;
			if (prop === 'width' || prop === 'height') {
				// Content can vary the instances; ours must be among the mockup's values.
				if (ov.every((v) => mv.includes(v))) continue;
			} else if (JSON.stringify(mv) === JSON.stringify(ov)) continue;
			diffs.push({ state, root, kind: 'style', key, prop, mock: mv.join(' | '), ours: ov.join(' | ') });
		}
		// Order: a pair of children the two put the other way round.
		const before = (seqs: string[][]) => {
			const pairs = new Set<string>();
			for (const s of seqs) for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) pairs.add(`${s[i]}\u0000${s[j]}`);
			return pairs;
		};
		const mp = before(m.map((r) => r.kids));
		for (const pair of before(o.map((r) => r.kids))) {
			const [a, b] = pair.split('\u0000');
			if (a !== b && mp.has(`${b}\u0000${a}`) && !mp.has(pair)) diffs.push({ state, root, kind: 'order', key, mock: `${b} before ${a}`, ours: `${a} before ${b}` });
		}
	}
	return diffs;
}

/** Every accepted difference that explained something in this run (`--unused` lists the others). */
const used = new Set<Allow>();

/** M3's accepted differences cover local mode only; the M4 states (live mode), the M5a, M5b and RT states have their own (mockup-diff-m4.ts, -m5a.ts, -m5b.ts, -rt.ts). */
function explain(diff: Diff, state: State): string | undefined {
	const list = state.ap ? ALLOW_AP : state.rt ? ALLOW_RT : state.m6 ? ALLOW_M6 : state.m5b ? ALLOW_M5B : state.m5a ? ALLOW_M5A : state.live ? ALLOW_M4 : ALLOW;
	for (const a of [...list, ...ALLOW_M6_ELSEWHERE, ...ALLOW_SCRUB, ...ALLOW_TWEAKS]) {
		if (a.state && !a.state.test(diff.state)) continue;
		if (a.root && a.root !== diff.root) continue;
		if (a.kind && a.kind !== diff.kind) continue;
		if (a.prop && !(diff.prop && a.prop.test(diff.prop))) continue;
		if (a.mock && !a.mock.test(diff.mock ?? '')) continue;
		if (a.ours && !a.ours.test(diff.ours ?? '')) continue;
		if (!a.key.test(diff.key)) continue;
		used.add(a);
		return a.reason;
	}
	return undefined;
}

// ─── Running it ──────────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

async function serveMockups(): Promise<{ server: Server; origin: string }> {
	const server = createServer((req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
		const file = join(mockups, path);
		if (!file.startsWith(mockups)) {
			res.writeHead(403).end();
			return;
		}
		try {
			const body = readFileSync(file);
			res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	return { server, origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` };
}

/** The mockup's Google Fonts, answered locally (the package's own files; Bricolage from the fixture demo site). */
async function localFonts(context: BrowserContext) {
	const files: Record<string, string> = {
		'instrument.woff2': join(fonts, 'instrument-sans-latin-wght-normal.woff2'),
		'geist.woff2': join(fonts, 'geist-mono-latin-wght-normal.woff2'),
		'bricolage.woff2': join(demoSite, 'src/fonts/BricolageGrotesque.woff2'),
	};
	const face = (family: string, file: string, weight: string, extra = '') =>
		`@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(https://fonts.gstatic.com/local/${file}) format('woff2');${extra}}`;
	await context.route('https://fonts.googleapis.com/**', (route) => {
		const url = route.request().url();
		let css = '';
		if (url.includes('Instrument')) css += face('Instrument Sans', 'instrument.woff2', '400 700');
		if (url.includes('Geist')) css += face('Geist Mono', 'geist.woff2', '400 500');
		if (url.includes('Bricolage')) css += face('Bricolage Grotesque', 'bricolage.woff2', '200 800', "font-stretch:75% 100%;");
		return route.fulfill({ status: 200, contentType: 'text/css', body: css });
	});
	await context.route('https://fonts.gstatic.com/**', (route) => {
		const name = route.request().url().split('/').pop() ?? '';
		const file = files[name];
		return file ? route.fulfill({ status: 200, contentType: 'font/woff2', body: readFileSync(file) }) : route.fulfill({ status: 404 });
	});
}

const spec = (root: string): SnapshotSpec => ({ root, skip: SKIP, props: STYLE_PROPS, fixedHeight: FIXED_HEIGHT, fixedWidth: FIXED_WIDTH });

async function settle(page: Page) {
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	await page.waitForTimeout(250);
}

async function parkMouse(page: Page) {
	const box = await page.locator('#bar .bar-a').boundingBox();
	if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

export interface StateResult {
	state: string;
	diffs: Diff[];
}

export type Group = 'M3' | 'M4' | 'M5a' | 'M5b' | 'M6' | 'RT' | 'AP';
const groupOf = (s: State): Group => (s.ap ? 'AP' : s.rt ? 'RT' : s.m6 ? 'M6' : s.m5b ? 'M5b' : s.m5a ? 'M5a' : s.live ? 'M4' : 'M3');

export async function runMockupDiff(options: { states?: string[]; group?: Group; browser?: Browser; site?: DevSite } = {}): Promise<StateResult[]> {
	let states = [...STATES, ...STATES_M4, ...STATES_M5A, ...STATES_M5B, ...STATES_M6, ...STATES_RT, ...STATES_AP];
	if (options.group) states = states.filter((s) => groupOf(s) === options.group);
	if (options.states?.length) states = states.filter((s) => options.states!.includes(s.id));
	const { server, origin } = await serveMockups();
	const browser = options.browser ?? (await chromium.launch());
	const results: StateResult[] = [];
	// The in-memory bucket and fake Mux for the whole run (M5b Decision 5): never the real ones. Each state reseeds them.
	const media = process.env.CARACMS_MEDIA;
	process.env.CARACMS_MEDIA = 'memory';
	// M6: the in-memory submissions store, never a folder or a bucket (the inbox's states seed it).
	const submissions = process.env.CARACMS_SUBMISSIONS;
	process.env.CARACMS_SUBMISSIONS = 'memory';
	try {
		// Local mode first, then live mode: the mode is read per process, so the two never run at once.
		const local = states.filter((s) => !s.live);
		const live = states.filter((s) => s.live);
		if (local.length) {
			// The mockups were drawn with Home's footer as a shared block in its body (M5a): edit in context's slot has states of its own.
			const site = options.site ?? (await startDevSite('mockup-diff', { edit: footerInBody }));
			try {
				for (const state of local) results.push(await runOne(state, { origin, browser, site }));
			} finally {
				if (!options.site) await site.close();
			}
		}
		if (live.length) {
			const liveSite = await startLiveSite('mockup-diff-live', LIVE_ENV, { edit: footerInBody });
			try {
				for (const state of live) {
					results.push(await runOne(state, { origin, browser, site: liveSite.site }));
				}
			} finally {
				await liveSite.close();
			}
		}
	} finally {
		server.close();
		if (!options.browser) await browser.close();
		if (media === undefined) delete process.env.CARACMS_MEDIA;
		else process.env.CARACMS_MEDIA = media;
		if (submissions === undefined) delete process.env.CARACMS_SUBMISSIONS;
		else process.env.CARACMS_SUBMISSIONS = submissions;
	}
	return results;
}

/** One state that can't be reached doesn't stop the others; it fails the run. */
async function runOne(state: State, options: { origin: string; browser: Browser; site: DevSite }): Promise<StateResult> {
	try {
		return await runState(state, options);
	} catch (error) {
		return { state: state.id, diffs: [{ state: state.id, root: state.roots[0]!, kind: 'root', key: '(state)', ours: `couldn't be reached: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }] };
	}
}

async function runState(state: State, { origin, browser, site }: { origin: string; browser: Browser; site: DevSite }): Promise<StateResult> {
	const viewport = state.viewport ?? { width: 1440, height: 900 };
	// The mockup.
	const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
	await localFonts(mctx);
	const mpage = await mctx.newPage();
	await mpage.goto(`${origin}/${state.ap ? 'arrange-pages' : 'm2-editor'}.html#${state.mock ?? state.id}`);
	if (state.ap) {
		// The arrange mockup has no preview frames: its page is a stand-in.
		await mpage.waitForSelector('#side .side-level');
		await mpage.evaluate(() => document.fonts.ready);
		await mpage.waitForTimeout(state.mockWait ?? 400);
	} else if (state.mockNoWait) await mpage.waitForSelector('#stage.unpainted');
	else {
		// The mockup's frames (its script's top-level `F`, a lexical global, so reached by an expression).
		await mpage.waitForFunction("typeof F !== 'undefined' && ['desktop', 'tablet', 'phone'].every((w) => F[w] && F[w].ready)");
		await mpage.evaluate(() => document.fonts.ready);
		if (state.mockFrame) await mpage.evaluate(`S.frame = ${JSON.stringify(state.mockFrame)}; applyFrame(); renderAll();`);
		await mpage.waitForTimeout(state.mockWait ?? 400);
	}
	const mock: Partial<Record<Root, Snapshot | null>> = {};
	for (const r of state.roots) mock[r] = await mpage.evaluate(snapshot, spec(ROOTS[r].mock));
	// The bar's shape (RT): the controls in order, which are pressed, the side of the block, the menu, popover and wash.
	const mockShape: BarShape | null = state.rt ? await mpage.evaluate(barShape, ROOTS.rt.mock) : null;
	await mctx.close();

	// /admin, on the demo's content as the tests pin it (an earlier state may have edited the copy).
	rmSync(join(site.root, 'content'), { recursive: true, force: true });
	cpSync(demoContent, join(site.root, 'content'), { recursive: true });
	// The copy's config has the footer as a body block (runMockupDiff's `footerInBody`); the pinned content has it as the slot's.
	if (!readFileSync(join(site.root, 'src/blocks/footer.ts'), 'utf8').includes("slot: 'footer'")) footerInBodyContent(site.root);
	// The demo's logo is in Site Settings since M5b (Phase 4), an upload in the bucket; the pinned fixture has none, so
	// every state seeds it (with the library it's in), and the bar shows the logo as the mockup's does.
	seedLibrary();
	seedLogo(site);
	state.setup?.(site);
	// Live mode: this state's environment, and a fresh runtime (nothing waiting, locked or published).
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(state.env ?? {})) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	if (state.live) await resetLive();
	const octx = await browser.newContext({ viewport, reducedMotion: 'reduce', javaScriptEnabled: !state.noScript });
	const as = state.as === undefined ? NIAMH : state.as;
	if (state.live && as) await octx.addCookies([cookieFor(site, as)]);
	await mediaOffline(octx);
	const page = await octx.newPage();
	page.on('pageerror', (e) => console.error(`[${state.id}] page error:`, e.message));
	const ctx: Ctx = { page, site, browser, extra: [] };
	const ours: Partial<Record<Root, Snapshot | null>> = {};
	let ourShape: BarShape | null = null;
	try {
		await state.ours(ctx);
		if (state.page === 'signin') {
			// The first field has autofocus; the mockup focuses it only in some states (keepFocus).
			if (!state.keepFocus) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
			await settle(page);
		} else if (!state.noScript && !state.viewport) {
			// Everything kept, as the mockup's states are (except the ones that are about keeping).
			if (!['keeping', 'offline', 'live-keeping', 'live-offline', 'signed-out-edit', 'signed-out-removed', 'not-kept'].includes(state.id)) await page.waitForSelector('#bar [data-keep="kept"]', { timeout: 10000 });
			if (!state.keepFocus) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
			if (!['blocks', 'overlays', 'too-long', 'drag'].includes(state.id) && !state.holdMouse) await parkMouse(page);
			await settle(page);
		}
		for (const r of state.roots) ours[r] = await page.evaluate(snapshot, spec(ROOTS[r].ours));
		if (state.rt) ourShape = await page.evaluate(barShape, ROOTS.rt.ours);
	} finally {
		for (const c of ctx.extra) await c.close().catch(() => {});
		await octx.close();
		await state.teardown?.(site);
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
	const diffs: Diff[] = state.roots.flatMap((r) => compare(state.id, r, mock[r] ?? null, ours[r] ?? null));
	if (state.rt) diffs.push(...compareShapes(state.id, mockShape, ourShape));
	for (const d of diffs) d.reason = explain(d, state);
	return { state: state.id, diffs };
}

export function report(results: StateResult[], all = false): { text: string; unexplained: number } {
	const lines: string[] = [];
	let unexplained = 0;
	for (const { state, diffs } of results) {
		const open = diffs.filter((d) => !d.reason);
		unexplained += open.length;
		lines.push(`${open.length ? '✗' : '✓'} ${state}: ${open.length} unexplained, ${diffs.length - open.length} accepted`);
		for (const d of all ? diffs : open) {
			const what = d.kind === 'style' ? `${d.prop}: mockup ${d.mock} · ours ${d.ours}` : d.kind === 'order' ? `mockup ${d.mock} · ours ${d.ours}` : `${d.mock ?? d.ours ?? ''}`;
			lines.push(`    [${d.root}] ${d.kind} ${d.key}${what ? `  ${what}` : ''}${d.reason ? `\n        accepted: ${d.reason}` : ''}`);
		}
	}
	return { text: lines.join('\n'), unexplained };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const all = args.includes('--all');
	const group = args.includes('--m3') ? 'M3' : args.includes('--m4') ? 'M4' : args.includes('--m5a') ? 'M5a' : args.includes('--m5b') ? 'M5b' : args.includes('--m6') ? 'M6' : args.includes('--rt') ? 'RT' : args.includes('--ap') ? 'AP' : undefined;
	const results = await runMockupDiff({ states: args.filter((a) => !a.startsWith('--')), group });
	const { text, unexplained } = report(results, all);
	console.log(text);
	if (args.includes('--unused')) {
		const lists: [string, Allow[]][] = [['M3', ALLOW], ['M4', ALLOW_M4], ['M5a', ALLOW_M5A], ['M5b', ALLOW_M5B], ['M6', ALLOW_M6], ['M6 elsewhere', ALLOW_M6_ELSEWHERE], ['RT', ALLOW_RT], ['AP', ALLOW_AP], ['copy scrub', ALLOW_SCRUB], ['tweaks', ALLOW_TWEAKS]];
		for (const [name, list] of lists) for (const a of list) if (!used.has(a)) console.log(`unused (${name}): ${a.state ?? ''} ${a.key} — ${a.reason.slice(0, 80)}`);
	}
	console.log(unexplained ? `\n${unexplained} unexplained difference(s).` : '\nEvery state matches the mockup, or differs only as accepted.');
	process.exit(unexplained ? 1 : 0);
}
