/**
 * One of a fixed list (Decision 12). Edited in the sidebar only.
 *
 * M6: a select whose options are the site's forms (the starter's Form block picks one
 * by its id, Decision 17) is the form picker (the mockup's #form-block): it says where the
 * form's fields come from, and under it how many fields the chosen form has and who gets
 * its email (Site Settings → Forms, where its words are too: review gaps, Decision 9).
 */
import { looksLikeEmail } from '../../../forms/rules.ts';
import type { SelectField as SelectDescriptor } from '../../../fields.ts';
import { useEditor } from '../context.tsx';
import type { Editor } from '../editor.ts';
import { Icon } from '../shell/Icons.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { useFieldHost } from './host.tsx';
import { useSiteSettings } from './SeoGroup.tsx';

/** Whether a select picks one of the site's forms: its options are exactly the forms' ids. */
export function isFormPicker(editor: Pick<Editor, 'forms'>, field: SelectDescriptor): boolean {
	const ids = editor.forms.map((f) => f.id).sort();
	const values = field.options.map((o) => o.value).sort();
	return ids.length > 0 && ids.length === values.length && ids.every((id, i) => id === values[i]);
}

export function SelectField(props: { blockKey: string; name: string; label: string; field: SelectDescriptor; value: unknown }) {
	const editor = useEditor();
	const host = useFieldHost();
	const id = `f-${props.blockKey}-${props.name}`.replace(/\./g, '-');
	const set = (v: string) => (host ? host.set(props.name, v) : editor.doc.setField(props.blockKey, props.name, v));
	const value = typeof props.value === 'string' ? props.value : props.field.default;
	const forms = isFormPicker(editor, props.field);
	return (
		<FieldFrame blockKey={props.blockKey} name={props.name} label={props.label} help={props.field.help} htmlFor={id}>
			<select className="input" id={id} data-path={props.name} value={value} onChange={(e) => set(e.target.value)}>
				{props.field.options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
			{forms ? <FormPickerHint formId={value} /> : null}
		</FieldFrame>
	);
}

function FormPickerHint({ formId }: { formId: string | undefined }) {
	const editor = useEditor();
	const settings = useSiteSettings();
	const form = editor.forms.find((f) => f.id === formId);
	const ok = (settings?.formRecipients[formId ?? ''] ?? []).filter(looksLikeEmail);
	const to = !settings ? null : ok.length === 0 ? 'no one yet' : ok.length === 1 ? ok[0]! : `${ok.length} addresses`;
	return (
		<>
			<p className="field-help">Its words, and who gets its emails, are in Site Settings › Forms.</p>
			{form ? (
				<p className="field-hint" data-form-hint={form.id}>
					<Icon name="mail" size="xs" />
					{form.fields.length} fields{to ? ` · its email goes to ${to}` : ''}
				</p>
			) : null}
		</>
	);
}
