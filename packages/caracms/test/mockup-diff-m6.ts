/**
 * The M6 states for the visual pass's check (M6, carrier B), run by mockup-diff.ts beside
 * the others (`--m6`): every state the mockup's switcher tags M6 (the inbox, Search and
 * sharing, the Form block, Site Settings' publish-time fields) against /admin in the same
 * state. Their accepted differences, each with its reason, are `ALLOW_M6`.
 *
 * Every state runs in local mode with the in-memory submissions store
 * (`CARACMS_SUBMISSIONS=memory`, set by mockup-diff.ts for the whole run), emptied and
 * seeded before each inbox state with messages like the mockup's sample: unread ones, files,
 * a failed email, skipped ones, one whose outcome is unknown, and enough older ones that the
 * list has Older. The demo's content is never changed: a state that needs other sample
 * content (a page's `seo`, recipients) writes it into the throwaway copy in its `setup`.
 */
import type { Page } from 'playwright-core';
import type { DevSite } from './helpers/dev-site.ts';
import { resetSubmissions, submissionStore, type StoredSubmission, type SubmissionStore } from '../src/forms/store.ts';
import type { Allow, Ctx, Root, State } from './mockup-diff.ts';
import { ALLOW_M5A } from './mockup-diff-m5a.ts';
import { ALLOW_M5B, LIB } from './mockup-diff-m5b.ts';

const SHOWN = '.side-level:not([hidden])';
const SIDE = '#side';
const DOCS = '[data-pane-level="documents"]';
const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const INBOX = '[data-pane-level="submissions"]';

const EDITOR: Root[] = ['side', 'bar', 'pops', 'toast', 'stage'];
const WITH_MODAL: Root[] = [...EDITOR, 'modal'];

// ─── The sample inbox (the in-memory store) ─────────────────────────────────

const store = (): SubmissionStore => submissionStore({ kind: 'memory' }) as SubmissionStore;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const RESEND_FAIL = 'The example.com domain is not verified. Please, add and verify your domain on https://resend.com/domains';
const NO_ONE = "No one is set to get the Riso workshop form's emails (Site Settings → Form emails).";

/** The mockup's sample, newest first (s1…s10), then older ones so the list has Older. Returns the ids by sample name. */
async function seedInbox(): Promise<Record<string, string>> {
	resetSubmissions();
	const ids: Record<string, string> = {};
	const add = async (key: string, at: string, form: 'contact' | 'workshop', fields: Record<string, string>, opts: { files?: [string, number][]; email?: StoredSubmission['email'] | null; read?: boolean } = {}) => {
		const s = await store().create({ form, receivedAt: at, fields, files: (opts.files ?? []).map(([name, size]) => ({ name, type: '', data: new Uint8Array(size) })) });
		if (opts.email !== null) await store().update(s.id, { email: opts.email ?? { status: 'sent', at, to: ['niamh@example.com', 'studio@example.com'] } });
		if (opts.read) await store().update(s.id, { readAt: at });
		ids[key] = s.id;
	};
	const contact = (name: string, email: string, kind: string, message: string, phone = '') => ({ name, email, phone, kind, message });
	const workshop = (given: string, family: string, email: string, date: string, places: string, notes: string) => ({ given, family, email, date, places, notes });
	// Older ones first (ids sort by time): 42 read messages from a fortnight back and more.
	for (let i = 0; i < 42; i++) await add(`old${i}`, ago(60 * 24 * 14 + i * 60), 'contact', contact(`Earlier visitor ${i + 1}`, `visitor${i + 1}@example.org`, 'print', 'An older message.'), { read: true });
	await add('s10', ago(60 * 24 * 9), 'workshop', workshop('Ronan', 'D.', 'ronan@example.com', '2026-11-08', '3', 'Is there parking nearby?'), { email: { status: 'skipped', at: ago(60 * 24 * 9), to: [], error: NO_ONE }, read: true });
	await add('s9', ago(60 * 24 * 7), 'contact', contact('Brigid', 'brigid@example.com', 'identity', 'We’re renaming the garden centre in the spring and would love to talk it through with you.'), { read: true });
	await add('s8', ago(60 * 24 * 6), 'contact', contact('Liam', 'liam@example.com', 'print', 'Do you print on card thicker than 300gsm? We want invitations for the shop’s fiftieth.'), { email: null, read: true });
	await add('s7', ago(60 * 24 * 3), 'contact', contact('Hannah', 'hannah@example.com', 'website', 'We need a new site for the clinic with online booking. The three pages we like are in the PDF, and our logo files are attached.', '086 993 0417'), { files: [['Sites we like.pdf', 3_984_000], ['logo.png', 98_000]], read: true });
	await add('s6', ago(60 * 24 * 2), 'workshop', workshop('Ruairí', 'B.', 'ruairi@example.com', '2026-11-08', '1', ''), { email: { status: 'skipped', at: ago(60 * 24 * 2), to: [], error: NO_ONE }, read: true });
	await add('s5', ago(60 * 26), 'contact', contact('Marta', 'marta@example.com', 'other', 'Would you give a short talk at our season launch on 7 November? Twenty minutes on how you work, and there will be wine.'), { read: true });
	await add('s4', ago(60 * 22), 'contact', contact('Declan', 'declan@example.com', 'print', 'Following up on our call: the shop needs 500 of the folded price lists by the 30th. The artwork is attached, same as last spring with the new prices.', '021 455 1180'), { files: [['Shop price list Oct.pdf', 2_200_000]], read: true });
	await add('s3', ago(50), 'workshop', workshop('Grace', 'M.', 'grace@example.com', '2026-11-22', '2', "Two places for my daughter and me, if there's room. We've never used a risograph but she draws all the time."), { email: { status: 'skipped', at: ago(50), to: [], error: NO_ONE } });
	await add('s2', ago(30), 'contact', contact('Tomás', 'tomas@example.com', 'identity', "Hi, I'm opening a bakery on the main street in March and need a name, a sign and bags. I saw what you did for the bakery and would love a chat."), { email: { status: 'failed', at: ago(30), to: ['niamh@example.com'], error: RESEND_FAIL } });
	await add('s1', ago(5), 'contact', contact('Saoirse', 'saoirse@example.com', 'website', "We're a surf school in Lahinch and our site is held together with tape. We'd love something we can update ourselves: lesson times, the weather line, a few photos each week.\n\nOur brief and some photos of the van are attached. No rush before Christmas.", '087 214 5590'), { files: [['Surf shop brief v2.pdf', 1_468_000], ['van-at-the-strand.jpg', 395_000]] });
	return ids;
}

// ─── Sample content, written into the throwaway copy only ───────────────────

const edit = (site: DevSite, file: string, change: (doc: Record<string, any>) => void) => {
	const doc = JSON.parse(site.read(file)) as Record<string, any>;
	change(doc);
	site.write(file, `${JSON.stringify(doc, null, 2)}\n`);
};
const CONTACT = 'content/pages/contact.json';
const HARBOUR = 'content/case-studies/high-street-coffee.json';
const SETTINGS = 'content/site-settings.json';
/** The mockup's CONTACT_SEO: a title, a description and a share image with a focal point. */
const contactSeo = (title = 'Contact CaraCMS, a design studio in Cork') => (site: DevSite) =>
	edit(site, CONTACT, (d) => {
		d.seo = { title, description: 'Write to us about a name, a website or a print run. We’re up the stairs on the quay, Cork, and open to visitors on Fridays.', image: { key: LIB.door, w: 3024, h: 4032, focal: [0.55, 0.2] } };
	});

// ─── Driving /admin ──────────────────────────────────────────────────────────

async function open(page: Page, origin: string, path = '/admin') {
	await page.goto(origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	await page.evaluate(() => document.fonts.ready);
}
const sideBottom = (page: Page) => page.evaluate(() => document.querySelector(`#side .side-level:not([hidden]) .side-body`)?.scrollTo(0, 1e6));
async function pickField(page: Page, frame: string) {
	await page.locator(`${frame} :is(button, input, textarea, select, [tabindex]):not([disabled]) >> nth=0`).focus();
	await page.waitForSelector(`${frame}.is-picked`);
	await page.locator(frame).scrollIntoViewIfNeeded();
}
/** Contact, then Site-wide → Submissions (the mockup's subsState: the inbox over Contact). */
async function inbox(ctx: Ctx, open1?: string) {
	await open(ctx.page, ctx.site.origin, '/admin/pages/contact');
	if (!(await ctx.page.isVisible(DOCS))) await ctx.page.click(`${SHOWN} .lv >> nth=0`);
	await ctx.page.click(`${SIDE} [data-act="open-subs"]`);
	await ctx.page.waitForSelector(`${INBOX} :is(.srow, .empty, [data-note="submissions-off"])`);
	if (open1) {
		await ctx.page.click(`${INBOX} .srow[data-id="${open1}"]`);
		await ctx.page.waitForSelector(`#stage-aside .sub-sheet[data-submission="${open1}"]`);
	}
}
/** The sample's ids by name (s1…s10), set as each inbox state seeds the store. */
let ids: Record<string, string> = {};
const seeded = (run: (ctx: Ctx) => Promise<void>): Pick<State, 'ours'> => ({
	ours: async (ctx) => {
		ids = await seedInbox();
		await run(ctx);
	},
});
/** Contact's block `index` from its document level, with `field` picked. */
async function contactBlock(ctx: Ctx, index: number, field: string) {
	await open(ctx.page, ctx.site.origin, '/admin/pages/contact');
	await ctx.page.click(`${DOC} .blist > .brow >> nth=${index} >> .brow-main`);
	await ctx.page.waitForSelector(`${BLOCK} .field-frame`);
	await pickField(ctx.page, `${BLOCK} [data-ff="${field}"]`);
}
async function openSeo(page: Page) {
	await page.click(`${SHOWN} details.seo > summary`);
	await page.waitForSelector(`${SHOWN} details.seo[open]`);
}

export const STATES_M6: State[] = [
	// ── Submissions ──
	{
		id: 'submissions-row',
		m6: true,
		roots: EDITOR,
		...seeded(async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/pages/contact');
			await ctx.page.click(`${SHOWN} .lv >> nth=0`);
			await ctx.page.waitForSelector(`${DOCS} [data-act="open-subs"] .ucnt`);
			await sideBottom(ctx.page);
		}),
	},
	{ id: 'submissions', m6: true, roots: EDITOR, ...seeded((ctx) => inbox(ctx)) },
	{ id: 'submission', m6: true, roots: EDITOR, ...seeded((ctx) => inbox(ctx, ids.s1)) },
	{ id: 'submission-failed', m6: true, roots: EDITOR, ...seeded((ctx) => inbox(ctx, ids.s2)) },
	{ id: 'submission-skipped', m6: true, roots: EDITOR, ...seeded((ctx) => inbox(ctx, ids.s3)) },
	{ id: 'submission-unknown', m6: true, roots: EDITOR, ...seeded((ctx) => inbox(ctx, ids.s8)) },
	{
		id: 'submission-delete',
		m6: true,
		roots: WITH_MODAL,
		...seeded(async (ctx) => {
			await inbox(ctx, ids.s1);
			await ctx.page.click('#stage-aside [data-act="sub-delete"]');
			await ctx.page.waitForSelector('#modal-root [data-dialog="sub-delete"]');
		}),
		keepFocus: true,
	},
	{
		id: 'submissions-older',
		m6: true,
		roots: EDITOR,
		...seeded(async (ctx) => {
			await inbox(ctx);
			await ctx.page.click(`${INBOX} [data-act="subs-older"]`);
			await ctx.page.waitForSelector(`${INBOX} .subs-foot > p.kb-hint:only-child`);
			await sideBottom(ctx.page);
		}),
	},
	{
		id: 'submissions-empty',
		m6: true,
		roots: EDITOR,
		ours: async (ctx) => {
			resetSubmissions();
			await inbox(ctx);
		},
	},
	{
		id: 'submissions-off',
		m6: true,
		roots: EDITOR,
		ours: async (ctx) => {
			resetSubmissions();
			// The production server without its bucket: the routes' 503 (forms/inbox.ts), as a dev server can't be one.
			await ctx.page.route(/\/_caracms\/submissions(\?.*)?$/, (route) =>
				route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({ error: "Form submissions aren't set up on this server.", code: 'submissions-unset', missing: ['SUBMISSIONS_S3_BUCKET', 'SUBMISSIONS_S3_ACCESS_KEY_ID', 'SUBMISSIONS_S3_SECRET_ACCESS_KEY'] }),
				}),
			);
			await inbox(ctx);
			await ctx.page.waitForSelector(`${INBOX} [data-note="submissions-off"]`);
		},
	},
	// ── Search, sharing and forms ──
	{
		id: 'seo-page',
		m6: true,
		roots: EDITOR,
		setup: contactSeo(),
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/pages/contact');
			await openSeo(ctx.page);
			await sideBottom(ctx.page);
		},
	},
	{
		id: 'seo-long',
		m6: true,
		roots: EDITOR,
		setup: contactSeo('Contact CaraCMS: a small design and print studio on the quay, Cork'),
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/pages/contact');
			await openSeo(ctx.page);
			await pickField(ctx.page, `${DOC} details.seo [data-ff="title"]`);
			await sideBottom(ctx.page);
		},
	},
	{
		id: 'seo-defaults',
		m6: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin');
			await sideBottom(ctx.page);
		},
	},
	{
		id: 'seo-case',
		m6: true,
		roots: EDITOR,
		setup: (site) => edit(site, HARBOUR, (d) => (d.seo = { image: { key: LIB.shopfront, w: 4000, h: 2667, focal: [0.62, 0.55] } })),
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/case-studies/high-street-coffee');
			await openSeo(ctx.page);
			await sideBottom(ctx.page);
		},
	},
	{ id: 'form-block', m6: true, roots: EDITOR, ours: (ctx) => contactBlock(ctx, 1, 'form') },
	{
		id: 'form-block-phone',
		m6: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await contactBlock(ctx, 1, 'heading');
			await ctx.page.click('#bar [role="radio"]:has-text("Phone")');
			await ctx.page.waitForSelector('#stage .frame.on[data-w="phone"]');
		},
	},
	{
		id: 'form-picker',
		m6: true,
		roots: EDITOR,
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/pages/contact');
			await ctx.page.click(`${DOC} .add-row`);
			await ctx.page.waitForSelector(`${SIDE} .picker-grid .ptype[data-type="form"]`);
		},
	},
	// ── Site Settings ──
	{
		id: 'settings-m6',
		m6: true,
		roots: EDITOR,
		setup: (site) => edit(site, SETTINGS, (d) => (d.formRecipients = { contact: ['niamh@example.com', 'studio@example.com'] })),
		ours: async (ctx) => {
			await open(ctx.page, ctx.site.origin, '/admin/settings');
			await ctx.page.fill('#set-gtag', '<script async src="https://www.googletagmanager.com/gtag/js?id=G-8XK2M4QZ1P"></script>');
			const contact = `${SIDE} [data-field="rcpt-contact"]`;
			// Review gaps (Decision 9): Form emails is now Forms, each form's group closed until opened.
			await ctx.page.click(`${SIDE} details[data-form-words="contact"] > summary`);
			await ctx.page.fill(`${contact} input[data-rcpt]`, 'aoife@example');
			await ctx.page.click(`${contact} button[type="submit"]`);
			await ctx.page.waitForSelector(`${contact} [data-recipient="aoife@example"]`);
			await ctx.page.evaluate(() => document.querySelector('#side [data-sec="seo"]')?.scrollIntoView({ block: 'start' }));
		},
	},
];

/**
 * M6's sample as the earlier groups' states see it (checked for every state, whatever its
 * group): since M6 the mockup draws its sample inbox and Site Settings' publish-time fields
 * in every state, where those states start with an empty inbox and the fixture's Site
 * Settings, which has no recipients and no tag.
 */
export const ALLOW_M6_ELSEWHERE: Allow[] = [
	{ state: /^(?!submission|seo-|form-|settings-m6)/, key: /button\.coll\.drow > span\.meta > span\.ucnt$/, kind: 'missing', reason: "the mockup's sample inbox has unread messages; the other groups' states start with an empty one (the in-memory store), so Submissions has no pill" },
	{ state: /^settings/, key: /div\.field\.rcpt > div\.eds$/, kind: 'missing', reason: "the mockup's sample emails the Contact form to two addresses; the fixture's Site Settings has no recipients (\"No one yet\")" },
	{ state: /^settings/, key: /div\.field\.gtag > div > p\.field-(ok|help)$/, reason: "the mockup's sample has a Google tag set; the fixture's Site Settings has none (\"Blank: the site has no tag.\")" },
];

const SAMPLE = "the mockup's sample content, not a difference in the design (its site has blocks, fields and documents the demo doesn't)";
const M4 = 'an M4 slot (live mode), empty in local mode';

export const ALLOW_M6: Allow[] = [
	// ── As in the earlier groups' states, for the same reasons ──
	{ key: /\.(av|dot|pub|me|avs|lock|who)\b/, reason: M4 },
	{ key: /(logo-slot|si-logo) > (svg|img)$/, reason: "the site's logo is a file Site Settings names, drawn as an <img> (the mockup inlines its sample SVG)" },
	{ key: /rchip/, reason: "Recent is per browser (M3 Decision 20): a fresh browser lists only what it opened; the mockup's strip is a sample" },
	{ kind: 'style', key: /./, mock: /rgb\(31, 47, 87\)/, ours: /rgb\(31, 58, 46\)/, reason: "the demo's own brand accent (its green) where the mockup has its sample navy: the accent's slots" },
	{ key: /cur-row > div$/, kind: 'missing', reason: `${SAMPLE}: the page's "…" menu is in the head row of a page, not of the mockup's sample` },
	{ key: /> p\.field-help$/, kind: 'missing', reason: `${SAMPLE}: the mockup's fields carry help lines that the demo's schema doesn't set (as in M5a's states)` },
	{ key: /> span\.ph-in(\.svg)?$/, kind: 'missing', reason: 'a picture is one <img> with object-fit (M5b), where the mockup draws a stand-in' },
	{ key: /> img\.ph-img$|thumb > span\.fp-dot$/, kind: 'extra', reason: 'a picture is one <img> with object-fit (M5b), where the mockup draws a stand-in' },
	{ key: /note[.\w-]*\.warn[.\w-]* > svg\.i$/, kind: 'style', prop: /color$/, reason: "contrast (M3 Phase 5, icons 3:1): a warning note's icon takes the strong warning amber (as in M5b's states)" },
	// ── M6's own, each with its reason ──
	{ state: /^submissions-row$/, key: /tnode > button\.drow\.t$/, kind: 'style', prop: /^padding-left$/, reason: `${SAMPLE}: the mockup's Pages tree has a group open (a child row indented); a fresh browser's groups are closed (M3 Decision 8)` },
	{ state: /^submissions-row$/, root: 'bar', key: /seg > button > span\.(wdot|tip|sr)$/, kind: 'missing', reason: `${SAMPLE}: the mockup's Contact has a heading too long for phones; the demo's doesn't` },
	{ state: /^settings-m6$/, key: /set-sec > div\.eds > div\.ed$/, kind: 'style', prop: /^border-top-(width|style)$/, reason: `${SAMPLE}: the fixture's Site Settings lets one editor in, so there's no second row to rule off; the mockup's lists several` },
	// ── The page under the inbox, the case study and Site Settings: as M5a's and M5b's states accept them ──
	...ALLOW_M5B,
	...ALLOW_M5A,
];
