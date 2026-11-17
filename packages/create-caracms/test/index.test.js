// `npm create caracms`: the flags, the commands they turn into, and what it refuses. The run itself (create-astro, the
// installs, init) needs the network, so it isn't run here; --dry-run prints the same list the run walks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { detectPm, dirProblem, homePage, parse, steps, withStyles } from '../lib.js';

const bin = fileURLToPath(new URL('../index.js', import.meta.url));
// spawnSync's pipes aren't a terminal, so these runs can never stop at a prompt.
const run = (args, cwd = mkdtempSync(join(tmpdir(), 'create-caracms-'))) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd, env: { ...process.env, npm_config_user_agent: 'pnpm/12.0.0 node/v22' } });
const line = (s) => [s.cmd, ...s.args].join(' ');

test('the package manager is the one the command was run with, npm when unknown', () => {
	assert.equal(detectPm('pnpm/12.11.2 npm/? node/v22.12.0 darwin arm64'), 'pnpm');
	assert.equal(detectPm('bun/1.3.0'), 'bun');
	assert.equal(detectPm(undefined), 'npm');
	assert.equal(detectPm('deno/2.0'), 'npm');
});

test('flags become answers, and a flag not given stays undefined so it can be asked', () => {
	assert.deepEqual(parse(['my-site', '--cloud', '--deploy', 'none', '--no-tailwind', '--pm', 'npm']), { help: false, dryRun: false, dir: 'my-site', mode: 'cloud', deploy: 'none', tailwind: false, pm: 'npm', problems: [] });
	const bare = parse([]);
	assert.deepEqual([bare.dir, bare.mode, bare.deploy, bare.tailwind, bare.pm], [undefined, undefined, undefined, undefined, undefined]);
	assert.equal(parse(['--self-hosted']).mode, 'standalone', "init's name for it still works");
	assert.equal(parse(['--standalone']).mode, 'standalone');
});

test('flags that contradict or name something unknown are problems', () => {
	assert.equal(parse(['--cloud', '--standalone']).problems.length, 1);
	assert.equal(parse(['--tailwind', '--no-tailwind']).problems.length, 1);
	assert.match(parse(['--deploy', 'fly']).problems[0], /railway or none/);
	assert.match(parse(['--pm', 'deno']).problems[0], /pnpm, npm, yarn, bun/);
	assert.equal(parse(['a', 'b']).problems.length, 1);
	assert.equal(parse(['--nope']).problems.length, 1);
});

test('the folder is a name, not a path', () => {
	assert.equal(dirProblem('my-site'), undefined);
	for (const bad of ['', '.', '../x', 'a/b', 'my site']) assert.ok(dirProblem(bad), bad);
});

test('the steps: blank Astro, caracms pinned exact, a commit before init, init with the answers, a commit after', () => {
	const lines = steps({ dir: 'my-site', mode: 'cloud', deploy: 'railway', tailwind: true, pm: 'pnpm' });
	const cmds = lines.filter((s) => s.cmd).map(line);
	assert.equal(cmds[0], 'pnpm dlx create-astro@latest my-site --template minimal --no-install --no-git --no-ai --yes --skip-houston');
	assert.equal(lines[0].cwd, 'here');
	assert.ok(lines.slice(1).every((s) => s.cwd === 'site'));
	assert.ok(cmds.includes('pnpm add astro@latest'), 'the published astro, not the template\'s pin');
	assert.ok(cmds.includes('pnpm exec astro add tailwind --yes'));
	assert.ok(cmds.includes('pnpm add --save-exact caracms'));
	const init = cmds.indexOf('pnpm exec caracms init --write --cloud --railway');
	assert.ok(init > 0);
	// init refuses on uncommitted changes, so the install is committed first.
	assert.ok(cmds.findIndex((c) => c.startsWith('git commit')) < init);
	assert.ok(cmds.findLastIndex((c) => c.startsWith('git commit')) > init);
	assert.ok(lines.findIndex((s) => s.finish) > lines.findIndex((s) => s.title === 'caracms init'), 'Home is written after init');
});

test('Standalone is init\'s --self-hosted; no Railway and no Tailwind leave their steps out; npm has its own commands', () => {
	const cmds = steps({ dir: 's', mode: 'standalone', deploy: 'none', tailwind: false, pm: 'npm' }).filter((s) => s.cmd).map(line);
	assert.ok(cmds.includes('npx caracms init --write --self-hosted'));
	assert.ok(!cmds.some((c) => c.includes('tailwind')));
	assert.ok(cmds.includes('npm install --save-exact caracms'));
	assert.ok(cmds[0].startsWith('npx --yes create-astro@latest s '));
});

test('Home is laid out the way the editor saves it', () => {
	const text = homePage();
	assert.ok(text.endsWith('}\n'));
	assert.match(text, /^{\n  "\$schema"/);
	assert.equal(JSON.parse(text).blocks[0].type, 'text');
});

test("Tailwind's stylesheet goes into init's page component once, and not into one that isn't init's", () => {
	const page = "---\nimport Blocks from 'caracms/components/Blocks.astro';\n---\n";
	const styled = withStyles(page);
	assert.match(styled, /import '\.\.\/\.\.\/styles\/global\.css';\nimport Blocks/);
	assert.equal(withStyles(styled), null);
	assert.equal(withStyles('---\n---\n<html></html>'), null);
});

test('--help exits 0 and names every flag', () => {
	const r = run(['--help']);
	assert.equal(r.status, 0, r.stderr);
	for (const flag of ['--cloud', '--standalone', '--deploy', '--no-tailwind', '--pm', '--dry-run']) assert.match(r.stdout, new RegExp(flag));
});

test("outside a terminal it asks nothing: it says what's missing and makes nothing", () => {
	const r = run([]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /the folder name, and --cloud or --standalone/);
	assert.match(run(['my-site']).stderr, /Still needed: --cloud or --standalone/);
});

test('--dry-run prints the commands, with the package manager it was run with', () => {
	const r = run(['my-site', '--standalone', '--dry-run']);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^pnpm dlx create-astro@latest my-site /);
	assert.match(r.stdout, /\(in my-site\) pnpm exec caracms init --write --self-hosted --railway/);
});

test('inside an Astro site it points at caracms init and stops', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'create-caracms-'));
	writeFileSync(join(cwd, 'astro.config.mjs'), '');
	const r = run(['my-site', '--cloud'], cwd);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /npx caracms init/);
});

test('a folder that exists with something in it is refused', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'create-caracms-'));
	mkdirSync(join(cwd, 'my-site'));
	writeFileSync(join(cwd, 'my-site/file'), '');
	const r = run(['my-site', '--cloud', '--dry-run'], cwd);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /isn't empty/);
});
