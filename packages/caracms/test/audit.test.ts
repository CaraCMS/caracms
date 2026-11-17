// `caracms audit` (review gaps, Decisions 15–18, Acceptance 22–26), run as a site
// runs it (bin/caracms.mjs, from the site's root) on a copy of test/fixtures/audit-site, whose
// caracms.config.ts says what each part of it is for; and the rules on markup of their own.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { addressOf, anchorHeld, formSourceCollections, frameLinkPhrases, inFrameLink, linkedTitleHeld, markedAnchors, markedIn, oneReader, unheldPhrases, unmarkedFields, type Finding } from '../src/audit/findings.ts';
import { find, parseHtml } from '../src/audit/html.ts';
import { link, list, media, number, select, text, toggle, date, buttons } from '../src/fields.ts';
import { allowPagedPreview } from '../src/audit/paged.ts';
import { startRenderer } from '../src/audit/render.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = join(packageRoot, 'bin/caracms.mjs');

let root: string;
let plain: { code: number | null; stdout: string; stderr: string };
let json: { code: number | null; stdout: string; stderr: string };
let findings: Finding[];

const run = (...args: string[]) => {
	// No media set up, as on a machine without the site's variables: audit brings its own.
	const { CARACMS_MEDIA: _media, ...env } = process.env;
	const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

before(() => {
	const tmp = join(packageRoot, 'test/.tmp');
	mkdirSync(tmp, { recursive: true });
	root = mkdtempSync(join(tmp, 'audit-'));
	cpSync(join(packageRoot, 'test/fixtures/audit-site'), root, { recursive: true });
	mkdirSync(join(root, 'node_modules'));
	symlinkSync(packageRoot, join(root, 'node_modules/caracms'));
	writeFileSync(join(root, 'package.json'), '{ "name": "audit-site", "private": true, "type": "module" }\n');
	plain = run('audit');
	json = run('audit', '--json');
	findings = JSON.parse(json.stdout).findings;
});
after(() => rmSync(root, { recursive: true, force: true }));

const of = (kind: Finding['kind']) => findings.filter((f) => f.kind === kind);

describe('caracms audit on the fixture', () => {
	test('Acceptance 26: exits 0 with findings, and --json gives the same findings as data', () => {
		assert.equal(plain.code, 0, plain.stderr);
		assert.equal(json.code, 0, json.stderr);
		// The fixture's broken route is said once, on stderr, and the rest still runs.
		assert.equal(plain.stderr.trim().split('\n').length, 1, plain.stderr);
		assert.match(plain.stderr, /^caracms audit: src\/pages\/broken\/\[slug\]\.astro: its getStaticPaths couldn't be read, so its later pages weren't rendered \(this route is broken on purpose\)\n$/);
		assert.ok(findings.length > 0);
		for (const f of findings) assert.ok(plain.stdout.includes(`  ${f.message}\n`), `the plain report has "${f.message}"`);
		assert.match(plain.stdout, /^Not clickable on the page:\n/);
		assert.match(plain.stdout, /\n\nWords no field holds:\n/);
		assert.match(plain.stdout, /\n\nRead by only one block:\n/);
		assert.match(plain.stdout, new RegExp(`caracms audit: ${findings.length} warnings\\.\\n$`));
	});

	test('Acceptance 22: an unmarked field is printed under its document and block; settings, a marked link\'s address and a marked image\'s alt never are', () => {
		const home = of('unmarked').filter((f) => f.file === 'content/pages/index.json');
		assert.deepEqual(
			home.map((f) => [f.path, f.message]),
			[['blocks[0].intro', 'Home › Hero: intro has words but nothing on the page marks it']],
		);
		const about = of('unmarked').filter((f) => f.file === 'content/pages/about.json');
		assert.deepEqual(
			about.map((f) => f.message),
			['About › Stats: stats.0.value has words but nothing on the page marks it'],
		);
	});

	test('Acceptance 23: a shared block in five bodies prints nothing per page; its unmarked field and a slot block\'s print once, under Shared', () => {
		const shared = of('unmarked').filter((f) => f.message.startsWith('Shared › '));
		assert.deepEqual(shared.map((f) => [f.file, f.path, f.message]).sort(), [
			['content/shared/footer.json', 'block.extra', 'Shared › Footer: extra has words but nothing on the page marks it'],
			['content/shared/promo.json', 'block.note', 'Shared › Promo: note has words but nothing on the page marks it'],
		]);
		assert.equal(of('unmarked').length, 4, 'nothing else is unmarked');
	});

	test('Acceptance 24: the layout\'s words print once with the pages they\'re on; head, ↘, aria-hidden, honeypot and data-cms-fixed words never', () => {
		const unheld = of('unheld');
		const maeve = unheld.find((f) => f.message.startsWith('“Talk to Maeve”'));
		assert.ok(maeve, plain.stdout);
		assert.deepEqual([...maeve.pages!].sort(), ['/', '/about', '/contact', '/news', '/news/page/2', '/posts/hello', '/posts/older', '/visit', '/work']);
		assert.equal(maeve.message, '“Talk to Maeve” — 9 pages, in Page');
		assert.equal(maeve.file, 'src/components/Page.astro');
		assert.equal(unheld.filter((f) => f.message.includes('Talk to Maeve')).length, 1);
		for (const never of ['Head words', '↘', 'Hidden from readers', 'Leave this empty', 'Monthly cost', 'Work it out']) {
			assert.ok(!plain.stdout.includes(never), `"${never}" isn't printed`);
		}
		// The words drawn without a field: the stat's value, the hero's intro, the shared promo's note
		// (from its own render, on the five pages that place it) and the footer's extra line.
		assert.deepEqual(unheld.map((f) => f.message.replace(/ — .*/, '')).sort(), ['“12”', '“Ends Friday”', '“Hello”', '“Instagram”', '“Older”', '“Open weekdays”', '“Talk to Maeve”', '“We make things”']);
		assert.deepEqual([...unheld.find((f) => f.message.startsWith('“Ends Friday”'))!.pages!].sort(), ['/', '/about', '/contact', '/visit', '/work']);
	});

	test('a document\'s title inside its own root is held (a cms.of entry\'s, the page\'s own, the brand\'s name in Site Settings\'); outside it, it isn\'t', () => {
		for (const held of ['Opening', 'Home', 'About', 'Contact', 'Audit fixture']) {
			assert.ok(!plain.stdout.includes(`“${held}”`), `"${held}" is held`);
		}
		const hello = of('unheld').find((f) => f.message.startsWith('“Hello”'));
		assert.equal(hello?.message, '“Hello” — on /, in Latest', 'a post\'s title drawn outside its root is still reported');
	});

	test('a slot block\'s links aren\'t reported, and their words are held inside its root only', () => {
		assert.ok(!of('unmarked').some((f) => /links|menu/.test(f.path ?? '')), plain.stdout);
		assert.ok(!plain.stdout.includes('Opening times'));
		// The layout's own "Instagram" (code, outside the footer's root) is still reported, on every page.
		const instagram = of('unheld').find((f) => f.message.startsWith('“Instagram”'));
		assert.equal(instagram?.message, '“Instagram” — 9 pages, in Page');
	});

	test('an image drawn by <Media> is marked though no media is set up (audit renders with the in-memory media)', () => {
		assert.ok(!of('unmarked').some((f) => f.path === 'blocks[0].cover'), plain.stdout);
	});

	test('a menu built in code inside a slot\'s root: its labels from the slot\'s fields aren\'t unmarked, and no link or button word there is unheld', () => {
		assert.ok(!of('unmarked').some((f) => /news|more|menuLabel/.test(f.path ?? '')), plain.stdout);
		// "All the news" is drawn again as a plain heading in the root: held there too, as the frame's link words are.
		for (const held of ['All the news', 'More from us', 'Privacy']) assert.ok(!plain.stdout.includes(held), `"${held}" is held`);
		// Outside a link, the slot's words still count: its extra line is reported.
		assert.ok(of('unheld').some((f) => f.message.startsWith('“Open weekdays”')));
	});

	test('a paged listing\'s later page is rendered from the site\'s own route, so a card there marks its post', () => {
		// The older post's teaser is drawn only on /news/page/2's card: marked there, so never printed.
		assert.ok(!of('unmarked').some((f) => f.file === 'content/posts/older.json'), plain.stdout);
		assert.ok(!plain.stdout.includes('Second teaser'));
		assert.ok(of('unheld').find((f) => f.message.startsWith('“Talk to Maeve”'))!.pages!.includes('/news/page/2'));
	});

	test('the hook is the audit\'s only: a preview without it is still page 1, whatever listPage it\'s given', async () => {
		const r = await startRenderer(root);
		try {
			const { site } = await r.load('virtual:caracms/config');
			const { readDocument } = await r.load('caracms/content');
			const { document } = await readDocument(site, 'pages', 'news');
			const render = (locals: Record<string, unknown>) =>
				r.page('caracms/components/RenderDocument.astro', { document, collection: 'pages', preview: true, previewPath: 'news', listPage: 2 }, 'http://localhost/news/page/2', locals);
			const editor = await render({});
			assert.ok(editor.includes('First teaser') && !editor.includes('Second teaser'), 'the editor\'s preview clamps to page 1');
			const audit: Record<string, unknown> = {};
			allowPagedPreview(audit);
			const paged = await render(audit);
			assert.ok(paged.includes('Second teaser') && !paged.includes('First teaser'), 'the audit\'s render follows listPage');
		} finally {
			await r.close();
		}
	});

	test('Acceptance 25: a pageless collection one block reads is printed with that block; one with pages never is', () => {
		const messages = of('one-reader').map((f) => f.message);
		assert.ok(messages.includes('FAQ is read only by About › Answers: a list on the block?'), messages.join('\n'));
		assert.ok(messages.some((m) => m.startsWith('Team is read by no block.') && m.includes("aren't recorded")));
		assert.ok(!messages.some((m) => m.startsWith('Posts')));
		assert.equal(messages.length, 2);
	});
});

describe('the rules, on markup', () => {
	test('setting fields and references are never unmarked; words, images, clips and addresses are', () => {
		const fields = {
			kind: select({ options: ['a', 'b'] }),
			on: toggle(),
			n: number(),
			day: date(),
			words: text(),
			cta: link(),
			web: link({ addressOnly: true }),
			photo: media(),
			list: list(text()),
			buttons: buttons({ styles: ['solid'] }),
		};
		const values = {
			kind: 'b',
			on: true,
			n: 4,
			day: '2026-11-01',
			words: 'Hello',
			cta: { label: 'Go', href: '/x' },
			web: { href: 'https://example.com' },
			photo: { key: 'uploads/a/b.jpg', alt: 'A thing' },
			list: ['one', ''],
			buttons: [{ label: 'Book', href: '/book', style: 'solid' }],
		};
		assert.deepEqual(unmarkedFields(fields, values, new Set()).map((u) => `${u.path}:${u.what}`), ['words:words', 'cta:words', 'web:address', 'photo:image', 'list.0:words', 'buttons.0:words']);
		// Marked: a link by its label, an image by itself (its alt with it), a list as a whole, a button by its label.
		assert.deepEqual(unmarkedFields(fields, values, new Set(['words', 'cta.label', 'web.href', 'photo', 'list', 'buttons', 'buttons.0.label'])), []);
	});

	test('a field marked in another context (a card\'s source, a placed shared block) doesn\'t mark the block\'s', () => {
		const tree = parseHtml(
			'<body><section data-cms-block="0"><h1 data-cms-field="heading">A</h1><div data-cms-source="faq/x"><p data-cms-source="faq/x" data-cms-field="intro">B</p></div></section><section data-cms-block="1"><p data-cms-field="intro">C</p></section></body>',
		);
		assert.deepEqual([...markedIn(tree, { kind: 'block', index: 0 })], ['heading']);
		assert.deepEqual([...markedIn(tree, { kind: 'block', index: 1 })], ['intro']);
		assert.deepEqual([...markedIn(tree, { kind: 'source', id: 'faq/x' })], ['intro']);
	});

	test('words: a phrase per element, formatting joined, held and left-out elements break it', () => {
		const tree = parseHtml(
			`<html><head><title>T</title></head><body><p>Call <strong>us</strong> &amp; more</p><p>Before <span data-cms-field="x">held</span> after</p><svg><text>Svg</text></svg><script>var a = "no";</script><style>p{}</style><p>—</p><p data-cms-block="0">Inside a block</p><!-- a comment --><input name="fax"></body></html>`,
		);
		const body = find(tree, (e) => e.tag === 'body')!;
		assert.deepEqual(unheldPhrases(body).map((p) => p.words), ['Call us & more', 'Before', 'after', 'Inside a block']);
	});

	test('a title is held inside a link to its document, and nowhere else; a marked heading inside an in-page link to it', () => {
		const tree = parseHtml(
			'<body><nav><a href="/about/"><span id="nav">About</span></a><a href="/contact" id="wrong">About</a><a href="https://elsewhere.test/about" id="away">About</a></nav><p id="plain">About</p>' +
				'<div data-cms-field="body"><h2 id="before-you-start">Before you start</h2></div><h2 id="loose">Loose</h2>' +
				'<ul><li><a href="#before-you-start" id="toc">Before you start</a></li><li><a href="#loose" id="toc-loose">Loose</a></li><li><a href="#before-you-start" id="toc-other">Overview</a></li></ul></body>',
		);
		const at = (id: string) => find(tree, (e) => e.attrs.id === id)!;
		const titles = new Map([['/about', 'About'], ['/contact', 'Contact']]);
		const linked = linkedTitleHeld((address) => titles.get(address), '/');
		assert.deepEqual(['nav', 'wrong', 'away', 'plain'].map((id) => linked('About', at(id))), [true, false, false, false], 'a link to another page, another site, or no link at all');
		assert.equal(addressOf('../about/?x=1#top', '/guides/start'), '/about');
		assert.equal(addressOf('#top'), null);
		const anchors = markedAnchors(tree);
		assert.deepEqual([...anchors], [['before-you-start', 'Before you start']], 'only an element a field holds');
		const anchor = anchorHeld(anchors);
		assert.deepEqual([anchor('Before you start', at('toc')), anchor('Loose', at('toc-loose')), anchor('Overview', at('toc-other'))], [true, false, false], 'its own words, pointing at it');
	});

	test('frame links: words in a link or control inside a slot root, not outside it nor in another root', () => {
		const tree = parseHtml(
			'<body><a id="layout">Top</a><header data-cms-source="shared/header"><p id="plain">Hi</p><nav><a href="/"><span id="deep">About</span></a><button id="b" aria-label="Open the menu">Menu</button><details><summary id="s">More</summary></details></nav></header><div data-cms-source="shared/promo"><a id="other">Go</a></div></body>',
		);
		const slots = new Set(['shared/header']);
		const at = (id: string) => find(tree, (e) => e.attrs.id === id)!;
		assert.deepEqual(['deep', 'b', 's'].map((id) => inFrameLink(at(id), slots)), [true, true, true]);
		assert.deepEqual(['layout', 'plain', 'other'].map((id) => inFrameLink(at(id), slots)), [false, false, false]);
		assert.deepEqual([...frameLinkPhrases(find(tree, (e) => e.tag === 'header')!)].sort(), ['About', 'Menu', 'More', 'Open the menu']);
		const fields = { about: text(), intro: text() };
		assert.deepEqual(unmarkedFields(fields, { about: 'About', intro: 'Hi' }, new Set(), '', { frame: true, linkPhrases: new Set(['About']) }).map((u) => u.path), ['intro']);
		assert.deepEqual(unmarkedFields(fields, { about: 'About', intro: 'Hi' }, new Set(), '', { linkPhrases: new Set(['About']) }).map((u) => u.path), ['about', 'intro'], 'only a frame\'s');
	});

	test('one-reader counts a shared block once, wherever it\'s placed', () => {
		const shared = { key: 'shared/promo', label: 'Shared › Promo' };
		const renders = [1, 2].map(() => ({ record: { '0': { lists: { faq: 1 }, documents: [] } }, readerOf: () => shared }));
		assert.deepEqual(oneReader([{ name: 'faq', label: 'FAQ' }], renders).map((f) => f.message), ['FAQ is read only by Shared › Promo: a list on the block?']);
		const two = [0, 1].map((i) => ({ record: { [String(i)]: { lists: {}, documents: ['faq/a'] } }, readerOf: (n: number) => ({ key: `p#${n}`, label: `P › ${n}` }) }));
		assert.deepEqual(oneReader([{ name: 'faq', label: 'FAQ' }], two), []);
	});

	test('one-reader leaves out a pageless collection a form\'s select or rows column takes its choices from (form rows review fix 2)', () => {
		const forms = {
			apply: { fields: [{ name: 'job', label: 'Job', type: 'select', source: { collection: 'jobs' } }] },
			booking: { fields: [{ name: 'bookings', label: 'Bookings', type: 'rows', columns: [{ name: 'workshop', label: 'Workshop', type: 'select', source: { collection: 'workshops' } }, { name: 'places', label: 'Places', type: 'number' }] }] },
			contact: { fields: [{ name: 'email', label: 'Email', type: 'email' }] },
		} as never;
		const sources = formSourceCollections(forms);
		assert.deepEqual([...sources].sort(), ['jobs', 'workshops']);
		const pageless = [
			{ name: 'jobs', label: 'Jobs' },
			{ name: 'workshops', label: 'Workshops' },
			{ name: 'faq', label: 'FAQ' },
		];
		assert.deepEqual(
			oneReader(pageless, [], sources).map((f) => f.message.split(' ')[0]),
			['FAQ'],
			'only the collection no form reads is a finding',
		);
	});
});
