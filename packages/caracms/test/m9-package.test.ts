// M9 (the Tina port): the package's shared line, checked without a site.
// - Decision 8 / check 4: a media field can serve its images as PNG.
// - Decision 10 / check 5: the lines rendering's field option, and the preview's text reader.
// - Decision 11 / check 6: a heading rich-text field's grammar, its editor document, and its warnings.
// - Decision 9: `<Blocks wrap>`'s runs as a tree, and the sentences for runs that don't fit.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CaracmsConfigError, media, resolveSite, richText, text } from '../src/config.ts';
import { headingPaths, fieldWarnings, parseField, fieldToJson } from '../src/fields.ts';
import { fromDoc, toDoc, type PMNode } from '../src/editor/client/fields/rich-text-doc.ts';
import { readRichText, richHeadingHtml, richTextPlain } from '../src/rich-text.ts';
import { IMAGE_WIDTHS, MEMORY_MEDIA, fixedImage, fluidImage, imageUrl, type MediaSettings } from '../src/media.ts';
import { runTree, type RunNode } from '../src/block-runs.ts';
import { siteRoot, variant } from './helpers/site.ts';

const SETTINGS: MediaSettings = { origin: 'https://img.test', key: MEMORY_MEDIA.key, salt: MEMORY_MEDIA.salt, bucket: 'bucket', memory: true };
const KEY = 'uploads/3f9a1c07b2e4/steps-dice.png';
const urls = (srcset: string) => srcset.split(', ').map((e) => e.split(' ')[0]!);

describe('PNG media (Decision 8, check 4)', () => {
	test('media({ format: "png" }) keeps the option; a plain media field has none', () => {
		assert.equal(media({ format: 'png' }).format, 'png');
		assert.equal('format' in media(), false);
	});

	test('a PNG image ends @png at every width, fluid and fixed; the default stays WebP', () => {
		const fluid = fluidImage(SETTINGS, { key: KEY, focal: null, w: 1200, h: 800 }, { sizes: '50vw', format: 'png' });
		assert.equal(urls(fluid.srcset!).length, IMAGE_WIDTHS.length);
		for (const url of [fluid.src, ...urls(fluid.srcset!)]) assert.match(url, /@png$/);
		const ratio = fluidImage(SETTINGS, { key: KEY, focal: [0.5, 0.5], w: 1200, h: 800 }, { sizes: '50vw', ratio: 1, format: 'png' });
		for (const url of urls(ratio.srcset!)) assert.match(url, /rs:fill:.*@png$/);
		const fixed = fixedImage(SETTINGS, { key: KEY, focal: null, w: 400, h: 400 }, { width: 64, format: 'png' });
		for (const url of urls(fixed.srcset!)) assert.match(url, /@png$/);
		const plain = fluidImage(SETTINGS, { key: KEY, focal: null, w: 1200, h: 800 }, { sizes: '50vw' });
		for (const url of urls(plain.srcset!)) assert.match(url, /@webp$/);
		assert.match(imageUrl(SETTINGS, KEY, { width: 160 }), /@webp$/);
	});

	test('a PNG and a WebP URL for the same size are signed apart', () => {
		const png = imageUrl(SETTINGS, KEY, { width: 160, format: 'png' });
		const webp = imageUrl(SETTINGS, KEY, { width: 160 });
		assert.notEqual(png.split('/')[3], webp.split('/')[3]);
	});

	test('the config refuses an unknown format, and a format on a video-only slot', () => {
		const withField = (field: unknown) => variant({ blocks: { art: { component: 'Block.astro', fields: { art: field } } } } as never);
		assert.throws(() => resolveSite(withField({ kind: 'media', format: 'gif' }), siteRoot), (e: Error) => e instanceof CaracmsConfigError && /format must be 'png' or 'webp'/.test(e.message));
		assert.throws(() => resolveSite(withField(media({ only: 'video', format: 'png' })), siteRoot), (e: Error) => e instanceof CaracmsConfigError && /format is for images/.test(e.message));
		assert.doesNotThrow(() => resolveSite(withField(media({ format: 'png' })), siteRoot));
	});
});

const withField = (field: unknown) => variant({ blocks: { b: { component: 'Block.astro', fields: { f: field } } } } as never);
const refused = (field: unknown, pattern: RegExp) => assert.throws(() => resolveSite(withField(field), siteRoot), (e: Error) => e instanceof CaracmsConfigError && pattern.test(e.message));

describe('the lines rendering\'s field (Decision 10, check 5)', () => {
	test('text({ lines: true }) is multiline; lines with multiline off is refused', () => {
		const field = text({ lines: true, heading: true });
		assert.deepEqual([field.multiline, field.lines, field.heading], [true, true, true]);
		assert.equal('lines' in text(), false);
		refused({ kind: 'text', multiline: false, heading: false, lines: true }, /text\(\{ lines: true \}\)/);
		assert.doesNotThrow(() => resolveSite(withField(field), siteRoot));
	});
});

describe('heading rich text (Decision 11, check 6)', () => {
	const heading = richText({ heading: true });

	test('richText({ heading: true }) has no headings and no links, and is a heading field', () => {
		assert.deepEqual([heading.heading, heading.headings, heading.links], [true, [], false]);
		assert.deepEqual(headingPaths({ intro: text(), statement: heading }), ['statement']);
		assert.equal('heading' in richText(), false);
	});

	test('the config refuses headings or links on a heading field', () => {
		refused({ ...heading, headings: ['h2'] }, /can't hold headings of its own/);
		refused({ ...heading, links: true }, /bold and line breaks only, not links/);
	});

	test('paragraphs and bold only: a list\'s items become lines, italic and links drop, each with a warning', () => {
		const raw = [{ p: 'Play **hard**' }, { h2: 'A heading' }, { ul: ['One', 'Two'] }, { p: '*Soft* [link](/about)' }];
		const { value, issues } = readRichText(raw, { headings: [], links: false, heading: true });
		assert.deepEqual(value, [
			{ kind: 'p', runs: [{ text: 'Play ' }, { text: 'hard', bold: true }] },
			{ kind: 'p', runs: [{ text: 'A heading' }] },
			{ kind: 'p', runs: [{ text: 'One' }] },
			{ kind: 'p', runs: [{ text: 'Two' }] },
			{ kind: 'p', runs: [{ text: 'Soft link' }] },
		]);
		assert.deepEqual(issues.map((i) => i.code), ['disallowed-kind', 'disallowed-kind', 'link-off', 'italic-off']);
		assert.deepEqual(fieldWarnings(heading, raw).map((w) => w.code), ['disallowed-kind', 'disallowed-kind', 'link-off', 'italic-off']);
		assert.deepEqual(fieldToJson(heading, parseField(heading, raw)), [{ p: 'Play **hard**' }, { p: 'A heading' }, { p: 'One' }, { p: 'Two' }, { p: 'Soft link' }]);
	});

	test('its HTML is the lines joined by <br>; its plain text is the words', () => {
		const value = parseField(heading, [{ p: 'Play **hard**' }, { p: 'Win' }]) as never;
		assert.equal(richHeadingHtml(value), 'Play <strong>hard</strong><br>Win');
		assert.equal(richTextPlain(value), 'Play hard\nWin');
	});

	test('the editor\'s document is inline content; every break reads back as a new line', () => {
		const options = { headings: [], links: false, heading: true } as const;
		const value = parseField(heading, [{ p: 'Play **hard**' }, { p: 'Win' }]) as never;
		const docJson = toDoc(value, options);
		assert.deepEqual(docJson, {
			type: 'doc',
			content: [{ type: 'text', text: 'Play ' }, { type: 'text', text: 'hard', marks: [{ type: 'bold' }] }, { type: 'hardBreak' }, { type: 'text', text: 'Win' }],
		});
		assert.deepEqual(fromDoc(docJson, options), value);
		// Typed: a break in the middle of bold splits it into two lines; an empty line drops.
		const typed: PMNode = { type: 'doc', content: [{ type: 'text', text: 'a', marks: [{ type: 'bold' }] }, { type: 'hardBreak' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] };
		assert.deepEqual(fromDoc(typed, options), [
			{ kind: 'p', runs: [{ text: 'a', bold: true }] },
			{ kind: 'p', runs: [{ text: 'b' }] },
		]);
		assert.deepEqual(toDoc([], options), { type: 'doc' });
	});
});

describe('runs of blocks (Decision 9)', () => {
	const Band = () => null;
	const Card = () => null;
	const shape = (nodes: RunNode[]): unknown => nodes.map((n) => (n.kind === 'entry' ? n.index : { [(n.component as () => null) === Band ? 'band' : 'card']: shape(n.children), ...(Object.keys(n.props).length ? { props: n.props } : {}) }));

	test('a band of cards: the entries between go inside, the rest stay as they are', () => {
		const tree = runTree([0, 1, 2, 3, 4, 5, 6, 7], [
			{ from: 2, to: 6, component: Band, runs: [{ from: 2, to: 4, component: Card, props: { id: 'story' } }, { from: 5, to: 6, component: Card, props: { id: 'team' } }] },
		]);
		assert.deepEqual(shape(tree), [0, 1, { band: [{ card: [2, 3, 4], props: { id: 'story' } }, { card: [5, 6], props: { id: 'team' } }] }, 7]);
	});

	test('no runs: the entries as they are; a run over a skipped index keeps the entries it has', () => {
		assert.deepEqual(shape(runTree([0, 1, 2], [])), [0, 1, 2]);
		assert.deepEqual(shape(runTree([0, 2, 3], [{ from: 1, to: 2, component: Card }])), [0, { card: [2] }, 3]);
	});

	test('runs out of order, overlapping, outside their parent or backwards stop the render with a sentence', () => {
		assert.throws(() => runTree([0, 1, 2, 3], [{ from: 2, to: 3, component: Card }, { from: 0, to: 1, component: Card }]), /the run 0–1 starts before the run 2–3 ends/);
		assert.throws(() => runTree([0, 1, 2, 3], [{ from: 0, to: 2, component: Card }, { from: 2, to: 3, component: Card }]), /starts before/);
		assert.throws(() => runTree([0, 1, 2, 3], [{ from: 1, to: 2, component: Band, runs: [{ from: 0, to: 1, component: Card }] }]), /the run 0–1 isn't inside the run 1–2/);
		assert.throws(() => runTree([0, 1], [{ from: 1, to: 0, component: Card }]), /from at or before to/);
		assert.throws(() => runTree([0, 1], [{ from: 0, to: 1, component: null }]), /has no component/);
	});
});
