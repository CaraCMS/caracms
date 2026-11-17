/**
 * The overlays, one per editor (editor/README.md → Overlays).
 *
 *   import { overlaysFor } from '../overlays/index.ts';
 *   const overlays = overlaysFor(editor);           // null on the server
 *   overlays?.set('block-list', [{ kind: 'hover', block: 2, label: 'Text' }]);
 *   overlays?.clear('block-list');
 *   const remove = overlays?.addPainter((ctx) => …elements…);
 *
 * The first call creates the layer and attaches it to the editor's preview driver;
 * every later call returns the same one. OverlayMount (mounted once in the shell)
 * makes that first call and draws the editor's own marks (editor-marks.ts).
 */
import type { Editor } from '../editor.ts';
import { displayName } from '../live/format.ts';
import { sameDoc } from '../../types.ts';
import { createOverlays, type Overlays } from './layer.ts';

export type { Mark, MarkKind, OverlayContext, OverlayPainter, Overlays, Rect } from './layer.ts';
export { LAYER_ID } from './layer.ts';

const made = new WeakMap<Editor, Overlays>();

export function overlaysFor(editor: Editor): Overlays | null {
	if (!editor.preview || typeof window === 'undefined') return null;
	let overlays = made.get(editor);
	if (!overlays) {
		overlays = createOverlays({
			driver: editor.preview,
			layout: editor.stageLayout,
			visibleWidth: () => editor.view.get().width,
			// M4: a read-only document has no overlays; a lock gives the veil (Decision 9). Edit in context
			// (Decision 14): a document open over the page has neither: its marks go the lock's grey instead.
			mode: () => {
				const access = editor.access.get();
				if (!access.readOnly) return { kind: 'normal' };
				const over = editor.over.get();
				if (over && sameDoc(editor.previewStatus.get().showing, over.page) && !sameDoc(over.page, editor.doc.get().ref)) return { kind: 'normal' };
				if (!access.veil || !sameDoc(editor.previewStatus.get().showing, editor.doc.get().ref)) return { kind: 'quiet' };
				const who = access.lock === 'theirs' && access.holder ? `${displayName(access.holder.person)} is editing` : "You're editing this in another tab";
				return { kind: 'veil', title: who };
			},
		});
		made.set(editor, overlays);
		editor.access.subscribe(() => overlays!.redraw());
		editor.over.subscribe(() => overlays!.redraw());
		editor.previewStatus.subscribe((s, previous) => s.showing !== previous.showing && overlays!.redraw());
		// The width on screen decides where hover and insert points go.
		editor.view.subscribe((view, previous) => {
			if (view.width !== previous.width) overlays!.redraw();
		});
	}
	return overlays;
}
