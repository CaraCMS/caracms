/**
 * One field of any kind, by its descriptor: what a level mounts for each field in
 * its schema, inside a FieldHostProvider (host.tsx).
 *
 *   <FieldHostProvider host={blockHost(editor, key, raw, readOnly)}>
 *     {Object.entries(fields).map(([name, field]) => (
 *       <FieldControl key={name} name={name} label={field.label ?? titleCase(name)} field={field} value={data[name]} />
 *     ))}
 *   </FieldHostProvider>
 *
 * `value` is the field's parsed value (document.ts parses every known field).
 * `lockupIndex` is the block's index in the rendered document, for the lockup's
 * preview warnings (only the block level has one); a group passes it on to its fields.
 */
import type { Field } from '../../../fields.ts';
import { ButtonsField } from './ButtonsField.tsx';
import { useHost } from './host.tsx';
import { LinkField } from './LinkField.tsx';
import { GroupField } from './GroupField.tsx';
import { ListField } from './ListField.tsx';
import { MediaField } from './MediaField.tsx';
import { LockupField } from './LockupField.tsx';
import { ReferenceField } from './ReferenceField.tsx';
import { RichTextField } from './RichTextField.tsx';
import { SelectField } from './SelectField.tsx';
import { DateField } from './DateField.tsx';
import { NumberField, ToggleField } from './SimpleFields.tsx';
import { TextField } from './TextField.tsx';

export function FieldControl(props: { name: string; label: string; field: Field; value: unknown; lockupIndex?: number }) {
	const host = useHost();
	const { name, label, field, value } = props;
	switch (field.kind) {
		case 'text':
			return <TextField blockKey={host.scope} name={name} label={label} field={field} value={value} />;
		case 'select':
			return <SelectField blockKey={host.scope} name={name} label={label} field={field} value={value} />;
		case 'lockup':
			return <LockupField key={`${host.scope}-${name}`} blockKey={host.scope} index={props.lockupIndex ?? -1} name={name} label={label} field={field} value={value} />;
		case 'richText':
			return <RichTextField name={name} label={label} field={field} value={value} />;
		case 'link':
			return <LinkField name={name} label={label} field={field} value={value} />;
		case 'buttons':
			return <ButtonsField name={name} label={label} field={field} value={value} />;
		case 'toggle':
			return <ToggleField name={name} label={label} field={field} value={value} />;
		case 'number':
			return <NumberField name={name} label={label} field={field} value={value} />;
		case 'date':
			return <DateField name={name} label={label} field={field} value={value} />;
		case 'list':
			return <ListField name={name} label={label} field={field} value={value} />;
		case 'group':
			return <GroupField name={name} label={label} field={field} value={value} lockupIndex={props.lockupIndex} />;
		case 'reference':
			return <ReferenceField name={name} label={label} field={field} value={value} />;
		case 'media':
			return <MediaField name={name} label={label} field={field} value={value} />;
	}
}
