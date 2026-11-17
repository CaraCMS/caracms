// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import caracms from 'caracms';
import site from './caracms.config.ts';

// `caracms audit` on a site with React islands (test/audit-islands.test.ts): the audit renders with
// the site's own framework renderers. test/audit-islands.test.ts also runs it with `react()` taken
// out, where nothing can render.
export default defineConfig({
	integrations: [react(), caracms(site)],
	devToolbar: { enabled: false },
});
