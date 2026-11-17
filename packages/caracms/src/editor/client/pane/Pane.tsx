/**
 * The drill-down pane (M2 → the drill-down sidebar): documents → a document → a
 * block, with a collection's own level beside documents (Decision 9). The levels you
 * came from stack above as tabs; back and Esc go up a level (App.tsx handles Esc).
 *
 * Each level is its own file under ./levels, rendered inside a `.side-level` (a
 * flex column, so a level's .trail / .side-body / .side-foot sit as in the mockup), so Phase 3 (the block level) and
 * Phase 4 (the documents, collection and document levels) can each replace theirs
 * without touching this frame. LEVELS maps a level to its component.
 */
import { useEffect, useRef, type ComponentType } from 'react';
import { useEditor, useStore } from '../context.tsx';
import type { PaneLevel } from '../editor.ts';
import { BlockLevel } from './levels/BlockLevel.tsx';
import { CollectionLevel } from './levels/CollectionLevel.tsx';
import { DocumentLevel } from './levels/DocumentLevel.tsx';
import { DocumentsLevel } from './levels/DocumentsLevel.tsx';
import { MediaLevel } from './levels/MediaLevel.tsx';
import { SubmissionsLevel } from './levels/SubmissionsLevel.tsx';
import { ArrangeLevel } from './levels/ArrangeLevel.tsx';

export const LEVELS: Record<PaneLevel, ComponentType> = {
	documents: DocumentsLevel,
	collection: CollectionLevel,
	document: DocumentLevel,
	block: BlockLevel,
	// M5b: the library (Site-wide → Media), and a slot's picker in place of the block's fields.
	media: MediaLevel,
	// M6: the inbox (Site-wide → Submissions).
	submissions: SubmissionsLevel,
	// Arrange pages: the screen's controls, then its review (Decision 16).
	arrange: ArrangeLevel,
};

/**
 * Marks a `.side-body` as scrolling for a moment after each scroll, so its thin
 * scrollbar shows while it moves as well as on hover (editor.css). Scroll events
 * don't bubble, so the pane listens in the capture phase.
 */
function useScrollingMark(ref: { current: HTMLElement | null }) {
	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		const timers = new Map<Element, ReturnType<typeof setTimeout>>();
		const onScroll = (event: Event) => {
			const el = event.target;
			if (!(el instanceof HTMLElement) || !el.classList.contains('side-body')) return;
			el.dataset.scrolling = '';
			clearTimeout(timers.get(el));
			timers.set(
				el,
				setTimeout(() => {
					delete el.dataset.scrolling;
					timers.delete(el);
				}, 800),
			);
		};
		root.addEventListener('scroll', onScroll, { capture: true, passive: true });
		return () => {
			root.removeEventListener('scroll', onScroll, { capture: true });
			timers.forEach((t) => clearTimeout(t));
		};
	}, [ref]);
}

export function Pane() {
	const editor = useEditor();
	const side = useRef<HTMLElement>(null);
	useScrollingMark(side);
	const level = useStore(editor.view, (v) => v.level);
	const blockKey = useStore(editor.view, (v) => v.block);
	const hasBlock = useStore(editor.doc.state, (s) => (blockKey ? s.document.blocks.some((b) => b.key === blockKey) : false));
	// A form (M5a) has no block level: its fields are on its document level.
	const form = useStore(editor.doc.state, (s) => s.document.kind !== 'sections');
	// A block that's gone (removed, or another document opened) falls back to its document.
	const shown: PaneLevel = level === 'block' && (!hasBlock || form) ? 'document' : level;
	const Level = LEVELS[shown];
	const Documents = LEVELS.documents;
	// The documents level stays mounted (hidden when it isn't shown): going up is instant,
	// it keeps its own state (a filter, scroll), and its Pages groups are in the server's
	// HTML as the cookie says (Decision 20; Verify 1).
	return (
		<aside ref={side} className="side" id="side" aria-label="Documents, blocks and fields" data-level={shown}>
			<div className="side-level" data-pane-level="documents" hidden={shown !== 'documents'}>
				<Documents />
			</div>
			{shown !== 'documents' ? (
				<div className="side-level" data-pane-level={shown}>
					<Level />
				</div>
			) : null}
		</aside>
	);
}
