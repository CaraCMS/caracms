/**
 * Which preview iframe has a page editor mounted, and on which element (on-page rich
 * text, Decisions 5–7). At most one per iframe. The driver and selection.ts read it
 * so that **every writer skips the mounted element in that iframe** (ProseMirror
 * reads any outside change to its DOM as typing): the morph pairs it only with its
 * own field (Decision 6), and the mirror and re-apply leave it alone (Decision 7).
 *
 * Light on purpose (no Tiptap here): page-edit.ts mounts and registers; the driver
 * only asks.
 */
import { parseRichText, richHeadingHtml, richTextHtml, type RichTextOptions } from '../../../rich-text.ts';

export interface MountedField {
	/** The field's element: the editor's root while mounted. */
	readonly el: HTMLElement;
	/** The block's key in the document store, and the field's key (always top level). */
	readonly key: string;
	readonly field: string;
	/**
	 * The morph paired the element with its field in the render and left it alone
	 * (Decision 6): the render's own attributes are what teardown must put back, so a
	 * render that changed them (a class that depends on another field) isn't undone.
	 */
	syncAttributes(from: Element): void;
	/**
	 * Tear it down now, synchronously (Decision 6: inside idiomorph's callback, before
	 * the morph writes). page-edit remounts it after the morph if the session or the
	 * pointer is still there.
	 */
	teardownForMorph(): void;
}

const byDoc = new WeakMap<Document, MountedField>();

/** The page editor mounted in a frame's document, or null. */
export function mountedIn(doc: Document | null | undefined): MountedField | null {
	return (doc && byDoc.get(doc)) ?? null;
}

export function setMounted(doc: Document, mounted: MountedField | null): void {
	if (mounted) byDoc.set(doc, mounted);
	else byDoc.delete(doc);
}

/** A field's value as the render gives it: the same HTML RichText.astro writes (a heading's: its lines, M9 Decision 11). */
export function renderedHtml(raw: unknown, options: RichTextOptions): string {
	const value = parseRichText(raw, options);
	return options.heading ? richHeadingHtml(value) : richTextHtml(value);
}

/**
 * Put a rich-text field's value into an element that isn't mounted (another width,
 * or after a render that predates it), only when it differs, so an unchanged field
 * keeps its nodes. The comparison goes through the element's own document's
 * serialiser (a `'` in the value is `&#39;` in richTextHtml, `'` in innerHTML).
 */
export function writeRichText(el: HTMLElement, raw: unknown, options: RichTextOptions): void {
	if (mountedIn(el.ownerDocument)?.el === el) return;
	const probe = el.ownerDocument.createElement('template');
	probe.innerHTML = renderedHtml(raw, options);
	setHeadingIds(probe.content, headingIdsOf(el));
	if (probe.innerHTML !== el.innerHTML) el.innerHTML = probe.innerHTML;
}

/**
 * Heading ids (heading-ids.ts) are numbered across the page by the server's render; the
 * editor's own writes (this mirror, a page editor's teardown) can't know them. So a write
 * keeps the element's ids, by position, and the next render puts the right ones back.
 */
const headingsOf = (root: ParentNode): Element[] => [...root.children].filter((c) => c.tagName === 'H2' || c.tagName === 'H3');

/** The ids of a field element's own `h2`/`h3`s, in order (`''` for none). */
export function headingIdsOf(root: ParentNode): string[] {
	return headingsOf(root).map((h) => h.getAttribute('id') ?? '');
}

/** Give a field element's `h2`/`h3`s these ids, by position (`''`: none). */
export function setHeadingIds(root: ParentNode, ids: readonly string[]): void {
	for (const [i, h] of headingsOf(root).entries()) {
		const id = ids[i];
		if (id) h.setAttribute('id', id);
	}
}
