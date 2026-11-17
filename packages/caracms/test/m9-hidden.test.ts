// M9 Decision 7: hidden pages, checked without a browser (checks 2 and 3).
// - The listing marks a hidden page, and the pages under it (`hiddenBy`); the home page never.
// - The serializer adds `"hidden": true` after `title`, takes it out to unhide, and leaves it alone otherwise.
// - A link to a hidden page is a warning naming it (the field's and `validate`'s), never an error.
// - `validate`: `hidden` is true or absent; the home page's is ignored, with a warning.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { link, list, reference, richText } from '../src/config.ts';
import { filesSource, listDocuments } from '../src/content.ts';
import { parseDocumentText } from '../src/document.ts';
import { fieldWarnings } from '../src/fields.ts';
import { hiddenDocuments, hiddenPages } from '../src/links.ts';
import { applyEdits, savedForm } from '../src/serialize.ts';
import { makeCliSite, type CliSite } from './helpers/cli-site.ts';
import { site, siteRoot } from './helpers/site.ts';

const page = (title: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ title, ...extra, blocks: [] }, null, 2)}\n`;
const files = new Map([
	['content/pages/index.json', page('Home', { hidden: true })],
	['content/pages/about.json', page('About', { hidden: true })],
	['content/pages/about/team.json', page('Team')],
	['content/pages/about/team/lead.json', page('Lead')],
	['content/pages/contact.json', page('Contact')],
	['content/journal/first.json', page('First', { hidden: true })],
]);
const source = filesSource(siteRoot, () => files);

describe('the listing (Decision 7)', () => {
	test('a hidden page is marked; the pages under it are hidden with it; the home page never is', async () => {
		const entries = await listDocuments(site, 'pages', source);
		const of = (path: string) => entries.find((e) => e.path === path)!;
		assert.equal(of('index').hidden, undefined, 'the home page is shown');
		assert.deepEqual([of('about').hidden, of('about').hiddenBy], [true, undefined]);
		assert.deepEqual([of('about/team').hidden, of('about/team').hiddenBy], [true, 'about']);
		assert.deepEqual([of('about/team/lead').hidden, of('about/team/lead').hiddenBy], [true, 'about']);
		assert.equal(of('contact').hidden, undefined);
		assert.equal((await listDocuments(site, 'journal', source))[0]!.hidden, true, 'a post can be hidden too');
	});

	test('hiddenPages maps each hidden address to its name', async () => {
		const map = hiddenPages(await listDocuments(site, 'pages', source));
		assert.deepEqual([...map], [['/about', 'About'], ['/about/team', 'Team'], ['/about/team/lead', 'Lead']]);
	});
});

describe('the serializer (Decision 7)', () => {
	const base = '{\n  "$schema": "../../schemas/pages.schema.json",\n  "title": "About",\n  "blocks": []\n}\n';
	const read = (text: string) => parseDocumentText(text, site).document;

	test('hiding adds "hidden": true after the title; unhiding takes it out; absent leaves it', () => {
		const hidden = applyEdits(base, { ...read(base), hidden: true }, site);
		assert.equal(hidden, '{\n  "$schema": "../../schemas/pages.schema.json",\n  "title": "About",\n  "hidden": true,\n  "blocks": []\n}\n');
		assert.equal(read(hidden).hidden, true);
		assert.equal(applyEdits(hidden, { ...read(hidden), hidden: false }, site), base);
		const { hidden: _, ...without } = read(hidden);
		assert.equal(applyEdits(hidden, without, site), hidden, 'an edit without the key leaves the file as it is');
		assert.equal(applyEdits(hidden, { ...read(hidden), hidden: true }, site), hidden);
	});

	test('a new hidden page is written with it after the title; a shown one without it', () => {
		assert.equal(applyEdits(null, { title: 'New', blocks: [], hidden: true }, site), '{\n  "title": "New",\n  "hidden": true,\n  "blocks": []\n}\n');
		assert.equal(applyEdits(null, { title: 'New', blocks: [], hidden: false }, site), '{\n  "title": "New",\n  "blocks": []\n}\n');
	});

	test('a file laid out with it is already in the saved form', () => {
		const text = '{\n  "$schema": "../../schemas/pages.schema.json",\n  "title": "About",\n  "hidden": true,\n  "blocks": []\n}\n';
		assert.equal(savedForm(text, site.collections.pages!, site), text);
	});
});

describe('a link to a hidden page warns (Decision 7, check 3)', () => {
	const context = { addresses: ['/', '/about', '/contact'], hiddenPages: new Map([['/about', 'About']]) };

	test('a link field, and a rich-text link, warn naming the page; not as a missing page', () => {
		const [w] = fieldWarnings(link(), { label: 'About us', href: '/about/' }, context);
		assert.equal(w?.code, 'link-hidden');
		assert.match(w!.message, /^Links to \/about, the About page, which is hidden from the site\./);
		assert.deepEqual(fieldWarnings(richText(), [{ p: 'See [us](/about#team).' }], context).map((x) => x.code), ['link-hidden']);
		assert.deepEqual(fieldWarnings(link(), { label: 'Contact', href: '/contact' }, context), []);
	});
});

describe('a reference to a hidden page warns (Decision 7, review)', () => {
	const exists = () => true;

	test('a reference, and a list of them, warn naming the page; a page under a hidden one too; a shown one doesn\'t', async () => {
		const context = { documentExists: exists, hiddenDocuments: hiddenDocuments(await listDocuments(site, 'pages', source)) };
		const [w] = fieldWarnings(reference({ to: 'pages' }), 'about', context);
		assert.equal(w?.code, 'reference-hidden');
		assert.match(w!.message, /^Points at \/about, the About page, which is hidden from the site\./);
		const ws = fieldWarnings(list(reference({ to: 'pages' })), ['contact', 'about/team/lead'], context);
		assert.deepEqual(ws.map((x) => [x.path, x.code]), [['1', 'reference-hidden']]);
		assert.match(ws[0]!.message, /\/about\/team\/lead, the Lead page, which is hidden/);
		assert.deepEqual(fieldWarnings(reference({ to: 'pages' }), 'contact', context), []);
		assert.deepEqual(fieldWarnings(reference({ to: 'pages' }), 'index', context), [], 'the home page is never hidden');
	});

	test('keyed by collection: a hidden post doesn\'t mark a page at the same path', async () => {
		const context = { documentExists: exists, hiddenDocuments: hiddenDocuments(await listDocuments(site, 'journal', source)) };
		assert.equal(fieldWarnings(reference({ to: 'journal' }), 'first', context)[0]?.code, 'reference-hidden');
		assert.deepEqual(fieldWarnings(reference({ to: 'pages' }), 'first', context), []);
	});

	test('a missing reference stays missing-reference, not hidden', () => {
		const context = { documentExists: () => false, hiddenDocuments: new Map([['pages/about', { label: 'About', url: '/about' }]]) };
		assert.deepEqual(fieldWarnings(reference({ to: 'pages' }), 'about', context).map((x) => x.code), ['missing-reference']);
	});
});

describe('validate (Decision 7, check 3)', () => {
	let s: CliSite;
	before(() => {
		s = makeCliSite('validate-hidden');
		// As the editor (and the Tina script) lay it out: right after the title.
		s.write('content/pages/about.json', s.read('content/pages/about.json').replace('"title": "About",', '"title": "About",\n  "hidden": true,'));
		// A list of references to pages on the call to action (a client site's Games block, review finding 1).
		s.write('src/blocks/cta.ts', s.read('src/blocks/cta.ts').replace("import { lockup, text,", "import { list, lockup, reference, text,").replace('background: background(),', "background: background(),\n\t\tpicks: list(reference({ to: 'pages', label: 'Picks' })),"));
		s.write('content/pages/contact.json', s.read('content/pages/contact.json').replace('"background": "photo"\n', '"background": "photo",\n      "picks": ["visit", "about/team"]\n').replace('"blocks": [\n', '"blocks": [\n    {\n      "type": "text",\n      "heading": "About",\n      "body": [\n        { "p": "Meet [the team](/about/team)." }\n      ],\n      "background": "light"\n    },\n'));
	});
	after(() => s.cleanup());

	const report = () => JSON.parse(s.run('validate', '--json').stdout) as { errors: { file: string; path: string; message: string }[]; warnings: { file: string; path: string; message: string }[] };

	test('a link to a page under a hidden one: a warning naming it, exit 0; the hidden key itself is fine', () => {
		const r = s.run('validate', '--json');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		const { errors, warnings } = JSON.parse(r.stdout) as ReturnType<typeof report>;
		assert.deepEqual(errors, []);
		const hidden = warnings.filter((w) => /^Links to .*hidden from the site/.test(w.message));
		assert.equal(hidden.length, 1, JSON.stringify(warnings));
		assert.equal(hidden[0]!.file, 'content/pages/contact.json');
		assert.match(hidden[0]!.message, /Links to \/about\/team, the .* page, which is hidden from the site/);
		assert.equal(warnings.filter((w) => w.file === 'content/pages/about.json').length, 0, 'no reformat or schema warning for the hidden page');
	});

	test('a reference to a page under a hidden one: a warning naming it, exit 0; the shown one beside it is fine', () => {
		const r = s.run('validate', '--json');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		const { errors, warnings } = JSON.parse(r.stdout) as ReturnType<typeof report>;
		assert.deepEqual(errors, []);
		const refs = warnings.filter((w) => /^Points at .*hidden from the site/.test(w.message));
		assert.equal(refs.length, 1, JSON.stringify(warnings));
		assert.equal(refs[0]!.file, 'content/pages/contact.json');
		assert.match(refs[0]!.path, /picks\.1$|picks\[1\]$/);
		assert.match(refs[0]!.message, /Points at \/about\/team, the Team page, which is hidden from the site/);
	});

	test('the home page\'s hidden is a warning; anything but true is an error', () => {
		const home = s.read('content/pages/index.json');
		s.write('content/pages/index.json', home.replace(/("title": "[^"]*",)/, '$1\n  "hidden": true,'));
		s.write('content/pages/visit.json', s.read('content/pages/visit.json').replace('"title": "Visit",', '"title": "Visit",\n  "hidden": "yes",'));
		const r = report();
		assert.ok(r.warnings.some((w) => w.file === 'content/pages/index.json' && w.path === 'hidden' && /home page can’t be hidden/.test(w.message)), JSON.stringify(r.warnings));
		assert.ok(r.errors.some((e) => e.file === 'content/pages/visit.json' && e.path === 'hidden' && /Expected true/.test(e.message)), JSON.stringify(r.errors));
	});
});
