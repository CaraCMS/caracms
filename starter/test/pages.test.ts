// The example pages and the blocks' empty slots (M7 Decisions 10, 12 and 19; Acceptance
// 24–27; Exit step 4), on the starter's pinned content (test/fixtures/content).
//
// - Acceptance 24: every block type is on at least one example page.
// - Acceptance 25: no Photo background, no footer block or shared footer; the shared call
//   to action ends Home, About, Work and Contact.
// - Acceptance 26: /faq's answers open and close with no script; /privacy renders; an
//   unknown address answers with the starter's 404 page (the built server, status 404).
// - Acceptance 27: an empty slot never leaves a hole (rendered through Astro's container).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import config from '../caracms.config.ts';
import { builtRoot, readHtml, serveClient } from './helpers/dist.ts';
import { count, fixtureContent, pinnedSite, startRenderer, type Renderer } from './helpers/render.ts';

const json = (file: string) => JSON.parse(readFileSync(join(fixtureContent, file), 'utf8'));
const pageFiles = (dir = join(fixtureContent, 'pages'), prefix = 'pages'): string[] =>
	readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? pageFiles(join(dir, name), `${prefix}/${name}`) : name.endsWith('.json') ? [`${prefix}/${name}`] : []));

/** Each page's blocks, a shared entry standing for the block it holds. */
const pageBlocks = () =>
	pageFiles().map((file) => ({
		file,
		blocks: (json(file).blocks as Record<string, unknown>[]).map((b) => (typeof b.shared === 'string' ? { ...json(`shared/${b.shared}.json`).block, shared: b.shared } : b)),
	}));

describe('the example content', () => {
	test('Acceptance 24: every block type is on at least one example page', () => {
		const used = new Set(pageBlocks().flatMap((p) => p.blocks.map((b) => b.type as string)));
		// Edit in context, Decision 16: the header and footer fill the page's slots, never its body.
		const types = Object.keys(config.blocks).filter((t) => !(config.blocks as Record<string, { slot?: string }>)[t]!.slot);
		assert.ok(types.length >= 12, types.join(', '));
		assert.deepEqual(
			types.filter((t) => !used.has(t)),
			[],
			'blocks no example page uses',
		);
	});

	test('Acceptance 25: no Photo background and no footer in a page\'s blocks (the footer is its slot\'s default); the shared call to action is on Home, About, Work and Contact', () => {
		const text = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? text(join(dir, n)) : [readFileSync(join(dir, n), 'utf8')]));
		const all = text(fixtureContent).join('\n');
		assert.doesNotMatch(all, /"background": "photo"/);
		assert.doesNotMatch(all, /"type": "footer"|"shared": "footer"|"shared": "header"/);
		// Edit in context, Decision 16 (replacing M7 Decision 12): the header and footer are shared blocks, their slots' defaults.
		assert.deepEqual([json('shared/header.json').block.type, json('shared/header.json').default], ['siteHeader', true]);
		assert.deepEqual([json('shared/footer.json').block.type, json('shared/footer.json').default], ['siteFooter', true]);
		const withCta = pageBlocks()
			.filter((p) => p.blocks.some((b) => b.shared === 'start-a-project'))
			.map((p) => p.file)
			.sort();
		assert.deepEqual(withCta, ['pages/about.json', 'pages/contact.json', 'pages/index.json', 'pages/work.json']);
		assert.equal(json('shared/start-a-project.json').block.type, 'cta');
	});
});

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

describe('Acceptance 26: Questions, Privacy and the 404', () => {
	let browser: Browser;
	let origin: string;
	let close: () => void;
	let server: ChildProcess | null = null;
	before(async () => {
		const served = await serveClient();
		origin = served.origin;
		close = () => served.server.close();
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		close?.();
		server?.kill();
	});

	test('/faq: each answer is a <details>, the first open; with scripts off, a click opens and closes each one', async () => {
		const context = await browser.newContext({ javaScriptEnabled: false });
		const page = await context.newPage();
		await page.route((url) => !url.href.startsWith(origin), (route) => route.abort());
		await page.goto(`${origin}/faq`);
		const details = page.locator('main details');
		const n = await details.count();
		assert.ok(n >= 3, String(n));
		assert.deepEqual(await details.evaluateAll((ds) => ds.map((d) => (d as HTMLDetailsElement).open)), [true, ...Array(n - 1).fill(false)]);
		for (let i = 0; i < n; i++) {
			const summary = details.nth(i).locator('summary');
			const was = await details.nth(i).evaluate((d) => (d as HTMLDetailsElement).open);
			await summary.click();
			assert.equal(await details.nth(i).evaluate((d) => (d as HTMLDetailsElement).open), !was, `answer ${i} toggled`);
			await summary.click();
			assert.equal(await details.nth(i).evaluate((d) => (d as HTMLDetailsElement).open), was, `answer ${i} back`);
		}
		await context.close();
	});

	test('/privacy renders: its heading is the page\'s one h1, and its text has headings and lists', () => {
		const html = readHtml('/privacy');
		assert.equal(count(html, /<h1[\s>]/g), 1);
		assert.match(html, /<h1[^>]*>Privacy policy<\/h1>/);
		assert.match(html, /<h2 id="what-we-collect">What we collect<\/h2>/);
		assert.match(html, /<ul>/);
	});

	test('an unknown address answers 404 with the starter\'s page, in the shell, from the built server', async () => {
		const port = await freePort();
		server = spawn(process.execPath, [join(builtRoot, 'dist/server/entry.mjs')], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
		let response: Response | null = null;
		for (let i = 0; i < 50 && !response; i++) {
			response = await fetch(`http://127.0.0.1:${port}/a-page-that-was-never-made`).catch(() => null);
			if (!response) await new Promise((r) => setTimeout(r, 100));
		}
		assert.ok(response, 'the server answered');
		assert.equal(response.status, 404);
		const html = await response.text();
		assert.match(html, /<title>Page not found · CaraCMS<\/title>/);
		assert.match(html, /<p class="eyebrow[^"]*">Error 404<\/p>/);
		assert.match(html, /isn’t here\./);
		assert.match(html, /data-site-header/);
		assert.match(html, /data-site-footer/);
		assert.match(html, /<a href="\/" class="btn btn--primary">/);
	});
});

describe('Acceptance 27: an empty slot never leaves a hole', () => {
	const demo = pinnedSite('empty-slots');
	let r: Renderer;
	let site: any;
	let parseDocumentText: (text: string, site: unknown) => { document: any };
	before(async () => {
		r = await startRenderer(demo.root);
		({ site } = await r.load('virtual:caracms/config'));
		({ parseDocumentText } = await r.load('caracms/document'));
	});
	after(async () => {
		await r?.close();
		demo.close();
	});
	const render = (blocks: unknown[]) =>
		r.page('caracms/components/RenderDocument.astro', { document: parseDocumentText(JSON.stringify({ title: 'Test', blocks }), site).document, collection: 'pages' });
	const main = (html: string) => /<main[^>]*>([\s\S]*)<\/main>/.exec(html)![1]!;

	test('a Card with no media is a text card: no frame, no image, its heading and text still there', async () => {
		const html = main(await render([{ type: 'cards', heading: 'Cards', items: [{ heading: 'Words only', text: 'No picture.' }] }]));
		assert.match(html, /<h3 class="text-h4">Words only<\/h3>/);
		assert.doesNotMatch(html, /<img|<video|class="frame/);
	});

	test('Full-width media with nothing in it renders nothing (a block beside it still does)', async () => {
		const html = main(await render([{ type: 'media' }, { type: 'text', heading: 'After it' }]));
		assert.equal(count(html, /<section/g), 1);
		assert.match(html, /After it/);
	});

	test('a hero with no media behind its text is a plain hero: its Background, no scrim, no media', async () => {
		const html = main(await render([{ type: 'hero', heading: ['A plain', 'hero'], intro: 'No picture.', background: 'grey' }]));
		assert.match(html, /<section class="band scheme-grey /);
		assert.doesNotMatch(html, /hero--behind|hero-scrim|scheme-media|<img|<video/);
		assert.match(html, /<h1[^>]*class="cms-lockup"/);
	});
});
