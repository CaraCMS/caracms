/**
 * The site's config (Decision 3): everything the package learns about a site. The
 * package names no block, no collection and no style; it reads them from here.
 *
 * A site writes `caracms.config.ts` with `defineSite({...})` and passes it to the
 * integration in `astro.config.mjs`:
 *
 *   import caracms from 'caracms';
 *   import site from './caracms.config.ts';
 *   export default defineConfig({ integrations: [caracms(site)] });
 *
 * The config is plain data: field descriptors, and components named by their path
 * (relative to the site's root), never imported. That lets `astro.config.mjs` load
 * it before Vite can compile `.astro` files, lets the integration validate it before
 * the dev server or the build starts, and lets the integration hand it to the site's
 * routes and the editor as one JSON blob (see index.ts → the virtual module).
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { FIELD_KINDS, headingPaths, titleCase, type Field, type Fields, type MediaField } from './fields.ts';
import { DEFAULT_SHARED_FOLDER, RESERVED_COLLECTIONS, SETTINGS_KEYS, SITE_SETTINGS_FILE } from './reserved.ts';
import type { ResolvedTextStyle, TextStyle } from './text-styles.ts';
import type { CodeRoute } from './code-routes.ts';
import { checkForms, type FormConfig, type ResolvedForm } from './forms/rules.ts';
import { formWordFields } from './forms/word-fields.ts';

export * from './fields.ts';
export type { TextStyle, TextTransform, ResolvedTextStyle } from './text-styles.ts';
export { variationSettings } from './text-styles.ts';
import { COLUMN_FIELD_WORDS, DEFAULT_COLUMNS, columnKindOf, isBuiltInColumn, type BuiltInColumn, type SortConfig } from './columns.ts';
import { checkView, type ResolvedView, type ViewConfig } from './cards.ts';
import { SLOT_NAMES, type SlotName } from './slots.ts';
export type { BuiltInColumn, SortConfig } from './columns.ts';
export type { FormChoice, FormColumnConfig, FormColumnType, FormConfig, FormFieldConfig, FormFieldType, FormFieldValue, FormNarrowing, FormRow, FormSource, ResolvedForm, ResolvedFormColumn, ResolvedFormField } from './forms/rules.ts';
export type { FormCodeWords, FormFieldWords, FormWord, FormWords } from './forms/words.ts';

/** Decision 11's default: phone lines take over below 640px wide. */
export const DEFAULT_PHONE_LINES_WIDTH = 640;

/** A section builder (M3): a document is a title and a list of blocks. */
export interface SectionsCollectionConfig {
	/** Shown in the editor. Defaults to the key, title-cased. */
	label?: string;
	kind: 'sections';
	/** The folder holding the collection's content files, relative to the site's root. */
	folder: string;
	/** The URL the collection's documents live under: `/` for Pages, `/tags/` for tags. Leave it out for a collection a page holds (`heldBy`). */
	urlBase?: string;
	/**
	 * Collections under pages (Decision 2): the documents' address follows a page instead of a
	 * prefix in code. Names the nested section builder (`'pages'`) one of whose pages holds this
	 * collection: that page's file says `"holds": "<this collection>"`, and the documents are at
	 * the page's address + `/` + their slug (`/journal/<slug>`), wherever the page moves. Not
	 * with `urlBase`, and the collection is flat. Until a page holds it, its documents have no
	 * addresses (`caracms validate` says why).
	 */
	heldBy?: string;
	/**
	 * Pages' rule (Decision 8): documents nest in folders and the file's path is the
	 * URL; `index.json` at the top of the folder is `urlBase` itself, and an
	 * `index.json` anywhere deeper is an error. Off: a flat list of `<slug>.json`.
	 */
	nested?: boolean;
	/**
	 * M6c (G2): the page's own fields, beside its blocks (a game's tile details, a
	 * header's "side"). Optional. Stored as top-level keys of the document's file,
	 * after `title` and before `blocks`, in schema order; edited in the sidebar at the
	 * document level, never on the page. The page component gets their render data as
	 * `data` (document.ts → PageProps), and `cms.read` as a ReadEntry's `data`.
	 * `title`, `blocks` and `seo` are the document's own keys, so no field takes them.
	 */
	fields?: Fields;
	/**
	 * The editor's table of the collection (a flat one, at its own level): the columns
	 * after the title, in order. Its page fields by key (Decision 13 of posts and tags:
	 * text, select, toggle, date, number, a reference or a list of references), and the
	 * built-ins `'address'` and `'edited'` (when it was last edited). Default:
	 * `['address', 'edited']`.
	 */
	columns?: readonly string[];
	/**
	 * The table's, the grid's and the sidebar list's order until an editor clicks a
	 * header (Decision 13): `'title'` or one of `columns` (not a list of references),
	 * either way. Default: the title, A to Z.
	 */
	sort?: SortConfig;
	/**
	 * Review gaps (Decision 1): `'manual'` gives the collection a hand order. Its entries are
	 * dragged in the editor's list, the order is kept in Site Settings (`collectionOrder`), a
	 * new entry goes first, and `documents()` returns them in it. Flat collections only (Pages
	 * have Arrange), and not with `sort`: the hand order is the list's order.
	 */
	order?: 'manual';
	/**
	 * M6c (G5): the editor's List / Grid switch on a flat collection (Decision 17):
	 * which view it opens in until an editor picks (`'list'`, the default, or `'grid'`)
	 * and the card picture's ratio (`'4:3'` by default). A card shows the first image in
	 * the page fields, then in the blocks.
	 */
	view?: Omit<ViewConfig, 'image'>;
	/**
	 * The blocks its pages offer, by type (`['full-image', 'image-pair', 'video']`): the
	 * picker shows only these, and only shared blocks of these types. Left out, every
	 * block. A stored block of another type is kept and still renders; the editor marks it.
	 */
	blocks?: readonly string[];
}

/**
 * A list of fields per document (M5a Decision 7): the file is `{ "title", ...fields }`,
 * with keys in schema order. Flat, at `urlBase` + slug, or with no pages of their own
 * (no `urlBase`, M6c G1).
 */
export interface FieldsCollectionConfig<F extends Fields = Fields> {
	label?: string;
	kind: 'fields';
	folder: string;
	/**
	 * The documents' URLs are `urlBase` + their slug (`/work/high-street-coffee`). Leave it
	 * out for documents with no pages of their own (M6c G1: a team, awards, logos), read
	 * by other pages through references and `cms.read`: they have no URL, aren't in the
	 * sitemap, aren't offered as link targets, have no address column, no "Change
	 * address…" and no redirects. The editor still previews one through `component`
	 * in the page component, as a shared block's own preview is.
	 */
	urlBase?: string;
	/**
	 * Collections under pages (Decision 2): the documents' address follows a page instead of a
	 * prefix in code. Names the nested section builder (`'pages'`) one of whose pages holds this
	 * collection: that page's file says `"holds": "<this collection>"`, and the documents are at
	 * the page's address + `/` + their slug (`/journal/<slug>`), wherever the page moves. Not
	 * with `urlBase`, and the collection is flat. Until a page holds it, its documents have no
	 * addresses (`caracms validate` says why).
	 */
	heldBy?: string;
	/** Every document's fields, in the form's order. `title` is every document's own, so it can't be one of them. */
	fields: F;
	/**
	 * The Astro component that renders a document's body, relative to the site's root.
	 * It gets `{ document, cms }` (document.ts → FieldsDocumentProps); the site's page
	 * component renders it in the page's frame (its `<Blocks>` does).
	 */
	component: string;
	/**
	 * The editor's table of the collection (at its own level): the columns after the
	 * title, in order. Its fields by key (text, select, toggle, date or number: one short
	 * value each), and the built-ins `'address'` and `'edited'` (when it was last edited).
	 * Default: `['address', 'edited']` (`['edited']` with no `urlBase`, which refuses
	 * `'address'`). Select and toggle columns get a filter.
	 */
	columns?: readonly (Extract<keyof F, string> | BuiltInColumn)[];
	/**
	 * The table's, the grid's and the sidebar list's order until an editor clicks a
	 * header (posts and tags, Decision 13): `'title'` or one of `columns` (not a list of
	 * references), either way. Default: the title, A to Z.
	 */
	sort?: { column: 'title' | Extract<keyof F, string> | BuiltInColumn; order: 'asc' | 'desc' };
	/**
	 * Review gaps (Decision 1): `'manual'` gives the collection a hand order. Its entries are
	 * dragged in the editor's list, the order is kept in Site Settings (`collectionOrder`), a
	 * new entry goes first, and `documents()` returns them in it. Flat collections only (Pages
	 * have Arrange), and not with `sort`: the hand order is the list's order.
	 */
	order?: 'manual';
	/**
	 * M6c (G5): the editor's List / Grid switch (Decision 17), when the fields hold a media
	 * field: which view it opens in until an editor picks (`'list'`, the default, or
	 * `'grid'`), the media field (or list of media: its first item) a card shows
	 * (default: the first image in schema order), and the picture's ratio (`'4:3'`).
	 */
	view?: ViewConfig & { image?: Extract<keyof F, string> };
}

export type CollectionConfig = SectionsCollectionConfig | FieldsCollectionConfig;

export interface BlockConfig<F extends Fields = Fields> {
	/** Shown in the editor's block list and picker. Defaults to the key, title-cased. */
	label?: string;
	/**
	 * The block's Astro component, relative to the site's root. It gets
	 * `{ block, cms }`: the block's parsed data and its render context
	 * (see document.ts → BlockProps).
	 */
	component: string;
	fields: F;
	/** M6c (G8): plain text at the top of the block's sidebar level, saying what it's for. Never on the page. */
	help?: string;
	/**
	 * Edit in context, Decision 2: the slot of the page's frame this block fills (`'header'` or
	 * `'footer'`). Its documents are shared blocks the page component draws with `<Slot name="…">`,
	 * never blocks of a page's body: a collection's `blocks` can't name it, and a body entry
	 * `{ "shared": … }` naming one is skipped on the page (kept in the file).
	 */
	slot?: SlotName;
	/**
	 * Review gaps (Decision 6): the block's states, key → the label the editor's switch shows
	 * (`{ sent: 'Sent', error: "Couldn't send" }`). The block as a visitor first sees it needs no
	 * entry. While the block is selected, a switch over the preview shows each one: the block's
	 * `cms.state` is then the chosen key (null everywhere else: the public page, a build, every
	 * other block), and the component draws that state's markup. A state is a view, never saved.
	 */
	states?: Record<string, string>;
}

// Edit in context, Decision 2: the slots of a page's frame a shared block can fill (slots.ts, browser-safe).
export { SLOT_NAMES, type SlotName } from './slots.ts';

/**
 * The brand's logo and tab icon as URLs (M2 → Brand slots). Since M5b Decision 11 they're
 * Site Settings' (`content/site-settings.json` → `brand.logo`, `brand.icon`, image values
 * uploaded in the editor), which `brandFrom` resolves to signed URLs; the config's
 * `brand.logo` and `brand.icon` are refused (`brandMediaRefusal`), as `brand.name` and
 * `brand.accent` are (M5a Decision 10).
 */
export interface BrandConfig {
	/** The logo's URL on the site, e.g. `/logo.svg` (served from `public/`). */
	logo?: string;
	/** The tab icon's URL on the site, e.g. `/favicon.svg`. */
	icon?: string;
}

/** The editor's four brand slots as they apply: the config's logo and icon, Site Settings' name and accent. */
export interface Brand extends BrandConfig {
	/** Site Settings' `brand.name`; "Site" when it has none. */
	name: string;
	/** Site Settings' `brand.accent` (`#rgb` or `#rrggbb`); the editor's neutral accent when it has none. */
	accent: string;
}

export { DEFAULT_SHARED_FOLDER, RESERVED_COLLECTIONS, SETTINGS_KEYS, SETTINGS_PATH, SITE_SETTINGS_FILE } from './reserved.ts';

export interface SiteConfig {
	collections: Record<string, CollectionConfig>;
	blocks: Record<string, BlockConfig>;
	textStyles: Record<string, TextStyle>;
	/**
	 * The site's page component, relative to the site's root. It renders a whole
	 * page from a document: `{ document, collection, preview }` (document.ts → PageProps).
	 * The public routes and the editor's preview both render through it.
	 */
	page: string;
	/**
	 * Refused in full since M5b: the brand's name, accent, logo and tab icon are all Site
	 * Settings' (`content/site-settings.json` → `brand`, M5a Decision 10, M5b Decision 11),
	 * so the editor can change them. An empty `brand: {}` is allowed.
	 */
	brand?: BrandConfig;
	/** The folder holding shared blocks, relative to the site's root (M5a Decision 8). Default `content/shared`. */
	sharedFolder?: string;
	/**
	 * Site Settings' own keys beyond the package's `title`, `editors` and `brand`
	 * (M5a Decision 10). They apply once published.
	 */
	settings?: { fields: Fields };
	/**
	 * Phone lines take over below this viewport width, in px (Decision 11). Above 375
	 * and at most 768. Set it to the site's own phone breakpoint. Default 640.
	 */
	phoneLinesWidth?: number;
	/**
	 * The site's folder inside its git repo, `/`-separated (M4 Decision 3). Default
	 * `'.'`: the site sits at the repo's root. Live mode joins it to the collection
	 * folders to find the site's files in git; on disk, folders stay relative to the
	 * site's root as before.
	 */
	repoPath?: string;
	/** The time zone the editor shows times in, an IANA name such as `Europe/Dublin` (M4 Decision 16). Default `UTC`. */
	timeZone?: string;
	/**
	 * The site's public forms, by id (M6 Decision 4): each a label, the email's subject
	 * and its fields in order. The public form is `Form.astro`; submissions go to the
	 * site's own bucket and the inbox. A form's id is never renamed once it's live.
	 */
	forms?: Record<string, FormConfig>;
	/**
	 * What joins a page's title and the site's name in the fallback `<title>`
	 * (`<document title><titleSeparator><brand name>`, head.ts), spaces included. Default
	 * `' · '`. Code, not a Site Settings field: a site's title format is design, not content.
	 * A site adopting caracms sets it to keep its old titles (` | `, ` - `). `siteSettings()`
	 * hands it to the site's own routes as `seo.titleSeparator`, so their titles match.
	 */
	titleSeparator?: string;
	/**
	 * What a page without its own `seo.title` falls back to (M9, head.ts). `'page-and-brand'`
	 * (the default): `<document title><titleSeparator><brand name>`, the home page excepted.
	 * `'site'`: every page falls back as the home page does, to Site Settings' `seo.title`,
	 * then the brand name, then the document title. For a site (a Tina template's, say)
	 * whose pages all show the site's own title.
	 */
	titleFallback?: TitleFallback;
	/**
	 * Where the site's services come from (caracms-cloud M5 Decision 1): GitHub access,
	 * media, forms and email, video. `'cloud'`: CaraCMS Cloud, through `CARACMS_CLOUD_KEY`.
	 * `'self-hosted'`: the site's own variables. The other mode's variables are ignored,
	 * with a warning (live/services.ts). Unset, the key decides, as before M5 (Decision 3).
	 * `caracms init --cloud` or `--self-hosted` writes it.
	 */
	services?: Services;
	/**
	 * Vivid, the on-site feedback widget (vivid.ts): `true` puts `data-vivid-field` and
	 * `data-vivid-edit` on every field the package's components draw on a public page, so a
	 * reviewer's pin names the field (`pages/about#blocks.2.heading`) and links to it in the
	 * editor. Never in a preview. Default `false`: the public page carries nothing for it.
	 */
	vivid?: boolean;
}

/** The config's `services` values (live/services.ts). */
export type Services = 'cloud' | 'self-hosted';

/** The config's `titleFallback` values (head.ts). */
export type TitleFallback = 'page-and-brand' | 'site';

/** The fallback title's separator when the config sets none (head.ts). */
export const DEFAULT_TITLE_SEPARATOR = ' · ';

/** Identity, for types: keeps each block's fields typed. */
export function defineSite<const C extends SiteConfig>(config: C): C {
	return config;
}

// ── Resolved: what the integration validates and hands on ─────────────────────

/**
 * A collection as the package uses it. `kind`:
 * - `sections`, `fields`: the site's own (config order);
 * - `shared`, `settings`: the two the package reserves (Decision 8), always present,
 *   after the site's. Shared blocks live in `sharedFolder`, one document per file.
 *   Site Settings is one document, `site-settings` (the file `content/site-settings.json`);
 *   its `dir` is that file's folder, but it holds nothing else.
 * Neither reserved one has URLs.
 */
export interface ResolvedCollection {
	name: string;
	label: string;
	kind: 'sections' | 'fields' | 'shared' | 'settings';
	/** As configured, relative to the root. */
	folder: string;
	/** Absolute. */
	dir: string;
	/**
	 * Always starts and ends with `/`. Null for the reserved collections, and a fields collection with no pages of its own (M6c G1).
	 * A held collection's (`heldBy`) is null here, in the config, and its holder's address + `/` once a listing resolves it
	 * (held.ts → withHeldBases); every caller that has a listing uses the resolved one.
	 */
	urlBase: string | null;
	/** Collections under pages (Decision 2): the nested section builder whose page holds this collection; absent when none does. */
	heldBy?: string;
	nested: boolean;
	/**
	 * A fields collection's fields (labelled); a section builder's page fields (M6c G2,
	 * labelled), null when it has none; Site Settings' site-added fields; null otherwise.
	 */
	fields: Fields | null;
	/** A fields collection's component, absolute; null otherwise. */
	component: string | null;
	/** The editor's table columns after the title, as configured (checked); null for the default (columns.ts). */
	columns: string[] | null;
	/** The view's initial order, as configured (checked; Decision 13); null or absent for the title, A to Z. */
	sort?: SortConfig | null;
	/** Review gaps (Decision 1): `'manual'` for a hand order (collection-order.ts); null or absent for none. */
	order?: 'manual' | null;
	/** M6c (G5): the List / Grid switch's view, checked and defaulted (cards.ts); null when the collection gets no switch. Absent reads as null. */
	view?: ResolvedView | null;
	/** A section builder's offered blocks, as configured (checked); null or absent for every block. */
	blocks?: string[] | null;
}

/** A section builder's `blocks` option, checked: null when left out (every block). */
function checkOffered(where: string, raw: unknown, blocks: Record<string, ResolvedBlock>, fail: (message: string) => never): string[] | null {
	if (raw === undefined) return null;
	const example = Object.keys(blocks).slice(0, 2);
	if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) fail(`${where}: blocks must be a list of block types, like ${JSON.stringify(example)}.`);
	if (raw.length === 0) fail(`${where}: blocks is empty, so its pages could add nothing. Name the blocks they offer, or take blocks out to offer every block.`);
	for (const type of raw as string[]) {
		if (!Object.hasOwn(blocks, type)) fail(`${where}: blocks names "${type}", which isn't one of the site's blocks (${Object.keys(blocks).join(', ')}).`);
		// Edit in context, Decision 2: a slot's block fills the page's frame, never its body.
		const slot = blocks[type]!.slot;
		if (slot) fail(`${where}: blocks names "${type}", which is the page's ${slot} (slot: '${slot}'), so it isn't a block of the body. Take it out of blocks.`);
	}
	return [...new Set(raw as string[])];
}

/** The site's own collections, in config order (the reserved two left out). */
export function siteCollections(site: Pick<ResolvedSite, 'collections'>): ResolvedCollection[] {
	return Object.values(site.collections).filter((c) => c.kind === 'sections' || c.kind === 'fields');
}

/** Is this a collection name the package reserves? */
export const isReserved = (name: string): boolean => (RESERVED_COLLECTIONS as readonly string[]).includes(name);

export interface ResolvedBlock {
	type: string;
	label: string;
	/** Absolute path of the component. */
	component: string;
	fields: Fields;
	/** The field holding the block's heading (Decision 16): the first top-level one marked as one, else the first inside a group (a dotted path, `left.heading`), or null. */
	headingField: string | null;
	/** M6c (G8): its help, shown at the top of its sidebar level; absent when it has none. */
	help?: string;
	/** Edit in context, Decision 2: the slot it fills; absent for a block of a page's body. */
	slot?: SlotName;
	/** Review gaps (Decision 6): its states, key → the switch's label, in config order; absent when it has none. */
	states?: Record<string, string>;
}

export interface ResolvedSite {
	/** The site's root, absolute. */
	root: string;
	collections: Record<string, ResolvedCollection>;
	blocks: Record<string, ResolvedBlock>;
	textStyles: Record<string, ResolvedTextStyle>;
	/** Absolute path of the page component. */
	page: string;
	/** The logo and icon (the name and accent are Site Settings', read at request time: editor/server/settings.ts). */
	brand: BrandConfig;
	/** The shared-block folder, as configured, relative to the root. */
	sharedFolder: string;
	phoneLinesWidth: number;
	/** The site's folder in its repo, normalised: `'.'` for the root, else `a/b` (no leading or trailing `/`). */
	repoPath: string;
	/** An IANA time zone name, checked with Intl. */
	timeZone: string;
	/** The forms, checked (M6 Decision 4), by id in config order; `{}` with none. */
	forms: Record<string, ResolvedForm>;
	/** The fallback title's separator, spaces included (`DEFAULT_TITLE_SEPARATOR` when the config sets none). */
	titleSeparator: string;
	/** What a page without its own `seo.title` falls back to (`'page-and-brand'` when the config sets none). */
	titleFallback: TitleFallback;
	/** Where the site's services come from (caracms-cloud M5 Decision 1); null when the config doesn't say. */
	services: Services | null;
	/** Whether public pages carry Vivid's attributes (vivid.ts); `false` when the config doesn't say. */
	vivid: boolean;
	/**
	 * M8 Decision 10: the URLs the site's own `src/pages/` serves (code-routes.ts), read by the
	 * integration at setup (and by the commands). Absent before then: nothing is reserved.
	 */
	codeRoutes?: CodeRoute[];
	/**
	 * Collections under pages (Decision 14): every route in `src/pages/`, the collections' own
	 * included, read with `codeRoutes`. The catch-all's reader (content.ts → addressedDocuments)
	 * leaves out a prefix collection with its own route, and logs a route left at a held base.
	 */
	pageRoutes?: CodeRoute[];
}

export class CaracmsConfigError extends Error {
	constructor(message: string) {
		super(`caracms config: ${message}`);
		this.name = 'CaracmsConfigError';
	}
}

/**
 * Validate the config and resolve its paths against the site's root. Throws a
 * CaracmsConfigError with a plain sentence for the first problem found; the
 * integration calls this before the dev server or the build starts, so a bad
 * config stops it with that sentence.
 */
export function resolveSite(config: SiteConfig, root: string): ResolvedSite {
	const fail = (message: string): never => {
		throw new CaracmsConfigError(message);
	};
	const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
	const mustExist = (p: string, what: string) => {
		if (!existsSync(abs(p))) fail(`${what} "${p}" doesn't exist (looked in ${abs(p)}).`);
	};

	if (!config || typeof config !== 'object') fail('pass the site config to caracms(): caracms(site).');

	// Decision 11.
	const phoneLinesWidth = config.phoneLinesWidth ?? DEFAULT_PHONE_LINES_WIDTH;
	if (typeof phoneLinesWidth !== 'number' || !Number.isFinite(phoneLinesWidth) || phoneLinesWidth <= 375 || phoneLinesWidth > 768) {
		fail(
			`phoneLinesWidth must be above 375 and at most 768 (got ${String(config.phoneLinesWidth)}), ` +
				'so the phone preview (375) always shows phone lines and tablet (768) and desktop never do.',
		);
	}

	// Text styles.
	const textStyles: Record<string, ResolvedTextStyle> = {};
	for (const [name, style] of Object.entries(config.textStyles ?? {})) {
		const where = `text style "${name}"`;
		if (!(style.sizePx > 0)) fail(`${where}: sizePx must be a positive number.`);
		if (!(style.minSizePx > 0) || style.minSizePx > style.sizePx) fail(`${where}: minSizePx must be positive and no larger than sizePx.`);
		if (!style.cssVariable?.startsWith('--')) fail(`${where}: cssVariable must start with "--".`);
		mustExist(style.fontFile.measure, `${where}: fontFile.measure`);
		mustExist(style.fontFile.web, `${where}: fontFile.web`);
		textStyles[name] = {
			...style,
			name,
			resolvedFontFile: { measure: abs(style.fontFile.measure), web: abs(style.fontFile.web) },
		};
	}

	// Collections: the site's own first (config order), then the two the package reserves.
	const collections: Record<string, ResolvedCollection> = {};
	const dirs = new Map<string, string>();
	const claimFolder = (name: string, folder: string) => {
		const dir = abs(folder);
		const other = dirs.get(dir);
		const what = (n: string) => (n === 'shared' ? 'sharedFolder' : `collection "${n}"`);
		if (other) fail(`${what(other)} and ${what(name)} share the folder "${folder}".`);
		dirs.set(dir, name);
		return dir;
	};
	const fieldsCollections: [string, FieldsCollectionConfig][] = [];
	const pageFieldCollections: [string, Fields][] = [];
	const sectionsCollections: [string, SectionsCollectionConfig][] = [];
	for (const [name, c] of Object.entries(config.collections ?? {})) {
		if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`collection "${name}": its key must be lowercase letters, digits and hyphens (it's part of the editor's addresses).`);
		if (isReserved(name)) fail(`collection "${name}": "shared" and "settings" are the package's own collections (shared blocks and Site Settings); name it something else.`);
		if (name === 'submissions') fail(`collection "submissions": /admin/submissions is the editor's inbox (M6), so a collection can't be called that; name it something else.`);
		if (c.kind !== 'sections' && c.kind !== 'fields') fail(`collection "${name}": kind must be 'sections' or 'fields' (got ${JSON.stringify((c as { kind?: unknown }).kind)}).`);
		if (!c.folder) fail(`collection "${name}": folder is required.`);
		const dir = claimFolder(name, c.folder);
		// Collections under pages (Decision 2): a page holds it, so its address comes from the content, never a urlBase too.
		const heldBy = (c as { heldBy?: unknown }).heldBy;
		if (heldBy !== undefined) {
			if (typeof heldBy !== 'string' || heldBy === '') fail(`collection "${name}": heldBy must name the collection whose page holds it, like 'pages'.`);
			if (c.urlBase !== undefined) fail(`collection "${name}": it has both urlBase ('${c.urlBase}') and heldBy ('${heldBy}'). Its address comes from one: a prefix in code (urlBase) or the page that holds it (heldBy). Take one out.`);
			if ((c as { nested?: unknown }).nested) fail(`collection "${name}": a collection a page holds is flat (its documents are at the page's address + their slug), so it can't be "nested".`);
		}
		// M6c (G1): a list-of-fields collection may have no pages of its own (no urlBase).
		const pageless = c.kind === 'fields' && c.urlBase === undefined && heldBy === undefined;
		if (!pageless && heldBy === undefined && (typeof c.urlBase !== 'string' || !c.urlBase.startsWith('/'))) {
			fail(c.urlBase === undefined ? `collection "${name}": a section builder needs a urlBase, like '/' or '/tags/', or heldBy: 'pages' when a page holds it (its documents are pages there).` : `collection "${name}": urlBase must start with "/".`);
		}
		const urlBase = pageless || heldBy !== undefined ? null : c.urlBase!.endsWith('/') ? c.urlBase! : `${c.urlBase}/`;
		const held = heldBy !== undefined ? { heldBy: heldBy as string } : {};
		// Review gaps (Decision 1): a hand order, on a flat collection, never beside sort.
		const order = (c as { order?: unknown }).order;
		if (order !== undefined) {
			if (order !== 'manual') fail(`collection "${name}": order must be 'manual' (a hand order, dragged in the editor's list), or left out (got ${JSON.stringify(order)}).`);
			if ((c as { nested?: unknown }).nested) fail(`collection "${name}": order: 'manual' is for a flat collection; a nested one (Pages) is ordered on the Arrange screen. Take it out.`);
			if (c.sort !== undefined) fail(`collection "${name}": it has both order: 'manual' and sort. A hand order is the list's order, so take sort out (an editor can still sort the table by a column to look).`);
		}
		const manual = order === 'manual' ? { order: 'manual' as const } : {};
		const label = c.label ?? titleCase(name);
		if (c.kind === 'fields') {
			if ((c as { nested?: unknown }).nested) fail(`collection "${name}": a list-of-fields collection is flat (one level of slugs under its urlBase); "nested" is for section builders.`);
			if (!c.component) fail(`collection "${name}": component is required (it renders a document's body).`);
			mustExist(c.component, `collection "${name}": component`);
			if (!c.fields || typeof c.fields !== 'object') fail(`collection "${name}": fields is required.`);
			fieldsCollections.push([name, c]);
			collections[name] = { name, label, kind: 'fields', folder: c.folder, dir, urlBase, ...held, ...manual, nested: false, fields: {}, component: abs(c.component), columns: null };
		} else {
			if (c.columns !== undefined && c.nested) fail(`collection "${name}": columns are for the editor's table of a flat collection; a nested one (Pages) is a tree.`);
			if (c.sort !== undefined && c.nested) fail(`collection "${name}": sort is for the editor's table of a flat collection; a nested one (Pages) is a tree.`);
			sectionsCollections.push([name, c]);
			if (c.fields !== undefined) {
				if (!c.fields || typeof c.fields !== 'object' || Array.isArray(c.fields)) fail(`collection "${name}": fields must be an object of fields, like { side: select({ options: ['left', 'right'] }) }.`);
				pageFieldCollections.push([name, c.fields]);
			}
			collections[name] = { name, label, kind: 'sections', folder: c.folder, dir, urlBase, ...held, ...manual, nested: c.nested ?? false, fields: null, component: null, columns: null };
		}
	}
	if (Object.keys(collections).length === 0) fail('declare at least one collection.');
	// Decision 6: a holder is a page of a nested section builder (Pages), whose slugs are addresses.
	for (const c of Object.values(collections)) {
		if (c.heldBy === undefined) continue;
		const by = Object.hasOwn(collections, c.heldBy) ? collections[c.heldBy]! : fail(`collection "${c.name}": heldBy names "${c.heldBy}", which isn't one of the site's collections (${Object.keys(collections).join(', ')}).`);
		if (by.kind !== 'sections' || !by.nested || by.urlBase === null) fail(`collection "${c.name}": heldBy names "${c.heldBy}", which isn't a nested section builder (like Pages), so none of its documents can hold a collection.`);
	}
	const ownCollections = { ...collections };

	const settingsFolder = SITE_SETTINGS_FILE.slice(0, SITE_SETTINGS_FILE.lastIndexOf('/'));
	// Site Settings is one file in that folder (SITE_SETTINGS_FILE); a collection owning the folder would treat it as one of its documents, and a write to it would go to that collection.
	const settingsDir = abs(settingsFolder);
	for (const c of Object.values(ownCollections)) {
		if (c.dir === settingsDir) fail(`collection "${c.name}": its folder "${c.folder}" is where Site Settings lives (${SITE_SETTINGS_FILE}), so it would read Site Settings as one of its documents; give the collection a folder of its own, like "${c.folder}/${c.name}".`);
	}

	// Shared blocks (Decision 8): their own folder, which no collection may share.
	const sharedFolder = config.sharedFolder ?? DEFAULT_SHARED_FOLDER;
	if (typeof sharedFolder !== 'string' || sharedFolder === '') fail('sharedFolder must be a folder, relative to the site, like \'content/shared\'.');
	const sharedDir = claimFolder('shared', sharedFolder);
	if (sharedDir === settingsDir) fail(`sharedFolder "${sharedFolder}" is where Site Settings lives (${SITE_SETTINGS_FILE}); give shared blocks a folder of their own.`);
	for (const c of Object.values(ownCollections)) {
		const inside = (a: string, b: string) => a.startsWith(`${b}/`) || a.startsWith(`${b}\\`);
		if (inside(sharedDir, c.dir) || inside(c.dir, sharedDir)) fail(`sharedFolder "${sharedFolder}" and collection "${c.name}"'s folder "${c.folder}" sit inside each other; give shared blocks a folder of their own.`);
	}

	// Fields: a fields collection's, then Site Settings' own (both may refer to any of the site's collections).
	const fieldCheck = (where: string): FieldCheck => ({ fail, textStyles, collections: ownCollections, listDepth: 0, where });
	for (const [name, c] of fieldsCollections) {
		const where = `collection "${name}"`;
		for (const [key, field] of Object.entries(c.fields)) {
			if (key === 'title') fail(`${where}: "title" is every document's own field (the form's first, one line), so a field can't be called that.`);
			if (key === 'seo') fail(`${where}: "seo" is every page's own search and sharing settings (M6 Decision 13), so a field can't be called that.`);
			if (key === 'frame') fail(`${where}: "frame" is every page's own pick of its header and footer (edit in context, Decision 3), so a field can't be called that.`);
			checkFieldKey(key, `${where}: field "${key}"`, fail);
			validateField(field, `${where}: field "${key}"`, { ...fieldCheck(where), siblings: c.fields });
		}
		const columns = checkColumns(where, c.columns, c.fields, fail);
		// A held collection (heldBy) has addresses too, once a page holds it (Contracts → Config).
		const addressed = c.urlBase !== undefined || c.heldBy !== undefined;
		if (!addressed && columns?.includes('address')) fail(`${where}: its documents have no pages of their own (no urlBase), so there's no 'address' column.`);
		const sort = checkSort(where, c.sort, columns ?? DEFAULT_COLUMNS.filter((k) => k !== 'address' || addressed), c.fields, fail);
		collections[name] = { ...collections[name]!, fields: withLabels(c.fields), columns, sort };
	}
	// M6c (G2): a section builder's page fields, beside `title`, `blocks` and `seo` in the file.
	for (const [name, fields] of pageFieldCollections) {
		const where = `collection "${name}"`;
		for (const [key, field] of Object.entries(fields)) {
			if (key === 'title' || key === 'blocks' || key === 'seo' || key === 'frame') {
				const what = { title: 'title', blocks: 'list of blocks', seo: 'search and sharing settings', frame: 'pick of its header and footer' }[key];
				fail(`${where}: "${key}" is every page's own (its ${what}), so a page field can't be called that.`);
			}
			checkFieldKey(key, `${where}: field "${key}"`, fail);
			validateField(field, `${where}: field "${key}"`, { ...fieldCheck(where), siblings: fields });
		}
		if (Object.keys(fields).length) collections[name] = { ...collections[name]!, fields: withLabels(fields) };
	}
	// Posts and tags (Decision 13): a section builder's columns may name its page fields, so they're checked once those are.
	for (const [name, c] of sectionsCollections) {
		const where = `collection "${name}"`;
		const fields = c.fields && Object.keys(c.fields).length ? c.fields : null;
		const columns = checkColumns(where, c.columns, fields, fail);
		const sort = checkSort(where, c.sort, columns ?? DEFAULT_COLUMNS, fields, fail);
		collections[name] = { ...collections[name]!, columns, sort };
	}
	const settingsFields = config.settings?.fields ?? {};
	for (const [key, field] of Object.entries(settingsFields)) {
		if ((SETTINGS_KEYS as readonly string[]).includes(key)) fail(`settings: "${key}" is one of Site Settings' own keys (${SETTINGS_KEYS.join(', ')}); name the field something else.`);
		checkFieldKey(key, `settings: field "${key}"`, fail);
		validateField(field, `settings: field "${key}"`, { ...fieldCheck('settings'), siblings: settingsFields });
	}
	collections.shared = { name: 'shared', label: 'Shared blocks', kind: 'shared', folder: sharedFolder, dir: sharedDir, urlBase: null, nested: false, fields: null, component: null, columns: null };
	// Review gaps (Decision 9a): each form's words are Site Settings fields, generated from the forms (checked first).
	const forms = checkForms(config.forms, fail, collections);
	const formWords = formWordFields(forms);
	collections.settings = { name: 'settings', label: 'Site Settings', kind: 'settings', folder: settingsFolder, dir: settingsDir, urlBase: null, nested: false, fields: { ...withLabels(settingsFields), ...(formWords ? { formWords } : {}) }, component: null, columns: null };

	// Blocks.
	const blocks: Record<string, ResolvedBlock> = {};
	for (const [type, b] of Object.entries(config.blocks ?? {})) {
		const where = `block "${type}"`;
		if (!b.component) fail(`${where}: component is required.`);
		mustExist(b.component, `${where}: component`);
		for (const [key, field] of Object.entries(b.fields ?? {})) {
			if (key === 'type') fail(`${where}: "type" is reserved for the block's type; name the field something else.`);
			if (key === 'shared') fail(`${where}: "shared" is reserved (a block-list entry \`{ "shared": … }\` uses a shared block); name the field something else.`);
			checkFieldKey(key, `${where}: field "${key}"`, fail);
			validateField(field, `${where}: field "${key}"`, { fail, textStyles, collections: ownCollections, listDepth: 0, where, siblings: b.fields });
		}
		// The block's one heading field (M3 Decision 16): its first top-level heading, else the first inside a group
		// (`left.heading`), so a block with a heading in each of two groups still gives the page one h1.
		const headingField = headingPaths(b.fields ?? {})[0] ?? null;
		// Every field gets its label (the key, title-cased, unless set), for the editor; a list's item fields too.
		const fields = withLabels(b.fields ?? {});
		if (b.help !== undefined && (typeof b.help !== 'string' || b.help.trim() === '')) fail(`${where}: help is a sentence of plain text, shown at the top of the block in the editor (got ${JSON.stringify(b.help)}).`);
		if (b.slot !== undefined && !(SLOT_NAMES as readonly unknown[]).includes(b.slot)) fail(`${where}: slot must be one of ${SLOT_NAMES.map((n) => `'${n}'`).join(' or ')}, the part of the page's frame it fills (got ${JSON.stringify(b.slot)}).`);
		const states = checkStates(where, b.states, fail);
		blocks[type] = { type, label: b.label ?? titleCase(type), component: abs(b.component), fields, headingField, ...(b.help !== undefined ? { help: b.help } : {}), ...(b.slot !== undefined ? { slot: b.slot } : {}), ...(states ? { states } : {}) };
	}

	// M6c (G5): each flat collection's List / Grid switch, once the blocks are known (a section builder's cards can come from any of them).
	for (const [name, c] of Object.entries(config.collections ?? {})) {
		const resolved = collections[name]!;
		const kind = resolved.kind === 'fields' ? 'fields' : 'sections';
		const offered = kind === 'sections' ? checkOffered(`collection "${name}"`, (c as { blocks?: unknown }).blocks, blocks, fail) : null;
		if (kind === 'fields' && (c as { blocks?: unknown }).blocks !== undefined) fail(`collection "${name}": blocks is for a section builder's picker; a list-of-fields collection has no blocks. Take it out.`);
		const view = checkView(`collection "${name}"`, (c as { view?: unknown }).view, { kind, nested: resolved.nested, fields: resolved.fields }, offered ? offered.map((type) => blocks[type]!) : Object.values(blocks), fail);
		collections[name] = { ...resolved, view, ...(offered ? { blocks: offered } : {}) };
	}

	// The page component.
	if (!config.page) fail('page (the page component) is required.');
	mustExist(config.page, 'page');

	// Brand slots: all four are Site Settings' (M5a Decision 10 moved the name and the
	// accent, M5b Decision 11 the logo and the icon), so the config's are refused.
	const brand: BrandConfig = { ...(config.brand ?? {}) };
	for (const key of ['name', 'accent'] as const) {
		if (Object.hasOwn(brand, key)) {
			fail(
				`brand.${key} has moved to Site Settings (content/site-settings.json → "brand": { "name", "accent" }), so the editor can change it; ` +
					`take it out of the config.`,
			);
		}
	}
	const mediaRefusal = brandMediaRefusal(brand);
	if (mediaRefusal) fail(mediaRefusal);

	// The site's folder in its repo (M4 Decision 3).
	const repoPath = normaliseRepoPath(config.repoPath ?? '.');
	if (repoPath === null) {
		fail(`repoPath must be a folder inside the repo, relative and "/"-separated, like 'starter' or '.' (got ${JSON.stringify(config.repoPath)}).`);
	}

	// The time zone (M4 Decision 16).
	const timeZone = config.timeZone ?? 'UTC';
	if (!isTimeZone(timeZone)) fail(`timeZone must be an IANA time zone name like 'Europe/Dublin' or 'UTC' (got ${JSON.stringify(config.timeZone)}).`);

	// The forms (M6 Decision 4): a bad entry stops the dev server and the build, naming the form and the field (checked above, with Site Settings).

	// The fallback title's separator (M8 trial, round 2): any text but an empty one or one with a line break.
	const titleSeparator = config.titleSeparator ?? DEFAULT_TITLE_SEPARATOR;
	if (typeof titleSeparator !== 'string' || !titleSeparator.trim() || /[\r\n]/.test(titleSeparator)) {
		fail(`titleSeparator must be the text between a page's title and the site's name, spaces included, like ' | ' (got ${JSON.stringify(config.titleSeparator)}).`);
	}

	// What a page without its own title falls back to (M9): the page and the brand, or the site's title.
	const titleFallback = config.titleFallback ?? 'page-and-brand';
	if (titleFallback !== 'page-and-brand' && titleFallback !== 'site') {
		fail(`titleFallback must be 'page-and-brand' (the page's title and the site's name) or 'site' (Site Settings' title on every page) (got ${JSON.stringify(config.titleFallback)}).`);
	}

	// caracms-cloud M5 Decision 1: where the site's services come from.
	const services = config.services ?? null;
	if (services !== null && services !== 'cloud' && services !== 'self-hosted') {
		fail(`services must be 'cloud' (CaraCMS Cloud) or 'self-hosted' (the site's own GitHub access, bucket, imgproxy and so on) (got ${JSON.stringify(config.services)}).`);
	}

	// Vivid (vivid.ts): the feedback widget's attributes on public pages.
	const vivid = config.vivid ?? false;
	if (typeof vivid !== 'boolean') fail(`vivid must be true (public pages carry Vivid's data-vivid-field and data-vivid-edit) or false (got ${JSON.stringify(config.vivid)}).`);
	return { root, collections, blocks, textStyles, page: abs(config.page), brand, sharedFolder, phoneLinesWidth, repoPath: repoPath!, timeZone, forms, titleSeparator, titleFallback, services, vivid };
}

/** A state's key: a word the preview's `&state=<block>:<key>` and a block's `cms.state` carry. */
const STATE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Review gaps (Decision 6): a block's `states`, checked; null when it has none. */
function checkStates(where: string, states: unknown, fail: (message: string) => never): Record<string, string> | null {
	if (states === undefined) return null;
	if (!states || typeof states !== 'object' || Array.isArray(states)) fail(`${where}: states must be an object of the block's states, key → the editor's label for it, like { sent: 'Sent' }.`);
	const out: Record<string, string> = {};
	for (const [key, label] of Object.entries(states as Record<string, unknown>)) {
		if (!STATE_KEY.test(key)) fail(`${where}: state "${key}": a state's key starts with a letter and holds only letters, digits, "_" and "-".`);
		if (typeof label !== 'string' || !label.trim()) fail(`${where}: state "${key}" needs a label, the words the editor's switch shows for it.`);
		out[key] = label.trim();
	}
	return Object.keys(out).length ? out : null;
}

interface FieldCheck {
	fail: (message: string) => never;
	textStyles: Record<string, ResolvedTextStyle>;
	collections: Record<string, ResolvedCollection>;
	/**
	 * How many lists hold this field (M7 Decision 14: one level of list inside a list). At 2,
	 * inside an inner list, a list is refused.
	 */
	listDepth: number;
	/** The item of a list of one field: a list here is refused (`list(list(…))`). */
	listItem?: boolean;
	/** Inside a group: a group here is refused (the editor-friction batch: one level of sections). */
	inGroup?: boolean;
	/** Inside a group inside a list's item: a list here is refused (an inner list is one of the item's own fields). */
	groupInList?: boolean;
	/** Whose fields these are, for messages. */
	where?: string;
	/** The fields beside this one (the block's, the group's or the list row's): what a media field's `altFrom` may name. */
	siblings?: Fields;
}

/**
 * M5b Decision 11: the config's `brand.logo` and `brand.icon` are refused once Site
 * Settings holds them (the sentence names where they went), as `brand.name` is. Null
 * when the config has neither. resolveSite fails with it.
 */
export function brandMediaRefusal(brand: BrandConfig | undefined): string | null {
	const key = (['logo', 'icon'] as const).find((k) => !!brand && Object.hasOwn(brand, k));
	if (!key) return null;
	return (
		`brand.${key} has moved to Site Settings (content/site-settings.json → "brand": { "logo", "icon" }, uploaded in the editor's Site Settings), ` +
		'so the editor can change it; take it out of the config.'
	);
}

/** A field's key: no dot (dots separate a path's parts, Decision 16), not a number. */
function checkFieldKey(key: string, where: string, fail: (message: string) => never): void {
	if (key.includes('.')) fail(`${where} has a "." in its name; dots separate the parts of a field's path.`);
	if (/^\d+$/.test(key)) fail(`${where} can't be a number (it would read as a list's index in a path).`);
}

/**
 * One field's descriptor (M5a Decision 2): a kind the package knows, built with
 * its helpers, and each kind's own rules. `where` names it in the sentence.
 */
function validateField(field: Field, where: string, check: FieldCheck): void {
	const { fail } = check;
	if (!field || typeof field !== 'object' || !(FIELD_KINDS as readonly string[]).includes(field.kind)) {
		fail(`${where} isn't a field the package knows (${FIELD_KINDS.join(', ')}). Build it with the package's field helpers.`);
	}
	// M6c (G8): help is plain text, said in the sidebar.
	if (field.help !== undefined && (typeof field.help !== 'string' || field.help.trim() === '')) fail(`${where}: help is a sentence of plain text, shown under the field in the editor (got ${JSON.stringify(field.help)}).`);
	switch (field.kind) {
		case 'text':
			// M9 Decision 10.
			if (field.lines !== undefined && field.lines !== true) fail(`${where}: lines is true or left out (got ${JSON.stringify(field.lines)}).`);
			if (field.lines && !field.multiline) fail(`${where}: lines draws each typed line as its own element, so the field takes several lines. Write text({ lines: true }) without multiline: false.`);
			break;
		case 'lockup':
			if (!Object.hasOwn(check.textStyles, field.style)) fail(`${where} uses the text style "${field.style}", which isn't in textStyles.`);
			break;
		case 'select':
			if (!Array.isArray(field.options) || field.options.length === 0) fail(`${where}: a select needs at least one option.`);
			break;
		case 'link':
			if (field.addressOnly !== undefined && field.addressOnly !== true) fail(`${where}: addressOnly is true or left out (got ${JSON.stringify(field.addressOnly)}).`);
			break;
		case 'richText': {
			const headings = Array.isArray(field.headings) ? field.headings : [];
			const ok = headings.length === 0 || (headings.length === 1 && headings[0] === 'h2') || (headings.length === 2 && headings.includes('h2') && headings.includes('h3'));
			if (!ok) {
				fail(
					`${where}: richText headings must be ['h2'] or ['h2', 'h3'] (got ${JSON.stringify(field.headings)}). ` +
						"An h3 with no h2 above it breaks the page's outline, and the page's h1 is a block's heading field.",
				);
			}
			// M9 Decision 11: a heading is bold and line breaks only.
			if (field.heading !== undefined && field.heading !== true) fail(`${where}: heading is true or left out (got ${JSON.stringify(field.heading)}).`);
			if (field.heading && headings.length > 0) fail(`${where}: a heading rich-text field can't hold headings of its own; it is the block's heading. Leave headings out.`);
			if (field.heading && field.links) fail(`${where}: a heading rich-text field takes bold and line breaks only, not links. Leave links out.`);
			break;
		}
		case 'buttons':
			if (!Array.isArray(field.styles) || field.styles.length === 0) fail(`${where}: buttons need at least one style.`);
			if (!Number.isInteger(field.max) || field.max < 1) fail(`${where}: buttons' max must be a whole number of at least 1 (got ${JSON.stringify(field.max)}).`);
			if (field.allowNoLink !== undefined && field.allowNoLink !== true) fail(`${where}: allowNoLink is true or left out (got ${JSON.stringify(field.allowNoLink)}).`);
			break;
		case 'number': {
			for (const k of ['min', 'max', 'step'] as const) {
				const v = field[k];
				if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) fail(`${where}: ${k} must be a number (got ${JSON.stringify(v)}).`);
			}
			if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail(`${where}: min (${field.min}) is above max (${field.max}).`);
			if (field.step !== undefined && !(field.step > 0)) fail(`${where}: step must be above 0.`);
			break;
		}
		case 'reference':
			if (typeof field.to !== 'string' || !Object.hasOwn(check.collections, field.to)) {
				fail(`${where}: reference({ to: ${JSON.stringify(field.to)} }) must name one of the site's collections (${Object.keys(check.collections).join(', ')}).`);
			}
			break;
		case 'list': {
			// M7 Decision 14: a list of several fields may hold a list among its item fields, one level deep.
			if (check.listItem) fail(`${where}: a list of one field can't be of a list. Make it a list of several fields, list({ … }), with the inner list as one of them.`);
			if (check.listDepth >= 2) fail(`${where}: a list inside a list can't contain a list. One level of lists inside lists is the most.`);
			if (check.groupInList) fail(`${where}: a list inside a list must be one of the item's own fields, not inside a group in it.`);
			const inner = { ...check, listDepth: check.listDepth + 1, listItem: false, groupInList: false };
			if (field.item && field.fields) fail(`${where}: a list is of one field or of several, not both.`);
			if (field.item) {
				if (field.item.kind === 'group') fail(`${where}: a list can't be of a group. A list of several fields, list({ … }), already keeps each item's fields together.`);
				validateField(field.item, `${where}'s item`, { ...inner, listItem: true, siblings: undefined });
			} else {
				const entries = Object.entries(field.fields ?? {});
				if (entries.length === 0) fail(`${where}: a list needs a field, or at least one field in its object.`);
				for (const [key, sub] of entries) {
					if (key.includes('.') || /^\d+$/.test(key)) fail(`${where}: item field "${key}" can't be a number or have a "." in its name (they'd read as part of a path).`);
					validateField(sub, `${where}, item field "${key}"`, { ...inner, siblings: field.fields ?? undefined });
				}
			}
			if (field.itemLabel !== undefined && !(field.fields && Object.hasOwn(field.fields, field.itemLabel))) {
				fail(`${where}: itemLabel "${field.itemLabel}" isn't one of the list's item fields.`);
			}
			if (field.itemNoun !== undefined && (typeof field.itemNoun !== 'string' || field.itemNoun.trim() === '')) {
				fail(`${where}: itemNoun is what one row is called ("person"), so it must be some words (got ${JSON.stringify(field.itemNoun)}).`);
			}
			// M5b Decision 10: bounds that warn, never block.
			for (const k of ['min', 'max'] as const) {
				const v = field[k];
				if (v !== undefined && (!Number.isInteger(v) || v < 0)) fail(`${where}: a list's ${k} must be a whole number, 0 or more (got ${JSON.stringify(v)}).`);
			}
			if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail(`${where}: min (${field.min}) is above max (${field.max}).`);
			break;
		}
		case 'group': {
			if (check.inGroup) fail(`${where}: a group can't hold another group. Put its fields in this group, or make it a group of its own beside this one.`);
			const entries = Object.entries(isPlainFields(field.fields) ? field.fields : {});
			if (entries.length === 0) fail(`${where}: a group needs at least one field.`);
			const inner = { ...check, inGroup: true, groupInList: check.listDepth > 0, listItem: false };
			for (const [key, sub] of entries) {
				if (key.includes('.') || /^\d+$/.test(key)) fail(`${where}: group field "${key}" can't be a number or have a "." in its name (they'd read as part of a path).`);
				validateField(sub, `${where}, group field "${key}"`, { ...inner, siblings: field.fields });
			}
			break;
		}
		case 'media':
			// M5b Decision 3.
			if (field.only !== undefined && field.only !== 'image' && field.only !== 'video') fail(`${where}: media's only must be 'image' or 'video' (got ${JSON.stringify(field.only)}).`);
			if (field.play !== undefined && field.play !== 'loop') fail(`${where}: media's play can only be 'loop' (a loop-only slot, like a hero's); leave it out to let each clip choose (got ${JSON.stringify(field.play)}).`);
			if (field.play === 'loop' && field.only === 'image') fail(`${where}: play: 'loop' is for a slot that takes videos, but this one takes images only.`);
			// M9 Decision 8.
			if (field.format !== undefined && field.format !== 'webp' && field.format !== 'png') fail(`${where}: media's format must be 'png' or 'webp' (got ${JSON.stringify(field.format)}).`);
			if (field.format !== undefined && field.only === 'video') fail(`${where}: format is for images, but this slot takes videos only.`);
			if (field.altFrom !== undefined) checkAltFrom(field.altFrom, field.only, where, check);
			break;
		default:
			break;
	}
}

/**
 * A media field's `altFrom`: the name of a text field beside it (in the same block, group or
 * list row), whose words start an image's empty alt text when it's placed.
 */
function checkAltFrom(altFrom: unknown, only: MediaField['only'], where: string, check: FieldCheck): void {
	const { fail, siblings } = check;
	if (typeof altFrom !== 'string' || altFrom.trim() === '') return fail(`${where}: altFrom names a text field beside this one, whose words start the image's alt text (got ${JSON.stringify(altFrom)}).`);
	if (only === 'video') fail(`${where}: altFrom fills an image's alt text, but this slot takes videos only.`);
	if (!siblings) return fail(`${where}: altFrom "${altFrom}" must name a text field beside this one, but a list of one media field has no fields beside it. Make it a list of several fields, list({ … }), with the text field as one of them.`);
	const named = Object.hasOwn(siblings, altFrom) ? siblings[altFrom] : undefined;
	if (!named) {
		const texts = Object.entries(siblings).filter(([, f]) => f?.kind === 'text').map(([k]) => `"${k}"`);
		return fail(`${where}: altFrom "${altFrom}" isn't a field beside this one${texts.length ? ` (its text fields are ${texts.join(', ')})` : ', and there are no text fields beside it'}.`);
	}
	if (named.kind !== 'text') fail(`${where}: altFrom "${altFrom}" is a ${named.kind} field; it must name a text field, whose words start the alt text.`);
}

/** Fields with every label filled in (the key, title-cased, unless set), recursing into lists. */
/**
 * A collection's `columns` (the editor's table, pre-M7 polish), checked: a list of its
 * fields (a section builder's page fields) that show one short value, or the built-ins,
 * each once; never `title` (always first). Undefined: null (the default columns).
 */
function checkColumns(where: string, columns: unknown, fields: Fields | null, fail: (message: string) => never): string[] | null {
	if (columns === undefined) return null;
	const allowed = `${fields ? 'its fields that show one short value (text, select, toggle, date, number, a reference or a list of references), or ' : ''}'address' and 'edited'`;
	if (!Array.isArray(columns)) return fail(`${where}: columns must be a list: ${allowed}.`);
	const seen = new Set<string>();
	for (const key of columns as unknown[]) {
		if (typeof key !== 'string') return fail(`${where}: columns must be a list of names: ${allowed}.`);
		if (key === 'title') fail(`${where}: columns: the title is always the table's first column, so leave "title" out.`);
		if (seen.has(key)) fail(`${where}: columns names "${key}" twice.`);
		seen.add(key);
		if (isBuiltInColumn(key)) continue;
		const field = fields?.[key];
		if (!field) fail(`${where}: columns: "${key}" isn't one of ${allowed}.`);
		else if (!columnKindOf(field)) fail(`${where}: columns: "${key}" is a ${field.kind === 'list' ? 'list' : field.kind} field; a column shows one short value, so it can be ${COLUMN_FIELD_WORDS}. Take "${key}" out of columns.`);
	}
	return [...(columns as string[])];
}

/**
 * A collection's `sort` (posts and tags, Decision 13), checked against its columns
 * (`columns` as configured, or the default): `title` or one of them, either way, but
 * not a list of references (several titles don't order). Undefined: null (the title, A to Z).
 */
function checkSort(where: string, sort: unknown, columns: readonly string[], fields: Fields | null, fail: (message: string) => never): SortConfig | null {
	if (sort === undefined) return null;
	const example = `{ column: 'title', order: 'asc' }`;
	if (!sort || typeof sort !== 'object' || Array.isArray(sort)) return fail(`${where}: sort must be a column and an order, like ${example}.`);
	const { column, order, ...rest } = sort as Record<string, unknown>;
	const extra = Object.keys(rest)[0];
	if (extra !== undefined) fail(`${where}: sort has no "${extra}"; it's a column and an order, like ${example}.`);
	if (typeof column !== 'string' || column === '') return fail(`${where}: sort needs a column, like ${example}.`);
	if (order !== 'asc' && order !== 'desc') fail(`${where}: sort's order must be 'asc' (A to Z, oldest or lowest first) or 'desc' (got ${JSON.stringify(order)}).`);
	if (column !== 'title' && !columns.includes(column)) {
		fail(`${where}: sort: "${column}" isn't one of its table's columns (${['title', ...columns].map((k) => `'${k}'`).join(', ')}). Add "${column}" to columns, or sort by one of those.`);
	}
	const field = fields?.[column];
	if (field && columnKindOf(field) === 'references') fail(`${where}: sort: "${column}" is a list of references, which can't order the table (a document may have several). Sort by another column.`);
	return { column, order: order as SortConfig['order'] };
}

function withLabels(fields: Fields): Fields {
	return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, withLabel(field, key)]));
}

const isPlainFields = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value);

function withLabel(field: Field, key: string): Field {
	const labelled = { ...field, label: field.label ?? titleCase(key) } as Field;
	if (labelled.kind === 'group') return { ...labelled, fields: withLabels(labelled.fields) };
	if (labelled.kind === 'list') {
		if (labelled.fields) return { ...labelled, fields: withLabels(labelled.fields) };
		if (labelled.item) return { ...labelled, item: { ...labelled.item, label: labelled.item.label ?? labelled.label } };
	}
	return labelled;
}

/** `'./starter/'` → `'starter'`, `''` or `'.'` → `'.'`; null for an absolute path, `..`, a backslash or an empty part. */
function normaliseRepoPath(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null;
	const parts = value.split('/').filter((p, i, all) => !(p === '.' || (p === '' && (i === 0 || i === all.length - 1))));
	if (parts.some((p) => p === '' || p === '..')) return null;
	return parts.length ? parts.join('/') : '.';
}

function isTimeZone(value: unknown): value is string {
	if (typeof value !== 'string' || value === '') return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** The prefix a site's file takes in its repo: `''` at the root, else `'starter/'`. */
export function repoPrefix(site: Pick<ResolvedSite, 'repoPath'>): string {
	return site.repoPath === '.' ? '' : `${site.repoPath}/`;
}
