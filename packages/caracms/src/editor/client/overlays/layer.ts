/**
 * The overlay layer: what the editor draws over the preview, inside each iframe
 * (M2 Decision 6; Phase 3). One shared layer, which the editor's own marks
 * (editor-marks.ts) and other modules (Phase 4: the block list's hover, insert
 * points) draw into through a small API. See editor/README.md → Overlays.
 *
 *   overlays.set(channel, marks)    show these marks, replacing the channel's last ones
 *   overlays.clear(channel)         show none of the channel's marks
 *   overlays.addPainter(painter)    draw your own elements, positioned against a block, on every redraw
 *   overlays.redraw()               draw again soon (a painter's own state changed)
 *
 * A child of the layer marked `data-cms-keep` (KEEP) is left where it is by every
 * redraw, on top: the formatting bar of rich text on the page (rich-text-bar.ts).
 *
 * **Preview renders only.** The layer is created at run time by /admin in its own
 * iframes; nothing of it is in any render, so the public build can't have it
 * (Decision 17). In each frame it's one element, `#cms-overlays`, appended to
 * `<html>` (outside `<body>`, so the driver's body morph never touches it), plus one
 * `<style>` in `<head>` (never morphed either). It's absolutely positioned in
 * document coordinates, so it scrolls with the page; `pointer-events: none`, except
 * on the buttons marks and painters put there.
 *
 * **Constant size on screen** (M2 → Overlays): each frame is shown scaled, so the
 * layer sets `--k` to 1 / that scale and every size in the CSS is `calc(var(--k) * Npx)`.
 */
import type { PreviewDriver, PreviewFrame } from '../preview/driver.ts';
import type { StageLayout } from '../preview/layout.ts';
import type { Store } from '../state/store.ts';
import type { Width } from '../../types.ts';
import { OVERLAY_CSS, OVERLAY_TOKENS } from './overlay-css.ts';
import { blockElement, blockElements, contextRoots, fieldElement, fieldElements, skippedAnchor, skippedTop, type Ctx } from '../preview/markers.ts';

export type MarkKind =
	/** A block under the pointer (or its row in the block list): thin outline, a wash, a light tag. */
	| 'hover'
	/** The open block: 2px outline, a filled tag. */
	| 'selected'
	/** A field under the pointer inside the open block: a thin dashed ring. */
	| 'field-hover'
	/** The picked field: a 2px ring with the field's name above it. */
	| 'picked'
	/** The field being typed on the page: a soft ring, "Typing on the page". */
	| 'typing'
	/** Amber dashes with an amber chip: "Too long for mobile". */
	| 'warn'
	/** An unknown block, skipped on the page: an amber dashed line across the page where it would be, with a pill. */
	| 'skipped'
	/** Edit in context (Decision 8): what the document open over the page draws there, a faint ring. */
	| 'open'
	/**
	 * Review gaps (Decision 7): a block with states, selected: its tag with the state switch beside it
	 * (`states`). `quiet`: the block's page is under a document open over it (a light tag, a faint ring).
	 */
	| 'states';

export interface Mark {
	kind: MarkKind;
	/** The block's index in the rendered document (`data-cms-block`). */
	block: number;
	/** A field in it (`data-cms-field`); the whole block when absent. */
	field?: string | null;
	/** The tag's, chip's or pill's text. None: no tag. */
	label?: string;
	/**
	 * Edit in context: where it is when it isn't (only) a block by index: the page's own fields,
	 * or a source (markers.ts). Every element there is marked (a source may draw a field twice).
	 */
	at?: readonly Ctx[];
	/** The chip names another document first, quieter: "Footer ›" (edit in context, Decision 8). */
	source?: string;
	/** An icon before the label (the lock, Decision 14). */
	icon?: 'lock';
	/** `phone`: teal, for phone lines. `ro`: the lock's grey (Decision 14). */
	tone?: 'phone' | 'ro';
	/** The frames to draw it in. Default: all three. */
	frames?: readonly Width[];
	/** Makes the mark's label a button (the skipped pill opens its block). */
	onClick?: (event: MouseEvent) => void;
	/** Review gaps (Decision 7): a `states` mark's switch. */
	states?: StateSwitch;
}

/** The state switch a `states` mark draws beside its tag (review gaps, Decision 7). */
export interface StateSwitch {
	/** Each state in the switch's order, the first look first (key null). */
	options: readonly { key: string | null; label: string }[];
	/** The state shown (null: the first look). */
	chosen: string | null;
	/** The chosen state's render is on its way: a pulse on it. */
	waiting: boolean;
	/** The block's page is under a document open over it: a light tag and a faint ring. */
	quiet: boolean;
	/** The folded switch's menu is open (a row too wide for its block folds into one button). */
	menu: boolean;
	/** Says, e.g., "Show the Form block as". */
	name: string;
	choose(key: string | null): void;
	toggleMenu(open: boolean): void;
}

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** What a painter gets, once per frame per redraw. */
export interface OverlayContext {
	frame: PreviewFrame;
	width: Width;
	/** The frame on screen (the others are drawn too, behind it). */
	visible: boolean;
	/** The frame's document. Create elements with `el()`, not the editor's `document`. */
	doc: Document;
	/** 1 / the frame's scale: multiply a size you want on screen by this. The CSS has `--k`. */
	k: number;
	/** A block's element (`[data-cms-block="i"]`), or null. A skipped block has none (see `skippedTop`). */
	block(index: number): HTMLElement | null;
	/** Where skipped block `index` would be, in the layer's coordinates (its comment, preview/markers.ts), or null. */
	skippedTop(index: number): number | null;
	/** A field's element inside a block, or null. */
	field(index: number, field: string): HTMLElement | null;
	/** Every block element on the page, in order. */
	blocks(): HTMLElement[];
	/** An element's box in the layer's coordinates (the document's), grown by `pad` px on screen. */
	rect(el: Element, pad?: number): Rect;
	/** `left/top/width/height` as a style string for a Rect. */
	place(rect: Rect): string;
	/**
	 * Sets a chip's `left` (the layer's coordinates) shifted so the chip sits inside the frame: it is
	 * measured in the layer, then pulled left of the document's right edge (`clientWidth`, which
	 * leaves out a drawn scrollbar), or kept at the left edge if it is wider than the frame.
	 */
	fitLeft(chip: HTMLElement, left: number): void;
	/** An element in the frame's document: `el('div', 'cms-ins', { left: '0px' })`. */
	el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, style?: Partial<Record<string, string>>): HTMLElementTagNameMap[K];
}

/** Returns the elements to put in the layer for this frame (or nothing). Called on every redraw. */
export type OverlayPainter = (ctx: OverlayContext) => Node | readonly Node[] | null | undefined | void;

export interface Overlays {
	set(channel: string, marks: readonly Mark[]): void;
	clear(channel: string): void;
	/** Returns a remove. Painters run after the marks, in the order added. */
	addPainter(painter: OverlayPainter): () => void;
	/** Redraw on the next animation frame (coalesced). */
	redraw(): void;
	/** Redraw now (tests). */
	flush(): void;
	/** The layer element in a frame, if it's mounted. */
	layerOf(frame: PreviewFrame): HTMLElement | null;
	/** Unmount from every frame and stop. */
	destroy(): void;
}

export const LAYER_ID = 'cms-overlays';
/** A child of the layer with this attribute is left alone by every redraw (it draws itself). */
export const KEEP = 'data-cms-keep';
const STYLE_ID = 'cms-overlays-css';
const FONT_FAMILY = 'caracms UI';

/**
 * Mark kinds in drawing order (later ones on top), as the mockup draws them: the
 * painters' elements (insert points, the empty page's invitation) go between the
 * block marks (up to `selected`) and the field marks, so a picked field's ring and
 * a warning sit over an insert point.
 */
const ORDER: MarkKind[] = ['open', 'skipped', 'hover', 'selected', 'field-hover', 'picked', 'typing', 'warn', 'states'];
const UNDER_PAINTERS = new Set<MarkKind>(['open', 'skipped', 'hover', 'selected']);
const LOCK_ICON = '<rect x="3" y="7" width="10" height="7.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>';

export function createOverlays(options: {
	driver: PreviewDriver;
	/** The stage's layout, for each frame's scale. */
	layout: Store<StageLayout | null>;
	/** The width on screen. */
	visibleWidth: () => Width;
	/** The editor's document, to read the overlay tokens from (default: the global document). */
	tokensFrom?: Document;
	/**
	 * M4 (Decision 9): `quiet` draws nothing (a read-only document: no overlays);
	 * `veil` draws only the lock's veil, a two-tone hatch over the whole page that
	 * takes the pointer, so nothing on the page can be clicked or typed. Default normal.
	 */
	mode?: () => { kind: 'normal' } | { kind: 'quiet' } | { kind: 'veil'; title: string };
}): Overlays {
	const { driver, layout } = options;
	const channels = new Map<string, readonly Mark[]>();
	const painters: OverlayPainter[] = [];
	const stops: (() => void)[] = [];
	const tokensFrom = options.tokensFrom ?? document;
	let raf = 0;
	let destroyed = false;
	/** Each frame's veil, while it shows or lifts. */
	const veils = new WeakMap<Document, HTMLElement>();

	const tokens = (() => {
		const style = getComputedStyle(tokensFrom.documentElement);
		const out: string[] = [];
		for (const [name, token] of Object.entries(OVERLAY_TOKENS)) {
			const value = style.getPropertyValue(token).trim();
			if (value) out.push(`${name}:${value}`);
		}
		return out.join(';');
	})();
	// The editor's UI font (the first preloaded font on /admin is Instrument Sans), for the tags.
	const fontUrl = (() => {
		const link = tokensFrom.querySelector<HTMLLinkElement>('link[rel="preload"][as="font"][href*="instrument-sans"]');
		return link ? new URL(link.getAttribute('href')!, tokensFrom.baseURI).href : null;
	})();

	function mount(frame: PreviewFrame): HTMLElement | null {
		const doc = frame.document;
		if (!doc?.documentElement) return null;
		if (!doc.getElementById(STYLE_ID)) {
			const style = doc.createElement('style');
			style.id = STYLE_ID;
			style.textContent =
				(fontUrl ? `@font-face{font-family:"${FONT_FAMILY}";src:url("${fontUrl}") format("woff2");font-weight:100 900;font-display:swap}\n` : '') + OVERLAY_CSS;
			(doc.head ?? doc.documentElement).appendChild(style);
		}
		let layer = doc.getElementById(LAYER_ID);
		if (!layer || layer.parentElement !== doc.documentElement) {
			layer?.remove();
			layer = doc.createElement('div');
			layer.id = LAYER_ID;
			layer.setAttribute('aria-hidden', 'true');
			layer.setAttribute('style', tokens);
			doc.documentElement.appendChild(layer);
		}
		return layer;
	}

	function context(frame: PreviewFrame, doc: Document, win: Window): OverlayContext {
		const scale = layout.get()?.[frame.width].scale ?? 1;
		const k = 1 / (scale > 0 ? scale : 1);
		return {
			frame,
			width: frame.width,
			visible: options.visibleWidth() === frame.width,
			doc,
			k,
			// A fields document's root (`data-cms-document`) is block 0 (preview/markers.ts).
			block: (i) => blockElement(doc, i),
			field: (i, field) => fieldElement(doc, i, field),
			blocks: () => blockElements(doc),
			skippedTop(i) {
				const anchor = skippedAnchor(doc, i);
				return anchor ? skippedTop(anchor) + win.scrollY : null;
			},
			rect(el, pad = 0) {
				const r = el.getBoundingClientRect();
				const p = pad * k;
				return { left: r.left + win.scrollX - p, top: r.top + win.scrollY - p, width: r.width + 2 * p, height: r.height + 2 * p };
			},
			place: (r) => `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`,
			fitLeft(chip, left) {
				const layer = doc.getElementById(LAYER_ID);
				if (layer && !chip.isConnected) layer.appendChild(chip);
				const gap = 6 * k;
				const width = chip.getBoundingClientRect().width;
				const right = (doc.documentElement.clientWidth || win.innerWidth) + win.scrollX - gap;
				chip.style.left = `${Math.max(win.scrollX + gap, Math.min(left, right - width))}px`;
			},
			el(tag, className, style) {
				const node = doc.createElement(tag);
				if (className) node.className = className;
				if (style) for (const [key, value] of Object.entries(style)) if (value !== undefined) node.style.setProperty(key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value);
				return node;
			},
		};
	}

	/** The elements a mark goes round: its `at` contexts' (every one), else its block's or its field's. */
	function targetsOf(ctx: OverlayContext, mark: Mark): HTMLElement[] {
		if (mark.at) return mark.field ? fieldElements(ctx.doc, mark.at, mark.field) : contextRoots(ctx.doc, mark.at);
		const one = mark.field ? ctx.field(mark.block, mark.field) : ctx.block(mark.block);
		return one ? [one] : [];
	}

	function drawMark(ctx: OverlayContext, mark: Mark): Node[] {
		if (mark.kind === 'skipped') {
			const one = drawOne(ctx, mark, null);
			return one ? [one] : [];
		}
		return targetsOf(ctx, mark)
			.map((target) => drawOne(ctx, mark, target))
			.filter((n): n is Node => !!n);
	}

	function drawOne(ctx: OverlayContext, mark: Mark, target: HTMLElement | null): Node | null {
		// A skipped block has no element: its mark goes where its comment is.
		const skippedAt = mark.kind === 'skipped' ? ctx.skippedTop(mark.block) : null;
		if (!target && skippedAt === null) return null;
		const tone = mark.tone ? ` ${mark.tone}` : '';
		const label = (cls: string) => {
			if (!mark.label) return null;
			const tag = ctx.el(mark.onClick ? 'button' : 'span', cls);
			if (mark.icon === 'lock') {
				const svg = ctx.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
				svg.setAttribute('class', 'cms-i');
				svg.setAttribute('viewBox', '0 0 16 16');
				svg.setAttribute('aria-hidden', 'true');
				svg.innerHTML = LOCK_ICON;
				tag.appendChild(svg);
			}
			if (mark.source) {
				const src = ctx.el('span', 'src');
				src.textContent = `${mark.source} ›`;
				tag.appendChild(src);
			}
			if (mark.icon || mark.source) {
				tag.appendChild(ctx.doc.createTextNode(mark.label));
				return tag;
			}
			if (mark.onClick) {
				(tag as HTMLButtonElement).type = 'button';
				tag.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					mark.onClick!(event as MouseEvent);
				});
			}
			tag.textContent = mark.label;
			return tag;
		};
		const box = (cls: string, pad: number, labelClass: string | null) => {
			const el = ctx.el('div', `cms-box ${cls}${tone}`);
			el.setAttribute('style', ctx.place(ctx.rect(target!, pad)));
			el.dataset.mark = mark.kind;
			el.dataset.block = String(mark.block);
			if (mark.field) el.dataset.field = mark.field;
			const tag = labelClass ? label(labelClass) : null;
			if (tag) el.appendChild(tag);
			return el;
		};
		switch (mark.kind) {
			case 'hover':
				return box('cms-hov', 0, 'cms-tag');
			case 'selected':
				return box('cms-sel', 0, 'cms-tag');
			case 'field-hover':
				// A field of another document names it: "Site Settings › Phone" (edit in context, Acceptance 9).
				return box('cms-fhov', 4, mark.label ? 'cms-chip' : null);
			case 'open': {
				// A full-width root (a footer) keeps its ring inside the frame; anything else (a card) a little outside.
				// Measured against the document's width, which leaves out a scrollbar the window's innerWidth counts.
				const wide = target!.getBoundingClientRect().width >= (ctx.doc.documentElement.clientWidth || Infinity) - 4;
				return box('cms-open', wide ? -3 : 6, null);
			}
			case 'picked':
				return box('cms-pick', 6, 'cms-chip');
			case 'typing':
				return box('cms-type', 6, 'cms-chip');
			case 'warn':
				return box('cms-warn', 4, 'cms-chip warn');
			case 'states':
				return mark.states ? drawStates(ctx, mark, mark.states, box(mark.states.quiet ? 'cms-stbox cms-open' : 'cms-stbox', 0, null)) : null;
			case 'skipped': {
				const el = ctx.el('div', 'cms-skip');
				el.style.top = `${skippedAt}px`;
				el.dataset.mark = 'skipped';
				el.dataset.block = String(mark.block);
				const pill = label('');
				if (pill) el.appendChild(pill);
				return el;
			}
		}
	}

	/**
	 * Review gaps (Decision 7): the block's tag and its state switch, a row at the block's top left: a
	 * segment per state, the chosen one filled. When the row is wider than the block it folds into one
	 * button naming the chosen state, with a menu (measured once the layer holds it).
	 */
	function drawStates(ctx: OverlayContext, mark: Mark, sw: StateSwitch, el: HTMLElement): HTMLElement {
		const row = ctx.el('div', 'cms-tagrow');
		if (mark.label) {
			const tag = ctx.el('span', sw.quiet ? 'cms-tag quiet' : 'cms-tag');
			tag.textContent = mark.label;
			row.appendChild(tag);
		}
		const stop = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		const segment = (option: StateSwitch['options'][number], role: 'radio' | 'menuitemradio') => {
			const b = ctx.el('button', '') as HTMLButtonElement;
			b.type = 'button';
			b.setAttribute('role', role);
			b.setAttribute('aria-checked', String(option.key === sw.chosen));
			b.dataset.state = option.key ?? '';
			if (option.key === sw.chosen && sw.waiting) b.appendChild(ctx.el('span', 'cms-wait'));
			b.appendChild(ctx.doc.createTextNode(option.label));
			b.addEventListener('pointerdown', (event) => event.stopPropagation());
			b.addEventListener('click', (event) => {
				stop(event);
				sw.toggleMenu(false);
				if (option.key !== sw.chosen) sw.choose(option.key);
			});
			return b;
		};
		const title = 'See this block at each step a visitor can reach. Only the preview changes; nothing is saved.';
		const full = ctx.el('div', 'cms-states');
		full.setAttribute('role', 'radiogroup');
		full.setAttribute('aria-label', sw.name);
		full.title = title;
		for (const option of sw.options) full.appendChild(segment(option, 'radio'));
		const compact = ctx.el('div', 'cms-states compact');
		compact.title = title;
		const cur = ctx.el('button', 'cur') as HTMLButtonElement;
		cur.type = 'button';
		cur.setAttribute('aria-haspopup', 'menu');
		cur.setAttribute('aria-expanded', String(sw.menu));
		if (sw.waiting) cur.appendChild(ctx.el('span', 'cms-wait'));
		cur.appendChild(ctx.doc.createTextNode(sw.options.find((o) => o.key === sw.chosen)?.label ?? sw.options[0]!.label));
		const chev = ctx.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
		chev.setAttribute('class', 'cms-i');
		chev.setAttribute('viewBox', '0 0 16 16');
		chev.setAttribute('aria-hidden', 'true');
		chev.innerHTML = '<path d="m3.5 6 4.5 4.5L12.5 6"/>';
		cur.appendChild(chev);
		cur.addEventListener('pointerdown', (event) => event.stopPropagation());
		cur.addEventListener('click', (event) => {
			stop(event);
			sw.toggleMenu(!sw.menu);
		});
		compact.appendChild(cur);
		if (sw.menu) {
			const menu = ctx.el('div', 'cms-smenu');
			menu.setAttribute('role', 'menu');
			menu.setAttribute('aria-label', sw.name);
			for (const option of sw.options) menu.appendChild(segment(option, 'menuitemradio'));
			compact.appendChild(menu);
		}
		row.append(full, compact);
		el.appendChild(row);
		// Folds when the row doesn't fit the block's width, once it's in the layer and can be measured.
		queueMicrotask(() => {
			if (!el.isConnected) return;
			const room = el.getBoundingClientRect().width - 8 * ctx.k;
			el.classList.toggle('fold', row.getBoundingClientRect().width > room);
		});
		return el;
	}

	function drawFrame(frame: PreviewFrame) {
		const doc = frame.document;
		const win = frame.window;
		if (!doc || !win) return;
		const layer = mount(frame);
		if (!layer) return;
		const ctx = context(frame, doc, win);
		layer.style.setProperty('--k', ctx.k.toFixed(4));
		const mode = options.mode?.() ?? { kind: 'normal' };
		const height = () => `${Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0)}px`;
		// The veil is one node per frame, kept across redraws, so it can lift: when the lock
		// goes it fades out (`.out`, over --dur-slow) above whatever is drawn now, then goes.
		let veil = veils.get(doc) ?? null;
		if (mode.kind === 'veil') {
			if (!veil || veil.ownerDocument !== doc) {
				veil = ctx.el('div', 'cms-veil');
				veil.dataset.mark = 'veil';
				veils.set(doc, veil);
			}
			veil.classList.remove('out');
			veil.title = mode.title;
			veil.style.height = height();
		} else if (veil) {
			if (!veil.classList.contains('out')) {
				const ms = parseFloat(getComputedStyle(veil).transitionDuration) * 1000 || 0;
				if (ms > 0 && veil.isConnected) {
					veil.classList.add('out');
					const lifting = veil;
					win.setTimeout(() => {
						if (veils.get(doc) !== lifting || !lifting.classList.contains('out')) return;
						veils.delete(doc);
						lifting.remove();
					}, ms + 40);
				} else {
					veils.delete(doc);
					veil = null;
				}
			}
		}
		if (mode.kind !== 'normal') {
			replaceMarks(layer, veil ? [veil] : []);
			return;
		}
		const out: Node[] = [];
		const marks = [...channels.values()].flat().filter((m) => !m.frames || m.frames.includes(frame.width));
		marks.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
		const draw = (mark: Mark) => {
			try {
				out.push(...drawMark(ctx, mark));
			} catch (error) {
				console.error('[caracms] an overlay mark failed:', error);
			}
		};
		marks.filter((m) => UNDER_PAINTERS.has(m.kind)).forEach(draw);
		for (const painter of painters) {
			try {
				const result = painter(ctx);
				if (result) out.push(...(Array.isArray(result) ? result : [result as Node]));
			} catch (error) {
				console.error('[caracms] an overlay painter failed:', error);
			}
		}
		marks.filter((m) => !UNDER_PAINTERS.has(m.kind)).forEach(draw);
		if (veil) out.push(veil);
		replaceMarks(layer, out);
	}

	/**
	 * The layer's children become `nodes`, except the ones marked `data-cms-keep` (the
	 * formatting bar of on-page rich text, rich-text-bar.ts), which stay where they are,
	 * on top: never taken out, since taking out a node that holds focus (the link
	 * popover's search) blurs it.
	 */
	function replaceMarks(layer: HTMLElement, nodes: readonly Node[]) {
		let kept: Element | null = null;
		for (const child of [...layer.childNodes]) {
			if (child.nodeType === 1 && (child as Element).hasAttribute(KEEP)) kept ??= child as Element;
			else child.remove();
		}
		const doc = layer.ownerDocument;
		const frag = doc.createDocumentFragment();
		frag.append(...nodes);
		layer.insertBefore(frag, kept);
	}

	function flush() {
		cancelAnimationFrame(raf);
		raf = 0;
		if (destroyed) return;
		for (const frame of driver.frames()) drawFrame(frame);
	}

	function redraw() {
		if (destroyed || raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			flush();
		});
	}

	// Each frame: the layer on load, again after every morph; a redraw when its page changes size.
	stops.push(
		driver.registerFrameHook((frame) => {
			const doc = frame.document;
			const win = frame.window as (Window & typeof globalThis) | null;
			if (!doc || !win) return;
			mount(frame);
			redraw();
			const observer = new win.ResizeObserver(() => redraw());
			observer.observe(doc.documentElement);
			if (doc.body) observer.observe(doc.body);
			const onFonts = () => redraw();
			doc.fonts?.addEventListener?.('loadingdone', onFonts);
			doc.addEventListener('input', onFonts, true);
			return () => {
				observer.disconnect();
				doc.fonts?.removeEventListener?.('loadingdone', onFonts);
				doc.removeEventListener('input', onFonts, true);
			};
		}),
	);
	stops.push(layout.subscribe(() => redraw()));

	return {
		set(channel, marks) {
			channels.set(channel, marks);
			redraw();
		},
		clear(channel) {
			if (channels.delete(channel)) redraw();
		},
		addPainter(painter) {
			painters.push(painter);
			redraw();
			return () => {
				const i = painters.indexOf(painter);
				if (i >= 0) painters.splice(i, 1);
				redraw();
			};
		},
		redraw,
		flush,
		layerOf(frame) {
			const layer = frame.document?.getElementById(LAYER_ID);
			return layer ?? null;
		},
		destroy() {
			destroyed = true;
			cancelAnimationFrame(raf);
			for (const stop of stops) stop();
			for (const frame of driver.frames()) {
				frame.document?.getElementById(LAYER_ID)?.remove();
				frame.document?.getElementById(STYLE_ID)?.remove();
			}
		},
	};
}
