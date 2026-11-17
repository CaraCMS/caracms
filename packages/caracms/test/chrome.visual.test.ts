// The chrome's look in a real browser (M3 Phase 5 → Verify 2–4, and the checklist's
// focus and accent rules), on throwaway copies of the demo (helpers/dev-site.ts):
//
// - **Contrast** with each of the mockup's sample accents (dark navy #1f2f57, pale
//   yellow #f6e27f), with no logo so the brand slot draws its initial on the accent:
//   every piece of the chrome's text 4.5:1 against what's behind it (3:1 for large
//   text), icons 3:1, the brand tile and an on switch against what's behind them 3:1;
//   then with each of Site Settings' presets set on the root (editor restyle, check 17),
//   and a mid accent's pressed edge read back through a canvas (check 8).
// - **The accent fills only its slots** (M2 Decision 5, editor restyle check 15): with
//   either accent and every preset, every colour in the chrome outside the branded slots
//   (the brand slot, .btn.ink, .btn.accent, the accent sample, an on switch), and the
//   overlays' colours, are the same; every .btn.ink and on switch fills from --accent.
// - **No side rails** (M2 Decision 10) on selected, current, warned or skipped rows,
//   or anything else in the chrome: no coloured left border wider than 1px, no inset
//   shadow offset to one side, no ::before/::after stripe.
// - **Pressed edges** (editor restyle, check 7): on :active an edged button sinks into its
//   edge, a quiet one takes the pressed wash and has no edge, a disabled one has no edge;
//   under reduced motion the change is instant.
// - **The frame** (check 9): the warning and danger frame is on every .note.warn and
//   .note.danger, the problem controls and the toned dialogs, and on nothing calm.
// - **Reduced motion**: under `prefers-reduced-motion: reduce` no transition or
//   animation runs in the chrome (and without it, some do).
// - **Focus shows everywhere**: tabbing through the chrome, each stop has a 2px ring,
//   blue on light and pale blue on the bar (or, for a text box, its own blue ring).
//
//   node --test --experimental-strip-types test/chrome.visual.test.ts
//
// Live mode's half (M4's places) is chrome-live-contrast.visual.test.ts and
// chrome-live.visual.test.ts; the checks themselves are in helpers/chrome-scans.ts.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { ACCENTS, contrastScan, frameScan, layerMoving, lookOf, moving, pressLook, park, railScan, settle, withAccent, type Accent, type Look } from './helpers/chrome-scans.ts';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { snapshot, STYLE_PROPS } from './helpers/style-snapshot.ts';
import { ACCENT_PRESETS, brandColours } from '../src/editor/brand.ts';

/** Paints one accent's three slots on the root, as a pick in Site Settings does (Decision 12). */
async function paint(page: Page, c: { accent: string; ink: string; edge: string }): Promise<void> {
	await page.evaluate((c) => {
		const root = document.documentElement.style;
		root.setProperty('--accent', c.accent);
		root.setProperty('--accent-ink', c.ink);
		root.setProperty('--accent-edge', c.edge);
	}, c);
	await settle(page);
}
const presetColours = (p: (typeof ACCENT_PRESETS)[number]) => ({ accent: p.hex, ink: p.ink, edge: p.edge });

/** In the page: each .btn.ink and on switch whose fill isn't --accent as the root has it now (check 15), and how many were read. */
function offAccent(): { off: string[]; inks: number; switches: number } {
	const probe = document.createElement('i');
	probe.style.background = 'var(--accent)';
	document.body.append(probe);
	const accent = getComputedStyle(probe).backgroundColor;
	probe.remove();
	const out: string[] = [];
	for (const el of document.querySelectorAll('#app .btn.ink:not(:disabled), #pops .btn.ink:not(:disabled), .switch[aria-checked="true"]:not(:disabled) .track')) {
		const fill = getComputedStyle(el).backgroundColor;
		if (fill !== accent) out.push(`${el.className} “${(el.textContent ?? el.parentElement?.textContent ?? '').trim().slice(0, 24)}” is ${fill}, not ${accent}`);
	}
	return { off: out, inks: document.querySelectorAll('.btn.ink:not(:disabled)').length, switches: document.querySelectorAll('.switch[aria-checked="true"]:not(:disabled)').length };
}

/**
 * In the page (check 8): the mid accent's pressed edge on a branded .btn.ink and a .btn.accent, read back through a
 * canvas (--edge-accent is a color-mix, which computes as oklab(), and contrastScan's parse can't read that).
 */
function midAccentEdges(): { what: string; fill: number[]; edge: number[]; ink: number[] }[] {
	const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
	const rgb = (c: string) => {
		canvas.clearRect(0, 0, 1, 1);
		canvas.fillStyle = c;
		canvas.fillRect(0, 0, 1, 1);
		return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)];
	};
	return ['btn ink', 'btn accent'].map((cls) => {
		const b = document.createElement('button');
		b.className = cls;
		b.textContent = 'Create';
		document.querySelector('#side')!.append(b);
		const cs = getComputedStyle(b);
		const edge = /(oklab|oklch|rgba?|color)\([^)]*\)/.exec(cs.boxShadow)?.[0] ?? 'transparent';
		const out = { what: `.${cls.replace(' ', '.')}`, fill: rgb(cs.backgroundColor), edge: rgb(edge), ink: rgb(cs.color) };
		b.remove();
		return out;
	});
}
const luminance = ([r, g, b]: number[]) => {
	const f = (v: number) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
};
const ratioOf = (a: number[], b: number[]) => {
	const [x, y] = [luminance(a), luminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const MID_ACCENT = '#c4472f';
import { LIB, mediaOffline, seedLibrary } from './mockup-diff-m5b.ts';
import { memoryMedia } from '../src/editor/server/media/memory.ts';

let browser: Browser;
const sites: Partial<Record<Accent, DevSite>> = {};

async function open(site: DevSite, path = '/admin', options: { reducedMotion?: 'reduce' | 'no-preference' } = {}): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: options.reducedMotion ?? 'reduce' });
	await mediaOffline(page.context());
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	await page.evaluate(() => document.fonts.ready);
	return page;
}

const DOCS = '[data-pane-level="documents"]';
const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const row = (i: number) => `${DOC} .blist > .brow >> nth=${i} >> .brow-main`;
/** Another document of the same site, from the page on screen. */
const goTo = async (page: Page, path: string) => {
	await page.goto(new URL(path, page.url()).href);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
};
/** Arrange pages: a real drag, onto another row's top quarter, middle or bottom quarter; `hold` keeps the button down. */
const arrangeDrag = async (page: Page, from: string, to: string, where: 'top' | 'mid' | 'bottom', hold = false) => {
	const at = (id: string) => `#atree .arow[data-id="${id}"]`;
	const a = (await page.locator(at(from)).boundingBox())!;
	await page.mouse.move(a.x + 120, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + 130, a.y + a.height / 2 + 8, { steps: 3 });
	await page.waitForSelector(`${at(from)}.is-src`);
	const b = (await page.locator(at(to)).boundingBox())!;
	await page.mouse.move(b.x + 200, where === 'top' ? b.y + 4 : where === 'bottom' ? b.y + b.height - 4 : b.y + b.height / 2, { steps: 6 });
	if (!hold) await page.mouse.up();
};
/** Arrange pages: a new group with About in it, Services renamed, Contact under the hidden Field notes, an empty group left. */
const arranged = async (page: Page) => {
	await goTo(page, '/admin/arrange');
	for (const name of ['Company', 'Later']) {
		await page.click('[data-act="new-group"]');
		await page.fill('#ng-in', name);
		await page.press('#ng-in', 'Enter');
	}
	await arrangeDrag(page, 'about', 'new:1', 'mid');
	await arrangeDrag(page, 'contact', 'field-notes', 'mid');
	await page.hover('#atree .arow[data-id="services"]');
	await page.click('#atree .arow[data-id="services"] [data-act="rename"]');
	await page.fill('#rn-in', 'Offerings');
	await page.click('#rn-ok');
};
const toDocs = async (page: Page) => {
	if (await page.isVisible(DOCS)) return;
	await page.click('.side-level:not([hidden]) .lv >> nth=0');
	await page.waitForSelector(DOCS, { state: 'visible' });
};
/** The states the checks walk: each leaves the page in one, and says which. */
const STATES: { name: string; go: (page: Page) => Promise<void> }[] = [
	{ name: 'the block list', go: async () => {} },
	{
		name: 'a selected row, hovered rows',
		go: async (page) => {
			await page.click(row(1));
			await page.click(`${BLOCK} .cur .ib.boxed`);
			await page.hover(`${DOC} .blist > .brow >> nth=2`);
		},
	},
	{
		name: 'the documents level, groups open, Find typed',
		go: async (page) => {
			await toDocs(page);
			for (const g of ['pages:about', 'pages:services']) {
				const el = `${DOCS} [data-group="${g}"]`;
				if ((await page.getAttribute(el, 'aria-expanded')) !== 'true') await page.click(el);
			}
		},
	},
	{
		name: 'Find typed',
		go: async (page) => {
			await toDocs(page);
			await page.fill(`${DOCS} input[data-filter="docs"]`, 'bra');
		},
	},
	{
		name: 'a collection',
		go: async (page) => {
			await toDocs(page);
			await page.click(`${DOCS} .drow.coll[data-coll="journal"]`);
		},
	},
	{
		name: 'the hero, picked from the page, too long for mobile',
		go: async (page) => {
			await page.frameLocator('#stage .frame[data-w="desktop"] iframe').locator('[data-cms-block="0"] [data-cms-field="heading"]').first().click();
			await page.waitForSelector(`${BLOCK} [data-warning="too-long"]`);
		},
	},
	{
		name: 'Phone, with phone lines',
		go: async (page) => {
			await page.click(row(0));
			await page.click('#bar .seg button[data-width="phone"]');
			await page.click(`${BLOCK} [data-warning="too-long"] .btn.phone`);
			await page.waitForSelector(`${BLOCK} .lk-field.phone`);
		},
	},
	{
		name: 'the switcher',
		go: async (page) => {
			await page.click('#bar .docbtn');
			await page.fill('#swq', 'e');
		},
	},
	{
		name: 'the picker',
		go: async (page) => {
			await page.click(`${DOC} .add-row`);
		},
	},
	{
		name: 'removed, with the toast',
		go: async (page) => {
			await page.focus(row(1));
			await page.keyboard.press('Backspace');
			await page.waitForSelector('#toast-root .toast');
		},
	},
	{
		name: "can't reach the server",
		go: async (page) => {
			await page.route('**/_caracms/write', (route) => route.abort());
			await page.click(row(1));
			await page.fill(`${BLOCK} [data-ff="heading"] input`, 'Work that lasts longer');
			await page.waitForSelector('#bar [data-keep="offline"]', { timeout: 10000 });
		},
	},
	{
		name: 'the preview not updated',
		go: async (page) => {
			await page.route('**/_caracms/preview', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'no' }) : route.continue()));
			await page.click(row(1));
			await page.fill(`${BLOCK} [data-ff="heading"] input`, 'Work that lasts longer');
			await page.click('#bar .bar-warn', { timeout: 10000 });
		},
	},
	// ── M5b (on the in-memory bucket and Mux): the library, the media field with its focal point, the alt text asked
	// for after placing, and Site Settings' logo and tab icon. Appended, so the indexes above stay.
	{
		name: 'M5b: the library, Show unused on, the stage as the drop target',
		go: async (page) => {
			await toDocs(page);
			await page.click('#side .media-row');
			await page.waitForSelector('#side [data-media-mode="browse"] .mtile[data-key]');
		},
	},
	{
		name: 'M5b: an image placed, its focal point open',
		go: async (page) => {
			await goTo(page, '/admin/pages/visit');
			await page.click(row(1));
			await page.click(`${BLOCK} [data-ff="media"] .media-acts button[aria-expanded]`);
			await page.waitForSelector(`${BLOCK} [data-ff="media"] .fp-img`);
		},
	},
	{
		name: 'M5b: alt text asked for after placing',
		go: async (page) => {
			await goTo(page, '/admin/pages/visit');
			await page.click(row(3));
			// Choose… on the empty slot (or Replace…, once an earlier state has placed one there).
			await page.locator(`${BLOCK} [data-ff="media"] :is(.mdrop .btn, .media-acts .btn:has-text("Replace…"))`).first().click();
			await page.click(`#side [data-media-mode="pick"] .mtile[data-key="${LIB.never}"]`);
			await page.waitForSelector(`${BLOCK} [data-ff="media"] [data-ask] .field-ask`);
		},
	},
	{
		name: "M5b: Site Settings' logo and tab icon",
		go: async (page) => {
			await goTo(page, '/admin/settings');
			await page.waitForSelector('.side-level:not([hidden]) [data-ff="brand.icon"] .mdrop');
		},
	},
	// ── Arrange pages (check 20): the screen, a name being typed, arranged with marks and an empty group, the review, a
	// refused drop (the button held down), the leave ask. Appended, so the indexes above stay.
	{
		name: 'Arrange pages: the screen, a group being named',
		go: async (page) => {
			await goTo(page, '/admin/arrange');
			await page.click('[data-act="new-group"]');
			await page.fill('#ng-in', 'Prints & Posters');
		},
	},
	{ name: 'Arrange pages: arranged, with an empty new group', go: arranged },
	{
		name: 'Arrange pages: the review, its documents open, the tick',
		go: async (page) => {
			await arranged(page);
			await page.click('#atree .arow[data-id="new:2"] [data-act="remove-group"] >> nth=0');
			await arrangeDrag(page, 'journal', 'new:1', 'mid');
			await page.click('[data-pane-level="arrange"] [data-act="review"]');
			await page.click('[data-pane-level="arrange"] [data-review="held"] .rv-more');
		},
	},
	{
		name: 'Arrange pages: applying, the server not answering yet',
		go: async (page) => {
			await goTo(page, '/admin/arrange');
			await arrangeDrag(page, 'contact', 'about', 'mid');
			await page.click('[data-pane-level="arrange"] [data-act="review"]');
			await page.route('**/_caracms/arrange', () => undefined);
			await page.click('[data-pane-level="arrange"] [data-act="apply"]');
			await page.waitForSelector('[data-pane-level="arrange"] .busy');
		},
	},
	{
		name: 'Arrange pages: a drag refused over Home (the button held down)',
		go: async (page) => {
			await goTo(page, '/admin/arrange');
			await arrangeDrag(page, 'contact', 'index', 'mid', true);
			await page.waitForSelector('#atree .arow.is-refused');
		},
	},
	{
		name: 'Arrange pages: the leave ask',
		go: async (page) => {
			await arranged(page);
			await page.click('[data-pane-level="arrange"] [data-act="cancel"]');
			await page.waitForSelector('[data-dialog="arrange-leave"]');
		},
	},
];

/** Arrange pages' hidden marks: a hidden page in the copy (Field notes), so the screen shows one. */
const withHidden = (edit: (root: string) => void) => (root: string) => {
	edit(root);
	writeFileSync(join(root, 'content/pages/field-notes.json'), `${JSON.stringify({ title: 'Field notes', hidden: true, blocks: [] }, null, 2)}\n`);
};


describe('the chrome in the browser', { skip: browserSkip }, () => {
	before(async () => {
		// M5b's states: the in-memory bucket and Mux (never the real ones), seeded with a library.
		process.env.CARACMS_MEDIA = 'memory';
		seedLibrary();
		browser = await chromium.launch();
		const [navy, yellow] = await Promise.all([
			startDevSite('chrome-navy', { edit: withHidden(withAccent(ACCENTS.navy)) }),
			startDevSite('chrome-yellow', { edit: withHidden(withAccent(ACCENTS.yellow)) }),
		]);
		sites.navy = navy;
		sites.yellow = yellow;
	});
	after(async () => {
		await browser?.close();
		await Promise.all(Object.values(sites).map((s) => s?.close()));
		memoryMedia().reset();
		delete process.env.CARACMS_MEDIA;
	});

	test('Verify 2: contrast with each sample accent, text 4.5:1 (large 3:1), icons and the brand tile 3:1', async (t) => {
		const failures: string[] = [];
		let checked = 0;
		const branded = { inks: 0, switches: 0 };
		for (const accent of Object.keys(ACCENTS) as Accent[]) {
			const lowest: Record<string, { ratio: number; what: string }> = {};
			for (const state of STATES) {
				const page = await open(sites[accent]!);
				await state.go(page);
				await park(page);
				await settle(page);
				const results = await page.evaluate(contrastScan, undefined);
				checked += results.length;
				const fills = await page.evaluate(offAccent);
				for (const off of fills.off) failures.push(`${accent}, ${state.name}: ${off}`);
				branded.inks += fills.inks;
				branded.switches += fills.switches;
				for (const r of results) {
					if (r.ratio < r.need) failures.push(`${accent}, ${state.name}: ${r.kind} ${r.what} is ${r.ratio}:1 (needs ${r.need}:1)`);
					if (!lowest[r.kind] || r.ratio < lowest[r.kind]!.ratio) lowest[r.kind] = { ratio: r.ratio, what: r.what };
				}
				if (state === STATES[0]) {
					assert.ok(results.some((r) => r.kind === 'brand tile'), 'the brand tile is checked');
					const ink = await page.$eval('#bar .logo-slot .logo-mono', (el) => el.textContent);
					assert.equal(ink, 'C', 'with no logo the slot shows the initial');
				}
				if (state === STATES[0]) {
					const ink = await page.$eval('#bar .logo-slot .logo-mono', (el) => {
						const cs = getComputedStyle(el);
						return `${cs.color} on ${cs.backgroundColor}`;
					});
					t.diagnostic(`${accent} (${ACCENTS[accent]}): the brand initial is ${ink}`);
				}
				// Check 17: each preset, set on the root as a pick sets it (one site is enough: the root is all a pick changes).
				if (accent === 'navy') {
					for (const preset of ACCENT_PRESETS) {
						await paint(page, presetColours(preset));
						const scanned = await page.evaluate(contrastScan, undefined);
						checked += scanned.length;
						for (const r of scanned) if (r.ratio < r.need) failures.push(`preset ${preset.name}, ${state.name}: ${r.kind} ${r.what} is ${r.ratio}:1 (needs ${r.need}:1)`);
						for (const off of (await page.evaluate(offAccent)).off) failures.push(`preset ${preset.name}, ${state.name}: ${off}`);
					}
				}
				// Check 8: a mid accent, one evaluation: the pressed edge darker than the fill, the label 4.5:1.
				if (accent === 'navy' && state === STATES[0]) {
					const mid = brandColours(MID_ACCENT);
					await paint(page, { accent: mid.accent, ink: mid.accentInk, edge: mid.accentEdge });
					for (const b of await page.evaluate(midAccentEdges)) {
						assert.ok(luminance(b.edge) < luminance(b.fill), `${MID_ACCENT}: ${b.what}'s pressed edge (${b.edge}) is darker than its fill (${b.fill})`);
						const label = ratioOf(b.ink, b.fill);
						assert.ok(label >= 4.5, `${MID_ACCENT}: ${b.what}'s label is ${label.toFixed(2)}:1 on its fill`);
						t.diagnostic(`${MID_ACCENT}: ${b.what} fill ${b.fill}, edge ${b.edge}, label ${label.toFixed(2)}:1`);
					}
				}
				await page.close();
			}
			for (const [kind, low] of Object.entries(lowest)) t.diagnostic(`${accent}: lowest ${kind} ${low.ratio}:1, ${low.what}`);
		}
		assert.ok(checked > 500, `enough of the chrome was checked (${checked})`);
		assert.ok(branded.inks > 0 && branded.switches > 0, `check 15 read some .btn.ink (${branded.inks}) and on switches (${branded.switches})`);
		assert.deepEqual(failures, []);
	});

	test('the accent fills only its slots: status, selection, overlay and Publish colours are the same with either accent and every preset; .btn.ink and on switches fill from it (M2 Decision 5, check 15)', async () => {
		const colourProps = STYLE_PROPS.filter((p) => /color|shadow|background/.test(p));
		const take = async (accent: Accent, state: (typeof STATES)[number], preset?: (typeof ACCENT_PRESETS)[number]) => {
			const page = await open(sites[accent]!);
			await state.go(page);
			await park(page);
			await settle(page);
			if (preset) await paint(page, presetColours(preset));
			const { off } = await page.evaluate(offAccent);
			// The on switch's track (and its knob's ring) is the accent's: check 15 covers it instead (offAccent).
			const spec = { skip: '.logo-slot, .si-logo, .switch[aria-checked="true"] .track', props: colourProps, fixedHeight: [], fixedWidth: [] };
			const chrome = await Promise.all(['#side', '#bar', '#pops', '#toast-root'].map((root) => page.evaluate(snapshot, { ...spec, root })));
			const overlays = await page.evaluate(snapshot, { ...spec, root: 'frame:#cms-overlays' });
			const layerTokens = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#stage .frame.on iframe')!.contentDocument!.getElementById('cms-overlays')!.getAttribute('style'));
			const tokens = await page.evaluate(() => {
				const cs = getComputedStyle(document.documentElement);
				return [...document.styleSheets]
					.flatMap((s) => [...s.cssRules])
					.filter((r): r is CSSStyleRule => 'selectorText' in r && (r as CSSStyleRule).selectorText === ':root')
					.flatMap((r) => [...r.style].filter((p) => /^--(status|select|phone|focus|ov)/.test(p)))
					.map((p) => `${p}:${cs.getPropertyValue(p).trim()}`)
					.sort();
			});
			await page.close();
			// The logo slot's own subtree is the brand's, and since Decision 12 so are .btn.ink, .btn.accent and the
			// accent sample (check 15 reads their fill instead); strip them from the keys.
			const branded = (key: string) =>
				/logo-slot|si-logo|logo-mono/.test(key) ||
				key.split(' > ').some((seg) => {
					const c = seg.split('.').slice(1);
					return c.includes('accent-try') || (c.includes('btn') && (c.includes('ink') || c.includes('accent')));
				});
			const strip = (snap: ReturnType<typeof snapshot>) =>
				snap
					? Object.fromEntries(
							Object.entries(snap)
								.filter(([key]) => !branded(key))
								.map(([key, records]) => [key, records.map((r) => r.styles)]),
						)
					: null;
			return { chrome: chrome.map(strip), overlays: strip(overlays), layerTokens: (layerTokens ?? '').replace(/--k:[^;]*;?/, ''), tokens, off };
		};
		for (const state of [STATES[1]!, STATES[5]!, STATES[7]!, STATES[10]!]) {
			const navy = await take('navy', state);
			const yellow = await take('yellow', state);
			assert.ok(navy.tokens.length > 30, 'the fixed colour tokens are read');
			assert.deepEqual(yellow.tokens, navy.tokens, `${state.name}: the status, selection and overlay tokens`);
			assert.deepEqual(yellow.layerTokens, navy.layerTokens, `${state.name}: the overlay layer's colours`);
			assert.deepEqual(yellow.overlays, navy.overlays, `${state.name}: the overlays`);
			assert.deepEqual(yellow.chrome, navy.chrome, `${state.name}: the chrome outside the brand slot`);
			assert.deepEqual([...navy.off, ...yellow.off], [], `${state.name}: .btn.ink and on switches fill from the accent`);
			for (const preset of ACCENT_PRESETS) {
				const with_ = await take('navy', state, preset);
				assert.deepEqual(with_.tokens, navy.tokens, `${state.name}, ${preset.name}: the status, selection and overlay tokens`);
				assert.deepEqual(with_.overlays, navy.overlays, `${state.name}, ${preset.name}: the overlays`);
				assert.deepEqual(with_.chrome, navy.chrome, `${state.name}, ${preset.name}: the chrome outside the branded slots`);
				assert.deepEqual(with_.off, [], `${state.name}, ${preset.name}: .btn.ink and on switches fill from the accent`);
			}
		}
	});

	test('Verify 3: no side rails on selected, current, warned or skipped rows, or anywhere in the chrome', async () => {
		const site = sites.navy!;
		site.write(
			'content/pages/rails-test.json',
			`${JSON.stringify({ title: 'Rails test', blocks: [{ type: 'text', heading: 'Before', body: 'A', background: 'light' }, { type: 'gone-away', heading: 'Kept' }, { type: 'cta', heading: ['Worried?', 'Why Wait?'], text: 'B', button: 'Go', background: 'dark' }] }, null, 2)}\n`,
		);
		try {
			const found: string[] = [];
			const walk = async (label: string, page: Page) => {
				await settle(page);
				for (const f of await page.evaluate(railScan, undefined)) found.push(`${label}: ${f}`);
			};
			for (const state of STATES) {
				const page = await open(site);
				await state.go(page);
				await walk(state.name, page);
				await page.close();
			}
			// A skipped row, selected and not; its block level; a warned row (the hero, too long).
			// The scan sees a rail when there is one: a left border, a one-sided inset shadow, a ::before stripe.
			const probe = await open(site);
			await probe.addStyleTag({
				content:
					'.drow.is-current{border-left:3px solid var(--select)}.rchip{box-shadow:inset 3px 0 0 var(--select)}.drow::before{content:"";position:absolute;left:0;top:4px;width:3px;height:20px;background:var(--select)}',
			});
			await toDocs(probe);
			const seen = (await probe.evaluate(railScan, undefined)).join('\n');
			assert.match(seen, /3px border on its left side/);
			assert.match(seen, /inset shadow offset to one side/);
			assert.match(seen, /::before “[^”]*”: a 3×20 stripe/);
			await probe.close();

			const page = await open(site, '/admin/pages/rails-test');
			assert.ok(await page.isVisible(`${DOC} .brow.is-unknown`), 'a skipped row is shown');
			await walk('a skipped row', page);
			await page.click(row(1));
			await walk("a skipped block's level", page);
			await page.click(`${BLOCK} .cur .ib.boxed`);
			assert.ok(await page.isVisible(`${DOC} .brow.is-unknown.is-current`), 'the skipped row is selected');
			await walk('a skipped row, selected', page);
			await page.close();
			const home = await open(site);
			await home.waitForSelector(`${DOC} .brow [data-chip="too-long"]`);
			await walk('a warned row', home);
			await home.close();
			assert.deepEqual(found, []);
		} finally {
			rmSync(join(site.root, 'content/pages/rails-test.json'), { force: true });
		}
	});

	test('check 7: edged buttons sink into their edge on :active, quiet ones take the wash, disabled ones have no edge, and under reduced motion it is instant', async () => {
		const page = await open(sites.navy!);
		const colour = (token: string) => page.evaluate((t) => {
			const probe = document.createElement('i');
			probe.style.backgroundColor = `var(${t})`;
			document.body.append(probe);
			const c = getComputedStyle(probe).backgroundColor;
			probe.remove();
			return c;
		}, token);
		const press = async (html: string): Promise<{ rest: Look; down: Look; up: Look }> => {
			await page.evaluate((html) => {
				const host = document.createElement('div');
				host.id = 'press-probe';
				host.style.cssText = 'position:fixed;left:560px;top:320px;z-index:99999;padding:24px';
				host.innerHTML = html;
				document.body.append(host);
			}, html);
			const looks = await pressLook(page, page.locator('#press-probe button').first());
			await page.evaluate(() => document.getElementById('press-probe')!.remove());
			return looks;
		};
		const failures: string[] = [];
		const instant = (look: Look) => look.transition.split(',').every((t) => parseFloat(t) === 0);
		// Edged: the edge is there at rest, goes when pressed (the button sinks by its depth), and comes back on release.
		const edged: { name: string; html: string; sameColour?: boolean }[] = [
			{ name: 'secondary .btn', html: '<button class="btn">Cancel</button>' },
			{ name: 'branded .btn.ink', html: '<button class="btn ink">Create</button>' },
			{ name: '.btn.accent', html: '<button class="btn accent">Sign in</button>' },
			{ name: '.btn.danger', html: '<button class="btn danger">Delete</button>' },
			{ name: '.btn.phone', html: '<button class="btn phone">Save</button>' },
			{ name: '.btn.publish', html: '<button class="btn publish">Publish 2 changes</button>' },
			{ name: '.ib.boxed', html: '<button class="ib boxed" aria-label="More">+</button>' },
			{ name: 'the bar’s .docbtn', html: '<button class="docbtn"><span class="t">Home</span></button>' },
			{ name: 'the bar’s Publish (.pub)', html: '<button class="pub"><span class="wt">2 waiting</span><span class="pb">Publish</span></button>' },
			{ name: 'the toast’s button', html: '<div class="toast"><button class="btn">Undo</button></div>' },
			// Its edge is the warning frame's hard shadow, which pressing swaps for a flat ring of the frame's colour.
			{ name: '.bar-warn', html: '<button class="bar-warn">Preview not updated</button>', sameColour: false },
		];
		for (const c of edged) {
			const { rest, down, up } = await press(c.html);
			const at = (look: Look) => (look.edge ? `${look.edge.x},${look.edge.y}` : 'none');
			if (!rest.edge || (rest.edge.x === 0 && rest.edge.y === 0)) failures.push(`${c.name}: no edge at rest (${at(rest)})`);
			if (rest.translate !== 'none') failures.push(`${c.name}: sunk at rest (${rest.translate})`);
			if (down.translate !== '0px 2px') failures.push(`${c.name}: pressed, it moved ${down.translate}, want 0px 2px`);
			if (down.edge && (down.edge.x !== 0 || down.edge.y !== 0)) failures.push(`${c.name}: pressed, the edge is still ${at(down)}`);
			if (c.sameColour !== false && rest.edge && down.edge && rest.edge.colour !== down.edge.colour) failures.push(`${c.name}: pressed edge ${down.edge.colour} is not its edge at rest ${rest.edge.colour}`);
			if (up.translate !== 'none' || at(up) !== at(rest)) failures.push(`${c.name}: released, it is ${up.translate} / ${at(up)}, want back at rest`);
			for (const [when, look] of [['rest', rest], ['pressed', down]] as const) if (!instant(look)) failures.push(`${c.name}: under reduced motion it transitions ${look.transition} (${when})`);
		}
		// Quiet: no edge and no sink, only the pressed wash (the bar's quiet controls, the bar's wash).
		const quiet: { name: string; html: string; wash: string }[] = [
			{ name: '.btn.ghost', html: '<button class="btn ghost">Skip</button>', wash: '--surface-pressed' },
			{ name: '.ib', html: '<button class="ib" aria-label="More">+</button>', wash: '--surface-pressed' },
			{ name: 'the bar’s .side-toggle', html: '<button class="side-toggle" aria-label="Sidebar">+</button>', wash: '--bar-raised-hover' },
		];
		for (const c of quiet) {
			const { rest, down } = await press(c.html);
			if (rest.edge || down.edge) failures.push(`${c.name}: has an edge (${JSON.stringify(down.edge ?? rest.edge)})`);
			if (down.translate !== 'none') failures.push(`${c.name}: pressed, it moved ${down.translate}`);
			const wash = await colour(c.wash);
			if (down.background !== wash) failures.push(`${c.name}: pressed, the fill is ${down.background}, want ${c.wash} ${wash}`);
		}
		// Disabled: no edge, no sink, nothing happens when pressed.
		for (const cls of ['btn', 'btn ink', 'btn accent', 'btn danger', 'btn phone', 'btn publish']) {
			const { rest, down } = await press(`<button class="${cls}" disabled>Create</button>`);
			if (rest.edge || down.edge) failures.push(`.${cls.replace(/ /g, '.')} disabled: has an edge (${JSON.stringify(down.edge ?? rest.edge)})`);
			if (rest.translate !== 'none' || down.translate !== 'none') failures.push(`.${cls.replace(/ /g, '.')} disabled: it moved (${down.translate})`);
		}
		assert.deepEqual(failures, []);
		await page.close();

		// Without the preference the press does take time (so the check above can see it).
		const moving = await open(sites.navy!, '/admin', { reducedMotion: 'no-preference' });
		await moving.evaluate(() => {
			const b = document.createElement('button');
			b.className = 'btn';
			b.id = 'press-probe';
			document.querySelector('#side')!.append(b);
		});
		assert.ok(!instant(await moving.locator('#press-probe').evaluate(lookOf)), 'a button transitions without the preference');
		await moving.close();
	});

	test('check 9: the warning and danger frame is on what needs you and nothing calm, in the static chrome', async () => {
		const site = sites.navy!;
		const found: string[] = [];
		const seen: Record<string, number> = {};
		for (const state of STATES) {
			const page = await open(site);
			await state.go(page);
			await settle(page);
			const r = await page.evaluate(frameScan, undefined);
			for (const f of r.failures) found.push(`${state.name}: ${f}`);
			for (const [k, n] of Object.entries(r.seen)) seen[k] = (seen[k] ?? 0) + n;
			await page.close();
		}
		// A field typed past its limit (Exit 3): the page's SEO title over 60, then left, so it isn't focused.
		const over = await open(site);
		await over.click(`${DOC} details.seo summary`);
		const field = over.locator(`${DOC} details.seo input[data-path="title"]`);
		await field.fill('CaraCMS: a small design and print studio on the quay in Cork, Ireland');
		await over.waitForSelector(`${DOC} details.seo [data-over]`);
		await field.evaluate((el) => (el as HTMLElement).blur());
		await settle(over);
		const r = await over.evaluate(frameScan, undefined);
		for (const f of r.failures) found.push(`a field typed past its limit: ${f}`);
		for (const [k, n] of Object.entries(r.seen)) seen[k] = (seen[k] ?? 0) + n;
		await over.close();
		assert.deepEqual(found, []);
		for (const kind of ['.note.warn', '.note.danger', '.dialog.danger', 'a field over its limit', 'a popover or menu', 'a block or document row', '.bar-warn']) assert.ok(seen[kind], `the scan met ${kind} (${JSON.stringify(seen)})`);
	});

	test('Verify 4: under prefers-reduced-motion nothing in the chrome moves (and without it, it does)', async () => {
		const site = sites.navy!;
		const found: string[] = [];
		for (const state of STATES) {
			const page = await open(site, '/admin', { reducedMotion: 'reduce' });
			await state.go(page);
			// Keeping pulses while a write is on its way: catch it too.
			await page.click('#bar .seg button[data-width="tablet"]').catch(() => {});
			for (const f of await page.evaluate(moving)) found.push(`${state.name}: ${f}`);
			for (const f of await page.evaluate(layerMoving)) found.push(`${state.name}: ${f}`);
			await page.close();
		}
		assert.deepEqual(found, []);

		// Without the preference, the same check finds motion (so it can see it).
		const page = await open(site, '/admin', { reducedMotion: 'no-preference' });
		await page.click('#bar .docbtn');
		assert.ok((await page.evaluate(moving)).length > 0, 'motion is there without the preference');
		await page.close();
	});

	test('focus shows everywhere: a 2px ring, blue on light and pale blue on the bar (a text box rings itself)', async () => {
		const site = sites.navy!;
		const failures: string[] = [];
		let stops = 0;
		for (const state of [STATES[0]!, STATES[2]!, STATES[5]!, STATES[7]!, STATES[8]!, STATES[9]!, ...STATES.filter((x) => x.name.startsWith('M5b') || (x.name.startsWith('Arrange') && !x.name.includes('held down')))]) {
			const page = await open(site);
			await state.go(page);
			const seen = new Set<string>();
			for (let i = 0; i < 70; i++) {
				await page.keyboard.press('Tab');
				const r = await page.evaluate(() => {
					const el = document.activeElement as HTMLElement | null;
					if (!el || el === document.body || el.tagName === 'IFRAME') return null;
					const colour = (token: string) => {
						const probe = document.createElement('i');
						probe.style.color = `var(${token})`;
						document.body.append(probe);
						const c = getComputedStyle(probe).color;
						probe.remove();
						return c;
					};
					const cs = getComputedStyle(el);
					// On dark: the bar, the toast, and the dimmed stage beside Site Settings and the library (M5a, M5b).
					const onDark = !!el.closest('#bar, .toast, .stage-aside');
					const want = colour(onDark ? '--focus-on-dark' : '--focus');
					const id = `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join('')} “${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}”`;
					const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && cs.outlineColor === want;
					// A text box rings itself (border and halo) or its row (a lockup line, the switcher's box).
					const box = el.matches('input, textarea, select') ? (el.closest('.lk-row') as HTMLElement | null) ?? el : null;
					const boxRing = !!box && getComputedStyle(box).borderColor === colour(box.closest('.lk-field.phone') ? '--phone' : '--select') && getComputedStyle(box).boxShadow !== 'none';
					// A library tile rings its picture (M5b, the mockup's .mtile): a 2px inset ring in the focus blue on the picture's ::after.
					const ph = el.matches('.mtile') ? el.querySelector('.ph') : null;
					const tileRing = !!ph && getComputedStyle(ph, '::after').boxShadow.startsWith(`${want} 0px 0px 0px 2px inset`);
					return { id, ok: ring || boxRing || tileRing, detail: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} (want ${want})` };
				});
				if (!r) continue;
				stops += 1;
				if (seen.has(r.id)) continue;
				seen.add(r.id);
				if (!r.ok) failures.push(`${state.name}: ${r.id}: ${r.detail}`);
			}
			await page.close();
		}
		assert.ok(stops > 100, `enough focus stops were checked (${stops})`);
		assert.deepEqual(failures, []);
	});
});
