// Edit in context, the editor's side (carrier B): a click on
// what the page shows opens the document it lives in over the page. On the fixture (helpers/dev-site.ts):
// its footer fills the page's footer slot (shared/footer, the default), its header is code (Decision 13's
// site), Home's Cases cards are marked as their case studies and its heading without its value (18b),
// and the journal's post draws its page fields (18a). Headless Chromium from Playwright's cache,
// skipped without it.
//
//   node --test --experimental-strip-types test/edit-in-context.browser.test.ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { AOIFE, CIARAN, keepState, openAdmin, signedIn, startLiveSite, type LiveSite } from './helpers/live-site.ts';

let site: DevSite;
let browser: Browser;

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
const pathname = (page: Page) => new URL(page.url()).pathname;
const DOC = '[data-pane-level="document"]';
const SUB = `${DOC} .cur .sub`;
/** Evaluate in the visible frame's document. */
const inFrame = <T>(page: Page, fn: (doc: Document) => T) =>
	page.evaluate(`(${fn.toString()})(document.querySelector('.frame.on iframe').contentDocument)`) as Promise<T>;
/** Evaluate in another width's frame. */
const inWidth = <T>(page: Page, width: string, fn: (doc: Document) => T) =>
	page.evaluate(`(${fn.toString()})(document.querySelector('#stage .frame[data-w="${width}"] iframe').contentDocument)`) as Promise<T>;
/** The open document's head says it's over Home. */
const overHome = (page: Page) => eventually(async () => /open over Home/.test((await page.textContent(SUB).catch(() => '')) ?? ''), 8000, '"open over Home"');

describe('edit in context: the editor', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('edit-in-context');
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('Acceptance 8: one click on the slot footer\'s address opens the Footer over Home, the caret there; typing mirrors', async () => {
		const page = await open('/admin');
		const address = frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-address');
		await address.click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, '/admin/shared/footer');
		await overHome(page);
		await page.waitForSelector(`${DOC} .field-frame.is-picked[data-ff="address"]`);
		// The stage never dims (Decision 9), and the caret is where the click landed.
		assert.equal(await page.locator('#stage.is-aside').count(), 0);
		assert.equal(await inFrame(page, (d) => d.activeElement?.classList.contains('footer-address') ?? false), true);
		await page.keyboard.press('End');
		await page.keyboard.type(' QX');
		await eventually(async () => /QX/.test(await page.inputValue(`${DOC} [data-ff="address"] textarea, ${DOC} [data-ff="address"] input`)), 8000, 'the sidebar follows');
		await eventually(() => inWidth(page, 'tablet', (d) => /QX/.test(d.querySelector('.footer-address')?.textContent ?? '')), 8000, 'the tablet mirrors it');
		// The faint ring round what the Footer draws.
		await eventually(() => inFrame(page, (d) => !!d.querySelector('#cms-overlays [data-mark="open"]')), 8000, 'the open ring');
		await page.close();
	});

	test('Acceptance 11: a click on the footer outside any field opens it at its form\'s top', async () => {
		const page = await open('/admin');
		await frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-name').click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, '/admin/shared/footer');
		await overHome(page);
		assert.equal(await page.locator(`${DOC} .field-frame.is-picked`).count(), 0);
		// The head names the document's kind beside its title (the mockup's #footer-top).
		assert.equal((await page.textContent(`${DOC} .cur .t .chip.shared`))?.trim(), 'Shared');
		await page.close();
	});

	test('Decision 10: the email, marked without its value, is picked with its control focused; nothing typed on the page', async () => {
		const page = await open('/admin');
		const email = frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-email');
		assert.equal(await email.getAttribute('contenteditable'), null);
		const before = await email.innerHTML();
		await email.click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, 'the Footer opens');
		await page.waitForSelector(`${DOC} .field-frame.is-picked[data-ff="email"]`);
		await eventually(() => page.evaluate(() => !!document.activeElement?.closest('[data-ff="email"]')), 8000, 'its control focused');
		await page.keyboard.type('x');
		await eventually(async () => (await page.inputValue(`${DOC} [data-ff="email"] input`)).endsWith('x'), 8000, 'typed in the sidebar');
		// The page's own markup is left alone: a render may change the address, never the shape.
		await eventually(async () => (await email.innerHTML()) !== before, 8000, 'the render shows it');
		assert.equal(await email.locator('*').count(), 0);
		await page.close();
	});

	test('Acceptance 13: Back (Esc) from the Footer returns to Home with the block selected before', async () => {
		const page = await open('/admin');
		await page.click('.brow-main >> nth=0');
		await page.waitForSelector('[data-pane-level="block"]');
		await frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-name').click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, 'the Footer opens');
		await overHome(page);
		await page.keyboard.press('Escape');
		await eventually(() => pathname(page) === '/admin', 8000, 'back on Home');
		await page.waitForSelector('[data-pane-level="block"]');
		await eventually(() => inFrame(page, (d) => !!d.querySelector('#cms-overlays [data-mark="selected"][data-block="0"]')), 8000, 'the hero selected again');
		await page.close();
	});

	test('Back right after typing in the Footer: Home\'s first render already shows what was typed', async () => {
		const page = await open('/admin');
		const address = frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-address');
		await address.click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, '/admin/shared/footer');
		await overHome(page);
		await page.keyboard.press('End');
		await page.keyboard.type(' ZZBACK');
		// Esc leaves the field, then the picked field for the form's top, then goes back: pressed at once, no wait between.
		for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
		await eventually(() => pathname(page) === '/admin', 8000, 'back on Home');
		await eventually(() => inFrame(page, (d) => /ZZBACK/.test(d.querySelector('footer .footer-address')?.textContent ?? '')), 8000, 'Home\'s footer shows the typed text');
		await page.close();
	});

	test('the faint ring round an open full-width footer stays inside every frame, scrollbars drawn or not', async () => {
		// Headless Chromium hides scrollbars; a person's browser may draw them, which makes the footer narrower than the window.
		for (const classic of [false, true]) {
			const own = classic ? await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] }) : browser;
			try {
				const page = await own.newPage({ viewport: { width: 1440, height: 900 } });
				await page.goto(site.origin + '/admin');
				await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
				await frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-name').click();
				await eventually(() => pathname(page) === '/admin/shared/footer', 8000, '/admin/shared/footer');
				await overHome(page);
				for (const width of ['desktop', 'tablet', 'phone']) {
					if (!(await page.locator(`#stage .frame[data-w="${width}"] iframe`).count())) continue;
					await eventually(() => inWidth(page, width, (d) => !!d.querySelector('#cms-overlays [data-mark="open"]')), 8000, `the open ring at ${width}`);
					const m = await inWidth(page, width, (d) => {
						const ring = d.querySelector('#cms-overlays [data-mark="open"]')!.getBoundingClientRect();
						const root = d.documentElement;
						return { scroll: root.scrollWidth, client: root.clientWidth, right: ring.right, left: ring.left };
					});
					const what = `${classic ? 'with' : 'without'} scrollbars, ${width}`;
					assert.ok(m.scroll <= m.client, `${what}: scrollWidth ${m.scroll} <= clientWidth ${m.client}`);
					assert.ok(m.left >= 0 && m.right <= m.client, `${what}: the ring sits inside the frame (${m.left}..${m.right} of ${m.client})`);
				}
				await page.close();
			} finally {
				if (classic) await own.close();
			}
		}
	});

	test('Acceptance 14: over Home, the page isn\'t typed in; its block goes back with it picked; a card replaces the Footer', async () => {
		const page = await open('/admin');
		await frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-name').click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, 'the Footer opens');
		await overHome(page);
		// Typing on the page's own text is refused while the Footer is open over it.
		const refused = await inFrame(page, (d) => {
			const el = d.querySelector('[data-cms-block="0"] [data-cms-kind="text"]');
			if (!el) return null;
			const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'Z' });
			el.dispatchEvent(event);
			return event.defaultPrevented;
		});
		assert.equal(refused, true);
		// A case study card replaces the Footer (no stack), still over Home.
		await frameOn(page).locator('[data-cms-block="3"] [data-cms-source^="case-studies/"] b').first().click();
		await eventually(() => pathname(page).startsWith('/admin/case-studies/'), 8000, 'the case study opens');
		await overHome(page);
		assert.match((await page.textContent(`${DOC} .cur .t .chip.kind`)) ?? '', /case study/i);
		// A click on Home's hero heading goes back to Home with that field picked.
		await frameOn(page).locator('[data-cms-block="0"] [data-cms-kind="text"]').first().click();
		await eventually(() => pathname(page) === '/admin', 8000, 'back on Home');
		await page.waitForSelector('[data-pane-level="block"] .field-frame.is-picked');
		await page.close();
	});

	test('Acceptance 15: an edit not yet kept still shows once the Footer is open over the page', async () => {
		const page = await open('/admin');
		const heading = frameOn(page).locator('[data-cms-block="0"] [data-cms-kind="text"]').first();
		await heading.click();
		await page.keyboard.press('End');
		await page.keyboard.type(' ZQW');
		await frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-name').click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, 'the Footer opens');
		await eventually(() => inFrame(page, (d) => !!d.querySelector('#cms-overlays [data-mark="open"]')), 8000, 'over Home');
		// After the overlay's render too.
		await page.waitForTimeout(800);
		assert.match((await heading.textContent()) ?? '', /ZQW/);
		await page.close();
	});

	test('Acceptance 16: Site Settings from the documents list keeps the last page, undimmed', async () => {
		const page = await open('/admin/pages/about');
		await page.keyboard.press('Escape');
		await page.click('[data-pane-level="documents"] [data-section="site-wide"] [data-doc="settings/site-settings"]');
		await eventually(() => pathname(page) === '/admin/settings', 8000, '/admin/settings');
		await eventually(async () => /open over About/.test((await page.textContent(SUB)) ?? ''), 8000, '"open over About"');
		assert.equal(await page.locator('#stage.is-aside').count(), 0);
		await page.close();
	});

	test('Acceptance 18b: the Cases heading, marked without its value: one click picks Heading with its control focused', async () => {
		const page = await open('/admin');
		const heading = frameOn(page).locator('[data-cms-block="3"] .cases-heading');
		assert.equal(await heading.getAttribute('contenteditable'), null);
		await heading.click();
		await page.waitForSelector('[data-pane-level="block"] .field-frame.is-picked[data-ff="heading"]');
		await eventually(() => page.evaluate(() => !!document.activeElement?.closest('[data-ff="heading"]')), 8000, 'its control focused');
		await page.keyboard.type('!');
		await eventually(async () => /!/.test((await heading.textContent()) ?? ''), 8000, 'the render shows it');
		assert.equal(await heading.locator('> span').count(), 1);
		await page.close();
	});

	test('Acceptance 19: a card in an unselected block selects it; then its one chip opens it over Home', async () => {
		const page = await open('/admin');
		const card = frameOn(page).locator('[data-cms-block="3"] [data-cms-source^="case-studies/"]').first();
		await card.locator('b').click();
		await page.waitForSelector('[data-pane-level="block"]');
		assert.equal(pathname(page), '/admin');
		await card.locator('b').hover();
		const chip = await eventually(() => inFrame(page, (d) => d.querySelector('#cms-overlays .cms-go[data-go="source"]')?.textContent ?? null), 8000, 'the chip');
		assert.match(chip!, /^Edit .+ →$/);
		assert.equal(await inFrame(page, (d) => d.querySelectorAll('#cms-overlays .cms-go').length), 1);
		await card.locator('b').click();
		await eventually(() => pathname(page).startsWith('/admin/case-studies/'), 8000, 'the case study opens');
		await overHome(page);
		assert.match((await page.textContent(`${DOC} .cur .t .chip.kind`)) ?? '', /case study/i);
		await page.close();
	});

	test('Acceptance 18a: a journal post\'s page fields: one click on the kicker, typing mirrors; Footer over it goes back with it picked', async () => {
		const page = await open('/admin/journal/notes-from-the-ridge');
		const kicker = frameOn(page).locator('[data-cms-page][data-cms-field="kicker"]');
		await kicker.click();
		await page.waitForSelector(`${DOC} [data-page-fields] .field-frame.is-picked[data-ff="kicker"]`);
		assert.equal(await inFrame(page, (d) => d.activeElement?.getAttribute('data-cms-field') ?? null), 'kicker');
		await page.keyboard.press('End');
		await page.keyboard.type('K9');
		await eventually(async () => /K9/.test(await page.inputValue(`${DOC} [data-page-fields] [data-ff="kicker"] input`)), 8000, 'the sidebar follows');
		await eventually(() => inWidth(page, 'phone', (d) => /K9/.test(d.querySelector('[data-cms-field="kicker"]')?.textContent ?? '')), 8000, 'the phone mirrors it');
		// The credit, marked without its value: picked, its control focused.
		await frameOn(page).locator('[data-cms-page][data-cms-field="credit"]').click();
		await page.waitForSelector(`${DOC} [data-page-fields] .field-frame.is-picked[data-ff="credit"]`);
		// The Footer over the post, then the kicker: back to the post with it picked.
		await frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-name').click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, 'the Footer opens');
		await kicker.click();
		await eventually(() => pathname(page) === '/admin/journal/notes-from-the-ridge', 8000, 'back on the post');
		await page.waitForSelector(`${DOC} [data-page-fields] .field-frame.is-picked[data-ff="kicker"]`);
		await page.close();
	});

	test('Acceptance 20: a click on the code header shows "Edited elsewhere", which opens Site Settings over the page', async () => {
		const page = await open('/admin');
		await frameOn(page).locator('header.site-header').click({ position: { x: 4, y: 4 } });
		const chip = frameOn(page).locator('#cms-overlays .cms-go[data-go="elsewhere"]');
		await chip.waitFor();
		assert.equal(await chip.textContent(), 'Edited elsewhere: open Site Settings →');
		await chip.click();
		await eventually(() => pathname(page) === '/admin/settings', 8000, '/admin/settings');
		await overHome(page);
		await page.close();
	});

	test('Acceptance 20: the "Edited elsewhere" chip stays inside the frame for a click near its right edge, at every width, scrollbars drawn or not', async () => {
		// An element at the frame's right edge inside the code header stands for a footer column on a real site.
		for (const classic of [false, true]) {
			const own = classic ? await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] }) : browser;
			try {
				const page = await own.newPage({ viewport: { width: 1440, height: 900 } });
				await page.goto(site.origin + '/admin');
				await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
				for (const width of ['desktop', 'tablet', 'phone']) {
					const what = `${classic ? 'with' : 'without'} scrollbars, ${width}`;
					if (width !== 'desktop') await page.click(`#bar [role="radio"][data-width="${width}"]`);
					await page.waitForSelector(`#stage .frame.on[data-w="${width}"]`);
					await inWidth(page, width, (d) => {
						d.querySelector('#edge-probe')?.remove();
						const probe = d.createElement('span');
						probe.id = 'edge-probe';
												probe.setAttribute('style', 'position:absolute;top:8px;right:0;width:40px;height:20px;overflow:hidden;font-size:10px');
						d.querySelector('header.site-header')!.appendChild(probe);
					});
					await frameOn(page).locator('#edge-probe').click({ position: { x: 14, y: 10 } });
					const chip = frameOn(page).locator('#cms-overlays .cms-go[data-go="elsewhere"]');
					await chip.waitFor();
					const m = await inWidth(page, width, (d) => {
						const box = d.querySelector('#cms-overlays .cms-go[data-go="elsewhere"]')!.getBoundingClientRect();
						const root = d.documentElement;
						return { scroll: root.scrollWidth, client: root.clientWidth, left: box.left, right: box.right, probe: d.querySelector('#edge-probe')!.getBoundingClientRect().left };
					});
					assert.ok(m.probe > m.client - 60, `${what}: the click was at the right edge (${m.probe} of ${m.client})`);
					assert.ok(m.left >= 0 && m.right <= m.client, `${what}: the chip sits inside the frame (${m.left}..${m.right} of ${m.client})`);
					assert.ok(m.scroll <= m.client, `${what}: scrollWidth ${m.scroll} <= clientWidth ${m.client}`);
				}
				await page.close();
			} finally {
				if (classic) await own.close();
			}
		}
	});
});

describe('edit in context: live mode (Decision 14)', { skip: browserSkip }, () => {
	let live: LiveSite;
	let liveBrowser: Browser;
	before(async () => {
		live = await startLiveSite('edit-in-context-live', { CARACMS_TIMINGS: JSON.stringify({ sweepIdleMs: 1500, sweepTickMs: 500, sweepCapMs: 10_000, lockLapseMs: 60_000, mainCheckMs: 1000, historyMs: 500, deploymentReadMs: 500, pollMs: 1000 }) });
		liveBrowser = await chromium.launch();
	});
	after(async () => {
		await liveBrowser?.close();
		await live?.close();
	});

	test('Acceptance 21: the Footer someone else holds opens read-only over the page, no veil, its chip says who', async () => {
		const { site } = live;
		// Aoife edits the Footer: she holds its lock.
		const a = await openAdmin(await signedIn(liveBrowser, site, AOIFE), site, '/admin/shared/footer');
		await a.fill(`${DOC} [data-ff="address"] textarea`, 'Unit 5, The Old Mill');
		await eventually(async () => (await keepState(a)) === 'kept', 15_000, 'Aoife: Kept');
		// Ciarán, on Home, clicks the footer's address.
		const c = await openAdmin(await signedIn(liveBrowser, site, CIARAN), site);
		await c.frameLocator('.frame.on iframe').locator('footer[data-cms-source="shared/footer"] .footer-address').click();
		await eventually(() => new URL(c.url()).pathname === '/admin/shared/footer', 10_000, 'the Footer opens');
		await c.waitForSelector(`${DOC} [data-chip="read-only"]`, { timeout: 15_000 });
		const chip = await eventually(
			() => inFrame(c, (d) => d.querySelector('#cms-overlays .cms-box.ro .cms-chip')?.textContent ?? null),
			15_000,
			'the grey chip on the page',
		);
		assert.match(chip!, /^Read-only · .+ is editing$/);
		assert.equal(await inFrame(c, (d) => !!d.querySelector('#cms-overlays [data-mark="veil"]')), false);
		// Nothing typed on the page.
		const refused = await inFrame(c, (d) => {
			const el = d.querySelector('footer[data-cms-source="shared/footer"] .footer-address');
			const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'Z' });
			el?.dispatchEvent(event);
			return event.defaultPrevented;
		});
		assert.equal(refused, true);
		await a.context().close();
		await c.context().close();
	});
});
