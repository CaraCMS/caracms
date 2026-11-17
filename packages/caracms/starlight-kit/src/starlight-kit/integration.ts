/**
 * The docs kit's Astro integration: adds the kit's Markdown routes.
 *
 *   /<page address>.md   every public page's Markdown (Home at /index.md)   routes/markdown.ts
 *   /llms.txt            the pages as links to their Markdown, like the sidebar   routes/llms.txt.ts
 *   /llms-full.txt       every page's Markdown, in sidebar order   routes/llms-full.txt.ts
 *
 * Why injected, not files in src/pages/: `caracms validate` reads any route file with a
 * rest parameter at `/` as a second catch-all, so `src/pages/[...path].md.ts` fails it (with
 * every page "served by the site's own code"), though Astro only sends it addresses ending
 * in `.md`. Routes injected here aren't in src/pages/, so validate doesn't see them.
 *
 * Options: `groupLabels`, labels for sidebar groups that are folders with no page of their
 * own, keyed by the folder's path (sidebar.ts). The kit's code reads them from
 * `virtual:starlight-kit/config` (typed in virtual.d.ts).
 *
 * Assumes: listed in astro.config's `integrations` beside caracms's (whose
 * `virtual:caracms/config` the routes read).
 */
import type { AstroIntegration } from 'astro';
import type { GroupLabels } from './sidebar.ts';

export type StarlightKitOptions = { groupLabels?: GroupLabels };

const VIRTUAL = 'virtual:starlight-kit/config';

export function starlightKit(options: StarlightKitOptions = {}): AstroIntegration {
	const config = `export const groupLabels = ${JSON.stringify(options.groupLabels ?? {})};`;
	return {
		name: 'starlight-kit',
		hooks: {
			'astro:config:setup': ({ injectRoute, updateConfig }) => {
				updateConfig({
					vite: {
						plugins: [
							{
								name: 'starlight-kit-config',
								resolveId: (id: string) => (id === VIRTUAL ? `\0${VIRTUAL}` : undefined),
								load: (id: string) => (id === `\0${VIRTUAL}` ? config : undefined),
							},
						],
					},
				});
				const at = (file: string) => new URL(`./routes/${file}`, import.meta.url);
				injectRoute({ pattern: '/[...path].md', entrypoint: at('markdown.ts'), prerender: true });
				injectRoute({ pattern: '/llms.txt', entrypoint: at('llms.txt.ts'), prerender: true });
				injectRoute({ pattern: '/llms-full.txt', entrypoint: at('llms-full.txt.ts'), prerender: true });
			},
		},
	};
}
