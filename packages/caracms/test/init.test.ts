// M8 Decisions 7–13, Acceptance 4–10, and runs-anywhere Decision 12 / check 27 (this file reads the starter's railway.ts and package.json:
// fixture-site.test.ts → REACHES_STARTER): `caracms init [--write]`, on copies of the site shapes it
// meets: weekend-bikes (static, pnpm, CLAUDE.md a link to AGENTS.md), High-street coffee roaster on the Node
// adapter and on the Cloudflare adapter, a Tina site, and the blockers one at a time. The sites are
// written here as the shapes of sites that adopt caracms.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { claudeBlock, HOST_VARIABLES, hostVariablesText, MARK_END, MARK_START, MODE_LINES, plan, run, skillNames, VERSIONS, WAY_BACK, withoutSkillsApproval, withServices } from '../bin/init.mjs';
import { REPLACED_NAMES } from '../bin/media.mjs';
import { STAMP as SKILLS_STAMP, skillsWarning } from '../bin/skills.mjs';
import { bin } from './helpers/cli-site.ts';
import { demoSite, packageRoot, starter } from './helpers/dev-site.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

interface Site {
	root: string;
	read(file: string): string;
	exists(file: string): boolean;
	status(): string;
	snapshot(): Map<string, string>;
	commit(message?: string): void;
}

/**
 * A site from its files. `inPackage` (default): under test/.tmp, so `astro` resolves from this
 * package's dependencies, with node_modules/caracms linked here; otherwise in the OS's temp
 * folder, where no Astro is installed. `git`: a repository with everything committed.
 */
function makeSite(name: string, files: Record<string, string>, options: { git?: boolean; inPackage?: boolean; links?: Record<string, string> } = {}): Site {
	const base = options.inPackage === false ? tmpdir() : join(packageRoot, 'test/.tmp');
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, `init-${name}-`));
	made.push(root);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(join(root, file, '..'), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	for (const [file, target] of Object.entries(options.links ?? {})) symlinkSync(target, join(root, file));
	if (options.inPackage !== false) {
		mkdirSync(join(root, 'node_modules'), { recursive: true });
		symlinkSync(packageRoot, join(root, 'node_modules/caracms'));
		writeFileSync(join(root, '.gitignore'), `${files['.gitignore'] ?? ''}node_modules/\n`);
	}
	const sh = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	const site: Site = {
		root,
		read: (file) => readFileSync(join(root, file), 'utf8'),
		exists: (file) => existsSync(join(root, file)) || !!lstatSync(join(root, file), { throwIfNoEntry: false }),
		status: () => sh('status', '--porcelain', '--untracked-files=all'),
		snapshot: () => {
			const out = new Map<string, string>();
			const walk = (dir: string) => {
				for (const n of readdirSync(join(root, dir))) {
					if (n === 'node_modules' || n === '.git') continue;
					const rel = dir ? `${dir}/${n}` : n;
					const st = lstatSync(join(root, rel));
					if (st.isSymbolicLink()) out.set(rel, `-> ${readlinkSync(join(root, rel))}`);
					else if (st.isDirectory()) walk(rel);
					else out.set(rel, readFileSync(join(root, rel), 'utf8'));
				}
			};
			walk('');
			return out;
		},
		commit: (message = 'commit') => {
			sh('add', '-A');
			sh('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', message, '--allow-empty');
		},
	};
	if (options.git !== false) {
		sh('init', '-q');
		site.commit('the site');
	}
	return site;
}

/** init in this process. `mode`: the flag (self-hosted by default: what init did before caracms-cloud M5); `ask`: the terminal's answer, or none. */
async function init(site: Site, write = false, railway = false, { mode = 'self-hosted', ask = null, env = {}, fetch: fetchImpl }: { mode?: 'cloud' | 'self-hosted' | 'both' | null; ask?: (() => Promise<string | null>) | null; env?: Record<string, string>; fetch?: typeof fetch } = {}) {
	let out = '';
	let err = '';
	const code = await run({
		root: site.root,
		write,
		railway,
		cloud: mode === 'cloud' || mode === 'both',
		selfHosted: mode === 'self-hosted' || mode === 'both',
		ask,
		env,
		fetch: fetchImpl ?? ((async () => {
			throw new Error('no network in tests');
		}) as typeof fetch),
		out: { write: (s: string) => (out += s) },
		err: { write: (s: string) => (err += s) },
	});
	return { code, out, err };
}

/** A skill copied in whole (0.9.0, bin/skills.mjs): real files, word for word the package's. */
function assertCopied(site: Site, name: string) {
	const dir = join(site.root, `.claude/skills/${name}`);
	assert.ok(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), `${name}: a folder, not a link`);
	for (const file of readdirSync(join(packageRoot, 'site-skills', name))) assert.equal(site.read(`.claude/skills/${name}/${file}`), readFileSync(join(packageRoot, 'site-skills', name, file), 'utf8'), `${name}/${file}`);
}

const cli = (site: Site, ...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: site.root, encoding: 'utf8' });

/** weekend-bikes, a static site: its package.json, astro.config, tsconfig, .gitignore, AGENTS.md and the route files. */
const STATIC_SITE: Record<string, string> = {
	'package.json': `${JSON.stringify(
		{
			name: 'weekend-bikes',
			type: 'module',
			version: '0.0.1',
			engines: { node: '>=22.22.0' },
			scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview', astro: 'astro', check: 'astro check', start: 'node server.mjs', test: 'node --test' },
			dependencies: { astro: '^7.4.0', gsap: '^3.15.0', lenis: '^1.3.26', sharp: '^0.35.5' },
			devDependencies: { '@astrojs/check': '^0.9.10', typescript: '^6.0.3' },
			packageManager: 'pnpm@12.11.2',
		},
		null,
		2,
	)}\n`,
	'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
	'astro.config.mjs': `// @ts-check
import { defineConfig } from 'astro/config';
import { readBuiltSlugs } from './src/lib/built-slugs.mjs';

// https://astro.build/config
export default defineConfig({
  // Strict: fail rather than drift to 4330.
  server: { port: 4329 },
  trailingSlash: 'never',
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  vite: {
    server: { strictPort: true },
    define: { __BUILT_SLUGS__: JSON.stringify(readBuiltSlugs()) },
  },
});
`,
	'src/lib/built-slugs.mjs': 'export const readBuiltSlugs = () => [];\n',
	'tsconfig.json': '{\n  "extends": "astro/tsconfigs/strict",\n  "include": [".astro/types.d.ts", "**/*"],\n  "exclude": ["dist"]\n}\n',
	'.gitignore': '# build output\ndist/\n# generated types\n.astro/\n',
	'AGENTS.md': '# weekend-bikes\n\nThe bike shop site.\n',
	'server.mjs': '// the static server\n',
	'src/content/people.yaml': '- name: Aoife\n',
	'src/pages/index.astro': '<h1>Home</h1>\n',
	'src/pages/about.astro': '<h1>About</h1>\n',
	'src/pages/team.astro': '<h1>Team</h1>\n',
	'src/pages/contact.astro': '<h1>Contact</h1>\n',
	'src/pages/design-system.astro': '<h1>Design system</h1>\n',
	'src/pages/404.astro': '<h1>Not found</h1>\n',
	'src/pages/work/index.astro': '<h1>Work</h1>\n',
	'src/pages/work/[slug].astro': '---\nexport const getStaticPaths = () => [{ params: { slug: \'first-project\' } }];\n---\n<h1>{Astro.params.slug}</h1>\n',
	'src/pages/services/index.astro': '<h1>Services</h1>\n',
	'src/pages/services/[slug].astro': '---\nexport const getStaticPaths = () => [{ params: { slug: \'web\' } }];\n---\n<h1>{Astro.params.slug}</h1>\n',
	'src/pages/dev/[...stub].astro': '---\nexport const getStaticPaths = () => [];\n---\n',
};

const SCHEMAS = ['schemas/pages.schema.json', 'schemas/shared.schema.json', 'schemas/site-settings.schema.json'];

describe('weekend-bikes with --railway: the dry run, then --write, then again', () => {
	let site: Site;
	let dry: Awaited<ReturnType<typeof init>>;
	let planned: Awaited<ReturnType<typeof plan>>;

	test('the dry run prints every added file and every edit as a diff, and changes nothing (Acceptance 4)', async () => {
		site = makeSite('site-a', STATIC_SITE, { links: { 'CLAUDE.md': 'AGENTS.md' } });
		const before = site.snapshot();
		dry = await init(site, false, true);
		assert.equal(dry.code, 0, dry.err);
		assert.ok(!dry.out.includes(hostVariablesText()), 'with --railway, no host variables table');
		assert.equal(site.status(), '');
		assert.deepEqual(site.snapshot(), before);
		for (const line of [
			'  edit    package.json',
			'  edit    astro.config.mjs',
			'  add     caracms.config.ts',
			'  add     src/components/caracms/Page.astro',
			'  add     src/components/caracms/TextBlock.astro',
			'  add     src/pages/[...path].astro',
			'  add     src/pages/health.ts',
			'  add     content/site-settings.json',
			'  edit    .gitignore',
			'  edit    tsconfig.json',
			'  add     .railway/railway.ts',
			'  edit    AGENTS.md',
			...SCHEMAS.map((f) => `  add     ${f} (generated: caracms schemas)`),
			...skillNames().map((n) => `  add     .claude/skills/${n}/SKILL.md`),
			'  add     .claude/skills/.caracms.json',
		]) {
			assert.ok(dry.out.includes(`${line}\n`), `missing: ${line}\n${dry.out.slice(0, 1500)}`);
		}
		// The diffs: package.json's start and dependencies, astro.config's imports and keys, a whole new file.
		assert.match(dry.out, /--- a\/package\.json\n\+\+\+ b\/package\.json\n/);
		assert.match(dry.out, /-    "start": "node server\.mjs",\n\+    "start": "caracms start",/);
		assert.match(dry.out, /\+    "@astrojs\/node": "\^11\.1\.7",/);
		assert.match(dry.out, /\+    "caracms": "\d+\.\d+\.\d+",/);
		assert.match(dry.out, /\+    "railway": "\^3\.16\.0",/);
		assert.match(dry.out, /\+import node from '@astrojs\/node';\n\+import caracms from 'caracms';\n\+import site from '\.\/caracms\.config\.ts';/);
		assert.match(dry.out, /\+  adapter: node\(\{ mode: 'standalone' \}\),/);
		assert.match(dry.out, /\+  integrations: \[caracms\(site\)\],/);
		assert.match(dry.out, /\+  devToolbar: \{ enabled: false \},/);
		assert.match(dry.out, /--- \/dev\/null\n\+\+\+ b\/caracms\.config\.ts\n@@ -0,0 \+1,\d+ @@\n\+import \{ defineSite, text \} from 'caracms\/config';/);
		assert.match(dry.out, /\+  "brand": \{\n\+    "name": "Weekend Bikes"\n/);
		assert.match(dry.out, /Then, after --write: `pnpm install`/);
	});

	test('--write makes exactly the change the dry run showed (Acceptance 5)', async () => {
		planned = await plan(site.root, { railway: true, mode: 'self-hosted' });
		const written = await init(site, true, true);
		assert.equal(written.code, 0, written.err);
		assert.ok(!written.out.includes(hostVariablesText()));
		for (const c of planned.changes) {
			if (c.kind === 'add' || c.kind === 'edit') assert.equal(site.read(c.file), c.after, c.file);
			else if (c.kind === 'link') assert.equal(readlinkSync(join(site.root, c.file)), c.target);
			else if (c.kind === 'schemas') assert.ok(site.exists(c.file), c.file);
		}
		const changed = site
			.status()
			.split('\n')
			.filter(Boolean)
			.map((l) => l.slice(3));
		const expected = [...planned.changes.map((c) => c.file), ...readdirSync(join(site.root, 'schemas')).map((n) => `schemas/${n}`)];
		for (const file of changed) assert.ok(expected.includes(file), `${file} changed, but the dry run didn't show it`);
		assert.match(written.out, /^caracms init: done\. It changed:/);
		assert.match(written.out, /Next: `pnpm install`/);
	});

	test('CLAUDE.md stays a link, and its target gets the block once (Acceptance 10)', () => {
		assert.ok(lstatSync(join(site.root, 'CLAUDE.md')).isSymbolicLink());
		const agents = site.read('AGENTS.md');
		assert.ok(agents.startsWith('# weekend-bikes\n\nThe bike shop site.\n\n<!-- caracms:start -->\n'));
		assert.equal(agents.split(MARK_START).length, 2);
		assert.match(agents, /Run `caracms validate` before a pull request\.\n<!-- caracms:end -->\n$/);
	});

	test('the files: the config, the settings, the gitignore, the tsconfig, Railway, the skills', () => {
		const settings = JSON.parse(site.read('content/site-settings.json'));
		assert.deepEqual(settings, { $schema: '../schemas/site-settings.schema.json', title: 'Site Settings', editors: [], brand: { name: 'Weekend Bikes' } });
		assert.match(site.read('.gitignore'), /\n\.caracms\/\n$/);
		assert.match(site.read('tsconfig.json'), /"compilerOptions": \{\n {4}"allowImportingTsExtensions": true\n {2}\}\n\}\n$/);
		const railway = site.read('.railway/railway.ts');
		assert.match(railway, new RegExp(`const SITE = "${site.root.split('/').pop()}";`));
		assert.match(railway, /const GITHUB_REPO = "OWNER\/REPO";/, 'no remote: a placeholder, and a note');
		assert.match(railway, /const BUILD_COMMAND = "pnpm build";\nconst START_COMMAND = "pnpm start";/);
		assert.doesNotMatch(railway, /demo only|"\{\{(SITE|GITHUB_REPO|BUILD|START)\}\}"/);
		for (const name of skillNames()) assertCopied(site, name);
		// M9 check 9: the Tina skill is one of them, and the CLAUDE.md block says what it's for.
		assert.deepEqual(skillNames(), ['caracms-adopt', 'caracms-blocks', 'caracms-content', 'caracms-hosting', 'caracms-starlight', 'caracms-tina', 'caracms-upgrade']);
		assert.match(claudeBlock(skillNames()), /- `caracms-tina`: porting a site built on Tina/);
		for (const f of SCHEMAS) assert.ok(site.exists(f), f);
	});

	test('run again on the set-up site, it has nothing to do (Acceptance 9); its Railway file is kept as today, without the flag', async () => {
		site.commit('caracms init');
		const again = await init(site);
		assert.equal(again.code, 0);
		assert.equal(again.out, `caracms init: nothing to do. caracms is set up here.\n\n${MODE_LINES['self-hosted']}\n`);
		const write = await init(site, true);
		assert.equal(write.out, again.out);
		assert.equal(site.status(), '');
	});

	test('after a version bump: a new skill copied in, an older one refreshed, a gone one removed, the block and the schemas refreshed, a file without $schema stamped', async () => {
		const [first, second] = skillNames() as [string, string];
		// What an older caracms copied: a skill this one doesn't have, and an older text of `second`, both in the stamp.
		const stamp = JSON.parse(site.read(SKILLS_STAMP));
		mkdirSync(join(site.root, '.claude/skills/caracms-gone'), { recursive: true });
		writeFileSync(join(site.root, '.claude/skills/caracms-gone/SKILL.md'), 'gone\n');
		stamp.files['caracms-gone/SKILL.md'] = sha('gone\n');
		writeFileSync(join(site.root, `.claude/skills/${second}/SKILL.md`), 'older\n');
		stamp.files[`${second}/SKILL.md`] = sha('older\n');
		writeFileSync(join(site.root, SKILLS_STAMP), JSON.stringify(stamp));
		const agents = site.read('AGENTS.md').replace('Run `caracms validate`', 'Run the old thing');
		writeFileSync(join(site.root, 'AGENTS.md'), agents);
		const schema = site.read('schemas/pages.schema.json');
		writeFileSync(join(site.root, 'schemas/pages.schema.json'), schema.replace('"Pages"', '"Old pages"'));
		mkdirSync(join(site.root, 'content/pages'), { recursive: true });
		writeFileSync(join(site.root, 'content/pages/careers.json'), '{\n  "title": "Careers",\n  "blocks": []\n}\n');
		rmSync(join(site.root, `.claude/skills/${first}`), { recursive: true });
		site.commit('older install');
		assert.match(skillsWarning(site.root) ?? '', /^\.claude\/skills is behind the skills of the installed caracms \(\d+\.\d+\.\d+\): run `npx caracms init --write`/);
		const p = await plan(site.root, { mode: 'self-hosted' });
		const firstFiles = readdirSync(join(packageRoot, 'site-skills', first)).sort();
		assert.deepEqual(
			p.changes.map((c) => `${c.kind} ${c.file}`),
			[
				...firstFiles.map((f) => `add .claude/skills/${first}/${f}`),
				`edit .claude/skills/${second}/SKILL.md`,
				'remove .claude/skills/caracms-gone/SKILL.md',
				`edit ${SKILLS_STAMP}`,
				'edit AGENTS.md',
				'schemas schemas/pages.schema.json',
				'schemas content/pages/careers.json',
			],
		);
		const r = await init(site, true);
		assert.equal(r.code, 0, r.err);
		assert.ok(!site.exists('.claude/skills/caracms-gone'), 'the emptied folder goes too');
		for (const name of skillNames()) assertCopied(site, name);
		assert.equal(skillsWarning(site.root), null);
		assert.equal(site.read('AGENTS.md').split(MARK_START).length, 2);
		assert.match(site.read('AGENTS.md'), /Run `caracms validate`/);
		assert.equal(JSON.parse(site.read('content/pages/careers.json')).$schema, '../../schemas/pages.schema.json');
		site.commit('re-init');
		assert.equal((await init(site)).out, `caracms init: nothing to do. caracms is set up here.\n\n${MODE_LINES['self-hosted']}\n`);
	});

	test("a skill file edited here is left alone, with a note; init refreshes it once it's deleted", async () => {
		const [name] = skillNames() as [string];
		const file = `.claude/skills/${name}/SKILL.md`;
		writeFileSync(join(site.root, file), `${site.read(file)}\nOur own addition.\n`);
		site.commit('our skill note');
		const r = await init(site, true);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, new RegExp(`${file.replaceAll('.', '\\.')} has been edited here, so init leaves it as it is\\. caracms's own is node_modules/caracms/site-skills/${name}/SKILL\\.md`));
		assert.match(site.read(file), /Our own addition\./);
		assert.equal(skillsWarning(site.root), null, 'an edited file is the site\'s, not behind');
		rmSync(join(site.root, file));
		site.commit('take our note out');
		assert.equal((await init(site, true)).code, 0);
		assertCopied(site, name);
		site.commit('back to caracms\'s');
	});

	test('a site on 0.8 links: the links become copies, and dev and validate said so first', async () => {
		rmSync(join(site.root, '.claude/skills'), { recursive: true });
		mkdirSync(join(site.root, '.claude/skills'));
		for (const name of skillNames()) symlinkSync(`../../node_modules/caracms/skills/${name}`, join(site.root, `.claude/skills/${name}`));
		// What `pnpm approve` left (High-street coffee roaster): its own links, gitignored by its own .gitignore.
		writeFileSync(join(site.root, '.claude/skills/.gitignore'), 'pnpm-*\n');
		symlinkSync('../../node_modules/.pnpm/caracms@0.8.3/node_modules/caracms/skills/caracms-adopt', join(site.root, '.claude/skills/pnpm-caracms-caracms-adopt'));
		site.commit('as 0.8 left it');
		assert.match(skillsWarning(site.root) ?? '', /^\.claude\/skills links caracms's skills from node_modules, and caracms \d+\.\d+\.\d+ copies them in instead/);
		const p = await plan(site.root, { mode: 'self-hosted' });
		assert.deepEqual(p.changes.filter((c) => c.kind === 'unlink').map((c) => c.file), [...skillNames().map((n) => `.claude/skills/${n}`), '.claude/skills/pnpm-caracms-caracms-adopt']);
		const r = await init(site, true);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /unlink  \.claude\/skills\/caracms-adopt \(a link into node_modules, now a copy\)/);
		assert.doesNotMatch(r.out, /Our own|^\+/m, 'no skill diffs');
		for (const name of skillNames()) assertCopied(site, name);
		assert.ok(!site.exists('.claude/skills/pnpm-caracms-caracms-adopt'));
		assert.equal(site.read('.claude/skills/.gitignore'), 'pnpm-*\n', "pnpm's .gitignore stays: other packages may use it");
		assert.equal(skillsWarning(site.root), null);
		site.commit('copies');
	});

	test("a set-up site that deleted the starting page component and block doesn't get them back (weekend-bikes)", async () => {
		// As a port leaves it: its own components, named in the config, and the starting ones deleted.
		mkdirSync(join(site.root, 'src/components/site'), { recursive: true });
		for (const [from, to] of [['TextBlock', 'Text'], ['Page', 'Page']]) {
			writeFileSync(join(site.root, `src/components/site/${to}.astro`), site.read(`src/components/caracms/${from}.astro`));
			rmSync(join(site.root, `src/components/caracms/${from}.astro`));
		}
		writeFileSync(join(site.root, 'caracms.config.ts'), site.read('caracms.config.ts').replace("'src/components/caracms/TextBlock.astro'", "'src/components/site/Text.astro'").replace("'src/components/caracms/Page.astro'", "'src/components/site/Page.astro'"));
		site.commit('the port has its own');
		const r = await init(site, true);
		assert.equal(r.code, 0, r.err);
		assert.equal(r.out, `caracms init: nothing to do. caracms is set up here.\n\n${MODE_LINES['self-hosted']}\n`);
		assert.ok(!site.exists('src/components/caracms/TextBlock.astro'));
		assert.equal(site.status(), '');
	});

	test("pnpm's approval of caracms's skills is taken out, and said why (High-street coffee roaster: it failed Railway's install)", async () => {
		const workspace = 'minimumReleaseAgeExclude:\n  - caracms@0.8.3\npermissions:\n  caracms:\n    skills: true\n';
		writeFileSync(join(site.root, 'pnpm-workspace.yaml'), workspace);
		site.commit('pnpm approve');
		const p = await plan(site.root, { mode: 'self-hosted' });
		assert.deepEqual(p.changes.map((c) => `${c.kind} ${c.file}`), ['edit pnpm-workspace.yaml']);
		const r = await init(site, true);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /pnpm-workspace\.yaml approved caracms's agent skills .* pnpm won't ask about caracms again\./);
		assert.equal(site.read('pnpm-workspace.yaml'), 'minimumReleaseAgeExclude:\n  - caracms@0.8.3\n');
		site.commit('re-init');
		assert.equal((await init(site)).out, `caracms init: nothing to do. caracms is set up here.\n\n${MODE_LINES['self-hosted']}\n`);
	});

	test('--write refuses with uncommitted changes to tracked files, the dry run doesn\'t, and untracked files never count (Acceptance 6)', async () => {
		writeFileSync(join(site.root, 'untracked.txt'), 'x');
		assert.equal((await init(site, true)).code, 0);
		writeFileSync(join(site.root, 'AGENTS.md'), `${site.read('AGENTS.md')}more\n`);
		const before = site.snapshot();
		const refused = await init(site, true);
		assert.equal(refused.code, 1);
		assert.match(refused.err, /There are uncommitted changes to tracked files \(AGENTS\.md\): commit or stash them first/);
		assert.deepEqual(site.snapshot(), before);
		assert.equal((await init(site)).code, 0);
	});
});

describe('a site builds after init, and a document renders through the templates (Acceptance 5)', () => {
	test('existing pages build as before; content/pages/hello.json is at /hello', async () => {
		const site = makeSite('build', {
			'package.json': '{\n  "name": "tiny-site",\n  "type": "module",\n  "dependencies": {\n    "astro": "^7.3.8"\n  }\n}\n',
			'astro.config.mjs': "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n",
			'tsconfig.json': '{\n  "extends": "astro/tsconfigs/base"\n}\n',
			'src/pages/index.astro': '<h1>Home, as code</h1>\n',
			'src/pages/about.astro': '<h1>About, as code</h1>\n',
		});
		const r = await init(site, true);
		assert.equal(r.code, 0, r.err);
		mkdirSync(join(site.root, 'content/pages'), { recursive: true });
		writeFileSync(join(site.root, 'content/pages/hello.json'), '{\n  "$schema": "../../schemas/pages.schema.json",\n  "title": "Hello",\n  "blocks": [\n    { "type": "text", "text": "Hello from a document." }\n  ]\n}\n');
		const build = spawnSync(process.execPath, [join(packageRoot, 'node_modules/astro/bin/astro.mjs'), 'build'], { cwd: site.root, encoding: 'utf8' });
		assert.equal(build.status, 0, build.stdout + build.stderr);
		assert.match(readFileSync(join(site.root, 'dist/client/index.html'), 'utf8'), /Home, as code/);
		assert.match(readFileSync(join(site.root, 'dist/client/about/index.html'), 'utf8'), /About, as code/);
		const hello = readFileSync(join(site.root, 'dist/client/hello/index.html'), 'utf8');
		assert.match(hello, /<p>Hello from a document\.<\/p>/);
		assert.match(hello, /<title>Hello/);
		const clean = cli(site, 'validate');
		assert.equal(clean.status, 0);
		assert.doesNotMatch(clean.stdout, /\.claude\/skills/);
		// An older caracms's copy of a skill: a warning through the site's own Vite, never a failure.
		const [name] = skillNames() as [string];
		const stamp = JSON.parse(site.read(SKILLS_STAMP));
		writeFileSync(join(site.root, `.claude/skills/${name}/SKILL.md`), 'older\n');
		stamp.files[`${name}/SKILL.md`] = sha('older\n');
		writeFileSync(join(site.root, SKILLS_STAMP), JSON.stringify(stamp));
		const behind = cli(site, 'validate');
		assert.equal(behind.status, 0, behind.stderr);
		assert.match(behind.stdout, /Warnings:\n(.*\n)*  \.claude\/skills: \.claude\/skills is behind the skills of the installed caracms/);
	});
});

describe('blockers (Decision 9, Acceptance 6–7)', () => {
	const pkg = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ name: 'x', type: 'module', dependencies: { astro: '^7.3.8' }, ...extra }, null, 2)}\n`;
	const NODE_CONFIG = "import { defineConfig } from 'astro/config';\nimport node from '@astrojs/node';\n\nexport default defineConfig({\n  adapter: node({ mode: 'standalone' }),\n});\n";

	async function refused(site: Site, write = false) {
		const before = site.snapshot();
		const r = await init(site, write);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.out, '');
		assert.deepEqual(site.snapshot(), before, 'nothing written');
		return r.err.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4));
	}

	test('High-street coffee roaster on the Node adapter (npm): exactly its sitemap.xml.ts and robots.txt.ts', async () => {
		const site = makeSite('node-own-seo', {
			'package.json': pkg({ name: 'high-street-coffee', dependencies: { '@astrojs/node': '^11.1.9', astro: '^7.3.8' } }),
			'package-lock.json': '{}\n',
			'astro.config.mjs': NODE_CONFIG,
			'src/pages/index.astro': '',
			'src/pages/api/contact.ts': '',
			'src/pages/sitemap.xml.ts': '',
			'src/pages/robots.txt.ts': '',
		});
		const problems = await refused(site);
		assert.equal(problems.length, 2, problems.join('\n'));
		assert.match(problems[0]!, /^src\/pages\/sitemap\.xml\.ts is the site's own \/sitemap\.xml, .*Delete it/);
		assert.match(problems[1]!, /^src\/pages\/robots\.txt\.ts is the site's own \/robots\.txt, and caracms's server \(`caracms start`\) answers \/robots\.txt itself/);
	});

	test('High-street coffee roaster on the Cloudflare adapter, with its own sitemap: both named in one run', async () => {
		const site = makeSite('cloudflare-own-seo', {
			'package.json': pkg({ dependencies: { '@astrojs/cloudflare': '^14.3.4', astro: '^7.3.8' } }),
			'astro.config.mjs': "import { defineConfig } from 'astro/config';\nimport cloudflare from '@astrojs/cloudflare';\n\nexport default defineConfig({\n  adapter: cloudflare({ imageService: 'passthrough' }),\n});\n",
			'src/pages/sitemap.xml.ts': '',
		});
		const problems = await refused(site);
		assert.ok(problems.some((p) => /astro\.config\.mjs uses the @astrojs\/cloudflare adapter\. caracms runs on the Node adapter/.test(p)), problems.join('\n'));
		assert.ok(problems.some((p) => /sitemap\.xml\.ts/.test(p)));
	});

	test('a Tina site is named as one', async () => {
		const site = makeSite('tina', {
			'package.json': pkg({ dependencies: { astro: '^7.3.5', tinacms: '^2.0.0', '@tinacms/astro': '^0.7.1' } }),
			'tina/config.ts': 'export default {};\n',
			'content/pages/home.md': '# Home\n',
			'astro.config.mjs': NODE_CONFIG,
			'.railway/railway.ts': '// the site\'s own\n',
		});
		const problems = await refused(site);
		assert.ok(problems.includes('This is a Tina site (a tina/ folder with tracked files and tinacms in its dependencies): Tina sites come in through a port, not `init`.'), problems.join('\n'));
		assert.ok(problems.some((p) => /^content\/ already holds files that aren't caracms's \(content\/pages\/home\.md\)/.test(p)));
	});

	// An adoption trial, item 1: a site stripped of Tina kept its git-ignored, untracked tina/__generated__/.
	test('a stripped Tina site: an ignored, untracked tina/__generated__/ alone isn\'t Tina, and a note says to delete it', async () => {
		const site = makeSite('tina-stripped', {
			'package.json': pkg(),
			'.gitignore': 'tina/__generated__/\n',
			'tina/__generated__/_schema.json': '{}\n',
			'astro.config.mjs': NODE_CONFIG,
		});
		assert.equal(execFileSync('git', ['ls-files', 'tina'], { cwd: site.root, encoding: 'utf8' }), '', 'nothing under tina/ is tracked');
		const p = await plan(site.root, { mode: 'self-hosted' });
		assert.deepEqual(p.problems, []);
		assert.ok(p.notes.includes('tina/__generated__/ is left over from Tina (nothing under tina/ is tracked): delete it.'), p.notes.join('\n'));
		// With tinacms still in the dependencies, it's a Tina site by that alone.
		writeFileSync(join(site.root, 'package.json'), pkg({ dependencies: { astro: '^7.3.8', tinacms: '^2.0.0' } }));
		site.commit('tinacms back');
		const problems = await refused(site);
		assert.ok(problems.includes('This is a Tina site (tinacms in its dependencies): Tina sites come in through a port, not `init`.'), problems.join('\n'));
	});

	test('a tina/ folder with tracked files is a Tina site without tinacms in the dependencies', async () => {
		const site = makeSite('tina-tracked', {
			'package.json': pkg(),
			'tina/config.ts': 'export default {};\n',
			'astro.config.mjs': NODE_CONFIG,
		});
		const problems = await refused(site);
		assert.ok(problems.includes('This is a Tina site (a tina/ folder with tracked files): Tina sites come in through a port, not `init`.'), problems.join('\n'));
	});

	test('the package\'s reserved paths, as routes or in public/', async () => {
		const site = makeSite('reserved', {
			'package.json': pkg(),
			'src/pages/admin.astro': '',
			'src/pages/files/[...path].astro': '',
			'public/_caracms/x.txt': '',
			'src/pages/[...slug].astro': '',
		});
		const problems = await refused(site);
		assert.ok(problems.some((p) => /^src\/pages\/admin\.astro serves \/admin, which caracms reserves/.test(p)), problems.join('\n'));
		assert.ok(problems.some((p) => /^src\/pages\/files\/\[\.\.\.path\]\.astro serves addresses under \/files, which caracms reserves/.test(p)), problems.join('\n'));
		assert.ok(problems.some((p) => /^public\/_caracms is at \/_caracms, which caracms reserves/.test(p)));
		assert.ok(problems.some((p) => /^src\/pages\/\[\.\.\.slug\]\.astro already catches addresses at the top of the site/.test(p)));
	});

	test('outside a git repo: refused, with the other blockers in the same run', async () => {
		// In the OS's temp folder: test/.tmp is inside this repository. No Astro is installed there either.
		const site = makeSite('no-git', { 'package.json': pkg(), 'src/pages/robots.txt.ts': '' }, { git: false, inPackage: false });
		const problems = await refused(site);
		assert.match(problems[0]!, /^This isn't a git repository: init only runs in one/);
		assert.ok(problems.some((p) => /robots\.txt\.ts/.test(p)));
		assert.equal(problems.length, 2, problems.join('\n'));
	});

	test('no Astro at all; an Astro outside the peer range', async () => {
		const none = makeSite('no-astro', { 'package.json': '{ "name": "x" }\n' }, { inPackage: false });
		assert.ok((await refused(none)).some((p) => /^There's no Astro here/.test(p)));
		const old = makeSite('old-astro', { 'package.json': `${JSON.stringify({ name: 'x', dependencies: { astro: '^6.2.0' } })}\n` }, { inPackage: false });
		assert.ok((await refused(old)).some((p) => /^Astro \^6\.2\.0 is outside the range caracms .* works with \(\^7\.3\.8\)/.test(p)));
	});

	test('robots.txt and sitemap.xml in public/ are the site\'s own too: the gate answers /robots.txt before static files, and caracms makes the sitemap', async () => {
		const site = makeSite('public-robots', { 'package.json': pkg(), 'public/robots.txt': 'User-agent: *\n', 'public/sitemap.xml': '<urlset/>\n' });
		const problems = await refused(site);
		assert.equal(problems.length, 2, problems.join('\n'));
		assert.match(problems[0]!, /^public\/sitemap\.xml is the site's own \/sitemap\.xml, and caracms makes the sitemap from its documents .*Delete it/);
		assert.match(problems[1]!, /^public\/robots\.txt is the site's own \/robots\.txt, and caracms's server \(`caracms start`\) answers \/robots\.txt itself, before Astro and public\//);
	});

	test('a site\'s own src/pages/[...path].astro is a blocker; caracms\'s template at that path isn\'t', async () => {
		const own = makeSite('own-catch-all', { 'package.json': pkg(), 'src/pages/[...path].astro': '---\nexport const getStaticPaths = () => [];\n---\n<h1>The site\'s own</h1>\n' });
		const problems = await refused(own);
		assert.equal(problems.length, 1, problems.join('\n'));
		assert.match(problems[0]!, /^src\/pages\/\[\.\.\.path\]\.astro is the site's own: it isn't the page caracms adds at that path, and it catches addresses at the top of the site.*Move it under a folder of its own/);
		const ours = makeSite('our-catch-all', { 'package.json': pkg(), 'src/pages/[...path].astro': readFileSync(join(packageRoot, 'bin/templates/catch-all.astro.txt'), 'utf8') });
		const r = await init(ours);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /Already done: .*src\/pages\/\[\.\.\.path\]\.astro/);
	});

	test('--write after installing caracms: the refusal says to commit the install first, with the git line', async () => {
		const site = makeSite('fresh-install', { 'package.json': pkg(), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
		writeFileSync(join(site.root, 'package.json'), pkg({ dependencies: { astro: '^7.3.8', caracms: '0.0.0' } }));
		writeFileSync(join(site.root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# caracms\n");
		const problems = await refused(site, true);
		assert.deepEqual(problems, ['package.json and pnpm-lock.yaml have uncommitted changes, which installing caracms makes. Commit the install first, so init\'s change is one reviewable diff of its own: `git add package.json pnpm-lock.yaml && git commit -m "Install caracms"`, then run init again.']);
		execFileSync('git', ['add', 'package.json', 'pnpm-lock.yaml'], { cwd: site.root });
		execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'Install caracms'], { cwd: site.root });
		assert.equal((await init(site, true)).code, 0);
		// Another file beside them is the general refusal.
		writeFileSync(join(site.root, 'package.json'), pkg({ dependencies: { astro: '^7.3.8', caracms: '0.0.1' } }));
		writeFileSync(join(site.root, 'astro.config.mjs'), `${site.read('astro.config.mjs')}// more\n`);
		site.commit('init');
		writeFileSync(join(site.root, 'package.json'), pkg({ dependencies: { astro: '^7.3.8', caracms: '0.0.2' } }));
		writeFileSync(join(site.root, 'astro.config.mjs'), `${site.read('astro.config.mjs')}// more\n`);
		const general = await refused(site, true);
		assert.match(general[0]!, /^There are uncommitted changes to tracked files \(astro\.config\.mjs, package\.json\): commit or stash them first/);
	});

	test('the Node adapter in middleware mode', async () => {
		const site = makeSite('middleware', { 'package.json': pkg(), 'astro.config.mjs': NODE_CONFIG.replace('standalone', 'middleware') });
		assert.ok((await refused(site)).some((p) => /middleware mode/.test(p)));
	});

	test('bad usage exits 2; a refusal exits 1, from the command', () => {
		const site = makeSite('cli', { 'package.json': pkg(), 'src/pages/robots.txt.ts': '' });
		assert.equal(cli(site, 'init', '--yes').status, 2);
		const r = cli(site, 'init', '--self-hosted');
		assert.equal(r.status, 1);
		assert.match(r.stderr, /^caracms init: one thing is in the way, so nothing was planned:\n {2}- src\/pages\/robots\.txt\.ts/);
	});
});

describe('existing files init can\'t edit safely (Decision 8), and Railway (Decision 11, Acceptance 8)', () => {
	test('a site\'s own .railway/railway.ts is never edited: caracms\'s needs are printed', async () => {
		const own = '// the site\'s own Railway file\n';
		const site = makeSite('railway', { 'package.json': `${JSON.stringify({ name: 'x', dependencies: { astro: '^7.3.8' } })}\n`, '.railway/railway.ts': own });
		const r = await init(site, true);
		assert.equal(r.code, 0, r.err);
		assert.equal(site.read('.railway/railway.ts'), own);
		assert.ok(!r.out.includes(hostVariablesText()), 'a site with a Railway file is treated as today');
		assert.match(r.out, /\.railway\/railway\.ts exists, so init doesn't edit it .*\n {4}Redis: .*\n {4}A media bucket: .*\n {4}A submissions bucket: .*\n {4}imgproxy/);
		assert.ok(!JSON.parse(site.read('package.json')).devDependencies?.railway, 'no railway dependency without its file');
	});

	test('with --railway, a missing one is made with SITE and GITHUB_REPO from the folder and the remote, for npm', async () => {
		const site = makeSite('railway-new', { 'package.json': `${JSON.stringify({ name: 'x', dependencies: { astro: '^7.3.8' } })}\n`, 'package-lock.json': '{}\n' });
		execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example-org/weekend-bikes.git'], { cwd: site.root });
		assert.equal((await init(site, true, true)).code, 0);
		const railway = site.read('.railway/railway.ts');
		assert.match(railway, /const GITHUB_REPO = "example-org\/weekend-bikes";/);
		assert.match(railway, /const BUILD_COMMAND = "npm run build";\nconst START_COMMAND = "npm start";/);
		assert.equal(JSON.parse(site.read('package.json')).devDependencies.railway, VERSIONS.railway);
	});

	test('an astro.config without defineConfig({ … }) is left alone, with the lines to add', async () => {
		const text = "const config = { server: { port: 4321 } };\nexport default config;\n";
		const site = makeSite('odd-config', { 'package.json': `${JSON.stringify({ name: 'x', dependencies: { astro: '^7.3.8' } })}\n`, 'astro.config.mjs': text });
		const r = await init(site, true);
		assert.equal(r.code, 0, r.err);
		assert.equal(site.read('astro.config.mjs'), text);
		assert.match(r.out, /astro\.config\.mjs: it doesn't export `defineConfig\(\{ … \}\)`, so init leaves it alone\. Add these by hand, then run init again:\n {4}import node from '@astrojs\/node';/);
	});

	test('existing integrations: caracms(site) goes in the list', async () => {
		const site = makeSite('integrations', {
			'package.json': `${JSON.stringify({ name: 'x', dependencies: { astro: '^7.3.8' } })}\n`,
			'astro.config.mjs': "import { defineConfig } from 'astro/config';\nimport mdx from '@astrojs/mdx';\n\nexport default defineConfig({\n\tintegrations: [mdx()],\n});\n",
		});
		assert.equal((await init(site, true)).code, 0);
		const config = site.read('astro.config.mjs');
		assert.match(config, /integrations: \[caracms\(site\), mdx\(\)\],/);
		assert.match(config, /import mdx from '@astrojs\/mdx';\nimport node from '@astrojs\/node';\nimport caracms from 'caracms';\nimport site from '\.\/caracms\.config\.ts';\n/);
		assert.match(config, /defineConfig\(\{\n\t\/\/ caracms: pages stay prerendered.*\n\tadapter: node\(\{ mode: 'standalone' \}\),\n/);
		assert.doesNotMatch(config, /integrations: \[caracms\(site\)\],/);
	});

	test('a CLAUDE.md with a start marker and no end marker is left alone, with the block printed to add by hand (Acceptance 10)', async () => {
		const text = `# The site\n\n${MARK_START}\n## caracms\n\nAn old block whose end was deleted.\n\n## Deploying\n\nThe site's own notes.\n`;
		const site = makeSite('orphan-marker', { 'package.json': `${JSON.stringify({ name: 'x', dependencies: { astro: '^7.3.8' } })}\n`, 'CLAUDE.md': text });
		const dry = await init(site);
		assert.equal(dry.code, 0, dry.err);
		assert.doesNotMatch(dry.out, /^ {2}(add|edit) {4}CLAUDE\.md$/m);
		const r = await init(site, true);
		assert.equal(r.code, 0, r.err);
		assert.equal(site.read('CLAUDE.md'), text);
		assert.ok(r.out.includes(`CLAUDE.md has a ${MARK_START} line with no ${MARK_END} after it, so init can't tell where its block ends and leaves the file alone.`), r.out);
		assert.ok(r.out.includes(claudeBlock(skillNames(), 'self-hosted').split('\n').map((l) => `    ${l}`).join('\n')), r.out);
	});

	test('a command that fails names itself, not `caracms start`', () => {
		// .claude is a file, so linking the skills under it fails part-way through --write.
		const site = makeSite('fatal', { 'package.json': `${JSON.stringify({ name: 'x', dependencies: { astro: '^7.3.8' } })}\n`, '.claude': 'not a folder\n' });
		const r = cli(site, 'init', '--write', '--self-hosted');
		assert.equal(r.status, 1);
		assert.match(r.stderr, /^caracms init: /);
		assert.doesNotMatch(r.stderr, /caracms start/);
	});

	test('a site with no CLAUDE.md gets one, with just the block', async () => {
		const site = makeSite('claude', { 'package.json': `${JSON.stringify({ name: 'x', dependencies: { astro: '^7.3.8' } })}\n` });
		assert.equal((await init(site, true)).code, 0);
		assert.equal(site.read('CLAUDE.md'), `${claudeBlock(skillNames(), 'self-hosted')}\n`);
		assert.ok(site.read('CLAUDE.md').endsWith(`${MARK_END}\n`));
	});
});

describe('without --railway: no host file, and the variables any host needs (runs-anywhere Decision 12, check 27)', () => {
	let site: Site;

	test('the dry run plans no Railway file and no railway dependency, and prints the list', async () => {
		site = makeSite('anyhost', STATIC_SITE);
		const dry = await init(site);
		assert.equal(dry.code, 0, dry.err);
		assert.equal(site.status(), '');
		assert.ok(!dry.out.includes('.railway/railway.ts'), dry.out.slice(0, 1500));
		assert.doesNotMatch(dry.out, /"railway":/);
		assert.ok(dry.out.includes(`\n\n${hostVariablesText()}\n`), 'the table, as its own block');
		const p = await plan(site.root, { mode: 'self-hosted' });
		assert.ok(!p.changes.some((c) => c.file.startsWith('.railway')));
	});

	test('--write writes no Railway file and no railway dependency, and prints the list', async () => {
		const written = await init(site, true);
		assert.equal(written.code, 0, written.err);
		assert.match(written.out, /^caracms init: done\. It changed:/);
		assert.ok(written.out.includes(hostVariablesText()));
		assert.ok(!site.exists('.railway'));
		const pkg = JSON.parse(site.read('package.json'));
		assert.ok(!pkg.devDependencies?.railway && !pkg.dependencies?.railway);
		assert.equal(pkg.scripts.start, 'caracms start');
	});

	test('run again, it has nothing to do, and still prints the list', async () => {
		site.commit('caracms init');
		const again = await init(site);
		assert.equal(again.out, `caracms init: nothing to do. caracms is set up here.\n\n${MODE_LINES['self-hosted']}\n\n${hostVariablesText()}\n`);
		assert.ok(!site.exists('.railway'));
	});

	test('the list: one row each, with what it\'s for, the names mode.ts and the gate read', () => {
		const text = hostVariablesText();
		const rows = text.split('\n').slice(2);
		assert.equal(rows.length, HOST_VARIABLES.length);
		assert.deepEqual(
			HOST_VARIABLES.map((v) => v.name),
			['GITHUB_REPO', 'CARACMS_GITHUB_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'SITE_URL', 'REDIS_URL', 'CARACMS_SECRET', 'CARACMS_CLIENT_IP_HEADER', 'CARACMS_ALLOW', 'RESEND_API_KEY', 'FORMS_FROM', 'CARACMS_BACKUP_USER', 'CARACMS_BACKUP_PASSWORD', 'CARACMS_RUNNING_COMMIT', 'CARACMS_DEPLOY_HOOK_URL', 'GITHUB_WEBHOOK_SECRET'],
		);
		for (const [i, v] of HOST_VARIABLES.entries()) {
			assert.ok(rows[i]!.startsWith(`  ${v.name} `) && rows[i]!.includes(v.need) && rows[i]!.endsWith(v.what), rows[i]);
		}
		const need = Object.fromEntries(HOST_VARIABLES.map((v) => [v.name, v.need]));
		for (const n of ['GITHUB_REPO', 'SITE_URL', 'REDIS_URL', 'CARACMS_SECRET']) assert.equal(need[n], 'required', n);
		assert.equal(need.CARACMS_CLIENT_IP_HEADER, 'required off Railway, Fly and Render');
		for (const n of ['CARACMS_ALLOW', 'RESEND_API_KEY', 'FORMS_FROM']) assert.equal(need[n], 'for email sign-in', n);
		for (const n of ['CARACMS_BACKUP_USER', 'CARACMS_BACKUP_PASSWORD']) assert.equal(need[n], 'for the backup sign-in', n);
		for (const n of ['CARACMS_RUNNING_COMMIT', 'CARACMS_DEPLOY_HOOK_URL', 'GITHUB_WEBHOOK_SECRET']) assert.equal(need[n], 'optional', n);
		// The names that exist today are ones the package reads (readMode() in src/live/mode.ts, mostly).
		for (const n of ['GITHUB_REPO', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'REDIS_URL', 'CARACMS_SECRET', 'CARACMS_ALLOW', 'RESEND_API_KEY', 'FORMS_FROM', 'CARACMS_BACKUP_USER', 'CARACMS_BACKUP_PASSWORD', 'CARACMS_RUNNING_COMMIT', 'GITHUB_WEBHOOK_SECRET']) {
			assert.equal(spawnSync('grep', ['-rqF', n, join(packageRoot, 'src')]).status, 0, `${n} isn't read anywhere under src/`);
		}
		assert.match(text, /SITE_URL .*https:\/\/.*same value at build and at run time/);
		assert.match(text, /CARACMS_CLIENT_IP_HEADER .*x-real-ip .*x-forwarded-for .*socket/);
	});

	test('with --railway on the same kind of site: today\'s output, the file and the dependency', async () => {
		const other = makeSite('anyhost-railway', STATIC_SITE);
		const dry = await init(other, false, true);
		assert.equal(dry.code, 0, dry.err);
		assert.ok(dry.out.includes('  add     .railway/railway.ts\n'));
		assert.match(dry.out, /\+    "railway": "\^3\.16\.0",/);
		assert.ok(!dry.out.includes(hostVariablesText()));
	});
});

describe('init\'s templates stay the starter\'s', () => {
	test('railway.ts below its names block is the starter\'s; the versions it adds are the ones caracms uses', () => {
		const body = (text: string) => text.slice(text.indexOf('// A Railway reference inside a longer string'));
		assert.equal(body(readFileSync(join(packageRoot, 'bin/templates/railway.ts.txt'), 'utf8')), body(readFileSync(join(starter, '.railway/railway.ts'), 'utf8')));
		assert.equal(readFileSync(join(packageRoot, 'bin/templates/health.ts.txt'), 'utf8'), readFileSync(join(demoSite, 'src/pages/health.ts'), 'utf8'));
		assert.equal(JSON.parse(readFileSync(join(starter, 'package.json'), 'utf8')).devDependencies.railway, VERSIONS.railway);
		assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).devDependencies['@astrojs/node'], VERSIONS.node);
	});
});

describe('where the site runs: the services field, the move and the key (caracms-cloud M5, checks 7–16)', () => {
	const KEY = `cck_${'k'.repeat(43)}`;
	const never = async (): Promise<string | null> => {
		throw new Error('asked, but it should not have');
	};
	/** A set-up, self-hosted site from before M5: init's Railway file, media variables in .env, no field. */
	async function preM5Site(name: string) {
		const site = makeSite(name, STATIC_SITE);
		assert.equal((await init(site, true, true)).code, 0);
		const config = site.read('caracms.config.ts');
		assert.match(config, /\n\tservices: 'self-hosted',\n/);
		writeFileSync(join(site.root, 'caracms.config.ts'), config.replace("\n\tservices: 'self-hosted',", ''));
		writeFileSync(join(site.root, '.env'), `S3_BUCKET=old-media\nS3_ENDPOINT=https://t3.storageapi.dev\nIMGPROXY_KEY=${'aa'.repeat(32)}\nCARACMS_MEDIA_URL=https://img.old.test\nMUX_TOKEN_ID=mux\n`);
		writeFileSync(join(site.root, '.gitignore'), `${site.read('.gitignore')}.env\n`);
		site.commit('caracms, before M5');
		return site;
	}

	test('check 7: no flag, no field, no terminal: a new site writes nothing, exits 1 and names both flags', async () => {
		const site = makeSite('nomode', STATIC_SITE);
		const before = site.snapshot();
		for (const write of [false, true]) {
			const r = await init(site, write, false, { mode: null });
			assert.equal(r.code, 1);
			assert.match(r.err, /--cloud/);
			assert.match(r.err, /--self-hosted/);
			assert.equal(r.out, '');
			assert.deepEqual(site.snapshot(), before);
		}
	});

	test('check 7: on a site already set up, it does the rest, writes no field and says the mode is not set (exit 0)', async () => {
		const site = await preM5Site('unset');
		const r = await init(site, true, false, { mode: null });
		assert.equal(r.code, 0, r.err);
		assert.doesNotMatch(site.read('caracms.config.ts'), /services/);
		assert.ok(site.read('CLAUDE.md').includes(MODE_LINES.none));
		assert.ok(r.out.includes(MODE_LINES.none));
		for (const name of skillNames()) assertCopied(site, name);
	});

	test('check 7: with a terminal it asks, and writes the answer; both flags are a problem', async () => {
		const site = makeSite('asked', STATIC_SITE);
		let asked = 0;
		const r = await init(site, true, false, { mode: null, ask: async () => (asked++, 'self-hosted') });
		assert.equal(r.code, 0, r.err);
		assert.equal(asked, 1);
		assert.match(site.read('caracms.config.ts'), /export default defineSite\(\{\n\tservices: 'self-hosted',\n\tcollections: \{/);
		const both = await init(site, false, false, { mode: 'both' });
		assert.equal(both.code, 1);
		assert.match(both.err, /`--cloud` and `--self-hosted` are the two places a site runs: give one of them\./);
	});

	test('check 8: run again on a site with the field, it asks nothing and keeps it; the block says the same', async () => {
		const site = makeSite('again', STATIC_SITE);
		assert.equal((await init(site, true, false, { mode: 'cloud' })).code, 0);
		site.commit('init');
		const r = await init(site, true, false, { mode: null, ask: never });
		assert.equal(r.code, 0, r.err);
		assert.equal(site.status(), '');
		assert.match(site.read('caracms.config.ts'), /\tservices: 'cloud',\n/);
		assert.ok(site.read('CLAUDE.md').includes(MODE_LINES.cloud));
		assert.ok(r.out.startsWith(`caracms init: nothing to do. caracms is set up here.\n\n${MODE_LINES.cloud}\n`), r.out);
	});

	test("check 9: --cloud on a self-hosted site writes the field, leaves railway.ts alone and prints the move list in order", async () => {
		const site = await preM5Site('move');
		const railway = site.read('.railway/railway.ts');
		const before = site.snapshot();
		const dry = await init(site, false, false, { mode: 'cloud' });
		assert.equal(dry.code, 0, dry.err);
		assert.deepEqual(site.snapshot(), before, 'the dry run writes nothing (check 15)');
		const r = await init(site, true, false, { mode: 'cloud' });
		assert.equal(r.code, 0, r.err);
		assert.match(site.read('caracms.config.ts'), /export default defineSite\(\{\n\tservices: 'cloud',\n\tcollections: \{/);
		assert.equal(site.read('.railway/railway.ts'), railway, 'byte for byte');
		const out = r.out;
		const order = [
			"The move to CaraCMS Cloud, in order. init only sees this repo",
			'  1. Make the site and a key for it in app.caracms.com',
			"  2. Commit and push `services: 'cloud'`",
			'  3. Copy the images',
			'  4. Set CARACMS_CLOUD_KEY on the host.',
			'  5. Upload each video clip again',
			'  6. Remove every variable the cloud replaces',
			'  7. Once 4–6 hold, retire',
			'  8. Cut .railway/railway.ts down to the site and Redis',
		].map((line) => out.indexOf(line));
		assert.ok(order.every((at) => at >= 0), out);
		assert.deepEqual([...order].sort((a, b) => a - b), order);
		for (const name of REPLACED_NAMES) assert.ok(new RegExp(`\\b${name}\\b`).test(out), name);
		assert.ok(out.includes('S3_BUCKET (* .env)'));
		assert.ok(out.includes('MUX_TOKEN_ID (* .env)'));
		assert.ok(out.includes('GITHUB_REPO (* .railway/railway.ts)'));
		assert.ok(out.includes('RESEND_API_KEY (* .railway/railway.ts)'));
		assert.ok(out.includes(MODE_LINES.cloud));
		assert.ok(site.read('CLAUDE.md').includes(MODE_LINES.cloud));
	});

	test('check 10: a defineSite argument that is not an object literal writes nothing and names the line to add', async () => {
		const site = await preM5Site('notliteral');
		const config = site.read('caracms.config.ts').replace('export default defineSite({', 'const config = {').replace(/\n\}\);\n?$/, '\n};\nexport default defineSite(config);\n');
		writeFileSync(join(site.root, 'caracms.config.ts'), config);
		site.commit('config from a variable');
		const before = site.snapshot();
		const r = await init(site, true, false, { mode: 'cloud' });
		assert.equal(r.code, 1);
		assert.match(r.err, /isn't an object literal/);
		assert.ok(r.err.includes("services: 'cloud',"));
		assert.deepEqual(site.snapshot(), before);
	});

	test('withServices: inserted first, an existing string replaced, inline literals, and a property set from elsewhere refused', () => {
		assert.equal(withServices("export default defineSite({\n  page: 'x',\n});\n", 'cloud').text, "export default defineSite({\n  services: 'cloud',\n  page: 'x',\n});\n");
		assert.equal(withServices("defineSite({\n\tpage: 'x',\n\tservices: 'self-hosted',\n})", 'cloud').text, "defineSite({\n\tpage: 'x',\n\tservices: 'cloud',\n})");
		assert.equal(withServices("defineSite({ page: 'x' })", 'cloud').text, "defineSite({ services: 'cloud', page: 'x' })");
		// A nested `services` (in a block's fields) isn't the site's.
		assert.equal(withServices("defineSite({\n\tblocks: { a: { services: 'x' } },\n})", 'cloud').text, "defineSite({\n\tservices: 'cloud',\n\tblocks: { a: { services: 'x' } },\n})");
		assert.match(withServices("defineSite({\n\tservices: mode,\n})", 'cloud').problem!, /line 2 sets services from something other than a string/);
		assert.match(withServices('export default site;', 'cloud').problem!, /no `defineSite\(…\)` call/);
	});

	test('check 11: --cloud --railway on a fresh site writes the site and Redis only', async () => {
		const site = makeSite('cloudrailway', STATIC_SITE);
		const r = await init(site, true, true, { mode: 'cloud' });
		assert.equal(r.code, 0, r.err);
		const railway = site.read('.railway/railway.ts');
		assert.match(railway, /redis\("Redis"/);
		assert.match(railway, /CARACMS_CLOUD_KEY: preserve\(\)/);
		assert.doesNotMatch(railway, /\bbucket\s*\(|service\("imgproxy"|ghcr\.io/);
		for (const name of REPLACED_NAMES) assert.doesNotMatch(railway, new RegExp(`\\b${name}\\b`), name);
		assert.doesNotMatch(r.out, /The move to CaraCMS Cloud/, 'a fresh site has nothing to move');
	});

	test('check 12: --self-hosted on a cloud site writes the field and prints the way back', async () => {
		const site = makeSite('back', STATIC_SITE);
		assert.equal((await init(site, true, false, { mode: 'cloud' })).code, 0);
		site.commit('on the cloud');
		const r = await init(site, true, false, { mode: 'self-hosted' });
		assert.equal(r.code, 0, r.err);
		assert.match(site.read('caracms.config.ts'), /\tservices: 'self-hosted',\n/);
		assert.ok(r.out.includes(WAY_BACK));
		assert.match(WAY_BACK, /Hosting section/);
		assert.match(WAY_BACK, /bucket/);
	});

	test('check 13: --cloud shows the key\'s site, team, repo and App; a refusal\'s sentence; where to make one; never the key', async () => {
		const site = makeSite('key', STATIC_SITE);
		const seen: { url: string; auth: string | null }[] = [];
		const answer = (status: number, body: unknown): typeof fetch =>
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
				return Response.json(body, { status });
			}) as typeof fetch;
		const ok = await init(site, false, false, {
			mode: 'cloud',
			env: { CARACMS_CLOUD_KEY: KEY, CARACMS_CLOUD_URL: 'https://cloud.test' },
			fetch: answer(200, { site: { name: 'High-street coffee roaster' }, team: { name: 'CaraCMS' }, github: { repo: 'example-org/high-street-coffee', installed: true }, folder: 'sites/high-street-coffee/' }),
		});
		assert.equal(ok.code, 0, ok.err);
		assert.deepEqual(seen, [{ url: 'https://cloud.test/v1/settings', auth: `Bearer ${KEY}` }]);
		assert.ok(ok.out.includes('CaraCMS Cloud key (from the environment):\n  Site: High-street coffee roaster\n  Team: CaraCMS\n  Repo: example-org/high-street-coffee (App installed)'), ok.out);
		const notInstalled = await init(site, false, false, { mode: 'cloud', env: { CARACMS_CLOUD_KEY: KEY }, fetch: answer(200, { site: { name: 'U' }, team: { name: 'T' }, github: { repo: 'a/b', installed: false } }) });
		assert.match(notInstalled.out, /Repo: a\/b \(App not installed: install the caracms App/);
		const refused = await init(site, false, false, { mode: 'cloud', env: { CARACMS_CLOUD_KEY: KEY }, fetch: answer(401, { error: 'revoked_key', message: 'This key was revoked in app.caracms.com. Make a new one.' }) });
		assert.equal(refused.code, 0);
		assert.ok(refused.out.includes('CaraCMS Cloud key (from the environment): refused. This key was revoked in app.caracms.com. Make a new one.'));
		const none = await init(site, false, false, { mode: 'cloud', env: {} });
		assert.match(none.out, /CaraCMS Cloud key: none here .* Make one in app\.caracms\.com, a labelled key per laptop or environment/);
		// From .env too.
		writeFileSync(join(site.root, '.env'), `CARACMS_CLOUD_KEY=${KEY}\n`);
		const fromFile = await init(site, false, false, { mode: 'cloud', env: {}, fetch: answer(200, { site: { name: 'U' }, team: { name: 'T' }, github: { repo: null, installed: null } }) });
		assert.match(fromFile.out, /CaraCMS Cloud key \(from \.env\):[\s\S]*Repo: none linked yet/);
		for (const r of [ok, notInstalled, refused, none, fromFile]) assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
		// --self-hosted never checks a key.
		seen.length = 0;
		await init(site, false, false, { mode: 'self-hosted', env: { CARACMS_CLOUD_KEY: KEY }, fetch: answer(200, {}) });
		assert.deepEqual(seen, []);
	});

	test('check 15: the dry run of each case writes nothing', async () => {
		const KEY2 = `cck_${'z'.repeat(43)}`;
		const seen = async (name: string, run: (site: Site) => Promise<{ code: number; err: string; out: string }>, setup: (site: Site) => void | Promise<void> = () => {}) => {
			const site = makeSite(name, STATIC_SITE);
			await setup(site);
			const before = site.snapshot();
			const r = await run(site);
			assert.deepEqual(site.snapshot(), before, `${name}: the dry run wrote something`);
			return r;
		};
		const cloudSite = async (site: Site) => {
			assert.equal((await init(site, true, false, { mode: 'cloud' })).code, 0);
			site.commit('on the cloud');
		};
		await seen('dry-asked', (site) => init(site, false, false, { mode: null, ask: async () => 'cloud' }));
		await seen('dry-again', (site) => init(site, false, false, { mode: null, ask: never }), cloudSite);
		await seen('dry-railway', (site) => init(site, false, true, { mode: 'cloud' }));
		await seen('dry-back', (site) => init(site, false, false, { mode: 'self-hosted' }), cloudSite);
		await seen('dry-key', (site) => init(site, false, false, { mode: 'cloud', env: { CARACMS_CLOUD_KEY: KEY2 }, fetch: (async () => Response.json({ site: { name: 'U' }, team: { name: 'T' }, github: { repo: 'a/b', installed: true } })) as typeof fetch }));
		const move = await preM5Site('dry-move');
		const before = move.snapshot();
		assert.equal((await init(move, false, false, { mode: 'cloud' })).code, 0);
		assert.deepEqual(move.snapshot(), before, 'the move list');
		const none = await seen('dry-notmode', (site) => init(site, false, false, { mode: null }));
		assert.equal(none.code, 1);
	});

	test('check 16: the block lists caracms-hosting, and init copies it in', async () => {
		const site = makeSite('hosting', STATIC_SITE);
		assert.equal((await init(site, true, false, { mode: 'cloud' })).code, 0);
		assertCopied(site, 'caracms-hosting');
		assert.match(site.read('CLAUDE.md'), /- `caracms-hosting`: where the site runs, CaraCMS Cloud or self-hosted/);
	});

	test('on the cloud, the host variables table has the key and none of what it replaces', () => {
		const text = hostVariablesText('cloud');
		assert.match(text, /CARACMS_CLOUD_KEY/);
		for (const name of REPLACED_NAMES) assert.doesNotMatch(text, new RegExp(`^  ${name} `, 'm'), name);
		assert.doesNotMatch(text, /^  GITHUB_WEBHOOK_SECRET /m, 'the cloud has no webhook');
		assert.match(hostVariablesText(), /^  GITHUB_WEBHOOK_SECRET /m, 'self-hosted keeps it');
	});
});

describe('withoutSkillsApproval: the pnpm-workspace.yaml shapes', () => {
	test('only the approval goes; emptied parents go with it', () => {
		assert.equal(withoutSkillsApproval('permissions:\n  caracms:\n    skills: true\n'), '');
		assert.equal(withoutSkillsApproval('a: 1\npermissions:\n  caracms:\n    skills: true\nb: 2\n'), 'a: 1\nb: 2\n');
		assert.equal(withoutSkillsApproval('permissions:\n  "caracms":\n    skills: true  # approved\n'), '');
	});
	test("another package's decision, or another of caracms's, stays", () => {
		assert.equal(withoutSkillsApproval('permissions:\n  caracms:\n    skills: true\n  esbuild:\n    build: true\n'), 'permissions:\n  esbuild:\n    build: true\n');
		assert.equal(withoutSkillsApproval('permissions:\n  caracms:\n    build: false\n    skills: true\n'), 'permissions:\n  caracms:\n    build: false\n');
	});
	test('nothing to take out: the same text', () => {
		for (const text of ['minimumReleaseAge: 0\n', 'permissions:\n  caracms:\n    skills: false\n', 'permissions:\n  other:\n    skills: true\n']) assert.equal(withoutSkillsApproval(text), text);
	});
	test("a shape it can't follow: undefined, so init notes it", () => {
		assert.equal(withoutSkillsApproval('permissions:\n  caracms: { skills: true }\n'), undefined);
		assert.equal(withoutSkillsApproval('permissions: { caracms: { skills: true } }\n'), undefined);
	});
});
