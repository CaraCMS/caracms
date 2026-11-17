// Edit in context, the preview route under `astro dev` on a
// copy of the fixture (helpers/dev-site.ts):
// - The read record (Contracts): GET and POST previews end with one
//   `<script type="application/json" id="cms-reads">`, each block's `cms.read` keyed by its index,
//   reads in a child component counted (Acceptance 18), the slot's own read not; the public page
//   has none (Acceptance 22).
// - The preview POST with `overlay` (Contracts, Acceptance 23): the page is read from the store, the
//   overlay (a shared block, Site Settings, a case study) is read in place of its stored copy for that
//   render only, and nothing is written.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startDevSite, type DevSite } from './helpers/dev-site.ts';

let site: DevSite;
before(async () => {
	site = await startDevSite('edit-in-context-preview', {
		edit(root) {
			// A block whose child component lists the journal and reads one case study (Acceptance 18).
			writeFileSync(join(root, 'src/blocks/Probe.astro'), "---\nimport Block from 'caracms/components/Block.astro';\nimport Child from './ProbeChild.astro';\nconst { cms } = Astro.props;\n---\n<Block cms={cms}><Child cms={cms} /></Block>\n");
			writeFileSync(join(root, 'src/blocks/ProbeChild.astro'), "---\nconst { cms } = Astro.props;\nconst posts = await cms.read.documents('journal');\nconst one = await cms.read.document('case-studies', 'weekend-bikes');\nawait cms.read.document('case-studies', 'not-there');\n---\n<p class=\"probe\">{posts.length} {one?.title}</p>\n");
			const config = join(root, 'caracms.config.ts');
			writeFileSync(config, readFileSync(config, 'utf8').replace('\tblocks: {\n', "\tblocks: {\n\t\tprobe: { component: 'src/blocks/Probe.astro', fields: {} },\n"));
			const visit = join(root, 'content/pages/visit.json');
			const page = JSON.parse(readFileSync(visit, 'utf8'));
			page.blocks.push({ type: 'probe' });
			writeFileSync(visit, JSON.stringify(page, null, 2));
		},
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			if ((await fetch(`${site.origin}/admin`)).status === 200) break;
		} catch {
			await site.stop();
			await site.start();
		}
	}
});
after(() => site?.close());

const reads = (html: string) => {
	const all = [...html.matchAll(/<script type="application\/json" id="cms-reads">([\s\S]*?)<\/script>/g)];
	assert.equal(all.length, 1, 'one read record');
	assert.ok(html.indexOf(all[0]![0]) < html.lastIndexOf('</body>'), 'before </body>');
	return JSON.parse(all[0]![1]!) as Record<string, { lists: Record<string, number>; documents: string[] }>;
};
const get = async (collection: string, path: string) => (await fetch(`${site.origin}/_caracms/preview?collection=${collection}&path=${encodeURIComponent(path)}`)).text();
const post = (body: unknown) => fetch(`${site.origin}/_caracms/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const file = (collection: string, path: string) => JSON.parse(site.read(`content/${collection}/${path}.json`));

describe('the read record', () => {
	test('a GET preview: the cases block\'s listing with its count; a block that read nothing has no entry; the slot\'s read isn\'t there', async () => {
		const record = reads(await get('pages', 'index'));
		// Home: hero, text, cta, cases (index 3).
		assert.deepEqual(Object.keys(record), ['3']);
		assert.deepEqual(record['3'], { lists: { 'case-studies': 6 }, documents: [] });
		assert.ok(!JSON.stringify(record).includes('shared'), 'the footer slot\'s read is the slot\'s own');
	});

	test('reads in a child component count; a document read alone is recorded once found', async () => {
		const html = await get('pages', 'visit');
		const record = reads(html);
		const index = String(file('pages', 'visit').blocks.length - 1);
		assert.deepEqual(record[index], { lists: { journal: 3 }, documents: ['case-studies/weekend-bikes'] });
		assert.match(html, /<p class="probe"[^>]*>3 Weekend bike shop<\/p>/);
	});

	test('a POST preview carries it too, and keeps its <html> unmarked', async () => {
		const res = await post({ version: 4, collection: 'pages', path: 'index', document: { ...file('pages', 'index'), blocks: file('pages', 'index').blocks.map((b: object, i: number) => ({ source: i, known: true, ...b, data: b })) } });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('X-Preview-Version'), '4');
		const html = await res.text();
		assert.deepEqual(reads(html)['3']?.lists, { 'case-studies': 6 });
		assert.doesNotMatch(html, /data-caracms-preview/);
	});

	test('the public page has no record and no markers', async () => {
		const html = await (await fetch(`${site.origin}/`)).text();
		assert.doesNotMatch(html, /cms-reads|data-cms-/);
	});
});

describe('the preview POST with an overlay (Contracts, Acceptance 23)', () => {
	const sharedFooter = () => {
		const raw = file('shared', 'footer');
		return { kind: 'shared', title: raw.title, default: true, block: { source: 0, type: 'footer', known: true, data: { address: 'Overlaid address', email: raw.block.email, links: raw.block.links } } };
	};

	test('the page as stored, with the opened shared block\'s copy in its slot; the file is untouched', async () => {
		const before = site.read('content/shared/footer.json');
		const res = await post({ version: 7, collection: 'pages', path: 'index', overlay: { collection: 'shared', path: 'footer', document: sharedFooter() } });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('X-Preview-Version'), '7');
		const html = await res.text();
		assert.match(html, /data-cms-source="shared\/footer"[\s\S]*Overlaid address/);
		assert.match(html, /Selected work/, 'the page is Home, as stored');
		assert.ok(reads(html)['3']);
		assert.equal(site.read('content/shared/footer.json'), before, 'never written');
		// The next render without it shows the stored footer.
		assert.doesNotMatch(await get('pages', 'index'), /Overlaid address/);
	});

	test('an opened case study\'s copy is what the cards read', async () => {
		const raw = file('case-studies', 'high-street-coffee');
		const { title, $schema: _s, seo: _seo, ...data } = raw;
		const res = await post({ version: 8, collection: 'pages', path: 'index', overlay: { collection: 'case-studies', path: 'high-street-coffee', document: { kind: 'fields', title: 'Harbour, renamed', data } } });
		const html = await res.text();
		assert.match(html, /<li[^>]*data-cms-source="case-studies\/high-street-coffee"[\s\S]*?<b[^>]*>Harbour, renamed<\/b>/);
		assert.equal(file('case-studies', 'high-street-coffee').title, title);
	});

	test('Site Settings as the overlay: the page renders (its settings read from the copy)', async () => {
		const raw = file('', 'site-settings');
		const res = await post({ version: 9, collection: 'pages', path: 'about', overlay: { collection: 'settings', path: 'site-settings', document: { kind: 'settings', title: raw.title, data: { ...raw, brand: { ...raw.brand, name: 'Overlaid Site' } } } } });
		assert.equal(res.status, 200);
		assert.match(await res.text(), /<title>About · Overlaid Site<\/title>/);
	});

	test('a bad overlay is a 400; a page that isn\'t there is a 404', async () => {
		assert.equal((await post({ version: 1, collection: 'pages', path: 'index', overlay: { collection: 'nope', path: 'x', document: {} } })).status, 400);
		assert.equal((await post({ version: 1, collection: 'pages', path: 'index', overlay: { collection: 'shared', path: '../x', document: {} } })).status, 400);
		assert.equal((await post({ version: 1, collection: 'pages', overlay: { collection: 'shared', path: 'footer', document: sharedFooter() } })).status, 400);
		assert.equal((await post({ version: 1, collection: 'pages', path: 'gone', overlay: { collection: 'shared', path: 'footer', document: sharedFooter() } })).status, 404);
	});
});
