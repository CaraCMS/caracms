/**
 * The empty page's invitation in the preview (the mockup's renderPreview:
 * `.cms-empty .cms-add`), painted into Phase 3's overlay layer (client/overlays): a
 * dashed area where its blocks would go (Blocks.astro's preview-only
 * `data-cms-empty`) with "+ Add the first block", in every frame. A click opens the
 * add-block picker at 0 (link.ts → openPicker).
 *
 * (The "+ Add block" points on a selected block's edges went in the pre-M7 polish:
 * the sidebar's Add block row is the one way to add after the first.) Nothing is
 * drawn while the preview shows another document than the sidebar (one is opening).
 *
 *   startEmptyPageAdd(editor)   // a stop; DocumentsLevel mounts it once (it's always mounted)
 */
import type { Editor } from '../editor.ts';
import { overlaysFor } from '../overlays/index.ts';
import { sameDoc } from '../../types.ts';
import { openPicker } from './link.ts';

/** Whether the preview offers "+ Add the first block" now (pure apart from reading stores). */
export function offersFirstBlock(editor: Pick<Editor, 'doc' | 'previewStatus'>): boolean {
	const status = editor.previewStatus.get();
	const session = editor.doc.get();
	if (status.opening || !sameDoc(status.showing, session.ref)) return false;
	// Only a section builder has blocks (M5a: not a form or a shared block).
	return session.document.kind === 'sections' && session.document.blocks.length === 0;
}

export function startEmptyPageAdd(editor: Editor): () => void {
	const overlays = overlaysFor(editor);
	if (!overlays) return () => {};

	const remove = overlays.addPainter((ctx) => {
		if (!offersFirstBlock(editor)) return null;
		const area = ctx.doc.querySelector('[data-cms-empty]');
		if (!area) return null;
		const box = ctx.el('div', 'cms-empty');
		box.setAttribute('style', ctx.place(ctx.rect(area, -24)));
		const b = ctx.el('button', 'cms-add');
		b.type = 'button';
		b.dataset.ins = '0';
		b.textContent = '+ Add the first block';
		// The page's own handlers (click to edit) ignore the layer; keep the press here anyway.
		b.addEventListener('mousedown', (event) => event.stopPropagation());
		b.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			openPicker(editor, 0);
		});
		box.appendChild(b);
		return box;
	});

	const redraw = () => overlays.redraw();
	const stops = [remove, editor.doc.state.subscribe(redraw), editor.previewStatus.subscribe(redraw)];
	return () => stops.forEach((stop) => stop());
}
