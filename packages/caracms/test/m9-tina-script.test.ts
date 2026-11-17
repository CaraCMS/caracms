// M9 acceptance checks 10 and 11, with the reference script run as a process (as a site runs
// it), not through its exports: `site-skills/caracms-tina/tina-to-caracms.mjs`.
// - 10: run twice on the same Tina checkout with its key map, it writes byte-identical
//   `content/` and touches nothing outside `content/`; run on a newer `main`, it replaces
//   `content/` with no leftovers from the older run.
// - 11: `caracms validate` on the converted site reports no errors and no warnings (every image
//   has its `w`/`h` from the key map, so the missing-size warning has nothing to say).
// Also: a key the map lacks, with no bucket to read it from, fails the run before anything is
// written; `--scaffold-config` keeps `caracms init --cloud`'s `services` line.
// The Tina checkout is a small one built here; the site is a throwaway copy of the pinned demo
// site (helpers/cli-site.ts) with the config the script scaffolds. Nothing reads starter/content.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withServices } from '../bin/init.mjs';
import { makeCliSite, type CliSite } from './helpers/cli-site.ts';

const script = fileURLToPath(new URL('../site-skills/caracms-tina/tina-to-caracms.mjs', import.meta.url));

const str = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'string', name, label: name, ...extra });
const img = (k: string) => `https://img.example.com/unsafe/plain/s3://media-1/${k}`;

const templates = [
	{
		name: 'textMedia',
		label: 'Text and media',
		fields: [
			str('heading', { ui: { component: 'textarea' } }),
			{ type: 'rich-text', name: 'body', overrides: { toolbar: ['bold', 'link'], headingLevels: [] } },
			{ type: 'object', list: true, name: 'pictures', fields: [{ type: 'image', name: 'image' }, str('imageAlt')] },
			str('background', { options: ['light', 'dark'] }),
		],
	},
];
const schema = {
	collections: [
		{ name: 'pages', path: 'content/pages', fields: [str('title', { isTitle: true }), { type: 'object', list: true, name: 'sections', templates }, { type: 'boolean', name: 'hidden' }] },
		{ name: 'products', path: 'content/products', fields: [str('title', { isTitle: true }), { type: 'image', name: 'shot' }, { type: 'object', list: true, name: 'sections', templates }] },
		{ name: 'siteSettings', path: 'content/siteSettings', fields: [{ type: 'object', list: true, name: 'menu', fields: [str('label'), str('href')] }] },
	],
};
/** The key map a site keeps beside the script (scripts/tina-media-keys.json): every key known, so no run needs the bucket. One entry carries the ETag and size a credentialed run records: without S3_* settings it's used as it is, and nothing reaches content/. */
const KEYS = {
	'uploads/a.jpg': { key: 'uploads/aaaaaaaaaaaa/a.jpg', w: 800, h: 600 },
	'uploads/b.jpg': { key: 'uploads/bbbbbbbbbbbb/b.jpg', w: 640, h: 480, etag: '0123456789abcdef0123456789abcdef', size: 4096 },
	'uploads/box.png': { key: 'uploads/b0b0b0b0b0b0/box.png', w: 500, h: 500 },
};

const write = (root: string, rel: string, data: unknown) => {
	mkdirSync(join(root, rel, '..'), { recursive: true });
	writeFileSync(join(root, rel), JSON.stringify(data, null, 2));
};

/** Every file under a folder (not node_modules, not .tmp) → its hash, keyed by relative path. */
function tree(root: string, dir = root, out = new Map<string, string>()): Map<string, string> {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules') continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) tree(root, full, out);
		else out.set(relative(root, full), createHash('sha256').update(readFileSync(full)).digest('hex'));
	}
	return out;
}
const outside = (t: Map<string, string>) => new Map([...t].filter(([f]) => !f.startsWith('content/')));
const inside = (t: Map<string, string>) => new Map([...t].filter(([f]) => f.startsWith('content/')));

describe('the reference script as a process (M9 checks 10 and 11)', () => {
	let site: CliSite;
	let tina: string;

	const run = (...args: string[]) => {
		const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
		for (const k of Object.keys(env)) if (k.startsWith('S3_')) delete env[k];
		const r = spawnSync(process.execPath, [script, '--from', tina, '--to', '.', ...args], { cwd: site.root, encoding: 'utf8', env });
		return { code: r.status, out: r.stdout + r.stderr };
	};

	before(() => {
		site = makeCliSite('m9-tina-script');
		tina = mkdtempSync(join(tmpdir(), 'tina-checkout-'));
		write(tina, 'tina/__generated__/_schema.json', schema);
		write(tina, 'content/pages/home.json', {
			title: 'Home',
			sections: [{ _template: 'textMedia', heading: 'Made\nto last', body: 'Hello **there**.\n', pictures: [{ image: img('uploads/a.jpg'), imageAlt: 'A' }] }],
		});
		write(tina, 'content/pages/where-to-buy.json', { title: 'Where to buy', hidden: true, sections: [] });
		write(tina, 'content/products/tee.json', { title: 'Tee', shot: img('uploads/box.png'), sections: [] });
		write(tina, 'content/siteSettings/siteSettings.json', { menu: [{ label: 'Home', href: '/' }] });
		// The key map a site keeps beside the script: every key is known, so no run goes to the network.
		write(site.root, 'scripts/tina-media-keys.json', KEYS);
		// The block component and the page the scaffolded config names.
		site.write('src/blocks/TextMedia.astro', '---\n---\n<div />\n');
		site.write('src/components/caracms/Page.astro', '---\n---\n<div />\n');
	});
	after(() => {
		site.cleanup();
		rmSync(tina, { recursive: true, force: true });
	});

	let first = new Map<string, string>();

	test('check 10: twice on the same checkout, content/ is byte-identical and nothing outside it moves', () => {
		const scaffold = run('--scaffold-config', '--force');
		assert.equal(scaffold.code, 0, scaffold.out);
		// The skill's order: the scaffolded config, then `caracms schemas` for the schema files the content points at.
		const schemas = site.run('schemas');
		assert.equal(schemas.code, 0, schemas.stdout + schemas.stderr);
		const before1 = tree(site.root);
		const one = run();
		assert.equal(one.code, 0, one.out);
		const afterOne = tree(site.root);
		assert.deepEqual([...outside(afterOne)], [...outside(before1)], 'only content/ changed');
		assert.ok(inside(afterOne).size >= 4, 'content/ was written');
		first = inside(afterOne);
		const two = run();
		assert.equal(two.code, 0, two.out);
		const afterTwo = tree(site.root);
		assert.deepEqual([...inside(afterTwo)], [...first], 'the second run is byte-identical');
		assert.deepEqual([...outside(afterTwo)], [...outside(before1)]);
		assert.match(two.out, /Media: 2 images and 0 files by their bytes' keys; 0 new in scripts\/tina-media-keys\.json\./, 'the map already had every key');
		assert.match(two.out, /Bucket: not checked/);
	});

	test('check 11: validate on the converted site: no errors, no warnings, exit 0', () => {
		const r = site.run('validate', '--json');
		assert.equal(r.code, 0, r.stdout + r.stderr);
		const report = JSON.parse(r.stdout) as { errors: unknown[]; warnings: unknown[] };
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.warnings, []);
		const home = JSON.parse(site.read('content/pages/index.json')) as { blocks: { pictures: unknown[] }[] };
		assert.deepEqual(home.blocks[0]!.pictures, [{ key: 'uploads/aaaaaaaaaaaa/a.jpg', alt: 'A', w: 800, h: 600 }], "the map's key and size are in the content, which is why there is no missing-size warning");
	});

	test('check 10: a newer main replaces content/ whole: what is gone from Tina is gone, no leftovers', () => {
		// An editor saved: Where to buy was deleted, Tee was renamed (a new file name), a page was added.
		rmSync(join(tina, 'content/pages/where-to-buy.json'));
		rmSync(join(tina, 'content/products/tee.json'));
		write(tina, 'content/products/mug.json', { title: 'Mug', shot: img('uploads/b.jpg'), sections: [] });
		write(tina, 'content/pages/about.json', { title: 'About', sections: [{ _template: 'textMedia', heading: 'About us', body: 'Hi.\n', pictures: [] }] });
		const before3 = tree(site.root);
		const three = run();
		assert.equal(three.code, 0, three.out);
		const after3 = tree(site.root);
		assert.deepEqual([...outside(after3)], [...outside(before3)], 'nothing outside content/ moved');
		const files = [...inside(after3).keys()].sort();
		assert.deepEqual(files, ['content/pages/about.json', 'content/pages/index.json', 'content/products/mug.json', 'content/site-settings.json']);
		// The run on the same newer checkout twice is still byte-identical, and still validates.
		const four = run();
		assert.equal(four.code, 0, four.out);
		assert.deepEqual([...inside(tree(site.root))], [...inside(after3)]);
		const v = JSON.parse(site.run('validate', '--json').stdout) as { errors: unknown[]; warnings: unknown[] };
		assert.deepEqual(v, { ...v, errors: [], warnings: [] });
	});

	test("a key the map lacks, with no S3_* settings to read it, fails the run by name and where, and nothing is written", () => {
		write(tina, 'content/products/cap.json', { title: 'Cap', shot: img('uploads/new photo.jpg'), sections: [] });
		const before5 = tree(site.root);
		const five = run();
		assert.equal(five.code, 1, five.out);
		assert.match(five.out, /These media keys aren't in scripts\/tina-media-keys\.json, and there are no S3_\* settings/);
		assert.match(five.out, /uploads\/new photo\.jpg \(content\/products\/cap\.json › shot\)/);
		assert.deepEqual([...tree(site.root)], [...before5], 'nothing written: not content/, not the map');
		rmSync(join(tina, 'content/products/cap.json'));
	});
});

describe('the reference script, holding comes only from the adapt table (collections under pages)', () => {
	let site: CliSite;
	let tina: string;
	/** The script as a site has it: a copy beside the site, its adapt table's `holders` set to `holders`. */
	const scriptWith = (holders: string) => {
		const text = readFileSync(script, 'utf8');
		const patched = text.replace(/\tholders: \{[^}]*\},\n/, `\tholders: ${holders},\n`);
		assert.notEqual(patched, text, 'the table was found');
		site.write('scripts/tina-to-caracms.mjs', patched);
		return join(site.root, 'scripts/tina-to-caracms.mjs');
	};
	const run = (entry: string, ...args: string[]) => {
		const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
		for (const k of Object.keys(env)) if (k.startsWith('S3_')) delete env[k];
		const r = spawnSync(process.execPath, [entry, '--from', tina, '--to', '.', ...args], { cwd: site.root, encoding: 'utf8', env });
		return { code: r.status, out: r.stdout + r.stderr };
	};
	const products = () => JSON.parse(site.read('content/pages/products.json')) as { holds?: string };

	before(() => {
		site = makeCliSite('m9-tina-script-held');
		tina = mkdtempSync(join(tmpdir(), 'tina-checkout-held-'));
		write(tina, 'tina/__generated__/_schema.json', schema);
		const section = [{ _template: 'textMedia', heading: 'Hi', body: 'Hello.\n', pictures: [] }];
		write(tina, 'content/pages/home.json', { title: 'Home', sections: section });
		// The Products page sits at the products collection's base (/products/) and is named like it.
		write(tina, 'content/pages/products.json', { title: 'Products', sections: section });
		write(tina, 'content/products/tee.json', { title: 'Tee', shot: img('uploads/box.png'), sections: [] });
		write(tina, 'content/siteSettings/siteSettings.json', { menu: [{ label: 'Home', href: '/' }] });
		write(site.root, 'scripts/tina-media-keys.json', KEYS);
		site.write('src/blocks/TextMedia.astro', '---\n---\n<div />\n');
		site.write('src/components/caracms/Page.astro', '---\n---\n<div />\n');
	});
	after(() => {
		site.cleanup();
		rmSync(tina, { recursive: true, force: true });
	});

	test('a site ported before holding (urlBase in its config, an empty table): a normal run writes no holds, the hint appears, and validate exits 0', () => {
		// The config the script scaffolded before this change: `urlBase: "/products/"`, hand-maintained since.
		const scaffold = run(script, '--scaffold-config', '--force');
		assert.equal(scaffold.code, 0, scaffold.out);
		assert.match(site.read('caracms.config.ts'), /urlBase: "\/products\/"/);
		assert.doesNotMatch(site.read('caracms.config.ts'), /heldBy/);
		assert.match(scaffold.out, /products has a page at content\/pages\/products\.json: to have that page hold it, add products: 'products' to SITE\.holders, then re-run with --scaffold-config --force/);
		assert.doesNotMatch(scaffold.out, /Held by a page/);
		const schemas = site.run('schemas');
		assert.equal(schemas.code, 0, schemas.stdout + schemas.stderr);
		const normal = run(script);
		assert.equal(normal.code, 0, normal.out);
		assert.equal(products().holds, undefined, 'no holds from the name alone');
		assert.match(normal.out, /products has a page at content\/pages\/products\.json/, 'a normal run prints the hint too');
		const v = site.run('validate', '--json');
		assert.equal(v.code, 0, v.stdout + v.stderr);
		const report = JSON.parse(v.stdout) as { errors: unknown[]; warnings: unknown[] };
		assert.deepEqual([report.errors, report.warnings], [[], []]);
	});

	test('with products named in the table: the scaffold says heldBy, the Products page says holds, and validate agrees (exit 0, nothing to report)', () => {
		const held = scriptWith("{ products: 'products' }");
		const r = run(held, '--scaffold-config', '--force');
		assert.equal(r.code, 0, r.out);
		assert.match(r.out, /Held by a page: products/);
		assert.doesNotMatch(r.out, /has a page at/, 'a collection in the table is not suggested');
		const config = site.read('caracms.config.ts');
		assert.match(config, /heldBy: 'pages'/);
		assert.doesNotMatch(config, /urlBase: "\/products\/"/);
		assert.equal(products().holds, 'products');
		const schemas = site.run('schemas');
		assert.equal(schemas.code, 0, schemas.stdout + schemas.stderr);
		const v = site.run('validate', '--json');
		assert.equal(v.code, 0, v.stdout + v.stderr);
		const report = JSON.parse(v.stdout) as { errors: unknown[]; warnings: unknown[] };
		assert.deepEqual([report.errors, report.warnings], [[], []]);
	});

	test("--scaffold-config takes init --cloud's starting config without --force, and keeps its services line", () => {
		const starting = readFileSync(fileURLToPath(new URL('../bin/templates/caracms.config.ts.txt', import.meta.url)), 'utf8');
		const cloud = withServices(starting, 'cloud').text!;
		assert.match(cloud, /services: 'cloud',/);
		site.write('caracms.config.ts', cloud);
		const r = run(script, '--scaffold-config');
		assert.equal(r.code, 0, r.out);
		assert.match(site.read('caracms.config.ts'), /export default defineSite\(\{\n\tservices: "cloud",\n\tcollections: \{/);
		assert.match(r.out, /no forms\.config\.mjs in the Tina checkout, so the config has no forms/);
		site.write('caracms.config.ts', `${cloud}// the site's own now\n`);
		const refused = run(script, '--scaffold-config');
		assert.equal(refused.code, 1, 'any other config is still refused without --force');
	});
});
