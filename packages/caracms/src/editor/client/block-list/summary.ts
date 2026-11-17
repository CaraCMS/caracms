/**
 * What a block row says about its block, pure for the unit tests:
 *
 *   blockSummary(site, block)   a known block's first lockup or text, else its first rich
 *                               text's words, else its first list item with words (a step, a
 *                               table's header cell), after a leading select's choice ("Tip · …");
 *                               an unknown block's type and what's kept
 *   keptSummary(data)           an unknown block's top-level keys, each with a short preview of
 *                               its value (Decision 21): `Heading: “Kind words” · Quotes: 3 items`
 *   blockIcon(type)             the sprite's block icon for a type, if it has one
 *   fieldsSummary(block)        the picker's line under a type: its fields' labels
 */
import { own, sharedEntryOf } from '../../../document.ts';
import { parseField, titleCase, type Field, type ListField } from '../../../fields.ts';
import { richTextPlain, type RichTextValue } from '../../../rich-text.ts';
import { itemSummary } from '../fields/list-summary.ts';
import type { EditorBlock, EditorSite, ListedDocument } from '../../types.ts';

/**
 * A page's shared entry (M5a Decision 8) as listed, when it renders: the shared block
 * exists and its type is one the site knows. Null for a block that isn't an entry, and
 * for an entry that's skipped (no such shared block, a type the code doesn't know, or a header's
 * or footer's block, edit in context Decision 2).
 */
export function sharedOf(site: Pick<EditorSite, 'blocks'>, documents: readonly ListedDocument[], block: Pick<EditorBlock, 'known' | 'data' | 'shared'>): ListedDocument | null {
	const name = sharedEntryOf(block);
	if (name === undefined) return null;
	const found = documents.find((d) => d.collection === 'shared' && d.path === name && !d.warning);
	// Edit in context, Decision 2: a header's or footer's block fills the page's frame, so an entry for one is skipped.
	return found && found.blockType && own(site.blocks, found.blockType) && !found.slot ? found : null;
}

/** Edit in context, Decision 2: the slot block a page's shared entry names (skipped on the page), or null. */
export function slotEntryOf(documents: readonly ListedDocument[], block: Pick<EditorBlock, 'known' | 'data' | 'shared'>): ListedDocument | null {
	const name = sharedEntryOf(block);
	if (name === undefined) return null;
	return documents.find((d) => d.collection === 'shared' && d.path === name && !d.warning && !!d.slot) ?? null;
}

/** "Used on 4 pages" (N counts documents of every collection), or "Not on any page yet". */
export const usedOnLine = (doc: Pick<ListedDocument, 'usedOn'>) => {
	const n = doc.usedOn?.length ?? 0;
	return n ? `Used on ${n} page${n === 1 ? '' : 's'}` : 'Not on any page yet';
};

/** A short preview of a value. */
export function previewValue(value: unknown, max = 24): string {
	if (value === null || value === undefined) return 'empty';
	if (typeof value === 'string') {
		const flat = value.replace(/\s+/g, ' ').trim();
		if (!flat) return 'empty';
		return `“${flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat}”`;
	}
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return 'empty';
		if (value.every((v) => typeof v === 'string')) return previewValue(value.join(' / '), max);
		return `${value.length} item${value.length === 1 ? '' : 's'}`;
	}
	if (typeof value === 'object') {
		const n = Object.keys(value as object).length;
		return n === 0 ? 'empty' : `${n} field${n === 1 ? '' : 's'}`;
	}
	return String(value);
}

/** An unknown block's kept keys (its `data` is its raw keys minus `type`), each with a preview. */
export function keptSummary(data: Record<string, unknown>): { key: string; label: string; preview: string }[] {
	return Object.entries(data).map(([key, value]) => ({ key, label: titleCase(key), preview: previewValue(value) }));
}

export function keptLine(data: Record<string, unknown>): string {
	const kept = keptSummary(data);
	return kept.length ? kept.map((k) => `${k.label}: ${k.preview}`).join(' · ') : 'Nothing but its type';
}

/**
 * The row's second line. A shared-block entry (M5a Decision 8) names its shared block.
 * M6 Decision 17: a block that picks one of the site's `forms` (a select of their ids, the
 * Form block) adds the form: "Get in touch · Contact form".
 */
export function blockSummary(site: Pick<EditorSite, 'blocks'>, block: EditorBlock, forms: readonly { id: string; label: string }[] = []): string {
	const shared = sharedEntryOf(block);
	if (shared !== undefined) return `Shared block · ${shared}`;
	if (!block.known) return `${block.type || 'No type'} · ${keptLine(block.data)}`;
	const fields = own(site.blocks, block.type)?.fields ?? {};
	const ids = forms.map((f) => f.id).sort().join('\n');
	const picker = ids ? Object.entries(fields).find(([, f]) => f.kind === 'select' && f.options.map((o) => o.value).sort().join('\n') === ids) : undefined;
	if (picker) {
		const chosen = forms.find((f) => f.id === block.data[picker[0]]);
		const first = firstText(fields, block);
		return `${first ? `${first} · ` : ''}${chosen ? `${chosen.label} form` : 'No form chosen'}`;
	}
	const first = firstText(fields, block);
	if (!first) return 'Nothing in it yet';
	// A block that opens with a select (an aside's kind) says its choice first: "Tip · Check the…".
	const [lead] = Object.entries(fields);
	if (lead && lead[1].kind === 'select') {
		const chosen = parseField(lead[1], block.data[lead[0]]);
		const label = lead[1].options.find((o) => o.value === chosen)?.label;
		if (label) return `${label} · ${first}`;
	}
	return first;
}

/**
 * The block's words: its first heading, lockup or text; failing those, its first rich text's
 * words; failing those, its first list item that has words (a steps block's first step, a
 * table's header cell, or its first row's label when the header is empty).
 */
function firstText(fields: Record<string, Field>, block: Pick<EditorBlock, 'data'>): string | null {
	return textPass(fields, block.data, false) ?? textPass(fields, block.data, true) ?? listPass(fields, block.data);
}

const noTitle = () => null;

/** The last pass: the first list (into groups) whose items include one with words, by the row's own summary. */
function listPass(fields: Record<string, Field>, data: Record<string, unknown>): string | null {
	for (const [key, field] of Object.entries(fields)) {
		const value = data[key];
		if (field.kind === 'group' && value && typeof value === 'object') {
			const inner = listPass(field.fields, value as Record<string, unknown>);
			if (inner) return inner;
		}
		if (field.kind !== 'list' || !Array.isArray(value)) continue;
		for (const item of value) {
			const words = flat(itemSummary(field as ListField, item, noTitle).main);
			if (words) return words;
		}
	}
	return null;
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** One pass over the fields (into groups); `rich` takes any rich-text field's words, not only a rich heading's. */
function textPass(fields: Record<string, Field>, data: Record<string, unknown>, rich: boolean): string | null {
	for (const [key, field] of Object.entries(fields)) {
		const value = data[key];
		// A group's own first text (a two-column block's left heading).
		if (field.kind === 'group' && value && typeof value === 'object') {
			const inner = textPass(field.fields, value as Record<string, unknown>, rich);
			if (inner) return inner;
		}
		if (rich) {
			if (field.kind === 'richText') {
				const words = flat(richTextPlain(parseField(field, value) as RichTextValue));
				if (words) return words;
			}
			continue;
		}
		if (field.kind === 'lockup' && value && typeof value === 'object') {
			const lines = (value as { lines?: string[] }).lines ?? [];
			if (lines.length) return lines.join(' / ');
		}
		if (field.kind === 'text' && typeof value === 'string' && value.trim()) return flat(value);
		// M9 Decision 11: a rich heading's words, without its bold.
		if (field.kind === 'richText' && field.heading) {
			const words = flat(richTextPlain(parseField(field, value) as RichTextValue));
			if (words) return words;
		}
	}
	return null;
}

/** The block icons the shell's sprite has (shell/Icons.tsx, `b-*`). */
const SPRITE = new Set(['hero', 'head', 'tm', 'cases', 'cta', 'footer', 'team', 'quote', 'gallery', 'video', 'form', 'faq']);

export function blockIcon(block: { type: string; known: boolean }): string {
	if (!block.known) return 'b-unknown';
	return SPRITE.has(block.type) ? `b-${block.type}` : 'b-tm';
}

export function fieldsSummary(schema: { fields: Record<string, { label?: string }> } | undefined): string {
	const labels = Object.entries(schema?.fields ?? {}).map(([key, f]) => f.label ?? titleCase(key));
	return labels.length ? labels.join(', ') : 'Nothing to set';
}
