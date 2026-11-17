// Loading the package's TypeScript (and through it the site's caracms.config.ts) from a
// plain `.mjs` command (M8 → Current state: "load it the way the site's own Astro does").
//
// Node 22.12 runs no TypeScript without flags, and the site's config imports `caracms/config`
// as TypeScript source. So a command that needs the config (`schemas`, `validate`) starts
// a Vite dev server in middleware mode from the site's own Astro's Vite, with caracms
// compiled (`ssr.noExternal`, as the integration sets it), loads one of the package's
// `src/cli/*.ts` modules through it, and closes it after. No port is opened, nothing is
// watched, and nothing is written.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** The Vite the site's Astro uses, or null with a sentence why. */
export function siteVite(root) {
	const fromSite = createRequire(join(root, 'package.json'));
	let astro;
	try {
		astro = fromSite.resolve('astro/package.json');
	} catch {
		return { vite: null, problem: "there's no Astro installed here. Run this from the site's root, after installing its dependencies." };
	}
	try {
		return { vite: createRequire(astro).resolve('vite'), problem: null };
	} catch {
		return { vite: null, problem: "the site's Astro has no Vite beside it. Reinstall the site's dependencies." };
	}
}

/**
 * Run `fn(module)` with the package's `src/cli/<name>.ts` loaded through the site's Vite,
 * then close the server. Throws an Error with a plain sentence when it can't be loaded.
 */
export async function withPackageModule(root, name, fn) {
	const { vite, problem } = siteVite(root);
	if (!vite) throw new Error(problem);
	const { createServer } = await import(pathToFileURL(vite).href);
	const server = await createServer({
		root,
		configFile: false,
		envFile: false,
		logLevel: 'error',
		clearScreen: false,
		appType: 'custom',
		server: { middlewareMode: true, hmr: false, ws: false, watch: null },
		optimizeDeps: { noDiscovery: true, include: [] },
		ssr: { noExternal: ['caracms'] },
	});
	try {
		const entry = join(packageRoot, 'src/cli', `${name}.ts`);
		if (!existsSync(entry)) throw new Error(`the package's ${entry} is missing. Reinstall caracms.`);
		const module = await server.ssrLoadModule(entry);
		return await fn(module);
	} finally {
		await server.close();
	}
}
