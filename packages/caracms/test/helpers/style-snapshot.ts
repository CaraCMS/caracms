/**
 * Computed-style snapshots of the editor's chrome, for comparing /admin with the
 * mockup (test/mockup-diff.ts) and for the chrome's own checks (contrast, side
 * rails, motion). Runs in the page: `page.evaluate(snapshot, spec)`.
 *
 * Every element under a root gets a key: its path from the root as `tag.class.class`
 * segments (classes sorted), so the same component has the same key in the mockup
 * and in /admin whatever the content. Wrappers that only group (Spec.skip) are left
 * out of paths; `display: none` elements, SVG internals and iframes' insides are
 * skipped. For each key: the computed styles of every instance, and the order of
 * its children's keys.
 */

export const STYLE_PROPS = [
	'display',
	'position',
	'font-family',
	'font-size',
	'font-weight',
	'font-style',
	'line-height',
	'letter-spacing',
	'text-transform',
	'text-align',
	'white-space',
	'color',
	'background-color',
	'background-image',
	'opacity',
	'visibility',
	'padding-top',
	'padding-right',
	'padding-bottom',
	'padding-left',
	'margin-top',
	'margin-right',
	'margin-bottom',
	'margin-left',
	'row-gap',
	'column-gap',
	'flex-direction',
	'align-items',
	'justify-content',
	'border-top-width',
	'border-top-style',
	'border-top-color',
	'border-right-width',
	'border-right-style',
	'border-right-color',
	'border-bottom-width',
	'border-bottom-style',
	'border-bottom-color',
	'border-left-width',
	'border-left-style',
	'border-left-color',
	'border-top-left-radius',
	'border-top-right-radius',
	'border-bottom-right-radius',
	'border-bottom-left-radius',
	'box-shadow',
	'cursor',
] as const;

/** Elements whose box size is fixed by the design, not by their content: their width or height is compared too. */
export const FIXED_HEIGHT = [
	'bar',
	'trail',
	'lv',
	'drow',
	'brow',
	'grp-h',
	'find',
	'input',
	'btn',
	'ib',
	'rchip',
	'side-foot',
	'logo-slot',
	'seg',
	'tick',
	'chip',
	'n-chip',
	'add-row',
	'sw-in',
	'lk-row',
	'mini-seg',
	'docbtn',
	'keep',
	'twisty',
	'kbd',
];
export const FIXED_WIDTH = ['side', 'logo-slot', 'ib', 'pop', 'toast', 'twisty'];

export interface SnapshotSpec {
	/** A selector in the page, or `frame:<selector>` for an element inside the preview frame on screen. */
	root: string;
	/** Wrappers to leave out of paths (their children are walked as the parent's). */
	skip?: string;
	props: readonly string[];
	fixedHeight: readonly string[];
	fixedWidth: readonly string[];
}

export interface ElementRecord {
	styles: Record<string, string>;
	/** The keys of its children, in order. */
	kids: string[];
	text: string;
}

export type Snapshot = Record<string, ElementRecord[]>;

/** In the page. Returns null when the root isn't there. */
export function snapshot(spec: SnapshotSpec): Snapshot | null {
	let root: Element | null = null;
	if (spec.root.startsWith('frame:')) {
		const iframe = document.querySelector<HTMLIFrameElement>('#stage .frame.on iframe');
		root = iframe?.contentDocument?.querySelector(spec.root.slice(6)) ?? null;
	} else {
		root = document.querySelector(spec.root);
	}
	if (!root) return null;
	const view = root.ownerDocument.defaultView!;
	const out: Snapshot = {};
	// Only classes some stylesheet in the page mentions: a class that's only a hook (for a test or a
	// script) doesn't change how anything looks, so it's left out of the keys.
	const styled = new Set<string>();
	const collect = (rules: CSSRuleList) => {
		for (const rule of rules) {
			if ('selectorText' in rule) for (const m of String((rule as CSSStyleRule).selectorText).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) styled.add(m[1]!);
			if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) collect((rule as CSSGroupingRule).cssRules);
		}
	};
	for (const sheet of root.ownerDocument.styleSheets) {
		try {
			collect(sheet.cssRules);
		} catch {
			/* a cross-origin sheet: its classes aren't the chrome's */
		}
	}
	const seg = (el: Element) => {
		const tag = el.tagName.toLowerCase();
		const classes = [...el.classList].filter((c) => styled.has(c)).sort();
		return tag + classes.map((c) => `.${c}`).join('');
	};
	const TYPE = new Set(['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'white-space', 'color']);
	const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [draggable="true"], .grip';
	const record = (el: Element, key: string, kids: string[]) => {
		const cs = view.getComputedStyle(el);
		const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '') || /^(input|textarea|select)$/i.test(el.tagName);
		const svg = el.tagName.toLowerCase() === 'svg';
		const typed = (el as HTMLElement).computedStyleMap?.();
		const styles: Record<string, string> = {};
		for (const p of spec.props) {
			// Inherited text styles matter where there's text (and an icon's colour, its stroke).
			if (TYPE.has(p) && !own && !(svg && p === 'color')) continue;
			if (p === 'cursor' && !el.matches(INTERACTIVE)) continue;
			const side = /^border-(top|right|bottom|left)-color$/.exec(p)?.[1];
			if (side && (cs.getPropertyValue(`border-${side}-style`) === 'none' || parseFloat(cs.getPropertyValue(`border-${side}-width`)) === 0)) continue;
			// Margins as specified when they're auto (the used value is the content's).
			if (p.startsWith('margin-') && typed) {
				const v = String(typed.get(p) ?? '');
				if (v === 'auto') {
					styles[p] = 'auto';
					continue;
				}
			}
			styles[p] = cs.getPropertyValue(p);
		}
		const box = el.getBoundingClientRect();
		const has = (names: readonly string[]) => names.some((n) => el.classList.contains(n) || el.id === n || el.tagName.toLowerCase() === n);
		if (has(spec.fixedHeight)) styles.height = `${Math.round(box.height * 2) / 2}px`;
		if (has(spec.fixedWidth)) styles.width = `${Math.round(box.width * 2) / 2}px`;
		(out[key] ??= []).push({ styles, kids, text: (el.textContent ?? '').trim().slice(0, 40) });
	};
	const children = (el: Element): Element[] => {
		const found: Element[] = [];
		for (const child of el.children) {
			if (view.getComputedStyle(child).display === 'none') continue;
			if (spec.skip && child.matches(spec.skip)) found.push(...children(child));
			else found.push(child);
		}
		return found;
	};
	const walk = (el: Element, key: string) => {
		const kids = children(el);
		const keys: string[] = [];
		for (const kid of kids) {
			const k = `${key} > ${seg(kid)}`;
			if (keys.at(-1) !== seg(kid)) keys.push(seg(kid));
			const tag = kid.tagName.toLowerCase();
			if (tag === 'svg' || tag === 'iframe' || tag === 'img' || tag === 'option') {
				record(kid, k, []);
				continue;
			}
			walk(kid, k);
		}
		record(el, key, keys);
	};
	walk(root, '(root)');
	return out;
}
