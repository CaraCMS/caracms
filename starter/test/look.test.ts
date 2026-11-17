// The look and the restyle proof (M7 Decisions 4–9, Acceptance 14–16 and 21–23).
//
// - Acceptance 14: the blocks, the shell, the collections' components and the pages name no
//   colour, font or type size: they read the tokens.
// - Acceptance 15: Tailwind's own palette, font stacks and type scale generate nothing.
// - Acceptance 21–23: the starter with the second look swapped in (test/fixtures/second-look,
//   helpers/look.ts) differs from the starter only in the look's files, builds, and wears the second look
//   (cream, a forest band, Bricolage lockups) while the plain build is the plain look;
//   every block's band reads at least 4.5:1 in both, for each background.
// - Acceptance 16, on the restyle: no lockup line wraps at 375, 768 or 1440 on any page.
//
// Two builds of the pinned content (helpers/dist.ts → buildCopy), the plain look and
// the second look, each with a test-only page that has a Text, Features and Call to action block
// on each background, and a test-only file of Tailwind default classes.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { listDocuments } from 'caracms/content';
import { buildCopy, serveClient, type BuiltCopy } from './helpers/dist.ts';
import { changedFiles, isLookFile, swapLook } from './helpers/look.ts';
import { displayFontLoaded, footerProblems, lockupProblems } from './helpers/lockups.ts';
import { pinnedSite, root } from './helpers/render.ts';

const SCHEMES = ['light', 'grey', 'dark', 'accent'] as const;

/**
 * The first example of every other block type in the pinned content (a hero without the
 * media behind its text, which is a different band), so the contrast check covers every
 * block's band, not just three of them (Acceptance 23).
 */
function otherBlocks(at: string): Record<string, unknown>[] {
	const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.json') ? [join(dir, n)] : []));
	const first = new Map<string, Record<string, unknown>>();
	for (const file of files(join(at, 'content/pages')).sort()) {
		for (const block of (JSON.parse(readFileSync(file, 'utf8')).blocks ?? []) as Record<string, unknown>[]) {
			if (typeof block.type !== 'string' || ['text', 'features', 'cta'].includes(block.type) || first.has(block.type)) continue;
			const { media, ...rest } = block;
			first.set(block.type, block.type === 'hero' ? rest : block);
		}
	}
	assert.deepEqual([...first.keys()].sort(), ['cards', 'cases', 'columns', 'faq', 'form', 'gallery', 'hero', 'media', 'posts', 'tm'], 'the pinned content has an example of each other block');
	return [...first.values()];
}

/** A page with a Text, Features and Call to action block on each background, then every other block on each (test-only content). */
function addSchemesPage(at: string) {
	const others = otherBlocks(at);
	const blocks = SCHEMES.flatMap((background) => [
		...others.map((block) => ({ ...block, background })),
		{ type: 'text', heading: `Text on ${background}`, body: [{ p: `A paragraph with [a link](/about) on ${background}.` }], background },
		{ type: 'features', heading: `Features on ${background}`, intro: 'An intro in the soft colour.', items: [{ heading: 'A point', text: 'Its text.' }, { heading: 'Another', text: 'And its text.' }], background },
		{
			type: 'cta',
			heading: ['A call', `on ${background}`],
			text: 'Some text beside it.',
			buttons: [
				{ label: 'Primary', href: '/contact', style: 'primary' },
				{ label: 'Secondary', href: '/work', style: 'secondary' },
			],
			background,
		},
	]);
	writeFileSync(join(at, 'content/pages/schemes.json'), `${JSON.stringify({ title: 'Schemes', blocks }, null, 2)}\n`);
}

/** Tailwind's own classes in a source file the build scans (not a registered block), and one token class as the control. */
function addDefaultsProbe(at: string) {
	writeFileSync(join(at, 'src/blocks/TailwindDefaults.astro'), '<div class="bg-red-500 text-xl font-serif bg-grey-400">Tailwind defaults</div>\n');
}

const cssOf = (copy: BuiltCopy) =>
	readdirSync(join(copy.client, '_astro'))
		.filter((f) => f.endsWith('.css') && !f.startsWith('admin'))
		.map((f) => readFileSync(join(copy.client, '_astro', f), 'utf8'))
		.join('\n');

// ── Acceptance 14 ─────────────────────────────────────────────────────────────

const NAMED_COLOURS =
	'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
		' ',
	);
const COLOUR = new RegExp(`#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\(|\\b(?:${NAMED_COLOURS.join('|')})\\b`, 'i');
const FONT_SIZE = /\b\d*\.?\d+(?:px|rem|em)\b/;

/** What's wrong with one CSS declaration's value, if anything. */
function badDeclaration(property: string, value: string): string | null {
	const literal = !/^\s*(?:var\(|inherit|initial|unset)/.test(value);
	// A token's name (`var(--color-grey-500)`) isn't a colour; what it holds is the look's.
	if (COLOUR.test(value.replace(/var\(--[\w-]+/g, 'var('))) return 'a colour';
	if (property === 'font-family' && literal) return 'a font-family';
	if ((property === 'font-size' || property === 'font') && FONT_SIZE.test(value)) return 'a font size';
	return null;
}

/** Every declaration in a stylesheet's text (comments out), as [property, value]. */
const declarations = (css: string) =>
	[...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;{\s])(-{0,2}[a-z][a-z-]*)\s*:\s*([^;{}]+)(?=;|\})/g)].map((m) => [m[1]!.toLowerCase(), m[2]!.trim()] as const);

/** Tailwind arbitrary values and properties that carry a colour, a font or a type size: `bg-[#fff]`, `text-[14px]`, `[color:red]`. */
function badClasses(text: string): string[] {
	const found: string[] = [];
	for (const m of text.matchAll(/(?:^|[\s"'`{(:])((?:bg|text|border|fill|stroke|decoration|outline|ring|from|via|to|shadow|accent|caret|placeholder|font)-\[([^\]]+)\])/g)) {
		if (COLOUR.test(m[2]!) || FONT_SIZE.test(m[2]!) || m[1]!.startsWith('font-')) found.push(m[1]!);
	}
	for (const m of text.matchAll(/\[([a-z-]+):([^\]]+)\]/g)) {
		const problem = badDeclaration(m[1]!, m[2]!.replaceAll('_', ' '));
		if (problem) found.push(m[0]);
	}
	return found;
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? sourceFiles(path) : /\.(astro|ts|css)$/.test(name) ? [path] : [];
	});
}

describe('Acceptance 14: the blocks and the shell read the tokens', () => {
	const files = ['src/blocks', 'src/components', 'src/collections', 'src/pages'].flatMap((d) => sourceFiles(join(root, d)));

	test('the scan sees the files it should (so it can\'t pass by checking nothing)', () => {
		for (const f of ['src/blocks/Hero.astro', 'src/components/SiteHeader.astro', 'src/components/site.css', 'src/collections/CaseStudy.astro', 'src/pages/404.astro']) {
			assert.ok(files.includes(join(root, f)), f);
		}
		// The checks themselves: each catches what it's for.
		assert.equal(badDeclaration('color', '#141414'), 'a colour');
		assert.equal(badDeclaration('background', 'rgb(0 0 0 / 0.5)'), 'a colour');
		assert.equal(badDeclaration('border-color', 'white'), 'a colour');
		assert.equal(badDeclaration('font-family', 'Georgia, serif'), 'a font-family');
		assert.equal(badDeclaration('font-size', '1.25rem'), 'a font size');
		assert.equal(badDeclaration('white-space', 'nowrap'), null);
		assert.equal(badDeclaration('border', '1px solid var(--line)'), null);
		assert.equal(badDeclaration('background', 'var(--color-grey-800)'), null);
		assert.equal(badDeclaration('font-size', 'var(--text-small)'), null);
		assert.deepEqual(badClasses('<p class="text-[14px] bg-[#fff] underline-offset-[0.3em] top-[calc(50%-1px)] [color:red]">'), ['text-[14px]', 'bg-[#fff]', '[color:red]']);
	});

	test('no colour, font-family or font size in a <style> block, a stylesheet or a class', () => {
		const problems: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, 'utf8');
			const where = file.slice(root.length);
			const styles = file.endsWith('.css') ? [text] : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
			for (const css of styles) {
				for (const [property, value] of declarations(css)) {
					const problem = badDeclaration(property, value);
					if (problem) problems.push(`${where}: ${problem} in "${property}: ${value}"`);
				}
			}
			const markup = file.endsWith('.css') ? '' : text.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
			for (const cls of badClasses(markup)) problems.push(`${where}: ${cls}`);
		}
		assert.deepEqual(problems, []);
	});
});

// ── The two builds ────────────────────────────────────────────────────────────

let plain: BuiltCopy;
let second: BuiltCopy;
let browser: Browser;
let page: Page;
const servers: { close(): void }[] = [];
const origins: Record<'plain' | 'second', string> = { plain: '', second: '' };

before(async () => {
	plain = await buildCopy('look-plain', (at) => {
		addSchemesPage(at);
		addDefaultsProbe(at);
	});
	second = await buildCopy('look-second', (at) => {
		swapLook(at);
		addSchemesPage(at);
		addDefaultsProbe(at);
	});
	for (const [name, copy] of [['plain', plain], ['second', second]] as const) {
		const served = await serveClient(copy.client);
		servers.push(served.server);
		origins[name] = served.origin;
	}
	browser = await chromium.launch();
	page = await browser.newPage();
	// Only the test's own servers: the Google tag and the made-up image host never answer.
	await page.route((url) => !Object.values(origins).some((o) => url.href.startsWith(o)), (route) => route.abort());
});
after(async () => {
	await browser?.close();
	for (const s of servers) s.close();
});

describe('Acceptance 15: Tailwind\'s defaults generate nothing', () => {
	test('bg-red-500, text-xl and font-serif have no rule and no variable in the built CSS, in either look; a token class beside them does', () => {
		for (const copy of [plain, second]) {
			const css = cssOf(copy);
			assert.match(css, /\.bg-grey-400\{/, 'the probe was scanned: its token class is there');
			for (const cls of ['bg-red-500', 'text-xl', 'font-serif']) assert.doesNotMatch(css, new RegExp(`\\.${cls}[{:,\\s]`), cls);
			for (const variable of ['--color-red-500', '--text-xl', '--font-serif', '--font-mono']) assert.doesNotMatch(css, new RegExp(`${variable}:`), variable);
		}
	});
});

describe('the restyle proof', () => {
	test('Acceptance 21: a copy with the second look swapped in differs from the starter only in the look\'s files', () => {
		const copy = pinnedSite('look-diff');
		try {
			swapLook(copy.root);
			const changed = changedFiles(root, copy.root);
			assert.ok(changed.includes('src/styles/tokens.css') && changed.includes('src/styles/text-styles.ts'), changed.join(', '));
			assert.ok(changed.includes('src/fonts/BricolageGrotesque.woff2') && changed.includes('src/fonts/InterVariable.woff2'), 'Bricolage in, Inter out');
			assert.ok(changed.includes('public/favicon.svg'), 'the tab icon');
			assert.deepEqual(changed.filter((f) => !isLookFile(f)), []);
		} finally {
			copy.close();
		}
	});

	test('Acceptance 23: every example page builds in both looks', async () => {
		const urls = (await listDocuments(plain.site)).filter((e) => !e.warning && e.url).map((e) => e.url!);
		assert.ok(urls.length >= 20, String(urls.length));
		for (const copy of [plain, second]) {
			for (const url of urls) assert.ok(existsSync(join(copy.client, url === '/' ? 'index.html' : `${url.slice(1)}/index.html`)), url);
		}
	});

	const lookOf = async (which: 'plain' | 'second', family: string) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`${origins[which]}/`);
		await page.evaluate(() => document.fonts.ready);
		assert.ok(await displayFontLoaded(page, family), `${which}: the display font loaded`);
		return page.evaluate(() => ({
			surface: getComputedStyle(document.body).backgroundColor,
			body: getComputedStyle(document.body).fontFamily,
			accentBand: getComputedStyle(document.querySelector('main .scheme-accent')!).backgroundColor,
			lockup: getComputedStyle(document.querySelector('main h1 .cms-lockup-line')!).fontFamily,
			lockupCase: getComputedStyle(document.querySelector('main h1 .cms-lockup-line')!).textTransform,
		}));
	};

	test('Acceptance 22: the plain Home is white, its band the accent, its lockups Inter; the restyled Home is cream, its band forest, its lockups Bricolage', async () => {
		const p = await lookOf('plain', 'Inter');
		assert.equal(p.surface, 'rgb(255, 255, 255)');
		assert.equal(p.accentBand, 'rgb(47, 79, 219)');
		assert.match(p.body, /^"?Inter Variable"?,/);
		assert.match(p.lockup, /^"?Inter-[0-9a-f]+"?,/);
		assert.equal(p.lockupCase, 'none');

		const f = await lookOf('second', 'Bricolage Grotesque');
		assert.equal(f.surface, 'rgb(244, 239, 230)', 'cream');
		assert.equal(f.accentBand, 'rgb(31, 58, 46)', 'forest');
		assert.match(f.body, /^system-ui,/);
		assert.match(f.lockup, /^"?Bricolage[_ ]Grotesque-[0-9a-f]+"?,/);
		assert.equal(f.lockupCase, 'uppercase');
	});

	test('Acceptance 23: on every background, in both looks, every piece of text reads at least 4.5:1 on what\'s behind it (and the footer\'s and header\'s too)', async () => {
		const problems: string[] = [];
		for (const which of ['plain', 'second'] as const) {
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`${origins[which]}/schemes`);
			const found = await page.evaluate((schemes) => {
				const toRgba = (c: string): [number, number, number, number] => {
					const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(c);
					if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
					const rgb = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(c);
					if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
					throw new Error(`can't read the colour ${c}`);
				};
				const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
				const lum = (c: number[]) => {
					const [r, g, b] = c.map((v) => {
						const s = v / 255;
						return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
					});
					return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
				};
				const behind = (el: Element): number[] => {
					for (let e: Element | null = el; e; e = e.parentElement) {
						const bg = toRgba(getComputedStyle(e).backgroundColor);
						if (bg[3] > 0) return bg[3] === 1 ? bg.slice(0, 3) : over(bg, behind(e.parentElement ?? document.documentElement));
					}
					return [255, 255, 255];
				};
				const bands = [...document.querySelectorAll('main > section.band, header, footer')];
				const seen = new Set<string>();
				const out: { scheme: string; text: string; ratio: number }[] = [];
				for (const band of bands) {
					const scheme = schemes.find((s) => band.classList.contains(`scheme-${s}`)) ?? band.tagName.toLowerCase();
					seen.add(scheme);
					for (const el of band.querySelectorAll('*')) {
						const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent!.trim()).join(' ').trim();
						if (!text || !el.checkVisibility() || el.getBoundingClientRect().width <= 1) continue;
						const bg = behind(el);
						const fg = over(toRgba(getComputedStyle(el).color), bg);
						const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
						out.push({ scheme, text: text.slice(0, 40), ratio: (hi! + 0.05) / (lo! + 0.05) });
					}
				}
				return { out, seen: [...seen] };
			}, [...SCHEMES]);
			for (const s of [...SCHEMES, 'header', 'footer']) assert.ok(found.seen.includes(s), `${which}: the page has a ${s} band`);
			assert.ok(found.out.length > 40, `${which}: ${found.out.length} pieces of text`);
			for (const t of found.out) if (t.ratio < 4.5) problems.push(`${which} ${t.scheme}: "${t.text}" ${t.ratio.toFixed(2)}:1`);
		}
		assert.deepEqual(problems, []);
	});

	test('Acceptance 16, on the restyle: no lockup line wraps or overflows at 375, 768 or 1440, on any page', async () => {
		const urls = (await listDocuments(second.site)).filter((e) => !e.warning && e.url).map((e) => e.url!);
		assert.deepEqual(await lockupProblems(page, origins.second, [...urls, '/404.html'], [375, 768, 1440]), []);
	});

	test('on the restyle too, no word in the footer breaks mid-word, from 320 to 1920 (the email may break before its @)', async () => {
		assert.deepEqual(await footerProblems(page, origins.second, '/', [320, 360, 375, 414, 640, 768, 1024, 1280, 1440, 1920]), []);
	});
});
