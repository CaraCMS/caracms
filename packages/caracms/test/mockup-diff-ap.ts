/**
 * The arrange-pages states for the visual pass's check (check 20), run by mockup-diff.ts beside the others (`--ap`): every state of
 * packages/caracms/test/mockups/arrange-pages.html against /admin in the same state, in local mode. Their
 * accepted differences, each with its reason, are `ALLOW_AP`. Ours are `ap-<the mockup's id>`.
 *
 * The mockup draws the starter's tree after collections-under-pages (Studio with Visit, Field
 * notes hidden, Privacy, Questions at /faq). Each state's `setup` writes those pages into the
 * throwaway copy, so the rows line up one for one; the demo's content is never changed.
 * Drags are real ones (the mouse held down over the target while the snapshot is taken). A
 * refused Apply (someone's lock, a failure part way) is the server's answer, faked with a
 * route, since the states run in local mode.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright-core';
import type { DevSite } from './helpers/dev-site.ts';
import type { Allow, Ctx, Root, State } from './mockup-diff.ts';

const PANE = '[data-pane-level="arrange"]';
const DOCS = '[data-pane-level="documents"]';
const ARRANGE: Root[] = ['side', 'stage', 'toast'];

// ─── The starter's tree, in the throwaway copy ──────────────────────────────

const write = (site: DevSite, file: string, text: string) => {
	mkdirSync(dirname(join(site.root, file)), { recursive: true });
	site.write(file, text);
};
const pageJson = (title: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ title, blocks: [], ...extra }, null, 2)}\n`;
/** Studio with Visit in it, Field notes (hidden), Privacy and Questions (/faq); no Print under Services. */
export function starterTree(site: DevSite, more?: (site: DevSite) => void) {
	write(site, 'content/pages/studio/visit.json', site.read('content/pages/visit.json'));
	rmSync(join(site.root, 'content/pages/visit.json'), { force: true });
	rmSync(join(site.root, 'content/pages/services/print.json'), { force: true });
	write(site, 'content/pages/field-notes.json', pageJson('Field notes', { hidden: true }));
	write(site, 'content/pages/privacy.json', pageJson('Privacy'));
	write(site, 'content/pages/faq.json', pageJson('Questions'));
	more?.(site);
}

// ─── Driving /admin ──────────────────────────────────────────────────────────

const row = (id: string) => `#atree .arow[data-id="${id}"]`;
async function openArrange(page: Page, origin: string) {
	await page.goto(`${origin}/admin/arrange`);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	await page.waitForSelector(row('index'));
	await page.evaluate(() => document.fonts.ready);
}
/** A real drag: onto `to`'s top quarter, middle or bottom quarter. `hold` keeps the button down (a mid-drag state). */
async function drag(page: Page, from: string, to: string, where: 'top' | 'mid' | 'bottom', hold = false) {
	const a = (await page.locator(row(from)).boundingBox())!;
	await page.mouse.move(a.x + 120, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + 130, a.y + a.height / 2 + 8, { steps: 3 });
	await page.waitForSelector(`${row(from)}.is-src`);
	const b = (await page.locator(row(to)).boundingBox())!;
	const y = where === 'top' ? b.y + 4 : where === 'bottom' ? b.y + b.height - 4 : b.y + b.height / 2;
	await page.mouse.move(b.x + 200, y, { steps: 6 });
	if (!hold) {
		await page.mouse.up();
		await page.waitForSelector(`${row(from)}:not(.is-src)`);
	}
}
async function newGroup(page: Page, name: string) {
	await page.click('[data-act="new-group"]');
	await page.fill('#ng-in', name);
	await page.press('#ng-in', 'Enter');
	await page.waitForSelector('#ng-in', { state: 'detached' });
}
async function rename(page: Page, id: string, name: string, confirm = true) {
	await page.hover(row(id));
	await page.click(`${row(id)} [data-act="rename"]`);
	await page.fill('#rn-in', name);
	if (confirm) await page.click('#rn-ok');
}
/**
 * The mockup's `mixed()`: New group Company after Home, with About (and Team), Journal (and its
 * posts) and Contact in it; Services renamed Offerings; Visit out of Studio to the top level
 * (Studio goes); Questions into Field notes, which is hidden.
 */
async function mixed(page: Page) {
	await newGroup(page, 'Company');
	await drag(page, 'new:1', 'about', 'top');
	await drag(page, 'about', 'new:1', 'mid');
	await drag(page, 'journal', 'new:1', 'mid');
	await drag(page, 'contact', 'new:1', 'mid');
	await rename(page, 'services', 'Offerings');
	await drag(page, 'studio/visit', 'field-notes', 'top');
	await drag(page, 'faq', 'field-notes', 'mid');
}
async function review(page: Page) {
	await page.click(`${PANE} [data-act="review"]`);
	await page.waitForSelector(`${PANE} [data-arrange="review"]`);
}
/** The Apply answered by a route (local mode has no locks; a failure part way can't be made to happen). */
async function answerApply(page: Page, status: number, body: unknown) {
	await page.route('**/_caracms/arrange', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

const AOIFE = { email: 'aoife.b@example.com', name: 'Aoife' }; // This address lands in the mockup's Aoife colour slot (colourOf).

const st = (id: string, ours: (ctx: Ctx) => Promise<void>, extra: Partial<State> = {}): State => ({
	id: `ap-${id}`,
	mock: id,
	ap: true,
	roots: ARRANGE,
	setup: (site) => starterTree(site),
	ours,
	...extra,
});
const at = (run: (page: Page) => Promise<void>) => async (ctx: Ctx) => {
	await openArrange(ctx.page, ctx.site.origin);
	await run(ctx.page);
};

export const STATES_AP: State[] = [
	// ── Opening ──
	st(
		'entry',
		async (ctx) => {
			await ctx.page.goto(`${ctx.site.origin}/admin`);
			await ctx.page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
			if (!(await ctx.page.isVisible(DOCS))) await ctx.page.click('.side-level:not([hidden]) .lv >> nth=0');
			await ctx.page.waitForSelector(DOCS, { state: 'visible' });
		},
		{ roots: ['pageshead'] },
	),
	st('open', at(async () => {})),
	// ── Dragging (the button held down over the target) ──
	st('drag-beside', at((page) => drag(page, 'journal', 'about', 'top', true)), { holdMouse: true }),
	st(
		'drag-inside',
		at(async (page) => {
			await newGroup(page, 'Company');
			await drag(page, 'about', 'new:1', 'mid');
			await drag(page, 'contact', 'new:1', 'mid', true);
		}),
		{ holdMouse: true },
	),
	st('drag-deeper', at((page) => drag(page, 'faq', 'about', 'bottom', true)), { holdMouse: true }),
	st('refused-home', at((page) => drag(page, 'privacy', 'index', 'mid', true)), { holdMouse: true }),
	st('refused-slug', at((page) => drag(page, 'studio/team', 'about/team', 'top', true)), {
		holdMouse: true,
		setup: (site) => starterTree(site, (s) => write(s, 'content/pages/studio/team.json', pageJson('Team'))),
	}),
	st('refused-held', at((page) => drag(page, 'privacy', 'held:journal', 'mid', true)), { holdMouse: true }),
	// ── Groups ──
	st(
		'group-naming',
		at(async (page) => {
			await page.click('[data-act="new-group"]');
			await page.fill('#ng-in', 'Company');
		}),
	),
	st(
		'group-clash',
		at(async (page) => {
			await page.click('[data-act="new-group"]');
			await page.fill('#ng-in', 'Studio');
		}),
	),
	st(
		'group-empty',
		at(async (page) => {
			await newGroup(page, 'Later');
			await drag(page, 'studio/visit', 'work', 'top');
		}),
	),
	st('group-rename', at((page) => rename(page, 'services', 'Offerings', false))),
	// ── Review ──
	st('changed', at(mixed)),
	st(
		'review-order',
		at(async (page) => {
			await drag(page, 'journal', 'about', 'top');
			await review(page);
		}),
	),
	st(
		'review',
		at(async (page) => {
			await mixed(page);
			await review(page);
		}),
	),
	st(
		'review-posts',
		at(async (page) => {
			await mixed(page);
			await review(page);
			await page.click(`${PANE} [data-review="held"] .rv-more`);
		}),
	),
	st(
		'review-shown',
		at(async (page) => {
			await drag(page, 'field-notes/faq', 'privacy', 'bottom');
			await review(page);
		}),
		{
			setup: (site) =>
				starterTree(site, (s) => {
					write(s, 'content/pages/field-notes/faq.json', s.read('content/pages/faq.json'));
					rmSync(join(s.root, 'content/pages/faq.json'), { force: true });
				}),
		},
	),
	st(
		'applying',
		at(async (page) => {
			await mixed(page);
			await review(page);
			// The server never answers: the review stays as it is while Apply runs.
			await page.route('**/_caracms/arrange', () => undefined);
			await page.click(`${PANE} [data-act="apply"]`);
			await page.waitForSelector(`${PANE} .busy`);
		}),
	),
	st(
		'applied',
		at(async (page) => {
			await mixed(page);
			await review(page);
			await page.click(`${PANE} [data-act="apply"]`);
			await page.waitForSelector(`${DOCS}:not([hidden])`, { timeout: 8000 }).catch(async (e) => {
				throw new Error(`pane: ${((await page.textContent(PANE).catch(() => '')) ?? '').replace(/\s+/g, ' ')} (${String(e).split('\n')[0]})`);
			});
			await page.waitForSelector('#toast-root .toast');
		}),
		{ roots: ['pageshead', 'toast'] },
	),
	// ── Trouble ──
	st(
		'refused-lock',
		at(async (page) => {
			await mixed(page);
			await review(page);
			await answerApply(page, 409, { error: 'Aoife is editing Branding', code: 'locked', lock: { file: 'content/pages/services/branding.json', person: AOIFE, since: new Date().toISOString(), releasing: false, mine: null }, state: 'theirs' });
			await page.click(`${PANE} [data-act="apply"]`);
			await page.waitForSelector(`${PANE} [data-note="arrange-lock"]`);
		}),
	),
	st(
		'changed-underneath',
		async (ctx) => {
			await openArrange(ctx.page, ctx.site.origin);
			await mixed(ctx.page);
			await review(ctx.page);
			// Since the review: a page under Services, a new post. The server refuses (changed); the review is planned again.
			write(ctx.site, 'content/pages/services/kitchen-pottery.json', pageJson('Kitchen pottery'));
			write(ctx.site, 'content/journal/the-new-letterpress.json', ctx.site.read('content/journal/notes-from-the-ridge.json'));
			await ctx.page.click(`${PANE} [data-act="apply"]`);
			await ctx.page.waitForSelector(`${PANE} [data-note="arrange-underneath"]`);
		},
	),
	st(
		'apply-failed',
		at(async (page) => {
			await mixed(page);
			await review(page);
			await answerApply(page, 500, { error: 'Something went wrong part way, so everything was put back as it was.' });
			await page.click(`${PANE} [data-act="apply"]`);
			await page.waitForSelector(`${PANE} [data-note="arrange-failed"]`);
		}),
	),
	// ── Leaving ──
	st(
		'leave',
		at(async (page) => {
			await mixed(page);
			await page.click(`${PANE} [data-act="cancel"]`);
			await page.waitForSelector('[data-dialog="arrange-leave"]');
		}),
		{ roots: [...ARRANGE, 'modal'] },
	),
];

/**
 * Arrange pages in live mode, for the live chrome sweeps (chrome-live*.visual.test.ts): the
 * review with its tick and "Goes live at the next Publish", and the same refused by someone
 * else's lock (the note with their avatar). Not mockup states: openLiveState drives them.
 */
async function liveReview(ctx: Ctx) {
	await ctx.page.goto(`${ctx.site.origin}/admin/arrange`);
	await ctx.page.waitForSelector(row('index'), { timeout: 20000 });
	await ctx.page.evaluate(() => document.fonts.ready);
	await drag(ctx.page, 'contact', 'about', 'mid');
	await review(ctx.page);
}
export const STATES_AP_LIVE: State[] = [
	{ id: 'ap-live-review', live: true, roots: ARRANGE, ours: liveReview },
	{
		id: 'ap-live-lock',
		live: true,
		roots: ARRANGE,
		ours: async (ctx) => {
			await liveReview(ctx);
			await answerApply(ctx.page, 409, { error: 'Aoife is editing Contact', code: 'locked', lock: { file: 'content/pages/contact.json', person: AOIFE, since: new Date().toISOString(), releasing: false, mine: null }, state: 'theirs' });
			await ctx.page.click(`${PANE} [data-act="apply"]`);
			await ctx.page.waitForSelector(`${PANE} [data-note="arrange-lock"]`);
		},
	},
];

const SAMPLE = "the mockup's sample content, not a difference in the design";

export const ALLOW_AP: Allow[] = [
	// The editor restyle: since Decision 12 the brand fills every .btn.ink and the on switch.
	{ kind: 'style', key: /./, mock: /rgb\(31, 47, 87\)/, ours: /rgb\(31, 58, 46\)/, reason: "the demo's own brand accent (its green) where the mockup has its sample navy: the accent's slots, which since the restyle's Decision 12 include .btn.ink and the on switch" },
	{ kind: 'style', key: /./, prop: /^box-shadow$/, mock: /oklab\(/, ours: /oklab\(/, reason: "the editor restyle (Decision 9 (b)): an accent button's pressed edge is --edge-accent, a color-mix of the accent, which computes as oklab(…) from the mockup's navy and the demo's own green, out of the catch-all accent rule's reach" },
	{ root: 'stage', key: /^\(root\) > div\.(frame\.on|boxed\.frame)$/, kind: 'extra', reason: "the preview's three frames stay rendered behind the screen, hidden (M3 Decision 13: never display: none); the mockup's stage has only the screen" },
	{ state: /^ap-entry$/, root: 'pageshead', key: /> button\.linkbtn(\.mk-ann)?\.subtle$/, reason: 'the mockup outlines "Arrange pages…" with its review tool\'s annotation (`mk-ann`, not part of the design) in this state' },
	{ root: 'pageshead', key: /> button\.linkbtn > svg\.i\.i-(sm|xs)$/, reason: "New page's own icon, as the editor has drawn it since M5a (xs); this spec doesn't touch it" },
	{ state: /^ap-applied$/, root: 'toast', key: /^\(root\) > div\.toast( > button\.ib)?$/, reason: "the editor's message toast (shell/Toast.tsx) has its close button and the padding that goes with it; the mockup draws a bare one" },
	{ state: /^ap-(drag|refused)-/, kind: 'style', key: /./, prop: /^cursor$/, reason: 'a real drag: the body says grabbing (or not-allowed over a refused row) everywhere while the button is held; the mockup draws the mid-drag state still, with no pointer' },
	{ state: /^ap-(drag|refused)-/, kind: 'style', key: /div\.arow(\.[\w-]+)*$/, prop: /^background-color$/, ours: /rgb\(242, 239, 231\)/, reason: "a real drag: the pointer is over the target row, so it has the row's hover wash; the mockup's still state has no pointer" },
	{ state: /^ap-(drag|refused)-/, kind: 'style', key: /span\.ag > svg\.i$/, prop: /^color$/, reason: "a real drag: the hovered row's grip darkens, as any row's does under the pointer; the mockup's still state has no pointer" },
	{ key: /div\.mv > span(\.fr)?$/, reason: "the old address in a review line is `.fr`; the editor has a rule for that class elsewhere and the mockup none, so its key keeps the class there and drops it here (same span, same look)" },
	{ root: 'stage', kind: 'missing', key: /div\.arow\.is-gone\.is-group > span\.ae > button\.act\.btn\.ghost\.sm$/, reason: 'a group that goes has no Rename… (the review fixes, 2026-10-25): nothing is left in it to name; the mockup draws one, shown only on hover and focus' },
	{ key: /span\.meta > span(\.hmark)?$/, reason: 'the hidden mark is the sidebar\'s `.hmark`; the editor has a rule for that class (the collection table\'s) and the mockup none, so its key keeps the class there and drops it here' },
	// Page folders: the older arrange mockup predates folders; its own new mockup (packages/caracms/test/mockups/page-folders.html) is authoritative for them.
	{ root: 'stage', kind: 'missing', key: /div\.arr-head-in > div > button\.btn\.sm$/, reason: 'page folders (Decision 4): "New group" now sits beside "New folder" in a wrapper (`.arr-tools`), so the lone button the mockup draws is not a direct child any more' },
	{ root: 'stage', kind: 'extra', key: /div\.arr-head-in > div > div\.arr-tools$/, reason: 'page folders (Decision 4): the Arrange head\'s "New folder" button, beside "New group"' },
	{ root: 'stage', kind: 'extra', key: /div\.arr-hint > span\.key > span\.key-dash$/, reason: 'page folders (mockup #open): the hint\'s key gains the marker for "Into a folder"' },
	{ root: 'stage', kind: 'extra', key: /div\.arow\.is-group > span\.ae > button\.act\.ib$/, reason: 'page folders (Decision 6): a group row\'s ··· menu holds "Take out of the addresses"' },
	{ root: 'stage', kind: 'style', prop: /^position$/, mock: /static/, ours: /relative/, key: /div\.arow(\.[\w-]+)* > span\.ae$/, reason: 'page folders (Decision 6): a row\'s action cell anchors its ··· menu (position: relative)' },
];
export { SAMPLE as AP_SAMPLE };
