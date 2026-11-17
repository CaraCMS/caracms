// Posts and tags (Decision 13, Acceptance 14–16 as the package has them): the editor's
// table with a section builder's page fields as columns, a reference and a list of
// references, and a collection's default sort. A copy of the demo under `astro dev`, with
// two collections of its own in the copy only: Notes (a section builder with a date, a
// list of topics and a lead topic) opening newest first, and Topics (a list of fields with
// no pages of its own) opening Z to A. One note's lead is a topic that's gone.
//
//   node --test --experimental-strip-types test/posts-table.browser.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

const VIEWPORT = { width: 1440, height: 900 };

/** The copy's changes: its config and content only, never the demo's. */
function edit(root: string) {
	const config = join(root, 'caracms.config.ts');
	writeFileSync(
		config,
		readFileSync(config, 'utf8')
			.replace("import { defineSite } from 'caracms/config';", "import { date, defineSite, list, reference, text } from 'caracms/config';")
			.replace(
				"'case-studies': caseStudies,",
				`'case-studies': caseStudies,
		notes: {
			kind: 'sections',
			folder: 'content/notes',
			urlBase: '/notes/',
			fields: { date: date(), topics: list(reference({ to: 'topics' })), lead: reference({ to: 'topics' }) },
			columns: ['date', 'topics', 'lead', 'edited'],
			sort: { column: 'date', order: 'desc' },
		},
		topics: { kind: 'fields', folder: 'content/topics', component: 'src/collections/CaseStudy.astro', fields: { blurb: text() }, sort: { column: 'title', order: 'desc' } },`,
			),
	);
	const write = (folder: string, name: string, doc: object) => {
		mkdirSync(join(root, 'content', folder), { recursive: true });
		writeFileSync(join(root, 'content', folder, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
	};
	write('topics', 'print', { title: 'Print' });
	write('topics', 'kilns', { title: 'Kilns' });
	write('topics', 'dyes', { title: 'Dyes' });
	write('notes', 'first-light', { title: 'First light', date: '2026-03-01', topics: ['print', 'kilns'], lead: 'print', blocks: [] });
	write('notes', 'same-day', { title: 'Same day', date: '2026-03-01', topics: [], blocks: [] });
	write('notes', 'dye-day', { title: 'Dye day', date: '2025-11-20', topics: ['dyes'], lead: 'gone', blocks: [] });
	write('notes', 'undated', { title: 'Undated', topics: ['print', 'gone'], lead: 'kilns', blocks: [] });
}

let site: DevSite;
let browser: Browser;

async function open(): Promise<Page> {
	const page = await browser.newPage({ viewport: VIEWPORT });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(`${site.origin}/admin`);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
	return page;
}

const STAGE = (name: string) => `#stage .ctable[data-collection-table="${name}"]`;

/** Back up the sidebar's levels to the documents level, then open a collection there (as grid.browser.test.ts does). */
async function openCollection(page: Page, name: string) {
	const documents = () => page.isVisible('[data-pane-level="documents"]');
	for (let i = 0; i < 4 && !(await documents()); i++) {
		await page.keyboard.press('Escape');
		if (!(await documents())) await page.locator('.side-level:not([hidden]) .cur .ib.boxed').first().click();
	}
	await page.click(`[data-pane-level="documents"] [data-coll="${name}"]`);
	await page.waitForSelector(STAGE(name));
}

const titles = (page: Page, name: string) => page.locator(`${STAGE(name)} tbody .ct-open .nm`).allTextContents();
const cell = (page: Page, name: string, doc: string, column: number) => page.locator(`${STAGE(name)} tbody tr[data-doc="${name}/${doc}"] > :nth-child(${column})`);

describe('posts and tags: the table in the browser', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('posts-table', { edit });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test("Acceptance 14: a section builder's page fields as columns; it opens in the config's sort, newest first, undated last; the sidebar list agrees", async () => {
		const page = await open();
		await openCollection(page, 'notes');
		const head = await page.locator(`${STAGE('notes')} thead th`).allTextContents();
		assert.deepEqual(head, ['Title', 'Date', 'Topics', 'Lead', 'Last edited']);
		assert.deepEqual(await titles(page, 'notes'), ['First light', 'Same day', 'Dye day', 'Undated'], 'newest first, a tie by title, undated last');
		assert.equal(await page.getAttribute(`${STAGE('notes')} thead th:nth-child(2)`, 'aria-sort'), 'descending');
		assert.equal(await page.getAttribute(`${STAGE('notes')} thead th:nth-child(1)`, 'aria-sort'), null);
		const side = await page.locator('[data-pane-level="collection"] [data-doc^="notes/"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-doc')));
		assert.deepEqual(side, ['notes/first-light', 'notes/same-day', 'notes/dye-day', 'notes/undated'], 'the sidebar list in the same order');
		assert.equal(await cell(page, 'notes', 'first-light', 2).textContent(), '1 March 2026', 'a date in words');
		await page.close();
	});

	test('Acceptance 14: clicking Date sorts it both ways, undated last either way; a list of references has no sort', async () => {
		const page = await open();
		await openCollection(page, 'notes');
		await page.click(`${STAGE('notes')} thead th:nth-child(2) .ct-sort`);
		assert.deepEqual(await titles(page, 'notes'), ['Dye day', 'First light', 'Same day', 'Undated'], 'oldest first, undated still last');
		assert.equal(await page.getAttribute(`${STAGE('notes')} thead th:nth-child(2)`, 'aria-sort'), 'ascending');
		await page.click(`${STAGE('notes')} thead th:nth-child(2) .ct-sort`);
		assert.deepEqual(await titles(page, 'notes'), ['First light', 'Same day', 'Dye day', 'Undated']);
		assert.equal(await page.locator(`${STAGE('notes')} thead th:nth-child(3) button`).count(), 0, 'Topics: no sort button');
		// Lead sorts by the topic's title; the missing one goes last.
		await page.click(`${STAGE('notes')} thead th:nth-child(4) .ct-sort`);
		assert.deepEqual(await titles(page, 'notes'), ['Undated', 'First light', 'Dye day', 'Same day']);
		await page.close();
	});

	test('Acceptance 15: a reference shows its title; a missing one shows Missing in the warning colour and the row stays whole; a list joins its titles', async () => {
		const page = await open();
		await openCollection(page, 'notes');
		assert.equal(await cell(page, 'notes', 'undated', 4).textContent(), 'Kilns');
		assert.equal(await cell(page, 'notes', 'first-light', 3).textContent(), 'Print, Kilns');
		assert.equal(await cell(page, 'notes', 'undated', 3).textContent(), 'Print, Missing');
		const missing = cell(page, 'notes', 'dye-day', 4).locator('.ct-missing');
		assert.equal(await missing.textContent(), 'Missing');
		const colours = await missing.evaluate((el) => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--status-warning-strong)';
			document.body.append(probe);
			const want = getComputedStyle(probe).color;
			probe.remove();
			return { got: getComputedStyle(el).color, want, text: getComputedStyle(el.closest('tr')!.querySelector('.ct-open')!).color };
		});
		assert.equal(colours.got, colours.want, 'the warning colour');
		assert.notEqual(colours.got, colours.text);
		assert.equal(await cell(page, 'notes', 'dye-day', 1).locator('.nm').textContent(), 'Dye day', 'the row keeps its title');
		assert.equal(await cell(page, 'notes', 'dye-day', 3).textContent(), 'Dyes');
		assert.equal(await page.locator(`${STAGE('notes')} tbody tr[data-doc="notes/same-day"] > :nth-child(3) .ct-nil`).count(), 1, 'no topics: the dash');
		await page.close();
	});

	test("Acceptance 14: a filter picks one referenced document ('Topic: Print'), keeping the rows that include it", async () => {
		const page = await open();
		await openCollection(page, 'notes');
		const filter = `${STAGE('notes')} select[data-filter-key="topics"]`;
		const options = await page.locator(`${filter} option`).allTextContents();
		assert.deepEqual(options, ['Any topic', 'Topic: Dyes', 'Topic: Kilns', 'Topic: Print']);
		await page.selectOption(filter, { label: 'Topic: Print' });
		assert.deepEqual(await titles(page, 'notes'), ['First light', 'Undated']);
		assert.equal(await page.locator(`${STAGE('notes')} .n-chip`).textContent(), '2 of 4');
		// A single reference filters the same way, by its own label.
		assert.deepEqual(await page.locator(`${STAGE('notes')} select[data-filter-key="lead"] option`).allTextContents(), ['Any lead', 'Lead: Dyes', 'Lead: Kilns', 'Lead: Print']);
		await page.selectOption(`${STAGE('notes')} select[data-filter-key="lead"]`, { label: 'Lead: Kilns' });
		assert.deepEqual(await titles(page, 'notes'), ['Undated']);
		await page.close();
	});

	test("a list of fields with no pages of its own takes a top-level sort too (Topics opens Z to A); Pages and Case studies open by title as before", async () => {
		const page = await open();
		await openCollection(page, 'topics');
		assert.deepEqual(await titles(page, 'topics'), ['Print', 'Kilns', 'Dyes']);
		assert.equal(await page.getAttribute(`${STAGE('topics')} thead th:nth-child(1)`, 'aria-sort'), 'descending');
		await openCollection(page, 'case-studies');
		assert.equal(await page.getAttribute(`${STAGE('case-studies')} thead th:nth-child(1)`, 'aria-sort'), 'ascending', 'no sort configured: the title, A to Z');
		await page.close();
	});

	test("the header row stays pinned as the table scrolls, the Title cell with the rest (it once took the heading's flex rule and scrolled away)", async () => {
		const page = await open();
		await page.setViewportSize({ width: 1440, height: 300 });
		await openCollection(page, 'notes');
		const scroller = page.locator(`${STAGE('notes')} .ct-scroll`);
		const scrolled = await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
			return el.scrollTop;
		});
		assert.ok(scrolled > 40, `the table scrolls (by ${scrolled}px)`);
		const tops = await page.locator(`${STAGE('notes')} thead th`).evaluateAll((ths) => ths.map((th) => Math.round(th.getBoundingClientRect().top)));
		const box = await scroller.evaluate((el) => Math.round(el.getBoundingClientRect().top));
		assert.equal(new Set(tops).size, 1, `every header cell at the same top: ${tops.join(', ')}`);
		assert.ok(tops[0] >= box - 8 && tops[0] <= box, `pinned at the top of the scroller (${tops[0]} against ${box})`);
		assert.equal(await page.locator(`${STAGE('notes')} thead th:first-child`).evaluate((th) => getComputedStyle(th).display), 'table-cell');
		await page.close();
	});
});
