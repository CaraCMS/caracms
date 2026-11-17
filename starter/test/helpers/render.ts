/**
 * Renders the demo's real components through Astro's container API, from
 * node:test (the pattern M1's spike proved).
 *
 * The container can't import `.astro` files from plain Node, so this starts a Vite
 * server in middleware mode with the starter's own Astro config (getViteConfig runs
 * the caracms integration, so its virtual modules and fonts are there), loads the
 * modules through it, and renders. Nothing listens on a port.
 *
 * Scoped `<style>` blocks and imported CSS aren't part of a container render, so
 * CSS is asserted on the built output instead (build-output.test.ts).
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';

export const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The starter's content as these tests expect it: its own pinned copy (M7 Decision 2),
 * test/fixtures/content, taken from starter/content at the end of M7. starter/content is
 * the live demo's, and a Publish from its editor changes it. A test that needs new
 * content adds it here.
 */
export const fixtureContent = join(root, 'test/fixtures/content');

/**
 * A throwaway copy of the starter with the pinned content, for the tests that check the
 * starter's own blocks, shell and build. It sits in test/.tmp (ignored), so its packages
 * resolve from the starter's node_modules. The round-trip test reads the real demo.
 * (Tests of package features through a site moved to the package, on its fixture site:
 * packages/caracms/test/helpers/site-render.ts.)
 */
export function pinnedSite(name: string): { root: string; close(): void } {
	const copy = join(root, 'test/.tmp', `${name}-${process.pid}`);
	rmSync(copy, { recursive: true, force: true });
	mkdirSync(copy, { recursive: true });
	// Never `.env`: it holds the live bucket's, imgproxy's and Mux's values (M5b Decision 5), which the
	// integration would load, and tests never touch them (they set fake ones or CARACMS_MEDIA=memory).
	for (const part of ['src', 'public', 'astro.config.mjs', 'caracms.config.ts', 'tsconfig.json', 'package.json']) {
		cpSync(join(root, part), join(copy, part), { recursive: true });
	}
	cpSync(fixtureContent, join(copy, 'content'), { recursive: true });
	return { root: copy, close: () => rmSync(copy, { recursive: true, force: true }) };
}

export interface Renderer {
	/** Render a component as a partial (no doctype). */
	component(path: string, props: Record<string, unknown>): Promise<string>;
	/** Render a component as a full page. */
	page(path: string, props: Record<string, unknown>, url?: string, locals?: Record<string, unknown>): Promise<string>;
	/** Load a module through Vite (virtual modules included). */
	load<T = any>(path: string): Promise<T>;
	close(): Promise<void>;
}

/** `at`: the site's root (default the starter; a `pinnedSite`'s for the pinned content). */
export async function startRenderer(at = root): Promise<Renderer> {
	const { createServer } = createRequire(import.meta.resolve('astro/package.json'))('vite');
	const viteConfig = await getViteConfig(
		{
			appType: 'custom',
			server: { middlewareMode: true, hmr: false, ws: false, watch: null },
			optimizeDeps: { noDiscovery: true },
		},
		{ root: at, logLevel: 'silent' },
	)({ mode: 'development', command: 'serve' });
	const server = await createServer({ ...viteConfig, logLevel: 'silent' });

	const { experimental_AstroContainer: AstroContainer } = await server.ssrLoadModule('astro/container');
	const container = await AstroContainer.create();
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

/** Count matches of a pattern (the markup is Astro's, well-formed). */
export const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;
