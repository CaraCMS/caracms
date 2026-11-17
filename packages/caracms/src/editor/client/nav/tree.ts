/**
 * The Pages tree as rows (Decision 8), built from the document list. Pure, so the
 * server render, the browser and the unit tests agree.
 *
 * The reader (content.ts → listDocuments) already returns a nested collection in
 * tree order: each level Home first, then alphabetical by title, with a folder that
 * has no page of its own sorted by its label. So the rows keep the list's order; a
 * row's depth is its path's, and a folder with no page becomes a group row just
 * before its first child. (The browser can't import content.ts's pageTree: it reads
 * the disk.)
 *
 * Page folders (Decision 8): the listing already has each folder's rows together in its
 * place; the folders themselves come beside it (`PagesLayout.folders`). A folder row goes just
 * before its first row, its rows one step deeper, and it opens and closes like a group (its
 * key `pages:(company)`, `pages:services/(extras)`: the folder's id, so a rename keeps it).
 */
import { titleCase } from '../../../fields.ts';
import type { ListedFolders } from '../../../page-folders.ts';
import type { ListedDocument, UiState } from '../../types.ts';
import { groupKey } from '../../ui-state.ts';

export type TreeRow =
	| {
			kind: 'page';
			/** The document's path, which is also its tree position. */
			path: string;
			depth: number;
			doc: ListedDocument;
			/** It has pages under it: it gets a show/hide chevron as well as opening. */
			parent: boolean;
			/** Its children are shown (only meaningful when `parent`). */
			open: boolean;
			/** Its group key in the cookie (`pages:about`). */
			key: string;
			/** Documents under it (any depth), for a bubbled mark when it's closed. */
			under: ListedDocument[];
	  }
	| {
			/**
			 * Collections under pages (Decision 4): a collection the page above holds, as one row
			 * (its name and count, opening its table), the first row under its holder whenever the
			 * holder's row shows. Its documents never go in the tree.
			 */
			kind: 'held';
			/** The holder's path (the row's position). */
			path: string;
			depth: number;
			collection: string;
			label: string;
			/** Every document in it, hidden ones included (as its sidebar entry counts them). */
			count: number;
			files: string[];
	  }
	| {
			/** A folder with no page of its own: shows or hides its children only. */
			kind: 'group';
			path: string;
			depth: number;
			/** The folder name, hyphens as spaces, capital first letter (`case-studies` → "Case studies"). */
			label: string;
			open: boolean;
			key: string;
			under: ListedDocument[];
	  }
	| {
			/** Page folders: an editor-only folder; shows or hides the rows filed in it. */
			kind: 'folder';
			/** Its key's path: `(company)`, `services/(extras)` (unique beside every page path). */
			path: string;
			/** The level it's at (`""`: the top level). */
			level: string;
			id: string;
			depth: number;
			label: string;
			/** The rows filed in it (pages and groups), not the pages under them. */
			count: number;
			open: boolean;
			key: string;
			/** Every document in it (its rows and what's under them), for a bubbled mark when it's closed. */
			under: ListedDocument[];
	  };

/** A folder's path in the tree's keys: `(company)` at the top level, `services/(extras)` under Services. */
export const folderPath = (level: string, id: string): string => (level === '' ? `(${id})` : `${level}/(${id})`);

/**
 * The rows a collection's tree shows, given which groups are open. A row under a
 * closed group (at any depth) isn't returned. `documents` must be one collection's,
 * in the reader's order.
 */
export function treeRows(
	collection: string,
	documents: readonly ListedDocument[],
	open: UiState['open'],
	/** The collections pages of this one hold, each with its holder's path and its documents' files. */
	held: readonly { collection: string; label: string; holder: string; files: string[] }[] = [],
	/** Page folders: the listing's folders (the Pages collection's; `{}` for any other). */
	folders: ListedFolders = {},
): TreeRow[] {
	const paths = new Set(documents.map((d) => d.path));
	const isOpen = (path: string) => open[groupKey(collection, path)] === true;
	const under = (path: string) => documents.filter((d) => d.path.startsWith(`${path}/`));
	// Each filed row → its folder (the first folder at its level that lists it, as the listing drew it).
	const filedIn = new Map<string, { level: string; id: string; name: string; rows: string[] }>();
	for (const [level, list] of Object.entries(folders)) for (const f of list) for (const row of f.rows) if (!filedIn.has(row)) filedIn.set(row, { level, ...f });
	const prefixes = (path: string) => {
		const segments = path.split('/');
		return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
	};
	/** Folders above it (its own included): each adds a step of depth. */
	const folded = (path: string) => (path === '' ? 0 : prefixes(path).filter((p) => filedIn.has(p)).length);
	/** Hidden when any page, group or folder above it is closed (`self`: its own folder counts too). */
	const hidden = (path: string, self = true) => {
		const all = path === '' ? [] : prefixes(path);
		for (const [i, p] of all.entries()) {
			if (i < all.length - 1 && !isOpen(p)) return true;
			const f = filedIn.get(p);
			if (f && (self || i < all.length - 1) && !isOpen(folderPath(f.level, f.id))) return true;
		}
		return false;
	};
	const folderShown = new Set<string>();
	/** A folder's row, just before its first row. */
	const folderRow = (node: string) => {
		const f = filedIn.get(node);
		if (!f) return;
		const path = folderPath(f.level, f.id);
		if (folderShown.has(path)) return;
		folderShown.add(path);
		// Shown when a row at its level would be, its own folder aside.
		if (hidden(f.level === '' ? '\u0000' : `${f.level}/\u0000`, false)) return;
		rows.push({
			kind: 'folder',
			path,
			level: f.level,
			id: f.id,
			depth: (f.level === '' ? 0 : f.level.split('/').length) + folded(f.level),
			label: f.name,
			count: f.rows.length,
			open: isOpen(path),
			key: groupKey(collection, path),
			under: documents.filter((d) => f.rows.some((r) => d.path === r || d.path.startsWith(`${r}/`))),
		});
	};

	const rows: TreeRow[] = [];
	const emitted = new Set<string>();
	for (const doc of documents) {
		const segments = doc.path.split('/');
		for (let i = 1; i < segments.length; i++) {
			const folder = segments.slice(0, i).join('/');
			if (paths.has(folder) || emitted.has(folder)) continue;
			emitted.add(folder);
			folderRow(folder);
			if (hidden(folder)) continue;
			rows.push({
				kind: 'group',
				path: folder,
				depth: i - 1 + folded(folder),
				label: titleCase(segments[i - 1]!),
				open: isOpen(folder),
				key: groupKey(collection, folder),
				under: under(folder),
			});
		}
		folderRow(doc.path);
		if (hidden(doc.path)) continue;
		const kids = under(doc.path);
		rows.push({
			kind: 'page',
			path: doc.path,
			depth: segments.length - 1 + folded(doc.path),
			doc,
			parent: kids.length > 0,
			open: isOpen(doc.path),
			key: groupKey(collection, doc.path),
			under: kids,
		});
		for (const h of held) {
			if (h.holder === doc.path) rows.push({ kind: 'held', path: doc.path, depth: segments.length + folded(doc.path), collection: h.collection, label: h.label, count: h.files.length, files: h.files });
		}
	}
	return rows;
}
