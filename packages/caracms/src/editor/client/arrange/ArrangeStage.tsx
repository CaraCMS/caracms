/**
 * Arrange pages (the mockup's packages/caracms/test/mockups/arrange-pages.html):
 * the screen in the preview's place (Decision 16). Every page and group at every depth, Home
 * first and fixed, held collections as rows under their pages that nothing drags or drops on,
 * hidden pages marked; a row's grip, its name at its depth, its address, its end (Rename…,
 * Remove, the twisty).
 *
 * Mouse only (Decision 4): press a row and move 4px to drag it. Over a row's top or bottom
 * quarter it goes beside that row (a line at that level's indent, tagged with the level), over
 * its middle inside it (a full ring and "Inside …"); a drop that can't land says why in the
 * row (model.ts → checkDrop). A card follows the pointer with where it would go. Esc or
 * leaving the window drops nothing. While reviewing, the tree is read-only.
 *
 * Page folders (the mockup's packages/caracms/test/mockups/page-folders.html):
 * a folder row (a plain folder icon, its count, "Not in the addresses"), a group's row with a
 * folder-and-"/" icon; over a folder's middle a row is filed in it (a dashed ring and an outlined
 * "Into …" tag: no address changes); a folder's and a group's ··· menu (Put in the addresses,
 * Remove; Take out of the addresses), and Put in's address part typed in the address column.
 */
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { addressAt, checkDrop, countFolders, countGroups, countPages, flatKids, folderNameCheck, indexTree, levelOf, pageless, locate, nameCheck, plural, putInCheck, type ArrangeNode, type ArrangeSite, type DropTarget, type NameCheck, type Placed, type Plan } from './model.ts';
import { andList } from '../documents/actions.ts';
import { slugify } from '../../../slug.ts';
import { arrangeFor, type Arrange, type ArrangeState } from './store.ts';

const depthStyle = (d: number) => ({ ['--depth' as string]: d }) as CSSProperties;

export function ArrangeStage() {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	const s = useStore(arrange.state);
	const plan = arrange.plan();
	const arranging = s.mode === 'arrange';
	const tree = useRef<HTMLDivElement>(null);
	const scroll = useRef<HTMLDivElement>(null);
	useDrag(arrange, tree);
	useMarker(arrange, s, tree);
	// New group scrolls to its row at the end and puts the caret in it.
	const naming = !!s.naming;
	useEffect(() => {
		if (!naming) return;
		scroll.current?.scrollTo({ top: 1e5 });
		document.getElementById('ng-in')?.focus();
	}, [naming]);
	const renamingId = s.renaming?.id ?? null;
	useEffect(() => {
		if (!renamingId) return;
		const input = document.getElementById('rn-in') as HTMLInputElement | null;
		input?.focus();
		input?.select();
	}, [renamingId]);
	const puttingId = s.putting?.id ?? null;
	useEffect(() => {
		if (!puttingId) return;
		const input = document.getElementById('pi-in') as HTMLInputElement | null;
		input?.focus();
		input?.select();
	}, [puttingId]);
	// A row's ··· menu closes on a click outside it, or Esc.
	const menuId = s.menu;
	useEffect(() => {
		if (!menuId) return;
		const onDown = (e: MouseEvent) => {
			if ((e.target as Element | null)?.closest('.ae .menu, .ae [data-act="row-menu"]')) return;
			arrange.setMenu(null);
		};
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			e.stopImmediatePropagation();
			arrange.setMenu(null);
		};
		document.addEventListener('mousedown', onDown);
		window.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('mousedown', onDown);
			window.removeEventListener('keydown', onKey, true);
		};
	}, [menuId, arrange]);

	const rows: ReactElement[] = [];
	const walk = (nodes: readonly ArrangeNode[], d: number) => {
		for (const node of nodes) {
			if (s.drag && node.id === s.drag.id) {
				rows.push(<Row key={node.id} node={node} depth={d} plan={plan} src />);
				continue;
			}
			rows.push(<Row key={node.id} node={node} depth={d} plan={plan} />);
			if (s.collapsed.includes(node.id)) continue;
			if (node.holds) rows.push(<HeldRowView key={`held:${node.id}`} node={node} depth={d + 1} plan={plan} />);
			walk(node.kids, d + 1);
		}
	};
	walk(s.tree, 0);

	return (
		<section className="arr" aria-label="Arrange pages" data-arrange-mode={s.mode}>
			<div className="arr-head">
				<div className="arr-head-in">
					<div className="arr-title">
						<h2>Pages</h2>
						<span className="n-chip">
							{plural(countPages(s.tree), 'page', 'pages')} · {plural(countGroups(s.tree), 'group', 'groups')} · {plural(countFolders(s.tree), 'folder', 'folders')}
						</span>
					</div>
					<div>
						{arranging ? (
							<div className="arr-tools">
								<button type="button" className="btn sm" data-act="new-folder" disabled={!!s.naming || !!s.renaming || !!s.putting} onClick={() => arrange.newFolder()}>
									<Icon name="plus" size="sm" />
									New folder
								</button>
								<button type="button" className="btn sm" data-act="new-group" disabled={!!s.naming || !!s.renaming || !!s.putting} onClick={() => arrange.newGroup()}>
									<Icon name="plus" size="sm" />
									New group
								</button>
							</div>
						) : (
							<span className="arr-ro">
								<Icon name="lock" size="sm" />
								Reviewing: go back to change anything
							</span>
						)}
					</div>
					<div className="arr-hint">
						{arranging ? (
							<>
								<span>Drag a row to order it, file it in a folder or put it inside another. Everything under a page moves with it.</span>
								<span className="key">
									<span className="key-line" aria-hidden="true" />
									Beside a row, at that level
								</span>
								<span className="key">
									<span className="key-dash" aria-hidden="true" />
									Into a folder: addresses stay
								</span>
								<span className="key">
									<span className="key-ring" aria-hidden="true" />
									Inside a page or group: addresses change
								</span>
							</>
						) : (
							<span>This is how the Pages tree will read once it’s applied.</span>
						)}
					</div>
				</div>
			</div>
			<div className="arr-scroll" id="ascroll" ref={scroll}>
				<div className="arr-cols" aria-hidden="true">
					<span />
					<span>Name</span>
					<span>Address</span>
					<span />
				</div>
				<div className="arr-tree" id="atree" role="tree" aria-label="Pages" ref={tree}>
					{rows}
					{s.naming ? <NamingRow /> : null}
					<div className="amark" id="amark" hidden>
						<span className="tag" />
					</div>
				</div>
			</div>
			{s.drag ? createPortal(<Ghost />, document.body) : null}
		</section>
	);
}

function Row({ node, depth: d, plan, src = false }: { node: ArrangeNode; depth: number; plan: Plan; src?: boolean }) {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	const s = useStore(arrange.state);
	const { site } = arrange;
	const id = node.id;
	const x = plan.now.get(id)!;
	const y = node.fresh ? undefined : plan.orig.get(id);
	const home = x.path === site.home && !x.parent;
	const folder = node.kind === 'folder';
	const group = node.kind === 'group';
	const t = s.drag?.target ?? null;
	const arranging = s.mode === 'arrange';
	const renaming = s.renaming?.id === id;
	const putting = s.putting?.id === id;
	const busy = !!s.naming || !!s.renaming || !!s.putting;
	const draggable = arranging && !home && !busy;
	const isNew = (group || folder) && !!node.fresh;
	const empty = pageless(node);
	const gone = (group || folder) && !!y && !node.fresh && empty && y.node.kind === node.kind;
	const root = !!y && y.parent !== x.parent;
	const moved = !!y && y.path !== x.path;
	const into = !!t && t.kind === 'inside' && t.rowId === id;
	const file = !!t && t.kind === 'folder' && t.rowId === id;
	const refusedTake = s.takeOutRefused?.id === id ? s.takeOutRefused : null;
	const refused = !!t && t.kind === 'refused' && t.rowId === id;
	const cls = ['arow', folder ? 'is-folder' : group ? 'is-group' : 'is-page'];
	if (home) cls.push('is-home');
	if (src) cls.push('is-src');
	if (isNew && empty && !renaming) cls.push('is-empty');
	if (gone) cls.push('is-gone');
	if (renaming || putting) cls.push('is-naming');
	if (into) cls.push('is-into');
	if (file) cls.push('is-file');
	if (refused) cls.push('is-refused');
	if (s.linked === id || s.takeOutRefused?.rowId === id) cls.push('is-linked');
	// A name or an address that clashes with this row washes it (a put-in's `merge` only counts while it's bad: otherwise it's the member that takes the folder's place).
	if (clashWith(plan, s, site) === id) cls.push('is-linked');

	const marks: ReactElement[] = [];
	if (home) marks.push(<span key="home">Always first</span>);
	if (folder && !empty && !renaming) marks.push(<span key="n" className="cnt">{filedText(node)}</span>);
	if (!renaming && !putting) {
		if (isNew) marks.push(<span key="m" className="chip select">{folder ? 'New folder' : 'New group'}</span>);
		else if (y && y.node.kind !== node.kind && node.was) marks.push(<span key="m" className="chip select">{node.was === 'folder' ? 'Was a folder' : 'Was a group'}</span>);
		else if (group && y && y.node.slug !== node.slug) marks.push(<span key="m" className="chip select">Renamed</span>);
		else if (folder && y && y.node.label !== node.label) marks.push(<span key="m" className="chip select">Renamed</span>);
		else if (root) marks.push(<span key="m" className="chip select">Moved</span>);
		if (gone) marks.push(<span key="g" className="chip">Goes</span>);
	}
	if (node.kind === 'page' && y) {
		if (x.hidden && !y.hidden) marks.push(<span key="v" className="chip warn">Will be hidden</span>);
		else if (!x.hidden && y.hidden) marks.push(<span key="v" className="chip live">Will be shown</span>);
		else if (x.hidden) marks.push(<span key="v" className="hmark" data-mark="hidden" title={node.hidden ? 'Hidden from the site' : 'Hidden from the site with the page it’s under'}>Hidden</span>);
	}
	if (node.holds && s.collapsed.includes(id)) marks.push(<span key="c" className="cnt">{node.holds.label} · {node.holds.docs.length}</span>);

	const level = levelOf(plan.now, x.level);
	const check = renaming ? (folder ? folderNameCheck(s.tree, s.renaming!.value, x.level, id) : nameCheck(site, s.tree, s.renaming!.value, x.parent, id)) : null;
	const putCheck = putting ? putInCheck(site, s.tree, id, s.putting!.value) : null;
	let addr: ReactElement | string;
	let plain = false;
	if (putting) {
		addr = (
			<span className="part">
				/
				<input
					className="input"
					id="pi-in"
					value={s.putting!.value}
					aria-label={`${node.label}’s address part`}
					aria-invalid={putCheck!.err ? true : undefined}
					aria-describedby="pi-sub"
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => arrange.setPutIn(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							arrange.confirmPutIn();
						} else if (e.key === 'Escape') {
							e.preventDefault();
							arrange.setPutIn(null);
						}
					}}
				/>
				/
			</span>
		);
	} else if (folder) {
		plain = true;
		addr = renaming ? (
			'Name only: no address changes'
		) : (
			<>
				Not in the addresses
				{y && y.node.kind === 'group' ? (
					<span className="was">
						was <span className="mono">{addressAt(site, 'group', y.path)}</span>
					</span>
				) : null}
			</>
		);
	} else if (renaming) {
		const pp = level.path ? `${level.path}/` : '';
		addr = (
			<>
				<span className="new" id="rn-addr">{`${site.base}${pp}${check!.slug || '…'}/`}</span>
				<span className="was">
					was <span className="mono">{addressAt(site, node.kind, (y ?? x).path)}</span>
				</span>
			</>
		);
	} else if (gone) addr = 'No pages left in it';
	else if (moved || isNew) {
		addr = (
			<>
				<span className="new">{addressAt(site, node.kind, x.path)}</span>
				{y ? (
					y.node.kind === 'folder' ? (
						<span className="was">was a folder</span>
					) : (
						<span className="was">
							was <span className="mono">{addressAt(site, y.node.kind, y.path)}</span>
						</span>
					)
				) : null}
			</>
		);
	} else addr = addressAt(site, node.kind, x.path);

	const ends: ReactElement[] = [];
	if (into) {
		ends.push(
			<span key="tag" className="tag">
				<Icon name="arrow-r" size="xs" />
				Inside {node.label}
			</span>,
		);
	} else if (file) {
		ends.push(
			<span key="tag" className="tag file">
				<Icon name="folder" size="xs" />
				Into {node.label}
			</span>,
		);
	} else if (renaming) {
		ends.push(
			<button key="c" type="button" className="btn sm ghost" data-act="rn-cancel" onClick={() => arrange.setRenaming(null)}>
				Cancel
			</button>,
			<button key="ok" type="button" className="btn sm ink" data-act="rn-ok" id="rn-ok" disabled={check!.bad} onClick={() => arrange.confirmRename()}>
				Rename
			</button>,
		);
	} else if (putting) {
		ends.push(
			<button key="c" type="button" className="btn sm ghost" data-act="pi-cancel" onClick={() => arrange.setPutIn(null)}>
				Cancel
			</button>,
			<button key="ok" type="button" className="btn sm ink" data-act="pi-ok" disabled={putCheck!.bad} onClick={() => arrange.confirmPutIn()}>
				Put in
			</button>,
		);
	} else if (arranging && (group || folder) && !busy) {
		// A group or folder that goes has no name to change: nothing is left in it.
		if (!gone) {
			ends.push(
				<button key="rn" type="button" className="btn sm ghost act" data-act="rename" onClick={() => arrange.startRename(id)}>
					Rename…
				</button>,
			);
		}
		if (isNew && empty) {
			ends.push(
				<button key="rm" type="button" className="btn sm ghost act" data-act={folder ? 'remove-folder' : 'remove-group'} onClick={() => (folder ? arrange.removeFolder(id) : arrange.remove(id))}>
					Remove
				</button>,
			);
		} else if (!gone) {
			ends.push(
				<button
					key="more"
					type="button"
					className="ib act"
					data-act="row-menu"
					aria-haspopup="menu"
					aria-expanded={s.menu === id}
					aria-label={`More for the ${node.label} ${node.kind}`}
					onClick={() => arrange.setMenu(s.menu === id ? null : id)}
				>
					<Icon name="more" />
				</button>,
			);
			if (s.menu === id) ends.push(<RowMenu key="menu" node={node} />);
		}
	}
	const hasKids = node.kids.length > 0 || !!node.holds;
	const closed = s.collapsed.includes(id);
	ends.push(
		hasKids && !renaming && !putting ? (
			<button key="tw" type="button" className="atw" aria-expanded={!closed} aria-label={`${closed ? 'Show' : 'Hide'} what’s under ${node.label}`} onClick={() => arrange.toggleCollapsed(id)}>
				<Icon name="chev-r" />
			</button>
		) : (
			<span key="tw" className="atw-gap" />
		),
	);

	const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			arrange.confirmRename();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			arrange.setRenaming(null);
		}
	};
	const title = home ? 'Home stays first, takes no pages and can’t be filed' : folder ? `${node.label} is a folder: the pages in it keep their own addresses` : undefined;
	return (
		<>
			<div className={cls.join(' ')} style={depthStyle(d)} data-id={id} data-depth={d} data-kind={node.kind} role="treeitem" aria-level={d + 1} data-drag={draggable ? '' : undefined} title={title}>
				<span className="ag" aria-hidden="true">
					{draggable ? <Icon name="grip" /> : null}
				</span>
				<span className="an">
					<Icon name={folder ? 'folder' : group ? 'folder-addr' : 'page'} />
					{renaming ? (
						<input
							className="input"
							id="rn-in"
							value={s.renaming!.value}
							aria-label={`New name for ${node.label}`}
							aria-invalid={check!.err ? true : undefined}
							aria-describedby="rn-sub"
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => arrange.setRenaming(e.target.value)}
							onKeyDown={onNameKey}
						/>
					) : (
						<span className="nm">{node.label}</span>
					)}
					<span className="meta">{marks}</span>
				</span>
				{refused && t?.kind === 'refused' ? (
					<span className="arow-why" role="status">
						<Icon name="x" size="sm" />
						{t.reason}
					</span>
				) : (
					<>
						<span className={`aa${plain ? ' plain' : ''}`}>{addr}</span>
						<span className="ae">{ends}</span>
					</>
				)}
			</div>
			{renaming ? <SubLine check={check!} depth={d} id="rn" help={folder ? 'Only the name changes: a folder isn’t in any address.' : renameHelp(node)} /> : null}
			{putting ? <SubLine check={putCheck!} depth={d} id="pi" help="" /> : null}
			{refusedTake ? (
				<div className="arow-sub err" style={depthStyle(d)} data-sub="take-out" role="status">
					<Icon name="x" size="sm" />
					{refusedTake.error}
				</div>
			) : null}
			{!renaming && isNew && empty && !src ? (
				<div className="arow-sub" style={depthStyle(d)} data-sub="empty">
					Empty: add a page or remove it
					{arranging ? (
						<>
							{' '}
							<button type="button" className="linkbtn" data-act={folder ? 'remove-folder' : 'remove-group'} onClick={() => (folder ? arrange.removeFolder(id) : arrange.remove(id))}>
								Remove
							</button>
						</>
					) : null}
				</div>
			) : null}
		</>
	);
}

/** The row the open folder rename, or put-in, clashes with (the washed row), if it does. */
function clashWith(plan: Plan, s: ArrangeState, site: ArrangeSite): string | null {
	if (s.renaming) {
		const r = plan.now.get(s.renaming.id);
		if (!r || r.node.kind !== 'folder') return null;
		const c = folderNameCheck(s.tree, s.renaming.value, r.level, s.renaming.id);
		return c.bad ? (c.merge ?? null) : null;
	}
	if (s.putting) {
		const c = putInCheck(site, s.tree, s.putting.id, s.putting.value);
		return c.bad ? (c.merge ?? null) : null;
	}
	return null;
}

/** A folder's count: "3 pages", or "3 rows" when it holds a group. */
function filedText(node: ArrangeNode): string {
	const n = node.kids.filter((k) => !pageless(k)).length;
	return node.kids.every((k) => k.kind === 'page') ? plural(n, 'page', 'pages') : plural(n, 'row', 'rows');
}

/** Page folders: a folder's or a group's ··· menu (the mockup's #folder-actions, #group-actions). */
function RowMenu({ node }: { node: ArrangeNode }) {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
	}, []);
	if (node.kind === 'folder') {
		const n = node.kids.length;
		return (
			<div className="menu" role="menu" aria-label={node.label} ref={box}>
				<button type="button" role="menuitem" data-act="put-in" onClick={() => arrange.startPutIn(node.id)}>
					<Icon name="folder-addr" />
					Put in the addresses
				</button>
				<div className="why">
					{filedText(node)} move{n === 1 ? 's' : ''} under <span className="mono">/{slugify(node.label) || '…'}/</span>, in this order, and it becomes a group. Old addresses can redirect.
				</div>
				<hr />
				<button type="button" role="menuitem" data-act="remove-folder" onClick={() => arrange.removeFolder(node.id)}>
					<Icon name="x" />
					Remove
				</button>
				<div className="why">Its rows go back to this level, in its place. No address changes.</div>
			</div>
		);
	}
	const k = flatKids(node.kids).length;
	return (
		<div className="menu" role="menu" aria-label={node.label} ref={box}>
			<button type="button" role="menuitem" data-act="take-out" onClick={() => arrange.takeOut(node.id)}>
				<Icon name="folder" />
				Take out of the addresses
			</button>
			<div className="why">
				Its {plural(k, 'row', 'rows')} move up a level, in this order, and a folder named {node.label} takes its place. Old addresses can redirect.
			</div>
		</div>
	);
}

function HeldRowView({ node, depth: d, plan }: { node: ArrangeNode; depth: number; plan: Plan }) {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	const target = useStore(arrange.state, (st) => st.drag?.target ?? null);
	const linked = useStore(arrange.state, (st) => st.linked);
	const { site } = arrange;
	const x = plan.now.get(node.id)!;
	const y = plan.orig.get(node.id);
	const moved = !!y && y.path !== x.path;
	const h = node.holds!;
	const rid = `held:${node.id}`;
	const refused = target?.kind === 'refused' && target.rowId === rid;
	const base = addressAt(site, 'page', x.path).replace(/\/$/, '');
	return (
		<div
			className={`arow is-held${refused ? ' is-refused' : ''}${linked === rid ? ' is-linked' : ''}`}
			style={depthStyle(d)}
			data-id={rid}
			data-holder={node.id}
			data-depth={d}
			role="treeitem"
			aria-level={d + 1}
			title={`${h.label} goes wherever ${node.label} goes: it can’t be dragged on its own, and nothing goes under it`}
		>
			<span className="ag" />
			<span className="an">
				<Icon name={h.icon} />
				<span className="nm">{h.label}</span>
				<span className="meta">
					<span className="cnt">
						{h.docs.length} {h.docs.length === 1 ? h.one : h.many}
					</span>
				</span>
			</span>
			{refused && target?.kind === 'refused' ? (
				<span className="arow-why" role="status">
					<Icon name="x" size="sm" />
					{target.reason}
				</span>
			) : (
				<>
					<span className="aa">{moved ? <span className="new">{base}/…</span> : `${base}/…`}</span>
					<span className="ae">
						<span className="carried">Moves with {node.label}</span>
						<span className="atw-gap" />
					</span>
				</>
			)}
		</div>
	);
}

function SubLine({ check, depth, id, help }: { check: NameCheck; depth: number; id: string; help: string }) {
	if (check.err) {
		return (
			<div className="arow-sub err" id={`${id}-sub`} style={depthStyle(depth)}>
				<Icon name="x" size="sm" />
				{check.err}
			</div>
		);
	}
	return (
		<div className="arow-sub" id={`${id}-sub`} style={depthStyle(depth)}>
			{check.info ?? help}
		</div>
	);
}

function renameHelp(node: ArrangeNode): string {
	const k = countPages(node.kids);
	if (!k) return 'Its address changes with its name.';
	const names = node.kids.filter((c) => c.kind === 'page').map((c) => c.label);
	return `${andList(names.slice(0, 3))}${k > 3 ? ` and ${k - 3} more` : ''} move${k === 1 ? 's' : ''} with it. Its address changes with its name.`;
}

function NamingRow() {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	const s = useStore(arrange.state);
	const value = s.naming?.value ?? '';
	// Page folders: New folder is named the same way, by the folder name rules.
	const folder = s.naming?.kind === 'folder';
	const c = folder ? folderNameCheck(s.tree, value, null, null) : nameCheck(arrange.site, s.tree, value, null, null);
	const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			arrange.confirmNaming();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			arrange.setNaming(null);
		}
	};
	return (
		<>
			<div className={`arow ${folder ? 'is-folder' : 'is-group'} is-naming`} style={depthStyle(0)} data-id="naming">
				<span className="ag" />
				<span className="an">
					<Icon name={folder ? 'folder' : 'folder-addr'} />
					<input
						className="input"
						id="ng-in"
						value={value}
						placeholder={folder ? 'Folder name, e.g. About Us' : 'Group name, e.g. Company'}
						aria-label={folder ? 'New folder’s name' : 'New group’s name'}
						aria-describedby="ng-sub"
						autoComplete="off"
						spellCheck={false}
						aria-invalid={c.err ? true : undefined}
						onChange={(e) => arrange.setNaming(e.target.value)}
						onKeyDown={onKey}
					/>
				</span>
				<span className={`aa${folder ? ' plain' : ''}`}>{folder ? 'Not in the addresses' : <span className="new" id="ng-addr">{`${arrange.site.base}${c.slug || '…'}/`}</span>}</span>
				<span className="ae">
					<button type="button" className="btn sm ghost" data-act="ng-cancel" onClick={() => arrange.setNaming(null)}>
						Cancel
					</button>
					<button type="button" className="btn sm ink" data-act="ng-ok" id="ng-ok" disabled={c.bad} onClick={() => arrange.confirmNaming()}>
						{folder ? 'Add folder' : 'Add group'}
					</button>
					<span className="atw-gap" />
				</span>
			</div>
			<SubLine
				check={c}
				depth={0}
				id="ng"
				help={folder ? 'Goes at the end of the top level. Drag it where you want it, then drag pages into it: they keep their addresses.' : 'Goes at the end of the top level. Then drag pages onto it.'}
			/>
		</>
	);
}

/** The card under the pointer: what's dragged, what goes with it, and where it would land. */
function Ghost() {
	const editor = useEditor();
	const arrange = arrangeFor(editor);
	const s = useStore(arrange.state);
	if (!s.drag) return null;
	const node = locate(s.tree, s.drag.id)?.node;
	if (!node) return null;
	const t = s.drag.target;
	const index = indexTree(s.tree);
	const k = countPages(node.kids);
	const bits: string[] = [];
	if (node.holds) bits.push(`its ${plural(node.holds.docs.length, node.holds.one, node.holds.many)}`);
	if (node.kind === 'folder') {
		if (node.kids.some((c) => !pageless(c))) bits.push(filedText(node));
	} else if (k === 1) bits.push(node.kids.find((c) => c.kind === 'page')!.label);
	else if (k > 1) bits.push(`${k} pages`);
	const folder = node.kind === 'folder';
	const from = folder ? 'Not in the addresses' : addressAt(arrange.site, node.kind, index.get(node.id)!.path);
	let to: ReactElement;
	if (!t) to = <span className="to plain">{from}</span>;
	else if (t.kind === 'refused') {
		to = (
			<span className="to">
				<Icon name="x" size="xs" />
				Can’t go here
			</span>
		);
	} else if (t.same) {
		// Filed in a folder, or out of one: it stays at its address. A folder, or a plain reorder: only the order.
		const filing = t.kind === 'folder' || index.get(t.parentId ?? '')?.node.kind === 'folder' || index.get(node.id)!.folder !== null;
		to = <span className="to plain">{folder || !filing ? 'Only the order changes' : `Stays at ${from}`}</span>;
	}
	else {
		// Page folders: the landing level is past any folder.
		const lp = levelOf(index, t.parentId).path;
		if (folder) to = <span className="to">{`Its ${plural(k, 'page moves', 'pages move')} under ${lp ? addressAt(arrange.site, 'group', lp) : arrange.site.base}`}</span>;
		else {
			const landing = t.merge ? addressAt(arrange.site, 'page', index.get(t.merge)!.path) : addressAt(arrange.site, node.kind, `${lp ? `${lp}/` : ''}${node.slug}`);
			to = <span className="to">{`${from} → ${landing}${t.merge ? `, as ${index.get(t.merge)!.node.label}’s own page` : ''}`}</span>;
		}
	}
	return (
		<div className={`adrag${t?.kind === 'refused' ? ' no' : ''}`} id="aghost" style={{ translate: `${ghostAt.x}px ${ghostAt.y}px` }}>
			<Icon name={node.kind === 'group' ? 'folder-addr' : folder ? 'folder' : 'page'} />
			<span className="nm">
				{node.label}
				{bits.length ? <small>and {andList(bits)}</small> : null}
			</span>
			{to}
		</div>
	);
}

/** Where the card sits (just past the pointer), kept outside React's state so a move doesn't render. */
const ghostAt = { x: -1000, y: -1000 };
const placeGhost = (x: number, y: number) => {
	ghostAt.x = Math.round(x + 14);
	ghostAt.y = Math.round(y + 10);
	const g = document.getElementById('aghost');
	if (g) g.style.translate = `${ghostAt.x}px ${ghostAt.y}px`;
};

/** The beside marker: a line at the landing level's indent, against its row's top or bottom edge, with the level as its tag. */
function useMarker(arrange: Arrange, s: ArrangeState, tree: { current: HTMLDivElement | null }) {
	useLayoutEffect(() => {
		const m = tree.current?.querySelector<HTMLElement>('#amark');
		if (!m) return;
		const t = s.drag?.target;
		const row = t && t.kind === 'beside' ? tree.current!.querySelector<HTMLElement>(`.arow[data-id="${CSS.escape(t.rowId)}"]`) : null;
		if (!t || t.kind !== 'beside' || !row) {
			m.hidden = true;
			return;
		}
		const css = getComputedStyle(document.documentElement);
		const grip = parseFloat(css.getPropertyValue('--arr-grip-w')) || 24;
		const indent = parseFloat(css.getPropertyValue('--tree-indent')) || 16;
		const y = t.edge === 'top' ? row.offsetTop : row.offsetTop + row.offsetHeight;
		m.style.top = `${y - 1}px`;
		m.style.left = `${grip + t.depth * indent}px`;
		const tag = m.querySelector('.tag');
		if (tag) tag.textContent = t.merge ? `Becomes ${locate(s.tree, t.merge)?.node.label ?? ''}’s own page` : (t.tag ?? '');
		m.hidden = false;
	});
}

/** Dragging rows with the mouse (the mockup's onPointerDown / onPointerMove / endDrag). */
function useDrag(arrange: Arrange, tree: { current: HTMLDivElement | null }) {
	const editor = useEditor();
	useEffect(() => {
		const el = tree.current;
		if (!el) return;
		let drag: { id: string; x: number; y: number; started: boolean; key: string } | null = null;
		const end = (commit: boolean) => {
			if (!drag) return;
			const d = drag;
			drag = null;
			document.body.classList.remove('is-dragging', 'is-no');
			if (!d.started) return;
			const t = arrange.state.get().drag?.target ?? null;
			if (commit && t && t.kind !== 'refused') arrange.drop(d.id, t);
			else arrange.setDrag(null);
		};
		const down = (e: PointerEvent) => {
			const s = arrange.state.get();
			if (s.mode !== 'arrange' || s.naming || s.renaming || e.button !== 0) return;
			const at = e.target as HTMLElement;
			if (at.closest('button, input, a')) return;
			const row = at.closest<HTMLElement>('.arow[data-drag]');
			if (!row?.dataset.id) return;
			drag = { id: row.dataset.id, x: e.clientX, y: e.clientY, started: false, key: '' };
			e.preventDefault();
		};
		const move = (e: PointerEvent) => {
			if (!drag) return;
			if (!drag.started) {
				if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
				drag.started = true;
				document.body.classList.add('is-dragging');
				placeGhost(e.clientX, e.clientY);
				arrange.setDrag({ id: drag.id, target: null });
			}
			const t = targetAt(arrange, editor.documents.get(), el, drag.id, e.clientX, e.clientY);
			const key = JSON.stringify(t);
			if (key !== drag.key) {
				drag.key = key;
				document.body.classList.toggle('is-no', t?.kind === 'refused');
				arrange.setDrag({ id: drag.id, target: t });
			}
			placeGhost(e.clientX, e.clientY);
		};
		const up = () => end(true);
		const cancel = () => end(false);
		const key = (e: globalThis.KeyboardEvent) => {
			if (e.key === 'Escape' && drag) {
				e.preventDefault();
				e.stopImmediatePropagation();
				end(false);
			}
		};
		el.addEventListener('pointerdown', down);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('keydown', key, true);
		return () => {
			el.removeEventListener('pointerdown', down);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
			window.removeEventListener('keydown', key, true);
			document.body.classList.remove('is-dragging', 'is-no');
		};
	}, [arrange, editor, tree]);
}

/** Where a drop at (x, y) would go: beside a row (its top or bottom quarter), inside it (its middle), or refused. */
function targetAt(arrange: Arrange, documents: Parameters<typeof checkDrop>[2], el: HTMLElement, src: string, x: number, y: number): DropTarget | null {
	const s = arrange.state.get();
	const check = (t: DropTarget) => checkDrop(arrange.site, s.tree, documents, src, t);
	const label = (id: string) => locate(s.tree, id)?.node.label ?? '';
	const nextSibling = (list: ArrangeNode[], i: number) => list.slice(i + 1).find((n) => n.id !== src)?.id ?? null;
	const row = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('#atree .arow');
	if (!row) {
		// Just below the last row: the end of the top level.
		const box = el.getBoundingClientRect();
		if (x >= box.left && x <= box.right && y > box.bottom - 2 && y < box.bottom + 120) {
			const last = [...el.querySelectorAll<HTMLElement>('.arow[data-id]')].pop();
			if (!last || last.dataset.id === src || last.dataset.id === 'naming') return null;
			return check({ kind: 'beside', parentId: null, beforeId: null, rowId: last.dataset.id!, edge: 'bottom', depth: 0 });
		}
		return null;
	}
	const id = row.dataset.id!;
	if (id === src || id === 'naming') return null;
	const r = row.getBoundingClientRect();
	const f = (y - r.top) / r.height;
	if (row.dataset.holder) {
		const h = label(row.dataset.holder);
		return { kind: 'refused', rowId: id, reason: `Moves with ${h}: drop on ${h} instead` };
	}
	const at = locate(s.tree, id);
	if (!at) return null;
	const index: Map<string, Placed> = indexTree(s.tree);
	if (index.get(id)!.path === arrange.site.home && !at.parentId) {
		if (f > 0.72) return check({ kind: 'beside', parentId: null, beforeId: nextSibling(at.list, at.i), rowId: id, edge: 'bottom', depth: 0 });
		return { kind: 'refused', rowId: id, reason: f < 0.28 ? 'Home stays first' : 'Home takes no pages' };
	}
	const node = at.node;
	const depth = Number(row.dataset.depth) || 0;
	const open = !s.collapsed.includes(id) && (node.kids.some((k) => k.id !== src) || !!node.holds);
	if (f < 0.28) return check({ kind: 'beside', parentId: at.parentId, beforeId: id, rowId: id, edge: 'top', depth });
	if (f > 0.72) {
		if (open) return check({ kind: 'beside', parentId: id, beforeId: node.kids.find((k) => k.id !== src)?.id ?? null, rowId: node.holds ? `held:${id}` : id, edge: 'bottom', depth: depth + 1 });
		return check({ kind: 'beside', parentId: at.parentId, beforeId: nextSibling(at.list, at.i), rowId: id, edge: 'bottom', depth });
	}
	// Page folders: over a folder's middle a row is filed in it, at its end (no address changes at its level).
	if (node.kind === 'folder') return check({ kind: 'folder', parentId: id, beforeId: null, rowId: id, depth: depth + 1 });
	return check({ kind: 'inside', parentId: id, beforeId: null, rowId: id, depth: depth + 1 });
}
