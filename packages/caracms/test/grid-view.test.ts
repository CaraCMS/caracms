/**
 * M6c (G5): the grid view, everything but the browser. Which collections get the
 * List / Grid switch and `view`'s refusals (Decisions 13, 17; Acceptance 19, 22); each
 * card's picture, from the listing (Decision 14; Acceptance 20–22); the signed URLs the
 * listing carries (Decision 19; Acceptance 25); the choice in the UI cookie (Decision 18;
 * Acceptance 24); Grid's order select and a card's captions (Decision 16; Acceptance 20, 23).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { join } from 'node:path';
import { date, list, media, resolveSite, select, text, toggle, type SiteConfig } from '../src/config.ts';
import { filesSource, listDocuments } from '../src/content.ts';
import { fieldsCover, sectionsCover, type CardCover } from '../src/cards.ts';
import { MEMORY_MEDIA, signPath, type MediaSettings } from '../src/media.ts';
import { cardPicture, withCards } from '../src/editor/server/cards.ts';
import { parseUiState, serializeUiState, viewModeOf, withViewMode } from '../src/editor/ui-state.ts';
import { captionColumns, orderOptions, orderValue, tableColumns } from '../src/editor/client/collections/table.ts';
import type { ListedDocument } from '../src/editor/types.ts';
import { config, siteRoot, variant } from './helpers/site.ts';

const signing: MediaSettings = { ...MEMORY_MEDIA, memory: true };

const caseFields = {
	client: text({ label: 'Client' }),
	sector: select({ options: ['food', 'craft'] }),
	featured: toggle(),
	launched: date(),
	summary: text({ multiline: true }),
	gallery: list(media({ only: 'image' })),
	cover: media({ only: 'image' }),
};
const cases = { kind: 'fields', folder: 'content/case-studies', urlBase: '/work', component: 'Block.astro', fields: caseFields, columns: ['client', 'featured', 'sector', 'launched'] } as const;
const people = { kind: 'fields', folder: 'content/people', component: 'Block.astro', fields: { role: text() } } as const;
const pictureBlocks = { ...config.blocks, picture: { component: 'Block.astro', fields: { caption: text(), image: media() } } };

const resolve = (patch: Partial<SiteConfig>) => resolveSite(variant(patch), siteRoot);
const refused = (patch: Partial<SiteConfig>, pattern: RegExp) => assert.throws(() => resolve(patch), pattern);

describe('the grid view', () => {
	test('Decision 13: the switch on a fields collection with a media field (lists included) and a flat section builder when a block holds one; never Pages, Shared blocks, Site Settings, or a collection with no media', () => {
		const s = resolve({ collections: { ...config.collections, 'case-studies': cases, people } as never, blocks: pictureBlocks });
		assert.deepEqual(s.collections['case-studies']!.view, { default: 'list', image: null, ratio: '4:3' });
		assert.deepEqual(s.collections.journal!.view, { default: 'list', image: null, ratio: '4:3' });
		assert.equal(s.collections.people!.view, null, 'no media field: no switch');
		assert.equal(s.collections.pages!.view, null, 'Pages is a tree');
		assert.equal(s.collections.shared!.view ?? null, null);
		assert.equal(s.collections.settings!.view ?? null, null);

		const noPictures = resolve({ collections: { ...config.collections } as never });
		assert.equal(noPictures.collections.journal!.view, null, "no block has a media field: the journal gets no switch");
		const pageField = resolve({ collections: { ...config.collections, journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal', fields: { lead: media() } } } as never });
		assert.ok(pageField.collections.journal!.view, 'a page field with media is enough');
		const inList = resolve({ collections: { x: { ...people, folder: 'content/x', fields: { credits: list({ name: text(), photo: media() }) } } } as never });
		assert.ok(inList.collections.x!.view, 'a media field inside a list of fields counts');
	});

	test('Decision 17: view takes default, image and ratio; image names a media field or a list of media', () => {
		const withView = (view: unknown, extra: object = {}) => ({ collections: { ...config.collections, 'case-studies': { ...cases, view, ...extra } } as never, blocks: pictureBlocks });
		assert.deepEqual(resolve(withView({ default: 'grid', ratio: '3:2', image: 'cover' })).collections['case-studies']!.view, { default: 'grid', image: 'cover', ratio: '3:2' });
		assert.equal(resolve(withView({ image: 'gallery' })).collections['case-studies']!.view!.image, 'gallery');
		assert.deepEqual(resolve({ collections: { ...config.collections, journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal', view: { default: 'grid', ratio: '1:1' } } } as never, blocks: pictureBlocks }).collections.journal!.view, { default: 'grid', image: null, ratio: '1:1' });

		refused(withView({ image: 'summary' }), /view\.image: "summary" is a text field; a card's picture comes from a media field, or a list of media/);
		refused(withView({ image: 'nope' }), /view\.image: "nope" isn't one of its fields/);
		refused(withView({ image: 'credits' }, { fields: { ...caseFields, credits: list({ name: text(), photo: media() }) } }), /"credits" is a list of fields/);
		refused(withView({ ratio: '5:4' }), /view\.ratio must be one of '4:3', '3:2', '1:1', '16:9', '3:4'/);
		refused(withView({ default: 'cards' }), /view\.default must be 'list' or 'grid'/);
		refused(withView({ columns: 2 }), /view has no "columns"/);
		refused(withView('grid'), /view must be an object/);
		refused({ collections: { ...config.collections, journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal', view: { image: 'image' } } } as never, blocks: pictureBlocks }, /view\.image is for a list-of-fields collection/);
		refused({ collections: { ...config.collections, people: { ...people, view: { default: 'grid' } } } as never }, /collection "people": view: its documents have no media field/);
		refused({ collections: { ...config.collections, journal: { kind: 'sections', folder: 'content/journal', urlBase: '/journal', view: {} } } as never }, /none of the blocks it offers has a media field/);
		refused({ collections: { pages: { kind: 'sections', folder: 'content/pages', urlBase: '/', nested: true, view: {} } } as never, blocks: pictureBlocks }, /a nested one \(Pages\) is a tree/);
	});

	test("Decision 14: a fields document's picture is its first image in schema order, or view.image's (a list's first item)", () => {
		const img = (key: string, extra: object = {}) => ({ key: `uploads/abc123/${key}`, alt: `${key} alt`, ...extra });
		const fields = resolve({ collections: { ...config.collections, 'case-studies': cases } as never }).collections['case-studies']!.fields!;
		assert.deepEqual(fieldsCover(fields, { gallery: [{}, img('a.jpg', { focal: [0.2, 0.8] })], cover: img('c.jpg') }, null), { kind: 'image', key: 'uploads/abc123/a.jpg', alt: 'a.jpg alt', focal: [0.2, 0.8] }, 'the gallery comes first in schema order, its first real item');
		assert.equal(fieldsCover(fields, { gallery: [], cover: img('c.jpg') }, null)?.kind, 'image');
		assert.equal((fieldsCover(fields, { gallery: [img('a.jpg')], cover: img('c.jpg') }, 'cover') as { key: string }).key, 'uploads/abc123/c.jpg', 'view.image names the cover: the gallery before it is passed over');
		assert.equal((fieldsCover(fields, { gallery: [img('a.jpg'), img('b.jpg')], cover: img('c.jpg') }, 'gallery') as { key: string }).key, 'uploads/abc123/a.jpg');
		assert.equal(fieldsCover(fields, { gallery: [img('a.jpg')] }, 'cover'), null, 'view.image names the field: nothing else stands in');
		assert.equal(fieldsCover(fields, {}, null), null, 'no image: a text card');
		assert.equal(fieldsCover(fields, { cover: { key: 'uploads/abc123/d.jpg', alt: '', decorative: true } }, null)?.kind, 'image', 'a decorative image is still the picture');
	});

	test("Decision 14: a section builder's picture is its page fields' first, then the first image in any block, shared entries and unknown blocks skipped; a clip (a loop too) is its poster", () => {
		const schemas = { text: { fields: { body: text() } }, picture: { fields: { image: media() } }, loop: { fields: { clip: media({ play: 'loop' }) } } };
		const block = (type: string, data: Record<string, unknown>, extra: object = {}) => ({ source: 0, type, known: true, data, ...extra });
		const image = { key: 'uploads/abc123/press.jpg', alt: 'The press', focal: [0.5, 0.4] };
		assert.deepEqual(
			sectionsCover(null, undefined, [block('text', { body: 'Hello' }), block('picture', { image })], schemas),
			{ kind: 'image', key: image.key, alt: 'The press', focal: [0.5, 0.4] },
			'an entry that opens with text still shows the picture further down',
		);
		assert.equal(sectionsCover(null, undefined, [block('picture', { image: { key: 'uploads/abc123/x.jpg', alt: '' } }, { shared: 'footer', known: false }), block('mystery', { image }, { known: false }), block('picture', { image })], schemas)?.kind, 'image');
		assert.equal((sectionsCover(null, undefined, [block('picture', { image: { key: 'uploads/abc123/x.jpg', alt: '' } }, { shared: 'footer', known: false }), block('text', { body: '' })], schemas)), null, 'a shared entry is skipped');
		assert.deepEqual(sectionsCover(null, undefined, [block('loop', { clip: { video: 'pb123', play: 'loop', poster: 2.5, duration: 14, name: 'Ridge' } }), block('picture', { image })], schemas), { kind: 'clip', playbackId: 'pb123', time: 2.5, duration: 14, name: 'Ridge' });
		const lead = { key: 'uploads/abc123/lead.jpg', alt: 'Lead' };
		assert.equal((sectionsCover({ lead: media() }, { lead }, [block('picture', { image })], schemas) as { key: string }).key, lead.key, 'a page field counts before the blocks');
		assert.equal(sectionsCover(null, undefined, [block('text', { body: 'Only words' })], schemas), null);
	});

	test('the listing carries each cover (content.ts), only in a collection with the switch', async () => {
		const s = resolve({ collections: { ...config.collections, 'case-studies': cases, people } as never, blocks: pictureBlocks });
		const files = new Map<string, string>([
			['content/journal/press.json', JSON.stringify({ title: 'Press', blocks: [{ type: 'text', body: 'Words' }, { type: 'picture', image: { key: 'uploads/abc123/press.jpg', alt: 'Press', focal: [0.3, 0.7] } }] })],
			['content/journal/words.json', JSON.stringify({ title: 'Words', blocks: [{ type: 'text', body: 'Only words' }] })],
			['content/case-studies/harbour.json', JSON.stringify({ title: 'Harbour', cover: { key: 'uploads/abc123/h.jpg', alt: 'Shopfront' } })],
			['content/people/aoife.json', JSON.stringify({ title: 'Aoife', role: 'Designer' })],
			['content/pages/index.json', JSON.stringify({ title: 'Home', blocks: [{ type: 'picture', image: { key: 'uploads/abc123/home.jpg', alt: '' } }] })],
		]);
		const source = filesSource(siteRoot, () => new Map([...files].map(([k, v]) => [k, v])));
		const entries = await listDocuments({ ...s, root: siteRoot, collections: Object.fromEntries(Object.entries(s.collections).map(([k, c]) => [k, { ...c, dir: join(siteRoot, c.folder) }])) }, undefined, source);
		const by = (path: string) => entries.find((e) => e.path === path)!;
		assert.deepEqual(by('press').cover, { kind: 'image', key: 'uploads/abc123/press.jpg', alt: 'Press', focal: [0.3, 0.7] });
		assert.equal(by('words').cover, undefined, 'no image: no cover (a text card)');
		assert.equal(by('harbour').cover?.kind, 'image');
		assert.equal(by('aoife').cover, undefined);
		assert.equal(by('index').cover, undefined, 'Pages never gets one');
	});

	test('Decision 19: each card carries rs:fill URLs at the ratio with the focal point as gravity, at 320 and its 2× 640, signed; a clip its cropped Mux poster', () => {
		const cover: CardCover = { kind: 'image', key: 'uploads/6d1f0a93be27/harbour-shopfront.jpg', alt: 'The shopfront', focal: [0.62, 0.55] };
		const card = cardPicture(signing, cover, '4:3')!;
		assert.equal(card.kind, 'image');
		assert.equal(card.alt, 'The shopfront');
		assert.match(card.src, /^https:\/\/img\.test\/[\w-]+\/rs:fill:320:240\/g:fp:0\.62:0\.55\/q:80\/plain\/s3:\/\/caracms-test-media\/uploads\/6d1f0a93be27\/harbour-shopfront\.jpg@webp$/);
		assert.match(card.src2x, /\/rs:fill:640:480\/g:fp:0\.62:0\.55\//);
		const path = card.src.slice(card.src.indexOf('/', 'https://img.test/'.length));
		assert.equal(card.src, `${MEMORY_MEDIA.origin}/${signPath(path, MEMORY_MEDIA.key, MEMORY_MEDIA.salt)}${path}`, 'signed with the image keys');
		assert.ok(!card.src.includes('/_caracms/'), 'never the thumbnail route');
		assert.match(cardPicture(signing, cover, '3:2')!.src, /rs:fill:320:213\//);
		assert.match(cardPicture(signing, cover, '3:4')!.src2x, /rs:fill:640:853\//);
		assert.doesNotMatch(cardPicture(signing, { ...cover, focal: null }, '4:3')!.src, /g:fp/);
		assert.equal((cardPicture(signing, { ...cover, focal: [0.62, 0.55] }, '4:3') as { position: string }).position, '62% 55%');

		const clip = cardPicture(signing, { kind: 'clip', playbackId: 'pb123', time: 2.5, duration: 14, name: 'Ridge' }, '16:9')!;
		assert.deepEqual(clip, {
			kind: 'clip',
			src: 'https://image.mux.com/pb123/thumbnail.webp?width=320&height=180&fit_mode=crop&time=2.5',
			src2x: 'https://image.mux.com/pb123/thumbnail.webp?width=640&height=360&fit_mode=crop&time=2.5',
			alt: 'Ridge',
			duration: 14,
		});
		assert.equal(cardPicture(null, cover, '4:3'), null, 'without the image variables, no URL: a text card');
		assert.ok(cardPicture(null, { kind: 'clip', playbackId: 'pb', time: null, duration: null, name: '' }, '4:3'), "a clip's poster needs no signing");
	});

	test("withCards swaps each cover for its card, at the collection's ratio, and the cover never leaves the server", () => {
		const s = resolve({ collections: { ...config.collections, 'case-studies': { ...cases, view: { ratio: '1:1' } } } as never, blocks: pictureBlocks });
		const listed = (path: string, collection: string, cover?: object): ListedDocument => ({ collection, kind: 'fields', path, file: `content/${collection}/${path}.json`, url: null, title: path, label: path, warning: null, mtimeMs: 0, ...(cover ? { cover: cover as never } : {}) });
		const out = withCards(s, [listed('h', 'case-studies', { kind: 'image', key: 'uploads/abc123/h.jpg', alt: 'H', focal: null }), listed('w', 'journal')], signing);
		assert.equal('cover' in out[0]!, false);
		assert.match(out[0]!.card!.src, /rs:fill:320:320\//);
		assert.equal(out[1]!.card, undefined);
		const unsigned = withCards(s, [listed('h', 'case-studies', { kind: 'image', key: 'uploads/abc123/h.jpg', alt: 'H', focal: null })], null);
		assert.equal(unsigned[0]!.card, undefined);
		assert.equal('cover' in unsigned[0]!, false);
	});

	test("Decision 18: the choice is remembered per collection in the UI cookie, the config's default until the editor picks", () => {
		const fresh = parseUiState(null);
		assert.equal(viewModeOf(fresh, 'journal', 'grid'), 'grid', "never switched: the config's default");
		const picked = withViewMode(withViewMode(fresh, 'journal', 'list'), 'case-studies', 'grid');
		assert.equal(withViewMode(picked, 'journal', 'list'), picked, 'no change, the same state');
		const back = parseUiState(serializeUiState(picked));
		assert.deepEqual(back.views, { journal: 'list', 'case-studies': 'grid' });
		assert.equal(viewModeOf(back, 'journal', 'grid'), 'list');
		assert.equal(viewModeOf(back, 'case-studies', 'list'), 'grid');
		assert.deepEqual(parseUiState(JSON.stringify({ open: {}, recent: [], views: { a: 'grid', b: 'cards', c: 3 } })).views, { a: 'grid' }, 'anything else is dropped');
		assert.equal(parseUiState(JSON.stringify({ open: {}, recent: [], views: 'grid' })).views, undefined);
	});

	test("Decision 16: Grid's order select reads each column in its own words and always holds the current sort; captions are the first two worded columns, a section builder's when it was last edited", () => {
		const s = resolve({ collections: { ...config.collections, 'case-studies': cases } as never, blocks: pictureBlocks });
		const columns = tableColumns(s.collections['case-studies']!);
		assert.deepEqual(
			orderOptions(columns, { key: 'title', dir: 'asc' }).map((o) => [o.value, o.label]),
			[
				['title:asc', 'Title, A to Z'],
				['title:desc', 'Title, Z to A'],
				['client:asc', 'Client, A to Z'],
				['sector:asc', 'Sector, A to Z'],
				['launched:desc', 'Launched, newest first'],
				['launched:asc', 'Launched, oldest first'],
			],
		);
		const fromList = orderOptions(columns, { key: 'client', dir: 'desc' });
		assert.equal(fromList.at(-1)!.value, orderValue({ key: 'client', dir: 'desc' }), "a sort set from List's headers is one of the options");
		assert.equal(fromList.at(-1)!.label, 'Client, Z to A');
		assert.deepEqual(captionColumns(s.collections['case-studies']!, columns).map((c) => c.key), ['client', 'sector'], 'the toggle has no words: skipped');
		const journal = tableColumns(s.collections.journal!);
		assert.deepEqual(captionColumns(s.collections.journal!, journal).map((c) => c.key), ['edited']);
		assert.deepEqual(orderOptions(journal, { key: 'title', dir: 'asc' }).map((o) => o.label), ['Title, A to Z', 'Title, Z to A', 'Address, A to Z', 'Last edited, newest first', 'Last edited, oldest first']);
	});
});
