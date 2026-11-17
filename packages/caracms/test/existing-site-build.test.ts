// M8 test pass: Acceptance 5 (the YAML content collections of weekend-bikes still build and render
// after `init --write`) and Acceptance 12 (`/about` stays the code route after init, and once the
// agent swaps `about.astro` for `content/pages/about.json` the document serves it).
// init.test.ts has the same site shapes without a content collection or the swap.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { run } from '../bin/init.mjs';
import { bin } from './helpers/cli-site.ts';
import { packageRoot } from './helpers/dev-site.ts';

const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
	'package.json': '{\n  "name": "yaml-site",\n  "type": "module",\n  "dependencies": {\n    "astro": "^7.3.8"\n  }\n}\n',
	'astro.config.mjs': "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({ trailingSlash: 'never' });\n",
	'tsconfig.json': '{\n  "extends": "astro/tsconfigs/base"\n}\n',
	'src/content.config.ts':
		"import { defineCollection } from 'astro:content';\nimport { file } from 'astro/loaders';\nimport { z } from 'astro/zod';\n\nconst people = defineCollection({\n  loader: file('src/content/people.yaml'),\n  schema: z.object({ name: z.string(), role: z.string() }),\n});\n\nexport const collections = { people };\n",
	'src/content/people.yaml': '- id: aoife\n  name: Aoife\n  role: Founder\n- id: niamh\n  name: Niamh\n  role: Engineer\n',
	'src/pages/index.astro':
		"---\nimport { getCollection } from 'astro:content';\nconst people = await getCollection('people');\n---\n<h1>Home, as code</h1>\n<ul>{people.map((p) => <li>{p.data.name}, {p.data.role}</li>)}</ul>\n",
	'src/pages/about.astro': '<h1>About, as code</h1>\n',
	'src/pages/contact.astro': '<h1>Contact, as code</h1>\n',
};

function makeSite() {
	const root = mkdtempSync(join((mkdirSync(join(packageRoot, 'test/.tmp'), { recursive: true }), join(packageRoot, 'test/.tmp')), 'init-yaml-'));
	made.push(root);
	for (const [file, text] of Object.entries(FILES)) {
		mkdirSync(join(root, file, '..'), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	mkdirSync(join(root, 'node_modules'), { recursive: true });
	symlinkSync(packageRoot, join(root, 'node_modules/caracms'));
	writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n.astro/\n');
	const sh = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	sh('init', '-q');
	sh('add', '-A');
	sh('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'the site');
	return root;
}

const build = (root: string) => spawnSync(process.execPath, [join(packageRoot, 'node_modules/astro/bin/astro.mjs'), 'build'], { cwd: root, encoding: 'utf8' });
const page = (root: string, path: string) => readFileSync(join(root, 'dist/client', path, 'index.html'), 'utf8');

describe('a site with a YAML content collection, set up by init (Acceptance 5, 12)', () => {
	test('every existing page, the collection included, builds and renders as before; /about is the document once about.astro goes', async () => {
		const root = makeSite();
		let err = '';
		const code = await run({ root, write: true, selfHosted: true, ask: null, out: { write: () => true }, err: { write: (s: string) => (err += s) } });
		assert.equal(code, 0, err);

		// After init: the code routes serve everything, and the collection renders.
		const first = build(root);
		assert.equal(first.status, 0, first.stdout + first.stderr);
		const home = page(root, '.');
		assert.match(home, /Home, as code/);
		assert.match(home, /<li>Aoife, Founder<\/li>/);
		assert.match(home, /<li>Niamh, Engineer<\/li>/);
		assert.match(page(root, 'about'), /About, as code/);
		assert.match(page(root, 'contact'), /Contact, as code/);

		// The agent converts About: the document in, the route out.
		mkdirSync(join(root, 'content/pages'), { recursive: true });
		writeFileSync(join(root, 'content/pages/about.json'), '{\n  "$schema": "../../schemas/pages.schema.json",\n  "title": "About",\n  "blocks": [\n    { "type": "text", "text": "About, as a document." }\n  ]\n}\n');
		unlinkSync(join(root, 'src/pages/about.astro'));
		const validate = spawnSync(process.execPath, [bin, 'validate'], { cwd: root, encoding: 'utf8' });
		assert.equal(validate.status, 0, validate.stdout + validate.stderr);
		const second = build(root);
		assert.equal(second.status, 0, second.stdout + second.stderr);
		const about = page(root, 'about');
		assert.match(about, /<p>About, as a document\.<\/p>/);
		assert.doesNotMatch(about, /About, as code/);
		// Nothing else moved.
		assert.match(page(root, '.'), /<li>Aoife, Founder<\/li>/);
		assert.match(page(root, 'contact'), /Contact, as code/);
		assert.ok(existsSync(join(root, 'dist/client/about/index.html')));
	});
});
