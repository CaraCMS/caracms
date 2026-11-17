// The chrome's colours come from tokens only (M2 Decision 7; M3 Phase 5): no hex,
// rgb() or hsl() colour in the editor's components, CSS or the overlay CSS string,
// outside styles/tokens.css. The overlay CSS goes into the preview's iframes, so it
// copies token values, but only from the token definitions (OVERLAY_TOKENS → the
// `--ov*` tokens), never retyped; brand.ts reads its inks from tokens.css too.
//
// The editor restyle adds two more holds: the sign-in
// pages' LOGIN_CSS is held to the same rule (check 1), and the colours drawn over any
// client's site and the fonts stay as they were before the restyle (checks 10 and 11).
//
//   node --test --experimental-strip-types test/chrome.test.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OVERLAY_CSS, OVERLAY_TOKENS } from '../src/editor/client/overlays/overlay-css.ts';
import { brandColours } from '../src/editor/brand.ts';
import { LOGIN_CSS } from '../src/live/auth/views.ts';

const editor = fileURLToPath(new URL('../src/editor', import.meta.url));
const tokensCss = readFileSync(join(editor, 'styles/tokens.css'), 'utf8');

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

/** A colour literal: #rgb, #rrggbb(aa), rgb(…)/rgba(…) or hsl(…)/hsla(…) with a number in it. */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.]/g;

/** Colour literals in code; a hex-looking run inside a longer word (an id like #add-row) isn't one. */
function colours(text: string): string[] {
	return [...text.matchAll(COLOUR)].filter((m) => !(m[0].startsWith('#') && /[-\w]/.test(text[m.index + m[0].length] ?? ''))).map((m) => m[0]);
}

/** Code without its comments (they may name colours; code may not). */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('tokens only (M2 Decision 7)', () => {
	test('no raw colour in the editor outside styles/tokens.css', () => {
		const found: string[] = [];
		for (const file of files(editor)) {
			if (!/\.(tsx?|css|astro)$/.test(file) || file.endsWith('styles/tokens.css')) continue;
			for (const hit of colours(withoutComments(readFileSync(file, 'utf8')))) found.push(`${relative(editor, file)}: ${hit}`);
		}
		assert.deepEqual(found, []);
	});

	test("no raw colour or literal box-shadow in the sign-in pages' LOGIN_CSS (editor restyle, check 1)", () => {
		// The sign-in pages don't load editor.css: LOGIN_CSS is their stylesheet, on the same tokens.
		assert.ok(LOGIN_CSS.length > 1000 && LOGIN_CSS.includes('.si-card'), 'LOGIN_CSS is the sign-in stylesheet');
		const css = withoutComments(LOGIN_CSS);
		assert.deepEqual(colours(css), []);
		// A named colour is a literal too (transparent and currentColor aren't colours of their own).
		const named = /(?<![\w-])(?:white|black|gr[ae]y|red|green|blue|yellow|orange|purple|pink|brown|navy|teal|silver|gold|maroon|olive|lime|aqua|cyan|magenta)(?![\w-])/;
		const literal = [...css.matchAll(/(?:^|[;{\s])((?:background(?:-color)?|color|border(?:-[a-z]+)*|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|caret-color)\s*:[^;}]+)/g)].map((m) => m[1]!.trim()).filter((d) => named.test(d.replace(/var\([^)]*\)/g, '')));
		assert.deepEqual(literal, []);
	});

	test('the overlay CSS uses only the --cms-* copies, each copied from an --ov* token that exists', () => {
		assert.deepEqual(colours(OVERLAY_CSS), [], 'no colour literal in the overlay CSS');
		const used = new Set([...OVERLAY_CSS.matchAll(/var\((--cms-[\w-]+)\)/g)].map((m) => m[1]!));
		for (const name of used) assert.ok(OVERLAY_TOKENS[name], `${name} is copied from a token`);
		for (const token of Object.values(OVERLAY_TOKENS)) assert.match(tokensCss, new RegExp(`${token}:`), `${token} is defined in tokens.css`);
	});

	test("the brand's inks are the tokens --on-fill and --text, read from tokens.css", () => {
		const value = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(tokensCss)![1]!.toLowerCase();
		assert.equal(brandColours('#1f2f57').accentInk, value('--on-fill'));
		assert.equal(brandColours('#f6e27f').accentInk, value('--text'));
	});
});

// Check 10: the colours drawn over any client's site (the selection, phone and focus colours, and the
// overlays inside the preview) are signals, not part of the look. These are the values from before the
// restyle (2878c91); changing one is a decision, so it means changing this table on purpose.
const SIGNALS: Record<string, string> = {
	'--select': '#1463f3',
	'--select-strong': '#0f56d9',
	'--select-wash': '#ebf2ff',
	'--select-halo': 'rgba(20,99,243,.2)',
	'--phone': '#0a7266',
	'--phone-strong': '#075e54',
	'--phone-wash': '#e7f4f1',
	'--phone-field': '#f7fbfa',
	'--phone-border': '#9dd2c8',
	'--phone-halo': 'rgba(10,114,102,.2)',
	'--focus': '#1463f3',
	'--focus-on-dark': '#8fb8ff',
	'--ov': '#1463f3',
	'--ov-text': '#0f56d9',
	'--ov-halo': 'rgba(255,255,255,.95)',
	'--ov-on': '#ffffff',
	'--ov-surface': '#ffffff',
	'--ov-wash': 'rgba(20,99,243,.07)',
	'--ov-phone': '#0a7266',
	'--ov-warn': '#e08a00',
	'--ov-warn-text': '#6e3c05',
	'--ov-warn-wash': '#fff6e3',
	'--ov-ring': 'rgba(20,99,243,.18)',
	'--ov-lift': 'rgba(0,0,0,.28)',
	'--ov-veil-a': 'rgba(255,255,255,.28)',
	'--ov-veil-b': 'rgba(17,17,15,.16)',
	'--ov-pop': 'rgba(20,20,18,.2)',
	'--ov-pop-line': 'rgba(20,20,18,.12)',
};
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
/** The declarations of tokens.css, comments out (a token is declared once). */
function declared(): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of tokensCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
	return out;
}

describe('what the restyle leaves alone (editor restyle, checks 10 and 11)', () => {
	test('the --select-*, --phone-*, --focus* and --ov-* tokens have their pre-restyle values, and no others of those names have joined them', () => {
		const tokens = declared();
		for (const [name, value] of Object.entries(SIGNALS)) assert.equal(tokens.get(name), value, name);
		const extra = [...tokens.keys()].filter((n) => /^--(select|phone|focus|ov)(-|$)/.test(n) && !(n in SIGNALS));
		assert.deepEqual(extra, [], 'a new signal token is added to SIGNALS on purpose');
	});

	test('the overlays inside the preview are the same CSS over the same token map', () => {
		// Their colours come from the --ov-* tokens pinned above, so with the same CSS they compute the same styles.
		assert.equal(sha(OVERLAY_CSS), 'ddb8a4ffc756567f38417bd068a65f53a737864a0c6679bb931c718dce691643');
		assert.equal(sha(JSON.stringify(OVERLAY_TOKENS)), '46fabb5d58eee9fd191c9f570b6c17b72bbd17e8c7c7bb70b1bd6c468c53f3a2');
	});

	test('--font-ui and --font-mono are unchanged, and the font files and their @font-face rules are untouched', () => {
		const tokens = declared();
		assert.equal(tokens.get('--font-ui'), '"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif');
		assert.equal(tokens.get('--font-mono'), '"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace');
		const fonts: Record<string, string> = {
			'geist-mono-latin-ext-wght-normal.woff2': '1a189eb997c3e2ece68373e387afaec9e8617424186c4b1ab3cff7c54ba6223b',
			'geist-mono-latin-wght-normal.woff2': '684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc',
			'instrument-sans-latin-ext-wght-normal.woff2': 'c4fcfea41f2c1cfeea9211fa43679845454a1d0e0d7e95e069c7e73c4ae302d2',
			'instrument-sans-latin-wght-normal.woff2': '2ee17598a98d8a59e4df8152d015bec9ab8e4d5672cc0ab42bef806b568e3971',
			'OFL-GeistMono.txt': 'cc815ed4fc045f0e991abb10395b7932bd028c6a067deb13316d6002105074e6',
			'OFL-InstrumentSans.txt': 'c27a3c53c3beed7f5c26853afa15991478ff7145d3754a36b0382f84e10c0d03',
		};
		const dir = join(editor, 'fonts');
		assert.deepEqual(readdirSync(dir).sort(), Object.keys(fonts).sort());
		for (const [name, hash] of Object.entries(fonts)) assert.equal(sha(readFileSync(join(dir, name))), hash, name);
		assert.equal(sha(readFileSync(join(editor, 'styles/fonts.css'))), '390e133376658322e9df9e0ee3c11cecc865ebcce682b83286b82cf156191332', 'fonts.css');
	});
});
