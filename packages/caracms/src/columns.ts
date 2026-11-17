/**
 * A collection's table columns (pre-M7 polish: a flat collection's documents as a
 * table over the editor's stage). The config names them per collection (`columns`):
 * its fields by key (a section builder's page fields too), of the kinds that show as one
 * short value, and two built-ins. Posts and tags (Decision 13) add a reference, shown as
 * the referenced document's title, and a list of references, its titles joined by commas.
 * Shared by the config's check (config.ts) and the editor's table
 * (editor/client/collections/table.ts), so the two agree on what a column can be.
 */

/** Built-in columns: the document's address, and when it was last edited. */
export const BUILT_IN_COLUMNS = ['address', 'edited'] as const;
export type BuiltInColumn = (typeof BUILT_IN_COLUMNS)[number];

/** Without `columns`: the title (always first), the address and when it was last edited. */
export const DEFAULT_COLUMNS: readonly BuiltInColumn[] = ['address', 'edited'];

/** The field kinds a column can show. */
export const COLUMN_FIELD_KINDS = ['text', 'select', 'toggle', 'date', 'number'] as const;

/** What a column field can be, in words, for the config's refusals. */
export const COLUMN_FIELD_WORDS = 'a text, select, toggle, date, number or reference field, or a list of references';

/** A field's column kind: one of COLUMN_FIELD_KINDS, `reference`, `references` (a list of references), or null when it can't be a column. */
export function columnKindOf(field: { kind: string; item?: { kind: string } | null }): (typeof COLUMN_FIELD_KINDS)[number] | 'reference' | 'references' | null {
	if ((COLUMN_FIELD_KINDS as readonly string[]).includes(field.kind)) return field.kind as (typeof COLUMN_FIELD_KINDS)[number];
	if (field.kind === 'reference') return 'reference';
	if (field.kind === 'list' && field.item?.kind === 'reference') return 'references';
	return null;
}

/** A collection's initial order (Decision 13): `title` or one of its columns, either way. */
export interface SortConfig {
	column: string;
	order: 'asc' | 'desc';
}

export const isBuiltInColumn = (key: string): key is BuiltInColumn => (BUILT_IN_COLUMNS as readonly string[]).includes(key);
export const isColumnField = (field: { kind: string; item?: { kind: string } | null }) => columnKindOf(field) !== null;
