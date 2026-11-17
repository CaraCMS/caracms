// M6c G4: files in the library, on the memory
// bucket (`CARACMS_MEDIA=memory`), never the real one. Decision 1's sniffing (Acceptance 1–3),
// the listing's file entries with what links to them by schema (Decision 8, Acceptance 13),
// and Replace… in both stores (Decision 9, Acceptance 15–16).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { after, beforeEach, describe, test } from 'node:test';
import { buttons, defineSite, link, list, media, resolveSite, richText, text, type SiteConfig } from '../src/config.ts';
import { localDraftsStore } from '../src/editor/server/drafts-store.ts';
import { handleMedia, type MediaContext } from '../src/editor/server/media/handler.ts';
import { mediaUses } from '../src/editor/server/media/library.ts';
import { memoryMedia } from '../src/editor/server/media/memory.ts';
import { sniffUpload } from '../src/editor/server/media/sniff.ts';
import type { MediaFileUploadResponse, MediaImagesResponse } from '../src/editor/types.ts';
import { MEDIA_NAME_HEADER } from '../src/editor/types.ts';
import { fileAddress } from '../src/files.ts';
import { handleFileRequest } from '../src/files-route.ts';
import { memoryLimiter } from '../src/forms/rate-limit.ts';
import { fileLinksIn, refileText } from '../src/relink.ts';

// ── Bytes ─────────────────────────────────────────────────────────────────────

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

/** A zip of `entries` (name → text), each stored, or deflated when `deflate` names it. No CRCs: the sniffer never checks them. */
function zip(entries: Record<string, string>, deflate: string[] = []): Uint8Array {
	const locals: number[] = [];
	const central: number[] = [];
	for (const [name, body] of Object.entries(entries)) {
		const raw = utf8(body);
		const data = deflate.includes(name) ? new Uint8Array(deflateRawSync(raw)) : raw;
		const method = deflate.includes(name) ? 8 : 0;
		const n = ascii(name);
		const offset = locals.length;
		locals.push(...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(method), ...le16(0), ...le16(0), ...le32(0), ...le32(data.length), ...le32(raw.length), ...le16(n.length), ...le16(0), ...n, ...data);
		central.push(...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(method), ...le16(0), ...le16(0), ...le32(0), ...le32(data.length), ...le32(raw.length), ...le16(n.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...n);
	}
	const count = Object.keys(entries).length;
	const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(count), ...le16(count), ...le32(central.length), ...le32(locals.length), ...le16(0)];
	return Uint8Array.from([...locals, ...central, ...eocd]);
}
const contentTypes = (main: string) => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/x" ContentType="${main}"/></Types>`;
const docx = (tag = '') => zip({ '[Content_Types].xml': contentTypes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'), 'word/document.xml': `<w:document>${tag}</w:document>` }, ['[Content_Types].xml']);
const xlsx = () => zip({ '[Content_Types].xml': contentTypes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'), 'xl/workbook.xml': '<workbook/>' });
const pptx = () => zip({ '[Content_Types].xml': contentTypes('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'), 'ppt/presentation.xml': '<p/>' });
const xlsm = () => zip({ '[Content_Types].xml': contentTypes('application/vnd.ms-excel.sheet.macroEnabled.main+xml'), 'xl/workbook.xml': '<workbook/>' }, ['[Content_Types].xml']);
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ole = (tag = '') => Uint8Array.from([...OLE, ...ascii(`legacy office ${tag}`)]);
const pdf = (tag = '') => ascii(`%PDF-1.7\n%${tag}\n1 0 obj\n`);

describe('Decision 1: files by their bytes', () => {
	test('Acceptance 1: PDF, Word, Excel, PowerPoint, legacy Office, CSV and Zip each sniff to their table type', () => {
		const ext = (bytes: Uint8Array, name: string) => {
			const r = sniffUpload(bytes, name);
			return r.ok ? r.ext : `refused: ${r.code}`;
		};
		assert.equal(ext(pdf(), 'rulebook.pdf'), 'pdf');
		assert.equal(ext(docx(), 'brief.docx'), 'docx', 'a deflated [Content_Types].xml is read');
		assert.equal(ext(xlsx(), 'timeline.xlsx'), 'xlsx');
		assert.equal(ext(pptx(), 'deck.pptx'), 'pptx');
		assert.equal(ext(ole(), 'terms.doc'), 'doc');
		assert.equal(ext(ole(), 'sheet.XLS'), 'xls');
		assert.equal(ext(ole(), 'slides.ppt'), 'ppt');
		assert.equal(ext(utf8('name,email\nAoife,a@example.com\n'), 'signups.csv'), 'csv');
		assert.equal(ext(utf8('﻿café,crème\n'), 'menu.csv'), 'csv', 'a BOM and accents are still text');
		assert.equal(ext(zip({ 'a.txt': 'hello' }), 'press-kit.zip'), 'zip');
		const r = sniffUpload(pdf(), 'x.pdf');
		assert.deepEqual(r.ok && { mime: r.mime, label: r.format === 'file' ? r.type.label : null }, { mime: 'application/pdf', label: 'PDF' });
	});

	test('Acceptance 2: the bytes win over the name; a binary called .csv, a program and a macro-enabled file are refused with a sentence', () => {
		const as = sniffUpload(pdf(), 'x.docx');
		assert.equal(as.ok && as.ext, 'pdf', 'a PDF called .docx is a PDF');
		assert.equal((sniffUpload(docx(), 'x.zip') as { ext: string }).ext, 'docx', 'a .docx called .zip is Word');
		const binary = sniffUpload(Uint8Array.from([1, 2, 0, 3, 4]), 'x.csv');
		assert.deepEqual(!binary.ok && binary.code, 'not-a-csv');
		assert.match(!binary.ok ? binary.message : '', /Not plain-text CSV/);
		const latin1 = sniffUpload(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), 'x.csv');
		assert.equal(!latin1.ok && latin1.code, 'not-a-csv', 'not valid UTF-8');
		assert.equal((sniffUpload(utf8('just,text'), 'notes.txt') as { code: string }).code, 'unknown-type', 'text is a CSV only when it is called one');
		const exe = sniffUpload(ascii('MZ\x90\x00'), 'setup.exe');
		assert.equal(!exe.ok && exe.message, 'This is a program. The library takes images (JPEG, PNG, WebP, AVIF, HEIC, GIF or SVG) and files (PDF, Word, Excel, PowerPoint, CSV or Zip).');
		assert.equal((sniffUpload(ascii('\x7fELF\x02\x01'), 'run') as { message: string }).message.startsWith('This is a program.'), true);
		const macro = sniffUpload(xlsm(), 'budget-tracker.xlsm');
		assert.deepEqual(!macro.ok && macro, { ok: false, code: 'macro-enabled', message: 'This Excel file has macros, which the library doesn’t take. Save it as an ordinary Excel workbook (.xlsx) and upload that.' });
		const docm = sniffUpload(zip({ '[Content_Types].xml': contentTypes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'), 'word/document.xml': '<d/>', 'word/vbaProject.bin': 'x' }), 'letter.docx');
		assert.equal(!docm.ok && docm.code, 'macro-enabled', 'a vbaProject.bin is macros too');
		assert.equal((sniffUpload(ole(), 'installer.msi') as { code: string }).code, 'unnamed-office');
		assert.equal((sniffUpload(ascii('PK\x03\x04truncated'), 'broken.zip') as { code: string }).code, 'unknown-type', 'a zip whose directory can’t be read');
	});
});

// ── The site: links to files in every place Decision 8 scans ─────────────────

const root = mkdtempSync(join(tmpdir(), 'caracms-files-'));
after(() => rmSync(root, { recursive: true, force: true }));

const RATE = 'uploads/3f9c2a71b0e4/rate-card.pdf';
const BRIEF = 'uploads/a81d55e3c902/brief.docx';
const UNUSED = 'uploads/0c4e7f19a6b2/timeline.xlsx';
const MENTIONED = 'uploads/9a0b6e2d41c7/mentioned.csv';
const IMAGE = 'uploads/aaaaaaaaaaaa/harbour.jpg';

const files: Record<string, unknown> = {
	'content/pages/index.json': {
		title: 'Home',
		brochure: { label: 'Brochure', href: fileAddress(RATE, { download: true }) },
		blocks: [
			{ type: 'text', body: `Our [rate card](${fileAddress(RATE)}) and the [brief](${fileAddress(BRIEF)}). Not a link: ${fileAddress(MENTIONED)}`, more: { label: 'More', href: '/about' } },
			{ type: 'cta', buttons: [{ label: 'Get the brief', href: fileAddress(BRIEF), style: 'main' }] },
			{ shared: 'footer' },
		],
	},
	'content/pages/about.json': { title: 'About', blocks: [{ type: 'text', body: 'Nothing here', more: { label: 'Rates', href: `${fileAddress(RATE)}#page=2` } }] },
	'content/docs/handbook.json': { title: 'Handbook', download: { label: 'Rates', href: fileAddress(RATE) }, note: fileAddress(MENTIONED) },
	'content/shared/footer.json': { title: 'Footer', block: { type: 'text', body: `[Rates](${fileAddress(RATE)})`, more: { label: '', href: '' } } },
	'content/site-settings.json': { title: 'Site Settings', handbook: { label: 'Handbook', href: fileAddress(BRIEF) }, redirects: [] },
};
for (const [file, value] of Object.entries(files)) {
	mkdirSync(join(root, file, '..'), { recursive: true });
	writeFileSync(join(root, file), JSON.stringify(value, null, 2) + '\n');
}
writeFileSync(join(root, 'Block.astro'), '---\n---\n');

const display = {
	family: 'Bricolage Grotesque',
	cssVariable: '--font-display',
	fontFile: { measure: join(import.meta.dirname, 'fixtures/fonts/BricolageGrotesque.ttf'), web: join(import.meta.dirname, 'fixtures/fonts/BricolageGrotesque.ttf') },
	weightRange: '200 800',
	axes: { wght: 700, wdth: 100, opsz: 96 },
	sizePx: 96,
	minSizePx: 28,
	trackingEm: 0.04,
	leading: 1,
	textTransform: 'uppercase',
} as const;

const config = defineSite({
		repoPath: 'starter',
		collections: {
			pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true, fields: { brochure: link() } },
			docs: { kind: 'fields', folder: 'content/docs', urlBase: '/docs/', component: 'Block.astro', fields: { download: link(), note: text() } },
		},
		blocks: {
			text: { label: 'Text', component: 'Block.astro', fields: { body: richText(), more: link() } },
			cta: { label: 'Call to action', component: 'Block.astro', fields: { buttons: buttons({ styles: ['main', 'plain'] }) } },
			gallery: { label: 'Gallery', component: 'Block.astro', fields: { images: list(media({ only: 'image' })) } },
		},
		settings: { fields: { handbook: link() } },
		textStyles: { display },
		page: 'Block.astro',
	} as SiteConfig);
const site = resolveSite(config, root);

const ORIGIN = 'http://site.test';
const MEMORY = { CARACMS_MEDIA: 'memory' };
const mem = memoryMedia();
beforeEach(() => mem.reset());

const local = (): MediaContext => ({ site, store: localDraftsStore(site), mode: 'local', person: null, env: MEMORY, production: false, log: () => {} });
const request = (path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) =>
	new Request(`${ORIGIN}/_caracms/media/${path}`, { method: init.body ? 'POST' : 'GET', headers: { origin: ORIGIN, ...init.headers }, body: init.body ?? null });
const upload = (bytes: Uint8Array, name: string) => request('upload', { body: bytes as BodyInit, headers: { [MEDIA_NAME_HEADER]: encodeURIComponent(name), 'content-type': 'application/octet-stream' } });
async function call<T>(req: Request, ctx: MediaContext = local()): Promise<{ status: number; body: T }> {
	const res = await handleMedia(req, ctx);
	const text = await res.text();
	return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

describe('uploading a file', () => {
	test('Acceptance 1: stored under uploads/<hash>/<name>.<ext>, the extension from the bytes, with no w or h; the answer is { file }', async () => {
		const bytes = pdf('rules');
		const r = await call<MediaFileUploadResponse>(upload(bytes, 'Rule Book (v2).PDF'));
		assert.equal(r.status, 201);
		const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
		assert.deepEqual(r.body, { file: { kind: 'file', key: `uploads/${hash}/rule-book-v2.pdf`, name: 'Rule Book (v2).PDF', type: 'PDF', bytes: bytes.byteLength, uploadedAt: r.body.file.uploadedAt, by: null, usedIn: [] }, created: true });
		const stored = mem.bucket.objects.get(r.body.file.key)!;
		assert.equal(stored.meta.contentType, 'application/pdf');
		assert.equal(stored.meta.w, null);
		assert.equal(stored.meta.h, null);
		const renamed = await call<MediaFileUploadResponse>(upload(pdf('other'), 'brochure.docx'));
		assert.match(renamed.body.file.key, /\/brochure\.pdf$/, 'Acceptance 2: stored as what its bytes say');
		const csv = await call<MediaFileUploadResponse>(upload(utf8('a,b\n'), 'Signups.csv'));
		assert.match(csv.body.file.key, /^uploads\/[0-9a-f]{12}\/signups\.csv$/);
		const legacy = await call<MediaFileUploadResponse>(upload(ole('t'), 'terms of business.doc'));
		assert.deepEqual([legacy.body.file.key.split('/').pop(), legacy.body.file.type], ['terms-of-business.doc', 'Word']);
	});

	test('the same bytes again answer the first file and write nothing; a macro-enabled file is refused (415) with its sentence', async () => {
		const bytes = docx('same');
		const first = await call<MediaFileUploadResponse>(upload(bytes, 'a.docx'));
		const second = await call<MediaFileUploadResponse>(upload(bytes, 'b.docx'));
		assert.equal(second.status, 200);
		assert.deepEqual([second.body.created, second.body.file.key], [false, first.body.file.key]);
		const macro = await call<{ error: string; code: string }>(upload(xlsm(), 'budget-tracker.xlsm'));
		assert.equal(macro.status, 415);
		assert.equal(macro.body.code, 'macro-enabled');
		assert.equal(mem.bucket.objects.size, 1);
	});

	test('a name with nothing to slugify is "file"', async () => {
		const r = await call<MediaFileUploadResponse>(upload(pdf('nameless'), '???.pdf'));
		assert.match(r.body.file.key, /\/file\.pdf$/);
	});
});

describe('Decision 8: the listing’s files and what links to them', () => {
	test('fileLinksIn finds links by schema: link fields, page fields, buttons, rich text, Site Settings; never a plain-text mention', () => {
		const read = (file: string, collection: string) => fileLinksIn(readFileSync(join(root, file), 'utf8'), site, site.collections[collection]!).map((l) => `${l.key}${l.download ? '?download' : ''}`);
		assert.deepEqual(read('content/pages/index.json', 'pages'), [`${RATE}?download`, RATE, BRIEF, BRIEF]);
		assert.deepEqual(read('content/docs/handbook.json', 'docs'), [RATE], 'the text field’s address is no link');
		assert.deepEqual(read('content/shared/footer.json', 'shared'), [RATE]);
		assert.deepEqual(read('content/site-settings.json', 'settings'), [BRIEF]);
		assert.deepEqual(read('content/pages/about.json', 'pages'), [RATE], 'a fragment is still a link to the file');
	});

	test('Acceptance 13: files are listed beside images, newest first, each with the documents that link to it and how often', async () => {
		mem.bucket.seed(RATE, { name: 'rate-card-2026.pdf' });
		mem.bucket.seed(BRIEF, {});
		mem.bucket.seed(UNUSED, {});
		mem.bucket.seed(MENTIONED, {});
		mem.bucket.seed(IMAGE, { w: 10, h: 10 });
		const r = await call<MediaImagesResponse>(request('images'));
		assert.equal(r.status, 200);
		assert.deepEqual(r.body.images.map((i) => [i.kind, i.key]), [['image', IMAGE]]);
		const by = (key: string) => r.body.files.find((f) => f.key === key)!;
		assert.deepEqual(r.body.files.map((f) => f.kind), ['file', 'file', 'file', 'file']);
		assert.equal(by(RATE).name, 'rate-card-2026.pdf');
		assert.equal(by(RATE).type, 'PDF');
		assert.deepEqual(
			by(RATE).usedIn.map((u) => `${u.collection}/${u.path} ×${u.links}`).sort(),
			['docs/handbook ×1', 'pages/about ×1', 'pages/index ×2', 'shared/footer ×1'],
		);
		assert.deepEqual(by(BRIEF).usedIn.map((u) => `${u.collection}/${u.path} ×${u.links}`).sort(), ['pages/index ×2', 'settings/site-settings ×1']);
		assert.deepEqual(by(UNUSED).usedIn, []);
		assert.deepEqual(by(MENTIONED).usedIn, [], 'a plain-text mention doesn’t count');
		assert.equal(by(BRIEF).type, 'Word');
	});

	test('mediaUses keeps finding images and clips as before', async () => {
		const uses = await mediaUses(localDraftsStore(site), site);
		assert.equal(uses.images.size, 0);
		assert.equal(uses.files.get(RATE)?.length, 4);
	});
});

describe('refileText (Replace’s rewrite)', () => {
	const NEW = 'uploads/c40a9e6b2d17/rate-card-v2.pdf';
	test('every link to the old file points at the new one, ?download and a fragment kept, anything else untouched', () => {
		const text = readFileSync(join(root, 'content/pages/index.json'), 'utf8');
		const out = refileText(text, RATE, NEW, site, site.collections.pages!);
		assert.equal(out.links, 2);
		const doc = JSON.parse(out.text);
		assert.equal(doc.brochure.href, `${fileAddress(NEW)}?download`);
		assert.equal(doc.blocks[0].body.startsWith(`Our [rate card](${fileAddress(NEW)}) and the [brief](${fileAddress(BRIEF)})`), true);
		assert.equal(doc.blocks[0].body.endsWith(`Not a link: ${fileAddress(MENTIONED)}`), true);
		const about = refileText(readFileSync(join(root, 'content/pages/about.json'), 'utf8'), RATE, NEW, site, site.collections.pages!);
		assert.equal(JSON.parse(about.text).blocks[0].more.href, `${fileAddress(NEW)}#page=2`);
		const none = refileText(text, UNUSED, NEW, site, site.collections.pages!);
		assert.deepEqual(none, { text, links: 0 });
	});
});

describe('Decision 4: a file key in a media value', () => {
	test('Acceptance 12: renders nothing and gets the wrong-kind warning', async () => {
		const { renderMedia } = await import('../src/media-value.ts');
		const { fieldWarnings } = await import('../src/fields.ts');
		const value = { key: RATE, alt: 'Rates' };
		assert.equal(renderMedia(value), null);
		assert.equal(renderMedia({ key: IMAGE, alt: '' })?.kind, 'image', 'an image key still renders');
		const warnings = fieldWarnings(media(), value);
		assert.deepEqual(warnings.map((w) => w.code), ['wrong-kind']);
		assert.match(warnings[0]!.message, /A file \(PDF\), not an image or video/);
	});
});

// ── Replace… (Decision 9) ────────────────────────────────────────────────────

describe('Replace… in local mode', async () => {
	const { cpSync } = await import('node:fs');
	const NEW = 'uploads/c40a9e6b2d17/rate-card-v2.pdf';
	const copy = () => {
		const dir = mkdtempSync(join(tmpdir(), 'caracms-replace-'));
		cpSync(root, dir, { recursive: true });
		const copied = resolveSite(config, dir);
		return { dir, site: copied, ctx: { ...local(), site: copied, store: localDraftsStore(copied) } as MediaContext };
	};
	const replace = (body: unknown, ctx: MediaContext) =>
		call<{ ok?: true; relinked?: { collection: string; path: string; links: number }[]; error?: string; code?: string }>(request('replace', { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), ctx);

	test('Acceptance 15 and 16: every link to the old file moves to the new one, ?download kept, shared blocks and Site Settings included; plain text left', async () => {
		const c = copy();
		try {
			mem.bucket.seed(RATE, {});
			mem.bucket.seed(NEW, {});
			mem.bucket.seed(BRIEF, {});
			const r = await replace({ from: RATE, to: NEW }, c.ctx);
			assert.equal(r.status, 200, JSON.stringify(r.body));
			assert.deepEqual(r.body.relinked!.map((u) => `${u.collection}/${u.path} ×${u.links}`).sort(), ['docs/handbook ×1', 'pages/about ×1', 'pages/index ×2', 'shared/footer ×1']);
			const read = (file: string) => JSON.parse(readFileSync(join(c.dir, file), 'utf8'));
			assert.equal(read('content/pages/index.json').brochure.href, `${fileAddress(NEW)}?download`, '?download kept');
			assert.match(read('content/pages/index.json').blocks[0].body, new RegExp(`\\[rate card\\]\\(${fileAddress(NEW).replace(/[.?]/g, '\\$&')}\\)`));
			assert.equal(read('content/shared/footer.json').block.body, `[Rates](${fileAddress(NEW)})`);
			const brief = await replace({ from: BRIEF, to: NEW }, c.ctx);
			assert.ok(brief.body.relinked!.some((u) => u.collection === 'settings'), 'Site Settings’ own link field');
			assert.equal(read('content/site-settings.json').handbook.href, fileAddress(NEW));
			assert.equal(read('content/docs/handbook.json').note, fileAddress(MENTIONED), 'a plain-text mention is left');
			assert.equal(mem.bucket.objects.has(RATE), true, 'the old file stays in the bucket');
		} finally {
			rmSync(c.dir, { recursive: true, force: true });
		}
	});

	test('the same key, a key that isn’t a file’s, or a new file not in the bucket is refused, and nothing changes', async () => {
		const c = copy();
		try {
			mem.bucket.seed(RATE, {});
			const before = readFileSync(join(c.dir, 'content/pages/index.json'), 'utf8');
			const same = await replace({ from: RATE, to: RATE }, c.ctx);
			assert.deepEqual([same.status, same.body.code], [400, 'same']);
			assert.equal((await replace({ from: RATE, to: IMAGE }, c.ctx)).status, 400);
			assert.equal((await replace({ from: RATE, to: '../../etc/passwd' }, c.ctx)).status, 400);
			const gone = await replace({ from: RATE, to: NEW }, c.ctx);
			assert.equal(gone.status, 404, 'the new file must be uploaded first');
			assert.equal(readFileSync(join(c.dir, 'content/pages/index.json'), 'utf8'), before);
		} finally {
			rmSync(c.dir, { recursive: true, force: true });
		}
	});
});

describe('Replace… in live mode', async () => {
	const { MemoryBackend } = await import('../src/live/backend.ts');
	const { createLiveEditor } = await import('../src/live/editor.ts');
	const { Tracker } = await import('../src/live/github.ts');
	const { memoryRedis } = await import('../src/live/redis.ts');
	const { createLiveRuntime, siteFiles } = await import('../src/live/runtime.ts');
	const { DEFAULT_TIMINGS } = await import('../src/live/timings.ts');
	const NEW = 'uploads/c40a9e6b2d17/rate-card-v2.pdf';
	const aoife = { email: 'aoife@example.com', name: 'Aoife' };
	const ciaran = { email: 'ciaran@example.com', name: 'Ciarán' };
	const live = { github: { kind: 'memory' as const }, redisUrl: null, secret: 's'.repeat(32), allow: [], webhookSecret: null, railway: null, backup: null, runningCommit: null, timings: { ...DEFAULT_TIMINGS }, production: false };
	async function world() {
		const clock = { t: Date.parse('2026-10-17T10:00:00Z') };
		const backend = new MemoryBackend(new Tracker(() => clock.t), { now: () => clock.t });
		backend.seed(await siteFiles(site));
		const rt = await createLiveRuntime({ site, settings: live, backend, redis: memoryRedis({ now: () => clock.t }), now: () => clock.t, log: () => {}, runningCommit: () => null });
		return createLiveEditor(rt, { log: () => {}, sleep: async () => {}, schedule: () => () => {} });
	}
	const ctxOf = (ed: Awaited<ReturnType<typeof world>>, person = aoife): MediaContext => ({ site, store: ed.store, mode: 'live', person, env: MEMORY, production: false, log: () => {} });
	const replace = (ed: Awaited<ReturnType<typeof world>>, body: unknown, tab = 'tab-aoife-0001') =>
		call<{ relinked?: { collection: string; path: string; links: number }[]; error?: string; code?: string }>(
			request('replace', { body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-caracms-tab': tab } }),
			ctxOf(ed),
		);

	test('Acceptance 15: the rewritten documents are waiting autosaves, named in the waiting-changes list; the new address reads back, ?download kept; the old address still serves the old bytes', async () => {
		const ed = await world();
		const OLD_BYTES = pdf('the old rate card');
		mem.bucket.seed(RATE, { name: 'rate-card.pdf', contentType: 'application/pdf' }, OLD_BYTES);
		mem.bucket.seed(NEW, {});
		const r = await replace(ed, { from: RATE, to: NEW });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.relinked!.length, 4);
		const home = JSON.parse((await ed.store.read('pages', 'index')).text);
		assert.equal(home.brochure.href, `${fileAddress(NEW)}?download`);
		for (const file of ['content/pages/index.json', 'content/pages/about.json', 'content/docs/handbook.json', 'content/shared/footer.json']) assert.ok(await ed.autosaves.get(file), file);
		assert.equal(await ed.autosaves.get('content/site-settings.json'), null, 'Site Settings links to the brief, not the rate card');

		// The waiting changes (what the Publish sheet lists) name each document the rewrite touched, and no other.
		const res = await ed.status(new Request(`${ORIGIN}/_caracms/status`, { headers: { origin: ORIGIN, 'x-caracms-tab': 'tab-aoife-0001' } }), aoife);
		assert.equal(res.status, 200);
		const waiting = ((await res.json()) as { waiting: { file: string; title: string; collection: string | null; path: string | null }[] }).waiting;
		assert.deepEqual(waiting.map((w) => w.file).sort(), ['content/docs/handbook.json', 'content/pages/about.json', 'content/pages/index.json', 'content/shared/footer.json']);
		assert.deepEqual(waiting.map((w) => w.title).sort(), ['About', 'Footer', 'Handbook', 'Home']);

		// The old address, through the route (not the bucket's map): the old file, byte for byte.
		const served = await handleFileRequest(new Request(`${ORIGIN}${fileAddress(RATE)}`), { env: MEMORY, production: false, limiter: memoryLimiter({ max: 1_000_000 }), log: () => {} });
		assert.equal(served.status, 200);
		assert.deepEqual(new Uint8Array(await served.arrayBuffer()), OLD_BYTES);
	});

	test('Acceptance 16: a failure part way leaves every document as it was', async () => {
		const ed = await world();
		mem.bucket.seed(RATE, {});
		mem.bucket.seed(NEW, {});
		const homeBefore = (await ed.store.read('pages', 'index')).text;
		const putIf = ed.autosaves.putIf.bind(ed.autosaves);
		let writes = 0;
		ed.autosaves.putIf = async (read, autosave) => {
			if (++writes === 3) throw new Error('the store went away');
			return putIf(read, autosave);
		};
		const failed = await replace(ed, { from: RATE, to: NEW });
		assert.equal(failed.status, 500, JSON.stringify(failed.body));
		ed.autosaves.putIf = putIf;
		assert.equal((await ed.store.read('pages', 'index')).text, homeBefore, 'Home as it was');
		for (const file of ['content/pages/index.json', 'content/pages/about.json', 'content/docs/handbook.json', 'content/shared/footer.json']) assert.equal(await ed.autosaves.get(file), null, file);

	});

	test('Acceptance 16: someone else editing a document that links to it refuses the whole Replace, naming them', async () => {
		const ed = await world();
		mem.bucket.seed(RATE, {});
		mem.bucket.seed(NEW, {});
		const homeBefore = (await ed.store.read('pages', 'index')).text;
		// Ciarán is typing in About: nothing changes, and the sentence names him.
		const opened = await ed.store.read('pages', 'about');
		const document = structuredClone(opened.document) as unknown as Record<string, unknown>;
		document.title = 'About us';
		const w = await ed.write(new Request(`${ORIGIN}/_caracms/write`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-caracms-tab': 'tab-ciaran-0001' }, body: JSON.stringify({ file: opened.entry.file, base: opened.text, document }) }), ciaran);
		assert.equal(w.status, 200);
		const refused = await replace(ed, { from: RATE, to: NEW });
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, 'locked');
		assert.match(refused.body.error!, /^Ciarán is editing About us, which links here/);
		assert.equal((await ed.store.read('pages', 'index')).text, homeBefore);
	});
});
