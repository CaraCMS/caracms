// Where rich text is typed on the page, and where it never is (on-page rich text,
// Decision 1), on a test site with the cases the demo doesn't have: a "note" block with a
// top-level rich-text body, a body with no headings and no links, and a list whose items
// each hold a rich-text body; a page that uses a shared note; and the shared note on its own.
//
//   typed on the page   a top-level body of a block; a shared block on its own document
//   never               rich text in a list item (`items.0.body`), a shared entry on a page that uses it:
//                       no tabindex in the preview render, never mounted, a click opens the sidebar
//   the bar             a field with no headings and no links has no style menu and no Link button
//
//   node --test --experimental-strip-types test/page-rich-text-edges.browser.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { caretSettled, charPoint, fieldState, revealBody } from './helpers/rich-on-page.ts';

let site: DevSite;
let browser: Browser;

const PAGE_FILE = 'content/pages/edges.json';
const SHARED_FILE = 'content/shared/aside.json';

const CONFIG = `import { defineSite, list, richText, text } from 'caracms/config';

export default defineSite({
	collections: {
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
	},
	blocks: {
		note: {
			label: 'Note',
			component: 'src/blocks/Note.astro',
			fields: {
				heading: text({ heading: true }),
				body: richText({ label: 'Body', headings: ['h2', 'h3'] }),
				plain: richText({ label: 'Plain', links: false }),
				items: list({ label: text(), body: richText() }, { label: 'Items' }),
			},
		},
	},
	textStyles: {},
	page: 'src/components/EdgesPage.astro',
	timeZone: 'Europe/Dublin',
});
`;

const NOTE = `---
import Block from 'caracms/components/Block.astro';
import RichText from 'caracms/components/RichText.astro';
import Text from 'caracms/components/Text.astro';
const { block, cms } = Astro.props;
---
<Block cms={cms} class="note">
	<Text cms={cms} field="heading" value={block.heading} />
	<RichText cms={cms} field="body" value={block.body} class="note-body" />
	<RichText cms={cms} field="plain" value={block.plain} class="note-plain" />
	<ul class="items">
		{block.items.map((item, i) => (
			<li><Text cms={cms} field={\`items.\${i}.label\`} value={item.label} as="span" /> <RichText cms={cms} field={\`items.\${i}.body\`} value={item.body} class="item-body" /></li>
		))}
	</ul>
</Block>
<style>.note { display: block; padding: 40px; } .items li { padding: 12px 0; }</style>
`;

const PAGE = `---
import Blocks from 'caracms/components/Blocks.astro';
const { document, preview = false } = Astro.props;
---
<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>{document.title}</title></head>
<body><main><Blocks document={document} preview={preview} /></main></body></html>
`;

const NOTE_BLOCK = {
	type: 'note',
	heading: 'Notes',
	body: [{ p: 'The top level body has words in it.' }],
	plain: [{ p: 'A plain field with its words.' }],
	items: [{ label: 'One', body: [{ p: 'The first item body has words.' }] }],
};
const PAGE_DOC = { title: 'Edges', blocks: [NOTE_BLOCK, { shared: 'aside' }] };
const SHARED_DOC = {
	title: 'Aside',
	block: { type: 'note', heading: 'Aside', body: [{ p: 'The shared body has its own words.' }], plain: [{ p: 'Shared plain words.' }], items: [] },
};
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const frameOn = (page: Page) => page.frameLocator('.frame.on iframe');
const block = '[data-pane-level="block"]';
const TOP = '[data-cms-block="0"] [data-cms-field="body"]';
const ITEM = '[data-cms-block="0"] [data-cms-field="items.0.body"]';
const PLAIN = '[data-cms-block="0"] [data-cms-field="plain"]';
const SHARED_ENTRY = '[data-cms-block="1"][data-cms-shared="aside"]';

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 30000 });
	return page;
}

async function eventually<T>(check: () => T | Promise<T>, timeout = 8000, what = 'the condition'): Promise<T> {
	const end = Date.now() + timeout;
	let last: unknown;
	while (Date.now() < end) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			last = error;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/** Anything of a page editor in any iframe of the stage. */
const editorsAnywhere = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].reduce((n, f) => n + f.contentDocument!.querySelectorAll('.ProseMirror, [contenteditable]:not([contenteditable="plaintext-only"])').length, 0),
	);

/** What the preview render gives a rich-text element: its attributes, as the render left them. */
const attributesOf = (page: Page, selector: string) =>
	page.evaluate((selector) => {
		const el = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!.querySelector(selector);
		return el ? { tabindex: el.getAttribute('tabindex'), field: el.getAttribute('data-cms-field'), kind: el.getAttribute('data-cms-kind'), editable: el.hasAttribute('contenteditable'), cls: el.getAttribute('class') } : null;
	}, selector);

describe('on-page rich text: where it is typed and where it never is', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('page-rich-edges', {
			edit(root) {
				writeFileSync(join(root, 'caracms.config.ts'), CONFIG);
				mkdirSync(join(root, 'src/blocks'), { recursive: true });
				writeFileSync(join(root, 'src/blocks/Note.astro'), NOTE);
				writeFileSync(join(root, 'src/components/EdgesPage.astro'), PAGE);
				writeFileSync(join(root, PAGE_FILE), json(PAGE_DOC));
				mkdirSync(join(root, 'content/shared'), { recursive: true });
				writeFileSync(join(root, SHARED_FILE), json(SHARED_DOC));
			},
		});
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});
	beforeEach(() => {
		site.write(PAGE_FILE, json(PAGE_DOC));
		site.write(SHARED_FILE, json(SHARED_DOC));
	});

	test('rich text in a list item is the sidebar\'s: no tabindex, never mounted, a click opens its row; the block\'s top-level body is typed on the page', async () => {
		const page = await open('/admin/pages/edges');
		// The render: the top-level body is focusable (the page editor mounts on it); the item's is not.
		assert.deepEqual(await attributesOf(page, TOP), { tabindex: '0', field: 'body', kind: 'richText', editable: false, cls: 'note-body' });
		assert.deepEqual(await attributesOf(page, ITEM), { tabindex: null, field: 'items.0.body', kind: 'richText', editable: false, cls: 'item-body' });

		// The pointer on the item, and a focus from script: nothing mounts.
		await revealBody(page, ITEM);
		const at = await charPoint(page, 'first item', 3, ITEM);
		await page.mouse.move(at.x - 20, at.y);
		await page.mouse.move(at.x, at.y, { steps: 3 });
		await new Promise((r) => setTimeout(r, 300)); // a negative wait: nothing should happen
		assert.equal((await fieldState(page, 1440, ITEM)).mounted, false, 'not mounted under the pointer');
		assert.equal(await editorsAnywhere(page), 0);

		// A click opens the block with the list item's row, and the item's rich-text field in the sidebar is where it goes.
		await page.mouse.click(at.x, at.y);
		await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="items"]`);
		// Focus in an element that takes typing, not only somewhere in the item: the sidebar's
		// rich-text editor mounts a frame or so after its row opens, and focus once landed on its
		// toolbar's Bold button instead (focusSidebarField now waits for the editor; "ZZ" never
		// reached the file).
		await eventually(
			() =>
				page.evaluate(() => {
					const a = document.activeElement as HTMLElement | null;
					return !!a?.closest('[data-pane-level="block"] [data-ff="items"]') && (a.isContentEditable || a.matches('input, textarea'));
				}),
			10000,
			'typing focus in the sidebar\'s item',
		);
		assert.equal((await fieldState(page, 1440, ITEM)).mounted, false, 'still the render');
		assert.equal(await editorsAnywhere(page), 0, 'no page editor anywhere');
		assert.equal(await page.locator(`${block} .chip.typing`).count(), 0, 'not "Typing on the page"');
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-rtbar').count(), 0, 'no bar');

		// Typing goes to the sidebar's field, not the page's element.
		await page.keyboard.type('ZZ');
		await eventually(() => JSON.stringify(JSON.parse(site.read(PAGE_FILE)).blocks[0].items[0].body).includes('ZZ'), 15000, 'the item\'s body in the file, from the sidebar');

		// The same block's top-level body is typed on the page.
		await revealBody(page, TOP);
		const top = await charPoint(page, 'body', 1, TOP);
		await page.mouse.move(top.x, top.y);
		await eventually(async () => (await fieldState(page, 1440, TOP)).mounted, 4000, 'the top-level body mounted');
		await page.mouse.click(top.x, top.y);
		await eventually(async () => (await fieldState(page, 1440, TOP)).focused, 4000, 'typing in the top-level body');
		await caretSettled(page, 1440, TOP);
		await page.keyboard.type('Q');
		await eventually(() => JSON.stringify(JSON.parse(site.read(PAGE_FILE)).blocks[0].body).includes('bQody'), 8000, 'the top-level body in the file');
		await page.close();
	});

	test('a shared entry on a page that uses it: its fields are the shared block\'s, never mounted for the page; the first click selects it, a click on its words opens it over the page and types into the shared file', async () => {
		const page = await open('/admin/pages/edges');
		const sharedBody = `${SHARED_ENTRY} .note-body`;
		// Marked as the shared block's (Decision 8, amended 2026-11-16): its source on the field, never on the root.
		assert.deepEqual(await attributesOf(page, sharedBody), { tabindex: '0', field: 'body', kind: 'richText', editable: false, cls: 'note-body' });
		assert.equal(await frameOn(page).locator(sharedBody).getAttribute('data-cms-source'), 'shared/aside');
		assert.equal(await frameOn(page).locator(SHARED_ENTRY).getAttribute('data-cms-source'), null);
		await revealBody(page, sharedBody);
		const at = await charPoint(page, 'own words', 1, sharedBody);
		await page.mouse.move(at.x - 20, at.y);
		await page.mouse.move(at.x, at.y, { steps: 3 });
		await new Promise((r) => setTimeout(r, 300)); // a negative wait: not the page's to mount
		assert.equal(await editorsAnywhere(page), 0, 'nothing mounted under the pointer');
		// The first click selects it as the page's block: the shared panel, no fields, nothing written.
		await page.mouse.click(at.x, at.y);
		await page.waitForSelector('[data-shared-panel]');
		assert.equal(await page.locator(`${block} .field-frame`).count(), 0, 'no fields of its own there');
		await page.keyboard.type('zzz');
		await new Promise((r) => setTimeout(r, 500)); // a negative wait: nothing is written
		assert.equal(site.read(SHARED_FILE), json(SHARED_DOC), 'the shared block\'s file is untouched');
		assert.equal(site.read(PAGE_FILE), json(PAGE_DOC), 'and so is the page\'s');
		// A click on its words opens it over the page; its body is then typed on the page, into the shared file.
		await page.mouse.click(at.x, at.y);
		await eventually(() => new URL(page.url()).pathname === '/admin/shared/aside', 8000, '/admin/shared/aside');
		await revealBody(page, sharedBody);
		const again = await charPoint(page, 'own words', 1, sharedBody);
		await page.mouse.move(again.x - 20, again.y);
		await page.mouse.move(again.x, again.y, { steps: 3 });
		await eventually(async () => (await fieldState(page, 1440, sharedBody)).mounted, 4000, 'the page editor on the shared body');
		await page.mouse.click(again.x, again.y);
		await eventually(async () => (await fieldState(page, 1440, sharedBody)).focused, 4000, 'typing in the shared body');
		await caretSettled(page, 1440, sharedBody);
		await page.keyboard.type('Q');
		await eventually(() => JSON.stringify(JSON.parse(site.read(SHARED_FILE)).block.body).includes('Q'), 8000, 'the shared body in the shared file');
		assert.equal(site.read(PAGE_FILE), json(PAGE_DOC), 'the page\'s file is untouched');
		await page.close();
	});

	test('the shared block on its own document is typed on the page and stored in the shared file', async () => {
		const page = await open('/admin/shared/aside');
		const body = '[data-cms-block="0"] [data-cms-field="body"]';
		assert.equal((await attributesOf(page, body))?.tabindex, '0');
		await revealBody(page, body);
		const at = await charPoint(page, 'own words', 1, body);
		await page.mouse.move(at.x, at.y);
		await eventually(async () => (await fieldState(page, 1440, body)).mounted, 4000, 'the page editor on hover');
		assert.equal((await fieldState(page, 1440, body)).wrapper, false);
		await page.mouse.click(at.x, at.y);
		await eventually(async () => (await fieldState(page, 1440, body)).focused, 4000, 'typing in the shared block');
		await caretSettled(page, 1440, body);
		await page.keyboard.type('Z');
		await eventually(() => JSON.stringify(JSON.parse(site.read(SHARED_FILE)).block.body).includes('oZwn words'), 8000, `the shared file: ${site.read(SHARED_FILE)}`);
		assert.equal(site.read(PAGE_FILE), json(PAGE_DOC), 'the page that uses it is untouched');
		await page.close();
	});

	test('heading ids: numbered across the page (a shared entry included), kept through an edit and a teardown, never stored', async () => {
		const doc = { ...PAGE_DOC, blocks: [{ ...NOTE_BLOCK, body: [{ h2: 'Setup' }, { p: 'The top level body has words in it.' }] }, { shared: 'aside' }] };
		site.write(PAGE_FILE, json(doc));
		site.write(SHARED_FILE, json({ ...SHARED_DOC, block: { ...SHARED_DOC.block, body: [{ h2: 'Setup' }, { p: 'The shared body has its own words.' }] } }));
		const page = await open('/admin/pages/edges');
		const ids = (width = 1440) =>
			page.evaluate((width) => {
				const doc = document.querySelector<HTMLIFrameElement>(`#stage iframe[data-width="${width}"]`)!.contentDocument!;
				return [...doc.querySelectorAll('.note-body h2, .note-body h3')].map((h) => h.id);
			}, width);
		assert.deepEqual(await ids(), ['setup', 'setup-1'], 'the block\'s heading, then the shared entry\'s');
		await revealBody(page, TOP);
		const at = await charPoint(page, 'level body', 1, TOP);
		await page.mouse.move(at.x, at.y);
		await page.mouse.click(at.x, at.y);
		await eventually(async () => (await fieldState(page, 1440, TOP)).focused, 4000, 'typing in the body');
		await caretSettled(page, 1440, TOP);
		await page.keyboard.type('Z');
		await eventually(() => JSON.stringify(JSON.parse(site.read(PAGE_FILE)).blocks[0].body).includes('lZevel'), 8000, `the file: ${site.read(PAGE_FILE)}`);
		assert.deepEqual(JSON.parse(site.read(PAGE_FILE)).blocks[0].body, [{ h2: 'Setup' }, { p: 'The top lZevel body has words in it.' }], 'stored without an id');
		await page.keyboard.press('Escape');
		await page.mouse.move(5, 5);
		await page.keyboard.press('Escape');
		await eventually(async () => !(await fieldState(page, 1440, TOP)).mounted, 4000, 'torn down');
		await eventually(async () => JSON.stringify(await ids()) === JSON.stringify(['setup', 'setup-1']), 8000, 'the ids after the edit');
		assert.deepEqual(await ids(768), ['setup', 'setup-1'], 'the tablet\'s render, mirrored while typing, keeps them too');
		await page.close();
	});

	test('a field with no headings and no links gets a bar with neither the style menu nor Link; ⌘K opens nothing there', async () => {
		const page = await open('/admin/pages/edges');
		await revealBody(page, PLAIN);
		const at = await charPoint(page, 'plain field', 2, PLAIN);
		await page.mouse.move(at.x, at.y);
		await eventually(async () => (await fieldState(page, 1440, PLAIN)).mounted, 4000, 'the page editor on hover');
		await page.mouse.click(at.x, at.y);
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-rtbar').count(), 4000, 'the bar');
		const controls = await frameOn(page).locator('#cms-overlays .cms-rtbar [data-rtc]').evaluateAll((els) => els.map((e) => e.getAttribute('data-rtc')));
		assert.deepEqual(controls, ['bold', 'italic', 'ul', 'ol'], 'bold, italic and the two lists only');
		await caretSettled(page, 1440, PLAIN);
		await page.keyboard.press('ControlOrMeta+k');
		await new Promise((r) => setTimeout(r, 300)); // a negative wait
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-lpop').count(), 0, 'no link popover');
		assert.equal(await page.locator('.pop.switcher').count(), 0, 'and not the document switcher either');
		// The sibling field with both on has them all (the plain field's bar sits above it: leave that one first).
		await page.keyboard.press('Escape');
		await page.mouse.move(5, 5);
		await eventually(async () => (await frameOn(page).locator('#cms-overlays .cms-rtbar').count()) === 0, 4000, 'the bar gone');
		await revealBody(page, TOP);
		const top = await charPoint(page, 'body', 1, TOP);
		await page.mouse.move(top.x, top.y);
		await eventually(async () => (await fieldState(page, 1440, TOP)).mounted, 4000, 'the top-level body mounted');
		await page.mouse.click(top.x, top.y);
		await eventually(async () => (await fieldState(page, 1440, TOP)).focused, 4000, 'typing in the top-level body');
		await eventually(async () => (await frameOn(page).locator('#cms-overlays .cms-rtbar [data-rtc]').evaluateAll((els) => els.map((e) => e.getAttribute('data-rtc')))).includes('link'), 4000, 'the other field\'s bar');
		assert.deepEqual(await frameOn(page).locator('#cms-overlays .cms-rtbar [data-rtc]').evaluateAll((els) => els.map((e) => e.getAttribute('data-rtc'))), ['style', 'bold', 'italic', 'ul', 'ol', 'link']);
		await page.close();
	});
});
