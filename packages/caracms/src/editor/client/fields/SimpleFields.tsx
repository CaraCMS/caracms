/**
 * M5a's small fields (Decision 2), each in the field frame and set through the
 * field host (host.tsx):
 *
 *   toggle   `true` / `false`: the mockup's switch, "On" / "Off"
 *   number   a JSON number, `null` when cleared. Out of range: kept as typed, with
 *            the reason on the field (Decision 15); the page gets null and shows its default
 *   date     `"2026-10-15"`, `null` when cleared: the browser's own date input (Decision 2)
 */
import { useEffect, useState } from 'react';
import type { NumberField as NumberDescriptor, ToggleField as ToggleDescriptor } from '../../../fields.ts';
import { FieldFrame } from './FieldFrame.tsx';
import { useFieldWarnings, useHost } from './host.tsx';
import { FieldIcon, Warnings } from './parts.tsx';

interface Props<F> {
	name: string;
	label: string;
	field: F;
	value: unknown;
}

const fieldId = (scope: string, name: string) => `f-${scope}-${name}`;

export function ToggleField(props: Props<ToggleDescriptor>) {
	const host = useHost();
	const id = fieldId(host.scope, props.name);
	const on = typeof props.value === 'boolean' ? props.value : props.field.default;
	const warnings = useFieldWarnings(props.name, props.field, props.value);
	return (
		<FieldFrame blockKey={host.scope} name={props.name} label={props.label} help={props.field.help} htmlFor={id}>
			<button type="button" className="switch" role="switch" id={id} data-path={props.name} aria-checked={on} onClick={() => host.set(props.name, !on)}>
				<span className="track" />
				<span>{on ? 'On' : 'Off'}</span>
			</button>
			<Warnings warnings={warnings} />
		</FieldFrame>
	);
}

/** What the input shows for a stored number. */
const shown = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '');

export function NumberField(props: Props<NumberDescriptor>) {
	const host = useHost();
	const id = fieldId(host.scope, props.name);
	const { min, max, step } = props.field;
	// What's typed, kept while it's mid-entry ("-", "1."), so the stored value never rewrites the input under the caret.
	const [text, setText] = useState(() => shown(props.value));
	useEffect(() => {
		const parsed = text.trim() === '' ? null : Number(text);
		const stored = typeof props.value === 'number' ? props.value : null;
		if (parsed !== stored) setText(shown(props.value));
	}, [props.value]);
	const warnings = useFieldWarnings(props.name, props.field, props.value);
	const bad = warnings.length > 0;
	const range = min !== undefined && max !== undefined ? `${min} to ${max}` : min !== undefined ? `${min} or more` : max !== undefined ? `up to ${max}` : '';
	const onChange = (next: string) => {
		setText(next);
		if (next.trim() === '') {
			host.set(props.name, null);
			return;
		}
		const n = Number(next);
		if (Number.isFinite(n)) host.set(props.name, n);
	};
	return (
		<FieldFrame blockKey={host.scope} name={props.name} label={props.label} help={props.field.help} htmlFor={id}>
			<div className="numf">
				<input
					className="input"
					type="number"
					id={id}
					data-path={props.name}
					inputMode="decimal"
					value={text}
					min={min}
					max={max}
					step={step ?? 'any'}
					aria-invalid={bad || undefined}
					aria-describedby={bad ? `${id}-w` : undefined}
					onChange={(e) => onChange(e.target.value)}
				/>
				{range ? <span className="rng">{range}</span> : null}
			</div>
			<Warnings warnings={warnings} id={`${id}-w`} />
		</FieldFrame>
	);
}
