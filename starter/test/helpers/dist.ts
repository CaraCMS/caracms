/**
 * The built demo for the build-output and wrap tests: a copy of the starter with the
 * pinned content (render.ts's `pinnedSite`), built here, once per test file (about a
 * second), so they check the demo's documents as pinned and need no `pnpm build`
 * first. Also: its resolved site, loaded from caracms.config.ts in plain Node, and a
 * tiny static server over its dist/client for the browser tests.
 *
 * `buildCopy` builds other copies the same way, changed first (M7: the look tests' copies,
 * one with the second look swapped in).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'astro';
import { resolveSite, type ResolvedSite } from 'caracms/config';
import { pinnedSite } from './render.ts';

/**
 * Fake media variables (M5b Decision 5): the pinned content has images, and a build that
 * renders one without them fails. Made up: the tests never fetch an image.
 */
export const FAKE_MEDIA_ENV = {
	CARACMS_MEDIA_URL: 'https://img.example.test',
	IMGPROXY_KEY: '6275696c642d746573742d6b6579',
	IMGPROXY_SALT: '6275696c642d746573742d73616c74',
	S3_BUCKET: 'test-media',
};
Object.assign(process.env, FAKE_MEDIA_ENV);
/** M6 Decision 3: the built demo's address, so its pages have canonical links and it has a sitemap. */
export const SITE_URL = 'https://site.test';
process.env.SITE_URL = SITE_URL;

export interface BuiltCopy {
	root: string;
	client: string;
	/** The copy's own resolved site (its config imports its own text styles). */
	site: ResolvedSite;
}

/** A pinned copy of the starter, changed by `edit`, built, and deleted when the process exits. */
export async function buildCopy(name: string, edit?: (root: string) => void): Promise<BuiltCopy> {
	const copy = pinnedSite(name);
	process.on('exit', () => copy.close());
	edit?.(copy.root);
	await build({ root: copy.root, logLevel: 'error' });
	const { default: config } = await import(pathToFileURL(join(copy.root, 'caracms.config.ts')).href);
	return { root: copy.root, client: join(copy.root, 'dist/client'), site: resolveSite(config, copy.root) };
}

const built = await buildCopy('dist');

/** The built copy's root (its content is the pinned demo's). */
export const builtRoot = built.root;
export const client = built.client;

export const site = built.site;

/** Every file under dist/client, relative, `/`-separated. */
export function clientFiles(dir = client, prefix = ''): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		const rel = prefix ? `${prefix}/${name}` : name;
		return statSync(path).isDirectory() ? clientFiles(path, rel) : [rel];
	});
}

/** The built HTML file for a URL path (`/` → index.html, `/about` → about/index.html). */
export const htmlFor = (url: string) => join(client, url === '/' ? 'index.html' : `${url.replace(/^\//, '')}/index.html`);
export const readHtml = (url: string) => readFileSync(htmlFor(url), 'utf8');

const types: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.woff2': 'font/woff2',
	'.ico': 'image/x-icon',
	'.css': 'text/css',
	// M7: the site's own module (motion and the menu) runs in the browser tests.
	'.js': 'text/javascript',
};

/** Serve a dist/client (the plain build's by default) on a free port, as the Node adapter would serve the prerendered pages. */
export async function serveClient(dir = client): Promise<{ origin: string; server: Server }> {
	const server = createServer((req, res) => {
		const url = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
		let file = normalize(join(dir, url));
		if (!file.startsWith(dir)) return void res.writeHead(400).end();
		if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
		if (!existsSync(file)) return void res.writeHead(404).end();
		res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('no port');
	return { origin: `http://127.0.0.1:${address.port}`, server };
}
