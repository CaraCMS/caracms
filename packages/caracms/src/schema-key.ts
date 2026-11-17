/**
 * The `$schema` key of a content file (M8 Decision 14): its first key, the relative path
 * from the file to its collection's generated JSON Schema (`schemas/<collection>.schema.json`,
 * `schemas/shared.schema.json`, `schemas/site-settings.schema.json`). Editors such as VS
 * Code read it; caracms's reader ignores it (it reads only the keys it knows), and the
 * serializer keeps it where it is (it splices known keys and leaves the rest as text).
 *
 * The editor stamps a new document (create.ts) and a moved one (move.ts: a move can change
 * the folder's depth); `caracms schemas` stamps every file that lacks it. A save never adds
 * it to a file that hasn't got it, so an edit's diff stays the edit.
 *
 * Browser-safe (no imports beyond the JSON source parser).
 */
import { parseSource } from './json-source.ts';

export const SCHEMA_KEY = '$schema';
/** The generated schemas' folder, relative to the site's root. */
export const SCHEMAS_FOLDER = 'schemas';

/** A collection's schema file name: the reserved two have fixed names (Contracts → Schemas). */
export function schemaFileName(collection: { name: string; kind: string }): string {
	if (collection.kind === 'settings') return 'site-settings.schema.json';
	if (collection.kind === 'shared') return 'shared.schema.json';
	return `${collection.name}.schema.json`;
}

/** The `$schema` value for a content file (`file`: site-relative, `/`-separated): `../../schemas/pages.schema.json`. */
export function schemaRef(collection: { name: string; kind: string }, file: string): string {
	const depth = file.split('/').filter(Boolean).length - 1;
	return `${'../'.repeat(depth)}${SCHEMAS_FOLDER}/${schemaFileName(collection)}`;
}

/**
 * The file's text with `"$schema": ref` as its first key: added when missing, its value
 * replaced when different (in place, wherever it sits). Anything else, and a file that
 * isn't a JSON object, comes back as it was. `add: false` only corrects a key the file
 * has (a move: a file that had none still has none).
 */
export function stampSchema(text: string, ref: string, { add = true }: { add?: boolean } = {}): string {
	let source;
	try {
		source = parseSource(text);
	} catch {
		return text;
	}
	const root = source.root;
	if (root.kind !== 'object') return text;
	const value = JSON.stringify(ref);
	const existing = root.members.find((m) => m.key === SCHEMA_KEY);
	if (existing) {
		if (existing.value.kind === 'scalar' && existing.value.value === ref) return text;
		return text.slice(0, existing.value.start) + value + text.slice(existing.value.end);
	}
	if (!add) return text;
	const line = `${JSON.stringify(SCHEMA_KEY)}: ${value}`;
	if (root.members.length === 0) return text.slice(0, root.start) + `{\n  ${line}\n}` + text.slice(root.end);
	// Before the first member, at its key's quote, with that member's own indentation after.
	const keyStart = text.indexOf('"', root.start);
	const lineStart = text.lastIndexOf('\n', keyStart) + 1;
	const indent = lineStart > root.start ? text.slice(lineStart, keyStart) : ' ';
	const sep = lineStart > root.start ? `,\n${indent}` : ', ';
	return text.slice(0, keyStart) + line + sep + text.slice(keyStart);
}
