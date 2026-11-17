/**
 * The field helpers a block's schema is built from (Decision 12; Spec → Fields).
 *
 * A field is a plain descriptor, not a validator: JSON-serialisable data the
 * integration hands to the site's routes and the editor (which reads `kind`,
 * `label`, `options` to draw the field), plus the parse and write rules below.
 *
 *   text()                     one line
 *   text({ multiline: true })  several lines; a break is stored as `\n` (the line-break rule)
 *   text({ lines: true })      several lines, each drawn as its own element (M9 Decision 10)
 *   text({ max: 200 })         M6: a soft limit, counted in the editor and amber past it (nothing refused)
 *   lockup({ style })          display text set as lines, optionally with phone lines (Decisions 10–11)
 *   select({ options })        one of a fixed list
 *
 * M5a (Decision 2) adds:
 *
 *   richText({ headings?, links? })  `[{ "p": "…" }, { "ul": ["…"] }]` (rich-text.ts, Decision 3)
 *   link()                           `{ "label", "href" }` (links.ts, Decision 4)
 *   buttons({ styles, max? })        `[{ "label", "href", "style" }]`; a button shows only when whole
 *   toggle()                         `true` / `false`
 *   number({ min?, max?, step? })    a JSON number, or `null` when cleared
 *   date()                           `"2026-10-15"`, or `null`
 *   list(field | fields)             `["…"]` for one field, `[{ … }]` for several (Decision 5)
 *   reference({ to })                the path of a document in collection `to` (Decision 6)
 *
 * M5b (Decision 3) adds:
 *
 *   media({ only?, play?, format?, altFrom? }) an image `{ key, alt, … }` or a Mux clip `{ video, play, … }` (media-value.ts)
 *
 * M6c adds `help` (G8: plain text under the field in the sidebar) to every helper, and
 * `link({ addressOnly: true })` (G9): `{ "href" }`, a link with no words of its own.
 *
 * The editor-friction batch adds:
 *
 *   group({ … }, { label?, help? })  named fields kept together, stored as one object
 *                                    `{ "heading": "…", "text": [ … ] }`; one section in the sidebar
 *   buttons({ …, allowNoLink })      a button with words and no link is a plain label ("Coming soon"), not half a button
 *
 * Every value has three layers (Core framing): the descriptor here, the value the
 * file stores and the editor holds (parseField / fieldToJson), and the render's
 * value (renderValue: what a block component gets). A value that breaks a field's
 * rule is kept as typed and flagged (fieldWarnings), and the render gets `null` or
 * text for it (Decision 15).
 *
 * Parsing normalises (text is trimmed, a lockup's blank lines are dropped, an
 * unknown select value falls back to the default). That's why the serializer never
 * writes a parsed value back unless the editor changed it (Decision 7).
 */
import { fileAddress, fileKeyOf, fileTypeOf, isFileKey } from './files.ts';
import { codeRouteAt, type CodeRoute } from './code-routes.ts';
import { hiddenLinkTarget, hiddenReferenceTarget, internalLinkPath, isLinkHref, missingLinkTarget, validateLink } from './links.ts';
import { MISSING_ALT_MESSAGE, mediaKind, mediaToJson, parseMedia, renderMedia, type MediaOnly, type MediaValue, type RenderMedia } from './media-value.ts';
import { readRichText, richTextHrefs, serializeRichText, type HeadingKind, type RichTextOptions, type RichTextValue } from './rich-text.ts';

export type { RichTextValue } from './rich-text.ts';
export type { ClipValue, ImageValue, MediaOnly, MediaValue, PlayAs, RenderClip, RenderImage, RenderMedia } from './media-value.ts';

interface FieldBase {
	/** Shown in the editor. Defaults to the field's key, title-cased. */
	label?: string;
	/**
	 * M6c (G8): plain text under the field's label in the editor's sidebar (an item
	 * field's under its sub-label), saying what it's for or what it does where the
	 * preview can't show it. Never on the page.
	 */
	help?: string;
}

/** Every helper's own `help` (G8), set on the descriptor only when given, so a field without one is as before. */
const withHelp = <F extends FieldBase>(field: F, options: { help?: string }): F => (options.help !== undefined ? { ...field, help: options.help } : field);

export interface TextField extends FieldBase {
	kind: 'text';
	multiline: boolean;
	/**
	 * This field is the block's heading, so it can hold the page's `h1` (Decision 16).
	 * Lockups are headings by default; a text field only when it says so.
	 */
	heading: boolean;
	/**
	 * M6: a soft limit (the Form block's intro, Decision 17): the editor counts the
	 * characters and turns amber past it. Nothing is refused: it's kept as written.
	 */
	max?: number;	/**
	 * M9 Decision 10: the lines rendering. Each typed line draws as its own element (Text's
	 * `lineClass`), blank lines draw nothing, and a single line draws unwrapped. Always
	 * multiline: a break is still stored as `\n`.
	 */
	lines?: true;
}

export interface LockupField extends FieldBase {
	kind: 'lockup';
	/** The text style's name in the site's config. */
	style: string;
	heading: boolean;
}

export interface SelectOption<V extends string = string> {
	value: V;
	label: string;
}

export interface SelectField<V extends string = string> extends FieldBase {
	kind: 'select';
	options: readonly SelectOption<V>[];
	/** Used when the file has no value or one the options don't know. Defaults to the first option. */
	default: V;
}

export interface RichTextField extends FieldBase {
	kind: 'richText';
	/** The heading kinds allowed: `[]` (default), `['h2']` or `['h2', 'h3']`. */
	headings: readonly HeadingKind[];
	/** Links allowed (default true). */
	links: boolean;
	/**
	 * M9 Decision 11: the block's heading, typed on the page with bold and line breaks only.
	 * It can hold the page's `h1` (M3 Decision 16) and draws inside its heading tag, its
	 * paragraphs as lines joined by `<br>`. No headings, no links, no lists, no italic.
	 */
	heading?: true;
}

export interface LinkField extends FieldBase {
	kind: 'link';
	/**
	 * M6c (G9): a link that's only an address (an image's link, a website, a social
	 * profile): stored as `{ "href" }`, no words of its own. Its render value is
	 * `{ href }`, or null when it's empty or fails the link rule. Set only when true.
	 */
	addressOnly?: true;
}

/** `link({ addressOnly: true })` (G9). */
export interface AddressLinkField extends LinkField {
	addressOnly: true;
}

/** An address-only link's value (G9): where it goes, no label. */
export interface AddressValue {
	href: string;
}

export interface ButtonsField<S extends string = string> extends FieldBase {
	kind: 'buttons';
	/** The site's button styles; a new button starts on the first. */
	styles: readonly SelectOption<S>[];
	/** At most this many show (default 2); more is kept, with a warning. */
	max: number;
	/**
	 * A button with words and no link is meant ("Coming soon"): it isn't warned, and
	 * `<Buttons>` draws it as a plain label with the button's classes. Set only when true.
	 */
	allowNoLink?: true;
}

export interface ToggleField extends FieldBase {
	kind: 'toggle';
	/** The value when the file has none (default false). */
	default: boolean;
}

export interface NumberField extends FieldBase {
	kind: 'number';
	min?: number;
	max?: number;
	step?: number;
}

export interface DateField extends FieldBase {
	kind: 'date';
}

/**
 * A list (Decision 5): of one field (`list(text())`, stored as a flat array), or
 * of several (`list({ role: text(), name: text() })`, stored as objects with keys
 * in schema order). Exactly one of `item` and `fields` is set. One level of list inside a
 * list (M7 Decision 14): a list of several fields may have a list among its item fields
 * (`list({ label: text(), links: list(link()) })`), and that inner list can't hold a list,
 * directly or through a group. A list of one field can't be a list.
 */
export interface ListField<I extends Field | Fields = Field | Fields> extends FieldBase {
	kind: 'list';
	item: I extends Field ? I : null;
	fields: I extends Fields ? I : null;
	/** The item field whose value labels a collapsed row. Default: the first text field (or the item itself). */
	itemLabel?: string;
	/**
	 * What one row is called, for Add and the row summaries ("Add person", "Removed person: …").
	 * Default: the list's label made singular ("People" would say "people"; "Credits", "credit").
	 */
	itemNoun?: string;
	/** M5b Decision 10: fewer items than this is warned (amber), never blocked. */
	min?: number;
	/** M5b Decision 10: more items than this is warned; Add stays on. */
	max?: number;
}

/**
 * A group: named fields kept together (`group({ heading: text(), button: buttons(…) })`),
 * stored as one object with its keys in schema order, and drawn as one section of the
 * sidebar that opens and closes. It holds any field but another group, and a list can't
 * be of a group alone (a list of several fields is that already).
 */
export interface GroupField<F extends Fields = Fields> extends FieldBase {
	kind: 'group';
	fields: F;
}

export interface ReferenceField extends FieldBase {
	kind: 'reference';
	/** The collection the referenced document is in. */
	to: string;
}

/**
 * A media slot (M5b Decision 3): an image or a Mux clip. `only` limits it to one
 * kind (a value of the other is kept and warned); `play: 'loop'` makes it loop-only
 * (the hero): any clip in it renders as a loop. `format: 'png'` serves its images as
 * PNG instead of WebP (M9 Decision 8: WebP smears flat artwork). `altFrom` names a text
 * field beside it (same block, group or list row): an image placed with no alt text starts
 * with that field's words as its alt.
 */
export interface MediaField extends FieldBase {
	kind: 'media';
	only?: MediaOnly;
	play?: 'loop';
	format?: ImageFormat;
	altFrom?: string;
}

/** The format a resized image is served in (M9 Decision 8). WebP unless a media field asks for PNG. */
export type ImageFormat = 'webp' | 'png';

export type Field =
	| TextField
	| LockupField
	| SelectField
	| RichTextField
	| LinkField
	| ButtonsField
	| ToggleField
	| NumberField
	| DateField
	| ListField
	| GroupField
	| ReferenceField
	| MediaField;
export type Fields = Record<string, Field>;

/** Every field kind the package knows. */
export const FIELD_KINDS = ['text', 'lockup', 'select', 'richText', 'link', 'buttons', 'toggle', 'number', 'date', 'list', 'group', 'reference', 'media'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * A lockup's value. `phone: null` means "no phone lines": the main lines show at
 * every width, and the file holds the plain list (Decision 10).
 */
export interface LockupValue {
	lines: string[];
	phone: string[] | null;
}

/** A link's value. `href` is kept as typed, even when it fails the link rule (Decision 15). */
export interface LinkValue {
	label: string;
	href: string;
}

export interface ButtonValue<S extends string = string> {
	label: string;
	href: string;
	style: S;
}

export type FieldValue<F extends Field> = F extends TextField
	? string
	: F extends LockupField
		? LockupValue
		: F extends SelectField<infer V>
			? V
			: F extends RichTextField
				? RichTextValue
				: F extends LinkField
					? F extends { addressOnly: true }
						? AddressValue | null
						: LinkValue
					: F extends ButtonsField<infer S>
						? ButtonValue<S>[]
						: F extends ToggleField
							? boolean
							: F extends NumberField
								? number | null
								: F extends DateField
									? string | null
									: F extends ReferenceField
										? string | null
										: F extends MediaField
											? RenderMedia | null
										: F extends ListField<infer I>
											? I extends Field
												? FieldValue<I>[]
												: I extends Fields
													? { [K in keyof I]: FieldValue<I[K]> }[]
													: unknown[]
											: F extends GroupField<infer G>
												? { [K in keyof G]: FieldValue<G[K]> }
												: never;

/** A block's parsed data, typed from its fields: `BlockData<typeof hero.fields>`. */
export type BlockData<F extends Fields> = { [K in keyof F]: FieldValue<F[K]> };

// ── Helpers ───────────────────────────────────────────────────────────────────

export function text(options: { label?: string; help?: string; multiline?: boolean; heading?: boolean; max?: number; lines?: boolean } = {}): TextField {
	const field: TextField = { kind: 'text', label: options.label, multiline: options.multiline ?? options.lines ?? false, heading: options.heading ?? false };
	if (options.max !== undefined) field.max = options.max;
	if (options.lines) field.lines = true;
	return withHelp(field, options);
}

export function lockup(options: { style: string; label?: string; help?: string; heading?: boolean }): LockupField {
	return withHelp({ kind: 'lockup', style: options.style, label: options.label, heading: options.heading ?? true }, options);
}

const toOptions = <V extends string>(options: readonly (V | SelectOption<V>)[]): SelectOption<V>[] =>
	options.map((o) => (typeof o === 'string' ? { value: o, label: titleCase(o) } : o));

export function select<const V extends string>(options: {
	options: readonly (V | SelectOption<V>)[];
	default?: NoInfer<V>;
	label?: string;
	help?: string;
}): SelectField<V> {
	const list = toOptions(options.options);
	if (list.length === 0) throw new Error('select(): needs at least one option');
	const fallback = options.default ?? list[0]!.value;
	if (!list.some((o) => o.value === fallback)) {
		throw new Error(`select(): the default "${fallback}" isn't one of its options`);
	}
	return withHelp({ kind: 'select', label: options.label, options: list, default: fallback }, options);
}

/**
 * Rich text (Decision 3). `headings`: `['h2']` or `['h2', 'h3']`, off by default. `links`: on by default.
 * `heading: true` (M9 Decision 11): the block's heading, bold and line breaks only (links off).
 */
export function richText(options: { label?: string; help?: string; headings?: readonly HeadingKind[]; links?: boolean; heading?: boolean } = {}): RichTextField {
	const field: RichTextField = { kind: 'richText', label: options.label, headings: [...(options.headings ?? [])], links: options.links ?? !options.heading };
	if (options.heading) field.heading = true;
	return withHelp(field, options);
}

/**
 * A link: `{ "label", "href" }` (Decision 4). `addressOnly: true` (M6c G9): only where
 * it goes, `{ "href" }`, for a link whose words are the site's (an image, an icon).
 */
export function link(options: { label?: string; help?: string; addressOnly: true }): AddressLinkField;
export function link(options?: { label?: string; help?: string; addressOnly?: false }): LinkField;
export function link(options: { label?: string; help?: string; addressOnly?: boolean } = {}): LinkField {
	const field: LinkField = { kind: 'link', label: options.label };
	if (options.addressOnly) field.addressOnly = true;
	return withHelp(field, options);
}

/**
 * The template's one button shape: `[{ "label", "href", "style" }]`, at most `max` (default 2).
 * `allowNoLink: true`: a button with words and no link is drawn as a plain label, never warned.
 */
export function buttons<const S extends string>(options: { styles: readonly (S | SelectOption<S>)[]; max?: number; label?: string; help?: string; allowNoLink?: boolean }): ButtonsField<S> {
	const styles = toOptions(options.styles);
	if (styles.length === 0) throw new Error('buttons(): needs at least one style');
	const field: ButtonsField<S> = { kind: 'buttons', label: options.label, styles, max: options.max ?? 2 };
	if (options.allowNoLink) field.allowNoLink = true;
	return withHelp(field, options);
}

export function toggle(options: { label?: string; help?: string; default?: boolean } = {}): ToggleField {
	return withHelp({ kind: 'toggle', label: options.label, default: options.default ?? false }, options);
}

export function number(options: { label?: string; help?: string; min?: number; max?: number; step?: number } = {}): NumberField {
	const field: NumberField = { kind: 'number', label: options.label };
	if (options.min !== undefined) field.min = options.min;
	if (options.max !== undefined) field.max = options.max;
	if (options.step !== undefined) field.step = options.step;
	return withHelp(field, options);
}

/** A day, `"2026-10-15"`: no time, no zone. */
export function date(options: { label?: string; help?: string } = {}): DateField {
	return withHelp({ kind: 'date', label: options.label }, options);
}

const isField = (value: unknown): value is Field =>
	!!value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string';

/**
 * A list (Decision 5): `list(text())` stores `["…"]`; `list({ role: text(), name: text() })`
 * stores `[{ "role": "…", "name": "…" }]`. `itemLabel` names the item field that labels
 * a collapsed row; `itemNoun` names one row (`list(…, { label: 'People', itemNoun: 'person' })`:
 * "Add person"), where the label made singular wouldn't do.
 */
export function list<const I extends Field | Fields>(of: I, options: { label?: string; help?: string; itemLabel?: string; itemNoun?: string; min?: number; max?: number } = {}): ListField<I> {
	const single = isField(of);
	return withHelp({
		kind: 'list',
		label: options.label,
		item: (single ? of : null) as ListField<I>['item'],
		fields: (single ? null : of) as ListField<I>['fields'],
		...(options.itemLabel !== undefined ? { itemLabel: options.itemLabel } : {}),
		...(options.itemNoun !== undefined ? { itemNoun: options.itemNoun } : {}),
		...(options.min !== undefined ? { min: options.min } : {}),
		...(options.max !== undefined ? { max: options.max } : {}),
	}, options);
}

/**
 * A group: `group({ heading: text(), button: buttons(…) }, { label: 'Left' })` stores
 * `{ "heading": "…", "button": [ … ] }`. Any field can be in one but another group:
 * that's refused here, when the schema is built.
 */
export function group<const F extends Fields>(fields: F, options: { label?: string; help?: string } = {}): GroupField<F> {
	for (const [key, f] of Object.entries(fields ?? {})) {
		if (isField(f) && f.kind === 'group') {
			throw new Error(`group(): "${key}" is a group, and a group can't hold another group. Put its fields in this group, or make it a group of its own beside this one.`);
		}
	}
	return withHelp({ kind: 'group', label: options.label, fields }, options);
}

/**
 * An image or a clip (M5b Decision 3). `only: 'image'` or `'video'` takes one kind;
 * `play: 'loop'` makes the slot loop-only (a clip in it always plays as a loop);
 * `format: 'png'` serves its images as PNG (M9 Decision 8); `altFrom: 'capture'` starts an
 * image's empty alt text with the sibling text field `capture`'s words when it's placed.
 */
export function media(options: { label?: string; help?: string; only?: MediaOnly; play?: 'loop'; format?: ImageFormat; altFrom?: string } = {}): MediaField {
	const field: MediaField = { kind: 'media', label: options.label };
	if (options.only !== undefined) field.only = options.only;
	if (options.play !== undefined) field.play = options.play;
	if (options.format !== undefined) field.format = options.format;
	if (options.altFrom !== undefined) field.altFrom = options.altFrom;
	return withHelp(field, options);
}

/** A reference to a document in collection `to`, stored as its path (Decision 6). */
export function reference(options: { to: string; label?: string; help?: string }): ReferenceField {
	return withHelp({ kind: 'reference', label: options.label, to: options.to }, options);
}

/** `case-studies` → "Case studies"; `heading` → "Heading". */
export function titleCase(key: string): string {
	const words = key.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

// ── Parse and write ───────────────────────────────────────────────────────────

/** Lines as a lockup renders them: trimmed, blank lines dropped. Non-strings dropped too. */
export function normaliseLines(lines: unknown): string[] {
	if (!Array.isArray(lines)) return [];
	return lines
		.filter((l): l is string => typeof l === 'string')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `"2026-10-15"` when the value is a real day in that form, else null. */
export function parseDay(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const m = DAY.exec(value.trim());
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const at = new Date(Date.UTC(y, mo - 1, d));
	return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d ? m[0]! : null;
}

export const richTextOptions = (field: RichTextField): RichTextOptions => ({ headings: field.headings, links: field.links, ...(field.heading ? { heading: true } : {}) });

function parseButton(field: ButtonsField, raw: Record<string, unknown>): ButtonValue {
	const style = typeof raw.style === 'string' && field.styles.some((o) => o.value === raw.style) ? raw.style : field.styles[0]!.value;
	return { label: str(raw.label), href: str(raw.href), style };
}

function parseItem(fields: Fields, raw: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(fields)) out[key] = parseField(field, Object.hasOwn(raw, key) ? raw[key] : undefined);
	return out;
}

/** A list item's keys outside the schema, as read (M7: kept on save, after the schema's keys, as a block's are). */
function unknownKeys(fields: Fields, raw: Record<string, unknown>): [string, unknown][] {
	return Object.entries(raw).filter(([key]) => !Object.hasOwn(fields, key) && key !== '__proto__');
}

/** A list item of several fields: its fields parsed, then its unknown keys as read. */
function parseListItem(fields: Fields, raw: Record<string, unknown>): Record<string, unknown> {
	const out = parseItem(fields, raw);
	for (const [key, value] of unknownKeys(fields, raw)) out[key] = value;
	return out;
}

/**
 * A raw value from the file (or `undefined` when the key is missing) as the field's
 * parsed value. Never throws: a value of the wrong shape parses as empty, and is
 * left alone in the file unless the editor changes it. Takes its own parsed value
 * as readily as the file's forms (the editor sends parsed values back).
 *
 * A value that breaks the field's rule (a number out of range, a link failing the
 * link rule) is kept as typed here; renderValue is what drops it (Decision 15).
 */
export function parseField(field: Field, raw: unknown): FieldValue<Field> {
	switch (field.kind) {
		case 'text':
			return typeof raw === 'string' ? raw.trim() : '';
		case 'lockup': {
			// Decision 10: `["…"]`, or `{ "lines": ["…"], "phone": ["…"] }` once it has phone lines.
			if (Array.isArray(raw)) return { lines: normaliseLines(raw), phone: null };
			if (raw && typeof raw === 'object') {
				const o = raw as Record<string, unknown>;
				const phone = normaliseLines(o.phone);
				return { lines: normaliseLines(o.lines), phone: phone.length > 0 ? phone : null };
			}
			return { lines: [], phone: null };
		}
		case 'select':
			return typeof raw === 'string' && field.options.some((o) => o.value === raw) ? raw : field.default;
		case 'richText':
			return readRichText(raw, richTextOptions(field)).value;
		case 'link':
			// G9: an address-only link holds just where it goes.
			if (field.addressOnly) return (isObject(raw) ? { href: str(raw.href) } : { href: '' }) as unknown as FieldValue<Field>;
			return isObject(raw) ? { label: str(raw.label), href: str(raw.href) } : { label: '', href: '' };
		case 'buttons':
			return Array.isArray(raw) ? raw.filter(isObject).map((b) => parseButton(field, b)) : [];
		case 'toggle':
			return typeof raw === 'boolean' ? raw : field.default;
		case 'number':
			return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
		case 'date':
			return parseDay(raw);
		case 'reference':
			return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
		case 'media':
			// The parsed value is the stored shape (media-value.ts); the render's value is renderValue's.
			return parseMedia(raw) as unknown as FieldValue<Field>;
		case 'list': {
			if (!Array.isArray(raw)) return [];
			if (field.item) {
				const item = field.item;
				return raw.map((v) => parseField(item, v)) as FieldValue<Field>;
			}
			const fields = field.fields ?? {};
			// M7: an item's unknown keys are kept, unmarked, as a block's are (Acceptance 10).
			return raw.filter(isObject).map((v) => parseListItem(fields, v)) as FieldValue<Field>;
		}
		case 'group':
			// Missing or not an object: every field at its own empty value.
			return parseItem(field.fields, isObject(raw) ? raw : {}) as FieldValue<Field>;
	}
}

/**
 * A field's value in the form the file stores it (Decision 7: "only a touched
 * field takes the schema's form"). A lockup without phone lines is the plain list;
 * rich text is written strictly (rich-text.ts); a list item's keys go in schema order,
 * its unknown keys after them (M7).
 */
export function fieldToJson(field: Field, value: unknown): unknown {
	// parseField takes the editor's values as readily as the file's forms.
	const parsed = parseField(field, value);
	switch (field.kind) {
		case 'lockup': {
			const v = parsed as LockupValue;
			return v.phone ? { lines: v.lines, phone: v.phone } : v.lines;
		}
		case 'richText':
			return serializeRichText(parsed, richTextOptions(field));
		case 'link': {
			const v = parsed as LinkValue;
			return field.addressOnly ? { href: v.href } : { label: v.label, href: v.href };
		}
		case 'buttons':
			return (parsed as ButtonValue[]).map((b) => ({ label: b.label, href: b.href, style: b.style }));
		case 'media':
			return mediaToJson(parsed);
		case 'list': {
			const items = parsed as unknown[];
			if (field.item) {
				const item = field.item;
				return items.map((v) => fieldToJson(item, v));
			}
			const fields = field.fields ?? {};
			// Schema keys in schema order, then the item's unknown keys as read (M7).
			return items.map((v) => {
				const o = v as Record<string, unknown>;
				return Object.fromEntries([...Object.entries(fields).map(([key, f]) => [key, fieldToJson(f, o[key])]), ...unknownKeys(fields, o)]);
			});
		}
		case 'group': {
			const v = parsed as Record<string, unknown>;
			return Object.fromEntries(Object.entries(field.fields).map(([key, f]) => [key, fieldToJson(f, v[key])]));
		}
		default:
			return parsed;
	}
}

/** Is this field's parsed value empty (for "the first block with a non-empty heading")? */
export function isEmptyValue(field: Field, value: unknown): boolean {
	switch (field.kind) {
		case 'lockup': {
			const v = value as LockupValue | undefined;
			return !v || v.lines.length === 0;
		}
		case 'text':
		case 'select':
			return typeof value !== 'string' || value.trim().length === 0;
		case 'richText':
		case 'buttons':
		case 'list':
			return !Array.isArray(value) || value.length === 0;
		case 'link': {
			const v = value as LinkValue | undefined;
			return !v || (!v.label && !v.href);
		}
		case 'toggle':
			return typeof value !== 'boolean';
		case 'group': {
			// Empty when every field in it is (a toggle or a select at its default counts as set).
			const v = isObject(value) ? value : {};
			return Object.entries(field.fields).every(([key, f]) => isEmptyValue(f, v[key]));
		}
		default:
			return value === null || value === undefined || value === '';
	}
}

/** Does a number sit inside the field's range? */
export function inRange(field: NumberField, value: number): boolean {
	return (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
}

/**
 * What a block component gets for a field's parsed value (Decision 15: "ignored
 * where it's used"). A number out of range is `null`, so the block shows its own
 * default; list items are mapped the same way. Everything else is the parsed value:
 * a link failing the rule and half a button stay in the value, and the package's
 * Link and Buttons components render them as text or nothing (indexes stay the
 * editor's, so markers line up). A missing reference becoming `null` is Phase 2's
 * (it needs the store).
 */
export function renderValue(field: Field, value: unknown): unknown {
	switch (field.kind) {
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) && inRange(field, value) ? value : null;
		case 'media':
			// M5b Decision 3: resolved for the page, null when empty or of a kind the slot doesn't take; a loop-only slot loops.
			return renderMedia(value, { only: field.only, play: field.play });
		case 'link': {
			// M6c G9: an address-only link is `{ href }` when it's usable, else null (empty, or failing the rule).
			if (!field.addressOnly) return value;
			const href = usableHref(isObject(value) ? value.href : undefined);
			return href ? { href } : null;
		}
		case 'list': {
			if (!Array.isArray(value)) return [];
			if (field.item) {
				const item = field.item;
				return value.map((v) => renderValue(item, v));
			}
			const fields = field.fields ?? {};
			return value.map((v) => (isObject(v) ? renderData(fields, v) : v));
		}
		case 'group':
			return isObject(value) ? renderData(field.fields, value) : value;
		default:
			return value;
	}
}

/** renderValue for every field of a block's (or a list item's) parsed data; keys outside the schema pass through. */
export function renderData(fields: Fields, data: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...data };
	for (const [key, field] of Object.entries(fields)) if (Object.hasOwn(data, key)) out[key] = renderValue(field, data[key]);
	return out;
}

/**
 * The loading rule's "first image" (M5b Decision 4): the dotted path of the first
 * media slot, in schema order (list items in order), that renders an `<img>` (an
 * image, or a player's poster); null when none does. A loop has no `<img>`.
 */
export function firstImagePath(fields: Fields, data: Record<string, unknown>, base = ''): string | null {
	return firstMediaWhere(fields, data, (m) => m.kind === 'image' || m.play === 'player', base)?.path ?? null;
}

/**
 * M6c (G5, Decision 14): a grid card's picture, the first media slot in schema order
 * (list items in order) holding an image or a clip, a loop included (its poster stands
 * for it on a card): its path, its stored value and its render value; null when none does.
 */
export function firstMedia(fields: Fields, data: Record<string, unknown>): FirstMedia | null {
	return firstMediaWhere(fields, data, () => true);
}

export interface FirstMedia {
	path: string;
	value: unknown;
	media: RenderMedia;
}

function firstMediaWhere(fields: Fields, data: Record<string, unknown>, accept: (media: RenderMedia) => boolean, base = ''): FirstMedia | null {
	const shown = (field: MediaField, value: unknown) => {
		const media = renderMedia(value, { only: field.only, play: field.play });
		return media && accept(media) ? media : null;
	};
	for (const [key, field] of Object.entries(fields)) {
		const value = data[key];
		const path = join(base, key);
		if (field.kind === 'media') {
			const media = shown(field, value);
			if (media) return { path, value, media };
		}
		if (field.kind === 'group' && isObject(value)) {
			const found = firstMediaWhere(field.fields, value, accept, path);
			if (found) return found;
		}
		if (field.kind === 'list' && Array.isArray(value)) {
			if (field.item?.kind === 'media') {
				const item = field.item;
				for (const [i, v] of value.entries()) {
					const media = shown(item, v);
					if (media) return { path: join(path, i), value: v, media };
				}
			} else if (field.fields) {
				for (const [i, v] of value.filter(isObject).entries()) {
					const found = firstMediaWhere(field.fields, v, accept, join(path, i));
					if (found) return found;
				}
			}
		}
	}
	return null;
}

/** M6c (G5, Decision 13): can these fields hold an image anywhere (a media field, lists and groups included)? */
export function holdsMedia(fields: Fields | null | undefined): boolean {
	return Object.values(fields ?? {}).some(fieldHoldsMedia);
}

/** Can this field hold an image: a media field, or a list or group with one in it? */
export function fieldHoldsMedia(field: Field): boolean {
	if (field.kind === 'media') return true;
	if (field.kind === 'list') return field.item ? fieldHoldsMedia(field.item) : holdsMedia(field.fields);
	return field.kind === 'group' && holdsMedia(field.fields);
}

// ── Warnings ──────────────────────────────────────────────────────────────────

export type FieldWarningCode =
	/** Rich text: a block kind the field doesn't allow, shown as a paragraph. */
	| 'disallowed-kind'
	/** Rich text: a link where the field has links off, shown as its text. */
	| 'link-off'
	/** Rich text: italic in a heading rich-text field (M9 Decision 11), shown as plain text. */
	| 'italic-off'
	/** A value (or a rich-text entry) the field can't read: shown as empty, kept until the field is edited. */
	| 'unreadable'
	/** A link that fails the link rule (Decision 4): shown as text. */
	| 'link-rule'
	/** An internal link to a path no document has (Decision 4). */
	| 'link-missing'
	/** M9 Decision 7: an internal link to a page hidden from the site. */
	| 'link-hidden'
	/** M9 Decision 7: a reference to a page hidden from the site (a warning, as `link-hidden` is). */
	| 'reference-hidden'
	/** A link or button with only one of its label and its link: shows nothing. */
	| 'half-link'
	/** More buttons than the field's `max`: the extra ones don't show. */
	| 'too-many'
	/** A number outside the field's `min`/`max`: the page uses its default. */
	| 'out-of-range'
	/** A reference to a document that doesn't exist (Decision 6): the render gets null. */
	| 'missing-reference'
	/** M5b Decision 9: an image that isn't decorative with no alt text. Never blocks. */
	| 'missing-alt'
	/** M5b Decision 3: a value of a kind the slot doesn't take (`only`): kept, not shown. */
	| 'wrong-kind'
	/** M5b Decision 10: fewer items than the list's `min` (`too-many` covers `max`). */
	| 'too-few';

/**
 * A message for the field, never an error: the value is kept as typed (Decision 15).
 * `path` is dotted and relative to the field: `''` for the field itself, `'1'` for
 * a list's or buttons' second item, `'1.href'` inside it, `'credits.1.name'`-style
 * paths compose by prefixing the field's own key.
 */
export interface FieldWarning {
	path: string;
	code: FieldWarningCode;
	message: string;
}

/** What fieldWarnings checks against, when the caller knows it (Phase 2 supplies these from the store's listing). */
export interface WarningContext {
	/** The site's documents' URLs (DocumentEntry.url), for internal links. Without them, internal links aren't checked. */
	addresses?: Iterable<string | null | undefined>;
	/** Whether a document exists, for references. Without it, references aren't checked. */
	documentExists?: (collection: string, path: string) => boolean;
	/**
	 * M6c G4 (Decision 10): whether a file's key is in the library, for links to `/files/…`.
	 * Without it (the library not read yet, or not set up), file links aren't checked.
	 */
	fileExists?: (key: string) => boolean;
	/**
	 * M8 trial (item 3): the site's own code routes (code-routes.ts). A link to an address one
	 * of them serves exists, as a document's does; a route with parameters counts for every
	 * address under it, since which ones it builds isn't known from its file name.
	 */
	codeRoutes?: readonly CodeRoute[];
	/** M9 Decision 7: hidden pages, their address (normalised) to their name. A link to one warns. */
	hiddenPages?: ReadonlyMap<string, string>;
	/**
	 * M9 Decision 7: hidden documents, `collection/path` to their name and address (links.ts
	 * `hiddenDocuments`). A reference to one warns.
	 */
	hiddenDocuments?: ReadonlyMap<string, { label: string; url: string | null }>;
}

const join = (base: string, part: string | number) => (base === '' ? String(part) : `${base}.${part}`);
const ordinal = (n: number) => String(n + 1);

function hrefWarnings(href: string, path: string, context: WarningContext, out: FieldWarning[]) {
	const rule = validateLink(href);
	if (rule) {
		out.push({ path, code: 'link-rule', message: rule });
		return;
	}
	const file = fileKeyOf(href.trim());
	if (file) {
		// A file link (Decision 4): its key in the library, never a page's address.
		if (context.fileExists && !context.fileExists(file.key)) {
			out.push({ path, code: 'link-missing', message: `There's no file at ${fileAddress(file.key)} in the library, so this link goes nowhere. Pick a file.` });
		}
		return;
	}
	if (context.addresses) {
		const target = internalLinkPath(href);
		if (target !== null && codeRouteAt(target, context.codeRoutes)) return;
		const hidden = context.hiddenPages && hiddenLinkTarget(href, context.hiddenPages);
		if (hidden) {
			out.push({ path, code: 'link-hidden', message: hidden });
			return;
		}
		const missing = missingLinkTarget(href, context.addresses);
		if (missing) out.push({ path, code: 'link-missing', message: missing });
	}
}

/**
 * The field's warnings for a value: the file's raw value (untouched), or the
 * editor's value once the field is edited (both read through parseField). Never
 * throws. Warnings that depend on what the file holds, such as a rich-text kind the
 * field doesn't allow, only come from the raw value: once the field is edited,
 * that's been written as a paragraph and the warning goes.
 */
export function fieldWarnings(field: Field, raw: unknown, context: WarningContext = {}, path = ''): FieldWarning[] {
	const out: FieldWarning[] = [];
	const unreadable = (message = "This value isn't in the field's format, so the page shows the field as empty.") =>
		out.push({ path, code: 'unreadable', message });
	const present = raw !== undefined && raw !== null;

	switch (field.kind) {
		case 'richText': {
			if (present && typeof raw !== 'string' && !Array.isArray(raw)) unreadable();
			const { value, issues } = readRichText(raw, richTextOptions(field));
			for (const issue of issues) {
				const at = join(path, issue.block);
				if (issue.code === 'disallowed-kind') {
					out.push({
						path: at,
						code: 'disallowed-kind',
						message: `${issue.kind === 'h1' ? 'An h1' : `A${/^[aeiouh]/i.test(issue.kind) ? 'n' : ''} ${issue.kind}`} isn't allowed in this field, so it shows as a paragraph.`,
					});
				} else if (issue.code === 'italic-off') {
					out.push({ path: at, code: 'italic-off', message: 'This heading takes bold only, so italic here shows as plain text.' });
				} else if (issue.code === 'link-off') {
					out.push({
						path: at,
						code: 'link-off',
						message: "This field doesn't take links, so a link here shows as its text.",
					});
				} else {
					out.push({ path: at, code: 'unreadable', message: "Part of this text isn't in a form the field can read, so it doesn't show." });
				}
			}
			if (field.links) for (const href of richTextHrefs(value)) hrefWarnings(href, path, context, out);
			break;
		}
		case 'link': {
			if (present && !isObject(raw)) unreadable();
			const v = parseField(field, raw) as LinkValue;
			if (v.href) hrefWarnings(v.href, join(path, 'href'), context, out);
			// G9: an address-only link has no words, so it's never half a link.
			if (!field.addressOnly && !!v.label !== !!v.href) {
				out.push({ path, code: 'half-link', message: 'A link shows only once it has both its words and where it goes.' });
			}
			break;
		}
		case 'buttons': {
			if (present && !Array.isArray(raw)) unreadable();
			const items = parseField(field, raw) as ButtonValue[];
			items.forEach((b, i) => {
				if (b.href) hrefWarnings(b.href, join(path, `${i}.href`), context, out);
				// allowNoLink: words with no link are a plain label, meant; a link with no words is still half a button.
				const half = b.href ? !b.label : !!b.label && !field.allowNoLink;
				if (half) {
					out.push({ path: join(path, i), code: 'half-link', message: `Button ${ordinal(i)} shows only once it has both a label and a link.` });
				}
			});
			if (items.length > field.max) {
				out.push({ path, code: 'too-many', message: `Up to ${field.max} button${field.max === 1 ? '' : 's'} here: remove one. Only the first ${field.max} show.` });
			}
			break;
		}
		case 'number': {
			if (present && (typeof raw !== 'number' || !Number.isFinite(raw))) unreadable();
			const v = parseField(field, raw) as number | null;
			if (v !== null && !inRange(field, v)) {
				const range =
					field.min !== undefined && field.max !== undefined
						? `between ${field.min} and ${field.max}`
						: field.min !== undefined
							? `at least ${field.min}`
							: `at most ${field.max}`;
				out.push({ path, code: 'out-of-range', message: `Enter a number ${range}. Until then the page shows its default.` });
			}
			break;
		}
		case 'date':
			if (present && parseDay(raw) === null) unreadable("This isn't a date in the form 2026-10-15, so the page shows no date.");
			break;
		case 'toggle':
			if (present && typeof raw !== 'boolean') unreadable();
			break;
		case 'reference': {
			if (present && typeof raw !== 'string') unreadable();
			const v = parseField(field, raw) as string | null;
			if (v !== null && context.documentExists && !context.documentExists(field.to, v)) {
				out.push({ path, code: 'missing-reference', message: `This points at "${v}", which isn't in ${titleCase(field.to)} any more.` });
			} else if (v !== null && context.hiddenDocuments) {
				const message = hiddenReferenceTarget(field.to, v, context.hiddenDocuments);
				if (message) out.push({ path, code: 'reference-hidden', message });
			}
			break;
		}
		case 'media': {
			if (present && parseMedia(raw) === null) unreadable("This isn't an image or a video the field can read, so the page shows nothing here.");
			const kind = mediaKind(raw);
			if (kind === 'image' && isFileKey((parseMedia(raw) as Extract<MediaValue, { key: string }>).key)) {
				// M6c G4 (Decision 4): a file's key in a media slot, written by hand: the page shows nothing for it.
				const type = fileTypeOf((parseMedia(raw) as Extract<MediaValue, { key: string }>).key)!;
				out.push({ path, code: 'wrong-kind', message: `A file (${type.label}), not an image or video; nothing shows.` });
			} else if (kind && field.only && kind !== field.only) {
				out.push({
					path,
					code: 'wrong-kind',
					message: field.only === 'image' ? "This slot takes images only, so the page doesn't show this video. It's kept until you replace it." : "This slot takes videos only, so the page doesn't show this image. It's kept until you replace it.",
				});
			} else if (kind === 'image') {
				// Reads the current value, edited or not (Decision 9): it stays for as long as the alt is empty.
				const v = parseMedia(raw) as Extract<MediaValue, { key: string }>;
				if (!v.decorative && v.alt.trim() === '') out.push({ path: join(path, 'alt'), code: 'missing-alt', message: MISSING_ALT_MESSAGE });
			}
			break;
		}
		case 'list': {
			if (present && !Array.isArray(raw)) {
				unreadable();
				break;
			}
			const items = Array.isArray(raw) ? raw : [];
			// M5b Decision 10: outside min/max is warned, never blocked (counted as the editor's rows are).
			const count = field.item ? items.length : items.filter(isObject).length;
			if (field.min !== undefined && count < field.min) {
				out.push({ path, code: 'too-few', message: `This takes at least ${field.min}: add ${field.min - count} more.` });
			}
			if (field.max !== undefined && count > field.max) {
				out.push({ path, code: 'too-many', message: `This takes up to ${field.max}: remove ${count - field.max}. Until then they all show.` });
			}
			if (field.item) {
				const item = field.item;
				items.forEach((v, i) => out.push(...fieldWarnings(item, v, context, join(path, i))));
			} else {
				const fields = field.fields ?? {};
				// Indexes are the parsed list's (non-objects are dropped), so they match the editor's rows.
				items.filter(isObject).forEach((v, i) => {
					for (const [key, f] of Object.entries(fields)) out.push(...fieldWarnings(f, v[key], context, join(path, `${i}.${key}`)));
				});
			}
			break;
		}
		case 'group': {
			if (present && !isObject(raw)) {
				unreadable();
				break;
			}
			// Each field's own warnings, at `<key>` inside the group (so `left.button.0` from the block).
			const v = isObject(raw) ? raw : {};
			for (const [key, f] of Object.entries(field.fields)) out.push(...fieldWarnings(f, Object.hasOwn(v, key) ? v[key] : undefined, context, join(path, key)));
			break;
		}
		default:
			break;
	}
	return out;
}

/** A link's href as the render uses it: the href when it passes the rule, else null (render the label as text). */
export function usableHref(href: unknown): string | null {
	return isLinkHref(href) ? href.trim() : null;
}

// ── Paths (Decision 16) ───────────────────────────────────────────────────────

/** `credits.1.name` → `['credits', '1', 'name']`. */
export function splitPath(path: string): string[] {
	return path === '' ? [] : path.split('.');
}

/** Is a path part a list's index (`1` in `credits.1.name`)? A field's key never is (config.ts refuses one). */
export const isIndexPart = (part: string) => /^\d+$/.test(part);

/**
 * A path with no list index in it: a top-level field, or one inside groups
 * (`left.heading`). Only these are typed on the page (M5a Decision 13); a list item's
 * fields open in the sidebar.
 */
export const isKeyPath = (path: string) => path !== '' && !splitPath(path).some(isIndexPart);

/**
 * The fields that can hold the page's heading (M3 Decision 16: a lockup, or a text
 * or rich-text field marked `heading`, M9 Decision 11), as paths, in the order they're tried: the top-level ones in
 * schema order, then those inside groups (`left.heading`), groups in schema order. A
 * top-level heading always comes before a group's.
 */
export function headingPaths(fields: Fields): string[] {
	const isHeading = (field: Field) => (field.kind === 'lockup' || field.kind === 'text' || field.kind === 'richText') && !!field.heading;
	const top = Object.entries(fields).filter(([, f]) => isHeading(f)).map(([key]) => key);
	const grouped = Object.entries(fields).flatMap(([key, f]) => (f.kind === 'group' ? Object.entries(f.fields).filter(([, g]) => isHeading(g)).map(([sub]) => `${key}.${sub}`) : []));
	return [...top, ...grouped];
}

/**
 * The descriptor a dotted path lands on, and what's left of the path after it:
 * `credits.1.name` → the `name` text field, rest `[]`; `buttons.0.label` → the
 * buttons field, rest `['0', 'label']`; `cta.label` → the link field, rest
 * `['label']`; `left.heading` → the group's `heading` field, rest `[]`. Undefined
 * when the path doesn't start with a field.
 */
export function fieldAtPath(fields: Fields, path: string): { field: Field; rest: string[] } | undefined {
	const parts = splitPath(path);
	const first = parts.shift();
	if (first === undefined || !Object.hasOwn(fields, first)) return undefined;
	let field = fields[first]!;
	while (parts.length > 0 && (field.kind === 'list' || field.kind === 'group')) {
		if (field.kind === 'group') {
			if (!Object.hasOwn(field.fields, parts[0]!)) return undefined;
			field = field.fields[parts.shift()!]!;
			continue;
		}
		if (!/^\d+$/.test(parts[0]!)) return undefined;
		if (field.item) {
			parts.shift();
			field = field.item;
			continue;
		}
		const key = parts[1];
		const sub = field.fields ?? {};
		if (key === undefined) return { field, rest: parts };
		if (!Object.hasOwn(sub, key)) return undefined;
		parts.splice(0, 2);
		field = sub[key]!;
	}
	return { field, rest: parts };
}

/** The field a dotted path names exactly (`heading`, `left.heading`, `credits.1.name`), or undefined. */
export function fieldAt(fields: Fields, path: string): Field | undefined {
	const found = fieldAtPath(fields, path);
	return found && found.rest.length === 0 ? found.field : undefined;
}

/** The value at a dotted path inside `data`, or undefined. */
export function getAtPath(data: unknown, path: string): unknown {
	let at: unknown = data;
	for (const part of splitPath(path)) {
		if (Array.isArray(at)) at = /^\d+$/.test(part) ? at[Number(part)] : undefined;
		else if (isObject(at)) at = Object.hasOwn(at, part) ? at[part] : undefined;
		else return undefined;
	}
	return at;
}

/**
 * A copy of `data` with the value at a dotted path set, copying only along the
 * path (what's off the path is shared). A missing step is made: an array when the
 * next part is an index, an object otherwise. An index past an array's end appends
 * there (holes are filled with null). An empty path returns `value`.
 */
export function setAtPath(data: unknown, path: string, value: unknown): unknown {
	const parts = splitPath(path);
	const set = (at: unknown, i: number): unknown => {
		if (i === parts.length) return value;
		const part = parts[i]!;
		const index = /^\d+$/.test(part) ? Number(part) : null;
		if (Array.isArray(at) && index !== null) {
			const copy = [...at];
			while (copy.length < index) copy.push(null);
			copy[index] = set(at[index], i + 1);
			return copy;
		}
		if (isObject(at)) return { ...at, [part]: set(Object.hasOwn(at, part) ? at[part] : undefined, i + 1) };
		// Nothing usable here: make the container.
		if (index !== null) {
			const made: unknown[] = [];
			while (made.length < index) made.push(null);
			made[index] = set(undefined, i + 1);
			return made;
		}
		return { [part]: set(undefined, i + 1) };
	};
	return set(data, 0);
}
