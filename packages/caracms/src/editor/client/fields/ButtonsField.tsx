/**
 * Buttons (M5a Decision 2; the template's one button shape): `[{ "label", "href",
 * "style" }]`, up to the field's `max` (default 2). The mockup's `.btnf`: each
 * button its style, its label and where it goes (LinkControl). A button shows only
 * with both a label and a link: half of one renders nothing, and the field says so
 * (the mockup's #buttons-half). Removing one has Undo, as a list row does
 * (Decision 14).
 */
import type { ButtonsField as ButtonsDescriptor, ButtonValue } from '../../../fields.ts';
import { Icon } from '../shell/Icons.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { useFieldWarnings, useHost, warningsAt } from './host.tsx';
import { LinkControl } from './LinkField.tsx';
import { Warn, Warnings } from './parts.tsx';

const ordinal = ['', 'second', 'third', 'fourth', 'fifth'];

export function ButtonsField(props: { name: string; label: string; field: ButtonsDescriptor; value: unknown }) {
	const host = useHost();
	const { name, field } = props;
	const buttons = (Array.isArray(props.value) ? props.value : []) as ButtonValue[];
	const warnings = useFieldWarnings(name, field, props.value);
	const add = () => {
		const style = field.styles[Math.min(buttons.length, field.styles.length - 1)]!.value;
		host.set(`${name}.${buttons.length}`, { label: '', href: '', style });
		requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`input[data-path="${CSS.escape(`${name}.${buttons.length}.label`)}"]`)?.focus());
	};
	return (
		<FieldFrame blockKey={host.scope} name={name} label={props.label} help={props.field.help} meta={<span className="field-meta">Up to {field.max}</span>}>
			{buttons.length === 0 ? <div className="list-empty">No buttons.</div> : null}
			{buttons.map((b, i) => {
				const own = warningsAt(warnings, String(i));
				const half = own.find((w) => w.code === 'half-link');
				const hasLabel = b.label.trim() !== '';
				const say = half ? `Button ${i + 1} has no ${hasLabel ? 'link' : 'label'}, so it doesn't show on the site.` : null;
				return (
					<div key={i} className={`btnf${half ? ' is-half' : ''}`} data-button={i}>
						<div className="btnf-h">
							<span className="t">{field.max === 1 ? 'Button' : `Button ${i + 1}`}</span>
							<button
								type="button"
								className="ib"
								aria-label={`Remove button ${i + 1}`}
								onClick={() => host.removeItem(name, i, `Removed button: ${b.label.trim() || 'empty'}`)}
							>
								<Icon name="x" size="sm" />
							</button>
						</div>
						{/* Its own row, the full width: three styles don't fit beside the name in a nested card. */}
						<div className="mini-seg" role="radiogroup" aria-label={`Button ${i + 1} style`}>
							{field.styles.map((s) => (
								<button key={s.value} type="button" role="radio" aria-checked={b.style === s.value} onClick={() => host.set(`${name}.${i}.style`, s.value)}>
									{s.label}
								</button>
							))}
						</div>
						<input
							className="input"
							aria-label={`Button ${i + 1} label`}
							placeholder="Label"
							data-path={`${name}.${i}.label`}
							value={b.label}
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => host.set(`${name}.${i}.label`, e.target.value.replace(/\n+/g, ' '))}
						/>
						<LinkControl
							path={`${name}.${i}.href`}
							href={b.href}
							label={`Button ${i + 1} link`}
							warnings={warningsAt(warnings, `${i}.href`)}
							onChange={(href) => host.set(`${name}.${i}.href`, href)}
						/>
						{say ? <Warn>{say}</Warn> : null}
					</div>
				);
			})}
			<Warnings warnings={warnings.filter((w) => w.path === '')} />
			{buttons.length < field.max ? (
				<button type="button" className="linkbtn subtle" style={{ marginTop: 'var(--space-2)' }} onClick={add}>
					<Icon name="plus" size="xs" />
					{buttons.length === 0 ? 'Add a button' : ordinal[buttons.length] ? `Add a ${ordinal[buttons.length]} button` : 'Add another button'}
				</button>
			) : null}
		</FieldFrame>
	);
}
