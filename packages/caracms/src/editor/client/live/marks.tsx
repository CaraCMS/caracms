/**
 * Who's where, and what's waiting, in navigation (M4 Decision 9; the mockup's metaFor
 * and bubble): the Pages tree, a collection's level, "Find a document", the Recent
 * strip and the ⌘K switcher. Live mode only; local mode has no marks (editor.marks is
 * empty), so these render nothing and the rows look as in M3.
 *
 * - `DocMarksView`: a row's marks. The merge notice's warning mark; someone else's
 *   lock as their avatar with "Aoife is editing" (the avatar alone when `compact`);
 *   other people with it open (presence) as avatars; the waiting dot.
 * - `Bubble`: a closed group's, a closed parent's or a collection's row carries the
 *   marks of what's inside it: one avatar, one dot. No side rails anywhere: marks are
 *   icons, avatars and dots.
 */
import { useEditor, useStore } from '../context.tsx';
import type { DocMarks } from '../editor.ts';
import { Icon } from '../shell/Icons.tsx';
import type { Person } from '../../types.ts';
import { colourOf, displayName, initialOf } from './format.ts';

export function Avatar({ person, size, title }: { person: Person; size?: 'sm' | 'lg'; title?: string }) {
	return (
		<span className={`av${size ? ` ${size}` : ''}`} style={{ ['--c' as string]: colourOf(person) }} aria-hidden="true" title={title}>
			{initialOf(person)}
		</span>
	);
}

export function DocMarksView({ file, compact = false, lock = true }: { file: string; compact?: boolean; /** M6c (G5): false leaves someone's lock out (a grid card says it on its picture: CollectionGrid.tsx). */ lock?: boolean }) {
	const editor = useEditor();
	const m: DocMarks | undefined = useStore(editor.marks, (all) => all.get(file));
	if (!m) return null;
	return (
		<>
			{m.kept ? (
				<span className="wmark" title="Changed outside the editor" data-mark="kept">
					<Icon name="warn" size="xs" />
					<span className="sr">, changed outside the editor</span>
				</span>
			) : null}
			{m.editing && lock ? (
				<span className="mk" data-mark="editing">
					<Avatar person={m.editing} size="sm" title={`${displayName(m.editing)} is editing`} />
					{compact ? <span className="sr">, {displayName(m.editing)} is editing</span> : <span className="who">{displayName(m.editing)} is editing</span>}
				</span>
			) : null}
			{m.present.map((p) => (
				<span key={p.email} className="mk" data-mark="present">
					<Avatar person={p} size="sm" title={`${displayName(p)} has it open`} />
					<span className="sr">, {displayName(p)} has it open</span>
				</span>
			))}
			{m.waiting ? (
				<span className="dot" title="Changes waiting" data-mark="waiting">
					<span className="sr">, changes waiting</span>
				</span>
			) : null}
		</>
	);
}

/** The marks of what's inside a closed group, a closed parent or a collection, bubbled up. */
export function Bubble({ files }: { files: readonly string[] }) {
	const editor = useEditor();
	const all = useStore(editor.marks);
	if (all.size === 0) return null;
	let someone: Person | null = null;
	let waiting = false;
	for (const file of files) {
		const m = all.get(file);
		if (!m) continue;
		someone ??= m.editing ?? m.present[0] ?? null;
		waiting ||= m.waiting;
	}
	if (!someone && !waiting) return null;
	return (
		<>
			{someone ? (
				<span className="mk" data-mark="bubble-person">
					<Avatar person={someone} size="sm" title={`${displayName(someone)} is in here`} />
					<span className="sr">, {displayName(someone)} is in here</span>
				</span>
			) : null}
			{waiting ? (
				<span className="dot" title="Changes waiting inside" data-mark="bubble-waiting">
					<span className="sr">, changes waiting inside</span>
				</span>
			) : null}
		</>
	);
}
