// Two more rules that need a browser, on a throwaway copy of the demo under `astro dev`
// (helpers/dev-site.ts); headless Chromium from Playwright's cache, skipped without it.
//
//   Watch-out "never morph <head>" (M1 → E2): a re-render replaces the body only, so
//     stylesheets and fonts don't refetch and the preview doesn't flicker.
//   Decision 12: a select field is edited in the sidebar and reaches the file as the
//     schema's value, changing only its own line.
//   On-page rich text, Decision 6: a morph while the body is typed on the page, with
//     focus in the iframe and in /admin, leaves the page editor alone; a render that
//     pairs it with the wrong node (a same-tag sibling before it) tears it down and
//     remounts it: one field, the right text.
//
//   node --test --experimental-strip-types test/morph-and-select.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { caretSettled, charPoint, fieldState, revealBody, sameNodes, tagNodes } from './helpers/rich-on-page.ts';

let site: DevSite;
let browser: Browser;
const HOME = 'content/pages/index.json';
const block = '[data-pane-level="block"]';

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

async function openHero(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(`${site.origin}/admin`);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
	await page.frameLocator('.frame.on iframe').locator('[data-cms-block="0"] [data-cms-kind="lockup"]').click();
	await page.waitForSelector(`${block} [data-ff="heading"] input[data-line="0"]`);
	return page;
}

describe('the preview and the fields, in a browser', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('morph-select');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('a re-render morphs the body and never the head: same nodes, no new requests', async () => {
		const page = await openHero();
		// Mark every node in each iframe's head, and note the requests it has made so far.
		const before = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => {
				const doc = f.contentDocument!;
				const nodes = [...doc.head.children];
				nodes.forEach((n, i) => ((n as any).__probe = i + 1));
				return { nodes: nodes.length, requests: f.contentWindow!.performance.getEntriesByType('resource').length };
			}),
		);
		assert.ok(before.every((b) => b.nodes > 0), 'every preview has a head');

		// Change the hero's heading three times (three renders), watching the body change each time.
		const first = page.locator(`${block} [data-ff="heading"] input[data-line="0"]`);
		await first.focus();
		await first.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));
		for (const letter of ['x', 'y', 'z']) {
			await page.keyboard.type(letter);
			await eventually(
				() =>
					page.evaluate(
						(letter) => [...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].every((f) => f.contentDocument!.querySelector('[data-cms-block="0"] .cms-lockup-line')?.textContent?.endsWith(letter)),
						letter,
					),
				6000,
				`the render with ${letter}`,
			);
		}

		const after = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => {
				const nodes = [...f.contentDocument!.head.children];
				return { nodes: nodes.length, probes: nodes.map((n) => (n as any).__probe ?? 0), requests: f.contentWindow!.performance.getEntriesByType('resource').length };
			}),
		);
		after.forEach((a, i) => {
			assert.equal(a.nodes, before[i]!.nodes, `iframe ${i}: the head has the same number of nodes`);
			assert.deepEqual(a.probes, a.probes.map((_, j) => j + 1), `iframe ${i}: every head node is the one that was there`);
			assert.equal(a.requests, before[i]!.requests, `iframe ${i}: no stylesheet or font was fetched again`);
		});
		await page.close();
	});

	test('Decision 12: a select field reaches the file as the schema\'s value, changing only its own line', async () => {
		const page = await openHero();
		const before = site.read(HOME).split('\n');
		await page.selectOption(`${block} [data-ff="layout"] select`, 'centre');
		await eventually(() => JSON.parse(site.read(HOME)).blocks[0].layout === 'centre', 6000, 'the layout in the file');
		const after = site.read(HOME).split('\n');
		assert.equal(after.length, before.length);
		const changed = before.map((l, i) => (l !== after[i] ? after[i] : null)).filter(Boolean);
		assert.deepEqual(changed, ['      "layout": "centre",']);
		// And back: the file is byte for byte what it was.
		const original = before.join('\n');
		await page.selectOption(`${block} [data-ff="layout"] select`, 'left');
		await eventually(() => site.read(HOME) === original, 6000, 'the file back as it was');
		await page.close();
	});
	/** Home with the pointer resting on the Text block's body and the caret in it after "Most of our " (the page editor mounted, typing). */
	async function typingBody(): Promise<{ page: Page; at: { x: number; y: number } }> {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.on('pageerror', (error) => console.error('[page]', error.message));
		await page.goto(`${site.origin}/admin`);
		await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
		await revealBody(page);
		const at = await charPoint(page, 'clients');
		await page.mouse.move(at.x, at.y);
		await page.mouse.click(at.x, at.y);
		await page.waitForSelector(`${block} .field-frame.is-picked[data-ff="body"]`, { timeout: 5000 }).catch(async (e) => {
			console.log('DEBUG', JSON.stringify(at), JSON.stringify(await fieldState(page)), await page.evaluate(() => document.querySelector('[data-pane-level="block"]')?.outerHTML.slice(0, 300)));
			throw e;
		});
		await eventually(async () => (await fieldState(page)).focused, 4000, 'the body focused on the page');
		return { page, at };
	}
	const headingInput = `${block} [data-ff="heading"] input`;
	const renderedHeading = (page: Page) => page.frameLocator('.frame.on iframe').locator('[data-cms-block="1"] [data-cms-field="heading"]').textContent();
	/** Focus the sidebar's Heading (without moving the pointer off the page) and type at its end. */
	async function typeHeading(page: Page, text: string) {
		await page.focus(headingInput);
		await page.keyboard.press('End');
		await page.keyboard.type(text);
	}

	test('on-page rich text: a morph with focus in /admin leaves the page editor\'s DOM and selection alone', async () => {
		const { page } = await typingBody();
		const selection = (await fieldState(page)).selection;
		await tagNodes(page);
		await typeHeading(page, ' A');
		await eventually(async () => / A$/.test((await renderedHeading(page)) ?? ''), 6000, 'the render');
		const after = await fieldState(page);
		assert.equal(after.mounted, true, 'still mounted: the pointer rests on it');
		assert.equal(await sameNodes(page), true, 'the very same nodes');
		assert.deepEqual(after.selection, selection, 'the same selection');
		assert.equal(after.count, 1);
		await page.close();
	});

	test('on-page rich text: a render that lands while typing on the page leaves the editor alone and re-applies the text in the other widths', async () => {
		const { page, at } = await typingBody();
		// Hold every render for a while: the one asked for now lands after typing on the page has gone on.
		await page.route(`${site.origin}/_caracms/preview`, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			await new Promise((r) => setTimeout(r, 1200));
			await route.fulfill({ response: await route.fetch() });
		});
		await typeHeading(page, ' B');
		await page.mouse.click(at.x, at.y);
		await eventually(async () => (await fieldState(page)).focused, 4000, 'focus back on the page');
		await page.keyboard.type('happy ');
		const el = await tagNodes(page);
		assert.ok(el > 0);
		const selection = (await fieldState(page)).selection;
		await eventually(async () => / B$/.test((await renderedHeading(page)) ?? ''), 8000, 'the slow render');
		const after = await fieldState(page);
		assert.equal(after.mounted, true);
		assert.equal(after.focused, true, 'focus stays in the editor');
		assert.equal(await sameNodes(page), true, 'the very same nodes');
		assert.deepEqual(after.selection, selection, 'the caret where it was');
		assert.match(after.html, /Most of our happy clients/);
		// The render predates "happy ": the other widths get it back.
		for (const width of [768, 375]) assert.match((await fieldState(page, width)).html, /Most of our happy clients/, `the ${width} iframe`);
		await page.unrouteAll({ behavior: 'ignoreErrors' });
		await page.close();
	});

	test('on-page rich text: a render that changes the mounted field\'s own attributes is what teardown leaves, not the mount-time ones', async () => {
		const { page } = await typingBody();
		await page.keyboard.press('Escape');
		await page.route(`${site.origin}/_caracms/preview`, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			const response = await route.fetch();
			// What a site's class that depends on another field does: the field's own element differs in the render.
			const html = (await response.text()).replace(/(<div[^>]*data-cms-field="body")/, '$1 data-extra="x"');
			await route.fulfill({ response, body: html });
		});
		await tagNodes(page);
		await typeHeading(page, ' E');
		await eventually(async () => / E$/.test((await renderedHeading(page)) ?? ''), 8000, 'the render');
		const during = await fieldState(page);
		assert.equal(during.mounted, true, 'still mounted: the morph paired it with its own field and left it');
		assert.equal(await sameNodes(page), true, 'the very same nodes');
		// The pointer leaves: the editor goes, and the element is the render's, attribute and all.
		await page.mouse.move(5, 5);
		await eventually(async () => !(await fieldState(page)).mounted, 4000, 'torn down');
		const left = await fieldState(page);
		assert.match(left.outer, /data-extra="x"/, left.outer);
		assert.doesNotMatch(left.outer, /ProseMirror|tiptap|contenteditable|translate|role=/, left.outer);
		// The tablet's copy was morphed into the same render (idiomorph appends a new attribute, so only the order may differ).
		const attributes = (outer: string) => [...outer.match(/^<div([^>]*)>/)![1]!.matchAll(/ ([\w-]+="[^"]*")/g)].map((m) => m[1]).sort();
		assert.deepEqual(attributes(left.outer), attributes((await fieldState(page, 768)).outer), 'the same attributes as the tablet\'s');
		await page.unrouteAll({ behavior: 'ignoreErrors' });
		await page.close();
	});

	test('on-page rich text: a render that pairs the editor with a same-tag sibling tears it down and remounts it: one field, the right text', async () => {
		for (const focus of ['admin', 'iframe'] as const) {
			const { page, at } = await typingBody();
			await page.keyboard.type('glad ');
			await page.route(`${site.origin}/_caracms/preview`, async (route) => {
				if (route.request().method() !== 'POST') return route.continue();
				if (focus === 'iframe') await new Promise((r) => setTimeout(r, 1200));
				const response = await route.fetch();
				const html = (await response.text()).replace(/(<div[^>]*data-cms-field="body")/, '<div class="sibling">Sibling</div>$1');
				await route.fulfill({ response, body: html });
			});
			await typeHeading(page, focus === 'admin' ? ' C' : ' D');
			if (focus === 'iframe') {
				await page.mouse.click(at.x, at.y);
				await eventually(async () => (await fieldState(page)).focused, 4000, 'focus back on the page');
				await caretSettled(page); // ProseMirror reads the click's caret on mouseup / selectionchange
			}
			const selection = (await fieldState(page)).selection;
			await eventually(async () => new RegExp(` ${focus === 'admin' ? 'C' : 'D'}$`).test((await renderedHeading(page)) ?? ''), 8000, 'the render');
			await eventually(async () => (await fieldState(page)).mounted, 4000, `${focus}: remounted after the morph`).catch(async (e) => {
				console.log('DEBUG2', focus, await page.frameLocator('.frame.on iframe').locator('[data-cms-block="1"]').innerHTML());
				throw e;
			});
			const after = await fieldState(page);
			assert.equal(after.count, 1, `${focus}: one body field on the page`);
			assert.match(after.html, /glad clients/, `${focus}: the field holds the typed text`);
			assert.equal(await page.frameLocator('.frame.on iframe').locator('[data-cms-block="1"] .sibling + [data-cms-field="body"]').count(), 1, `${focus}: the sibling came in before it`);
			if (focus === 'iframe') {
				assert.equal(after.focused, true, 'focus is back in the remounted editor');
				assert.deepEqual(after.selection, selection, 'with its selection');
			}
			await page.unrouteAll({ behavior: 'ignoreErrors' });
			await page.close();
		}
	});
});
