/**
 * Arrange pages: the screen's model. Pure and
 * browser-safe, so the screen, its review and the unit tests agree.
 *
 * - **The tree** (`buildTree`): the Pages listing as nodes, in the listing's order (the
 *   server's order rule, Decision 7), a folder with no page of its own as a group just
 *   before its first child (as nav/tree.ts does), each held collection on its page.
 *   A node's `id` is its path as listed (a page and the folder of its pages are one node),
 *   or `new:<n>` for a group made on the screen. The id never changes while arranging, so
 *   the tree as it was (`orig`) and as it is now (`tree`) line up by id.
 * - **The plan** (`makePlan`): what the arrangement means, worked out from the two trees:
 *   the Apply's request (roots only, and the full child list of every level that changed:
 *   the spec's Contracts → "Apply request"), the review's old → new list (Decisions 3, 12,
 *   14, 21), and the pane's list of changes.
 * - **The checks** (`checkDrop`, `nameCheck`): a drop or a name refused on the screen, at
 *   the drop (Decision 8), Home taking nothing (Decision 13), a held collection's row
 *   taking nothing (Decision 12), a group's name by the new-page rules (Decision 17).
 * - **Re-planning** (`rebase`, Decision 10): the same arrangement on a fresh listing, after
 *   the server refused an Apply, with what changed underneath named.
 * - **Page folders**: a third kind of node, `folder`, that
 *   isn't in any address. Its rows are its level's rows (a folder holds siblings only, no
 *   folders inside folders); `Placed.level` is a row's address parent, past any folder. The
 *   plan sends each changed level's order with the folders' tokens and its folders; the
 *   folder-only lines (`Plan.folderLines`) say what changes without changing an address.
 */
import { titleCase } from '../../../fields.ts';
import { documentsNoun } from '../../../held.ts';
import { INDEX_MESSAGE, NO_ADDRESS_MESSAGE, RESERVED_SLUG, addressProblem, slugify, type AddressCollection } from '../../../slug.ts';
import type { CodeRoute } from '../../../code-routes.ts';
import type { ArrangeFolder, ListedDocument } from '../../types.ts';
import { newFolderId, type ListedFolders } from '../../../page-folders.ts';
import { andList, singular } from '../documents/actions.ts';

/** A collection a page holds, as its row on the screen shows it (Decision 12). */
export interface HeldRow {
	collection: string;
	label: string;
	icon: string;
	/** Its word for one document and for several: "case study", "case studies". */
	one: string;
	many: string;
	/** Every document in it, hidden ones included (as the sidebar counts them). */
	docs: { path: string; url: string | null }[];
}

export interface ArrangeNode {
	/** Its path as listed, or `new:<n>` for a group made here. Constant while arranging. */
	id: string;
	kind: 'page' | 'group' | 'folder';
	/** Its address part; `''` for a folder (it isn't in any address). */
	slug: string;
	label: string;
	/** A page's own "hidden" (M9), not one it has from a page above it. */
	hidden: boolean;
	holds: HeldRow | null;
	kids: ArrangeNode[];
	/** A group made on this screen (Decision 17). */
	fresh?: boolean;
	/** Groups this page took in (Decision 8): dropped beside one with its slug, or one renamed to its slug. */
	joined?: { label: string; how: 'drop' | 'name' }[];
	/** Page folders: a folder's id (its token's, kept on rename). */
	fid?: string;
	/** Page folders: a folder put in the addresses (now a group), or a group taken out (now a folder). */
	was?: 'folder' | 'group';
	/** Page folders: the folder this page (or group) took the place of, when the folder went into the addresses at its address part. */
	absorbed?: string;
	/** Page folders: folders inside a group taken out of the addresses, dissolved into it (their names). */
	dissolved?: string[];
	/** Page folders: groups taken out of the addresses while filed here, whose rows joined this folder (their names). */
	took?: string[];
}

/** What the model needs of the site. */
export interface ArrangeSite {
	/** The nested collection being arranged (`pages`). */
	collection: string;
	/** Its `urlBase` (`/`). */
	base: string;
	/** Home's path (`index`). */
	home: string;
	collections: readonly (AddressCollection & { kind?: string; heldBy?: string | null; holder?: { collection: string; path: string } | null; nested?: boolean })[];
	codeRoutes?: readonly CodeRoute[];
}

export interface Placed {
	node: ArrangeNode;
	/** The parent's id; null at the top level. */
	parent: string | null;
	/** Its path in this tree. */
	path: string;
	/** Hidden on the site: its own flag, or a page above it hidden. */
	hidden: boolean;
	depth: number;
	/** Page folders: its address parent's id (the parent, past a folder); null at the top level. */
	level: string | null;
	/** Page folders: the folder it's filed in, or null. */
	folder: string | null;
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A folder node's id on the screen: `folder:(company)`, `folder:services/(extras)`. */
export const folderNodeId = (level: string, fid: string): string => `folder:${level === '' ? '' : `${level}/`}(${fid})`;

/** The tree from the listing, in its order (the server's order rule), each folder wrapped round its rows in their place. */
export function buildTree(site: ArrangeSite, documents: readonly ListedDocument[], folders: ListedFolders = {}): ArrangeNode[] {
	const docs = documents.filter((d) => d.collection === site.collection);
	const byPath = new Map<string, ArrangeNode>();
	const top: ArrangeNode[] = [];
	const place = (path: string, node: ArrangeNode) => {
		byPath.set(path, node);
		const parent = parentOf(path);
		(parent ? ensure(parent).kids : top).push(node);
	};
	const ensure = (path: string): ArrangeNode => {
		const had = byPath.get(path);
		if (had) return had;
		const slug = path.slice(path.lastIndexOf('/') + 1);
		const group: ArrangeNode = { id: path, kind: 'group', slug, label: titleCase(slug), hidden: false, holds: null, kids: [] };
		place(path, group);
		return group;
	};
	for (const d of docs) {
		const slug = d.path.slice(d.path.lastIndexOf('/') + 1);
		const had = byPath.get(d.path);
		const own = { kind: 'page' as const, label: d.label, hidden: !!d.hiddenSelf };
		if (had) Object.assign(had, own);
		else place(d.path, { id: d.path, slug, holds: null, kids: [], ...own });
	}
	for (const c of site.collections) {
		if (c.heldBy !== site.collection || c.holder?.collection !== site.collection) continue;
		const holder = byPath.get(c.holder.path);
		if (!holder || holder.kind !== 'page') continue;
		holder.holds = {
			collection: c.name,
			label: c.label,
			icon: c.kind === 'fields' ? 'case' : 'journal',
			one: singular({ kind: 'sections', nested: false, label: c.label }),
			many: documentsNoun(c.label),
			docs: documents.filter((d) => d.collection === c.name).map((d) => ({ path: d.path, url: d.url })),
		};
	}
	// Page folders: each folder takes its first row's place, its rows inside it in its order.
	for (const [level, list] of Object.entries(folders)) {
		const kids = level === '' ? top : byPath.get(level)?.kids;
		if (!kids) continue;
		for (const f of list) {
			const rows = f.rows.map((r) => kids.find((k) => k.id === r)).filter((k): k is ArrangeNode => !!k);
			if (!rows.length) continue;
			const at = Math.min(...rows.map((r) => kids.indexOf(r)));
			const node: ArrangeNode = { id: folderNodeId(level, f.id), kind: 'folder', slug: '', fid: f.id, label: f.name, hidden: false, holds: null, kids: rows };
			for (const r of rows) kids.splice(kids.indexOf(r), 1);
			kids.splice(Math.min(at, kids.length), 0, node);
		}
	}
	return top;
}

export function indexTree(tree: readonly ArrangeNode[]): Map<string, Placed> {
	const out = new Map<string, Placed>();
	const walk = (nodes: readonly ArrangeNode[], parent: string | null, pp: string, hidden: boolean, depth: number, level: string | null, folder: string | null) => {
		for (const node of nodes) {
			if (node.kind === 'folder') {
				// Not in any address: its path is its token's, and its rows are at its level.
				out.set(node.id, { node, parent, path: pp ? `${pp}/(${node.fid})` : `(${node.fid})`, hidden, depth, level, folder: null });
				walk(node.kids, node.id, pp, hidden, depth + 1, level, node.id);
				continue;
			}
			const path = pp ? `${pp}/${node.slug}` : node.slug;
			const h = hidden || (node.kind === 'page' && node.hidden);
			out.set(node.id, { node, parent, path, hidden: h, depth, level, folder });
			walk(node.kids, node.id, path, h, depth + 1, node.id, null);
		}
	};
	walk(tree, null, '', false, 0, null, null);
	return out;
}

/** A level's rows, folders opened out: the pages and groups at that address level. */
export const flatKids = (kids: readonly ArrangeNode[]): ArrangeNode[] => kids.flatMap((k) => (k.kind === 'folder' ? k.kids : [k]));

/** The address level a drop into `parentId` lands at (past a folder), and its path (`''` at the top level). */
export function levelOf(index: ReadonlyMap<string, Placed>, parentId: string | null): { id: string | null; path: string } {
	if (!parentId) return { id: null, path: '' };
	const p = index.get(parentId);
	if (!p) return { id: null, path: '' };
	if (p.node.kind !== 'folder') return { id: parentId, path: p.path };
	return p.level ? { id: p.level, path: index.get(p.level)!.path } : { id: null, path: '' };
}

/** A row's public address: `/about/team`, Home `/`, a group `/services/`. */
export function addressAt(site: Pick<ArrangeSite, 'base' | 'home'>, kind: ArrangeNode['kind'], path: string): string {
	if (kind === 'folder') return '';
	if (kind === 'group') return `${site.base}${path}/`;
	return path === site.home ? site.base : `${site.base}${path}`;
}

export function locate(tree: ArrangeNode[], id: string, parentId: string | null = null): { list: ArrangeNode[]; i: number; node: ArrangeNode; parentId: string | null } | null {
	for (let i = 0; i < tree.length; i++) {
		const node = tree[i]!;
		if (node.id === id) return { list: tree, i, node, parentId };
		const found = locate(node.kids, id, node.id);
		if (found) return found;
	}
	return null;
}

export const countPages = (nodes: readonly ArrangeNode[]): number => nodes.reduce((k, n) => k + (n.kind === 'page' ? 1 : 0) + countPages(n.kids), 0);
/** A group with no page anywhere under it (only groups that go, or nothing): it goes too, or, new, it's empty. */
export const pageless = (node: ArrangeNode): boolean => node.kind !== 'page' && countPages(node.kids) === 0;
export const countGroups = (nodes: readonly ArrangeNode[]): number => nodes.reduce((k, n) => k + (n.kind === 'group' ? 1 : 0) + countGroups(n.kids), 0);
export const countFolders = (nodes: readonly ArrangeNode[]): number => nodes.reduce((k, n) => k + (n.kind === 'folder' ? 1 : 0) + countFolders(n.kids), 0);

// ── Changing the tree (each on a clone the store then keeps) ────────────────────

/** Move `id` into `parentId` (null: the top level), before `beforeId` (null: at the end). */
export function moveNode(tree: ArrangeNode[], id: string, parentId: string | null, beforeId: string | null): void {
	const s = locate(tree, id);
	if (!s) return;
	s.list.splice(s.i, 1);
	const list = parentId ? locate(tree, parentId)?.node.kids : tree;
	if (!list) return void s.list.splice(s.i, 0, s.node);
	let at = beforeId ? list.findIndex((x) => x.id === beforeId) : -1;
	if (at < 0) at = list.length;
	list.splice(at, 0, s.node);
}

/** A drop that landed: a move, or (Decision 8) a page taking the place of a group with its slug, the group's pages under it. */
export function dropNode(tree: ArrangeNode[], id: string, target: Exclude<DropTarget, { kind: 'refused' }>): void {
	if (!target.merge) return moveNode(tree, id, target.parentId, target.beforeId);
	const s = locate(tree, id);
	const g = locate(tree, target.merge);
	if (!s || !g) return;
	s.list.splice(s.i, 1);
	const at = g.list.indexOf(g.node);
	s.node.kids = [...s.node.kids, ...g.node.kids];
	s.node.joined = [...(s.node.joined ?? []), ...(g.node.joined ?? []), { label: g.node.label, how: 'drop' }];
	g.list.splice(at, 1, s.node);
}

/** New group (Decision 17): at the end of the top level. Returns its id. */
export function addGroup(tree: ArrangeNode[], label: string, n: number): string {
	const id = `new:${n}`;
	tree.push({ id, kind: 'group', slug: slugify(label), label: label.trim(), hidden: false, holds: null, kids: [], fresh: true });
	return id;
}

/** Rename… on a group; a name that's a sibling page's slug puts the group's pages under that page (Decision 8). */
export function renameGroup(tree: ArrangeNode[], id: string, label: string, merge: string | null): void {
	const g = locate(tree, id);
	if (!g) return;
	if (merge) {
		const page = locate(tree, merge)?.node;
		if (!page) return;
		g.list.splice(g.i, 1);
		page.kids = [...page.kids, ...g.node.kids];
		page.joined = [...(page.joined ?? []), { label: g.node.label, how: 'name' }];
		return;
	}
	g.node.label = label.trim();
	g.node.slug = slugify(label);
}

export function removeNode(tree: ArrangeNode[], id: string): void {
	const s = locate(tree, id);
	if (s) s.list.splice(s.i, 1);
}

// ── Page folders ───────────────────────────────────────────────────────────────

/** New folder (Decision 4): at the end of the top level, its id from its name past the ids `taken` there (drawn or not, check 7). Returns its node's id. */
export function addFolder(tree: ArrangeNode[], label: string, n: number, taken: Iterable<string>): string {
	const id = `newf:${n}`;
	const used = new Set(taken);
	for (const k of tree) if (k.kind === 'folder' && k.fid) used.add(k.fid);
	tree.push({ id, kind: 'folder', slug: '', fid: newFolderId(label, used), label: label.trim(), hidden: false, holds: null, kids: [], fresh: true });
	return id;
}

/** Rename… on a folder: the name only (its id, and so its place and open state, is kept). */
export function renameFolder(tree: ArrangeNode[], id: string, label: string): void {
	const f = locate(tree, id);
	if (f) f.node.label = label.trim();
}

/** Remove on a folder: its rows go back to its level, in its place and order. */
export function removeFolder(tree: ArrangeNode[], id: string): void {
	const f = locate(tree, id);
	if (f) f.list.splice(f.i, 1, ...f.node.kids);
}

/**
 * Put in the addresses (Decision 6): the folder becomes a group at `part`, its rows under it in
 * order. When `part` is a row's own slug, that row takes the folder's place and the rest go
 * under it, after what it has.
 */
export function putIn(tree: ArrangeNode[], id: string, part: string): void {
	const f = locate(tree, id);
	if (!f || f.node.kind !== 'folder') return;
	const slug = slugify(part);
	const member = f.node.kids.find((k) => k.slug === slug);
	if (member) {
		member.kids = [...member.kids, ...f.node.kids.filter((k) => k !== member)];
		member.absorbed = f.node.label;
		f.list.splice(f.i, 1, member);
		return;
	}
	f.node.kind = 'group';
	f.node.slug = slug;
	// Taken out and put back in on the screen: it's the group it was.
	if (f.node.was === 'group') delete f.node.was;
	else f.node.was = 'folder';
}

/**
 * Take out of the addresses (Decision 6): the group's rows move up a level, in order, in a
 * folder with its name in its place (id `fid`), folders inside it dissolving into it. A group
 * filed in a folder gives its rows to that folder instead (no folders inside folders).
 */
export function takeOut(tree: ArrangeNode[], id: string, fid: string): void {
	const g = locate(tree, id);
	if (!g || g.node.kind !== 'group') return;
	const inner = g.node.kids.filter((k) => k.kind === 'folder').map((k) => k.label);
	const rows = flatKids(g.node.kids);
	const outer = g.parentId ? locate(tree, g.parentId)?.node : null;
	if (outer?.kind === 'folder') {
		g.list.splice(g.i, 1, ...rows);
		outer.took = [...(outer.took ?? []), g.node.label];
		if (inner.length) outer.dissolved = [...(outer.dissolved ?? []), ...inner];
		return;
	}
	g.node.kind = 'folder';
	g.node.slug = '';
	g.node.fid = fid;
	// Put in and taken back out on the screen: it's the folder it was.
	if (g.node.was === 'folder') delete g.node.was;
	else g.node.was = 'group';
	g.node.kids = rows;
	if (inner.length) g.node.dissolved = inner;
}

/**
 * The id a group taken out of the addresses gets as a folder: its name's, past the folder ids at its level
 * (`ids`, drawn or not, as listed, and the folders drawn there now). A folder put in the addresses on this
 * screen and taken back out gets its own id back, so the plan comes back empty.
 */
export function takeOutId(origTree: readonly ArrangeNode[], tree: readonly ArrangeNode[], id: string, ids: Readonly<Record<string, readonly string[]>>): string {
	const index = indexTree(tree);
	const x = index.get(id)!;
	const kids = x.level ? index.get(x.level)!.node.kids : tree;
	const lp = x.level ? index.get(x.level)!.path : '';
	const o = indexTree(origTree);
	const was = o.get(id);
	const own = was?.node.kind === 'folder' && (was.level ? o.get(was.level)!.path : '') === lp ? was.node.fid : undefined;
	const taken = [...(ids[lp] ?? []).filter((t) => t !== own), ...kids.filter((k) => k.kind === 'folder').map((k) => k.fid!)];
	return newFolderId(x.node.label, taken);
}

/** A folder's name (New folder, Rename…): 1–60 characters, not a drawn folder's at its level (any case). `merge`: the folder it clashes with. */
export function folderNameCheck(tree: readonly ArrangeNode[], value: string, levelId: string | null, selfId: string | null): NameCheck {
	const name = value.trim();
	if (!name) return { slug: '', bad: true };
	if ([...name].length > 60) return { slug: '', bad: true, err: 'A folder’s name can be at most 60 characters.' };
	const index = indexTree(tree);
	const kids = levelId ? (index.get(levelId)?.node.kids ?? []) : tree;
	const same = kids.find((k) => k.kind === 'folder' && k.id !== selfId && k.label.toLowerCase() === name.toLowerCase());
	if (same) return { slug: '', bad: true, err: `There’s already a folder called ${same.label} here.`, merge: same.id };
	return { slug: '', bad: false };
}

/** Put in the addresses' address part (Decision 6): a row's own slug in the folder takes the folder's place; a sibling's outside it is refused. */
export function putInCheck(site: ArrangeSite, tree: readonly ArrangeNode[], id: string, value: string): NameCheck {
	const slug = slugify(value || '');
	if (!value.trim()) return { slug, bad: true };
	if (!slug) return { slug, bad: true, err: NO_ADDRESS_MESSAGE };
	if (slug === RESERVED_SLUG) return { slug, bad: true, err: INDEX_MESSAGE };
	const index = indexTree(tree);
	const x = index.get(id);
	if (!x || x.node.kind !== 'folder') return { slug, bad: true };
	const lp = levelOf(index, x.level).path;
	const at = (rest: string) => `${lp ? `${lp}/` : ''}${rest}`;
	const member = x.node.kids.find((k) => k.slug === slug);
	if (member) {
		const clash = x.node.kids.find((k) => k !== member && member.kids.some((m) => m.slug === k.slug));
		if (clash) return { slug, bad: true, err: `There’s already a page called ${clash.label} in ${member.label}.` };
		const rest = x.node.kids.filter((k) => k !== member).map((k) => addressAt(site, k.kind, at(`${slug}/${k.slug}`)));
		return { slug, bad: false, merge: member.id, info: `${member.label} is in this folder, so it stays at ${addressAt(site, member.kind, at(slug))} and becomes the page the others go under${rest.length ? `: ${rest.join(', ')}` : ''}.` };
	}
	const siblings = flatKids(x.level ? index.get(x.level)!.node.kids : tree).filter((k) => !x.node.kids.includes(k));
	const same = siblings.find((k) => k.slug === slug);
	if (same) return { slug, bad: true, err: `There’s already a ${same.kind} called ${same.label} here; file it in the folder first, or pick another address.`, merge: same.id };
	const problem = addressProblem(addressAt(site, 'page', at(slug)), site.collection, site.collections, [], site.codeRoutes);
	if (problem) return { slug, bad: true, err: problem.message };
	const shown = x.node.kids.slice(0, 3).map((r) => addressAt(site, r.kind, at(`${slug}/${r.slug}`)));
	const k = x.node.kids.length;
	const [one, many] = x.node.kids.every((r) => r.kind === 'page') ? ['page', 'pages'] : ['row', 'rows'];
	return { slug, bad: false, info: `${k === 1 ? `Its ${one} moves` : `Its ${k} ${many} move`} under it, in this order: ${shown.join(', ')}${k > 3 ? '…' : ''}.` };
}

/** Take out of the addresses (Decision 6, check 18): why it can't be (and the row it clashes with), or null. Offered on a group only. */
export function takeOutProblem(site: ArrangeSite, tree: readonly ArrangeNode[], documents: readonly ListedDocument[], id: string): { error: string; rowId?: string } | null {
	const index = indexTree(tree);
	const x = index.get(id);
	if (!x || x.node.kind !== 'group') return { error: 'Only a group can come out of the addresses.' };
	const lp = levelOf(index, x.level).path;
	const levelKids = x.level ? index.get(x.level)!.node.kids : tree;
	const above = flatKids(levelKids).filter((k) => k.id !== id);
	const rows = flatKids(x.node.kids);
	for (const r of rows) {
		const same = above.find((k) => k.slug === r.slug);
		if (same) return { error: `Can’t take ${x.node.label} out of the addresses: there’s already a ${same.kind} called ${same.label} here.`, rowId: same.id };
	}
	const outer = x.parent ? index.get(x.parent)?.node : null;
	if (outer?.kind !== 'folder') {
		// The folder takes the group's name, and a folder's name is at most 60 characters (as the server holds it to).
		if ([...x.node.label.trim()].length > 60) return { error: `Can’t take ${x.node.label} out of the addresses: a folder’s name can be at most 60 characters. Rename it first.` };
		const named = levelKids.find((k) => k.kind === 'folder' && k.label.toLowerCase() === x.node.label.toLowerCase());
		if (named) return { error: `Can’t take ${x.node.label} out of the addresses: there’s already a folder called ${named.label} here.`, rowId: named.id };
	}
	const moving = new Set<string>();
	for (const [, y] of indexTree(rows)) if (y.node.kind === 'page') moving.add(y.node.id);
	const others = documents.filter((d) => !(d.collection === site.collection && moving.has(d.path)));
	for (const r of rows) {
		if (r.kind !== 'page') continue;
		const problem = addressProblem(addressAt(site, 'page', `${lp ? `${lp}/` : ''}${r.slug}`), site.collection, site.collections, others, site.codeRoutes);
		if (problem) return { error: `Can’t take ${x.node.label} out of the addresses: ${problem.message.replace(/\.$/, '')}.`, rowId: r.id };
	}
	return null;
}

// ── Checks ─────────────────────────────────────────────────────────────────────

export type DropTarget =
	| {
			/** Page folders: `folder` files the row at the end of that folder (`parentId`): no address changes at its level. */
			kind: 'beside' | 'inside' | 'folder';
			/** Where it lands: the parent's id (null: the top level), and the sibling it goes before (null: last). */
			parentId: string | null;
			beforeId: string | null;
			/** The row the marker is drawn against, and which edge (beside). */
			rowId: string;
			edge?: 'top' | 'bottom';
			depth: number;
			/** A page dropped beside a group with its slug: the group it becomes the page of (Decision 8). */
			merge?: string;
			/** Only the order changes (same parent, no merge). */
			same?: boolean;
			/** The level it lands in, for the marker's tag: "Top level", "In About", "Inside Company". */
			tag?: string;
	  }
	| { kind: 'refused'; rowId: string; reason: string };

/**
 * Whether a drop lands, given where the pointer is (`target` without `merge`, `same` or
 * `tag`), or why not: a page beside a page with its slug, a group beside anything with its
 * slug, a page into its own pages, an address a page can't have (reserved, a code route,
 * under another collection, a held document's).
 */
export function checkDrop(site: ArrangeSite, tree: ArrangeNode[], documents: readonly ListedDocument[], srcId: string, target: DropTarget): DropTarget {
	if (target.kind === 'refused') return target;
	const src = locate(tree, srcId);
	if (!src) return { kind: 'refused', rowId: target.rowId, reason: 'That row has gone' };
	const index = indexTree(tree);
	const t = { ...target };
	const refuse = (reason: string): DropTarget => ({ kind: 'refused', rowId: t.rowId, reason });
	const folder = src.node.kind === 'folder';
	if (t.parentId) {
		const p = index.get(t.parentId);
		if (!p) return refuse('That row has gone');
		if (p.node.kind !== 'folder' && p.path === site.home) return refuse('Home takes no pages');
		if (t.parentId === srcId || p.path.startsWith(`${index.get(srcId)!.path}/`) || locate(src.node.kids, t.parentId)) return refuse(`${src.node.label} can’t go inside itself`);
		// Page folders (Decision 3, check 4): no folders inside folders, and Home is never filed.
		if (p.node.kind === 'folder') {
			if (folder) return refuse('A folder can’t go in a folder');
			if (index.get(srcId)!.path === site.home) return refuse('Home can’t go in a folder');
		}
	}
	const level = levelOf(index, t.parentId);
	const srcLevel = index.get(srcId)!.level;
	const levelKids = level.id ? index.get(level.id)!.node.kids : tree;
	// The rows at the landing level, folders opened out, without what's moving.
	const moving = folder ? src.node.kids : [src.node];
	const list = flatKids(levelKids).filter((k) => !moving.includes(k));
	if (folder) {
		if (level.id !== srcLevel) {
			const named = levelKids.find((k) => k.kind === 'folder' && k.id !== srcId && k.label.toLowerCase() === src.node.label.toLowerCase());
			if (named) return refuse(`There’s already a folder called ${named.label} here`);
		}
		for (const k of src.node.kids) {
			const same = list.find((x) => x.slug === k.slug);
			if (same) return refuse(`There’s already a ${same.kind} called ${same.label} here`);
		}
	} else {
		const same = list.find((k) => k.slug === src.node.slug);
		if (same) {
			if (same.kind === 'page' || src.node.kind === 'group' || t.kind === 'folder' || index.get(t.parentId ?? '')?.node.kind === 'folder') return refuse(`There’s already a ${same.kind} called ${same.label} here`);
			const clash = src.node.kids.find((k) => same.kids.some((g) => g.slug === k.slug));
			if (clash) return refuse(`There’s already a page called ${clash.label} in ${same.label}`);
			t.merge = same.id;
		}
	}
	// Only the order (or the folder it's filed in) changes: the same address level, no merge.
	t.same = srcLevel === level.id && !t.merge;
	const label = (id: string) => index.get(id)?.node.label ?? '';
	t.tag = t.kind === 'folder' ? `Into ${label(t.parentId!)}` : t.kind === 'inside' ? `Inside ${label(t.parentId!)}` : t.parentId ? `In ${label(t.parentId)}` : 'Top level';
	if (!t.same && !t.merge) {
		const pp = level.path ? `${level.path}/` : '';
		const pages = (folder ? src.node.kids : [src.node]).filter((k) => k.kind === 'page');
		const ids = new Set<string>();
		for (const k of folder ? src.node.kids : [src.node]) for (const [, x] of indexTree([k])) if (x.node.kind === 'page') ids.add(x.node.id);
		const others = documents.filter((d) => !(d.collection === site.collection && ids.has(d.path)));
		for (const k of pages) {
			const problem = addressProblem(addressAt(site, 'page', `${pp}${k.slug}`), site.collection, site.collections, others, site.codeRoutes);
			if (problem) return refuse(problem.message.replace(/\.$/, ''));
		}
	}
	return t;
}

export interface NameCheck {
	slug: string;
	/** Can't be added (empty, or refused). */
	bad: boolean;
	err?: string;
	/** A sibling page with this slug: the group's pages go under it (Decision 8). */
	merge?: string;
	info?: string;
}

/** A group's name (New group, Rename…) by the new-page rules (Decision 17), among `list`, its siblings. */
export function nameCheck(site: ArrangeSite, tree: ArrangeNode[], value: string, parentId: string | null, selfId: string | null): NameCheck {
	const slug = slugify(value || '');
	if (!value.trim()) return { slug, bad: true };
	if (!slug) return { slug, bad: true, err: NO_ADDRESS_MESSAGE };
	if (slug === RESERVED_SLUG) return { slug, bad: true, err: INDEX_MESSAGE };
	const index = indexTree(tree);
	// Page folders: the level's rows, folders opened out (a folder isn't in the address).
	const level = levelOf(index, parentId);
	const list = flatKids(level.id ? (index.get(level.id)?.node.kids ?? []) : tree);
	const same = list.find((k) => k.id !== selfId && k.slug === slug);
	if (same?.kind === 'group') return { slug, bad: true, err: `There’s already a group called ${same.label} here.` };
	if (same?.kind === 'page') return { slug, bad: false, merge: same.id, info: `There’s a page called ${same.label} here, so this joins it: what you put in goes under ${same.label}.` };
	const pp = level.path ? `${level.path}/` : '';
	const problem = addressProblem(addressAt(site, 'page', `${pp}${slug}`), site.collection, site.collections, [], site.codeRoutes);
	if (problem) return { slug, bad: true, err: problem.message };
	return { slug, bad: false };
}

// ── The plan ───────────────────────────────────────────────────────────────────

export type Entry =
	| { t: 'move' | 'carried'; id: string; label: string; from: string; to: string; ind: number; vis: 'hidden' | 'shown' | null }
	| { t: 'held'; id: string; holder: string; held: HeldRow; from: string; to: string; base: string; ind: number }
	| { t: 'newgroup'; id: string; label: string; empty: boolean; ind: number }
	| { t: 'rename' | 'groupmove'; id: string; label: string; from: string; to: string; dest: string | null; fromA: string; toA: string; ind: number }
	| { t: 'gone'; id: string; label: string; ind: number }
	| { t: 'joined'; id: string; label: string; into: string; how: 'drop' | 'name'; ind: number }
	/** Page folders: a folder put in the addresses (now a group at `toA`), a group taken out (now a folder), a folder moved to another level, a row that took a folder's place. */
	| { t: 'putin'; id: string; label: string; toA: string; ind: number }
	| { t: 'takeout'; id: string; label: string; fromA: string; ind: number }
	| { t: 'fmove'; id: string; label: string; dest: string | null; ind: number }
	| { t: 'absorbed'; id: string; label: string; folder: string; at: string; ind: number };

/** One line in the pane's list of changes: an icon and its words (with the names to set in bold). */
export interface Change {
	icon: string;
	/** Text and bold parts in turn: `['', 'About', ' moves into ', 'Company', '']`, even indexes plain. */
	parts: string[];
	muted?: boolean;
}

export interface ApplyMove {
	collection: string;
	fromPath: string;
	toPath: string;
}

export interface Plan {
	orig: Map<string, Placed>;
	now: Map<string, Placed>;
	/** The Apply's request (Contracts): roots only, and the full child list of every level that changed. */
	moves: ApplyMove[];
	order: Record<string, string[]>;
	/** Page folders (Contracts → the Apply request): the full folder list of every level whose folders or order changed. */
	folders: Record<string, ArrangeFolder[]>;
	entries: Entry[];
	/** Page folders: what changes without an address changing (new, renamed, removed, emptied folders; rows filed), in words. */
	folderLines: Change[];
	changes: Change[];
	/** The levels whose order changed (a parent's id; null for the top level). */
	reorders: (string | null)[];
	/** Pages whose address changes, and the held collections that go with them. */
	moved: string[];
	heldMoved: HeldRow[];
	emptyFresh: ArrangeNode[];
	gone: string[];
	/** Anything to apply. */
	any: boolean;
	/** No address changes: only the order (Decision 21). */
	orderOnly: boolean;
	/** At least one changed address was live (the tick shows, Decision 3). */
	live: boolean;
	/** "3 pages and 24 journal entries" and its verb. */
	lead: string;
	verb: 'changes' | 'change';
	total: number;
}

export interface PlanOptions {
	/** Made since the last Publish, or moved since and already redirected: no live address to leave a redirect from. */
	pending?: (collection: string, path: string) => boolean;
}

export function makePlan(site: ArrangeSite, origTree: readonly ArrangeNode[], tree: readonly ArrangeNode[], options: PlanOptions = {}): Plan {
	const o = indexTree(origTree);
	const n = indexTree(tree);
	const addr = (x: Placed) => addressAt(site, x.node.kind, x.path);
	const moved: string[] = [];
	const heldMoved: HeldRow[] = [];
	for (const [id, x] of n) {
		const y = o.get(id);
		if (!y || x.node.kind !== 'page' || y.node.kind !== 'page') continue;
		if (y.path !== x.path) {
			moved.push(id);
			if (x.node.holds) heldMoved.push(x.node.holds);
		}
	}
	const fresh = [...n.values()].filter((x) => x.node.fresh);
	const emptyFresh = fresh.filter((x) => pageless(x.node)).map((x) => x.node);
	const gone = [...o.values()].filter((y) => y.node.kind === 'group' && n.get(y.node.id)?.node.kind === 'group' && pageless(n.get(y.node.id)!.node)).map((y) => y.node.id);
	const groupsMoved = [...n.values()].filter((x) => x.node.kind === 'group' && o.has(x.node.id) && o.get(x.node.id)!.path !== x.path);
	const joined = [...n.values()].filter((x) => x.node.joined?.length);

	// The levels whose order changed among the rows that were and still are there.
	const reorders: (string | null)[] = [];
	for (const p of [null, ...n.keys()]) {
		if (p && !o.has(p)) continue;
		const oldKids = (p ? o.get(p)!.node.kids : origTree).map((k) => k.id).filter((id) => n.get(id)?.parent === p);
		const newKids = (p ? n.get(p)!.node.kids : tree).map((k) => k.id).filter((id) => oldKids.includes(id));
		if (oldKids.join('\n') !== newKids.join('\n')) reorders.push(p);
	}

	// The request's roots: each page whose path changes and isn't carried by a root above it.
	const moves: ApplyMove[] = [];
	for (const [id, x] of n) {
		const y = o.get(id);
		if (!y || x.node.kind !== 'page' || y.node.kind !== 'page' || y.path === x.path) continue;
		const carried = moves.some((m) => y.path.startsWith(`${m.fromPath}/`) && x.path === `${m.toPath}${y.path.slice(m.fromPath.length)}`);
		if (!carried) moves.push({ collection: site.collection, fromPath: y.path, toPath: x.path });
	}

	// The request's order and folders: for every level whose rows, order, folders or what's under a row changed, its full
	// list (a folder as its token, `(id)`, in its place) and its full folder list, keyed by its path after the moves. Home is
	// always first, so it's never listed; a group that goes, and a folder with nothing to show, have no place.
	const order: Record<string, string[]> = {};
	const folders: Record<string, ArrangeFolder[]> = {};
	const holdsSome = (k: ArrangeNode) => countPages(k.kids) > 0 || !!k.holds;
	const layoutOf = (kids: readonly ArrangeNode[]) => {
		const entries: string[] = [];
		const list: ArrangeFolder[] = [];
		const ids = new Set<string>();
		for (const k of kids) {
			if (k.kind === 'folder') {
				const pages = k.kids.filter((r) => !pageless(r)).map((r) => r.slug);
				if (!pages.length) continue;
				// A folder moved here from another level whose id is taken here gets a free one.
				const id = ids.has(k.fid!) ? newFolderId(k.label, ids) : k.fid!;
				ids.add(id);
				list.push({ id, name: k.label, pages });
				entries.push(`(${id})`);
			} else if (!pageless(k) && k.slug !== site.home) entries.push(k.slug);
		}
		return { entries, folders: list };
	};
	const levelChanged = (before: readonly ArrangeNode[] | null, after: readonly ArrangeNode[]) => {
		if (!before) return after.length > 0;
		if (JSON.stringify(layoutOf(before)) !== JSON.stringify(layoutOf(after))) return true;
		return flatKids(after).some((k) => {
			const was = o.get(k.id)?.node;
			return !!was && holdsSome(was) !== holdsSome(k);
		});
	};
	const put = (path: string, before: readonly ArrangeNode[] | null, after: readonly ArrangeNode[]) => {
		const now = layoutOf(after);
		order[path] = now.entries;
		if (now.folders.length || (before && layoutOf(before).folders.length)) folders[path] = now.folders;
	};
	if (levelChanged(origTree, tree)) put('', origTree, tree);
	for (const [id, x] of n) {
		if (x.node.kind === 'folder' || x.path === site.home || pageless(x.node)) continue;
		const was = o.get(id)?.node;
		// A folder put in the addresses is a new level: its rows were at the level above.
		const before = was && was.kind !== 'folder' ? was.kids : null;
		if (levelChanged(before, x.node.kids)) put(x.path, before, x.node.kids);
	}

	// The review's list, top to bottom in the new tree: each root, then what it carries.
	const entries: Entry[] = [];
	const isRoot = (id: string) => o.get(id)!.parent !== n.get(id)!.parent;
	const visOf = (x: Placed, y: Placed) => (y.hidden !== x.hidden ? (x.hidden ? 'hidden' : 'shown') : null);
	const pushPage = (node: ArrangeNode, ind: number) => {
		const x = n.get(node.id)!;
		const y = o.get(node.id)!;
		entries.push({ t: isRoot(node.id) ? 'move' : 'carried', id: node.id, label: node.label, from: addr(y), to: addr(x), ind, vis: visOf(x, y) });
		if (node.holds) entries.push({ t: 'held', id: node.id, holder: node.label, held: node.holds, from: `${addr(y).replace(/\/$/, '')}/…`, to: `${addr(x).replace(/\/$/, '')}/…`, base: addr(x).replace(/\/$/, ''), ind: ind + 1 });
	};
	const pushJoined = (node: ArrangeNode, ind: number) => {
		for (const j of node.joined ?? []) entries.push({ t: 'joined', id: node.id, label: j.label, into: node.label, how: j.how, ind });
	};
	const carried = (nodes: readonly ArrangeNode[], ind: number) => {
		for (const k of nodes) {
			const y = o.get(k.id);
			if (k.kind === 'page') {
				if (y?.node.kind === 'page' && y.path !== n.get(k.id)!.path) pushPage(k, ind);
				carried(k.kids, ind + 1);
			} else carried(k.kids, ind);
		}
	};
	const walk = (nodes: readonly ArrangeNode[], ind: number) => {
		for (const node of nodes) {
			const x = n.get(node.id)!;
			const y = o.get(node.id);
			if (node.kind === 'folder') {
				// Page folders: a group taken out of the addresses; a folder moved to another level, its rows with it.
				if (y && y.node.kind === 'group') {
					entries.push({ t: 'takeout', id: node.id, label: node.label, fromA: addr(y), ind });
					carried(node.kids, ind + 1);
				} else if (y && !node.fresh && y.level !== x.level) {
					entries.push({ t: 'fmove', id: node.id, label: node.label, dest: x.level ? n.get(x.level)!.node.label : null, ind });
					carried(node.kids, ind + 1);
				} else walk(node.kids, ind);
				continue;
			}
			if (node.kind === 'group' && y && y.node.kind === 'folder') {
				// Page folders: a folder put in the addresses.
				entries.push({ t: 'putin', id: node.id, label: node.label, toA: addr(x), ind });
				carried(node.kids, ind + 1);
				continue;
			}
			if (node.absorbed && y && y.path === x.path) {
				// Page folders: put in at this row's own address part: it stays, and the folder's other rows go under it.
				entries.push({ t: 'absorbed', id: node.id, label: node.label, folder: node.absorbed, at: addr(x), ind });
				walk(node.kids, ind + 1);
				continue;
			}
			if (node.kind === 'group') {
				if (!y || node.fresh) {
					entries.push({ t: 'newgroup', id: node.id, label: node.label, empty: pageless(node), ind });
					walk(node.kids, ind + 1);
					continue;
				}
				if (y.path !== x.path) {
					const renamed = y.node.slug !== node.slug;
					entries.push({ t: renamed ? 'rename' : 'groupmove', id: node.id, from: y.node.label, to: node.label, label: node.label, dest: x.parent ? n.get(x.parent)!.node.label : null, fromA: addr(y), toA: addr(x), ind });
					carried(node.kids, ind + 1);
					continue;
				}
				walk(node.kids, ind);
				continue;
			}
			if (y && y.node.kind === 'page' && y.path !== x.path) {
				pushPage(node, ind);
				pushJoined(node, ind + 1);
				carried(node.kids, ind + 1);
				continue;
			}
			pushJoined(node, ind);
			walk(node.kids, ind);
		}
	};
	walk(tree, 0);
	for (const g of gone) {
		const gp = addr(o.get(g)!);
		let last = -1;
		entries.forEach((e, i) => {
			if ('from' in e && typeof e.from === 'string' && e.from.startsWith(gp)) last = i;
		});
		const at = last < 0 ? entries.length : last + 1;
		entries.splice(at, 0, { t: 'gone', id: g, label: o.get(g)!.node.label, ind: last < 0 ? 0 : entries[last]!.ind });
	}

	// Page folders: what changes without an address changing.
	const folderLines: Change[] = [];
	const levelName = (id: string | null) => (id ? `in ${n.get(id)?.node.label ?? ''}` : 'to the top level');
	for (const [id, x] of n) {
		const node = x.node;
		if (node.kind !== 'folder') continue;
		const y = o.get(id);
		// Made here and dragged into a page or group: the line says where it is (the Exit walk, step 5).
		if (!y || node.fresh) folderLines.push({ icon: 'folder', parts: x.level ? ['', node.label, ' is a new folder in ', n.get(x.level)?.node.label ?? '', pageless(node) ? ', still empty' : ''] : ['', node.label, ` is a new folder${pageless(node) ? ', still empty' : ''}`] });
		else if (y.node.kind === 'folder') {
			if (y.node.label !== node.label) folderLines.push({ icon: 'pencil', parts: ['', y.node.label, ' is renamed ', node.label, ''] });
			if (pageless(node)) folderLines.push({ icon: 'folder', muted: true, parts: ['', node.label, ' goes: no pages left in it'] });
		}
		for (const d of node.dissolved ?? []) folderLines.push({ icon: 'folder', muted: true, parts: ['', d, ` goes: its rows join ${node.label} in its place, since a folder can’t hold a folder`] });
		for (const g of node.took ?? []) folderLines.push({ icon: 'folder', muted: true, parts: ['', g, ` comes out of the addresses: its rows join ${node.label} in its place, since a folder can’t hold a folder`] });
	}
	for (const [id, y] of o) {
		if (y.node.kind !== 'folder' || n.has(id)) continue;
		// A folder inside a group taken out of the addresses: its own line is the `dissolved` one above.
		const group = y.parent ? o.get(y.parent)?.node : null;
		const into = group?.kind === 'group' ? [...n.values()].find((x) => x.node.kind === 'folder' && x.node.dissolved?.includes(y.node.label) && (x.node.id === group.id || x.node.took?.includes(group.label))) : null;
		if (into) continue;
		const took = [...n.values()].find((x) => x.node.absorbed === y.node.label && o.get(x.node.id)?.parent === id);
		if (took) folderLines.push({ icon: 'folder', muted: true, parts: ['The ', y.node.label, ` folder goes: ${took.node.label} takes its place`] });
		else {
			const rows = y.node.kids.map((k) => k.label);
			folderLines.push({ icon: 'x', parts: ['', y.node.label, ` is removed: ${andList(rows)} go${rows.length === 1 ? 'es' : ''} back ${levelName(y.level)}, in its place`] });
		}
	}
	const into = new Map<string, string[]>();
	const outOf = new Map<string, string[]>();
	for (const [id, x] of n) {
		const y = o.get(id);
		if (!y || x.node.kind === 'folder' || y.level !== x.level || y.folder === x.folder) continue;
		if (x.folder) into.set(x.folder, [...(into.get(x.folder) ?? []), x.node.label]);
		else if (y.folder && n.get(y.folder)?.node.kind === 'folder') outOf.set(y.folder, [...(outOf.get(y.folder) ?? []), x.node.label]);
	}
	for (const [f, rows] of into) folderLines.push({ icon: 'arrow-r', parts: ['', andList(rows), ` go${rows.length === 1 ? 'es' : ''} into `, n.get(f)!.node.label, ''] });
	for (const [f, rows] of outOf) folderLines.push({ icon: 'arrow-r', parts: ['', andList(rows), ` come${rows.length === 1 ? 's' : ''} out of `, n.get(f)!.node.label, ''] });

	const parts: string[] = [];
	if (moved.length) parts.push(plural(moved.length, 'page', 'pages'));
	for (const h of heldMoved) parts.push(plural(h.docs.length, h.one, h.many));
	const total = moved.length + heldMoved.reduce((k, h) => k + h.docs.length, 0);
	const pending = options.pending ?? (() => false);
	const live =
		moved.some((id) => !pending(site.collection, o.get(id)!.path)) ||
		heldMoved.some((h) => h.docs.some((d) => d.url !== null && !pending(h.collection, d.path)));
	const any = moved.length > 0 || fresh.length > 0 || gone.length > 0 || groupsMoved.length > 0 || reorders.length > 0 || joined.length > 0 || Object.keys(order).length > 0 || folderLines.length > 0;
	const plan: Plan = {
		orig: o,
		now: n,
		moves,
		order,
		folders,
		entries,
		folderLines,
		changes: [],
		reorders,
		moved,
		heldMoved,
		emptyFresh,
		gone,
		any,
		orderOnly: !moved.length && !entries.length,
		live,
		lead: andList(parts),
		verb: total === 1 ? 'changes' : 'change',
		total,
	};
	plan.changes = changesOf(plan);
	return plan;
}

/** The pane's list (the mockup's changeItems): what's been arranged so far, in words. */
function changesOf(plan: Plan): Change[] {
	const n = plan.now;
	const nameOf = (id: string) => n.get(id)?.node.label ?? '';
	const withWhat = (node: ArrangeNode) => {
		const bits: string[] = [];
		if (node.holds) bits.push(`its ${plural(node.holds.docs.length, node.holds.one, node.holds.many)}`);
		const k = countPages(node.kids);
		if (k === 1) bits.push(node.kids.find((c) => c.kind === 'page')?.label ?? 'its page');
		else if (k > 1) bits.push(`its ${k} pages`);
		return bits.length ? `, with ${andList(bits)}` : '';
	};
	const out: Change[] = [];
	for (const e of plan.entries) {
		if (e.t === 'newgroup') out.push({ icon: 'folder', parts: ['', e.label, ` is a new group${e.empty ? ', still empty' : ''}`] });
		else if (e.t === 'rename') out.push({ icon: 'pencil', parts: ['', e.from, ' is renamed ', e.to, ''] });
		else if (e.t === 'groupmove') out.push({ icon: 'arrow-r', parts: e.dest ? ['', e.label, ' moves into ', e.dest, ''] : ['', e.label, ' moves to the top level'] });
		else if (e.t === 'move') {
			const x = n.get(e.id)!;
			const tail = `${withWhat(x.node)}${e.vis === 'hidden' ? ', and will be hidden' : e.vis === 'shown' ? ', and will be shown' : ''}`;
			out.push({ icon: 'arrow-r', parts: x.parent ? ['', e.label, ' moves into ', nameOf(x.parent), tail] : ['', e.label, ` moves to the top level${tail}`] });
		} else if (e.t === 'gone') out.push({ icon: 'folder', muted: true, parts: ['', e.label, ' goes: no pages left in it'] });
		else if (e.t === 'joined') out.push({ icon: 'folder', parts: e.how === 'drop' ? ['', e.into, ' becomes ', e.label, '’s own page'] : ['', e.label, ' joins ', e.into, ': its pages go under it'] });
		else if (e.t === 'putin') out.push({ icon: 'folder-addr', parts: ['', e.label, ' goes into the addresses at ', e.toA, ': its rows move under it, in the same order'] });
		else if (e.t === 'takeout') out.push({ icon: 'folder', parts: ['', e.label, ' comes out of the addresses: its rows move up a level, in a folder named ', e.label, ''] });
		else if (e.t === 'fmove') out.push({ icon: 'arrow-r', parts: e.dest ? ['', e.label, ' moves into ', e.dest, ', with its rows'] : ['', e.label, ' moves to the top level, with its rows'] });
		else if (e.t === 'absorbed') out.push({ icon: 'folder-addr', parts: ['', e.folder, ' goes into the addresses: ', e.label, ' becomes the page the others go under'] });
	}
	out.push(...plan.folderLines);
	for (const p of plan.reorders) out.push({ icon: 'list', parts: p ? ['The order changes in ', nameOf(p), ''] : ['The order changes at the top level'] });
	return out;
}

/** "at the top level and in About": where the order changes. */
export function whereOrder(plan: Plan): string {
	return andList(plan.reorders.map((p) => (p ? `in ${plan.now.get(p)?.node.label ?? ''}` : 'at the top level')));
}

// ── Re-planning on a fresh listing (Decision 10) ───────────────────────────────

export interface Rebased {
	orig: ArrangeNode[];
	tree: ArrangeNode[];
	/** What changed underneath, one sentence each: "Kitchen pottery was added under Services since you opened this." */
	notes: string[];
	/** Rows added since, marked in the review. */
	added: string[];
	/** Held documents added since (their paths), marked in the open disclosure. */
	addedDocs: string[];
	/** Two rows that would land at one address: the arrangement can't be applied as it is. */
	clashes: string[];
}

/**
 * The same arrangement on a fresh listing: rows that went are taken out (what the person
 * moved under them stays, in their place), rows added since go where the listing has them
 * (under the same row as on the site, which may since have moved or been renamed on the
 * screen), names, hidden marks and held documents are the listing's.
 *
 * Page folders: what the person did stands (Put in, Take out, a folder's name, what they filed
 * or took out of a folder, a folder they removed), and what the listing changed that they didn't
 * touch comes in: a folder made since arrives with its rows filed in it where they still sit
 * unfiled at its level here, rows filed in (or taken out of) a folder since follow, a folder
 * renamed since takes its new name, and a folder removed since goes, its rows staying in place.
 */
export function rebase(site: ArrangeSite, oldOrig: readonly ArrangeNode[], tree: readonly ArrangeNode[], documents: readonly ListedDocument[], folders: ListedFolders = {}, ids: Readonly<Record<string, readonly string[]>> = {}): Rebased {
	const orig = buildTree(site, documents, folders);
	const was = indexTree(oldOrig);
	const fresh = indexTree(orig);
	const next = clone(tree) as ArrangeNode[];
	const notes: string[] = [];
	const added: string[] = [];
	const addedDocs: string[] = [];
	const addr = (kind: ArrangeNode['kind'], path: string) => addressAt(site, kind, path);
	const where = (level: string | null) => (level ? `under ${locate(next, level)?.node.label ?? fresh.get(level)?.node.label ?? ''}` : 'at the top level');

	// Gone since: taken out, keeping in their place whatever the person put under them.
	for (const [id, y] of was) {
		if (fresh.has(id)) continue;
		const at = locate(next, id);
		if (!at) continue;
		if (y.node.kind === 'folder') {
			// Page folders: put in the addresses here, it's the person's group now, and stays.
			if (at.node.kind !== 'folder') continue;
			if (!y.level || fresh.has(y.level)) notes.push(`The ${y.node.label} folder was removed since you opened this; its rows stay where they are.`);
		}
		if (y.node.kind === 'page') notes.push(`${y.node.label} was deleted since you opened this.`);
		const keep = at.node.kids.filter((k) => !(was.has(k.id) && !fresh.has(k.id)));
		at.list.splice(at.i, 1, ...keep);
	}
	// Still there: the listing's name, hidden mark, kind and held documents. A kind the person
	// switched on the screen (Put in, Take out) stays switched unless the listing changed it too.
	for (const [id, f] of fresh) {
		const y = was.get(id);
		const at = locate(next, id);
		if (!y || !at) continue;
		const node = at.node;
		if (y.node.kind !== f.node.kind) {
			if (f.node.kind === 'page') {
				notes.push(`${f.node.label} was made at ${addr('page', f.path)} since you opened this.`);
				added.push(id);
			} else notes.push(`${y.node.label} was deleted since you opened this; its pages stay, as a group.`);
			node.kind = f.node.kind;
			node.slug = f.node.slug;
			delete node.fid;
			delete node.was;
			delete node.dissolved;
		}
		if (f.node.kind === 'page' || !node.label) node.label = f.node.label;
		else if (y.node.kind === 'folder' && f.node.label !== y.node.label && node.label === y.node.label) {
			// Page folders: renamed since, and not by this person.
			node.label = f.node.label;
			notes.push(`The ${y.node.label} folder was renamed ${f.node.label} since you opened this.`);
		}
		node.hidden = f.node.hidden;
		const before = y.node.holds?.docs ?? [];
		const after = f.node.holds?.docs ?? [];
		node.holds = f.node.holds ? clone(f.node.holds) : null;
		if (f.node.holds && y.node.holds) {
			const newOnes = after.filter((d) => !before.some((b) => b.path === d.path));
			const lost = before.filter((b) => !after.some((d) => d.path === b.path)).length;
			const h = f.node.holds;
			if (newOnes.length) {
				addedDocs.push(...newOnes.map((d) => d.path));
				notes.push(`${f.node.label} has ${newOnes.length === 1 ? `a new ${h.one}` : `${newOnes.length} new ${h.many}`} since you opened this, so ${plural(after.length, h.one, h.many)} move with it.`);
			}
			if (lost) notes.push(`${plural(lost, h.one, h.many)} under ${f.node.label} ${lost === 1 ? 'was' : 'were'} deleted since you opened this.`);
		}
	}
	// Added since: under the same row as on the site, at the end. (Folders made since come next.)
	for (const [id, f] of fresh) {
		if (f.node.kind === 'folder' || was.has(id) || locate(next, id)) continue;
		const pp = parentOf(f.path);
		const nowIndex = indexTree(next);
		let list: ArrangeNode[] = next;
		let under = '';
		if (pp) {
			const holder = locate(next, pp)?.node ?? [...nowIndex.values()].find((x) => x.path === pp)?.node;
			if (holder) {
				list = holder.kids;
				under = holder.label;
			}
		}
		if (f.node.kind === 'group') {
			// A folder made by a page added in it: one already on the screen at that address takes its pages.
			const there = [...nowIndex.values()].find((x) => x.path === f.path);
			if (there) continue;
			list.push({ ...clone(f.node), kids: [] });
			continue;
		}
		list.push({ ...clone(f.node), kids: [] });
		added.push(id);
		notes.push(`${f.node.label} was added ${under ? `under ${under}` : 'at the top level'} since you opened this.`);
	}

	// Page folders: a row follows the listing's filing when the listing changed it and the person didn't
	// (same folder here as when the screen opened, at the same level).
	const follows = (id: string, f: Placed): boolean => {
		const nx = indexTree(next).get(id);
		if (!nx || nx.node.kind === 'folder' || f.node.kind === 'folder') return false;
		const yFolder = was.get(id)?.folder ?? null;
		return f.folder !== yFolder && nx.folder === yFolder && nx.level === f.level;
	};
	// Folders made since: each takes the place of its first row still unfiled at its level here, its rows in it in its order.
	for (const [id, f] of fresh) {
		if (f.node.kind !== 'folder' || was.has(id) || locate(next, id)) continue;
		const level = f.level ? locate(next, f.level)?.node : null;
		if (f.level && (!level || level.kind === 'folder')) continue;
		const rows = f.node.kids.filter((k) => follows(k.id, fresh.get(k.id)!));
		const name = `The ${f.node.label} folder was added ${where(f.level)} since you opened this`;
		if (!rows.length) {
			notes.push(`${name}, but you’ve arranged its rows elsewhere, so it goes.`);
			continue;
		}
		const first = locate(next, rows[0]!.id)!;
		first.list.splice(first.i, 0, { ...clone(f.node), kids: [] });
		for (const r of rows) moveNode(next, r.id, id, null);
		notes.push(`${name}, with ${andList(rows.map((r) => r.label))} in it.`);
	}
	// Rows filed in a folder, or taken out of one, since.
	const filed = new Map<string, string[]>();
	const unfiled = new Map<string, string[]>();
	for (const [id, f] of fresh) {
		if (!follows(id, f)) continue;
		const nx = indexTree(next).get(id)!;
		if (f.folder) {
			const target = indexTree(next).get(f.folder);
			if (!target || target.node.kind !== 'folder' || target.level !== f.level) continue;
			// In the listing's order: before the next row the listing has after it that's in the folder here.
			const listed = fresh.get(f.folder)!.node.kids.map((k) => k.id);
			const before = listed.slice(listed.indexOf(id) + 1).find((r) => target.node.kids.some((k) => k.id === r)) ?? null;
			moveNode(next, id, f.folder, before);
			filed.set(target.node.label, [...(filed.get(target.node.label) ?? []), nx.node.label]);
		} else if (nx.folder) {
			// In the listing's place: before the next row (or folder) the listing has after it that sits at that level here.
			const from = nx.folder;
			const label = locate(next, from)!.node.label;
			const listed = (f.level ? fresh.get(f.level)!.node.kids : orig).map((k) => k.id);
			const here = (f.level ? locate(next, f.level)!.node.kids : next).map((k) => k.id);
			const before = listed.slice(listed.indexOf(id) + 1).find((r) => r !== from && here.includes(r)) ?? null;
			moveNode(next, id, f.level, before);
			unfiled.set(label, [...(unfiled.get(label) ?? []), nx.node.label]);
		}
	}
	for (const [label, rows] of filed) notes.push(`${andList(rows)} ${rows.length === 1 ? 'was' : 'were'} filed in ${label} since you opened this.`);
	for (const [label, rows] of unfiled) notes.push(`${andList(rows)} ${rows.length === 1 ? 'was' : 'were'} taken out of ${label} since you opened this.`);
	// A level the person didn't reorder takes the listing's order (Decision 12: their Apply mustn't undo another's reorder).
	followOrder(oldOrig, tree, orig, next);
	// A folder made on this screen whose id the listing now has at its level, drawn or not (`ids`, by the listing's level path), gets a free one.
	const nowIndex = indexTree(next);
	for (const [, x] of nowIndex) {
		if (x.node.kind !== 'folder' || !x.node.fresh) continue;
		const lp = x.level ? fresh.get(x.level)?.path : '';
		const listed = [...fresh.values()].filter((y) => y.node.kind === 'folder' && y.level === x.level).map((y) => y.node.fid!);
		if (lp !== undefined) listed.push(...(ids[lp] ?? []));
		if (!listed.includes(x.node.fid!)) continue;
		const drawn = [...nowIndex.values()].filter((y) => y.node.kind === 'folder' && y.level === x.level && y.node !== x.node).map((y) => y.node.fid!);
		x.node.fid = newFolderId(x.node.label, [...listed, ...drawn]);
	}

	// Two rows at one address, or two folders with one name at a level: the person has to arrange it again.
	const clashes: string[] = [];
	const scan = (nodes: readonly ArrangeNode[], pp: string, at: string) => {
		const seen = new Map<string, ArrangeNode>();
		for (const k of flatKids(nodes)) {
			const other = seen.get(k.slug);
			if (other) {
				const [a, b] = added.includes(k.id) ? [k, other] : [other, k];
				const path = pp ? `${pp}/${k.slug}` : k.slug;
				clashes.push(`${a.label} ${added.includes(a.id) ? 'was added at' : 'is at'} ${addr(a.kind, path)}, where ${b.label} would go. Go back and move one of them.`);
			} else seen.set(k.slug, k);
			scan(k.kids, pp ? `${pp}/${k.slug}` : k.slug, `in ${k.label}`);
		}
		const named = new Set<string>();
		for (const k of nodes) {
			if (k.kind !== 'folder') continue;
			const name = k.label.toLowerCase();
			if (named.has(name)) clashes.push(`There are two folders called ${k.label} ${at} now: one was added or renamed since you opened this. Go back and rename or remove one of them.`);
			named.add(name);
		}
	};
	scan(next, '', 'at the top level');
	return { orig, tree: next, notes, added, addedDocs, clashes };
}

/**
 * Each list of rows in `next` (a level, or a folder's rows) that the person didn't reorder (its rows,
 * folders as one each, in the same order in their tree as when the screen opened, among those in both)
 * takes the listing's order: the rows the listing has there are put in its order, in the places they
 * hold now; anything else (a row moved in on the screen, a new folder) keeps its place.
 */
function followOrder(oldOrig: readonly ArrangeNode[], tree: readonly ArrangeNode[], orig: readonly ArrangeNode[], next: ArrangeNode[]): void {
	const kidsOf = (nodes: readonly ArrangeNode[], id: string | null) => (id === null ? nodes : locate(nodes as ArrangeNode[], id)?.node.kids ?? null);
	const lists: [string | null, ArrangeNode[]][] = [[null, next], ...[...indexTree(next).values()].filter((x) => x.node.kids.length).map((x): [string, ArrangeNode[]] => [x.node.id, x.node.kids])];
	for (const [id, list] of lists) {
		const before = kidsOf(oldOrig, id)?.map((k) => k.id);
		const mine = kidsOf(tree, id)?.map((k) => k.id);
		const listed = kidsOf(orig, id)?.map((k) => k.id);
		if (!before || !mine || !listed) continue;
		const a = before.filter((k) => mine.includes(k));
		const b = mine.filter((k) => before.includes(k));
		if (a.join('\n') !== b.join('\n')) continue;
		const slots = list.map((k, i) => (listed.includes(k.id) ? i : -1)).filter((i) => i >= 0);
		const sorted = slots.map((i) => list[i]!).sort((x, y) => listed.indexOf(x.id) - listed.indexOf(y.id));
		slots.forEach((i, j) => (list[i] = sorted[j]!));
	}
}
