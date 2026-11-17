/**
 * The M5a states for the visual pass's check (M5a Phase 6), run by mockup-diff.ts
 * beside M3's and M4's (`--m5a`): every state the mockup's switcher tags M5a, against
 * /admin in the same state. Their accepted differences, each with its reason, are
 * `ALLOW_M5A`. The two that waited for M5b, `alt-missing` and `blocked` (now
 * `publish-alt`, as the mockup redrew them), are in M5b's group (mockup-diff-m5b.ts).
 *
 * Since M5b the demo's logo is an upload in Site Settings; mockup-diff.ts seeds it (and
 * the in-memory library it's in) into every state's copy, so the bar shows the logo as
 * the mockup's does.
 *
 * Most run in local mode on a throwaway copy of the demo, as M3's do. Four need live
 * mode (helpers/live-site.ts, as M4's): `settings-self` (who you are), `delete-locked`
 * (someone else editing), `waiting-docs` (the waiting list) and `new-case-open` (the
 * "New" chip a document gets while it's waiting). The demo's content is never changed:
 * a state that needs other sample content (a half-filled button, a credit to a page
 * that's gone) writes it into the throwaway copy in its `setup`.
 */
import type { Page } from 'playwright-core';
import { AOIFE, eventually, keepState, openAdmin } from './helpers/live-site.ts';
import { cookieFor } from './helpers/live-site.ts';
import type { DevSite } from './helpers/dev-site.ts';
import type { Allow, Ctx, Root, State } from './mockup-diff.ts';

const SHOWN = '.side-level:not([hidden])';
const DOCS = '[data-pane-level="documents"]';
const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const FORM = `${SHOWN} [data-form]`;
const desktop = (page: Page) => page.frameLocator('#stage .frame[data-w="desktop"] iframe');

const EDITOR: Root[] = ['side', 'bar', 'pops', 'toast', 'stage'];
const WITH_OVERLAYS: Root[] = [...EDITOR, 'overlays'];
const DIALOG: Root[] = ['side', 'bar', 'modal'];

async function open(page: Page, origin: string, path = '/admin') {
	await page.goto(origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	await page.evaluate(() => document.fonts.ready);
}
async function toDocs(page: Page) {
	if (await page.isVisible(DOCS)) return;
	await page.click(`${SHOWN} .lv >> nth=0`);
	await page.waitForSelector(DOCS, { state: 'visible' });
}
async function openGroups(page: Page, groups: string[]) {
	for (const g of groups) {
		const el = `${DOCS} [data-group="${g}"]`;
		if ((await page.getAttribute(el, 'aria-expanded')) !== 'true') await page.click(el);
	}
}
/** The documents level as the mockup's (About and Services open). */
async function docs(ctx: Ctx) {
	await open(ctx.page, ctx.site.origin);
	await toDocs(ctx.page);
	await openGroups(ctx.page, ['pages:about', 'pages:services']);
}
const row = (i: number) => `${DOC} .blist > .brow >> nth=${i} >> .brow-main`;

/** High-street coffee roaster's form (the mockup's #case), one field picked by focusing it. */
async function harbour(ctx: Ctx, focus?: string) {
	await open(ctx.page, ctx.site.origin, '/admin/case-studies/high-street-coffee');
	await ctx.page.waitForSelector(FORM);
	if (focus) await ctx.page.focus(`${FORM} ${focus}`);
}
/** The footer as its own document (#shared-doc), one of its links open. */
async function footer(ctx: Ctx, item: number) {
	await open(ctx.page, ctx.site.origin, '/admin/shared/footer');
	await ctx.page.waitForSelector(FORM);
	await ctx.page.click(`${FORM} [data-ff="links"] .item-sum >> nth=${item}`);
	await ctx.page.waitForSelector(`${FORM} [data-ff="links"] .item.is-open`);
}
/** The open document's "…" menu, then its Delete. */
async function deleteDialog(ctx: Ctx, path: string, dialog = 'delete') {
	await open(ctx.page, ctx.site.origin, path);
	await ctx.page.click(`${SHOWN} [data-act="doc-menu"]`);
	await ctx.page.click('[data-act="delete-document"]');
	await ctx.page.waitForSelector(`[data-dialog="${dialog}"]`);
}
/** New page from the documents level: its name, and where it sits. */
async function newPage(ctx: Ctx, name: string, inside: string, group?: string) {
	await docs(ctx);
	await ctx.page.click(`${DOCS} [data-act="new-page"]`);
	await ctx.page.waitForSelector('[data-dialog="new"]');
	await ctx.page.click('#np-inside');
	await ctx.page.click(`[data-inside-pick="${inside}"]`);
	if (group !== undefined) await ctx.page.fill('#np-group', group);
	await ctx.page.fill('#np-name', name);
}
async function groupMenu(ctx: Ctx) {
	await docs(ctx);
	const group = `${DOCS} [data-tnode-group="services"]`;
	await ctx.page.hover(group);
	await ctx.page.click(`${group} [data-act="group-menu"]`);
	await ctx.page.waitForSelector(`${group} .menu`);
}
async function newCase(ctx: Ctx, name: string) {
	await open(ctx.page, ctx.site.origin);
	await toDocs(ctx.page);
	await ctx.page.click(`${DOCS} [data-coll="case-studies"]`);
	await ctx.page.click('[data-pane-level="collection"] [data-act="new-document"]');
	await ctx.page.waitForSelector('[data-dialog="new"]');
	await ctx.page.fill('#np-name', name);
}

/** Another person in their own browser context (closed when the state ends). */
async function as(ctx: Ctx, email: string, path: string): Promise<Page> {
	const context = await ctx.browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
	ctx.extra.push(context);
	await context.addCookies([cookieFor(ctx.site, email)]);
	return openAdmin(context, ctx.site, path);
}

// ─── Sample content, written into the throwaway copy only ───────────────────

const edit = (site: DevSite, file: string, change: (doc: Record<string, any>) => void) => {
	const doc = JSON.parse(site.read(file)) as Record<string, any>;
	change(doc);
	site.write(file, `${JSON.stringify(doc, null, 2)}\n`);
};
const HOME = 'content/pages/index.json';
const HARBOUR = 'content/case-studies/high-street-coffee.json';
const FOOTER = 'content/shared/footer.json';
const SETTINGS = 'content/site-settings.json';
const block = (doc: Record<string, any>, type: string) => (doc.blocks as Record<string, any>[]).find((b) => b.type === type)!;

export const STATES_M5A: State[] = [
	// ── Fields: a case study ──
	{ id: 'case', m5a: true, roots: WITH_OVERLAYS, ours: (ctx) => harbour(ctx, '[data-ff="summary"] textarea') },
	{
		id: 'date',
		m5a: true,
		roots: EDITOR,
		keepFocus: true,
		ours: async (ctx) => {
			await harbour(ctx);
			await ctx.page.click(`${FORM} [data-ff="launched"] button[aria-haspopup="dialog"]`);
			await ctx.page.waitForSelector(`${FORM} [data-ff="launched"] .cal [role="grid"]`);
		},
	},
	{
		id: 'rich-text',
		m5a: true,
		roots: EDITOR,
		keepFocus: true,
		ours: async (ctx) => {
			await harbour(ctx);
			await ctx.page.click(`${FORM} [data-ff="body"] .ProseMirror h2`);
			await ctx.page.click(`${FORM} [data-ff="body"] .tb-style`);
			await ctx.page.waitForSelector(`${FORM} [data-ff="body"] .tb .menu`);
		},
	},
	{
		id: 'rich-link',
		m5a: true,
		roots: EDITOR,
		keepFocus: true,
		ours: async (ctx) => {
			await harbour(ctx);
			await ctx.page.dblclick(`${FORM} [data-ff="body"] .ProseMirror p >> nth=0`, { position: { x: 4, y: 8 } });
			await ctx.page.keyboard.press('Meta+k');
			await ctx.page.waitForSelector(`${FORM} [data-ff="body"] .lpop`);
			await ctx.page.keyboard.type('pri');
		},
	},
	{
		id: 'list',
		m5a: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await harbour(ctx);
			await ctx.page.click(`${FORM} [data-ff="credits"] .item-sum >> nth=1`);
			await ctx.page.waitForSelector(`${FORM} [data-ff="credits"] .item.is-open`);
		},
	},
	{
		id: 'list-removed',
		m5a: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await harbour(ctx);
			await ctx.page.focus(`${FORM} [data-ff="credits"] .item-sum >> nth=1`);
			await ctx.page.keyboard.press('Backspace');
			await ctx.page.waitForSelector('#toast-root .toast');
		},
	},
	{
		id: 'reference',
		m5a: true,
		roots: EDITOR,
		keepFocus: true,
		ours: async (ctx) => {
			await harbour(ctx);
			await ctx.page.click(`${FORM} [data-ff="related"] .lnk .linkbtn`);
			await ctx.page.waitForSelector(`${FORM} [data-ff="related"] .lpop`);
			await ctx.page.keyboard.type('m');
		},
	},
	{
		id: 'reference-missing',
		m5a: true,
		roots: EDITOR,
		setup: (site) => edit(site, HARBOUR, (d) => d.related.splice(1, 0, 'the-sea-shed')),
		ours: async (ctx) => {
			await harbour(ctx);
			await ctx.page.focus(`${FORM} [data-ff="related"] .refs > [data-row] >> nth=0`);
		},
	},
	// ── Fields on pages ──
	{
		id: 'buttons-half',
		m5a: true,
		roots: EDITOR,
		setup: (site) =>
			edit(site, HOME, (d) => {
				block(d, 'hero').buttons = [
					{ label: 'See the work', href: '/work', style: 'primary' },
					{ label: 'Start a project', href: '', style: 'secondary' },
				];
			}),
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await ctx.page.click(row(0));
			await ctx.page.focus(`${BLOCK} [data-ff="buttons"] [data-path="buttons.1.label"]`);
		},
	},
	{
		id: 'number-range',
		m5a: true,
		roots: EDITOR,
		setup: (site) => edit(site, HOME, (d) => (block(d, 'cases').count = 14)),
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await ctx.page.click(row(3));
			await ctx.page.focus(`${BLOCK} [data-ff="count"] input`);
		},
	},
	{
		id: 'rich-warn',
		m5a: true,
		roots: EDITOR,
		// The demo's Text body allows H2 and H3, so the kind it doesn't allow is an H1 (never allowed, Decision 3).
		setup: (site) => edit(site, HOME, (d) => (block(d, 'text').body = [{ h1: 'Twelve years in' }, { p: 'We start with the words, then the type, then everything else.' }])),
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await ctx.page.click(row(1));
			await ctx.page.focus(`${BLOCK} [data-ff="body"] .ProseMirror`);
		},
	},
	// ── Shared blocks ──
	{
		id: 'shared',
		m5a: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await ctx.page.click(`${DOC} .blist > .brow[data-shared="footer"] .brow-main`);
			await ctx.page.waitForSelector('[data-shared-panel]');
		},
	},
	{
		id: 'shared-list',
		m5a: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await toDocs(ctx.page);
			await ctx.page.click(`${DOCS} [data-section="site-wide"] [data-coll="shared"]`);
			await ctx.page.waitForSelector('[data-pane-level="collection"] [data-doc="shared/footer"]');
		},
	},
	{
		id: 'new-shared',
		m5a: true,
		roots: DIALOG,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await toDocs(ctx.page);
			await ctx.page.click(`${DOCS} [data-section="site-wide"] [data-coll="shared"]`);
			await ctx.page.click('[data-pane-level="collection"] [data-act="new-document"]');
			await ctx.page.waitForSelector('[data-dialog="new-shared"]');
			await ctx.page.click('[data-dialog="new-shared"] [role="radio"][data-type="cta"]');
			await ctx.page.fill('#ns-name', 'Client quote');
		},
	},
	{ id: 'shared-doc', m5a: true, roots: EDITOR, ours: (ctx) => footer(ctx, 0) },
	{
		id: 'link-missing',
		m5a: true,
		roots: EDITOR,
		setup: (site) => edit(site, FOOTER, (d) => d.block.links.push({ label: 'Newsletter', href: '/newsletter' })),
		ours: (ctx) => footer(ctx, 3),
	},
	{
		id: 'link-bad',
		m5a: true,
		roots: EDITOR,
		setup: (site) => edit(site, FOOTER, (d) => (d.block.links[1].href = 'are.na/example')),
		ours: (ctx) => footer(ctx, 1),
	},
	{ id: 'shared-delete', m5a: true, roots: DIALOG, ours: (ctx) => deleteDialog(ctx, '/admin/shared/footer', 'in-use') },
	{
		id: 'picker-shared',
		m5a: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/pages/contact');
			await ctx.page.click(`${DOC} .add-row`);
			await ctx.page.waitForSelector('[data-section="shared-blocks"]');
			await ctx.page.evaluate(() => {
				const body = document.querySelector<HTMLElement>('.side-level:not([hidden]) .side-body');
				if (body) body.scrollTop = body.scrollHeight;
			});
		},
	},
	// ── Site Settings ──
	{
		id: 'settings',
		m5a: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/settings');
			// Edit in context, Decision 9: over Home, undimmed (the head says so).
			await ctx.page.waitForSelector(`${DOC} .cur .sub`);
		},
	},
	{
		id: 'settings-public',
		m5a: true,
		roots: EDITOR,
		keepFocus: true,
		setup: (site) => edit(site, SETTINGS, (d) => d.editors.push('@gmail.com')),
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/settings');
			await ctx.page.fill('#ed-new', '@outlook.com');
			await ctx.page.waitForSelector('#ed-err');
		},
	},
	{
		// Live: removing your own address asks first, so the editor has to know who you are.
		id: 'settings-self',
		m5a: true,
		live: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/settings');
			await ctx.page.click(`${FORM} .ed[data-editor="niamh@example.com"] .ib`);
			await ctx.page.waitForSelector('[data-note="remove-self"]');
		},
	},
	// ── Creating and deleting ──
	{ id: 'new-page', m5a: true, roots: DIALOG, ours: (ctx) => newPage(ctx, 'Packaging', 'services') },
	{ id: 'new-group', m5a: true, roots: DIALOG, ours: (ctx) => newPage(ctx, 'Risograph', '__new', 'Workshops') },
	{
		id: 'address-taken',
		m5a: true,
		roots: DIALOG,
		setup: (site) => site.write('content/pages/services/packaging.json', '{\n  "title": "Packaging",\n  "blocks": []\n}\n'),
		ours: async (ctx) => {
			await newPage(ctx, 'Packaging', 'services');
			await ctx.page.waitForSelector('#np-err');
		},
	},
	{ id: 'group-menu', m5a: true, roots: EDITOR, keepFocus: true, ours: groupMenu },
	{
		id: 'group-page',
		m5a: true,
		roots: DIALOG,
		ours: async (ctx) => {
			await groupMenu(ctx);
			await ctx.page.click(`${DOCS} [data-tnode-group="services"] [data-act="group-page"]`);
			await ctx.page.waitForSelector('[data-dialog="new"]');
		},
	},
	{ id: 'new-case', m5a: true, roots: DIALOG, ours: (ctx) => newCase(ctx, 'Seaweed Baths') },
	{
		// Live: the "New" chip is the waiting list's (a document not on `main` yet).
		id: 'new-case-open',
		m5a: true,
		live: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await newCase(ctx, 'Seaweed Baths');
			await ctx.page.click('[data-dialog="new"] [data-act="create"]');
			await eventually(() => new URL(ctx.page.url()).pathname === '/admin/case-studies/seaweed-baths', 10_000, 'it opens');
			await ctx.page.waitForSelector(`${SHOWN} .cur .chip.waiting`, { timeout: 15_000 });
		},
	},
	{ id: 'delete-page', m5a: true, roots: DIALOG, ours: (ctx) => deleteDialog(ctx, '/admin/pages/contact') },
	{
		id: 'delete-parent',
		m5a: true,
		roots: DIALOG,
		// The mockup's Services page has a heading block; so does this one.
		setup: (site) =>
			site.write(
				'content/pages/services.json',
				`${JSON.stringify({ title: 'Services', blocks: [{ type: 'text', heading: 'What we do', body: 'Names and marks, things in print, and sites you can edit yourself.', background: 'light' }] }, null, 2)}\n`,
			),
		ours: async (ctx) => {
			await deleteDialog(ctx, '/admin/pages/services');
			await ctx.page.waitForSelector('[data-dialog="delete"] [data-kids]');
		},
	},
	{
		id: 'home-menu',
		m5a: true,
		roots: EDITOR,
		keepFocus: true,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin);
			await ctx.page.click(`${SHOWN} [data-act="doc-menu"]`);
			await ctx.page.waitForSelector('[data-why="delete"]');
		},
	},
	{
		// Live: Aoife has Contact open with a change, so its Delete is refused.
		id: 'delete-locked',
		m5a: true,
		live: true,
		roots: EDITOR,
		keepFocus: true,
		ours: async (ctx) => {
			const contact = await as(ctx, AOIFE, '/admin/pages/contact');
			await contact.click(`${DOC} .brow-main >> nth=0`);
			const field = contact.locator(`${BLOCK} textarea, ${BLOCK} input.input`).first();
			await field.fill('Contact, edited by Aoife.');
			await eventually(async () => (await keepState(contact)) === 'kept', 10_000, 'Kept');
			await open(ctx.page, ctx.site.origin, '/admin/pages/contact');
			await ctx.page.waitForSelector(`${SHOWN} [data-note="locked"]`);
			await ctx.page.click(`${SHOWN} [data-act="doc-menu"]`);
			await ctx.page.waitForSelector('[data-why="delete"]');
		},
	},
	{
		id: 'deleted',
		m5a: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await deleteDialog(ctx, '/admin/pages/contact');
			await ctx.page.click('[data-act="confirm-delete"]');
			await eventually(async () => (await ctx.page.getAttribute('#side', 'data-level')) === 'documents', 10_000, 'the documents level');
			await ctx.page.waitForSelector('#toast-root .toast');
			await openGroups(ctx.page, ['pages:about', 'pages:services']);
		},
	},
	{
		// Live: a new page, a deleted one and Site Settings waiting, with Home's intro picked (the mockup's field).
		id: 'waiting-docs',
		m5a: true,
		live: true,
		roots: ['side', 'bar', 'pops'],
		ours: async (ctx) => {
			await newPage(ctx, 'Packaging', 'services');
			await ctx.page.click('[data-dialog="new"] [data-act="create"]');
			await eventually(() => new URL(ctx.page.url()).pathname === '/admin/pages/services/packaging', 10_000, 'Packaging opens');
			await deleteDialog(ctx, '/admin/pages/contact');
			await ctx.page.click('[data-act="confirm-delete"]');
			await eventually(async () => (await ctx.page.getAttribute('#side', 'data-level')) === 'documents', 10_000, 'the documents level');
			await open(ctx.page, ctx.site.origin, '/admin/settings');
			await ctx.page.fill('#ed-new', 'dara@example.org');
			await ctx.page.click('[data-form="editor"] button[type="submit"]');
			await eventually(async () => (await keepState(ctx.page)) === 'kept', 10_000, 'Kept');
			await open(ctx.page, ctx.site.origin);
			await desktop(ctx.page).locator('[data-cms-block="0"] [data-cms-field="heading"]').first().click();
			await ctx.page.click(`${BLOCK} [data-ff="intro"] textarea`);
			await eventually(async () => /3 waiting/.test((await ctx.page.textContent('.bar [data-slot="publish"]')) ?? ''), 15_000, '3 waiting');
			await ctx.page.click('.bar [data-slot="publish"]');
			await ctx.page.waitForSelector('[data-pop="waiting"] .wlist');
		},
	},
];

// ─── Accepted differences ────────────────────────────────────────────────────

const M4 = "an M4 place (presence, waiting, Publish, locks) that local mode leaves empty, as in M3's states";
const SAMPLE = "the mockup's sample content, not a difference in the design (its site has blocks, fields and documents the demo doesn't)";
const M5B = "M5b's media (the case study's cover, a block's background image) is compared in M5b's group (mockup-diff-m5b.ts: alt-missing, case-cover, media-only, hero-image), with its own accepted differences";
/** The mockup's sample accent (navy #1f2f57) and the demo's own (its green). */
const NAVY = /rgb\(31, 47, 87\)/;

/**
 * Review gaps, after the older mockups: three things this build changed on purpose,
 * drawn in its own mockup (packages/caracms/test/mockups/review-gaps.html: #forms-settings, #order-site, #state-first), so the
 * older mockups' states differ from /admin exactly here. M5b's and M6's states take these too.
 */
export const ALLOW_REVIEW_GAPS: Allow[] = [
	{ state: /^settings/, key: /side-body > section\.set-sec > div\.field > div\.presets > span\.presets-sep$/, kind: 'extra', reason: "editor restyle, Decision 9 (a): the fixture stores a colour from before the presets (#1f3a2e), so the picker draws \"Current\" and its divider first, where the mockup's settings states, on navy, don't (#settings-accent-custom draws it)" },
	{ state: /^settings/, key: /side-body > section\.set-sec > div\.field\.rcpt$/, kind: 'missing', reason: 'review gaps, Decision 9: Site Settings\' "Form emails" became "Forms", a group per form with its words, then its emails (review-gaps.html#forms-settings)' },
	{ state: /^settings/, key: /side-body > section\.fm-sec\.set-sec$/, kind: 'extra', reason: 'review gaps, Decision 9: the Forms section (review-gaps.html#forms-settings), in place of the older mockups\' Form emails field' },
	{ state: /^new-case$/, key: /div\.side-body > div > button\.drow$/, kind: 'missing', reason: 'review gaps, Decision 3: a hand-ordered collection\'s list is the Site order list (review-gaps.html#order-site), not plain document rows' },
	{ state: /^new-case$/, key: /div\.side-body > div > (div\.ord-h|ul\.olist|p\.kb-hint)$/, kind: 'extra', reason: 'review gaps, Decision 3: a hand-ordered collection\'s list has the "Site order" heading, the draggable rows and the keyboard hint (review-gaps.html#order-site)' },
	{ state: /^form-block/, key: /div\.side-body > div\.(reads|states-line)$/, kind: 'extra', reason: 'review gaps, Decisions 7 and 14: a block with states names them ("Also shows Sent, Couldn\'t send and Invalid") and the form\'s words row ("Words from Site Settings › Forms › Contact", review-gaps.html#state-first)' },
];

export const ALLOW_M5A: Allow[] = [
	...ALLOW_REVIEW_GAPS,
	// ── M6c (after M5a's mockups): the link picker and a button's link row offer a File… choice (mockup m6c-downloads-grid.html → #link-pop) ──
	{ state: /^rich-link$/, key: /lpop > div\.find$/, kind: 'missing', reason: "M6c (m6c mockup #link-pop): the link picker's search box sits in a top row (div.top) beside the File… button, so the mockup's bare div.find is not a direct child" },
	{ state: /^rich-link$/, key: /lpop > div\.top$/, kind: 'extra', reason: "M6c (m6c mockup #link-pop): the picker's top row holds the search box and the File… button (choose a file in the library to link to)" },
	{ state: /^buttons-half$/, key: /btnf\.is-half > div\.lnk$/, kind: 'missing', reason: "M6c (m6c mockup #link-pop): a button's link is a row (div.lnk-row) holding the link field and the File… button, in place of the mockup's bare div.lnk" },
	{ state: /^buttons-half$/, key: /btnf\.is-half > div\.lnk-row$/, kind: 'extra', reason: "M6c (m6c mockup #link-pop): a button's link row holds the link field and the File… button" },
	{ state: /^link-bad$/, key: /items > div\.is-open\.item > div\.item-b > div\.is-bad\.lnk$/, kind: 'missing', reason: "M6c (m6c mockup #link-pop): a list item's link is a row (div.lnk-row) holding the link field and the File… button, in place of the mockup's bare div.lnk" },
	{ state: /^link-bad$/, key: /items > div\.is-open\.item > div\.item-b > div\.lnk-row$/, kind: 'extra', reason: "M6c (m6c mockup #link-pop): a list item's link row holds the link field and the File… button" },
	// ── High-street coffee roaster (0.3.2, after M5a's mockups): Inside is a searchable tree, not a select ──
	{ state: /^(new-page|new-group|address-taken)$/, key: /dialog > div\.field > select\.input$/, kind: 'missing', reason: "High-street coffee roaster (2026-10-24): once Inside offered every page, a select grew too long to use, so it's a field that opens a searchable tree (documents/InsidePicker.tsx)" },
	{ state: /^(new-page|new-group|address-taken)$/, key: /dialog > div\.field > div\.inside-pick$/, kind: 'extra', reason: "High-street coffee roaster (2026-10-24): Inside's field (the chosen place and its address), which opens the searchable tree in place of the mockup's select" },
	// ── As in M3's and M4's states, for the same reasons ──
	{ key: /\.(av|dot|pub|me|avs|lock|who)\b/, state: /^(?!settings-self|delete-locked|waiting-docs|new-case-open)/, reason: M4 },
	{ key: /(logo-slot|si-logo) > (svg|img)$/, reason: "the site's logo is a file its config names, drawn as an <img> (the mockup inlines its sample SVG)" },
	{ root: 'overlays', prop: /^font-family$/, key: /./, reason: 'the layer loads the editor\'s Instrument Sans under its own name ("caracms UI")' },
	{ key: /rchip/, reason: "Recent is per browser (M3 Decision 20): a fresh browser lists only what it opened; the mockup's strip is a sample" },
	{ key: /note[.\w-]*\.warn[.\w-]* > svg\.i$|wmark > svg|toast > button\.btn\.sm > svg/, kind: 'style', prop: /color$/, reason: "contrast (M3 Phase 5, icons 3:1): the warning mark and a warning note's icon take the strong warning amber; the Undo button's icon is the button's ink" },
	{ key: /span\.nm > span\.chip\.warn$|span\.meta > span\.wmark$/, kind: 'extra', reason: "the \"too long for mobile\" marks are the mockup's own (browHTML, metaFor), but its sidebar isn't redrawn after it measures the phone frame (as in M3's states)" },
	{ kind: 'style', key: /./, mock: NAVY, ours: /rgb\(31, 58, 46\)/, reason: "the demo's own brand accent (its green) where the mockup has its sample navy: the accent's slots" },
	{ kind: 'style', key: /./, prop: /^box-shadow$/, mock: /oklab\(/, ours: /oklab\(/, reason: "the editor restyle (Decision 9 (b)): an accent button's pressed edge is --edge-accent, a color-mix of the accent, which computes as oklab(…) from the mockup's navy and the demo's own green, out of the catch-all accent rule's reach" },
	{ kind: 'style', key: /\.av\b[^>]*$/, prop: /^background-color$/, reason: `${SAMPLE}: a person's colour is picked from their address (format.ts → colourOf)` },
	// The documents level: the mockup's site has other collections (its Pages tree, Journal, the counts).
	{ key: /cur-row > div$/, kind: 'missing', reason: `${SAMPLE}: the page's "…" menu is in the head row of a page, not of the mockup's sample` },
	// ── Edit in context (Decision 9): Site Settings opens over the last page, undimmed ──
	{ state: /^settings(-public|-self)?$/, root: 'stage', key: /^\(root\) > div\.stage-aside$/, kind: 'missing', reason: "edit in context, Decision 9: Site Settings shows over the last page, live and undimmed (edit-in-context.html#settings-top), replacing M5a's dimmed stage and its 'no page of its own' note" },
	{ state: /^settings(-public|-self)?$/, root: 'side', key: /^\(root\) > div\.trail > button\.lv$/, kind: 'style', prop: /^(background-color|margin-(left|right))$/, reason: "edit in context, Decision 8: over a page, the page's tab stacks above Site Settings' head (edit-in-context.html#settings-top: CaraCMS, then Home · Blocks), so the trail has a second, inner tab" },
	// ── Edit in context, the rest of what the new behaviour changes in M5a's states (Decisions 1, 8, 9, 12) ──
	{ state: /^settings-(brand|m6)$/, root: 'stage', key: /^\(root\) > div\.stage-aside$/, kind: 'missing', reason: "edit in context, Decision 9: Site Settings shows over the last page, live and undimmed (edit-in-context.html#settings-top), replacing M5a's dimmed stage and its 'no page of its own' note" },
	{ state: /^settings-(brand|m6)$/, root: 'side', key: /^\(root\) > div\.trail > button\.lv$/, kind: 'style', prop: /^(background-color|margin-(left|right))$/, reason: "edit in context, Decision 8: over a page, the page's tab stacks above Site Settings' head (edit-in-context.html#settings-top: CaraCMS, then Home · Blocks), so the trail has a second, inner tab" },
	{ state: /^(number-range|case-cards)$/, root: 'side', key: /^\(root\) > div\.side-body > div\.reads$/, kind: 'extra', reason: "edit in context, Decision 12: a block whose render read a collection shows 'Shows entries from Case studies (n) · Open' on its level (edit-in-context.html#cases-block); the earlier mockups don't have the row" },
	{ state: /^(shared-list|new-shared)$/, root: 'side', key: /^\(root\) > div\.side-body > div > (button\.drow|div\.grp)$/, reason: "edit in context, Decision 1: the Shared blocks level groups its blocks (Header, Footer, then the rest by block type), so the Footer row sits under a group head with its count; the mockup's list is flat" },
	{ state: /^(shared-doc|link-missing|link-bad|shared-delete)$/, root: 'side', key: /cur-title > span\.t > span\.crumbp$/, kind: 'missing', reason: "edit in context, Decision 8: a shared block opened over a page has its page's tab in the trail and 'open over <page>' under its title, in place of the 'Shared blocks /' crumb (edit-in-context.html#footer-top)" },
	{ state: /^(shared-doc|link-missing|link-bad|shared-delete)$/, root: 'bar', key: /seg > button > span\.(wdot|tip|sr)$/, kind: 'extra', reason: "edit in context, Decision 9: the footer opened from the list shows over the last page (Home on a fresh load), whose hero is too long for phones, so the Phone toggle has its dot; the mockup's shared block has no page" },
	// ── M5a's own, each with its reason ──
	{ state: /^settings-(public|self|brand)$/, key: /side-body > section\.set-sec > p\.field-(help|hint)$/, kind: 'extra', reason: "pre-M7 item 8: Site Settings' Redirects section (after the mockups), empty in the fixture: its line and the applies-once-published hint" },
	{ state: /^date$/, key: /div\.datef > div\.cal > div(\.cal-h|\.cal-g)?$/, reason: "pre-M7 polish: the calendar is react-day-picker's (its grid is a table, with its own keyboard and screen-reader labels), drawn as the mockup's .cal; the mockup's sample opens on March 2024, the demo's High-street coffee roaster on May 2024" },
	{ key: /> p\.field-help$/, kind: 'missing', reason: `${SAMPLE}: the mockup's fields carry help lines ("Shows in Selected work on Home.") that the demo's schema doesn't set` },
	{ state: /^settings(-public|-self)?$/, key: /div\.eds > div\.ed$/, kind: 'style', prop: /^border-top-(width|style)$/, reason: `${SAMPLE}: the rule is between rows, and the demo's editors list has one person (the mockup's has several)` },
	{ key: /p\.urlpre > button\.linkbtn\.subtle$/, kind: 'extra', reason: "Decision 11: the last part of the address can be edited before creating, so the address line has Change" },
	{ state: /^new-case$/, key: /div\.side-body > div > button\.drow > span\.meta > span$/, kind: 'missing', reason: `${SAMPLE}: a case study's year (as in M3's collection state)` },
	// The live states: the mockup's sample people and changes.
	{ state: /^(settings-self|new-case-open|delete-locked|waiting-docs)$/, root: 'bar', key: /span\.avs > span\.av\.sm$/, kind: 'style', prop: /^(margin-left|box-shadow)$/, reason: `${SAMPLE}: the mockup's waiting changes are by two people, so its avatars overlap; here one person has changes waiting` },
	{ state: /^settings-self$/, root: 'bar', key: /div\.bar-e > button\.(off\.)?pub$/, reason: `${SAMPLE}: the mockup has three changes waiting; this state starts with none` },
	{ state: /^settings-self$/, key: /div\.eds > div\.ed$/, kind: 'missing', reason: `${SAMPLE}: the demo's editors list has only Niamh, the row being removed` },
	{ state: /^settings-self$/, key: /div\.ed\.is-confirm > span\.tile > svg\.i\.i-sm$/, kind: 'extra', reason: `${SAMPLE}: the demo lists Niamh's own address (a mail icon), where the mockup lists her domain (an @)` },
	{ state: /^delete-locked$/, key: /lock\.note > div > div\.acts$/, kind: 'extra', reason: "Take over (M4 Decision 9, added during a walk on 2026-10-15, after the mockup): someone else's lock note offers it" },
	{ state: /^new-case-open$/, key: /lk-field > div\.(lk-rows > div\.lk-row|lk-status)$|seg > button > span\.(wdot|tip|sr)$/, reason: `${SAMPLE}: the mockup's new case study starts with a sample heading (too long for mobile, with the Phone toggle's dot); a new one here has an empty heading` },
	{ state: /^new-case-open$/, key: /div\.prose\.rt > p$/, kind: 'extra', reason: "an empty ProseMirror document holds one empty paragraph (the caret's place); the mockup's empty box is an empty div" },
	{ state: /^waiting-docs$/, key: /field-frame > div\.field > div\.(btnf|list-empty)$/, reason: `${SAMPLE}: the mockup's hero has a filled button; the demo's hero has an empty Buttons field (as in M3's states)` },
	{ state: /^number-range$/, key: /^\(root\) > div\.side-body$/, kind: 'order', reason: `${SAMPLE}: the demo's case-study list has a Background field after How many, so the picked field isn't the last` },
	{ state: /^rich-warn$/, key: /div\.prose\.rt > p > a$|div\.tb > button\.tb-style$/, reason: `${SAMPLE}: the demo's Text body allows H2 and H3 (so it has the style menu, and the heading it doesn't allow is an H1), and has no link in its first paragraph` },
	{ state: /^shared-doc$/, key: /side-body > div\.field-frame(\.is-picked)?( > div\.field > (div\.field-head > span\.field-label|div\.items|div\.list-foot))?$/, reason: "opening a list item focuses its row, and focus picks its field (Decision 13, M3's field frame), so Links is the picked field; the mockup opens the item with nothing picked" },
	{ key: /field-head > span\.field-meta$/, kind: 'missing', reason: "a field with a maximum shows a count; the demo's fields set none (as in M3's states)" },
	{ key: /field-head > span\.field-label$/, kind: 'extra', reason: "a field that's a group of inputs (Buttons, Related work) is named by a span, not a <label> with nothing to point at (the mockup's buttons and refs fields have a <label for> whose input doesn't exist)" },
	{ key: /field-frame\.is-picked > div\.field > div\.field-head > label$/, kind: 'missing', state: /^(reference|reference-missing|buttons-half)$/, reason: "the picked field is a group of inputs, named by a span (the same difference, on the picked frame)" },
	{ key: /div\.tb > button > i(\.tb-i)?$/, reason: "the italic button's Georgia is a class (.tb-i), not an inline style: the editor's CSP allows no inline styles" },
	{ key: /div\.tb > div\.menu > button > span\.st-h3$/, kind: 'missing', reason: `${SAMPLE}: the demo's case-study Story allows H2 only (headings: ['h2']); the mockup's allows H2 and H3` },
	{ state: /^(rich-text|rich-link)$/, key: /field-frame\.is-picked > div\.field > div\.prose-wrap$/, kind: 'style', prop: /^(border-\w+-color|box-shadow)$/, reason: "the caret is in the field (the style menu and the link popover open from it), so it has its focus ring; the mockup's drawing has no focus" },
	{ state: /^(reference|rich-link)$/, key: /lpop > div\.find > input\.input$/, kind: 'style', prop: /^(border-\w+-color|box-shadow)$/, reason: "the picker's search box has focus as it opens (type to find); the mockup's has none" },
	{ state: /^reference$/, key: /lpop > div(\.lpop-list)? > button\.drow\.is-active$/, kind: 'extra', reason: "the picker's keyboard highlight on its first hit (Enter picks it), a wash, as the switcher's (M3 Phase 4)" },
	{ state: /^reference$/, key: /lpop > div(\.lpop-list)? > button\.drow > span\.meta > span > span\.mono$/, kind: 'extra', reason: `${SAMPLE}: a hit shows the document's address (any collection's); the mockup's case-study hits show a year` },
	// Rich text: Tiptap's (ProseMirror's) document, and the mockup's drawing devices.
	{ key: /div\.prose\.rt( > [\w.-]+)*$/, kind: 'style', prop: /^white-space$/, mock: /^normal$/, ours: /^pre-wrap$/, reason: "ProseMirror sets white-space: pre-wrap on its editable element (it needs it for spaces and breaks); the mockup's contenteditable is a plain div" },
	{ key: /div\.prose\.rt > ul > li > p$/, kind: 'extra', reason: "ProseMirror's list item holds a paragraph (its schema: li > p); it's unstyled, so the item looks as the mockup's" },
	{ key: /div\.prose\.rt > (h3|h2 > br|p > strong|h2)$/, kind: 'missing', reason: `${SAMPLE}: the mockup's Story has an H3 and no break in its H2; the demo's has a two-line H2, bold and a list` },
	{ key: /div\.prose\.rt > (h2 > br|p > strong|ul > li > p)$/, kind: 'extra', reason: `${SAMPLE}: the demo's Story has a two-line H2 (a <br>), bold "ferry signs" and a list` },
	{ state: /^rich-text$/, key: /div\.prose\.rt > (h2\.is-caret|h2)$/, reason: "the mockup marks the caret's heading with a class to draw it (.is-caret); the editor's caret is the browser's own" },
	{ state: /^rich-link$/, key: /div\.prose\.rt > p > span\.rt-sel$/, kind: 'missing', reason: "the mockup draws the selected word with a class (.rt-sel); the editor's selection is the browser's own" },
	{ key: /div\.refs > div\.ref > span\.yr$/, kind: 'missing', reason: `${SAMPLE}: the mockup's references show a case study's year; a reference shows any collection's documents by title and address` },
	{ key: /fgroup|mk-later/, reason: "the case study's \"Search and sharing\" group is M6's (the mockup marks it \"M6 · not in M5a\"), so it isn't built" },
	{ key: /media|i-image/, reason: M5B },
	// Pre-M7 item 8, after the mockups: Change address… in the document menu (off, with its reason, for Home and while someone else edits), and Site Settings' Redirects section.
	{ state: /^(home-menu|delete-locked)$/, key: /div\.menu > button( > svg\.i)?$/, kind: 'style', prop: /^(color|cursor)$/, reason: "pre-M7 item 8: the menu's Change address… row (not in the mockup) is off for Home and while someone else is editing, so the rows line up differently" },
	{ state: /^(home-menu|delete-locked)$/, key: /div\.menu$/, kind: 'order', reason: "pre-M7 item 8: Change address… and its reason sit between View on the live site and Delete, which the mockup's menu doesn't have" },
	{ state: /^settings(-m6)?$/, key: /side-body > section\.set-sec > p\.field-(help|hint)$/, kind: 'extra', reason: "pre-M7 item 8: Site Settings' Redirects section (after the mockups), empty in the fixture: its line and the applies-once-published hint" },
	{ state: /^shared-list$/, root: 'stage', key: /^\(root\) > div\.stage-table$|^\(root\) > div(\.boxed)?\.frame(\.on)?( > iframe)?$/, reason: "pre-M7 polish: a flat collection's level shows its documents as a table over the stage in place of the preview (the 'table over the stage', after the mockup, which has no state for it); the preview's frames are hidden under it" },
];
