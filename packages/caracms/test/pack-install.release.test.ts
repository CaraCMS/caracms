// M8 Decision 5, Acceptance 1–3: the release shape. `pnpm pack` holds what a site needs and
// nothing else; the tarball, installed into a plain Astro site outside this workspace (once with
// pnpm, once with npm), takes `caracms init --write`, then runs `astro dev`, `astro build` and
// `caracms start`, with none of the workspace's hoisted packages: a dependency the package
// imports but doesn't declare fails here.
//
// It installs from the registry (the package managers' caches make it quicker), so it isn't
// in test:unit: `pnpm --filter caracms test:release`, a few minutes.
//
// Under `astro dev` it also opens /admin in headless Chromium (Playwright's, as the
// *.browser.test.ts files use) and checks the editor starts with no module errors, and that
// every bare import the package's browser code makes is one Vite pre-bundled
// (EDITOR_CLIENT_DEPS). Installed from a tarball (npm or pnpm), a missing entry is served as
// the dependency's raw file, and a CommonJS one (react-dom) kills the editor; the workspace's
// linked copy hides it (caracms-cloud adversarial review, finding 12).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright-core';
import { browserSkip, packageRoot } from './helpers/dev-site.ts';

const work = mkdtempSync(join(tmpdir(), 'caracms-release-'));
let tarball: string;

before(() => {
	execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: packageRoot, stdio: 'ignore' });
	tarball = join(work, `caracms-${JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version}.tgz`);
});
after(() => rmSync(work, { recursive: true, force: true }));

describe('the tarball (Acceptance 1, 3)', () => {
	test('holds src, bin, site-skills, starlight-kit, README.md, LICENSE and package.json, and nothing else', () => {
		const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean);
		const top = [...new Set(entries.map((e) => e.replace(/^package\//, '').split('/')[0]))].sort();
		assert.deepEqual(top, ['LICENSE', 'README.md', 'bin', 'package.json', 'site-skills', 'src', 'starlight-kit']);
		// The docs kit's tests ship with it (going-public Decision 6): a Starlight site copies them
		// beside the kit. That folder is the only exception.
		const outsideKit = entries.filter((e) => !e.startsWith('package/starlight-kit/'));
		assert.ok(!outsideKit.some((e) => /\.test\.ts$|\/test\/|fixtures|mockups|throwaway/.test(e)), 'no tests, fixtures, mockups or throwaway scripts outside starlight-kit');
		assert.ok(entries.includes('package/starlight-kit/src/starlight-kit/integration.ts'), 'the kit itself');
		assert.ok(entries.includes('package/starlight-kit/test/kit/sidebar.test.ts'), 'the kit\'s tests');
	});

	test('its package.json names the public repository, bugs and homepage, and has no workspace: ranges', () => {
		const pkg = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
		// going-public Decision 12: the public repo, CaraCMS/caracms, with issues on.
		assert.deepEqual(pkg.repository, { type: 'git', url: 'git+https://github.com/CaraCMS/caracms.git', directory: 'packages/caracms' });
		assert.equal(pkg.homepage, 'https://github.com/CaraCMS/caracms#readme');
		assert.deepEqual(pkg.bugs, { url: 'https://github.com/CaraCMS/caracms/issues' });
		assert.doesNotMatch(JSON.stringify(pkg), /workspace:/);
		// The package's own version, a plain release (no prerelease tag left over from a trial tarball).
		assert.equal(pkg.version, JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version);
		assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
		assert.equal(pkg.engines.node, '>=22.12.0');
		assert.equal(pkg.license, 'MIT');
	});

	test('the README says it\'s unsupported, names no repository, and starts at caracms init', () => {
		const readme = execFileSync('tar', ['-xzOf', tarball, 'package/README.md'], { encoding: 'utf8' });
		assert.match(readme, /unsupported/i);
		assert.doesNotMatch(readme, /github\.com|gitlab|bitbucket/i);
		assert.match(readme, /caracms init/);
	});
});

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = createServer();
		s.listen(0, () => {
			const { port } = s.address() as { port: number };
			s.close(() => resolve(port));
		});
	});
}

/** GET a path until it answers (or the process dies, or 90 s pass). */
async function waitFor(url: string, child: ChildProcess, log: () => string): Promise<Response> {
	const end = Date.now() + 90_000;
	while (Date.now() < end) {
		if (child.exitCode !== null) throw new Error(`exited ${child.exitCode}:\n${log()}`);
		try {
			return await fetch(url, { redirect: 'manual' });
		} catch {
			await new Promise((r) => setTimeout(r, 300));
		}
	}
	throw new Error(`${url} never answered:\n${log()}`);
}

/** `during` runs while the server is still up, after the paths have answered. */
async function serve(cwd: string, command: string, args: string[], env: Record<string, string>, paths: string[], during?: (origin: string) => Promise<void>): Promise<Map<string, { status: number; text: string }>> {
	const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	child.stdout!.on('data', (d) => (out += d));
	child.stderr!.on('data', (d) => (out += d));
	try {
		const answers = new Map<string, { status: number; text: string }>();
		for (const path of paths) {
			const r = await waitFor(`http://127.0.0.1:${env.PORT}${path}`, child, () => out);
			answers.set(path, { status: r.status, text: await r.text() });
		}
		await during?.(`http://127.0.0.1:${env.PORT}`);
		return answers;
	} finally {
		child.kill('SIGTERM');
		await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)));
	}
}

/**
 * Where a module the dev server serves points its imports: each one must be the package's own
 * file, Vite's (`/@vite/`, `/@id/` for virtual modules, its client under node_modules/vite) or a
 * pre-bundled dependency (`/node_modules/.vite/deps/`). Anything else under node_modules is a
 * dependency served raw: what `EDITOR_CLIENT_DEPS` is missing.
 */
const RAW_DEPENDENCY = (spec: string) => {
	const path = spec.split('?')[0]!;
	return path.includes('/node_modules/') && !/\/node_modules\/(\.vite\/deps|caracms|vite\/dist\/client)\//.test(path);
};

/** The editor at /admin in Chromium: it paints, nothing fails, and no dependency arrives raw. */
async function checkEditorInBrowser(origin: string): Promise<void> {
	assert.equal(browserSkip, false, `${browserSkip}: the release check needs it (npx playwright-core install chromium)`);
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		const problems: string[] = [];
		const scripts = new Set<string>();
		page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
		page.on('console', (message) => message.type() === 'error' && problems.push(`console: ${message.text()}`));
		page.on('requestfailed', (request) => problems.push(`failed: ${request.url()} (${request.failure()?.errorText})`));
		page.on('response', (response) => {
			const url = new URL(response.url());
			if (url.origin !== origin) return;
			if (response.status() >= 400) problems.push(`${response.status()}: ${url.pathname}`);
			if (response.request().resourceType() === 'script') scripts.add(url.pathname + url.search);
		});
		await page.goto(`${origin}/admin`);
		const painted = await page.waitForSelector('#stage[data-painted="true"]', { timeout: 30_000 }).then(
			() => true,
			() => false,
		);
		assert.deepEqual(problems, [], 'the editor\'s page loads with no errors');
		assert.ok(painted, 'the editor hydrated and painted its stage');

		// Raw dependencies the page fetched, then every import (static or dynamic, so the lazy
		// ones too: @mux/upchunk on an upload) in the package's own modules, and the site's video
		// player (components/media-player.ts, which /admin doesn't load).
		const own = [...scripts].filter((path) => /\/node_modules\/caracms\/src\//.test(path));
		assert.ok(own.length > 0, `the page loaded the package's modules: ${[...scripts].join(', ')}`);
		const base = own[0]!.replace(/\/src\/.*$/, '/src/');
		const raw = [...scripts].filter(RAW_DEPENDENCY);
		for (const path of new Set([...own.map((p) => p.split('?')[0]!), `${base}components/media-player.ts`])) {
			const response = await fetch(origin + path);
			assert.equal(response.status, 200, path);
			const code = await response.text();
			for (const [, spec] of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^import\s+)["']([^"']+)["']/gm)) {
				if (RAW_DEPENDENCY(spec!)) raw.push(`${spec} (imported by ${path})`);
			}
		}
		assert.deepEqual([...new Set(raw)], [], 'every dependency the browser code imports is pre-bundled (EDITOR_CLIENT_DEPS)');
	} finally {
		await browser.close();
	}
}

for (const pm of ['pnpm', 'npm'] as const) {
	describe(`installed with ${pm} into a plain Astro site outside the workspace (Acceptance 2)`, () => {
		const root = join(work, `site-${pm}`);
		const sh = (cmd: string, args: string[]) => {
			const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } });
			assert.equal(r.status, 0, `${cmd} ${args.join(' ')}:\n${r.stdout}\n${r.stderr}`);
			return r.stdout + r.stderr;
		};
		const install = (...args: string[]) => (pm === 'pnpm' ? sh('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile', ...args]) : sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...args]));

		test('the tarball installs beside Astro, and init --write sets the site up', () => {
			mkdirSync(join(root, 'src/pages'), { recursive: true });
			mkdirSync(join(root, 'vendor'));
			cpSync(tarball, join(root, 'vendor/caracms.tgz'));
			const astro = JSON.parse(readFileSync(join(packageRoot, 'node_modules/astro/package.json'), 'utf8')).version;
			writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: `plain-${pm}`, private: true, type: 'module', scripts: { dev: 'astro dev', build: 'astro build' }, dependencies: { astro, caracms: 'file:vendor/caracms.tgz' } }, null, 2)}\n`);
			writeFileSync(join(root, 'astro.config.mjs'), "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n");
			writeFileSync(join(root, 'tsconfig.json'), '{\n  "extends": "astro/tsconfigs/base"\n}\n');
			writeFileSync(join(root, 'src/pages/index.astro'), '<h1>Home, as code</h1>\n');
			writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n.astro/\n');
			const installed = install();
			// 0.9.0: no `skills/<name>/SKILL.md` in the package, so pnpm 12.11+ asks nothing (its approval failed Railway's install).
			assert.doesNotMatch(installed, /awaiting approval/);
			sh('git', ['init', '-q']);
			sh('git', ['add', '-A']);
			sh('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'a plain Astro site']);
			const bin = pm === 'pnpm' ? ['pnpm', ['exec', 'caracms', 'init', '--write', '--self-hosted']] : ['npx', ['--no-install', 'caracms', 'init', '--write', '--self-hosted']];
			const out = sh(bin[0] as string, bin[1] as string[]);
			assert.match(out, /caracms init: done/);
			// The skills, copied in as real files (bin/skills.mjs).
			assert.ok(lstatSync(join(root, '.claude/skills/caracms-adopt/SKILL.md')).isFile());
			assert.ok(existsSync(join(root, '.claude/skills/.caracms.json')));
			install();
			assert.ok(existsSync(join(root, 'node_modules/@astrojs/node/package.json')));
			mkdirSync(join(root, 'content/pages'), { recursive: true });
			// Laid out the editor's way, or validate warns about the layout.
			const hello = { $schema: '../../schemas/pages.schema.json', title: 'Hello', blocks: [{ type: 'text', text: 'Hello from a document.' }] };
			writeFileSync(join(root, 'content/pages/hello.json'), JSON.stringify(hello, null, 2) + '\n');
			assert.match(sh(process.execPath, ['node_modules/caracms/bin/caracms.mjs', 'validate']), /no problems/);
		});

		test('astro build, then caracms start serves the code page, the document and /health', async () => {
			sh(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build']);
			const port = String(await freePort());
			const answers = await serve(root, process.execPath, ['node_modules/caracms/bin/caracms.mjs', 'start'], { PORT: port, HOST: '127.0.0.1', CARACMS_CLIENT_IP_HEADER: 'socket' }, ['/health', '/', '/hello']);
			assert.equal(answers.get('/health')!.status, 200);
			assert.match(answers.get('/')!.text, /Home, as code/);
			assert.match(answers.get('/hello')!.text, /Hello from a document\./);
		});

		test('astro dev serves the document and the editor, which starts in a browser with every dependency pre-bundled', async () => {
			const port = String(await freePort());
			// --ignore-lock: in the foreground, though an agent runs it (Astro 7 backgrounds `astro dev` under one).
		const answers = await serve(root, process.execPath, ['node_modules/astro/bin/astro.mjs', 'dev', '--port', port, '--host', '127.0.0.1', '--ignore-lock'], { PORT: port }, ['/hello', '/admin'], checkEditorInBrowser);
			assert.equal(answers.get('/hello')!.status, 200);
			assert.match(answers.get('/hello')!.text, /Hello from a document\./);
			assert.equal(answers.get('/admin')!.status, 200, answers.get('/admin')!.text.slice(0, 500));
		});
	});
}
