// M6c G4 in a real browser: files in the library
// and in links, on a throwaway copy of the demo under `astro dev` with the in-memory bucket
// (CARACMS_MEDIA=memory), and the test-only port site (helpers/port-site.ts: the text block
// gets an address-only `link()` field, `more`). Nothing reaches the real bucket.
//
// 1. Acceptance 13: upload a PDF and a .docx in the library; the Files tab lists them with
//    type, name and size; a file's own level gives its address.
// 2. Acceptance 11: a link field's File… opens the library on Files; picking the PDF stores
//    its address, and Download stores `?download`. A button's File… with the .docx stores
//    its address and shows "Downloads", no toggle. Rich text's File… in the sidebar links
//    the selected words to the PDF.
// 3. Acceptance 14: a /files/ address whose key isn't in the library says so.
// 4. Acceptance 15: Replace… the PDF with another: both links move, ?download kept.
// 5. Decision 9: Replace refuses only the old file itself; a file already in the library
//    (a retry's new bytes) can be used to replace.
// 6. Acceptance 16: Replace refuses while this tab holds unsent edits (a write that can't
//    reach the server), says so, and changes no document.
// 7. Acceptance 11, on the page: rich text typed in the preview links a selected word to a
//    file from the link popover's File… (the sidebar's half is test 2).
//
//   node --test --experimental-strip-types test/files.browser.test.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { fileAddress } from '../src/files.ts';
import { browserSkip, startDevSite, type DevSite } from './helpers/dev-site.ts';
import { edit } from './helpers/port-site.ts';
import { charPoint, fieldState, revealBody } from './helpers/rich-on-page.ts';

let site: DevSite;
let browser: Browser;

const FILE = 'content/pages/about.json';
const DOC = '[data-pane-level="document"]';
const BLOCK = '[data-pane-level="block"]';
const SIDE = '#side';

const pdf = (tag: string) => Buffer.from(`%PDF-1.7\n%${tag}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
/** A .docx's bytes: a zip holding [Content_Types].xml and a word/ part (stored, no CRCs: the sniffer reads the directory). */
function docx(): Buffer {
	const le16 = (n: number) => [n & 255, (n >> 8) & 255];
	const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
	const entries: [string, string][] = [
		['[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
		['word/document.xml', '<w:document/>'],
	];
	const locals: number[] = [];
	const central: number[] = [];
	for (const [name, body] of entries) {
		const n = [...Buffer.from(name)];
		const data = [...Buffer.from(body)];
		const offset = locals.length;
		locals.push(...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(n.length), ...le16(0), ...n, ...data);
		central.push(...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(n.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...n);
	}
	return Buffer.from([...locals, ...central, ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(2), ...le16(2), ...le32(central.length), ...le32(locals.length), ...le16(0)]);
}
const keyOf = (bytes: Buffer, name: string) => `uploads/${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}/${name}`;

const RULES = pdf('rules');
const RULES_V2 = pdf('rules v2');
const BRIEF = docx();
const RULES_KEY = keyOf(RULES, 'rule-book.pdf');
const RULES_V2_KEY = keyOf(RULES_V2, 'rule-book-v2.pdf');
const BRIEF_KEY = keyOf(BRIEF, 'brief.docx');

async function open(path: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on('pageerror', (error) => console.error('[page]', error.message));
	await page.goto(site.origin + path);
	await page.waitForSelector('#stage[data-painted="true"]', { timeout: 20000 });
	return page;
}

async function eventually<T>(check: () => T | Promise<T>, timeout = 10000, what = 'the condition'): Promise<T> {
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

const blocks = () => (JSON.parse(site.read(FILE)) as { blocks: Record<string, unknown>[] }).blocks;

/** Open About's block `index` from the document level. */
async function openBlock(page: Page, index: number) {
	if (!(await page.isVisible(DOC))) await page.click(`${SIDE} .lv >> nth=-1`);
	await page.click(`${DOC} .blist .brow-main >> nth=${index}`);
	await page.waitForSelector(`${BLOCK} .field-frame`);
}

async function library(page: Page) {
	await page.click(`${SIDE} .lv >> nth=0`);
	await page.click(`${SIDE} .media-row`);
	await page.waitForSelector(`${SIDE} [data-media-mode="browse"]`);
}

describe('files in the library and in links (M6c G4)', { skip: browserSkip }, () => {
	before(async () => {
		process.env.CARACMS_MEDIA = 'memory';
		memoryMedia().reset();
		site = await startDevSite('files', { edit });
		browser = await chromium.launch();
	});

	after(async () => {
		await browser?.close();
		await site?.close();
		memoryMedia().reset();
		delete process.env.CARACMS_MEDIA;
	});

	test('Acceptance 13: a PDF and a .docx uploaded in the library show on Files with type, name and size; a file’s level gives its address', async () => {
		const page = await open('/admin/pages/about');
		await library(page);
		await page.locator(`${SIDE} [data-lib-file]`).first().setInputFiles([
			{ name: 'Rule Book.pdf', mimeType: 'application/pdf', buffer: RULES },
			{ name: 'Brief.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: BRIEF },
		]);
		// A file uploaded from Images switches the library to Files.
		await page.waitForSelector(`${SIDE} .lib-bar [data-v="files"][aria-checked="true"]`);
		await page.waitForSelector(`${SIDE} .flist .frow[data-file="${RULES_KEY}"]`);
		await page.waitForSelector(`${SIDE} .flist .frow[data-file="${BRIEF_KEY}"]`);
		const row = (await page.textContent(`${SIDE} .frow[data-file="${RULES_KEY}"]`))!;
		assert.match(row, /Rule Book\.pdf/);
		assert.match(row, /PDF · \d+ bytes · .* · Just uploaded/);
		assert.match((await page.textContent(`${SIDE} .frow[data-file="${BRIEF_KEY}"]`))!, /Brief\.docx.*Word/);
		await page.click(`${SIDE} .frow[data-file="${RULES_KEY}"]`);
		await page.waitForSelector(`${SIDE} [data-file-level]`);
		assert.equal((await page.textContent(`${SIDE} [data-file-address]`))!.trim(), fileAddress(RULES_KEY));
		assert.match((await page.textContent(`${SIDE} [data-file-level]`))!, /Nothing links to it/);
		await page.waitForSelector('[data-file-stage] .ftype.lg');
		await page.close();
	});

	test('Acceptance 11: File… in a link field, a button and rich text: the address stored, Download adds ?download, a .docx says it downloads', async () => {
		const page = await open('/admin/pages/about');
		// The text block's address-only link (port-site.ts): File… → the library on Files only → the PDF.
		await openBlock(page, 1);
		await page.click(`${BLOCK} [data-link-path="more.href"] ~ [data-act="link-file"]`);
		await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		assert.match((await page.textContent(`${SIDE} [data-pane-level="media"] .cur`))!, /Choose a file/);
		assert.equal(await page.locator(`${SIDE} .lib-bar [role="radio"]`).count(), 0, 'Files only: no tabs');
		await page.click(`${SIDE} .frow[data-file="${RULES_KEY}"]`);
		await page.waitForSelector(`${BLOCK} [data-link-file="${RULES_KEY}"]`);
		await eventually(() => (blocks()[1]!.more as { href: string } | undefined)?.href === fileAddress(RULES_KEY), 10000, 'the PDF’s address in the link');
		await page.click(`${BLOCK} .opens [data-opens="download"]`);
		await eventually(() => (blocks()[1]!.more as { href: string }).href === `${fileAddress(RULES_KEY)}?download`, 10000, '?download');

		// Rich text in the sidebar: select a word, the link popover, File…, the PDF.
		// Double-click selects a word ("team"); ⌘K opens the popover on it.
		await page.locator(`${BLOCK} [data-rich-text="body"] .ProseMirror`).dblclick({ position: { x: 40, y: 10 } });
		await page.waitForTimeout(150);
		await page.keyboard.press('ControlOrMeta+k');
		await page.click(`${BLOCK} .lpop [data-act="link-file"]`);
		await page.click(`${BLOCK} .lpop [data-file="${RULES_KEY}"]`);
		await page.waitForSelector(`${BLOCK} .lpop [data-picked-file="${RULES_KEY}"]`);
		await eventually(() => /\]\(\/files\//.test(JSON.stringify(blocks()[1]!.body)) && JSON.stringify(blocks()[1]!.body).includes(`](${fileAddress(RULES_KEY)})`), 10000, 'the words linked to the PDF');

		// The hero's buttons: a button to the .docx downloads, with no toggle.
		await openBlock(page, 0);
		await page.click(`${BLOCK} button:has-text("Add a button")`);
		await page.click(`${BLOCK} [data-link-path="buttons.0.href"] ~ [data-act="link-file"]`);
		await page.waitForSelector(`${SIDE} [data-media-mode="pick"]`);
		await page.click(`${SIDE} .frow[data-file="${BRIEF_KEY}"]`);
		await page.waitForSelector(`${BLOCK} .dl-note`);
		assert.match((await page.textContent(`${BLOCK} .dl-note`))!, /Downloads\. A Word file doesn’t open in the browser/);
		assert.equal(await page.locator(`${BLOCK} [data-link-file="${BRIEF_KEY}"] ~ .opens`).count(), 0);
		await eventually(() => JSON.stringify(blocks()[0]!.buttons ?? []).includes(fileAddress(BRIEF_KEY)), 10000, 'the .docx’s address in the button');
		await page.close();
	});

	test('Acceptance 14: a /files/ address whose file isn’t in the library says so', async () => {
		const missing = 'uploads/9b1e04c7a2f3/last-year.pdf';
		const doc = JSON.parse(site.read(FILE)) as { blocks: Record<string, unknown>[] };
		doc.blocks[1]!.more = { label: '', href: fileAddress(missing) };
		site.write(FILE, `${JSON.stringify(doc, null, 2)}\n`);
		const page = await open('/admin/pages/about');
		await openBlock(page, 1);
		await page.waitForSelector(`${BLOCK} .lnk.is-missing`);
		assert.match((await page.textContent(`${BLOCK} [data-field="more"], ${BLOCK} .field-frame:has([data-link-path="more.href"])`))!, /There's no file at \/files\/9b1e04c7a2f3\/last-year\.pdf in the library/);
		// Put the PDF back for Replace.
		doc.blocks[1]!.more = { label: '', href: `${fileAddress(RULES_KEY)}?download` };
		site.write(FILE, `${JSON.stringify(doc, null, 2)}\n`);
		await page.close();
	});

	test('Acceptance 15: Replace… the PDF: both links move to the new file, ?download kept; the old file stays', async () => {
		const page = await open('/admin/pages/about');
		await library(page);
		await page.click(`${SIDE} .lib-bar [data-v="files"]`);
		await page.click(`${SIDE} .frow[data-file="${RULES_KEY}"]`);
		await page.waitForSelector(`${SIDE} [data-file-level]`);
		await eventually(async () => /Linked from 1/.test((await page.textContent(`${SIDE} [data-file-level]`)) ?? ''), 10000, 'Linked from 1');
		await page.click(`${SIDE} [data-act="file-replace"]`);
		await page.waitForSelector('[data-dialog="replace"]');
		await page.locator('[data-dialog="replace"] [data-replace-file]').setInputFiles([{ name: 'Rule Book v2.pdf', mimeType: 'application/pdf', buffer: RULES_V2 }]);
		await page.waitForSelector('[data-dialog="replace"] [data-act="replace-go"]:not([disabled])');
		assert.match((await page.textContent('[data-dialog="replace"] .affects'))!, /Updates 2 links in 1 document/);
		await page.click('[data-dialog="replace"] [data-act="replace-go"]');
		await page.waitForSelector('[data-dialog="replace-done"]');
		const about = blocks()[1]!;
		assert.equal((about.more as { href: string }).href, `${fileAddress(RULES_V2_KEY)}?download`, '?download kept');
		assert.ok(JSON.stringify(about.body).includes(`](${fileAddress(RULES_V2_KEY)})`), 'the rich-text link moved');
		assert.ok(memoryMedia().bucket.objects.has(RULES_KEY), 'the old file stays');
		await page.close();
	});

	test('Decision 9: re-uploading the old file itself is refused; a file already in the library (not the old one) can replace it', async () => {
		const page = await open('/admin/pages/about');
		await library(page);
		await page.click(`${SIDE} .lib-bar [data-v="files"]`);
		await page.click(`${SIDE} .frow[data-file="${RULES_V2_KEY}"]`);
		await page.waitForSelector(`${SIDE} [data-file-level]`);
		await eventually(async () => /Linked from 1/.test((await page.textContent(`${SIDE} [data-file-level]`)) ?? ''), 10000, 'Linked from 1');
		await page.click(`${SIDE} [data-act="file-replace"]`);
		await page.waitForSelector('[data-dialog="replace"]');
		const dialog = '[data-dialog="replace"]';
		// The old file itself: nothing to replace.
		await page.locator(`${dialog} [data-replace-file]`).setInputFiles([{ name: 'Rule Book v2.pdf', mimeType: 'application/pdf', buffer: RULES_V2 }]);
		await page.waitForSelector(`${dialog} [data-replace-same]`);
		assert.equal(await page.locator(`${dialog} [data-act="replace-go"]`).count(), 0, 'no Replace button to press');
		assert.equal(await page.locator(`${dialog} .acts .btn.ink`).isDisabled(), true);
		// The first PDF's bytes are already in the library (created: false), and aren't the old file: Replace goes ahead.
		await page.locator(`${dialog} [data-replace-file]`).setInputFiles([{ name: 'Rule Book.pdf', mimeType: 'application/pdf', buffer: RULES }]);
		await page.waitForSelector(`${dialog} [data-act="replace-go"]:not([disabled])`);
		assert.equal(await page.locator(`${dialog} [data-replace-same]`).count(), 0);
		await page.click(`${dialog} [data-act="replace-go"]`);
		await page.waitForSelector('[data-dialog="replace-done"]');
		const about = blocks()[1]!;
		assert.equal((about.more as { href: string }).href, `${fileAddress(RULES_KEY)}?download`, 'the links moved back to the existing file, ?download kept');
		assert.ok(JSON.stringify(about.body).includes(`](${fileAddress(RULES_KEY)})`), 'the rich-text link moved too');
		assert.ok(memoryMedia().bucket.objects.has(RULES_V2_KEY), 'the old file stays');
		await page.close();
	});

	test('Acceptance 16: Replace refuses while this tab holds unsent edits, says so, and changes no document', async () => {
		const page = await open('/admin/pages/about');
		const before = site.read(FILE);
		// Writes can't reach the server: an edit stays in this tab, unsent.
		await page.route('**/_caracms/write', (route) => route.abort());
		const seo = page.locator(`${DOC} details.seo`);
		await seo.waitFor();
		await seo.locator('summary').click();
		await page.locator(`${DOC} details.seo input[data-path="title"]`).fill('An edit that never reaches the server');
		await page.waitForSelector('[data-keep="offline"]', { timeout: 15000 }); // the bar can't keep it

		await library(page);
		await page.click(`${SIDE} .lib-bar [data-v="files"]`);
		await page.click(`${SIDE} .frow[data-file="${RULES_KEY}"]`);
		await page.waitForSelector(`${SIDE} [data-file-level]`);
		await eventually(async () => /Linked from 1/.test((await page.textContent(`${SIDE} [data-file-level]`)) ?? ''), 10000, 'Linked from 1');
		await page.click(`${SIDE} [data-act="file-replace"]`);
		await page.waitForSelector('[data-dialog="replace"]');
		await page.locator('[data-dialog="replace"] [data-replace-file]').setInputFiles([{ name: 'Rule Book v2.pdf', mimeType: 'application/pdf', buffer: RULES_V2 }]);
		await page.waitForSelector('[data-dialog="replace"] [data-act="replace-go"]:not([disabled])');
		await page.click('[data-dialog="replace"] [data-act="replace-go"]');
		const blocked = await page.waitForSelector('[data-dialog="replace"] [data-replace-blocked]', { timeout: 15000 });
		assert.match((await blocked.textContent())!, /haven.t reached the server yet/);
		assert.equal(await page.locator('[data-dialog="replace-done"]').count(), 0, 'Replace did not go ahead');
		assert.equal(await page.locator('[data-dialog="replace"] [data-act="replace-go"]').isDisabled(), true, 'and the button waits');
		assert.equal(site.read(FILE), before, 'no document changed');
		await page.unroute('**/_caracms/write');
		await page.close();
	});

	test('Acceptance 11 (on the page): the link popover’s File… links a selected word to the PDF, and Download adds ?download', async () => {
		const page = await open('/admin/pages/about');
		const frame = page.frameLocator('.frame.on iframe');
		const bar = (selector: string) => frame.locator(`#cms-overlays ${selector}`);
		await revealBody(page);
		const at = await charPoint(page, 'launch', 2);
		await page.mouse.move(at.x, at.y);
		await eventually(async () => (await fieldState(page)).mounted, 5000, 'the page editor on hover');
		await page.mouse.click(at.x, at.y);
		await page.waitForSelector(`${BLOCK} .field-frame.is-picked[data-ff="body"]`);
		await page.waitForTimeout(700); // apart from the click above, or the double-click is a triple
		const word = await charPoint(page, 'launch', 1);
		await page.mouse.dblclick(word.x, word.y);
		await eventually(async () => {
			const sel = (await fieldState(page)).selection;
			return !!sel && sel.head - sel.anchor === 'launch'.length;
		}, 5000, '"launch" selected').catch(async (e) => {
			throw new Error(`${e.message}: ${JSON.stringify(await fieldState(page))}`);
		});
		await page.keyboard.press('ControlOrMeta+k');
		await bar('.cms-lpop [data-files]').click();
		await bar(`.cms-lpop .drow[data-file="${RULES_KEY}"]`).click();
		await bar(`.cms-lpop [data-picked-file="${RULES_KEY}"]`).waitFor();
		await eventually(() => JSON.stringify(blocks()[1]!.body).includes(`[launch](${fileAddress(RULES_KEY)})`), 10000, 'the word linked to the PDF in the file');
		await bar('.cms-lpop [data-opens="download"]').click();
		await eventually(() => JSON.stringify(blocks()[1]!.body).includes(`[launch](${fileAddress(RULES_KEY)}?download)`), 10000, '?download in the file');
		await page.close();
	});
});
