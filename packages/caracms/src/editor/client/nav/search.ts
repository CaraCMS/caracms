/**
 * "Find a document" and the ⌘K switcher (Decision 9): **every document's title and
 * address, collections included, grouped by collection.** A nested page shows its
 * parent in front ("Services / Branding") and matches on its parent's name too (the
 * mockup revision's accepted reading). Pure, for the unit tests.
 *
 * Page folders (Decision 8, check 11): with the listing's folders, a page's crumb names the
 * folders it sits in ("Company / About" for Team), so it matches on them too, and a folder whose
 * name matches is a hit of its own (`SearchGroup.folders`), which opens it in the tree.
 */
import type { ListedFolders } from '../../../page-folders.ts';
import type { EditorCollection, ListedDocument } from '../../types.ts';

export interface SearchHit {
	doc: ListedDocument;
	/** The parent page's or folder's label for a nested page (`Services`), else ''. */
	crumb: string;
}

export interface SearchGroup {
	collection: EditorCollection;
	hits: SearchHit[];
	/** How many documents the collection has in all (for "2 of 40"). */
	total: number;
	/** Page folders: the folders whose name matches (the Pages collection's only). */
	folders?: FolderHit[];
}

export interface FolderHit {
	level: string;
	id: string;
	name: string;
	/** The rows filed in it. */
	count: number;
	/** The level's label, for its crumb ('' at the top level). */
	crumb: string;
}

/** A document's parent label for crumbs: its parent page's label, or its folder's name title-cased (`Services`). */
export function parentLabel(ref: { collection: string; path: string }, documents: readonly { collection: string; path: string; label: string }[]): string {
	const slash = ref.path.lastIndexOf('/');
	if (slash < 0) return '';
	const parent = ref.path.slice(0, slash);
	const page = documents.find((d) => d.collection === ref.collection && d.path === parent);
	if (page) return page.label;
	const name = parent.split('/').pop()!.replace(/[-_]+/g, ' ').trim();
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Lower-cased and with accents folded, so "cafe" finds "Café". */
export const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The text a query is matched against: title, label, address, path, and the parent's label. */
function haystack(doc: ListedDocument, crumb: string): string {
	return fold([doc.title, doc.label, doc.url ?? '', doc.path, crumb].join('\n'));
}

/**
 * Every collection's matches for `query`, in config order, each in the list's own
 * order (tree order for Pages). Empty groups are left out. A blank query matches
 * nothing (the caller shows its unfiltered list instead).
 */
export function searchDocuments(
	query: string,
	documents: readonly ListedDocument[],
	collections: readonly EditorCollection[],
	/** Page folders: the Pages collection's name and the listing's folders. */
	pages?: { collection: string; folders: ListedFolders },
): SearchGroup[] {
	const words = fold(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const filed = new Map<string, string>();
	for (const list of Object.values(pages?.folders ?? {})) for (const f of list) for (const row of f.rows) if (!filed.has(row)) filed.set(row, f.name);
	const groups: SearchGroup[] = [];
	for (const collection of collections) {
		const docs = documents.filter((d) => d.collection === collection.name);
		const inPages = collection.name === pages?.collection;
		const hits: SearchHit[] = [];
		for (const doc of docs) {
			const parent = collection.nested ? parentLabel(doc, documents) : '';
			const crumb = inPages ? [...folderNames(doc.path, filed), parent].filter(Boolean).join(' / ') : parent;
			const text = haystack(doc, crumb);
			if (words.every((w) => text.includes(w))) hits.push({ doc, crumb });
		}
		const folders: FolderHit[] = [];
		if (inPages) {
			for (const [level, list] of Object.entries(pages!.folders)) {
				for (const f of list) {
					const name = fold(f.name);
					if (words.every((w) => name.includes(w))) folders.push({ level, id: f.id, name: f.name, count: f.rows.length, crumb: level ? parentLabel({ collection: collection.name, path: `${level}/x` }, documents) : '' });
				}
			}
		}
		if (hits.length || folders.length) groups.push({ collection, hits, total: docs.length, ...(folders.length ? { folders } : {}) });
	}
	return groups;
}

/** The folders a page sits in, outermost first: its own, and those its rows above it are filed in. */
function folderNames(path: string, filed: ReadonlyMap<string, string>): string[] {
	const segments = path.split('/');
	const out: string[] = [];
	for (let i = 1; i <= segments.length; i++) {
		const name = filed.get(segments.slice(0, i).join('/'));
		if (name) out.push(name);
	}
	return out;
}

/** One collection's documents matching `query` (its own level's filter). A blank query keeps them all. */
export function filterCollection(query: string, documents: readonly ListedDocument[]): ListedDocument[] {
	const words = fold(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...documents];
	return documents.filter((d) => {
		const text = fold([d.title, d.label, d.url ?? '', d.path].join('\n'));
		return words.every((w) => text.includes(w));
	});
}
