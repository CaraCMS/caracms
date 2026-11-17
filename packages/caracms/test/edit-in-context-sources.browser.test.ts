// Edit in context, the hover chips and the clicks on a footer that reads Site Settings (Acceptance 7, 9,
// 10, 12, 16 and the rest of 18a), on a copy of the fixture shaped like the starter's footer
// (starter/src/components/SiteFooter.astro): the footer is the slot's shared block with a list of
// columns (a heading each, a list of links), and it draws Site Settings' phone (typed on the page) and
// social networks (marked as the network, without its value). The starter's own marks are checked on its
// render by starter/test/slots.test.ts; the editor's side is the package's, so it is proved here once.
// Headless Chromium from Playwright's cache, skipped without it.
//
//   node --test --experimental-strip-types test/edit-in-context-sources.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

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
const inFrame = <T>(page: Page, fn: (doc: Document) => T) =>
	page.evaluate(`(${fn.toString()})(document.querySelector('.frame.on iframe').contentDocument)`) as Promise<T>;
const overHome = (page: Page) => eventually(async () => /open over Home/.test((await page.textContent(SUB).catch(() => '')) ?? ''), 8000, '"open over Home"');
/** The hover chip on the page, its source and its label as one line. */
const chipText = (page: Page) => inFrame(page, (d) => (d.querySelector('#cms-overlays .cms-chip')?.textContent ?? '').replace(/\s+/g, ' ').trim());

const FOOTER_BLOCK = `---
import Block from 'caracms/components/Block.astro';
import Link from 'caracms/components/Link.astro';
import Text from 'caracms/components/Text.astro';
import { siteSettings } from 'caracms/content';
import { site } from 'virtual:caracms/config';
const { block, cms } = Astro.props;
const settings: any = await siteSettings(site, Astro.locals);
---

<Block cms={cms} as="footer" class="band bg-dark footer-block">
	<div class="band-inner">
		{block.columns.map((column: any, i: number) => (
			<section class="footer-col">
				<Text cms={cms} field={\`columns.\${i}.heading\`} value={column.heading} as="h2" class="footer-col-heading" />
				<ul>
					{column.links.map((l: any, j: number) => (
						<li><Link cms={cms} field={\`columns.\${i}.links.\${j}\`} value={l} class="footer-col-link" /></li>
					))}
				</ul>
			</section>
		))}
		<Text cms={cms.settings} field="contact.phone" value={settings.contact?.phone ?? ''} as="span" class="footer-phone" />
		{(settings.socials ?? []).map((s: any, i: number) => (
			<Block cms={cms.settings} field={\`socials.\${i}.network\`} as="a" class="footer-social" href={s.href?.href}>{s.network}</Block>
		))}
	</div>
</Block>
`;

const FOOTER_CONFIG = `import { link, list, text, type BlockConfig, type BlockData } from 'caracms/config';

export const footer = {
	label: 'Footer',
	component: 'src/blocks/Footer.astro',
	slot: 'footer',
	fields: {
		columns: list(
			{
				heading: text({ label: 'Heading' }),
				links: list(link({ label: 'Link' }), { label: 'Links' }),
			},
			{ label: 'Columns', itemLabel: 'heading' },
		),
	},
} satisfies BlockConfig;

export type FooterData = BlockData<typeof footer.fields>;
`;

/** The fixture with the starter's footer: columns of its own, Site Settings' phone and socials. */
function starterFooter(root: string): void {
	const configFile = join(root, 'caracms.config.ts');
	writeFileSync(
		configFile,
		readFileSync(configFile, 'utf8')
			.replace("import { defineSite } from 'caracms/config';", "import { defineSite, group, link, list, select, text } from 'caracms/config';")
			.replace(
				'export default defineSite({',
				`export default defineSite({
	settings: {
		fields: {
			contact: group({ phone: text({ label: 'Phone' }) }, { label: 'Contact details' }),
			socials: list(
				{ network: select({ label: 'Network', options: [{ value: 'instagram', label: 'Instagram' }, { value: 'linkedin', label: 'LinkedIn' }] }), href: link({ label: 'Address', addressOnly: true }) },
				{ label: 'Social links', itemLabel: 'network' },
			),
		},
	},`,
			),
	);
	writeFileSync(join(root, 'src/blocks/footer.ts'), FOOTER_CONFIG);
	writeFileSync(join(root, 'src/blocks/Footer.astro'), FOOTER_BLOCK);
	writeFileSync(
		join(root, 'content/shared/footer.json'),
		`${JSON.stringify(
			{
				title: 'Footer',
				default: true,
				block: {
					type: 'footer',
					columns: [
						{ heading: 'Studio', links: [{ label: 'About', href: '/about' }, { label: 'Work', href: '/work' }] },
						{ heading: 'Elsewhere', links: [{ label: 'Contact', href: '/contact' }] },
					],
				},
			},
			null,
			2,
		)}\n`,
	);
	const settingsFile = join(root, 'content/site-settings.json');
	writeFileSync(
		settingsFile,
		readFileSync(settingsFile, 'utf8').replace(
			'"title": "Site Settings",',
			`"title": "Site Settings",
  "contact": { "phone": "+353 21 000 0000" },
  "socials": [{ "network": "instagram", "href": { "href": "/contact" } }, { "network": "linkedin", "href": { "href": "/work" } }],`,
		),
	);
}

describe('edit in context: a footer with columns that reads Site Settings (the starter\'s shape)', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('eic-sources', { edit: starterFooter });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('Acceptance 7: the hover chip names the Footer and the field; one click opens its column\'s row, the page undimmed, and editing the heading re-renders it', async () => {
		const page = await open('/admin');
		const heading = frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-col-heading').first();
		await heading.hover();
		await eventually(async () => /^Footer ›\s*Columns$/.test(await chipText(page)), 8000, 'the chip "Footer › Columns"');
		await heading.click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, '/admin/shared/footer');
		await overHome(page);
		assert.equal(await page.locator('#stage.is-aside').count(), 0, 'the page is never dimmed');
		await page.waitForSelector(`${DOC} .field-frame.is-picked[data-ff="columns"] .item.is-open`);
		// The preview is still Home's: the hero, as before.
		assert.ok(await inFrame(page, (d) => !!d.querySelector('[data-cms-block="0"]')), 'Home is still shown');
		const input = page.locator(`${DOC} .item.is-open input`).first();
		await eventually(async () => (await input.inputValue()) === 'Studio', 8000, 'the open row is the first column\'s');
		await input.fill('Studio QX');
		await eventually(() => inFrame(page, (d) => d.querySelector('.footer-col-heading')?.textContent === 'Studio QX'), 10000, 'the page\'s footer follows');
		await page.close();
	});

	test('Acceptance 9: the hover chip said "Site Settings › Phone"; one click opens Site Settings with Phone picked, the caret in the footer; typing shows in both', async () => {
		const page = await open('/admin');
		const phone = frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-phone');
		await phone.hover();
		await eventually(async () => /^Site Settings ›\s*Phone$/.test(await chipText(page)), 8000, 'the chip "Site Settings › Phone"');
		await phone.click();
		await eventually(() => pathname(page) === '/admin/settings', 8000, '/admin/settings');
		await overHome(page);
		await page.waitForSelector(`${DOC} .field-frame.is-picked[data-ff="phone"], ${DOC} .field-frame.is-picked[data-ff="contact.phone"]`);
		assert.equal(await inFrame(page, (d) => d.activeElement?.classList.contains('footer-phone') ?? false), true, 'the caret is in the footer');
		assert.equal(await page.locator('#stage.is-aside').count(), 0);
		// The caret is where the click landed (the browser's own), so what's typed lands inside the number.
		await page.keyboard.type('77');
		await eventually(async () => (await page.inputValue(`${DOC} .is-picked input`)).includes('77'), 8000, 'the sidebar follows');
		await eventually(() => inFrame(page, (d) => /77/.test(d.querySelector('.footer-phone')?.textContent ?? '')), 8000, 'the page keeps it');
		await page.close();
	});

	test('Acceptance 10 and 12: a social link opens Site Settings with its row open and its Network control focused, is not followed, and nothing is typed on the page', async () => {
		const page = await open('/admin');
		const social = frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-social').first();
		assert.equal(await social.getAttribute('contenteditable'), null);
		const before = await social.innerHTML();
		await inFrame(page, (d) => ((d.defaultView as unknown as { __stay?: number }).__stay = 1));
		await social.click();
		await eventually(() => pathname(page) === '/admin/settings', 8000, 'Site Settings opens, not the linked page');
		await overHome(page);
		await page.waitForSelector(`${DOC} .field-frame.is-picked[data-ff="socials"] .item.is-open`);
		await eventually(() => page.evaluate(() => document.activeElement?.getAttribute('data-path') === 'socials.0.network'), 8000, 'the Network control focused');
		// Not followed (the href was /contact): the frame never navigated, so its mark survives, and its markup is as it was.
		assert.equal(await inFrame(page, (d) => (d.defaultView as unknown as { __stay?: number }).__stay), 1, 'the frame did not navigate');
		assert.equal(await social.innerHTML(), before);
		assert.equal(await social.evaluate((el) => el.hasAttribute('contenteditable')), false);
		await page.close();
	});

	test('Acceptance 12: a link field in the footer is picked, not followed; its row opens in the Footer', async () => {
		const page = await open('/admin');
		await inFrame(page, (d) => ((d.defaultView as unknown as { __stay?: number }).__stay = 1));
		await frameOn(page).locator('footer[data-cms-source="shared/footer"] .footer-col-link').first().click();
		await eventually(() => pathname(page) === '/admin/shared/footer', 8000, 'the Footer opens, not the linked page');
		await overHome(page);
		await page.waitForSelector(`${DOC} .field-frame.is-picked[data-ff="columns"]`);
		assert.equal(await inFrame(page, (d) => (d.defaultView as unknown as { __stay?: number }).__stay), 1, 'the frame did not navigate');
		await page.close();
	});
});

describe('edit in context: a shared block in the body over the last page, and a journal post\'s media field (Acceptance 16, 18a)', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('eic-sources-2', {
			edit(root) {
				writeFileSync(join(root, 'content/shared/start.json'), `${JSON.stringify({ title: 'Start a project', block: { type: 'cta', heading: ['Start a project'], text: 'Tell us what you are making.', buttons: [] } }, null, 2)}\n`);
				const about = join(root, 'content/pages/about.json');
				const raw = readFileSync(about, 'utf8');
				const at = raw.indexOf('\n  ]', raw.indexOf('"blocks": ['));
				writeFileSync(about, `${raw.slice(0, at)},\n    { "shared": "start" }${raw.slice(at)}`);
			},
		});
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	/** From a document to the Shared blocks level, then the block's row. */
	async function openStartFromTheList(page: Page) {
		await page.keyboard.press('Escape');
		await page.waitForSelector('[data-pane-level="documents"]', { state: 'visible' });
		await page.click('[data-pane-level="documents"] .drow.coll[data-coll="shared"]');
		await page.waitForSelector('[data-pane-level="collection"] #coll-list');
		await page.click('[data-pane-level="collection"] [data-doc="shared/start"]');
		await eventually(() => pathname(page) === '/admin/shared/start', 8000, '/admin/shared/start');
	}

	test('Acceptance 16: "Start a project" from the list keeps About, which uses it, undimmed; over Field notes, which doesn\'t, it shows its own preview', async () => {
		const about = await open('/admin/pages/about');
		await openStartFromTheList(about);
		await eventually(async () => /open over About/.test((await about.textContent(SUB).catch(() => '')) ?? ''), 8000, '"open over About"');
		assert.equal(await about.locator('#stage.is-aside').count(), 0);
		assert.match(await inFrame(about, (d) => d.title), /About/, 'About is still shown');
		await about.close();

		const notes = await open('/admin/journal/notes-from-the-ridge');
		await openStartFromTheList(notes);
		await new Promise((r) => setTimeout(r, 1500));
		assert.doesNotMatch((await notes.textContent(SUB).catch(() => '')) ?? '', /open over/, 'no page under it');
		// Its own preview: the block alone, none of the post.
		assert.equal(await inFrame(notes, (d) => !!d.querySelector('.post-head, .post-kicker')), false, 'the post is not shown');
		assert.equal(await inFrame(notes, (d) => d.querySelectorAll('[data-cms-block]').length), 1, 'the block alone');
		await notes.close();
	});

	test('Decision 8, amended: on About, the first click on the shared block selects it as the page\'s block; a click on its words opens it over About, and typing on the page edits it', async () => {
		const page = await open('/admin/pages/about');
		const root = frameOn(page).locator('[data-cms-shared="start"]');
		// Its root is the page's block; its fields are the shared block's.
		assert.equal(await root.getAttribute('data-cms-source'), null);
		const heading = root.locator('[data-cms-field="heading"]').first();
		assert.equal(await heading.getAttribute('data-cms-source'), 'shared/start');
		await heading.click();
		await page.getByText('Start a project is a shared block').waitFor({ timeout: 8000 });
		assert.equal(pathname(page), '/admin/pages/about', 'still the page');
		await heading.click();
		await eventually(() => pathname(page) === '/admin/shared/start', 8000, '/admin/shared/start');
		await eventually(async () => /open over About/.test((await page.textContent(SUB).catch(() => '')) ?? ''), 8000, '"open over About"');
		assert.match(await inFrame(page, (d) => d.title), /About/, 'About is still shown');
		// Typing on the page goes into the shared block.
		const text = frameOn(page).locator('[data-cms-shared="start"] [data-cms-field="text"]');
		await text.click();
		await page.keyboard.press('End');
		await page.keyboard.type(' Today.');
		await eventually(async () => /making\. Today\./.test((await page.locator(`${DOC} textarea`).first().inputValue().catch(() => '')) ?? ''), 8000, 'the shared block\'s Text field');
		await page.close();
	});

	test('Acceptance 18a: a click on the post head outside a field opens Page details at its top; the photo\'s slot is picked in one click', async () => {
		const page = await open('/admin/journal/notes-from-the-ridge');
		await frameOn(page).locator('[data-cms-page].post-head').click({ position: { x: 4, y: 4 } });
		await page.waitForSelector(`${DOC} [data-page-fields]`);
		assert.equal(await page.locator(`${DOC} [data-page-fields] .field-frame.is-picked`).count(), 0, 'no field picked: the top of Page details');
		await frameOn(page).locator('[data-cms-page][data-cms-field="photo"]').click();
		await page.waitForSelector(`${DOC} [data-page-fields] .field-frame.is-picked[data-ff="photo"]`);
		await page.close();
	});
});
