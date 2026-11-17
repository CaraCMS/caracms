// The on-page rich text rules that no other test pins (the test pass over the build):
// on Home's Text body and Work's two, on a
// throwaway copy of the demo under `astro dev` (helpers/dev-site.ts).
//
//   Decision 3/5  mounting changes nothing you can see; the editor adds no styling but pre-wrap
//   Decision 5    mounted by focus alone (a tap, Tab); torn down when the block's level closes, the
//                 width changes or another document opens; never mounted in a hidden width
//   Decision 7    a page edit is re-applied after a render that predates it, with no editor mounted
//   Decision 2    paste keeps what the field allows; no input rules, no autolink
//   Decision 11   undo is the page editor's own, from its mount
//   Exit step 2   a drag selects on the first press (hover has mounted the editor); and, the review's
//                 fix, a drag that starts on a second field while another session is on selects the range
//
//   node --test --experimental-strip-types test/page-rich-text-rules.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { BODY, bodyInFile, caretSettled, charPoint, fieldState, pasteOnPage, revealBody } from './helpers/rich-on-page.ts';

let site: DevSite;
let browser: Browser;
const originals = new Map<string, string>();

const HOME = 'content/pages/index.json';
const WORK = 'content/pages/work.json';
const block = '[data-pane-level="block"]';
const frameOn = (page: Page) => page.frameLocator('.frame.on iframe');
const headingInput = `${block} [data-ff="heading"] input`;
const renderedHeading = (page: Page) => frameOn(page).locator('[data-cms-block="1"] [data-cms-field="heading"]').textContent();

async function open(path = '/admin'): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
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

/** Hover then click inside `word` (+extra) in the body: the page editor is mounted, focused, the block's level open. */
async function clickIn(page: Page, word = 'words', extra = 2, selector = BODY) {
	await revealBody(page, selector);
	const at = await charPoint(page, word, extra, selector);
	await page.mouse.move(at.x, at.y);
	await eventually(async () => (await fieldState(page, 1440, selector)).mounted, 4000, 'the page editor on hover');
	await page.mouse.click(at.x, at.y);
	await eventually(async () => (await fieldState(page, 1440, selector)).focused, 4000, 'typing in the body');
	await caretSettled(page, 1440, selector);
	return at;
}

const bodyText = () => JSON.stringify(bodyInFile(site.read(HOME)));
/** The body's strings as stored (a `\*` is one backslash and a star here, not the JSON escape). */
const bodyStrings = (): string[] => (bodyInFile(site.read(HOME)) as Record<string, string | string[]>[]).flatMap((b) => Object.values(b).flat());

/** Every iframe's rich-text field that has an editor on it (any width). */
const mountedAnywhere = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => ({
			width: f.dataset.width,
			editors: f.contentDocument!.querySelectorAll('.ProseMirror, [contenteditable]:not([contenteditable="plaintext-only"])').length,
		})),
	);

describe('on-page rich text: the rules no other test pins', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('page-rich-rules');
		browser = await chromium.launch();
		for (const file of [HOME, WORK]) originals.set(file, site.read(file));
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});
	beforeEach(() => {
		for (const [file, text] of originals) site.write(file, text);
	});

	test('mounting changes nothing you can see: the same box, the same type; the one style the editor adds is white-space: pre-wrap (Decisions 3 and 5)', async () => {
		const page = await open();
		await revealBody(page);
		const look = () =>
			page.evaluate((selector) => {
				const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
				const win = doc.defaultView!;
				const el = doc.querySelector<HTMLElement>(selector)!;
				const props = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'color', 'textTransform', 'textAlign', 'fontVariantLigatures', 'fontVariationSettings', 'marginTop', 'marginBottom', 'paddingTop', 'paddingLeft', 'display', 'listStyleType'] as const;
				const style = (e: Element) => Object.fromEntries(props.map((p) => [p, win.getComputedStyle(e)[p]]));
				const box = (e: Element) => {
					const r = e.getBoundingClientRect();
					return [r.top, r.left, r.width, r.height].map((n) => Math.round(n * 100) / 100);
				};
				return {
					field: style(el),
					box: box(el),
					kids: [...el.children].map((c) => ({ tag: c.tagName, style: style(c), box: box(c) })),
					inlineStyle: el.getAttribute('style'),
					whiteSpace: win.getComputedStyle(el).whiteSpace,
				};
			}, BODY);
		const before = await look();
		assert.equal(before.whiteSpace, 'normal');
		const at = await charPoint(page, 'words', 2);
		await page.mouse.move(at.x, at.y);
		await eventually(async () => (await fieldState(page)).mounted, 4000, 'the page editor on hover');
		const after = await look();
		assert.equal(after.whiteSpace, 'pre-wrap', 'the one style it adds');
		assert.equal(after.inlineStyle, null, 'no inline style on the element');
		assert.deepEqual({ ...after, whiteSpace: '' }, { ...before, whiteSpace: '' }, 'the field, its blocks, their boxes and their type: unchanged by the mount');

		// The only rules the layer holds for a ProseMirror element set white-space (never ProseMirror's suggested font-variant-ligatures).
		const props = await page.evaluate(() => {
			const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
			const found = new Set<string>();
			const walk = (rules: CSSRuleList) => {
				for (const rule of rules) {
					if ((rule as CSSStyleRule).selectorText?.includes('ProseMirror') && (rule as CSSStyleRule).style) for (const p of (rule as CSSStyleRule).style) found.add(p);
					if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
				}
			};
			for (const sheet of doc.styleSheets) walk(sheet.cssRules);
			return [...found];
		});
		// (The stylesheet object lists the shorthand's longhands.)
		assert.deepEqual(props.sort(), ['text-wrap-mode', 'white-space-collapse'], 'the iframe styles ProseMirror with white-space only');
		await page.close();
	});

	test('focus alone mounts it (a tap, Tab): the caret where the browser put it, a session, the bar; Esc and no pointer there: a render again', async () => {
		const page = await open();
		await revealBody(page);
		assert.equal((await fieldState(page)).mounted, false);
		// What a tap does: the browser puts the caret at the tap, then focuses the field. No pointer is over the page.
		await page.evaluate((selector) => {
			const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
			const el = doc.querySelector(selector)!;
			const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
				const at = n.data.indexOf('words');
				if (at >= 0) {
					doc.getSelection()!.collapse(n, at + 2);
					return;
				}
			}
			throw new Error('no "words"');
		}, BODY);
		await frameOn(page).locator(BODY).focus();
		await eventually(async () => (await fieldState(page)).mounted, 4000, 'the page editor mounted by focus');
		assert.equal((await fieldState(page)).focused, true);
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-type').count(), 4000, 'the typing ring');
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-rtbar').count(), 4000, 'the bar');
		await eventually(() => page.locator(`${block} [data-ff="body"] .chip.typing`).count(), 4000, 'the sidebar\'s chip');
		await caretSettled(page);
		await page.keyboard.type('Q');
		await eventually(async () => /woQrds/.test((await fieldState(page)).html), 4000, 'typed where the caret was put');
		await eventually(() => /woQrds/.test(bodyText()), 8000, 'the file');
		// Esc leaves the field; the pointer was never on it, so the editor goes at once and the element is the render's.
		await page.keyboard.press('Escape');
		await eventually(async () => !(await fieldState(page)).mounted, 4000, 'torn down');
		const left = await fieldState(page);
		assert.doesNotMatch(left.outer, /ProseMirror|tiptap|contenteditable|translate|role=/, left.outer);
		assert.equal(left.outer, (await fieldState(page, 768)).outer, 'the same as the tablet\'s render of the value');
		assert.equal(await frameOn(page).locator('#cms-overlays .cms-rtbar').count(), 0, 'the bar goes with it');
		await page.close();
	});

	test('it is torn down when the block\'s level closes, even with the pointer still on the field', async () => {
		const page = await open();
		await clickIn(page);
		await page.keyboard.type('x');
		await page.keyboard.press('Escape'); // leave the field: the pointer rests on it, so it stays mounted
		await eventually(async () => !(await fieldState(page)).focused, 4000, 'out of the field');
		assert.equal((await fieldState(page)).mounted, true, 'still mounted: the pointer is on the field');
		await page.keyboard.press('Escape'); // up a level: the block's level closes
		await eventually(async () => !(await fieldState(page)).mounted, 4000, 'torn down with the level');
		assert.equal(await page.locator(`${block} [data-ff="body"]`).count(), 0, 'the block\'s level is closed');
		assert.equal((await fieldState(page)).outer, (await fieldState(page, 768)).outer, 'the element is the render\'s');
		assert.match((await fieldState(page)).html, /woxrds/, 'the typed text is kept');
		await page.close();
	});

	test('it is torn down when the width changes, nothing is mounted in the new width, and the typed text is kept', async () => {
		const page = await open();
		await clickIn(page);
		await page.keyboard.type('x');
		await eventually(() => /woxrds/.test(bodyText()), 8000, 'the file');
		// From script, so the pointer and focus stay where they are: only the width changes.
		await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[role="radio"][data-width="tablet"]')!.click());
		await page.waitForSelector('.frame.on[data-w="tablet"]');
		await eventually(async () => (await mountedAnywhere(page)).every((f) => f.editors === 0), 4000, 'no editor in any width');
		assert.match((await fieldState(page, 1440)).outer, /^<div(?![^>]*contenteditable)/, 'the desktop element is a render again');
		assert.match((await fieldState(page, 768)).html, /woxrds/, 'the tablet shows the typed text');
		assert.equal(await page.locator(`${block} [data-ff="body"] .chip.typing`).count(), 0, 'typing on the page has ended');
		await page.close();
	});

	test('it is torn down when another document opens; the typed text is kept in the first', async () => {
		const page = await open();
		await clickIn(page);
		await page.keyboard.type('x');
		await eventually(() => /woxrds/.test(bodyText()), 8000, 'the file');
		await page.evaluate((selector) => {
			const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
			(window as unknown as { __old: Element }).__old = doc.querySelector(selector)!;
		}, BODY);
		// The switcher, opened from script so the pointer never leaves the field (focus goes to its search).
		await page.evaluate(() => document.querySelector<HTMLElement>('.docbtn')!.click());
		await page.waitForSelector('#swq');
		await page.keyboard.type('contact');
		await page.keyboard.press('Enter');
		await page.waitForURL('**/admin/pages/contact');
		await eventually(
			() => page.evaluate(() => (window as unknown as { __old: Element }).__old.classList.contains('ProseMirror') === false && !(window as unknown as { __old: Element }).__old.hasAttribute('contenteditable')),
			4000,
			'the first document\'s editor torn down',
		);
		await eventually(async () => (await mountedAnywhere(page)).every((f) => f.editors === 0), 8000, 'no editor in any width of the new document');
		assert.match(bodyText(), /woxrds/, 'the first document keeps what was typed');
		await page.close();
	});

	test('a hidden width never mounts one, whatever reaches it: a hover, a focus; one editor at most, in the visible width', async () => {
		const page = await open();
		await revealBody(page);
		const poke = await page.evaluate((selector) => {
			const f = document.querySelector<HTMLIFrameElement>('#stage iframe[data-width="768"]')!;
			const doc = f.contentDocument!;
			const win = f.contentWindow as unknown as typeof globalThis;
			const el = doc.querySelector<HTMLElement>(selector)!;
			el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 20 }));
			el.focus();
			el.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
			return { tabbable: el.getAttribute('tabindex'), hidden: f.closest('.frame')!.classList.contains('on') === false };
		}, BODY);
		assert.equal(poke.tabbable, '0', 'the hidden render has the field focusable too');
		assert.equal(poke.hidden, true, 'the tablet is the hidden one');
		await new Promise((r) => setTimeout(r, 300)); // a negative wait: nothing should happen
		assert.ok((await mountedAnywhere(page)).every((f) => f.editors === 0), `nothing mounted in a hidden width: ${JSON.stringify(await mountedAnywhere(page))}`);
		assert.equal(await page.locator(`${block} [data-ff="body"] .chip.typing`).count(), 0, 'no typing session from a hidden width');
		// The visible one mounts as usual, and it's the only editor in any width.
		const at = await charPoint(page, 'words', 2);
		await page.mouse.move(at.x, at.y);
		await eventually(async () => (await fieldState(page)).mounted, 4000, 'the page editor on hover');
		assert.deepEqual((await mountedAnywhere(page)).map((f) => [f.width, f.editors]), [['1440', 1], ['768', 0], ['375', 0]]);
		await page.close();
	});

	test('a page edit made after a render began is re-applied when that render lands with no editor mounted: no frame shows the old text', async () => {
		const page = await open();
		const at = await clickIn(page);
		await page.route(`${site.origin}/_caracms/preview`, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			await new Promise((r) => setTimeout(r, 3000));
			await route.fulfill({ response: await route.fetch() });
		});
		// A render starts (the sidebar's heading), then the body is edited on the page, then the editor goes.
		await page.focus(headingInput);
		await page.keyboard.press('End');
		await page.keyboard.type('!');
		await page.mouse.click(at.x, at.y);
		await eventually(async () => (await fieldState(page)).focused, 4000, 'focus back on the page');
		await page.keyboard.type('happy ');
		await eventually(() => /happy/.test(bodyText()), 8000, 'the file');
		await page.keyboard.press('Escape');
		await page.mouse.move(5, 5);
		await eventually(async () => !(await fieldState(page)).mounted, 4000, 'torn down');
		assert.equal(/!$/.test((await renderedHeading(page)) ?? ''), false, 'the slow render has not landed yet');
		// Every animation frame from here on must show the typed words in the body, in every width.
		await page.evaluate((selector) => {
			const w = window as unknown as { __flash: number; __watch: boolean };
			w.__flash = 0;
			w.__watch = true;
			const tick = () => {
				for (const f of document.querySelectorAll<HTMLIFrameElement>('#stage iframe')) {
					const text = f.contentDocument!.querySelector(selector)?.textContent ?? '';
					if (!text.includes('happy')) w.__flash++;
				}
				if (w.__watch) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		}, BODY);
		await eventually(async () => /!$/.test((await renderedHeading(page)) ?? ''), 10_000, 'the old render to land');
		await new Promise((r) => setTimeout(r, 200));
		const flash = await page.evaluate(() => {
			(window as unknown as { __watch: boolean }).__watch = false;
			return (window as unknown as { __flash: number }).__flash;
		});
		assert.equal(flash, 0, 'no frame showed the body without the typed words');
		for (const width of [1440, 768, 375]) assert.match((await fieldState(page, width)).html, /wohappy rds/, `the ${width} iframe has the typed words`);
		assert.equal((await fieldState(page)).mounted, false);
		await page.unrouteAll({ behavior: 'ignoreErrors' });
		await page.close();
	});

	test('paste on the page keeps only paragraphs, the field\'s headings, lists, bold, italic and links; typing ** and a bare address stay as typed (no input rules, no autolink)', async () => {
		const page = await open();
		await clickIn(page);
		// Typed: no input rule turns ** into bold, and an address isn't made a link.
		await page.keyboard.type('**stars** and https://example.com ');
		await eventually(() => bodyStrings().some((t) => t.includes('\\*\\*stars\\*\\* and https://example.com')), 8000, `the asterisks, escaped, and the address as typed: ${bodyText()}`);
		assert.ok(!bodyText().includes(']('), `no link was made: ${bodyText()}`);
		assert.doesNotMatch((await fieldState(page)).html, /<strong>|<a /, 'no bold, no link on the page either');

		// Pasted: an h1 (not this field's), an image, a table, an h4, an underline, code, a nested list.
		const handled = await pasteOnPage(page, {
			'text/plain': 'ignored',
			'text/html':
				'<h1>Big</h1><p>x <b>bold</b> <i>it</i> <a href="/about">about</a> <u>u</u> <code>c</code></p><img src="/x.png"><table><tr><td>cell</td></tr></table><h2>Two</h2><h4>four</h4><ul><li><p>i</p><ul><li>nested</li></ul></li></ul>',
		});
		assert.equal(handled, true, 'the page editor took the paste');
		await eventually(() => bodyText().includes('nested'), 8000, 'the paste in the file');
		const body = bodyInFile(site.read(HOME)) as Record<string, unknown>[];
		const kinds = body.map((b) => Object.keys(b)[0]);
		assert.ok(kinds.every((k) => ['p', 'h2', 'h3', 'ul', 'ol'].includes(k!)), `only the field's kinds: ${JSON.stringify(body)}`);
		assert.ok(kinds.includes('h2') && kinds.includes('ul'), `the allowed heading and the list arrive: ${JSON.stringify(body)}`);
		const all = JSON.stringify(body);
		for (const word of ['Big', 'cell', 'four', 'nested', 'Two']) assert.ok(all.includes(word), `${word} is kept as text: ${all}`);
		assert.ok(all.includes('**bold**') && all.includes('*it*') && all.includes('[about](/about)'), `bold, italic and the link: ${all}`);
		assert.ok(!/<|img|x\.png|`/.test(all.replace(/\\\*/g, '')), `no other markup: ${all}`);
		const dom = await fieldState(page);
		assert.doesNotMatch(dom.html, /<h1|<h4|<img|<table|<td|<u>|<code|<script/, 'nor in the editor\'s DOM');
		assert.match(dom.html, /<strong>bold<\/strong>/);
		assert.match(dom.html, /<em>it<\/em>/);
		assert.match(dom.html, /<a href="\/about"[^>]*>about<\/a>/);

		// Plain text: blank lines are paragraphs, single newlines are breaks.
		await pasteOnPage(page, { 'text/plain': 'PA\nPB\n\nPC' });
		await eventually(() => bodyText().includes('PC'), 8000, 'the plain-text paste');
		const last = (bodyInFile(site.read(HOME)) as Record<string, unknown>[]).slice(-2);
		assert.ok(JSON.stringify(last).includes('PA\\nPB') && JSON.stringify(last).includes('PC'), JSON.stringify(last));
		await page.close();
	});

	test('undo on the page is the page editor\'s own: it undoes the typing and redoes it, and a teardown starts it afresh', async () => {
		const page = await open();
		await clickIn(page);
		await page.keyboard.type('abc');
		await eventually(() => /woabcrds/.test(bodyText()), 8000, 'typed');
		await page.keyboard.press('ControlOrMeta+z');
		await eventually(() => !bodyText().includes('abc'), 8000, 'undone in the file');
		assert.doesNotMatch((await fieldState(page)).html, /abc/);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await eventually(() => /woabcrds/.test(bodyText()), 8000, 'redone in the file');

		// Typed again, then the editor goes (Esc, the pointer away) and comes back: its history is new, so ⌘Z has nothing to undo.
		await page.keyboard.type('xyz');
		await eventually(() => /woabcxyzrds/.test(bodyText()), 8000, 'typed again');
		await page.keyboard.press('Escape');
		await page.mouse.move(5, 5);
		await eventually(async () => !(await fieldState(page)).mounted, 4000, 'torn down');
		const at = await charPoint(page, 'clients', 1);
		await page.mouse.move(at.x, at.y);
		await eventually(async () => (await fieldState(page)).mounted, 4000, 'mounted again');
		await page.mouse.click(at.x, at.y);
		await eventually(async () => (await fieldState(page)).focused, 4000, 'focused again');
		await caretSettled(page);
		const was = bodyText();
		await page.keyboard.press('ControlOrMeta+z');
		await new Promise((r) => setTimeout(r, 400)); // a negative wait: nothing should change
		assert.equal(bodyText(), was, 'nothing to undo in a new editor');
		assert.match((await fieldState(page)).html, /woabcxyzrds/);
		await page.close();
	});

	test('a drag selects on the first press, and ⌘B bolds just that range', async () => {
		const page = await open();
		await revealBody(page);
		const a = await charPoint(page, 'type', 0);
		const b = await charPoint(page, 'then everything', 0);
		await page.mouse.move(a.x, a.y);
		await eventually(async () => (await fieldState(page)).mounted, 4000, 'the page editor on hover');
		await page.mouse.down();
		await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 4 });
		await page.mouse.move(b.x, b.y, { steps: 4 });
		await page.mouse.up();
		await eventually(async () => (await fieldState(page)).focused, 4000, 'focus in the body');
		await caretSettled(page);
		const selected = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!.getSelection()!.toString());
		assert.equal(selected.trim(), 'type,', `the dragged range is selected: "${selected}"`);
		await page.keyboard.press('ControlOrMeta+b');
		await eventually(() => bodyText().includes('the **type,** then everything'), 8000, `the bold range in the file: ${bodyText()}`);
		await page.close();
	});

	test('review fix: a drag that starts on a second rich-text field while another field\'s session is on selects the dragged range', async () => {
		const page = await open('/admin/pages/work');
		const one = '[data-cms-block="1"] [data-cms-field="body"]';
		const two = '[data-cms-block="2"] [data-cms-field="body"]';
		await clickIn(page, 'identity', 2, one);
		await page.keyboard.type('X');
		await eventually(() => frameOn(page).locator('#cms-overlays .cms-rtbar').count(), 4000, 'the bar, in the first body');

		// Press on "website", drag to "printed", release: all on the second body, which is not mounted until the press.
		await revealBody(page, two);
		const from = await charPoint(page, 'website', 0, two);
		const to = await charPoint(page, 'printed', 0, two);
		assert.ok(Math.abs(from.y - to.y) < 6, 'both words are on one line');
		await page.mouse.move(from.x - 30, from.y, { steps: 3 });
		await page.mouse.move(from.x, from.y, { steps: 3 });
		assert.equal((await fieldState(page, 1440, two)).mounted, false, 'the second is not mounted under the pointer (a session is on in the first)');
		await page.mouse.down();
		await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 });
		await page.mouse.move(to.x, to.y, { steps: 4 });
		await page.mouse.up();
		await eventually(async () => (await fieldState(page, 1440, two)).focused, 4000, 'the session moved to the second body');
		assert.equal((await fieldState(page, 1440, two)).mounted, true);
		assert.equal((await fieldState(page, 1440, one)).mounted, false, 'the first is a render again');
		await caretSettled(page, 1440, two);
		const selected = await page.evaluate((selector) => {
			const doc = document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!;
			const el = doc.querySelector<HTMLElement & { editor: { state: { selection: { from: number; to: number }; doc: { textBetween(a: number, b: number, sep: string): string } } } }>(selector)!;
			const s = el.editor.state.selection;
			return { text: el.editor.state.doc.textBetween(s.from, s.to, '\n'), dom: doc.getSelection()!.toString() };
		}, two);
		assert.equal(selected.text, 'website and ', `the editor's selection is the dragged range: ${JSON.stringify(selected)}`);
		assert.equal(selected.dom, 'website and ', 'and so is the DOM\'s');
		// Typing replaces the selection, in the second body.
		await page.keyboard.type('site');
		await eventually(async () => /A siteprinted programme/.test((await fieldState(page, 1440, two)).html.replace(/<[^>]+>/g, '')), 4000, 'the range replaced by typing');
		await page.close();
	});
});
