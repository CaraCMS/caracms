// The editor on a site with @astrojs/react, under `astro dev` (found porting a client site, 0.13.3).
// @astrojs/react hands @vitejs/plugin-react an `exclude` of its own, which replaces the plugin's
// node_modules exclude, so in dev Fast Refresh instruments every module /admin loads, react-dom's
// pre-bundled chunk included. Astro adds the refresh preamble only to pages that render an island;
// /admin now loads the site's before-hydration scripts first (routes/admin.astro). Before that the
// editor died on "$RefreshSig$ is not defined" and the preview never showed.
//
// Runs test/fixtures/island-site (a React header in its slot's <Block> root) through its own
// astro.config.mjs. Headless Chromium from Playwright's cache, skipped without it.
//
//   node --test --experimental-strip-types test/admin-react.browser.test.ts
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { browserSkip, packageRoot } from './helpers/dev-site.ts';

const root = join(packageRoot, 'test/.tmp', `admin-react-${process.pid}`);
let server: { stop(): Promise<void> } | null = null;
let origin: string;
let browser: Browser;

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.on('error', reject);
		s.listen(0, '127.0.0.1', () => {
			const address = s.address();
			s.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
		});
	});
}

describe('the editor on a site with @astrojs/react, in dev', { skip: browserSkip }, () => {
	before(async () => {
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		cpSync(join(packageRoot, 'test/fixtures/island-site'), root, { recursive: true });
		mkdirSync(join(root, 'node_modules'));
		symlinkSync(packageRoot, join(root, 'node_modules/caracms'), 'dir');
		// React named as a dependency, as on any React site: Astro reads it to bundle the renderer.
		const pkg = { name: 'island-site', private: true, type: 'module', dependencies: { '@astrojs/react': '*', react: '*', 'react-dom': '*' } };
		writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
		process.env.ASTRO_DISABLE_UPDATE_CHECK = 'true';
		const { dev } = await import('astro');
		const port = await freePort();
		server = await dev({ root, logLevel: 'error', server: { port, host: '127.0.0.1' }, vite: { server: { strictPort: true }, logLevel: 'error' } });
		origin = `http://127.0.0.1:${port}`;
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await server?.stop();
		rmSync(root, { recursive: true, force: true });
	});

	test('/admin hydrates with no errors and the preview pane shows; a click on the React header opens the Header', async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text());
		});
		await page.goto(`${origin}/admin`);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 30000 });
		// The pane fades in once the preview is painted: the visible frame and everything above it opaque.
		const opacity = () =>
			page.evaluate(() => {
				let el: Element | null = document.querySelector('.frame.on iframe');
				let min = el ? 1 : 0;
				for (; el; el = el.parentElement) min = Math.min(min, parseFloat(getComputedStyle(el).opacity));
				return min;
			});
		const end = Date.now() + 15000;
		while ((await opacity()) < 1 && Date.now() < end) await page.waitForTimeout(100);
		assert.equal(await opacity(), 1, 'the preview pane shows');
		assert.equal(await page.evaluate(() => typeof (window as unknown as { $RefreshSig$?: unknown }).$RefreshSig$), 'function', 'the refresh preamble ran');

		// The header island's menu button, drawn by React inside the slot's root.
		await page.frameLocator('.frame.on iframe').locator('[data-cms-source="shared/header"] button', { hasText: 'Open the menu' }).click();
		const opened = Date.now() + 10000;
		while (new URL(page.url()).pathname !== '/admin/shared/header' && Date.now() < opened) await page.waitForTimeout(100);
		assert.equal(new URL(page.url()).pathname, '/admin/shared/header');
		assert.deepEqual(errors, []);
	});
});
