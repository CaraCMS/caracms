/**
 * Images with no alt text in a document (M5b Decision 9's server half): what Publish's
 * summary names for each waiting document (`WaitingView.missingAlt`). It warns and never
 * blocks.
 *
 * - **Read from the text it's given**: the caller passes the document as it will publish
 *   (live/editor.ts: the autosave's text, else the `drafts` copy's).
 * - **Only rendered slots count**: a known block's media fields (a page's, or a shared
 *   block's own document), a fields document's or Site Settings' own fields, a section
 *   builder's page fields (M6c G2). Not an
 *   unknown block, nor a page's shared entry (its shared block lists its own images when
 *   it's waiting), nor a value of a kind the slot doesn't take (it isn't shown), nor the
 *   brand's logo and icon (Decision 11: they have no alt; the brand's name is it).
 * - **A decorative image never counts.** The rule is the field's own warning
 *   (fields.ts → `fieldWarnings`, code `missing-alt`), so the two never disagree, and its
 *   list indexes are the editor's rows.
 * - **The slot's label** (Decision 9): the block type's name plus "image" ("Hero image",
 *   "Text and media image"), with its position in a list ("Gallery image 3", and in an inner list "Partners image 2, logos 1"); in a fields
 *   document, the field's own label ("Cover image"). A block with more than one media
 *   field says which ("Hero background").
 */
import type { ResolvedCollection, ResolvedSite } from '../../../config.ts';
import { own, parseAnyDocument } from '../../../document.ts';
import { fieldAt, fieldHoldsMedia, fieldWarnings, isIndexPart, splitPath, titleCase, type Field, type Fields } from '../../../fields.ts';
import { parseSource } from '../../../json-source.ts';
import type { MissingAltView } from '../../types.ts';

type Site = Pick<ResolvedSite, 'blocks' | 'collections'>;

const labelOf = (key: string, field: Field) => field.label?.trim() || titleCase(key);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The list rows a path is in, outermost first: the index after each list on the way down
 * (`gallery.2.alt` → [2], through a group too: `left.gallery.0` → [0]; M7, an inner list:
 * `partners.1.logos.0.alt` → [1, 0]), each with its list's field.
 */
function rowsOf(fields: Fields, path: string): { row: number; list: Field; key: string }[] {
	const parts = splitPath(path);
	const out: { row: number; list: Field; key: string }[] = [];
	for (let i = 1; i < parts.length; i++) {
		const field = fieldAt(fields, parts.slice(0, i).join('.'));
		if (field?.kind === 'list' && isIndexPart(parts[i]!)) out.push({ row: Number(parts[i]), list: field, key: parts[i - 1]! });
	}
	return out;
}

/** The images with no alt text in one form's fields (a block's, or a fields document's). */
function slots(fields: Fields, data: Record<string, unknown>, block: number | null, owner: string | null): MissingAltView[] {
	const mediaFields = Object.entries(fields).filter(([, f]) => fieldHoldsMedia(f));
	const out: MissingAltView[] = [];
	for (const [key, field] of mediaFields) {
		let base: string;
		if (owner !== null) base = mediaFields.length === 1 ? `${owner} image` : `${owner} ${lowerFirst(labelOf(key, field))}`;
		else {
			const label = labelOf(key, field);
			base = /\bimage\b/i.test(label) ? label : `${label} image`;
		}
		for (const warning of fieldWarnings(field, data[key])) {
			if (warning.code !== 'missing-alt') continue;
			const path = `${key}.${warning.path}`;
			const [outer, inner] = rowsOf(fields, path);
			// M7: an inner list's image adds its own list and row ("Partners image 2, logos 1").
			const label = !outer ? base : `${base} ${outer.row + 1}${inner ? `, ${lowerFirst(labelOf(inner.key, inner.list))} ${inner.row + 1}` : ''}`;
			out.push({ block, field: key, path, row: outer ? outer.row : null, label });
		}
	}
	return out;
}

/**
 * Every image with no alt text that isn't decorative, in a document's text (any kind),
 * in document order. Empty for text that isn't a document (not JSON, a file no
 * collection holds).
 */
export function missingAltIn(site: Site, collectionName: string | null, text: string | null): MissingAltView[] {
	if (!collectionName || text === null) return [];
	const collection: ResolvedCollection | undefined = own(site.collections, collectionName);
	if (!collection) return [];
	let raw: unknown;
	try {
		raw = parseSource(text).value;
	} catch {
		return [];
	}
	const document = parseAnyDocument(raw, site, collection);
	switch (document.kind) {
		case 'fields':
			return slots(collection.fields ?? {}, document.data, null, null);
		case 'settings':
			// Only the site's own fields: `brand` (the logo and the icon) isn't one of them.
			return slots(collection.fields ?? {}, document.data, null, null);
		case 'shared': {
			const block = document.block;
			const schema = block.known ? own(site.blocks, block.type) : undefined;
			return schema ? slots(schema.fields, block.data, 0, schema.label) : [];
		}
		default:
			// M6c (G2): the page's own fields first (they come before the blocks), `block` null as a form's.
			return [...slots(collection.fields ?? {}, document.data ?? {}, null, null), ...document.blocks.flatMap((block, index) => {
				// An unknown block, or a shared entry (its own document carries its images), isn't counted here.
				if (!block.known || block.shared !== undefined) return [];
				const schema = own(site.blocks, block.type);
				return schema ? slots(schema.fields, block.data, index, schema.label) : [];
			})];
	}
}
