// @ts-check
import { defineConfig } from 'astro/config';
import caracms from 'caracms';
import site from './caracms.config.ts';

// `caracms audit`'s fixture (review gaps, Decisions 15–18; test/audit.test.ts): a small site with one
// case of each thing the audit reports, and one of each it must leave out.
export default defineConfig({
	integrations: [caracms(site)],
	devToolbar: { enabled: false },
});
