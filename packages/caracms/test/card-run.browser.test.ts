// Friction note item 3 ("Wrapping a run of blocks", the editor-friction batch):
// does a port's CSS-only card hold in the editor's preview? A run of neighbouring
// blocks is drawn as one cream card by sibling CSS alone: each block has a select ("Starts
// a new card" / "Same card as above") that lands on its root as `data-card`, the first
// block in a card gets the top rounding, a "same card" block drops its top margin, and the
// last block in a card (one not followed by a "same card" block) gets the bottom rounding.
//
// A test-only `card` block goes into the throwaway copy only (helpers/dev-site.ts →
// `edit`), and its pages are written into the copy's content; the pinned fixture and the
// starter are untouched. The test reads the preview through bounding boxes and computed
// styles and asks how many cards a reader would see, after the page loads, with a block
// hovered and selected, and after a block is added, moved and removed in the editor.
//
//   node --test --experimental-strip-types test/card-run.browser.test.ts
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

const CARD_TS = `import { select, text, type BlockConfig, type BlockData } from 'caracms/config';

/** Test-only (card-run.browser.test.ts): one block of a cream card, a client site's way. */
export const card = {
	label: 'Card part',
	component: 'src/blocks/Card.astro',
	fields: {
		heading: text({ label: 'Heading' }),
		join: select({
			label: 'Card',
			options: [
				{ value: 'start', label: 'Starts a new card' },
				{ value: 'same', label: 'Same card as above' },
			],
			default: 'same',
		}),
	},
} satisfies BlockConfig;

export type CardData = BlockData<typeof card.fields>;
`;

// The CSS as a site would write it: global, on the block's own root, siblings only.
const CARD_ASTRO = `---
import Block from 'caracms/components/Block.astro';
import Text from 'caracms/components/Text.astro';
import type { BlockProps } from 'caracms/document';
import type { CardData } from './card.ts';

const { block, cms } = Astro.props as BlockProps<CardData>;
---

<Block cms={cms} class="card" data-card={block.join}>
	<Text cms={cms} field="heading" value={block.heading} as="h3" class="card-heading" />
</Block>

<style is:global>
	main > .card {
		display: block;
		box-sizing: border-box;
		width: min(100% - 48px, 960px);
		margin: 40px auto 0;
		padding: 32px;
		background: rgb(244, 236, 216);
		border-radius: 0;
	}
	main > .card[data-card='start'] {
		border-top-left-radius: 20px;
		border-top-right-radius: 20px;
	}
	main > .card[data-card='same'] {
		margin-top: 0;
	}
	main > .card:not(:has(+ .card[data-card='same'])) {
		border-bottom-left-radius: 20px;
		border-bottom-right-radius: 20px;
		margin-bottom: 40px;
	}
	.card-heading {
		margin: 0;
		font-size: 20px;
	}
</style>
`;

/** Put the test-only block into the copy's src and config (never the starter's). */
function addCardBlock(root: string) {
	writeFileSync(join(root, 'src/blocks/card.ts'), CARD_TS);
	writeFileSync(join(root, 'src/blocks/Card.astro'), CARD_ASTRO);
	const configFile = join(root, 'caracms.config.ts');
	let config = readFileSync(configFile, 'utf8');
	config = config.replace("import { cta } from './src/blocks/cta.ts';", "import { card } from './src/blocks/card.ts';\nimport { cta } from './src/blocks/cta.ts';");
	config = config.replace(/\n(\t\tfooter,\n)/, '\n$1\t\tcard,\n');
	assert.ok(config.includes('\t\tcard,\n') && config.includes("from './src/blocks/card.ts'"), 'the card block is in the copy\'s config');
	writeFileSync(configFile, config);
}

const textBlock = (heading: string) => ({ type: 'text', heading, body: 'Body', background: 'light' });
const cardBlock = (heading: string, join: 'start' | 'same') => ({ type: 'card', heading, join });
const writePage = (file: string, title: string, blocks: unknown[]) => site.write(file, `${JSON.stringify({ title, blocks }, null, 2)}\n`);

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

interface Part {
	heading: string;
	top: number;
	bottom: number;
	left: number;
	width: number;
	bg: string;
	roundTop: boolean;
	roundBottom: boolean;
	/** What follows the block in the DOM: a block's type, or the tag of anything else. */
	next: string | null;
}

/** Every card block in a document, in DOM order, as a reader's eye gets it. Runs in the browser. */
function measure(doc: Document): Part[] {
	return [...doc.querySelectorAll<HTMLElement>('main > .card')].map((el) => {
		const r = el.getBoundingClientRect();
		const s = doc.defaultView!.getComputedStyle(el);
		const n = el.nextElementSibling;
		return {
			heading: el.querySelector('h3')?.textContent?.trim() || 'new',
			top: r.top,
			bottom: r.bottom,
			left: r.left,
			width: r.width,
			bg: s.backgroundColor,
			roundTop: parseFloat(s.borderTopLeftRadius) > 0 && parseFloat(s.borderTopRightRadius) > 0,
			roundBottom: parseFloat(s.borderBottomLeftRadius) > 0 && parseFloat(s.borderBottomRightRadius) > 0,
			next: n ? (n.getAttribute('data-cms-type') ?? n.tagName.toLowerCase()) : null,
		};
	});
}

/**
 * The cards a reader sees: a new card starts where the previous block's bottom is
 * rounded, this one's top is rounded, there's any gap, or the edges or colour differ.
 * Each card is its blocks' headings, with `(` / `)` where its top and bottom are rounded
 * (a card missing one reads as cut off): `(A B C)` is one whole card.
 */
function cards(parts: Part[]): string[] {
	const out: Part[][] = [];
	for (const p of parts) {
		const cur = out.at(-1);
		const prev = cur?.at(-1);
		const joins = prev && !prev.roundBottom && !p.roundTop && Math.abs(p.top - prev.bottom) < 0.5 && Math.abs(p.left - prev.left) < 0.5 && Math.abs(p.width - prev.width) < 0.5 && p.bg === prev.bg;
		if (cur && joins) cur.push(p);
		else out.push([p]);
	}
	return out.map((c) => `${c[0]!.roundTop ? '(' : ''}${c.map((p) => p.heading).join(' ')}${c.at(-1)!.roundBottom ? ')' : ''}`);
}

const frames = [1440, 375] as const;
const partsIn = (page: Page, width: number) =>
	page.evaluate(
		([w, fn]) => {
			const doc = document.querySelector<HTMLIFrameElement>(`#stage iframe[data-width="${w}"]`)!.contentDocument!;
			return (new Function('doc', `return (${fn})(doc)`) as (d: Document) => Part[])(doc);
		},
		[width, measure.toString()] as const,
	);

/** The preview (desktop and phone) settles on `expected` cards; on a timeout, the last reading is the failure. */
async function previewReads(page: Page, expected: string[], what: string) {
	let last: Record<number, string[]> = {};
	try {
		await eventually(
			async () => {
				for (const w of frames) last[w] = cards(await partsIn(page, w));
				return frames.every((w) => JSON.stringify(last[w]) === JSON.stringify(expected));
			},
			8000,
			what,
		);
	} catch {
		for (const w of frames) assert.deepEqual(last[w], expected, `${what}: the ${w} preview`);
	}
}

const LIST = '[data-pane-level="document"] .blist';
const rowMain = (i: number) => `${LIST} > .brow >> nth=${i} >> .brow-main`;
const fileHeadings = (file: string) => (JSON.parse(site.read(file)) as { blocks: { type: string; heading?: string }[] }).blocks.map((b) => `${b.type}:${b.heading ?? ''}`);
async function fileReads(file: string, expected: string[], what: string) {
	await eventually(() => JSON.stringify(fileHeadings(file)) === JSON.stringify(expected), 8000, `${what}: the file`);
}
const toList = async (page: Page) => {
	if (await page.isVisible(LIST)) return;
	await page.click('[data-pane-level="block"] .lv >> nth=1');
	await page.waitForSelector(LIST);
};

describe('a run of blocks drawn as one card by CSS (friction item 3)', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('card-run', { edit: addCardBlock });
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test('three "same card" blocks read as one card in the preview, through hover, select, add, move and remove', async () => {
		const file = 'content/pages/cards.json';
		writePage(file, 'Cards', [textBlock('Before'), cardBlock('A', 'start'), cardBlock('B', 'same'), cardBlock('C', 'same'), textBlock('After')]);
		const page = await open('/admin/pages/cards');
		await page.waitForSelector(LIST);
		await previewReads(page, ['(A B C)'], 'loaded');

		// Nothing the editor draws sits between the blocks: its layer hangs off <html>, outside <body>.
		const desktop = page.frameLocator('#stage iframe[data-width="1440"]');
		const placement = () =>
			page.evaluate(() => {
				const doc = document.querySelector<HTMLIFrameElement>('#stage iframe[data-width="1440"]')!.contentDocument!;
				const layer = doc.getElementById('cms-overlays');
				const main = doc.querySelector('main')!;
				return { layerParent: layer?.parentElement?.tagName.toLowerCase() ?? null, mainChildren: [...main.children].map((c) => c.getAttribute('data-cms-type') ?? c.tagName.toLowerCase()) };
			});
		// Hover the middle block, then select it: the hover mark, the selection and its label are drawn.
		await desktop.locator('[data-cms-block="2"]').hover();
		await eventually(() => desktop.locator('#cms-overlays .cms-hov').count(), 6000, 'the hover mark');
		await previewReads(page, ['(A B C)'], 'hovered');
		await page.click(rowMain(2));
		await page.waitForSelector('[data-pane-level="block"]');
		await eventually(() => desktop.locator('#cms-overlays .cms-sel').count(), 6000, 'the selected block');
		await previewReads(page, ['(A B C)'], 'selected');
		assert.deepEqual(await placement(), { layerParent: 'html', mainChildren: ['text', 'card', 'card', 'card', 'text'] }, 'only the blocks are in <main>');
		await toList(page);

		// Add: a card block from the picker (its select defaults to "Same card as above"), at the end, then up into the run.
		await page.click('[data-pane-level="document"] .add-row');
		await page.waitForSelector('[data-picker-at="5"]');
		await page.click('[data-picker-at] .ptype[data-type="card"]');
		await page.waitForSelector('[data-pane-level="block"]');
		await toList(page);
		await fileReads(file, ['text:Before', 'card:A', 'card:B', 'card:C', 'text:After', 'card:'], 'added');
		// Added after "After": a "same card" block there is its own card, rounded below but not above (the content's doing).
		await previewReads(page, ['(A B C)', 'new)'], 'added at the end');
		await page.focus(rowMain(5));
		await page.keyboard.press('Alt+ArrowUp');
		await fileReads(file, ['text:Before', 'card:A', 'card:B', 'card:C', 'card:', 'text:After'], 'moved into the run');
		await previewReads(page, ['(A B C new)'], 'added and moved into the run');

		// Move inside the run: C up past B (the morph reorders the elements).
		await page.focus(rowMain(3));
		await page.keyboard.press('Alt+ArrowUp');
		await fileReads(file, ['text:Before', 'card:A', 'card:C', 'card:B', 'card:', 'text:After'], 'moved');
		await previewReads(page, ['(A C B new)'], 'moved within the run');

		// Remove the middle (B), then the last (the new one): C, last now, takes the bottom rounding.
		await page.focus(rowMain(3));
		await page.keyboard.press('Backspace');
		await fileReads(file, ['text:Before', 'card:A', 'card:C', 'card:', 'text:After'], 'removed B');
		await previewReads(page, ['(A C new)'], 'a middle block removed');
		await page.focus(rowMain(3));
		await page.keyboard.press('Backspace');
		await fileReads(file, ['text:Before', 'card:A', 'card:C', 'text:After'], 'removed the last');
		await previewReads(page, ['(A C)'], 'the last block removed');
		// Undo brings it back, and C gives the rounding back.
		await page.keyboard.press('ControlOrMeta+z');
		await fileReads(file, ['text:Before', 'card:A', 'card:C', 'card:', 'text:After'], 'undone');
		await previewReads(page, ['(A C new)'], 'undone');
		await page.close();
	});

	// A block the code doesn't know, inside the run: the public render leaves nothing for
	// it, and the preview leaves only a comment (src/skipped.ts), no element, so `+` matches
	// across it and the preview shows one card, as the public page does. (Until 2026-10-19
	// a zero-height `data-cms-skipped` placeholder sat there and cut the card in two.)
	test('an unknown block inside the run: one card on the public page and in the preview', async () => {
		const file = 'content/pages/cards-unknown.json';
		writePage(file, 'Cards with an unknown', [cardBlock('A', 'start'), cardBlock('B', 'same'), { type: 'testimonial-strip', heading: 'Kind words' }, cardBlock('C', 'same')]);

		const publicPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		await publicPage.goto(`${site.origin}/cards-unknown`);
		await publicPage.waitForSelector('main > .card');
		const publicParts = await publicPage.evaluate((fn) => (new Function('doc', `return (${fn})(doc)`) as (d: Document) => Part[])(document), measure.toString());
		assert.deepEqual(cards(publicParts), ['(A B C)'], 'the public page: one card');
		await publicPage.close();

		const page = await open('/admin/pages/cards-unknown');
		await page.waitForSelector(LIST);
		await previewReads(page, ['(A B C)'], 'the preview: one card across the unknown block');
		const parts = await partsIn(page, 1440);
		assert.equal(parts[1]!.next, 'card', 'B is followed by C, with nothing between');
		// The editor still marks the unknown block: its amber line sits on the seam between B and C.
		const mark = page.frameLocator('#stage iframe[data-width="1440"]').locator('#cms-overlays .cms-skip[data-block="2"]');
		await eventually(() => mark.count(), 4000, 'the skipped mark');
		const top = await mark.evaluate((el) => parseFloat((el as HTMLElement).style.top) - el.ownerDocument.defaultView!.scrollY);
		assert.ok(Math.abs(top - parts[1]!.bottom) < 1, `the mark at B's bottom (${top} vs ${parts[1]!.bottom})`);
		await page.close();
	});
});
