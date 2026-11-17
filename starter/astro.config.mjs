// @ts-check
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import caracms from 'caracms';
import site from './caracms.config.ts';

// The starter (a site about CaraCMS itself).
// M7 Decision 5: Tailwind v4, its tokens in src/styles/tokens.css (src/components/site.css imports them).
export default defineConfig({
	// Public pages are prerendered; the Node server serves them and, later, /admin.
	adapter: node({ mode: 'standalone' }),
	// caracms reads the site's collections, blocks, text styles, page component and
	// brand from caracms.config.ts, and registers the text styles' fonts.
	integrations: [caracms(site)],
	// Injected into the body in dev; it would fight the editor's body morph (M1 → Watch-outs).
	devToolbar: { enabled: false },
	// Port 4326, strict. Astro's `server` has no strictPort; Vite's does.
	server: { port: 4326 },
	vite: {
		plugins: [tailwindcss()],
		server: { strictPort: true },
		preview: { strictPort: true },
	},
});
