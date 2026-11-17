/**
 * Rendering a site's pages outside its dev server (review gaps, Decision 15): the site's own
 * Vite (its Astro config through `getViteConfig`, so the caracms integration's virtual modules,
 * fonts and the site's other plugins are there) in middleware mode, and Astro's container API
 * on top. Nothing listens on a port, nothing is watched and nothing is written.
 *
 * `caracms audit` renders every page through it; the package's tests render their fixture
 * sites through it (test/helpers/site-render.ts re-exports it, beside the fixtures it copies).
 *
 * Astro and its Vite are the site's own, found from the site's root as the commands find them
 * (bin/site-runner.mjs), so a site on its own install renders with what it builds with.
 *
 * Scoped `<style>` blocks and imported CSS aren't part of a container render. Framework components
 * (a React island, `client:*` or not) render with the site's own renderers (siteRenderers), into
 * their server-rendered HTML. Each render runs through the site's own middleware (siteMiddleware),
 * as a request to its dev server does, so what a middleware puts in `Astro.locals` is there.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { getViteConfig as GetViteConfig } from 'astro/config';

export interface Renderer {
	/** Render a component as a partial (no doctype). */
	component(path: string, props: Record<string, unknown>): Promise<string>;
	/**
	 * Render a component as a full page; `url`: the request's address (default `http://localhost/render-test`).
	 * `locals`: the request's `Astro.locals`, kept by the caller, so what the render writes there (the
	 * preview's read record, read.ts → startReadRecord) can be read after.
	 */
	page(path: string, props: Record<string, unknown>, url?: string, locals?: Record<string, unknown>): Promise<string>;
	/** Load a module through Vite (virtual modules included). */
	load<T = any>(path: string): Promise<T>;
	close(): Promise<void>;
}

export interface RendererOptions {
	/**
	 * Astro's source annotations (`data-astro-source-file` on each element a component writes), which
	 * Astro adds in dev only with the dev toolbar on. On: the toolbar is turned on for these renders
	 * whatever the site's config says, so the audit can say which component wrote a word.
	 */
	annotate?: boolean;
}

/** The site's Astro (its folder), as the commands find it. */
function siteAstro(root: string): string {
	try {
		return dirname(createRequire(join(root, 'package.json')).resolve('astro/package.json'));
	} catch {
		throw new Error("there's no Astro installed here. Run this from the site's root, after installing its dependencies.");
	}
}

/** One of Astro's package exports (`./config`), as a file URL. */
function astroExport(astro: string, name: string): string {
	const exports = (JSON.parse(readFileSync(join(astro, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }).exports;
	let entry = exports[name];
	while (entry && typeof entry === 'object') entry = (entry as Record<string, unknown>).import ?? (entry as Record<string, unknown>).default;
	if (typeof entry !== 'string') throw new Error(`the site's Astro has no "${name}" export.`);
	return pathToFileURL(join(astro, entry)).href;
}

/**
 * The site's framework renderers (React, Preact, Svelte, Vue, Solid…), as its own dev server loads
 * them: `getViteConfig` runs the integrations' setup, each framework integration registers its
 * renderer there, and Astro's renderers plugin serves them all, server half loaded, as
 * `virtual:astro:renderers`. Without them the container can't draw a framework component
 * ("Unable to render X"). A site with no framework integration gets none, as before.
 */
async function siteRenderers(server: { ssrLoadModule(path: string): Promise<any> }): Promise<unknown[]> {
	const { renderers } = (await server.ssrLoadModule('virtual:astro:renderers')) as { renderers?: unknown[] };
	return Array.isArray(renderers) ? renderers : [];
}

/**
 * The site's middleware chain, as its dev server runs it: `virtual:astro:middleware` is its
 * `src/middleware` and every integration's (`addMiddleware`) in order, caracms's own included.
 * Without it the container runs none, so a page that reads what a middleware sets fails to render:
 * Starlight's sets `Astro.locals.t` and its route data, which every Starlight component reads
 * (found on a Starlight site, 0.20.0). caracms's own are no-ops here: no editor path is rendered, and the
 * audit's in-memory media keeps the cloud's from fetching.
 */
async function siteMiddleware(server: { ssrLoadModule(path: string): Promise<any> }): Promise<unknown> {
	const { onRequest } = (await server.ssrLoadModule('virtual:astro:middleware')) as { onRequest?: unknown };
	return typeof onRequest === 'function' ? onRequest : undefined;
}

/** `root`: the site's root (its astro.config and node_modules). */
export async function startRenderer(root: string, options: RendererOptions = {}): Promise<Renderer> {
	const astro = siteAstro(root);
	const { createServer } = (await import(pathToFileURL(createRequire(join(astro, 'package.json')).resolve('vite')).href)) as {
		createServer(config: unknown): Promise<{ ssrLoadModule(path: string): Promise<any>; close(): Promise<void> }>;
	};
	const { getViteConfig } = (await import(astroExport(astro, './config'))) as { getViteConfig: typeof GetViteConfig };
	const viteConfig = await getViteConfig(
		{
			appType: 'custom',
			server: { middlewareMode: true, hmr: false, ws: false, watch: null },
			optimizeDeps: { noDiscovery: true },
		},
		{ root, logLevel: 'silent', ...(options.annotate ? { devToolbar: { enabled: true } } : {}) },
	)({ mode: 'development', command: 'serve' });
	const server = await createServer({ ...viteConfig, logLevel: 'silent' });

	let container: { renderToString(component: unknown, options: unknown): Promise<string> };
	try {
		const { experimental_AstroContainer: AstroContainer } = await server.ssrLoadModule('astro/container');
		const onRequest = await siteMiddleware(server);
		// The container takes a middleware only through its manifest; the rest of it keeps the container's defaults.
		container = await AstroContainer.create({ renderers: await siteRenderers(server), ...(onRequest ? { manifest: { middleware: () => ({ onRequest }) } } : {}) });
	} catch (error) {
		// An open server keeps the process alive: the command would hang instead of saying what failed.
		await server.close();
		throw error;
	}
	const load = (path: string) => server.ssrLoadModule(path);

	return {
		load,
		async component(path, props) {
			return container.renderToString((await load(path)).default, { props });
		},
		async page(path, props, url = 'http://localhost/render-test', locals) {
			// M6: a page's address, not `/`, which the head would take for the home page (head.ts → its title rule).
			return container.renderToString((await load(path)).default, { props, partial: false, request: new Request(url), ...(locals ? { locals } : {}) });
		},
		close: () => server.close(),
	};
}
