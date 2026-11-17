// M8 Acceptance 25 (Decision 20): the look-the-same script, given two addresses and a page
// list, writes one side-by-side page with a difference score per page at both widths, and
// leaves the site's package.json and lockfile unchanged.
//
// Two tiny static sites are served from node:http: `/` looks identical on both and its HTML
// differs only in what the HTML diff normalises away (an asset hash, Astro's
// data-astro-cid-*, whitespace between tags, attribute order); `/changed` has a different
// heading; `/attribute` looks identical but its heading's bare attribute became ="true"
// (M8 trial finding 4), which only the HTML diff can see. Round 2 of the trial: `/space` moves a
// space from the end of a <span>'s text to between </span> and <em> (it renders the same, so 0
// lines); `/lost` really loses one (it shows); `/order` writes <head>'s children in another order
// (not a difference) and swaps two paragraphs in <body> (a difference).
//
// An adoption trial (its findings, "Where caracms and its skills fell
// short" 3), in a run of its own: `/lazy` has lazy images in a hidden element and a closed
// <details>, which never start, so they must not be waited for (the run used to hang); `/slow`
// has a lazy image far down the page that starts in the scroll-through but answers after 5 s, so
// the image wait's cap (--image-wait 1) gives up on it and says so. `/missing` answers 404 on both sides and is compared; `/only-old` answers 404 only on
// the new side, a difference, not an error. `/ignored` differs only in attributes --ignore-attr
// drops; `/ids` only in ids drawn per render, which --mask-ids masks; `/broken` has a reference
// that no longer points at its element, which still shows. The script runs with this package's own playwright-core
// (`--playwright` pointing at the package) and the machine's Chrome, from inside a stand-in
// site folder whose files must come out untouched. Skipped when Chrome isn't installed.
// `/busy` polls the server every 200 ms for ever, as a looping clip does: it never reaches
// `networkidle`, and must still be shot.
//
// A release test, not a browser test (moved 2026-11-10): it takes about 3 minutes, tests the
// adopt skill's script rather than the editor, so it runs before an npm publish, not after
// every build phase. `pnpm --filter caracms test:release`, or on its own:
//   node --test --experimental-strip-types test/look-same.release.test.ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const script = join(packageDir, 'site-skills/caracms-adopt/look-same.mjs');

let chromeSkip: string | false = false;
try {
	const browser = await chromium.launch({ channel: 'chrome' });
	await browser.close();
} catch {
	chromeSkip = "Chrome isn't installed (playwright-core's channel 'chrome'): the look-same check was NOT tested";
}

type Variant = { hash?: string; cid?: string; h1?: string; gap?: string };
const page = (heading: string, { hash = 'Ab12Cd34', cid = '', h1 = '', gap = '' }: Variant = {}) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/_astro/site.${hash}.css">
<style>body{margin:0;font:18px/1.5 sans-serif}h1{font-size:48px;margin:40px 24px}p{margin:24px}.tall{height:1600px;background:linear-gradient(#eef,#fee)}</style>
</head><body${cid}>${gap}<h1${h1}>${heading}</h1>${gap}<p>Some body text that stays the same on both sites.</p><div class="tall"></div><p>The end.</p></body></html>`;

const small = (head: string, body: string) =>
	`<!doctype html>\n<html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const titleTags = ['<title>Home | CaraCMS</title>', '<meta name="description" content="A studio.">', '<link rel="icon" href="/favicon.svg">'];

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);
const lazy = small(
	'',
	'<p>Tabs</p><div hidden><img loading="lazy" src="/img/hidden.png" width="20" height="20" alt=""></div>' +
		'<details><summary>More</summary><img loading="lazy" src="/img/details.png" width="20" height="20" alt=""></details>',
);
const slow = small('', '<div style="height:4000px"></div><img loading="lazy" src="/slow/photo.png" width="20" height="20" alt="">');
// A smooth-scrolling page with a sticky header: the shot must find it at the top.
const smooth = small(
	'<style>html{scroll-behavior:smooth}header{position:sticky;top:0;height:60px;background:#123}</style>',
	'<header></header><div style="height:6000px;background:linear-gradient(#fff,#888)"></div>',
);
// A page whose network never goes quiet, like one with a looping Mux clip:
// it never reaches `networkidle`, so the shot must not wait for it.
const busy = small('', '<h1>Busy</h1><script>setInterval(() => fetch("/poll?" + Date.now()), 200)</script>');
const tabs = (button: string, panel: string, label: string) =>
	small(
		'',
		`<button id="${button}" aria-controls="${panel}">Tab</button><div id="${panel}" role="tabpanel" aria-labelledby="${button}">Panel</div>` +
			`<a href="#${panel}">Jump</a><label for="${label}">Name</label><input id="${label}">`,
	);

function serve(pages: Record<string, string>): Promise<Server> {
	const server = createServer((req, res) => {
		if (req.url?.startsWith('/img/')) {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end(PNG);
			return;
		}
		if (req.url?.startsWith('/slow/')) {
			setTimeout(() => {
				res.writeHead(200, { 'content-type': 'image/png' });
				res.end(PNG);
			}, 5000).unref();
			return;
		}
		if (req.url?.startsWith('/poll')) {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('ok');
			return;
		}
		if (req.url?.startsWith('/_astro/')) {
			res.writeHead(200, { 'content-type': 'text/css' });
			res.end('');
			return;
		}
		const html = pages[req.url ?? ''];
		res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
		res.end(html ?? 'not found');
	});
	return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}
const base = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Status = { old: number; new: number };
type Cap = { stillLoading: number; images: string[] };
type Result = {
	path: string;
	width: number;
	differingShare: number;
	heightDelta: number;
	error?: string;
	status?: Status;
	statusDiffers?: boolean;
	imageWait?: number;
	imageCap?: { old?: Cap; new?: Cap };
};
type HtmlResult = {
	path: string;
	differingLines: number;
	removed: number;
	added: number;
	file: string;
	error?: string;
	status?: Status;
	statusDiffers?: boolean;
};

describe('look-same', { skip: chromeSkip }, () => {
	let oldSite: Server;
	let newSite: Server;
	let work: string;
	let site: string;
	let out: string;

	before(async () => {
		oldSite = await serve({
			'/': page('Welcome to CaraCMS', { cid: ' data-astro-cid-abc12345', h1: ' id="top" class="big  title"' }),
			'/changed': page('Our team'),
			'/attribute': page('Welcome to CaraCMS', { h1: ' data-hero' }),
			'/space': small('', '<p><span>sub </span><em>title</em></p>'),
			'/lost': small('', '<p><span>sub</span> <em>title</em></p>'),
			'/order': small(titleTags.join(''), '<p>One</p><p>Two</p>'),
			'/lazy': lazy,
			'/slow': slow,
			'/only-old': small('', '<p>Here</p>'),
			'/ignored': small('', '<h1 data-tina-field="hero.title" data-vivid-id="a1">Hi</h1>'),
			'/ids': tabs('sp-q9w8e7', 'st-a1b2c3', 'sp-k1x2c3'),
			'/broken': tabs('sp-q9w8e7', 'st-a1b2c3', 'sp-k1x2c3'),
			'/smooth': smooth,
			'/busy': busy,
		});
		newSite = await serve({
			'/': page('Welcome to CaraCMS', {
				hash: 'Zz98Yx76',
				cid: ' data-astro-cid-x9y8z7w6',
				h1: " class='big title' id=\"top\"",
				gap: '\n    ',
			}),
			'/changed': page('Meet the whole crew today'),
			'/attribute': page('Welcome to CaraCMS', { h1: ' data-hero="true"' }),
			'/space': small('', '<p><span>sub</span> <em>title</em></p>'),
			'/lost': small('', '<p><span>sub</span><em>title</em></p>'),
			'/order': small([...titleTags].reverse().join('\n  '), '<p>Two</p><p>One</p>'),
			'/lazy': lazy,
			'/slow': slow,
			'/ignored': small('', '<h1 data-tina-field="0.blocks.hero.title" data-tina-island data-vivid-id="z9">Hi</h1>'),
			// The button, the panel and the label's input are written in another attribute order too.
			'/ids': tabs('sp-m3n4b5', 'st-z9y8x7', 'sp-r5t6y7').replace('id="sp-m3n4b5" aria-controls', 'aria-controls').replace('>Tab', ' id="sp-m3n4b5">Tab'),
			// The button's aria-controls points at an id the panel no longer has.
			'/broken': tabs('sp-m3n4b5', 'st-z9y8x7', 'sp-r5t6y7').replace('aria-controls="st-z9y8x7"', 'aria-controls="st-0ld1d2"'),
			'/smooth': smooth,
			'/busy': busy,
		});
		work = mkdtempSync(join(tmpdir(), 'look-same-test-'));
		site = join(work, 'site');
		out = join(work, 'report');
		mkdirSync(site);
		writeFileSync(join(site, 'package.json'), '{"name":"a-site"}\n');
		writeFileSync(join(site, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
		writeFileSync(join(site, 'pages.txt'), '# the pages\n/\n\nchanged\nattribute\nspace\nlost\norder\n');
	});

	after(() => {
		oldSite?.closeAllConnections();
		newSite?.closeAllConnections();
		oldSite?.close();
		newSite?.close();
		if (work) rmSync(work, { recursive: true, force: true });
	});

	const run = (pages: string, outDir: string, flags: string[] = [], timeout = 120_000) =>
		promisify(execFile)(
			process.execPath,
			[script, '--playwright', packageDir, '--old', base(oldSite), '--new', base(newSite), '--pages', pages, '--out', outDir, ...flags],
			{ cwd: site, timeout },
		);

	test('writes the side-by-side page and scores: identical scores 0, a changed heading does not', async () => {
		const { stdout } = await run('pages.txt', out);
		assert.match(stdout, /wrote .*index\.html/);

		assert.ok(existsSync(join(out, 'index.html')));
		const html = readFileSync(join(out, 'index.html'), 'utf8');
		assert.match(html, /The score<\/strong> is the share of pixels/);

		const scores = JSON.parse(readFileSync(join(out, 'scores.json'), 'utf8')) as { results: Result[]; html: HtmlResult[] };
		const by = (path: string, width: number) => scores.results.find((r) => r.path === path && r.width === width);
		assert.equal(scores.results.length, 12, 'six pages at two widths');
		for (const width of [1440, 390]) {
			const same = by('/', width);
			const changed = by('/changed', width);
			assert.ok(same && changed, `both pages at ${width}`);
			assert.equal(same.error, undefined);
			assert.equal(same.differingShare, 0, `the identical page at ${width}`);
			assert.equal(same.heightDelta, 0);
			assert.ok(changed.differingShare > 0, `the changed heading at ${width}`);
			for (const kind of ['old', 'new', 'diff']) {
				assert.match(html, new RegExp(`shots/changed-${width}-${kind}\\.png`));
			}
			// The screenshots can't see the attribute.
			const attribute = by('/attribute', width);
			assert.equal(attribute?.differingShare, 0, `the attribute page looks the same at ${width}`);
			assert.equal(attribute?.heightDelta, 0);
		}

		// The HTML diff: one entry per page, not per width.
		const htmlBy = (path: string) => scores.html.find((h) => h.path === path);
		assert.equal(scores.html.length, 6);
		const home = htmlBy('/');
		assert.equal(home?.error, undefined);
		assert.equal(home?.differingLines, 0, 'hash, data-astro-cid-*, whitespace and attribute order are normalised away');
		assert.ok((htmlBy('/changed')?.differingLines ?? 0) > 0, 'the changed heading is in the HTML diff');
		const attribute = htmlBy('/attribute');
		assert.equal(attribute?.removed, 1);
		assert.equal(attribute?.added, 1);
		assert.equal(attribute?.differingLines, 2);
		const diff = readFileSync(join(out, attribute!.file), 'utf8');
		assert.match(diff, /^- <h1 data-hero>$/m);
		assert.match(diff, /^\+ <h1 data-hero="true">$/m);
		assert.match(html, /&lt;h1 data-hero=&quot;true&quot;&gt;/, 'the report shows the diff');
		assert.match(html, /The HTML diff<\/strong>/);

		// Round 2: a space that moved between inline elements renders the same, so it's no difference...
		assert.equal(htmlBy('/space')?.differingLines, 0, '<span>sub </span><em> against <span>sub</span> <em>');
		// ...but a space that's really gone still shows.
		const lost = htmlBy('/lost');
		assert.equal(lost?.removed, 1);
		assert.equal(lost?.added, 1);
		const lostDiff = readFileSync(join(out, lost!.file), 'utf8');
		assert.match(lostDiff, /^- ␣title$/m);
		assert.match(lostDiff, /^\+ title$/m);
		// <head>'s order isn't compared; <body>'s is.
		const order = htmlBy('/order');
		assert.ok((order?.differingLines ?? 0) > 0, 'the swapped paragraphs are a difference');
		const orderDiff = readFileSync(join(out, order!.file), 'utf8');
		const changed = orderDiff.split('\n').filter((line) => /^[-+] /.test(line));
		assert.ok(changed.length > 0 && changed.every((line) => /^[-+] (<\/?p>|One|Two)$/.test(line)), `only the paragraphs differ:\n${changed.join('\n')}`);

		// The site folder (the command's cwd) gained nothing and its files are untouched.
		assert.deepEqual(readdirSync(site).sort(), ['package.json', 'pages.txt', 'pnpm-lock.yaml']);
		assert.equal(readFileSync(join(site, 'package.json'), 'utf8'), '{"name":"a-site"}\n');
		assert.equal(readFileSync(join(site, 'pnpm-lock.yaml'), 'utf8'), "lockfileVersion: '9.0'\n");
	});

	test("an adoption trial's port: no hang on lazy images, any status, --ignore-attr, --mask-ids", async () => {
		const trialOut = join(work, 'trial');
		// A hang (the run used to wait forever on /lazy) hits this timeout.
		const { stdout } = await run(
			'/lazy,/slow,/missing,/only-old,/ignored,/ids,/broken',
			trialOut,
			['--ignore-attr', 'data-tina-*,data-vivid-id', '--mask-ids', '^(st|sp)-', '--image-wait', '1'],
			90_000,
		);
		const html = readFileSync(join(trialOut, 'index.html'), 'utf8');
		const scores = JSON.parse(readFileSync(join(trialOut, 'scores.json'), 'utf8')) as { results: Result[]; html: HtmlResult[] };
		const by = (path: string, width: number) => scores.results.find((r) => r.path === path && r.width === width);
		const htmlBy = (path: string) => scores.html.find((h) => h.path === path);
		assert.equal(scores.results.length, 14, 'seven pages at two widths');

		// 1: the hidden lazy images aren't waited for (no hang, no cap)...
		for (const width of [1440, 390]) {
			const lazyShot = by('/lazy', width);
			assert.equal(lazyShot?.error, undefined);
			assert.equal(lazyShot?.imageCap, undefined, `the hidden lazy images aren't waited for at ${width}`);
			assert.equal(lazyShot?.differingShare, 0);
			// ...and a slow image that started hits the cap, which is recorded.
			const slowShot = by('/slow', width);
			assert.equal(slowShot?.error, undefined);
			assert.equal(slowShot?.imageWait, 1);
			assert.equal(slowShot?.imageCap?.old?.stillLoading, 1, `the cap at ${width}`);
			assert.match(slowShot?.imageCap?.new?.images[0] ?? '', /\/slow\/photo\.png$/);
		}
		assert.match(html, /gave up waiting for 1 image after 1 s/);
		assert.match(stdout, /\/slow @1440: .*gave up waiting for images after 1 s \(old: 1, new: 1\)/);

		// 2: a 404 on both sides is compared like any page; a 404 on one side is a difference, not an error.
		const missing = htmlBy('/missing');
		assert.equal(missing?.error, undefined);
		assert.deepEqual(missing?.status, { old: 404, new: 404 });
		assert.equal(missing?.statusDiffers, false);
		assert.equal(missing?.differingLines, 0);
		for (const width of [1440, 390]) {
			const shot = by('/missing', width);
			assert.equal(shot?.error, undefined);
			assert.deepEqual(shot?.status, { old: 404, new: 404 });
			assert.equal(shot?.differingShare, 0);
			const gone = by('/only-old', width);
			assert.equal(gone?.error, undefined, 'a status that differs is not an error');
			assert.deepEqual(gone?.status, { old: 200, new: 404 });
			assert.equal(gone?.statusDiffers, true);
		}
		const onlyOld = htmlBy('/only-old');
		assert.equal(onlyOld?.error, undefined);
		assert.equal(onlyOld?.statusDiffers, true);
		assert.match(html, /HTTP 404</);
		assert.match(html, /HTTP 200 → 404/);

		// 3: --ignore-attr drops the named attributes and the data-tina-* prefix.
		assert.equal(htmlBy('/ignored')?.differingLines, 0, 'data-tina-field, data-tina-island and data-vivid-id are ignored');
		// 4: --mask-ids: ids drawn per render, and what points at them, compare equal...
		assert.equal(htmlBy('/ids')?.differingLines, 0, 'the masked ids and their references');
		// ...but a reference that no longer points at its element still shows.
		const broken = htmlBy('/broken');
		assert.equal(broken?.removed, 1);
		assert.equal(broken?.added, 1);
		const brokenDiff = readFileSync(join(trialOut, broken!.file), 'utf8');
		assert.match(brokenDiff, /^- <button aria-controls="\[id2\]" id="\[id1\]">$/m);
		assert.match(brokenDiff, /^\+ <button aria-controls="\[missing1\]" id="\[id1\]">$/m);
	});

	test('a smooth-scrolling page is shot at the top: the same page scores 0', async () => {
		const smoothOut = join(work, 'smooth');
		await run('/smooth', smoothOut);
		const scores = JSON.parse(readFileSync(join(smoothOut, 'scores.json'), 'utf8')) as { results: Result[] };
		for (const r of scores.results) assert.equal(r.differingShare, 0, `${r.path} at ${r.width}`);
	});

	test('a page whose network never goes quiet is shot, not given up on: the same page scores 0', async () => {
		const busyOut = join(work, 'busy');
		await run('/busy', busyOut);
		const scores = JSON.parse(readFileSync(join(busyOut, 'scores.json'), 'utf8')) as { results: Result[] };
		assert.equal(scores.results.length, 2);
		for (const r of scores.results) {
			assert.equal(r.error, undefined, `${r.path} at ${r.width}: ${r.error}`);
			assert.equal(r.differingShare, 0, `${r.path} at ${r.width}`);
		}
	});

	test('--pages / is the home page, not a list file at the disk\'s root', async () => {
		const rootOut = join(work, 'root');
		await run('/', rootOut);
		const scores = JSON.parse(readFileSync(join(rootOut, 'scores.json'), 'utf8')) as { results: Result[] };
		assert.deepEqual([...new Set(scores.results.map((r) => r.path))], ['/']);
	});

	test('--css is added to both pages before each shot, and the report says so', async () => {
		const cssOut = join(work, 'css');
		await run('/changed', cssOut, ['--css', 'h1{display:none!important}']);
		const scores = JSON.parse(readFileSync(join(cssOut, 'scores.json'), 'utf8')) as { options: { css: string | null }; results: Result[] };
		assert.equal(scores.options.css, 'h1{display:none!important}');
		for (const r of scores.results) assert.equal(r.differingShare, 0, `the changed heading is hidden on both sides at ${r.width}`);
		assert.match(readFileSync(join(cssOut, 'index.html'), 'utf8'), /<code>--css<\/code>\) added to both pages/);
		// Without it the same page differs (the first test), and the report names no CSS.
		const plain = join(work, 'no-css');
		await run('/changed', plain, ['--widths', '1440']);
		assert.equal((JSON.parse(readFileSync(join(plain, 'scores.json'), 'utf8')) as { options: { css: string | null } }).options.css, null);
	});

	test('without --ignore-attr and --mask-ids those pages differ; --mask-ids auto masks the same ids', async () => {
		const plain = join(work, 'plain');
		await run('/ignored,/ids', plain, ['--widths', '1440']);
		const plainScores = JSON.parse(readFileSync(join(plain, 'scores.json'), 'utf8')) as { html: HtmlResult[] };
		for (const h of plainScores.html) assert.ok(h.differingLines > 0, `${h.path} differs unmasked`);

		const auto = join(work, 'auto');
		await run('/ids,/broken', auto, ['--widths', '1440', '--mask-ids', 'auto']);
		const autoScores = JSON.parse(readFileSync(join(auto, 'scores.json'), 'utf8')) as { html: HtmlResult[] };
		assert.equal(autoScores.html.find((h) => h.path === '/ids')?.differingLines, 0);
		assert.equal(autoScores.html.find((h) => h.path === '/broken')?.differingLines, 2);
	});
});
