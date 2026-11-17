/**
 * Following links from the page (2026-10-20, dispatched without a spec). In /admin a
 * click is an edit unless it clearly isn't, so:
 *
 * - **The header and footer** (no block marker: SiteHeader.astro, never an edit): a
 *   click on a link follows it.
 * - **A link in a block** follows only once that block is selected; the first click
 *   selects it, as click to edit always has (page-edit.ts). A click on a field still picks
 *   it (a button's label) or places the caret (text typed on the page), link or not: the
 *   chip follows those.
 * - **Following** a link to a document opens it in the editor (`openDocument`, so the
 *   address and Back/Forward follow); a paged listing (`/journal/page/2`) opens its page.
 *   A web address on another site, or a file, opens in a new tab. `mailto:`/`tel:`, a
 *   spot on this page and an address with no document do nothing (link-target.ts).
 * - **The chip:** hovering a link in the selected block shows where it goes ("Go to
 *   /about →"), a button that follows it too. In the header and footer it shows only
 *   for a link that won't be followed, saying why.
 *
 * Edit in context: a link in the page's own region (`data-cms-page`, a page field drawn by the
 * page component) is the page's, never the frame's: it follows as a selected block's does, the
 * page having no block to select first. A link inside a sourced item in a block (a card) is that
 * item's: a click opens its source (page-edit.ts), and its only chip is "Edit <title> →"
 * (overlays/source-marks.ts). A link in a slot (the header's menu) is the frame's. With a
 * document open over the page (Decision 8), only the frame's links follow.
 *
 * The driver's guard (driver.ts) still cancels every link's default, so the preview
 * itself never navigates. Nothing here runs while the preview shows another document
 * than the sidebar (one is opening), or in the frames off screen.
 *
 *   startFollowLinks(editor)   // a stop; OverlayMount starts it once
 */
import type { Editor } from '../editor.ts';
import type { Overlays } from '../overlays/layer.ts';
import { sameDoc } from '../../types.ts';
import type { PreviewFrame } from './driver.ts';
import { linkTarget, type LinkTarget } from './link-target.ts';
import { blockIndexOf, blockRootOf } from './markers.ts';

const LAYER = '#cms-overlays';
/** How far (screen px) past the link the pointer can go toward its chip: the chip's height and gap, and a margin. */
const CHIP_REACH = 22 + 6 + 8;
/** A field on the page: a click on it picks it, or places the caret (page-edit.ts), even inside a link. */
const FIELD = '[data-cms-field]';
/** A `<style>` in each frame's `<head>` (never morphed): the selected block's links take a pointer cursor. */
const CURSOR_STYLE_ID = 'cms-follow-css';

interface Hovered {
	frame: PreviewFrame;
	anchor: HTMLAnchorElement;
}

export function startFollowLinks(editor: Editor, overlays: Overlays): () => void {
	const driver = editor.preview;
	if (!driver) return () => {};

	const settled = () => !editor.previewStatus.get().opening && !editor.view.get().opening;
	const live = () => settled() && sameDoc(editor.previewStatus.get().showing, editor.doc.get().ref);
	/** A document open over the page on screen (edit in context, Decision 8): only the frame's links follow. */
	const over = () => {
		const o = editor.over.get();
		return settled() && !!o && sameDoc(editor.previewStatus.get().showing, o.page) && !sameDoc(o.page, editor.doc.get().ref);
	};
	const shown = () => live() || over();
	const visible = (frame: PreviewFrame) => frame.width === editor.view.get().width;
	const elementOf = (target: EventTarget | null): Element | null =>
		target && (target as Node).nodeType === 1 ? (target as Element) : ((target as Node | null)?.parentElement ?? null);

	/** The selected block's index on the page, or null. */
	function selectedIndex(): number | null {
		const view = editor.view.get();
		if (!editor.fieldsOpen(view) || !view.block) return null;
		const blocks = editor.doc.get().document.blocks;
		for (let i = 0; i < blocks.length; i++) if (editor.doc.keyAt(i) === view.block) return i;
		return null;
	}

	/**
	 * Where a link is: the header or footer (a slot too), the selected block, another block, the
	 * page's own region (`page`, as selected), or a sourced item in a block (`item`: its source
	 * opens instead). Over a page, everything but the frame is the page under the opened document.
	 */
	function placeOf(anchor: Element): 'chrome' | 'selected' | 'block' | 'page' | 'item' {
		const item = anchor.closest('[data-cms-source]');
		const root = blockRootOf(anchor);
		if (item && root && root.contains(item)) return 'item';
		if (!root) {
			if (!anchor.closest('[data-cms-page]')) return 'chrome';
			return over() ? 'block' : 'page';
		}
		if (over()) return 'block';
		return blockIndexOf(root) === selectedIndex() ? 'selected' : 'block';
	}

	const targetOf = (frame: PreviewFrame, anchor: HTMLAnchorElement): LinkTarget => {
		const target = linkTarget(anchor.getAttribute('href') ?? '', { origin: frame.window?.location.origin ?? location.origin }, editor.documents.get());
		// The page shown (the header's link to it, `/about#team`): nothing to go to, and the selection stays.
		if (target.kind === 'document' && sameDoc({ collection: target.doc.collection, path: target.doc.path }, editor.previewStatus.get().showing)) return { kind: 'none', label: 'On this page' };
		return target;
	};

	/** Follow it: true when something happened (a document opened, a tab). */
	function follow(target: LinkTarget, frame: PreviewFrame): boolean {
		if (target.kind === 'document') {
			void editor.openDocument({ collection: target.doc.collection, path: target.doc.path });
			return true;
		}
		if (target.kind === 'external') {
			// From the frame's window: the click's user activation is there, so it isn't a blocked popup.
			(frame.window ?? window).open(target.href, '_blank', 'noopener,noreferrer');
			return true;
		}
		return false;
	}

	// ---- The chip ----

	let hovered: Hovered | null = null;
	const setHovered = (next: Hovered | null) => {
		if (next?.anchor === hovered?.anchor && next?.frame === hovered?.frame) return;
		hovered = next;
		overlays.redraw();
	};

	const chipText = (target: LinkTarget) => {
		switch (target.kind) {
			case 'document':
				return `Go to ${target.label} →`;
			case 'external':
				return `Open ${target.label} ↗`;
			case 'contact':
				return `${target.label} · not opened from the editor`;
			case 'none':
				return target.label === 'On this page' ? 'A link on this page' : 'Not a page in the editor';
		}
	};

	const removePainter = overlays.addPainter((ctx) => {
		const now = hovered;
		if (!now || now.frame !== ctx.frame || !ctx.visible || !shown() || !now.anchor.isConnected) return null;
		const place = placeOf(now.anchor);
		const target = targetOf(ctx.frame, now.anchor);
		const followable = target.kind === 'document' || target.kind === 'external';
		if (place === 'block' || place === 'item' || (place === 'chrome' && followable)) return null;
		const r = ctx.rect(now.anchor);
		// The picked field's name tag sits just above it: when the link is that field (a button's label), go below.
		const field = now.anchor.closest<HTMLElement>('[data-cms-field]') ?? now.anchor.querySelector<HTMLElement>('[data-cms-field]');
		const tagged = !!field && field.dataset.cmsField === editor.view.get().field;
		const above = !tagged && r.top - (22 + 6) * ctx.k >= (ctx.frame.window?.scrollY ?? 0);
		const chip = ctx.el(followable ? 'button' : 'span', `cms-go${followable ? '' : ' off'}`, {
			left: `${r.left}px`,
			top: above ? `${r.top - (22 + 6) * ctx.k}px` : `${r.top + r.height + 6 * ctx.k}px`,
		});
		chip.textContent = chipText(target);
		chip.dataset.go = target.kind;
		ctx.fitLeft(chip, r.left);
		if (followable) {
			(chip as HTMLButtonElement).type = 'button';
			chip.addEventListener('mousedown', (event) => event.stopPropagation());
			chip.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				follow(target, ctx.frame);
			});
		}
		return chip;
	});

	// ---- The selected block's links take a pointer cursor ----

	function markSelected() {
		const index = selectedIndex();
		const sections = editor.doc.get().document.kind === 'sections';
		// A form (a fields document, a shared block) has one root, `data-cms-document` (markers.ts).
		const root = sections ? `[data-cms-block="${index}"]` : '[data-cms-document]';
		// The page's own region's links follow with no block selected (edit in context, Decision 10a).
		const page = sections && live() ? 'html [data-cms-page] a[href]{cursor:pointer}' : '';
		const css = (index === null ? '' : `html ${root} a[href]{cursor:pointer}`) + page;
		for (const frame of driver!.frames()) {
			const doc = frame.document;
			if (!doc?.documentElement) continue;
			let style = doc.getElementById(CURSOR_STYLE_ID);
			if (!style) {
				style = doc.createElement('style');
				style.id = CURSOR_STYLE_ID;
				(doc.head ?? doc.documentElement).appendChild(style);
			}
			if (style.textContent !== css) style.textContent = css;
		}
	}

	// ---- Per frame: the click, and the pointer for the chip ----

	function attach(frame: PreviewFrame): () => void {
		const doc = frame.document!;
		const onClick = (event: MouseEvent) => {
			if (event.button !== 0 || !visible(frame) || !shown()) return;
			const el = elementOf(event.target);
			if (!el || el.closest(LAYER) || el.closest(FIELD)) return;
			const anchor = el.closest<HTMLAnchorElement>('a[href]');
			if (!anchor) return;
			const place = placeOf(anchor);
			if (place === 'block' || place === 'item') return;
			if (!follow(targetOf(frame, anchor), frame)) return;
			// Followed: not also a click to edit (page-edit.ts listens below, on the bubble).
			event.stopPropagation();
			setHovered(null);
		};
		const onMove = (event: MouseEvent) => {
			if (!visible(frame) || !shown()) return setHovered(null);
			const el = elementOf(event.target);
			if (el?.closest(LAYER)) return; // on the chip itself
			// Over a field too: a click there picks it (or places the caret), so the chip is the way to follow it.
			const anchor = el?.closest<HTMLAnchorElement>('a[href]') ?? null;
			if (anchor) return setHovered({ frame, anchor });
			// On the way from the link to its chip (the gap between them, which is the page's): keep it.
			if (hovered?.frame === frame && hovered.anchor.isConnected) {
				const r = hovered.anchor.getBoundingClientRect();
				const scale = editor.stageLayout.get()?.[frame.width].scale || 1;
				const reach = CHIP_REACH / scale;
				// Sideways too: the chip starts at the link's left and can be wider than it.
				if (event.clientX >= r.left - reach && event.clientX <= r.right + reach * 6 && event.clientY >= r.top - reach && event.clientY <= r.bottom + reach) return;
			}
			setHovered(null);
		};
		const onLeave = () => {
			if (hovered?.frame === frame) setHovered(null);
		};
		doc.addEventListener('click', onClick, true);
		doc.addEventListener('mousemove', onMove, { capture: true, passive: true });
		doc.documentElement.addEventListener('mouseleave', onLeave);
		return () => {
			doc.removeEventListener('click', onClick, true);
			doc.removeEventListener('mousemove', onMove, { capture: true });
			doc.documentElement.removeEventListener('mouseleave', onLeave);
		};
	}

	// Listeners are kept per document: attached once when a frame's document loads (as page-edit.ts).
	const attached = new WeakSet<Document>();
	const detachers: (() => void)[] = [];
	const stops = [
		removePainter,
		driver.registerFrameHook((frame) => {
			markSelected();
			const doc = frame.document;
			if (!doc || attached.has(doc)) return;
			attached.add(doc);
			detachers.push(attach(frame));
		}),
		() => detachers.forEach((detach) => detach()),
		editor.view.subscribe(() => {
			markSelected();
			overlays.redraw();
		}),
		editor.doc.state.subscribe(markSelected),
		editor.previewStatus.subscribe(() => {
			if (!shown()) setHovered(null);
		}),
		editor.over.subscribe(markSelected),
	];
	return () => stops.forEach((stop) => stop());
}
