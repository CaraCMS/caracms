/**
 * A throwaway copy of the demo site (its code pinned: `demoSite`; its content pinned: `demoContent`)
 * running under `astro dev` on a free port, for the editor's browser tests. The copy
 * lives in test/.tmp/ (ignored), so the editor's writes never touch the starter's
 * content, and it can be stopped and started again on the same port (Phase 2 → Verify 3).
 *
 * The copy has `node_modules/caracms` linked to this package, so its config and
 * components resolve `caracms/*` as the starter does; `astro` resolves from this
 * package's own dependencies. The Astro config is passed inline (the starter's
 * astro.config.mjs needs the Node adapter, which dev doesn't, so the fixture has none).
 *
 * Headless Chromium comes from Playwright's cache (playwright-core 1.63.0 →
 * chromium 1243), as in starter/test/wraps.test.ts. Without it the tests skip.
 * WebKit (standing in for Safari; the page editor's spike runs in both) installs with
 * `npx playwright-core install webkit`; without it, `webkitSkip` says so.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright-core';
import { addRowsContent } from './rows-content.ts';

export const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
/** The real starter: only for the tests of its build (starter/dist), never its code. */
export const starter = fileURLToPath(new URL('../../../../starter', import.meta.url));
/**
 * The demo site's code as the browser and visual tests expect it: starter/'s src, public,
 * caracms.config.ts and tsconfig.json before M7 rewrote its blocks (M7 Decision 1). Frozen
 * with `demoContent` as the pre-M7 demo; a package feature that needs a new block for its
 * tests adds it here.
 */
export const demoSite = fileURLToPath(new URL('../fixtures/demo-site', import.meta.url));
/**
 * The demo's content as the browser tests expect it (starter/content at M5a Phase 2).
 * The demo's own content moves: a Publish from its editor commits to `main` (the
 * Exit walk added Visit and Kitchen pottery and deleted Print), and tests that create Visit
 * or delete Print then wait out a 30 s click on something that's already there or gone.
 * The copy takes its config and components from `demoSite` and its content from here.
 */
export const demoContent = fileURLToPath(new URL('../fixtures/demo-content', import.meta.url));

export const browserSkip: string | false = existsSync(chromium.executablePath())
	? false
	: `Playwright's Chromium isn't installed (${chromium.executablePath()})`;

export const webkitSkip: string | false = existsSync(webkit.executablePath())
	? false
	: `Playwright's WebKit isn't installed (${webkit.executablePath()}): run \`npx playwright-core install webkit\` in packages/caracms. WebKit was NOT tested.`;

/** The browsers a test can run in, with why each would be skipped (false: it runs). */
export const browsers = [
	{ name: 'chromium', type: chromium, skip: browserSkip },
	{ name: 'webkit', type: webkit, skip: webkitSkip },
] as const;

/**
 * Edit in context, Decision 16: the fixture's footer fills the page's footer slot, so no page lists
 * it. For a test about a shared block placed in a page's body (selecting it, "Edit Footer (used on
 * N pages)", following its links, the picker's Shared section, a delete naming its uses), this puts
 * a copy back as it was before the move: the footer a plain block type (no `slot`, no `default`),
 * placed last on Home, About, Work and Contact. Pass it as (or call it from) `startDevSite`'s `edit`.
 */
/**
 * Form rows and sourced selects: a dev site's `edit` that runs it on `caracms.rows.config.ts` (the
 * fixture's config plus the `workshops` collection and the `booking` form): the copy's own config
 * becomes the base the rows config builds on, and `caracms.config.ts` re-exports the rows one.
 */
export function useRowsConfig(root: string): void {
	renameSync(join(root, 'caracms.config.ts'), join(root, 'caracms.base.config.ts'));
	writeFileSync(join(root, 'caracms.rows.config.ts'), readFileSync(join(demoSite, 'caracms.rows.config.ts'), 'utf8').replace("from './caracms.config.ts'", "from './caracms.base.config.ts'"));
	writeFileSync(join(root, 'caracms.config.ts'), "export { default } from './caracms.rows.config.ts';\n");
	addRowsContent(root);
}

export function footerInBody(root: string): void {
	const config = join(root, 'src/blocks/footer.ts');
	const text = readFileSync(config, 'utf8');
	if (!text.includes("\tslot: 'footer',\n")) throw new Error("the fixture's footer.ts has changed: update footerInBody");
	writeFileSync(config, text.replace("\tslot: 'footer',\n", ''));
	footerInBodyContent(root);
}

/**
 * The content half of `footerInBody`, for a harness that puts the pinned content back between runs
 * (mockup-diff.ts) on a site whose config `footerInBody` already changed.
 */
export function footerInBodyContent(root: string): void {
	const shared = join(root, 'content/shared/footer.json');
	writeFileSync(shared, readFileSync(shared, 'utf8').replace('  "default": true,\n', ''));
	for (const page of ['index', 'about', 'work', 'contact']) {
		const file = join(root, `content/pages/${page}.json`);
		const page_ = readFileSync(file, 'utf8');
		// The end of its top-level `blocks` list (a `seo` may follow it).
		const at = page_.indexOf('\n  ]', page_.indexOf('"blocks": ['));
		if (at === -1) throw new Error(`content/pages/${page}.json: no blocks list to add the footer to`);
		writeFileSync(file, `${page_.slice(0, at)},\n    { "shared": "footer" }${page_.slice(at)}`);
	}
}

export interface DevSite {
	root: string;
	origin: string;
	port: number;
	/** A file in the copy, relative to its root. */
	read(file: string): string;
	write(file: string, text: string): void;
	/** Stop the dev server (the copy stays). */
	stop(): Promise<void>;
	/** Start it again on the same port. */
	start(): Promise<void>;
	/** What the dev server's file watcher watches: folder → the names in it it watches. */
	watched(): Record<string, string[]>;
	/** Stop and delete the copy. */
	close(): Promise<void>;
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
		});
	});
}

/** `edit` changes the copy before the server starts (its config, say); the fixture is never touched. */
export async function startDevSite(name: string, options: { edit?: (root: string) => void } = {}): Promise<DevSite> {
	const root = join(packageRoot, 'test/.tmp', `${name}-${process.pid}`);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	// Never a .env: the integration loads its media variables (M5b Decision 5), and tests never use the live ones.
	for (const part of ['src', 'public', 'caracms.config.ts', 'tsconfig.json']) {
		cpSync(join(demoSite, part), join(root, part), { recursive: true });
	}
	cpSync(demoContent, join(root, 'content'), { recursive: true });
	mkdirSync(join(root, 'node_modules'), { recursive: true });
	symlinkSync(packageRoot, join(root, 'node_modules/caracms'), 'dir');
	writeFileSync(join(root, 'package.json'), '{ "name": "caracms-editor-test-site", "private": true, "type": "module" }\n');
	options.edit?.(root);

	// A fresh copy has never checked for an Astro update, so `astro dev` asks npm, then writes
	// .astro/settings.json, which is on its own restart list: when the watcher reports that
	// write twice, the server restarts under the first requests (connection refused,
	// "transport was disconnected"). Tests don't need the check.
	process.env.ASTRO_DISABLE_UPDATE_CHECK = 'true';
	const { default: caracms } = await import('../../src/index.ts');
	const { default: config } = await import(pathToFileURL(join(root, 'caracms.config.ts')).href);
	const { dev } = await import('astro');
	const port = await freePort();
	let server: Awaited<ReturnType<typeof dev>> | null = null;

	const start = async () => {
		server = await dev({
			root,
			configFile: false,
			logLevel: 'error',
			integrations: [caracms(config)],
			devToolbar: { enabled: false },
			server: { port, host: '127.0.0.1' },
			vite: { server: { strictPort: true }, logLevel: 'error' },
		});
	};
	await start();

	return {
		root,
		origin: `http://127.0.0.1:${port}`,
		port,
		read: (file) => readFileSync(join(root, file), 'utf8'),
		write: (file, text) => writeFileSync(join(root, file), text),
		async stop() {
			await server?.stop();
			server = null;
		},
		start,
		watched() {
			const watcher = server?.watcher as unknown as { getWatched(): Record<string, string[]> } | undefined;
			return watcher ? watcher.getWatched() : {};
		},
		async close() {
			await server?.stop();
			server = null;
			rmSync(root, { recursive: true, force: true });
		},
	};
}
