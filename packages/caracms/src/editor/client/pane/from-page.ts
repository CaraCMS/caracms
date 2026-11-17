/**
 * Edit in context: what the sidebar reads from the page the preview shows, pure for the unit
 * tests (pane/FromPage.tsx draws it).
 *
 *   settingsMarks(roots)             the Site Settings field paths marked inside a block's roots
 *   settingsShown(paths, fields)     Decision 4: those fields by their labels, in page order and
 *                                    once each ("Phone", "Email", "Social links"): a group's
 *                                    field by its own label, a list (or a row's field) by the list's
 *   readRecordOf(doc) / parseReadRecord(text)   Contracts → the read record: the page's `#cms-reads`
 *   readRows(record, index, …)       Decision 12: one row per collection a block listed with
 *                                    `documents()`, and one per document it read alone with
 *                                    `document()` that none of its own reference fields holds
 *   heldRefs(fields, data)           the `<collection>/<path>` every reference field holds
 */
import { titleCase, type Field, type Fields } from '../../../fields.ts';
import type { ReadRecord } from '../../../read.ts';

const SETTINGS_FIELD = '[data-cms-source="settings"][data-cms-field]';

/** Every Site Settings field path marked inside `roots`, in page order (a field element carries `data-cms-source="settings"` itself). */
export function settingsMarks(roots: readonly Element[]): string[] {
	return roots.flatMap((root) => [...(root.matches(SETTINGS_FIELD) ? [root] : []), ...root.querySelectorAll(SETTINGS_FIELD)].map((el) => el.getAttribute('data-cms-field') ?? ''));
}

/** Review gaps (Decision 9): the forms whose words those marks are (`formWords.<form>.…`), once each, in order. */
export function formsShown(paths: readonly string[]): string[] {
	const out: string[] = [];
	for (const path of paths) {
		const id = /^formWords\.([^.]+)\./.exec(path)?.[1];
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}

/** A Site Settings path that isn't a form's word (those get their own row: formsShown). */
export const notFormWord = (path: string): boolean => !path.startsWith('formWords.');

/** Those fields by the form's labels, once each. */
export function settingsShown(paths: readonly string[], fields: Fields): string[] {
	const out: string[] = [];
	for (const path of paths) {
		const label = settingsLabel(fields, path);
		if (label && !out.includes(label)) out.push(label);
	}
	return out;
}

/** A Site Settings field path as the form names it: `contact.phone` → "Phone", `socials.2.network` → "Social links". */
export function settingsLabel(fields: Fields, path: string): string | null {
	const [first = '', second] = path.split('.');
	const top = Object.hasOwn(fields, first) ? fields[first]! : undefined;
	if (!top) return null;
	if (top.kind === 'group' && second !== undefined && Object.hasOwn(top.fields, second)) return top.fields[second]!.label ?? titleCase(second);
	return top.label ?? titleCase(first);
}

/** The page's read record, or null when it has none (a page that isn't a preview render, or one that failed). */
export function readRecordOf(doc: Document | null | undefined): ReadRecord | null {
	return parseReadRecord(doc?.getElementById('cms-reads')?.textContent);
}

/** A read record's text, parsed; null when there's none or it isn't one. */
export function parseReadRecord(text: string | null | undefined): ReadRecord | null {
	if (!text) return null;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ReadRecord) : null;
	} catch {
		return null;
	}
}

export type ReadRow =
	/** A collection listed with `documents()`: "Shows entries from Clients (5)", Open goes to its level. */
	| { kind: 'list'; collection: string; count: number }
	/** A document read alone with `document()`: Open shows it over the page. */
	| { kind: 'document'; collection: string; path: string };

/** Decision 12's rows for block `index`: its lists first, in the order read, then its documents read alone. */
export function readRows(record: ReadRecord | null, index: number, held: ReadonlySet<string>): ReadRow[] {
	const reads = record?.[String(index)];
	if (!reads) return [];
	const rows: ReadRow[] = Object.entries(reads.lists ?? {}).map(([collection, count]) => ({ kind: 'list', collection, count }));
	for (const id of reads.documents ?? []) {
		if (held.has(id)) continue;
		const slash = id.indexOf('/');
		if (slash > 0) rows.push({ kind: 'document', collection: id.slice(0, slash), path: id.slice(slash + 1) });
	}
	return rows;
}

/** Every `<collection>/<path>` a block's reference fields hold, in groups and lists too. */
export function heldRefs(fields: Fields, data: unknown, out = new Set<string>()): Set<string> {
	const values = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	for (const [name, field] of Object.entries(fields)) collect(field, values[name], out);
	return out;
}

function collect(field: Field, value: unknown, out: Set<string>): void {
	if (field.kind === 'reference') {
		if (typeof value === 'string' && value !== '') out.add(`${field.to}/${value}`);
	} else if (field.kind === 'group') {
		heldRefs(field.fields, value, out);
	} else if (field.kind === 'list' && Array.isArray(value)) {
		for (const item of value) {
			if (field.item) collect(field.item, item, out);
			else heldRefs(field.fields ?? {}, item, out);
		}
	}
}
