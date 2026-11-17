/**
 * Review gaps (Decision 9a): `formWords` as real fields. resolveSite adds this group to Site
 * Settings' fields, one group per form, so a form word has a descriptor like any Site Settings
 * field: the package's `Text` and `Block field` mark it, the content schema and `validate` check
 * it, `focusSidebarField` finds it and the editor's Forms section draws it.
 *
 *   formWords.<form>.fields.<field>.{label, placeholder, help, error, optional, options.<value>}
 *   formWords.<form>.fields.<field>.{rowLabel, add, remove, atMost}                 (a rows field)
 *   formWords.<form>.fields.<field>.columns.<column>.{label, placeholder, error, options.<value>}
 *   formWords.<form>.{submit, sending, sent.heading, sent.line, failed, choose}
 *
 * A placeholder only for the types a visitor types into, "(optional)" only for an optional
 * field, options only for a select (a value with a dot keeps its config label: words.ts →
 * optionHasWord), "Choose…" only on a form with a select. The soft limits are the mockup's.
 *
 * These groups nest, where a site's own can't (`group()` refuses a group in a group, to keep a
 * block's sidebar flat): they're the package's, drawn only by its Forms section, and everything
 * else that reads a group (paths, parsing, saving, the content schema, validate) takes any depth.
 */
import { text, type Fields, type GroupField } from '../fields.ts';
import type { ResolvedForm } from './rules.ts';
import { columnTakesPlaceholder, formHasChoose, optionHasWord, takesPlaceholder } from './words.ts';

/** A group, built as a literal: `group()` would refuse the nesting. */
const nest = (fields: Fields, label: string): GroupField => ({ kind: 'group', label, fields });

/** The `formWords` group for the site's forms, or null when it has none. */
export function formWordFields(forms: Record<string, ResolvedForm>): GroupField | null {
	const byForm: Fields = {};
	for (const form of Object.values(forms)) {
		const fields: Fields = {};
		for (const f of form.fields) {
			const words: Fields = { label: text({ label: 'Label', max: 60, help: 'Also names this answer in emails and Submissions.' }) };
			if (f.type === 'select') words.placeholder = text({ label: 'Before a choice is made', max: 60, help: 'The first line of this choice. Blank: the form’s “Choose…”.' });
			else if (takesPlaceholder(f.type)) words.placeholder = text({ label: 'Placeholder', max: 60, help: 'Grey words in the empty box. Blank: none.' });
			words.help = text({ label: 'Help', max: 160, multiline: true, help: 'Under the box. Blank: none.' });
			if (f.type !== 'rows') words.error = text({ label: 'Error message', max: 120, help: f.optional ? 'Shown when it’s filled in wrong.' : 'Shown when it’s left empty or filled in wrong.' });
			if (f.optional) words.optional = text({ label: 'After the label', max: 20, help: 'Says the field can be left empty.' });
			const options = (f.options ?? []).filter((o) => optionHasWord(o.value));
			if (options.length) words.options = nest(Object.fromEntries(options.map((o) => [o.value, text({ label: o.value, max: 60 })])), 'Options');
			if (f.type === 'rows') {
				// Form rows Decision 14: the row word, the buttons, the at-most line, then each column's words.
				words.rowLabel = text({ label: 'Row word', max: 30, help: 'Names a row in the form’s messages, like “Product 2: …”.' });
				words.add = text({ label: 'Add button', max: 30 });
				words.remove = text({ label: 'Remove button', max: 30 });
				words.atMost = text({ label: 'At the most rows', max: 120, help: 'Shown in place of the add button once the form has its most rows.' });
				const columns: Fields = {};
				for (const c of f.columns ?? []) {
					const cw: Fields = { label: text({ label: 'Label', max: 60 }) };
					if (columnTakesPlaceholder(c)) {
						cw.placeholder =
							c.type === 'select'
								? text({ label: 'Before a choice is made', max: 60, help: 'The first line of this choice. Blank: the form’s “Choose…”.' })
								: text({ label: 'Placeholder', max: 60, help: 'Grey words in the empty box. Blank: none.' });
					}
					cw.error = text({ label: 'Error message', max: 120, help: 'Shown when it’s left empty or filled in wrong.' });
					const columnOptions = (c.options ?? []).filter((o) => optionHasWord(o.value));
					if (columnOptions.length) cw.options = nest(Object.fromEntries(columnOptions.map((o) => [o.value, text({ label: o.value, max: 60 })])), 'Options');
					columns[c.name] = nest(cw, c.label);
				}
				words.columns = nest(columns, 'Columns');
			}
			fields[f.name] = nest(words, f.label);
		}
		const own: Fields = {
			fields: nest(fields, 'Fields'),
			submit: text({ label: 'Button', max: 30 }),
			sending: text({ label: 'While sending', max: 30, help: 'On the button while the message goes.' }),
			sent: nest({ heading: text({ label: 'Sent: heading', max: 60, help: 'Shown in place of the form once it’s sent. Blank: the line alone, under the button.' }), line: text({ label: 'Sent: line', max: 200, multiline: true }) }, 'Sent'),
			failed: text({ label: 'Couldn’t send', max: 200, multiline: true, help: 'Under the button when the message doesn’t go. Nothing typed is lost.' }),
		};
		if (formHasChoose(form)) own.choose = text({ label: 'Before a choice is made', max: 30, help: 'The first line of every choice.' });
		byForm[form.id] = nest(own, form.label);
	}
	return Object.keys(byForm).length ? nest(byForm, 'Forms') : null;
}
