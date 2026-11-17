// M6c (G5): the grid view in a real browser (Acceptance 19–25). A copy of the demo under
// `astro dev` with the in-memory media (CARACMS_MEDIA=memory: the signing keys are the
// tests' own, and img.test never answers, which is what a slow image looks like), and in
// the copy only: Case studies at 3:2, the Journal opening in Grid, a journal entry that
// opens with text and has its picture further down, one whose first media is a loop, and a
// case study that can't be opened. The marks (lock, waiting, conflict) run in live mode on
// the in-memory GitHub, signed in as two people.
//
//   node --test --experimental-strip-types test/grid.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { AOIFE, CIARAN, eventually, keepState, openAdmin, runtime, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

const VIEWPORT = { width: 1440, height: 900 };
const TIMINGS = { sweepIdleMs: 1500, sweepTickMs: 500, sweepCapMs: 10_000, lockLapseMs: 20_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 1000 };

const IMAGE = { key: 'uploads/0a1b2c3d4e5f/press-sheets.jpg', alt: 'Proofs of the catalogue on the press', focal: [0.3, 0.7], w: 3000, h: 2000 };

/** The copy's changes: its config and content only, never the demo's. */
function edit(root: string) {
	const cases = join(root, 'src/collections/case-studies.ts');
	writeFileSync(cases, readFileSync(cases, 'utf8').replace(/\n\tcolumns: \[/, "\n\tview: { ratio: '3:2' },\n\tcolumns: ["));
	const config = join(root, 'caracms.config.ts');
	writeFileSync(config, readFileSync(config, 'utf8').replace("heldBy: 'pages', fields: journalFields }", "heldBy: 'pages', fields: journalFields, view: { default: 'grid' } }"));
	const journal = (name: string, doc: object) => writeFileSync(join(root, 'content/journal', `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
	journal('printing-the-autumn-catalogue', {
		title: 'Printing the autumn catalogue',
		blocks: [
			{ type: 'text', heading: 'On press', body: 'Two days at the printer, and every sheet checked by hand.', background: 'light' },
			{ type: 'tm', body: 'The proofs.', media: IMAGE, side: 'left', background: 'light' },
		],
	});
	journal('a-loop-from-the-ridge', {
		title: 'A loop from the ridge',
		blocks: [{ type: 'hero', heading: ['From', 'The ridge'], intro: 'Wind on the grass.', layout: 'left', background: 'photo', media: { video: 'ridgeplayback123', play: 'loop', poster: 2, duration: 14, name: 'Ridge loop' } }],
	});
	writeFileSync(join(root, 'content/case-studies/broken.json'), '{ "title": "Broken", ');
}

let site: DevSite;
let browser: Browser;

async function open(path = '/admin', context?: BrowserContext): Promise<Page> {
	const page = context ? await context.newPage() : await browser.newPage({ viewport: VIEWPORT });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
	return page;
}

const STAGE = (name: string) => `#stage .ctable[data-collection-table="${name}"]`;

/** Back up the sidebar's levels to the documents level, then open a collection there. */
async function openCollection(page: Page, name: string, section = '') {
	const documents = () => page.isVisible('[data-pane-level="documents"]');
	for (let i = 0; i < 4 && !(await documents()); i++) {
		await page.keyboard.press('Escape');
		if (!(await documents())) await page.locator('.side-level:not([hidden]) .cur .ib.boxed').first().click();
	}
	await page.click(`[data-pane-level="documents"] ${section}[data-coll="${name}"]`);
	await page.waitForSelector(STAGE(name));
}

const cardTitles = (page: Page, name: string) => page.locator(`${STAGE(name)} .card .card-t .nm`).allTextContents();

describe('the grid view in the browser', { skip: browserSkip }, () => {
	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		site = await startDevSite('grid', { edit });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
		delete process.env.CARACMS_MEDIA;
	});

	test('Acceptance 19: Case studies and the Journal have the List / Grid switch; Shared blocks never do, and Pages stays a tree', async () => {
		const page = await open();
		await openCollection(page, 'case-studies');
		assert.equal(await page.locator(`${STAGE('case-studies')} .ct-view [role="radio"]`).count(), 2);
		assert.equal(await page.getAttribute(`${STAGE('case-studies')} [data-view-mode="list"]`, 'aria-checked'), 'true', 'Case studies opens in List (the default)');
		await openCollection(page, 'journal');
		assert.equal(await page.getAttribute(`${STAGE('journal')} [data-view-mode="grid"]`, 'aria-checked'), 'true', "the Journal opens in Grid: the copy's view.default");
		await openCollection(page, 'shared', '[data-section="site-wide"] ');
		assert.equal(await page.locator(`${STAGE('shared')} .ct-view`).count(), 0, 'no switch on Shared blocks');
		assert.equal(await page.locator(`${STAGE('shared')} table.ct`).count(), 1);
		await page.click('[data-pane-level="collection"] .cur .ib.boxed');
		assert.equal(await page.locator('[data-pane-level="documents"] [data-coll="pages"]').count(), 0, 'Pages is the tree on the documents level, with no level of its own to switch');
		assert.equal(await page.locator('[data-pane-level="documents"] [data-collection="pages"]').count(), 1);
		await page.close();
	});

	test("Acceptance 20, 21, 25: each card is the first image cropped at its focal point to the collection's ratio, signed in the listing (never the thumbnail route); the text card; a picture further down; a loop's poster; the box holds its ratio while the image loads", async () => {
		const page = await open();
		const thumbs: string[] = [];
		page.on('request', (r) => {
			if (r.url().includes('/_caracms/media/thumbnail')) thumbs.push(r.url());
		});
		await openCollection(page, 'case-studies');
		await page.click(`${STAGE('case-studies')} [data-view-mode="grid"]`);
		const grid = `${STAGE('case-studies')} .cgrid`;
		await page.waitForSelector(grid);
		assert.equal(await page.getAttribute(STAGE('case-studies'), 'aria-label'), 'Case studies, as a grid');
		assert.equal(await page.getAttribute(grid, 'data-ratio'), '3:2');

		// High-street coffee roaster's cover (the fixture's), cropped by imgproxy at 3:2 with its focal point as gravity, 320 and 640 wide.
		const harbour = page.locator(`${grid} .card[data-doc="case-studies/high-street-coffee"]`);
		const img = harbour.locator('img.card-img');
		assert.match((await img.getAttribute('src'))!, /^https:\/\/img\.test\/[\w-]+\/rs:fill:320:213\/g:fp:0\.62:0\.55\/q:80\/plain\/s3:\/\/caracms-test-media\/uploads\/6d1f0a93be27\/harbour-shopfront\.jpg@webp$/);
		assert.match((await img.getAttribute('srcset'))!, /rs:fill:640:427\/g:fp:0\.62:0\.55\/.* 2x$/);
		assert.equal(await img.getAttribute('alt'), 'The coffee shopfront at dusk, with the new window signs lit');
		// Its title and the first two worded columns (Client, Sector: the Featured toggle has no words).
		assert.equal(await harbour.locator('.card-t .nm').textContent(), 'High-street coffee roaster');
		// Review gaps (Decision 3): Case studies is manual, so a card says its place in Site order first.
		assert.deepEqual(await harbour.locator('.card-c').allTextContents(), ['4 · High-street coffee roaster', 'Food and drink']);

		// img.test never answers: the picture's box holds 3:2 on its flat surface, and nothing moves when it would land.
		const box = await harbour.locator('.ph').boundingBox();
		assert.ok(box && Math.abs(box.width / box.height - 1.5) < 0.02, `3:2 (got ${box?.width}×${box?.height})`);
		assert.equal(await img.evaluate((el) => getComputedStyle(el).opacity), '0', 'not shown before it has loaded');
		assert.equal(await harbour.locator('.ph').evaluate((el) => getComputedStyle(el).animationName), 'none', 'no shimmer');

		// A case study with no picture: the text card, its title in the picture's place, at the same ratio.
		const oak = page.locator(`${grid} .card[data-doc="case-studies/oak-furniture"]`);
		assert.equal(await oak.locator('.ph.tcard .tc-t').textContent(), 'Oak furniture maker');
		const tbox = await oak.locator('.ph').boundingBox();
		assert.ok(tbox && Math.abs(tbox.width / tbox.height - 1.5) < 0.02, 'the text card holds the ratio too');
		assert.equal(Math.round(tbox!.height), Math.round(box!.height), 'cards line up');

		// The Journal (a section builder, 4:3 by default): the picture further down, a loop's poster, text cards, when each was last edited.
		await openCollection(page, 'journal');
		const jgrid = `${STAGE('journal')} .cgrid`;
		await page.waitForSelector(jgrid);
		assert.equal(await page.getAttribute(jgrid, 'data-ratio'), '4:3');
		const press = page.locator(`${jgrid} .card[data-doc="journal/printing-the-autumn-catalogue"]`);
		assert.match((await press.locator('img.card-img').getAttribute('src'))!, /\/rs:fill:320:240\/g:fp:0\.3:0\.7\/.*press-sheets\.jpg@webp$/, 'opens with text: its card is the picture in the second block');
		const ridge = page.locator(`${jgrid} .card[data-doc="journal/a-loop-from-the-ridge"]`);
		assert.equal(await ridge.locator('img.card-img').getAttribute('src'), 'https://image.mux.com/ridgeplayback123/thumbnail.webp?width=320&height=240&fit_mode=crop&time=2');
		assert.equal(await ridge.locator('.pbadge').textContent(), '0:14');
		assert.equal(await page.locator(`${jgrid} .card[data-doc="journal/a-new-home-for-caracms"] .tcard`).count(), 1, 'no image in any block: a text card');
		assert.match((await press.locator('.card-c').textContent())!, /^Edited /);
		const jbox = await press.locator('.ph').boundingBox();
		assert.ok(jbox && Math.abs(jbox.width / jbox.height - 4 / 3) < 0.02, '4:3');

		assert.deepEqual(thumbs, [], 'no request to the thumbnail route');
		await page.close();
	});

	test('Acceptance 23: find, filters, the order select and + New work in Grid as in List; the open document is a wash and a full ring; a card that can\'t be opened says why', async () => {
		const page = await open('/admin/case-studies/high-street-coffee');
		await page.click('[data-pane-level="document"] .cur .ib.boxed');
		await page.waitForSelector(STAGE('case-studies'));
		const table = STAGE('case-studies');
		if ((await page.getAttribute(`${table} [data-view-mode="grid"]`, 'aria-checked')) !== 'true') await page.click(`${table} [data-view-mode="grid"]`);
		await page.waitForSelector(`${table} .cgrid`);
		const all = await cardTitles(page, 'case-studies');
		assert.equal(all.length, 7, "the fixture's six and the broken one");
		// Review gaps (Decision 3): Case studies is manual, so it opens in Site order: the fixture's seeded six, then the one it doesn't name.
		assert.deepEqual(all, ['Nature film studio', 'Tiny publisher', 'Oak furniture maker', 'High-street coffee roaster', 'Sourdough bakery', 'Weekend bike shop', 'Broken'], 'in Site order');
		assert.deepEqual(await page.locator('#coll-list .drow .nm').allTextContents(), all, 'the sidebar lists the same, in the same order');

		// The open document: a wash and a full ring (all four sides), no rail.
		const current = page.locator(`${table} .card.is-current`);
		assert.equal(await current.getAttribute('data-doc'), 'case-studies/high-street-coffee');
		assert.equal(await current.getAttribute('aria-current'), 'page');
		const ring = await current.evaluate((el) => {
			const s = getComputedStyle(el);
			return { widths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth], colours: new Set([s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor]).size, bg: s.backgroundColor, shadow: s.boxShadow };
		});
		assert.deepEqual(ring.widths, ['1px', '1px', '1px', '1px'], 'a full ring');
		assert.equal(ring.colours, 1, 'one colour all round');
		assert.notEqual(ring.bg, 'rgba(0, 0, 0, 0)', 'a wash');
		assert.equal(ring.shadow, 'none', 'no inset rail');

		// The order is a select in Grid (no headers); it's the same view's sort as List's.
		assert.equal(await page.locator(`${table} thead`).count(), 0);
		// (Site order is the seeded newest launch first, so oldest first is the order that differs.)
		await page.selectOption(`${table} select[data-order]`, { label: 'Order: Launched, oldest first' });
		const newest = await cardTitles(page, 'case-studies');
		assert.notDeepEqual(newest, all);
		await page.click(`${table} [data-view-mode="list"]`);
		await page.waitForSelector(`${table} table.ct`);
		assert.equal(await page.getAttribute(`${table} thead th:has-text("Launched")`, 'aria-sort'), 'ascending', "List's header shows the order Grid set");
		assert.deepEqual((await page.locator(`${table} tbody .ct-open .nm`).allTextContents()), newest);
		await page.click(`${table} [data-view-mode="grid"]`);
		await page.selectOption(`${table} select[data-order]`, { label: 'Order: Title, A to Z' });

		// Filters and find narrow the cards and the sidebar alike; nothing left says so, with a way back.
		await page.selectOption(`${table} select[data-filter-key="sector"]`, { label: 'Food and drink' });
		const food = await cardTitles(page, 'case-studies');
		assert.ok(food.includes('High-street coffee roaster') && food.length < all.length);
		assert.deepEqual(await page.locator('#coll-list .drow .nm').allTextContents(), food);
		await page.fill(`${table} input[data-filter="table"]`, 'high-street');
		assert.deepEqual(await cardTitles(page, 'case-studies'), ['High-street coffee roaster']);
		await page.fill(`${table} input[data-filter="table"]`, 'linen');
		assert.equal(await page.locator(`${table} .card`).count(), 0);
		assert.match((await page.textContent(`${table} .ct-none`))!, /Nothing in Case studies matches/);
		await page.click(`${table} .ct-none .linkbtn`);
		assert.equal((await cardTitles(page, 'case-studies')).length, all.length);

		// A card that can't be opened has the warning mark, and says why rather than opening.
		const broken = page.locator(`${table} .card[data-doc="case-studies/broken"]`);
		assert.equal(await broken.locator('[data-warning="invalid-json"]').count(), 1);
		await broken.click();
		await eventually(async () => /Broken can't be opened/.test((await page.textContent('#live')) ?? ''), 4000, 'the announcement');
		assert.equal(await page.isVisible(`${table} .cgrid`), true, 'still in the grid');

		// + New opens the same dialog; a card opens its document, and the grid gives way to the preview.
		await page.click(`${table} [data-act="table-new"]`);
		await page.waitForSelector('[role="dialog"]');
		await page.keyboard.press('Escape');
		await page.locator(`${table} .card[data-doc="case-studies/weekend-bikes"]`).click();
		await page.waitForURL(/\/admin\/case-studies\/weekend-bikes$/);
		await page.waitForSelector('[data-pane-level="document"] [data-form]');
		await page.close();
	});

	test("Acceptance 24: the choice survives a fresh page load, in the UI cookie, and the collection draws in it at once (never the other view first); a collection never switched shows the config's default", async () => {
		const context = await browser.newContext({ viewport: VIEWPORT });
		const page = await open('/admin', context);
		await openCollection(page, 'case-studies');
		await page.click(`${STAGE('case-studies')} [data-view-mode="grid"]`);
		await page.waitForSelector(`${STAGE('case-studies')} .cgrid`);
		await openCollection(page, 'journal');
		await page.click(`${STAGE('journal')} [data-view-mode="list"]`);
		await page.waitForSelector(`${STAGE('journal')} table.ct`);
		const cookie = (await context.cookies()).find((c) => c.name === 'caracms-ui');
		assert.deepEqual(JSON.parse(decodeURIComponent(cookie!.value)).views, { 'case-studies': 'grid', journal: 'list' });

		// A new page in the same browser (the cookie stays), watched from before any of its scripts
		// run: every DOM change on the document, and every animation frame, records which view each
		// collection's table shows. Neither collection may ever show the other view, not for a frame.
		await page.close();
		const again = await context.newPage();
		await again.addInitScript(() => {
			const w = window as unknown as { seen: string[] };
			w.seen = [];
			const look = () => {
				for (const t of document.querySelectorAll<HTMLElement>('.ctable[data-collection-table]')) {
					w.seen.push(`${t.dataset.collectionTable}:${t.querySelector('.cgrid') ? 'grid' : t.querySelector('table.ct') ? 'list' : 'none'}`);
				}
			};
			new MutationObserver(look).observe(document, { childList: true, subtree: true });
			const frame = () => {
				look();
				requestAnimationFrame(frame);
			};
			requestAnimationFrame(frame);
		});
		again.on('pageerror', (error) => console.error('[page]', error.message));
		await again.goto(site.origin + '/admin');
		await again.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		await openCollection(again, 'case-studies');
		await again.waitForSelector(`${STAGE('case-studies')} .cgrid`);
		await openCollection(again, 'journal');
		await again.waitForSelector(`${STAGE('journal')} table.ct`);
		await again.waitForTimeout(300); // a few more frames
		const seen = [...new Set(await again.evaluate(() => (window as unknown as { seen: string[] }).seen))].sort();
		assert.ok(seen.includes('case-studies:grid') && seen.includes('journal:list'), `both tables were drawn and seen (${seen.join(', ')})`);
		assert.deepEqual(
			seen.filter((x) => x === 'case-studies:list' || x === 'journal:grid'),
			[],
			`never the other view, not even for a frame (${seen.join(', ')})`,
		);
		assert.ok(!seen.some((x) => x.endsWith(':none')), `nor an empty table (${seen.join(', ')})`);
		await again.close();

		// A fresh browser: nothing chosen, so each collection shows its config's default.
		const fresh = await open('/admin');
		await openCollection(fresh, 'journal');
		assert.equal(await fresh.locator(`${STAGE('journal')} .cgrid`).count(), 1, 'the Journal: Grid, its view.default');
		await openCollection(fresh, 'case-studies');
		assert.equal(await fresh.locator(`${STAGE('case-studies')} table.ct`).count(), 1, 'Case studies: List');
		await fresh.close();
		await context.close();
	});
});

describe('the grid view, live: a card shows the marks a row shows', { skip: browserSkip }, () => {
	let live: LiveSite;
	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		live = await startLiveSite('grid-live', { CARACMS_TIMINGS: JSON.stringify(TIMINGS) });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await live?.close();
		delete process.env.CARACMS_MEDIA;
	});

	test("Acceptance 23: someone's lock on the picture, the waiting dot, and the conflict mark once main changed the same document", async () => {
		const { site: s } = live;
		const contextA = await signedIn(browser, s, AOIFE);
		const a = await openAdmin(contextA, s, '/admin/case-studies/high-street-coffee');
		const client = '[data-pane-level="document"] [data-ff="client"] input';
		await a.waitForSelector(client);
		await a.fill(client, 'High-street coffee roaster Ltd');
		await eventually(async () => (await keepState(a)) === 'kept', 10_000, 'A: Kept');

		const b = await openAdmin(await signedIn(browser, s, CIARAN), s, '/admin/case-studies/weekend-bikes');
		await b.click('[data-pane-level="document"] .cur .ib.boxed');
		await b.waitForSelector(STAGE('case-studies'));
		await b.click(`${STAGE('case-studies')} [data-view-mode="grid"]`);
		const card = b.locator(`${STAGE('case-studies')} .card[data-doc="case-studies/high-street-coffee"]`);
		await eventually(async () => (await card.locator('.card-lock[data-mark="editing"]').count()) === 1, 10_000, "B: Aoife's lock on the picture");
		assert.match((await card.locator('.card-lock').textContent())!, /aoife is editing/i);
		assert.equal(await card.locator('.card-t [data-mark="editing"]').count(), 0, 'said once, on the picture');
		assert.match((await card.getAttribute('aria-labelledby'))!, /-t$/);
		assert.match((await card.locator('.card-t').textContent())!, /aoife is editing/i, "the card's name carries it for a screen reader");
		await eventually(async () => (await card.locator('[data-mark="waiting"]').count()) === 1, 15_000, 'B: the waiting dot');

		// A developer changes the same document on main: the merge keeps the draft, and the card is marked.
		const rt = await runtime();
		await eventually(() => !rt.git.waiting().every((w) => w.file !== 'content/case-studies/high-street-coffee.json'), 15_000, 'the sweep committed the draft');
		const file = 'starter/content/case-studies/high-street-coffee.json';
		rt.backend.push('main', { [file]: rt.backend.file('main', file)!.replace(/"client": "[^"]*"/, '"client": "Changed on main"') });
		await a.click('[data-pane-level="document"] .cur .ib.boxed');
		await a.waitForSelector(STAGE('case-studies'));
		if ((await a.getAttribute(`${STAGE('case-studies')} [data-view-mode="grid"]`, 'aria-checked')) !== 'true') await a.click(`${STAGE('case-studies')} [data-view-mode="grid"]`);
		await eventually(async () => (await a.locator(`${STAGE('case-studies')} .card[data-doc="case-studies/high-street-coffee"] [data-mark="kept"]`).count()) === 1, 20_000, "A: the card's conflict mark");
		await contextA.close();
	});
});
