// M8 Decisions 15–16, Acceptance 19–22: `caracms validate`. Clean on the pinned demo fixture;
// each error kind in Decision 15 reported with its file, its JSON path and a plain sentence,
// exit 1; warnings never change the exit code; content judged by the config, not the
// (possibly stale) schema files, which are reported; `--json` in the Contract's shape;
// `--fix` runs `schemas` first.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { bin, makeCliSite, type CliSite } from './helpers/cli-site.ts';

interface Finding {
	file: string;
	path: string;
	message: string;
}
interface Report {
	errors: Finding[];
	warnings: Finding[];
}

const json = (s: CliSite): { code: number | null; report: Report } => {
	const r = s.run('validate', '--json');
	return { code: r.code, report: JSON.parse(r.stdout) as Report };
};

/** The two warnings the pinned fixture keeps on purpose: the editor's own warning tests use them. */
const FIXTURE_WARNINGS = [
	{ file: 'content/pages/index.json', path: 'blocks[0].heading', message: /too long for its box/ },
	{ file: 'content/pages/visit.json', path: 'blocks[4].images[2].alt', message: /No alt text/ },
];

describe('the pinned fixture', () => {
	let s: CliSite;
	before(() => (s = makeCliSite('validate-clean')));
	after(() => s.cleanup());

	test('no errors, only the editor\'s own two warnings, exit 0, in seconds', () => {
		const started = Date.now();
		const r = s.run('validate');
		assert.ok(Date.now() - started < 10_000);
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.doesNotMatch(r.stdout, /Errors:/);
		assert.match(r.stdout, /caracms validate: 0 errors, 2 warnings\./);
		const { report } = json(s);
		assert.deepEqual(report.errors, []);
		assert.equal(report.warnings.length, FIXTURE_WARNINGS.length, JSON.stringify(report.warnings));
		FIXTURE_WARNINGS.forEach((w, i) => {
			assert.equal(report.warnings[i]!.file, w.file);
			assert.equal(report.warnings[i]!.path, w.path);
			assert.match(report.warnings[i]!.message, w.message);
		});
	});

	test('no route clash: the demo\'s own routes reserve nothing a document uses (Acceptance 15)', () => {
		assert.ok(!json(s).report.errors.some((f) => /served by the site's own code/.test(f.message)));
	});

	// Acceptance 21: the package's engines are 22.12, and `validate` runs there with no flags, no
	// environment beyond PATH and HOME, no .env, no server, in under ten seconds. Point
	// NODE_22_12 at that Node's binary (`npx -p node@22.12.0 which node`) to run it; the test
	// pass does. Without it the engines range is still pinned.
	test('engines allow Node 22.12 and no lower (Acceptance 21)', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
		assert.equal(pkg.engines.node, '>=22.12.0');
	});

	test('on the lowest Node the engines allow: no flags, a bare environment, under ten seconds (Acceptance 21)', { skip: process.env.NODE_22_12 ? false : 'set NODE_22_12 to a Node 22.12.0 binary' }, () => {
		const started = Date.now();
		const r = spawnSync(process.env.NODE_22_12!, [bin, 'validate', '--json'], { cwd: s.root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
		const seconds = (Date.now() - started) / 1000;
		assert.equal(spawnSync(process.env.NODE_22_12!, ['-v'], { encoding: 'utf8' }).stdout.trim(), 'v22.12.0');
		assert.ok(!existsSync(join(s.root, '.env')), 'no .env in the site');
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual((JSON.parse(r.stdout) as Report).errors, []);
		assert.ok(seconds < 10, `took ${seconds}s`);
		console.log(`# validate on Node 22.12.0: ${seconds.toFixed(2)}s`);
	});

	test('bad usage exits 2', () => {
		const r = s.run('validate', '--nope');
		assert.equal(r.code, 2);
		assert.match(r.stderr, /"--nope" isn't an option of validate/);
	});
});

describe('every error kind', () => {
	let s: CliSite;
	let report: Report;
	let code: number | null;
	let text: string;
	before(() => {
		s = makeCliSite('validate-errors');
		const page = (blocks: unknown[], extra: Record<string, unknown> = {}) => `${JSON.stringify({ $schema: '../../schemas/pages.schema.json', title: 'T', ...extra, blocks }, null, 2)}\n`;
		s.write('content/pages/broken.json', '{ "title": "Broken", "blocks": [ }\n');
		s.write('content/stray/notes.json', '{ "title": "Stray" }\n');
		s.write('content/journal/2024/old.json', '{ "title": "Old", "blocks": [] }\n');
		s.write('content/pages/e-type.json', page([{ type: 'hreo', heading: ['x'] }]));
		s.write('content/pages/e-field.json', page([{ type: 'text', heading: 'Hi', colour: 'red' }]));
		s.write('content/pages/e-shape.json', page([{ type: 'hero', heading: 42 }]));
		s.write('content/pages/e-rich.json', page([{ type: 'text', body: [{ h1: 'Big' }, { quote: 'x' }, { p: 3 }] }]));
		s.write('content/pages/e-no-blocks.json', '{\n  "title": "No blocks"\n}\n');
		s.write('content/pages/e-no-title.json', '{\n  "blocks": []\n}\n');
		s.write('content/pages/e-shared.json', page([{ shared: 'gone' }]));
		s.write('content/pages/e-top.json', page([], { colour: 'red' }));
		s.write('content/pages/work/high-street-coffee.json', page([]));
		// A code route, and a document on its URL.
		s.write('src/pages/contact-us.astro', '---\n---\n<p>Contact</p>\n');
		s.write('content/pages/contact-us.json', page([]));
		// Case studies: a media value with no key, a reference to nothing, a list inside a list inside a list.
		const study = JSON.parse(s.read('content/case-studies/high-street-coffee.json'));
		study.cover = { alt: 'No key' };
		study.related = ['nope'];
		study.launched = 'last May';
		s.write('content/case-studies/high-street-coffee.json', `${JSON.stringify(study, null, 2)}\n`);
		// A menu of columns with a list of links in each (M7 Decision 14's one level), then a list one level deeper.
		s.write(
			'caracms.config.ts',
			s.read('caracms.config.ts').replace('\tblocks: {\n', "\tblocks: {\n\t\tmenu: { component: 'src/blocks/Text.astro', fields: { columns: list({ label: text(), links: list(link()) }) } },\n\t\tlinks: { component: 'src/blocks/Text.astro', fields: { a: link(), b: link(), c: link(), d: link({ addressOnly: true }), e: link() } },\n").replace("import { defineSite } from 'caracms/config';", "import { defineSite, link, list, text } from 'caracms/config';"),
		);
		s.write('content/pages/e-nested.json', page([{ type: 'menu', columns: [{ label: 'A', links: [[{ label: 'x', href: '/' }]] }] }]));
		// M8 trial items 2 and 3: a link to a code route exists, `#` passes the rule, /privacy is served by nothing, and a value that can't render is flagged.
		s.write('src/pages/work-list.astro', '---\n---\n<p>Work</p>\n');
		s.write('src/pages/studio/[slug].astro', '---\nexport const getStaticPaths = () => [];\n---\n');
		s.write(
			'content/pages/w-links.json',
			page([{ type: 'links', a: { label: 'Work', href: '/work-list' }, b: { label: 'Top', href: '#' }, c: { label: 'Privacy', href: '/privacy' }, d: { href: 'javascript:alert(1)' }, e: { label: 'Studio', href: '/studio/one#x' } }]),
		);
		// Warnings only: an unknown select value.
		s.write('content/pages/w-select.json', page([{ type: 'cases', heading: 'Work', show: 'bogus' }]));
		s.run('schemas');
		const r = s.run('validate', '--json');
		code = r.code;
		report = JSON.parse(r.stdout) as Report;
		text = s.run('validate').stdout;
	});
	after(() => s.cleanup());

	const find = (list: Finding[], file: string, path: string, message: RegExp) => {
		const hit = list.find((f) => f.file === file && f.path === path && message.test(f.message));
		assert.ok(hit, `no finding for ${file} › ${path} ~ ${message}\n${JSON.stringify(list.filter((f) => f.file === file), null, 1)}`);
		return hit;
	};
	const err = (file: string, path: string, message: RegExp) => find(report.errors, file, path, message);

	test('exit 1, and the plain lines are `file › path: sentence`', () => {
		assert.equal(code, 1);
		assert.match(text, /^Errors:\n/);
		assert.match(text, /\n {2}content\/pages\/e-type\.json › blocks\[0\]\.type: There's no block type "hreo"\./);
		assert.match(text, /\ncaracms validate: \d+ errors, \d+ warnings\.\n$/);
	});

	test('JSON that doesn\'t parse; a file in no collection', () => {
		err('content/pages/broken.json', '', /isn't valid JSON/);
		err('content/stray/notes.json', '', /isn't in any collection/);
		err('content/journal/2024/old.json', '', /isn't in any collection/);
	});

	test('an unknown block type or field, at the page\'s level too', () => {
		err('content/pages/e-type.json', 'blocks[0].type', /There's no block type "hreo"\. The site's blocks are/);
		err('content/pages/e-field.json', 'blocks[0].colour', /"colour" isn't a field of the Text block\. Its fields are "type", "heading", "body", "background"/);
		err('content/pages/e-top.json', 'colour', /"colour" isn't a field of a Pages page/);
	});

	test('a wrong value shape: a lockup, rich text outside its grammar, a media value missing its key, a date', () => {
		err('content/pages/e-shape.json', 'blocks[0].heading', /^Expected a lockup: .*found the number 42\.$/);
		err('content/pages/e-rich.json', 'blocks[0].body[0]', /An h1 isn't allowed in this field/);
		err('content/pages/e-rich.json', 'blocks[0].body[1]', /A quote isn't allowed in this field/);
		err('content/pages/e-rich.json', 'blocks[0].body[2]', /isn't rich text this field can read/);
		err('content/case-studies/high-street-coffee.json', 'cover.key', /This image has no "key"/);
		err('content/case-studies/high-street-coffee.json', 'launched', /Expected a date in the form 2026-10-15, found text \("last May"\)\./);
	});

	test('a missing required key', () => {
		err('content/pages/e-no-blocks.json', 'blocks', /has no "blocks"/);
		err('content/pages/e-no-title.json', 'title', /has no "title", so it has no page on the site/);
	});

	test('a reference to a document or a shared block that doesn\'t exist', () => {
		err('content/case-studies/high-street-coffee.json', 'related[0]', /points at "nope", which isn't a document in Case studies/);
		err('content/pages/e-shared.json', 'blocks[0].shared', /There's no shared block "gone"/);
	});

	test('two documents at one URL; a document on a code route, naming both', () => {
		// Reported on the second one listed (case studies come after pages), naming the first.
		err('content/case-studies/high-street-coffee.json', '', /content\/pages\/work\/high-street-coffee\.json is at \/work\/high-street-coffee too/);
		err('content/pages/contact-us.json', '', /\/contact-us is served by the site's own code \(src\/pages\/contact-us\.astro\)/);
	});

	test('a list nested deeper than one level inside a list', () => {
		err('content/pages/e-nested.json', 'blocks[0].columns[0].links[0]', /a list inside a list inside a list/);
	});

	test('an unknown select value is a warning, not an error', () => {
		find(report.warnings, 'content/pages/w-select.json', 'blocks[0].show', /"bogus" isn't one of this field's options .* so the page shows "featured"/);
		assert.ok(!report.errors.some((f) => f.file === 'content/pages/w-select.json'));
	});

	test('links: a code route\'s address exists, `#` passes, /privacy warns, a value that can\'t render warns (trial items 2, 3)', () => {
		const file = 'content/pages/w-links.json';
		const on = (path: string) => report.warnings.filter((f) => f.file === file && f.path === path);
		assert.deepEqual(on('blocks[0].a.href'), [], 'a static code route');
		assert.deepEqual(on('blocks[0].e.href'), [], 'under a code route with parameters');
		assert.deepEqual(on('blocks[0].b.href'), [], 'a bare #');
		find(report.warnings, file, 'blocks[0].c.href', /Links to \/privacy, which no page or route serves/);
		find(report.warnings, file, 'blocks[0].d.href', /Enter a path starting with "\/"/);
		assert.ok(!report.errors.some((f) => f.file === file), JSON.stringify(report.errors.filter((f) => f.file === file)));
	});

	test('the JSON is the Contract\'s shape: errors and warnings, each { file, path, message }', () => {
		assert.deepEqual(Object.keys(report), ['errors', 'warnings']);
		for (const f of [...report.errors, ...report.warnings]) assert.deepEqual(Object.keys(f), ['file', 'path', 'message']);
	});
});

describe('a second route with parameters at a collection\'s base (trial: [slug].astro beside [...path].astro)', () => {
	let s: CliSite;
	before(() => (s = makeCliSite('validate-shadow')));
	after(() => s.cleanup());

	test('an error naming the route and the collection; the documents it hides are on a code route', () => {
		s.write('src/pages/[slug].astro', '---\nexport const getStaticPaths = () => [{ params: { slug: \'careers\' } }];\n---\n<h1>Careers</h1>\n');
		const { code, report } = json(s);
		assert.equal(code, 1);
		find(report.errors, 'src/pages/[slug].astro', '', /^src\/pages\/\[slug\]\.astro is a second route with parameters at the pages collection's address \(\/\), beside its own src\/pages\/\[\.\.\.path\]\.astro\. Astro ranks it first, so it serves the addresses of that collection's documents and hides them\./);
		find(report.errors, 'content/pages/about.json', '', /\/about is served by the site's own code \(src\/pages\/\[slug\]\.astro\)/);
		// The starter's other bases keep their one route each: nothing about journal/ or work/.
		assert.ok(!report.errors.some((f) => /journal\/|work\//.test(f.file) && /second route/.test(f.message)));
	});
});

describe('stale schemas, and --fix', () => {
	let s: CliSite;
	before(() => (s = makeCliSite('validate-stale')));
	after(() => s.cleanup());

	test('content is judged by the config, not the stale file, and the stale file is reported (Acceptance 20)', () => {
		// A field added to a block in code, the schema not regenerated, and content already using it.
		s.write('src/blocks/text.ts', s.read('src/blocks/text.ts').replace("heading: text({ label: 'Heading', heading: true }),", "heading: text({ label: 'Heading', heading: true }),\n\t\tkicker: text({ label: 'Kicker' }),"));
		const about = JSON.parse(s.read('content/pages/about.json'));
		about.blocks[1].kicker = 'Since 2019';
		s.write('content/pages/about.json', `${JSON.stringify(about, null, 2)}\n`);
		const { code, report } = json(s);
		assert.equal(code, 0, JSON.stringify(report.errors));
		find(report.warnings, 'schemas/pages.schema.json', '', /out of date with caracms\.config\.ts/);
		find(report.warnings, 'schemas/shared.schema.json', '', /out of date/);
	});

	test('--fix runs `schemas` first: the files are current and the content stamped', () => {
		s.write('content/pages/new.json', '{\n  "title": "New",\n  "blocks": []\n}\n');
		const r = s.run('validate', '--fix');
		assert.equal(r.code, 0);
		assert.match(r.stdout, /wrote schemas\/pages\.schema\.json/);
		assert.match(r.stdout, /added \$schema to content\/pages\/new\.json/);
		assert.equal(JSON.parse(s.read('content/pages/new.json')).$schema, '../../schemas/pages.schema.json');
		const { report } = json(s);
		assert.ok(!report.warnings.some((w) => w.file.startsWith('schemas/')));
		// --fix with --json: the report on stdout, the fix's lines on stderr.
		const both = s.run('validate', '--fix', '--json');
		assert.deepEqual(Object.keys(JSON.parse(both.stdout)), ['errors', 'warnings']);
	});

	test('a content file with no $schema is a warning', () => {
		s.write('content/pages/plain.json', '{\n  "title": "Plain",\n  "blocks": []\n}\n');
		const { code, report } = json(s);
		assert.equal(code, 0);
		find(report.warnings, 'content/pages/plain.json', '', /no "\$schema".*`caracms validate --fix` adds it/);
	});

	test('no caracms.config.ts: one sentence, exit 1', () => {
		rmSync(join(s.root, 'caracms.config.ts'));
		const r = s.run('validate');
		assert.equal(r.code, 1);
		assert.match(r.stderr, /^caracms validate: there's no caracms\.config\.ts in /);
		assert.ok(readFileSync);
	});
});

// An adoption trial, item 5: 82 images with no w/h passed as "no problems".
describe('an image with no "w" or "h"', () => {
	let s: CliSite;
	before(() => (s = makeCliSite('validate-sizes')));
	after(() => s.cleanup());

	test('a warning naming the file, the path and the image, never an error; a file key gets none', () => {
		const study = s.read('content/case-studies/high-street-coffee.json');
		s.write('content/case-studies/high-street-coffee.json', study.replace(', "w": 4000, "h": 2667 }', ' }'));
		const settings = s.read('content/site-settings.json');
		s.write('content/site-settings.json', settings.replace('"accent": "#1f3a2e"', '"accent": "#1f3a2e",\n    "logo": { "key": "uploads/0123456789ab/logo.svg", "w": 120 }'));
		const { code, report } = json(s);
		assert.equal(code, 0, JSON.stringify(report.errors));
		const cover = find(report.warnings, 'content/case-studies/high-street-coffee.json', 'cover', /^This image \(uploads\/6d1f0a93be27\/harbour-shopfront\.jpg\) has no "w" or "h", its size in pixels/);
		assert.match(cover.message, /`caracms media import <the image's file>` prints its key with "w" and "h": add them here\.$/);
		find(report.warnings, 'content/site-settings.json', 'brand.logo', /^This image \(uploads\/0123456789ab\/logo\.svg\) has no "h", its size in pixels/);
		assert.match(s.run('validate').stdout, /\n {2}content\/case-studies\/high-street-coffee\.json › cover: This image/);
	});
});

// An adoption trial, item 7: a script wrote tabs, and one save left a file with mixed indents.
describe('files laid out the way a save writes them', () => {
	let s: CliSite;
	before(() => (s = makeCliSite('validate-format')));
	after(() => s.cleanup());

	test('the pinned fixture is already in the editor\'s form', () => {
		assert.ok(!json(s).report.warnings.some((w) => /laid out the way the editor saves it/.test(w.message)));
	});

	test('a tab-indented file, one with no trailing newline: warned; --fix rewrites exactly what a save writes, no value or key order changed', () => {
		const about = s.read('content/pages/about.json');
		const study = s.read('content/case-studies/high-street-coffee.json');
		const tabbed = `${JSON.stringify(JSON.parse(about), null, '\t')}\n`;
		s.write('content/pages/about.json', tabbed);
		s.write('content/case-studies/high-street-coffee.json', study.trimEnd());
		const { code, report } = json(s);
		assert.equal(code, 0);
		for (const file of ['content/pages/about.json', 'content/case-studies/high-street-coffee.json']) {
			find(report.warnings, file, '', /^This file isn't laid out the way the editor saves it .* `caracms validate --fix` rewrites it the editor's way, changing no values\.$/);
		}
		const r = s.run('validate', '--fix');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /\n {2}reformatted content\/pages\/about\.json \(as the editor saves it\)\n/);
		assert.match(r.stdout, /\n {2}reformatted content\/case-studies\/high-street-coffee\.json \(as the editor saves it\)\n/);
		assert.doesNotMatch(r.stdout, /reformatted content\/pages\/index\.json/);
		// Byte for byte the fixture's own text: the form the editor wrote it in.
		assert.equal(s.read('content/pages/about.json'), about);
		assert.equal(s.read('content/case-studies/high-street-coffee.json'), study);
		assert.ok(!json(s).report.warnings.some((w) => /laid out the way the editor saves it/.test(w.message)));
	});

	test('keys stay in the file\'s order, values as they are: only the whitespace changes', () => {
		const odd = { blocks: [{ heading: 'Hi', type: 'text', body: [{ p: 'One' }, { ul: ['a', 'b'] }] }], title: 'Odd', $schema: '../../schemas/pages.schema.json' };
		s.write('content/pages/odd.json', JSON.stringify(odd));
		s.run('validate', '--fix');
		const text = s.read('content/pages/odd.json');
		assert.equal(JSON.stringify(JSON.parse(text)), JSON.stringify(odd));
		assert.equal(
			text,
			'{\n  "blocks": [\n    {\n      "heading": "Hi",\n      "type": "text",\n      "body": [\n        { "p": "One" },\n        { "ul": ["a", "b"] }\n      ]\n    }\n  ],\n  "title": "Odd",\n  "$schema": "../../schemas/pages.schema.json"\n}\n',
		);
	});
});

function find(list: Finding[], file: string, path: string, message: RegExp) {
	const hit = list.find((f) => f.file === file && f.path === path && message.test(f.message));
	assert.ok(hit, `no finding for ${file} › ${path} ~ ${message}\n${JSON.stringify(list, null, 1)}`);
	return hit;
}
