// A lockup inside a group (the editor-friction batch, the review's "Limits left
// as they are", fixed 2026-10-19): the block level's "Editing on Phone" note, the lockup's
// own phone-lines control at the group's dotted path (`side.title`), its write to the
// file, the phone iframe showing the phone lines, its preview warning, and the block
// list's phone-lines chip.
//
// A test-only `banner` block (a group "Side" holding a lockup and a text field) goes into
// the throwaway copy only (helpers/dev-site.ts → `edit`), as card-run.browser.test.ts does;
// the pinned fixture and the starter are untouched.
//
//   node --test --experimental-strip-types test/group-lockup.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

const BANNER_TS = `import { group, lockup, text, type BlockConfig, type BlockData } from 'caracms/config';

/** Test-only (group-lockup.browser.test.ts): a lockup inside a group. */
export const banner = {
	label: 'Banner',
	component: 'src/blocks/Banner.astro',
	fields: {
		side: group({ title: lockup({ style: 'display', label: 'Title' }), note: text({ label: 'Note' }) }, { label: 'Side' }),
	},
} satisfies BlockConfig;

export type BannerData = BlockData<typeof banner.fields>;
`;

const BANNER_ASTRO = `---
import Block from 'caracms/components/Block.astro';
import Lockup from 'caracms/components/Lockup.astro';
import Text from 'caracms/components/Text.astro';
import type { BlockProps } from 'caracms/document';
import type { BannerData } from './banner.ts';

const { block, cms } = Astro.props as BlockProps<BannerData>;
---

<Block cms={cms} class="band banner">
	<div class="band-inner">
		<Lockup cms={cms} field="side.title" value={block.side.title} />
		<Text cms={cms} field="side.note" value={block.side.note} />
	</div>
</Block>
`;

function addBannerBlock(root: string) {
	writeFileSync(join(root, 'src/blocks/banner.ts'), BANNER_TS);
	writeFileSync(join(root, 'src/blocks/Banner.astro'), BANNER_ASTRO);
	const configFile = join(root, 'caracms.config.ts');
	let config = readFileSync(configFile, 'utf8');
	config = config.replace("import { cta } from './src/blocks/cta.ts';", "import { banner } from './src/blocks/banner.ts';\nimport { cta } from './src/blocks/cta.ts';");
	config = config.replace(/\n(\t\tfooter,\n)/, '\n$1\t\tbanner,\n');
	assert.ok(config.includes('\t\tbanner,\n') && config.includes("from './src/blocks/banner.ts'"), "the banner block is in the copy's config");
	writeFileSync(configFile, config);
}

async function eventually<T>(check: () => T | Promise<T>, timeout = 8000, what = 'the condition'): Promise<T> {
	const end = Date.now() + timeout;
	let last: unknown;
	while (Date.now() < end) {
		try {
			const value = await check();
			if (value) return value;
			last = value;
		} catch (error) {
			last = error;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 15000 });
	return page;
}

const FILE = 'content/pages/banner.json';
const MAIN = ['Small studio', 'big ideas'];
const block = '[data-pane-level="block"]';
const field = `${block} [data-ff="side.title"]`;
const titleOnDisk = () => (JSON.parse(site.read(FILE)) as { blocks: { side?: { title?: unknown } }[] }).blocks[0]!.side?.title;

/** Which of the banner's line sets each iframe shows (desktop, tablet, phone). */
const shownSets = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll<HTMLIFrameElement>('#stage iframe')].map((f) => {
			const win = f.contentWindow!;
			return [...f.contentDocument!.querySelectorAll<HTMLElement>('[data-cms-block="0"] [data-cms-field="side.title"] [data-cms-lines]')]
				.filter((s) => win.getComputedStyle(s).display !== 'none')
				.map((s) => s.dataset.cmsLines)
				.join(',');
		}),
	);

describe('a lockup inside a group gets the phone-lines control', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('group-lockup', { edit: addBannerBlock });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('on Phone: the note, Give Phone its own lines at side.title, the object form in the file, the phone iframe, the chip', async () => {
		site.write(FILE, `${JSON.stringify({ title: 'Banner', blocks: [{ type: 'banner', side: { title: MAIN, note: 'Hello' } }] }, null, 2)}\n`);
		const page = await open('/admin/pages/banner');
		await page.frameLocator('.frame.on iframe').locator('[data-cms-block="0"] [data-cms-kind="lockup"]').click();
		await page.waitForSelector(field);
		await page.click('button[role="radio"][data-width="phone"]');

		// The block level says what Phone editing means, as for a top-level lockup.
		await page.waitForSelector(`${block} .note.phone:has-text("except a heading's phone lines")`);
		// The lockup's preview warning reaches it (its block index comes through the group).
		await page.waitForSelector(`${field} [data-warning]`);

		// The field's own control: "Phone lines" (none yet), then give them.
		await page.click(`${field} .mini-seg button.ph`);
		await page.click(`${field} button:has-text("Give Phone its own lines")`);
		const disk = await eventually(() => {
			const t = titleOnDisk() as { lines?: unknown; phone?: unknown } | undefined;
			return t && !Array.isArray(t) && Array.isArray(t.phone) && t.phone.length > 0 ? t : null;
		}, 6000, 'the object form at side.title');
		assert.deepEqual(disk!.lines, MAIN, 'the main lines kept');
		assert.equal((JSON.parse(site.read(FILE)) as { blocks: { side: { note: string } }[] }).blocks[0]!.side.note, 'Hello', "the group's other field kept");
		await page.waitForSelector(`${field} .lk-rows input[data-set="phone"]`);

		// It takes effect: the phone iframe shows the phone lines, desktop and tablet the main ones.
		await eventually(async () => (await shownSets(page)).join(' ') === 'main main phone', 6000, 'the sets per width');

		// Back on Desktop: the field says Phone has its own lines, and so does the block's row.
		await page.click('button[role="radio"][data-width="desktop"]');
		await eventually(async () => /Phone lines/.test((await page.textContent(`${field} .field-head`)) ?? ''), 4000, "the field's Phone lines chip");
		await page.click(`${block} .lv >> nth=1`);
		await page.waitForSelector('[data-pane-level="document"] .blist .brow [data-chip="phone-lines"]');
		await page.close();
	});
});
