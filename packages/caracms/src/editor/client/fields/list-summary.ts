/**
 * A list row's words (M5a Decision 5), pure for the unit tests: what one item is
 * called ("Add credit"), and what a collapsed row shows: the field's `itemLabel`,
 * else its first text field's value (and a second one, muted); for `list(text())`
 * the string itself; for `list(reference())` the referenced document's title; rich text
 * by its words on one line. An item with an inner list (M7) adds how many it holds, and a
 * row with no words of its own is named by its first list's first item (a table row by its
 * first cell).
 */
import { parseField, type Field, type Fields, type LinkValue, type ListField as ListDescriptor } from '../../../fields.ts';
import { richTextPlain, type RichTextValue } from '../../../rich-text.ts';

/**
 * "Credits" → "credit"; what one item is called ("Add credit", "Removed credit: …"). A list
 * that names its row (`list(…, { itemNoun: 'person' })`) is called that instead.
 */
export function itemNoun(label: string, named?: string): string {
	if (named !== undefined && named.trim() !== '') return named.trim();
	const word = label.trim().toLowerCase();
	if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
	if (/[^s]s$/.test(word)) return word.slice(0, -1);
	return word || 'item';
}

/** How many rows, in words: "1 credit", "2 credits"; a list that names its row counts in its label ("2 people"). */
export function itemCount(n: number, label: string, named?: string): string {
	const one = itemNoun(label, named);
	const many = named !== undefined && named.trim() !== '' ? label.trim().toLowerCase() || `${one}s` : `${one}s`;
	return `${n} ${n === 1 ? one : many}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A value as one line of text for a summary: a string, a link's label, a referenced title. */
function lineOf(field: Field, value: unknown, titleOf: (to: string, path: string) => string | null): string {
	switch (field.kind) {
		case 'text':
		case 'select':
			return typeof value === 'string' ? value.replace(/\s*\n\s*/g, ' ').trim() : '';
		case 'link':
			// G9: an address-only link is named by where it goes.
			if (field.addressOnly) return linkDestination(value);
			return isObject(value) ? String((value as unknown as LinkValue).label ?? '').trim() : '';
		case 'reference':
			return typeof value === 'string' ? (titleOf(field.to, value) ?? value) : '';
		case 'lockup':
			return isObject(value) && Array.isArray(value.lines) ? value.lines.join(' ') : '';
		case 'richText':
			// Its words on one line (a step, a table cell).
			return richTextPlain(parseField(field, value) as RichTextValue).replace(/\s+/g, ' ').trim();
		case 'date':
			return typeof value === 'string' ? value : '';
		case 'number':
			return typeof value === 'number' ? String(value) : '';
		case 'media': {
			// M5b: an image by its alt text, else its file name; a clip by its name.
			if (!isObject(value)) return '';
			if (typeof value.key === 'string') return (typeof value.alt === 'string' && value.alt.trim()) || (value.key.split('/').pop() ?? '');
			return typeof value.name === 'string' ? value.name.trim() : '';
		}
		default:
			return '';
	}
}

/** Where a link goes, short (the mockup's linkText): an address without `https://` or `mailto:`. */
export function linkDestination(value: unknown): string {
	if (!isObject(value)) return '';
	return String((value as unknown as LinkValue).href ?? '')
		.trim()
		.replace(/^https:\/\//, '')
		.replace(/^mailto:/, '');
}

/**
 * A collapsed row's summary: the label field's value, and a second text field's, muted.
 * A list of links shows each link's words, then where it goes.
 */
export function itemSummary(list: ListDescriptor, item: unknown, titleOf: (to: string, path: string) => string | null): { main: string; more: string } {
	if (list.item) return { main: lineOf(list.item, item, titleOf), more: list.item.kind === 'link' && !list.item.addressOnly ? linkDestination(item) : '' };
	return fieldsSummary((list.fields ?? {}) as Fields, item, list.itemLabel, titleOf);
}

/** A row of fields' summary; a group in the label's place is looked inside (a row whose only field is a group). */
function fieldsSummary(fields: Fields, item: unknown, itemLabel: string | undefined, titleOf: (to: string, path: string) => string | null): { main: string; more: string } {
	const entries = Object.entries(fields);
	const data = isObject(item) ? item : {};
	const labelKey = itemLabel && Object.hasOwn(fields, itemLabel) ? itemLabel : entries.find(([, f]) => f.kind === 'text')?.[0] ?? entries[0]?.[0];
	const labelField = labelKey ? fields[labelKey]! : null;
	if (labelField?.kind === 'group') return fieldsSummary(labelField.fields, data[labelKey!], undefined, titleOf);
	let main = labelKey ? lineOf(labelField!, data[labelKey], titleOf) : '';
	// No words of its own, and no text field to name it: a row is named by its first list's first item (a table row by its first cell).
	if (!main && labelField?.kind !== 'text') {
		const first = entries.find(([, f]) => f.kind === 'list');
		const items = first ? data[first[0]] : null;
		if (first && Array.isArray(items) && items.length > 0) main = itemSummary(first[1] as ListDescriptor, items[0], titleOf).main;
	}
	// M7 Decision 15: an item holding an inner list with items counts them ("Services · 2 dropdown links").
	const inner = entries.find(([k, f]) => f.kind === 'list' && Array.isArray(data[k]) && (data[k] as unknown[]).length > 0);
	if (inner) {
		const n = (data[inner[0]] as unknown[]).length;
		const list = inner[1] as ListDescriptor;
		return { main, more: itemCount(n, list.label ?? inner[0], list.itemNoun) };
	}
	const otherKey = entries.find(([k, f]) => k !== labelKey && (f.kind === 'text' || f.kind === 'link' || f.kind === 'reference'))?.[0];
	const more = otherKey ? lineOf(fields[otherKey]!, data[otherKey], titleOf) : '';
	return { main, more };
}
