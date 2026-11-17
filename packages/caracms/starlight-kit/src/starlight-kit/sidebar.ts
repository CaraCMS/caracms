/**
 * The sidebar, from CaraCMS's page tree, in Starlight's user-config shape
 * (`{ label, link }` and `{ label, items }`), for `<StarlightPage sidebar>`.
 *
 * - The order is the reader's: `read.documents('pages')` lists a nested collection in tree
 *   order, which follows Site Settings' `pageOrder` (the editor's Arrange pages screen).
 * - A page with pages under it becomes a group labelled with its title, its own page the
 *   group's first link. A page without is a link. A folder with no page of its own (a
 *   group the arrange screen made) becomes a group labelled like the editor labels it,
 *   unless the site gives it a label (`groupLabels`, keyed by the folder's path; the
 *   integration's `groupLabels` option, through `virtual:starlight-kit/config`).
 * - Home (`index`) is left out (Starlight's site title links to it), and so are hidden
 *   pages and everything under one.
 *
 * Assumes: a nested `pages` collection with `urlBase: '/'`. Pass the page component's
 * `read` so the editor's preview shows its drafts' order and titles.
 */
import type { DocumentReader, ReadEntry } from 'caracms/document';

export type SidebarLink = { label: string; link: string };
export type SidebarGroup = { label: string; items: SidebarItem[] };
export type SidebarItem = SidebarLink | SidebarGroup;
/** Labels for folders with no page of their own, keyed by the folder's path (`'guides'`, `'guides/advanced'`). */
export type GroupLabels = Readonly<Record<string, string>>;
export type SidebarOptions = { groupLabels?: GroupLabels };

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
// The editor's label for a folder with no page (caracms fields.ts → titleCase): hyphens as spaces, capital first.
const folderLabel = (path: string) => {
	const name = path.slice(path.lastIndexOf('/') + 1).replace(/[-_]+/g, ' ');
	return name.charAt(0).toUpperCase() + name.slice(1);
};
const isHidden = (entry: ReadEntry) => (entry.document as { hidden?: boolean }).hidden === true;

/** The pages to show, in sidebar order: every public page but Home, with its path. */
export async function sidebarPages(read: DocumentReader): Promise<ReadEntry[]> {
	const all = await read.documents('pages');
	const hidden = all.filter(isHidden).map((e) => e.path);
	const under = (path: string) => hidden.some((h) => path === h || path.startsWith(`${h}/`));
	return all.filter((e) => e.url && e.path !== 'index' && !under(e.path));
}

export async function sidebarFrom(read: DocumentReader, options: SidebarOptions = {}): Promise<SidebarItem[]> {
	const pages = await sidebarPages(read);
	const top: SidebarItem[] = [];
	// Each tree node's list of items, keyed by its path ('' is the top level).
	const lists = new Map<string, SidebarItem[]>([['', top]]);
	const listFor = (path: string): SidebarItem[] => {
		const found = lists.get(path);
		if (found) return found;
		// A folder with no page of its own: a group, placed where its first page falls.
		const group: SidebarGroup = { label: options.groupLabels?.[path] ?? folderLabel(path), items: [] };
		listFor(parentOf(path)).push(group);
		lists.set(path, group.items);
		return group.items;
	};
	const hasChildren = (path: string) => pages.some((e) => parentOf(e.path) === path);
	for (const entry of pages) {
		const link: SidebarLink = { label: entry.title, link: entry.url! };
		// Tree order puts a page before the pages under it, so its group already exists.
		const parent = listFor(parentOf(entry.path));
		if (hasChildren(entry.path)) {
			const group: SidebarGroup = { label: entry.title, items: [link] };
			parent.push(group);
			lists.set(entry.path, group.items);
		} else parent.push(link);
	}
	return top;
}
