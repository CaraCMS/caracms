/**
 * `caracms schemas` (M8 Decision 14): write `schemas/` from the config, and give every
 * content file that lacks one its `$schema` key (or correct a wrong path). `init` and
 * `validate --fix` run it; `astro dev` runs only the first half (`writeSchemaFiles`), so a
 * dev run never touches content.
 *
 * `schemas/` is the package's: a `*.schema.json` there that the config no longer makes
 * (a collection removed or renamed) is deleted. Nothing else in it is touched.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedSite } from '../config.ts';
import { siteSchemas, schemaText } from '../content-schema.ts';
import { listDocuments } from '../content.ts';
import { SCHEMAS_FOLDER, schemaRef, stampSchema } from '../schema-key.ts';
import { loadSite } from './site.ts';

// `caracms init` loads the site through this module too (bin/init.mjs).
export { loadSite };

type Site = Pick<ResolvedSite, 'root' | 'blocks' | 'collections'>;

export interface SchemaFileChange {
	/** Site-relative. */
	file: string;
	/** Null: the file goes (the config no longer makes it). */
	text: string | null;
	/** What's there now; null when it's new. */
	before: string | null;
}

const read = (path: string): string | null => {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
};

/** The schema files that differ from what the config makes: new, changed or gone. Empty when they're current. */
export function schemaFileChanges(site: Site): SchemaFileChange[] {
	const out: SchemaFileChange[] = [];
	const made = siteSchemas(site);
	for (const [name, schema] of made) {
		const file = `${SCHEMAS_FOLDER}/${name}`;
		const text = schemaText(schema);
		const before = read(join(site.root, file));
		if (before !== text) out.push({ file, text, before });
	}
	let names: string[] = [];
	try {
		names = readdirSync(join(site.root, SCHEMAS_FOLDER));
	} catch {
		// No folder yet.
	}
	for (const name of names.sort()) {
		if (!name.endsWith('.schema.json') || made.has(name)) continue;
		const file = `${SCHEMAS_FOLDER}/${name}`;
		out.push({ file, text: null, before: read(join(site.root, file)) });
	}
	return out;
}

/** Write the schema files (astro dev's half). Returns what changed. */
export function writeSchemaFiles(site: Site): SchemaFileChange[] {
	const changes = schemaFileChanges(site);
	if (changes.length) mkdirSync(join(site.root, SCHEMAS_FOLDER), { recursive: true });
	for (const c of changes) {
		const path = join(site.root, c.file);
		if (c.text === null) rmSync(path, { force: true });
		else writeFileSync(path, c.text);
	}
	return changes;
}

export interface StampChange {
	file: string;
	text: string;
	before: string;
}

/** Content files whose `$schema` is missing or wrong, with their stamped text. A file that isn't JSON is left alone. */
export async function stampChanges(site: Site): Promise<StampChange[]> {
	const out: StampChange[] = [];
	for (const entry of await listDocuments(site)) {
		const before = read(join(site.root, entry.file));
		if (before === null) continue;
		const text = stampSchema(before, schemaRef(site.collections[entry.collection]!, entry.file));
		if (text !== before) out.push({ file: entry.file, text, before });
	}
	return out;
}

export interface SchemasResult {
	/** Schema files written or removed. */
	schemas: SchemaFileChange[];
	/** Content files given their `$schema`. */
	stamped: string[];
}

/** The whole command, on a resolved site. */
export async function runSchemas(site: Site): Promise<SchemasResult> {
	const schemas = writeSchemaFiles(site);
	const stamps = await stampChanges(site);
	for (const s of stamps) writeFileSync(join(site.root, s.file), s.text);
	return { schemas, stamped: stamps.map((s) => s.file) };
}

/** What `caracms schemas` prints for a result. */
export function schemasReport(result: SchemasResult): string {
	if (!result.schemas.length && !result.stamped.length) return 'caracms schemas: the schemas and every content file\'s $schema are up to date.\n';
	const lines: string[] = [];
	for (const c of result.schemas) lines.push(`  ${c.text === null ? 'removed' : 'wrote'} ${c.file}`);
	for (const f of result.stamped) lines.push(`  added $schema to ${f}`);
	return `caracms schemas:\n${lines.join('\n')}\n`;
}

/** The command's entry (bin/caracms.mjs loads this module through the site's Vite). */
export async function command(root: string): Promise<{ code: number; out: string }> {
	const result = await runSchemas(await loadSite(root));
	return { code: 0, out: schemasReport(result) };
}
