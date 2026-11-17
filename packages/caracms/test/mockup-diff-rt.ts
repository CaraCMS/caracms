/**
 * The RT states for the visual pass's check (on-page rich text, Phase 4): the ten states the mockup's switcher tags
 * RT (`#rt-type` … `#rt-case`), against /admin in the same state, compared by computed
 * style as mockup-diff.ts compares M3's, M4's and M5a's. Their accepted differences,
 * each with its reason, are `ALLOW_RT`.
 *
 *   node --experimental-strip-types packages/caracms/test/mockup-diff.ts --rt          every RT state
 *   node --experimental-strip-types packages/caracms/test/mockup-diff.ts rt-link       some
 *   … --all, --unused   as for the other groups
 *
 * mockup-diff.ts runs these states (`--rt`, and `test/mockup-rt.visual.test.ts` in the
 * visual pass); this file holds the states, their accepted differences, the `rt` root
 * and the bar's shape check.
 *
 * The roots: the sidebar (the body's field follows, with its "Typing on the page"
 * chip), the overlay layer in the frame on screen (the typing ring, the block's
 * outline), and **`rt`**: the bar, the style menu, the link popover and the linked
 * words' wash. The mockup draws those in a layer of their own (`#cms-rt`); /admin draws
 * them in the overlay layer, in `.cms-rt` (rich-text-bar.ts), so `rt` is that element,
 * and the overlay root accepts `.cms-rt` as extra (it's compared here).
 *
 * How each state is reached: Home's Text body, the demo's, with headings (H2, H3) and
 * links on (M5a Decision 17). The mockup's Home Text block has headings off and
 * switches them per state; **the demo wins**, so its options are the demo's. The
 * mockup's sample paragraphs (RT_BODY, RT_LIST) are written into the throwaway copy's
 * Home in each state's `setup`, so the caret sits in the same words as the mockup's.
 * The field is scrolled to the same place in the frame (the mockup's `rtScroll`),
 * hovered and clicked (the page editor mounts on pointer entry, the click focuses
 * it), then the caret or selection is set exactly where the mockup's is.
 *
 * `rt-plain` needs a field with no headings and no links, and no demo field is one
 * (Text's body has H2 and H3, a case study's story H2; both allow links). So it runs
 * on a second throwaway copy whose `src/blocks/text.ts` says
 * `richText({ label: 'Body', links: false })`, started when the state needs it and
 * closed in its teardown, with the main copy stopped meanwhile (see `stoppedMain`). `rt-case` is High-street coffee roaster's story, the demo's
 * (its caret in a paragraph, as the mockup's).
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { demoContent, startDevSite, type DevSite } from './helpers/dev-site.ts';
import type { Allow, Ctx, Root, State } from './mockup-diff.ts';

/** The bar, its menu and popover, and the wash: `#cms-rt` in the mockup, `.cms-rt` in the overlay layer here. */
export const ROOT_RT = { rt: { mock: 'frame:#cms-rt', ours: 'frame:#cms-overlays > .cms-rt' } };

const HOME = 'content/pages/index.json';
const HOME_BODY = '[data-cms-block="1"] [data-cms-field="body"]';
const CASE_BODY = '[data-cms-field="body"][data-cms-kind="richText"]';
const ROOTS: Root[] = ['side', 'overlays', 'rt'];

/** The mockup's RT_BODY and RT_LIST, as stored (M5a Decision 3's blocks). */
const RT_BODY = [
	{ p: "We make identities, sites and the odd book for people who'd rather be making things." },
	{ p: 'Twelve years, four people, one very old risograph.' },
	{ h3: 'How we work' },
	{ p: 'Most projects start at the long table and end on the drying line, with the client in the room for both.' },
];
const RT_BOLD = RT_BODY.map((b) => (b.p?.includes('risograph') ? { p: b.p.replace('risograph', '**risograph**') } : b));
const RT_LIST = [
	{ p: "We make identities, sites and the odd book for people who'd rather be making things. Mostly:" },
	{ ul: ['Names, marks and the signs over doors', 'Websites you can edit yourself', 'Short print runs, on the risogr'] },
];
const RT_PLAIN = RT_BODY.slice(0, 2);

function homeBody(site: DevSite, body: unknown) {
	const doc = JSON.parse(site.read(HOME)) as { blocks: { type?: string; body?: unknown }[] };
	doc.blocks.find((b) => b.type === 'text')!.body = body;
	site.write(HOME, `${JSON.stringify(doc, null, '\t')}\n`);
}

// ─── Driving /admin ──────────────────────────────────────────────────────────

async function open(page: Page, origin: string, path = '/admin') {
	// A copy's first page compiles everything (rt-plain's copy starts cold), so a minute.
	await page.goto(origin + path, { timeout: 60000 });
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 30000 });
	await page.evaluate(() => document.fonts.ready);
}

/** Put the field's top at `at` of the visible frame's height (the mockup's rtScroll), once the site's fonts are in. */
async function scrollField(page: Page, selector: string, at: number) {
	await page.evaluate(
		async ([selector, at]) => {
			const f = document.querySelector<HTMLIFrameElement>('#stage .frame.on iframe')!;
			const win = f.contentWindow!;
			await f.contentDocument!.fonts.ready;
			const el = f.contentDocument!.querySelector(selector)!;
			const r = el.getBoundingClientRect();
			win.scrollTo({ top: Math.max(0, win.scrollY + r.top - win.innerHeight * at), behavior: 'instant' });
		},
		[selector, at] as const,
	);
}

/** The point in /admin over the first character of `text` in the field. */
function charPoint(page: Page, selector: string, text: string) {
	return page.evaluate(
		([selector, text]) => {
			const f = document.querySelector<HTMLIFrameElement>('#stage .frame.on iframe')!;
			const doc = f.contentDocument!;
			const walker = doc.createTreeWalker(doc.querySelector(selector)!, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
				const at = n.data.indexOf(text);
				if (at < 0) continue;
				const range = doc.createRange();
				range.setStart(n, at);
				range.setEnd(n, at + 1);
				const r = range.getClientRects()[0]!;
				const box = f.getBoundingClientRect();
				const k = box.width / f.offsetWidth;
				return { x: box.left + (r.left + 1) * k, y: box.top + (r.top + r.height / 2) * k };
			}
			throw new Error(`no "${text}" in ${selector}`);
		},
		[selector, text] as const,
	);
}

/** The caret after `text`, or `text` selected, in the mounted page editor (ProseMirror's own selection). */
async function select(page: Page, selector: string, text: string, whole: boolean) {
	await page.evaluate(
		([selector, text, whole]) => {
			const f = document.querySelector<HTMLIFrameElement>('#stage .frame.on iframe')!;
			const el = f.contentDocument!.querySelector(selector) as unknown as {
				editor: { state: { doc: { descendants(fn: (n: { isText: boolean; text?: string }, pos: number) => boolean | void): void } }; commands: { setTextSelection(p: number | { from: number; to: number }): boolean } };
			};
			let from = -1;
			el.editor.state.doc.descendants((n, pos) => {
				if (from >= 0) return false;
				const i = n.isText ? (n.text ?? '').indexOf(text) : -1;
				if (i >= 0) from = pos + i;
			});
			if (from < 0) throw new Error(`no "${text}" in the page editor`);
			el.editor.commands.setTextSelection(whole ? { from, to: from + text.length } : from + text.length);
		},
		[selector, text, whole] as const,
	);
}

const frameOn = (page: Page) => page.frameLocator('#stage .frame.on iframe');

/** Type `field` on the page: scroll it to `at`, hover and click on `text` (mounted, focused), then the caret or selection. */
async function typeOnPage(page: Page, { selector, at, text, whole = false }: { selector: string; at: number; text: string; whole?: boolean }) {
	await scrollField(page, selector, at);
	const p = await charPoint(page, selector, text);
	// The page editor mounts on pointer entry; if the first entry came before page-edit was listening, enter again.
	const mounted = frameOn(page).locator(`${selector}.ProseMirror`);
	for (let i = 0; ; i++) {
		await page.mouse.move(p.x, p.y + 40, { steps: 2 });
		await page.mouse.move(p.x, p.y, { steps: 4 });
		try {
			await mounted.waitFor({ timeout: 3000 });
			break;
		} catch (error) {
			if (i === 3) throw error;
		}
	}
	await page.mouse.click(p.x, p.y);
	await frameOn(page).locator('#cms-overlays .cms-rt .cms-rtbar').waitFor({ timeout: 10000 });
	await select(page, selector, text, whole);
}

interface Home {
	at?: number;
	text: string;
	whole?: boolean;
	phone?: boolean;
	then?: (page: Page) => Promise<void>;
}
async function rtHome({ page, site }: Ctx, { at = 0.42, text, whole, phone, then }: Home) {
	await open(page, site.origin);
	if (phone) {
		await page.click('#bar .seg button[data-width="phone"]');
		await page.waitForSelector('#stage .frame.on[data-w="phone"]');
	}
	await typeOnPage(page, { selector: HOME_BODY, at, text, whole });
	await then?.(page);
}
const openMenu = async (page: Page) => {
	await frameOn(page).locator('#cms-overlays .cms-rtbar [data-rtc="style"]').click();
	await frameOn(page).locator('#cms-overlays .cms-rtmenu').waitFor();
};
const openLink = (query: string) => async (page: Page) => {
	await page.keyboard.press('Meta+k');
	await frameOn(page).locator('#cms-overlays .cms-lpop input').waitFor();
	await page.keyboard.type(query);
};

/** The copy with a Text body that allows no headings and no links (rt-plain), started when first needed. */
let plain: Promise<DevSite> | null = null;
const plainSite = () =>
	(plain ??= startDevSite('mockup-diff-rt-plain', {
		edit: (root) => {
			const file = join(root, 'src/blocks/text.ts');
			const text = readFileSync(file, 'utf8');
			const next = text.replace(/richText\(\{ label: 'Body', headings: \['h2', 'h3'\] \}\)/, "richText({ label: 'Body', links: false })");
			if (next === text) throw new Error("rt-plain: the Text block's body isn't richText({ label: 'Body', headings: ['h2', 'h3'] }) any more");
			writeFileSync(file, next);
		},
	}));
/**
 * The main copy, stopped while rt-plain's runs. Two dev servers in one process break each
 * other (each watches the package through its `node_modules/caracms` symlink, and the other's
 * copy lands in it, so both restart and one loses its port): the main copy stops, the second
 * runs, and `closeRtSites` closes it and starts the main copy again.
 */
let stoppedMain: DevSite | null = null;
/** Close the second copy, if it was started, and bring the main one back. */
export async function closeRtSites() {
	const p = plain;
	plain = null;
	if (p) await (await p).close();
	const main = stoppedMain;
	stoppedMain = null;
	await main?.start();
}

// ─── The states ──────────────────────────────────────────────────────────────

export const STATES_RT: State[] = [
	{ id: 'rt-type', rt: true, roots: ROOTS, keepFocus: true, setup: (s) => homeBody(s, RT_BODY), ours: (ctx) => rtHome(ctx, { text: 'sites and the' }) },
	{ id: 'rt-bold', rt: true, roots: ROOTS, keepFocus: true, setup: (s) => homeBody(s, RT_BOLD), ours: (ctx) => rtHome(ctx, { text: 'risograph', whole: true }) },
	{ id: 'rt-style', rt: true, roots: ROOTS, keepFocus: true, setup: (s) => homeBody(s, RT_BODY), ours: (ctx) => rtHome(ctx, { at: 0.5, text: 'How we', then: openMenu }) },
	{ id: 'rt-list', rt: true, roots: ROOTS, keepFocus: true, setup: (s) => homeBody(s, RT_LIST), ours: (ctx) => rtHome(ctx, { text: 'on the risogr' }) },
	{ id: 'rt-link', rt: true, roots: ROOTS, keepFocus: true, setup: (s) => homeBody(s, RT_BODY), ours: (ctx) => rtHome(ctx, { at: 0.46, text: 'risograph', whole: true, then: openLink('pri') }) },
	{ id: 'rt-link-bad', rt: true, roots: ROOTS, keepFocus: true, setup: (s) => homeBody(s, RT_BODY), ours: (ctx) => rtHome(ctx, { at: 0.46, text: 'risograph', whole: true, then: openLink('wrok.html') }) },
	{
		id: 'rt-plain',
		rt: true,
		roots: ROOTS,
		keepFocus: true,
		ours: async (ctx) => {
			stoppedMain = ctx.site;
			await ctx.site.stop();
			const site = await plainSite();
			rmSync(join(site.root, 'content'), { recursive: true, force: true });
			cpSync(demoContent, join(site.root, 'content'), { recursive: true });
			homeBody(site, RT_PLAIN);
			await rtHome({ ...ctx, site }, { text: 'four people' });
		},
		teardown: () => closeRtSites(),
	},
	{ id: 'rt-top', rt: true, roots: ROOTS, keepFocus: true, setup: (s) => homeBody(s, RT_BODY), ours: (ctx) => rtHome(ctx, { at: 0.012, text: 'the odd book' }) },
	{ id: 'rt-phone', rt: true, roots: ROOTS, keepFocus: true, setup: (s) => homeBody(s, RT_BODY), ours: (ctx) => rtHome(ctx, { at: 0.3, text: 'four people,', phone: true }) },
	{
		id: 'rt-case',
		rt: true,
		roots: ROOTS,
		keepFocus: true,
		ours: async ({ page, site }) => {
			await open(page, site.origin, '/admin/case-studies/high-street-coffee');
			await typeOnPage(page, { selector: CASE_BODY, at: 0.12, text: 'We drew the letters' });
		},
	},
];

// ─── Accepted differences ────────────────────────────────────────────────────

const SAMPLE = "the mockup's sample content, not a difference in the design (its site has blocks, fields and documents the demo doesn't)";

export const ALLOW_RT: Allow[] = [
	// The editor restyle: since Decision 12 the brand fills every .btn.ink and the on switch.
	{ kind: 'style', key: /./, mock: /rgb\(31, 47, 87\)/, ours: /rgb\(31, 58, 46\)/, reason: "the demo's own brand accent (its green) where the mockup has its sample navy: the accent's slots, which since the restyle's Decision 12 include .btn.ink and the on switch" },
	{ kind: 'style', key: /./, prop: /^box-shadow$/, mock: /oklab\(/, ours: /oklab\(/, reason: "the editor restyle (Decision 9 (b)): an accent button's pressed edge is --edge-accent, a color-mix of the accent, which computes as oklab(…) from the mockup's navy and the demo's own green, out of the catch-all accent rule's reach" },
	// ── M6c (after the RT mockups): the on-page link popover offers a File… choice (mockup m6c-downloads-grid.html → #rt-link-file) ──
	{ state: /^rt-link(-bad)?$/, root: 'rt', key: /cms-lpop > div\.find$/, kind: 'missing', reason: "M6c (m6c mockup #rt-link-file): the popover's search box sits in a top row (div.cms-top) beside the File… button, so the mockup's bare div.find is not a direct child" },
	{ state: /^rt-link(-bad)?$/, root: 'rt', key: /cms-lpop > div\.cms-top$/, kind: 'extra', reason: "M6c (m6c mockup #rt-link-file): the popover's top row holds the search box and the File… button (choose a file in the library to link to)" },
	// ── The bar's own (Phase 3's departures, judged in Phase 4) ──
	{ root: 'overlays', kind: 'extra', key: /^\(root\) > div\.cms-rt$/, reason: "the bar, its menu, its popover and the wash are drawn in the overlay layer (`#cms-overlays > .cms-rt`, kept across the layer's redraws), not in a layer of their own as the mockup's #cms-rt: one layer per iframe, outside <body>, never morphed. They're compared as the `rt` root" },
	{ root: 'rt', prop: /^font-family$/, key: /./, reason: 'the layer loads the editor\'s Instrument Sans under its own name ("caracms UI"), so the site\'s fonts can\'t clash (as the overlays\' font in M3\'s states)' },
	// ── As in M3's and M5a's states, for the same reasons ──
	{ root: 'overlays', prop: /^font-family$/, key: /./, reason: 'the layer loads the editor\'s Instrument Sans under its own name ("caracms UI")' },
	{ key: /rchip/, reason: "Recent is per browser (M3 Decision 20): a fresh browser lists only what it opened; the mockup's strip is a sample" },
	{ key: /cur-row > div$/, kind: 'missing', reason: `${SAMPLE}: the page's "…" menu is in the head row of a page, not of the mockup's sample (as in M5a's states)` },
	{ key: /media/, reason: "M5b's: the mockup's Text block has a background image; media isn't built yet (as in M5a's states)" },
	{ key: /div\.tb > button > i(\.tb-i)?$/, reason: "the sidebar's italic button's Georgia is a class (.tb-i), not an inline style: the editor's CSP allows no inline styles (M5a)" },
	{ key: /div\.prose\.rt( > [\w.-]+)*$/, kind: 'style', prop: /^white-space$/, mock: /^normal$/, ours: /^pre-wrap$/, reason: "ProseMirror sets white-space: pre-wrap on its editable element (the sidebar's field, M5a); the mockup's contenteditable is a plain div" },
	// ── rt-case: High-street coffee roaster's form, as in M5a's `case` and `rich-*` states ──
	{ state: /^rt-case$/, key: /> p\.field-help$/, kind: 'missing', reason: `${SAMPLE}: the mockup's fields carry help lines the demo's schema doesn't set` },
	{ state: /^rt-case$/, key: /div\.prose\.rt > (h3|h2 > br|p > strong)$/, reason: `${SAMPLE}: the mockup's Story has an H3 and no break in its H2; the demo's has a two-line H2 and bold "ferry signs" (the demo's Story allows H2 only)` },
	{ state: /^rt-case$/, key: /div\.refs > div\.ref > span\.yr$/, kind: 'missing', reason: `${SAMPLE}: the mockup's references show a case study's year; a reference shows any collection's documents by title and address` },
	{ state: /^rt-case$/, key: /fgroup/, reason: "the case study's \"Search and sharing\" group is M6's (the mockup marks it \"M6 · not in M5a\")" },
];

// ─── The bar's shape ─────────────────────────────────────────────────────────

/**
 * What the computed styles can't say: which controls the bar has, in order (a key
 * stands for every instance, so a Link button too many would pass), which are pressed,
 * which side of the block it sits, and whether the menu, the popover and the wash are
 * there. Both draw `data-rtc` on the controls and `data-place` on the bar's wrapper.
 * mockup-diff.ts evaluates `barShape` in each page (it must stay self-contained) and
 * compares the two with `compareShapes`.
 */
export interface BarShape {
	controls: string[];
	pressed: string[];
	place: string;
	open: string[];
	holds: boolean;
}
export function barShape(root: string): BarShape | null {
	const iframe = document.querySelector<HTMLIFrameElement>('#stage .frame.on iframe');
	const el = iframe?.contentDocument?.querySelector(root.slice(6));
	const bar = el?.querySelector('.cms-rtbar');
	if (!el || !bar) return null;
	const rtc = (b: Element) => b.getAttribute('data-rtc') ?? '';
	return {
		controls: [...bar.querySelectorAll('[data-rtc]')].map(rtc),
		pressed: [...bar.querySelectorAll('[data-rtc][aria-pressed="true"], [data-rtc][aria-expanded="true"]')].map(rtc),
		place: el.querySelector<HTMLElement>('.cms-rtw')?.dataset.place ?? '',
		open: ['.cms-rtmenu', '.cms-lpop', '.cms-msg'].filter((s) => el.querySelector(s)),
		holds: !!el.querySelector('.cms-hold'),
	};
}

/** A difference in the bar's shape, in mockup-diff.ts's Diff form. */
export interface ShapeDiff {
	state: string;
	root: Root;
	kind: 'style' | 'root';
	key: string;
	prop?: string;
	mock?: string;
	ours?: string;
}
export function compareShapes(state: string, mock: BarShape | null, ours: BarShape | null): ShapeDiff[] {
	if (!mock && !ours) return [];
	if (!mock || !ours) return [{ state, root: 'rt', kind: 'root', key: '(bar)', mock: mock ? 'a bar' : 'no bar', ours: ours ? 'a bar' : 'no bar' }];
	const out: ShapeDiff[] = [];
	for (const k of ['controls', 'pressed', 'place', 'open', 'holds'] as const) {
		const m = JSON.stringify(mock[k]);
		const o = JSON.stringify(ours[k]);
		if (m !== o) out.push({ state, root: 'rt', kind: 'style', key: '(bar)', prop: k, mock: m, ours: o });
	}
	return out;
}
