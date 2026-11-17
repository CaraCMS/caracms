// M5a Phase 4 in a real browser: the new fields in the sidebar, on a throwaway copy
// of the demo under `astro dev` (helpers/dev-site.ts) with a test config of its own
// (one "kit" block holding every new field kind), so the demo's content isn't needed.
//
// - Rich text: Spec → Text's Enter table key for key, paste (plain text and HTML),
//   ⌘B, ⌘I, ⌘K (a document picked from the list stores its URL), typing `**`
//   stores escaped asterisks, and the file after each edit is Decision 3's format.
// - Rich text's list item is a textblock (on-page rich text, Decision 3): <li> holds its
//   text; the list buttons toggle; the style menu in an item lifts it; a pasted <li><p>.
// - A list row reordered with ⌥↓, removed, then Undone, comes back in place (Decision 14).
// - Clicking a list item's render in the preview opens its row and focuses its field (Decision 13).
// - A reference to a document that's gone is warned, and the picker sets one from Journal.
// - A number out of range is kept with the reason; half a button says it shows nothing.
//
//   node --test --experimental-strip-types test/fields.browser.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
let browser: Browser;

const FILE = 'content/pages/kit.json';

const CONFIG = `import { defineSite, buttons, date, link, list, number, reference, richText, text, toggle } from 'caracms/config';

export default defineSite({
	collections: {
		pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true },
		journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal/' },
	},
	blocks: {
		kit: {
			label: 'Kit',
			component: 'src/blocks/Kit.astro',
			fields: {
				heading: text({ heading: true }),
				body: richText({ headings: ['h2', 'h3'] }),
				cta: link(),
				buttons: buttons({ styles: ['primary', 'secondary'] }),
				featured: toggle(),
				count: number({ min: 1, max: 12 }),
				launched: date(),
				credits: list({ role: text(), name: text() }),
				tags: list(text()),
				related: reference({ to: 'journal' }),
			},
		},
	},
	textStyles: {},
	page: 'src/components/KitPage.astro',
	timeZone: 'Europe/Dublin',
});
`;

const KIT = `---
import Block from 'caracms/components/Block.astro';
import Buttons from 'caracms/components/Buttons.astro';
import Link from 'caracms/components/Link.astro';
import RichText from 'caracms/components/RichText.astro';
import Text from 'caracms/components/Text.astro';
const { block, cms } = Astro.props;
---
<Block cms={cms} class="kit">
	<Text cms={cms} field="heading" value={block.heading} />
	<RichText cms={cms} field="body" value={block.body} class="kit-body" />
	<Link cms={cms} field="cta" value={block.cta} />
	<Buttons cms={cms} field="buttons" value={block.buttons} />
	<ul class="credits">
		{block.credits.map((c, i) => (
			<li><Text cms={cms} field={\`credits.\${i}.role\`} value={c.role} as="span" /> <Text cms={cms} field={\`credits.\${i}.name\`} value={c.name} as="span" class="credit-name" /></li>
		))}
	</ul>
</Block>
<style>.kit { display: block; padding: 40px; } .credits li { padding: 12px 0; font-size: 20px; }</style>
`;

const PAGE = `---
import Blocks from 'caracms/components/Blocks.astro';
const { document, preview = false } = Astro.props;
---
<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>{document.title}</title></head>
<body><main><Blocks document={document} preview={preview} /></main></body></html>
`;

const CREDITS = [
	{ role: 'Identity', name: 'Aoife' },
	{ role: 'Photography', name: 'Dara' },
	{ role: 'Type', name: 'Niamh' },
];

const KIT_DOC = {
	title: 'Kit',
	blocks: [
		{
			type: 'kit',
			heading: 'The kit',
			body: [{ p: 'Start.' }],
			cta: { label: 'See the work', href: '/about' },
			buttons: [{ label: 'Start a project', href: '', style: 'primary' }],
			featured: false,
			count: 3,
			launched: '2024-05-02',
			credits: CREDITS,
			tags: ['one', 'two'],
			related: 'gone-post',
		},
	],
};

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
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

/** The kit block's stored value for a field, as the file has it. */
const stored = (field: string): unknown => (JSON.parse(site.read(FILE)) as { blocks: Record<string, unknown>[] }).blocks[0]![field];

async function fileHas(field: string, want: unknown, what: string) {
	await eventually(() => JSON.stringify(stored(field)) === JSON.stringify(want), 8000, `${what}: ${JSON.stringify(want)} (now ${JSON.stringify(stored(field))})`);
}

const BLOCK = '[data-pane-level="block"]';
const BODY = `${BLOCK} [data-rich-text="body"] .ProseMirror`;

/** Open the kit block's level from the document level. */
async function openKit(page: Page) {
	await page.click('[data-pane-level="document"] .blist .brow-main >> nth=0');
	await page.waitForSelector(BODY);
}

/** Empty the rich-text body and put the caret in it. */
async function clearBody(page: Page) {
	await page.click(BODY);
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Backspace');
}

/**
 * Wait for ProseMirror to have read the browser's selection in the sidebar's body: it reads a native
 * caret move (an arrow key, shift+arrows) on `selectionchange`, a task later, so a key or a toolbar
 * click straight after acts on the old caret. Never a fixed pause.
 */
async function caretRead(page: Page) {
	await eventually(
		() =>
			page.evaluate((selector) => {
				const el = document.querySelector(selector) as unknown as { editor: { view: { posAtDOM(n: Node, o: number): number }; state: { selection: { anchor: number; head: number } } } } | null;
				const s = document.getSelection();
				if (!el || !s?.anchorNode || !s.focusNode) return false;
				return el.editor.view.posAtDOM(s.anchorNode, s.anchorOffset) === el.editor.state.selection.anchor && el.editor.view.posAtDOM(s.focusNode, s.focusOffset) === el.editor.state.selection.head;
			}, BODY),
		5000,
		'ProseMirror to read the caret',
	);
}

/** Paste into the focused rich-text editor, as the browser would. */
async function paste(page: Page, data: Record<string, string>) {
	await page.evaluate((d) => {
		const target = document.activeElement!;
		const clipboardData = new DataTransfer();
		for (const [type, value] of Object.entries(d)) clipboardData.setData(type, value);
		target.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
	}, data);
}

describe('M5a fields in the editor', { skip: browserSkip }, () => {
	before(async () => {
		site = await startDevSite('fields', {
			edit(root) {
				writeFileSync(join(root, 'caracms.config.ts'), CONFIG);
				mkdirSync(join(root, 'src/blocks'), { recursive: true });
				writeFileSync(join(root, 'src/blocks/Kit.astro'), KIT);
				writeFileSync(join(root, 'src/components/KitPage.astro'), PAGE);
				writeFileSync(join(root, FILE), `${JSON.stringify(KIT_DOC, null, 2)}\n`);
			},
		});
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await site?.close();
	});

	test("rich text: Spec → Text's Enter table, key for key, written in Decision 3's format", async () => {
		const page = await open('/admin/pages/kit');
		await openKit(page);
		await clearBody(page);
		await fileHas('body', [], 'emptied');

		// A paragraph: Enter is a new paragraph, Shift+Enter a break in it.
		await page.keyboard.type('First para');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Second');
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.type('line');
		await page.keyboard.press('Enter');
		await fileHas('body', [{ p: 'First para' }, { p: 'Second\nline' }], 'paragraphs');

		// A heading (the style menu): Shift+Enter is a break and it stays one heading; Enter is a new paragraph after it.
		await page.click(`${BLOCK} [data-rich-text="body"] .tb-style`);
		await page.click(`${BLOCK} [data-rich-text="body"] .menu [role="menuitemradio"]:has-text("Heading 2")`);
		await page.keyboard.type('Head');
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.type('two');
		await page.keyboard.press('Enter');
		await page.keyboard.type('After');
		await fileHas('body', [{ p: 'First para' }, { p: 'Second\nline' }, { h2: 'Head\ntwo' }, { p: 'After' }], 'heading');
		assert.equal(await page.textContent(`${BLOCK} [data-rich-text="body"] .tb-style`), 'Paragraph', 'the block after the heading is a paragraph');

		// A list item: Enter is a new item, Shift+Enter a break in it; Enter in an empty item leaves the list (Google Docs).
		await page.keyboard.press('Enter');
		await page.click(`${BLOCK} [data-rich-text="body"] button[aria-label="Bulleted list"]`);
		await page.keyboard.type('One');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Two');
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.type('more');
		await page.keyboard.press('Enter');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Out');
		const listed = [{ p: 'First para' }, { p: 'Second\nline' }, { h2: 'Head\ntwo' }, { p: 'After' }, { ul: ['One', 'Two\nmore'] }, { p: 'Out' }];
		await fileHas('body', listed, 'list');

		// The file: one block per line, the heading as one h2 with \n (Decision 3 → On disk).
		const text = site.read(FILE);
		assert.ok(text.includes('"body": [\n        { "p": "First para" },\n        { "p": "Second\\nline" },\n        { "h2": "Head\\ntwo" },'), text);
		assert.ok(text.includes('{ "ul": ["One", "Two\\nmore"] },'), text);

		// The preview renders it: the heading's break is a <br>, still one h2.
		await eventually(
			() =>
				page.evaluate(() => {
					const doc = document.querySelector<HTMLIFrameElement>('#stage iframe[data-width="1440"]')!.contentDocument!;
					return doc.querySelector('[data-cms-field="body"] h2')?.innerHTML === 'Head<br>two';
				}),
			8000,
			'the preview’s h2',
		);
		await page.close();
	});

	test('rich text: ⌘B, ⌘I, typing ** stays two asterisks, ⌘K links a document picked from the list', async () => {
		const page = await open('/admin/pages/kit');
		await openKit(page);
		await clearBody(page);
		await page.keyboard.type('Plain ');
		await page.keyboard.press('ControlOrMeta+b');
		await page.keyboard.type('bold');
		await page.keyboard.press('ControlOrMeta+b');
		await page.keyboard.type(' and ');
		await page.keyboard.press('ControlOrMeta+i');
		await page.keyboard.type('it');
		await page.keyboard.press('ControlOrMeta+i');
		await page.keyboard.type(' with **stars** [x]');
		await fileHas('body', [{ p: 'Plain **bold** and *it* with \\*\\*stars\\*\\* \\[x\\]' }], 'marks and literal characters');

		// ⌘K on a selected word: the popover, not the document switcher; pick About from the list.
		await page.keyboard.press('Enter');
		await page.keyboard.type('See us');
		await page.keyboard.down('Shift');
		for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft');
		await page.keyboard.up('Shift');
		// ProseMirror reads the DOM selection on selectionchange, a task after the keys.
		await caretRead(page);
		await page.keyboard.press('ControlOrMeta+k');
		await page.waitForSelector(`${BLOCK} [data-rich-text="body"] .lpop [data-link-find]`);
		assert.equal(await page.isVisible('.pop.switcher'), false, '⌘K in rich text is the link, not the switcher');
		// An address that fails the link rule says the rule's message.
		await page.fill(`${BLOCK} .lpop [data-link-find]`, 'www.example.com');
		await page.waitForSelector(`${BLOCK} .lpop .field-warn`);
		assert.match((await page.textContent(`${BLOCK} .lpop .field-warn`))!, /Enter a path starting with "\/"/);
		await page.fill(`${BLOCK} .lpop [data-link-find]`, 'abou');
		await page.click(`${BLOCK} .lpop .drow[data-href="/about"]`);
		await fileHas('body', [{ p: 'Plain **bold** and *it* with \\*\\*stars\\*\\* \\[x\\]' }, { p: 'See [us](/about)' }], 'a link to a document');
		await page.close();
	});

	test('rich text: paste keeps only what the field allows; plain text paragraphs and breaks', async () => {
		const page = await open('/admin/pages/kit');
		await openKit(page);
		await clearBody(page);
		await paste(page, { 'text/plain': 'P1\nbreak\n\nP2' });
		await fileHas('body', [{ p: 'P1\nbreak' }, { p: 'P2' }], 'plain text');

		await clearBody(page);
		await fileHas('body', [], 'emptied again');
		await paste(page, {
			'text/plain': 'ignored',
			'text/html': '<h1>Big</h1><p>x <u>u</u> <a href="/about">a</a> <code>c</code></p><h4>four</h4><img src="/x.png"><ul><li>i<ul><li>nested</li></ul></li></ul>',
		});
		await eventually(() => Array.isArray(stored('body')) && (stored('body') as unknown[]).length > 0, 8000, 'the paste');
		const body = stored('body') as Record<string, unknown>[];
		const kinds = body.map((b) => Object.keys(b)[0]);
		assert.ok(kinds.every((k) => ['p', 'h2', 'h3', 'ul', 'ol'].includes(k!)), `only allowed kinds: ${JSON.stringify(body)}`);
		const all = JSON.stringify(body);
		assert.ok(all.includes('Big') && all.includes('four') && all.includes('nested'), `the words are kept: ${all}`);
		assert.ok(all.includes('[a](/about)'), `the link is kept: ${all}`);
		assert.ok(!/<|u>|`/.test(all), `no markup that isn't the field's: ${all}`);
		await page.close();
	});

	// On-page rich text, Phase 2 (Decision 3): the list item is a textblock, so the editor's DOM is the render's.
	test('rich text: a list item holds its text (<li>One</li>); the list buttons toggle; the style menu in an item lifts it', async () => {
		const page = await open('/admin/pages/kit');
		await openKit(page);
		await clearBody(page);
		const items = () => page.$$eval(`${BODY} > ul > li, ${BODY} > ol > li`, (els) => els.map((e) => e.innerHTML));
		const shape = () => page.$eval(BODY, (el) => [...el.children].map((c) => c.tagName.toLowerCase()).join(' '));

		// A paragraph to a list with the toolbar, then two items: <ul><li>One</li><li>Two</li></ul>, no <p> inside.
		await page.keyboard.type('One');
		await page.click(`${BLOCK} [data-rich-text="body"] button[aria-label="Bulleted list"]`);
		await page.keyboard.press('Enter');
		await page.keyboard.type('Two');
		await fileHas('body', [{ ul: ['One', 'Two'] }], 'a list from the toolbar');
		assert.deepEqual(await items(), ['One', 'Two']);
		assert.equal(await page.$(`${BODY} li p`), null, 'no <p> in an item');
		assert.equal(await page.getAttribute(`${BLOCK} [data-rich-text="body"] button[aria-label="Bulleted list"]`, 'aria-pressed'), 'true');

		// Bulleted to numbered, and back off to paragraphs (just the item the caret is in).
		await page.click(`${BLOCK} [data-rich-text="body"] button[aria-label="Numbered list"]`);
		await fileHas('body', [{ ol: ['One', 'Two'] }], 'numbered');
		await page.click(`${BLOCK} [data-rich-text="body"] button[aria-label="Numbered list"]`);
		await fileHas('body', [{ ol: ['One'] }, { p: 'Two' }], 'the item out of the list');
		await page.click(`${BLOCK} [data-rich-text="body"] button[aria-label="Numbered list"]`);
		await fileHas('body', [{ ol: ['One', 'Two'] }], 'back in, joined to the list above');

		// Three items; the style menu on the middle one: a heading, the list split around it.
		await page.keyboard.press('Enter');
		await page.keyboard.type('Three');
		await page.keyboard.press('ArrowUp');
		await caretRead(page);
		await page.click(`${BLOCK} [data-rich-text="body"] .tb-style`);
		await page.click(`${BLOCK} [data-rich-text="body"] .menu [role="menuitemradio"]:has-text("Heading 2")`);
		await fileHas('body', [{ ol: ['One'] }, { h2: 'Two' }, { ol: ['Three'] }], 'the style menu in an item');
		assert.equal(await shape(), 'ol h2 ol');
		assert.equal(await page.textContent(`${BLOCK} [data-rich-text="body"] .tb-style`), 'Heading 2');

		// Backspace at the start of the first item lifts just it.
		await clearBody(page);
		await page.keyboard.type('A');
		await page.click(`${BLOCK} [data-rich-text="body"] button[aria-label="Bulleted list"]`);
		await page.keyboard.press('Enter');
		await page.keyboard.type('B');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('ArrowLeft');
		// ProseMirror reads the DOM selection on selectionchange, a task after the keys.
		await caretRead(page);
		await page.keyboard.press('Backspace');
		await fileHas('body', [{ p: 'A' }, { ul: ['B'] }], 'Backspace at the first item');
		await page.close();
	});

	test("rich text: a pasted list whose items hold paragraphs (Google Docs, a web page) gives items of text", async () => {
		const page = await open('/admin/pages/kit');
		await openKit(page);
		await clearBody(page);
		await fileHas('body', [], 'emptied');
		await paste(page, {
			'text/plain': 'ignored',
			'text/html': '<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-x"><ul><li dir="ltr"><p dir="ltr"><span>One </span><span style="font-weight:700">bold</span></p></li><li><p>Two</p><ul><li><p>nested</p></li></ul></li></ul><p>After</p></b>',
		});
		await fileHas('body', [{ ul: ['One **bold**', 'Two'] }, { ul: ['nested'] }, { p: 'After' }], 'the pasted list');
		assert.equal(await page.$(`${BODY} li p`), null, 'no <p> in an item');
		await page.close();
	});

	test('a list row reordered with ⌥↓, removed, then Undone comes back in place; a preview click opens its row', async () => {
		const page = await open('/admin/pages/kit');
		await openKit(page);
		const rows = `${BLOCK} [data-list="credits"] .item-sum`;
		assert.deepEqual(await page.$$eval(rows, (els) => els.map((e) => e.querySelector('.s')!.textContent)), ['Identity · Aoife', 'Photography · Dara', 'Type · Niamh']);

		await page.focus(`${rows} >> nth=0`);
		await page.keyboard.press('Alt+ArrowDown');
		await fileHas('credits', [CREDITS[1], CREDITS[0], CREDITS[2]], 'moved down');
		assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-row]')?.getAttribute('data-row')), '1', 'focus moves with the row');

		await page.keyboard.press('Backspace');
		await fileHas('credits', [CREDITS[1], CREDITS[2]], 'removed');
		assert.match((await page.textContent('#toast-root .toast'))!, /Removed credit: Identity/);
		await page.keyboard.press('ControlOrMeta+z');
		await fileHas('credits', [CREDITS[1], CREDITS[0], CREDITS[2]], 'undone, in place');
		// The file: one item per object, keys in schema order.
		assert.ok(site.read(FILE).includes('"credits": [\n        {\n          "role": "Photography",\n          "name": "Dara"\n        },'), site.read(FILE));

		// Click a credit's name in the preview: the credits field opens that row and focuses the name (Decision 13).
		const frame = page.frameLocator('#stage iframe[data-width="1440"]');
		await frame.locator('[data-cms-field="credits.2.name"]').click();
		await eventually(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.path === 'credits.2.name'), 4000, 'the name focused');
		assert.equal(await page.getAttribute(`${BLOCK} [data-list="credits"] [data-row="2"]`, 'class').then((c) => /is-open/.test(c ?? '')), true);
		assert.match((await page.getAttribute(`${BLOCK} .field-frame[data-ff="credits"]`, 'class'))!, /is-picked/);
		await page.close();
	});

	test('a reference: a missing one is warned; the picker sets one from Journal', async () => {
		const page = await open('/admin/pages/kit');
		await openKit(page);
		const frame = `${BLOCK} .field-frame[data-ff="related"]`;
		await page.waitForSelector(`${frame} .ref.is-missing`);
		assert.match((await page.textContent(`${frame} .field-warn`))!, /"gone-post", which isn't in Journal any more/);
		await page.click(`${frame} button[data-path="related"]`);
		await page.fill(`${frame} [data-ref-find]`, 'ridge');
		await page.click(`${frame} .drow[data-path-pick="notes-from-the-ridge"]`);
		await fileHas('related', 'notes-from-the-ridge', 'picked');
		await page.waitForSelector(`${frame} .ref:not(.is-missing)`);
		assert.equal(await page.isVisible(`${frame} .field-warn`), false);
		await page.close();
	});

	test('a number out of range is kept with the reason; half a button says it shows nothing; toggle and date store their values', async () => {
		const page = await open('/admin/pages/kit');
		await openKit(page);
		assert.match((await page.textContent(`${BLOCK} [data-ff="buttons"] .btnf.is-half .field-warn`))!, /Button 1 has no link/);

		await page.fill(`${BLOCK} [data-ff="count"] input`, '14');
		await fileHas('count', 14, 'kept as typed');
		assert.match((await page.textContent(`${BLOCK} [data-ff="count"] .field-warn`))!, /between 1 and 12/);
		await page.fill(`${BLOCK} [data-ff="count"] input`, '');
		await fileHas('count', null, 'cleared');

		await page.click(`${BLOCK} [data-ff="featured"] .switch`);
		await fileHas('featured', true, 'toggled');
		await page.fill(`${BLOCK} [data-ff="launched"] input`, '2026-10-15');
		await page.press(`${BLOCK} [data-ff="launched"] input`, 'Enter');
		await fileHas('launched', '2026-10-15', 'dated');
		await page.close();
	});

	test('the date: typed day first, picked from the calendar by keyboard, cleared; one it can\'t read is kept with a warning until Esc', async () => {
		const page = await open('/admin/pages/kit');
		await openKit(page);
		const date = `${BLOCK} [data-ff="launched"]`;
		// Typed: day first, kept on Enter, shown in words.
		await page.fill(`${date} input`, '15/10/2026');
		await page.press(`${date} input`, 'Enter');
		await fileHas('launched', '2026-10-15', 'typed');
		assert.equal(await page.inputValue(`${date} input`), '15 October 2026');
		// Not a day: kept in the box with a warning, the file unchanged; Esc puts the day back, and stays on the level.
		await page.fill(`${date} input`, '31/2/2026');
		await page.press(`${date} input`, 'Enter');
		assert.match((await page.textContent(`${date} .field-warn`))!, /Not a day/);
		assert.equal(await page.getAttribute(`${date} input`, 'aria-invalid'), 'true');
		await page.press(`${date} input`, 'Escape');
		assert.equal(await page.inputValue(`${date} input`), '15 October 2026');
		assert.equal(await page.locator(`${date} .field-warn`).count(), 0);
		await page.waitForSelector('[data-pane-level="block"]');
		// The calendar: opens on the day, focused; arrows move, Enter picks and closes it.
		await page.click(`${date} button[aria-haspopup="dialog"]`);
		await page.waitForSelector(`${date} .cal [role="grid"][aria-label="October 2026"]`);
		assert.match((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ?? '', /October 15th, 2026/);
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('Enter');
		await fileHas('launched', '2026-10-16', 'picked');
		assert.equal(await page.locator(`${date} .cal`).count(), 0);
		// Esc closes it without leaving the level; Clear empties the field.
		await page.click(`${date} button[aria-haspopup="dialog"]`);
		await page.waitForSelector(`${date} .cal`);
		await page.keyboard.press('Escape');
		assert.equal(await page.locator(`${date} .cal`).count(), 0);
		await page.waitForSelector('[data-pane-level="block"]');
		await page.click(`${date} button[aria-haspopup="dialog"]`);
		await page.click(`${date} .cal-f .linkbtn`);
		await fileHas('launched', null, 'cleared');
		assert.equal(await page.inputValue(`${date} input`), '');
		await page.close();
	});
});
