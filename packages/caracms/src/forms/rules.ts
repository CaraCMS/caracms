/**
 * The forms config's rules (M6 Decision 4), and what the endpoint, the email, the
 * inbox and the public form share about a form: the honeypot's name, the hidden
 * fields, the upload limits, the sender's name and the snippet.
 *
 * The template is the rulebook (the Tina template's forms: the forms config, and Files:
 * the wire contract); this is its `form-rules.mjs` and the shared parts
 * of `form-field-types.mjs`, with caracms's shape: forms are `defineSite({ forms })`,
 * keyed by id, their fields keyed by name in the form's order.
 *
 * Browser-safe (no imports): the editor's inbox reads `senderName`, `formatBytes` and
 * the id pattern too.
 */

/** The field types (Decision 4, and form rows Decision 7's `rows`). The template's site-own types stay out (form rows Decision 1). */
export const FORM_FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'files', 'rows'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** A rows field's column types (form rows Decision 7). */
export const FORM_COLUMN_TYPES = ['select', 'number', 'text'] as const;
export type FormColumnType = (typeof FORM_COLUMN_TYPES)[number];

/** One fixed choice of a select. */
export interface FormChoice {
	value: string;
	label: string;
}

/**
 * Form rows Decision 2: a select's documents. Each document of `collection` (hidden and warned
 * ones never) is a choice after any fixed ones: its value its path, its words its title. With
 * `where`, only documents whose toggle of that name is on.
 */
export interface FormSource {
	collection: string;
	where?: string;
}

/**
 * Form rows Decision 6: a select column whose choices follow the document picked in another
 * column. `column` is a sourced select column of the same rows field; `field` is a list (of
 * select or of text) on that collection; `else` applies when the picked document's list names
 * none of the column's options (left out: every option).
 */
export interface FormNarrowing {
	column: string;
	field: string;
	else?: string[];
}

/** One column of a rows field, as the config writes it (form rows Decision 7). Every column is required within a row. */
export interface FormColumnConfig {
	label: string;
	/** Default `text`. */
	type?: FormColumnType;
	/** A select column's fixed choices. */
	options?: FormChoice[];
	/** A select column's documents (Decision 2). */
	source?: FormSource;
	/** A select column narrowed by another column's pick (Decision 6). Needs fixed `options` and no `source`. */
	from?: FormNarrowing;
	/** The words in the empty box (text, number), or a select's blank first choice. */
	placeholder?: string;
	/** The line under the cell when it's blank or wrong. */
	error?: string;
	/** A fixed lead-in in the box (text and number). */
	prefix?: string;
	/** A fixed, faint tail in the box (text and number). */
	suffix?: string;
}

/** One field of a form, as the site's config writes it (Contracts → The forms config). */
export interface FormFieldConfig {
	label: string;
	/** Default `text`. */
	type?: FormFieldType;
	/** Required unless this is set: blank and absent are then both fine (stored as `''`). */
	optional?: boolean;
	/** A select's fixed choices; the endpoint accepts only their values (and a `source`'s). Select only. */
	options?: FormChoice[];
	/** Form rows Decision 2: a select's documents, listed after its fixed `options`. Select only. */
	source?: FormSource;
	/** A line under the field. */
	help?: string;
	/** The browser's hint, and the inbox's sender name (`name`, or `given-name` + `family-name`). */
	autocomplete?: string;
	/** The line under the field when it's blank or wrong; blank uses the type's own wording. */
	error?: string;
	/**
	 * The input's hint text inside the box (`placeholder`): text, email, tel and textarea; on a
	 * select (form rows Decision 15), the words of its blank first choice. It never replaces the
	 * label, which stays in the markup for screen readers even when a site hides it. Plain text,
	 * trimmed; blank is the same as leaving it out.
	 */
	placeholder?: string;
	/**
	 * A short fixed text drawn before the input, like "$" on a price: text and tel only.
	 * Only for show: it isn't part of what's sent, stored, emailed or shown in the inbox.
	 * Plain text, trimmed; blank is the same as leaving it out.
	 */
	prefix?: string;
	/**
	 * Form rows Decision 15: a short fixed text drawn at the end of the box, faint, like "USD":
	 * text and tel only. Hidden from screen readers; config only, never a word.
	 */
	suffix?: string;
	/** A textarea's height in lines (`rows`), a whole number from 1 to 50. Default 6. Textarea only. */
	rows?: number;
	/** Form rows Decision 7: a rows field's columns by name, in order. Rows only. */
	columns?: Record<string, FormColumnConfig>;
	/** A rows field's most rows, 1 to 50. Default 10. Rows only. */
	max?: number;
	/** A rows field's row word, naming a row in the server's sentences ("Product 2: …"). Default "Row". Rows only. */
	rowLabel?: string;
	/** A rows field's add button. Default "Add another". Rows only. */
	add?: string;
	/** A rows field's remove button. Default "Remove". Rows only. */
	remove?: string;
	/** A rows field's line once it has `max` rows. Default "That’s the most this form takes." Rows only. */
	atMost?: string;
}

/** One form (Contracts → The forms config). Its key is its id: stored on submissions, keys `formRecipients`; never renamed once live. */
export interface FormConfig {
	/** "Contact": the inbox, the email, Site Settings. */
	label: string;
	/** The email's subject starts with this: `<subject> — <brand name> website`. */
	email: { subject: string };
	/** The fields by name, in the form's order. */
	fields: Record<string, FormFieldConfig>;
}

/** A narrowing as resolved: `else` always given (every option when the config has none). */
export interface ResolvedNarrowing {
	column: string;
	field: string;
	else: string[];
}

/** A rows field's column as the package uses it. */
export interface ResolvedFormColumn {
	name: string;
	label: string;
	type: FormColumnType;
	options?: FormChoice[];
	source?: FormSource;
	from?: ResolvedNarrowing;
	placeholder?: string;
	error?: string;
	prefix?: string;
	suffix?: string;
}

export interface ResolvedFormField {
	name: string;
	label: string;
	type: FormFieldType;
	optional: boolean;
	options?: FormChoice[];
	source?: FormSource;
	help?: string;
	autocomplete?: string;
	error?: string;
	placeholder?: string;
	prefix?: string;
	suffix?: string;
	rows?: number;
	/** A rows field's columns, in order. */
	columns?: ResolvedFormColumn[];
	/** A rows field's most rows (default 10). */
	max?: number;
	rowLabel?: string;
	add?: string;
	remove?: string;
	atMost?: string;
}

/** One stored row of a rows field: its cells by column name, every one text (form rows Decision 9). */
export type FormRow = Record<string, string>;
/** A stored field's value: text, or a rows field's list of rows (form rows Decision 9). */
export type FormFieldValue = string | FormRow[];

/** A form as the package uses it: its fields as a list, in order, each with its type. Plain JSON. */
export interface ResolvedForm {
	id: string;
	label: string;
	email: { subject: string };
	fields: ResolvedFormField[];
}

/**
 * The honeypot's name (Decision 5): a hidden field only a bot fills in. `fax`, not
 * `company`: a real form can have a Company field (the template's lesson). The form
 * component renders it from here and the endpoint reads it from here.
 */
export const HONEYPOT = 'fax';

/** The form's hidden fields: its id, the no-JS return page, and Turnstile's token. */
export const HIDDEN_FIELDS = ['form', 'return', 'cf-turnstile-response'] as const;

/** Names a form's field can't take. */
export const RESERVED_FIELD_NAMES: readonly string[] = [HONEYPOT, ...HIDDEN_FIELDS];

/** At most this many files on one submission. */
export const MAX_FILES = 5;
/** At most this many bytes of files in all, on one submission: 25 MB. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The extensions a files field takes, each with the declared types it may come with.
 * **The extension decides the type**: a declared type must be blank,
 * `application/octet-stream` or one listed here. The first is the type a download is
 * served as.
 */
export const FILE_TYPES: Readonly<Record<string, readonly string[]>> = {
	jpg: ['image/jpeg', 'image/pjpeg'],
	jpeg: ['image/jpeg', 'image/pjpeg'],
	png: ['image/png'],
	webp: ['image/webp'],
	heic: ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'],
	pdf: ['application/pdf'],
	doc: ['application/msword'],
	docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
	xls: ['application/vnd.ms-excel'],
	xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

/** The allowed kinds, as a visitor reads them (the endpoint's refusal names them). */
export const FILE_KINDS = 'JPEG, PNG, WebP, HEIC, PDF, Word or Excel';

/** The file input's `accept`. */
export const FILE_ACCEPT = Object.keys(FILE_TYPES)
	.map((ext) => `.${ext}`)
	.join(',');

/** The types that take a placeholder: the ones a visitor types into, and a select's blank first choice (form rows Decision 15). */
export const PLACEHOLDER_TYPES: readonly FormFieldType[] = ['text', 'email', 'tel', 'textarea', 'select'];
/** The types that take a prefix or a suffix: a one-line box where a fixed lead-in or tail reads naturally ("$", "+353", "USD"). */
const PREFIX_TYPES: readonly FormFieldType[] = ['text', 'tel'];

/** A rows field's most rows when the config gives none (form rows Decision 7). */
export const DEFAULT_MAX_ROWS = 10;
/** The most a rows field's `max` can be, and the cloud's cap on a list (form rows Decision 7, Contracts → The cloud). */
export const MAX_ROWS = 50;
/** The most columns a rows field can have (form rows Decision 7, the cloud's cap on a row's keys). */
export const MAX_COLUMNS = 20;

const FORM_ID = /^[a-z][a-z0-9-]*$/;
/** A field's name goes into the form's markup and the stored JSON: letters, digits, `_` and `-`. A column's name too (they're the stored keys). */
export const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * What checkForms needs to know of the site's collections, to check a `source` (form rows
 * Decisions 2 and 6): each collection's kind and its fields' kinds (a list's item kind too).
 */
export interface FormSourceCollections {
	readonly [name: string]: { kind: string; fields: Readonly<Record<string, { kind: string; item?: { kind: string } | null }>> | null };
}

/** The collections a select can list: a site's own, never Shared blocks or Site Settings. */
const SOURCE_KINDS = ['sections', 'fields'];

/** Check a `source` (form rows Decision 2). */
function checkSource(raw: unknown, at: string, collections: FormSourceCollections, fail: (message: string) => never): FormSource {
	const source = (raw ?? {}) as Partial<FormSource>;
	if (typeof source !== 'object' || Array.isArray(source) || typeof source.collection !== 'string' || !source.collection) fail(`${at}: source must be { collection: '<a collection of the site>' }, optionally with where: '<a toggle field>'.`);
	const collection = Object.hasOwn(collections, source.collection!) ? collections[source.collection!]! : null;
	if (!collection || !SOURCE_KINDS.includes(collection.kind)) fail(`${at}: source names the collection "${source.collection}", which the site doesn't have.`);
	if (source.where !== undefined) {
		const toggle = typeof source.where === 'string' && collection!.fields && Object.hasOwn(collection!.fields, source.where) ? collection!.fields[source.where]! : null;
		if (!toggle || toggle.kind !== 'toggle') fail(`${at}: source's where must name a toggle field of the collection "${source.collection}" (got ${JSON.stringify(source.where)}).`);
	}
	const extra = Object.keys(source).filter((k) => k !== 'collection' && k !== 'where');
	if (extra.length) fail(`${at}: source takes collection and where only (got ${extra.join(', ')}).`);
	return { collection: source.collection!, ...(source.where !== undefined ? { where: source.where } : {}) };
}

/** Check a select's fixed options (each a value and a label, no value twice). */
function checkOptions(options: unknown, at: string, fail: (message: string) => never): FormChoice[] {
	if (!Array.isArray(options)) fail(`${at}: options must be a list, like [{ value: 'branding', label: 'Branding' }].`);
	const values = new Set<string>();
	for (const option of options as Partial<FormChoice>[]) {
		if (typeof option?.value !== 'string' || !option.value || typeof option.label !== 'string' || !option.label) fail(`${at}: every option needs a value and a label.`);
		if (values.has(option.value!)) fail(`${at}: the option "${option.value}" is listed twice.`);
		values.add(option.value!);
	}
	return (options as FormChoice[]).map((o) => ({ value: o.value, label: o.label }));
}

/** A trimmed optional text setting; fails when it isn't text. */
function textSetting(value: unknown, at: string, key: string, fail: (message: string) => never): string {
	if (value !== undefined && typeof value !== 'string') fail(`${at}: ${key} must be text.`);
	return (value as string | undefined)?.trim() ?? '';
}

/** Check a rows field's columns (form rows Decisions 6 and 7). */
function checkColumns(raw: unknown, at: string, collections: FormSourceCollections, fail: (message: string) => never): ResolvedFormColumn[] {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) fail(`${at}: a rows field needs columns, an object of columns by name, like { product: { label: 'Product', type: 'select', options: [...] } }.`);
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length > MAX_COLUMNS) fail(`${at}: a rows field has at most ${MAX_COLUMNS} columns (this one has ${entries.length}).`);
	const columns: ResolvedFormColumn[] = [];
	const seen = new Set<string>();
	for (const [name, rawColumn] of entries) {
		const where = `${at}, column "${name}"`;
		if (!FIELD_NAME.test(name)) fail(`${where}: a column's name must start with a letter and hold only letters, digits, "_" and "-".`);
		if (seen.has(name.toLowerCase())) fail(`${where} is listed twice (column names are compared without case).`);
		seen.add(name.toLowerCase());
		const column = (rawColumn ?? {}) as Partial<FormColumnConfig>;
		if (typeof column !== 'object' || Array.isArray(column)) fail(`${where} must be an object: { label, type }.`);
		if (typeof column.label !== 'string' || !column.label.trim()) fail(`${where} needs a label (what the visitor sees).`);
		const type = column.type ?? 'text';
		if (!(FORM_COLUMN_TYPES as readonly string[]).includes(type)) fail(`${where}: a column's type must be one of ${FORM_COLUMN_TYPES.join(', ')} (got ${JSON.stringify(column.type)}).`);
		const placeholder = textSetting(column.placeholder, where, 'placeholder', fail);
		const error = textSetting(column.error, where, 'error', fail);
		const prefix = textSetting(column.prefix, where, 'prefix', fail);
		const suffix = textSetting(column.suffix, where, 'suffix', fail);
		if ((prefix || suffix) && type === 'select') fail(`${where}: a select column takes no ${prefix ? 'prefix' : 'suffix'} (only text and number columns do).`);
		let options: FormChoice[] | undefined;
		let source: FormSource | undefined;
		if (type === 'select') {
			if (column.options !== undefined) options = checkOptions(column.options, where, fail);
			if (column.source !== undefined) source = checkSource(column.source, where, collections, fail);
			if (!options?.length && !source) fail(`${where}: a select column needs options, a source, or both.`);
		} else {
			if (column.options !== undefined) fail(`${where}: only a select column takes options (this one is ${type}).`);
			if (column.source !== undefined) fail(`${where}: only a select takes a source (this column is ${type}).`);
		}
		if (column.from !== undefined && type !== 'select') fail(`${where}: only a select column can take its choices from another column (this one is ${type}).`);
		columns.push({
			name,
			label: column.label!.trim(),
			type,
			...(options?.length ? { options } : {}),
			...(source ? { source } : {}),
			...(placeholder ? { placeholder } : {}),
			...(error ? { error } : {}),
			...(prefix ? { prefix } : {}),
			...(suffix ? { suffix } : {}),
		});
	}
	// The narrowings, once every column is known (`from` may name a later column).
	for (const [name, rawColumn] of entries) {
		const from = (rawColumn as Partial<FormColumnConfig>).from as Partial<FormNarrowing> | undefined;
		if (from === undefined) continue;
		const where = `${at}, column "${name}"`;
		const column = columns.find((c) => c.name === name)!;
		if (!from || typeof from !== 'object' || Array.isArray(from) || typeof from.column !== 'string' || typeof from.field !== 'string') fail(`${where}: from must be { column, field }, optionally with else.`);
		if (column.source) fail(`${where}: a column that takes its choices from another can't have a source of its own.`);
		if (!column.options?.length) fail(`${where}: a column that takes its choices from another needs its fixed options (they hold the words).`);
		const picked = columns.find((c) => c.name === from!.column);
		if (!picked || picked.name === name || picked.type !== 'select' || !picked.source) fail(`${where}: from's column must be a select column of this rows field with a source (got ${JSON.stringify(from!.column)}).`);
		const collection = collections[picked!.source!.collection]!;
		const list = collection.fields && Object.hasOwn(collection.fields, from!.field!) ? collection.fields[from!.field!]! : null;
		if (!list) fail(`${where}: from's field "${from!.field}" isn't a field of the collection "${picked!.source!.collection}".`);
		if (list!.kind !== 'list' || !list!.item || (list!.item.kind !== 'select' && list!.item.kind !== 'text')) fail(`${where}: from's field "${from!.field}" must be a list of select or of text on "${picked!.source!.collection}".`);
		const values = column.options!.map((o) => o.value);
		let fallback = values;
		if (from!.else !== undefined) {
			if (!Array.isArray(from!.else) || from!.else.some((v) => typeof v !== 'string')) fail(`${where}: from's else must be a list of the column's option values.`);
			// Review fix 6: an empty else would refuse every row whose document names none ("… is one of: .").
			if (from!.else.length === 0) fail(`${where}: from's else can't be empty: leave it out to offer every option when the document names none, or list the ones to offer.`);
			const wrong = from!.else!.find((v) => !values.includes(v));
			if (wrong !== undefined) fail(`${where}: from's else names "${wrong}", which isn't one of the column's options.`);
			fallback = values.filter((v) => from!.else!.includes(v));
		}
		column.from = { column: from!.column!, field: from!.field!, else: fallback };
	}
	return columns;
}

/**
 * Check the site's forms (Decision 4: `forms.md` → The forms config's `checkForms()`
 * list) and resolve them. `fail` throws the sentence, which names the form and the
 * field. Refused: the honeypot's name or a hidden field's, a duplicate, no `email`
 * field, more than one `files` field, a select without options or a source, options on a
 * field that isn't a select, and a type that isn't one of the field types. `collections`
 * (the site's, resolved) checks a select's `source` and a column's `from` (form rows
 * Acceptance 5 and 14).
 */
export function checkForms(forms: unknown, fail: (message: string) => never, collections: FormSourceCollections = {}): Record<string, ResolvedForm> {
	if (forms === undefined) return {};
	if (!forms || typeof forms !== 'object' || Array.isArray(forms)) fail('forms must be an object of forms by id, like { contact: { label, email, fields } }.');
	const out: Record<string, ResolvedForm> = {};
	for (const [id, raw] of Object.entries(forms as Record<string, unknown>)) {
		const where = `form "${id}"`;
		if (!FORM_ID.test(id)) fail(`${where}: its id must be lowercase letters, digits and hyphens (it's stored on every submission).`);
		const form = (raw ?? {}) as Partial<FormConfig>;
		if (typeof form !== 'object' || Array.isArray(form)) fail(`${where} must be an object: { label, email: { subject }, fields }.`);
		if (typeof form.label !== 'string' || !form.label.trim()) fail(`${where} needs a label (the inbox, the email and Site Settings name it by it).`);
		if (typeof form.email?.subject !== 'string' || !form.email.subject.trim()) fail(`${where} needs email.subject, like "New contact enquiry".`);
		if (!form.fields || typeof form.fields !== 'object' || Array.isArray(form.fields)) fail(`${where} needs fields, an object of fields by name.`);
		const fields: ResolvedFormField[] = [];
		const seen = new Set<string>();
		let filesField: string | null = null;
		for (const [name, rawField] of Object.entries(form.fields!)) {
			const at = `${where}, field "${name}"`;
			if (RESERVED_FIELD_NAMES.includes(name)) {
				fail(`${at}: "${name}" is taken (${name === HONEYPOT ? 'the honeypot, a field only a bot fills in' : "one of the form's hidden fields"}); name the field something else.`);
			}
			if (!FIELD_NAME.test(name)) fail(`${at}: a field's name must start with a letter and hold only letters, digits, "_" and "-".`);
			// Object keys can't repeat, but two spellings of one name would post as one field.
			if (seen.has(name.toLowerCase())) fail(`${at} is listed twice (field names are compared without case).`);
			seen.add(name.toLowerCase());
			const field = (rawField ?? {}) as Partial<FormFieldConfig>;
			if (typeof field.label !== 'string' || !field.label.trim()) fail(`${at} needs a label (what the visitor sees).`);
			const type = field.type ?? 'text';
			if (!(FORM_FIELD_TYPES as readonly string[]).includes(type)) fail(`${at}: type must be one of ${FORM_FIELD_TYPES.join(', ')} (got ${JSON.stringify(field.type)}).`);
			let options: FormChoice[] | undefined;
			let source: FormSource | undefined;
			if (type === 'select') {
				if (field.options !== undefined) options = checkOptions(field.options, at, fail);
				if (field.source !== undefined) source = checkSource(field.source, at, collections, fail);
				if (!options?.length && !source) fail(`${at}: a select needs options, like [{ value: 'branding', label: 'Branding' }], a source, like { collection: 'jobs' }, or both.`);
			} else {
				if (field.options !== undefined) fail(`${at}: only a select takes options (this one is ${type}).`);
				if (field.source !== undefined) fail(`${at}: only a select takes a source (this one is ${type}).`);
			}
			let columns: ResolvedFormColumn[] | undefined;
			if (type === 'rows') {
				if (name === 'email') fail(`${at}: the "email" field is the visitor's address, so it can't be a rows field.`);
				columns = checkColumns(field.columns, at, collections, fail);
				if (field.max !== undefined && (!Number.isInteger(field.max) || field.max < 1 || field.max > MAX_ROWS)) fail(`${at}: max must be a whole number from 1 to ${MAX_ROWS} (got ${JSON.stringify(field.max)}).`);
			} else {
				for (const key of ['columns', 'max', 'rowLabel', 'add', 'remove', 'atMost'] as const) if (field[key] !== undefined) fail(`${at}: only a rows field takes ${key} (this one is ${type}).`);
			}
			if (type === 'files') {
				if (filesField) fail(`${at}: a form has at most one files field ("${filesField}" is the first).`);
				filesField = name;
			}
			if (field.optional !== undefined && typeof field.optional !== 'boolean') fail(`${at}: optional must be true or left out.`);
			for (const key of ['help', 'autocomplete', 'error', 'placeholder', 'prefix', 'suffix', 'rowLabel', 'add', 'remove', 'atMost'] as const) {
				if (field[key] !== undefined && typeof field[key] !== 'string') fail(`${at}: ${key} must be text.`);
			}
			const placeholder = field.placeholder?.trim() ?? '';
			if (placeholder && !PLACEHOLDER_TYPES.includes(type)) {
				fail(type === 'rows' ? `${at}: a rows field takes no placeholder of its own (its columns do).` : `${at}: a ${type} field has no box to type in, so it can't take a placeholder (only ${PLACEHOLDER_TYPES.join(', ')} can).`);
			}
			const prefix = field.prefix?.trim() ?? '';
			if (prefix && !PREFIX_TYPES.includes(type)) fail(`${at}: only a text or tel field takes a prefix (this one is ${type}).`);
			const suffix = field.suffix?.trim() ?? '';
			if (suffix && !PREFIX_TYPES.includes(type)) fail(`${at}: only a text or tel field takes a suffix (this one is ${type}).`);
			const rowWords = Object.fromEntries((['rowLabel', 'add', 'remove', 'atMost'] as const).map((k) => [k, field[k]?.trim() ?? '']).filter(([, v]) => v));
			if (field.rows !== undefined) {
				if (type !== 'textarea') fail(`${at}: only a textarea takes rows (this one is ${type}).`);
				if (!Number.isInteger(field.rows) || field.rows < 1 || field.rows > 50) fail(`${at}: rows must be a whole number from 1 to 50 (got ${JSON.stringify(field.rows)}).`);
			}
			fields.push({
				name,
				label: field.label!.trim(),
				type,
				optional: field.optional === true,
				...(options?.length ? { options } : {}),
				...(source ? { source } : {}),
				...(field.help ? { help: field.help } : {}),
				...(field.autocomplete ? { autocomplete: field.autocomplete } : {}),
				...(field.error ? { error: field.error } : {}),
				...(placeholder ? { placeholder } : {}),
				...(prefix ? { prefix } : {}),
				...(suffix ? { suffix } : {}),
				...(field.rows !== undefined ? { rows: field.rows } : {}),
				...(columns ? { columns, max: field.max ?? DEFAULT_MAX_ROWS, ...rowWords } : {}),
			});
		}
		const email = fields.find((f) => f.name === 'email');
		if (!email) fail(`${where} needs a field named "email", with type 'email': the visitor's address, which the email's Reply-To uses.`);
		if (email!.type !== 'email') fail(`${where}, field "email": its type must be 'email' (it's the visitor's address, the email's Reply-To).`);
		out[id] = { id, label: form.label!.trim(), email: { subject: form.email!.subject.trim() }, fields };
	}
	return out;
}

const RETURN_PATH = /^\/[a-z0-9/-]*$/;

/** The no-JS return page (Decision 5): a path on this site matching `^/[a-z0-9/-]*$` and not `//…`, else `/`. */
export function cleanReturn(value: string): string {
	return RETURN_PATH.test(value) && !value.startsWith('//') ? value : '/';
}

/** Whether any form takes files: the endpoint's upload cap is there only then (Decision 5). */
export const formsAcceptFiles = (forms: Readonly<Record<string, Pick<ResolvedForm, 'fields'>>>): boolean =>
	Object.values(forms).some((form) => form.fields.some((field) => field.type === 'files'));

// Deliberately loose: an over-strict pattern refuses real addresses. The real check is the reply.
export const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** A size as people read it: "812 bytes", "240 KB", "2.4 MB" (1 KB = 1024 bytes). */
export function formatBytes(bytes: number): string {
	const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
	if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
	if (Math.round(n / 1024) < 1024) return `${Math.round(n / 1024)} KB`;
	const mb = n / 1024 / 1024;
	return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The last part of a name, whatever slashes a browser or a bot sent: `../../x.pdf` → `x.pdf`. */
export const shownFileName = (name: string): string => name.split(/[\\/]/).pop() ?? '';

/**
 * A submission's id: the receive time with `:` and `.` swapped for `-`, then six
 * random base-36 characters (`2026-09-25T09-14-02-123Z_k3f9a2`), so ids sort in
 * received order. Every id from a URL is checked against this before it becomes a
 * key or a path (the path-traversal guard).
 */
export const SUBMISSION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-z0-9]{6}$/;
export const isSubmissionId = (id: unknown): id is string => typeof id === 'string' && SUBMISSION_ID.test(id);

/** A submission's address in the editor (the email's link). */
export const submissionAddress = (id: string): string => `/admin/submissions/${encodeURIComponent(id)}`;

/**
 * Who sent it (Decision 9, `forms.md` → The forms config): the field marked
 * `autocomplete: 'name'`, else the `given-name` and `family-name` fields together,
 * else the email address. A form no longer in the config: the address.
 */
export function senderName(form: Pick<ResolvedForm, 'fields'> | null, fields: Readonly<Record<string, unknown>>): string {
	const value = (name: string | undefined) => (name && typeof fields[name] === 'string' ? (fields[name] as string).trim() : '');
	const by = (hint: string) => form?.fields.find((f) => f.autocomplete === hint)?.name;
	const full = value(by('name'));
	if (full) return full;
	const both = [value(by('given-name')), value(by('family-name'))].filter(Boolean).join(' ');
	if (both) return both;
	return value('email');
}

/** A row's one-line snippet (Decision 9): the form's first `textarea`, its lines joined, cut at 140 characters. '' when there's none. */
export function submissionSnippet(form: Pick<ResolvedForm, 'fields'> | null, fields: Readonly<Record<string, unknown>>): string {
	const name = form?.fields.find((f) => f.type === 'textarea')?.name;
	const text = name && typeof fields[name] === 'string' ? (fields[name] as string).replace(/\s+/g, ' ').trim() : '';
	return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
}

/**
 * Form rows (Contracts → The wire): one cell of a rows field as a form posts it,
 * `<name>[<index>][<column>]`, index 0–9999. The match is the field's name, the index and the column.
 */
export const ROW_CELL = /^([A-Za-z][A-Za-z0-9_-]*)\[(\d{1,4})\]\[([A-Za-z][A-Za-z0-9_-]*)\]$/;

/** A cell's name on the wire: `orderLines[0][product]`. */
export const rowCellName = (field: string, index: number, column: string): string => `${field}[${index}][${column}]`;

/** A number cell's text (form rows Decision 7): digits with an optional decimal part (`2`, `2.5`, `.5`), above 0. */
export const isRowNumber = (value: string): boolean => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) && Number(value) > 0;

/**
 * Form rows Decision 8: a row is blank when every column a visitor types or picks from scratch is
 * empty. A narrowed column doesn't count: its select always posts something.
 */
export function isBlankRow(field: Pick<ResolvedFormField, 'columns'>, row: Readonly<Record<string, string>>): boolean {
	return (field.columns ?? []).every((c) => {
		const value = rowCell(row, c.name);
		return !!c.from || !(typeof value === 'string' ? value : '').trim();
	});
}

/**
 * A row's cell by its column's name, only when the row holds it itself: a column may be called
 * `constructor` or `toString`, which a plain object would otherwise answer from its prototype
 * (as top-level fields are read with `Object.hasOwn`).
 */
export function rowCell(row: unknown, name: string): unknown {
	return row && typeof row === 'object' && !Array.isArray(row) && Object.hasOwn(row, name) ? (row as Record<string, unknown>)[name] : undefined;
}

/**
 * Form rows Decision 6: the option values a narrowed column allows for a picked document, from its
 * list field's value. A listed value that isn't one of the column's options is ignored; when none
 * is left (or the list is empty or missing), the column's `else`.
 */
export function narrowedChoices(column: Pick<ResolvedFormColumn, 'options' | 'from'>, listed: unknown): string[] {
	const values = (column.options ?? []).map((o) => o.value);
	const named = Array.isArray(listed) ? listed.filter((v): v is string => typeof v === 'string') : [];
	const allowed = values.filter((v) => named.includes(v));
	return allowed.length ? allowed : (column.from?.else ?? values);
}

/**
 * Form rows Decision 2: a select's choices in order, its fixed options first, then the documents
 * offered (each `{ value: path, label: title }`); a document whose path equals a fixed value is
 * the fixed one, listed once.
 */
export function selectChoices(select: { options?: readonly FormChoice[] }, offered: readonly FormChoice[] = []): FormChoice[] {
	const fixed = (select.options ?? []).map((o) => ({ value: o.value, label: o.label }));
	return [...fixed, ...offered.filter((d) => !fixed.some((o) => o.value === d.value)).map((d) => ({ value: d.value, label: d.label }))];
}

/** Sourced values' titles, by collection then path (form rows Decision 5): what the email and the inbox show for a stored document path. */
export type SourceTitles = Record<string, Record<string, string>>;

/**
 * A stored select value as people read it: a fixed option's label; else, for a select with a
 * `source`, the document's title (Decision 5, looked up when the email or the inbox is written);
 * else the value as stored.
 */
export function shownChoice(select: { options?: readonly FormChoice[]; source?: FormSource }, value: string, titles: SourceTitles = {}): string {
	const fixed = select.options?.find((o) => o.value === value);
	if (fixed) return fixed.label;
	const byPath = select.source && Object.hasOwn(titles, select.source.collection) ? titles[select.source.collection]! : undefined;
	const title = byPath && Object.hasOwn(byPath, value) ? byPath[value] : undefined;
	return title ?? value;
}

/**
 * Form rows Decision 11: a rows value as lines, one per row: the first column's shown value, a
 * dash, then the rest in column order ("Paint — 2.5 L"); where a value follows a number and starts
 * with a digit itself, a "×" between ("Primer — 4 × 5L Tin"). A select cell shows as its option's
 * label or its document's title. Only the columns the form declares; a blank cell is left out.
 */
export function rowsLines(field: Pick<ResolvedFormField, 'columns'>, rows: unknown, titles: SourceTitles = {}): string[] {
	if (!Array.isArray(rows)) return [];
	const columns = field.columns ?? [];
	return rows.map((raw) => {
		const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
		const cells = columns
			.map((c) => {
				const cell = rowCell(row, c.name);
				const value = typeof cell === 'string' ? cell.trim() : cell === undefined || cell === null ? '' : String(cell);
				return { type: c.type, shown: value && c.type === 'select' ? shownChoice(c, value, titles) : value };
			})
			.filter((c) => c.shown);
		const [head, ...rest] = cells;
		if (!head) return '';
		let tail = '';
		rest.forEach((cell, i) => {
			const before = i === 0 ? null : rest[i - 1]!;
			tail += i === 0 ? cell.shown : `${before?.type === 'number' && /^\d/.test(cell.shown) ? ' × ' : ' '}${cell.shown}`;
		});
		return tail ? `${head.shown} — ${tail}` : head.shown;
	}).filter(Boolean);
}

/**
 * Form rows Decision 11: a stored list the form doesn't declare as rows, never `[object Object]`:
 * one line per row, each cell as `column: value`.
 */
export function plainRowLines(value: readonly unknown[]): string[] {
	return value.map((row) =>
		row && typeof row === 'object' && !Array.isArray(row)
			? Object.entries(row as Record<string, unknown>)
					.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
					.join(', ')
			: typeof row === 'string' ? row : JSON.stringify(row),
	);
}

/** One document a sourced select offers (form rows Decision 2): its path, its title and its fields as rendered. */
export interface OfferedDocument extends FormChoice {
	data: Record<string, unknown>;
}

/**
 * The documents each sourced select of a form offers, as the deployed content has them: keyed by
 * the field's name, or `<field>.<column>` for a rows field's column. Read on the server
 * (forms/sources.ts); everything that checks or lists a sourced select's choices takes it.
 */
export type FormSources = Record<string, OfferedDocument[]>;
