/**
 * Vivid (the config's `vivid: true`): on a public page, every field the package's components draw
 * (`<Text>`, `<RichText>`, `<Lockup>`, `<Buttons>`, `<Link>`, `<Media>`, and `<Block field>`) also
 * carries the two attributes Vivid, the on-site feedback widget, reads from a pinned element or its
 * nearest ancestor, so a reviewer's pin names the field and links to it in the editor:
 *
 * - `data-vivid-field="<document>#<field path>"`. The document is `<collection>/<path>`
 *   (`pages/services/branding`, `journal/my-post`, `case-studies/high-street-coffee`, `shared/footer`),
 *   or `settings` for Site Settings. The field path is the field's path in the document's JSON file,
 *   list indexes included:
 *     a section builder's block field      `pages/services/branding#blocks.2.heading`
 *     a field in a block's list            `pages/about#blocks.1.credits.1.name`
 *     a button's or a link's words         `pages/index#blocks.0.buttons.0.label`, `…#blocks.3.cta.label`
 *     a section builder's page field       `journal/my-post#date`
 *     a fields document's field            `case-studies/high-street-coffee#summary`
 *     Site Settings (`cms.settings`)       `settings#contact.phone`
 *     a shared block (a slot's, a page's   `shared/footer#block.address`
 *       `{ "shared": … }` entry, `cms.of`)   (its fields sit under `block` in its file)
 *     an entry a block read (`cms.of`)     `case-studies/high-street-coffee#cover`
 *   A value over 200 characters (Vivid's limit) is left out, with a warning, rather than cut short.
 * - `data-vivid-edit`: the document's address in the site's own editor, absolute (Vivid ignores a
 *   relative one): `<origin>/admin/<collection>/<path>`, `<origin>/admin/settings`,
 *   `<origin>/admin/shared/<name>`, and `<origin>/admin` for Home (editor/addresses.ts → addressOf).
 *   The origin (`vividOrigin`): in `astro dev`, the dev server's own; otherwise the site's public
 *   address, the chain sign-in links use (Astro's `site`, then SITE_URL, then Railway's domain:
 *   live/mode.ts → addressFrom), never a request's Host header. Public pages are prerendered, so a
 *   build without an address leaves `data-vivid-edit` out, with a warning.
 *
 * Off (the default) and in every preview, nothing: a context carries a `vivid` document only on a
 * public render with the switch on (document.ts → BlockContext.vivid), so the public page is byte
 * for byte what it was, and the editor's preview never sees these.
 *
 * How a public render knows its document: the route reads it with `readDocument` (content.ts), which
 * tags it with its collection and path (`documentRefOf`); RenderDocument and `<Blocks>` look the tag
 * up. A document built in code (the 404's) has none, so its own fields go untagged; Site Settings'
 * and the slots' still are.
 */
import type { ResolvedSite } from './config.ts';
import { addressOf } from './editor/addresses.ts';
import { addressFrom } from './live/mode.ts';
import { SETTINGS_PATH } from './reserved.ts';
import { warnOnce } from './slots.ts';

/** Vivid's own limit on `data-vivid-field` (its widget cuts anything longer). */
export const VIVID_FIELD_MAX = 200;

/** Where a context's fields are stored: the document, and the path to them inside its file (`blocks.2.`, `block.`, or ''). */
export interface VividDoc {
	collection: string;
	path: string;
	prefix: string;
}

/** A document's collection and path, as `readDocument` tagged it. */
export interface DocumentRef {
	collection: string;
	path: string;
}

/** The documents `readDocument` handed out, and their refs. On globalThis: a build's prerender may run a bundled copy of this module beside the route's. */
const REFS = Symbol.for('caracms.documentRefs');
const refs = ((globalThis as { [REFS]?: WeakMap<object, DocumentRef> })[REFS] ??= new WeakMap());

/** Tag a document read from its file with its collection and path (content.ts → readDocument). */
export function tagDocument(document: object, ref: DocumentRef): void {
	refs.set(document, { collection: ref.collection, path: ref.path });
}

/** The collection and path `readDocument` read a document from, or null (a document built in code, or a copy). */
export function documentRefOf(document: unknown): DocumentRef | null {
	return document !== null && typeof document === 'object' ? (refs.get(document) ?? null) : null;
}

/** Site Settings' Vivid document. */
export const VIVID_SETTINGS: VividDoc = { collection: 'settings', path: SETTINGS_PATH, prefix: '' };

/** A shared block's Vivid document: its fields sit under `block` in its file. */
export const vividShared = (name: string): VividDoc => ({ collection: 'shared', path: name, prefix: 'block.' });

/** An entry's Vivid document (a document `cms.read` gave, behind `cms.of`). */
export function vividEntry(ref: DocumentRef): VividDoc {
	if (ref.collection === 'settings') return VIVID_SETTINGS;
	if (ref.collection === 'shared') return vividShared(ref.path);
	return { collection: ref.collection, path: ref.path, prefix: '' };
}

/** `data-vivid-field`'s document part: `settings`, else `<collection>/<path>`. */
export const vividDocKey = (doc: Pick<VividDoc, 'collection' | 'path'>): string => (doc.collection === 'settings' ? 'settings' : `${doc.collection}/${doc.path}`);

/**
 * The editor's address for a document, from the site's config alone: Home is the first nested
 * collection's `index` (editor/server/admin-props.ts → homeOf, whose fallback, for a site with
 * none, opens at its own `/admin/<collection>/<path>` too).
 */
export function vividEditPath(site: Pick<ResolvedSite, 'collections'>, doc: Pick<VividDoc, 'collection' | 'path'>): string {
	const nested = Object.values(site.collections).find((c) => c.nested);
	const home = nested ? { collection: nested.name, path: 'index' } : { collection: '', path: '' };
	return addressOf({ collection: doc.collection, path: doc.path }, home);
}

/**
 * The origin `data-vivid-edit` starts with: the dev server's own in `astro dev` (the request's), else
 * the site's public address (live/mode.ts → addressFrom); null when neither is known.
 */
export function vividOrigin(dev: boolean, request: URL, astroSite: URL | undefined, env: Record<string, string | undefined> = process.env): string | null {
	if (dev) return request.protocol === 'https:' || request.protocol === 'http:' ? request.origin : null;
	return addressFrom(env, astroSite?.href);
}

/**
 * The attributes for one field element (`path` as the component's preview marker has it), or none:
 * none unless the context carries a Vivid document (a public render with the switch on).
 */
export function vividMarkers(site: Pick<ResolvedSite, 'collections'>, cms: { vivid?: VividDoc | null }, path: string, origin: string | null): Record<string, string> {
	const doc = cms.vivid;
	if (!doc) return {};
	const out: Record<string, string> = {};
	const field = `${vividDocKey(doc)}#${doc.prefix}${path}`;
	if (field.length <= VIVID_FIELD_MAX) out['data-vivid-field'] = field;
	else warnOnce(`caracms: vivid: "${field.slice(0, 80)}…" is over Vivid's ${VIVID_FIELD_MAX} characters, so that field has no data-vivid-field.`);
	if (origin) out['data-vivid-edit'] = `${origin}${vividEditPath(site, doc)}`;
	else warnOnce("caracms: vivid is on, but the site's address isn't known, so fields have no data-vivid-edit. Set Astro's `site`, or SITE_URL, to it (like https://example.com) when the site is built.");
	return out;
}

/**
 * A field component's attributes maker: `const vivid = vividOf(site, cms, Astro, import.meta.env.DEV)`,
 * then `{...vivid(field)}` on the field's element. Nothing at all when the context carries no document.
 */
export function vividOf(site: Pick<ResolvedSite, 'collections'>, cms: { vivid?: VividDoc | null }, astro: { url: URL; site?: URL | undefined }, dev: boolean): (path: string) => Record<string, string> {
	if (!cms.vivid) return () => ({});
	const origin = vividOrigin(dev, astro.url, astro.site);
	return (path) => vividMarkers(site, cms, path, origin);
}
