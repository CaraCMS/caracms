/**
 * Where the package's field components find a field's descriptor from the path
 * they're given (M5a Decision 16): a block's schema, or, in a fields document's
 * render (`cms.collection`, Decision 7), its collection's fields. Every component
 * looks up here, so all of them work in both.
 *
 * Edit in context: a source context's paths (`cms.source`) resolve against its document's fields
 * (Site Settings' are the site's `settings: { fields }`, a shared block's its block type's, an
 * entry's its collection's), and the page's own context's (`cms.page`) against its collection's
 * page `fields`. `contextMarker` is what each field element carries beside `data-cms-field` there.
 */
import type { ResolvedSite } from '../config.ts';
import { own, sourceKey, type BlockContext } from '../document.ts';
import { fieldAtPath, isKeyPath, type Field, type Fields } from '../fields.ts';

type Site = Pick<ResolvedSite, 'blocks' | 'collections'>;

/** The fields the context's paths point into: its source's, the page's, its fields document's, else its block's. */
export function fieldsOf(site: Site, cms: BlockContext): Fields | undefined {
	if (cms.source) {
		if (cms.source.collection === 'shared') return own(site.blocks, cms.type)?.fields;
		return own(site.collections, cms.source.collection)?.fields ?? undefined;
	}
	if (cms.page) return own(site.collections, cms.page.collection)?.fields ?? undefined;
	if (cms.collection) return own(site.collections, cms.collection)?.fields ?? undefined;
	return own(site.blocks, cms.type)?.fields;
}

/** "block "hero"", "collection "case-studies"", "Site Settings", for messages. */
export function whose(cms: BlockContext): string {
	if (cms.source?.collection === 'settings') return 'Site Settings';
	if (cms.source?.collection === 'shared') return `shared block "${cms.source.path}" (block "${cms.type}")`;
	if (cms.source) return `${cms.source.collection} "${cms.source.path}"`;
	if (cms.page) return `the page fields of collection "${cms.page.collection}"`;
	return cms.collection ? `collection "${cms.collection}"` : `block "${cms.type}"`;
}

/**
 * Edit in context: what a field element carries beside `data-cms-field` in a preview, so the
 * editor maps it to its document without walking up: under a source context its
 * `data-cms-source` (a Site Settings phone inside a footer is Site Settings', not the footer's),
 * under the page's own context `data-cms-page`. Nothing for a block's own fields (their document
 * is the nearest `data-cms-block` or `data-cms-document`), and nothing outside a preview.
 */
export function contextMarker(cms: BlockContext): Record<string, string> {
	if (!cms.preview) return {};
	if (cms.source) return { 'data-cms-source': sourceKey(cms.source) };
	if (cms.page) return { 'data-cms-page': '' };
	return {};
}

/**
 * The descriptor at a dotted path (`heading`, `credits.1.name`, `cta`) in the
 * context's schema, with what's left of the path past it; undefined when the path
 * names no field.
 */
export function descriptorAt(site: Site, cms: BlockContext, path: string): { field: Field; rest: string[] } | undefined {
	const fields = fieldsOf(site, cms);
	return fields ? fieldAtPath(fields, path) : undefined;
}

/** The descriptor a component needs, or a plain error naming the component, the block (or collection) and the path. */
export function requireField<K extends Field['kind']>(site: Site, cms: BlockContext, path: string, kind: K, component: string): Extract<Field, { kind: K }> {
	const found = descriptorAt(site, cms, path);
	if (!found || found.rest.length > 0 || found.field.kind !== kind) {
		throw new Error(`<${component}>: ${whose(cms)} has no ${kind} field "${path}"`);
	}
	return found.field as Extract<Field, { kind: K }>;
}

/**
 * Only a path with no list index is typed on the page (Decision 13): a top-level field,
 * or one in a group (`left.heading`). A list item's fields open in the sidebar.
 */
export const isTypedOnPage = (path: string) => isKeyPath(path);
