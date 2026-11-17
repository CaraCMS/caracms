/**
 * Edit in context's two chips on the page, painted into the overlay layer (layer.ts →
 * addPainter), in the link chip's look (`cms-go`, follow-links.ts):
 *
 *   Edit <title> →     hovering an item marked as its source inside the selected block (a
 *                      card): a ring round it and this one chip, even when the item is a link
 *                      (Decision 7: following its address is in the opened form's menu). It
 *                      opens the item's document over the page, as a click on the item does.
 *   Edited elsewhere   a click on the frame a site draws itself, where it landed (Decision 13,
 *                      page-edit.ts → `elsewhere`): "Edited elsewhere: open Site Settings →",
 *                      which opens Site Settings over the page. Never inside `data-cms-page`.
 *
 * Only while the page on screen is the open document (with a document over it, a click on an
 * item opens it at once, and the frame's chip has nothing to point at).
 */
import type { Editor } from '../editor.ts';
import type { PageEdit } from '../preview/page-edit.ts';
import { refOfSource } from '../preview/places.ts';
import { sameDoc } from '../../types.ts';
import { documentName } from './editor-marks.ts';
import type { Overlays } from './layer.ts';

/** The chip's height and its gap above what it names, on screen. */
const CHIP_ABOVE = 22 + 6;

export function startSourceMarks(editor: Editor, overlays: Overlays, pageEdit: PageEdit): () => void {
	const live = () => {
		const status = editor.previewStatus.get();
		return !status.opening && !editor.view.get().opening && sameDoc(status.showing, editor.doc.get().ref);
	};
	const selectedIndex = (): number | null => {
		const view = editor.view.get();
		if (view.level !== 'block' || !view.block) return null;
		const index = editor.doc.indexOf(view.block);
		return index >= 0 ? index : null;
	};

	const remove = overlays.addPainter((ctx) => {
		if (!ctx.visible || !live()) return null;
		const out: HTMLElement[] = [];
		const chip = (text: string, go: string, left: number, top: number, onClick: () => void) => {
			const button = ctx.el('button', 'cms-go', { left: `${left}px`, top: `${top}px` });
			button.type = 'button';
			button.textContent = text;
			button.dataset.go = go;
			ctx.fitLeft(button, left);
			button.addEventListener('mousedown', (event) => event.stopPropagation());
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				onClick();
			});
			return button;
		};

		const source = pageEdit.hover.get()?.source;
		if (source && source.inBlock !== null && source.inBlock === selectedIndex() && source.root.isConnected && source.root.ownerDocument === ctx.doc) {
			const r = ctx.rect(source.root, 6);
			const ring = ctx.el('div', 'cms-box cms-hov');
			ring.setAttribute('style', ctx.place(r));
			ring.dataset.mark = 'item-hover';
			out.push(ring);
			const above = r.top - CHIP_ABOVE * ctx.k >= (ctx.frame.window?.scrollY ?? 0);
			const ref = source.ref;
			out.push(chip(`Edit ${documentName(editor, ref)} →`, 'source', r.left, above ? r.top - CHIP_ABOVE * ctx.k : r.top + r.height + 6 * ctx.k, () => void editor.openOver(ref)));
		}

		const away = pageEdit.elsewhere.get();
		if (away && away.width === ctx.width && away.el.isConnected && away.el.ownerDocument === ctx.doc) {
			const r = ctx.rect(away.el);
			const above = r.top - CHIP_ABOVE * ctx.k >= (ctx.frame.window?.scrollY ?? 0);
			out.push(
				chip('Edited elsewhere: open Site Settings →', 'elsewhere', r.left, above ? r.top - CHIP_ABOVE * ctx.k : r.top + r.height + 6 * ctx.k, () => {
					pageEdit.elsewhere.set(null);
					void editor.openOver(refOfSource('settings'));
				}),
			);
		}
		return out;
	});

	const stops = [remove, pageEdit.hover.subscribe(() => overlays.redraw()), pageEdit.elsewhere.subscribe(() => overlays.redraw()), editor.view.subscribe(() => overlays.redraw())];
	return () => stops.forEach((stop) => stop());
}
