/**
 * The site as the commands see it (M8): its `caracms.config.ts`, loaded and resolved as
 * the integration resolves it, and its content files on disk. Loaded through the site's
 * own Vite (bin/site-runner.mjs), so the config's TypeScript and its imports of
 * `caracms/config` work on any Node the package supports.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveSite, type ResolvedSite, type SiteConfig } from '../config.ts';

/** The config file names a site may use, in the order they're looked for. */
export const CONFIG_FILES = ['caracms.config.ts', 'caracms.config.mts', 'caracms.config.mjs', 'caracms.config.js'] as const;

export class CommandError extends Error {}

export function configFile(root: string): string | null {
	for (const name of CONFIG_FILES) if (existsSync(join(root, name))) return name;
	return null;
}

/** The site's resolved config. Throws a CommandError with the config's own sentence when it's missing or wrong. */
export async function loadSite(root: string): Promise<ResolvedSite> {
	const name = configFile(root);
	if (!name) throw new CommandError(`there's no caracms.config.ts in ${root}. Run this from the site's root (run \`caracms init\` first on a site without caracms).`);
	let config: SiteConfig;
	try {
		config = ((await import(/* @vite-ignore */ join(root, name))) as { default: SiteConfig }).default;
	} catch (error) {
		throw new CommandError(`${name} couldn't be loaded: ${(error as Error).message}`);
	}
	if (!config || typeof config !== 'object') throw new CommandError(`${name} has no default export. It should end \`export default defineSite({ … })\`.`);
	try {
		return resolveSite(config, root);
	} catch (error) {
		throw new CommandError((error as Error).message);
	}
}

export const posix = (path: string): string => path.split(sep).join('/');

/** Every `.json` file under `dir` (absolute), site-relative and `/`-separated; dot folders and files skipped. */
export function jsonFilesUnder(root: string, dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		for (const n of names.sort()) {
			if (n.startsWith('.')) continue;
			const p = join(d, n);
			let isDir = false;
			try {
				isDir = statSync(p).isDirectory();
			} catch {
				continue;
			}
			if (isDir) walk(p);
			else if (n.endsWith('.json')) out.push(posix(relative(root, p)));
		}
	};
	walk(dir);
	return out;
}
