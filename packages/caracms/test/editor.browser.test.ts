// The editor's frame in a real browser (Phase 2 → Verify 1–5), on a throwaway copy
// of the demo site under `astro dev` (helpers/dev-site.ts). Headless Chromium from
// Playwright's cache; skipped without it.
//
//   node --test --experimental-strip-types test/editor.browser.test.ts
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

const UI_COOKIE = 'caracms-ui';

async function open(path: string, init?: (page: Page) => Promise<void>): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await init?.(page);
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
	return page;
}

/** Wait until `check` holds, polling (no fixed sleeps in assertions). */
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

const keepState = (page: Page) => page.getAttribute('[data-keep]', 'data-keep');

/** Every iframe's layout width, its window's width, and whether it or any ancestor is display: none. */
const frameReport = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((iframe) => {
			let hidden = false;
			for (let el: Element | null = iframe; el; el = el.parentElement) if (getComputedStyle(el).display === 'none') hidden = true;
			const box = iframe.parentElement!.getBoundingClientRect();
			return {
				width: iframe.dataset.width,
				layout: iframe.clientWidth,
				inner: iframe.contentWindow!.innerWidth,
				hidden,
				boxed: box.width > 0 && box.height > 0,
			};
		}),
	);

describe('the editor in the browser', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('editor');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('Verify 1: the chrome is in the server\'s HTML before any script runs, with the Pages groups as the cookie says', async () => {
		const cookie = (open: Record<string, boolean>) => `${UI_COOKIE}=${encodeURIComponent(JSON.stringify({ open, recent: [] }))}`;
		const closed = await (await fetch(`${site.origin}/admin`, { headers: { cookie: cookie({ 'pages:services': false }) } })).text();
		for (const html of [closed]) {
			assert.match(html, /<footer class="bar" id="bar"/);
			assert.match(html, /<aside class="side" id="side"/);
			assert.match(html, /<main class="stage unpainted" id="stage"/);
			assert.match(html, /data-keep="kept"/);
			assert.equal(html.match(/<iframe [^>]*src="\/_caracms\/preview\?collection=pages&amp;path=index"/g)?.length, 3);
			assert.match(html, /<title>Home · CaraCMS<\/title>/);
			assert.match(html, /aria-label="Blocks on Home"/);
		}
		assert.match(closed, /data-group="pages:services" aria-expanded="false"/);
		assert.doesNotMatch(closed, /data-doc="pages\/services\/branding"/);

		const opened = await (await fetch(`${site.origin}/admin`, { headers: { cookie: cookie({ 'pages:services': true }) } })).text();
		assert.match(opened, /data-group="pages:services" aria-expanded="true"/);
		assert.match(opened, /data-doc="pages\/services\/branding"/);

		// A group holding the open document starts open, whatever the cookie says (Decision 8).
		const branding = await fetch(`${site.origin}/admin/pages/services/branding`, { headers: { cookie: cookie({ 'pages:services': false }) } });
		const brandingHtml = await branding.text();
		assert.match(brandingHtml, /data-group="pages:services" aria-expanded="true"/);
		assert.match(brandingHtml, /<title>Branding · CaraCMS<\/title>/);
		assert.match(branding.headers.get('set-cookie') ?? '', /caracms-ui=/);

		// An address that isn't a document.
		assert.equal((await fetch(`${site.origin}/admin/pages/nope`)).status, 404);
		assert.equal((await fetch(`${site.origin}/admin/elsewhere/x`)).status, 404);
	});

	test('content folders are out of Vite\'s watch (Decision 5)', () => {
		const watched = site.watched();
		const content = join(site.root, 'content');
		assert.ok(watched[site.root]?.includes('src'), 'the site itself is watched');
		assert.deepEqual(watched[content] ?? [], [], 'nothing inside content/ is watched');
		assert.deepEqual(
			Object.keys(watched).filter((dir) => dir.startsWith(join(content, 'pages')) || dir.startsWith(join(content, 'journal'))),
			[],
		);
	});

	test('Verify 2: in every editing state the iframes are 1440, 768 and 375 wide, and none is display: none', async () => {
		const page = await open('/admin/pages/about');
		const problems: string[] = [];
		const check = async (state: string) => {
			for (const f of await frameReport(page)) {
				if (f.layout !== Number(f.width) || f.inner !== Number(f.width)) problems.push(`${state}: the ${f.width} iframe is ${f.layout} (window ${f.inner})`);
				if (f.hidden) problems.push(`${state}: the ${f.width} iframe is display: none`);
				if (!f.boxed) problems.push(`${state}: the ${f.width} iframe's box is zero-size`);
			}
		};
		for (const width of ['desktop', 'tablet', 'phone']) {
			await page.click(`.seg button[data-width="${width}"]`);
			await page.click('.side-level:not([hidden]) .lv >> nth=0'); // up to documents
			await check(`documents, ${width}`);
			await page.click('.drow.coll[data-coll="journal"]');
			await check(`a collection, ${width}`);
			await page.click('.side-level:not([hidden]) .lv >> nth=0');
			await page.click('[data-doc="pages/about"]');
			await page.waitForSelector('[data-pane-level="document"]');
			await check(`a document, ${width}`);
			await page.click('.brow-main >> nth=1');
			await page.waitForSelector('[data-pane-level="block"]');
			await check(`a block, ${width}`);
			const visible = await page.evaluate(() => document.querySelector('.frame.on')?.getAttribute('data-w'));
			assert.equal(visible, width);
		}
		// Too narrow: the note shows, the editor is hidden, the previews keep their layout.
		await page.setViewportSize({ width: 900, height: 700 });
		assert.equal(await page.isVisible('#narrow'), true);
		await check('too narrow');
		await page.setViewportSize({ width: 1440, height: 900 });
		assert.equal(await page.isVisible('#narrow'), false);
		assert.deepEqual(problems, []);
		await page.close();
	});

	test('Verify 3: an edit reaches the disk about a second later; the server stops and comes back; nothing is lost', async () => {
		const file = 'content/pages/about.json';
		const original = site.read(file);
		const page = await open('/admin/pages/about', async (p) => {
			// The keep states the bar shows, from the first paint, across reloads.
			await p.addInitScript(() => {
				const log: string[] = JSON.parse(sessionStorage.getItem('keepLog') ?? '[]');
				const record = () => {
					const state = document.querySelector('[data-keep]')?.getAttribute('data-keep');
					if (state && log.at(-1) !== state) {
						log.push(state);
						sessionStorage.setItem('keepLog', JSON.stringify(log));
					}
				};
				document.addEventListener('DOMContentLoaded', () => {
					record();
					new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-keep'] });
				});
			});
		});
		const keepLog = async () => JSON.parse((await page.evaluate(() => sessionStorage.getItem('keepLog'))) ?? '[]') as string[];
		await page.evaluate(() => {
			(window as any).__noReload = true;
			for (const f of document.querySelectorAll('iframe')) (f.contentWindow as any).__noReload = true;
		});

		await page.click('.brow-main >> nth=1'); // the Text block
		const heading = page.locator('[data-pane-level="block"] input.input').first();
		assert.equal(await heading.inputValue(), 'How we work');
		await heading.fill('How we work now');
		const typedAt = Date.now();
		await eventually(() => site.read(file).includes('"How we work now"'), 6000, 'the file to change');
		const took = Date.now() - typedAt;
		assert.ok(took >= 800, `written ${took}ms after the change (about a second, not at once)`);
		// Decision 7: only that line changed.
		const lines = (t: string) => t.split('\n');
		const changed = lines(site.read(file)).filter((line, i) => line !== lines(original)[i]);
		assert.deepEqual(changed, ['      "heading": "How we work now",']);
		await eventually(async () => (await keepState(page)) === 'kept', 4000, 'Kept');
		assert.deepEqual(await keepLog(), ['kept', 'keeping', 'kept']);
		assert.equal(await page.evaluate(() => (window as any).__noReload), true, '/admin did not reload');
		assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => (f.contentWindow as any).__noReload)), [true, true, true]);
		// The preview shows it (all three).
		await eventually(
			() => page.evaluate(() => [...document.querySelectorAll('iframe')].every((f) => f.contentDocument!.body.innerText.includes('How we work now'))),
			4000,
			'the preview',
		);

		// The server stops: the next change can't be kept, and the bar says so and stays.
		await site.stop();
		try {
		await heading.fill('How we work, offline');
		await eventually(async () => (await keepState(page)) === 'offline', 6000, "Can't reach the server");
		assert.equal(await page.isVisible('.side-level:not([hidden]) [data-note="offline"]'), true);
		await new Promise((r) => setTimeout(r, 2500));
		assert.equal(await keepState(page), 'offline', 'it keeps saying so (no timer retries)');
		assert.doesNotMatch(site.read(file), /offline/);
		} catch (error) {
			await site.start();
			throw error;
		}

		// The server comes back: Vite reloads the page, the edits held in the browser are re-sent.
		const reloaded = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 20000 });
		await site.start();
		await reloaded;
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		await eventually(() => site.read(file).includes('"How we work, offline"'), 8000, 'the re-sent edit on disk');
		await eventually(async () => (await keepState(page)) === 'kept', 6000, 'Kept after the re-send');
		const log = await keepLog();
		const sinceOffline = log.slice(log.lastIndexOf('offline') + 1);
		assert.deepEqual(sinceOffline, ['keeping', 'kept'], `after the reload: ${log.join(' → ')}`);
		// The preview shows the re-sent copy, not the file as it was.
		await eventually(
			() => page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe')!.contentDocument!.body.innerText.includes('How we work, offline')),
			4000,
			'the preview after the reload',
		);
		await page.close();
	});

	test('Verify 4: opening another document never shows a blank preview; the address changes; a reload opens it again', async () => {
		const page = await open('/admin/pages/about');
		// Sample the visible iframe on every animation frame.
		await page.evaluate(() => {
			const samples: { blank: boolean; text: string }[] = [];
			(window as any).__samples = samples;
			const tick = () => {
				const frame = document.querySelector<HTMLIFrameElement>('.frame.on iframe');
				const doc = frame?.contentDocument;
				const text = doc?.body?.innerText?.trim() ?? '';
				samples.push({ blank: !doc || doc.location.href === 'about:blank' || text.length === 0, text: text.slice(0, 40) });
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
			(window as any).__loads = 0;
			for (const f of document.querySelectorAll('iframe')) f.addEventListener('load', () => (window as any).__loads++);
		});
		await page.click('[data-pane-level="document"] .lv'); // up to the documents level
		await page.click('[data-group="pages:services"]');
		await page.click('[data-doc="pages/services/branding"]');
		await page.waitForSelector('[data-pane-level="document"]');
		await eventually(
			() => page.evaluate(() => document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!.body.innerText.toUpperCase().includes('NAMES, MARKS')),
			6000,
			'Branding in the preview',
		);
		const samples = (await page.evaluate(() => (window as any).__samples)) as { blank: boolean; text: string }[];
		assert.ok(samples.length > 5, 'sampled some frames');
		assert.deepEqual(samples.filter((s) => s.blank), [], 'no blank frame');
		// M8 trial, item 8: another document loads each frame afresh, once (its own scripts run), with no blank frame between.
		// The third frame's load event can land a moment after the first two have painted Branding.
		await eventually(() => page.evaluate(() => (window as any).__loads === 3), 4000, 'each iframe to load the new document');
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(await page.evaluate(() => (window as any).__loads), 3, 'each iframe loaded the new document once');
		assert.equal(new URL(page.url()).pathname, '/admin/pages/services/branding');
		assert.match(await page.title(), /^Branding · CaraCMS$/);

		await page.reload();
		await page.waitForSelector('#stage[data-painted="true"]');
		assert.match(await page.textContent('[data-pane-level="document"] .cur-title') ?? '', /Branding/);
		assert.ok(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe')!.contentDocument!.body.innerText.toUpperCase().includes('NAMES, MARKS')));

		// Back opens About again.
		await page.goBack();
		await eventually(async () => /About/.test((await page.textContent('[data-pane-level="document"] .cur-title')) ?? ''), 6000, 'About after Back');
		await page.close();
	});

	test('a failed load on a document switch (a 404) keeps the last good preview and says so; Try again shows the document', async () => {
		const page = await open('/admin/pages/about');
		const frames = () =>
			page.evaluate(() =>
				[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => ({
					marked: f.contentDocument!.documentElement.hasAttribute('data-caracms-preview'),
					text: f.contentDocument!.body?.innerText.toUpperCase() ?? '',
				})),
			);
		const before = await frames();
		assert.ok(before.every((f) => f.marked), 'the preview route marks its pages');
		// Each frame's own text (the phone's menu is folded away, say).
		const about = before.map((f) => f.text.slice(0, 60));
		// The file went from disk between the editor reading it and the frames loading it: the preview's GET answers 404.
		const branding = (url: URL) => url.pathname === '/_caracms/preview' && url.searchParams.get('path') === 'services/branding';
		await page.route(branding, (route) =>
			route.request().method() === 'GET' ? route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'There is no pages/services/branding.' }) : route.continue(),
		);
		await page.click('[data-pane-level="document"] .lv');
		await page.click('[data-group="pages:services"]');
		await page.click('[data-doc="pages/services/branding"]');
		await page.waitForSelector('.bar-warn', { timeout: 8000 });
		assert.match((await page.textContent('.bar-warn')) ?? '', /Preview not updated/);
		const after = await eventually(async () => {
			const f = await frames();
			return f.every((x, i) => x.marked && x.text.startsWith(about[i]!)) ? f : undefined;
		}, 8000, 'the last good preview (About) back in all three frames').catch(async (error) => {
			throw new Error(`${error.message}\n${JSON.stringify(await frames(), null, 1).slice(0, 2000)}`);
		});
		assert.ok(after!.every((f) => !f.text.includes('THERE IS NO')), 'the error page is never shown as the page');

		await page.unroute(branding);
		await page.click('.bar-warn');
		await page.click('#pops .pop .btn');
		await eventually(async () => (await frames()).every((f) => f.marked && f.text.includes('NAMES, MARKS')), 8000, 'Branding after Try again');
		assert.equal(await page.isVisible('.bar-warn'), false);
		await page.close();
	});

	test('Verify 5: a failed render keeps the last good preview and says so; Try again shows the change', async () => {
		const page = await open('/admin/journal/notes-from-the-ridge');
		const frameText = () => page.evaluate(() => document.querySelector<HTMLIFrameElement>('.frame.on iframe')!.contentDocument!.body.innerText);
		const before = await frameText();
		await page.route(`${site.origin}/_caracms/preview`, (route) =>
			route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'A render error' }) : route.continue(),
		);
		await page.click('.brow-main >> nth=0');
		// A plain text field (the hero's intro): the lockup's lines render in capitals (text-transform).
		const field = page.locator('[data-pane-level="block"] [data-ff="intro"] textarea');
		const value = await field.inputValue();
		await field.fill(`${value} Broken render.`);
		await page.waitForSelector('.bar-warn', { timeout: 6000 });
		assert.match((await page.textContent('.bar-warn')) ?? '', /Preview not updated/);
		assert.equal(await frameText(), before, 'the last good preview stays');
		await page.click('.bar-warn');
		assert.match((await page.textContent('#pops .pop')) ?? '', /The latest change couldn't be shown/);

		await page.unroute(`${site.origin}/_caracms/preview`);
		await page.click('#pops .pop .btn');
		await eventually(async () => (await frameText()).includes('Broken render.'), 6000, 'the change in the preview');
		assert.equal(await page.isVisible('.bar-warn'), false);
		await page.close();
	});

	test('Decision 13: a caret on the page survives a re-render while focus is in the sidebar', async () => {
		const page = await open('/admin/pages/contact');
		// Put the caret in the desktop iframe's first plain text field: 5 characters into its
		// last line (Contact's intro is two lines, "hello@…<br>+353 1 555 0142").
		const placed = await page.evaluate(() => {
			const doc = document.querySelector<HTMLIFrameElement>('iframe[data-width="1440"]')!.contentDocument!;
			const field = doc.querySelector<HTMLElement>('[data-cms-block] [data-cms-kind="text"]')!;
			const text = field.lastChild!;
			if (text.nodeType !== 3 || !field.querySelector('br')) throw new Error('expected a two-line text field');
			doc.getSelection()!.setBaseAndExtent(text, 5, text, 5);
			return { block: field.closest<HTMLElement>('[data-cms-block]')!.dataset.cmsBlock, field: field.dataset.cmsField, text: field.innerText };
		});
		// Change that same line from the sidebar: the morph rewrites the text node the caret is
		// in, which on its own would put the caret back to the start of the node.
		await page.click(`.brow-main >> nth=${placed.block}`);
		const input = page.locator(`[data-pane-level="block"] [data-field="${placed.field}"] .input`);
		await input.fill(`${await input.inputValue()} More.`);
		await eventually(
			() => page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[data-width="1440"]')!.contentDocument!.body.innerText.includes('More.')),
			6000,
			'the render',
		);
		const caret = await page.evaluate(({ block, field }) => {
			const doc = document.querySelector<HTMLIFrameElement>('iframe[data-width="1440"]')!.contentDocument!;
			const el = doc.querySelector(`[data-cms-block="${block}"] [data-cms-field="${field}"]`)!;
			const s = doc.getSelection()!;
			return { inField: el.contains(s.anchorNode), node: s.anchorNode?.textContent, offset: s.anchorOffset, collapsed: s.isCollapsed };
		}, placed);
		assert.deepEqual(caret, { inField: true, node: '+353 1 555 0142 More.', offset: 5, collapsed: true });
		await page.close();
	});
});
