#!/usr/bin/env node
// look-same: does the site still look the same after adopting caracms?
//
// It screenshots each page of the old site and the new one, full page, at 1440 and 390
// wide, and writes one HTML page with old and new side by side and a difference score per
// pair (plus scores.json for an agent to read). It also diffs each page's HTML (below).
//
// Usage. playwright-core lives in a temporary folder OUTSIDE the site, so the site gains no
// dependency and its package.json and lockfile stay untouched. The machine's own Chrome is
// used, so there's no browser download:
//
//   npm i --prefix /tmp/look-same playwright-core
//   node look-same.mjs --playwright /tmp/look-same \
//     --old http://localhost:4321 --new http://localhost:4336 \
//     --pages pages.txt --out /tmp/look-same/report
//
//   --playwright <dir>  the folder playwright-core was installed into (with --prefix). Or set
//                       LOOK_SAME_PLAYWRIGHT=<dir> instead.
//   --old, --new <url>  the two base addresses. Each page path is appended to both.
//   --pages <list>      a file with one path per line (blank lines and # comments ignored),
//                       or a comma list: --pages /,/about,/team
//   --out <dir>         where the report goes: index.html, scores.json, shots/ and html/. Nothing
//                       else is written anywhere.
//   --widths <list>     optional, default 1440,390
//   --image-wait <s>    optional, default 5: the most seconds a shot waits for its images to
//                       finish (below).
//   --ignore-attr <list> optional: attributes the HTML diff drops, a comma list of names. A name
//                       ending in * matches by prefix. A Tina port, for example:
//                       --ignore-attr data-tina-field,data-tina-island  or  --ignore-attr 'data-tina-*'
//   --css <rules>       optional: CSS added to both pages just before each shot, for an element
//                       that varies from run to run on the old site itself (a wordmark fitted to its
//                       box while the display font loads). Hide it or pin its size on both sides, e.g.
//                       --css '[data-logo]{visibility:hidden!important}'. It changes the shots
//                       only, not the HTML diff.
//   --mask-ids <regex|auto> optional: ids drawn at random per render (one site's st-a8f3k2, React's
//                       :r1:) differ on every build, and so does every attribute that points at
//                       them. Ids whose value matches the regex (JavaScript syntax, unanchored:
//                       anchor it yourself, e.g. '^(st|sp)-') are written [id1], [id2], ... by the
//                       HTML diff, numbered in the order their id="" attributes come on the page,
//                       and so is what references one: for, aria-controls, aria-labelledby,
//                       aria-describedby and the other id-list attributes (each id in the list),
//                       href="#…" and url(#…). One id is one mask within a page, so a reference
//                       that no longer points at its element still shows: [id2] against [id3], or
//                       [missing1] when it points at an id the page doesn't have.
//                       Ids in a script's or a style's text aren't masked. auto is a built-in
//                       pattern: React's :r1: and «r1», and ids ending in -, _ or : then a run of
//                       5 or more letters and digits with at least one of each (st-a8f3k2, not
//                       section-12345 or step-intro).
//
// Then open <out>/index.html, or read <out>/scores.json.
//
// How a page is taken: motion is reduced (prefers-reduced-motion: reduce, and CSS
// animations and transitions are finished before the shot), the page is scrolled through
// to the bottom so lazy and scroll-triggered content loads, scrolled back to the top, and
// shot once fonts are ready and the network is idle.
//
// Images: before the shot it waits for each image still loading, but only one that has started:
// an eager image, or a lazy one that renders (not under hidden, display: none, a closed
// <details> or content-visibility: hidden) within a viewport's width of the page's sides. A lazy
// image that never started (in a hidden tab panel, say) never fires load or error, and waiting
// for it would hang. The whole wait is capped
// by --image-wait (5 s). A shot that hit the cap is still taken, and it's recorded: imageCap in
// scores.json (per side, how many images were still loading and the first few addresses), and a
// line in the report and the console.
//
// Status: a page is compared whatever status it answers, so a site's 404 page can be compared
// (put a path that doesn't exist in the list). The status is in the report and scores.json
// (status: { old, new }). When the two sides answer different statuses, that's a difference
// (statusDiffers: true), not an error: both pages are still shot and diffed as they came.
//
// The score: of the pixels both screenshots cover (the overlap of the two sizes), the share
// that differ in any colour channel by more than 16 out of 255. 0% means identical within
// that tolerance. A difference in page height is reported separately, as heightDelta (new
// minus old, in CSS pixels), because one extra line near the top shifts everything below
// it. Images may legitimately differ a little (encoding, sub-pixel scaling): a person
// judges those from the side-by-side. Text, layout and spacing should not.
//
// The HTML diff: screenshots miss what doesn't show (an attribute, an element's order under
// a cover, a dropped space the font hides), so each page's HTML is also fetched from both
// sites, as the server sends it (no JavaScript run), normalised, and diffed line by line.
// Compare two BUILT sites (astro build, then preview or the production server): a dev server
// injects its own scripts and inlines its CSS, and that would all show as differences.
// Normalising, the same on both sides, drops only what changes from build to build or
// renders the same:
//   - asset hashes in file names: /_astro/index.Ab12Cd34.css becomes /_astro/index.[hash].css
//   - Astro's scoped-style attributes, data-astro-cid-*
//   - caracms's editor markers, data-cms-* (they're only in editor previews, never in a
//     public page, so this matters only if you point the script at a preview)
//   - the attributes named by --ignore-attr, and the ids matched by --mask-ids (above)
//   - where a space sits, when it renders the same. The rule: a run of whitespace is one
//     space. Between inline content (text, and inline tags like <span>, <em>, <a>), a space
//     shows once wherever it is, so it's moved to the start of the next text and shown as ␣:
//     <span>a </span><em>b</em> and <span>a</span> <em>b</em> are both "a", then "␣b". A space
//     before an image or a control (img, svg, button, input, select, video, ...) is a "␣"
//     line of its own. Beside a block-level tag (<p>, <div>, <li>, <h1>, <br>, ... opening or
//     closing) a space doesn't render, so it's dropped, as is whitespace between block tags.
//     So a space that was really lost still shows: "␣b" against "b". CSS that makes an
//     element a block (display: block on a <span>) isn't known, and <pre>'s whitespace is
//     collapsed like any other.
//   - the order of <head>'s children: each child (a tag with what's inside it) is sorted,
//     because caracms writes <title>, the description and its own tags in its own place. The
//     tags themselves are still compared. Order in <body> still matters.
//   - attribute order (sorted), quoting, and attr="" (written as a bare attr, which is the
//     same thing). class has its spaces collapsed. attr="true" is NOT the same as attr and
//     stays a difference.
// Then each tag and each text is one line. The report shows the diff per page, and
// scores.json has differingLines (added plus removed) per page, with the full diff in
// html/<page>.diff. caracms adds its own og: and twitter: meta tags; expect those.
//
// Exit codes: 0 when the report is written (whatever the scores, statuses or image caps), 1 for
// a usage error, 2 when the report is written but some page couldn't be fetched at all.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const TOLERANCE = 16;

// ---------------------------------------------------------------- arguments

function usage(message) {
	if (message) console.error(`look-same: ${message}`);
	console.error(
		'usage: node look-same.mjs --playwright <dir> --old <url> --new <url> --pages <file|a,b,c> --out <dir> [--widths 1440,390] [--image-wait 5] [--ignore-attr a,data-b-*] [--mask-ids <regex>|auto] [--css <rules>]',
	);
	process.exit(1);
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		if (!key.startsWith('--')) usage(`unexpected argument ${key}`);
		const value = argv[i + 1];
		if (value === undefined || value.startsWith('--')) usage(`${key} needs a value`);
		args[key.slice(2)] = value;
		i++;
	}
	return args;
}

function readPages(spec) {
	// A list file only when it's a file: `--pages /` is the home page, not the disk's root.
	const isFile = existsSync(spec) && statSync(spec).isFile();
	const lines = isFile ? readFileSync(spec, 'utf8').split('\n') : spec.split(',');
	return lines
		.map((line) => line.replace(/#.*/, '').trim())
		.filter(Boolean)
		.map((path) => (path.startsWith('/') ? path : `/${path}`));
}

const joinUrl = (base, path) => base.replace(/\/+$/, '') + path;

// ---------------------------------------------------------------- playwright-core

async function loadPlaywright(dir) {
	if (!dir) usage('say where playwright-core is installed: --playwright <dir> or LOOK_SAME_PLAYWRIGHT');
	const require = createRequire(join(resolve(dir), 'look-same.cjs'));
	let entry;
	try {
		entry = require.resolve('playwright-core');
	} catch {
		usage(`playwright-core isn't installed in ${dir}: run npm i --prefix ${dir} playwright-core`);
	}
	const module = await import(pathToFileURL(entry).href);
	return module.chromium ?? module.default.chromium;
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(bytes) {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Decodes an 8-bit, non-interlaced PNG (what Chrome's screenshots are) to RGBA. */
function decodePng(buffer) {
	if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
	let offset = 8;
	let width = 0;
	let height = 0;
	let colorType = 0;
	const idat = [];
	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString('ascii', offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const depth = data[8];
			colorType = data[9];
			if (depth !== 8 || data[12] !== 0 || ![2, 6].includes(colorType)) {
				throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${data[12]})`);
			}
		} else if (type === 'IDAT') idat.push(data);
		else if (type === 'IEND') break;
		offset += 12 + length;
	}
	const channels = colorType === 6 ? 4 : 3;
	const stride = width * channels;
	const raw = inflateSync(Buffer.concat(idat));
	const pixels = Buffer.alloc(width * height * 4);
	let prev = Buffer.alloc(stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? line[x - channels] : 0;
			const b = prev[x];
			const c = x >= channels ? prev[x - channels] : 0;
			let add = 0;
			if (filter === 1) add = a;
			else if (filter === 2) add = b;
			else if (filter === 3) add = (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			line[x] = (line[x] + add) & 0xff;
		}
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			pixels[o] = line[x * channels];
			pixels[o + 1] = line[x * channels + 1];
			pixels[o + 2] = line[x * channels + 2];
			pixels[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
		}
		prev = line;
	}
	return { width, height, pixels };
}

function encodePng({ width, height, pixels }) {
	const chunk = (type, data) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, 'ascii');
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
		return Buffer.concat([head, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const raw = Buffer.alloc(height * (width * 4 + 1));
	for (let y = 0; y < height; y++) {
		pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/**
 * Compares two screenshots over the area both cover. Returns the score and a picture of the
 * difference: differing pixels in red over a faded copy of the new page, and the part only
 * one of them covers in grey.
 */
function compare(oldPng, newPng) {
	const a = decodePng(oldPng);
	const b = decodePng(newPng);
	const width = Math.max(a.width, b.width);
	const height = Math.max(a.height, b.height);
	const overlapW = Math.min(a.width, b.width);
	const overlapH = Math.min(a.height, b.height);
	const out = Buffer.alloc(width * height * 4);
	let differing = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			if (x >= overlapW || y >= overlapH) {
				out.set([200, 200, 200, 255], o);
				continue;
			}
			const oa = (y * a.width + x) * 4;
			const ob = (y * b.width + x) * 4;
			let max = 0;
			for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(a.pixels[oa + c] - b.pixels[ob + c]));
			if (max > TOLERANCE) {
				differing++;
				out.set([230, 0, 60, 255], o);
			} else {
				const grey = (b.pixels[ob] + b.pixels[ob + 1] + b.pixels[ob + 2]) / 3;
				const faded = Math.round(255 - (255 - grey) * 0.25);
				out.set([faded, faded, faded, 255], o);
			}
		}
	}
	const compared = overlapW * overlapH;
	return {
		old: { width: a.width, height: a.height },
		new: { width: b.width, height: b.height },
		comparedPixels: compared,
		differingPixels: differing,
		differingShare: compared ? differing / compared : 1,
		heightDelta: b.height - a.height,
		diff: encodePng({ width, height, pixels: out }),
	};
}

// ---------------------------------------------------------------- taking a page

async function shoot(browser, url, width, imageWaitMs, css) {
	const context = await browser.newContext({
		viewport: { width, height: width >= 768 ? 900 : 844 },
		deviceScaleFactor: 1,
		isMobile: width < 768,
		hasTouch: width < 768,
		reducedMotion: 'reduce',
	});
	try {
		const page = await context.newPage();
		// `load`, not `networkidle`: a page with a looping clip (Mux, any streamed video) keeps
		// the network busy for ever and never reaches it (found on a port). The short
		// best-effort waits for a quiet network below are for late requests, not a gate.
		const response = await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
		await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
		const status = response ? response.status() : null;
		await page.evaluate(() => document.fonts.ready);
		// Scroll through in steps so lazy images and scroll-triggered sections load. The page
		// can grow as it goes, so keep going until the bottom stops moving.
		await page.evaluate(async () => {
			const pause = (ms) => new Promise((done) => setTimeout(done, ms));
			let y = 0;
			for (let i = 0; i < 200; i++) {
				const bottom = document.documentElement.scrollHeight - window.innerHeight;
				if (y >= bottom) break;
				y = Math.min(y + Math.round(window.innerHeight * 0.75), bottom);
				// Instant, whatever the page's own `scroll-behavior`: a smooth scroll still moving at
				// the shot puts a sticky header somewhere else each run (found on a port).
				window.scrollTo({ top: y, behavior: 'instant' });
				await pause(120);
			}
			await pause(300);
			window.scrollTo({ top: 0, behavior: 'instant' });
		});
		await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
		await page.evaluate(() => document.fonts.ready);
		// Only images that have started (the header's Images): an eager one, or a lazy one that
		// renders near the page. The whole wait is capped.
		const imageCap = await page.evaluate(async (capMs) => {
			const started = (img) => {
				if (img.loading !== 'lazy') return true;
				// checkVisibility is false under display: none (hidden) and content-visibility: hidden,
				// which is also what a closed <details> uses.
				if (img.checkVisibility && !img.checkVisibility()) return false;
				const rect = img.getClientRects()[0];
				return Boolean(rect) && rect.right > -window.innerWidth && rect.left < 2 * window.innerWidth;
			};
			const pending = [...document.images].filter((img) => !img.complete && started(img));
			let timer;
			const capped = await Promise.race([
				Promise.all(
					pending.map((img) => new Promise((done) => {
						img.addEventListener('load', done, { once: true });
						img.addEventListener('error', done, { once: true });
					})),
				).then(() => false),
				new Promise((done) => {
					timer = setTimeout(() => done(true), capMs);
				}),
			]);
			clearTimeout(timer);
			if (!capped) return null;
			const still = pending.filter((img) => !img.complete);
			if (!still.length) return null;
			return { stillLoading: still.length, images: still.slice(0, 3).map((img) => img.currentSrc || img.src) };
		}, imageWaitMs);
		// Decode every loaded image before the shot: a `decoding="async"` image far down the
		// page can be loaded but not yet drawn, and a full-page shot catches it blank. Capped,
		// like the wait above.
		await page.evaluate(async (capMs) => {
			const decoded = Promise.all([...document.images].filter((img) => img.complete && img.naturalWidth > 0).map((img) => img.decode().catch(() => {})));
			await Promise.race([decoded, new Promise((done) => setTimeout(done, capMs))]);
		}, imageWaitMs);
		await page.waitForTimeout(300);
		if (css) await page.addStyleTag({ content: css });
		const png = await page.screenshot({ fullPage: true, animations: 'disabled', type: 'png' });
		return { png, status, imageCap };
	} finally {
		await context.close();
	}
}

// ---------------------------------------------------------------- the HTML diff

const DIFF_CONTEXT = 3;
const MAX_EDITS = 4000; // beyond this many differing lines, a page is shown as all removed and all added
const SHOWN_LINES = 600; // the report shows at most this many diff lines per page; html/<page>.diff has them all

const HASHED = /([\w-])\.[A-Za-z0-9_-]{8,}\.(m?js|css|woff2?|ttf|otf|eot|svg|png|jpe?g|webp|avif|gif|ico|json|wasm)\b/g;
const DROPPED_ATTRIBUTE = /^(data-astro-cid-[\w-]+|data-cms-[\w-]+)$/i;
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

const unhash = (text) => text.replace(HASHED, '$1.[hash].$2');

// --mask-ids auto: React's useId (:r1:, «r1»), or a separator then a run of 5+ letters and digits
// with at least one of each at the end (st-a8f3k2, sp_9QwE1).
const AUTO_IDS = /^[:«][rR][0-9a-zA-Z]*[:»]$|[-_:](?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{5,}$/;
// Attributes whose value is a space-separated list of ids.
const ID_LISTS = new Set(
	('for aria-controls aria-labelledby aria-describedby aria-owns aria-activedescendant aria-details ' +
		'aria-errormessage aria-flowto headers list form popovertarget commandfor anchor itemref').split(' '),
);

/** --ignore-attr's list as a test of a (lower-case) attribute name. */
function ignoredAttributes(list) {
	const names = String(list ?? '')
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.filter(Boolean);
	const exact = new Set(names.filter((name) => !name.endsWith('*')));
	const prefixes = names.filter((name) => name.endsWith('*')).map((name) => name.slice(0, -1));
	return (key) => exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix));
}

/**
 * How one page is normalised: { ignore(key), maskIds: RegExp | null, masks: Map } — masks is
 * per page, so it's made fresh for each side of each page.
 */
function pageOptions(options = {}) {
	return { ignore: options.ignore ?? (() => false), maskIds: options.maskIds ?? null, masks: new Map(), ids: 0 };
}

/** Numbers the page's masked ids in the order their id="" attributes come, before anything is normalised. */
function numberIds(html, page) {
	if (!page.maskIds) return;
	const tags = new RegExp(TAG.source, 'g');
	for (const tag of html.matchAll(tags)) {
		if (tag[1]) continue;
		for (const m of tag[3].matchAll(ATTRIBUTE)) {
			const id = m[2] ?? m[3] ?? m[4];
			if (m[1].toLowerCase() === 'id' && id && page.maskIds.test(id) && !page.masks.has(id)) {
				page.masks.set(id, `[id${page.masks.size + 1}]`);
			}
		}
	}
	page.ids = page.masks.size;
}

function mask(id, page) {
	if (!page.maskIds || !page.maskIds.test(id)) return id;
	// A reference to an id the page doesn't have.
	if (!page.masks.has(id)) page.masks.set(id, `[missing${page.masks.size - page.ids + 1}]`);
	return page.masks.get(id);
}

function maskValue(key, value, page) {
	if (!page.maskIds) return value;
	if (key === 'id') return mask(value, page);
	if (ID_LISTS.has(key)) return value.split(/(\s+)/).map((part) => (/\S/.test(part) ? mask(part, page) : part)).join('');
	if ((key === 'href' || key === 'xlink:href') && value.startsWith('#')) return `#${mask(value.slice(1), page)}`;
	return value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (_, quote, id) => `url(${quote}#${mask(id, page)}${quote})`);
}

function normaliseTag(name, attributes, page) {
	const pairs = [];
	for (const m of attributes.matchAll(ATTRIBUTE)) {
		const key = m[1].toLowerCase();
		if (DROPPED_ATTRIBUTE.test(key) || page.ignore(key)) continue;
		pairs.push([key, m[2] ?? m[3] ?? m[4]]);
	}
	// Sorted before masking, so the masks are numbered the same whatever order the attributes came in.
	pairs.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : (x ?? '') < (y ?? '') ? -1 : (x ?? '') > (y ?? '') ? 1 : 0));
	const kept = pairs.map(([key, raw]) => {
		if (raw === undefined || raw === '') return key;
		let value = maskValue(key, unhash(raw), page);
		if (key === 'class') value = value.replace(/\s+/g, ' ').trim();
		return `${key}="${value.replace(/"/g, '&quot;')}"`;
	});
	return `<${name}${kept.length ? ` ${kept.join(' ')}` : ''}>`;
}

// Where a space renders (the header's whitespace rule). A BLOCK tag, opening or closing, ends a
// line of text, so a space beside it never shows; BR does too. An ATOMIC element is inline but
// not text (an image, a control): a space before it shows, so it stays as a line of its own.
// Every other tag is inline, or renders nothing (script, template, meta): a space beside it shows
// once, wherever it sits, and the run of text goes on through it.
const BLOCK = new Set(
	('address article aside blockquote body br caption center col colgroup dd details dialog dir div dl dt fieldset ' +
		'figcaption figure footer form frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html legend li main menu nav ol ' +
		'optgroup option p pre search section summary table tbody td tfoot th thead tr ul').split(' '),
);
const ATOMIC = new Set('audio button canvas embed iframe img input meter object progress select svg textarea video'.split(' '));
const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));

/** The page as tokens: tags (open, close or void), texts, and comments and doctypes as they are. */
function htmlTokens(html, page) {
	const tokens = [];
	const text = (raw) => tokens.push({ kind: 'text', raw });
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		if (lt === -1) {
			text(html.slice(i));
			break;
		}
		if (lt > i) text(html.slice(i, lt));
		if (html.startsWith('<!--', lt)) {
			const close = html.indexOf('-->', lt + 4);
			const stop = close === -1 ? html.length : close + 3;
			tokens.push({ kind: 'other', line: html.slice(lt, stop).replace(/\s+/g, ' ') });
			i = stop;
			continue;
		}
		if (html[lt + 1] === '!' || html[lt + 1] === '?') {
			const close = html.indexOf('>', lt);
			const stop = close === -1 ? html.length : close + 1;
			tokens.push({ kind: 'other', line: html.slice(lt, stop).replace(/\s+/g, ' ').toLowerCase() });
			i = stop;
			continue;
		}
		TAG.lastIndex = lt;
		const m = TAG.exec(html);
		if (!m) {
			text('<');
			i = lt + 1;
			continue;
		}
		const name = m[2].toLowerCase();
		i = TAG.lastIndex;
		if (m[1]) {
			tokens.push({ kind: 'close', name, line: `</${name}>` });
			continue;
		}
		const empty = VOID.has(name) || /\/\s*$/.test(m[3]);
		tokens.push({ kind: empty ? 'void' : 'open', name, line: normaliseTag(name, m[3], page) });
		if (RAW_TEXT.has(name)) {
			const close = html.toLowerCase().indexOf(`</${name}`, i);
			const stop = close === -1 ? html.length : close;
			const inner = html.slice(i, stop).replace(/\s+/g, ' ').trim();
			if (inner) tokens.push({ kind: 'raw', line: unhash(inner) });
			i = stop;
		}
	}
	return tokens;
}

/**
 * Texts as lines, with each space put where it renders: a run of whitespace is one space, and
 * a space beside inline tags goes to the start of the next text as ␣ (or before an atomic
 * element, as a line of its own), so `<span>a </span><em>b</em>` and `<span>a</span> <em>b</em>`
 * both come out `a`, then `␣b`. A space at the start or end of a line of text (next to a block
 * tag, or the page's ends) doesn't render, so it's dropped.
 */
function placeSpaces(tokens) {
	const out = [];
	let space = false; // a space waiting for what comes next
	let lineStart = true; // nothing has rendered since the last block boundary
	for (const t of tokens) {
		if (t.kind === 'text') {
			const collapsed = t.raw.replace(/\s+/g, ' ');
			const body = collapsed.trim();
			if (collapsed.startsWith(' ') || !body) space = !lineStart;
			if (!body) continue;
			out.push({ kind: 'text', line: (space ? '␣' : '') + unhash(body) });
			space = collapsed.endsWith(' ');
			lineStart = false;
			continue;
		}
		if (t.kind === 'open' || t.kind === 'close' || t.kind === 'void') {
			if (BLOCK.has(t.name)) {
				space = false;
				lineStart = true;
			} else if (ATOMIC.has(t.name) && t.kind !== 'close') {
				if (space) out.push({ kind: 'text', line: '␣' });
				space = false;
				lineStart = false;
			}
		}
		out.push(t);
	}
	return out;
}

/**
 * <head>'s children in a fixed order (sorted by their lines), so a tag that only moved within
 * <head> isn't a difference: the order of <title>, <meta> and <link> there doesn't change the page.
 */
function sortHead(tokens) {
	const start = tokens.findIndex((t) => t.kind === 'open' && t.name === 'head');
	if (start === -1) return tokens;
	const children = [];
	let depth = 0;
	let i = start + 1;
	for (; i < tokens.length; i++) {
		const t = tokens[i];
		if (depth === 0 && ((t.kind === 'close' && t.name === 'head') || (t.kind === 'open' && t.name === 'body'))) break;
		if (depth === 0) children.push([]);
		children[children.length - 1].push(t);
		if (t.kind === 'open') depth++;
		else if (t.kind === 'close') depth = Math.max(0, depth - 1);
	}
	const key = (child) => child.map((t) => t.line).join('\n');
	children.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
	return [...tokens.slice(0, start + 1), ...children.flat(), ...tokens.slice(i)];
}

/** The page as lines: one per tag, text, comment or doctype, normalised as the header says. */
function htmlLines(html, options) {
	const page = pageOptions(options);
	numberIds(html, page);
	return sortHead(placeSpaces(htmlTokens(html, page))).map((t) => t.line);
}

/** Myers's diff of two line lists: [op, line] with op ' ', '-' or '+'. */
function diffLines(a, b) {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const head = a.slice(0, start).map((line) => [' ', line]);
	const tail = a.slice(endA).map((line) => [' ', line]);
	const x0 = a.slice(start, endA);
	const y0 = b.slice(start, endB);
	const n = x0.length;
	const m = y0.length;
	const max = n + m;
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace = [];
	let found = false;
	for (let d = 0; d <= Math.min(max, MAX_EDITS) && !found; d++) {
		trace.push(v.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && x0[x] === y0[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = true;
				break;
			}
		}
	}
	if (!found) {
		return [...head, ...x0.map((line) => ['-', line]), ...y0.map((line) => ['+', line]), ...tail];
	}
	const middle = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const at = (k) => trace[d][k + d + 1];
		const k = x - y;
		const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			middle.push([' ', x0[x]]);
		}
		if (d > 0) {
			if (x === prevX) middle.push(['+', y0[--y]]);
			else middle.push(['-', x0[--x]]);
		}
	}
	return [...head, ...middle.reverse(), ...tail];
}

/** The diff as unified hunks with a few lines of context, and its counts. */
function unified(ops) {
	const changed = ops.map(([op]) => op !== ' ');
	const keep = ops.map((_, i) => {
		for (let j = Math.max(0, i - DIFF_CONTEXT); j <= Math.min(ops.length - 1, i + DIFF_CONTEXT); j++) if (changed[j]) return true;
		return false;
	});
	const lines = [];
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	ops.forEach(([op, line], i) => {
		if (op !== '+') oldLine++;
		if (op !== '-') newLine++;
		if (!keep[i]) {
			inHunk = false;
			return;
		}
		if (!inHunk) {
			lines.push(`@@ old line ${op === '+' ? oldLine + 1 : oldLine}, new line ${op === '-' ? newLine + 1 : newLine} @@`);
			inHunk = true;
		}
		lines.push(`${op} ${line}`);
	});
	const removed = ops.filter(([op]) => op === '-').length;
	const added = ops.filter(([op]) => op === '+').length;
	return { lines, removed, added, differingLines: removed + added };
}

async function fetchHtml(url) {
	const response = await fetch(url, { redirect: 'follow' });
	return { status: response.status, text: await response.text() };
}

async function compareHtml(oldUrl, newUrl, options) {
	const [oldPage, newPage] = await Promise.all([fetchHtml(oldUrl), fetchHtml(newUrl)]);
	return {
		status: { old: oldPage.status, new: newPage.status },
		statusDiffers: oldPage.status !== newPage.status,
		...unified(diffLines(htmlLines(oldPage.text, options), htmlLines(newPage.text, options))),
	};
}

// ---------------------------------------------------------------- the report

const escape = (text) =>
	String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const statusLabel = (s) => (!s ? '' : s.old === s.new ? `HTTP ${s.old}` : `HTTP ${s.old} → ${s.new}`);
const statusSpan = (r) => (r.status ? ` <span class="score ${r.statusDiffers ? 'differs' : 'status'}">${escape(statusLabel(r.status))}</span>` : '');
const percent = (share) => `${(share * 100).toFixed(share > 0 && share < 0.001 ? 3 : 2)}%`;

function renderHtmlDiff(h) {
	const label = `${escape(h.path)}: the HTML`;
	if (h.error) return `<section><h2>${label}</h2><p class="error">Couldn't compare: ${escape(h.error)}</p></section>`;
	const tone = h.differingLines === 0 && !h.statusDiffers ? 'same' : 'differs';
	const summary =
		h.differingLines === 0 ? 'same HTML' : `${h.differingLines} lines differ (${h.removed} only in old, ${h.added} only in new)`;
	const shown = h.lines.slice(0, SHOWN_LINES);
	const body = shown
		.map((line) => {
			const kind = line.startsWith('@@') ? 'hunk' : line[0] === '-' ? 'del' : line[0] === '+' ? 'ins' : 'ctx';
			return `<span class="${kind}">${escape(line)}</span>`;
		})
		.join('\n');
	const more = h.lines.length > SHOWN_LINES ? `<p>${h.lines.length - SHOWN_LINES} more lines in <a href="${h.file}">${h.file}</a>.</p>` : '';
	return `<section>
  <h2>${label} <span class="score ${tone}">${summary}</span>${statusSpan(h)}</h2>${
		h.differingLines === 0 ? '' : `\n  <p><a href="${h.file}">${h.file}</a></p><pre class="diff">${body}</pre>${more}`
	}
</section>`;
}

function renderHtml(report) {
	const htmlFor = new Map(report.html.map((h) => [h.path, h]));
	const rows = report.results
		.map((r, i) => {
			const first = i === 0 || report.results[i - 1].path !== r.path;
			return `${first && htmlFor.has(r.path) ? `${renderHtmlDiff(htmlFor.get(r.path))}\n` : ''}${renderShots(r)}`;
		})
		.join('\n');
	return renderPage(report, rows);
}

function renderShots(r) {
	const label = `${escape(r.path)} at ${r.width}px`;
	if (r.error) {
		return `<section><h2>${label}</h2><p class="error">Couldn't compare: ${escape(r.error)}</p></section>`;
	}
	const height =
		r.heightDelta === 0
			? 'same height'
			: `new is ${Math.abs(r.heightDelta)}px ${r.heightDelta > 0 ? 'taller' : 'shorter'} (${r.old.height} → ${r.new.height})`;
	const tone = r.differingShare === 0 && r.heightDelta === 0 && !r.statusDiffers ? 'same' : 'differs';
	const capped = r.imageCap
		? Object.entries(r.imageCap)
				.map(
					([side, c]) =>
						`<p class="error">${side === 'old' ? 'Old' : 'New'}: gave up waiting for ${c.stillLoading} image${c.stillLoading === 1 ? '' : 's'} after ${r.imageWait} s, so the shot may show ${c.stillLoading === 1 ? 'it' : 'them'} unloaded: ${c.images.map(escape).join(', ')}</p>`,
				)
				.join('\n  ')
		: '';
	return `<section>
  <h2>${label} <span class="score ${tone}">${percent(r.differingShare)} differ · ${height}</span>${statusSpan(r)}</h2>${capped ? `\n  ${capped}` : ''}
  <div class="pair" style="--w:${r.width}px">
    <figure><figcaption>Old · <a href="${escape(r.oldUrl)}">${escape(r.oldUrl)}</a></figcaption><img src="${r.files.old}" alt="old ${label}" loading="lazy"></figure>
    <figure><figcaption>New · <a href="${escape(r.newUrl)}">${escape(r.newUrl)}</a></figcaption><img src="${r.files.new}" alt="new ${label}" loading="lazy"></figure>
    <figure><figcaption>Difference (red)</figcaption><img src="${r.files.diff}" alt="difference ${label}" loading="lazy"></figure>
  </div>
</section>`;
}

function renderPage(report, rows) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Look the same</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #ddd; --ok: #0a7a3d; --bad: #b0003a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #eee; --muted: #aaa; --line: #333; --ok: #4cc983; --bad: #ff6b8f; } }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  header { max-width: 72ch; margin-bottom: 32px; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { margin: 0 0 8px; color: var(--muted); }
  section { margin: 0 0 48px; padding-top: 16px; border-top: 1px solid var(--line); }
  h2 { font-size: 16px; margin: 0 0 12px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; }
  .score { font-weight: 500; font-size: 14px; }
  .same { color: var(--ok); } .differs { color: var(--bad); } .status { color: var(--muted); }
  .error { color: var(--bad); }
  .pair { display: grid; grid-template-columns: repeat(3, minmax(0, var(--w))); gap: 16px; overflow-x: auto; }
  figure { margin: 0; min-width: 0; }
  figcaption { font-size: 13px; color: var(--muted); margin-bottom: 6px; overflow-wrap: anywhere; }
  figcaption a { color: inherit; }
  .diff { margin: 0; padding: 12px; overflow-x: auto; border: 1px solid var(--line); font: 12px/1.45 ui-monospace, monospace; white-space: pre; }
  .diff .del { color: var(--bad); } .diff .ins { color: var(--ok); } .diff .hunk { color: var(--muted); }
  img { display: block; width: 100%; height: auto; border: 1px solid var(--line); }
</style>
</head>
<body>
<header>
  <h1>Look the same</h1>
  <p>Old <a href="${escape(report.old)}">${escape(report.old)}</a> beside new <a href="${escape(report.new)}">${escape(report.new)}</a>, taken ${escape(report.generated)}.</p>
  <p><strong>The score</strong> is the share of pixels, over the area both screenshots cover, that differ in any colour channel by more than ${TOLERANCE} out of 255. A difference in page height is shown separately, since one extra line near the top shifts everything below it.</p>
  <p>Text, layout and spacing should be the same. Images may differ a little in encoding and sub-pixel scaling; judge those by eye.</p>
  <p><strong>The HTML diff</strong> compares each page's HTML as the server sends it, one tag or text per line, after dropping what changes from build to build or renders the same: asset hashes in file names, Astro's <code>data-astro-cid-*</code>, caracms's <code>data-cms-*</code> editor markers, where a space sits when it renders the same (a space between inline content shows as ␣ at the start of the next text; beside a block tag it's dropped), the order of <code>&lt;head&gt;</code>'s children (sorted), attribute order and quoting, and <code>attr=""</code> against a bare <code>attr</code>.${
		report.options.ignoreAttr ? ` Also dropped (<code>--ignore-attr</code>): <code>${escape(report.options.ignoreAttr)}</code>.` : ''
	}${
		report.options.maskIds
			? ` Ids matching <code>${escape(report.options.maskIds)}</code> (<code>--mask-ids</code>), and the references to them, are written <code>[id1]</code>, <code>[id2]</code>, … in the order the ids come on the page (a reference to an id the page doesn't have is <code>[missing1]</code>, …), so a reference that no longer points at its element still shows.`
			: ''
	} It catches what a screenshot can't: an attribute, an order under a cover, a lost space.</p>
  <p><strong>Status:</strong> every page is compared whatever it answers (a 404 page too), and its HTTP status is shown beside it; two different statuses are a difference. <strong>Images:</strong> each shot waits up to ${report.options.imageWait} s for the images that have started loading; a shot that gave up says so.${
		report.options.css ? ` <strong>CSS</strong> (<code>--css</code>) added to both pages before each shot: <code>${escape(report.options.css)}</code>.` : ''
	}</p>
</header>
${rows}
</body>
</html>
`;
}

// ---------------------------------------------------------------- run

async function main() {
	const args = parseArgs(process.argv.slice(2));
	for (const key of ['old', 'new', 'pages', 'out']) if (!args[key]) usage(`--${key} is required`);
	const pages = readPages(args.pages);
	if (!pages.length) usage('the page list is empty');
	const widths = (args.widths ?? '1440,390').split(',').map(Number);
	if (widths.some((w) => !Number.isInteger(w) || w < 200)) usage('--widths takes whole numbers, e.g. 1440,390');
	const imageWait = Number(args['image-wait'] ?? 5);
	if (!Number.isFinite(imageWait) || imageWait < 0) usage('--image-wait takes a number of seconds, e.g. 5');
	let maskIds = null;
	if (args['mask-ids'] === 'auto') maskIds = AUTO_IDS;
	else if (args['mask-ids'] !== undefined) {
		try {
			maskIds = new RegExp(args['mask-ids']);
		} catch (error) {
			usage(`--mask-ids isn't a regular expression: ${error instanceof Error ? error.message : error}`);
		}
	}
	const css = args.css ?? '';
	const htmlOptions = { ignore: ignoredAttributes(args['ignore-attr']), maskIds };
	const known = new Set(['playwright', 'old', 'new', 'pages', 'out', 'widths', 'image-wait', 'ignore-attr', 'mask-ids', 'css']);
	for (const key of Object.keys(args)) if (!known.has(key)) usage(`unknown option --${key}`);

	const chromium = await loadPlaywright(args.playwright ?? process.env.LOOK_SAME_PLAYWRIGHT);
	const out = resolve(args.out);
	mkdirSync(join(out, 'shots'), { recursive: true });
	mkdirSync(join(out, 'html'), { recursive: true });

	const browser = await chromium.launch({ channel: 'chrome' });
	const results = [];
	const html = [];
	try {
		for (const path of pages) {
			const page = path.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home';
			const htmlResult = { path, oldUrl: joinUrl(args.old, path), newUrl: joinUrl(args.new, path), file: `html/${page}.diff` };
			try {
				const { lines, ...counts } = await compareHtml(htmlResult.oldUrl, htmlResult.newUrl, htmlOptions);
				Object.assign(htmlResult, counts);
				writeFileSync(
					join(out, htmlResult.file),
					`--- old ${htmlResult.oldUrl}\n+++ new ${htmlResult.newUrl}\n${lines.join('\n')}${lines.length ? '\n' : ''}`,
				);
				html.push({ ...htmlResult, lines });
			} catch (error) {
				htmlResult.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
				html.push(htmlResult);
			}
			console.log(
				htmlResult.error
					? `${path} HTML: error: ${htmlResult.error}`
					: `${path} HTML: ${htmlResult.differingLines} lines differ (${htmlResult.removed} only in old, ${htmlResult.added} only in new)${
							htmlResult.statusDiffers || htmlResult.status.old !== 200 ? `, ${statusLabel(htmlResult.status)}` : ''
						}`,
			);
			for (const width of widths) {
				const slug = `${page}-${width}`;
				const files = { old: `shots/${slug}-old.png`, new: `shots/${slug}-new.png`, diff: `shots/${slug}-diff.png` };
				const oldUrl = joinUrl(args.old, path);
				const newUrl = joinUrl(args.new, path);
				const result = { path, width, oldUrl, newUrl, files };
				try {
					const oldShot = await shoot(browser, oldUrl, width, imageWait * 1000, css);
					const newShot = await shoot(browser, newUrl, width, imageWait * 1000, css);
					writeFileSync(join(out, files.old), oldShot.png);
					writeFileSync(join(out, files.new), newShot.png);
					const { diff, ...score } = compare(oldShot.png, newShot.png);
					writeFileSync(join(out, files.diff), diff);
					result.status = { old: oldShot.status, new: newShot.status };
					result.statusDiffers = oldShot.status !== newShot.status;
					if (oldShot.imageCap || newShot.imageCap) {
						result.imageWait = imageWait;
						result.imageCap = {};
						if (oldShot.imageCap) result.imageCap.old = oldShot.imageCap;
						if (newShot.imageCap) result.imageCap.new = newShot.imageCap;
					}
					Object.assign(result, score);
				} catch (error) {
					result.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
				}
				results.push(result);
				console.log(
					result.error
						? `${path} @${width}: error: ${result.error}`
						: `${path} @${width}: ${percent(result.differingShare)} differ, height ${result.heightDelta >= 0 ? '+' : ''}${result.heightDelta}px${
								result.statusDiffers || result.status.old !== 200 ? `, ${statusLabel(result.status)}` : ''
							}${
								result.imageCap
									? `; gave up waiting for images after ${imageWait} s (${Object.entries(result.imageCap)
											.map(([side, c]) => `${side}: ${c.stillLoading}`)
											.join(', ')})`
									: ''
							}`,
				);
			}
		}
	} finally {
		await browser.close();
	}

	const report = {
		old: args.old,
		new: args.new,
		generated: new Date().toISOString(),
		score: `differingShare: of the pixels both screenshots cover, the share differing in any colour channel by more than ${TOLERANCE}/255. heightDelta: new height minus old, in CSS pixels.`,
		tolerance: TOLERANCE,
		options: { widths, imageWait, ignoreAttr: args['ignore-attr'] ?? null, maskIds: maskIds ? (args['mask-ids'] === 'auto' ? `auto (${AUTO_IDS.source})` : maskIds.source) : null, css: css || null },
		status: 'status: the HTTP status each side answered, { old, new }. statusDiffers: true when they differ, which is a difference, not an error. imageCap (results only, when present): the shot gave up waiting for images after imageWait seconds; per side, how many were still loading and the first few addresses.',
		results,
		htmlScore:
			'differingLines: lines only in old plus lines only in new, after normalising (see the report header); the diff is in file. 0 means the same HTML.',
		html: html.map(({ lines, ...h }) => h),
	};
	writeFileSync(join(out, 'scores.json'), `${JSON.stringify(report, null, '\t')}\n`);
	writeFileSync(join(out, 'index.html'), renderHtml({ ...report, html }));
	console.log(`look-same: wrote ${join(out, 'index.html')}, scores.json and html/`);
	if (results.some((r) => r.error) || html.some((h) => h.error)) process.exit(2);
}

main().catch((error) => {
	console.error(`look-same: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
