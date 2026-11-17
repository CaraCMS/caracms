/**
 * Reading the site's pages folder for its code routes (M8 Decision 10; code-routes.ts
 * has the rules). Server-only. The integration passes Astro's own `srcDir`; `validate`,
 * with no Astro running, reads it from the site's astro.config (`srcDirOf`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { codeRoutesFrom, routeOf, type CodeRoute } from './code-routes.ts';

const posix = (path: string) => path.split(sep).join('/');

/** Every route under `<srcDir>/pages` (each one, collections' own included), in file order. */
export function pagesRoutes(root: string, srcDir: string): CodeRoute[] {
	const pages = join(isAbsolute(srcDir) ? srcDir : join(root, srcDir), 'pages');
	const out: CodeRoute[] = [];
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (name.startsWith('_') || name.startsWith('.')) continue;
			const path = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(path).isDirectory();
			} catch {
				continue;
			}
			if (isDir) walk(path);
			else {
				const route = routeOf(posix(relative(pages, path)), posix(relative(root, path)));
				if (route) out.push(route);
			}
		}
	};
	walk(pages);
	return out;
}

/** The routes that reserve URLs (the collections' own left out). */
export function readCodeRoutes(root: string, srcDir: string, collections: readonly { urlBase: string | null }[]): CodeRoute[] {
	return codeRoutesFrom(pagesRoutes(root, srcDir), collections);
}

export const ASTRO_CONFIG_FILES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js', 'astro.config.cjs', 'astro.config.cts'] as const;

/**
 * The site's `srcDir` as its astro.config writes it (`srcDir: './app'`), else `./src`,
 * Astro's default. Read from the text: a computed value isn't seen (and `validate` says
 * nothing about it), which is the price of needing no running Astro.
 */
export function srcDirOf(root: string): string {
	for (const name of ASTRO_CONFIG_FILES) {
		let text: string;
		try {
			text = readFileSync(join(root, name), 'utf8');
		} catch {
			continue;
		}
		const m = /\bsrcDir\s*:\s*(['"`])([^'"`]+)\1/.exec(text);
		return m ? m[2]! : './src';
	}
	return './src';
}
