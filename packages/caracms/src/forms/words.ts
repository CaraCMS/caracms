/**
 * A form's words (review gaps, Decisions 9–13): every word a visitor reads on a form, where it
 * comes from, and the Site Settings field that holds it.
 *
 * **Where a word comes from** (Decision 10): Site Settings (`formWords.<form>`, a blank one is
 * unset), then the site's code (`Form.astro`'s props, or the defaults a site's own markup passes
 * to `cms.formWords`), then the form's config, then the package. Two exceptions keep 0.10.0's
 * order, so a site upgrading reads the same (Acceptance 18): a field's own `error` in the config
 * still wins over the code's `errors` by type, and `labelPlaceholders` uses the field's label as
 * the placeholder only when the config gives it none.
 *
 * **What no page can supply** (Decision 11): the endpoint's sentences, the email and the inbox
 * read `formWithWords()`, the config's form with Site Settings' labels, options, placeholders,
 * help and errors in place, so what the agency types is what the email says.
 *
 * Browser-safe (type imports only): the editor's Forms section reads the defaults too.
 */
import { narrowedChoices, rowCell, selectChoices, type FormChoice, type FormColumnType, type FormFieldType, type FormSources, type ResolvedForm, type ResolvedFormColumn, type ResolvedFormField } from './rules.ts';

/** The words a field's Site Settings group holds (Contracts → Site Settings). */
export interface StoredFieldWords {
	label?: string;
	placeholder?: string;
	help?: string;
	error?: string;
	optional?: string;
	options?: Record<string, string>;
	/** A rows field's (form rows Decision 14). */
	rowLabel?: string;
	add?: string;
	remove?: string;
	atMost?: string;
	columns?: Record<string, StoredColumnWords>;
}

/** A rows field's column's words in Site Settings (form rows Contracts → The words' paths). */
export interface StoredColumnWords {
	label?: string;
	placeholder?: string;
	error?: string;
	options?: Record<string, string>;
}

/** A form's words as Site Settings holds them (`formWords.<form>`); every one optional, a blank one unset. */
export interface StoredFormWords {
	fields?: Record<string, StoredFieldWords>;
	submit?: string;
	sending?: string;
	sent?: { heading?: string; line?: string };
	failed?: string;
	choose?: string;
}

/**
 * The site code's words for a form (Decision 10's middle layer): `Form.astro`'s props, or what a
 * site's own markup passes to `cms.formWords(form, defaults)`. Each optional.
 */
export interface FormCodeWords {
	/** The button. */
	submit?: string;
	/** The button's words while the message goes. */
	sending?: string;
	/** The sent panel's heading; blank or absent: no panel, the thanks line in the status line (0.10.0's send). */
	sentHeading?: string;
	/** The line after a send (Form.astro's `thanks`). */
	thanks?: string;
	/** The line when a send fails (Form.astro's `failed`). */
	failed?: string;
	/** A select's first line. */
	choose?: string;
	/** After an optional field's label. */
	optional?: string;
	/** The error line by field type; a field's own `error` in the config still wins (0.10.0's order). */
	errors?: Partial<Record<FormFieldType, string>>;
	/** A field that takes a placeholder and has none of its own uses its label as one. */
	labelPlaceholders?: boolean;
}

/**
 * One word as it resolves (Decision 13): `value`, what the visitor reads, and `field`, the Site
 * Settings path that holds it (`formWords.contact.fields.name.label`), to draw with `Text` (or
 * mark with `Block field`) under the Site Settings context. `field` is null for the one word no
 * field can hold: a select option whose value has a dot in it keeps its config label.
 */
export interface FormWord {
	value: string;
	field: string | null;
}

/**
 * One column's words (form rows Decisions 13 and 14). `placeholder` is a text or number column's
 * hint, or a select's blank first choice (none on a narrowed column: its select always has a
 * value). A select column has its `choices`; a narrowed one, what each document `allowed` and `else`.
 */
export interface FormColumnWords {
	label: FormWord;
	placeholder: FormWord | null;
	error: FormWord;
	/** A select column's fixed option labels, by value, in the config's order. */
	options: Record<string, FormWord>;
	/** A select column's choices, resolved and in order: fixed first, then the documents offered. */
	choices?: FormChoice[];
	/** A narrowed column: the option values each offered document allows (its `else` already applied). */
	allowed?: Record<string, string[]>;
	/** A narrowed column: the values offered before a pick (every option when the config gives none). */
	else?: string[];
}

/** One field's words (Decision 13). `placeholder` only for the types a visitor types into, and a select (its blank first choice); `optional` only for an optional field. */
export interface FormFieldWords {
	label: FormWord;
	placeholder: FormWord | null;
	help: FormWord;
	error: FormWord;
	optional: FormWord | null;
	/** A select's option labels, by option value, in the config's order. Empty for any other type. */
	options: Record<string, FormWord>;
	/** Form rows Decision 13: a select's choices, resolved and in order (fixed first, then the documents offered). */
	choices?: FormChoice[];
	/** Form rows Decision 14: a rows field's row word ("Product"), its add and remove buttons, its at-most line and its columns' words. */
	rowLabel?: FormWord;
	add?: FormWord;
	remove?: FormWord;
	atMost?: FormWord;
	columns?: Record<string, FormColumnWords>;
}

/**
 * `cms.formWords(form)`'s shape (Decision 13; recorded in the spec's Decisions during build): every
 * word of one form, resolved, each with the Site Settings field that holds it.
 */
export interface FormWords {
	/** The form's id. */
	form: string;
	/** The form's own label (config only: the inbox's and Site Settings' name for it). */
	label: string;
	/** By field name, in the form's order. */
	fields: Record<string, FormFieldWords>;
	submit: FormWord;
	sending: FormWord;
	/** The sent panel: its heading (blank: no panel, 0.10.0's thanks line) and its line. */
	sent: { heading: FormWord; line: FormWord };
	failed: FormWord;
	/** A select's first line ("Choose…"). */
	choose: FormWord;
}

/** The package's words, under the code's and the config's (0.10.0's, so nothing changes on upgrade). */
export const PACKAGE_WORDS = {
	submit: 'Send',
	sending: 'Sending…',
	sentHeading: '',
	thanks: "Thanks, we'll be in touch shortly.",
	failed: 'Something went wrong. Please email us directly.',
	choose: 'Choose…',
	optional: '(optional)',
	/** Form rows Decision 14: a rows field's words. */
	rowLabel: 'Row',
	add: 'Add another',
	remove: 'Remove',
	atMost: 'That’s the most this form takes.',
} as const;

/** The error line by field type when neither the config nor the code sets one. */
export const DEFAULT_ERRORS: Readonly<Record<FormFieldType, string>> = {
	text: 'Please fill this in.',
	email: 'Please enter your email address, like name@example.com.',
	tel: 'Please enter a phone number.',
	textarea: 'Please write a message.',
	select: 'Please choose one.',
	files: 'Please attach a file.',
	rows: 'Please add at least one.',
};

/** A column's error line when the config sets none (form rows Decision 14). */
export const DEFAULT_COLUMN_ERRORS: Readonly<Record<FormColumnType, string>> = {
	select: 'Please choose one.',
	number: 'Please enter a number above 0.',
	text: 'Please fill this in.',
};

/** Site Settings' key for every form's words (reserved.ts → SETTINGS_KEYS). */
export const FORM_WORDS_KEY = 'formWords';

/** The types that take a placeholder (rules.ts → PLACEHOLDER_TYPES): a select's is its blank first choice (form rows Decision 15). */
const TYPED: readonly FormFieldType[] = ['text', 'email', 'tel', 'textarea', 'select'];

/** Whether a field's type takes a placeholder. */
export const takesPlaceholder = (type: FormFieldType): boolean => TYPED.includes(type);

/** Whether a column takes a placeholder: every one but a narrowed select (which has no blank first choice). */
export const columnTakesPlaceholder = (column: Pick<ResolvedFormColumn, 'from'>): boolean => !column.from;

/** Whether a form has a select with a blank first choice (a field, or a column that isn't narrowed): its "Choose…" word is then used. */
export const formHasChoose = (form: Pick<ResolvedForm, 'fields'>): boolean =>
	form.fields.some((f) => f.type === 'select' || (f.columns ?? []).some((c) => c.type === 'select' && !c.from));

/** Whether a select option's value can be a field key (a value with a dot can't: it would split the path). */
export const optionHasWord = (value: string): boolean => !value.includes('.');

/** The Site Settings path of a form's word: `formWords.<form>.<rest>`. */
export const wordPath = (form: string, rest: string): string => `${FORM_WORDS_KEY}.${form}.${rest}`;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A stored word: its text when it has any, else undefined (blank is unset). */
const set = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
/** The first word that has any text, else ''. */
const first = (...words: (string | undefined)[]): string => words.find((w) => w !== undefined && w.trim() !== '')?.trim() ?? '';

/** A form's stored words from Site Settings' raw data (`settings.formWords`), shaped, whatever was there. */
export function storedWordsOf(formWords: unknown, form: string): StoredFormWords {
	const raw = isObject(formWords) && isObject(formWords[form]) ? (formWords[form] as Record<string, unknown>) : {};
	const fields: Record<string, StoredFieldWords> = {};
	if (isObject(raw.fields)) {
		for (const [name, f] of Object.entries(raw.fields)) {
			if (!isObject(f)) continue;
			const options: Record<string, string> = {};
			if (isObject(f.options)) for (const [value, label] of Object.entries(f.options)) if (set(label)) options[value] = set(label)!;
			const columns: Record<string, StoredColumnWords> = {};
			if (isObject(f.columns)) {
				for (const [column, c] of Object.entries(f.columns)) {
					if (!isObject(c)) continue;
					const columnOptions: Record<string, string> = {};
					if (isObject(c.options)) for (const [value, label] of Object.entries(c.options)) if (set(label)) columnOptions[value] = set(label)!;
					columns[column] = { label: set(c.label), placeholder: set(c.placeholder), error: set(c.error), options: columnOptions };
				}
			}
			fields[name] = {
				label: set(f.label),
				placeholder: set(f.placeholder),
				help: set(f.help),
				error: set(f.error),
				optional: set(f.optional),
				options,
				rowLabel: set(f.rowLabel),
				add: set(f.add),
				remove: set(f.remove),
				atMost: set(f.atMost),
				columns,
			};
		}
	}
	const sent = isObject(raw.sent) ? raw.sent : {};
	return { fields, submit: set(raw.submit), sending: set(raw.sending), sent: { heading: set(sent.heading), line: set(sent.line) }, failed: set(raw.failed), choose: set(raw.choose) };
}

/** A field's words below Site Settings: the code's, then the config's, then the package's (with 0.10.0's two exceptions). */
function fieldDefaults(f: ResolvedFormField, code: FormCodeWords, label: string) {
	return {
		// Form rows Decision 15: `labelPlaceholders` leaves a select alone (its blank choice falls back to "Choose…").
		placeholder: f.placeholder ?? (code.labelPlaceholders && takesPlaceholder(f.type) && f.type !== 'select' ? label : ''),
		help: f.help ?? '',
		error: first(f.error, code.errors?.[f.type], DEFAULT_ERRORS[f.type]),
	};
}

/** A select's option words, by value: Site Settings' (when its value can be a key), else the config's label. */
function optionWords(options: readonly FormChoice[] | undefined, stored: Record<string, string> | undefined, at: (rest: string) => string): Record<string, FormWord> {
	const out: Record<string, FormWord> = {};
	for (const o of options ?? []) out[o.value] = optionHasWord(o.value) ? { value: first(stored?.[o.value], o.label), field: at(`options.${o.value}`) } : { value: o.label, field: null };
	return out;
}

/** A select's resolved choices: its option words, then the documents offered (form rows Decision 2). */
const choicesFrom = (options: Record<string, FormWord>, select: { options?: readonly FormChoice[] }, offered: FormSources[string] | undefined): FormChoice[] =>
	selectChoices({ options: (select.options ?? []).map((o) => ({ value: o.value, label: options[o.value]?.value ?? o.label })) }, offered ?? []);

/**
 * Every word of a form as it resolves (Decision 10), with the Site Settings field holding each
 * (Decision 13). `sources` is the documents each sourced select offers (form rows Decision 2,
 * read on the server: forms/sources.ts); without it a select's `choices` are its fixed ones.
 */
export function resolveFormWords(form: ResolvedForm, stored: StoredFormWords, code: FormCodeWords = {}, sources: FormSources = {}): FormWords {
	const id = form.id;
	const fields: Record<string, FormFieldWords> = {};
	// Site Settings has a choose field only for a form with a select (word-fields.ts), so only it names one.
	const choose = { value: first(stored.choose, code.choose, PACKAGE_WORDS.choose), field: formHasChoose(form) ? wordPath(id, 'choose') : null };
	for (const f of form.fields) {
		const s = stored.fields?.[f.name] ?? {};
		const at = (rest: string) => wordPath(id, `fields.${f.name}.${rest}`);
		const label = first(s.label, f.label);
		const d = fieldDefaults(f, code, label);
		const options = optionWords(f.options, s.options, at);
		const placeholder = !takesPlaceholder(f.type)
			? null
			: f.type === 'select'
				? { value: first(s.placeholder, d.placeholder, choose.value), field: at('placeholder') }
				: { value: first(s.placeholder, d.placeholder), field: at('placeholder') };
		const words: FormFieldWords = {
			label: { value: label, field: at('label') },
			placeholder,
			help: { value: first(s.help, d.help), field: at('help') },
			// A rows field's own error word has no Site Settings field: each column's error line is the one shown (form rows Decision 17).
			error: f.type === 'rows' ? { value: first(f.error, DEFAULT_ERRORS.rows), field: null } : { value: first(s.error, d.error), field: at('error') },
			optional: f.optional ? { value: first(s.optional, code.optional, PACKAGE_WORDS.optional), field: at('optional') } : null,
			options,
		};
		if (f.type === 'select') words.choices = choicesFrom(options, f, sources[f.name]);
		if (f.type === 'rows') {
			words.rowLabel = { value: first(s.rowLabel, f.rowLabel, PACKAGE_WORDS.rowLabel), field: at('rowLabel') };
			words.add = { value: first(s.add, f.add, PACKAGE_WORDS.add), field: at('add') };
			words.remove = { value: first(s.remove, f.remove, PACKAGE_WORDS.remove), field: at('remove') };
			words.atMost = { value: first(s.atMost, f.atMost, PACKAGE_WORDS.atMost), field: at('atMost') };
			const columns: Record<string, FormColumnWords> = {};
			for (const c of f.columns ?? []) {
				const sc = (s.columns && Object.hasOwn(s.columns, c.name) ? s.columns[c.name] : undefined) ?? {};
				const cat = (rest: string) => at(`columns.${c.name}.${rest}`);
				const columnOptions = optionWords(c.options, sc.options, cat);
				const cw: FormColumnWords = {
					label: { value: first(sc.label, c.label), field: cat('label') },
					placeholder: columnTakesPlaceholder(c) ? { value: first(sc.placeholder, c.placeholder, c.type === 'select' ? choose.value : ''), field: cat('placeholder') } : null,
					error: { value: first(sc.error, c.error, DEFAULT_COLUMN_ERRORS[c.type]), field: cat('error') },
					options: columnOptions,
				};
				if (c.type === 'select') cw.choices = choicesFrom(columnOptions, c, sources[`${f.name}.${c.name}`]);
				if (c.from) {
					const offered = sources[`${f.name}.${c.from.column}`] ?? [];
					cw.allowed = Object.fromEntries(offered.map((doc) => [doc.value, narrowedChoices(c, rowCell(doc.data, c.from!.field))]));
					cw.else = [...c.from.else];
				}
				columns[c.name] = cw;
			}
			words.columns = columns;
		}
		fields[f.name] = words;
	}
	const own = (key: string, value: string) => ({ value, field: wordPath(id, key) });
	return {
		form: id,
		label: form.label,
		fields,
		submit: own('submit', first(stored.submit, code.submit, PACKAGE_WORDS.submit)),
		sending: own('sending', first(stored.sending, code.sending, PACKAGE_WORDS.sending)),
		sent: {
			heading: own('sent.heading', first(stored.sent?.heading, code.sentHeading, PACKAGE_WORDS.sentHeading)),
			line: own('sent.line', first(stored.sent?.line, code.thanks, PACKAGE_WORDS.thanks)),
		},
		failed: own('failed', first(stored.failed, code.failed, PACKAGE_WORDS.failed)),
		choose,
	};
}

/**
 * The config's form with Site Settings' words in place (Decision 11): each field's label,
 * placeholder, help, error and option labels. The endpoint's sentences, the email and the inbox
 * read it; the site's code can't reach them, so its layer isn't here.
 */
export function formWithWords(form: ResolvedForm, stored: StoredFormWords): ResolvedForm {
	return {
		...form,
		fields: form.fields.map((f) => {
			const s = stored.fields?.[f.name];
			if (!s) return f;
			const out: ResolvedFormField = { ...f, label: first(s.label, f.label) };
			if (s.placeholder && takesPlaceholder(f.type)) out.placeholder = s.placeholder;
			if (s.help) out.help = s.help;
			if (s.error) out.error = s.error;
			if (f.options) out.options = f.options.map((o) => ({ value: o.value, label: optionHasWord(o.value) ? first(s.options?.[o.value], o.label) : o.label }));
			if (f.type === 'rows') {
				for (const key of ['rowLabel', 'add', 'remove', 'atMost'] as const) if (s[key]) out[key] = s[key];
				out.columns = (f.columns ?? []).map((c) => {
					const sc = s.columns && Object.hasOwn(s.columns, c.name) ? s.columns[c.name] : undefined;
					if (!sc) return c;
					const column: ResolvedFormColumn = { ...c, label: first(sc.label, c.label) };
					if (sc.placeholder && columnTakesPlaceholder(c)) column.placeholder = sc.placeholder;
					if (sc.error) column.error = sc.error;
					if (c.options) column.options = c.options.map((o) => ({ value: o.value, label: optionHasWord(o.value) ? first(sc.options?.[o.value], o.label) : o.label }));
					return column;
				});
			}
			return out;
		}),
	};
}
