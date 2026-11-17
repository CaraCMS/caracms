/**
 * Writing a document back to its content file (Decision 7).
 *
 * **The write starts from the raw file as read and applies the editor's changes
 * field by field. A field the editor didn't touch is written back exactly as read,
 * its value and its position; only a touched field takes the schema's form, and a
 * touched block's keys take the schema's order, with unknown keys after in their
 * original order.** A block of a type the schema no longer knows is written back as
 * read. Two-space JSON with a trailing newline; an array of strings on one line.
 *
 * ## The API (Phases 2–4 call this)
 *
 *   applyEdits(base: string | null, edited: SiteDocument, site): string
 *
 * - `base` is the content file's text **as the editor read it** when it opened the
 *   document (the same text whose `blocks` the editor's `source` indexes point
 *   into), or `null` for a new document. Keep it for the whole editing session and
 *   pass the same `base` on every write: the rules are stated against the file as
 *   read, so writing "the document as edited" over the same base again and again is
 *   correct and idempotent (a field changed and changed back is untouched again).
 *   Re-reading the file between writes would invalidate the `source` indexes after a
 *   reorder. If the file changes on disk meanwhile, the last write wins (M3 →
 *   Watch-outs, accepted for local dev).
 * - `edited` is the whole document as the editor has it: `{ title, blocks }`, every
 *   block a DocumentBlock (document.ts). What the editor did is read from it:
 *     - **a field edit:** the block's `data[field]` differs from the file's parsed
 *       value. "Differs" compares parsed forms, so sending a value the file already
 *       holds in another spelling (a trailing space, a blank lockup line) is not an edit;
 *     - **reorder:** blocks appear in a new order, each keeping its `source`;
 *     - **add:** a block with `source: null` (a known type; start from `emptyBlock()`);
 *     - **remove:** a source index that no longer appears; **bring back** (Undo):
 *       the block reappears with its old `source`, and is written as read.
 *   An unknown block's `data` is ignored; it's always copied from the file. A block
 *   whose `type` the editor changed is written as a new block.
 * - Returns the file's new text. With nothing touched, that's `base` itself, byte
 *   for byte. Throws on a block with no `source` and an unknown type, a `source`
 *   that isn't in the base, or a base that isn't a JSON object.
 *
 * Untouched blocks and untouched fields are copied as their exact source text, so
 * a file written by hand in another layout keeps that layout where nothing changed.
 */
import type { ResolvedCollection, ResolvedSite } from './config.ts';
import {
	EDITORS_FIELD,
	own,
	parseBlock,
	parseDocument,
	parseFrame,
	parseSettingsBrand,
	type AnyDocument,
	type DocumentBlock,
	type FieldsDocument,
	type Frame,
	type SettingsBrand,
	type SettingsDocument,
	type SharedDocument,
	type SiteDocument,
} from './document.ts';
import { fieldToJson, isEmptyValue, parseField, type Field, type Fields } from './fields.ts';
import { mediaLine } from './media-value.ts';
import { parseRedirects } from './redirects.ts';
import { parsePageOrder } from './page-order.ts';
import { parsePageFolders, type PageFolder } from './page-folders.ts';
import { parseCollectionOrder } from './collection-order.ts';
import { member, parseSource, slice, type ArrayNode, type JsonNode, type MemberNode, type ObjectNode, type ParsedSource } from './json-source.ts';
import { isEmptySeo, parseFormRecipients, parseGoogleTag, parseSeo, seoText, type Seo } from './seo.ts';
import { SCHEMA_KEY } from './schema-key.ts';

const INDENT = '  ';
const pad = (depth: number) => INDENT.repeat(depth);

/**
 * Canonical JSON: two-space indent, one member per line, an array of strings on
 * one line (`["Play Hard", "Work Hard"]`), `[]` and `{}` when empty. No trailing
 * newline (applyEdits adds the file's).
 */
export function toJson(value: unknown, depth = 0): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		if (value.every((v) => typeof v === 'string')) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
		return `[\n${value.map((v) => pad(depth + 1) + toJson(v, depth + 1)).join(',\n')}\n${pad(depth)}]`;
	}
	const entries = Object.entries(value).filter(([, v]) => v !== undefined);
	if (entries.length === 0) return '{}';
	return `{\n${entries.map(([k, v]) => `${pad(depth + 1)}${JSON.stringify(k)}: ${toJson(v, depth + 1)}`).join(',\n')}\n${pad(depth)}}`;
}

/** A member list written as an object at `depth`, each value already rendered as text. */
function objectText(members: [string, string][], depth: number): string {
	if (members.length === 0) return '{}';
	return `{\n${members.map(([k, v]) => `${pad(depth + 1)}${JSON.stringify(k)}: ${v}`).join(',\n')}\n${pad(depth)}}`;
}

function arrayText(items: string[], depth: number): string {
	if (items.length === 0) return '[]';
	return `[\n${items.map((v) => pad(depth + 1) + v).join(',\n')}\n${pad(depth)}]`;
}

const same = (a: unknown, b: unknown) => toJson(a) === toJson(b);

/**
 * A field's value written as the file stores it, at `depth` (the depth of the
 * member holding it). toJson's canonical form, plus two field rules:
 * - **rich text: one block per line**, a list's items on its line
 *   (`{ "ul": ["First", "Second"] }`), M5a Decision 3;
 * - **a list of several fields: each item an object on its own lines**, its keys
 *   in schema order and each value by its own field's rule (Decision 5). A list of
 *   one field is toJson's: a flat array of strings on one line.
 * - **a group: an object on its own lines**, the same way as a list's item.
 */
export function fieldText(field: Field, value: unknown, depth: number): string {
	const stored = fieldToJson(field, value);
	return storedText(field, stored, depth);
}

function storedText(field: Field, stored: unknown, depth: number): string {
	if (field.kind === 'richText' && Array.isArray(stored)) {
		const lines = stored.map((entry) => {
			const [kind, v] = Object.entries(entry as Record<string, unknown>)[0]!;
			return `{ ${JSON.stringify(kind)}: ${toJson(v)} }`;
		});
		return lines.length === 0 ? '[]' : arrayText(lines, depth);
	}
	// M5b: a media value on one line, as the demo writes it (media-value.ts → mediaLine).
	if (field.kind === 'media') return mediaLine(stored);
	if (field.kind === 'list' && Array.isArray(stored)) {
		if (field.item) {
			const item = field.item;
			if (item.kind === 'media') return stored.length === 0 ? '[]' : arrayText(stored.map((v) => mediaLine(v)), depth);
			if (item.kind !== 'richText') return toJson(stored, depth);
			return stored.length === 0 ? '[]' : arrayText(stored.map((v) => storedText(item, v, depth + 1)), depth);
		}
		const fields = field.fields ?? {};
		const items = stored.map((v) => {
			const o = v as Record<string, unknown>;
			// M7: the item's unknown keys (fieldToJson keeps them, after the schema's), written as read.
			const extra = Object.keys(o).filter((key) => !Object.hasOwn(fields, key));
			return objectText([...Object.entries(fields).map(([key, f]): [string, string] => [key, storedText(f, o[key], depth + 2)]), ...extra.map((key): [string, string] => [key, toJson(o[key], depth + 2)])], depth + 1);
		});
		return items.length === 0 ? '[]' : arrayText(items, depth);
	}
	// A group: an object on its own lines, its keys in schema order, each value by its own field's rule.
	if (field.kind === 'group' && stored && typeof stored === 'object') {
		const o = stored as Record<string, unknown>;
		return objectText(Object.entries(field.fields).map(([key, f]): [string, string] => [key, storedText(f, o[key], depth + 1)]), depth);
	}
	return toJson(stored, depth);
}

/** The canonical text of a new document. */
export function serializeDocument(document: SiteDocument, site: Pick<ResolvedSite, 'blocks'>, pageFields: Fields | null = null): string {
	return applyEdits(null, document, site, pageFields);
}

/**
 * `pageFields`: the collection's page fields (M6c G2; ResolvedCollection → `fields`), or
 * null. They're written per key, as a fields document's are: `edited.data` absent leaves
 * the file's as they are; a key the edit changes is written in place, or, new to the
 * file, after the key before it in schema order (`title` first, so before `blocks`). A
 * new file has `title`, every page field with a value, `blocks`, then `seo`.
 */
export function applyEdits(base: string | null, edited: SiteDocument, site: Pick<ResolvedSite, 'blocks'>, pageFields: Fields | null = null): string {
	const fields = pageFields ?? {};
	const values = edited.data;
	if (base === null) {
		const blocks = edited.blocks.map((b) => newBlockText(b, site, 2));
		const seo = parseSeo(edited.seo);
		const members: [string, string][] = [['title', JSON.stringify(edited.title)]];
		for (const [key, field] of Object.entries(fields)) {
			if (!values || !Object.hasOwn(values, key)) continue;
			const value = parseField(field, values[key]);
			if (!isEmptyValue(field, value)) members.push([key, fieldText(field, value, 1)]);
		}
		members.push(['blocks', arrayText(blocks, 1)]);
		if (!isEmptySeo(seo)) members.push(['seo', seoText(seo, 1)]);
		// M9 Decision 7: `hidden` right after `title` (where the Tina script writes it).
		if (edited.hidden) members.splice(1, 0, ['hidden', 'true']);
		// Edit in context, Decision 3: the page's picks after those.
		const frame = frameEditText(edited.frame, undefined);
		if (frame?.text) members.splice(edited.hidden ? 2 : 1, 0, ['frame', frame.text]);
		return `${objectText(members, 0)}\n`;
	}

	const source = parseSource(base);
	if (source.root.kind !== 'object') throw new Error('applyEdits: the base file is not a JSON object');
	const root = source.root;
	const read = parseDocument(source.value, site);
	const blocksMember = member(root, 'blocks');
	const rawBlocks: JsonNode[] = blocksMember?.value.kind === 'array' ? (blocksMember.value as ArrayNode).items : [];

	// Blocks, each as text at depth 2 (inside the top-level `blocks` array).
	const used = new Set<number>();
	let blocksChanged = edited.blocks.length !== rawBlocks.length;
	const blockTexts = edited.blocks.map((block, position) => {
		const { text, changed } = blockText(block, position);
		if (changed) blocksChanged = true;
		return text;
	});

	function blockText(block: DocumentBlock, position: number): { text: string; changed: boolean } {
		if (block.source === null || block.source === undefined) return { text: newBlockText(block, site, 2), changed: true };
		const index = block.source;
		if (!Number.isInteger(index) || index < 0 || index >= rawBlocks.length) {
			throw new Error(`applyEdits: block ${position} has source ${index}, which isn't a block in the base file`);
		}
		if (used.has(index)) {
			// The same source twice: the copy is a new block (an unknown one can't be copied).
			return { text: newBlockText({ ...block, source: null }, site, 2), changed: true };
		}
		used.add(index);
		const raw = rawBlocks[index]!;
		const was = read.blocks[index]!;
		const moved = index !== position;
		if (!was.known) return { text: slice(source, raw), changed: moved };
		if (block.type !== was.type) return { text: newBlockText({ ...block, source: null }, site, 2), changed: true };

		const text = knownBlockText(source, raw as ObjectNode, was, block, site, 2);
		return text === null ? { text: slice(source, raw), changed: moved } : { text, changed: true };
	}

	const titleChanged = edited.title !== read.title;
	// M6 Decision 13: the page's `seo`, per key: absent from the edit, untouched; emptied, removed.
	const seo = seoEdit(edited.seo, (source.value as Record<string, unknown>).seo);
	// M6c (G2): the page fields, per key: each one the edit changes (compared parsed).
	const fieldTexts = new Map<string, string>();
	if (values) {
		const raw = source.value as Record<string, unknown>;
		for (const [key, field] of Object.entries(fields)) {
			if (!Object.hasOwn(values, key)) continue;
			const value = parseField(field, values[key]);
			if (!same(value, parseField(field, raw[key]))) fieldTexts.set(key, fieldText(field, value, 1));
		}
	}
	// M9 Decision 7: `hidden` per edit: absent, untouched; true adds it after `title`; false takes it out.
	const hiddenEdit = edited.hidden === undefined || edited.hidden === (read.hidden === true) ? null : edited.hidden;
	if (hiddenEdit !== null) fieldTexts.set('hidden', 'true');
	// Edit in context, Decision 3: `frame` the same way: absent, untouched; picks written; none left, taken out.
	const frame = frameEditText(edited.frame, (source.value as Record<string, unknown>).frame);
	if (frame?.text) fieldTexts.set('frame', frame.text);
	if (!titleChanged && !blocksChanged && !seo && !frame && fieldTexts.size === 0) return base;

	const replacements = new Map<string, string>();
	if (titleChanged) replacements.set('title', JSON.stringify(edited.title));
	if (blocksChanged) replacements.set('blocks', arrayText(blockTexts, 1));
	if (seo?.text) replacements.set('seo', seo.text);

	let out = replacements.size ? replaceTopLevel(source, root, replacements) : source.text;
	if (seo && !seo.text) out = removeTopLevel(out, 'seo');
	if (hiddenEdit === false) {
		fieldTexts.delete('hidden');
		out = removeTopLevel(out, 'hidden');
	}
	if (frame && !frame.text) out = removeTopLevel(out, 'frame');
	if (fieldTexts.size) {
		const next = parseSource(out);
		if (next.root.kind === 'object') out = spliceKeys(next, next.root, fieldTexts, ['title', 'hidden', 'holds', 'frame', ...Object.keys(fields)]);
	}
	return withTrailingNewline(out);
}

/**
 * Edit in context, Decision 3: a `frame` edit against the file's, as `seoEdit`: null when
 * untouched (absent from the edit, or the same picks); `{ text }` to write; `{ text: null }` to
 * take the key out (every pick cleared). The picks are written header first, then footer.
 */
function frameEditText(edited: Frame | undefined, raw: unknown): { text: string | null } | null {
	if (edited === undefined) return null;
	const next = parseFrame(edited);
	if (raw !== undefined && same(next, parseFrame(raw))) return null;
	if (raw === undefined && Object.keys(next).length === 0) return null;
	return { text: Object.keys(next).length ? toJson(next, 1) : null };
}

/**
 * A `seo` edit against the file's (M6 Decision 13): null when untouched (absent from the
 * edit, or the same once parsed); `{ text }` to write; `{ text: null }` to remove the key
 * (the last part cleared). A file that never had one and an edit that sets nothing: untouched.
 */
function seoEdit(edited: Seo | undefined, raw: unknown): { text: string | null } | null {
	if (edited === undefined) return null;
	const next = parseSeo(edited);
	if (same(next, parseSeo(raw))) return null;
	return { text: isEmptySeo(next) ? null : seoText(next, 1) };
}

/** Take a top-level member out of a file's text, keeping everything else as it is. */
export function removeTopLevel(text: string, key: string): string {
	const source = parseSource(text);
	if (source.root.kind !== 'object') return text;
	const root = source.root;
	const members = root.members;
	const index = members.findIndex((m) => m.key === key);
	if (index === -1) return text;
	const m = members[index]!;
	if (members.length === 1) return text.slice(0, root.start) + '{}' + text.slice(root.end);
	if (index > 0) return text.slice(0, members[index - 1]!.value.end) + text.slice(m.value.end);
	// The first member: from its key's quote to the next member's.
	const keyStart = text.indexOf('"', root.start);
	const nextKey = text.indexOf('"', m.value.end);
	return text.slice(0, keyStart) + text.slice(nextKey);
}

/**
 * A known block as read (`was`, from `raw`) with the editor's `block` applied, as
 * text at `depth`; null when no field was touched (copy it as read). A touched
 * block: `type`, then the schema's fields in schema order, then unknown keys as read.
 */
function knownBlockText(source: ParsedSource, node: ObjectNode, was: DocumentBlock, block: DocumentBlock, site: Pick<ResolvedSite, 'blocks'>, depth: number): string | null {
	const schema = own(site.blocks, was.type)!;
	const touched = Object.entries(schema.fields).filter(([key, field]) => !same(parseField(field, block.data[key]), was.data[key]));
	if (touched.length === 0) return null;
	const touchedKeys = new Set(touched.map(([key]) => key));
	const members: [string, string][] = [];
	const typeMember = member(node, 'type');
	members.push(['type', typeMember ? slice(source, typeMember.value) : JSON.stringify(was.type)]);
	for (const [key, field] of Object.entries(schema.fields)) {
		const m = member(node, key);
		if (touchedKeys.has(key)) members.push([key, fieldText(field, block.data[key], depth + 1)]);
		else if (m) members.push([key, slice(source, m.value)]);
	}
	const emitted = new Set(members.map(([k]) => k));
	for (const m of node.members) {
		if (emitted.has(m.key)) continue;
		emitted.add(m.key);
		members.push([m.key, slice(source, member(node, m.key)!.value)]);
	}
	return objectText(members, depth);
}

/** A block the file doesn't have (added, or retyped): `type`, then every schema field. */
function newBlockText(block: DocumentBlock, site: Pick<ResolvedSite, 'blocks'>, depth: number): string {
	// A shared entry added in the editor (M5a Decision 8, the picker's Shared blocks): the
	// shared block's path and nothing else, on one line as the demo writes it.
	if (typeof block.shared === 'string') return `{ "shared": ${JSON.stringify(block.shared)} }`;
	const schema = own(site.blocks, block.type);
	if (!schema) throw new Error(`applyEdits: a new block has the unknown type "${block.type}"`);
	const members: [string, string][] = [['type', JSON.stringify(block.type)]];
	for (const [key, field] of Object.entries(schema.fields)) {
		members.push([key, fieldText(field, block.data[key], depth + 1)]);
	}
	return objectText(members, depth);
}

/**
 * Replace top-level members' values in place, keeping the rest of the file's text
 * as it is. A key the file doesn't have yet is added at the end of the object.
 */
function replaceTopLevel(source: ParsedSource, root: ObjectNode, replacements: Map<string, string>): string {
	const missing = [...replacements.keys()].filter((key) => !member(root, key));
	if (missing.length > 0) {
		// Rebuild the top level: its members as read, in order, then the new keys.
		const members: [string, string][] = [];
		const seen = new Set<string>();
		for (const m of root.members) {
			if (seen.has(m.key)) continue;
			seen.add(m.key);
			members.push([m.key, replacements.get(m.key) ?? slice(source, member(root, m.key)!.value)]);
		}
		for (const key of missing) members.push([key, replacements.get(key)!]);
		return source.text.slice(0, root.start) + objectText(members, 0) + source.text.slice(root.end);
	}
	const edits = [...replacements].map(([key, text]) => ({ node: member(root, key)!.value, text })).sort((a, b) => b.node.start - a.node.start);
	let out = source.text;
	for (const { node, text } of edits) out = out.slice(0, node.start) + text + out.slice(node.end);
	return out;
}

function withTrailingNewline(text: string): string {
	return text.endsWith('\n') ? text : `${text}\n`;
}

// ── The other kinds of document (M5a) ─────────────────────────────────────────

/**
 * One top-level key of a document written per key (Decision 7): how its value
 * parses (to compare the editor's with the file's) and how a touched one is written.
 */
interface KeyCodec {
	parse(raw: unknown): unknown;
	text(value: unknown, depth: number): string;
	/** Nothing set (a new file leaves it out). */
	empty(value: unknown): boolean;
	/** M6: an edit that empties it takes the key out of the file (`seo`, `googleTag`, `formRecipients`). */
	removeWhenEmpty?: boolean;
}

/** M6 Decision 13: a page's `seo`, and Site Settings' defaults. */
const seoCodec: KeyCodec = { parse: parseSeo, text: seoText, empty: (v) => isEmptySeo(parseSeo(v)), removeWhenEmpty: true };
/** M6 Decision 16: the Google tag's ID, trimmed. */
const googleTagCodec: KeyCodec = { parse: parseGoogleTag, text: (v) => JSON.stringify(parseGoogleTag(v)), empty: (v) => parseGoogleTag(v) === '', removeWhenEmpty: true };
/** M6 Decision 14: one list of addresses per form, each on one line. */
const recipientsCodec: KeyCodec = {
	parse: parseFormRecipients,
	text: (v, depth) => toJson(parseFormRecipients(v), depth),
	empty: (v) => Object.keys(parseFormRecipients(v)).length === 0,
	removeWhenEmpty: true,
};

/** Pre-M7 item 8: the redirects, one `{ "from", "to" }` per line. */
const redirectsCodec: KeyCodec = {
	parse: parseRedirects,
	text: (v, depth) => {
		const list = parseRedirects(v);
		if (list.length === 0) return '[]';
		return `[\n${list.map((r) => `${pad(depth + 1)}{ "from": ${JSON.stringify(r.from)}, "to": ${JSON.stringify(r.to)} }`).join(',\n')}\n${pad(depth)}]`;
	},
	empty: (v) => parseRedirects(v).length === 0,
	removeWhenEmpty: true,
};

/** Arrange pages (Decision 6): the saved order, one parent's list per line. */
const pageOrderCodec: KeyCodec = {
	parse: parsePageOrder,
	text: (v, depth) => {
		const entries = Object.entries(parsePageOrder(v));
		if (entries.length === 0) return '{}';
		return `{\n${entries.map(([k, list]) => `${pad(depth + 1)}${JSON.stringify(k)}: [${list.map((s) => JSON.stringify(s)).join(', ')}]`).join(',\n')}\n${pad(depth)}}`;
	},
	empty: (v) => Object.keys(parsePageOrder(v)).length === 0,
	removeWhenEmpty: true,
};

/** Page folders: each level's folders, one folder per line. */
const pageFoldersCodec: KeyCodec = {
	parse: parsePageFolders,
	text: (v, depth) => {
		const entries = Object.entries(parsePageFolders(v)).filter(([, list]) => list.length > 0);
		if (entries.length === 0) return '{}';
		const folder = (f: PageFolder) => `{ "id": ${JSON.stringify(f.id)}, "name": ${JSON.stringify(f.name)}, "pages": [${f.pages.map((s) => JSON.stringify(s)).join(', ')}] }`;
		return `{\n${entries.map(([k, list]) => `${pad(depth + 1)}${JSON.stringify(k)}: [\n${list.map((f) => `${pad(depth + 2)}${folder(f)}`).join(',\n')}\n${pad(depth + 1)}]`).join(',\n')}\n${pad(depth)}}`;
	},
	empty: (v) => Object.values(parsePageFolders(v)).every((list) => list.length === 0),
	removeWhenEmpty: true,
};

/** Review gaps (Decision 2): the manual collections' hand orders, one collection's list per line (pageOrder's layout). */
const collectionOrderCodec: KeyCodec = { ...pageOrderCodec, parse: parseCollectionOrder };

/** A form's words with only the ones set: no blank word, no group left empty (null when none is set). */
function setWords(value: unknown): unknown {
	if (typeof value === 'string') return value.trim() === '' ? null : value;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		const kept = setWords(v);
		if (kept !== null) out[key] = kept;
	}
	return Object.keys(out).length ? out : null;
}

/**
 * Review gaps (Decision 9a, Watch-outs): the forms' words, written with only the ones set, so Site
 * Settings stays empty until the agency changes one (a blank word uses the code's, the config's or
 * the package's). Emptied, the key goes.
 */
const formWordsCodec = (field: Field): KeyCodec => ({
	parse: (raw) => setWords(parseField(field, raw)) ?? {},
	text: (value, depth) => toJson(setWords(value) ?? {}, depth),
	empty: (value) => setWords(value) === null,
	removeWhenEmpty: true,
});

const fieldCodec = (field: Field): KeyCodec => ({
	parse: (raw) => parseField(field, raw),
	text: (value, depth) => fieldText(field, value, depth),
	empty: (value) => isEmptyValue(field, value),
});

/** Site Settings' `brand` (Decision 10): `{ "name", "accent" }`, on its own lines; M5b's `logo` and `icon` after them when set, each on one line. */
const brandCodec: KeyCodec = {
	parse: parseSettingsBrand,
	text: (value, depth) => {
		const brand = parseSettingsBrand(value) as SettingsBrand;
		const members: [string, string][] = [['name', JSON.stringify(brand.name)], ['accent', JSON.stringify(brand.accent)]];
		for (const key of ['logo', 'icon'] as const) {
			const image = brand[key];
			if (image) members.push([key, `{ ${Object.entries(image).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`]);
		}
		return objectText(members, depth);
	},
	empty: (value) => {
		const brand = parseSettingsBrand(value);
		return brand.name === '' && brand.accent === '' && !brand.logo && !brand.icon;
	},
};

/** A fields collection's keys, or Site Settings' (the package's `editors` and `brand`, then the site's own). */
function codecsFor(collection: Pick<ResolvedCollection, 'kind' | 'fields'>): Map<string, KeyCodec> {
	const codecs = new Map<string, KeyCodec>();
	if (collection.kind === 'settings') {
		codecs.set('editors', fieldCodec(EDITORS_FIELD));
		codecs.set('brand', brandCodec);
		// M6 Decision 14: Site Settings' search and sharing defaults, the Google tag, the form emails' recipients.
		codecs.set('seo', seoCodec);
		codecs.set('googleTag', googleTagCodec);
		codecs.set('formRecipients', recipientsCodec);
		codecs.set('redirects', redirectsCodec);
		codecs.set('pageOrder', pageOrderCodec);
		codecs.set('pageFolders', pageFoldersCodec);
		codecs.set('collectionOrder', collectionOrderCodec);
	}
	for (const [key, field] of Object.entries(collection.fields ?? ({} as Fields))) codecs.set(key, collection.kind === 'settings' && key === 'formWords' ? formWordsCodec(field) : fieldCodec(field));
	return codecs;
}

/**
 * Write a fields document or Site Settings back to its file, **per key** (M5a
 * Decision 7, M3 Decision 7's rule): an untouched key is written back exactly as
 * read, its text and its position; a touched key takes the schema's form, in place
 * when the file has it, else after the key before it in schema order (`title` first);
 * keys the schema doesn't know stay where they are. With nothing touched, that's
 * `base` byte for byte. `base` null: a new file, `title` then every key `edited.data`
 * has that isn't empty (fields.ts → isEmptyValue), in schema order: `{ data: {} }` is
 * `{ "title" }`, Decision 11's new document.
 */
export function applyKeyedEdits(
	base: string | null,
	edited: { title: string; data: Record<string, unknown>; seo?: Seo; frame?: Frame },
	collection: Pick<ResolvedCollection, 'kind' | 'fields'>,
): string {
	// Edit in context, Decision 3: a fields document's page picks, after its title.
	const frameEdit = collection.kind === 'fields' ? edited.frame : undefined;
	const codecs = codecsFor(collection);
	// M6 Decision 13: a fields document's `seo` is the document's own (beside `data`, as on a page), after its fields.
	const values = new Map<string, unknown>();
	for (const key of codecs.keys()) if (Object.hasOwn(edited.data, key)) values.set(key, edited.data[key]);
	if (collection.kind === 'fields') {
		codecs.set('seo', seoCodec);
		if (edited.seo !== undefined) values.set('seo', edited.seo);
		else values.delete('seo');
	}
	if (base === null) {
		const members: [string, string][] = [['title', JSON.stringify(edited.title)]];
		for (const [key, codec] of codecs) {
			if (!values.has(key)) continue;
			const value = codec.parse(values.get(key));
			if (!codec.empty(value)) members.push([key, codec.text(value, 1)]);
		}
		const frame = frameEditText(frameEdit, undefined);
		if (frame?.text) members.splice(1, 0, ['frame', frame.text]);
		return `${objectText(members, 0)}\n`;
	}
	const source = parseSource(base);
	if (source.root.kind !== 'object') throw new Error('applyEdits: the base file is not a JSON object');
	const root = source.root;
	const raw = source.value as Record<string, unknown>;
	const replacements = new Map<string, string>();
	const removals: string[] = [];
	if (edited.title !== (typeof raw.title === 'string' ? raw.title : '')) replacements.set('title', JSON.stringify(edited.title));
	for (const [key, codec] of codecs) {
		if (!values.has(key)) continue;
		const value = codec.parse(values.get(key));
		if (same(value, codec.parse(raw[key]))) continue;
		if (codec.removeWhenEmpty && codec.empty(value)) {
			if (Object.hasOwn(raw, key)) removals.push(key);
		} else replacements.set(key, codec.text(value, 1));
	}
	const frame = frameEditText(frameEdit, raw.frame);
	if (frame?.text) replacements.set('frame', frame.text);
	else if (frame) removals.push('frame');
	if (replacements.size === 0 && removals.length === 0) return base;
	let out = replacements.size ? spliceKeys(source, root, replacements, ['title', 'frame', ...codecs.keys()]) : source.text;
	for (const key of removals) out = removeTopLevel(out, key);
	return withTrailingNewline(out);
}

/**
 * Replace (or add) top-level members' values in the file's text. A key the file has
 * is replaced in place; a missing one goes after the nearest key before it in
 * `order` that the file has (first when there's none). Everything else is the
 * file's own text.
 */
function spliceKeys(source: ParsedSource, root: ObjectNode, replacements: Map<string, string>, order: readonly string[]): string {
	interface Edit {
		at: number;
		end: number;
		text: string;
	}
	const edits: Edit[] = [];
	for (const [key, text] of replacements) {
		const m = member(root, key);
		if (m) {
			edits.push({ at: m.value.start, end: m.value.end, text });
			continue;
		}
		// After the nearest earlier key the file has (schema order), else first: after `$schema`, which stays first (M8 Decision 14).
		let after: MemberNode | undefined;
		for (const k of [SCHEMA_KEY, ...order.slice(0, Math.max(0, order.indexOf(key)))]) after = member(root, k) ?? after;
		const line = `${pad(1)}${JSON.stringify(key)}: ${text}`;
		if (root.members.length === 0) {
			edits.push({ at: root.start, end: root.end, text: `{\n${line}\n}` });
		} else if (after) {
			edits.push({ at: after.value.end, end: after.value.end, text: `,\n${line}` });
		} else {
			// Before the first member: its key's quote is the first one after the brace.
			const keyStart = source.text.indexOf('"', root.start);
			edits.push({ at: keyStart, end: keyStart, text: `${line.trimStart()},\n${pad(1)}` });
		}
	}
	// Apply from the end of the text; several inserts at one point keep their order.
	let out = source.text;
	const byPoint = new Map<number, Edit[]>();
	for (const e of edits) byPoint.set(e.at, [...(byPoint.get(e.at) ?? []), e]);
	for (const at of [...byPoint.keys()].sort((a, b) => b - a)) {
		const group = byPoint.get(at)!;
		const replace = group.find((e) => e.end !== e.at);
		const inserts = group.filter((e) => e.end === e.at);
		if (replace) out = out.slice(0, replace.at) + replace.text + inserts.map((e) => e.text).join('') + out.slice(replace.end);
		else out = out.slice(0, at) + inserts.map((e) => e.text).join('') + out.slice(at);
	}
	return out;
}

/**
 * Write a shared block back to its file (Decision 8): `title` per key; the block, if
 * a field was touched, as a touched block is on a page (`type`, the schema's fields
 * in order, unknown keys after); an unknown type, or an untouched block, as read.
 * `base` null: a new file, `{ "title", "block": { "type", …every field } }`.
 */
export function applySharedEdits(base: string | null, edited: SharedDocument, site: Pick<ResolvedSite, 'blocks'>): string {
	if (base === null) {
		const block = own(site.blocks, edited.block.type) ? newBlockText(edited.block, site, 1) : objectText([['type', JSON.stringify(edited.block.type)]], 1);
		// Edit in context, Decision 3: a slot's default says so beside its block.
		return `${objectText([['title', JSON.stringify(edited.title)], ...(edited.default ? [['default', 'true'] as [string, string]] : []), ['block', block]], 0)}\n`;
	}
	const source = parseSource(base);
	if (source.root.kind !== 'object') throw new Error('applyEdits: the base file is not a JSON object');
	const root = source.root;
	const raw = source.value as Record<string, unknown>;
	const replacements = new Map<string, string>();
	if (edited.title !== (typeof raw.title === 'string' ? raw.title : '')) replacements.set('title', JSON.stringify(edited.title));
	const blockMember = member(root, 'block');
	const was = parseBlock(raw.block, 0, site);
	if (!was.known || !blockMember || blockMember.value.kind !== 'object') {
		// Unknown, or not a block at all: kept as read, unless the editor gave it a known type.
		if (edited.block.known && own(site.blocks, edited.block.type) && edited.block.type !== was.type) replacements.set('block', newBlockText(edited.block, site, 1));
	} else if (edited.block.type !== was.type) {
		if (own(site.blocks, edited.block.type)) replacements.set('block', newBlockText(edited.block, site, 1));
	} else {
		const text = knownBlockText(source, blockMember.value as ObjectNode, was, edited.block, site, 1);
		if (text !== null) replacements.set('block', text);
	}
	// Edit in context, Decision 3: `default` as `hidden` is: true adds it, false takes it out, absent leaves it.
	const wasDefault = raw.default === true;
	if (edited.default === true && !wasDefault) replacements.set('default', 'true');
	const removeDefault = edited.default === false && Object.hasOwn(raw, 'default');
	if (replacements.size === 0 && !removeDefault) return base;
	const out = replacements.size ? spliceKeys(source, root, replacements, ['title', 'default', 'block']) : source.text;
	return withTrailingNewline(removeDefault ? removeTopLevel(out, 'default') : out);
}

/**
 * Any document's write (the write route and live mode's autosave call this): by its
 * collection's kind, the section builder's applyEdits, the shared block's, or the
 * per-key writer for a fields document and Site Settings. A document of the wrong
 * kind for its collection is refused (throws).
 */
export function applyDocumentEdits(
	base: string | null,
	edited: AnyDocument,
	site: Pick<ResolvedSite, 'blocks'>,
	collection: Pick<ResolvedCollection, 'kind' | 'fields'>,
): string {
	const kind = edited.kind ?? 'sections';
	if (kind !== collection.kind) throw new Error(`a ${kind} document can't be written to a ${collection.kind} collection`);
	switch (edited.kind) {
		case 'fields':
		case 'settings':
			return applyKeyedEdits(base, edited as FieldsDocument | SettingsDocument, collection);
		case 'shared':
			return applySharedEdits(base, edited, site);
		default:
			return applyEdits(base, edited as SiteDocument, site, collection.fields);
	}
}

// ── A whole file in the form a save writes (M8 trial; an adoption trial, item 7) ─────

/** How a value is laid out: the serialiser's per-field rules, keyed by what holds it. */
type Shape =
	| { kind: 'plain' }
	| { kind: 'inline' }
	| { kind: 'rich' }
	| { kind: 'list'; item: Shape }
	| { kind: 'object'; keys: ReadonlyMap<string, Shape> };

const PLAIN: Shape = { kind: 'plain' };
const INLINE: Shape = { kind: 'inline' };

function shapeOf(field: Field): Shape {
	switch (field.kind) {
		case 'media':
			return INLINE;
		case 'richText':
			return { kind: 'rich' };
		case 'group':
			return { kind: 'object', keys: shapesOf(field.fields) };
		case 'list':
			if (field.item) return field.item.kind === 'media' ? { kind: 'list', item: INLINE } : field.item.kind === 'richText' ? { kind: 'list', item: { kind: 'rich' } } : PLAIN;
			return { kind: 'list', item: { kind: 'object', keys: shapesOf(field.fields ?? {}) } };
		default:
			return PLAIN;
	}
}

const shapesOf = (fields: Fields): Map<string, Shape> => new Map(Object.entries(fields).map(([k, f]) => [k, shapeOf(f)]));

/** One value on one line, as mediaLine and newBlockText's shared entry write it: `{ "key": "…", "focal": [0.5, 0.5] }`. */
function inlineText(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(inlineText).join(', ')}]`;
	const entries = Object.entries(value);
	return entries.length ? `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inlineText(v)}`).join(', ')} }` : '{}';
}

function layout(value: unknown, shape: Shape, depth: number): string {
	if (value === null || typeof value !== 'object') return toJson(value, depth);
	switch (shape.kind) {
		case 'inline':
			return inlineText(value);
		case 'rich':
			// storedText's rule: one block per line, its value as toJson writes it.
			if (!Array.isArray(value)) return toJson(value, depth);
			return arrayText(
				value.map((entry) =>
					entry && typeof entry === 'object' && !Array.isArray(entry)
						? `{ ${Object.entries(entry).map(([k, v]) => `${JSON.stringify(k)}: ${toJson(v)}`).join(', ')} }`
						: toJson(entry),
				),
				depth,
			);
		case 'list':
			if (!Array.isArray(value)) return toJson(value, depth);
			return arrayText(value.map((v) => layout(v, shape.item, depth + 1)), depth);
		case 'object': {
			if (Array.isArray(value)) return toJson(value, depth);
			return objectText(Object.entries(value).map(([k, v]): [string, string] => [k, layout(v, shape.keys.get(k) ?? PLAIN, depth + 1)]), depth);
		}
		default:
			return toJson(value, depth);
	}
}

/** A block, or a page's `{ "shared": … }` entry (on one line, as newBlockText writes it); an unknown type's keys as toJson writes them. */
function blockShape(raw: unknown, site: Pick<ResolvedSite, 'blocks'>): Shape {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return PLAIN;
	const o = raw as Record<string, unknown>;
	if (typeof o.shared === 'string' && o.type === undefined) return INLINE;
	const schema = typeof o.type === 'string' ? own(site.blocks, o.type) : undefined;
	return { kind: 'object', keys: schema ? shapesOf(schema.fields) : new Map() };
}

const SEO_SHAPE: Shape = { kind: 'object', keys: new Map([['image', INLINE]]) };

/**
 * A content file's text as the editor's save writes it (two-space JSON, one member per line,
 * a string array on one line, a media value on one line, rich text one block per line, a
 * trailing newline: the rules above, by the collection's kind and fields), **with every key
 * where it is and every value as it is**: only the whitespace changes. Null when the text
 * isn't a JSON object. `validate` warns on a file that differs; `validate --fix` writes this.
 */
export function savedForm(text: string, collection: Pick<ResolvedCollection, 'kind' | 'fields'>, site: Pick<ResolvedSite, 'blocks'>): string | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const keys = shapesOf(collection.fields ?? {});
	keys.set('seo', SEO_SHAPE);
	if (collection.kind === 'sections') {
		const members = Object.entries(raw).map(([k, v]): [string, string] => {
			if (k === 'blocks' && Array.isArray(v)) return [k, arrayText(v.map((b) => layout(b, blockShape(b, site), 2)), 1)];
			return [k, layout(v, keys.get(k) ?? PLAIN, 1)];
		});
		return `${objectText(members, 0)}\n`;
	}
	if (collection.kind === 'shared') {
		const block = (raw as Record<string, unknown>).block;
		keys.set('block', blockShape(block, site));
	}
	if (collection.kind === 'settings') {
		// brandCodec: logo and icon on one line each; redirectsCodec: one redirect per line.
		keys.set('brand', { kind: 'object', keys: new Map([['logo', INLINE], ['icon', INLINE]]) });
		keys.set('redirects', { kind: 'list', item: INLINE });
		// pageOrderCodec: one parent's list per line.
		const order = (raw as Record<string, unknown>).pageOrder;
		if (order && typeof order === 'object' && !Array.isArray(order)) keys.set('pageOrder', { kind: 'object', keys: new Map(Object.keys(order).map((k) => [k, INLINE])) });
		// pageFoldersCodec: one folder per line.
		const folders = (raw as Record<string, unknown>).pageFolders;
		if (folders && typeof folders === 'object' && !Array.isArray(folders)) keys.set('pageFolders', { kind: 'object', keys: new Map(Object.keys(folders).map((k) => [k, { kind: 'list', item: INLINE }])) });
		const hand = (raw as Record<string, unknown>).collectionOrder;
		if (hand && typeof hand === 'object' && !Array.isArray(hand)) keys.set('collectionOrder', { kind: 'object', keys: new Map(Object.keys(hand).map((k) => [k, INLINE])) });
	}
	return `${layout(raw, { kind: 'object', keys }, 0)}\n`;
}
