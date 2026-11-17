// `caracms audit` on a Starlight site (found on a Starlight site, 0.20.0): every page failed with
// "Astro.locals.t is not a function", since the audit's container ran none of the site's middleware
// and Starlight's is what sets `Astro.locals.t`. The renders now run the site's middleware chain
// (audit/render.ts → siteMiddleware). Run as a site runs it (bin/caracms.mjs, from the site's root)
// on a copy of test/fixtures/starlight-site, whose caracms.config.ts says what it should print.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type { Finding } from '../src/audit/findings.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = join(packageRoot, 'bin/caracms.mjs');
let root = '';

const run = (...args: string[]) => {
	const { CARACMS_MEDIA: _media, ...env } = process.env;
	const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

before(() => {
	const tmp = join(packageRoot, 'test/.tmp');
	mkdirSync(tmp, { recursive: true });
	root = mkdtempSync(join(tmp, 'audit-starlight-'));
	cpSync(join(packageRoot, 'test/fixtures/starlight-site'), root, { recursive: true });
	// Starlight's docs loader reads src/content/docs, which git can't keep empty.
	mkdirSync(join(root, 'src/content/docs'), { recursive: true });
	mkdirSync(join(root, 'node_modules'));
	symlinkSync(packageRoot, join(root, 'node_modules/caracms'));
	const pkg = { name: 'starlight-site', private: true, type: 'module', dependencies: { '@astrojs/starlight': '*' } };
	writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
});

after(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe('caracms audit on a Starlight site', () => {
	let plain: ReturnType<typeof run>;
	let findings: Finding[];
	before(() => {
		plain = run('audit');
		const json = run('audit', '--json');
		assert.equal(json.code, 0, json.stderr);
		findings = JSON.parse(json.stdout).findings;
	});

	test('every page renders inside <StarlightPage>, with what Starlight\'s middleware sets: nothing on stderr, exit 0', () => {
		assert.doesNotMatch(plain.stderr, /couldn't be rendered/, plain.stderr);
		assert.equal(plain.stderr, '', plain.stderr);
		assert.equal(plain.code, 0);
		assert.match(plain.stdout, new RegExp(`caracms audit: ${findings.length} warnings?\\.\\n$`));
	});

	test('the page is checked: a field marked inside Starlight\'s <Aside> counts, an unmarked one is flagged', () => {
		const unmarked = findings.filter((f) => f.kind === 'unmarked').map((f) => f.message);
		assert.ok(unmarked.includes('Home › Note: credit has words but nothing on the page marks it'), unmarked.join('\n'));
		assert.ok(!unmarked.some((m) => m.includes('body')), 'the body is marked inside the aside');
	});

	test('Starlight\'s own words are read as the page\'s, its translated ones included', () => {
		// "Skip to content" is Starlight's `Astro.locals.t('skipLink.label')`: drawn only once its middleware has run.
		const unheld = findings.filter((f) => f.kind === 'unheld').map((f) => f.message);
		assert.ok(unheld.includes('“Skip to content” — 2 pages, in SkipLink'), unheld.join('\n'));
		assert.ok(unheld.includes('“Written by the support team” — on /, in Note'), unheld.join('\n'));
	});

	// Found on a Starlight site (0.20.1): 669 warnings, nearly all Starlight's chrome drawing what fields already hold.
	test('a page\'s title isn\'t reported where Starlight draws it: its <h1>, the sidebar\'s links, prev/next', () => {
		const unheld = findings.filter((f) => f.kind === 'unheld').map((f) => f.message);
		for (const title of ['Home', 'About']) assert.ok(!unheld.some((m) => m.startsWith(`“${title}”`)), `"${title}" is held:\n${unheld.join('\n')}`);
		// Starlight's own words stay, as does the sidebar's group label, written in the page component.
		assert.ok(unheld.includes('“Guides” — 2 pages, in SidebarSublist'), unheld.join('\n'));
		assert.ok(unheld.some((m) => m.startsWith('“Next” — on /')), unheld.join('\n'));
		assert.ok(unheld.some((m) => m.startsWith('“Previous” — on /about')), unheld.join('\n'));
	});

	test('a marked heading isn\'t reported again in the table of contents that links to it', () => {
		const unheld = findings.filter((f) => f.kind === 'unheld').map((f) => f.message);
		for (const heading of ['Asking for approval', 'Before you start']) assert.ok(!unheld.some((m) => m.startsWith(`“${heading}”`)), `"${heading}" is held:\n${unheld.join('\n')}`);
		assert.ok(unheld.some((m) => m.startsWith('“On this page” — 2 pages')), unheld.join('\n'));
	});
});
