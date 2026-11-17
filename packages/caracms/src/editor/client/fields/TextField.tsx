/**
 * Text, one line or several (Decision 12; the line-break rule: a break is `\n`, and
 * nothing else breaks the text). The same field is typed on the page (page-edit.ts);
 * what's typed there shows here as it's typed (the store), and what's typed here
 * re-renders the preview.
 *
 * M6: a field with a `max` (the Form block's intro, Decision 17) counts its characters,
 * and past it the count and a note turn amber. Nothing is refused (it's kept as written).
 */
import type { TextField as TextDescriptor } from '../../../fields.ts';
import { useEditor } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { useFieldHost } from './host.tsx';

export function TextField(props: { blockKey: string; name: string; label: string; field: TextDescriptor; value: unknown }) {
	const editor = useEditor();
	// In a field host (host.tsx) the value is set through it; M3's block level passed the block's key.
	const host = useFieldHost();
	const id = `f-${props.blockKey}-${props.name}`.replace(/\./g, '-');
	const value = typeof props.value === 'string' ? props.value : '';
	const set = (next: string) => {
		const v = props.field.multiline ? next : next.replace(/\n+/g, ' ');
		if (host) host.set(props.name, v);
		else editor.doc.setField(props.blockKey, props.name, v);
	};
	const max = props.field.max;
	const over = max !== undefined && value.length > max;
	const meta =
		max !== undefined ? (
			<span className={`field-meta${over ? ' soft-over' : ''}`} data-count={max} data-soft="">
				{value.length} / {max}
			</span>
		) : undefined;
	const warn = over ? (
		<p className="field-warn" id={`${id}-w`} data-over="">
			<Icon name="warn" size="sm" />
			<span>Over {max}: it may not fit.</span>
		</p>
	) : null;
	return (
		<FieldFrame blockKey={props.blockKey} name={props.name} label={props.label} help={props.field.help} htmlFor={id} meta={meta}>
			{props.field.multiline ? (
				<textarea className="input" id={id} data-path={props.name} rows={3} value={value} spellCheck={false} aria-describedby={over ? `${id}-w` : undefined} onChange={(e) => set(e.target.value)} />
			) : (
				<input className="input" id={id} data-path={props.name} value={value} autoComplete="off" spellCheck={false} aria-describedby={over ? `${id}-w` : undefined} onChange={(e) => set(e.target.value)} />
			)}
			{warn}
		</FieldFrame>
	);
}
