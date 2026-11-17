// Motion, switched on with no effects (M7 Decisions 20–21; Acceptance 28–31; Exit step 6).
//
// - Acceptance 28: on a public page Locomotive runs (the root has Lenis's class), GSAP with
//   ScrollTrigger is in the page's module, the wheel is smoothed, and nothing has an effect.
// - Acceptance 29: with reduced motion the wheel is native, and a `data-scroll` element still
//   gets `is-inview`.
// - Acceptance 30: in a preview (the editor's preview route, on a dev server in local mode)
//   the wheel is native, and after a redraw adds a `data-scroll` element on screen
//   (`caracms:rendered`, which the editor fires after each morph: the package's browser tests
//   check that), it gets `is-inview` and the frame's scroll position doesn't move.
// - Acceptance 31: the public pages' one module (motion and the menu) ships no React (the
//   built-site test lists every page's scripts).
//
// The starter ships no `data-scroll` element, so the tests' copies add one: a test-only edit
// of Page.astro, as the package's port-site.ts edits its copy.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { buildCopy, client, clientFiles, serveClient, type BuiltCopy } from './helpers/dist.ts';
import { pinnedSite } from './helpers/render.ts';

const BLOCKS = '<Blocks document={document} collection={collection} preview={preview} listPage={listPage} />';

/** A test-only element Locomotive watches, after the page's blocks (below the fold). */
function addScrollElement(root: string) {
	const file = join(root, 'src/components/Page.astro');
	const text = readFileSync(file, 'utf8');
	assert.ok(text.includes(BLOCKS), 'Page.astro renders its blocks as the test expects');
	writeFileSync(file, text.replace(BLOCKS, `${BLOCKS}\n\t\t\t<div data-scroll data-test-scroll class="py-section">Watched by Locomotive</div>`));
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
		});
	});
}

/** Record every class the root element has while the wheel scrolls the page down. */
async function wheelClasses(page: Page): Promise<{ classes: string[]; moved: number }> {
	await page.evaluate(() => {
		const seen = new Set(document.documentElement.classList);
		(window as any).__seen = seen;
		new MutationObserver(() => document.documentElement.classList.forEach((c) => seen.add(c))).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
	});
	const start = await page.evaluate(() => scrollY);
	await page.mouse.move(700, 450);
	for (let i = 0; i < 4; i++) {
		await page.mouse.wheel(0, 300);
		await page.waitForTimeout(60);
	}
	await page.waitForTimeout(1500);
	return page.evaluate((s) => ({ classes: [...(window as any).__seen].sort(), moved: scrollY - s }), start);
}

let browser: Browser;
before(async () => {
	browser = await chromium.launch();
});
after(async () => {
	await browser?.close();
});

describe('on the public pages', () => {
	let watched: BuiltCopy;
	let origin: string;
	let watchedOrigin: string;
	const servers: { close(): void }[] = [];
	before(async () => {
		watched = await buildCopy('motion', addScrollElement);
		for (const dir of [client, watched.client]) {
			const served = await serveClient(dir);
			servers.push(served.server);
			if (dir === client) origin = served.origin;
			else watchedOrigin = served.origin;
		}
	});
	after(() => servers.forEach((s) => s.close()));

	const open = async (url: string, options: { reducedMotion?: 'reduce' | 'no-preference' } = {}) => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: options.reducedMotion ?? 'no-preference' });
		const base = new URL(url).origin;
		await page.route((u) => !u.href.startsWith(base), (route) => route.abort());
		await page.goto(url);
		await page.waitForFunction(() => document.documentElement.classList.contains('lenis'), null, { timeout: 5000 });
		return page;
	};

	test('Acceptance 28, Exit step 6: Home\'s root has Lenis\'s class, GSAP is loaded, and the wheel is smoothed', async () => {
		const page = await open(`${origin}/`);
		assert.ok(await page.evaluate(() => Array.isArray((window as any).gsapVersions) && (window as any).gsapVersions.length > 0), 'GSAP ran');
		const { classes, moved } = await wheelClasses(page);
		assert.ok(classes.includes('lenis-smooth'), `smoothed: ${classes.join(' ')}`);
		assert.ok(moved > 300, `the wheel scrolled (${moved}px)`);
		await page.close();
	});

	test('Acceptance 28: ScrollTrigger is registered in the page\'s one module, which also holds the menu, and ships no React (31)', () => {
		const all = clientFiles().filter((f) => /\.m?js$/.test(f));
		const entry = all.find((f) => /^_astro\/Page\.astro_astro_type_script_/.test(f))!;
		const reached = new Set<string>();
		const visit = (file: string) => {
			if (reached.has(file)) return;
			reached.add(file);
			const text = readFileSync(`${client}/${file}`, 'utf8');
			for (const other of all) if (text.includes(other.slice('_astro/'.length))) visit(other);
		};
		visit(entry);
		const code = [...reached].map((f) => readFileSync(`${client}/${f}`, 'utf8')).join('\n');
		// assert.ok, not match: a failure would print the whole bundle.
		assert.ok(/registerPlugin\(/.test(code), 'GSAP registers a plugin');
		assert.ok(/[`"']ScrollTrigger[`"']/.test(code), 'ScrollTrigger registers itself');
		assert.ok(code.includes('data-nav-group-button') && code.includes('data-menu-button'), 'the menu');
		assert.ok(!/react-dom|react\.production|__SECRET_INTERNALS/.test(code), 'no React');
	});

	test('Acceptance 28: no effects ship: no page has a data-scroll element, and after scrolling Home nothing has a transform or opacity set by motion code', async () => {
		for (const file of clientFiles().filter((f) => f.endsWith('.html'))) {
			assert.ok(!/\sdata-scroll[\s>=]/.test(readFileSync(`${client}/${file}`, 'utf8')), file);
		}
		const page = await open(`${origin}/`);
		await wheelClasses(page);
		const moved = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLElement>('body *')]
				.filter((el) => /(?:^|;)\s*(?:transform|translate|scale|rotate|opacity)\s*:/.test(el.getAttribute('style') ?? ''))
				.map((el) => `${el.tagName} ${el.getAttribute('style')}`),
		);
		assert.deepEqual(moved, []);
		await page.close();
	});

	test('Acceptance 29: with reduced motion, Lenis still runs, the wheel is native, and a data-scroll element gets is-inview when it comes into view', async () => {
		const page = await open(`${watchedOrigin}/`, { reducedMotion: 'reduce' });
		const target = page.locator('[data-test-scroll]');
		assert.equal(await target.evaluate((el) => el.classList.contains('is-inview')), false, 'below the fold at first');
		const { classes, moved } = await wheelClasses(page);
		assert.ok(!classes.includes('lenis-smooth'), `native: ${classes.join(' ')}`);
		assert.ok(moved > 300, `the wheel scrolled (${moved}px)`);
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await page.waitForFunction(() => document.querySelector('[data-test-scroll]')!.classList.contains('is-inview'), null, { timeout: 5000 });
		await page.close();
	});
});

describe('Acceptance 30: in the editor\'s preview', () => {
	const copy = pinnedSite('motion-preview');
	let server: { stop(): Promise<void> } | null = null;
	let origin = '';
	before(async () => {
		process.env.ASTRO_DISABLE_UPDATE_CHECK = 'true';
		for (const name of ['CARACMS_GITHUB', 'CARACMS_MEDIA']) delete process.env[name];
		const { dev } = await import('astro');
		const port = await freePort();
		server = await dev({ root: copy.root, logLevel: 'error', server: { port, host: '127.0.0.1' } });
		origin = `http://127.0.0.1:${port}`;
	});
	after(async () => {
		await server?.stop();
		copy.close();
	});

	test('the wheel is native; a data-scroll element a redraw adds on screen gets is-inview, and the scroll position doesn\'t move', async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		await page.route((u) => !u.href.startsWith(origin), (route) => route.abort());
		await page.goto(`${origin}/_caracms/preview?collection=pages&path=about`);
		assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-preview')), true, 'a preview render');
		await page.waitForFunction(() => document.documentElement.classList.contains('lenis'), null, { timeout: 15000 });

		const { classes, moved } = await wheelClasses(page);
		assert.ok(!classes.includes('lenis-smooth'), `native: ${classes.join(' ')}`);
		assert.ok(moved > 300, `the wheel scrolled (${moved}px)`);

		// A morph's result: a new data-scroll element on screen, then the editor's event.
		const before = await page.evaluate(() => {
			const y = scrollY;
			const under = document.elementFromPoint(700, 300)!.closest('main > *')!;
			const added = document.createElement('div');
			added.setAttribute('data-scroll', '');
			added.id = 'added-by-a-morph';
			added.textContent = 'Added by a redraw';
			under.before(added);
			window.scrollTo(0, y);
			document.dispatchEvent(new Event('caracms:rendered'));
			return y;
		});
		await page.waitForFunction(() => document.getElementById('added-by-a-morph')!.classList.contains('is-inview'), null, { timeout: 5000 });
		await page.waitForTimeout(300);
		assert.equal(await page.evaluate(() => scrollY), before, 'the frame didn\'t jump');
		await page.close();
	});
});
