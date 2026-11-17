/**
 * The collections table's rows and columns (pre-M7 polish: a flat collection's
 * documents as a table over the stage). Pure, so the sidebar's list and the table
 * read one view: the same find, filters and order.
 *
 * Columns: the title always, then what the collection's config names in `columns`
 * (its fields, by key, and the two built-ins `address` and `edited`); without
 * `columns`, the address and when it was last edited. A field column's values ride
 * on each listed document (`entry.columns`, content.ts), so the table draws at once.
 *
 * Posts and tags (Decision 13): a section builder's page fields can be columns too,
 * and two more kinds, for both collection kinds: a reference, shown as the referenced
 * document's title ("Missing" when it's gone), and a list of references, its titles
 * joined by commas. Titles come from the editor's listing of every collection (`RefIndex`).
 *
 * Filters: one per select, toggle, reference or list-of-references column, an exact
 * match on its value (a reference's: the document's path; a list's: one of them).
 * Sorting: by any column but a list of references, either way; documents without a
 * value go last whichever way. The view starts in the config's `sort`, else the title A to Z.
 */
import type { Field, Fields } from '../../../fields.ts';
import { titleCase } from '../../../fields.ts';
import type { EditorAnyCollection, ListedDocument } from '../../types.ts';
import { formatDay } from '../fields/date.ts';
import { filterCollection } from '../nav/search.ts';
import { DEFAULT_COLUMNS, columnKindOf, type SortConfig } from '../../../columns.ts';

export type ColumnKind = 'title' | 'address' | 'edited' | 'text' | 'select' | 'toggle' | 'date' | 'number' | 'reference' | 'references';

export interface TableColumn {
	key: string;
	label: string;
	kind: ColumnKind;
	field?: Field;
	/** A reference or list-of-references column's: the collection its documents are in. */
	to?: string;
}

/** The listed documents a reference can point at, by `collection` and `path` (refIndex). */
export type RefIndex = ReadonlyMap<string, ListedDocument>;
const refKey = (collection: string, path: string) => `${collection}:${path}`;

/** Every listed document by collection and path, for reference columns' titles. */
export function refIndex(documents: readonly ListedDocument[]): RefIndex {
	return new Map(documents.map((d) => [refKey(d.collection, d.path), d]));
}

const NO_REFS: RefIndex = new Map();

/** A reference column's paths for a document: one (a reference), or each of a list's; empty for none. */
export function refPaths(doc: ListedDocument, column: TableColumn): string[] {
	const v = doc.columns?.[column.key];
	const paths = column.kind === 'reference' ? [v] : column.kind === 'references' && Array.isArray(v) ? v : [];
	return paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim());
}

/** One referenced document's title, or null when it's missing (gone from its collection). */
export function refTitle(refs: RefIndex, column: TableColumn, path: string): string | null {
	const doc = column.to ? refs.get(refKey(column.to, path)) : undefined;
	return doc ? doc.label || doc.title : null;
}

/** A reference cell's parts, in order: each referenced document's title, or `missing`. */
export function refParts(doc: ListedDocument, column: TableColumn, refs: RefIndex): { path: string; title: string | null }[] {
	return refPaths(doc, column).map((path) => ({ path, title: refTitle(refs, column, path) }));
}

/** What a reference that's gone shows (in the warning colour). */
export const MISSING = 'Missing';

export type SortDir = 'asc' | 'desc';

/** A filter's value: a select's option value, or a toggle's on/off. */
export type FilterValue = string | boolean;

export interface TableView {
	query: string;
	sort: { key: string; dir: SortDir };
	filters: Record<string, FilterValue>;
}

/**
 * Review gaps (Decision 3): a manual collection's own order, "Site order", as a sort key no
 * column can have (a field's key is a word). Its documents arrive in it (the listing's order),
 * so sorting by it keeps them as they are.
 */
export const SITE_ORDER = '$order';

/** A view as it opens: a manual collection's Site order (review gaps, Decision 3), else the config's sort (Decision 13), else the title A to Z. */
export const defaultView = (sort?: SortConfig | null, manual = false): TableView => ({ query: '', sort: manual ? { key: SITE_ORDER, dir: 'asc' } : sort ? { key: sort.column, dir: sort.order } : { key: 'title', dir: 'asc' }, filters: {} });

/** Whether the view drags: a manual collection in Site order with no find and no filter (review gaps, Decision 3). */
export const dragsInView = (view: TableView): boolean => view.sort.key === SITE_ORDER && view.query.trim() === '' && Object.keys(view.filters).length === 0;

export function tableColumns(collection: Pick<EditorAnyCollection, 'fields' | 'columns'> & { urlBase?: string | null }): TableColumn[] {
	const fields: Fields = collection.fields ?? {};
	const named = collection.columns ?? DEFAULT_COLUMNS;
	const columns: TableColumn[] = [{ key: 'title', label: 'Title', kind: 'title' }];
	for (const key of named) {
		// Shared blocks have no address (no page of their own): no column for it.
		if (key === 'address') {
			if (collection.urlBase !== null) columns.push({ key, label: 'Address', kind: 'address' });
		}
		else if (key === 'edited') columns.push({ key, label: 'Last edited', kind: 'edited' });
		else {
			const field = fields[key];
			const kind = field ? columnKindOf(field) : null;
			if (!field || !kind) continue;
			const to = field.kind === 'reference' ? field.to : field.kind === 'list' && field.item?.kind === 'reference' ? field.item.to : undefined;
			columns.push({ key, label: field.label ?? titleCase(key), kind, field, ...(to ? { to } : {}) });
		}
	}
	return columns;
}

/** A field column's stored value for a document (undefined when it has none). */
const raw = (doc: ListedDocument, key: string): unknown => doc.columns?.[key];

/**
 * The value a column sorts and filters by: a string, number or boolean, or null (none).
 * A reference's is its document's title (a missing one has none, so it sorts last); a
 * list of references' is its titles joined (it doesn't sort, and filters by refPaths).
 */
export function cellValue(doc: ListedDocument, column: TableColumn, refs: RefIndex = NO_REFS): string | number | boolean | null {
	switch (column.kind) {
		case 'reference':
		case 'references': {
			const titles = refParts(doc, column, refs).flatMap((p) => (p.title === null ? [] : [p.title]));
			return titles.length ? titles.join(', ') : null;
		}
		case 'title':
			return doc.label;
		case 'address':
			return doc.url;
		case 'edited':
			return doc.mtimeMs;
		case 'toggle': {
			const v = raw(doc, column.key);
			return typeof v === 'boolean' ? v : column.field?.kind === 'toggle' ? column.field.default : null;
		}
		case 'number': {
			const v = raw(doc, column.key);
			return typeof v === 'number' && Number.isFinite(v) ? v : null;
		}
		default: {
			const v = raw(doc, column.key);
			return typeof v === 'string' && v.trim() !== '' ? v : null;
		}
	}
}

/**
 * What a cell shows, as text ('' for nothing). A toggle's is "Yes" or ''; the table
 * draws it as a mark. `edited` writes a time (the editor's absolute times, live/format.ts → when).
 */
export function cellText(doc: ListedDocument, column: TableColumn, edited: (ms: number) => string, refs: RefIndex = NO_REFS): string {
	if (column.kind === 'reference' || column.kind === 'references') return refParts(doc, column, refs).map((p) => p.title ?? MISSING).join(', ');
	const v = cellValue(doc, column);
	if (v === null) return '';
	switch (column.kind) {
		case 'select': {
			const field = column.field;
			return field?.kind === 'select' ? (field.options.find((o) => o.value === v)?.label ?? String(v)) : String(v);
		}
		case 'date':
			return formatDay(v);
		case 'toggle':
			return v ? 'Yes' : '';
		case 'edited':
			return edited(v as number);
		default:
			return String(v);
	}
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compare(a: string | number | boolean, b: string | number | boolean): number {
	if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b);
	if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? -1 : 1; // on first
	return Number(a) - Number(b);
}

/** The documents in the view's order: by its column either way, the title breaking ties; no value last. */
export function sortRows(docs: readonly ListedDocument[], columns: readonly TableColumn[], sort: TableView['sort'], refs: RefIndex = NO_REFS): ListedDocument[] {
	// Review gaps (Decision 3): Site order is the listing's own.
	if (sort.key === SITE_ORDER) return [...docs];
	// A list of references doesn't order (Decision 13): the title does instead.
	const column = columns.find((c) => c.key === sort.key && sortable(c)) ?? columns[0]!;
	const title = columns[0]!;
	const sign = sort.dir === 'asc' ? 1 : -1;
	return [...docs].sort((x, y) => {
		const a = cellValue(x, column, refs);
		const b = cellValue(y, column, refs);
		if (a === null || b === null) {
			if (a !== b) return a === null ? 1 : -1;
		} else {
			const c = compare(a, b);
			if (c !== 0) return sign * c;
		}
		return collator.compare(String(cellValue(x, title)), String(cellValue(y, title)));
	});
}

/** Whether a column's header sorts: every column but a list of references. */
export const sortable = (column: TableColumn) => column.kind !== 'references';

const isFilterable = (c: TableColumn) => c.kind === 'select' || c.kind === 'toggle' || c.kind === 'reference' || c.kind === 'references';

/** The columns a filter can be set on: select, toggle, reference and list-of-references columns. */
export const filterable = (columns: readonly TableColumn[]) => columns.filter(isFilterable);

/** Whether a document passes a column's filter: its value, or for a reference column, one of its paths. */
function matches(doc: ListedDocument, column: TableColumn, want: FilterValue): boolean {
	if (column.kind === 'reference' || column.kind === 'references') return refPaths(doc, column).includes(String(want));
	return cellValue(doc, column) === want;
}

/** The view's documents: found (filterCollection), filtered, in order. */
export function viewRows(docs: readonly ListedDocument[], columns: readonly TableColumn[], view: TableView, refs: RefIndex = NO_REFS): ListedDocument[] {
	const byFilter = Object.entries(view.filters).flatMap(([key, want]) => {
		const column = columns.find((c) => c.key === key && isFilterable(c));
		return column ? [[column, want] as const] : [];
	});
	const found = filterCollection(view.query, docs).filter((d) => byFilter.every(([column, want]) => matches(d, column, want)));
	return sortRows(found, columns, view.sort, refs);
}

/** The next sort for a click on a column's header: that column ascending, or the other way when it's already the sort. */
export const nextSort = (sort: TableView['sort'], key: string): TableView['sort'] => (key === SITE_ORDER ? { key, dir: 'asc' } : sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });

/**
 * Review gaps (Decision 3): a sort in words, for the line a manual collection shows when it's
 * sorted another way: the column's label and the grid's words for its direction ("Launched",
 * "oldest first"). Null for Site order.
 */
export function sortWords(columns: readonly TableColumn[], sort: TableView['sort']): { label: string; how: string } | null {
	if (sort.key === SITE_ORDER) return null;
	const column = columns.find((c) => c.key === sort.key) ?? columns[0]!;
	const asc = sort.dir === 'asc';
	const how =
		column.kind === 'date' || column.kind === 'edited' ? (asc ? 'oldest first' : 'newest first') : column.kind === 'number' ? (asc ? 'lowest first' : 'highest first') : column.kind === 'toggle' ? (asc ? 'on first' : 'off first') : asc ? 'A to Z' : 'Z to A';
	return { label: column.label, how };
}

// ── M6c (G5): the grid view ───────────────────────────────────────────────────

export interface OrderOption {
	value: string;
	label: string;
	sort: TableView['sort'];
}

/** A sort's `<option>` value: `<key>:<dir>`. */
export const orderValue = (sort: TableView['sort']) => `${sort.key}:${sort.dir}`;

/**
 * Grid's order select (it has no headers to click, Decision 16): the title either way,
 * then each column in the words its kind reads in (dates newest or oldest first,
 * numbers lowest or highest, text and choices A to Z). A toggle doesn't order a grid.
 * The view's sort is always one of them, set from List's headers or not, so the select
 * never lies about the order.
 */
export function orderOptions(columns: readonly TableColumn[], current: TableView['sort'], manual = false): OrderOption[] {
	const out: OrderOption[] = [];
	// Review gaps (Decision 3): a manual collection's grid shows Site order first.
	if (manual) out.push({ value: orderValue({ key: SITE_ORDER, dir: 'asc' }), label: 'Site order', sort: { key: SITE_ORDER, dir: 'asc' } });
	const add = (column: TableColumn, dir: SortDir, words: string) => out.push({ value: orderValue({ key: column.key, dir }), label: `${column.label}, ${words}`, sort: { key: column.key, dir } });
	for (const c of columns) {
		if (c.kind === 'toggle' || c.kind === 'references') continue;
		if (c.kind === 'title') {
			add(c, 'asc', 'A to Z');
			add(c, 'desc', 'Z to A');
		} else if (c.kind === 'date' || c.kind === 'edited') {
			add(c, 'desc', 'newest first');
			add(c, 'asc', 'oldest first');
		} else if (c.kind === 'number') {
			add(c, 'asc', 'lowest first');
			add(c, 'desc', 'highest first');
		} else add(c, 'asc', 'A to Z');
	}
	if (!out.some((o) => o.value === orderValue(current))) {
		const column = columns.find((c) => c.key === current.key);
		if (column) out.push({ value: orderValue(current), label: `${column.label}, ${current.dir === 'asc' ? 'A to Z' : 'Z to A'}`, sort: current });
	}
	return out;
}

/**
 * A card's captions (Decision 16): up to two of the configured columns after the
 * title, as the table formats them; a toggle has no words, so it's skipped. A section
 * builder whose columns are the built-ins: its card says when it was last edited. One
 * whose columns name page fields (posts and tags, Decision 13) captions as a list of fields does.
 */
export function captionColumns(collection: Pick<EditorAnyCollection, 'kind'>, columns: readonly TableColumn[]): TableColumn[] {
	if (collection.kind === 'sections' && !columns.some((c) => c.field)) return [columns.find((c) => c.kind === 'edited') ?? { key: 'edited', label: 'Last edited', kind: 'edited' }];
	return columns.filter((c) => c.kind !== 'title' && c.kind !== 'toggle').slice(0, 2);
}
