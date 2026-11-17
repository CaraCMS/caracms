/**
 * Collections under pages (Decisions 2, 7, 11, 13): a held collection's address is the
 * address of the page that holds it, worked out from a listing, never from the config.
 *
 * - **The mount is in the content:** a page of the collection `heldBy` names says
 *   `"holds": "<collection>"` (content.ts reads it into the entry's `holds`). The
 *   collection's base is that page's address + `/` (`/journal/`), so its documents follow
 *   the page wherever it moves.
 * - **One holder or none.** No page holding it, two pages holding it, Home holding it, or
 *   the holder's own file unopenable (invalid JSON, no title): the collection has no
 *   addresses (base null) and `problem` says why, naming the files. `validate` reports the
 *   same sentence as an error; the editor shows it on the collection's sidebar entry.
 * - **A hidden holder hides its documents** (Decision 11), as a hidden page hides the pages
 *   under it: `hidden` here, and content.ts marks each document.
 * - **Pure and browser-safe** (no imports): the server resolves bases for the editor's
 *   payload, and the browser can do the same from a fresh listing.
 */

/** What resolving needs of a collection (config.ts → ResolvedCollection, the editor's payload). */
export interface HoldableCollection {
	name: string;
	label: string;
	urlBase: string | null;
	heldBy?: string | null;
}

/** What resolving needs of a listed document (content.ts → DocumentEntry). */
export interface HoldingEntry {
	collection: string;
	path: string;
	file: string;
	url: string | null;
	label: string;
	warning: { message: string } | null;
	hidden?: true;
	/** The collection key the page's file says it holds (`"holds"`), even when the file can't be opened. */
	holds?: string;
}

export interface HeldBase {
	collection: string;
	/** The holder's address + `/` (`/journal/`); null while no page holds it, or the holding is a problem. */
	base: string | null;
	/** The page that holds it; null when none does (or two do). */
	holder: { collection: string; path: string; file: string; label: string } | null;
	/** The holder is hidden from the site (itself, or a page above it), so the documents are too (Decision 11). */
	hidden: boolean;
	/** Decision 13's sentence when the collection has no addresses, naming the files; null when it's held. */
	problem: string | null;
}

const and = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** Every held collection's base, from a listing that has (at least) every document of the collections their `heldBy` names. */
export function heldBases(collections: Readonly<Record<string, HoldableCollection>>, entries: readonly HoldingEntry[]): Record<string, HeldBase> {
	const out: Record<string, HeldBase> = {};
	for (const collection of Object.values(collections)) {
		if (!collection.heldBy) continue;
		const { name, label } = collection;
		const holders = entries.filter((e) => e.collection === collection.heldBy && e.holds === name);
		const none: HeldBase = { collection: name, base: null, holder: null, hidden: false, problem: null };
		if (holders.length === 0) {
			out[name] = { ...none, problem: `No page holds ${label}, so its documents have no addresses and aren't on the site. Add "holds": "${name}" to the page they go under.` };
			continue;
		}
		if (holders.length > 1) {
			const files = holders.map((h) => h.file);
			out[name] = { ...none, problem: `${and(files)} ${files.length === 2 ? 'both' : 'all'} hold ${label}, but only one page can hold it, so its documents have no addresses. Take "holds" out of ${files.length === 2 ? 'one of them' : 'all but one'}.` };
			continue;
		}
		const page = holders[0]!;
		const holder = { collection: page.collection, path: page.path, file: page.file, label: page.label };
		if (page.path === 'index') {
			out[name] = { ...none, holder, problem: `${page.file} is Home, which can't hold ${label} (its address is the whole site's), so ${label}'s documents have no addresses. Put "holds": "${name}" on another page.` };
			continue;
		}
		if (page.warning || page.url === null) {
			const why = page.warning ? ` ${page.warning.message}` : '';
			out[name] = { ...none, holder, problem: `${page.file} holds ${label}, but it can't be opened, so ${label}'s documents have no addresses until it's fixed.${why}` };
			continue;
		}
		out[name] = { collection: name, base: `${page.url.replace(/\/+$/, '')}/`, holder, hidden: page.hidden === true, problem: null };
	}
	return out;
}

/** The site with each held collection's `urlBase` as resolved (null while it has a problem): what every address rule and the editor read. */
export function withHeldBases<C extends HoldableCollection, S extends { collections: Record<string, C> }>(site: S, bases: Readonly<Record<string, HeldBase>>): S {
	const held = Object.values(bases);
	if (held.length === 0) return site;
	const collections = { ...site.collections };
	for (const b of held) if (Object.hasOwn(collections, b.collection)) collections[b.collection] = { ...collections[b.collection]!, urlBase: b.base };
	return { ...site, collections };
}

/** Does the site have a collection a page holds? (Most don't, and skip the extra listing.) */
export const hasHeld = (collections: Readonly<Record<string, HoldableCollection>>): boolean => Object.values(collections).some((c) => !!c.heldBy);

/**
 * A held collection's word for its documents, as the editor's `singular` (documents/actions.ts)
 * names one: a plural label as it is ("case studies", "posts"), any other with "entries"
 * ("journal entries"). A held collection is flat and never shared blocks, so the label is all it takes.
 */
export function documentsNoun(label: string): string {
	const l = label.toLowerCase();
	return /ies$/.test(l) || /[^s]s$/.test(l) ? l : `${l} entries`;
}

/**
 * Decision 12's sentence: "Journal holds the journal entries. Delete the “holds” line in its
 * file, or move the journal entries to another page, first." Delete… on the page says it instead of asking.
 */
export function holdsMessage(page: string, collection: string): string {
	const noun = documentsNoun(collection);
	return `${page} holds the ${noun}. Delete the “holds” line in its file, or move the ${noun} to another page, first.`;
}
