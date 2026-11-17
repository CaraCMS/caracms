// Posts and tags, the package's part (Decisions 12, 14, 15, 16; Acceptance 18 and 20): a page
// number reaching blocks, the " — page N" title, and reads shared across a production build on the
// disk source only. The fixture site's paged list (Acceptance 20's 300-post build) is in
// posts-and-tags-build.test.ts.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { contentReader, diskSource, filesSource } from '../src/content.ts';
import { blockContexts, type PageDocument, type SiteDocument } from '../src/document.ts';
import { headOf, type HeadInput } from '../src/head.ts';
import { MEMORY_MEDIA } from '../src/media.ts';
import { documentReader, shareBuildReads } from '../src/read.ts';
import { site, siteRoot } from './helpers/site.ts';

/** Count the disk's reads of each file while `run` goes. */
async function countingDisk<T>(run: () => Promise<T>): Promise<Map<string, number>> {
	const original = diskSource.readText;
	const counts = new Map<string, number>();
	diskSource.readText = (file) => {
		counts.set(file, (counts.get(file) ?? 0) + 1);
		return original(file);
	};
	try {
		await run();
	} finally {
		diskSource.readText = original;
	}
	return counts;
}

/** A copy of the unit-test site's folder, so a test can change a file between reads. */
function copiedSite() {
	const root = mkdtempSync(join(tmpdir(), 'caracms-reads-'));
	cpSync(siteRoot, root, { recursive: true });
	// The resolved site with its folders moved (resolveSite would look for the fixture's fonts beside the copy).
	const collections = Object.fromEntries(Object.entries(site.collections).map(([name, c]) => [name, { ...c, dir: c.dir.replace(siteRoot, root) }]));
	return { site: { ...site, root, collections }, root, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe('reads shared across a production build (Decision 15, Acceptance 20)', () => {
	afterEach(() => shareBuildReads(false));

	test('in build mode, two readers on the disk read each file once between them', async () => {
		shareBuildReads(true);
		const counts = await countingDisk(async () => {
			for (const reader of [documentReader(site, diskSource), contentReader(site)]) {
				const pages = await reader.documents('pages');
				assert.ok(pages.length > 1, 'the fixture has pages');
				await reader.document('pages', pages[0]!.path);
			}
		});
		assert.ok(counts.size > 1, 'files were read');
		for (const [file, n] of counts) assert.equal(n, 1, `${file} was read ${n} times`);
	});

	test('outside a build (dev), a second reader reads again, and sees a file changed after the first read it', async () => {
		const copy = copiedSite();
		try {
			const first = await documentReader(copy.site, diskSource).document('pages', 'about');
			assert.ok(first);
			writeFileSync(join(copy.root, 'content/pages/about.json'), JSON.stringify({ title: 'Changed', blocks: [] }));
			assert.equal((await documentReader(copy.site, diskSource).document('pages', 'about'))?.title, 'Changed');
		} finally {
			copy.close();
		}
	});

	test('in build mode, a store source is never shared: a second reader sees the change', async () => {
		shareBuildReads(true);
		const files = new Map([['content/pages/about.json', JSON.stringify({ title: 'Before', blocks: [] })]]);
		const store = filesSource(siteRoot, () => files);
		assert.equal((await documentReader(site, store).document('pages', 'about'))?.title, 'Before');
		files.set('content/pages/about.json', JSON.stringify({ title: 'After', blocks: [] }));
		assert.equal((await documentReader(site, store).document('pages', 'about'))?.title, 'After');
	});

	test('turned off at the end of a build, the shared reads are forgotten', async () => {
		const copy = copiedSite();
		try {
			shareBuildReads(true);
			assert.ok(await documentReader(copy.site, diskSource).document('pages', 'about'));
			shareBuildReads(false);
			writeFileSync(join(copy.root, 'content/pages/about.json'), JSON.stringify({ title: 'Changed', blocks: [] }));
			assert.equal((await documentReader(copy.site, diskSource).document('pages', 'about'))?.title, 'Changed');
		} finally {
			copy.close();
		}
	});
});

describe('the page number on every block (Decision 12)', () => {
	const doc = { title: 'Journal', blocks: [{ type: 'hero', known: true, data: {} }, { type: 'text', known: true, data: {} }] } as unknown as SiteDocument;
	test('each block context carries the page given; 1 by default', () => {
		assert.deepEqual(blockContexts(doc, site, false, undefined, undefined, 3).map((c) => c?.listPage), [3, 3]);
		assert.deepEqual(blockContexts(doc, site, false).map((c) => c?.listPage), [1, 1]);
	});
});

describe('" — page N" in the title (Decision 16, Acceptance 18)', () => {
	const settings = JSON.stringify({ title: 'Site Settings', brand: { name: 'CaraCMS' } });
	const page = (title: string, seo?: Record<string, unknown>): PageDocument => ({ title, blocks: [], ...(seo ? { seo } : {}) }) as PageDocument;
	const input = (patch: Partial<HeadInput>): HeadInput => ({ document: page('Journal'), settingsText: settings, path: '/journal/page/2', siteUrl: 'https://site.test', media: { kind: 'ready', settings: { ...MEMORY_MEDIA, memory: false } }, tagAllowed: false, ...patch });

	test('page 2 onwards: after the title, before the brand', () => {
		assert.equal(headOf(input({ listPage: 2 })).title, 'Journal — page 2 · CaraCMS');
		assert.equal(headOf(input({ listPage: 3 })).title, 'Journal — page 3 · CaraCMS');
	});
	test('page 1, or none given: unchanged', () => {
		assert.equal(headOf(input({ listPage: 1 })).title, 'Journal · CaraCMS');
		assert.equal(headOf(input({})).title, 'Journal · CaraCMS');
	});
	test("a page's own SEO title gets the same suffix", () => assert.equal(headOf(input({ listPage: 2, document: page('Journal', { title: 'Studio notes' }) })).title, 'Studio notes — page 2'));
	test("the home page's page 2 isn't the home page's address, so it reads as a page: its title, the suffix, the brand", () => assert.equal(headOf(input({ listPage: 2, path: '/page/2', document: page('Home') })).title, 'Home — page 2 · CaraCMS'));
	test('its canonical link is its own address', () => assert.equal(headOf(input({ listPage: 2 })).canonical, 'https://site.test/journal/page/2'));
});
