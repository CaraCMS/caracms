/**
 * Edit in context, Decision 3: "Default footer" (or header) on a slot block's form, the switch
 * the hidden toggle is (HiddenToggle.tsx). One block per slot is the site's default: "Pages
 * that don't pick a footer get this one."
 *
 * - **Off → on** makes this block the default (documents/actions.ts → makeDefault): every other
 *   default of the slot is written without it first, then this one's own edit is kept. While
 *   someone else is editing one of them it's refused, and the sentence names them.
 * - **On stays on:** a slot keeps a default once it has one, so the switch can't be turned
 *   off here; another block's switch moves it.
 */
import { useMemo, useState } from 'react';
import type { SlotName } from '../../../config.ts';
import { useEditor, useStore } from '../context.tsx';
import { makeDefault } from '../documents/actions.ts';
import { Icon } from '../shell/Icons.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { FieldHostProvider, type FieldHost } from './host.tsx';

const SCOPE = 'slot-default';
const NAME = 'default';

export function DefaultSwitch({ slot }: { slot: SlotName }) {
	const editor = useEditor();
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const on = useStore(editor.doc.state, (s) => !!s.document.default);
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const host = useMemo<FieldHost>(() => ({ scope: SCOPE, picked: () => null, pick() {}, set() {}, removeItem() {}, raw: () => undefined, readOnly }), [readOnly]);
	const id = `f-${SCOPE}-${NAME}`;
	const turnOn = async () => {
		if (on || busy || readOnly) return;
		setBusy(true);
		setError(null);
		const answer = await makeDefault(editor, ref);
		setBusy(false);
		if (answer.ok) editor.announce(`Pages that don't pick a ${slot} get this one now.`);
		else setError(answer.error);
	};
	return (
		<div className="slot-default" data-slot-default={on ? 'on' : 'off'}>
			<FieldHostProvider host={host}>
				<FieldFrame blockKey={SCOPE} name={NAME} label={`Default ${slot}`} help={on ? `The default ${slot}. To change it, make another ${slot} the default.` : undefined} htmlFor={id}>
					<button type="button" className="switch" role="switch" id={id} data-path={NAME} aria-checked={on} aria-disabled={on || undefined} disabled={readOnly || busy} onClick={() => void turnOn()}>
						<span className="track" />
						<span>Pages that don't pick a {slot} get this one</span>
					</button>
				</FieldFrame>
			</FieldHostProvider>
			{error ? (
				<p className="field-warn" role="alert" data-why="slot-default">
					<Icon name="warn" size="sm" />
					<span>{error}</span>
				</p>
			) : null}
		</div>
	);
}
