/**
 * Where a field's value lives, so the field components aren't tied to a block
 * (M5a Phase 4; Phase 5 mounts the same components in a fields document's form).
 *
 *   <FieldHostProvider host={host}>
 *     <FieldControl name="credits" field={descriptor} value={parsed} />
 *   </FieldHostProvider>
 *
 * A host says how to set a value by dotted path (M5a Decision 16: `credits.1.name`),
 * how to remove a list row with Undo (Decision 14), what the file held for a field
 * (warnings read the raw value while the field is untouched, Phase 1's note), and
 * which field is picked. The block level's host is `blockHost(editor, key)`: every
 * path goes to `editor.doc.setField(key, path, value)`.
 *
 * Warnings' context (links to documents that don't exist, references to documents
 * that don't exist) comes from the editor's document listing: `useWarningContext()`.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { fieldWarnings, getAtPath, parseField, splitPath, type Field, type Fields, type FieldWarning, type WarningContext } from '../../../fields.ts';
import { mediaFor } from '../media/store.ts';
import { useEditor, useStore } from '../context.tsx';
import type { Editor, View } from '../editor.ts';
import { hiddenDocuments, hiddenPages } from '../../../links.ts';

export interface FieldHost {
	/**
	 * What the fields belong to, for element ids and the picked state: the block's
	 * key in the block level; Phase 5's fields document picks its own (one per form).
	 */
	scope: string;
	/** The path picked among this host's fields (a top-level key or a dotted path), or null. A pure read of the view. */
	picked(view: View): string | null;
	/** Pick a field (focus moved into it in the sidebar). `path` may be dotted. */
	pick(path: string): void;
	/** Set the value at a dotted path from the host's root: `credits.1.name`, `cta.href`, `featured`. */
	set(path: string, value: unknown, options?: { undoLabel?: string }): void;
	/** Remove item `index` of the list at `path`, with Undo under `label` (M2's toast; Decision 14). */
	removeItem(path: string, index: number, label: string): void;
	/** The file's value for a top-level field as first read; undefined when the file has none (a new block). */
	raw(name: string): unknown;
	/** Read-only (M4: a lock, held edits, signed out). Controls are disabled by the level's fieldset too. */
	readOnly: boolean;
}

const HostContext = createContext<FieldHost | null>(null);

export function FieldHostProvider({ host, children }: { host: FieldHost; children: ReactNode }) {
	return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

/** The host the field is rendered in, or null outside one (M3's fields fall back to their block key). */
export function useFieldHost(): FieldHost | null {
	return useContext(HostContext);
}

/** The host every field needs. Throws outside a FieldHostProvider. */
export function useHost(): FieldHost {
	const host = useContext(HostContext);
	if (!host) throw new Error('A field needs a <FieldHostProvider>');
	return host;
}

/** Is `path` the field `name` itself or a path inside it? */
export const within = (path: string | null | undefined, name: string): boolean => !!path && (path === name || path.startsWith(`${name}.`));

const rawCache = new Map<string, unknown>();

/** The file's text as a value (cached per text, so a re-render doesn't re-parse); undefined when it isn't JSON. */
export function parseBase(base: string): unknown {
	if (rawCache.has(base)) return rawCache.get(base);
	let value: unknown;
	try {
		value = JSON.parse(base);
	} catch {
		value = undefined;
	}
	if (rawCache.size > 8) rawCache.clear();
	rawCache.set(base, value);
	return value;
}

/** A block's raw fields in the file as first read (by its `source`), or undefined for an added block. */
export function rawBlock(base: string, source: number | null): Record<string, unknown> | undefined {
	if (source === null) return undefined;
	const doc = parseBase(base);
	const blocks = doc && typeof doc === 'object' ? (doc as { blocks?: unknown }).blocks : undefined;
	const raw = Array.isArray(blocks) ? blocks[source] : undefined;
	return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/** The block level's host: one block of the open document, by its key. */
export function blockHost(editor: Editor, key: string, raw: Record<string, unknown> | undefined, readOnly: boolean): FieldHost {
	return {
		scope: key,
		picked: (view) => (view.level === 'block' && view.block === key ? view.field : null),
		pick(path) {
			const view = editor.view.get();
			if (view.field !== path) editor.view.update({ field: path, picked: false });
		},
		set: (path, value, options) => editor.doc.setField(key, path, value, options),
		removeItem(path, index, label) {
			editor.doc.removeItem(key, path, index, { label });
			editor.announce(`${label}. Undo with Command Z.`);
		},
		raw: (name) => (raw && Object.hasOwn(raw, name) ? raw[name] : undefined),
		readOnly,
	};
}

/**
 * What warnings check against, from the editor's document listing: every document's
 * address and the site's code routes (internal links, Decision 4) and whether a document exists (references,
 * Decision 6).
 */
export function useWarningContext(): WarningContext {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	// M6c G4 (Decision 10): the library's file keys, once read (media/store.ts reads them the first time an opened document holds a /files/ link).
	const files = useStore(mediaFor(editor).files, (l) => l.list);
	return useMemo(() => {
		const ids = new Set(documents.map((d) => `${d.collection}/${d.path}`));
		const keys = files ? new Set(files.map((f) => f.key)) : null;
		return {
			addresses: documents.map((d) => d.url),
			// M9 Decision 7: a link to a hidden page warns.
			hiddenPages: hiddenPages(documents),
			// ...and so does a reference to one.
			hiddenDocuments: hiddenDocuments(documents),
			// M8 trial (item 3): an address the site's own code serves exists too.
			codeRoutes: editor.site.codeRoutes ?? [],
			documentExists: (collection: string, path: string) => ids.has(`${collection}/${path}`),
			...(keys ? { fileExists: (key: string) => keys.has(key) } : {}),
		};
	}, [documents, files]);
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * A field's warnings (Phase 1's fieldWarnings): from the file's raw value while the
 * field is untouched (so a heading where headings are off, kept in the file, is
 * still said), from the edited value once it's changed.
 */
export function useFieldWarnings(name: string, field: Field, value: unknown): FieldWarning[] {
	const host = useHost();
	const context = useWarningContext();
	// A field inside a group or a list item (`left.heading`): the file's value at that path in its top-level field.
	const [top, ...inside] = splitPath(name);
	const raw = inside.length ? getAtPath(host.raw(top!), inside.join('.')) : host.raw(name);
	return useMemo(() => {
		const untouched = raw !== undefined && same(parseField(field, raw), value);
		return fieldWarnings(field, untouched ? raw : value, context);
	}, [field, raw, value, context]);
}

/**
 * Every warning in a set of fields (a form's, or a section builder's page fields), by
 * the same rule as each field's own (useFieldWarnings): the file's value while a field is
 * untouched, the edited one once it's changed. For a section's mark (GroupField.tsx →
 * FieldSection), so a closed section says it holds a warning.
 */
export function fieldsWarnings(fields: Fields, data: Record<string, unknown>, raw: Record<string, unknown> | undefined, context: WarningContext): FieldWarning[] {
	return Object.entries(fields).flatMap(([name, field]) => {
		const was = raw && Object.hasOwn(raw, name) ? raw[name] : undefined;
		const untouched = was !== undefined && same(parseField(field, was), data[name]);
		return fieldWarnings(field, untouched ? was : data[name], context, name);
	});
}

/** Warnings at a path relative to the field: `''` the field's own, `'1'` and `'1.href'` the second item's. */
export const warningsAt = (warnings: readonly FieldWarning[], path: string): FieldWarning[] =>
	warnings.filter((w) => w.path === path || w.path.startsWith(`${path}.`));
