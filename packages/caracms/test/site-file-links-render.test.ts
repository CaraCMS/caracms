// M7 Decision 2: moved from starter/test. It checks a package feature through a site, so it runs on the
// package's fixture site (test/fixtures/demo-site, the pre-M7 demo) and pinned content (helpers/site-render.ts).
// M6c Decision 11 / acceptance 17: file links on the site, through the demo's real blocks
// (Astro's container, as fields-render.test.ts does). A PDF without `?download` opens in a
// new tab with a visually hidden "(opens in a new tab)"; `?download` and any other file
// type carry `download`; every other link, `/brochure.pdf` from public/ included, is
// unchanged. The same in a preview render, with the markers as they were. The demo has no
// address-only link, so a pinned copy's text block gets one (`more`) in its copied
// src/blocks; the demo's files are untouched.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pinnedSite, startRenderer, type Renderer } from './helpers/site-render.ts';

const copy = pinnedSite('file-links-render');
const edit = (file: string, from: string, to: string) => {
	const path = join(copy.root, file);
	const before = readFileSync(path, 'utf8');
	const after = before.replace(from, to);
	assert.notEqual(after, before, `${file}: ${from} replaced`);
	writeFileSync(path, after);
};
edit('src/blocks/text.ts', 'import { richText,', 'import { link, richText,');
edit('src/blocks/text.ts', 'background: background(),', "background: background(),\n\t\tmore: link({ label: 'More', addressOnly: true }),");
edit('src/blocks/Text.astro', "import Block from 'caracms/components/Block.astro';", "import Block from 'caracms/components/Block.astro';\nimport Link from 'caracms/components/Link.astro';");
edit('src/blocks/Text.astro', '<RichText cms={cms} field="body" value={block.body} class="text-body" />', '<RichText cms={cms} field="body" value={block.body} class="text-body" />\n\t\t<Link cms={cms} field="more" value={block.more} class="text-more"><i data-icon>icon</i></Link>');

const PDF = '/files/0123456789ab/rulebook.pdf';
const DOCX = '/files/0123456789ab/terms.docx';
const NOTE = /<span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect\(0,0,0,0\);white-space:nowrap;border:0"> \(opens in a new tab\)<\/span>/;

let r: Renderer;
let site: any;
let parseDocumentText: (text: string, site: unknown) => { document: any };
before(async () => {
	r = await startRenderer(copy.root);
	({ site } = await r.load('virtual:caracms/config'));
	({ parseDocumentText } = await r.load('caracms/document'));
});
after(async () => {
	await r?.close();
	copy.close();
});

const render = (blocks: unknown[], preview = false) =>
	r.page('caracms/components/RenderDocument.astro', { document: parseDocumentText(JSON.stringify({ title: 'Test', blocks }), site).document, collection: 'pages', preview });
const hero = (buttons: unknown[]) => ({ type: 'hero', heading: ['Hello'], intro: '', buttons });
const footer = (links: unknown[]) => ({ type: 'footer', address: '', email: '', links });
const text = (body: unknown, more: unknown = { href: '' }) => ({ type: 'text', heading: 'A heading', body, more });

/** Every `<a>` element in the HTML whose href is `href`, whole. */
const anchors = (html: string, href: string) => [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]).filter((a) => a.includes(`href="${href}"`));
const one = (html: string, href: string) => {
	const found = anchors(html, href);
	assert.equal(found.length, 1, `one link to ${href}`);
	return found[0]!;
};
const newTab = (a: string) => {
	assert.match(a, /\starget="_blank"/);
	assert.match(a, /\srel="noopener"/);
	assert.doesNotMatch(a, /\sdownload/);
	assert.match(a, NOTE);
};
const downloads = (a: string) => {
	assert.match(a, /\sdownload(?:=""|[\s>])/);
	assert.doesNotMatch(a, /target=|rel=|opens in a new tab/);
};
const plain = (a: string) => assert.doesNotMatch(a, /target=|rel=|download|opens in a new tab/);

const links = [
	{ label: 'Rules', href: PDF },
	{ label: 'Rules (download)', href: `${PDF}?download` },
	{ label: 'Terms', href: DOCX },
	{ label: 'Brochure', href: '/brochure.pdf' },
	{ label: 'Work', href: '/plain-page' },
];

describe('Decision 11: a link field (<Link>)', () => {
	test('a PDF opens in a new tab with the hidden note after the label; ?download and a .docx download; others unchanged', async () => {
		const html = await render([hero([]), footer(links)]);
		const pdf = one(html, PDF);
		newTab(pdf);
		assert.match(pdf, /Rules\s*<span style/, 'the note follows the label inside the link');
		downloads(one(html, `${PDF}?download`));
		downloads(one(html, DOCX));
		plain(one(html, '/brochure.pdf'));
		plain(one(html, '/plain-page'));
	});

	test('a preview render: the same attributes, and the markers as they were', async () => {
		const html = await render([hero([]), footer(links)], true);
		const pdf = one(html, PDF);
		newTab(pdf);
		assert.match(pdf, /data-cms-field="links\.0\.label" data-cms-kind="link"/);
		const docx = one(html, DOCX);
		downloads(docx);
		assert.match(docx, /data-cms-field="links\.2\.label" data-cms-kind="link"/);
	});

	test('an address-only link (G9): the slot, then the note, for a PDF; download for ?download; markers on .href', async () => {
		const pdf = one(await render([hero([]), text('Body', { href: PDF })]), PDF);
		newTab(pdf);
		assert.match(pdf, /class="text-more"/);
		assert.match(pdf, /<i data-icon[^>]*>icon<\/i>\s*<span style/);
		downloads(one(await render([hero([]), text('Body', { href: `${PDF}?download` })]), `${PDF}?download`));
		plain(one(await render([hero([]), text('Body', { href: '/brochure.pdf' })]), '/brochure.pdf'));
		const preview = one(await render([hero([]), text('Body', { href: DOCX })], true), DOCX);
		downloads(preview);
		assert.match(preview, /data-cms-field="more\.href" data-cms-kind="link"/);
	});
});

describe('Decision 11: buttons (<Buttons>)', () => {
	test('a PDF button opens in a new tab; a .docx button downloads; others unchanged; markers kept in a preview', async () => {
		const buttons = [
			{ label: 'Rules', href: PDF, style: 'primary' },
			{ label: 'Terms', href: DOCX, style: 'secondary' },
		];
		const html = await render([hero(buttons)]);
		const pdf = one(html, PDF);
		newTab(pdf);
		assert.match(pdf, /class="hero-button hero-button--primary"/);
		downloads(one(html, DOCX));
		plain(one(await render([hero([{ label: 'Go', href: '/brochure.pdf', style: 'primary' }])]), '/brochure.pdf'));
		const preview = await render([hero(buttons)], true);
		newTab(one(preview, PDF));
		assert.match(one(preview, PDF), /data-cms-field="buttons\.0\.label" data-cms-kind="button"/);
		downloads(one(preview, DOCX));
	});
});

describe('Decision 11: rich text (<RichText>)', () => {
	const body = [{ p: `Read [the rules](${PDF}), [save them](${PDF}?download), [the terms](${DOCX}), [the brochure](/brochure.pdf) or [our work](/plain-page).` }];

	test('the same behaviour for a file link inside rich text', async () => {
		const html = await render([hero([]), text(body)]);
		const pdf = one(html, PDF);
		newTab(pdf);
		assert.match(pdf, /the rules<span style/);
		downloads(one(html, `${PDF}?download`));
		downloads(one(html, DOCX));
		plain(one(html, '/brochure.pdf'));
		plain(one(html, '/plain-page'));
	});

	test('a preview render: the same attributes, and the field marker unchanged', async () => {
		const html = await render([hero([]), text(body)], true);
		newTab(one(html, PDF));
		downloads(one(html, DOCX));
		assert.match(html, /<div class="text-body"[^>]*data-cms-field="body" data-cms-kind="richText"/);
	});
});
