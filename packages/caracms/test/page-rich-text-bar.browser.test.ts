// The formatting bar and the link popover of rich text typed on the page (on-page
// rich text, Phase 3; Decision 9): the bar's buttons and their active states, its
// placement (above the caret's block, unmoved while typing, moved on a block change,
// below with no room above), ⌘K on the page (the popover, never the switcher), Enter
// in the popover's search, the address rule's message, the Esc order (popover, then
// field, then level) and clicking into the sidebar's field. Home's Text body
// (headings and links on) on a throwaway copy of the demo under `astro dev`.
//
//   node --test --experimental-strip-types test/page-rich-text-bar.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { BODY, bodyInFile, caretSettled, charPoint, fieldState, revealBody } from './helpers/rich-on-page.ts';

let site: DevSite;
let browser: Browser;
let original = '';

const HOME = 'content/pages/index.json';
const block = '[data-pane-level="block"]';
const frameOn = (page: Page) => page.frameLocator('.frame.on iframe');
/** The menu or popover covers none of the caret's block (read after the rise-in animation). */
async function clearOfBlock(page: Page) {
	await new Promise((r) => setTimeout(r, 300));
	const s = (await barState(page))!;
	assert.ok(s.opened && s.target, 'open, with a block');
	assert.ok(s.opened!.bottom <= s.target!.top + 0.5 || s.opened!.top >= s.target!.bottom - 0.5, `clear of the block: ${JSON.stringify([s.opened, s.target])}`);
	assert.ok(s.opened!.bottom <= s.bar.top + 0.5 || s.opened!.top >= s.bar.bottom - 0.5, 'clear of the bar');
}

const barButton = (page: Page, label: string) => frameOn(page).locator(`#cms-overlays .cms-rtbar button[aria-label^="${label}"]`);

async function open(path = '/admin'): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
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
		await new Promise((r) => setTimeout(r, 80));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

interface Bar {
	/** Each button's aria-label → aria-pressed (or aria-expanded for the style menu). */
	buttons: Record<string, string | null>;
	place: string | undefined;
	block: string | undefined;
	/** The bar's box, and the caret's block's, in the iframe's viewport. */
	bar: { top: number; bottom: number; left: number };
	target: { top: number; bottom: number; left: number } | null;
	field: { left: number };
	k: number;
	menu: string[] | null;
	pop: boolean;
	/** The menu's or popover's box (whichever is open). */
	opened: { top: number; bottom: number; left: number } | null;
	holds: number;
	/** Where focus is in the iframe: the field, the layer (the popover's search), or a tag name. */
	focus: string;
}

/** The bar in the iframe on screen, or null. */
function barState(page: Page): Promise<Bar | null> {
	return page.evaluate((selector) => {
		const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
		const wrap = doc.querySelector<HTMLElement>('#cms-overlays .cms-rt .cms-rtw');
		if (!wrap) return null;
		const field = doc.querySelector<HTMLElement>(selector)!;
		const box = (el: Element) => {
			const r = el.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom, left: r.left };
		};
		const target = wrap.dataset.block !== undefined ? field.children[Number(wrap.dataset.block)] : null;
		const active = doc.activeElement;
		return {
			buttons: Object.fromEntries(
				[...wrap.querySelectorAll('.cms-rtbar button')].map((b) => [b.getAttribute('aria-label')!, b.getAttribute('aria-pressed') ?? b.getAttribute('aria-expanded')]),
			),
			place: wrap.dataset.place,
			block: wrap.dataset.block,
			// Where it was put (its box would include the rise-in animation's offset for a moment).
			bar: (() => {
				const win = doc.defaultView!;
				const top = parseFloat(wrap.style.top) - win.scrollY;
				return { top, bottom: top + wrap.querySelector<HTMLElement>('.cms-rtbar')!.offsetHeight, left: parseFloat(wrap.style.left) - win.scrollX };
			})(),
			target: target ? box(target) : null,
			field: box(field),
			k: parseFloat(doc.getElementById('cms-overlays')!.style.getPropertyValue('--k')) || 1,
			menu: wrap.querySelector('.cms-rtmenu') ? [...wrap.querySelectorAll('.cms-rtmenu button')].map((b) => b.textContent!) : null,
			pop: !!wrap.querySelector('.cms-lpop'),
			opened: (() => {
				const f = wrap.querySelector('.cms-lpop, .cms-rtmenu');
				return f ? box(f) : null;
			})(),
			holds: doc.querySelectorAll('#cms-overlays .cms-hold').length,
			focus: active === field ? 'field' : active?.closest('#cms-overlays') ? 'layer' : (active?.tagName ?? 'none'),
		};
	}, BODY);
}

/** Hover the body, click inside `word` (+extra characters): the page editor has focus, the bar shows. */
async function typeOnPage(page: Page, word = 'words', extra = 2) {
	await revealBody(page);
	const at = await charPoint(page, word, extra);
	await page.mouse.move(at.x, at.y);
	await eventually(async () => (await fieldState(page)).mounted, 4000, 'the page editor on hover');
	await page.mouse.click(at.x, at.y);
	await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="body"]`);
	await eventually(() => barState(page), 4000, 'the bar');
	return at;
}

/** Double-click a word on the page; wait for ProseMirror to read the selection. */
async function selectWord(page: Page, word: string) {
	const at = await charPoint(page, word, 1);
	await page.mouse.dblclick(at.x, at.y);
	await eventually(async () => {
		const s = (await fieldState(page)).selection;
		return s && s.head - s.anchor === word.length;
	}, 4000, `"${word}" selected`);
}

describe('the formatting bar on the page', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('page-rich-bar');
		browser = await chromium.launch();
		original = site.read(HOME);
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});
	beforeEach(() => site.write(HOME, original));

	test("the bar: the field's controls, active states following the selection, focus kept in the text; the ring without its chip", async () => {
		const page = await open();
		await typeOnPage(page);
		const bar = (await barState(page))!;
		assert.deepEqual(Object.keys(bar.buttons), ['Paragraph style: Paragraph', 'Bold', 'Italic', 'Bulleted list', 'Numbered list', 'Link'], 'headings and links on: every control');
		assert.ok(Object.entries(bar.buttons).every(([, on]) => on === 'false'), JSON.stringify(bar.buttons));
		assert.equal(bar.focus, 'field');
		// The typing ring stays; its on-page chip is dropped for rich text. The sidebar's chip stays.
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-type').count(), 4000, 'the typing ring');
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-type .cms-chip').count(), 0, 'no "Typing on the page" on the page');
		assert.equal(await page.locator(`${block} [data-ff="body"] .chip.typing`).count(), 1, 'the sidebar\'s "Typing on the page"');

		// A word selected; Bold, then Italic from the bar: both active, the selection kept, the file has it.
		await selectWord(page, 'words');
		const selected = (await fieldState(page)).selection;
		await barButton(page, 'Bold').click();
		await eventually(async () => (await barState(page))!.buttons.Bold === 'true', 3000, 'Bold active');
		await barButton(page, 'Italic').click();
		await eventually(async () => (await barState(page))!.buttons.Italic === 'true', 3000, 'Italic active');
		const after = (await barState(page))!;
		assert.equal(after.buttons.Bold, 'true');
		assert.equal(after.focus, 'field', "the bar's buttons don't take focus from the text");
		assert.deepEqual((await fieldState(page)).selection, selected, 'the selection stays');
		assert.match((await fieldState(page)).html, /<strong><em>words<\/em><\/strong>|<em><strong>words<\/strong><\/em>/);
		await eventually(() => /\*\*\*words\*\*\*/.test(JSON.stringify(bodyInFile(site.read(HOME)))), 8000, 'bold and italic in the file');

		// A caret in plain text: neither is active.
		const plain = await charPoint(page, 'everything', 3);
		await page.mouse.click(plain.x, plain.y);
		await eventually(async () => (await barState(page))!.buttons.Bold === 'false', 3000, 'Bold off in plain text');
		assert.equal((await barState(page))!.buttons.Italic, 'false');

		// Bulleted list: on (the list button active, the body a list), then off again.
		await barButton(page, 'Bulleted list').click();
		await eventually(async () => (await barState(page))!.buttons['Bulleted list'] === 'true', 3000, 'the list button active');
		assert.match((await fieldState(page)).html, /^<ul><li>/);
		assert.equal((await barState(page))!.buttons['Numbered list'], 'false');
		await eventually(() => JSON.stringify(bodyInFile(site.read(HOME))).startsWith('[{"ul":'), 8000, 'a list in the file');
		await barButton(page, 'Bulleted list').click();
		await eventually(async () => (await barState(page))!.buttons['Bulleted list'] === 'false', 3000, 'the list button off');
		assert.match((await fieldState(page)).html, /^<p>/);

		// The style menu: Paragraph, Heading 2, Heading 3 (the field allows both); Heading 2 makes the block one.
		await barButton(page, 'Paragraph style').click();
		await eventually(async () => (await barState(page))!.menu, 3000, 'the style menu');
		assert.deepEqual((await barState(page))!.menu, ['Paragraph', 'Heading 2', 'Heading 3']);
		assert.equal((await barState(page))!.buttons['Paragraph style: Paragraph'], 'true', 'the style button shows the menu open');
		assert.equal((await barState(page))!.focus, 'field');
		await frameOn(page).locator('#cms-overlays .cms-rtmenu button', { hasText: 'Heading 2' }).click();
		await eventually(async () => (await barState(page))!.buttons['Paragraph style: Heading 2'] !== undefined, 3000, 'the style is Heading 2');
		const styled = (await barState(page))!;
		assert.equal(styled.menu, null, 'the menu closes');
		assert.equal(styled.focus, 'field');
		assert.match((await fieldState(page)).html, /^<h2>/);
		await eventually(() => JSON.stringify(bodyInFile(site.read(HOME))).startsWith('[{"h2":'), 8000, 'a heading in the file');
		await page.close();
	});

	test('placement: above the caret\'s block, 12px clear and lined up with the field; unmoved while typing; moved on a block change; below with no room above', async () => {
		const page = await open();
		await typeOnPage(page, 'everything', 3);
		const first = (await barState(page))!;
		assert.equal(first.place, 'above');
		assert.equal(first.block, '0');
		const clear = first.target!.top - first.bar.bottom;
		assert.ok(Math.abs(clear - 12 * first.k) < 1.5, `12px clear on screen (${clear} in the frame, k ${first.k})`);
		assert.ok(Math.abs(first.bar.left - first.field.left) < 1, 'lined up with the field\'s left edge');

		// Typing in the block (and a line break in it) doesn't move it.
		await page.keyboard.type('and more words to wrap the line ');
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.type('a second line');
		await new Promise((r) => setTimeout(r, 300));
		const typed = (await barState(page))!;
		assert.equal(typed.bar.top, first.bar.top, 'unmoved while typing in the block');

		// Enter: the caret's in a new block, and the bar moves to it.
		await page.keyboard.press('Enter');
		await page.keyboard.type('A new paragraph');
		await eventually(async () => (await barState(page))!.block === '1', 3000, 'the bar on the new block');
		const moved = (await barState(page))!;
		assert.ok(moved.bar.top > first.bar.top, `moved down (${first.bar.top} → ${moved.bar.top})`);
		assert.ok(Math.abs(moved.target!.top - moved.bar.bottom - 12 * moved.k) < 1.5, 'above the new block, 12px clear');

		// Leave the field; scroll so the first block is at the frame's top; click back in: below the block.
		await page.keyboard.press('Escape');
		await eventually(async () => !(await barState(page)), 3000, 'the bar goes with focus');
		await page.evaluate((selector) => {
			const f = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!;
			const el = f.contentDocument!.querySelector(selector)!;
			f.contentWindow!.scrollBy(0, el.getBoundingClientRect().top - 4);
		}, BODY);
		const top = await charPoint(page, 'start', 2);
		await page.mouse.move(top.x, top.y);
		await page.mouse.click(top.x, top.y);
		await eventually(async () => (await barState(page))?.block === '0', 4000, 'the bar on the first block');
		const below = (await barState(page))!;
		assert.equal(below.place, 'below', 'no room above: below the block');
		assert.ok(Math.abs(below.bar.top - below.target!.bottom - 12 * below.k) < 1.5, `below the block, 12px clear (${below.bar.top - below.target!.bottom})`);
		await page.close();
	});

	test('⌘K on the page opens the link popover (not the switcher); the words keep a wash; Enter picks the highlighted document; a bad address shows the rule and is kept', async () => {
		const page = await open();
		await typeOnPage(page);
		await selectWord(page, 'words');
		await page.keyboard.press('ControlOrMeta+k');
		await eventually(async () => (await barState(page))?.pop, 3000, 'the popover on the page');
		assert.equal(await page.isVisible('.pop.switcher'), false, '⌘K on the page is the link, not the switcher');
		const open1 = (await barState(page))!;
		assert.equal(open1.focus, 'layer', "focus is in the popover's search");
		assert.ok(open1.holds > 0, 'the words being linked keep a wash');
		assert.equal(open1.buttons.Link, 'true');
		await clearOfBlock(page);
		// Still one typing session: the editor mounted, the sidebar's chip, the ring.
		assert.equal((await fieldState(page)).mounted, true);
		assert.equal(await page.locator(`${block} [data-ff="body"] .chip.typing`).count(), 1);
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-type').count(), 1);

		await page.keyboard.type('Work');
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-lpop .drow.is-active[data-href="/work"]').count(), 3000, 'Work highlighted');
		await page.keyboard.press('Enter');
		await eventually(async () => !(await barState(page))!.pop, 3000, 'the popover closes');
		assert.equal((await barState(page))!.focus, 'field', 'back in the text');
		assert.match((await fieldState(page)).html, /<a href="\/work"[^>]*>words<\/a>/);
		await eventually(() => JSON.stringify(bodyInFile(site.read(HOME))).includes('[words](/work)'), 8000, 'the link in the file');

		// With the caret (nothing selected), an address that fails the rule: its message; kept as typed if used.
		const caret = await charPoint(page, 'everything', 0);
		await page.mouse.click(caret.x, caret.y);
		// ProseMirror reads a native caret move on selectionchange, a task later (Watch-outs).
		await caretSettled(page);
		await page.keyboard.press('ControlOrMeta+k');
		await eventually(async () => (await barState(page))?.pop, 3000, 'the popover again');
		await page.keyboard.type('wrok.html');
		const msg = frameOn(page).locator('#cms-overlays .cms-lpop .cms-msg');
		await eventually(() => msg.count(), 3000, "the link rule's message").catch(async (e) => {
			throw new Error(`${e.message}: ${JSON.stringify(await barState(page))} ${await frameOn(page).locator('#cms-overlays .cms-lpop').innerHTML().catch(() => 'no pop')} ${JSON.stringify(await fieldState(page))}`);
		});
		assert.match((await msg.textContent()) ?? '', /\S/);
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-lpop input').getAttribute('aria-invalid'), 'true');
		await page.keyboard.press('Enter');
		await eventually(() => JSON.stringify(bodyInFile(site.read(HOME))).includes('[wrok.html](wrok.html)'), 8000, 'the address kept, as the link and its text');
		await page.close();
	});

	test('Esc: the style menu, then the popover close first, back to the text with its selection; then the field; then the level', async () => {
		const page = await open();
		await typeOnPage(page);
		await barButton(page, 'Paragraph style').click();
		await eventually(async () => (await barState(page))?.menu, 3000, 'the style menu');
		await clearOfBlock(page);
		await page.keyboard.press('Escape');
		await eventually(async () => (await barState(page))?.menu === null, 3000, 'the menu closes');
		assert.equal((await barState(page))!.focus, 'field', 'the text keeps focus');

		await selectWord(page, 'type');
		const selection = (await fieldState(page)).selection;
		await barButton(page, 'Link').click();
		await eventually(async () => (await barState(page))?.focus === 'layer', 3000, "the popover's search");
		await page.keyboard.press('Escape');
		await eventually(async () => (await barState(page))?.pop === false, 3000, 'the popover closes');
		assert.equal((await barState(page))!.focus, 'field', 'back in the text');
		assert.deepEqual((await fieldState(page)).selection, selection, 'with its selection');
		assert.equal(await page.locator(block).count(), 1);

		await page.keyboard.press('Escape');
		await eventually(async () => !(await barState(page)), 3000, 'the field left: no bar').catch(async (e) => {
			throw new Error(`${e.message}: ${JSON.stringify(await barState(page))} ${JSON.stringify(await fieldState(page))}`);
		});
		assert.equal((await fieldState(page)).focused, false);
		assert.equal(await page.locator(block).count(), 1, 'the level is still open');

		await page.keyboard.press('Escape');
		await eventually(async () => (await page.locator(block).count()) === 0, 3000, 'up a level');
		await page.close();
	});

	test("clicking into the sidebar's field ends typing on the page", async () => {
		const page = await open();
		await typeOnPage(page);
		assert.equal(await page.locator(`${block} [data-ff="body"] .chip.typing`).count(), 1);
		await page.locator(`${block} [data-ff="body"] .ProseMirror`).click();
		await eventually(async () => !(await barState(page)), 3000, 'the bar goes');
		await eventually(async () => (await page.locator(`${block} [data-ff="body"] .chip.typing`).count()) === 0, 3000, 'the sidebar\'s chip goes');
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-type').count(), 0, 'no typing ring');
		await eventually(async () => !(await fieldState(page)).mounted, 3000, 'the page editor goes');
		await page.close();
	});
});
