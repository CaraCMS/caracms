// M9 Decisions 14–15: the caracms-tina skill's reference conversion script
// (site-skills/caracms-tina/tina-to-caracms.mjs). Its generic pieces: Tina's field kinds →
// caracms's, rich-text unescaping, media keys by their bytes and the key map, the adapt
// table's shared blocks, form words and redirects, the editor's layout, and a whole run on a
// small Tina checkout giving the same bytes twice.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { cleanName, keyFor, keyName, signS3 } from '../bin/media.mjs';
import { buttons, group, link, list, media, reference, richText as richTextField, select, text, toggle } from '../src/config.ts';
import { fileKeyOf, isFileKey } from '../src/files.ts';
import { checkForms } from '../src/forms/rules.ts';
import { savedForm } from '../src/serialize.ts';
import {
	blockKey,
	compileField,
	compileFields,
	convertAll,
	fileAddress,
	fileLink,
	formsFromTina,
	imageKey,
	inlineMarkdown,
	kebab,
	keyFromBytes,
	keysText,
	renderDocs,
	resolveKeys,
	richText,
	scaffoldConfig,
	SITE,
} from '../site-skills/caracms-tina/tina-to-caracms.mjs';

const str = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'string', name, label: name, ...extra });
const kindOf = (f: Record<string, unknown>, siblings: Record<string, unknown>[] = [f], at = `blocks.x.${String(f.name)}`) => compileField(f, siblings, at, SITE);

describe('Tina field kinds → caracms fields', () => {
	test('strings: text, multiline, select, list of select, address', () => {
		assert.equal(kindOf(str('label')).kind, 'text');
		assert.equal(kindOf(str('intro', { ui: { component: 'textarea' } })).multiline, true);
		assert.equal(kindOf(str('heading')).heading, true, 'a block heading may hold the h1');
		const sel = kindOf(str('side', { options: ['left', 'right'] }));
		assert.equal(sel.kind, 'select');
		const multi = kindOf(str('units', { options: ['a', 'b'], list: true }));
		assert.deepEqual([multi.kind, multi.item.kind], ['list', 'select']);
		assert.equal(kindOf(str('href')).kind, 'address', 'a lone href is an address');
		const site = { ...SITE, addressFields: ['siteSettings.socials.instagram'] };
		assert.equal(compileField(str('instagram'), [], 'siteSettings.socials.instagram', site).kind, 'address');
		assert.equal(compileField(str('instagram'), [], 'siteSettings.socials.instagram', SITE).kind, 'text');
	});

	test('numbers, booleans and a default that lived in mapper code', () => {
		assert.equal(kindOf({ type: 'number', name: 'n' }).kind, 'number');
		assert.equal(kindOf({ type: 'boolean', name: 'live' }).kind, 'toggle');
		const site = { ...SITE, fieldDefaults: { 'jobs.live': true } };
		assert.equal(compileField({ type: 'boolean', name: 'live' }, [], 'jobs.live', site).default, true);
	});

	test('images: with an …Alt sibling the pair is one media field; bare, decorative', () => {
		const fields = [{ type: 'image', name: 'image' }, str('imageAlt'), str('caption')];
		const specs = compileFields(fields, 'blocks.x', SITE);
		assert.deepEqual(specs.map((s: { name: string }) => s.name), ['image', 'caption'], 'the alt field goes');
		assert.deepEqual([specs[0].kind, specs[0].only, specs[0].alt], ['media', 'image', 'imageAlt']);
		const bare = compileFields([{ type: 'image', name: 'shot' }], 'products', SITE)[0];
		assert.equal(bare.alt, null);
	});

	test("the template's media object: media(), image-only without playbackId", () => {
		const sub = [str('kind', { options: ['image', 'video'] }), { type: 'image', name: 'src' }, str('alt'), { type: 'number', name: 'focusX' }];
		const still = kindOf({ type: 'object', name: 'media', fields: sub });
		assert.deepEqual([still.kind, still.object, still.only], ['media', true, 'image']);
		const clip = kindOf({ type: 'object', name: 'media', fields: [...sub, str('playbackId')] });
		assert.equal(clip.only, undefined);
	});

	test('linkLabel + href become one link() where linkLabel stood', () => {
		const specs = compileFields([str('heading'), str('linkLabel'), str('href'), str('body')], 'blocks.x.items', SITE);
		assert.deepEqual(specs.map((s: { name: string; kind: string }) => `${s.name}:${s.kind}`), ['heading:text', 'link:link', 'body:text']);
	});

	test('object lists: buttons, links, one-field lists flattened, the rest lists of fields', () => {
		const style = str('style', { options: ['primary', 'secondary'] });
		const b = kindOf({ type: 'object', list: true, name: 'buttons', fields: [str('label'), str('href'), style] });
		assert.deepEqual([b.kind, b.styles], ['buttons', ['primary', 'secondary']]);
		assert.equal(kindOf({ type: 'object', list: true, name: 'items', fields: [str('label'), str('href')] }).item.kind, 'link');
		const lines = kindOf({ type: 'object', list: true, name: 'addressLines', fields: [str('line')] });
		assert.deepEqual([lines.kind, lines.item.kind, lines.unwrap], ['list', 'text', 'line']);
		const refs = kindOf({ type: 'object', list: true, name: 'picks', fields: [{ type: 'reference', name: 'product', collections: ['products'] }] });
		assert.deepEqual([refs.item.kind, refs.unwrap], ['reference', 'product']);
		const pics = kindOf({ type: 'object', list: true, name: 'pictures', fields: [{ type: 'image', name: 'image' }, str('imageAlt')] });
		assert.deepEqual([pics.item.kind, pics.item.alt], ['media', 'imageAlt']);
		const rows = kindOf({ type: 'object', list: true, name: 'rows', fields: [str('name'), str('line')] });
		assert.deepEqual([rows.kind, rows.fields.length], ['list', 2]);
		assert.equal(kindOf({ type: 'object', name: 'contact', fields: [str('email')] }).kind, 'group');
	});

	test('rich text: headings and links from Tina\'s overrides; displayOnly and isTitle dropped', () => {
		const r = kindOf({ type: 'rich-text', name: 'body', overrides: { toolbar: ['bold', 'italic', 'ul'], headingLevels: [] } });
		assert.deepEqual([r.kind, r.headings, r.links], ['richText', [], false]);
		const long = kindOf({ type: 'rich-text', name: 'body' });
		assert.deepEqual([long.headings, long.links], [['h2', 'h3'], true]);
		assert.deepEqual(compileFields([{ type: 'displayOnly', name: 'x' }, str('title', { isTitle: true }), str('a')], 'c', SITE).map((s: { name: string }) => s.name), ['a']);
	});

	test('a field kind with no caracms field fails by name', () => {
		assert.throws(() => kindOf({ type: 'mystery', name: 'm' }), /blocks\.x\.m: no caracms field for Tina's "mystery"/);
	});

	test('block keys: the renames, else camelCase → kebab case', () => {
		assert.equal(kebab('textMedia'), 'text-media');
		assert.equal(kebab('CTABand'), 'cta-band');
		assert.equal(blockKey('jumpLinks', { ...SITE, blockRenames: { jumpLinks: 'section-links' } }), 'section-links');
		assert.equal(blockKey('jumpLinks', SITE), 'jump-links');
	});
});

describe('rich text: Tina\'s Markdown → caracms\'s', () => {
	test("Tina's escapes are undone, except caracms's own", () => {
		assert.equal(inlineMarkdown('see the Q\\&A'), 'see the Q&A');
		assert.equal(inlineMarkdown('[us](mailto\\:hi@x.test)'), '[us](mailto:hi@x.test)');
		assert.equal(inlineMarkdown('5 \\* 3 \\[sic\\] a\\\\b'), '5 \\* 3 \\[sic\\] a\\\\b');
	});

	test("Tina's line breaks (a trailing backslash or two spaces) become \\n; _ and __ become * and **", () => {
		assert.equal(inlineMarkdown('one\\\ntwo  \nthree\nfour'), 'one\ntwo\nthree\nfour');
		assert.equal(inlineMarkdown('an _aside_ and __loud__ words, snake_case_name'), 'an *aside* and **loud** words, snake_case_name');
	});

	test('paragraphs, lists and headings; trailing newlines trimmed; empty is []', () => {
		assert.deepEqual(richText('The site offers a **short tour**.\n'), [{ p: 'The site offers a **short tour**.' }]);
		assert.deepEqual(richText('Intro\n\n* 3 x Red\n* 2 x Blue\n\n1. one\n2. two\n\n## Next\n\nEnd'), [
			{ p: 'Intro' },
			{ ul: ['3 x Red', '2 x Blue'] },
			{ ol: ['one', 'two'] },
			{ h2: 'Next' },
			{ p: 'End' },
		]);
		assert.deepEqual(richText(''), []);
		assert.deepEqual(richText('\n\n'), []);
	});

	test('an h1 and a nested list are kept as caracms can hold them, with a warning', () => {
		const warnings: string[] = [];
		const out = richText('# Big\n\n* a\n  * b', { warn: (m: string) => warnings.push(m) });
		assert.deepEqual(out, [{ p: 'Big' }, { ul: ['a', 'b'] }]);
		assert.equal(warnings.length, 2);
	});

	test("a link's address goes through the rewrite (a Tina file link becomes caracms's)", () => {
		const out = richText('Get [the price list](/files/prices.pdf).', { rewriteHref: (h: string) => (fileLink(h) ? (fileAddress('uploads/0123456789ab/prices.pdf') ?? h) : h) });
		assert.equal(out[0]!.p, 'Get [the price list](/files/0123456789ab/prices.pdf).');
	});
});

/** A PNG's headers (the sniffer reads no pixels). */
const png = (w: number, h: number, salt = 0) => {
	const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
	return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...Buffer.from('IHDR'), ...u32(w), ...u32(h), 8, 6, 0, 0, 0, ...u32(salt), ...u32(0), ...Buffer.from('IEND'), ...u32(0)]);
};
const hex12 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const TOOLS = { keyFor, keyName, cleanName, signS3 };

describe('media keys by their bytes', () => {
	test("a Tina file link names its bucket key and file name; what isn't one is left alone", () => {
		assert.deepEqual(fileLink('/files/Price%20List%20v2.PDF'), { sourceKey: 'uploads/Price List v2.PDF', name: 'Price List v2.PDF' });
		assert.equal(fileLink('/about'), null);
		assert.equal(fileLink('/files/abc123def456/x.pdf'), null, 'already a caracms address');
		assert.equal(fileLink('/files/no-extension'), null);
	});

	test("an image's key is the upload route's: the bytes' hash, the slugified name, the sniffed type, with w/h", () => {
		const bytes = png(640, 480);
		const entry = keyFromBytes(bytes, { kind: 'image', name: 'Harbour Wall.jpg' }, TOOLS);
		assert.deepEqual(entry, { key: `uploads/${hex12(bytes)}/harbour-wall.png`, w: 640, h: 480 }, "the type is the bytes', not the name's");
		assert.equal(keyFromBytes(Buffer.from('%PDF-1.7'), { kind: 'image', name: 'x.jpg' }, TOOLS), null, 'not an image where one is used');
	});

	test("a file's key is its bytes' hash and its slugified name, keeping its extension (lower-cased); its address names that key", () => {
		const pdf = Buffer.from('%PDF-1.7 the price list');
		const entry = keyFromBytes(pdf, { kind: 'file', name: 'Price List v2.PDF' }, TOOLS);
		assert.deepEqual(entry, { key: `uploads/${hex12(pdf)}/price-list-v2.pdf` });
		assert.ok(isFileKey(entry.key), 'a caracms file key');
		const address = fileAddress(entry.key)!;
		assert.equal(address, `/files/${hex12(pdf)}/price-list-v2.pdf`);
		assert.deepEqual(fileKeyOf(address), { key: entry.key, download: false }, 'its address names its key');
		assert.notEqual(keyFromBytes(Buffer.from('%PDF-1.7 other'), { kind: 'file', name: 'Price List v2.PDF' }, TOOLS)!.key, entry.key, 'other bytes, another key');
	});

	test('an image keeps nothing of its Tina URL but the bucket key', () => {
		assert.equal(imageKey('https://img.example.com/unsafe/plain/s3://site-media-1/uploads/photos/a%20b.jpg'), 'uploads/photos/a b.jpg');
		assert.equal(imageKey('https://elsewhere.test/a.jpg'), null);
	});

	test('the key map is sorted, one entry per line', () => {
		const text = keysText({ 'uploads/b.jpg': { key: 'uploads/bbbbbbbbbbbb/b.jpg', w: 2, h: 1 }, 'uploads/a.pdf': { key: 'uploads/aaaaaaaaaaaa/a.pdf' } });
		assert.equal(text, '{\n  "uploads/a.pdf": { "key": "uploads/aaaaaaaaaaaa/a.pdf" },\n  "uploads/b.jpg": { "key": "uploads/bbbbbbbbbbbb/b.jpg", "w": 2, "h": 1 }\n}\n');
	});
});

describe('resolveKeys: the key map, and the copies within the bucket', () => {
	const CREDS = { S3_ENDPOINT: 'https://s3.test', S3_REGION: 'auto', S3_BUCKET: 'media-1', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' };
	const photo = png(800, 600, 7);
	const pdf = Buffer.from('%PDF-1.7 prices');
	const media = () =>
		new Map([
			['uploads/Photo One.jpg', { kind: 'image', name: 'Photo One.jpg', where: 'content/pages/home.json' }],
			['uploads/prices.pdf', { kind: 'file', name: 'prices.pdf', where: 'content/pages/home.json' }],
		]);
	const PHOTO_KEY = `uploads/${hex12(photo)}/photo-one.png`;
	const PDF_KEY = `uploads/${hex12(pdf)}/prices.pdf`;
	/** The fake bucket's ETag for some bytes: their MD5, as S3 gives a single-part object's. */
	const etag = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
	type Entry = { key: string; w?: number; h?: number; etag?: string; size?: number };

	/**
	 * A bucket behind fetch: GET and HEAD read it (with a quoted ETag and Content-Length), a
	 * PUT with x-amz-copy-source copies within it (412 when x-amz-copy-source-if-match misses).
	 */
	const withBucket = async (objects: Map<string, Uint8Array>, go: (calls: string[]) => Promise<void>) => {
		const calls: string[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
			const method = init.method ?? 'GET';
			const key = decodeURIComponent(new URL(url).pathname.replace(/^\/media-1\//, ''));
			calls.push(`${method} ${key}`);
			if (method === 'PUT') {
				const source = decodeURIComponent(init.headers!['x-amz-copy-source']!.replace(/^\/media-1\//, ''));
				const match = init.headers!['x-amz-copy-source-if-match'];
				if (match && match !== `"${etag(objects.get(source)!)}"`) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
				objects.set(key, objects.get(source)!);
				return new Response('<CopyObjectResult/>', { status: 200 });
			}
			const body = objects.get(key);
			if (!body) return new Response(null, { status: 404 });
			const headers = { etag: `"${etag(body)}"`, 'content-length': String(body.length) };
			return new Response(method === 'HEAD' ? null : (body as unknown as BodyInit), { status: 200, headers });
		}) as typeof fetch;
		try {
			await go(calls);
		} finally {
			globalThis.fetch = real;
		}
	};

	test("a key the map lacks is read from the bucket once and copied to its caracms key; one that's there is skipped; nothing is deleted", async () => {
		const objects = new Map<string, Uint8Array>([
			['uploads/Photo One.jpg', photo],
			['uploads/prices.pdf', pdf],
			[PDF_KEY, pdf],
		]);
		const map: Record<string, Entry> = {};
		await withBucket(objects, async (calls) => {
			const r = await resolveKeys(media(), map, TOOLS, CREDS);
			assert.deepEqual(r, { learned: ['uploads/Photo One.jpg', 'uploads/prices.pdf'], unreadable: [], rekeyed: [], stamped: [], copied: [PHOTO_KEY], kept: [PDF_KEY] });
			assert.deepEqual(map, {
				'uploads/Photo One.jpg': { key: PHOTO_KEY, w: 800, h: 600, etag: etag(photo), size: photo.length },
				'uploads/prices.pdf': { key: PDF_KEY, etag: etag(pdf), size: pdf.length },
			});
			assert.ok(objects.has('uploads/Photo One.jpg') && objects.has('uploads/prices.pdf'), 'the Tina keys stay: the live site serves them');
			assert.ok(!calls.some((c) => c.startsWith('DELETE')));
			assert.deepEqual(calls.filter((c) => c.startsWith('PUT')), [`PUT ${PHOTO_KEY}`], 'only the missing copy is made; nothing is overwritten');
		});
	});

	test('with every key in the map and no S3_* settings, a run makes no request at all', async () => {
		const map = { 'uploads/Photo One.jpg': { key: PHOTO_KEY, w: 800, h: 600 }, 'uploads/prices.pdf': { key: PDF_KEY, etag: 'stale', size: 1 } };
		const before = JSON.stringify(map);
		await withBucket(new Map([['uploads/prices.pdf', Buffer.from('%PDF-1.7 replaced')]]), async (calls) => {
			const r = await resolveKeys(media(), map, TOOLS, null);
			assert.deepEqual(r, { learned: [], unreadable: [], rekeyed: [], stamped: [], copied: [], kept: [] });
			assert.deepEqual(calls, []);
		});
		assert.equal(JSON.stringify(map), before, 'the map is used as it is');
	});

	test('with S3_* settings, an unchanged source (ETag and size as in its entry) costs a HEAD and nothing more', async () => {
		const objects = new Map<string, Uint8Array>([
			['uploads/Photo One.jpg', photo],
			['uploads/prices.pdf', pdf],
			[PHOTO_KEY, photo],
			[PDF_KEY, pdf],
		]);
		const map: Record<string, Entry> = {
			'uploads/Photo One.jpg': { key: PHOTO_KEY, w: 800, h: 600, etag: etag(photo), size: photo.length },
			'uploads/prices.pdf': { key: PDF_KEY, etag: etag(pdf), size: pdf.length },
		};
		const before = JSON.stringify(map);
		await withBucket(objects, async (calls) => {
			const r = await resolveKeys(media(), map, TOOLS, CREDS);
			assert.deepEqual(r, { learned: [], unreadable: [], rekeyed: [], stamped: [], copied: [], kept: [PHOTO_KEY, PDF_KEY] });
			assert.deepEqual(calls, ['HEAD uploads/Photo One.jpg', 'HEAD uploads/prices.pdf', `HEAD ${PHOTO_KEY}`, `HEAD ${PDF_KEY}`], 'no GET, no PUT');
		});
		assert.equal(JSON.stringify(map), before, 'nothing in the map moves, so the run writes nothing to it');
	});

	test('with S3_* settings, a file Tina replaced in place (a new ETag) is read again, re-keyed and copied; the old copy stays', async () => {
		const replaced = Buffer.from('%PDF-1.7 prices, 2027 edition');
		const NEW_KEY = `uploads/${hex12(replaced)}/prices.pdf`;
		const objects = new Map<string, Uint8Array>([
			['uploads/Photo One.jpg', photo],
			['uploads/prices.pdf', replaced],
			[PHOTO_KEY, photo],
			[PDF_KEY, pdf],
		]);
		const map: Record<string, Entry> = {
			'uploads/Photo One.jpg': { key: PHOTO_KEY, w: 800, h: 600, etag: etag(photo), size: photo.length },
			'uploads/prices.pdf': { key: PDF_KEY, etag: etag(pdf), size: pdf.length },
		};
		await withBucket(objects, async (calls) => {
			const r = await resolveKeys(media(), map, TOOLS, CREDS);
			assert.deepEqual(r, { learned: [], unreadable: [], rekeyed: ['uploads/prices.pdf'], stamped: [], copied: [NEW_KEY], kept: [PHOTO_KEY] });
			assert.deepEqual(map['uploads/prices.pdf'], { key: NEW_KEY, etag: etag(replaced), size: replaced.length });
			assert.deepEqual(calls.filter((c) => c.startsWith('GET')), ['GET uploads/prices.pdf'], 'only the changed source is read');
			assert.deepEqual(calls.filter((c) => c.startsWith('PUT')), [`PUT ${NEW_KEY}`]);
			assert.ok(!calls.some((c) => c.startsWith('DELETE')));
			assert.equal(objects.get(PDF_KEY), pdf, 'the old byte-hash copy is neither deleted nor overwritten');
			assert.equal(objects.get(NEW_KEY), replaced);
		});
	});

	test('with S3_* settings, an entry with no ETag yet gets one from the bytes, which are hashed once to confirm its key', async () => {
		const objects = new Map<string, Uint8Array>([
			['uploads/Photo One.jpg', photo],
			['uploads/prices.pdf', pdf],
			[PHOTO_KEY, photo],
			[PDF_KEY, pdf],
		]);
		const map: Record<string, Entry> = { 'uploads/Photo One.jpg': { key: PHOTO_KEY, w: 800, h: 600 }, 'uploads/prices.pdf': { key: PDF_KEY } };
		await withBucket(objects, async (calls) => {
			const r = await resolveKeys(media(), map, TOOLS, CREDS);
			assert.deepEqual(r, { learned: [], unreadable: [], rekeyed: [], stamped: ['uploads/Photo One.jpg', 'uploads/prices.pdf'], copied: [], kept: [PHOTO_KEY, PDF_KEY] });
			assert.deepEqual(map, {
				'uploads/Photo One.jpg': { key: PHOTO_KEY, w: 800, h: 600, etag: etag(photo), size: photo.length },
				'uploads/prices.pdf': { key: PDF_KEY, etag: etag(pdf), size: pdf.length },
			});
			assert.ok(!calls.some((c) => c.startsWith('PUT')), 'the same key: nothing to copy');
		});
		// One whose bytes no longer hash to its key (replaced before any ETag was kept) is re-keyed.
		const replaced = Buffer.from('%PDF-1.7 prices, swapped');
		objects.set('uploads/prices.pdf', replaced);
		const stale: Record<string, Entry> = { 'uploads/Photo One.jpg': { key: PHOTO_KEY, w: 800, h: 600 }, 'uploads/prices.pdf': { key: PDF_KEY } };
		await withBucket(objects, async () => {
			const r = await resolveKeys(media(), stale, TOOLS, CREDS);
			assert.deepEqual(r.rekeyed, ['uploads/prices.pdf']);
			assert.deepEqual(r.stamped, ['uploads/Photo One.jpg']);
			assert.equal(stale['uploads/prices.pdf']!.key, `uploads/${hex12(replaced)}/prices.pdf`);
		});
	});

	test("with S3_* settings, a mapped source that's gone from the bucket is unreadable, and no copy is made", async () => {
		const objects = new Map<string, Uint8Array>([['uploads/Photo One.jpg', photo], [PHOTO_KEY, photo], [PDF_KEY, pdf]]);
		const map: Record<string, Entry> = {
			'uploads/Photo One.jpg': { key: PHOTO_KEY, w: 800, h: 600, etag: etag(photo), size: photo.length },
			'uploads/prices.pdf': { key: PDF_KEY, etag: etag(pdf), size: pdf.length },
		};
		await withBucket(objects, async (calls) => {
			const r = await resolveKeys(media(), map, TOOLS, CREDS);
			assert.deepEqual(r.unreadable, ['uploads/prices.pdf']);
			assert.ok(!calls.some((c) => c.startsWith('PUT') || c.startsWith('GET')));
		});
	});

	test("a key whose bytes can't be read (missing, no S3_* settings, or not an image where one is used) is unreadable, and no copy is made", async () => {
		const objects = new Map<string, Uint8Array>([['uploads/Photo One.jpg', pdf]]);
		await withBucket(objects, async (calls) => {
			const r = await resolveKeys(media(), {}, TOOLS, CREDS);
			assert.deepEqual(r.unreadable, ['uploads/Photo One.jpg', 'uploads/prices.pdf']);
			assert.ok(!calls.some((c) => c.startsWith('PUT') || c.startsWith('HEAD')), 'nothing copied while any key is unreadable');
		});
		const none = await resolveKeys(media(), {}, TOOLS, null);
		assert.deepEqual(none.unreadable, ['uploads/Photo One.jpg', 'uploads/prices.pdf']);
	});
});

describe('a whole run on a small Tina checkout', () => {
	const root = mkdtempSync(join(tmpdir(), 'tina-convert-'));
	after(() => rmSync(root, { recursive: true, force: true }));
	const write = (rel: string, data: unknown) => {
		mkdirSync(join(root, rel, '..'), { recursive: true });
		writeFileSync(join(root, rel), JSON.stringify(data, null, 2));
	};
	const img = (k: string) => `https://img.example.com/unsafe/plain/s3://media-1/${k}`;
	const mediaObject = { type: 'object', name: 'media', fields: [str('kind', { options: ['image', 'video'] }), { type: 'image', name: 'src' }, str('alt'), str('playbackId'), { type: 'number', name: 'duration' }, str('playAs', { options: ['loop', 'player'] })] };
	// A Tina template's description, which the template's aboutText puts in front of the first field's own help.
	const textMediaAbout = 'Text beside a picture or a video. Layout picks which side the media sits on. A blank field shows nothing.';
	const templates = [
		{
			name: 'textMedia',
			label: 'Text and media',
			ui: { description: textMediaAbout },
			fields: [
				str('heading', { ui: { component: 'textarea' }, description: `About this block: ${textMediaAbout} Optional. Shown at the largest size.` }),
				{ type: 'rich-text', name: 'body', overrides: { toolbar: ['bold', 'link'], headingLevels: [] } },
				{ type: 'object', list: true, name: 'buttons', fields: [str('label'), str('href'), str('style', { options: ['primary', 'secondary'] })] },
				mediaObject,
				{ type: 'object', list: true, name: 'pictures', fields: [{ type: 'image', name: 'image' }, str('imageAlt')] },
				str('background', { options: ['light', 'dark'] }),
			],
		},
		{ name: 'products', label: 'Products', fields: [{ type: 'object', list: true, name: 'picks', fields: [{ type: 'reference', name: 'product', collections: ['products'] }] }] },
	];
	const schema = {
		collections: [
			{ name: 'pages', path: 'content/pages', fields: [str('title', { isTitle: true }), { type: 'object', list: true, name: 'sections', templates }, { type: 'boolean', name: 'hidden' }, { type: 'object', name: 'seo', fields: [str('metaTitle'), { type: 'image', name: 'ogImage' }, str('ogImageAlt')] }] },
			{ name: 'products', path: 'content/products', fields: [str('title', { isTitle: true }), { type: 'image', name: 'shot' }, { type: 'object', list: true, name: 'facts', fields: [str('label')] }, { type: 'object', list: true, name: 'sections', templates }] },
			{
				name: 'siteSettings',
				path: 'content/siteSettings',
				fields: [
					{ type: 'object', list: true, name: 'menu', fields: [str('label'), str('href')] },
					{ type: 'object', name: 'formNotifications', fields: [{ type: 'object', list: true, name: 'contact', fields: [str('address')] }] },
					{ type: 'object', name: 'adminBranding', fields: [str('name'), str('accent')] },
				],
			},
		],
	};
	write('tina/__generated__/_schema.json', schema);
	write('content/pages/home.json', {
		title: 'Home',
		sections: [
			{
				_template: 'textMedia',
				heading: 'Made\nto last',
				body: 'Questions? See the Q\\&A. Read [the price list](/files/prices.pdf).\n',
				buttons: [{ label: 'Shop', href: '/products', style: 'primary' }],
				media: { kind: 'video', playbackId: 'abc', duration: 19.94, playAs: 'loop' },
				pictures: [{ image: img('uploads/a.jpg'), imageAlt: 'A' }],
				background: '',
				_stale: 'gone',
			},
			{ _template: 'products', picks: [{ product: 'content/products/tee.json' }] },
		],
		seo: { metaTitle: 'Home', ogImage: img('uploads/og.jpg'), ogImageAlt: 'Shelf' },
	});
	write('content/pages/where-to-buy.json', { title: 'Where to buy', hidden: true, sections: [] });
	write('content/products/tee.json', { title: 'Tee', shot: img('uploads/box.png'), facts: [{ label: 'size M' }, { label: '' }, { label: '2 colours' }], sections: [] });
	write('content/siteSettings/siteSettings.json', { menu: [{ label: 'About', href: '/about' }], formNotifications: { contact: [{ address: 'client@x.test' }] }, adminBranding: { name: 'Site A', accent: '#336699' } });

	/** The key map a run filled from the bucket: each Tina key → its caracms key (an image's with w/h). */
	const KEYS = {
		'uploads/a.jpg': { key: 'uploads/aaaaaaaaaaaa/a.jpg', w: 800, h: 600 },
		'uploads/og.jpg': { key: 'uploads/0a0a0a0a0a0a/og.jpg', w: 1200, h: 630 },
		'uploads/box.png': { key: 'uploads/b0b0b0b0b0b0/box.png', w: 500, h: 500 },
		'uploads/prices.pdf': { key: 'uploads/c0c0c0c0c0c0/prices.pdf' },
	};
	const run = (recipients?: string, keys: Record<string, { key: string; w?: number; h?: number }> = KEYS) => {
		const { read, conv, docs } = convertAll({ from: root, schema, keys, recipients });
		return { read, conv, texts: renderDocs(docs) };
	};

	test('the same input gives the same bytes', () => {
		assert.deepEqual([...run().texts], [...run().texts]);
	});

	test("with an empty key map, the first pass keeps Tina's keys and still lists every one the content uses", () => {
		const { texts, conv } = run(undefined, {});
		assert.deepEqual([...conv.media.keys()].sort(), ['uploads/a.jpg', 'uploads/box.png', 'uploads/og.jpg', 'uploads/prices.pdf']);
		const home = JSON.parse(texts.get('content/pages/index.json')!);
		assert.deepEqual(home.blocks[0].pictures, [{ key: 'uploads/a.jpg', alt: 'A' }]);
		assert.equal('redirects' in JSON.parse(texts.get('content/site-settings.json')!), true);
		assert.deepEqual(JSON.parse(texts.get('content/site-settings.json')!).redirects, [{ from: '/sitemap-index.xml', to: '/sitemap.xml' }], 'no file redirect until the map has its key');
	});

	test('the documents, as caracms holds them', () => {
		const { texts, conv } = run('walker@example.com');
		assert.deepEqual([...texts.keys()].sort(), ['content/pages/index.json', 'content/pages/where-to-buy.json', 'content/products/tee.json', 'content/site-settings.json']);
		const home = JSON.parse(texts.get('content/pages/index.json')!);
		assert.equal(home.$schema, '../../schemas/pages.schema.json');
		const [tm, products] = home.blocks;
		assert.equal(tm.type, 'text-media');
		assert.equal(tm.background, undefined, 'a blank select is left to its default');
		assert.equal('_stale' in tm, false);
		assert.deepEqual(tm.body, [{ p: 'Questions? See the Q&A. Read [the price list](/files/c0c0c0c0c0c0/prices.pdf).' }]);
		assert.deepEqual(tm.media, { video: 'abc', play: 'loop', duration: 19.94 });
		assert.deepEqual(tm.pictures, [{ key: 'uploads/aaaaaaaaaaaa/a.jpg', alt: 'A', w: 800, h: 600 }], "the key map's key and size");
		assert.deepEqual(products, { type: 'products', picks: ['tee'] });
		assert.deepEqual(home.seo, { title: 'Home', image: { key: 'uploads/0a0a0a0a0a0a/og.jpg', alt: 'Shelf', w: 1200, h: 630 } });
		assert.equal(JSON.parse(texts.get('content/pages/where-to-buy.json')!).hidden, true, "Tina's hidden → hidden: true");
		assert.deepEqual(JSON.parse(texts.get('content/products/tee.json')!).shot, { key: 'uploads/b0b0b0b0b0b0/box.png', alt: '', decorative: true, w: 500, h: 500 });
		assert.deepEqual(JSON.parse(texts.get('content/products/tee.json')!).facts, ['size M', '2 colours'], 'a list of one-text-field objects is unwrapped to its strings (port friction 9)');
		const settings = JSON.parse(texts.get('content/site-settings.json')!);
		assert.deepEqual(settings.formRecipients, { contact: ['walker@example.com'] }, '--recipients replaces them');
		assert.deepEqual(settings.brand, { name: 'Site A', accent: '#336699' });
		assert.deepEqual(settings.menu, [{ label: 'About', href: '/about' }]);
		assert.deepEqual(
			[...conv.media.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, m]: [string, { kind: string; where: string }]) => [k, m.kind, m.where]),
			[
				['uploads/a.jpg', 'image', 'content/pages/home.json › sections[0].pictures[0]'],
				['uploads/box.png', 'image', 'content/products/tee.json › shot'],
				['uploads/og.jpg', 'image', 'content/pages/home.json › seo.ogImage'],
				['uploads/prices.pdf', 'file', 'content/pages/home.json › sections[0].body'],
			],
			'every bucket key the content uses, with where',
		);
		assert.deepEqual(settings.redirects, [
			{ from: '/files/prices.pdf', to: '/files/c0c0c0c0c0c0/prices.pdf' },
			{ from: '/sitemap-index.xml', to: '/sitemap.xml' },
		], "each old file address to its new one, then the table's own");
		assert.ok(conv.warnings.some((w: string) => w.includes('"_stale"')));
		assert.deepEqual(JSON.parse(run().texts.get('content/site-settings.json')!).formRecipients, { contact: ['client@x.test'] });
	});

	test("the files are already in the editor's saved form", () => {
		const { texts } = run();
		const blocks = {
			'text-media': {
				component: 'x',
				fields: {
					heading: text({ multiline: true }),
					body: richTextField({ links: true }),
					buttons: buttons({ styles: ['primary', 'secondary'] }),
					media: media(),
					pictures: list(media({ only: 'image' })),
					background: select({ options: ['light', 'dark'] }),
				},
			},
			products: { component: 'x', fields: { picks: list(reference({ to: 'products' })) } },
		};
		const site = { blocks } as unknown as Parameters<typeof savedForm>[2];
		const pages = { kind: 'sections', fields: {} } as Parameters<typeof savedForm>[1];
		for (const rel of ['content/pages/index.json', 'content/pages/where-to-buy.json']) assert.equal(savedForm(texts.get(rel)!, pages, site), texts.get(rel));
		const products = { kind: 'sections', fields: { shot: media({ only: 'image' }), facts: list(text()) } } as Parameters<typeof savedForm>[1];
		assert.equal(savedForm(texts.get('content/products/tee.json')!, products, site), texts.get('content/products/tee.json'));
		const settings = { kind: 'settings', fields: { menu: list(link()), notes: group({ a: toggle() }) } } as Parameters<typeof savedForm>[1];
		assert.equal(savedForm(texts.get('content/site-settings.json')!, settings, site), texts.get('content/site-settings.json'));
	});

	test('the scaffolded config names every block and collection with the right helpers', () => {
		const config = scaffoldConfig(run().read);
		assert.match(config, /^import \{ buttons, defineSite, link, list, media, reference, richText, select, text \} from 'caracms\/config';/);
		assert.match(config, /"text-media": \{\n\t\t\tlabel: "Text and media",\n\t\t\thelp: "[^"]*",\n\t\t\tcomponent: "src\/blocks\/TextMedia\.astro"/);
		assert.match(config, /"text-media": \{\n\t\t\tlabel: "Text and media",\n\t\t\thelp: "Text beside a picture or a video\. Layout picks which side the media sits on\.",\n/, "the template's description is the block's help, a sentence or two");
		assert.match(config, /heading: text\(\{ multiline: true, heading: true, label: "heading", help: "Optional\. Shown at the largest size\." \}\)/, "the field keeps its own help");
		assert.doesNotMatch(config, /About this block/);
		assert.match(config, /products: \{\n\t\t\tlabel: "Products",\n\t\t\tcomponent:/, 'no description: no help');
		assert.match(config, /picks: list\(reference\(\{ to: "products"/);
		assert.match(config, /pictures: list\(media\(\{ only: 'image'/);
		assert.match(config, /products: \{\n\t\t\tlabel: "products",\n\t\t\tkind: 'sections',\n\t\t\tfolder: "content\/products",\n\t\t\turlBase: "\/products\/",\n\t\t\tfields: \{\n\t\t\t\tshot: media/);
		assert.match(config, /settings: \{ fields: \{\n\t\tmenu: list\(link\(\)/);
	});
});

describe("the adapt table's shared blocks, form words and redirects", () => {
	const root = mkdtempSync(join(tmpdir(), 'tina-shared-'));
	after(() => rmSync(root, { recursive: true, force: true }));
	const write = (rel: string, data: unknown) => {
		mkdirSync(join(root, rel, '..'), { recursive: true });
		writeFileSync(join(root, rel), JSON.stringify(data, null, 2));
	};
	const linkItem = { type: 'object', list: true, fields: [str('label'), str('href')] };
	const schema = {
		collections: [
			{ name: 'pages', path: 'content/pages', fields: [str('title', { isTitle: true }), { type: 'object', list: true, name: 'sections', templates: [{ name: 'intro', label: 'Intro', fields: [str('heading')] }] }] },
			{
				name: 'siteSettings',
				path: 'content/siteSettings',
				fields: [
					{ ...linkItem, name: 'menu' },
					{ type: 'object', name: 'footer', fields: [{ ...linkItem, name: 'columns' }] },
					{ type: 'object', name: 'newsletter', fields: [str('heading'), str('privacyLink'), str('blurb')] },
					str('email'),
					{ type: 'object', name: 'formNotifications', fields: [{ type: 'object', list: true, name: 'contact', fields: [str('address')] }] },
				],
			},
		],
	};
	write('tina/__generated__/_schema.json', schema);
	write('content/pages/home.json', { title: 'Home', sections: [{ _template: 'intro', heading: 'Hi' }] });
	write('content/siteSettings/siteSettings.json', {
		menu: [{ label: 'About', href: '/about' }],
		footer: { columns: [{ label: 'Prices', href: '/files/prices.pdf' }] },
		newsletter: { heading: 'Stay in touch', privacyLink: '/privacy', blurb: 'Monthly.' },
		email: 'hi@x.test',
		formNotifications: { contact: [{ address: 'client@x.test' }] },
	});
	const KEYS = { 'uploads/prices.pdf': { key: 'uploads/c0c0c0c0c0c0/prices.pdf' } };
	const SHARED: typeof SITE = {
		...SITE,
		addressFields: ['siteSettings.newsletter.privacyLink'],
		shared: {
			header: { title: 'Header', type: 'site-header', slot: 'header', fields: { menu: { from: 'menu' } } },
			footer: {
				title: 'Footer',
				type: 'site-footer',
				slot: 'footer',
				fields: {
					columns: { from: 'footer.columns' },
					newsletterHeading: { from: 'newsletter.heading' },
					privacyLink: { link: { label: 'Privacy policy', hrefFrom: 'newsletter.privacyLink' }, label: 'Privacy link' },
					contactHeading: { text: 'Contact', help: 'Email and phone.' },
				},
			},
			'not-found': {
				title: 'Page not found',
				type: 'not-found',
				fields: {
					heading: { text: 'This page\nisn’t here.', lines: true },
					intro: { text: 'It may have moved.', multiline: true },
					button: { link: { label: 'Home', href: '/' } },
				},
			},
		},
		formWords: { contact: { submit: 'Send a message', sent: { line: 'Thanks.' } } },
		redirects: [{ from: '/old', to: '/new' }],
	};
	const run = (site = SHARED) => {
		const { read, conv, docs } = convertAll({ from: root, schema, keys: KEYS, site });
		return { read, conv, texts: renderDocs(docs) };
	};

	test('a moved field leaves Site Settings (a group left empty goes too, one with fields left stays)', () => {
		const settings = JSON.parse(run().texts.get('content/site-settings.json')!);
		assert.equal('menu' in settings, false);
		assert.equal('footer' in settings, false, 'footer had only columns: the group goes');
		assert.deepEqual(settings.newsletter, { blurb: 'Monthly.' }, "newsletter keeps what wasn't moved");
		assert.equal(settings.email, 'hi@x.test');
		const config = scaffoldConfig(run().read);
		assert.match(config, /settings: \{ fields: \{\n\t\tnewsletter: group\(\{\n\t\t\tblurb: text/);
		assert.doesNotMatch(config.slice(config.indexOf('settings: {')), /menu:|columns:|privacyLink:/);
	});

	test("each shared block holds its moved fields as they were and the code's words; default only with a slot", () => {
		const { texts } = run();
		const header = JSON.parse(texts.get('content/shared/header.json')!);
		assert.deepEqual(header, { $schema: '../../schemas/shared.schema.json', title: 'Header', default: true, block: { type: 'site-header', menu: [{ label: 'About', href: '/about' }] } });
		const footer = JSON.parse(texts.get('content/shared/footer.json')!);
		assert.equal(footer.default, true);
		assert.deepEqual(footer.block, {
			type: 'site-footer',
			columns: [{ label: 'Prices', href: '/files/c0c0c0c0c0c0/prices.pdf' }],
			newsletterHeading: 'Stay in touch',
			privacyLink: { label: 'Privacy policy', href: '/privacy' },
			contactHeading: 'Contact',
		});
		const notFound = JSON.parse(texts.get('content/shared/not-found.json')!);
		assert.equal('default' in notFound, false, 'no slot, no default');
		assert.deepEqual(notFound.block, { type: 'not-found', heading: 'This page\nisn’t here.', intro: 'It may have moved.', button: { label: 'Home', href: '/' } });
	});

	test('the scaffold puts the shared blocks in blocks, with their slot and their words as fields', () => {
		const config = scaffoldConfig(run().read);
		assert.match(config, /"site-footer": \{\n\t\t\tlabel: "Footer",\n\t\t\tslot: "footer",\n\t\t\tcomponent: "src\/blocks\/SiteFooter\.astro",/);
		assert.match(config, /"not-found": \{\n\t\t\tlabel: "Page not found",\n\t\t\tcomponent:/);
		assert.match(config, /contactHeading: text\(/);
		assert.match(config, /heading: text\(\{[^)]*lines: true/);
	});

	test('a shared type that clashes with a Tina block, or a path Site Settings lacks, is an error naming it', () => {
		assert.throws(() => run({ ...SHARED, shared: { x: { title: 'X', type: 'intro', fields: {} } } }), /SITE\.shared\.x: "intro" is already a block from Tina's templates/);
		assert.throws(() => run({ ...SHARED, shared: { x: { title: 'X', type: 'x', fields: { a: { from: 'nope.here' } } } } }), /SITE\.shared\.x\.a: Site Settings has no field "nope\.here"/);
	});

	test('redirects come after formRecipients (file links first, sorted, then the table), formWords after the site\'s own fields; one redirect per line', () => {
		const text = run().texts.get('content/site-settings.json')!;
		const settings = JSON.parse(text);
		const keys = Object.keys(settings);
		assert.deepEqual(keys.slice(keys.indexOf('formRecipients')), ['formRecipients', 'redirects', 'newsletter', 'email', 'formWords']);
		assert.deepEqual(settings.redirects, [
			{ from: '/files/prices.pdf', to: '/files/c0c0c0c0c0c0/prices.pdf' },
			{ from: '/old', to: '/new' },
		]);
		assert.ok(text.includes('  "redirects": [\n    { "from": "/files/prices.pdf", "to": "/files/c0c0c0c0c0c0/prices.pdf" },\n    { "from": "/old", "to": "/new" }\n  ],\n'), text);
		assert.deepEqual(settings.formWords, { contact: { submit: 'Send a message', sent: { line: 'Thanks.' } } });
		const plain = JSON.parse(run({ ...SHARED, formWords: {}, redirects: [] }).texts.get('content/site-settings.json')!);
		assert.equal('formWords' in plain, false, 'an empty table writes no formWords');
		assert.deepEqual(plain.redirects, [{ from: '/files/prices.pdf', to: '/files/c0c0c0c0c0c0/prices.pdf' }]);
	});
});

describe("the scaffold's forms and hosting mode", () => {
	test("formsFromTina keeps the on-page label and caracms's field keys, and names the rest", () => {
		const { forms, notes } = formsFromTina([
			{
				id: 'contact',
				label: 'Contact',
				email: { subject: 'New message' },
				onSubmit: () => {},
				fields: [
					{ name: 'name', label: 'Your name', emailLabel: 'Name', autocomplete: 'name' },
					{ name: 'email', label: 'Email', emailLabel: 'Email', type: 'email' },
					{ name: 'topic', label: 'Topic', type: 'select', options: [{ value: 'a', label: 'A' }], width: 'half' },
					{ name: 'message', label: 'Message', type: 'textarea', rows: 5, optional: true },
				],
			},
			{ id: 'newsletter', fields: [{ name: 'email', label: 'Email', type: 'email' }] },
		]);
		assert.deepEqual(forms, [
			{
				id: 'contact',
				label: 'Contact',
				subject: 'New message',
				fields: [
					['name', { label: 'Your name', autocomplete: 'name' }],
					['email', { label: 'Email', type: 'email' }],
					['topic', { label: 'Topic', type: 'select', options: [{ value: 'a', label: 'A' }] }],
					['message', { label: 'Message', type: 'textarea', optional: true, rows: 5 }],
				],
			},
			{ id: 'newsletter', label: 'newsletter', subject: 'New newsletter submission', fields: [['email', { label: 'Email', type: 'email' }]] },
		]);
		assert.deepEqual(notes, [
			"contact.onSubmit has no place in caracms's form definition, so it's left out (a form's own server step: carry it over by hand)",
			'contact.name: the email\'s label "Name" goes; the on-page "Your name" names it everywhere',
			"contact.topic.width has no place in caracms's form field, so it's left out",
		]);
	});

	test('form rows Decision 16: a source, a select\'s placeholder and a watermark carry over; a type caracms lacks is left out with a note naming rows (Acceptance 28)', () => {
		const { forms, notes } = formsFromTina(
			[
				{
					id: 'apply',
					label: 'Job application',
					fields: [
						{ name: 'job', label: 'Role', type: 'select', optional: true, options: [{ value: 'general', label: 'Any role' }], source: 'jobs' },
						{ name: 'email', label: 'Email', type: 'email' },
					],
				},
				{
					id: 'order',
					label: 'Order',
					fields: [
						{ name: 'email', label: 'Email', type: 'email' },
						{ name: 'orderLines', label: 'Order', type: 'orderLines', productLabel: 'Product', amountLabel: 'Amount' },
						{ name: 'deliveryOption', label: 'Delivery', type: 'select', placeholder: 'eg. Collect', options: [{ value: 'collect', label: 'Collect' }] },
						{ name: 'budget', label: 'Budget', optional: true, prefix: '$', watermark: 'USD', placeholder: 'e.g. 500' },
					],
				},
			],
			{ jobs: { toggles: ['live'] } },
		);
		const fields = Object.fromEntries(forms.flatMap((f) => f.fields.map(([name, field]) => [`${f.id}.${name}`, field])));
		assert.deepEqual(fields['apply.job'], { label: 'Role', type: 'select', optional: true, options: [{ value: 'general', label: 'Any role' }], source: { collection: 'jobs' } });
		assert.equal(fields['order.orderLines'], undefined, 'left out');
		assert.deepEqual(fields['order.deliveryOption'], { label: 'Delivery', type: 'select', options: [{ value: 'collect', label: 'Collect' }], placeholder: 'eg. Collect' });
		assert.deepEqual(fields['order.budget'], { label: 'Budget', optional: true, placeholder: 'e.g. 500', prefix: '$', suffix: 'USD' });
		assert.ok(notes.some((n) => n.startsWith('apply.job lists every document of "jobs"') && n.includes("where: 'live'") && n.includes('a blank one read as on')), notes.join('\n'));
		const rowsNote = notes.find((n) => n.startsWith('order.orderLines'));
		assert.match(rowsNote ?? '', /"orderLines" field, which caracms doesn't have, so it's left out\. .*type: 'rows'.*The template's field: \{"name":"orderLines"/);
		assert.equal(notes.filter((n) => n.startsWith('order.orderLines.')).length, 0, "a left-out field's keys aren't named one by one");
		// The scaffold writes the source as an object, and the config passes checkForms.
		const config = scaffoldConfig({ collections: {}, blocks: new Map(), settingsSpecs: [], sharedBlocks: [] }, { forms });
		assert.match(config, /job: \{ label: "Role", type: "select", optional: true, options: \[\{ value: "general", label: "Any role" \}\], source: \{ collection: "jobs" \} \},/);
		assert.match(config, /budget: \{ label: "Budget", optional: true, placeholder: "e\.g\. 500", prefix: "\$", suffix: "USD" \},/);
		const asConfig = Object.fromEntries(forms.map((f) => [f.id, { label: f.label, email: { subject: f.subject }, fields: Object.fromEntries(f.fields) }]));
		const checked = checkForms(asConfig, (m) => assert.fail(m), { jobs: { kind: 'fields', fields: { live: { kind: 'toggle' } } } });
		assert.deepEqual(Object.keys(checked), ['apply', 'order']);
	});

	test("the scaffold writes the forms, and keeps init's hosting mode", () => {
		const read = { collections: {}, blocks: new Map(), settingsSpecs: [], sharedBlocks: [] };
		const config = scaffoldConfig(read, { forms: formsFromTina([{ id: 'contact', label: 'Contact', fields: [{ name: 'email', label: 'Email', type: 'email' }] }]).forms, services: 'cloud' });
		assert.match(config, /export default defineSite\(\{\n\tservices: "cloud",\n\tcollections: \{/);
		assert.match(config, /\tforms: \{\n\t\tcontact: \{\n\t\t\tlabel: "Contact",\n\t\t\temail: \{ subject: "New contact submission" \},\n\t\t\tfields: \{\n\t\t\t\temail: \{ label: "Email", type: "email" \},\n\t\t\t\},\n\t\t\},\n\t\},\n/);
		assert.doesNotMatch(scaffoldConfig(read), /services:|forms:/, 'neither, when there are none');
	});
});

describe('a collection the adapt table names is held by its page', () => {
	const root = mkdtempSync(join(tmpdir(), 'tina-held-'));
	after(() => rmSync(root, { recursive: true, force: true }));
	const write = (rel: string, data: unknown) => {
		mkdirSync(join(root, rel, '..'), { recursive: true });
		writeFileSync(join(root, rel), JSON.stringify(data, null, 2));
	};
	const templates = [{ name: 'intro', label: 'Intro', fields: [str('heading')] }];
	const sections = { type: 'object', list: true, name: 'sections', templates };
	const schema = {
		collections: [
			{ name: 'pages', path: 'content/pages', fields: [str('title', { isTitle: true }), sections, { type: 'boolean', name: 'hidden' }] },
			// Products: a sections collection whose page (products.json) is at its base. Work: a fields collection, same.
			{ name: 'products', path: 'content/products', fields: [str('title', { isTitle: true }), sections] },
			{ name: 'work', path: 'content/work', fields: [str('title', { isTitle: true }), str('client')] },
			// Notes: no Notes page, so a prefix in code.
			{ name: 'notes', path: 'content/notes', fields: [str('title', { isTitle: true }), sections] },
		],
	};
	write('tina/__generated__/_schema.json', schema);
	for (const name of ['home', 'products', 'work', 'about']) write(`content/pages/${name}.json`, { title: name, hidden: name === 'products', sections: [{ _template: 'intro', heading: name }] });
	write('content/products/tee.json', { title: 'Tee', sections: [] });
	write('content/work/atlas.json', { title: 'Atlas', client: 'A client' });
	write('content/notes/first.json', { title: 'First', sections: [] });
	// The table is the only source of holding: Products and Work are named, Notes isn't.
	const HELD: typeof SITE = { ...SITE, holders: { products: 'products', work: 'work' } };
	const run = (site = HELD) => {
		const { read, docs } = convertAll({ from: root, schema, site });
		return { read, texts: renderDocs(docs) };
	};

	test('the page says what it holds, after its title and hidden; other pages say nothing', () => {
		const { texts } = run();
		const products = texts.get('content/pages/products.json')!;
		assert.deepEqual(Object.keys(JSON.parse(products)), ['$schema', 'title', 'hidden', 'holds', 'blocks']);
		assert.equal(JSON.parse(products).holds, 'products');
		assert.equal(JSON.parse(texts.get('content/pages/work.json')!).holds, 'work');
		for (const rel of ['content/pages/index.json', 'content/pages/about.json']) assert.equal('holds' in JSON.parse(texts.get(rel)!), false, rel);
		assert.equal(texts.has('content/notes/first.json'), true);
		assert.equal('holds' in JSON.parse(texts.get('content/products/tee.json')!), false);
		const pages = { kind: 'sections', fields: {} } as Parameters<typeof savedForm>[1];
		const site = { blocks: { intro: { component: 'x', fields: { heading: text() } } } } as unknown as Parameters<typeof savedForm>[2];
		assert.equal(savedForm(products, pages, site), products, 'already in the editor\'s saved form');
	});

	test('the scaffold writes heldBy for a held collection (no urlBase), and keeps urlBase for a prefix', () => {
		const config = scaffoldConfig(run().read);
		assert.match(config, /products: \{\n\t\t\tlabel: "products",\n\t\t\tkind: 'sections',\n\t\t\tfolder: "content\/products",\n\t\t\theldBy: 'pages',\n/);
		assert.match(config, /work: \{\n\t\t\tlabel: "work",\n\t\t\tkind: 'fields',\n\t\t\tfolder: "content\/work",\n\t\t\theldBy: 'pages',\n\t\t\tcomponent:/);
		assert.doesNotMatch(config, /urlBase: "\/products\/"|urlBase: "\/work\/"/);
		assert.match(config, /notes: \{\n\t\t\tlabel: "notes",\n\t\t\tkind: 'sections',\n\t\t\tfolder: "content\/notes",\n\t\t\turlBase: "\/notes\/",\n/);
		assert.match(config, /pages: \{\n\t\t\tlabel: "pages",\n\t\t\tkind: 'sections',\n\t\t\tfolder: "content\/pages",\n\t\t\turlBase: "\/",\n\t\t\tnested: true,/, 'the pages keep their base');
	});

	test("the adapt table names a page that isn't called like its collection", () => {
		const posts = { name: 'posts', path: 'content/posts', fields: [str('title', { isTitle: true }), sections] };
		const s = { collections: [...schema.collections, posts] };
		write('content/pages/blog.json', { title: 'Blog', sections: [] });
		write('content/posts/one.json', { title: 'One', sections: [] });
		const without = convertAll({ from: root, schema: s, site: HELD });
		assert.equal(without.read.collections.posts.holder, undefined, 'not in the table: not held');
		const site = { ...HELD, holders: { ...HELD.holders, posts: 'blog' } };
		const { read, docs } = convertAll({ from: root, schema: s, site });
		assert.equal(read.collections.posts.holder, 'blog');
		assert.equal(JSON.parse(renderDocs(docs).get('content/pages/blog.json')!).holds, 'posts');
		assert.match(scaffoldConfig(read), /posts: \{\n\t\t\tlabel: "posts",\n\t\t\tkind: 'sections',\n\t\t\tfolder: "content\/posts",\n\t\t\theldBy: 'pages',\n/);
	});

	test('with an empty table nothing is held, even where a page is named like a collection', () => {
		const { read, texts } = run(SITE);
		for (const key of ['products', 'work', 'notes']) assert.equal(read.collections[key].holder, undefined, key);
		for (const rel of ['products', 'work', 'about', 'index'].map((n) => `content/pages/${n}.json`)) assert.equal('holds' in JSON.parse(texts.get(rel)!), false, rel);
		const config = scaffoldConfig(read);
		assert.match(config, /products: \{\n\t\t\tlabel: "products",\n\t\t\tkind: 'sections',\n\t\t\tfolder: "content\/products",\n\t\t\turlBase: "\/products\/",\n/);
		assert.doesNotMatch(config, /heldBy/);
	});

	test('a sections collection with a same-named page, not in the table, is suggested; a fields collection is not', () => {
		const { read } = run(SITE);
		assert.equal(read.holderCandidates.length, 1, read.holderCandidates.join('\n'));
		assert.match(read.holderCandidates[0], /^products has a page at content\/pages\/products\.json: to have that page hold it, add products: 'products' to SITE\.holders, then re-run with --scaffold-config --force$/);
		assert.deepEqual(run(HELD).read.holderCandidates, [], 'a collection the table names is not suggested');
		const named = run({ ...SITE, holders: { work: 'work' } }).read;
		assert.deepEqual(named.holderCandidates.map((l: string) => l.split(' ')[0]), ['products'], 'the table may name a fields collection; the rest are still suggested');
		assert.equal(named.collections.work.holder, 'work');
	});

	test("a table entry naming a page that doesn't exist is a warning, not a crash", () => {
		const { read, conv } = convertAll({ from: root, schema, site: { ...SITE, holders: { notes: 'nowhere' } } });
		assert.equal(read.collections.notes.holder, undefined);
		assert.ok(conv.warnings.some((w: string) => /SITE\.holders: notes is held by the page "nowhere", but there's no content\/pages\/nowhere\.json/.test(w)), conv.warnings.join('\n'));
	});

	test('Home never holds a collection, even one named like it', () => {
		const home = mkdtempSync(join(tmpdir(), 'tina-held-home-'));
		try {
			mkdirSync(join(home, 'content/pages'), { recursive: true });
			writeFileSync(join(home, 'content/pages/home.json'), JSON.stringify({ title: 'Home', sections: [] }));
			const s = { collections: [schema.collections[0]!, { name: 'home', path: 'content/home', fields: [str('title', { isTitle: true }), sections] }] };
			const { read, docs } = convertAll({ from: home, schema: s, site: { ...SITE, holders: { home: 'home' } } });
			assert.equal(read.collections.home.holder, undefined);
			assert.equal('holds' in JSON.parse(renderDocs(docs).get('content/pages/index.json')!), false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
