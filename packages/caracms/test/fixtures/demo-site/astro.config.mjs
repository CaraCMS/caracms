// @ts-check
import node from '@astrojs/node';
import { defineConfig } from 'astro/config';
import caracms from 'caracms';
import site from './caracms.config.ts';

// The package's fixture site (M7 Decisions 1–2): the starter's Astro config as it was before
// M7, for the tests that render or build the fixture site through it
// (test/helpers/site-render.ts). The browser tests' dev server (helpers/dev-site.ts) passes
// its own config instead. No port: a test copy is never served on 4326.
export default defineConfig({
	adapter: node({ mode: 'standalone' }),
	integrations: [caracms(site)],
	devToolbar: { enabled: false },
});
