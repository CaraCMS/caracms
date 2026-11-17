/**
 * Review gaps (Decisions 9 and 9a): Site Settings › Forms, today's "Form emails" grown into a group
 * per form (the mockup's #forms-settings and #forms-options): its fields, one row each (one open at
 * a time, as a list's rows), then its button and messages, then who gets its emails (Recipients,
 * as before).
 *
 * Every word is an ordinary Site Settings field (`formWords.<form>…`, forms/word-fields.ts), so a
 * click on the page picks it here (`focusSidebarField` finds its frame by `data-ff`), and the row
 * and the group holding a picked word open. A blank box shows the word it uses in grey, the site
 * code's or the config's or the package's (forms/words.ts); a changed one names its length and has
 * Reset. A select's option words are written as the whole `options` object (an all-digit value
 * would otherwise be made an array index).
 */
import { useState } from 'react';
import { fieldAt, getAtPath, type Fields, type TextField } from '../../../../fields.ts';
import { PACKAGE_WORDS, formHasChoose, resolveFormWords, storedWordsOf, takesPlaceholder, wordPath, FORM_WORDS_KEY, type FormWord, type FormWords } from '../../../../forms/words.ts';
import type { ResolvedFormField } from '../../../../forms/rules.ts';
import { useEditor, useStore } from '../../context.tsx';
import { FieldFrame } from '../../fields/FieldFrame.tsx';
import { useHost } from '../../fields/host.tsx';
import { Icon } from '../../shell/Icons.tsx';
import type { EditorForm } from '../../../types.ts';

const KIND: Record<ResolvedFormField['type'], string> = { text: 'Short text', email: 'Email', tel: 'Phone', textarea: 'Long text', select: 'Choice', files: 'Files', rows: 'Rows' };
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The section: a group per form, its words first, then its emails (`recipients` draws those). */
export function FormsSection({ data, recipients }: { data: Record<string, unknown>; recipients: (form: EditorForm) => React.ReactNode }) {
	const editor = useEditor();
	const picked = useStore(editor.view, (v) => (v.field?.startsWith(`${FORM_WORDS_KEY}.`) ? v.field : null));
	return (
		<section className="set-sec fm-sec" data-sec="forms">
			<h3>Forms</h3>
			<p className="lead">Each form’s words, the same on the page, in its emails and in Submissions, then who gets its emails. A blank box uses the words shown in grey.</p>
			{editor.forms.length ? editor.forms.map((form) => <FormGroup key={form.id} form={form} data={data} picked={picked} recipients={recipients} />) : <p className="field-help">No forms yet.</p>}
		</section>
	);
}

/** The words set for a form, counted (each a changed word). */
function changedIn(value: unknown): number {
	if (typeof value === 'string') return value.trim() ? 1 : 0;
	if (value && typeof value === 'object') return Object.values(value).reduce<number>((n, v) => n + changedIn(v), 0);
	return 0;
}

function FormGroup({ form, data, picked, recipients }: { form: EditorForm; data: Record<string, unknown>; picked: string | null; recipients: (form: EditorForm) => React.ReactNode }) {
	const editor = useEditor();
	const prefix = wordPath(form.id, '');
	const pickedHere = picked?.startsWith(prefix) ? picked.slice(prefix.length) : null;
	const pickedField = pickedHere?.startsWith('fields.') ? pickedHere.split('.')[1]! : null;
	const [open, setOpen] = useState<boolean | null>(null);
	const [row, setRow] = useState<string | null>(null);
	const isOpen = open ?? pickedHere !== null;
	const openRow = pickedField ?? row;
	const stored = getAtPath(data, `${FORM_WORDS_KEY}.${form.id}`);
	const words = resolveFormWords({ id: form.id, label: form.label, email: { subject: '' }, fields: form.fields }, storedWordsOf(data[FORM_WORDS_KEY], form.id));
	const defaults = resolveFormWords({ id: form.id, label: form.label, email: { subject: '' }, fields: form.fields }, {});
	const fields = (editor.site.collections.find((c) => c.kind === 'settings') as { fields?: Fields } | undefined)?.fields ?? {};
	const changed = changedIn(stored);
	const n = form.fields.length;
	const has = { select: formHasChoose(form) };
	return (
		<details className="fgroup fm" data-form-words={form.id} open={isOpen} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
			<summary>
				{form.label} form{' '}
				<span className="s">
					· {n} field{n === 1 ? '' : 's'}
					{changed ? ` · ${changed} changed` : ''}
				</span>
				<Icon name="chev-r" size="sm" />
			</summary>
			<div className="in">
				<div className="fm-part">
					<div className="fm-part-h">
						<b>Fields</b>
						<span className="field-meta">{n}</span>
					</div>
					<div className="items">
						{form.fields.map((f) => {
							const rowOpen = openRow === f.name;
							const c = changedIn(getAtPath(stored, `fields.${f.name}`));
							return (
								<div key={f.name} className={`item${rowOpen ? ' is-open' : ''}`} data-item={`${form.id}.${f.name}`}>
									<div className="item-h">
										<button type="button" className="item-sum" aria-expanded={rowOpen} onClick={() => setRow(rowOpen ? null : f.name)}>
											<span className="s">
												{words.fields[f.name]!.label.value}{' '}
												<span>
													· {KIND[f.type]}
													{f.optional ? ', optional' : ''}
												</span>
											</span>
											{c ? <span className="chip set">{c} changed</span> : null}
											<Icon name="chev-r" size="xs" />
										</button>
									</div>
									{rowOpen ? (
										<div className="item-b">
											<FieldWords form={form.id} field={f} words={words} defaults={defaults} fields={fields} data={data} />
										</div>
									) : null}
								</div>
							);
						})}
					</div>
				</div>
				<div className="fm-part" data-part="own">
					<div className="fm-part-h">
						<b>Button and messages</b>
					</div>
					<Word path={words.submit.field!} fields={fields} data={data} placeholder={defaults.submit.value} />
					<Word path={words.sending.field!} fields={fields} data={data} placeholder={defaults.sending.value} />
					<Word path={words.sent.heading.field!} fields={fields} data={data} placeholder={defaults.sent.heading.value || 'None'} />
					<Word path={words.sent.line.field!} fields={fields} data={data} placeholder={defaults.sent.line.value} />
					<Word path={words.failed.field!} fields={fields} data={data} placeholder={defaults.failed.value} />
					{has.select ? <Word path={words.choose.field!} fields={fields} data={data} placeholder={defaults.choose.value} /> : null}
				</div>
				<div className="fm-part">{recipients(form)}</div>
			</div>
		</details>
	);
}

/** One field's words: its label, placeholder, help, error, "(optional)", a select's options, and a rows field's words and columns (form rows Decision 14). */
function FieldWords({ form, field, words, defaults, fields, data }: { form: string; field: ResolvedFormField; words: FormWords; defaults: FormWords; fields: Fields; data: Record<string, unknown> }) {
	const w = words.fields[field.name]!;
	const d = defaults.fields[field.name]!;
	return (
		<>
			<Word path={w.label.field!} fields={fields} data={data} placeholder={d.label.value} />
			{takesPlaceholder(field.type) && w.placeholder ? <Word path={w.placeholder.field!} fields={fields} data={data} placeholder={d.placeholder!.value || 'None'} /> : null}
			<Word path={w.help.field!} fields={fields} data={data} placeholder={d.help.value || 'None'} />
			{w.error.field ? <Word path={w.error.field} fields={fields} data={data} placeholder={d.error.value} /> : null}
			{w.optional ? <Word path={w.optional.field!} fields={fields} data={data} placeholder={d.optional?.value ?? PACKAGE_WORDS.optional} /> : null}
			<OptionWords path={wordPath(form, `fields.${field.name}.options`)} words={w.options} defaults={d.options} fields={fields} data={data} />
			{field.type === 'rows' ? (
				<>
					{(['rowLabel', 'add', 'remove', 'atMost'] as const).map((key) => (w[key] ? <Word key={key} path={w[key]!.field!} fields={fields} data={data} placeholder={d[key]!.value} /> : null))}
					{(field.columns ?? []).map((c) => {
						const cw = w.columns?.[c.name];
						const cd = d.columns?.[c.name];
						if (!cw || !cd) return null;
						return (
							<div key={c.name} className="w" data-ff={wordPath(form, `fields.${field.name}.columns.${c.name}`)} data-column={c.name}>
								<div className="field-head">
									<span className="field-label">{cw.label.value}</span>
									<span className="field-meta">Column</span>
								</div>
								<Word path={cw.label.field!} fields={fields} data={data} placeholder={cd.label.value} />
								{cw.placeholder ? <Word path={cw.placeholder.field!} fields={fields} data={data} placeholder={cd.placeholder!.value || 'None'} /> : null}
								<Word path={cw.error.field!} fields={fields} data={data} placeholder={cd.error.value} />
								<OptionWords path={wordPath(form, `fields.${field.name}.columns.${c.name}.options`)} words={cw.options} defaults={cd.options} fields={fields} data={data} />
							</div>
						);
					})}
				</>
			) : null}
		</>
	);
}

/** A select's option words (a field's or a column's), written as the whole `options` object. Sourced choices have none (form rows Decision 4). */
function OptionWords({ path, words, defaults, fields, data }: { path: string; words: Record<string, FormWord>; defaults: Record<string, FormWord>; fields: Fields; data: Record<string, unknown> }) {
	const host = useHost();
	const options = Object.entries(words).filter(([, word]) => word.field !== null);
	if (!options.length) return null;
	return (
		<div className="w" data-ff={path}>
			<div className="field-head">
				<span className="field-label">Options</span>
				<span className="field-meta">{options.length}</span>
			</div>
			<div className="w-opts">
				{options.map(([value, word]) => (
					<div key={value} className="w-opt">
						<Word
							path={word.field!}
							fields={fields}
							data={data}
							placeholder={defaults[value]!.value}
							onChange={(v) => {
								const now = getAtPath(data, path);
								const next = { ...(now && typeof now === 'object' && !Array.isArray(now) ? (now as Record<string, unknown>) : {}), [value]: v };
								host.set(path, next);
							}}
						/>
					</div>
				))}
			</div>
			<p className="w-help">Each option’s words. What’s stored with an answer is the grey value, which never changes.</p>
		</div>
	);
}

/**
 * One word's box: its label, "Up to N" while blank (the grey word is the one it uses), or its
 * length and Reset once changed; its help under the box. Its frame is the field's (`data-ff`), so
 * a click on the page picks it.
 */
function Word({ path, fields, data, placeholder, onChange }: { path: string; fields: Fields; data: Record<string, unknown>; placeholder: string; onChange?: (value: string) => void }) {
	const host = useHost();
	const descriptor = fieldAt(fields, path) as TextField | undefined;
	const value = str(getAtPath(data, path));
	const set = value !== '';
	const max = descriptor?.max ?? 60;
	const id = `w-${path.replace(/[^\w-]/g, '-')}`;
	const write = onChange ?? ((v: string) => host.set(path, v));
	const multiline = !!descriptor?.multiline;
	const meta = set ? (
		<span className="field-meta" data-count={max}>
			{value.length} / {max} ·{' '}
			<button type="button" className="linkbtn" data-reset={path} title={`Back to “${placeholder}”`} disabled={host.readOnly} onClick={() => write('')}>
				Reset
			</button>
		</span>
	) : (
		<span className="field-meta">Up to {max}</span>
	);
	return (
		<FieldFrame blockKey={host.scope} name={path} label={descriptor?.label ?? path} htmlFor={id} meta={meta} className={`w${set ? ' is-set' : ''}`}>
			{multiline ? (
				<textarea className="input" id={id} data-path={path} rows={2} value={value} placeholder={placeholder} spellCheck={false} disabled={host.readOnly} onChange={(e) => write(e.target.value)} />
			) : (
				<input className="input" id={id} data-path={path} value={value} placeholder={placeholder} autoComplete="off" spellCheck={false} disabled={host.readOnly} onChange={(e) => write(e.target.value.replace(/\n+/g, ' '))} />
			)}
			{descriptor?.help ? <p className="w-help">{descriptor.help}</p> : null}
		</FieldFrame>
	);
}
