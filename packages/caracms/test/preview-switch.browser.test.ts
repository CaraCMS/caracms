// M8 trial, item 8 (the M8 trial's findings): switching to another document in
// the editor loads the preview frames afresh, so that page's own module scripts run; edits
// within a document are still morphed (the frame's window stays). On a throwaway copy of the
// demo under `astro dev` (helpers/dev-site.ts) whose About page has a block with a module
// script that marks the DOM; Home doesn't have it. Headless Chromium, skipped without it.
//
//   node --test --experimental-strip-types test/preview-switch.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

const MARKER = `---
import Block from 'caracms/components/Block.astro';
const { cms } = Astro.props;
---

<Block cms={cms} as="div" class="switch-marker"><p>Marked by its script</p></Block>

<script>
	// A module script (Astro's default): it runs once per load of a page that has this block.
	for (const el of document.querySelectorAll('.switch-marker')) el.setAttribute('data-script-ran', 'yes');
	(window as any).__markerRuns = ((window as any).__markerRuns ?? 0) + 1;
</script>
`;

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

/** Each frame's state: which page, whether the marker's script ran there, and a tag set on its window. */
const frames = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => ({
			path: new URLSearchParams(f.contentWindow!.location.search).get('path'),
			marker: f.contentDocument!.querySelector('.switch-marker')?.getAttribute('data-script-ran') ?? null,
			runs: (f.contentWindow as any).__markerRuns ?? 0,
			tag: (f.contentWindow as any).__tag ?? null,
		})),
	);
const tagWindows = (page: Page, tag: string) =>
	page.evaluate((tag) => {
		for (const f of document.querySelectorAll<HTMLIFrameElement>('#stage iframe')) (f.contentWindow as any).__tag = tag;
	}, tag);

describe('switching documents loads the preview afresh (trial item 8)', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('preview-switch', {
			edit: (root) => {
				writeFileSync(join(root, 'src/blocks/Marker.astro'), MARKER);
				const config = join(root, 'caracms.config.ts');
				writeFileSync(config, readFileSync(config, 'utf8').replace('\tblocks: {\n', "\tblocks: {\n\t\tmarker: { component: 'src/blocks/Marker.astro', fields: {} },\n"));
				const about = join(root, 'content/pages/about.json');
				const doc = JSON.parse(readFileSync(about, 'utf8'));
				doc.blocks.splice(1, 0, { type: 'marker' });
				writeFileSync(about, `${JSON.stringify(doc, null, 2)}\n`);
			},
		});
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test("About opened second runs its own module script; an edit there morphs; Home again loads afresh", async () => {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.on('pageerror', (error) => console.error('[page]', error.message));
		await page.goto(`${site.origin}/admin`);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		const home = await frames(page);
		assert.equal(home.length, 3);
		assert.ok(home.every((f) => f.marker === null && f.runs === 0), JSON.stringify(home));
		await tagWindows(page, 'home');

		// Open About from the header's link in the preview (as an editor would).
		await page.frameLocator('.frame.on iframe').locator('header.site-header nav a[href="/about"]').click();
		await eventually(async () => (await frames(page)).every((f) => f.path === 'about' && f.marker === 'yes'), 10000, "About's marker set by its own script in every frame");
		const about = await frames(page);
		for (const [i, f] of about.entries()) {
			assert.equal(f.tag, null, `frame ${i}: a fresh window, not Home's`);
			assert.equal(f.runs, 1, `frame ${i}: the script ran once`);
		}
		// The editor's own state follows: the sidebar is on About, the preview not marked as opening.
		await eventually(async () => (await page.textContent('[data-pane-level="document"]'))?.includes('About'), 6000, 'the sidebar on About');

		// An edit within About is morphed in: the same windows, the script not run again.
		await tagWindows(page, 'about');
		await page.frameLocator('.frame.on iframe').locator('[data-cms-block="0"] [data-cms-kind="lockup"]').click();
		const heading = '[data-pane-level="block"] [data-ff="heading"] input[data-line="0"]';
		await page.waitForSelector(heading);
		const input = page.locator(heading);
		await input.focus();
		await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));
		await page.keyboard.type('q');
		await eventually(
			() =>
				page.evaluate(() =>
					[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].every((f) => f.contentDocument!.querySelector('[data-cms-block="0"] .cms-lockup-line')?.textContent?.endsWith('q')),
				),
			8000,
			'the edit morphed into every frame',
		);
		const edited = await frames(page);
		for (const [i, f] of edited.entries()) {
			assert.equal(f.tag, 'about', `frame ${i}: morphed, not reloaded`);
			assert.equal(f.runs, 1, `frame ${i}: the script didn't run again`);
		}

		// Back to Home: loaded afresh again (About's window, and its script's work, gone).
		await page.goBack();
		await eventually(async () => (await frames(page)).every((f) => f.path === 'index' && f.tag === null), 10000, 'Home loaded afresh in every frame');
		assert.ok((await frames(page)).every((f) => f.marker === null && f.runs === 0));
		await page.close();
	});
});
