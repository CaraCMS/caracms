/**
 * A group (the editor-friction batch, item 1): `group({ heading: text(), button: buttons(…) })`,
 * drawn the way M6c's Page details is: a labelled section of the sidebar that opens and
 * closes, open by default. Closed, it carries a warning mark when anything inside it is
 * warned (the list row's `.wmark`), so a closed group never hides a problem.
 *
 * Its fields are the ordinary field controls at the group's paths (`left.heading`), so
 * they pick, ring, warn and type on the page as any field does. A path picked inside the
 * group (from the page, or Publish's list of images without alt text) opens it.
 *
 * `FieldSection` is the section itself, shared with Page details (PageFields.tsx), so
 * the two look and behave the same.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { titleCase, type Field, type GroupField as GroupDescriptor } from '../../../fields.ts';
import { useEditor } from '../context.tsx';
import type { View } from '../editor.ts';
import { formRows } from '../pane/levels/FormLevel.tsx';
import { Icon } from '../shell/Icons.tsx';
import { FieldControl } from './FieldControl.tsx';
import { useFieldWarnings, useHost, within } from './host.tsx';
import { Warnings } from './parts.tsx';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** "1 warning in Left" / "3 warnings in Page details", the mark's title (and, as "… in it", its words for a screen reader). */
const warnedLine = (n: number, label: string) => `${n} warning${n === 1 ? '' : 's'} in ${label}`;

/**
 * A path picked inside a section, as a count that goes up each time one is picked
 * (`useReveal`'s): the section reopens on every new pick, even after it was closed by
 * hand. `inside` is the path picked in it at a view, or null.
 *
 * A pick is a view change that lands inside: to another path, a click on the page
 * (`picked`), or a popover closing on it (Publish's "Add alt text", which picks the same
 * path again when it's asked twice).
 */
export function useReveal(inside: (view: View) => string | null): number {
	const editor = useEditor();
	const [count, setCount] = useState(0);
	const at = useRef(inside);
	at.current = inside;
	useEffect(
		() =>
			editor.view.subscribe((next, previous) => {
				const path = at.current(next);
				if (path === null) return;
				if (path !== at.current(previous) || next.picked !== previous.picked || (previous.pop !== null && next.pop === null)) setCount((c) => c + 1);
			}),
		[editor],
	);
	return count;
}

/**
 * A section of the sidebar that opens and closes (`details.fgroup`), open by default.
 * `warnings` is how many warnings are inside: closed, a mark says so. `reveal` opens it
 * each time it goes up (a path inside it was picked: `useReveal`).
 */
export function FieldSection(props: { label: string; className: string; warnings: number; reveal?: number; data?: Record<string, string>; children: ReactNode }) {
	const [open, setOpen] = useState(true);
	useEffect(() => {
		if (props.reveal) setOpen(true);
	}, [props.reveal]);
	const marked = !open && props.warnings > 0;
	return (
		<details className={`fgroup ${props.className}`} open={open} {...props.data} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
			<summary>
				{props.label}
				{marked ? (
					<span className="wmark" data-wmark={props.warnings} title={warnedLine(props.warnings, props.label)}>
						<Icon name="warn" size="xs" />
						<span className="sr">{warnedLine(props.warnings, 'it')}</span>
					</span>
				) : null}
				<Icon name="chev-r" size="sm" />
			</summary>
			<div className="in">{props.children}</div>
		</details>
	);
}

export function GroupField(props: { name: string; label: string; field: GroupDescriptor; value: unknown; lockupIndex?: number }) {
	const host = useHost();
	const { name, field } = props;
	const data = isObject(props.value) ? props.value : {};
	const warnings = useFieldWarnings(name, field, props.value);
	const reveal = useReveal((v) => {
		const picked = host.picked(v);
		return picked !== null && within(picked, name) && picked !== name ? picked : null;
	});
	const control = ([key, f]: [string, Field]) => <FieldControl key={key} name={`${name}.${key}`} label={f.label ?? titleCase(key)} field={f} value={data[key]} lockupIndex={props.lockupIndex} />;
	return (
		<FieldSection label={props.label} className="group-field" warnings={warnings.length} reveal={reveal} data={{ 'data-group': name }}>
			{field.help ? (
				<p className="field-help" data-help="">
					{field.help}
				</p>
			) : null}
			{/* The group's own (its value isn't an object); its fields say theirs. */}
			<Warnings warnings={warnings.filter((w) => w.path === '')} />
			{formRows(field.fields).map((row) =>
				row.length === 2 ? (
					<div key={`${row[0]![0]}+`} className="two">
						{row.map(control)}
					</div>
				) : (
					control(row[0]!)
				),
			)}
		</FieldSection>
	);
}
