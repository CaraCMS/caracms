// `caracms audit` on a site with React islands (found porting a client site, 0.13.2): the audit renders with
// the site's own framework renderers, an island's HTML counts as the page's markup, and a render that
// fails is never taken for a clean audit. Run as a site runs it (bin/caracms.mjs, from the site's
// root) on copies of test/fixtures/island-site, whose caracms.config.ts says what it should print.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type { Finding } from '../src/audit/findings.ts';
import { formatAudit } from '../src/cli/audit.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = join(packageRoot, 'bin/caracms.mjs');
const roots: string[] = [];

/** A copy of the fixture as a site: its own package.json lists React (Astro bundles a renderer only for a dependency the site names). */
function site(edit?: (root: string) => void): string {
	const tmp = join(packageRoot, 'test/.tmp');
	mkdirSync(tmp, { recursive: true });
	const root = mkdtempSync(join(tmp, 'audit-islands-'));
	roots.push(root);
	cpSync(join(packageRoot, 'test/fixtures/island-site'), root, { recursive: true });
	mkdirSync(join(root, 'node_modules'));
	symlinkSync(packageRoot, join(root, 'node_modules/caracms'));
	const pkg = { name: 'island-site', private: true, type: 'module', dependencies: { '@astrojs/react': '*', react: '*', 'react-dom': '*' } };
	writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
	edit?.(root);
	return root;
}

const env = () => {
	const { CARACMS_MEDIA: _media, ...rest } = process.env;
	return { ...rest, NO_COLOR: '1' };
};
const run = (root: string, ...args: string[]) => {
	const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: env() });
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
/** Both streams as a terminal shows them, in the order they were written. */
const together = (root: string) => {
	const r = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${bin}" audit 2>&1`], { cwd: root, encoding: 'utf8', env: env() });
	return { code: r.status, out: r.stdout };
};

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('caracms audit on a site with React islands', () => {
	let plain: ReturnType<typeof run>;
	let findings: Finding[];
	before(() => {
		const root = site();
		plain = run(root, 'audit');
		const json = run(root, 'audit', '--json');
		assert.equal(json.code, 0, json.stderr);
		findings = JSON.parse(json.stdout).findings;
	});

	test('every page and both slot blocks render with the site\'s React renderer: nothing on stderr, exit 0', () => {
		assert.equal(plain.stderr, '', plain.stderr);
		assert.equal(plain.code, 0);
		assert.doesNotMatch(plain.stdout, /couldn't be rendered/);
		assert.match(plain.stdout, new RegExp(`caracms audit: ${findings.length} warnings\\.\\n$`));
	});

	test('an island\'s HTML is the page\'s markup: the marker it draws counts, its unmarked field and its own words are flagged as in plain Astro', () => {
		const unmarked = findings.filter((f) => f.kind === 'unmarked').map((f) => f.message);
		assert.ok(unmarked.includes('Home › Gallery: credit has words but nothing on the page marks it'), unmarked.join('\n'));
		assert.ok(!unmarked.some((m) => m.includes('caption')), 'the caption is marked inside the island');
		const unheld = findings.filter((f) => f.kind === 'unheld');
		const drawn = unheld.find((f) => f.message.startsWith('“Drawn in React”'));
		assert.equal(drawn?.message, '“Drawn in React” — on /, in Caption');
		assert.equal(drawn?.file, 'src/components/Caption.tsx');
	});

	test('a slot block\'s island inside its <Block> root: its links and menu button are the frame\'s, held on every page', () => {
		for (const words of ['Visit us', 'Our story', 'Open the menu']) {
			assert.ok(!plain.stdout.includes(words), `"${words}" is the header's, so not reported`);
		}
		assert.ok(!findings.some((f) => f.file === 'content/shared/header.json'), 'nothing reported for the header');
	});

	test('a slot block whose outermost element is the island, with no <Block> root, is named as the cause, and its words follow', () => {
		const footer = findings.filter((f) => f.file === 'content/shared/footer.json').map((f) => [f.path, f.message]);
		assert.deepEqual(footer[0], [
			'block',
			"Shared › Footer: its component's outermost element isn't a <Block cms={cms}>, so nothing on the page opens it and its links' words count as no field's",
		]);
		assert.ok(findings.some((f) => f.message === '“Join the newsletter” — 2 pages, in Nav'));
	});
});

describe('a render that fails is never a clean audit', () => {
	let noReact: string;
	before(() => {
		// The ported site's report before 0.13.2: with no renderer for its islands, nothing renders.
		noReact = site((root) => {
			const config = join(root, 'astro.config.mjs');
			writeFileSync(config, readFileSync(config, 'utf8').replace('integrations: [react(), ', 'integrations: ['));
		});
	});

	test('no "quiet": the failures first, then how many documents weren\'t checked; exit 1', () => {
		const { code, out } = together(noReact);
		assert.equal(code, 1, out);
		assert.doesNotMatch(out, /quiet/);
		const lines = out.trimEnd().split('\n');
		assert.equal(lines.length, 5, out);
		for (const line of lines.slice(0, 4)) assert.match(line, /^caracms audit: content\/(pages|shared)\/\w+\.json: couldn't be rendered \(Unable to render `Nav`\.\)$/);
		assert.equal(lines[4], "caracms audit: 4 of 4 documents couldn't be rendered, so they weren't checked.");
	});

	test('--json exits 1 too, and says how many', () => {
		const { code, stdout } = run(noReact, 'audit', '--json');
		assert.equal(code, 1);
		assert.deepEqual(JSON.parse(stdout), { findings: [], unrendered: 4, total: 4 });
	});

	test('the summary line, with some rendered and some not', () => {
		const warning: Finding = { kind: 'unheld', message: '“Hello” — on /' };
		assert.equal(formatAudit([], 0, 3), 'caracms audit: quiet.\n');
		assert.equal(formatAudit([], 1, 3), "caracms audit: 1 of 3 documents couldn't be rendered, so it wasn't checked.\n");
		const report = formatAudit([warning, warning], 2, 3);
		assert.ok(report.endsWith("\n\ncaracms audit: 2 of 3 documents couldn't be rendered, so they weren't checked; 2 warnings in the rest.\n"), report);
	});
});
