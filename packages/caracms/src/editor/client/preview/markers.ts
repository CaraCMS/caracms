/**
 * Finding a block's element in a preview (M3 Decision 17's markers), for every kind of
 * document (M5a Decision 16):
 *
 * - a section builder's blocks, and a shared block on its own, carry
 *   `data-cms-block="<index>"`;
 * - a list-of-fields document's component carries `data-cms-document="<collection>"`
 *   in place of `data-cms-block`, with the fields' markers under it. The editor holds
 *   that document as one block (document-store.ts), index 0, so it's that block here.
 *
 * A block the render skips (an unknown type) has no element: a preview leaves a comment
 * where it would be (skipped.ts), found with `skippedAnchor`, and placed between the
 * elements either side of it with `skippedTop`.
 *
 * Everything that maps between the page and the editor's blocks goes through these, so
 * the same lookup works with or without a block index.
 */
import { parseSkipped } from '../../../skipped.ts';

/** The selector for any block's root (or a fields document's). */
export const BLOCK_ROOT = '[data-cms-block],[data-cms-document]';

/** The block root an element is in, or null. */
export function blockRootOf(el: Element | null | undefined): HTMLElement | null {
	return (el?.closest?.(BLOCK_ROOT) as HTMLElement | null) ?? null;
}

/** A block root's index: its `data-cms-block`, or 0 for a fields document's root. NaN when it has neither. */
export function blockIndexOf(root: HTMLElement): number {
	if (root.dataset.cmsBlock !== undefined) return Number(root.dataset.cmsBlock);
	return root.hasAttribute('data-cms-document') ? 0 : Number.NaN;
}

/** The element of block `index` in a document (a fields document's root for 0 when there's no block 0), or null. */
export function blockElement(doc: Document | ParentNode, index: number | string): HTMLElement | null {
	const found = doc.querySelector<HTMLElement>(`[data-cms-block="${CSS.escape(String(index))}"]`);
	if (found) return found;
	return String(index) === '0' ? doc.querySelector<HTMLElement>('[data-cms-document]') : null;
}

/** Every block root in a document, in order. */
export function blockElements(doc: Document | ParentNode): HTMLElement[] {
	return [...doc.querySelectorAll<HTMLElement>(BLOCK_ROOT)];
}

/** A field's element (`data-cms-field`, which may be a dotted path) inside block `index`, optionally of a kind. */
export function fieldElement(doc: Document | ParentNode, index: number | string, field: string, kind?: string): HTMLElement | null {
	const block = blockElement(doc, index);
	return block?.querySelector<HTMLElement>(`[data-cms-field="${CSS.escape(field)}"]${kind ? `[data-cms-kind="${CSS.escape(kind)}"]` : ''}`) ?? null;
}

/** The comment a preview leaves for skipped block `index` (skipped.ts), or null. */
export function skippedAnchor(doc: Document, index: number): Comment | null {
	const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_COMMENT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (parseSkipped((node as Comment).data)?.index === index) return node as Comment;
	}
	return null;
}

const UNBOXED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'NOSCRIPT']);
/** The element beside a node in one direction that takes a box on the page (skips scripts, styles, `display: none`). */
function boxed(node: Node, dir: 'previousSibling' | 'nextSibling'): Element | null {
	for (let n = node[dir]; n; n = n[dir]) {
		if (n.nodeType !== 1) continue;
		const el = n as Element;
		if (UNBOXED.has(el.tagName) || el.getClientRects().length === 0) continue;
		return el;
	}
	return null;
}

/**
 * Where a skipped block would be, in viewport pixels (as `getBoundingClientRect().top`):
 * the middle of the gap between the elements either side of its comment, the bottom
 * of the one before or the top of the one after when it's at an end, and the top of
 * its parent when it's alone.
 */
export function skippedTop(anchor: Comment): number {
	const before = boxed(anchor, 'previousSibling');
	const after = boxed(anchor, 'nextSibling');
	if (before && after) return (before.getBoundingClientRect().bottom + after.getBoundingClientRect().top) / 2;
	if (before) return before.getBoundingClientRect().bottom;
	if (after) return after.getBoundingClientRect().top;
	return anchor.parentElement?.getBoundingClientRect().top ?? 0;
}

// ── Edit in context: sources and the page's own fields ──────────────────────────────
//
// Beside a block's root, a preview marks two more kinds of context (carrier A, edit in
// context's Contracts): a source, `data-cms-source="settings" | "shared/<path>" |
// "<collection>/<path>"` (a header or footer slot, Site Settings' fields, an entry a block
// read), and the page's own fields, `data-cms-page` (bare). **A field element under either
// carries that marker itself too**, so a field's context is `closest(CONTEXT)` from the
// field, and a Site Settings phone inside the footer's root is Site Settings'. `BLOCK_ROOT`
// matches neither.

/** Every element that starts a context: a block's root, a fields document's, a source's, a page region. */
export const CONTEXT = '[data-cms-source],[data-cms-page],[data-cms-block],[data-cms-document]';

/** What a context is, in the page's terms: a block (by index), the page's own fields, or a source (its `docId`). */
export type Ctx = { kind: 'block'; index: number } | { kind: 'page' } | { kind: 'source'; id: string };

/** The context element an element is in (itself included), or null: the frame a site draws itself, or nothing marked. */
export function contextRootOf(el: Element | null | undefined): HTMLElement | null {
	return (el?.closest?.(CONTEXT) as HTMLElement | null) ?? null;
}

/** A context element's context. A source wins over a block marker on the same element (it never has both). */
export function ctxOf(root: HTMLElement): Ctx | null {
	const source = root.getAttribute('data-cms-source');
	if (source !== null) return { kind: 'source', id: source };
	if (root.hasAttribute('data-cms-page')) return { kind: 'page' };
	const index = blockIndexOf(root);
	return Number.isInteger(index) ? { kind: 'block', index } : null;
}

export const sameCtx = (a: Ctx | null | undefined, b: Ctx | null | undefined): boolean =>
	!!a && !!b && a.kind === b.kind && (a.kind !== 'block' || a.index === (b as { index: number }).index) && (a.kind !== 'source' || a.id === (b as { id: string }).id);

/** A context as a string (`b:2`, `page`, `s:shared/footer`), for remembering one across a morph. */
export const ctxKey = (ctx: Ctx): string => (ctx.kind === 'block' ? `b:${ctx.index}` : ctx.kind === 'page' ? 'page' : `s:${ctx.id}`);
export function ctxFromKey(key: string): Ctx | null {
	if (key === 'page') return { kind: 'page' };
	if (key.startsWith('s:')) return { kind: 'source', id: key.slice(2) };
	const index = Number(key.slice(2));
	return key.startsWith('b:') && Number.isInteger(index) ? { kind: 'block', index } : null;
}

/** The field element an element is in, when that field belongs to the element's own context (else null). */
export function ownFieldOf(el: Element | null | undefined): HTMLElement | null {
	const field = (el?.closest?.('[data-cms-field]') as HTMLElement | null) ?? null;
	if (!field) return null;
	return contextRootOf(field) === contextRootOf(el) ? field : null;
}

const asList = (ctx: Ctx | readonly Ctx[]): readonly Ctx[] => (Array.isArray(ctx) ? ctx : [ctx as Ctx]);

/**
 * Every element of a field in a context (or any of several): a block's by index (as
 * `fieldElement`), the page's and a source's by their markers, which the field carries itself.
 * A source's field may be drawn more than once (Site Settings' phone in the footer and a contact
 * block): each one. `kind` keeps only fields of that kind (`text`); a field marked without its
 * value has no kind.
 */
export function fieldElements(doc: Document | ParentNode, ctx: Ctx | readonly Ctx[], field: string, kind?: string): HTMLElement[] {
	const out: HTMLElement[] = [];
	const k = kind ? `[data-cms-kind="${CSS.escape(kind)}"]` : '';
	const f = `[data-cms-field="${CSS.escape(field)}"]${k}`;
	for (const c of asList(ctx)) {
		if (c.kind === 'block') {
			const el = fieldElement(doc, c.index, field, kind);
			if (el) out.push(el);
		} else {
			const marker = c.kind === 'page' ? '[data-cms-page]' : `[data-cms-source="${CSS.escape(c.id)}"]`;
			for (const el of doc.querySelectorAll<HTMLElement>(`${marker}${f}`)) if (sameCtx(ctxOf(el), c)) out.push(el);
		}
	}
	return out;
}

/** The outermost elements a context draws (a block's root; every page region; a source's roots, none inside another of its own). */
export function contextRoots(doc: Document | ParentNode, ctx: Ctx | readonly Ctx[]): HTMLElement[] {
	const out: HTMLElement[] = [];
	for (const c of asList(ctx)) {
		if (c.kind === 'block') {
			const el = blockElement(doc, c.index);
			if (el) out.push(el);
			continue;
		}
		const marker = c.kind === 'page' ? '[data-cms-page]' : `[data-cms-source="${CSS.escape(c.id)}"]`;
		for (const el of doc.querySelectorAll<HTMLElement>(marker)) {
			if (!el.parentElement?.closest(marker)) out.push(el);
		}
	}
	return out;
}

/**
 * The frame a site draws itself (edit in context, Decision 13): outside every context and
 * outside `<main>` (the header, the footer). A page with no `<main>`: inside a `<header>` or
 * `<footer>` that no context holds. Never inside a page region (`data-cms-page`).
 */
export function inUnmarkedFrame(el: Element): boolean {
	if (contextRootOf(el)) return false;
	const doc = el.ownerDocument;
	if (doc.querySelector('main')) return !el.closest('main');
	return !!el.closest('header, footer');
}
