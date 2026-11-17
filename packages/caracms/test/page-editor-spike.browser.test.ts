// The page editor's spike (on-page rich text, Decision 4; Phase 1's first bullet):
// /admin's own Tiptap mounted with `element: { mount: fieldEl }` on the Text block's
// body in the visible preview iframe (candidate A), and the checklist run in Chromium
// and in WebKit (WebKit stands in for Safari). On a throwaway copy of the demo under
// `astro dev` (helpers/dev-site.ts). The editor is loaded into /admin's own window
// through the dev server (helpers/page-editor-spike.ts), so it runs in /admin's realm.
//
// WebKit: `npx playwright-core install webkit` (in packages/caracms). Without it the
// WebKit half skips and says so: a skip is not a pass.
//
//   node --test --experimental-strip-types test/page-editor-spike.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { browsers, browserSkip, packageRoot, startDevSite, type DevSite } from './helpers/dev-site.ts';
import type * as Spike from './helpers/page-editor-spike.ts';

type S = typeof Spike;
declare global {
	interface Window {
		__s: S;
	}
}

let site: DevSite;
const SPIKE = `/@fs${packageRoot}test/helpers/page-editor-spike.ts`;

const P = (text: string) => ({ kind: 'p' as const, runs: [{ text }] });
const LONG =
	'A long paragraph that wraps across several lines in the preview, so the arrow keys have visual lines to move between inside one block, and then some more words so it surely wraps at desktop width as well as the others.';

/** The editor's document as block texts (a hardBreak as \n). */
function texts(doc: any): string[] {
	const inline = (n: any): string => (n.content ?? []).map((c: any) => (c.type === 'text' ? c.text : c.type === 'hardBreak' ? '\n' : inline(c))).join('');
	return (doc.content ?? []).map((b: any) => (b.type.endsWith('List') ? (b.content ?? []).map(inline).join('|') : inline(b)));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the page editor spike (candidate A)', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('page-editor-spike');
	});
	after(async () => {
		await site?.close();
	});

	for (const { name, type, skip } of browsers) {
		describe(`in ${name}`, { skip: skip || false }, () => {
			let browser: Browser;
			let page: Page;
			const s = <R,>(fn: (s: S, arg: any) => R | Promise<R>, arg?: unknown) =>
				page.evaluate(([src, a]) => new Function('s', 'a', `return (${src})(s, a)`)(window.__s, a), [fn.toString(), arg] as const) as Promise<R>;
			const mount = (value: unknown) => s((s, v) => s.mount(v), value);
			/**
			 * Wait until ProseMirror has read the browser's selection (it does on `selectionchange`, a task after a
			 * native caret move: a click, a drag, an arrow key). Never a fixed pause: those flaked under load.
			 */
			const settle = async () => {
				const end = Date.now() + 5000;
				for (;;) {
					const dom = await s((s) => s.domSelection());
					const pm = await s((s) => s.selection());
					if (dom && dom.from === pm.from && dom.to === pm.to) return;
					if (Date.now() > end) throw new Error(`ProseMirror never read the selection: DOM ${JSON.stringify(dom)}, editor ${JSON.stringify(pm)}`);
					await wait(20);
				}
			};
			/** A key, then until ProseMirror has read the selection back. */
			const key = async (k: string) => {
				await page.keyboard.press(k);
				await settle();
			};
			/** The editor's block texts, once they equal `want` (cut and IME land a task after the event), else whatever they are. */
			const textsBecome = async (want: string[]) => {
				const end = Date.now() + 3000;
				let got = texts(await s((s) => s.json()));
				while (JSON.stringify(got) !== JSON.stringify(want) && Date.now() < end) {
					await wait(20);
					got = texts(await s((s) => s.json()));
				}
				return got;
			};
			const mod = name === 'webkit' || process.platform === 'darwin' ? 'Meta' : 'Control';

			before(async () => {
				browser = await type.launch();
				page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
				page.on('pageerror', (error) => console.error(`[${name} page]`, error.message));
				await page.goto(`${site.origin}/admin`);
				await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
				await page.evaluate(async (url) => {
					window.__s = await import(/* @vite-ignore */ url);
					window.__s.prepare();
				}, SPIKE);
			});
			after(async () => {
				await browser?.close();
			});

			/** Mount a value, scroll the field into view in the iframe, and return the field's shape. */
			async function fresh(value: unknown) {
				const shape = await mount(value);
				await s((s) => s.field().scrollIntoView({ block: 'center' }));
				await wait(50);
				return shape;
			}

			test('1. no .ProseMirror wrapper: the field is the root, its first child the first block', async () => {
				const shape = await fresh([{ kind: 'h2', runs: [{ text: 'A heading' }] }, P('One.')]);
				assert.equal(shape.rootIsField, true, 'view.dom is the field');
				assert.equal(shape.wrapper, false, 'no .ProseMirror inside the field');
				assert.equal(shape.first, 'H2');
				assert.deepEqual(shape.childTags, ['H2', 'P']);
				assert.equal(shape.count, 1);
			});

			test('2. a click puts the caret where it lands', async () => {
				await fresh([P('First paragraph with some words in it.'), P('Second paragraph here.')]);
				const pt = await s((s) => s.charPoint('some', 2));
				await page.mouse.click(pt.x, pt.y);
				await settle();
				const sel = await s((s) => s.selection());
				const want = await s((s) => s.posAt('some', 2));
				assert.equal(sel.empty, true);
				assert.equal(sel.from, want, 'the caret is between "so" and "me"');
				assert.equal(await s((s) => s.focusedInFrame()), true, 'the field has focus in the iframe');
			});

			test('3. a drag selects on the first press', async () => {
				await fresh([P('First paragraph with some words in it.'), P('Second paragraph here.')]);
				const a = await s((s) => s.charPoint('paragraph with'));
				const b = await s((s) => s.charPoint('with', 4));
				await page.mouse.move(a.x, a.y);
				await page.mouse.down();
				await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 4 });
				await page.mouse.move(b.x, b.y, { steps: 4 });
				await page.mouse.up();
				await settle();
				const sel = await s((s) => s.selection());
				assert.equal(sel.from, await s((s) => s.posAt('paragraph with')));
				assert.equal(sel.to, await s((s) => s.posAt('with', 4)));
			});

			test('4. typing, Enter, Shift+Enter and Backspace across a block boundary', async () => {
				await fresh([P('First paragraph.'), P('Second paragraph.')]);
				const pt = await s((s) => s.charPoint('paragraph.'));
				await page.mouse.click(pt.x, pt.y);
				await settle();
				await page.keyboard.type('studio ');
				assert.deepEqual(texts(await s((s) => s.json())), ['First studio paragraph.', 'Second paragraph.']);
				await page.keyboard.press('Enter');
				assert.deepEqual(texts(await s((s) => s.json())), ['First studio ', 'paragraph.', 'Second paragraph.']);
				await page.keyboard.press('Shift+Enter');
				assert.deepEqual(texts(await s((s) => s.json())), ['First studio ', '\nparagraph.', 'Second paragraph.']);
				await page.keyboard.press('Backspace'); // the break
				await page.keyboard.press('Backspace'); // across the block boundary: joins
				assert.deepEqual(texts(await s((s) => s.json())), ['First studio paragraph.', 'Second paragraph.']);
				assert.deepEqual(await s((s) => s.describe().childTags), ['P', 'P']);
				assert.match(await s((s) => s.html()), /^<p>First studio paragraph\.<\/p><p>Second paragraph\.<\/p>$/);
			});

			test('5. Left and Right across a line end and a block boundary', async () => {
				await fresh([P('Line one\nline two'), P('Next block')]);
				// Across the break: the end of "Line one" → Right → the start of "line two".
				const endOne = await s((s) => s.posAt('Line one', 8));
				await s((s, p) => s.setSelection(p), endOne);
				await key('ArrowRight');
				assert.equal((await s((s) => s.selection())).from, await s((s) => s.posAt('line two')), 'Right over the break');
				await key('ArrowLeft');
				assert.equal((await s((s) => s.selection())).from, endOne, 'Left back over the break');
				// Across the block boundary.
				const endTwo = await s((s) => s.posAt('line two', 8));
				await s((s, p) => s.setSelection(p), endTwo);
				await key('ArrowRight');
				assert.equal((await s((s) => s.selection())).from, await s((s) => s.posAt('Next block')), 'Right into the next block');
				await key('ArrowLeft');
				assert.equal((await s((s) => s.selection())).from, endTwo, 'Left back into the first block');
			});

			test('6. Up and Down across a line end (wrapped and broken) and a block boundary', async () => {
				await fresh([P(LONG), P('Short one\nshort two'), P('Last block')]);
				// Down through the wrapped paragraph: it stays in the block until its last line.
				await s((s, p) => s.setSelection(p), await s((s) => s.posAt('A long', 2)));
				const end = await s((s) => s.posAt('others.', 7));
				const shortStart = await s((s) => s.posAt('Short one'));
				const seen: number[] = [];
				for (let i = 0; i < 12; i++) {
					await key('ArrowDown');
					const at = (await s((s) => s.selection())).from;
					seen.push(at);
					if (at >= shortStart) break;
				}
				assert.ok(seen.length >= 2, `the wrapped paragraph has more than one line (${seen.join(',')})`);
				assert.ok(seen.slice(0, -1).every((p) => p <= end), `stays in the long block until its last line (${seen.join(',')})`);
				const inShort = seen.at(-1)!;
				assert.ok(inShort >= shortStart && inShort <= (await s((s) => s.posAt('Short one', 9))), `Down from the last line goes to the next block's first line (${inShort})`);
				// Down across the <br>, then across the block boundary.
				await key('ArrowDown');
				const two = (await s((s) => s.selection())).from;
				assert.ok(two >= (await s((s) => s.posAt('short two'))) && two <= (await s((s) => s.posAt('short two', 9))), `Down over the break (${two})`);
				await key('ArrowDown');
				const last = (await s((s) => s.selection())).from;
				assert.ok(last >= (await s((s) => s.posAt('Last block'))), `Down into the last block (${last})`);
				await key('ArrowUp');
				const backTwo = (await s((s) => s.selection())).from;
				assert.ok(backTwo >= (await s((s) => s.posAt('short two'))) && backTwo <= (await s((s) => s.posAt('short two', 9))), `Up back over the boundary (${backTwo})`);
				await key('ArrowUp');
				const backOne = (await s((s) => s.selection())).from;
				assert.ok(backOne >= shortStart && backOne <= (await s((s) => s.posAt('Short one', 9))), `Up back over the break (${backOne})`);
				await key('ArrowUp');
				const backLong = (await s((s) => s.selection())).from;
				assert.ok(backLong < shortStart - 1, `Up into the wrapped paragraph's last line (${backLong})`);
			});

			test('7. view.coordsAtPos at the caret gives a rect in the iframe\'s coordinates', async () => {
				await fresh([P('First paragraph with some words in it.'), P('Second paragraph here.')]);
				await s((s) => s.field().scrollIntoView({ block: 'end' }));
				const got = await s((s) => {
					const pos = s.posAt('words');
					s.setSelection(pos);
					const c = s.pe().view.coordsAtPos(pos);
					return { coords: { left: c.left, top: c.top, bottom: c.bottom }, want: s.charRect('words') };
				});
				assert.ok(Math.abs(got.coords.left - got.want.left) < 2, `left ${got.coords.left} vs ${got.want.left}`);
				assert.ok(Math.abs(got.coords.top - got.want.top) < 3, `top ${got.coords.top} vs ${got.want.top}`);
				assert.ok(Math.abs(got.coords.bottom - got.want.bottom) < 3, `bottom ${got.coords.bottom} vs ${got.want.bottom}`);
				// And at a block's end (the case behind endOfTextblock).
				const end = await s((s) => {
					const pos = s.posAt('it.', 3);
					const c = s.pe().view.coordsAtPos(pos);
					const r = s.charRect('it.', 2);
					return { left: c.left, want: r.left, top: c.top, wantTop: r.top };
				});
				assert.ok(end.left > end.want && end.left - end.want < 20, `the block's end, right of its last character (${end.left} vs ${end.want})`);
				assert.ok(Math.abs(end.top - end.wantTop) < 3);
			});

			test('8. ⌘B and ⌘I', async () => {
				await fresh([P('Make this bold and that italic.')]);
				await s((s) => s.setSelection(s.posAt('this'), s.posAt('this', 4)));
				await page.keyboard.press(`${mod}+b`);
				await s((s) => s.setSelection(s.posAt('that'), s.posAt('that', 4)));
				await page.keyboard.press(`${mod}+i`);
				assert.equal(await s((s) => s.html()), '<p>Make <strong>this</strong> bold and <em>that</em> italic.</p>');
			});

			test('9. paste of HTML and of plain text', async () => {
				await fresh([P('Start.')]);
				await s((s) => s.setSelection(s.posAt('Start.', 6)));
				const pasted = await s((s) =>
					s.clipboard('paste', {
						'text/html': '<h1>Big</h1><p>Some <b>bold</b> and <i>it</i> <a href="/work">work</a></p><img src="x.png"><table><tr><td>cell</td></tr></table><ul><li><p>item</p></li></ul>',
						'text/plain': 'ignored',
					}),
				);
				assert.equal(pasted.prevented, true, 'ProseMirror handled the paste');
				const after = await s((s) => s.html());
				assert.doesNotMatch(after, /<h1|<img|<table|<td/, after);
				assert.match(after, /<strong>bold<\/strong>/);
				assert.match(after, /<em>it<\/em>/);
				assert.match(after, /<a href="\/work"[^>]*>work<\/a>/);
				assert.match(after, /cell/);
				await fresh([P('Start.')]);
				await s((s) => s.setSelection(s.posAt('Start.', 6)));
				await s((s) => s.clipboard('paste', { 'text/plain': ' one\n\ntwo\nthree' }));
				assert.deepEqual(texts(await s((s) => s.json())), ['Start. one', 'two\nthree']);
			});

			test('10. copy and cut', async () => {
				await fresh([P('Copy these words here.')]);
				await s((s) => s.setSelection(s.posAt('these'), s.posAt('words', 5)));
				const copied = await s((s) => s.clipboard('copy'));
				assert.equal(copied.plain, 'these words');
				assert.match(copied.html, /these words/);
				assert.deepEqual(texts(await s((s) => s.json())), ['Copy these words here.']);
				const cut = await s((s) => s.clipboard('cut'));
				assert.equal(cut.plain, 'these words');
				assert.deepEqual(await textsBecome(['Copy  here.']), ['Copy  here.']);
			});

			test('11. ⌘Z undoes', async () => {
				await fresh([P('Undo me.')]);
				await s((s) => s.setSelection(s.posAt('me.', 3)));
				await page.keyboard.type(' Now');
				assert.deepEqual(texts(await s((s) => s.json())), ['Undo me. Now']);
				await page.keyboard.press(`${mod}+z`);
				assert.deepEqual(texts(await s((s) => s.json())), ['Undo me.']);
				await page.keyboard.press(`${mod}+Shift+z`);
				assert.deepEqual(texts(await s((s) => s.json())), ['Undo me. Now']);
			});

			test('12. IME composition: a dead key, ´ then e, gives é', async () => {
				await fresh([P('Caf here.')]);
				await s((s) => s.setSelection(s.posAt('Caf', 3)));
				if (name === 'chromium') {
					// The browser's own IME path, through the DevTools protocol.
					const cdp = await page.context().newCDPSession(page);
					await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 });
					await wait(30);
					await cdp.send('Input.imeSetComposition', { text: 'é', selectionStart: 1, selectionEnd: 1 });
					await wait(30);
					await cdp.send('Input.insertText', { text: 'é' });
					assert.deepEqual(await textsBecome(['Café here.']), ['Café here.'], 'Chromium IME');
					await fresh([P('Caf here.')]);
					await s((s) => s.setSelection(s.posAt('Caf', 3)));
				}
				// Synthetic composition events with the DOM change a browser makes (WebKit has no IME driver).
				await s((s) => s.compose());
				assert.deepEqual(texts(await s((s) => s.json())), ['Café here.'], 'synthetic composition');
				await page.keyboard.type('s');
				assert.deepEqual(texts(await s((s) => s.json())), ['Cafés here.'], 'typing goes on after it');
			});

			test('13. focus leaving to /admin and coming back keeps the selection', async () => {
				await fresh([P('Keep this selection safe.')]);
				const range = await s((s) => {
					s.setSelection(s.posAt('this'), s.posAt('selection', 9));
					return s.selection();
				});
				await page.evaluate(() => {
					const input = document.createElement('input');
					input.id = 'spike-input';
					input.style.cssText = 'position:fixed;top:0;left:0;z-index:99';
					document.body.append(input);
					input.focus();
				});
				await page.keyboard.type('elsewhere');
				await wait(50);
				assert.equal(await page.evaluate(() => document.activeElement?.id), 'spike-input', 'focus is in /admin');
				assert.deepEqual(await s((s) => s.selection()), range, 'the editor\'s selection, while /admin has focus');
				assert.deepEqual(texts(await s((s) => s.json())), ['Keep this selection safe.']);
				await s((s) => s.pe().view.focus());
				await settle();
				assert.deepEqual(await s((s) => s.selection()), range, 'the editor\'s selection, back');
				assert.deepEqual(await s((s) => s.domSelection()), { from: range.from, to: range.to }, 'the iframe\'s DOM selection, back');
				await page.keyboard.type('X');
				assert.deepEqual(texts(await s((s) => s.json())), ['Keep X safe.'], 'typing replaces the kept selection');
				await page.evaluate(() => document.getElementById('spike-input')?.remove());
			});

			test('14. a morph with focus in /admin leaves the editor\'s DOM and selection alone', async () => {
				await fresh([P('Morph around this text.'), P('And this one.')]);
				const range = await s((s) => {
					s.setSelection(s.posAt('this text'), s.posAt('this text', 4));
					return s.selection();
				});
				await page.evaluate(() => {
					const input = document.createElement('input');
					input.id = 'spike-input';
					document.body.append(input);
					input.focus();
				});
				const before = await s((s) => {
					const el = s.field();
					(window as any).__nodes = [el, ...el.querySelectorAll('*'), ...[...el.querySelectorAll('p')].map((p) => p.firstChild)];
					return s.html();
				});
				const morph = await s((s) => s.morphFresh());
				assert.deepEqual(morph, { paired: true, tornDown: false, count: 1 }, 'paired with its own field and left alone');
				assert.equal(await s((s) => s.html()), before, 'the editor\'s DOM');
				assert.equal(
					await s((s) => {
						const el = s.field();
						const now = [el, ...el.querySelectorAll('*'), ...[...el.querySelectorAll('p')].map((p) => p.firstChild)];
						const was = (window as any).__nodes as Node[];
						return was.length === now.length && was.every((n, i) => n === now[i]);
					}),
					true,
					'the very same nodes',
				);
				assert.deepEqual(await s((s) => s.selection()), range, 'the selection');
				assert.deepEqual(texts(await s((s) => s.json())), ['Morph around this text.', 'And this one.'], 'nothing read as typing');
				await s((s) => s.pe().view.focus());
				await settle();
				assert.deepEqual(await s((s) => s.domSelection()), { from: range.from, to: range.to }, 'the DOM selection, back in the iframe');

				// Decision 6: a render with a same-tag sibling before the field pairs the editor with the sibling: torn down, one field after.
				const odd = await s((s) =>
					s.morphFresh((html) => html.replace(/(<div[^>]*data-cms-field="body")/, '<div class="spike-sibling">Sibling</div>$1')),
				);
				assert.equal(odd.count, 1, 'one field on the page');
				assert.equal(odd.tornDown, true, 'torn down in the callback');
				assert.match(await s((s) => s.field().textContent ?? ''), /We start with the words/, 'the field holds the render\'s text');
				await page.evaluate(() => document.getElementById('spike-input')?.remove());
				await s((s) => s.unmount());
			});

			test('15. teardown leaves the element exactly as a render would', async () => {
				const fieldHtml = (html: string) => {
					const m = html.match(/<div[^>]*data-cms-field="body"[^>]*>[\s\S]*?<\/div>/);
					return m?.[0];
				};
				// A fresh render of the demo's body; mount on it (a no-op value change), tear down, compare.
				await s((s) => s.unmount());
				await s((s) => s.morphFresh());
				const rendered = await s((s) => s.field().outerHTML);
				const raw = await page.evaluate(async () => (await (await fetch(document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.src)).text()));
				assert.ok(fieldHtml(raw));
				await s((s) => {
					s.mount('We start with the words, then the type, then everything else.\nMost of our clients stay for years, and so does the work.');
					s.setSelection(5);
					s.unmount();
				});
				assert.equal(await s((s) => s.field().outerHTML), rendered, 'outerHTML after teardown');
			});

			test('16. (finding) tabindex vs contenteditable: which gives a native caret on a tap', async () => {
				const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
				const tp = await ctx.newPage();
				await tp.goto(`${site.origin}/admin`);
				await tp.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
				await tp.evaluate(async (url) => {
					window.__s = await import(/* @vite-ignore */ url);
					window.__s.prepare();
				}, SPIKE);
				const results: Record<string, unknown> = {};
				for (const attr of ['tabindex', 'contenteditable'] as const) {
					const pt = await tp.evaluate((attr) => {
						const s = window.__s;
						const el = s.field();
						el.removeAttribute('tabindex');
						el.removeAttribute('contenteditable');
						el.setAttribute(attr, attr === 'tabindex' ? '0' : 'true');
						s.frameDoc().getSelection()?.removeAllRanges();
						el.scrollIntoView({ block: 'center' });
						return s.charPoint('words', 2);
					}, attr);
					await wait(50);
					await tp.touchscreen.tap(pt.x, pt.y);
					await wait(120);
					results[attr] = await tp.evaluate(() => {
						const s = window.__s;
						const doc = s.frameDoc();
						const sel = doc.getSelection();
						const el = s.field();
						const inField = !!sel?.anchorNode && el.contains(sel.anchorNode);
						return {
							focused: doc.activeElement === el,
							caretInField: inField && !!sel?.isCollapsed,
							at: inField ? `${(sel!.anchorNode as Text).data?.slice(0, sel!.anchorOffset).slice(-8)}|` : null,
						};
					});
				}
				console.log(`[spike ${name}] a tap on the field:`, JSON.stringify(results));
				await ctx.close();
			});
		});
	}
});
