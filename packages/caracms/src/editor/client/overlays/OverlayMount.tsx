/**
 * Mounted once in the shell (App.tsx): starts the overlay layer, editing from the
 * page (click to edit, typing on the page, hover), the editor's own marks and the
 * formatting bar of rich text typed on the page (rich-text-bar.ts), and
 * following links from the page (follow-links.ts), and edit in context's chips
 * (source-marks.ts). Renders
 * nothing; on the server it does nothing.
 */
import { useEffect } from 'react';
import { useEditor } from '../context.tsx';
import { pageEditFor } from '../preview/page-edit.ts';
import { startFollowLinks } from '../preview/follow-links.ts';
import { startEditorMarks } from './editor-marks.ts';
import { overlaysFor } from './index.ts';
import { startRichTextBar } from './rich-text-bar.ts';
import { startSourceMarks } from './source-marks.ts';

export function OverlayMount() {
	const editor = useEditor();
	useEffect(() => {
		const overlays = overlaysFor(editor);
		const pageEdit = pageEditFor(editor);
		if (!overlays || !pageEdit) return;
		const stops = [startEditorMarks(editor, overlays, pageEdit), startRichTextBar(editor, overlays, pageEdit), startFollowLinks(editor, overlays), startSourceMarks(editor, overlays, pageEdit)];
		return () => stops.forEach((stop) => stop());
	}, [editor]);
	return null;
}
