/**
 * The editor shell (Decision 2; M2's 4d layout): one left pane, the stage with the
 * preview, one dark bar along the bottom, server-rendered so the chrome is there at
 * first paint and hydrated in the browser.
 *
 * Keys (M2 → Rules): ⌘K the document switcher; Esc closes a popover, leaves a field,
 * then goes up a level; ⌘Z (outside a field) undoes (Decision 18).
 */
import { useEffect } from 'react';
import { EditorContext, useStore } from '../context.tsx';
import type { Editor } from '../editor.ts';
import { OverlayMount } from '../overlays/OverlayMount.tsx';
import { Pane } from '../pane/Pane.tsx';
import { SWITCHER_READY } from '../pane/switcher.tsx';
import { Bar } from './Bar.tsx';
import { IconSprite } from './Icons.tsx';
import { NarrowNote } from './NarrowNote.tsx';
import { Popovers } from './Popovers.tsx';
import { SignedOutModal } from '../live/session.tsx';
import { SideToggle } from './SideToggle.tsx';
import { Stage } from './Stage.tsx';
import { DocumentDialogs } from '../documents/dialogs.tsx';
import { Toast } from './Toast.tsx';

const IN_FIELD = 'input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"]';

export function EditorApp({ editor }: { editor: Editor }) {
	useEffect(() => editor.start(), [editor]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as Element | null;
			const inField = !!target?.closest?.(IN_FIELD);
			const mod = event.metaKey || event.ctrlKey;
			if (mod && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				const { pop } = editor.view.get();
				if (SWITCHER_READY) editor.setPop(pop === 'switcher' ? null : 'switcher');
				else editor.goTo('documents');
				return;
			}
			// ⌘\ hides or shows the sidebar (pre-M7 polish), from anywhere, a field included.
			if (mod && !event.shiftKey && !event.altKey && (event.key === '\\' || event.code === 'Backslash')) {
				event.preventDefault();
				editor.setSideHidden(editor.ui.get().side !== 'hidden');
				return;
			}
			if (mod && !event.shiftKey && event.key.toLowerCase() === 'z' && !inField && editor.doc.get().undo.length > 0) {
				event.preventDefault();
				editor.doc.undo();
				return;
			}
			if (event.key === 'Escape') {
				if (event.defaultPrevented) return;
				if (editor.view.get().pop) {
					editor.setPop(null);
					return;
				}
				if (inField) {
					(target as HTMLElement).blur();
					return;
				}
				editor.goUp();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [editor]);

	const sideHidden = useStore(editor.ui, (u) => u.side === 'hidden');
	return (
		<EditorContext.Provider value={editor}>
			<IconSprite />
			<div id="app" data-screen="editor">
				<div className="editor" id="editor" data-side={sideHidden ? 'hidden' : undefined}>
					<SideToggle />
					<Pane />
					<Stage />
					<Bar />
					<Popovers />
					<div id="toast-root">
						<Toast />
					</div>
					<div id="modal-root">
						{editor.mode === 'live' ? <SignedOutModal /> : null}
						<DocumentDialogs />
					</div>
				</div>
				<NarrowNote />
			</div>
			<Live editor={editor} />
			<OverlayMount />
		</EditorContext.Provider>
	);
}

function Live({ editor }: { editor: Editor }) {
	const text = useStore(editor.live);
	return (
		<div className="sr" id="live" aria-live="polite">
			{text}
		</div>
	);
}
