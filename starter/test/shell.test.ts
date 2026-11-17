// The page shell: the header and footer (M7 Decisions 16–18, Acceptance 18–20; Exit steps 1–3
// and 5), since edit in context (Decision 16) the header's and the footer's shared blocks, with
// the name, contact details and socials still Site Settings'.
//
// - The shell's rules (src/components/shell.ts), on their own.
// - The footer with parts cleared, through Astro's container (helpers/render.ts): no empty
//   wrapper is left.
// - The built site (helpers/dist.ts) in headless Chromium: the header's name and menu, the
//   dropdown (click, Escape, a click outside, choosing a link, the keyboard), the phone menu
//   at 375, the current page, and the footer.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { footerParts, menuItems, normalisePath, siteName } from '../src/components/shell.ts';
import { buildCopy, readHtml, serveClient } from './helpers/dist.ts';
import { count, pinnedSite, startRenderer, type Renderer } from './helpers/render.ts';

const link = (href: string) => ({ href });
const MENU = [
	{ label: 'About', href: link('/about'), links: [] },
	{ label: 'Services', href: link('/services'), links: [{ label: 'Branding', href: '/services/branding' }, { label: 'Websites', href: '/services/websites' }] },
	{ label: 'Services page', href: link('/services'), links: [] },
	{ label: 'Nowhere', href: link(''), links: [] },
	{ label: 'Empty group', href: link(''), links: [{ label: 'No address', href: '' }] },
	{ label: '', href: link('/contact'), links: [] },
];

describe('the shell\'s rules (shell.ts)', () => {
	test('the site\'s name is brand.name (the package already gave it its fallback); "Site" if it\'s somehow missing', () => {
		assert.equal(siteName({ brand: { name: 'CaraCMS' } }), 'CaraCMS');
		assert.equal(siteName({}), 'Site');
	});

	test('the menu: a link, a group (its own address ignored), and nothing for an item with no address and no dropdown links, a group whose links have no address, or an item with no label', () => {
		const items = menuItems({ menu: MENU }, '/about');
		assert.deepEqual(
			items.map((i) => (i.kind === 'group' ? `${i.label}: ${i.links.map((l) => l.href).join(', ')}` : `${i.label} ${i.href}`)),
			['About /about', 'Services: /services/branding, /services/websites', 'Services page /services'],
		);
		assert.deepEqual(menuItems({}, '/'), [], 'no menu, no items');
		assert.deepEqual(menuItems({ menu: 'not a list' }, '/'), []);
	});

	test('Acceptance 19: the current page is an exact match: /services doesn\'t mark /services/branding\'s link, nor the other way round; a trailing slash doesn\'t matter', () => {
		const current = (path: string) =>
			menuItems({ menu: MENU }, path).flatMap((i) => (i.kind === 'group' ? [{ label: i.label, current: i.current }, ...i.links] : [i])).filter((i) => i.current).map((i) => i.label);
		assert.deepEqual(current('/services'), ['Services page']);
		assert.deepEqual(current('/services/branding'), ['Services', 'Branding'], 'the group holding it is marked too');
		assert.deepEqual(current('/services/branding/'), ['Services', 'Branding']);
		assert.deepEqual(current('/about/team'), []);
		assert.deepEqual(menuItems({ menu: MENU }, null).filter((i) => i.current), [], 'a page with no address marks nothing');
		assert.equal(normalisePath('/'), '/');
		assert.equal(normalisePath('/a/?x=1'), '/a');
	});

	test('the footer\'s parts: columns with usable links, the email and phone as links, the address by line, socials by their network\'s name', () => {
		const parts = footerParts(
			{
				columns: [
					{ heading: 'Studio', links: [{ label: 'About', href: '/about' }, { label: 'Half', href: '' }] },
					{ heading: 'Empty', links: [] },
				],
			},
			{
				contact: { email: ' studio@example.com ', phone: '+353 21 000 0000', address: '4 Example Lane\n\nCork\n' },
				socials: [{ network: 'linkedin', href: link('https://linkedin.example.com/x') }, { network: 'x', href: link('') }],
			},
		);
		assert.deepEqual(parts.columns, [{ index: 0, heading: 'Studio', links: [{ label: 'About', href: '/about', current: false, file: null }] }]);
		assert.deepEqual(
			parts.contact.map((l) => [l.label, l.href]),
			[
				['studio@example.com', 'mailto:studio@example.com'],
				['+353 21 000 0000', 'tel:+353210000000'],
			],
		);
		assert.deepEqual(parts.address, ['4 Example Lane', 'Cork']);
		assert.deepEqual(parts.socials.map((l) => [l.label, l.href]), [['LinkedIn', 'https://linkedin.example.com/x']]);
		assert.deepEqual(footerParts({}, {}), { columns: [], contact: [], address: [], socials: [] });
	});
});

describe('Acceptance 20: clearing a footer part leaves no empty element', () => {
	const demo = pinnedSite('shell-footer');
	let r: Renderer;
	// The slot's context for a shared block, outside a preview: no markers (the package's document.ts).
	let cmsOf: (type: string, path: string) => unknown;
	before(async () => {
		r = await startRenderer(demo.root);
		const { EMPTY_READER, settingsContext, slotContext } = await r.load('caracms/document');
		cmsOf = (type, path) => slotContext(type === 'siteHeader' ? 'header' : 'footer', { path, type }, '/', false, EMPTY_READER, settingsContext(false, EMPTY_READER));
	});
	after(async () => {
		await r?.close();
		demo.close();
	});
	const footer = ({ columns, ...settings }: Record<string, unknown>) =>
		r.component('src/components/SiteFooter.astro', { name: 'CaraCMS', parts: footerParts({ columns }, settings), cms: cmsOf('siteFooter', 'footer') });
	const ALL = {
		columns: [{ heading: 'Studio', links: [{ label: 'About', href: '/about' }] }],
		contact: { email: 'studio@example.com', phone: '+353 21 000 0000', address: '4 Example Lane\nCork' },
		socials: [{ network: 'instagram', href: link('https://instagram.example.com/example') }],
	};

	test('everything set: a column, Contact, Address and Follow, then the © line under a rule', async () => {
		const html = await footer(ALL);
		assert.equal(count(html, /data-footer-group/g), 4);
		assert.match(html, /<nav aria-label="Studio"/);
		assert.match(html, /<address>4 Example Lane<br>Cork<\/address>/);
		assert.match(html, new RegExp(`<p class="fg-muted text-small mt-14 border-t[^"]*" data-footer-legal(?: data-cms-fixed)?>© ${new Date().getFullYear()} CaraCMS</p>`));
	});

	test('each part cleared on its own: its group goes, and nothing empty is left', async () => {
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ ...ALL, columns: [] }, /aria-label="Studio"/],
			[{ ...ALL, contact: { ...ALL.contact, email: '', phone: '' } }, />Contact</],
			[{ ...ALL, contact: { ...ALL.contact, address: '' } }, /<address/],
			[{ ...ALL, socials: [] }, />Follow</],
		];
		for (const [settings, gone] of cases) {
			const html = await footer(settings);
			assert.doesNotMatch(html, gone);
			assert.equal(count(html, /data-footer-group/g), 3, String(gone));
			assert.doesNotMatch(html, /<ul[^>]*><\/ul>|<address><\/address>|<h2[^>]*><\/h2>/, 'no empty list, address or heading');
		}
	});

	test('everything cleared: only the © line, with no rule above it and no grid', async () => {
		const html = await footer({});
		assert.equal(count(html, /data-footer-group/g), 0);
		assert.doesNotMatch(html, /grid-cols|border-t/);
		assert.match(html, /<p class="fg-muted text-small" data-footer-legal(?: data-cms-fixed)?>©/);
	});

	test('an empty menu: just the name, with no nav, list or button', async () => {
		const html = await r.component('src/components/SiteHeader.astro', { name: 'CaraCMS', items: [], cms: cmsOf('siteHeader', 'header') });
		assert.match(html, /<a class="text-h4 font-semibold no-underline" href="\/">CaraCMS<\/a>/);
		assert.doesNotMatch(html, /<nav|<ul|<button/);
	});
});

describe('the shell in the browser (the built site)', () => {
	let browser: Browser;
	let page: Page;
	let origin: string;
	let close: () => void;
	before(async () => {
		const served = await serveClient();
		origin = served.origin;
		close = () => served.server.close();
		browser = await chromium.launch();
		page = await browser.newPage();
		// Only the test's own server: the Google tag and the made-up image host never answer.
		await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
	});
	after(async () => {
		await browser?.close();
		close?.();
	});

	const open = async (url: string, width = 1440) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto(origin + url);
		// Links don't leave the page in these tests: what's checked is what the menu does.
		await page.evaluate(() => document.addEventListener('click', (e) => (e.target as Element).closest?.('a') && e.preventDefault()));
	};
	const services = () => page.locator('[data-nav-group-button]');
	const panel = () => page.locator('[data-nav-group-panel]');
	const expanded = async () => (await services().getAttribute('aria-expanded')) === 'true';

	test('Acceptance 18: the header shows the site\'s name linking home, and the menu from Site Settings, Services as a group', async () => {
		await open('/');
		assert.equal(await page.locator('[data-site-header] a[href="/"]').first().textContent(), 'CaraCMS');
		const desktop = await page.locator('[data-site-header] nav > div:first-child > ul > li').evaluateAll((lis) => lis.map((li) => li.querySelector(':scope > a, :scope > button')!.textContent!.trim()));
		assert.deepEqual(desktop, ['About', 'Work', 'Journal', 'Services', 'Contact']);
		assert.equal(await services().evaluate((b) => b.tagName), 'BUTTON');
		assert.equal(await expanded(), false);
		assert.equal(await panel().isVisible(), false);
		assert.equal(await page.locator('[data-menu-button]').isVisible(), false, 'no phone button at 1440');
	});

	test('Acceptance 18, Exit step 2: a click opens the dropdown; Escape closes it and puts focus back on its button', async () => {
		await open('/');
		await services().click();
		assert.equal(await expanded(), true);
		assert.deepEqual(await panel().locator('a').allTextContents(), ['Branding', 'Websites']);
		assert.equal(await panel().isVisible(), true);
		await page.locator('[data-nav-group-panel] a').first().focus();
		await page.keyboard.press('Escape');
		assert.equal(await expanded(), false);
		assert.equal(await panel().isVisible(), false);
		assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-nav-group-button')), true);
	});

	test('a click outside closes it; so does choosing one of its links; a second click on the button closes it', async () => {
		await open('/');
		await services().click();
		await page.mouse.click(5, 600);
		assert.equal(await expanded(), false, 'a click outside');
		await services().click();
		await panel().locator('a', { hasText: 'Websites' }).click();
		assert.equal(await expanded(), false, 'choosing a link');
		await services().click();
		await services().click();
		assert.equal(await expanded(), false, 'the button again');
	});

	test('the keyboard: Tab reaches the button in order, Enter opens it, its links come next, and tabbing past the last one closes it', async () => {
		await open('/');
		// Posts and tags: Journal sits between Work and Services.
		await page.locator('[data-site-header] a[href="/journal"]').first().focus();
		await page.keyboard.press('Tab');
		assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Services');
		await page.keyboard.press('Enter');
		assert.equal(await expanded(), true);
		await page.keyboard.press('Tab');
		assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Branding');
		await page.keyboard.press('Tab');
		assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Websites');
		await page.keyboard.press('Tab');
		assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Contact');
		assert.equal(await expanded(), false, 'focus left it, so it closed');
	});

	test('the menu wraps rather than overflow on a narrow desktop (768)', async () => {
		await open('/', 768);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		assert.equal(overflow, 0);
		assert.equal(await services().isVisible(), true);
	});

	test('a group as the last menu item, opened at 768, opens its panel inside the content edge and the page gains no horizontal scroll', async () => {
		// A test-only variant: the pinned menu with Services moved to the end.
		const copy = await buildCopy('shell-last-group', (root) => {
			const file = join(root, 'content/shared/header.json');
			const header = JSON.parse(readFileSync(file, 'utf8'));
			header.block.menu.sort((a: { label: string }, b: { label: string }) => Number(a.label === 'Services') - Number(b.label === 'Services'));
			writeFileSync(file, JSON.stringify(header, null, '\t'));
		});
		const served = await serveClient(copy.client);
		// Its own page: the shared one only lets the first server's address through.
		const variant = await browser.newPage({ viewport: { width: 768, height: 900 } });
		try {
			await variant.route((url) => !url.href.startsWith(served.origin), (route) => route.abort());
			await variant.goto(served.origin + '/');
			assert.equal(await variant.locator('[data-nav-group]:last-child').count(), 1, 'Services is the last item');
			await variant.locator('[data-nav-group-button]').click();
			assert.equal(await variant.locator('[data-nav-group-button]').getAttribute('aria-expanded'), 'true');
			const { overflow, right, edge } = await variant.evaluate(() => {
				const box = document.querySelector('[data-nav-group-panel]')!.getBoundingClientRect();
				const container = document.querySelector('[data-site-header] .content-container')!.getBoundingClientRect();
				return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, right: box.right, edge: container.right };
			});
			assert.equal(overflow, 0, 'no horizontal scroll');
			assert.ok(right <= edge + 0.5, `the panel ends at ${right}, inside the content edge ${edge}`);
		} finally {
			await variant.close();
			served.server.close();
		}
	});

	test('Acceptance 18, Exit step 3: at 375 the menu is behind one button; opened, it lists About, Work, Journal, Contact and Services with its links under its label', async () => {
		await open('/', 375);
		assert.equal(await services().isVisible(), false, 'no inline menu');
		const button = page.locator('[data-menu-button]');
		assert.equal(await button.isVisible(), true);
		assert.equal(await button.textContent(), 'Menu');
		await button.click();
		assert.equal(await button.getAttribute('aria-expanded'), 'true');
		assert.equal(await button.textContent(), 'Close');
		const listed = await page.locator('[data-menu-panel] > ul > li').evaluateAll((lis) =>
			lis.map((li) => {
				const label = li.querySelector(':scope > span');
				return label ? `${label.textContent}: ${[...li.querySelectorAll('a')].map((a) => a.textContent).join(', ')}` : li.querySelector('a')!.textContent;
			}),
		);
		assert.deepEqual(listed, ['About', 'Work', 'Journal', 'Services: Branding, Websites', 'Contact']);
		await page.keyboard.press('Escape');
		assert.equal(await button.getAttribute('aria-expanded'), 'false');
		assert.equal(await page.locator('[data-menu-panel]').isVisible(), false);
		assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-menu-button')), true, 'focus back on the button');
		await button.click();
		await page.locator('[data-menu-panel] a', { hasText: 'Work' }).click();
		assert.equal(await button.getAttribute('aria-expanded'), 'false', 'a link closes it');
		await button.click();
		assert.equal(await button.getAttribute('aria-expanded'), 'true');
		await page.setViewportSize({ width: 1024, height: 900 });
		await page.waitForFunction(() => document.querySelector('[data-menu-button]')!.getAttribute('aria-expanded') === 'false', null, { timeout: 2000 });
		assert.equal(await page.locator('[data-menu-panel]').evaluate((p) => (p as HTMLElement).hidden), true, 'growing past 768 closes it');
	});

	test('Acceptance 19, Exit step 5: on /about only the About links are the current page; on Branding, its links are, and the Services button carries the accent underline (not aria-current)', async () => {
		const marked = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);
		assert.deepEqual(marked(readHtml('/about')), ['/about', '/about'], 'the desktop list and the phone list');
		assert.deepEqual(marked(readHtml('/about/team')), []);
		assert.deepEqual(marked(readHtml('/services/branding')), ['/services/branding', '/services/branding']);
		assert.doesNotMatch(readHtml('/services/branding'), /<button[^>]*aria-current/);
		await open('/services/branding');
		const line = await page.locator('[data-nav-group-button] > span').evaluate((s) => [getComputedStyle(s).textDecorationLine, getComputedStyle(s).textDecorationColor]);
		assert.deepEqual(line, ['underline', 'rgb(47, 79, 219)']);
		await open('/');
		assert.equal(await page.locator('[data-nav-group-button] > span').evaluate((s) => getComputedStyle(s).textDecorationLine), 'none');
	});

	test('Acceptance 20, Exit step 1: the footer shows the link columns, the contact details, the address, the social links and © <year> CaraCMS', async () => {
		await open('/');
		const groups = await page.locator('[data-site-footer] [data-footer-group]').evaluateAll((gs) =>
			gs.map((g) => `${g.querySelector('h2')?.textContent}: ${[...g.querySelectorAll('a, address')].map((a) => a.textContent).join(', ')}`),
		);
		assert.deepEqual(groups, [
			'Studio: About, Team, Work, Contact',
			'Elsewhere: Field notes, Visit, Questions, Privacy',
			'Contact: studio@example.com, +353 21 000 0000',
			'Address: 4 Example LaneCorkIreland',
			'Follow: Instagram, LinkedIn, YouTube',
		]);
		assert.equal(await page.locator('[data-footer-legal]').textContent(), `© ${new Date().getFullYear()} CaraCMS`);
		assert.equal(await page.locator('[data-site-footer] a[href="mailto:studio@example.com"]').count(), 1);
	});
});
