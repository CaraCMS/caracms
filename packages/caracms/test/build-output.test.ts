// The demo's production build (M4 Decision 1; Phase 2 → Verify 7). The editor's
// routes are in the build now (reversing M3 Decision 4), and the public pages still
// ship no editor, no React and no markers (M7 Decision 20: they do ship the starter's own
// bundled scripts from /_astro/, the motion setup and the menu's):
// - the editor's routes exist in the server output;
// - no prerendered page has a data-cms-* marker or contenteditable, and the only scripts a
//   page may carry are the kinds that shipped (a form's inline script, the Google tag) and
//   module scripts bundled from /_astro/, none of them the editor's entry;
// - every .js in the client output is either the editor's own bundle (reachable only from
//   the entry the editor's server-rendered page loads, /admin) or the site's own (reachable
//   from a public page's script or the player's), and the site's has no React and no editor
//   markers in it or in anything it imports.
// Run `pnpm build` first; without starter/dist this skips.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { BUILD_INFO_FILE, EDITOR_ROUTES, PUBLIC_ROUTES } from '../src/index.ts';
import { starter } from './helpers/dev-site.ts';

const dist = join(starter, 'dist');
const skip = existsSync(join(dist, 'server/entry.mjs')) ? false : 'starter/dist is missing: run `pnpm build` first';

const files = (dir: string): string[] =>
	existsSync(dir) ? readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)])) : [];

describe('the production build: the editor\'s routes, and public pages with no editor in them', { skip }, () => {
	const server = files(join(dist, 'server'));
	const client = files(join(dist, 'client'));
	const text = (file: string) => readFileSync(file, 'utf8');
	const pages = client.filter((f) => f.endsWith('.html'));
	const scripts = client.filter((f) => /\.m?js$/.test(f));
	const adminEntries = scripts.filter((f) => basename(f).startsWith('admin.astro_astro_type_script'));
	// M7 Decision 20: the site's own bundled scripts, as the starter's pages reference them.
	const SITE_SCRIPT = /<script type="module" src="(\/_astro\/[^"?#]+\.m?js)"><\/script>/g;
	const imports = (file: string) =>
		[...text(file).matchAll(/["'`](\.{1,2}\/[^"'`]+\.m?js)["'`]/g)].map((m) => join(file, '..', m[1]!)).filter((next) => existsSync(next));
	const closure = (roots: string[]) => {
		const reached = new Set<string>();
		const visit = (file: string) => {
			if (reached.has(file)) return;
			reached.add(file);
			imports(file).forEach(visit);
		};
		roots.forEach(visit);
		return reached;
	};

	test('the editor\'s routes are in the server output', () => {
		const code = server.filter((f) => f.endsWith('.mjs')).map(text).join('\n');
		for (const route of [...EDITOR_ROUTES, ...PUBLIC_ROUTES]) assert.ok(code.includes(route.pattern), `${route.pattern} isn't in the server output`);
		assert.ok(code.includes('caracms-props'), 'the admin page');
	});

	test('the public pages have no editor script, no markers, no contenteditable, no tabindex, and load no .js but the site\'s own from /_astro/ (and a form\'s own and the Google tag)', () => {
		assert.ok(pages.length >= 5, 'the public pages were prerendered');
		for (const page of pages) {
			const where = relative(dist, page);
			// M6 Decision 17: a form's page carries its one small inline script and its honeypot's tabindex="-1".
			const html = text(page)
				.replace(/<script type="module">[^<]*form\[data-caracms-form\][^<]*<\/script>/g, '')
				.replace(/<input type="text" name="fax" tabindex="-1"/g, '<input type="text" name="fax"')
				// M6 Decision 16: Site Settings' Google tag (head.ts → gtag.js or Tag Manager), when the demo has one set.
				.replace(/<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+"><\/script><script>window\.dataLayer=[^<]*<\/script>/g, '')
				.replace(/<script>\(function\(w,d,s,l,i\)[^<]*googletagmanager\.com\/gtm\.js[^<]*<\/script>/g, '')
				// M7 Decision 20: the site's own bundled module scripts (motion setup, menu) from /_astro/; never the editor's entry.
				.replace(SITE_SCRIPT, (_tag, src: string) => {
					const file = join(dist, 'client', src);
					assert.ok(existsSync(file), `${where} loads ${src}, which isn't in the client output`);
					assert.equal(adminEntries.includes(file), false, `${where} loads the editor's entry ${src}`);
					return '';
				});
			assert.doesNotMatch(html, /<script/i, `${where} has a script`);
			// data-cms-fixed is the site's own attribute (words it accepts as code, for `caracms audit`), so it ships.
			assert.doesNotMatch(html, /data-cms-(?!fixed\b)/, `${where} has an editor marker`);
			assert.doesNotMatch(html, /contenteditable/i, `${where} has contenteditable`);
			assert.doesNotMatch(html, /tabindex/i, `${where} has tabindex (on-page rich text's preview-only focus)`);
			assert.doesNotMatch(html, /\.m?js["'?#\s>]/, `${where} references a .js file`);
		}
		assert.equal(client.some((f) => relative(join(dist, 'client'), f).startsWith('admin')), false, 'no prerendered /admin');
	});

	test('every .js in the client output is the editor\'s bundle (reached only from /admin\'s entry) or the site\'s own, which has no React and no editor code in it (M5b: the media player\'s counts as the site\'s)', () => {
		const entries = adminEntries;
		assert.equal(entries.length, 1, 'the editor\'s one entry (admin.astro\'s script)');
		// M5b Decision 4: a page with a player carries one click script, which imports Mux Player on the first click.
		const player = scripts.filter((f) => basename(f).startsWith('MediaPlayer.astro_astro_type_script'));
		assert.ok(player.length <= 1, 'at most the player\'s one click script');
		// M7 Decision 20: the scripts the public pages themselves reference.
		const referenced = new Set<string>();
		for (const page of pages) for (const m of text(page).matchAll(SITE_SCRIPT)) referenced.add(join(dist, 'client', m[1]!));
		assert.ok(referenced.size >= 1, 'the public pages load the site\'s own script');
		assert.equal(entries.some((f) => referenced.has(f)), false, 'a public page loads the editor\'s entry');

		const site = closure([...referenced, ...player]);
		const editor = closure(entries);
		assert.equal(site.has(entries[0]!), false, 'the site\'s scripts import the editor\'s entry');
		assert.deepEqual(
			scripts.filter((f) => !site.has(f) && !editor.has(f)).map((f) => relative(dist, f)),
			[],
			'a client .js that neither the editor\'s entry nor a public page\'s script reaches',
		);
		// The markers must mean something: the editor's bundle has them; the site's scripts, and what they import, have none.
		const EDITOR_CODE = /data-cms-|caracms-props|contenteditable/i;
		const REACT = /\breact(-dom)?\b|__SECRET_INTERNALS|jsx-runtime/i;
		const bundle = text(entries[0]!);
		assert.match(bundle, EDITOR_CODE, 'the editor\'s bundle carries its markers');
		assert.match(bundle, REACT, 'the editor\'s bundle carries React');
		for (const f of site) {
			assert.doesNotMatch(text(f), EDITOR_CODE, `${relative(dist, f)} (a public script) has editor code`);
			assert.doesNotMatch(text(f), REACT, `${relative(dist, f)} (a public script) has React`);
		}
		const admin = server.filter((f) => f.endsWith('.mjs')).map(text).join('\n');
		for (const f of entries) assert.ok(admin.includes(basename(f)), `${basename(f)} isn't loaded by the editor's page`);
	});
});

describe('the build info beside the server entry, for caracms start (runs-anywhere Decisions 7 and 9)', { skip }, () => {
	test('dist/server/caracms-build.json: the site\'s address as built and the commit, nothing else', () => {
		const info = JSON.parse(readFileSync(join(dist, 'server', BUILD_INFO_FILE), 'utf8')) as Record<string, unknown>;
		assert.deepEqual(Object.keys(info).sort(), ['commit', 'site']);
		assert.ok(info.site === null || (typeof info.site === 'string' && /^https?:\/\//.test(info.site)), String(info.site));
		// Built inside this repo: the commit is `git rev-parse HEAD` unless a host variable was set.
		assert.ok(typeof info.commit === 'string' && info.commit.length > 0, String(info.commit));
	});
});
