// Which slow tests a change needs (cms/CLAUDE.md → "Which tests to run when").
//
//   pnpm --filter caracms test:pick <base>          print the picked files and why
//   pnpm --filter caracms test:pick <base> --run    and run them
//
// <base> is the commit the change started from (a run's first commit's parent, or `main`).
// The diff is <base> against the working tree, plus untracked files, so new tests count.
// `<base>..<head>` picks for a range of commits instead (e.g. to see what a past run needed).
//
// The rules, in one breath: each changed path picks its area's tests (AREAS); touching
// the editor's core adds one broad browser file per main screen (CORE_SET); any change to
// how the editor looks runs the whole visual pass; the full browser suite is for a publish,
// or when one is asked for. In detail:
//
// - Browser: the smoke pair whenever src/ changed, the areas' files, CORE_SET when a CORE
//   path changed, and any test file the diff touched.
// - Visual: every visual file when a look path changed (isLook: .css, *-css.ts, .tsx under
//   src/editor/, the editor's fonts, the accent presets). That is where a change to one
//   screen has really shown up in another: a new button in an older mockup's state. Otherwise
//   only the visual files the areas name.
// - Test-side: a changed helper, mockup-diff or fixture picks the tests that name it (through
//   a helper, one hop, never a hub). An edit to the pinned demo (anything in demo-content/, an
//   existing file in demo-site/) runs everything; its generated schemas/ count for nothing.
// - The starter's tests whenever src/ or starter/ changed.
//
// Keeping it current fails safe: a browser or visual file no row names always runs (and
// is listed, so it gets a row), and a path under src/editor/ or src/components/ that no row,
// CORE or QUIET names counts as CORE. Forgetting costs time, never coverage. A new area adds
// its row here in the same commit; a pattern that names no test file is reported as stale.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source paths are prefixes under packages/caracms/src/ (a folder ends in '/').
// Test names are files in test/, '*' matching anything.

/** The editor's core: every screen goes through these. */
const CORE = [
	'editor/client/editor.ts',
	'editor/client/main.tsx',
	'editor/client/context.tsx',
	'editor/client/shell/',
	'editor/client/state/store.ts',
	'editor/client/state/document-store.ts',
	'editor/client/state/schema.ts',
	'editor/client/pane/Pane.tsx',
	'editor/client/pane/parts.tsx',
	'editor/client/preview/driver.ts',
	'editor/server/admin-props.ts',
	'editor/routes/admin.astro',
	'editor/middleware.ts',
	'editor/addresses.ts',
	'editor/ui-state.ts',
	'editor/styles/editor.css',
	'editor/styles/tokens.css',
	'editor/styles/fonts.css',
	'editor/fonts/',
	'components/Blocks.astro',
	'components/Block.astro',
	'components/RenderDocument.astro',
	'index.ts',
];

/** One broad browser file per main screen, for a CORE change (instead of all of them). */
const CORE_SET = [
	'editor.browser.test.ts', // the frame
	'navigation.browser.test.ts', // the sidebar and moving between documents
	'page-edit.browser.test.ts', // a block's fields, the overlays, click to edit
	'block-list.browser.test.ts', // the block list
	'm5a-screens.browser.test.ts', // new page, collections, Site Settings, delete
	'media-editor.browser.test.ts', // the library
	'm6-editor.browser.test.ts', // the inbox, Search and sharing
	'live-editor.browser.test.ts', // live mode
];

/** Whenever src/ changed: the editor opens, and you can move around it. */
const SMOKE = ['editor.browser.test.ts', 'navigation.browser.test.ts'];

/** Helpers nearly every test imports: a fixture named in one is opted into by name, so not followed. */
const HUBS = ['dev-site', 'live-site'];

/** Changes that need no browser test: pnpm check and the unit tests cover them. */
const QUIET = ['editor/types.ts', 'editor/tsconfig.json', 'editor/README.md'];

/** How the editor looks: any of these runs every visual file. */
function isLook(src: string): boolean {
	return (
		(src.startsWith('editor/') && (src.endsWith('.css') || src.endsWith('-css.ts') || src.endsWith('.tsx'))) ||
		src.startsWith('editor/fonts/') ||
		src === 'editor/client/accent-presets.ts' ||
		src === 'editor/brand.ts' ||
		src === 'lockup-css.ts'
	);
}

type Area = { area: string; src: string[]; tests: string[] };

const AREAS: Area[] = [
	{
		area: 'arrange pages and page folders',
		src: [
			'editor/client/arrange/',
			'editor/client/pane/levels/ArrangeLevel.tsx',
			'editor/styles/levels/arrange.css',
			'editor/server/arrange.ts',
			'editor/routes/arrange.ts',
			'page-folders.ts',
			'page-order.ts',
		],
		tests: ['arrange-pages*.browser.test.ts', 'page-folders.browser.test.ts', 'mockup-ap.visual.test.ts'],
	},
	{
		area: 'hand order',
		src: [
			'editor/client/collections/hand-order.ts',
			'editor/client/collections/HandOrderList.tsx',
			'editor/styles/levels/hand-order.css',
			'editor/server/collection-order.ts',
			'editor/routes/collection-order.ts',
			'collection-order.ts',
		],
		tests: ['hand-order.browser.test.ts'],
	},
	{
		area: 'collections',
		src: [
			'editor/client/collections/',
			'editor/client/pane/levels/CollectionLevel.tsx',
			'editor/styles/levels/collections.css',
			'editor/server/cards.ts',
			'relink.ts',
		],
		tests: [
			'collections-under-pages*.browser.test.ts',
			'posts-table.browser.test.ts',
			'grid.browser.test.ts',
			'polish.browser.test.ts',
			'hand-order.browser.test.ts',
		],
	},
	{
		area: 'documents (new, delete, move, the sidebar list)',
		src: [
			'editor/client/documents/',
			'editor/client/pane/levels/DocumentsLevel.tsx',
			'editor/client/pane/levels/FormLevel.tsx',
			'editor/styles/levels/documents.css',
			'editor/styles/levels/document-level.css',
			'editor/styles/levels/m5a-documents.css',
			'editor/server/create.ts',
			'editor/server/move.ts',
			'editor/server/write.ts',
			'editor/server/empty-site.ts',
			'editor/routes/create.ts',
			'editor/routes/delete.ts',
			'editor/routes/move.ts',
			'editor/routes/write.ts',
			'editor/routes/document.ts',
			'editor/routes/documents.ts',
			'held.ts',
		],
		tests: [
			'm5a-screens.browser.test.ts',
			'm5a-live.browser.test.ts',
			'untitled-documents.browser.test.ts',
			'preview-switch.browser.test.ts',
			'collections-under-pages.browser.test.ts',
			'm9-hidden.browser.test.ts',
			'mockup-m5a.visual.test.ts',
		],
	},
	{
		area: 'the block list and the block level',
		src: [
			'editor/client/block-list/',
			'editor/client/pane/levels/BlockLevel.tsx',
			'editor/client/pane/levels/DocumentLevel.tsx',
			'block-runs.ts',
			'cards.ts',
			'columns.ts',
			'components/BlockRunTree.astro',
		],
		tests: [
			'block-list.browser.test.ts',
			'block-allow-list.browser.test.ts',
			'card-run.browser.test.ts',
			'm9-cards.browser.test.ts',
			'review-gaps-states.browser.test.ts',
			'group-lockup.browser.test.ts',
		],
	},
	{
		area: 'fields',
		src: [
			'editor/client/fields/',
			'editor/styles/levels/fields.css',
			'fields.ts',
			'text-styles.ts',
			'lockup-css.ts',
		],
		tests: [
			'fields.browser.test.ts',
			'group-field.browser.test.ts',
			'group-lockup.browser.test.ts',
			'lockup-edges.browser.test.ts',
			'nested-list.browser.test.ts',
			'alt-from.browser.test.ts',
			'posts-table.browser.test.ts',
			'page-edit.browser.test.ts',
			'untitled-documents.browser.test.ts',
		],
	},
	{
		area: 'rich text on the page',
		src: [
			'editor/client/fields/rich-text',
			'editor/client/fields/RichTextField.tsx',
			'editor/client/overlays/rich-text-bar.ts',
			'editor/client/preview/page-editor',
			'editor/client/preview/field-text.ts',
			'rich-text.ts',
			'heading-ids.ts',
			'components/RichText.astro',
		],
		tests: ['page-rich-text-*.browser.test.ts', 'page-editor-spike.browser.test.ts', 'mockup-rt.visual.test.ts'],
	},
	{
		area: 'media and files',
		src: [
			'editor/client/media/',
			'editor/client/pane/levels/MediaLevel.tsx',
			'editor/client/pane/levels/FileLevel.tsx',
			'editor/client/fields/MediaField.tsx',
			'editor/styles/levels/media.css',
			'editor/styles/levels/files.css',
			'editor/server/media/',
			'editor/server/replace.ts',
			'editor/routes/media.ts',
			'media.ts',
			'media-value.ts',
			'files.ts',
			'files-route.ts',
			'components/Media.astro',
			'components/MediaPlayer.astro',
			'components/media-player.ts',
			'components/media-props.ts',
		],
		tests: [
			'media-*.browser.test.ts',
			'alt-from.browser.test.ts',
			'files.browser.test.ts',
			'grid.browser.test.ts',
			'mockup-m5b.visual.test.ts',
		],
	},
	{
		area: 'forms and the inbox',
		src: [
			'forms/',
			'components/Form.astro',
			'components/FormEnd.astro',
			'components/FormRowsScript.astro',
			'components/form-client.ts',
			'components/form-rows-client.ts',
			'editor/client/inbox/',
			'editor/client/pane/levels/SubmissionsLevel.tsx',
			'editor/client/pane/levels/FormWords.tsx',
			'editor/styles/levels/form-words.css',
			'editor/routes/submissions.ts',
			'editor/zone-name.ts',
			'email.ts',
		],
		tests: [
			'form-*.browser.test.ts',
			'm6-editor.browser.test.ts',
			'review-gaps-states.browser.test.ts',
			'mockup-m6.visual.test.ts',
		],
	},
	{
		area: 'Site Settings',
		src: ['editor/server/settings.ts', 'editor/client/pane/levels/SettingsM6.tsx', 'editor/client/accent-presets.ts', 'editor/brand.ts'],
		tests: ['m6-editor.browser.test.ts', 'media-alt.browser.test.ts', 'm5a-screens.browser.test.ts', 'mockup-m6.visual.test.ts'],
	},
	{
		area: 'live mode',
		src: [
			'live/',
			'editor/client/live/',
			'editor/client/state/live.ts',
			'editor/client/state/keeper.ts',
			'editor/styles/levels/live.css',
			'editor/server/mode.ts',
			'editor/server/drafts-store.ts',
			'editor/routes/_live.ts',
			'editor/routes/lock.ts',
			'editor/routes/publish.ts',
			'editor/routes/discard.ts',
			'editor/routes/history.ts',
			'editor/routes/notice.ts',
			'editor/routes/try-again.ts',
			'editor/routes/status.ts',
			'editor/routes/github.ts',
			'editor/routes/login/',
		],
		tests: [
			'live-*.browser.test.ts',
			'*-live.browser.test.ts',
			'discard.browser.test.ts',
			'github-access-note.browser.test.ts',
			'redis-diet-*.browser.test.ts',
			'untitled-documents.browser.test.ts',
			'mockup-m4.visual.test.ts',
			'chrome-live*.visual.test.ts',
		],
	},
	{
		area: 'the preview and editing on the page',
		src: [
			'editor/client/preview/',
			'editor/client/overlays/',
			'editor/routes/preview.astro',
			'editor/server/render.tsx',
			'components/attributes.ts',
			'components/descriptor.ts',
			'components/Text.astro',
			'components/Lockup.astro',
			'components/Link.astro',
			'components/Buttons.astro',
			'links.ts',
			'vivid.ts',
		],
		tests: [
			'page-edit.browser.test.ts',
			'morph-and-select.browser.test.ts',
			'follow-links.browser.test.ts',
			'preview-rendered.browser.test.ts',
			'preview-switch.browser.test.ts',
			'card-run.browser.test.ts',
			'm9-editor.browser.test.ts',
			'media-empty.browser.test.ts',
			'review-gaps-states.browser.test.ts',
			'lockup-edges.browser.test.ts',
		],
	},
	{
		area: 'edit in context',
		src: [
			'editor/client/pane/FromPage.tsx',
			'editor/client/pane/from-page.ts',
			'editor/client/overlays/source-marks.ts',
			'editor/styles/levels/edit-in-context.css',
			'editor/server/slot-default.ts',
			'editor/routes/slot-default.ts',
			'slots.ts',
			'components/Slot.astro',
		],
		tests: ['edit-in-context*.browser.test.ts'],
	},
	{
		area: 'navigation, search and the switcher',
		src: ['editor/client/nav/', 'editor/client/pane/switcher.tsx', 'editor/styles/levels/switcher.css'],
		tests: ['navigation.browser.test.ts', 'page-folders.browser.test.ts', 'm9-hidden.browser.test.ts', 'polish.browser.test.ts'],
	},
	{
		area: 'a site\'s config and how /admin is built into it',
		src: ['config.ts', 'content-schema.ts', 'index.ts', 'editor/routes/admin.astro'],
		tests: [
			'port-readiness.browser.test.ts',
			'block-allow-list.browser.test.ts',
			'nested-list.browser.test.ts',
			'admin-react.browser.test.ts',
		],
	},
];

// ---------------------------------------------------------------------------------------

const testDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(testDir);
const args = process.argv.slice(2);
const run = args.includes('--run');
const base = args.find((a) => !a.startsWith('--'));
if (!base) {
	console.error('Usage: pnpm --filter caracms test:pick <base> [--run]   (base: a commit, e.g. main)');
	process.exit(2);
}

const git = (...a: string[]) => execFileSync('git', a, { cwd: pkgDir, encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
// `<base>` diffs against the working tree (with untracked files); `<base>..<head>` diffs a range.
// Each entry is [status, path]: A added, M modified, D deleted (a rename is a delete and an add).
const changed: [string, string][] = [];
for (const line of git('diff', '--name-status', base).split('\n').filter(Boolean)) {
	const [status, a, b] = line.split('\t');
	if (status.startsWith('R')) changed.push(['D', a], ['A', b]);
	else changed.push([status[0], a]);
}
if (!base.includes('..')) {
	for (const f of git('ls-files', '--others', '--exclude-standard', '--full-name').split('\n').filter(Boolean)) changed.push(['A', f]);
}
const pkgPrefix = pkgDir.slice(root.length + 1) + '/'; // packages/caracms/

const allTests = readdirSync(testDir).sort();
const browserFiles = allTests.filter((f) => f.endsWith('.browser.test.ts'));
const visualFiles = allTests.filter((f) => f.endsWith('.visual.test.ts'));

const toRegex = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const expand = (patterns: string[]) => allTests.filter((f) => patterns.some((p) => toRegex(p).test(f)));
const under = (src: string, prefixes: string[]) => prefixes.some((p) => src.startsWith(p));

const browser = new Map<string, string>(); // file → why
const visual = new Map<string, string>();
const pick = (file: string, why: string) => {
	const into = file.endsWith('.browser.test.ts') ? browser : file.endsWith('.visual.test.ts') ? visual : null;
	if (into && !into.has(file)) into.set(file, why);
};

let srcChanged = false;
let starter = false;
let full = '';
const notes: string[] = [];

for (const [status, path] of changed) {
	if (path.startsWith('starter/')) starter = true;
	if (!path.startsWith(pkgPrefix)) continue;
	const rel = path.slice(pkgPrefix.length); // src/…, test/…
	if (rel.startsWith('src/')) {
		const src = rel.slice(4);
		if (src.endsWith('.md') || under(src, QUIET)) continue;
		srcChanged = starter = true;
		const areas = AREAS.filter((a) => under(src, a.src));
		for (const a of areas) for (const f of expand(a.tests)) pick(f, `${a.area} (${src})`);
		const core = under(src, CORE) || (areas.length === 0 && (src.startsWith('editor/') || src.startsWith('components/')));
		if (core) {
			if (!under(src, CORE)) notes.push(`${src} is in no row, so it counts as core: give it an area or add it to CORE or QUIET`);
			for (const f of CORE_SET) pick(f, `core (${src})`);
		}
		if (isLook(src)) for (const f of visualFiles) pick(f, `the look (${src})`);
	} else if (rel.startsWith('test/')) {
		const name = rel.slice(5);
		const fixture = name.startsWith('fixtures/') ? name.split('/')[1] : '';
		const pinned = fixture === 'demo-content' || fixture === 'demo-site';
		if (/^fixtures\/[^/]+\/schemas\//.test(name)) {
			// Generated from src (cli/schemas.ts): the src change that made it picks.
		} else if (fixture === 'demo-content' || (fixture === 'demo-site' && status !== 'A')) {
			// Every browser and visual test runs on these: a new page shows in every list, an edit anywhere.
			full ||= `the pinned demo every browser test runs on changed (${name})`;
		} else if (fixture) {
			// A new file in the demo site (a config a test opts into): the tests that name it.
			// Another fixture: the tests that name its folder.
			for (const f of namers(pinned ? basename(name).replace(/\.[^.]+$/, '') : fixture)) pick(f, `uses ${name}`);
		} else if (name.endsWith('.browser.test.ts') || name.endsWith('.visual.test.ts')) {
			if (existsSync(join(testDir, name))) pick(name, 'changed in this diff');
		} else if (name.startsWith('helpers/') || name.startsWith('mockup-diff')) {
			// A helper or a mockup-diff: the tests that name it, through a helper one hop.
			// A hub (dev-site.ts, live-site.ts) picks nearly every file: setup a few tests opt
			// into belongs in a helper of its own.
			for (const f of namers(basename(name).replace(/\.ts$/, ''))) pick(f, `uses ${name}`);
		}
	}
}

/** The browser and visual tests that name `key`, directly or through a helper (one hop, not a hub). */
function namers(key: string): string[] {
	const files = [...browserFiles, ...visualFiles];
	const helpers = readdirSync(join(testDir, 'helpers'))
		.map((h) => `helpers/${h}`)
		.concat(allTests.filter((f) => f.startsWith('mockup-diff') && f.endsWith('.ts')));
	const read = (f: string) => readFileSync(join(testDir, f), 'utf8');
	const viaHelpers = helpers
		.filter((h) => read(h).includes(key))
		.map((h) => basename(h).replace(/\.ts$/, ''))
		.filter((h) => h !== key && !HUBS.includes(h));
	return files.filter((f) => {
		const text = read(f);
		return text.includes(key) || viaHelpers.some((h) => text.includes(h));
	});
}

if (srcChanged) for (const f of SMOKE) pick(f, 'smoke: src/ changed');

// Fail safe: a file no row names always runs.
const named = new Set([...CORE_SET, ...SMOKE, ...expand(AREAS.flatMap((a) => a.tests))]);
const unmapped = [...browserFiles, ...visualFiles].filter((f) => !named.has(f) && !(f.startsWith('chrome') || f.startsWith('mockup-')));
for (const f of unmapped) pick(f, 'in no row of test/pick.ts: give it one');
const stale = AREAS.flatMap((a) => a.tests).concat(CORE_SET, SMOKE).filter((p) => expand([p]).length === 0);

if (full) {
	for (const f of browserFiles) pick(f, full);
	for (const f of visualFiles) pick(f, full);
}

// ---------------------------------------------------------------------------------------

const list = (m: Map<string, string>) => [...m].sort(([a], [b]) => a.localeCompare(b));
const say = (s = '') => console.log(s);
say(`Diff from ${base}: ${changed.length} files${srcChanged ? '' : ', none under packages/caracms/src'}`);
if (full) say(`Full run: ${full}`);
say();
say(`Browser: ${browser.size} of ${browserFiles.length} files`);
for (const [f, why] of list(browser)) say(`  ${f}  — ${why}`);
say(`Visual: ${visual.size} of ${visualFiles.length} files`);
for (const [f, why] of list(visual)) say(`  ${f}  — ${why}`);
say(`Starter: ${starter ? 'yes' : 'no'}`);
say();
const skippedB = browserFiles.length - browser.size;
const skippedV = visualFiles.length - visual.size;
if (skippedB || skippedV) {
	say(`Skipped: ${skippedB} browser and ${skippedV} visual files, outside what this diff touched.`);
	say('The full run (pnpm --filter caracms test) is for an npm publish, or when one is asked for.');
}
for (const n of notes) say(`Note: ${n}`);
if (unmapped.length) say(`Note: ${unmapped.length} test file(s) in no row always run until they get one: ${unmapped.join(', ')}`);
if (stale.length) say(`Note: these patterns in test/pick.ts match no test file (stale?): ${stale.join(', ')}`);

const commands: string[][] = [];
const files = (m: Map<string, string>) => list(m).map(([f]) => `test/${f}`);
if (browser.size) commands.push(['node', '--test', '--experimental-strip-types', '--test-concurrency=2', ...files(browser)]);
if (visual.size) commands.push(['node', '--test', '--experimental-strip-types', '--test-concurrency=3', ...files(visual)]);
say();
say('Run (from packages/caracms):');
for (const c of commands) say(`  ${c.join(' ')}`);
if (starter) say('  pnpm --filter caracms-starter test');
if (!commands.length && !starter) say('  nothing');

if (run) {
	let failed = false;
	for (const c of commands) failed = spawnSync(c[0], c.slice(1), { cwd: pkgDir, stdio: 'inherit' }).status !== 0 || failed;
	if (starter) failed = spawnSync('pnpm', ['--filter', 'caracms-starter', 'test'], { cwd: pkgDir, stdio: 'inherit' }).status !== 0 || failed;
	process.exit(failed ? 1 : 0);
}
