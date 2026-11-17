/**
 * Measure a lockup line's width in ems, from the font file, as the browser will
 * draw it (Spec → Text → "What's measured"; lifted from M1, E4: within 0.064% of Chrome).
 *
 * - Shaped with HarfBuzz (harfbuzzjs), the shaper Chrome and Firefox use, so
 *   kerning (GPOS) and substitutions (GSUB) match their defaults.
 * - The style's text-transform is applied before shaping.
 * - The style's variable axes are pinned (TextStyle.axes), as the CSS pins them.
 * - Tracking is added once per grapheme cluster, including after the last one
 *   (browsers draw that trailing letter-space).
 * - With non-zero tracking, optional ligatures (`liga`, `clig`) are off, as CSS asks.
 * - **Uncovered characters** (Decision 15): a character the font has no glyph for
 *   shapes as `.notdef` (glyph 0) here, but the browser draws it from a system
 *   font at an unknown width, so the fit can overflow. They're reported, per line,
 *   as the graphemes as drawn (after the transform), so the editor can say
 *   "“✨” isn't in this font, so this line may not fit".
 *
 * Synchronous after module load (harfbuzzjs initialises its wasm with a top-level
 * await), so it runs inside an Astro component's frontmatter during render.
 */
import { readFileSync } from 'node:fs';
import type * as Harfbuzz from 'harfbuzzjs';
import type { TextStyle, TextTransform } from './text-styles.ts';
import { normaliseLines } from './fields.ts';

/** What measuring needs from a style: the measured font's absolute path, and how it's set. */
export type MeasureStyle = Pick<TextStyle, 'axes' | 'trackingEm' | 'textTransform'> & {
	resolvedFontFile: { measure: string };
};

/**
 * harfbuzzjs, loaded at runtime from where it's installed. The integration sets
 * `__CARACMS_HARFBUZZ__` (a Vite `define`) to its entry's file URL, because a
 * built site can't bundle it (it reads its .wasm beside itself) and, under pnpm,
 * can't resolve it from the site's own folder either (it's the package's
 * dependency, not the site's). Outside Vite (node:test) it's a plain import.
 */
declare const __CARACMS_HARFBUZZ__: string | undefined;
const hb: typeof Harfbuzz = await import(
	/* @vite-ignore */ typeof __CARACMS_HARFBUZZ__ === 'string' ? __CARACMS_HARFBUZZ__ : 'harfbuzzjs'
);

interface LoadedFont {
	font: Harfbuzz.Font;
	upem: number;
}

// A cache of shaping fonts by file and axes: immutable, so safe to share between renders.
const fonts = new Map<string, LoadedFont>();

function fontFor(style: MeasureStyle): LoadedFont {
	const path = style.resolvedFontFile.measure;
	const key = `${path}|${JSON.stringify(style.axes)}`;
	let loaded = fonts.get(key);
	if (!loaded) {
		const face = new hb.Face(new hb.Blob(readFileSync(path)));
		const font = new hb.Font(face);
		const axes = Object.entries(style.axes);
		if (axes.length > 0) font.setVariations(axes.map(([tag, value]) => new hb.Variation(tag, value)));
		loaded = { font, upem: face.upem };
		fonts.set(key, loaded);
	}
	return loaded;
}

export function applyTransform(text: string, transform: TextTransform): string {
	switch (transform) {
		case 'uppercase':
			return text.toLocaleUpperCase('en');
		case 'lowercase':
			return text.toLocaleLowerCase('en');
		default:
			return text;
	}
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export interface MeasuredLine {
	text: string;
	/** Width in em at the style's tracking, transform and axes. */
	em: number;
	/** Graphemes (as drawn, after the transform) the font has no glyph for, in order, without repeats. */
	uncovered: string[];
}

/** Measure one line. Empty → 0 em. */
export function measureLineDetail(line: string, style: MeasureStyle): MeasuredLine {
	const text = applyTransform(line, style.textTransform);
	if (text.length === 0) return { text: line, em: 0, uncovered: [] };

	const { font, upem } = fontFor(style);
	const buffer = new hb.Buffer();
	buffer.addText(text);
	buffer.guessSegmentProperties();
	const features = style.trackingEm !== 0 ? [new hb.Feature('liga', 0), new hb.Feature('clig', 0)] : [];
	hb.shape(font, buffer, features);

	let advance = 0;
	for (const p of buffer.getGlyphPositions()) advance += p.xAdvance;

	// Graphemes by UTF-16 offset; a glyph's cluster is the offset of its first code unit.
	const graphemes = [...segmenter.segment(text)];
	const uncovered: string[] = [];
	for (const info of buffer.getGlyphInfos()) {
		if (info.codepoint !== 0) continue; // after shaping, `codepoint` is the glyph id; 0 is .notdef
		const g = graphemes.findLast((s) => s.index <= info.cluster)?.segment;
		if (g && !/^\s+$/.test(g) && !uncovered.includes(g)) uncovered.push(g);
	}

	return { text: line, em: advance / upem + graphemes.length * style.trackingEm, uncovered };
}

/** The line's width in ems. */
export function measureLine(line: string, style: MeasureStyle): number {
	return measureLineDetail(line, style).em;
}

/** Graphemes in a line the style's font doesn't cover (Decision 15). */
export function uncoveredCharacters(line: string, style: MeasureStyle): string[] {
	return measureLineDetail(line, style).uncovered;
}

export interface MeasuredLockup {
	lines: MeasuredLine[];
	/** The longest line's em width; drives `--longest-line`. */
	longest: number;
	/** Every uncovered grapheme across the lines, without repeats. */
	uncovered: string[];
}

/** Measure a set of lines as the lockup renders them: trimmed, blank lines dropped. */
export function measureLockup(lines: readonly string[], style: MeasureStyle): MeasuredLockup {
	const measured = normaliseLines(lines).map((text) => measureLineDetail(text, style));
	const uncovered = [...new Set(measured.flatMap((l) => l.uncovered))];
	return { lines: measured, longest: Math.max(0, ...measured.map((l) => l.em)), uncovered };
}

/**
 * The size a lockup computes at a given container width, in px, by the CSS fit:
 * `min(size, width / longest)`. What the browser does; for tests and the demo's numbers.
 */
export function fittedSizePx(longestEm: number, containerPx: number, sizePx: number): number {
	return longestEm > 0 ? Math.min(sizePx, containerPx / longestEm) : sizePx;
}
