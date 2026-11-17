/**
 * Form rows and sourced selects (Decisions 2, 3 and 5): what a sourced select offers, and the
 * titles of stored sourced values, read from the content as deployed. Server only (it reads the
 * disk through read.ts); `forms/rules.ts` and `forms/words.ts` take the results as plain data.
 *
 * - **Offered** (Decision 2): each document of the select's collection in the collection's own
 *   order (`documents()`, so a hand order holds), hidden and warned ones never, and with `where`
 *   only those whose toggle is on. A missing collection folder, or a read that fails, offers
 *   nothing (Decision 3: every sourced value is then refused).
 * - **Read at each call, never cached** outside a build: the endpoint checks a posted value
 *   against the content on the server's disk now, not the options baked into the page (check 4).
 * - **Titles** (Decision 5): a stored value's document's title whether or not it's still
 *   offered; a document that's gone, or a lookup that fails, has none (the stored value shows).
 */
import type { ResolvedSite } from '../config.ts';
import { diskSource, type ContentSource } from '../content.ts';
import type { DocumentReader } from '../document.ts';
import { documentReader } from '../read.ts';
import { rowCell, type FormSource, type FormSources, type OfferedDocument, type ResolvedForm, type SourceTitles } from './rules.ts';

type ReaderSite = Pick<ResolvedSite, 'root' | 'collections' | 'blocks'>;

/** Every sourced select of a form: its key in `FormSources` (the field's name, or `<field>.<column>`) and its source. */
export function sourcedSelects(form: Pick<ResolvedForm, 'fields'>): { key: string; source: FormSource }[] {
	const out: { key: string; source: FormSource }[] = [];
	for (const f of form.fields) {
		if (f.type === 'select' && f.source) out.push({ key: f.name, source: f.source });
		for (const c of f.columns ?? []) if (c.type === 'select' && c.source) out.push({ key: `${f.name}.${c.name}`, source: c.source });
	}
	return out;
}

/** A fresh reader on the disk (or the given source): nothing kept between submissions. */
export const formReader = (site: ReaderSite, source: ContentSource = diskSource): DocumentReader => documentReader(site, source);

/** The documents one source offers (Decision 2). Never throws: a failed read offers nothing, logged. */
async function offeredBy(reader: DocumentReader, source: FormSource, log: (line: string) => void): Promise<OfferedDocument[]> {
	try {
		const docs = await reader.documents(source.collection);
		return docs
			.filter((doc) => source.where === undefined || doc.data[source.where] === true)
			.map((doc) => ({ value: doc.path, label: doc.title, data: doc.data }));
	} catch (error) {
		log(`[caracms] forms: couldn't list the collection "${source.collection}" for a form's choices, so it offers none: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

/** What each sourced select of the form offers now (Decision 2), keyed as `FormSources` is. A form with none reads nothing. */
export async function readFormSources(reader: DocumentReader, form: Pick<ResolvedForm, 'fields'>, log: (line: string) => void = (line) => console.error(line)): Promise<FormSources> {
	const out: FormSources = {};
	await Promise.all(
		sourcedSelects(form).map(async ({ key, source }) => {
			out[key] = await offeredBy(reader, source, log);
		}),
	);
	return out;
}

/**
 * The titles of a submission's stored sourced values (Decision 5), by collection then path: each
 * sourced select's value, and each row's sourced cells. Never throws; a value with no document
 * (gone, or not a document path) is left out, so it shows as stored.
 */
export async function readSourceTitles(reader: DocumentReader, form: Pick<ResolvedForm, 'fields'> | null, fields: Readonly<Record<string, unknown>>): Promise<SourceTitles> {
	const wanted: { collection: string; path: string }[] = [];
	for (const f of form?.fields ?? []) {
		const value = Object.hasOwn(fields, f.name) ? fields[f.name] : undefined;
		if (f.type === 'select' && f.source && typeof value === 'string' && value) wanted.push({ collection: f.source.collection, path: value });
		if (f.type === 'rows' && Array.isArray(value)) {
			for (const c of f.columns ?? []) {
				if (c.type !== 'select' || !c.source) continue;
				for (const row of value) {
					const cell = rowCell(row, c.name);
					if (typeof cell === 'string' && cell) wanted.push({ collection: c.source.collection, path: cell });
				}
			}
		}
	}
	const titles: SourceTitles = {};
	await Promise.all(
		wanted.map(async ({ collection, path }) => {
			const doc = await reader.document(collection, path).catch(() => null);
			if (doc) (titles[collection] ??= {})[path] = doc.title;
		}),
	);
	return titles;
}

/** The titles of every document the form's sourced selects offer, by collection then path: the email's, for a submission just checked against them. */
export function titlesFromSources(form: Pick<ResolvedForm, 'fields'>, sources: FormSources): SourceTitles {
	const titles: SourceTitles = {};
	for (const { key, source } of sourcedSelects(form)) for (const doc of Object.hasOwn(sources, key) ? sources[key]! : []) (titles[source.collection] ??= {})[doc.value] = doc.label;
	return titles;
}
