// M7 Acceptance 1 (Decision 1): the package's tests stop reading the starter's code.
//
// The browser and visual tests run on `test/fixtures/demo-site/` and `demo-content/`. The
// only tests that reach the real starter are Decision 1's named exceptions, which read its
// build (`starter/dist`), plus two that read a content file as data. This fails when a
// test (or helper) starts reaching for the starter's src, public, config or tsconfig, or
// a new file resolves a path into `starter/` without being added here on purpose.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = fileURLToPath(new URL('.', import.meta.url));

const sources = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (['fixtures', '.tmp', 'node_modules'].includes(name)) return [];
		return statSync(path).isDirectory() ? sources(path) : name.endsWith('.ts') ? [path] : [];
	});
const files = sources(testDir).map((path) => ({ file: relative(testDir, path), text: readFileSync(path, 'utf8') }));

/** Files that resolve a path into the real `starter/`, and why that's allowed. */
const REACHES_STARTER: Record<string, string> = {
	'helpers/dev-site.ts': 'exports `starter` for the two build tests below',
	'build-output.test.ts': "reads starter/dist (the package's output on a real site)",
	'built-server.test.ts': "runs starter/dist's server (and one content file's path, to prove nothing is written)",
	'gate-built.test.ts': 'Decision 1 exception: `caracms start` on starter/dist',
	'page-edit.browser.test.ts': 'Decision 1 exception: no overlays in starter/dist/client',
	'live-auth.test.ts': "reads starter/content/site-settings.json as data (the demo's editors are not real people)",
	'init.test.ts': "M8: init's Railway template and the versions it adds stay the starter's (.railway/railway.ts, package.json)",
};

describe('Acceptance 1: no package test copies, renders or builds the starter\'s code', () => {
	test('the fixture site is there, with the four parts a copy takes', () => {
		for (const part of ['src', 'public', 'caracms.config.ts', 'tsconfig.json']) assert.ok(existsSync(join(testDir, 'fixtures/demo-site', part)), part);
		assert.ok(existsSync(join(testDir, 'fixtures/demo-content/pages')), 'the pinned content');
	});

	test('the helpers that make a site copy take its code from the fixture site and its content from the fixture content', () => {
		for (const helper of ['helpers/dev-site.ts', 'helpers/site-render.ts']) {
			const text = files.find((f) => f.file === helper)!.text;
			assert.match(text, /join\(demoSite, part\)/, `${helper}: the code`);
			assert.match(text, /cpSync\(demoContent, /, `${helper}: the content`);
			assert.doesNotMatch(text, /cpSync\(join\(starter|cpSync\(starter/, `${helper}: never the starter`);
		}
	});

	test('no test joins a path into the starter\'s src, public, caracms.config.ts or tsconfig.json, or imports from them', () => {
		const bad = files.flatMap(({ file, text }) =>
			[...text.matchAll(/join\(\s*starter\s*,\s*['"`](src|public|caracms\.config|tsconfig)|\.\.\/starter\/(src|public|caracms\.config|tsconfig)|import\([^)]*starter\/(src|caracms\.config)/g)].map((m) => `${file}: ${m[0]}`),
		);
		assert.deepEqual(bad, []);
	});

	test('only the named files resolve a path into the real starter (a new one is added to the list on purpose)', () => {
		const reaching = files
			.filter(({ file, text }) => file !== 'fixture-site.test.ts' && (/\.\.\/starter['"/`]/.test(text) || /import \{[^}]*\bstarter\b[^}]*\} from '\.\/helpers\/dev-site\.ts'/.test(text)))
			.map((f) => f.file)
			.sort();
		assert.deepEqual(reaching, Object.keys(REACHES_STARTER).sort());
	});

	test('the tests that read the starter\'s build read dist, not its code', () => {
		for (const file of ['build-output.test.ts', 'gate-built.test.ts', 'built-server.test.ts', 'page-edit.browser.test.ts']) {
			assert.match(files.find((f) => f.file === file)!.text, /starter, 'dist|starter, "dist|join\(starter, 'dist\//, file);
		}
	});
});
