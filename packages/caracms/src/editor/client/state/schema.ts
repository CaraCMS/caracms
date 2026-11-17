/**
 * The fields a block of the open document has (M5a Phase 5): a block's schema in a
 * section builder or a shared block, or, for the one block a fields document or Site
 * Settings is held as (document-store.ts), its collection's fields. Pure, so the
 * overlays, the page's typing and the driver read the same thing.
 */
import { EDITORS_FIELD, own } from '../../../document.ts';
import type { Fields } from '../../../fields.ts';
import type { EditorDocument, EditorSite } from '../../types.ts';


/** The fields of a fields document's collection, or of Site Settings (the site's own `settings.fields`). */
export function formFields(site: Pick<EditorSite, 'collections'>, collection: string): Fields {
	return site.collections.find((c) => c.name === collection)?.fields ?? {};
}

/** The block types `collection`'s pages offer (config.ts `blocks`): null for every block. */
export function offeredBlocks(site: Pick<EditorSite, 'collections'>, collection: string): readonly string[] | null {
	return site.collections.find((c) => c.name === collection)?.blocks ?? null;
}

/** Whether `collection`'s pages offer blocks of `type` (always, when it names none). */
export function offersBlock(site: Pick<EditorSite, 'collections'>, collection: string, type: string): boolean {
	const offered = offeredBlocks(site, collection);
	return !offered || offered.includes(type);
}

/**
 * The fields the block `blockType` has in a document of `kind` from `collection`: a
 * form's (fields, settings) are its collection's; a block's are its type's schema.
 */
export function fieldsOfBlock(
	site: Pick<EditorSite, 'blocks' | 'collections'>,
	document: Pick<EditorDocument, 'kind'>,
	collection: string,
	block: { type: string; known: boolean },
): Fields {
	if (document.kind === 'fields') return formFields(site, collection);
	if (document.kind === 'settings') return { editors: EDITORS_FIELD, ...formFields(site, collection) };
	if (!block.known) return {};
	return own(site.blocks, block.type)?.fields ?? {};
}
