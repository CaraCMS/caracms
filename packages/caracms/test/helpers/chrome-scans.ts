/**
 * The chrome's checks in the page (chrome.visual.test.ts and chrome-live.visual.test.ts):
 * contrast, side rails and motion, run with `page.evaluate`; the sample accents and the
 * demo copied with one.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright-core';

export const ACCENTS = { navy: '#1f2f57', yellow: '#f6e27f' } as const;
export type Accent = keyof typeof ACCENTS;

/**
 * The demo with this accent and no logo or icon (so the brand slot draws the initial on the accent).
 * The whole brand is Site Settings' (M5a Decision 10, M5b Decision 11), and the pinned
 * fixture's names no logo or icon.
 */
export const withAccent = (accent: string) => (root: string) => {
	const settings = join(root, 'content/site-settings.json');
	const text = readFileSync(settings, 'utf8');
	const changed = text.replace(/"accent": "#[0-9a-fA-F]+"/, `"accent": "${accent}"`);
	assert.notEqual(changed, text, 'the sample accent is set in Site Settings');
	writeFileSync(settings, changed);
};

export const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
export const park = async (page: Page) => {
	const box = await page.locator('#bar .bar-a').boundingBox();
	if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};


/** In the page: every visible piece of text and every icon in the chrome, with its contrast against what's behind it. */
export function contrastScan(roots = '#side, #bar, #pops, #toast-root') {
	type RGBA = [number, number, number, number];
	const probe = document.createElement('i');
	document.body.append(probe);
	const parse = (c: string): RGBA => {
		const m = /rgba?\(([^)]+)\)/.exec(c);
		if (!m) {
			probe.style.color = c;
			return parse(getComputedStyle(probe).color);
		}
		const [r, g, b, a] = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number) as number[];
		return [r!, g!, b!, a ?? 1];
	};
	const over = (top: RGBA, bottom: RGBA): RGBA => {
		const a = top[3] + bottom[3] * (1 - top[3]);
		const mixc = (i: number) => (top[i]! * top[3] + bottom[i]! * bottom[3] * (1 - top[3])) / (a || 1);
		return [mixc(0), mixc(1), mixc(2), a];
	};
	const lum = ([r, g, b]: RGBA) => {
		const f = (v: number) => {
			const c = v / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
	};
	const ratio = (a: RGBA, b: RGBA) => {
		const x = lum(a);
		const y = lum(b);
		return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
	};
	const behind = (el: Element): RGBA => {
		const layers: RGBA[] = [];
		for (let e: Element | null = el; e; e = e.parentElement) {
			const c = parse(getComputedStyle(e).backgroundColor);
			if (c[3] > 0) layers.push(c);
			if (c[3] >= 1) break;
		}
		return layers.reverse().reduce<RGBA>((bottom, top) => over(top, bottom), [255, 255, 255, 1]);
	};
	const shown = (el: Element) => {
		const r = el.getBoundingClientRect();
		if (r.width < 2 || r.height < 2) return false;
		for (let e: Element | null = el; e; e = e.parentElement) {
			const cs = getComputedStyle(e);
			if (cs.visibility !== 'visible' && e === el) return false;
			if (parseFloat(cs.opacity) < 1) return false;
		}
		return true;
	};
	const describe = (el: Element) => {
		const cls = [...el.classList].join('.');
		const parent = el.parentElement ? `${el.parentElement.tagName.toLowerCase()}.${[...el.parentElement.classList].join('.')} > ` : '';
		return `${parent}${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} “${(el.textContent ?? '').trim().slice(0, 30)}”`;
	};
	const out: { what: string; kind: string; ratio: number; need: number }[] = [];
	for (const root of document.querySelectorAll(roots)) {
		for (const el of root.querySelectorAll('*')) {
			if (el.closest(':disabled, [aria-disabled="true"], .sr, [hidden]')) continue;
			const svg = el.tagName.toLowerCase() === 'svg';
			const text = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
			if (!svg && !text) continue;
			if (!shown(el)) continue;
			const cs = getComputedStyle(el);
			const bg = behind(svg ? el.parentElement! : el);
			const fg = over(parse(cs.color), bg);
			const size = parseFloat(cs.fontSize);
			const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
			const need = svg || large ? 3 : 4.5;
			out.push({ what: describe(el), kind: svg ? 'icon' : large ? 'large text' : 'text', ratio: Math.round(ratio(fg, bg) * 100) / 100, need });
		}
	}
	// The brand tile against its slot: the tile's edge (or the tile) must stand out 3:1.
	for (const tile of document.querySelectorAll('.logo-mono')) {
		const slot = behind(tile.parentElement!);
		const cs = getComputedStyle(tile);
		const edge = /rgba?\([^)]+\)/.exec(cs.boxShadow)?.[0];
		const best = Math.max(ratio(over(parse(cs.backgroundColor), slot), slot), edge ? ratio(over(parse(edge), slot), slot) : 0);
		out.push({ what: `the brand tile in ${describe(tile.parentElement!)}`, kind: 'brand tile', ratio: Math.round(best * 100) / 100, need: 3 });
	}
	// An on switch against what's behind it (editor restyle, check 17): the accent track or its --accent-edge ring
	// must stand out 3:1. A track has no text or svg, so the loop above skips it.
	for (const root of document.querySelectorAll(roots)) {
		for (const track of root.querySelectorAll('.switch[aria-checked="true"] .track')) {
			if (track.closest(':disabled, [aria-disabled="true"], [hidden]') || !shown(track)) continue;
			const back = behind(track.parentElement!);
			const cs = getComputedStyle(track);
			const ring = /rgba?\([^)]+\)/.exec(cs.boxShadow)?.[0];
			const best = Math.max(ratio(over(parse(cs.backgroundColor), back), back), ring ? ratio(over(parse(ring), back), back) : 0);
			out.push({ what: `the on switch ${describe(track.parentElement!)}`, kind: 'on switch', ratio: Math.round(best * 100) / 100, need: 3 });
		}
	}
	probe.remove();
	return out;
}

/** In the page: anything in the chrome drawn like a side rail. */
export function railScan(scope = '#app *') {
	const out: string[] = [];
	const transparent = (c: string) => /rgba\([^)]*,\s*0\)$/.test(c) || c === 'transparent';
	const name = (el: Element, pseudo = '') =>
		`${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join('')}${pseudo} “${(el.textContent ?? '').trim().slice(0, 24)}”`;
	for (const el of document.querySelectorAll(scope)) {
		if (el.closest('iframe, svg')) continue;
		const cs = getComputedStyle(el);
		for (const side of ['left', 'inline-start']) {
			const width = parseFloat(cs.getPropertyValue(`border-${side}-width`));
			if (width > 1 && cs.getPropertyValue(`border-${side}-style`) !== 'none' && !transparent(cs.getPropertyValue(`border-${side}-color`))) {
				const other = parseFloat(cs.getPropertyValue(side === 'left' ? 'border-right-width' : 'border-inline-end-width'));
				if (other < width) out.push(`${name(el)}: a ${width}px border on its ${side} side`);
			}
		}
		// Inset shadows: a full ring has no offset; one offset to a side is a rail.
		for (const shadow of cs.boxShadow.split(/,(?![^(]*\))/)) {
			if (!/inset/.test(shadow)) continue;
			const nums = shadow.replace(/rgba?\([^)]*\)/g, '').match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
			if ((nums[0] ?? 0) !== 0 || (nums[1] ?? 0) !== 0) out.push(`${name(el)}: an inset shadow offset to one side (${shadow.trim()})`);
		}
		for (const pseudo of ['::before', '::after']) {
			const ps = getComputedStyle(el, pseudo);
			if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
			const w = parseFloat(ps.width);
			const h = parseFloat(ps.height);
			const painted = !transparent(ps.backgroundColor) || ['left', 'right'].some((s) => parseFloat(ps.getPropertyValue(`border-${s}-width`)) > 0 && !transparent(ps.getPropertyValue(`border-${s}-color`)));
			if (painted && w <= 6 && h >= 10) out.push(`${name(el, pseudo)}: a ${w}×${h} stripe`);
		}
	}
	return out;
}

/** In the page: anything in the chrome with a transition or animation, and anything running now. */
export const moving = () => {
	const out: string[] = [];
	const ms = (v: string) => Math.max(...v.split(',').map((t) => parseFloat(t) * (t.trim().endsWith('ms') ? 1 : 1000)));
	const check = (el: Element, pseudo: string | null) => {
		const cs = getComputedStyle(el, pseudo);
		if (pseudo && (cs.content === 'none' || cs.content === 'normal')) return;
		const what = `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join('')}${pseudo ?? ''}`;
		if (cs.transitionProperty !== 'none' && ms(cs.transitionDuration) > 0) out.push(`${what}: transition ${cs.transitionProperty} ${cs.transitionDuration}`);
		if (cs.animationName !== 'none' && ms(cs.animationDuration) > 0) out.push(`${what}: animation ${cs.animationName} ${cs.animationDuration}`);
	};
	for (const el of document.querySelectorAll('#app *')) {
		if (el.closest('svg')) continue;
		check(el, null);
		check(el, '::before');
		check(el, '::after');
	}
	// Anything actually running right now.
	for (const a of document.getAnimations()) {
		const d = Number(a.effect?.getComputedTiming().duration ?? 0);
		if (a.playState === 'running' && d > 0) out.push(`running: ${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? 'an animation'} ${d}ms`);
	}
	return out;
};
/** In the page: transitions in the preview's overlay layer. */
export const layerMoving = () => {
	const doc = document.querySelector<HTMLIFrameElement>('#stage .frame.on iframe')!.contentDocument!;
	const win = doc.defaultView!;
	const out: string[] = [];
	for (const el of doc.querySelectorAll('#cms-overlays, #cms-overlays *')) {
		for (const pseudo of [null, '::before', '::after']) {
			const cs = win.getComputedStyle(el, pseudo);
			if (cs.transitionProperty !== 'none' && parseFloat(cs.transitionDuration) > 0) out.push(`overlay ${el.className}${pseudo ?? ''}: ${cs.transitionDuration}`);
		}
	}
	return out;
};

/**
 * In the page (editor restyle, check 9): the frame that means "needs you". Reads every framed and every calm kind of
 * object on screen: `.note.warn` and `.note.danger` (not the draft-kept merge notice), a field with a problem, a toned
 * dialog and the bar's warning and failed pills carry their tone's border and hard shadow; a `.note.lock`, `.note.select`,
 * the draft-kept notice, the bar's Publish with drafts, a block row and a document row carry none; a popover, menu or
 * dialog without a tone has only the neutral frame. `seen` counts what it found, so a test can say it looked at some.
 */
export function frameScan(roots = '#app, #pops, #toast-root, #modal-root') {
	const failures: string[] = [];
	const seen: Record<string, number> = {};
	const probe = document.createElement('i');
	document.body.append(probe);
	const colour = (token: string) => {
		probe.style.color = `var(${token})`;
		return getComputedStyle(probe).color;
	};
	const framesByTone: Record<string, string> = { neutral: colour('--frame-neutral'), warning: colour('--frame-warning'), danger: colour('--frame-danger'), 'warning-on-dark': colour('--frame-warning-on-dark'), 'danger-on-dark': colour('--frame-danger-on-dark') };
	const name = (el: Element) => `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join('')} “${(el.textContent ?? '').trim().slice(0, 24)}”`;
	/** Hard diagonal shadows (the frame's, not a button's straight-down edge): outside the box, offset both ways, no blur, no spread (Chrome computes the colour first). */
	const hard = (el: Element) =>
		[...getComputedStyle(el).boxShadow.matchAll(/(?:oklab|oklch|rgba?)\([^)]*\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?(\s+inset)?/g)].filter(
			(m) => !m[5] && Number(m[3]) === 0 && Number(m[4] ?? 0) === 0 && Number(m[1]) !== 0 && Number(m[2]) !== 0,
		);
	const framed = (el: Element, kind: string, tone: string) => {
		seen[kind] = (seen[kind] ?? 0) + 1;
		const cs = getComputedStyle(el);
		if (cs.borderTopColor !== framesByTone[tone]) failures.push(`${kind} ${name(el)}: border ${cs.borderTopColor}, want the ${tone} frame ${framesByTone[tone]}`);
		// (The frame's 1.5px computes as 1px at a device-pixel ratio of 1, so its width can't tell it from a plain border; its colour and shadow do.)
		if (!(parseFloat(cs.borderTopWidth) >= 1)) failures.push(`${kind} ${name(el)}: no border (${cs.borderTopWidth})`);
		if (hard(el).length === 0) failures.push(`${kind} ${name(el)}: no hard shadow (${cs.boxShadow})`);
	};
	const calm = (el: Element, kind: string) => {
		seen[kind] = (seen[kind] ?? 0) + 1;
		const cs = getComputedStyle(el);
		const frames = Object.entries(framesByTone).filter(([tone, c]) => tone !== 'neutral' && cs.borderTopColor === c);
		if (frames.length) failures.push(`${kind} ${name(el)}: framed (${frames[0]![0]}) but should be calm`);
		if (hard(el).length) failures.push(`${kind} ${name(el)}: a hard shadow (${cs.boxShadow}) but should be calm`);
	};
	const neutral = (el: Element, kind: string) => {
		seen[kind] = (seen[kind] ?? 0) + 1;
		const cs = getComputedStyle(el);
		if (cs.borderTopColor !== framesByTone.neutral) failures.push(`${kind} ${name(el)}: border ${cs.borderTopColor}, want the neutral frame`);
		if (hard(el).length === 0) failures.push(`${kind} ${name(el)}: no hard shadow`);
	};
	for (const root of document.querySelectorAll(roots)) {
		for (const el of root.querySelectorAll('.note.warn')) (el as HTMLElement).dataset.note === 'draft-kept' ? calm(el, 'the draft-kept notice') : framed(el, '.note.warn', 'warning');
		for (const el of root.querySelectorAll('.note.danger')) framed(el, '.note.danger', 'danger');
		for (const el of root.querySelectorAll('.note.lock')) calm(el, '.note.lock');
		for (const el of root.querySelectorAll('.note.select')) calm(el, '.note.select');
		for (const el of root.querySelectorAll('.input[aria-invalid="true"]:not(:focus)')) framed(el, 'an invalid field', 'danger');
		for (const el of root.querySelectorAll('.input:has(+ .field-warn[data-over]:not([hidden])):not(:focus)')) framed(el, 'a field over its limit', 'warning');
		for (const el of root.querySelectorAll('.dialog.danger')) framed(el, '.dialog.danger', 'danger');
		for (const el of root.querySelectorAll('.dialog.warn')) framed(el, '.dialog.warn', 'warning');
		for (const el of root.querySelectorAll('.dialog:not(.danger):not(.warn)')) neutral(el, 'a dialog without a tone');
		for (const el of root.querySelectorAll('.pop, .menu')) neutral(el, 'a popover or menu');
		for (const el of root.querySelectorAll('.bar-warn')) framed(el, '.bar-warn', 'warning-on-dark');
		for (const el of root.querySelectorAll('.pub.fail')) framed(el, '.pub.fail', 'danger-on-dark');
		for (const el of root.querySelectorAll('.pub:not(.fail)')) calm(el, 'the bar’s Publish');
		for (const el of root.querySelectorAll('.brow, .drow')) calm(el, 'a block or document row');
	}
	probe.remove();
	return { failures, seen };
}

/** In the page: how a control looks right now (its pressed edge, the sink and the fill), for the :active check (editor restyle, check 7). */
export const lookOf = (el: Element) => {
	const cs = getComputedStyle(el);
	const layers: string[] = [];
	let depth = 0;
	let from = 0;
	for (let i = 0; i <= cs.boxShadow.length; i++) {
		const ch = cs.boxShadow[i];
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if ((ch === ',' && depth === 0) || i === cs.boxShadow.length) {
			layers.push(cs.boxShadow.slice(from, i).trim());
			from = i + 1;
		}
	}
	const parsed = layers
		.filter((l) => l && l !== 'none')
		.map((l) => {
			const colour = /(?:oklab|oklch|rgba?|color)\([^)]*\)/.exec(l)?.[0] ?? '';
			const [x, y, blur, spread] = (l.replace(colour, '').match(/-?[\d.]+(?=px)/g) ?? []).map(Number);
			return { inset: /\binset\b/.test(l), colour, x: x ?? 0, y: y ?? 0, blur: blur ?? 0, spread: spread ?? 0 };
		});
	// The edge: the hard layer outside the box (an offset, no blur, no spread).
	const edge = parsed.find((l) => !l.inset && l.blur === 0 && l.spread === 0) ?? null;
	return {
		translate: cs.translate,
		edge: edge ? { x: edge.x, y: edge.y, colour: edge.colour } : null,
		background: cs.backgroundColor,
		transition: cs.transitionDuration,
	};
};
export type Look = ReturnType<typeof lookOf>;

/** A control at rest, with the mouse button held down on it (a real :active), and after release. */
export async function pressLook(page: Page, control: Locator): Promise<{ rest: Look; down: Look; up: Look }> {
	const rest = await control.evaluate(lookOf);
	const box = (await control.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	const down = await control.evaluate(lookOf);
	await page.mouse.up();
	const up = await control.evaluate(lookOf);
	return { rest, down, up };
}
