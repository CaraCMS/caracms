// Editing a block in a real browser (Phase 3 → Verify 1–4): the lockup field and its
// warning, phone lines in the file, the caret through a slow render, the overlays,
// click to edit and skipped blocks. On a throwaway copy of the demo under `astro dev`
// (helpers/dev-site.ts); headless Chromium from Playwright's cache, skipped without it.
//
//   node --test --experimental-strip-types test/page-edit.browser.test.ts
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, footerInBody, startDevSite, starter, type DevSite } from './helpers/dev-site.ts';
import { bodyInFile, caretSettled, charPoint, fieldState, revealBody, until } from './helpers/rich-on-page.ts';

let site: DevSite;
let browser: Browser;

const HOME = 'content/pages/index.json';
const MOUSETRAP = ['Building a better mousetrap', 'For You'];

async function open(path: string): Promise<Page> {
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
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

const frameOn = (page: Page) => page.frameLocator('.frame.on iframe');
const block = '[data-pane-level="block"]';
const lockupLines = (page: Page, set: 'main' | 'phone') => page.$$eval(`${block} [data-ff="heading"] .lk-rows input[data-set="${set}"]`, (els) => els.map((e) => (e as HTMLInputElement).value));

/** The hero heading's lines as each iframe renders them, per set. */
const renderedLines = (page: Page, set: 'main' | 'phone') =>
	page.evaluate(
		(set) =>
			[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) =>
				[...f.contentDocument!.querySelectorAll(`[data-cms-block="0"] [data-cms-lines="${set}"] .cms-lockup-line`)].map((l) => l.textContent),
			),
		set,
	);

/** Which hero line set each iframe shows (the other is display: none). */
const shownSets = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => {
			const win = f.contentWindow!;
			return [...f.contentDocument!.querySelectorAll<HTMLElement>('[data-cms-block="0"] [data-cms-lines]')]
				.filter((s) => win.getComputedStyle(s).display !== 'none')
				.map((s) => s.dataset.cmsLines)
				.join(',');
		}),
	);

const heroHeading = (text: string) => (JSON.parse(text) as { blocks: { heading: unknown }[] }).blocks[0]!.heading;

describe('editing a block in the browser', { skip: browserSkip }, () => {
	before(async () => {
		// Home's blocks as these tests know them, the shared footer last (helpers/dev-site.ts → footerInBody: not the footer slot).
		site = await startDevSite('page-edit', { edit: footerInBody });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('Verify 1: typing in a lockup updates all three iframes without a blank frame; the warning comes and goes', async () => {
		const page = await open('/admin');
		// Click to edit: the hero's heading on the page opens the hero and picks its field.
		await frameOn(page).locator('[data-cms-block="0"] [data-cms-kind="lockup"]').click();
		await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="heading"]`);
		assert.match((await page.textContent(`${block} [data-ff="heading"] .field-head`)) ?? '', /Picked from the page/);
		assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).dataset.set), 'main', 'the lockup\'s sidebar field has focus');
		assert.deepEqual(await lockupLines(page, 'main'), MOUSETRAP);
		// "Building a better mousetrap" is too long at 375 (Phase 1's numbers).
		await page.waitForSelector(`${block} [data-warning="too-long"]`);
		assert.match((await page.textContent(`${block} [data-warning="too-long"]`)) ?? '', /Too long for mobile: shorten a line or split it/);
		assert.equal(await page.locator('button[role="radio"][data-width="phone"] .wdot').count(), 1, 'the Phone toggle\'s dot');
		// The picked, warned heading: on Phone only the amber "Too long for mobile" tag, no
		// field tag under it (the mockup's #phone-main); on Desktop the blue "Heading" tag.
		const tags = (width: number) =>
			page.evaluate((width) => {
				const doc = document.querySelector<HTMLIFrameElement>(`iframe[data-width="${width}"]`)!.contentDocument!;
				const els = [...doc.querySelectorAll<HTMLElement>('#cms-overlays [data-block="0"][data-field="heading"] .cms-chip')];
				const boxes = els.map((e) => e.getBoundingClientRect());
				const overlap = boxes.some((a, i) => boxes.some((b, j) => j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
				return { texts: els.map((e) => e.textContent).sort(), overlap };
			}, width);
		await eventually(async () => (await tags(375)).texts.join('|') === 'Too long for mobile', 4000, 'only the amber tag on Phone');
		assert.equal((await tags(375)).overlap, false, 'no two overlay tags overlap on Phone');
		assert.deepEqual(await tags(1440), { texts: ['Heading'], overlap: false });

		// Watch every iframe on every animation frame: none may ever be blank.
		await page.evaluate(() => {
			const w = window as any;
			w.__blank = 0;
			w.__watch = true;
			const tick = () => {
				for (const f of document.querySelectorAll<HTMLIFrameElement>('#stage iframe')) if (!f.contentDocument?.body?.innerText.trim()) w.__blank++;
				if (w.__watch) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});

		// Split the first line after "Building a": Enter.
		const first = page.locator(`${block} [data-ff="heading"] input[data-line="0"]`);
		await first.focus();
		await first.evaluate((el: HTMLInputElement) => el.setSelectionRange(10, 10));
		await page.keyboard.press('Enter');
		assert.deepEqual(await lockupLines(page, 'main'), ['Building a', 'better mousetrap', 'For You']);
		assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).dataset.line), '1', 'the caret is on the new line');
		await eventually(async () => (await renderedLines(page, 'main')).every((l) => l.join('|') === 'Building a|better mousetrap|For You'), 6000, 'all three iframes');
		await page.waitForSelector(`${block} [data-warning="fits"]`);
		assert.equal(await page.locator(`${block} [data-warning="too-long"]`).count(), 0);
		await eventually(async () => (await page.locator('button[role="radio"][data-width="phone"] .wdot').count()) === 0, 4000, 'the dot to go');

		// Type a character: still every iframe.
		const caretTo = (at: number | 'end') =>
			page.evaluate((at) => {
				const el = document.activeElement as HTMLInputElement;
				const n = at === 'end' ? el.value.length : at;
				el.setSelectionRange(n, n);
			}, at);
		await caretTo('end');
		await page.keyboard.type('s');
		await eventually(async () => (await renderedLines(page, 'main')).every((l) => l[1] === 'better mousetraps'), 6000, 'the typed letter').catch(async (e) => {
			console.log('DEBUG', await lockupLines(page, 'main'), JSON.stringify(await renderedLines(page, 'main')), await page.evaluate(() => (document.activeElement as HTMLElement).outerHTML));
			throw e;
		});
		await page.keyboard.press('Backspace');

		// Join it back: ⌫ at the start of line 2. The warning comes back.
		await caretTo(0);
		await page.keyboard.press('Backspace');
		assert.deepEqual(await lockupLines(page, 'main'), MOUSETRAP);
		await page.waitForSelector(`${block} [data-warning="too-long"]`);
		await eventually(async () => (await renderedLines(page, 'main')).every((l) => l.join('|') === MOUSETRAP.join('|')), 6000, 'joined in all three');

		const blank = await page.evaluate(() => {
			(window as any).__watch = false;
			return (window as any).__blank;
		});
		assert.equal(blank, 0, 'no animation frame had a blank iframe');
		await eventually(() => JSON.stringify(heroHeading(site.read(HOME))) === JSON.stringify(MOUSETRAP), 6000, 'the file back as it was');
		await page.close();
	});

	test('Verify 2: phone lines given on Phone are in the file as the object form; Desktop says so; removing them writes the plain list', async () => {
		const page = await open('/admin');
		await frameOn(page).locator('[data-cms-block="0"] [data-cms-kind="lockup"]').click();
		await page.waitForSelector(`${block} [data-ff="heading"]`);
		await page.click('button[role="radio"][data-width="phone"]');
		// The warning offers the fix on Phone.
		await page.waitForSelector(`${block} [data-warning="too-long"]`);
		await page.click(`${block} [data-warning="too-long"] button:has-text("Give Phone its own lines")`);
		assert.deepEqual(await lockupLines(page, 'phone'), ['Building a', 'better mousetrap', 'For You']);
		assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).dataset.set), 'phone');
		await eventually(
			() => JSON.stringify(heroHeading(site.read(HOME))) === JSON.stringify({ lines: MOUSETRAP, phone: ['Building a', 'better mousetrap', 'For You'] }),
			6000,
			'the object form on disk',
		);
		assert.match(site.read(HOME), /"phone": \["Building a", "better mousetrap", "For You"\]/, 'string arrays on one line (Decision 7)');
		await page.waitForSelector(`${block} [data-warning="fits"]`);
		// Phone lines keep their words: typing in them is refused.
		await page.keyboard.type('x');
		assert.deepEqual(await lockupLines(page, 'phone'), ['Building a', 'better mousetrap', 'For You']);
		// The phone iframe shows the phone lines; desktop and tablet the main ones (Decision 11).
		await eventually(async () => (await shownSets(page)).join(' ') === 'main main phone', 6000, 'the sets per width');

		// Back on Desktop: the main lines, and the field says Phone has its own.
		await page.click('button[role="radio"][data-width="desktop"]');
		await page.waitForSelector(`${block} [data-ff="heading"] .lk-phone-sum`);
		assert.match((await page.textContent(`${block} [data-ff="heading"] .field-head`)) ?? '', /Phone lines/);
		assert.deepEqual(await lockupLines(page, 'main'), MOUSETRAP);
		assert.deepEqual((await renderedLines(page, 'phone'))[0], ['Building a', 'better mousetrap', 'For You']);

		// Words change in the main lines: one more word drops the phone lines, with a notice.
		const second = page.locator(`${block} [data-ff="heading"] input[data-line="1"]`);
		await second.fill('For You Now');
		await page.waitForSelector(`${block} .lk-dropped`);
		await eventually(() => JSON.stringify(heroHeading(site.read(HOME))) === JSON.stringify(['Building a better mousetrap', 'For You Now']), 6000, 'dropped: the plain list');
		await second.fill('For You');
		await eventually(() => JSON.stringify(heroHeading(site.read(HOME))) === JSON.stringify(MOUSETRAP), 6000, 'the words back');

		// Give them again, then "Use main lines": the plain list, with Undo.
		await page.click('button[role="radio"][data-width="phone"]');
		await page.click(`${block} button:has-text("Give Phone its own lines")`);
		await eventually(() => typeof heroHeading(site.read(HOME)) === 'object' && !Array.isArray(heroHeading(site.read(HOME))), 6000, 'the object form again');
		await page.click(`${block} button:has-text("Use main lines")`);
		await page.waitForSelector('.toast:has-text("Phone uses the main lines again")');
		await eventually(() => JSON.stringify(heroHeading(site.read(HOME))) === JSON.stringify(MOUSETRAP), 6000, 'the plain list after Use main lines');
		await page.close();
	});

	test('Verify 3: the caret on the page survives a slow render that lands after focus moved to the sidebar', async () => {
		const page = await open('/admin');
		const intro = frameOn(page).locator('[data-cms-block="0"] [data-cms-field="intro"]');
		await intro.click();
		await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="intro"]`);
		await page.waitForSelector(`${block} [data-ff="intro"] .chip.typing`);

		// Every render now takes 1.5 seconds.
		let landed = 0;
		await page.route(`${site.origin}/_caracms/preview`, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			await new Promise((r) => setTimeout(r, 1500));
			const response = await route.fetch();
			await route.fulfill({ response });
			landed++;
		});
		// A sidebar change sends a render (in flight for 1.5 s)…
		await page.selectOption(`${block} [data-ff="layout"] select`, 'centre');
		// …then text is typed on the page, at the end of the intro…
		await intro.evaluate((el) => {
			el.focus();
			const sel = el.ownerDocument.getSelection()!;
			sel.selectAllChildren(el);
			sel.collapseToEnd();
		});
		await page.keyboard.type(' Kettle on.');
		const typed = await intro.evaluate((el) => (el as HTMLElement).innerText);
		assert.match(typed, /Kettle on\.$/);
		// …then focus moves to a sidebar field while the render is still in flight.
		assert.equal(landed, 0, 'the render is still in flight');
		await page.focus(`${block} [data-ff="layout"] select`);

		await eventually(() => landed >= 1, 6000, 'the slow render');
		await eventually(() => frameOn(page).locator('[data-cms-block="0"].hero--centre').count(), 6000, 'the render morphed in');
		await page.waitForTimeout(150);
		const after = await page.evaluate(() => {
			const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
			const field = doc.querySelector<HTMLElement>('[data-cms-block="0"] [data-cms-field="intro"]')!;
			const s = doc.getSelection()!;
			return {
				text: field.innerText,
				inField: field.contains(s.anchorNode),
				collapsed: s.isCollapsed,
				atEnd: s.anchorNode?.nodeType === 3 && s.anchorOffset === (s.anchorNode as Text).data.length && (s.anchorNode as Text).data.endsWith('Kettle on.'),
				others: [...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => f.contentDocument!.querySelector<HTMLElement>('[data-cms-block="0"] [data-cms-field="intro"]')!.innerText),
				sidebar: (document.querySelector(`[data-pane-level="block"] [data-ff="intro"] textarea`) as HTMLTextAreaElement).value,
			};
		});
		assert.equal(after.text, typed, 'the typed text is still there after the render landed');
		assert.deepEqual({ inField: after.inField, collapsed: after.collapsed, atEnd: after.atEnd }, { inField: true, collapsed: true, atEnd: true }, 'the caret is where it was');
		assert.ok(after.others.every((t) => t.endsWith('Kettle on.')), 'mirrored into all three iframes');
		assert.ok(after.sidebar.endsWith('Kettle on.'), 'the sidebar field follows');
		await page.unroute(`${site.origin}/_caracms/preview`);
		await eventually(() => site.read(HOME).includes('Kettle on.'), 6000, 'typed on the page, kept on disk');
		await page.close();
	});

	test('Verify 4: overlays are drawn inside each iframe, outside the page, at a constant size on light, dark and photo blocks', async () => {
		const page = await open('/admin');
		const report = (index: number) =>
			page.evaluate((index) => {
				const iframe = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!;
				const doc = iframe.contentDocument!;
				const layer = doc.getElementById('cms-overlays')!;
				const sel = layer.querySelector<HTMLElement>(`.cms-sel[data-block="${index}"]`);
				const target = doc.querySelector<HTMLElement>(`[data-cms-block="${index}"]`)!;
				const scale = iframe.getBoundingClientRect().width / iframe.offsetWidth;
				const tag = sel?.querySelector<HTMLElement>('.cms-tag');
				return {
					outsideBody: layer.parentElement === doc.documentElement,
					inBody: !!doc.body.querySelector('#cms-overlays, .cms-box'),
					background: target.className.match(/bg-(\w+)/)?.[1],
					tag: tag?.textContent,
					// The box sits on the block, in document coordinates.
					fits: !!sel && Math.abs(sel.getBoundingClientRect().top - target.getBoundingClientRect().top) < 1 && Math.abs(sel.getBoundingClientRect().height - target.getBoundingClientRect().height) < 1,
					// 22px on screen whatever the scale.
					tagOnScreen: tag ? Math.round(tag.getBoundingClientRect().height * scale) : null,
				};
			}, index);
		const backgrounds: string[] = [];
		for (const [index, field] of [
			[0, 'intro'],
			[1, 'body'],
			[2, 'text'],
		] as const) {
			await frameOn(page).locator(`[data-cms-block="${index}"] [data-cms-field="${field}"]`).click();
			await page.keyboard.press('Escape'); // leave the text (typing on the page), keep the block
			await eventually(async () => (await report(index)).fits, 4000, `block ${index}'s outline`);
			const r = await report(index);
			assert.equal(r.outsideBody, true);
			assert.equal(r.inBody, false, 'nothing of the layer is in the page\'s body (the morph never sees it)');
			assert.ok(r.tag, 'a filled tag with the block type');
			assert.equal(r.tagOnScreen, 22);
			backgrounds.push(r.background!);
		}
		assert.deepEqual(backgrounds.sort(), ['dark', 'light', 'photo']);

		// Hover: the block under the pointer gets a thin outline with a light tag.
		await frameOn(page).locator('[data-cms-block="0"]').hover({ position: { x: 20, y: 20 } });
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-hov[data-block="0"] .cms-tag').count(), 4000, 'the hover outline');
		// The phone frame marks the too-long lockup with amber dashes.
		const warn = await page.evaluate(
			() => document.querySelector<HTMLIFrameElement>('iframe[data-width="375"]')!.contentDocument!.querySelectorAll('#cms-overlays .cms-warn[data-field="heading"]').length,
		);
		assert.equal(warn, 1);
		// Same at Tablet scale: constant size on screen.
		await page.click('button[role="radio"][data-width="tablet"]');
		await frameOn(page).locator('[data-cms-block="1"] [data-cms-field="heading"]').click();
		await page.keyboard.press('Escape');
		await eventually(async () => (await report(1)).tagOnScreen === 22, 4000, 'the tag at 22px on screen at tablet scale');
		await page.close();

		// The public page (the same components, not a preview render) has none of it.
		const html = await (await fetch(`${site.origin}/`)).text();
		assert.doesNotMatch(html, /data-cms-|contenteditable|cms-overlays|cms-box|data-cms-skipped/);
	});

	test('click to edit opens the block and field; a lockup opens its sidebar field; a plain text field is typed on the page', async () => {
		const page = await open('/admin');
		await frameOn(page).locator('[data-cms-block="2"] [data-cms-kind="lockup"]').click();
		await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="heading"]`);
		assert.match((await page.textContent(`${block} .cur-title`)) ?? '', /Call to action/);
		// Home: hero, text, CTA, then (M5a's demo) the case-study list and the shared footer.
		assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).value), 'Worried?');
		// The picked overlay rings the heading with its name.
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-pick[data-block="2"][data-field="heading"] .cms-chip:has-text("Heading")').count(), 4000, 'the picked ring');

		// The button label, typed on the page: the sidebar and the file follow.
		const label = frameOn(page).locator('[data-cms-block="2"] [data-cms-field="button"]');
		await label.click();
		await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="button"]`);
		await label.evaluate((el) => {
			const sel = el.ownerDocument.getSelection()!;
			sel.selectAllChildren(el);
			sel.collapseToEnd();
		});
		await page.keyboard.type(' today');
		// One line: Enter leaves the field instead of breaking it.
		await page.keyboard.press('Enter');
		assert.equal(await label.evaluate((el) => (el as HTMLElement).innerText), 'Start a project today');
		assert.equal(await page.inputValue(`${block} [data-ff="button"] input`), 'Start a project today');
		await eventually(() => site.read(HOME).includes('"button": "Start a project today"'), 6000, 'the file');
		await page.close();
	});

	test('on-page rich text: hover mounts the page editor; a click mid-word then typing reaches the store, the file, the phone iframe and the sidebar; leaving leaves the render', async () => {
		const page = await open('/admin');
		await revealBody(page);
		const rendered = await fieldState(page);
		assert.equal(rendered.mounted, false, 'nothing mounted before the pointer comes');
		assert.match(rendered.outer, /tabindex="0"/, 'the preview render makes the body focusable');
		assert.doesNotMatch(rendered.outer, /contenteditable/);

		// The pointer enters the field: the page editor is mounted on the element itself.
		const at = await charPoint(page, 'words', 2);
		await page.mouse.move(at.x, at.y);
		await eventually(async () => (await fieldState(page)).mounted, 4000, 'the page editor on hover');
		const hovered = await fieldState(page);
		assert.equal(hovered.wrapper, false, 'no .ProseMirror inside the field');
		assert.match(hovered.html, /^<p>We start with the words/, 'the field\'s first child is the value\'s first block');

		// A click mid-word: the caret is there, the block opens with the body picked, and typing goes in.
		await page.mouse.click(at.x, at.y);
		await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="body"]`);
		assert.equal((await fieldState(page)).focused, true, 'focus stays on the page');
		await page.keyboard.type('studio ');
		assert.match((await fieldState(page)).html, /the wostudio rds,/, 'typed where the click landed');
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-type').count(), 4000, 'the typing ring');
		assert.equal(await page.locator(`${block} [data-ff="body"] .chip.typing`).count(), 1, 'the sidebar\'s "Typing on the page"');

		// The store (the file, Decision 3's format), the phone iframe, and the sidebar's field follow.
		const want = [{ p: 'We start with the wostudio rds, then the type, then everything else.\nMost of our clients stay for years, and so does the work.' }];
		await eventually(() => JSON.stringify(bodyInFile(site.read(HOME))) === JSON.stringify(want), 8000, 'the body in the file');
		const phone = await fieldState(page, 375);
		assert.equal(phone.mounted, false, 'never mounted in a hidden width');
		assert.equal(phone.html, '<p>We start with the wostudio rds, then the type, then everything else.<br>Most of our clients stay for years, and so does the work.</p>');
		await eventually(async () => /wostudio rds/.test((await page.textContent(`${block} [data-ff="body"] .ProseMirror`)) ?? ''), 4000, 'the sidebar\'s field');

		// Esc leaves the field (not the level); with the pointer away, the editor goes and the element is a render again.
		await page.keyboard.press('Escape');
		assert.equal(await page.locator(`${block} [data-ff="body"]`).count(), 1, 'the block\'s level is still open');
		await page.mouse.move(5, 5);
		await eventually(async () => !(await fieldState(page)).mounted, 4000, 'torn down');
		const left = await fieldState(page);
		assert.doesNotMatch(left.outer, /ProseMirror|tiptap|contenteditable|translate|role=/, left.outer);
		// A fresh render (the heading typed in the sidebar) leaves it as it is, and the tablet's copy, just rendered, is the same.
		const heading = page.locator(`${block} [data-ff="heading"] input`);
		await heading.focus();
		await page.keyboard.press('End');
		await page.keyboard.type('!');
		await eventually(async () => /Work that lasts!/.test((await frameOn(page).locator('[data-cms-block="1"] [data-cms-field="heading"]').textContent()) ?? ''), 6000, 'the render');
		assert.equal((await fieldState(page)).outer, left.outer, 'the render found nothing to change');
		assert.equal((await fieldState(page, 768)).outer, left.outer, 'the same as a fresh render of the value');
		await page.close();
	});

	test('on-page rich text: a change from elsewhere reaches the mounted, unfocused page editor without losing its selection; an empty paragraph from Enter survives its echo', async () => {
		const page = await open('/admin');
		await revealBody(page);
		const at = await charPoint(page, 'clients');
		await page.mouse.move(at.x, at.y);
		await page.mouse.click(at.x, at.y);
		await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="body"]`);
		const caret = (await fieldState(page)).selection!;
		// Focus goes to the sidebar's body field; the pointer still rests on the page's body (mounted, not focused).
		// (Focused from script: a click there would take the pointer off the page.)
		await page.evaluate((sel) => (document.querySelector(sel) as unknown as { editor: { commands: { focus(at: string): void } } }).editor.commands.focus('end'), `${block} [data-ff="body"] .ProseMirror`);
		await eventually(() => page.evaluate(() => !!document.activeElement?.closest('[data-ff="body"]')), 4000, 'focus in the sidebar\'s body');
		await page.keyboard.type(' Zed');
		await eventually(async () => /so does the work\. Zed<\/p>$/.test((await fieldState(page)).html), 4000, 'the page editor shows the sidebar\'s change').catch(async (error) => {
			throw new Error(`${error.message}: ${JSON.stringify(await fieldState(page))}, sidebar ${await page.innerHTML(`${block} [data-ff="body"] .ProseMirror`)}`);
		});
		const after = await fieldState(page);
		assert.equal(after.mounted, true, 'still mounted (not torn down and remounted)');
		assert.deepEqual(after.selection, caret, 'the page\'s selection is unchanged');

		// Enter at the end on the page: an empty paragraph, which the stored value drops, stays on the page.
		const end = await charPoint(page, 'Zed', 2);
		await page.mouse.click(end.x, end.y);
		await eventually(async () => (await fieldState(page)).focused, 4000, 'focus back on the page');
		// ProseMirror reads a native caret move (the click, then the arrow key) on selectionchange, a task later
		// (the sidebar's editor too): wait for it to have read each, never a fixed pause.
		await caretSettled(page);
		const before = (await fieldState(page)).selection!;
		await page.keyboard.press('ArrowRight');
		await until(async () => (await fieldState(page)).selection?.anchor === before.anchor + 1, 'ProseMirror to read the arrow key');
		await page.keyboard.press('Enter');
		// A negative wait: the stored value drops the empty paragraph, so no change comes back; give an echo time to (wrongly) replace it.
		await new Promise((r) => setTimeout(r, 400));
		assert.match((await fieldState(page)).html, /Zed<\/p><p><br class="ProseMirror-trailingBreak"><\/p>$/, 'the empty paragraph survives its own echo');
		await page.keyboard.type('New one');
		await eventually(() => JSON.stringify(bodyInFile(site.read(HOME))).includes('{"p":"New one"}'), 8000, 'the new paragraph in the file');
		await page.close();
	});

	test('on-page rich text: a case study\'s story (a fields document) is typed on the page the same way', async () => {
		const page = await open('/admin/case-studies/high-street-coffee');
		const story = '[data-cms-document] [data-cms-field="body"]';
		await revealBody(page, story);
		const at = await charPoint(page, 'morning ferry', 0, story);
		await page.mouse.move(at.x, at.y);
		await eventually(async () => (await fieldState(page, 1440, story)).mounted, 4000, 'the page editor on hover');
		assert.match((await fieldState(page, 1440, story)).html, /^<p>The roaster started/, 'its first block first, no wrapper');
		await page.mouse.click(at.x, at.y);
		await eventually(async () => (await fieldState(page, 1440, story)).focused, 4000, 'typing in the story');
		await page.keyboard.type('early ');
		const file = 'content/case-studies/high-street-coffee.json';
		await eventually(() => (JSON.parse(site.read(file)) as { body: { p?: string }[] }).body[0]?.p === 'The roaster started as a cart on the quay, selling coffee to the people waiting for the early morning ferry.', 8000, 'the story in the file');
		assert.equal((await fieldState(page, 1440, story)).wrapper, false);
		await page.close();
	});

	test('on-page rich text: the pointer passing over a second rich-text field mid-session leaves the first typing; clicking into the second moves the session there', async () => {
		const page = await open('/admin/pages/work');
		const one = '[data-cms-block="1"] [data-cms-field="body"]';
		const two = '[data-cms-block="2"] [data-cms-field="body"]';
		await revealBody(page, one);
		const first = await charPoint(page, 'identity', 2, one);
		await page.mouse.move(first.x, first.y);
		await eventually(async () => (await fieldState(page, 1440, one)).mounted, 4000, 'the first body mounted on hover');
		await page.mouse.click(first.x, first.y);
		await eventually(async () => (await fieldState(page, 1440, one)).focused, 4000, 'typing in the first body');
		await page.keyboard.type('X');
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-type').count(), 4000, 'the typing ring');
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-rtbar').count(), 4000, 'the bar');

		// The pointer crosses the second body (no click, no button): the first session is untouched.
		await revealBody(page, two);
		const there = await charPoint(page, 'festival', 3, two);
		await page.mouse.move(there.x - 40, there.y, { steps: 4 });
		await page.mouse.move(there.x, there.y, { steps: 4 });
		await page.mouse.move(there.x + 6, there.y, { steps: 4 });
		await new Promise((r) => setTimeout(r, 400));
		const a = await fieldState(page, 1440, one);
		assert.equal(a.mounted, true, 'the first body is still mounted');
		assert.equal(a.focused, true, 'and focused');
		assert.equal((await fieldState(page, 1440, two)).mounted, false, 'the second is not mounted under the pointer');
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-type').count(), 1, 'the ring is still drawn');
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-rtbar').count(), 1, 'the bar is still shown');
		assert.equal(await page.locator(`${block} [data-ff="body"] .chip.typing`).count(), 1, 'typing is still set');
		await page.keyboard.type('Y');
		await eventually(async () => /idXYentity/.test((await fieldState(page, 1440, one)).html), 4000, 'typing continues into the first body');

		// A click into the second (typing scrolled the first back into view: the point is read again): the
		// session moves there, the caret where it landed, the first is a render again.
		const click = await charPoint(page, 'festival', 3, two);
		await page.mouse.click(click.x, click.y);
		await eventually(async () => (await fieldState(page, 1440, two)).focused, 4000, 'focus in the second body');
		assert.equal((await fieldState(page, 1440, two)).mounted, true);
		await page.keyboard.type('Z');
		await eventually(async () => /fesZtival/.test((await fieldState(page, 1440, two)).html), 4000, 'typed where the click landed').catch(async (error) => {
			throw new Error(`${error.message}: ${JSON.stringify(await fieldState(page, 1440, two))} ${JSON.stringify(await fieldState(page, 1440, one))}`);
		});
		const left = await fieldState(page, 1440, one);
		assert.equal(left.mounted, false, 'the first is torn down');
		assert.doesNotMatch(left.outer, /ProseMirror|tiptap|contenteditable|translate|role=/, left.outer);
		assert.match(left.html, /^<p>A new idXYentity/, 'to its render, with what was typed');
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-type').count(), 1, 'one ring, on the second');
		await page.close();
	});

	test('a skipped block: its preview index matches the editor\'s, it is marked on the page, and its pill opens it', async () => {
		site.write(
			// An existing page (the public route's paths are the ones the dev server started with).
			'content/pages/about.json',
			`${JSON.stringify(
				{
					title: 'Skipped',
					blocks: [
						{ type: 'text', heading: 'Before', body: 'One', background: 'light' },
						{ type: 'carousel', images: ['a.jpg', 'b.jpg'] },
						{ type: 'text', heading: 'After', body: 'Two', background: 'dark' },
					],
				},
				null,
				2,
			)}\n`,
		);
		const page = await open('/admin/pages/about');
		// The skipped block leaves a comment between its neighbours (src/skipped.ts), no element, so the blocks either side are siblings.
		const markers = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => {
				const before = f.contentDocument!.querySelector<HTMLElement>('[data-cms-block="0"]')!;
				const out: string[] = [];
				for (let n: ChildNode | null = before; n; n = n.nextSibling) {
					if (n.nodeType === 1 && (n as HTMLElement).dataset.cmsBlock !== undefined) out.push(`${(n as HTMLElement).dataset.cmsBlock}:${(n as HTMLElement).dataset.cmsType}`);
					else if (n.nodeType === 8) out.push(`<!--${(n as Comment).data}-->`);
				}
				return { order: out, next: before.nextElementSibling?.getAttribute('data-cms-block') ?? null };
			}),
		);
		for (const frame of markers) {
			assert.deepEqual(frame.order, ['0:text', '<!--cms-skipped 1 type=carousel-->', '2:text']);
			assert.equal(frame.next, '2', 'no element between the neighbours');
		}

		// The skipped block: amber dashes and a pill on the page; the pill opens it.
		const pill = frameOn(page).locator('#cms-overlays .cms-skip[data-block="1"] button');
		await eventually(() => pill.count(), 4000, 'the skipped mark');
		assert.equal(await pill.textContent(), 'Skipped on the page: carousel');
		await pill.click();
		await eventually(async () => /Unknown block/.test((await page.textContent(`${block} .cur-title`)) ?? ''), 4000, 'the skipped block opened');
		// A click on the block after it opens that block: index 2 is the editor's third block.
		await frameOn(page).locator('[data-cms-block="2"] [data-cms-field="heading"]').click();
		await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="heading"]`);
		assert.doesNotMatch((await page.textContent(`${block} .cur-title`)) ?? '', /Unknown block/);
		assert.equal(await page.inputValue(`${block} [data-ff="heading"] input`), 'After');

		await page.close();

		// The public render of the same page: no placeholder, no markers.
		const html = await (await fetch(`${site.origin}/about`)).text();
		assert.match(html, /Before/);
		assert.doesNotMatch(html, /data-cms-|carousel/);
	});
});

// Verify 4's other half: no overlay and no marker reaches the built public site. Needs
// `pnpm build` first (starter/dist); skipped without it.
const dist = join(starter, 'dist/client');
describe('the built public site has no overlays', { skip: existsSync(dist) ? false : 'starter/dist is missing: run `pnpm build` first' }, () => {
	const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
	test('no overlay layer, no markers, no placeholder, no contenteditable, no tabindex in any built page', () => {
		const pages = files(dist).filter((f) => f.endsWith('.html'));
		assert.ok(pages.length > 0);
		for (const file of pages) {
			// M6 Decision 17: a form's page carries its one small inline script and its honeypot's tabindex="-1".
			const html = readFileSync(file, 'utf8')
				.replace(/<script type="module">[^<]*form\[data-caracms-form\][^<]*<\/script>/g, '')
				.replace(/<input type="text" name="fax" tabindex="-1"/g, '<input type="text" name="fax"');
			// A site's own scripts (its Google tag from Site Settings) are fine; what mustn't be there
			// is the editor's: a script that names the overlay layer, the markers, the admin or the endpoints.
			const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
			for (const script of scripts) assert.doesNotMatch(script, /cms-overlays|cms-box|cms-skip|data-cms-|_caracms|\/admin|page-edit|contenteditable/, `${file}: ${script.slice(0, 80)}`);
			const rest = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
			// data-cms-fixed is the site's own attribute (words it accepts as code, for `caracms audit`), so it ships.
			assert.doesNotMatch(rest, /cms-overlays|cms-box|cms-skip|data-cms-(?!fixed\b)|contenteditable|tabindex/, file);
		}
	});
});
