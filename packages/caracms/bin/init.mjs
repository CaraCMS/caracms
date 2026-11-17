// `caracms init [--write] [--railway] [--cloud | --self-hosted]` (M8 Decisions 7–13,
// caracms-cloud M5 Decisions 5–11): add caracms's plumbing to an existing Astro site, and
// nothing about its design.
//
// - Run plainly, it prints every file it would add and every edit as a diff, and writes
//   nothing. `--write` applies exactly that, then writes the schemas (`caracms schemas`).
// - Where the site runs (the config's `services`, M5): `--cloud` or `--self-hosted` writes
//   it into the `defineSite({` literal. With neither and no field yet, it asks only when a
//   person can answer (a terminal on both ends); otherwise a new site stops and names both
//   flags, and a site already set up gets everything else and "Mode not set". A field
//   already there is the mode, never asked again; a flag against it is the move: `--cloud`
//   prints the move list for a self-hosted site, `--self-hosted` the way back. `--cloud`
//   checks the key (`GET /v1/settings`) when it can find one, never printing it.
// - It stops on anything in the way (Decision 9), naming each problem with what to do, and
//   writes nothing. One run reports every problem, the git checks included.
// - An existing file it can't edit safely (an astro.config it can't follow, an existing
//   `.railway/railway.ts`) gets the lines to add printed instead, and is left alone.
// - `.railway/railway.ts` and the `railway` dependency come only with `--railway`, or are
//   left as they are on a site that already has the file (runs-anywhere Decision 12).
//   Otherwise init writes no host file and prints the variables any host needs
//   (HOST_VARIABLES), on the dry run and on `--write`.
// - Run again, it refreshes the skills (copies, skills.mjs), the CLAUDE.md block and the schemas, and
//   reports the rest as already done.
//
// Plain JavaScript importing only Node built-ins, media.mjs and skills.mjs (and, for the schemas and the
// config's `services`, the site's own Vite through site-runner.mjs), so it runs on Node
// 22.12 with no flags.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLOUD_URL, OWN_MEDIA_NAMES, parseDotenv, REPLACED_NAMES } from './media.mjs';
import { skillNames, skillsPlan } from './skills.mjs';

export { skillNames };

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const templates = fileURLToPath(new URL('./templates/', import.meta.url));
const template = (name) => readFileSync(join(templates, name), 'utf8');
const ownPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

/**
 * The variables any host needs (runs-anywhere Decision 12): the one list, printed by init
 * without `--railway`. The package README's Hosting section matches it. Names as
 * `src/live/mode.ts` reads them, and the gate's `CARACMS_CLIENT_IP_HEADER`.
 */
export const HOST_VARIABLES = [
	{ name: 'GITHUB_REPO', need: 'required', what: "The site's repository, as owner/name." },
	{ name: 'CARACMS_GITHUB_TOKEN', need: 'required, or the App', what: 'A fine-grained token (github_pat_…) on that one repo: Contents read and write, Metadata read (Deployments read is optional). Never GITHUB_TOKEN.' },
	{ name: 'GITHUB_APP_ID', need: 'instead of the token', what: "The GitHub App's ID, for anyone setting up many sites. Set the token or the App, not both." },
	{ name: 'GITHUB_APP_PRIVATE_KEY', need: 'with GITHUB_APP_ID', what: "The App's private key." },
	{ name: 'SITE_URL', need: 'required', what: "The site's public address, https://. The same value at build and at run time." },
	{ name: 'REDIS_URL', need: 'required', what: "The editor's drafts and sessions: redis:// or rediss:// (Upstash works, in the site's region)." },
	{ name: 'CARACMS_SECRET', need: 'required', what: "Signs the editors' sessions. A long random string." },
	{ name: 'CARACMS_CLIENT_IP_HEADER', need: 'required off Railway, Fly and Render', what: "Where the visitor's IP comes from: x-real-ip for nginx with `proxy_set_header X-Real-IP $remote_addr`, x-forwarded-for for Caddy, or socket if nothing sits in front of this server. `caracms start` won't start without it." },
	{ name: 'CARACMS_ALLOW', need: 'for email sign-in', what: 'Who may sign in, comma-separated: addresses (aoife@example.com) or whole domains (@example.com). The client adds their own people in Site Settings.' },
	{ name: 'RESEND_API_KEY', need: 'for email sign-in', what: 'Sends the sign-in links (and form notifications) through Resend.' },
	{ name: 'FORMS_FROM', need: 'for email sign-in', what: 'The address those emails come from, on a domain verified in Resend.' },
	{ name: 'CARACMS_BACKUP_USER', need: 'for the backup sign-in', what: "The backup sign-in, for when email sign-in links can't arrive. Both or neither." },
	{ name: 'CARACMS_BACKUP_PASSWORD', need: 'for the backup sign-in', what: "The backup sign-in's password." },
	{ name: 'CARACMS_RUNNING_COMMIT', need: 'optional', what: "The commit this server runs, where the host doesn't say (Railway and Render do)." },
	{ name: 'CARACMS_DEPLOY_HOOK_URL', need: 'optional', what: "Try again on a publish POSTs here to redeploy the site (the host's deploy hook)." },
	{ name: 'GITHUB_WEBHOOK_SECRET', need: 'optional', what: "For a webhook added in the repo's settings. Without it, a check once a minute does the same job." },
];

/** What the cloud key replaces in HOST_VARIABLES (M5 Contracts), and the key itself. */
const CLOUD_KEY_VARIABLE = { name: 'CARACMS_CLOUD_KEY', need: 'required', what: "The site's key from app.caracms.com (cck_…), labelled for this server. It brings the site's GitHub access, images, video, and forms and email." };

/** HOST_VARIABLES as init prints it: one table, name, whether it's needed, what it's for. On CaraCMS Cloud, the key in place of what it replaces. */
/** @param {string | null} [mode] the config's `services` */
export function hostVariablesText(mode = null) {
	const variables = mode === 'cloud' ? [CLOUD_KEY_VARIABLE, ...HOST_VARIABLES.filter((v) => !REPLACED_NAMES.includes(v.name) && v.name !== 'GITHUB_WEBHOOK_SECRET').map((v) => (v.name === 'CARACMS_ALLOW' ? { ...v, need: 'for email sign-in (sent by the cloud)' } : v))] : HOST_VARIABLES;
	const rows = [{ name: 'Name', need: 'Needed', what: "What it's for" }, ...variables];
	const w1 = Math.max(...rows.map((r) => r.name.length));
	const w2 = Math.max(...rows.map((r) => r.need.length));
	return [
		mode === 'cloud'
			? "The variables any host needs, on the site's server (`caracms start` runs it; one instance, behind HTTPS), on CaraCMS Cloud. Set email sign-in, the backup sign-in or both, or nobody can sign in. `caracms init --railway` writes a Railway setup instead."
			: "The variables any host needs, on the site's server (`caracms start` runs it; one instance, behind HTTPS). Set email sign-in, the backup sign-in or both, or nobody can sign in. Images, video and forms have their own variables: the caracms README's Hosting section lists them. `caracms init --railway` writes a Railway setup instead.",
		...rows.map((r) => `  ${r.name.padEnd(w1)}  ${r.need.padEnd(w2)}  ${r.what}`),
	].join('\n');
}

/** What init adds to a site's package.json (Decisions 7 and 11). */
export const VERSIONS = { node: '^11.1.7', railway: '^3.16.0' };

export const MARK_START = '<!-- caracms:start -->';
export const MARK_END = '<!-- caracms:end -->';
/** The URLs the package reserves (src/slug.ts → addressProblem). */
const RESERVED = ['/admin', '/_caracms', '/files'];
const ROUTE_EXTENSIONS = ['.astro', '.md', '.mdx', '.markdown', '.html', '.ts', '.js', '.mjs', '.mts'];
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'];
const ASTRO_CONFIGS = ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js', 'astro.config.cjs', 'astro.config.cts'];
/** The schema files the starting config makes (bin/templates/caracms.config.ts.txt). */
const STARTING_SCHEMAS = ['schemas/pages.schema.json', 'schemas/shared.schema.json', 'schemas/site-settings.schema.json'];
const SKILL_BLURBS = {
	'caracms-content': 'changing content: the JSON files in content/, rich text, images, references, Site Settings, and working on a branch',
	'caracms-blocks': 'building the site: blocks and their fields, collections, text styles, the page component, forms, and scripts beside the editor',
	'caracms-adopt': 'bringing the site\'s existing pages onto caracms, one page at a time, and checking they look the same',
	'caracms-tina': 'porting a site built on Tina (a Tina template site) onto caracms with the reference conversion script, re-runnable on newer content',
	'caracms-hosting': "where the site runs, CaraCMS Cloud or self-hosted: choosing the mode with `caracms init`, the server's host, moving a self-hosted site onto the cloud, and what to do about each of the cloud's refusals",
	'caracms-upgrade': 'moving the site onto a newer caracms release: the steps in order, and what each release breaks, needs run, shows and offers to adopt',
	'caracms-starlight': 'only for an Astro Starlight docs site: each page drawn in <StarlightPage>, the docs kit (sidebar, docs blocks, .md pages, llms.txt), heading ids, and the editor-preview traps',
};

const posix = (p) => p.split(sep).join('/');
const read = (path) => {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
};
const isDir = (path) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};
const lstat = (path) => {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
};
const titleCase = (name) => name.replace(/^@[^/]+\//, '').split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

function git(root, args) {
	try {
		return { ok: true, out: execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
	} catch {
		return { ok: false, out: '' };
	}
}

// ── Routes (the same reading as src/code-routes.ts, in plain JavaScript) ─────────

/** Every route file under src/pages (Astro's rules: `_` and `.` names skipped), with its URL and whether it has parameters. */
function pageRoutes(root, srcDir) {
	const pages = join(root, srcDir, 'pages');
	const out = [];
	const walk = (dir) => {
		let names = [];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (name.startsWith('_') || name.startsWith('.')) continue;
			const path = join(dir, name);
			if (isDir(path)) {
				walk(path);
				continue;
			}
			if (/\.d\.[mc]?ts$/.test(name)) continue;
			const ext = ROUTE_EXTENSIONS.find((e) => name.endsWith(e));
			if (!ext) continue;
			const parts = posix(relative(pages, path)).split('/');
			const base = parts.pop().slice(0, -ext.length);
			const segments = [...parts, ...(base === 'index' ? [] : [base])];
			const first = segments.findIndex((s) => s.includes('['));
			const file = posix(relative(root, path));
			if (first === -1) out.push({ file, url: `/${segments.join('/')}`, dynamic: false, rest: false });
			else out.push({ file, url: first ? `/${segments.slice(0, first).join('/')}/` : '/', dynamic: true, rest: /^\[\.\.\.[^\]]+\]$/.test(segments[first]) });
		}
	};
	walk(pages);
	return out;
}

/** Does `route` serve `url` or anything under it? */
function routeReaches(route, url) {
	const at = url.toLowerCase();
	const r = route.url.toLowerCase().replace(/\/$/, '') || '/';
	if (!route.dynamic) return r === at || r.startsWith(`${at}/`);
	// A catch-all at the top never takes the package's own routes: Astro ranks a rest parameter last.
	if (r === '/') return false;
	return r === at || r.startsWith(`${at}/`) || at.startsWith(`${r}/`);
}

// ── The site as found ───────────────────────────────────────────────────────────

function inspect(root) {
	const pkgText = read(join(root, 'package.json'));
	let pkg = null;
	try {
		pkg = pkgText === null ? null : JSON.parse(pkgText);
	} catch {
		pkg = undefined;
	}
	const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
	const configName = ASTRO_CONFIGS.find((n) => existsSync(join(root, n))) ?? null;
	const configText = configName ? read(join(root, configName)) : null;
	const srcDir = (configText && /\bsrcDir\s*:\s*(['"`])([^'"`]+)\1/.exec(configText)?.[2]) || 'src';
	const lock = existsSync(join(root, 'pnpm-lock.yaml'))
		? 'pnpm'
		: existsSync(join(root, 'package-lock.json'))
			? 'npm'
			: existsSync(join(root, 'yarn.lock'))
				? 'yarn'
				: existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))
					? 'bun'
					: (pkg?.packageManager?.split('@')[0] ?? 'npm');
	const caracmsConfigText = read(join(root, 'caracms.config.ts'));
	return { root, pkgText, pkg, deps, configName, configText, srcDir, pm: lock, setUp: caracmsConfigText !== null, caracmsConfigText };
}

function installedAstro(root) {
	try {
		return JSON.parse(readFileSync(createRequire(join(root, 'package.json')).resolve('astro/package.json'), 'utf8')).version;
	} catch {
		return null;
	}
}

const parseVersion = (v) => {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
	return m ? m.slice(1, 4).map(Number) : null;
};

/** Does `version` satisfy the package's peer range for Astro (a caret range: `^7.3.8`)? */
function inPeerRange(version, range) {
	const v = parseVersion(version);
	const r = parseVersion(range);
	if (!v || !r) return true;
	if (v[0] !== r[0]) return false;
	return v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2]);
}

/** The adapter astro.config uses: its import's module, or null for none. `unknown` when it can't be followed. */
function adapterOf(configText) {
	if (!configText) return null;
	const m = /\badapter\s*:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(configText);
	if (!m) return /\badapter\s*:/.test(configText) ? 'unknown' : null;
	const from = new RegExp(`import\\s+${m[1].replace(/\$/g, '\\$')}\\s+from\\s+['"]([^'"]+)['"]`).exec(configText);
	return from ? from[1] : 'unknown';
}

// ── Problems (Decisions 8 and 9) ────────────────────────────────────────────────

function problemsOf(site, write) {
	const { root } = site;
	const problems = [];
	const inGit = git(root, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true';
	if (!inGit) problems.push("This isn't a git repository: init only runs in one, so what it does is one reviewable diff. Run `git init` and commit the site first.");
	else if (write) {
		// Paths relative to the site's root (porcelain prints them from the repository's), so the `git add` line runs from here.
		const prefix = git(root, ['rev-parse', '--show-prefix']).out.trim();
		const dirty = git(root, ['status', '--porcelain', '--untracked-files=no', '--', '.'])
			.out.split('\n')
			.filter(Boolean)
			.map((l) => l.slice(3))
			.map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f));
		if (dirty.length && dirty.every((f) => f === 'package.json' || LOCKFILES.includes(f))) {
			// Installing caracms (the step before init) changes exactly these: the refusal stays (Decision 8), with the step.
			problems.push(`${dirty.join(' and ')} ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes, which installing caracms makes. Commit the install first, so init's change is one reviewable diff of its own: \`git add ${dirty.join(' ')} && git commit -m "Install caracms"\`, then run init again.`);
		} else if (dirty.length) problems.push(`There are uncommitted changes to tracked files (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}): commit or stash them first, so init's change is one reviewable diff.`);
	}
	if (site.pkg === null) {
		problems.push("There's no package.json here. Run init from the site's root.");
		return problems;
	}
	if (site.pkg === undefined) problems.push("package.json isn't valid JSON. Fix it, then run init again.");

	// Tina (Decision 9): named as one, by what's real (tinaOf).
	const tina = tinaOf(site, inGit).reasons;
	if (tina.length) problems.push(`This is a Tina site (${tina.join(' and ')}): Tina sites come in through a port, not \`init\`.`);

	const astroVersion = installedAstro(root);
	const peer = ownPackage.peerDependencies?.astro ?? '';
	if (!site.deps.astro && !astroVersion) problems.push("There's no Astro here (no astro in package.json): caracms adds to an existing Astro site. Run init from the site's root.");
	else {
		const version = astroVersion ?? site.deps.astro;
		if (!inPeerRange(version, peer)) problems.push(`Astro ${version} is outside the range caracms ${ownPackage.version} works with (${peer}). Move the site to an Astro in that range first.`);
	}

	const adapter = adapterOf(site.configText);
	if (adapter === 'unknown') problems.push(`${site.configName} sets an adapter init can't follow. caracms needs @astrojs/node in standalone mode: set \`adapter: node({ mode: 'standalone' })\` (import node from '@astrojs/node') by hand, then run init again.`);
	else if (adapter && adapter !== '@astrojs/node') problems.push(`${site.configName} uses the ${adapter} adapter. caracms runs on the Node adapter (@astrojs/node, standalone): move the site to it first.`);
	else if (adapter === '@astrojs/node' && /\bmode\s*:\s*['"]middleware['"]/.test(site.configText)) problems.push(`${site.configName} has the Node adapter in middleware mode. caracms's server (\`caracms start\`) needs standalone mode: change it to \`node({ mode: 'standalone' })\`.`);

	// content/ (Decision 9): caracms's own. A set-up site's is its documents.
	if (!site.setUp && isDir(join(root, 'content'))) {
		const files = listFiles(join(root, 'content')).map((f) => posix(relative(root, f)));
		if (files.length) problems.push(`content/ already holds files that aren't caracms's (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}). caracms keeps its content there: move them (Astro's own content collections can live in src/content/), then run init again.`);
	}

	const routes = pageRoutes(root, site.srcDir);
	for (const url of RESERVED) {
		for (const r of routes.filter((r) => routeReaches(r, url))) problems.push(`${r.file} serves ${r.dynamic ? `addresses under ${r.url.replace(/\/$/, '')}` : r.url}, which caracms reserves (${url} and everything under it). Move that page elsewhere.`);
		const inPublic = join(root, 'public', url.slice(1));
		if (existsSync(inPublic)) problems.push(`public${url} is at ${url}, which caracms reserves (${url} and everything under it). Move it elsewhere in public/.`);
	}
	for (const [url, why] of [
		['/sitemap.xml', 'caracms makes the sitemap from its documents (when SITE_URL is set)'],
		['/robots.txt', "caracms's server (`caracms start`) answers /robots.txt itself, before Astro and public/ (bin/gate.mjs), so this would never be reached"],
	]) {
		for (const r of routes.filter((r) => !r.dynamic && r.url === url)) problems.push(`${r.file} is the site's own ${url}, and ${why}. Delete it; to keep pages out of search, use SITE_URL and Site Settings.`);
		// A static file is the same address: the adapter serves public/ before Astro's routes (and robots.txt never gets that far).
		if (existsSync(join(root, 'public', url.slice(1)))) problems.push(`public${url} is the site's own ${url}, and ${why}. Delete it; to keep pages out of search, use SITE_URL and Site Settings.`);
	}
	if (!site.setUp) {
		// caracms's own catch-all counts as done only when it's the template, byte for byte (as health.ts is compared).
		const own = `${posix(site.srcDir)}/pages/[...path].astro`;
		const isOwn = (r) => r.file === own && read(join(root, own)) === template('catch-all.astro.txt');
		for (const r of routes.filter((r) => r.dynamic && r.url === '/' && !isOwn(r))) {
			if (r.file === own) problems.push(`${r.file} is the site's own: it isn't the page caracms adds at that path, and it catches addresses at the top of the site, where caracms's pages go. Move it under a folder of its own (src/pages/<folder>/), or delete it if caracms's documents replace it, then run init again.`);
			else problems.push(`${r.file} already catches addresses at the top of the site, where caracms's pages go. Rename it under a folder of its own (src/pages/<folder>/), then run init again.`);
		}
	}
	return problems;
}

/**
 * Is this a Tina site (Decision 9)? `tinacms` (or an `@tinacms/` package) in its dependencies,
 * or a tina/ folder holding tracked files. An adoption trial, item 1: a site stripped of Tina can keep an
 * untracked, git-ignored tina/__generated__/, which alone isn't a Tina site: `leftover` names
 * what's there, for a note. Outside git there's no telling, so a tina/ folder counts.
 */
function tinaOf(site, inGit = git(site.root, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true') {
	const reasons = [];
	let leftover = null;
	if (isDir(join(site.root, 'tina'))) {
		const tracked = inGit ? git(site.root, ['ls-files', '--', 'tina']).out.trim() !== '' : true;
		if (tracked) reasons.push('a tina/ folder with tracked files');
		else leftover = readdirSync(join(site.root, 'tina')).filter((n) => n !== '.DS_Store').sort().map((n) => `tina/${n}${isDir(join(site.root, 'tina', n)) ? '/' : ''}`);
	}
	if (Object.keys(site.deps).some((d) => d === 'tinacms' || d.startsWith('@tinacms/'))) reasons.push('tinacms in its dependencies');
	return { reasons, leftover };
}

function listFiles(dir) {
	const out = [];
	const walk = (d) => {
		for (const name of readdirSync(d).sort()) {
			if (name === '.DS_Store') continue;
			const p = join(d, name);
			if (isDir(p)) walk(p);
			else out.push(p);
		}
	};
	walk(dir);
	return out;
}

// ── Where the site runs (caracms-cloud M5) ──────────────────────────────────────

/** The config's `services` values, as the flags name them. */
export const MODES = ['cloud', 'self-hosted'];
/** Decision 5: a new site with no mode, no flag and no terminal to ask in. */
export const NO_MODE_PROBLEM =
	"Where will this site run? There's no terminal to ask in, so run init again with `--cloud` (CaraCMS Cloud) or `--self-hosted` (the site's own GitHub access, buckets and imgproxy).";
export const BOTH_MODES_PROBLEM = '`--cloud` and `--self-hosted` are the two places a site runs: give one of them.';
/** The CLAUDE.md block's and the report's line for the mode (Decision 8). */
export const MODE_LINES = {
	cloud: 'This site runs on CaraCMS Cloud: see the `caracms-hosting` skill.',
	'self-hosted': 'This site is self-hosted (its own GitHub access, buckets and imgproxy): see the `caracms-hosting` skill.',
	none: 'Mode not set: run `caracms init --cloud` or `--self-hosted`.',
};

/** The end of a string literal starting at `i` (its closing quote's index). */
function stringEnd(text, i) {
	const quote = text[i];
	for (let j = i + 1; j < text.length; j++) {
		if (text[j] === '\\') j++;
		else if (text[j] === quote) return j;
	}
	return text.length;
}

/**
 * The config's text with `services: '<mode>',` written (Decision 7): an existing `services`
 * property of the `defineSite({` object literal set to the string, or the property inserted
 * as the literal's first. `{ text }`, or `{ problem }` naming the line to add by hand when
 * the argument isn't an object literal or `services` is set from something else.
 * @returns {{ text?: string, problem?: string }}
 */
export function withServices(text, mode, file = 'caracms.config.ts') {
	const line = `services: '${mode}',`;
	const lineOf = (i) => text.slice(0, i).split('\n').length;
	const byHand = (where) => ({
		problem: `${file}: ${where}, so init can't write where the site runs. Add this line by hand, as the first inside \`defineSite({ … })\`, then run init again:\n      ${line}`,
	});
	const call = /\bdefineSite\s*\(\s*/.exec(text);
	if (!call) return byHand("there's no `defineSite(…)` call in it");
	const open = call.index + call[0].length;
	if (text[open] !== '{') return byHand(`what line ${lineOf(call.index)} passes to defineSite isn't an object literal ({ … })`);
	// The literal's top level: strings and comments skipped, brackets counted.
	let depth = 0;
	let found = -1;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === '"' || c === "'" || c === '`') {
			const end = stringEnd(text, i);
			if (depth === 1 && text.slice(i + 1, end) === 'services' && /^\s*:/.test(text.slice(end + 1))) {
				found = i;
				break;
			}
			i = end;
		} else if (c === '/' && text[i + 1] === '/') {
			const end = text.indexOf('\n', i);
			i = end === -1 ? text.length : end;
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 1;
		} else if ('{[('.includes(c)) depth++;
		else if ('}])'.includes(c)) {
			if (--depth === 0) break;
		} else if (depth === 1 && /[A-Za-z_$]/.test(c) && !/[\w$]/.test(text[i - 1] ?? '')) {
			const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))[0];
			if (word === 'services' && /^\s*:/.test(text.slice(i + word.length))) {
				found = i;
				break;
			}
			i += word.length - 1;
		}
	}
	if (found !== -1) {
		const m = /^(['"]?services['"]?\s*:\s*)(?:(['"])[^'"\n]*\2)?/.exec(text.slice(found));
		if (!m[2]) return byHand(`line ${lineOf(found)} sets services from something other than a string`);
		return { text: `${text.slice(0, found)}${m[1]}'${mode}'${text.slice(found + m[0].length)}` };
	}
	const rest = text.slice(open + 1);
	if (rest.startsWith('\n') || rest.startsWith('\r\n')) {
		const indent = /\n([ \t]*)\S/.exec(rest)?.[1] ?? '\t';
		return { text: `${text.slice(0, open + 1)}\n${indent}${line}${rest}` };
	}
	return { text: `${text.slice(0, open + 1)} ${line}${/^\s/.test(rest) ? '' : ' '}${rest}` };
}

/** The cloud's replaced variables, by group, for the move list (src/live/services.ts `REPLACED_VARIABLES`). */
const REPLACED_GROUPS = [
	['Images', OWN_MEDIA_NAMES],
	['Video', ['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET']],
	['Forms and email', ['SUBMISSIONS_S3_BUCKET', 'SUBMISSIONS_S3_ACCESS_KEY_ID', 'SUBMISSIONS_S3_SECRET_ACCESS_KEY', 'RESEND_API_KEY', 'FORMS_FROM']],
	['GitHub', ['CARACMS_GITHUB_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_REPO']],
];

/**
 * A self-hosted site's signs in the repo (Decision 9): each replaced variable found in
 * `.env` or `.railway/railway.ts` (name → where), and whether railway.ts declares buckets or imgproxy.
 */
export function selfHostedSigns(root) {
	const railwayText = read(join(root, '.railway/railway.ts'));
	const dotenv = parseDotenv(read(join(root, '.env')) ?? '');
	const found = new Map();
	for (const name of REPLACED_NAMES) {
		if (dotenv[name]?.trim()) found.set(name, '.env');
		else if (railwayText && new RegExp(`\\b${name}\\b`).test(railwayText)) found.set(name, '.railway/railway.ts');
	}
	const services = Boolean(railwayText && /\bbucket\s*\(|\bservice\(\s*["']imgproxy|ghcr\.io\/imgproxy/.test(railwayText));
	return { found, railway: railwayText !== null, services, any: found.size > 0 || services };
}

/** The move to the cloud, in the Contracts' order, only the steps that apply, each with its check (Decision 9). */
export function moveList(signs, { write }) {
	const has = (names) => names.some((n) => signs.found.has(n));
	const media = has(OWN_MEDIA_NAMES) || signs.services;
	const video = has(['MUX_TOKEN_ID', 'MUX_TOKEN_SECRET']);
	const steps = [];
	const step = (id, text, check) => steps.push({ id, text, check });
	step('setup', "Make the site and a key for it in app.caracms.com, and install the caracms GitHub App on this repo (only this one). Then open the site's page in app.caracms.com: the cloud refreshes the App's install state only when that page opens (or a repo is linked, or the site mints a token).", 'run `caracms init --cloud` again: it shows "App installed".');
	step('push', `Commit and push \`services: 'cloud'\` in caracms.config.ts${write ? '' : ' (after `caracms init --cloud --write`)'}.`, 'the host\'s build fails with "CARACMS_CLOUD_KEY isn\'t set" until the key is on the host. That\'s expected: the old deployment keeps serving.');
	if (media) step('images', "Copy the images into the site's cloud folder: `caracms media push`, with the old bucket's S3_* on its command line (or in .env) and the key in .env.", 'it reports failed: 0, and a second run skips everything.');
	step('key', 'Set CARACMS_CLOUD_KEY on the host. Leave the old variables there for now: they\'re ignored.', "the deploy's logs list them as ignored; an editor signs in; an upload lands in the cloud.");
	if (video) step('video', 'Upload each video clip again in the editor, and place it again.', 'no page plays a clip from the old Mux account.');
	const marked = REPLACED_GROUPS.map(([group, names]) => `       ${group}: ${names.map((n) => (signs.found.has(n) ? `${n} (* ${signs.found.get(n)})` : n)).join(', ')}`);
	step('remove', ['Remove every variable the cloud replaces from the host, one by one (* found in this repo):', ...marked].join('\n'), 'the next deploy logs no "ignored" lines.');
	const n = Object.fromEntries(steps.map((s, i) => [s.id, i + 1]));
	const after = ['key', 'video', 'remove'].filter((id) => n[id]).map((id) => n[id]);
	step(
		'retire',
		`Once ${after.length > 1 ? `${after[0]}–${after[after.length - 1]}` : after[0]} hold, retire what the cloud replaced: imgproxy; the media bucket; the GitHub token or App on this repo; Resend. Keep the submissions bucket until its old submissions are exported or no longer wanted (the cloud doesn't copy them)${video ? `, and the old Mux account until step ${n.video} is done` : ''}.`,
		null,
	);
	if (signs.railway) step('railway', 'Cut .railway/railway.ts down to the site and Redis: what `caracms init --cloud --railway` writes for a new site, keeping this site\'s names. init leaves the file alone: cut down any earlier, `railway config apply` would remove the buckets before the images are copied.', '`railway config plan` shows nothing to create or change.');
	return [
		"The move to CaraCMS Cloud, in order. init only sees this repo (.env and .railway/railway.ts): check the variables on the host's own page against the list in step " +
			`${n.remove} too.`,
		...steps.map((s, i) => `  ${i + 1}. ${s.text}${s.check ? `\n     Check: ${s.check}` : ''}`),
	].join('\n');
}

/** The way back from the cloud (Decision 12; the README's leaving notes). */
export const WAY_BACK = [
	"Leaving CaraCMS Cloud: the site's services are its own again.",
	"  1. Set them up as the caracms README's Hosting section says: GitHub access (a token or an App), a media bucket and imgproxy, a submissions bucket, Resend, and Mux for video.",
	"  2. Copy the site's folder in CaraCMS Cloud's media bucket to the new media bucket: the keys in content (uploads/…) stay the same. There's no export command yet: ask CaraCMS for a copy of the folder.",
	'  3. Set the variables on the host, deploy, and check the editor and an upload.',
	'  4. Remove CARACMS_CLOUD_KEY from the host (it\'s ignored now), then revoke the key in app.caracms.com.',
].join('\n');

/** A variable from the environment, else the site's `.env` (as `media import` reads it). */
function envOrDotenv(root, env) {
	const dotenv = parseDotenv(read(join(root, '.env')) ?? '');
	return (name) => {
		const v = env[name]?.trim();
		if (v) return { value: v, from: 'the environment' };
		const d = dotenv[name]?.trim();
		return d ? { value: d, from: '.env' } : null;
	};
}

/**
 * Decision 11: the key, when one can be found, checked against `GET /v1/settings`: the site,
 * its team, its repo and whether the App is installed on it, or the cloud's own sentence.
 * The key's value is never in what this returns.
 */
export async function keyCheck(root, { env = process.env, fetch: fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
	const get = envOrDotenv(root, env);
	const key = get('CARACMS_CLOUD_KEY');
	if (!key) return "CaraCMS Cloud key: none here (CARACMS_CLOUD_KEY in the environment or .env). Make one in app.caracms.com, a labelled key per laptop or environment, and put this laptop's in .env (never committed); then run `caracms init --cloud` again to check it.";
	const url = (get('CARACMS_CLOUD_URL')?.value ?? DEFAULT_CLOUD_URL).replace(/\/+$/, '');
	let res;
	let answer;
	try {
		res = await fetchImpl(`${url}/v1/settings`, { headers: { authorization: `Bearer ${key.value}`, accept: 'application/json', 'user-agent': 'caracms' }, signal: AbortSignal.timeout(timeoutMs) });
		answer = await res.json();
	} catch {
		return `CaraCMS Cloud key (from ${key.from}): CaraCMS Cloud couldn't be reached at ${url} to check it. Try again in a minute.`;
	}
	const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
	if (!res.ok) {
		const message = typeof obj(answer).message === 'string' && obj(answer).message.trim() ? obj(answer).message.trim() : `the cloud answered ${res.status}.`;
		return `CaraCMS Cloud key (from ${key.from}): refused. ${message}`;
	}
	const site = obj(obj(answer).site).name;
	const team = obj(obj(answer).team).name;
	const github = obj(obj(answer).github);
	const repo = typeof github.repo === 'string' && github.repo ? github.repo : null;
	const app = github.installed === true ? 'App installed' : github.installed === false ? "App not installed: install the caracms App on it from the site's page in app.caracms.com" : 'App not checked yet: the site\'s page in app.caracms.com checks it';
	return [
		`CaraCMS Cloud key (from ${key.from}):`,
		`  Site: ${typeof site === 'string' && site ? site : '(not named)'}`,
		`  Team: ${typeof team === 'string' && team ? team : '(this cloud doesn\'t say)'}`,
		`  Repo: ${repo ? `${repo} (${app})` : "none linked yet: link it on the site's page in app.caracms.com"}`,
	].join('\n');
}

/** Ask where the site runs (Decision 5), on a terminal. Null when there's no answer (the input closed). */
export async function askMode({ input = process.stdin, output = process.stdout } = {}) {
	const rl = createInterface({ input, output });
	try {
		for (;;) {
			let answer;
			try {
				answer = (await rl.question('Where will this site run?\n  1. CaraCMS Cloud\n  2. Self-hosted (its own GitHub access, buckets and imgproxy)\nChoose 1 or 2: ')).trim().toLowerCase();
			} catch {
				return null;
			}
			if (answer === '1' || answer === 'cloud' || answer === 'caracms cloud') return 'cloud';
			if (answer === '2' || answer === 'self-hosted' || answer === 'self hosted') return 'self-hosted';
		}
	} finally {
		rl.close();
	}
}

// ── The changes ─────────────────────────────────────────────────────────────────

/**
 * Everything init would do, as a list of changes ({ kind: 'add' | 'edit' |
 * 'remove' | 'unlink' | 'schemas', file, before?, after?, why?, skill? }), notes (printed, nothing written),
 * and what's already done.
 */
function changesOf(site, { railway = false, mode = null, field = null } = {}) {
	const { root } = site;
	const changes = [];
	const notes = [];
	const done = [];
	const add = (file, text, what) => {
		if (existsSync(join(root, file))) done.push(what ?? file);
		else changes.push({ kind: 'add', file, after: text });
	};
	const edit = (file, before, after, what) => {
		if (after === before) done.push(what ?? file);
		else changes.push({ kind: before === null ? 'add' : 'edit', file, before, after });
	};

	// package.json: @astrojs/node, `start`, and railway when its file is made (only with --railway).
	const railwayFile = '.railway/railway.ts';
	const hasRailway = existsSync(join(root, railwayFile));
	const makeRailway = railway && !hasRailway;
	{
		const pkg = structuredClone(site.pkg);
		pkg.dependencies ??= {};
		if (!site.deps['@astrojs/node']) pkg.dependencies = withKey(pkg.dependencies, '@astrojs/node', VERSIONS.node);
		// Decision 3: a site pins the exact version. An existing entry (on the trial, the tarball) is left alone.
		if (!site.deps.caracms) pkg.dependencies = withKey(pkg.dependencies, 'caracms', ownPackage.version);
		if (makeRailway && !site.deps.railway) pkg.devDependencies = withKey(pkg.devDependencies ?? {}, 'railway', VERSIONS.railway);
		pkg.scripts = { ...(pkg.scripts ?? {}) };
		pkg.scripts.start = 'caracms start';
		if (Object.keys(pkg.dependencies).length === 0 && !site.pkg.dependencies) delete pkg.dependencies;
		edit('package.json', site.pkgText, jsonText(pkg, site.pkgText), 'package.json (@astrojs/node, `start`)');
	}

	// astro.config: the adapter, the integration, no dev toolbar.
	{
		const result = astroConfigEdit(site);
		if (result.edit) edit(result.file, site.configText, result.edit, `${result.file} (adapter, integration)`);
		else if (result.done) done.push(`${result.file} (adapter, integration)`);
		else notes.push(result.note);
	}

	// The config: a new site's from the template, with where it runs (M5 Decision 7); a set-up site's
	// field written when the mode is new or moves (plan() has checked withServices can).
	if (!site.setUp) add('caracms.config.ts', mode ? withServices(template('caracms.config.ts.txt'), mode).text : template('caracms.config.ts.txt'));
	else if (mode && mode !== field) edit('caracms.config.ts', site.caracmsConfigText, withServices(site.caracmsConfigText, mode).text);
	else if (mode) done.push(`caracms.config.ts (services: '${mode}')`);
	// The starting page component and block, for a new site only: a set-up site's config names its own,
	// and may have deleted these (one port did; 0.9.0's init added TextBlock.astro back).
	if (!site.setUp) {
		add('src/components/caracms/Page.astro', template('Page.astro.txt'));
		add('src/components/caracms/TextBlock.astro', template('TextBlock.astro.txt'));
	}
	add(`${posix(site.srcDir)}/pages/[...path].astro`, template('catch-all.astro.txt'));
	const health = pageRoutes(root, site.srcDir).find((r) => !r.dynamic && r.url === '/health');
	const healthFile = `${posix(site.srcDir)}/pages/health.ts`;
	if (!health) changes.push({ kind: 'add', file: healthFile, after: template('health.ts.txt') });
	else if (health.file === healthFile && read(join(root, healthFile)) === template('health.ts.txt')) done.push(healthFile);
	else notes.push(`The site already has a /health route (${health.file}), so init leaves it alone. Hosts' healthchecks (Railway's, for one) ask /health for a 200.`);

	{
		const name = titleCase(site.pkg.name ?? basename(root)) || 'Site';
		const settings = { $schema: '../schemas/site-settings.schema.json', title: 'Site Settings', editors: [], brand: { name } };
		add('content/site-settings.json', `${JSON.stringify(settings, null, 2)}\n`);
	}

	{
		const before = read(join(root, '.gitignore'));
		const has = before !== null && before.split('\n').some((l) => /^\/?\.caracms\/?$/.test(l.trim()));
		const lines = "# caracms's working files\n.caracms/\n";
		const after = has ? before : before === null || before === '' ? lines : `${before}${before.endsWith('\n') ? '' : '\n'}\n${lines}`;
		edit('.gitignore', before, after, '.gitignore (.caracms/)');
	}

	{
		const before = read(join(root, 'tsconfig.json'));
		const after = tsconfigEdit(before);
		if (after === undefined) notes.push('tsconfig.json: init couldn\'t follow it. Add `"allowImportingTsExtensions": true` to its compilerOptions by hand (caracms.config.ts imports .ts files by name).');
		else edit('tsconfig.json', before, after, 'tsconfig.json (allowImportingTsExtensions)');
	}

	// Railway (Decision 11): with --railway, or the site's existing file. Otherwise no host file
	// and report() prints HOST_VARIABLES (runs-anywhere Decision 12).
	if (!railway && !hasRailway) {
		// nothing to write
	} else if (makeRailway) {
		const remote = git(root, ['remote', 'get-url', 'origin']).out.trim();
		const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote)?.[1] ?? null;
		const repoName = basename(git(root, ['rev-parse', '--show-toplevel']).out.trim() || root);
		const run = site.pm === 'npm' ? 'npm run' : site.pm;
		// M5 Decision 10: on the cloud, the site and Redis only.
		const text = template(mode === 'cloud' ? 'railway-cloud.ts.txt' : 'railway.ts.txt')
			.replaceAll('{{SITE}}', repoName)
			.replaceAll('{{GITHUB_REPO}}', repo ?? 'OWNER/REPO')
			.replaceAll('{{BUILD}}', `${run} build`)
			.replaceAll('{{START}}', `${site.pm} start`);
		changes.push({ kind: 'add', file: railwayFile, after: text });
		if (!repo) notes.push(`${railwayFile}: the git remote isn't on GitHub, so GITHUB_REPO is "OWNER/REPO". Set it to the site's repository.`);
	} else if (!read(join(root, railwayFile))?.includes('(written by `caracms init` from the')) {
		// One init wrote is set up; a site's own (every Tina site has one) gets caracms's needs printed.
		notes.push(railwayNeeds(railwayFile, mode));
	} else done.push(railwayFile);

	// Skills (Decision 12; copies since 0.9.0, skills.mjs).
	const skills = skillNames();
	{
		const s = skillsPlan(root);
		changes.push(...s.changes);
		notes.push(...s.notes);
		done.push(...s.done);
	}

	// The CLAUDE.md block (Decision 12): into the link's target when CLAUDE.md is a link.
	{
		const link = lstat(join(root, 'CLAUDE.md'))?.isSymbolicLink() ? readlinkSync(join(root, 'CLAUDE.md')) : null;
		const file = link ? posix(relative(root, resolve(root, link))) : 'CLAUDE.md';
		const before = read(join(root, file));
		const block = claudeBlock(skills, mode);
		const after = withBlock(before, block);
		if (after === null) notes.push(`${file} has a ${MARK_START} line with no ${MARK_END} after it, so init can't tell where its block ends and leaves the file alone. Replace the old block with this one by hand, then run init again:\n${block.split('\n').map((l) => `    ${l}`).join('\n')}`);
		else edit(file, before, after, `${file} (the caracms block)`);
	}
	// pnpm 12.11+ asked to approve the skills caracms shipped before 0.9.0; approving wrote `permissions:
	// caracms: skills: true`, which fails an install that runs before the repo is copied in (Railway's,
	// 2026-10-28). The package no longer ships skills pnpm links, so it's taken back out.
	{
		const before = read(join(root, 'pnpm-workspace.yaml'));
		const after = before === null ? null : withoutSkillsApproval(before);
		if (after === undefined) notes.push(`pnpm-workspace.yaml approves caracms's agent skills in a shape init can't edit. Take the approval out by hand (the \`skills: true\` under \`permissions:\` → \`caracms:\`): it fails an install that runs before the repo is copied in, Railway's for one, and init copies the skills in itself.`);
		else if (after !== null && after !== before) {
			changes.push({ kind: 'edit', file: 'pnpm-workspace.yaml', before, after });
			notes.push(`pnpm-workspace.yaml approved caracms's agent skills (\`pnpm approve\`), so init takes that out: the approval fails an install that runs before the repo is copied in, Railway's for one, and init copies the skills in itself. pnpm won't ask about caracms again.`);
		}
	}
	// An adoption trial, item 1: what Tina left behind, untracked (tinaOf).
	const { leftover } = tinaOf(site);
	if (leftover) notes.push(`${leftover.length ? leftover.join(', ') : 'tina/'} ${leftover.length > 1 ? 'are' : 'is'} left over from Tina (nothing under tina/ is tracked): delete ${leftover.length > 1 ? 'them' : 'it'}.`);
	return { changes, notes, done, hostVariables: !railway && !hasRailway };
}

/**
 * pnpm-workspace.yaml's text without the approval of caracms's agent skills (`permissions:` →
 * `caracms:` → `skills: true`), emptied parents and all; the same text when there's none.
 * Undefined when there is one in a shape these lines can't follow (a flow mapping, say).
 */
export function withoutSkillsApproval(text) {
	const lines = text.split('\n');
	const indent = (l) => /^ */.exec(l)[0].length;
	const blank = (l) => /^\s*(#.*)?$/.test(l);
	// The lines under `lines[at]`: everything indented deeper, up to the next line that isn't.
	const childrenOf = (at) => {
		const out = [];
		for (let i = at + 1; i < lines.length; i++) {
			if (blank(lines[i])) continue;
			if (indent(lines[i]) <= indent(lines[at])) break;
			out.push(i);
		}
		return out;
	};
	const top = lines.findIndex((l) => /^permissions:\s*(#.*)?$/.test(l));
	if (top === -1) return /^permissions:/m.test(text) && /caracms/.test(text) ? undefined : text;
	const under = childrenOf(top);
	const pkg = under.find((i) => /^\s+(['"]?)caracms\1:/.test(lines[i]));
	if (pkg === undefined) return text;
	const rest = lines[pkg].replace(/^\s+(['"]?)caracms\1:/, '').replace(/#.*$/, '').trim();
	if (rest) return /skills\s*:\s*true/.test(rest) ? undefined : text;
	const own = childrenOf(pkg);
	const skills = own.find((i) => /^\s+skills:\s*true\s*(#.*)?$/.test(lines[i]));
	if (skills === undefined) return /skills\s*:\s*true/.test(own.map((i) => lines[i]).join('\n')) ? undefined : text;
	const drop = new Set([skills]);
	if (own.length === 1) drop.add(pkg);
	if (own.length === 1 && under.every((i) => i === pkg || own.includes(i))) drop.add(top);
	return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/** `object` with `key` added, in alphabetical order when the object already is. */
function withKey(object, key, value) {
	if (Object.hasOwn(object, key)) return object;
	const keys = Object.keys(object);
	const sorted = keys.every((k, i) => i === 0 || keys[i - 1].localeCompare(k) <= 0);
	const entries = [...Object.entries(object), [key, value]];
	if (sorted) entries.sort(([a], [b]) => a.localeCompare(b));
	return Object.fromEntries(entries);
}

/** JSON in the file's own indentation, with its trailing newline. */
function jsonText(value, like) {
	const indent = /\n([ \t]+)"/.exec(like ?? '')?.[1] ?? '  ';
	return `${JSON.stringify(value, null, indent)}${like?.endsWith('\n') === false ? '' : '\n'}`;
}

/** tsconfig.json's text with `allowImportingTsExtensions`, or undefined when it can't be followed. */
function tsconfigEdit(text) {
	if (text === null) return `{\n  "extends": "astro/tsconfigs/base",\n  "compilerOptions": {\n    "allowImportingTsExtensions": true\n  }\n}\n`;
	if (/"allowImportingTsExtensions"\s*:\s*true/.test(text)) return text;
	if (/"allowImportingTsExtensions"/.test(text)) return undefined;
	const options = /"compilerOptions"\s*:\s*\{/.exec(text);
	const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
	if (options) {
		const at = options.index + options[0].length;
		const empty = /^\s*\}/.test(text.slice(at));
		return `${text.slice(0, at)}\n${indent}${indent}"allowImportingTsExtensions": true${empty ? `\n${indent}` : ','}${empty ? text.slice(at).replace(/^\s*/, '') : text.slice(at)}`;
	}
	const end = text.lastIndexOf('}');
	if (end === -1) return undefined;
	const body = text.slice(0, end).replace(/\s*$/, '');
	const comma = body.endsWith('{') ? '' : ',';
	return `${body}${comma}\n${indent}"compilerOptions": {\n${indent}${indent}"allowImportingTsExtensions": true\n${indent}}\n${text.slice(end)}`;
}

const INTEGRATION_LINES = (indent, { adapter, integrations, toolbar }) =>
	[
		adapter ? `${indent}// caracms: pages stay prerendered; the Node server adds the editor (caracms start).\n${indent}adapter: node({ mode: 'standalone' }),` : null,
		integrations ? `${indent}// caracms reads caracms.config.ts: collections, blocks, text styles and the page component.\n${indent}integrations: [caracms(site)],` : null,
		toolbar ? `${indent}// Astro's dev toolbar would fight the editor's preview.\n${indent}devToolbar: { enabled: false },` : null,
	].filter(Boolean);

/** astro.config's new text: `{ file, edit }`, `{ file, done: true }`, or `{ file, note }` (lines to add by hand). */
function astroConfigEdit(site) {
	const file = site.configName ?? 'astro.config.mjs';
	const imports = ["import node from '@astrojs/node';", "import caracms from 'caracms';", "import site from './caracms.config.ts';"];
	const text = site.configText;
	if (text === null) {
		const body = INTEGRATION_LINES('\t', { adapter: true, integrations: true, toolbar: true }).join('\n');
		return { file, edit: `// @ts-check\nimport { defineConfig } from 'astro/config';\n${imports.join('\n')}\n\nexport default defineConfig({\n${body}\n});\n` };
	}
	if (/\bcaracms\s*\(/.test(text)) return { file, done: true };
	const hasAdapter = adapterOf(text) !== null;
	const hasToolbar = /\bdevToolbar\s*:/.test(text);
	const hasIntegrations = /\bintegrations\s*:/.test(text);
	const needed = imports.filter((line, i) => !(i === 0 && hasAdapter));
	const byHand = (why) => {
		const lines = [...needed, ...INTEGRATION_LINES('  ', { adapter: !hasAdapter, integrations: !hasIntegrations, toolbar: !hasToolbar }).map((l) => l.trimStart())];
		if (hasIntegrations) lines.push('caracms(site) in its integrations: [ … ]');
		return { file, note: `${file}: ${why}, so init leaves it alone. Add these by hand, then run init again:\n${lines.map((l) => `    ${l}`).join('\n')}` };
	};
	const open = /defineConfig\(\s*\{/.exec(text);
	if (!open) return byHand("it doesn't export `defineConfig({ … })`");
	const integrationsArray = hasIntegrations ? /\bintegrations\s*:\s*\[/.exec(text) : null;
	if (hasIntegrations && !integrationsArray) return byHand('its integrations aren\'t a plain list');

	let out = text;
	// The integration first (later offsets move), then the keys after `defineConfig({`, then the imports.
	if (integrationsArray) {
		const at = integrationsArray.index + integrationsArray[0].length;
		const empty = /^\s*\]/.test(out.slice(at));
		out = `${out.slice(0, at)}caracms(site)${empty ? '' : ', '}${out.slice(at)}`;
	}
	const openAt = open.index + open[0].length;
	const nextLine = /\n([ \t]*)\S/.exec(out.slice(openAt));
	const indent = nextLine?.[1] || '  ';
	const lines = INTEGRATION_LINES(indent, { adapter: !hasAdapter, integrations: !hasIntegrations, toolbar: !hasToolbar });
	if (lines.length) out = `${out.slice(0, openAt)}\n${lines.join('\n')}${out.slice(openAt)}`;

	const importRe = /^import\s(?:[^;'"]*?\sfrom\s*)?['"][^'"]+['"];?[ \t]*$/gm;
	let lastImportEnd = -1;
	for (let m; (m = importRe.exec(out)); ) lastImportEnd = m.index + m[0].length;
	const importText = needed.join('\n');
	if (lastImportEnd >= 0) out = `${out.slice(0, lastImportEnd)}\n${importText}${out.slice(lastImportEnd)}`;
	else {
		const check = /^\/\/ @ts-check[ \t]*\n/.exec(out);
		const at = check ? check[0].length : 0;
		out = `${out.slice(0, at)}${importText}\n${out.slice(at)}`;
	}
	return { file, edit: out };
}

function railwayNeeds(file, mode = null) {
	if (mode === 'cloud') {
		return [
			`${file} exists, so init doesn't edit it (every Tina site has one). On CaraCMS Cloud, the project needs only these:`,
			'    Redis: the editor\'s drafts and sessions. The site gets REDIS_URL.',
			'    The site: NODE_ENV=production, SITE_URL (its public address), start command `caracms start`, healthcheck /health; set by hand: CARACMS_CLOUD_KEY, CARACMS_SECRET, CARACMS_ALLOW, CARACMS_BACKUP_USER, CARACMS_BACKUP_PASSWORD, CARACMS_RAILWAY_TOKEN.',
			'    The whole of it, as init writes it for a new cloud site: node_modules/caracms/bin/templates/railway-cloud.ts.txt.',
		].join('\n');
	}
	return [
		`${file} exists, so init doesn't edit it (every Tina site has one). Add what caracms needs to it by hand:`,
		'    Redis: the editor\'s drafts and sessions. The site gets REDIS_URL.',
		'    A media bucket: uploaded images. The site gets S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
		'    A submissions bucket: form submissions, apart from the media imgproxy can read. The site gets SUBMISSIONS_S3_BUCKET, SUBMISSIONS_S3_ACCESS_KEY_ID and SUBMISSIONS_S3_SECRET_ACCESS_KEY.',
		'    imgproxy (ghcr.io/imgproxy/imgproxy), reading only the media bucket: it serves the images, signed. The site gets CARACMS_MEDIA_URL (imgproxy\'s public address), IMGPROXY_KEY and IMGPROXY_SALT (the same as imgproxy\'s).',
		'    The site: NODE_ENV=production, SITE_URL (its public address), GITHUB_REPO (owner/name), start command `caracms start`, healthcheck /health; set by hand: CARACMS_GITHUB_TOKEN (a fine-grained token on that one repo; or, instead, the App: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY), GITHUB_WEBHOOK_SECRET, CARACMS_SECRET, CARACMS_ALLOW, CARACMS_BACKUP_USER, CARACMS_BACKUP_PASSWORD, CARACMS_RAILWAY_TOKEN, MUX_TOKEN_ID, MUX_TOKEN_SECRET, RESEND_API_KEY, FORMS_FROM.',
		'    The whole of it, as caracms\'s starter writes it: node_modules/caracms/bin/templates/railway.ts.txt.',
	].join('\n');
}

/**
 * @param {string[]} skills
 * @param {string | null} [mode] the config's `services`; null: not set
 */
export function claudeBlock(skills, mode = null) {
	const lines = [
		MARK_START,
		'## caracms',
		'',
		MODE_LINES[mode ?? 'none'],
		'',
		"This site's content is edited with caracms (the `caracms` package). Its skills are copied from the installed package into `.claude/skills/` by `caracms init`, which brings them up to date after an upgrade (`astro dev` and `caracms validate` say when they're behind):",
		'',
		...skills.map((name) => `- \`${name}\`${SKILL_BLURBS[name] ? `: ${SKILL_BLURBS[name]}.` : ''}`),
		...(skills.length ? [''] : []),
		'Run `caracms validate` before a pull request.',
		MARK_END,
	];
	return lines.join('\n');
}

/**
 * The file's text with the block between the markers replaced, or appended. Nothing outside the markers changes.
 * Null when there's a start marker with no end marker after it: where the old block ends can't be told, so it isn't safe to edit.
 */
export function withBlock(text, block) {
	if (text === null || text === '') return `${block}\n`;
	const start = text.indexOf(MARK_START);
	const end = start === -1 ? -1 : text.indexOf(MARK_END, start);
	if (start !== -1 && end === -1) return null;
	if (start !== -1) return text.slice(0, start) + block + text.slice(end + MARK_END.length);
	return `${text.replace(/\n*$/, '')}\n\n${block}\n`;
}

// ── Output ──────────────────────────────────────────────────────────────────────

/** A unified diff of two texts, three lines of context. */
export function diff(file, before, after) {
	const a = before === null ? [] : before.replace(/\n$/, '').split('\n');
	const b = after.replace(/\n$/, '').split('\n');
	// The longest common subsequence, by a table (config files are small).
	const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) ops.push([' ', a[i++], j++]);
		else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(['-', a[i++]]);
		else ops.push(['+', b[j++]]);
	}
	const out = [`--- ${before === null ? '/dev/null' : `a/${file}`}`, `+++ b/${file}`];
	const changed = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter((k) => k >= 0);
	let k = 0;
	while (k < changed.length) {
		let from = Math.max(0, changed[k] - 3);
		let to = Math.min(ops.length, changed[k] + 4);
		while (k + 1 < changed.length && changed[k + 1] - 3 <= to) to = Math.min(ops.length, changed[++k] + 4);
		k++;
		const hunk = ops.slice(from, to);
		const aStart = ops.slice(0, from).filter((o) => o[0] !== '+').length + 1;
		const bStart = ops.slice(0, from).filter((o) => o[0] !== '-').length + 1;
		const aLen = hunk.filter((o) => o[0] !== '+').length;
		const bLen = hunk.filter((o) => o[0] !== '-').length;
		out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
		for (const o of hunk) out.push(`${o[0]}${o[1]}`);
	}
	return out.join('\n');
}

function describe(change) {
	switch (change.kind) {
		case 'add':
			return `  add     ${change.file}`;
		case 'edit':
			return `  edit    ${change.file}`;
		case 'remove':
			return `  remove  ${change.file} (${change.why})`;
		case 'unlink':
			return `  unlink  ${change.file} (${change.why})`;
		case 'schemas':
			return `  ${change.before === null ? 'add   ' : change.after === null ? 'remove' : 'edit  '}  ${change.file}${change.generated ? ' (generated: caracms schemas)' : ''}`;
	}
}

function report({ changes, notes, done, hostVariables, mode, where, site }, { write, pm }) {
	const setUp = site.setUp;
	const parts = [];
	if (changes.length === 0) {
		parts.push('caracms init: nothing to do. caracms is set up here.');
	} else {
		parts.push(write ? 'caracms init: done. It changed:' : 'caracms init: the change it would make. Nothing is written: `caracms init --write` applies exactly this.');
		parts.push(changes.map(describe).join('\n'));
		if (!write) {
			const diffs = changes.filter((c) => (((c.kind === 'add' || c.kind === 'edit') && !c.skill) || (c.kind === 'schemas' && !c.generated && c.after !== null)));
			if (diffs.length) parts.push(diffs.map((c) => diff(c.file, c.before ?? null, c.after)).join('\n\n'));
		}
	}
	if (done.length && changes.length) parts.push(`Already done: ${done.join('; ')}.`);
	if (notes.length) parts.push(`Notes:\n${notes.map((n) => `  - ${n}`).join('\n')}`);
	// M5: where the site runs, the key's check, and the move or the way back.
	parts.push(...where);
	if (hostVariables) parts.push(hostVariablesText(mode));
	if (changes.length && setUp) {
		parts.push(write ? 'Next: commit this as one change.' : 'Then, after --write: commit it as one change.');
	} else if (changes.length) {
		const install = `${pm} install`;
		parts.push(
			write
				? `Next: \`${install}\` (it adds @astrojs/node), commit this as one change, then follow the caracms-adopt skill to bring the pages in.`
				: `Then, after --write: \`${install}\`, and the caracms-adopt skill.`,
		);
	}
	return `${parts.join('\n\n')}\n`;
}

// ── Schemas ─────────────────────────────────────────────────────────────────────

/**
 * The schema and `$schema` changes, and the config's `services` (M5 Decision 7), from the
 * site's config through its Vite, in one load. A fresh site's are the starting config's, and no field.
 */
async function schemaChanges(site) {
	if (!site.setUp) return { schemas: STARTING_SCHEMAS.map((file) => ({ kind: 'schemas', file, before: null, after: '', generated: true })), services: null };
	const { withPackageModule } = await import('./site-runner.mjs');
	return withPackageModule(site.root, 'schemas', async (m) => {
		const loaded = await m.loadSite(site.root);
		const files = m.schemaFileChanges(loaded).map((c) => ({ kind: 'schemas', file: c.file, before: c.before, after: c.text, generated: true }));
		const stamps = (await m.stampChanges(loaded)).map((c) => ({ kind: 'schemas', file: c.file, before: c.before, after: c.text }));
		return { schemas: [...files, ...stamps], services: loaded.services ?? null };
	});
}

// ── The command ─────────────────────────────────────────────────────────────────

/**
 * The plan: problems (nothing happens when there are any), or the changes. `mode` is the
 * flag's (`'cloud'`, `'self-hosted'`, `'both'` for both flags, or null); `choose()` asks a
 * person where the site runs, only called with no flag and no field (Decision 5).
 * @param {string} root
 * @param {{ write?: boolean, railway?: boolean, mode?: string | null, choose?: (() => Promise<string | null>) | null }} [options]
 */
export async function plan(root, { write = false, railway = false, mode: flag = null, choose = null } = {}) {
	const site = inspect(root);
	/** @param {string[]} problems */
	const nothing = (problems) => ({ site, problems, changes: /** @type {any[]} */ ([]), notes: /** @type {string[]} */ ([]), done: /** @type {string[]} */ ([]), hostVariables: false, mode: null, field: null, where: /** @type {string[]} */ ([]), checkKey: false });
	const problems = problemsOf(site, write);
	if (flag === 'both') problems.push(BOTH_MODES_PROBLEM);
	if (problems.length) return nothing(problems);
	let loaded;
	try {
		loaded = await schemaChanges(site);
	} catch (error) {
		return nothing([`The schemas couldn't be made from caracms.config.ts: ${error.message}`]);
	}
	// M5 Decisions 5–6: the flag, else the field, else a person's answer.
	const field = loaded.services;
	let mode = flag ?? field;
	let asked = false;
	if (!mode && choose) {
		mode = await choose();
		asked = Boolean(mode);
	}
	if (!mode && !site.setUp) return nothing([NO_MODE_PROBLEM]);
	if (mode && mode !== field && site.setUp) {
		const edited = withServices(site.caracmsConfigText, mode);
		if (edited.problem) return nothing([edited.problem]);
	}
	const { changes, notes, done, hostVariables } = changesOf(site, { railway, mode, field });
	changes.push(...loaded.schemas);

	const where = [MODE_LINES[mode ?? 'none']];
	// Decision 9: --cloud on a self-hosted site (or one with no field) with self-hosted signs is the move.
	if (mode === 'cloud' && field !== 'cloud') {
		const signs = selfHostedSigns(root);
		if (signs.any) where.push(moveList(signs, { write }));
	}
	// Decision 12: --self-hosted on a cloud site, the way back.
	if (mode === 'self-hosted' && field === 'cloud') where.push(WAY_BACK);
	return { site, problems, changes, notes, done, hostVariables, mode, field, where, checkKey: mode === 'cloud' && (flag === 'cloud' || asked) };
}

function apply(root, changes) {
	for (const c of changes) {
		const path = join(root, c.file);
		switch (c.kind) {
			case 'add':
			case 'edit':
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, c.after);
				break;
			case 'remove':
			case 'unlink':
				rmSync(path, { force: true });
				// A skill folder left empty goes too (skills.mjs: a skill the package no longer has).
				for (let dir = dirname(path); c.kind === 'remove' && dir.startsWith(join(root, '.claude/skills/')) && readdirSync(dir).length === 0; dir = dirname(dir)) rmSync(dir, { recursive: true });
				break;
			// 'schemas' is written by the schemas command, after everything else.
		}
	}
}

/**
 * `caracms init [--write] [--railway] [--cloud | --self-hosted]`, from `root`. Returns the exit code; prints to `out` and `err` (stdout and stderr).
 * `cloud` and `selfHosted` are the flags. `ask` is how a person is asked where the site runs: by default only when stdin and stdout
 * are both a terminal (Decision 5), never otherwise. `env` and `fetch` are the key check's (Decision 11).
 * @param {{ root: string, write?: boolean, railway?: boolean, cloud?: boolean, selfHosted?: boolean, ask?: (() => Promise<string | null>) | null, env?: Record<string, string | undefined>, fetch?: typeof fetch, out?: { write(text: string): unknown }, err?: { write(text: string): unknown } }} options
 */
export async function run({ root, write = false, railway = false, cloud = false, selfHosted = false, ask, env = process.env, fetch: fetchImpl = fetch, out = process.stdout, err = process.stderr }) {
	const flag = cloud && selfHosted ? 'both' : cloud ? 'cloud' : selfHosted ? 'self-hosted' : null;
	const choose = ask !== undefined ? ask : process.stdin.isTTY && process.stdout.isTTY ? () => askMode() : null;
	const p = await plan(root, { write, railway, mode: flag, choose });
	if (p.problems.length) {
		err.write(`caracms init: ${p.problems.length === 1 ? 'one thing is' : `${p.problems.length} things are`} in the way, so nothing was ${write ? 'written' : 'planned'}:\n${p.problems.map((x) => `  - ${x}`).join('\n')}\n`);
		return 1;
	}
	if (write && p.changes.length) {
		apply(root, p.changes);
		if (p.changes.some((c) => c.kind === 'schemas')) {
			try {
				const { withPackageModule } = await import('./site-runner.mjs');
				await withPackageModule(root, 'schemas', (m) => m.command(root));
			} catch (error) {
				err.write(`caracms init: the files are written, but the schemas couldn't be: ${error.message}\nFix that, then run \`caracms schemas\`.\n`);
				return 1;
			}
		}
	}
	// Decision 11: the key, checked after anything is written (it reads only), never printed.
	if (p.checkKey) p.where.splice(1, 0, await keyCheck(root, { env, fetch: fetchImpl }));
	out.write(report(p, { write, pm: p.site.pm }));
	return 0;
}
