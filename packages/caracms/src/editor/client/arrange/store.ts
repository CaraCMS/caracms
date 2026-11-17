/**
 * Arrange pages: the screen's state and actions, one
 * per editor (`arrangeFor(editor)`), read by the stage (ArrangeStage.tsx) and the pane's
 * level (pane/levels/ArrangeLevel.tsx). Nothing is saved until Apply (Decision 15): the
 * state starts again from the listing each time the screen opens, and a reload does too.
 *
 *   arrange.state          { mode, orig, tree, drag, naming, renaming, collapsed, … }
 *   arrange.plan()         what it means (model.ts → makePlan), worked out once per tree
 *   arrange.drop(id, t) / newGroup() / rename… / remove(id)
 *   arrange.review() / back() / apply()
 *   arrange.leave(go?)     asks first when there are changes (the leave dialog), then goes
 *
 * Apply (Decision 10): this tab's unsent edits to what moves go first (as Change address…),
 * then one POST of the plan's request. A refusal re-reads the listing, re-plans the same
 * arrangement on it and shows the review again, naming what changed; a lock refusal names
 * the person and the document.
 */
import { isOrderedCollection, listingStamp } from '../../../page-order.ts';
import { SETTINGS_PATH } from '../../../reserved.ts';
import type { Editor } from '../editor.ts';
import { closeDialog, openDialog } from '../documents/dialogs.tsx';
import { createStore, type Store } from '../state/store.ts';
import { docId, ENDPOINTS, TAB_HEADER, type ArrangeRequest, type DocRef, type LockRefusal, type Person } from '../../types.ts';
import { addFolder, addGroup, buildTree, dropNode, folderNameCheck, indexTree, locate, makePlan, nameCheck, putIn, putInCheck, rebase, removeFolder, removeNode, renameFolder, renameGroup, takeOut, takeOutId, takeOutProblem, type ArrangeNode, type ArrangeSite, type DropTarget, type Plan } from './model.ts';
import { slugify } from '../../../slug.ts';

export type ArrangeNote =
	| { kind: 'lock'; person: Person | null; error: string }
	| { kind: 'underneath'; lines: string[]; clashes: string[] }
	| { kind: 'refused'; error: string }
	| { kind: 'failed'; error: string };

export interface ArrangeState {
	/** Arranging, the review, or the review while Apply runs. */
	mode: 'arrange' | 'review' | 'applying';
	/** The tree as the listing had it when the screen opened (or at the last re-plan), and as arranged. */
	orig: ArrangeNode[];
	tree: ArrangeNode[];
	/** Mid-drag: the row and where it would land (null: nowhere). */
	drag: { id: string; target: DropTarget | null } | null;
	/** New group (or, page folders, New folder), being named; Rename… on a group or folder, inline. */
	naming: { value: string; kind?: 'group' | 'folder' } | null;
	renaming: { id: string; value: string } | null;
	/** Page folders: Put in the addresses on a folder, its address part being typed. */
	putting: { id: string; value: string } | null;
	/** Page folders: the row whose ··· menu is open. */
	menu: string | null;
	/** Page folders: Take out of the addresses refused at a group's row (check 18): the row, why, and the row it clashes with. */
	takeOutRefused: { id: string; error: string; rowId?: string } | null;
	/** Page folders: the order stamp the screen was planned on (`PagesLayout.orderStamp`, sent as `expectOrder`). */
	orderStamp: string;
	/** Rows whose rows under them are hidden (the screen's twisties). */
	collapsed: string[];
	/** Holders whose documents the review shows one by one. */
	openHeld: string[];
	/** "Leave redirects from the old addresses" (Decision 3). */
	tick: boolean;
	note: ArrangeNote | null;
	/** After a re-plan: rows and held documents added since the screen opened. */
	added: string[];
	addedDocs: string[];
	/** New groups made so far (their ids). */
	made: number;
	/** The row an entry of the review points at while hovered (washed on the screen). */
	linked: string | null;
}

export interface Arrange {
	state: Store<ArrangeState>;
	site: ArrangeSite;
	plan(): Plan;
	/** Why Review… is off, as text and bold parts in turn; null when it's on. */
	blocked(): string[] | null;
	reset(): void;
	setDrag(drag: ArrangeState['drag']): void;
	drop(id: string, target: DropTarget): void;
	newGroup(): void;
	/** Page folders: New folder (named like New group, then at the end of the top level). */
	newFolder(): void;
	setMenu(id: string | null): void;
	removeFolder(id: string): void;
	startPutIn(id: string): void;
	setPutIn(value: string | null): void;
	confirmPutIn(): void;
	takeOut(id: string): void;
	setNaming(value: string | null): void;
	confirmNaming(): void;
	startRename(id: string): void;
	setRenaming(value: string | null): void;
	confirmRename(): void;
	remove(id: string): void;
	toggleCollapsed(id: string): void;
	toggleHeld(id: string): void;
	setLinked(id: string | null): void;
	setTick(tick: boolean): void;
	review(): void;
	back(): void;
	apply(): Promise<void>;
	/** Leave the screen (Cancel, Back, the trail): asks first when anything is arranged. */
	leave(go?: () => void): void;
}

const all = new WeakMap<Editor, Arrange>();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The collection the screen arranges (`pages`): the one the saved order is for, by the server's rule (page-order.ts). */
export function arrangeSite(editor: Pick<Editor, 'site'>): ArrangeSite {
	const pages = editor.site.collections.find(isOrderedCollection);
	return {
		collection: pages?.name ?? 'pages',
		base: pages?.urlBase ?? '/',
		home: editor.site.home.collection === pages?.name ? editor.site.home.path : 'index',
		collections: editor.site.collections,
		codeRoutes: editor.site.codeRoutes,
	};
}

export function arrangeFor(editor: Editor): Arrange {
	const had = all.get(editor);
	if (had) return had;
	const site = arrangeSite(editor);
	const start = (): ArrangeState => {
		const pages = editor.pages.get();
		const orig = buildTree(site, editor.documents.get(), pages.folders);
		return { mode: 'arrange', orig, tree: clone(orig), drag: null, naming: null, renaming: null, putting: null, menu: null, takeOutRefused: null, orderStamp: pages.orderStamp, collapsed: [], openHeld: [], tick: true, note: null, added: [], addedDocs: [], made: 0, linked: null };
	};
	const state = createStore<ArrangeState>(start());
	let cached: { orig: ArrangeNode[]; tree: ArrangeNode[]; waiting: unknown; plan: Plan } | null = null;
	const plan = () => {
		const { orig, tree } = state.get();
		const waiting = editor.liveState.get().status?.waiting;
		if (cached && cached.orig === orig && cached.tree === tree && cached.waiting === waiting) return cached.plan;
		// Made since the last Publish, or moved since and already redirected: no live address there to leave a redirect from.
		const pending = (collection: string, path: string) => (waiting ?? []).some((w) => w.collection === collection && w.path === path && (w.change === 'new' || !!w.movedFrom));
		cached = { orig, tree, waiting, plan: makePlan(site, orig, tree, { pending }) };
		return cached.plan;
	};
	/** A change to the tree, on a copy (the plan is worked out again from it). */
	const change = (edit: (tree: ArrangeNode[]) => void, patch: Partial<ArrangeState> = {}) => {
		const tree = clone(state.get().tree);
		edit(tree);
		state.update({ tree, ...patch });
	};
	const parentOf = (id: string) => locate(state.get().tree, id)?.parentId ?? null;
	const goToDocuments = () => {
		void editor.openDocument(editor.doc.get().ref, { history: 'push' }).then(() => editor.goTo('documents'));
	};

	const arrange: Arrange = {
		state,
		site,
		plan,
		blocked() {
			const s = state.get();
			if (s.naming) return [`Finish naming the new ${s.naming.kind === 'folder' ? 'folder' : 'group'} first.`];
			if (s.renaming) return [`Finish renaming ${locate(s.tree, s.renaming.id)?.node.label ?? 'the group'} first.`];
			if (s.putting) return [`Finish putting ${locate(s.tree, s.putting.id)?.node.label ?? 'the folder'} in the addresses first.`];
			const p = plan();
			if (p.emptyFresh.length) return ['', p.emptyFresh[0]!.label, ' is empty: add a page to it or remove it.'];
			if (!p.any) return ['Nothing to review yet.'];
			return null;
		},
		reset() {
			cached = null;
			state.set(start());
		},
		setDrag(drag) {
			state.update({ drag, ...(drag ? { menu: null, takeOutRefused: null } : {}) });
		},
		drop(id, target) {
			if (target.kind === 'refused') return state.update({ drag: null });
			change((tree) => dropNode(tree, id, target), { drag: null });
		},
		newGroup() {
			state.update({ naming: { value: '', kind: 'group' }, renaming: null, putting: null, menu: null, takeOutRefused: null });
		},
		newFolder() {
			state.update({ naming: { value: '', kind: 'folder' }, renaming: null, putting: null, menu: null, takeOutRefused: null });
		},
		setMenu(menu) {
			state.update({ menu, takeOutRefused: null });
		},
		removeFolder(id) {
			change((tree) => removeFolder(tree, id), { menu: null });
		},
		startPutIn(id) {
			const node = locate(state.get().tree, id)?.node;
			if (node?.kind === 'folder') state.update({ putting: { id, value: slugify(node.label) }, menu: null, naming: null, renaming: null });
		},
		setPutIn(value) {
			const p = state.get().putting;
			state.update({ putting: value === null || !p ? null : { id: p.id, value } });
		},
		confirmPutIn() {
			const s = state.get();
			if (!s.putting) return;
			const c = putInCheck(site, s.tree, s.putting.id, s.putting.value);
			if (c.bad) return;
			const { id, value } = s.putting;
			change((tree) => putIn(tree, id, value), { putting: null });
		},
		takeOut(id) {
			const s = state.get();
			const problem = takeOutProblem(site, s.tree, editor.documents.get(), id);
			if (problem) return state.update({ menu: null, takeOutRefused: { id, ...problem } });
			const fid = takeOutId(s.orig, s.tree, id, editor.pages.get().ids ?? {});
			change((tree) => takeOut(tree, id, fid), { menu: null, takeOutRefused: null });
		},
		setNaming(value) {
			const n = state.get().naming;
			state.update({ naming: value === null ? null : { value, kind: n?.kind ?? 'group' } });
		},
		confirmNaming() {
			const s = state.get();
			if (!s.naming) return;
			if (s.naming.kind === 'folder') {
				if (folderNameCheck(s.tree, s.naming.value, null, null).bad) return;
				const name = s.naming.value;
				return change((tree) => void addFolder(tree, name, s.made + 1, editor.pages.get().ids?.[''] ?? []), { naming: null, made: s.made + 1 });
			}
			const c = nameCheck(site, s.tree, s.naming.value, null, null);
			if (c.bad) return;
			// A group named like a page at the top level is that page (Decision 8): nothing to add.
			if (c.merge) return state.update({ naming: null });
			change((tree) => addGroup(tree, s.naming!.value, s.made + 1), { naming: null, made: s.made + 1 });
		},
		startRename(id) {
			const node = locate(state.get().tree, id)?.node;
			if (node) state.update({ renaming: { id, value: node.label }, naming: null });
		},
		setRenaming(value) {
			const r = state.get().renaming;
			state.update({ renaming: value === null || !r ? null : { id: r.id, value } });
		},
		confirmRename() {
			const s = state.get();
			if (!s.renaming) return;
			const { id, value } = s.renaming;
			if (locate(s.tree, id)?.node.kind === 'folder') {
				// Page folders: the name only; its level is where a clash is looked for.
				if (folderNameCheck(s.tree, value, indexTree(s.tree).get(id)!.level, id).bad) return;
				return change((tree) => renameFolder(tree, id, value), { renaming: null });
			}
			const c = nameCheck(site, s.tree, value, parentOf(id), id);
			if (c.bad) return;
			change((tree) => renameGroup(tree, id, value, c.merge ?? null), { renaming: null });
		},
		remove(id) {
			change((tree) => removeNode(tree, id));
		},
		toggleCollapsed(id) {
			const c = state.get().collapsed;
			state.update({ collapsed: c.includes(id) ? c.filter((x) => x !== id) : [...c, id] });
		},
		toggleHeld(id) {
			const o = state.get().openHeld;
			state.update({ openHeld: o.includes(id) ? o.filter((x) => x !== id) : [...o, id] });
		},
		setLinked(linked) {
			state.update({ linked });
		},
		setTick(tick) {
			state.update({ tick });
		},
		review() {
			if (arrange.blocked()) return;
			state.update({ mode: 'review', note: null, drag: null });
		},
		back() {
			if (state.get().mode === 'applying') return;
			state.update({ mode: 'arrange', note: null, added: [], addedDocs: [] });
		},
		async apply() {
			const s = state.get();
			const p = plan();
			if (s.mode !== 'review' || (s.note?.kind === 'underneath' && s.note.clashes.length)) return;
			state.update({ mode: 'applying', note: null });
			const refused = (note: ArrangeNote) => state.update({ mode: 'review', note });
			// This tab's unsent edits to what moves (and to Site Settings, which the order rides) go first.
			const refs: DocRef[] = [...movingRefs(site, p), { collection: 'settings', path: SETTINGS_PATH }];
			for (const r of refs) {
				const id = docId(r);
				let flushed = true;
				await editor.keeper?.flush(id).catch(() => (flushed = false));
				if (!flushed || editor.keeper?.dirty(id)) {
					const what = editor.documents.get().find((d) => d.collection === r.collection && d.path === r.path)?.label ?? r.path;
					return refused({ kind: 'refused', error: `${what} has changes that haven't been saved yet, so nothing can move. Sort those out first (Use mine or Discard mine, or sign in again), then apply again.` });
				}
			}
			const body: ArrangeRequest = {
				moves: p.moves,
				order: p.order,
				...(Object.keys(p.folders).length ? { folders: p.folders } : {}),
				expect: expected(site, p),
				// Page folders (Decision 12): the order and folders the review was planned on.
				expectOrder: s.orderStamp,
				...(p.live && !s.tick ? { redirect: false } : {}),
			};
			const answer = await post(editor, body);
			if (!answer.ok) {
				if (answer.code === 'locked') return refused({ kind: 'lock', person: answer.lock?.person ?? null, error: answer.error });
				if (answer.status === 0 || answer.status >= 500 || answer.status === 401) return refused({ kind: 'failed', error: answer.error });
				// Something changed underneath (Decision 10): the same arrangement on the listing as it is now.
				await editor.refreshDocuments().catch(() => undefined);
				const now = state.get();
				const pages = editor.pages.get();
				const r = rebase(site, now.orig, now.tree, editor.documents.get(), pages.folders, pages.ids ?? {});
				const holders = [...indexTree(r.tree).values()].filter((x) => x.node.holds?.docs.some((d) => r.addedDocs.includes(d.path))).map((x) => x.node.id);
				state.update({ orig: r.orig, tree: r.tree, orderStamp: pages.orderStamp, added: r.added, addedDocs: r.addedDocs, openHeld: [...new Set([...now.openHeld, ...holders])] });
				return refused(r.notes.length || r.clashes.length ? { kind: 'underneath', lines: r.notes, clashes: r.clashes } : { kind: 'refused', error: answer.error });
			}
			for (const r of refs) editor.keeper?.discard(docId(r));
			await editor.refreshDocuments().catch(() => undefined);
			// The document under the screen goes with its page when it moved.
			const open = editor.doc.get().ref;
			const to = open.collection === site.collection ? newPathOf(p, open.path) : null;
			const total = p.total;
			const later = editor.mode === 'live' ? (total === 1 ? ' It goes live at the next Publish.' : ' They go live at the next Publish.') : '';
			const text = total ? `Applied: ${p.lead} ${total === 1 ? 'has a new address' : 'have new addresses'}.${later}` : p.folderLines.length ? 'Applied: the Pages tree’s folders and order are saved.' : 'Applied: the Pages tree’s new order is saved.';
			arrange.reset();
			await editor.openDocument(to ? { collection: open.collection, path: to } : open, { history: 'push' });
			editor.goTo('documents');
			editor.toast(text, 'check');
			editor.announce(text);
		},
		leave(go = goToDocuments) {
			if (state.get().mode === 'applying') return;
			const proceed = () => {
				arrange.reset();
				go();
			};
			if (!plan().any) return proceed();
			openDialog(editor, {
				kind: 'arrange-leave',
				go: () => {
					closeDialog(editor);
					proceed();
				},
			});
		},
	};
	editor.arrangeGuard = {
		ask(go) {
			if (editor.view.get().level !== 'arrange' || !plan().any) {
				if (editor.view.get().level === 'arrange') arrange.reset();
				return false;
			}
			arrange.leave(go);
			return true;
		},
		up() {
			const s = state.get();
			if (s.naming || s.renaming || s.putting) return;
			if (s.mode === 'review') arrange.back();
			else if (s.mode === 'arrange') arrange.leave();
		},
	};
	// Each time the screen opens, it starts from the listing as it is (Decision 15).
	editor.view.subscribe((next, previous) => {
		if (next.level === 'arrange' && previous.level !== 'arrange') arrange.reset();
	});
	all.set(editor, arrange);
	return arrange;
}

/** Every document whose address the plan changes, by its path now: the pages, and the held documents that go with them. */
function movingRefs(site: ArrangeSite, p: Plan): DocRef[] {
	const out: DocRef[] = [];
	for (const id of p.moved) out.push({ collection: site.collection, path: p.orig.get(id)!.path });
	for (const h of p.heldMoved) for (const d of h.docs) out.push({ collection: h.collection, path: d.path });
	return out;
}

/**
 * Decision 10: the listing the review was planned on, as the server checks it at Apply
 * (`ArrangeRequest.expect`): every page's path, and each moving holder's documents'.
 */
function expected(site: ArrangeSite, p: Plan): Record<string, string> {
	const pages = [...p.orig.values()].filter((x) => x.node.kind === 'page').map((x) => x.path);
	const out: Record<string, string> = { [site.collection]: listingStamp(pages) };
	for (const h of p.heldMoved) out[h.collection] = listingStamp(h.docs.map((d) => d.path));
	return out;
}

/** Where a page of the arranged collection is after the plan (its path now, if it moves). */
function newPathOf(p: Plan, path: string): string | null {
	for (const [id, y] of p.orig) if (y.path === path && p.now.has(id) && p.now.get(id)!.path !== path) return p.now.get(id)!.path;
	return null;
}

type Answer = { ok: true } | { ok: false; status: number; error: string; code: string | null; lock: LockRefusal['lock'] | null };

async function post(editor: Editor, body: ArrangeRequest): Promise<Answer> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
	if (editor.liveSession) headers[TAB_HEADER] = editor.liveSession.tab;
	let response: Response;
	try {
		response = await fetch(ENDPOINTS.arrange, { method: 'POST', headers, body: JSON.stringify(body) });
	} catch {
		return { ok: false, status: 0, error: "The server can't be reached. Nothing was applied; try again in a moment.", code: 'offline', lock: null };
	}
	const said = (await response.json().catch(() => ({}))) as Partial<LockRefusal> & { error?: string; code?: string };
	if (response.status === 401 && editor.liveSession) editor.liveState.update({ signedOut: said as never });
	if (!response.ok) return { ok: false, status: response.status, error: said.error ?? `The server said no (${response.status}).`, code: said.code ?? null, lock: said.lock ?? null };
	return { ok: true };
}
