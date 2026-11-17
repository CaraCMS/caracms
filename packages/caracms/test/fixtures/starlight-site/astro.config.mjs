// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import caracms from 'caracms';
import site from './caracms.config.ts';

// `caracms audit` on a Starlight site (test/audit-starlight.test.ts): every Starlight component reads
// what Starlight's middleware puts in `Astro.locals` (`t`, its route data), so the audit's renders
// must run the site's middleware. A real docs site's shape, cut down: CaraCMS pages inside <StarlightPage>.
export default defineConfig({
	integrations: [caracms(site), starlight({ title: 'Starlight fixture' })],
	devToolbar: { enabled: false },
});
