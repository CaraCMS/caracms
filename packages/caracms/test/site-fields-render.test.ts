// M7 Decision 2: moved from starter/test. It checks a package feature through a site, so it runs on the
// package's fixture site (test/fixtures/demo-site, the pre-M7 demo) and pinned content (helpers/site-render.ts).
// M5a's test pass, the render half of the field rules, through the demo's real blocks
// (Astro's container, as render.test.ts does): the "half a button shows nothing" rule,
// the link rule on a link, rich text's reading rules in the public HTML, a number the
// render can't use, a reference to a missing document, markers by path, and the demo
// itself (Decision 17). Nothing here opens a browser.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { count, pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

// The demo's documents as pinned (helpers/render.ts), not the live demo's.
const demo = pinnedSite('fields-render');
const root = demo.root;
let r: Renderer;
let site: any;
let parseDocumentText: (text: string, site: unknown) => { document: any };
let parseAnyDocument: (raw: unknown, site: unknown, collection: unknown) => any;
before(async () => {
	r = await startRenderer(root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseDocumentText, parseAnyDocument } = await r.load('caracms/document'));
});
after(async () => {
	await r.close();
	demo.close();
});

const render = (document: unknown, preview = false) => r.page('caracms/components/RenderDocument.astro', { document, collection: 'pages', preview });
const doc = (blocks: unknown[]) => parseDocumentText(JSON.stringify({ title: 'Test', blocks }), site).document;
const hero = (extra: Record<string, unknown> = {}) => ({ type: 'hero', heading: ['Hello'], intro: '', ...extra });
const text = (body: unknown, extra: Record<string, unknown> = {}) => ({ type: 'text', heading: 'A heading', body, ...extra });
const read = (file: string) => readFileSync(`${root}/${file}`, 'utf8');

/** The anchors of a hero's buttons wrapper, as `[href, class, label]`. */
const heroButtons = (html: string) => [...html.matchAll(/<a href="([^"]*)" class="(hero-button[^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2], m[3]]);

describe('Decision 2: buttons (the half-a-button rule is the component\'s, not the block author\'s)', () => {
	const good = { label: 'Start', href: '/contact', style: 'primary' };

	test('a button shows only with both a label and a link that passes the rule', async () => {
		const html = await render(
			doc([
				hero({
					buttons: [
						{ label: 'Only words', href: '', style: 'primary' },
						{ label: '', href: '/only-a-link', style: 'primary' },
						{ label: 'Bad link', href: 'nope', style: 'primary' },
						good,
					],
				}),
			]),
		);
		// max defaults to 2: the first two entries are the ones considered, and both are half or bad.
		assert.deepEqual(heroButtons(html), []);
		const second = await render(doc([hero({ buttons: [{ label: 'Half', href: '', style: 'secondary' }, good, { label: 'Third', href: '/third', style: 'primary' }] })]));
		assert.deepEqual(heroButtons(second), [['/contact', 'hero-button hero-button--primary', 'Start']], 'the half one is skipped; the third is past max 2');
	});

	test('public: no wrapper at all when no button shows; preview: the wrapper stays, marked, so the field can be clicked', async () => {
		const page = doc([hero({ buttons: [{ label: 'Half', href: '', style: 'primary' }] })]);
		const pub = await render(page);
		assert.doesNotMatch(pub, /hero-buttons/);
		assert.equal(count(pub, /data-cms-/g), 0);
		const preview = await render(page, true);
		assert.match(preview, /<div[^>]*data-cms-field="buttons" data-cms-kind="buttons"/);
		assert.deepEqual(heroButtons(preview), []);
	});

	test('markers keep the field\'s own indexes: the second button is buttons.1.label even when the first is skipped', async () => {
		const preview = await render(doc([hero({ buttons: [{ label: 'Half', href: '', style: 'primary' }, good] })]), true);
		assert.match(preview, /<a href="\/contact"[^>]*data-cms-field="buttons\.1\.label" data-cms-kind="button"/);
		assert.doesNotMatch(preview, /buttons\.0\.label/);
	});

	test('a wrong-shape buttons value renders nothing and doesn\'t throw', async () => {
		for (const buttons of ['oops', 3, { label: 'x' }, [null, 'a', 7]]) {
			const html = await render(doc([hero({ buttons })]));
			assert.deepEqual(heroButtons(html), []);
		}
	});
});

describe('Decision 4: a link field renders by the link rule', () => {
	const footer = (links: unknown) => ({ type: 'footer', address: 'Unit 4', email: '', links });
	const list = (html: string) => /<ul class="footer-links"[^>]*>([\s\S]*?)<\/ul>/.exec(html)![1]!;
	const items = (html: string) => [...list(html).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.trim());

	test('good link: an anchor. Fails the rule: its label as plain text. Half: nothing', async () => {
		const html = await render(
			doc([
				hero(),
				footer([
					{ label: 'Work', href: '/work' },
					{ label: 'Bad', href: 'javascript:alert(1)' },
					{ label: 'Only words', href: '' },
					{ label: '', href: '/only-a-link' },
					{ label: 'Mail', href: 'mailto:hello@example.com' },
				]),
			]),
		);
		const rows = items(html);
		assert.equal(rows.length, 5);
		assert.match(rows[0]!, /^<a href="\/work"[^>]*>Work<\/a>$/);
		assert.match(rows[1]!, /^<span[^>]*>Bad<\/span>$/);
		assert.doesNotMatch(rows[1]!, /href|javascript/);
		assert.equal(rows[2], '');
		assert.equal(rows[3], '');
		assert.match(rows[4]!, /^<a href="mailto:hello@example\.com"/);
		assert.equal(count(html, /data-cms-/g), 0);
	});

	test('a link inside a list carries its path in a preview: links.<i>.label, kind link', async () => {
		const html = await render(doc([hero(), footer([{ label: 'A', href: '/a' }, { label: 'B', href: '/b' }])]), true);
		assert.match(html, /<a href="\/a"[^>]*data-cms-field="links\.0\.label" data-cms-kind="link"/);
		assert.match(html, /<a href="\/b"[^>]*data-cms-field="links\.1\.label" data-cms-kind="link"/);
	});
});

describe('Decision 3: rich text in the public HTML', () => {
	/** The inner HTML of the text block's body wrapper. */
	const body = (html: string) => /<div class="text-body"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null;

	test('semantic HTML: p, a two-line h2 with a <br>, bold, a link and a list, and no class inside', async () => {
		const html = await render(
			doc([
				text([
					{ p: 'We drew the letters from the old **ferry signs**, see [the print work](/services/print).' },
					{ h2: 'From the harbour wall\noutward' },
					{ ul: ['First', 'Second *point*'] },
					{ ol: ['One'] },
				]),
			]),
		);
		assert.equal(
			body(html),
			'<p>We drew the letters from the old <strong>ferry signs</strong>, see <a href="/services/print">the print work</a>.</p>' +
				'<h2 id="from-the-harbour-wall-outward">From the harbour wall<br>outward</h2><ul><li>First</li><li>Second <em>point</em></li></ul><ol><li>One</li></ol>',
		);
		assert.equal(count(html, /<h1[\s>]/g), 1, 'the page\'s one h1 is the block\'s heading field, never rich text');
	});

	test('never an h1: an h1 in the file, a kind the field doesn\'t allow and a quote all render as paragraphs', async () => {
		const html = await render(doc([text([{ h1: 'Big' }, { blockquote: 'Quote' }, { h4: 'Four' }, { p: 'Fine' }])]));
		assert.equal(body(html), '<p>Big</p><p>Quote</p><p>Four</p><p>Fine</p>');
		assert.equal(count(html, /<h1[\s>]/g), 1);
	});

	test('a link failing the rule renders as its text; the others stay links', async () => {
		const html = await render(doc([text([{ p: '[evil](javascript:alert(1)) and [bare](contact) and [ok](/contact) and [out](https://example.com)' }])]));
		const inner = body(html)!;
		assert.doesNotMatch(inner, /javascript|href="contact"/);
		assert.match(inner, /evil\)? and bare and <a href="\/contact">ok<\/a> and <a href="https:\/\/example\.com">out<\/a>/);
	});

	test('a plain string (an old text() value) reads literally: an asterisk stays an asterisk, breaks stay breaks', async () => {
		const html = await render(doc([text('Five * three = fifteen, **not bold**\n\nsecond\nline')]));
		assert.equal(body(html), '<p>Five * three = fifteen, **not bold**</p><p>second<br>line</p>');
	});

	test('an empty value: no wrapper in public, a marked one in a preview (never contenteditable)', async () => {
		const page = doc([text([])]);
		assert.equal(body(await render(page)), null);
		const preview = await render(page, true);
		assert.match(preview, /<div class="text-body"[^>]*data-cms-field="body" data-cms-kind="richText"/);
		assert.doesNotMatch(/<div class="text-body"[^>]*>/.exec(preview)![0], /contenteditable/);
	});

	test('wrong shapes render as empty and never throw', async () => {
		for (const bad of [7, { p: 'x' }, [3, null, 'y'], [{ p: 1 }]]) {
			const html = await render(doc([text(bad)]));
			assert.equal(body(html), null, JSON.stringify(bad));
		}
	});
});

describe('Decision 2 and the Watch-outs: a number the render can\'t use reaches the block as null, and the block shows its default', () => {
	const cards = async (extra: Record<string, unknown>) => {
		const html = await render(doc([hero(), { type: 'cases', heading: 'Work', show: 'in-order', ...extra }]));
		return count(html, /class="cases-sector"/g);
	};
	test('in range: used. Out of range, cleared or not a number: the default, 3 (the file keeps what was typed)', async () => {
		assert.equal(await cards({ count: 5 }), 5);
		assert.equal(await cards({ count: 12 }), 6, 'in range, and only six exist');
		for (const bad of [99, 2, 0, -1, null, '5', {}]) assert.equal(await cards({ count: bad }), 3, JSON.stringify(bad));
		assert.equal(await cards({}), 3);
		// The parse keeps the typed value (Decision 15); only the render's copy is null.
		assert.equal(doc([{ type: 'cases', heading: 'x', show: 'in-order', count: 99 }]).blocks[0].data.count, 99);
	});
});

describe('Decision 6: a reference to a document that doesn\'t exist', () => {
	const caseStudy = (raw: Record<string, unknown>) => parseAnyDocument({ title: 'High-street coffee roaster', heading: ['Harbour', 'Coffee'], ...raw }, site, site.collections['case-studies']);
	const renderCase = (document: unknown) => r.page('caracms/components/RenderDocument.astro', { document, collection: 'case-studies', preview: false });
	const relatedLinks = (html: string) => [...(/<section class="band bg-dark case-related"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '').matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);

	test('the missing one is skipped, the rest render, and the file keeps the typed path', async () => {
		const html = await renderCase(caseStudy({ related: ['tiny-publisher', 'gone-for-good', 'weekend-bikes'] }));
		assert.deepEqual(relatedLinks(html), [
			['/work/tiny-publisher', 'Tiny publisher'],
			['/work/weekend-bikes', 'Weekend bike shop'],
		]);
		assert.doesNotMatch(html, /gone-for-good/);
		assert.deepEqual(caseStudy({ related: ['tiny-publisher', 'gone-for-good'] }).data.related, ['tiny-publisher', 'gone-for-good']);
	});

	test('all missing: no Related work section', async () => {
		const html = await renderCase(caseStudy({ related: ['nope', 'nada'] }));
		assert.doesNotMatch(html, /case-related/);
	});
});

describe('Decision 16: markers by path in a fields document', () => {
	test('a list of fields and a link/rich text under the document marker, each by dotted path', async () => {
		const html = await r.page('caracms/components/RenderDocument.astro', {
			document: parseAnyDocument(JSON.parse(read('content/case-studies/high-street-coffee.json')), site, site.collections['case-studies']),
			collection: 'case-studies',
			preview: true,
		});
		for (const path of ['credits.0.role', 'credits.0.name', 'credits.1.role', 'credits.1.name', 'heading', 'client', 'summary', 'body']) {
			assert.match(html, new RegExp(`data-cms-field="${path.replace('.', '\\.')}"`), path);
		}
		assert.equal(count(html, /data-cms-document="case-studies"/g), 1);
		assert.equal(count(html, /data-cms-block=/g), 0);
	});
});

describe('Decision 17: the demo shows every field and every kind of document', () => {
	const kinds = (fields: Record<string, any>): string[] => Object.values(fields).flatMap((f) => [f.kind, ...(f.item ? [f.item.kind] : []), ...(f.fields ? kinds(f.fields) : [])]);

	test('the demo uses all eight new field kinds somewhere', () => {
		const used = new Set<string>([
			...Object.values<any>(site.blocks).flatMap((b) => kinds(b.fields)),
			...Object.values<any>(site.collections).flatMap((c) => (c.fields ? kinds(c.fields) : [])),
		]);
		for (const kind of ['richText', 'link', 'buttons', 'toggle', 'number', 'date', 'list', 'reference']) assert.ok(used.has(kind), kind);
	});

	test('the case-studies collection: a list of fields at /work/ (the Work page holds it), with the mockup\'s six fictional studies (Kitchen pottery is left for Exit step 3)', () => {
		const c = site.collections['case-studies'];
		assert.equal(c.kind, 'fields');
		assert.equal(c.heldBy, 'pages');
		assert.equal(JSON.parse(read('content/pages/work.json')).holds, 'case-studies');
		const files = readdirSync(`${root}/content/case-studies`).filter((f) => f.endsWith('.json')).sort();
		assert.deepEqual(files, ['high-street-coffee.json', 'nature-films.json', 'oak-furniture.json', 'sourdough-bakery.json', 'tiny-publisher.json', 'weekend-bikes.json']);
		for (const f of files) assert.equal(JSON.parse(read(`content/case-studies/${f}`)).title.length > 0, true, f);
	});

	test('Text\'s body is rich text with headings and links on; the CTA keeps button: text(); the hero has a buttons field', () => {
		assert.deepEqual([site.blocks.text.fields.body.kind, site.blocks.text.fields.body.headings, site.blocks.text.fields.body.links], ['richText', ['h2', 'h3'], true]);
		assert.equal(site.blocks.cta.fields.button.kind, 'text', 'a type change would need a migration against the demo\'s live drafts');
		assert.equal(site.blocks.hero.fields.buttons.kind, 'buttons');
		assert.equal(site.blocks.hero.fields.buttons.max, 2);
	});

	test('the case-study list is on Home and Work; the footer is one shared file, the footer slot\'s default, in no page\'s blocks', () => {
		const blocks = (page: string) => JSON.parse(read(`content/pages/${page}.json`)).blocks as { type?: string; shared?: string }[];
		for (const page of ['index', 'work']) assert.ok(blocks(page).some((b) => b.type === 'cases'), page);
		// Edit in context, Decision 16: the footer fills the page's footer slot, so no page lists it.
		for (const page of ['index', 'about', 'work', 'contact']) assert.deepEqual(blocks(page).filter((b) => b.shared).map((b) => b.shared), [], page);
		assert.equal(JSON.parse(read('content/shared/footer.json')).block.type, 'footer');
		assert.equal(JSON.parse(read('content/shared/footer.json')).default, true);
		assert.equal(site.blocks.footer.slot, 'footer');
		assert.deepEqual(readdirSync(`${root}/content/shared`), ['footer.json']);
	});

	test('Site Settings carries the brand and editors; the config holds no brand slot (M5b Decision 11)', () => {
		const settings = JSON.parse(read('content/site-settings.json'));
		assert.equal(typeof settings.brand.name, 'string');
		assert.match(settings.brand.accent, /^#[0-9a-f]{6}$/i);
		assert.ok(Array.isArray(settings.editors));
		assert.deepEqual(Object.keys(site.brand), []);
	});
});
