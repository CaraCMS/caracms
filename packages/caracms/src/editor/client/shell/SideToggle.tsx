/**
 * The sidebar's hide and show button (⌘\): one button for both states, so focus stays
 * on it either way. Shown, it sits in the sidebar's top row at its right end; hidden,
 * it sits at the top left of the preview (editor.css places it).
 */
import { useEditor, useStore } from '../context.tsx';
import { Icon } from './Icons.tsx';

export function SideToggle() {
	const editor = useEditor();
	const sideHidden = useStore(editor.ui, (u) => u.side === 'hidden');
	return (
		<button
			type="button"
			className="ib side-toggle"
			aria-controls="side"
			aria-expanded={!sideHidden}
			aria-keyshortcuts="Meta+Backslash Control+Backslash"
			aria-label={sideHidden ? 'Show the sidebar' : 'Hide the sidebar'}
			title={sideHidden ? 'Show the sidebar (⌘\\)' : 'Hide the sidebar (⌘\\)'}
			onClick={() => editor.setSideHidden(!sideHidden)}
		>
			<Icon name="sidebar" />
		</button>
	);
}
