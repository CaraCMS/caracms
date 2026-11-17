/**
 * Renders the package's fixture site (test/fixtures/demo-site, the pre-M7 demo, on the pinned
 * content in test/fixtures/demo-content) through Astro's container API, from node:test.
 * M7 Decision 2: the job of the starter's `test/helpers/render.ts` `pinnedSite()` moved here
 * with the tests that check a package feature through a site (file links, forms, media, port
 * readiness, columns, fields, the h1 and markers).
 *
 * The container can't import `.astro` files from plain Node, so the renderer (src/audit/render.ts,
 * re-exported here) starts a Vite server in middleware mode with the copy's own Astro config,
 * loads the modules through it, and renders. Nothing listens on a port.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRowsContent } from './rows-content.ts';

/** The package's root: its `node_modules/.bin/astro` builds a copy, and its test fixtures are here. */
export const root = fileURLToPath(new URL('../..', import.meta.url));
const demoSite = join(root, 'test/fixtures/demo-site');
const demoContent = join(root, 'test/fixtures/demo-content');

/**
 * A throwaway copy of the fixture site with the pinned content. It sits in test/.tmp
 * (ignored), so astro and @astrojs/node resolve from the package's node_modules; `caracms`
 * is a link to the package itself, and the copy gets its own package.json, as in
 * helpers/dev-site.ts. (Not a file in the fixture: a package.json there would hide the
 * package's own from the fixture's `caracms/…` imports when the package is type-checked.)
 */
export function pinnedSite(name: string): { root: string; close(): void } {
	const copy = join(root, 'test/.tmp', `site-${name}-${process.pid}`);
	rmSync(copy, { recursive: true, force: true });
	mkdirSync(copy, { recursive: true });
	// Never `.env`: tests never touch the live media values (they set fake ones or CARACMS_MEDIA=memory).
	for (const part of ['src', 'public', 'astro.config.mjs', 'caracms.config.ts', 'caracms.paged.config.ts', 'tsconfig.json']) {
		cpSync(join(demoSite, part), join(copy, part), { recursive: true });
	}
	cpSync(demoContent, join(copy, 'content'), { recursive: true });
	mkdirSync(join(copy, 'node_modules'), { recursive: true });
	symlinkSync(root, join(copy, 'node_modules/caracms'), 'dir');
	writeFileSync(join(copy, 'package.json'), '{ "name": "caracms-fixture-site", "private": true, "type": "module" }\n');
	return { root: copy, close: () => rmSync(copy, { recursive: true, force: true }) };
}

/**
 * Posts and tags (Decisions 12, 14–16): a `pinnedSite` on `caracms.paged.config.ts`, the fixture's
 * config plus a paged list block (`listing`) and a `date` page field on the journal.
 */
export function pagedSite(name: string): { root: string; close(): void } {
	const copy = pinnedSite(name);
	const config = join(copy.root, 'astro.config.mjs');
	writeFileSync(config, readFileSync(config, 'utf8').replace("from './caracms.config.ts'", "from './caracms.paged.config.ts'"));
	return copy;
}

/**
 * Form rows and sourced selects: a `pinnedSite` on `caracms.rows.config.ts`, the fixture's config
 * plus the `workshops` collection and the `booking` form (a rows field whose Workshop column lists
 * the open workshops and narrows its Session column).
 */
export function rowsSite(name: string): { root: string; close(): void } {
	const copy = pinnedSite(name);
	cpSync(join(demoSite, 'caracms.rows.config.ts'), join(copy.root, 'caracms.rows.config.ts'));
	addRowsContent(copy.root);
	const config = join(copy.root, 'astro.config.mjs');
	writeFileSync(config, readFileSync(config, 'utf8').replace("from './caracms.config.ts'", "from './caracms.rows.config.ts'"));
	return copy;
}

// The renderer moved into the package (review gaps, Decision 15: `caracms audit` renders through it).
export { startRenderer, type Renderer } from '../../src/audit/render.ts';

/** Count matches of a pattern (the markup is Astro's, well-formed). */
export const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;
