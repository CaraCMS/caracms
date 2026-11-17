/**
 * The toast (M2 Decision 14; Decision 18): the newest Undo entry, for a few seconds,
 * with an Undo button. ⌘Z (outside a field) undoes too (App.tsx). The editor's own
 * messages (`editor.toast`, M4: "Aoife's done. About is yours to edit now." when a lock
 * lapses) use the same toast, with an icon and no Undo, for four seconds, as the
 * mockup's `toast(text, false, icon)`. Whichever came last shows.
 */
import { useEffect, useState } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from './Icons.tsx';

type Shown = { kind: 'undo'; id: number } | { kind: 'message'; id: number } | null;

export function Toast() {
	const editor = useEditor();
	const undo = useStore(editor.doc.state, (s) => s.undo);
	const latest = undo.at(-1) ?? null;
	const message = useStore(editor.message);
	const [shown, setShown] = useState<Shown>(null);
	useEffect(() => {
		if (!latest) {
			setShown((s) => (s?.kind === 'undo' ? null : s));
			return;
		}
		setShown({ kind: 'undo', id: latest.id });
		const timer = setTimeout(() => setShown((s) => (s?.kind === 'undo' && s.id === latest.id ? null : s)), 8000);
		return () => clearTimeout(timer);
	}, [latest]);
	useEffect(() => {
		if (!message) return;
		setShown({ kind: 'message', id: message.id });
		const timer = setTimeout(() => setShown((s) => (s?.kind === 'message' && s.id === message.id ? null : s)), 4000);
		return () => clearTimeout(timer);
	}, [message]);
	const dismiss = (
		<button type="button" className="ib" aria-label="Dismiss" style={{ color: 'var(--bar-muted)' }} onClick={() => setShown(null)}>
			<Icon name="x" size="sm" />
		</button>
	);
	if (shown?.kind === 'message' && message && shown.id === message.id) {
		return (
			<div className="toast" role="status">
				{message.icon ? <Icon name={message.icon} size="sm" /> : null}
				<span className="t">{message.text}</span>
				{dismiss}
			</div>
		);
	}
	if (!latest || shown?.kind !== 'undo' || shown.id !== latest.id) return null;
	// As the mockup's undo toast: the text, Undo with its key, and a quiet dismiss.
	return (
		<div className="toast" role="status">
			<span className="t">{latest.label}</span>
			<button type="button" className="btn sm" onClick={() => editor.doc.undo()}>
				<Icon name="undo" size="sm" />
				Undo <kbd>⌘Z</kbd>
			</button>
			{dismiss}
		</div>
	);
}
