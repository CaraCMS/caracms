// The skills caracms puts in a site: the package's `site-skills/<name>/` folders, copied into the
// site's `.claude/skills/<name>/` by `caracms init`, with a stamp of what was copied
// (`.claude/skills/.caracms.json`: each file's hash). Copies, not links (0.9.0): pnpm 12.11+ asks
// to approve any package that ships `skills/<name>/SKILL.md`, and an approval fails an install
// that runs before the repo is copied in (Railway's). So the package keeps them in `site-skills/`,
// which pnpm doesn't look in, and a site's copies work on a fresh clone with nothing installed.
//
// The stamp is how init tells a copy it may refresh from one someone edited: a file whose hash
// is still the stamp's is caracms's, and is brought up to date; one that isn't is left alone,
// with a note. `astro dev` and `caracms validate` say when the copies are behind (skillsWarning).
//
// Plain JavaScript importing only Node built-ins: init.mjs, validate and the integration share it.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const source = join(packageRoot, 'site-skills');
export const SKILLS_DIR = '.claude/skills';
export const STAMP = `${SKILLS_DIR}/.caracms.json`;
/** Where 0.8 and earlier linked a site's skills to. */
export const OLD_LINK_BASE = '../../node_modules/caracms/skills/';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const lstat = (path) => lstatSync(path, { throwIfNoEntry: false }) ?? null;
const read = (path) => {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
};

/** The package's skills: its `site-skills/<name>/` folders. */
export function skillNames() {
	if (!lstat(source)?.isDirectory()) return [];
	return readdirSync(source, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
		.map((d) => d.name)
		.sort();
}

/** The files under `dir`, as `/`-separated paths relative to it, sorted. */
function filesUnder(dir, prefix = '') {
	const out = [];
	for (const d of readdirSync(dir, { withFileTypes: true })) {
		if (d.name.startsWith('.')) continue;
		const rel = `${prefix}${d.name}`;
		if (d.isDirectory()) out.push(...filesUnder(join(dir, d.name), `${rel}/`));
		else if (d.isFile()) out.push(rel);
	}
	return out.sort();
}

/** The package's skill files: `<name>/<file>` → text. */
function packageFiles() {
	const out = new Map();
	for (const name of skillNames()) for (const file of filesUnder(join(source, name))) out.set(`${name}/${file}`, readFileSync(join(source, name, file), 'utf8'));
	return out;
}

/** The stamp's hashes (`<name>/<file>` → hash), or null when there's no stamp or it doesn't parse. */
function stampOf(root) {
	try {
		const files = JSON.parse(read(join(root, STAMP)) ?? '').files;
		return files && typeof files === 'object' ? files : null;
	} catch {
		return null;
	}
}

/**
 * What init does to bring a site's `.claude/skills/` to the package's skills, as init's changes
 * (`add`, `edit`, `remove` and `unlink`; a skill file's carry `skill: true`, so a dry run lists
 * them without diffs), notes and what's already done.
 * @param {string} root
 */
export function skillsPlan(root) {
	const changes = [];
	const notes = [];
	const done = [];
	const wanted = packageFiles();
	const stamp = stampOf(root) ?? {};
	const next = {};
	const at = (rel) => `${SKILLS_DIR}/${rel}`;
	const mine = (rel, text) => stamp[rel] !== undefined && hash(text) === stamp[rel];

	for (const name of skillNames()) {
		const dir = at(name);
		const st = lstat(join(root, dir));
		const files = [...wanted.keys()].filter((rel) => rel.startsWith(`${name}/`));
		const fresh = () => {
			for (const rel of files) {
				changes.push({ kind: 'add', file: at(rel), after: wanted.get(rel), skill: true });
				next[rel] = hash(wanted.get(rel));
			}
		};
		if (st?.isSymbolicLink()) {
			if (!readlinkSync(join(root, dir)).startsWith(OLD_LINK_BASE)) {
				notes.push(`${dir} is the site's own (a link elsewhere), so init doesn't copy caracms's ${name} skill over it.`);
				continue;
			}
			// 0.8 and earlier: a link into node_modules, now a copy.
			changes.push({ kind: 'unlink', file: dir, why: 'a link into node_modules, now a copy' });
			fresh();
			continue;
		}
		if (!st) {
			fresh();
			continue;
		}
		// Caracms's when the stamp names it, or when every file is caracms's word for word (a lost stamp).
		const ours = Object.keys(stamp).some((rel) => rel.startsWith(`${name}/`)) || (st.isDirectory() && files.every((rel) => read(join(root, at(rel))) === wanted.get(rel)));
		if (!st.isDirectory() || !ours) {
			notes.push(`${dir} is the site's own, so init doesn't copy caracms's ${name} skill over it.`);
			continue;
		}
		let current = true;
		for (const rel of files) {
			const want = wanted.get(rel);
			const have = read(join(root, at(rel)));
			if (have === want) next[rel] = hash(want);
			else if (have === null || mine(rel, have)) {
				changes.push({ kind: have === null ? 'add' : 'edit', file: at(rel), before: have, after: want, skill: true });
				next[rel] = hash(want);
				current = false;
			} else {
				notes.push(`${at(rel)} has been edited here, so init leaves it as it is. caracms's own is node_modules/caracms/site-skills/${rel}: bring your changes across, or delete the file and run init again.`);
				if (stamp[rel] !== undefined) next[rel] = stamp[rel];
				current = false;
			}
		}
		// Files caracms copied that the skill no longer has.
		for (const rel of Object.keys(stamp).filter((r) => r.startsWith(`${name}/`) && !wanted.has(r))) {
			const have = read(join(root, at(rel)));
			if (have === null) continue;
			if (mine(rel, have)) changes.push({ kind: 'remove', file: at(rel), why: 'no longer in the skill' });
			else {
				notes.push(`${at(rel)} is no longer in caracms's ${name} skill, but it has been edited here, so init leaves it.`);
				next[rel] = stamp[rel];
			}
			current = false;
		}
		if (current) done.push(dir);
	}

	// Skills the package no longer has: their copies (when unedited) and their 0.8 links.
	const names = new Set(skillNames());
	for (const rel of Object.keys(stamp).filter((r) => !names.has(r.split('/')[0]))) {
		const have = read(join(root, at(rel)));
		if (have === null) continue;
		if (mine(rel, have)) changes.push({ kind: 'remove', file: at(rel), why: 'that skill is no longer in the package' });
		else {
			notes.push(`${at(rel)} is from a skill caracms no longer has, but it has been edited here, so init leaves it.`);
			next[rel] = stamp[rel];
		}
	}
	const dirPath = join(root, SKILLS_DIR);
	if (lstat(dirPath)?.isDirectory()) {
		for (const name of readdirSync(dirPath).sort()) {
			if (names.has(name) || !lstat(join(dirPath, name))?.isSymbolicLink()) continue;
			if (readlinkSync(join(dirPath, name)).startsWith(OLD_LINK_BASE)) changes.push({ kind: 'unlink', file: at(name), why: 'that skill is no longer in the package' });
			// pnpm's own links, from an approval of 0.8's skills (gitignored, so only on that machine): each skill twice.
			else if (name.startsWith('pnpm-caracms-')) changes.push({ kind: 'unlink', file: at(name), why: "pnpm's link from an approval, a second copy of a skill" });
		}
	}

	const before = read(join(root, STAMP));
	const after = `${JSON.stringify({ about: "caracms's skills as `caracms init` copied them: it refreshes a file whose hash is still this one, and leaves an edited one alone.", files: next }, null, 2)}\n`;
	if (before !== after && (changes.length || Object.keys(next).length)) changes.push({ kind: before === null ? 'add' : 'edit', file: STAMP, before, after, skill: true });
	return { changes, notes, done };
}

/**
 * One sentence when the site's copies are behind the installed package (what `astro dev` and
 * `caracms validate` warn), else null. Only for a site that has caracms's skills already (a
 * stamp, or 0.8's links): one that never ran init, or took them out, gets nothing.
 * @param {string} root
 * @returns {string | null}
 */
export function skillsWarning(root) {
	const linked = (() => {
		const dirPath = join(root, SKILLS_DIR);
		if (!lstat(dirPath)?.isDirectory()) return false;
		return readdirSync(dirPath).some((n) => lstat(join(dirPath, n))?.isSymbolicLink() && readlinkSync(join(dirPath, n)).startsWith(OLD_LINK_BASE));
	})();
	if (!linked && stampOf(root) === null) return null;
	const behind = skillsPlan(root).changes.some((c) => c.file !== STAMP);
	if (!behind) return null;
	const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
	return linked
		? `${SKILLS_DIR} links caracms's skills from node_modules, and caracms ${version} copies them in instead: run \`npx caracms init --write\` and commit the result.`
		: `${SKILLS_DIR} is behind the skills of the installed caracms (${version}): run \`npx caracms init --write\` and commit the result.`;
}
