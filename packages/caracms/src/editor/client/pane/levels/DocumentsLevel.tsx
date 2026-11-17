/**
 * The documents level, the pane's top (the mockup's #docs, #tree-open, #tree-closed,
 * #find; Decisions 8 and 9):
 *
 * - **Pages as a tree** (client/nav/tree.ts): Home first, then alphabetical by
 *   title; a page with pages under it opens like any page and has a show/hide
 *   chevron on the left, in a column every tree row reserves; a folder with no page
 *   of its own is a group row that only shows or hides its children. Groups open or
 *   closed as the cookie says (Decision 20), and the server renders them so.
 * - **"Collections N"**: a row per other collection (name, count, chevron) that
 *   drills into its own level (CollectionLevel.tsx). Nesting is Pages only.
 * - **"Find a document"** searches every document's title and address, collections
 *   included, grouped by collection (client/nav/search.ts).
 * - **"Site-wide"** (M5a): Shared blocks (a row to its own level, like a collection),
 *   then Site Settings (a document row).
 * - **New page** (M5a) opens the New page dialog (documents/dialogs.tsx); a group row's
 *   menu offers "Create a page at /services" and "New page in Services".
 * - Shared blocks and Site Settings are found by Find and ⌘K too (grouped by collection).
 * - It also starts the empty page's "+ Add the first block" (block-list/insert-points.ts), once:
 *   this level is the one that's always mounted.
 * - M4 (live mode): presence and waiting dots, bubbled up to a closed group, a
 *   closed parent and a collection's row (live/marks.tsx → Bubble). Local mode: the
 *   slots stay empty.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useEditor, useStore } from '../../context.tsx';
import { BrandMark } from '../../shell/Brand.tsx';
import { mediaFor } from '../../media/store.ts';
import { inboxFor } from '../../inbox/store.ts';
import { Icon } from '../../shell/Icons.tsx';
import { startEmptyPageAdd } from '../../block-list/insert-points.ts';
import { DocRow, docIcon } from '../../nav/DocRow.tsx';
import { addressFor } from '../../documents/actions.ts';
import { openDialog } from '../../documents/dialogs.tsx';
import { Bubble } from '../../live/marks.tsx';
import { searchDocuments } from '../../nav/search.ts';
import { treeRows, type TreeRow } from '../../nav/tree.ts';
import { arrangeSite } from '../../arrange/store.ts';
import { opensInEditor, type EditorCollection, type ListedDocument } from '../../../types.ts';
import { CurrentHead, GlobalNotes, RecentStrip, Trail } from '../parts.tsx';

export function DocumentsLevel() {
	const editor = useEditor();
	const { host } = editor.site;
	const brand = useStore(editor.brand);
	const documents = useStore(editor.documents);
	const [query, setQuery] = useState('');
	const nested = editor.site.collections.filter((c) => c.nested);
	// The site's other collections: section builders that don't nest, and list-of-fields ones (M5a).
	const flat = editor.site.collections.filter((c) => !c.nested && (c.kind === 'sections' || c.kind === 'fields'));
	const sharedCollection = editor.site.collections.find((c) => c.kind === 'shared');
	const settings = documents.find((d) => d.collection === 'settings');
	const searching = query.trim() !== '';
	// The empty page's add (block-list/insert-points.ts). Mounted here because this level
	// is always mounted (Pane.tsx keeps it, hidden), so it starts once per editor.
	useEffect(() => startEmptyPageAdd(editor), [editor]);

	const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			const first = searchDocuments(query, documents, editor.site.collections)
				.flatMap((g) => g.hits)
				.find((h) => opensInEditor(h.doc));
			if (first) void editor.openDocument({ collection: first.doc.collection, path: first.doc.path });
		} else if (event.key === 'Escape' && query) {
			// Clear the box first; a second Esc leaves it (App.tsx).
			event.preventDefault();
			setQuery('');
		}
	};

	return (
		<>
			<Trail>
				<CurrentHead
					lead={
						<span className="logo-slot" style={{ background: 'var(--surface-sunken)' }}>
							<BrandMark />
						</span>
					}
					title={brand.name}
					sub={`${documents.length} document${documents.length === 1 ? '' : 's'} · ${host}`}
				/>
			</Trail>
			<div className="side-body flush">
				<GlobalNotes />
				<div className="find">
					<Icon name="search" />
					<input
						className="input"
						type="search"
						placeholder="Find a document"
						aria-label="Find a document"
						data-filter="docs"
						autoComplete="off"
						spellCheck={false}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onFindKey}
					/>
				</div>
				<div id="docs-list">
					{searching ? (
						<SearchResults query={query} documents={documents} onClear={() => setQuery('')} />
					) : (
						<>
							{nested.map((c) => (
								<PagesSection key={c.name} collection={c} documents={documents.filter((d) => d.collection === c.name)} all={documents} />
							))}
							{flat.length > 0 ? (
								<section className="grp" aria-label="Collections">
									<div className="grp-h">
										Collections <span className="n">{flat.length}</span>
									</div>
									{flat.map((c) => (
										<CollectionRow key={c.name} collection={c} documents={documents.filter((d) => d.collection === c.name)} />
									))}
								</section>
							) : null}
							<section className="grp" aria-label="Site-wide" data-section="site-wide">
								<div className="grp-h">Site-wide</div>
								{sharedCollection ? <CollectionRow collection={sharedCollection} documents={documents.filter((d) => d.collection === sharedCollection.name)} /> : null}
								<MediaRow />
								{settings ? <DocRow doc={settings} /> : null}
								<SubmissionsRow />
							</section>
						</>
					)}
				</div>
			</div>
			<RecentStrip />
		</>
	);
}

function PagesSection({ collection, documents, all }: { collection: EditorCollection; documents: ListedDocument[]; all: ListedDocument[] }) {
	const editor = useEditor();
	const open = useStore(editor.ui, (u) => u.open);
	// Collections under pages (Decision 4): each collection a page here holds, as a row under it.
	const held = editor.site.collections
		.filter((c) => c.heldBy === collection.name && c.holder?.collection === collection.name)
		.map((c) => ({ collection: c.name, label: c.label, holder: c.holder!.path, files: all.filter((d) => d.collection === c.name).map((d) => d.file) }));
	// Page folders (Decision 8): the Pages tree's folders, as the listing drew them.
	const isPages = collection.name === arrangeSite(editor).collection;
	const folders = useStore(editor.pages, (p) => p.folders);
	const rows = treeRows(collection.name, documents, open, held, isPages ? folders : {});
	return (
		<section className="grp" aria-label={collection.label} data-collection={collection.name}>
			<div className="grp-h">
				{collection.label} <span className="n">{documents.length}</span>
				<span className="sp" />
				{/* Arrange pages (Decision 2): the deliberate place to order, nest and group; nothing drags in the sidebar. */}
				{collection.name === arrangeSite(editor).collection ? (
					<>
						<button type="button" className="linkbtn subtle" data-act="open-arrange" onClick={() => editor.openArrange()}>
							Arrange pages…
						</button>
						<span style={{ width: 6 }} />
					</>
				) : null}
				<button type="button" className="linkbtn" data-act="new-page" onClick={() => openDialog(editor, { kind: 'new', collection: collection.name })}>
					<Icon name="plus" size="xs" />
					New page
				</button>
			</div>
			{rows.map((row) => (
				<TreeNode key={`${row.kind}:${row.path}`} row={row} collection={collection} />
			))}
		</section>
	);
}

function TreeNode({ row, collection }: { row: TreeRow; collection: EditorCollection }) {
	const editor = useEditor();
	const depth = { ['--depth' as string]: row.depth };
	if (row.kind === 'held') {
		const held = editor.site.collections.find((c) => c.name === row.collection);
		return (
			<div className="tnode" data-tnode-held={row.collection}>
				<button type="button" className="drow t coll is-held" style={depth} data-held={row.collection} aria-label={`${row.label}, ${row.count}`} title={`${row.label}, held by this page: its documents are at its address`} onClick={() => editor.openCollection(row.collection)}>
					<Icon name={docIcon(held)} />
					<span className="nm">{row.label}</span>
					<span className="meta">
						{editor.mode === 'live' ? <Bubble files={row.files} /> : <span data-slot="bubble" hidden />}
						<span className="cnt">{row.count}</span>
					</span>
					<Icon name="chev-r" size="sm" />
				</button>
			</div>
		);
	}
	if (row.kind === 'folder') {
		return (
			<div className="tnode" data-tnode-folder={row.path}>
				<button
					type="button"
					className="drow t is-group is-folder"
					style={depth}
					data-group={row.key}
					data-folder={row.id}
					aria-expanded={row.open}
					aria-label={`${row.label}, a folder, ${row.count}`}
					title={`${row.label} is a folder: its pages keep their own addresses`}
					onClick={() => editor.toggleGroup(row.key)}
				>
					<Icon name="folder" />
					<span className="nm">{row.label}</span>
					<span className="meta">
						{editor.mode === 'live' && !row.open ? <Bubble files={row.under.map((d) => d.file)} /> : <span data-slot="bubble" hidden />}
						<span className="cnt">{row.count}</span>
					</span>
					<span className="tw" aria-hidden="true">
						<Icon name="chev-r" size="xs" />
					</span>
				</button>
				<FolderMenu row={row} collection={collection} />
			</div>
		);
	}
	if (row.kind === 'group') {
		const address = `${addressFor(collection, row.path) ?? `/${row.path}`}/`;
		return (
			<div className="tnode" data-tnode-group={row.path}>
				<button
					type="button"
					className="drow t is-group"
					style={depth}
					data-group={row.key}
					aria-expanded={row.open}
					title={`${row.label} has no page of its own`}
					onClick={() => editor.toggleGroup(row.key)}
				>
					<Icon name="folder-addr" />
					<span className="nm">{row.label}</span>
					<span className="meta">
						{/* M4: presence and waiting dots inside, bubbled up while it's closed. */}
						{editor.mode === 'live' && !row.open ? <Bubble files={row.under.map((d) => d.file)} /> : <span data-slot="bubble" hidden />}
						{/* Page folders (Decision 2): a group shows its address, so it reads apart from a folder. */}
						<span className="gaddr">{address}…</span>
					</span>
					{/* The twisty at the row's end, as the parent pages' is: icons line up with the rest of the sidebar. */}
					<span className="tw" aria-hidden="true">
						<Icon name="chev-r" size="xs" />
					</span>
				</button>
				<GroupMenu row={row} collection={collection} />
			</div>
		);
	}
	return (
		<div className="tnode">
			<DocRow doc={row.doc} className={row.parent ? 't has-kids' : 't'} style={depth} extra={row.parent && !row.open ? editor.mode === 'live' ? <Bubble files={row.under.map((d) => d.file)} /> : <span data-slot="bubble" hidden /> : null} />
			{row.parent ? (
				<button
					type="button"
					className="twisty"
					data-group={row.key}
					aria-expanded={row.open}
					aria-label={`${row.open ? 'Hide' : 'Show'} the pages under ${row.doc.label}`}
					onClick={() => editor.toggleGroup(row.key)}
				>
					<Icon name="chev-r" size="xs" />
				</button>
			) : null}
		</div>
	);
}

/**
 * A group row's menu (M5a; the mockup's #group-menu): "Create a page at /services"
 * (the group becomes a page, its pages stay under it), and "New page in Services".
 */
function GroupMenu({ row, collection }: { row: Extract<TreeRow, { kind: 'group' }>; collection: EditorCollection }) {
	const editor = useEditor();
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const address = addressFor(collection, row.path) ?? `/${row.path}`;
	const readOnly = useStore(editor.access, (a) => !!a.signedOut);
	useEffect(() => {
		if (!open) return;
		box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
		const onDown = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (box.current?.contains(target) || button.current?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [open]);
	const go = (dialog: Parameters<typeof openDialog>[1]) => {
		setOpen(false);
		openDialog(editor, dialog);
	};
	const n = row.under.length;
	return (
		<>
			<button
				ref={button}
				type="button"
				className="ib row-more"
				data-act="group-menu"
				aria-label={`Actions for the ${row.label} group`}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={readOnly}
				onClick={() => setOpen((o) => !o)}
			>
				<Icon name="more" />
			</button>
			{open ? (
				<div
					ref={box}
					className="menu"
					role="menu"
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							// Closes the menu only.
							e.preventDefault();
							setOpen(false);
							button.current?.focus();
						}
					}}
				>
					<button type="button" role="menuitem" data-act="group-page" onClick={() => go({ kind: 'new', collection: collection.name, at: row.path })}>
						<Icon name="page" />
						Create a page at {address}
					</button>
					<div className="why">
						{row.label} has no page of its own. Its {n} page{n === 1 ? '' : 's'} stay{n === 1 ? 's' : ''} under it.
					</div>
					<hr />
					<button type="button" role="menuitem" data-act="new-in-group" onClick={() => go({ kind: 'new', collection: collection.name, inside: row.path })}>
						<Icon name="plus" />
						New page in {row.label}
					</button>
				</div>
			) : null}
		</>
	);
}

/**
 * Page folders (Decision 8; the mockup's sidebar menu): a folder's ··· menu. "New page in
 * Company" makes a page at the folder's level, filed at the end of it; "Arrange pages…" is
 * where a folder is renamed, removed or put in the addresses.
 */
function FolderMenu({ row, collection }: { row: Extract<TreeRow, { kind: 'folder' }>; collection: EditorCollection }) {
	const editor = useEditor();
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const readOnly = useStore(editor.access, (a) => !!a.signedOut);
	useEffect(() => {
		if (!open) return;
		box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
		const onDown = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (box.current?.contains(target) || button.current?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [open]);
	return (
		<>
			<button
				ref={button}
				type="button"
				className="ib row-more"
				data-act="folder-menu"
				aria-label={`Actions for the ${row.label} folder`}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={readOnly}
				onClick={() => setOpen((o) => !o)}
			>
				<Icon name="more" />
			</button>
			{open ? (
				<div
					ref={box}
					className="menu"
					role="menu"
					aria-label={row.label}
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							e.preventDefault();
							setOpen(false);
							button.current?.focus();
						}
					}}
				>
					<button
						type="button"
						role="menuitem"
						data-act="new-in-folder"
						onClick={() => {
							setOpen(false);
							openDialog(editor, { kind: 'new', collection: collection.name, inside: row.level, folder: { id: row.id, name: row.label } });
						}}
					>
						<Icon name="plus" />
						New page in {row.label}
					</button>
					<div className="why">It goes at the end of {row.label}. Its address is at this level: folders aren’t in addresses.</div>
					<hr />
					<button
						type="button"
						role="menuitem"
						data-act="folder-arrange"
						onClick={() => {
							setOpen(false);
							editor.openArrange();
						}}
					>
						<Icon name="list" />
						Arrange pages…
					</button>
					<div className="why">Rename or remove {row.label}, or put it in the addresses.</div>
				</div>
			) : null}
		</>
	);
}

/** M5b: the library, Site-wide → Media (the mockup's #media-row): its count once it's been read, read on intent. */
function MediaRow() {
	const editor = useEditor();
	const media = mediaFor(editor);
	const images = useStore(media.images, (l) => l.list?.length ?? null);
	const clips = useStore(media.clips, (l) => l.list?.length ?? null);
	// M6c G4: files count too (read with the images).
	const files = useStore(media.files, (l) => l.list?.length ?? null);
	const n = images === null && clips === null ? null : (images ?? 0) + (clips ?? 0) + (files ?? 0);
	const prefetch = () => {
		void media.loadImages();
		void media.loadClips();
	};
	return (
		<button
			type="button"
			className="drow coll media-row"
			data-act="open-media"
			aria-label={n === null ? 'Media' : `Media, ${n}`}
			onPointerEnter={prefetch}
			onFocus={prefetch}
			onClick={() => {
				prefetch();
				editor.openMedia();
			}}
		>
			<Icon name="media" />
			<span className="nm">Media</span>
			<span className="meta">{n === null ? null : <span className="cnt">{n}</span>}</span>
			<Icon name="chev-r" size="sm" />
		</button>
	);
}

/**
 * M6 Decision 9: the inbox, last under Site-wide (the mockup's #submissions-row), with the
 * unread count as a small pill only when something is unread. Its list is read on intent.
 */
function SubmissionsRow() {
	const editor = useEditor();
	const unread = useStore(editor.submissions, (s) => s.unread ?? 0);
	const prefetch = () => void inboxFor(editor).load();
	return (
		<button
			type="button"
			className="drow coll subs-row"
			data-act="open-subs"
			aria-label={`Submissions${unread ? `, ${unread} unread` : ''}`}
			onPointerEnter={prefetch}
			onFocus={prefetch}
			onClick={() => editor.openInbox(null)}
		>
			<Icon name="inbox" />
			<span className="nm">Submissions</span>
			<span className="meta">
				{unread ? (
					<span className="ucnt" title={`${unread} unread`}>
						{unread}
					</span>
				) : null}
			</span>
			<Icon name="chev-r" size="sm" />
		</button>
	);
}

function CollectionRow({ collection, documents }: { collection: EditorCollection; documents: ListedDocument[] }) {
	const editor = useEditor();
	const n = documents.length;
	// Collections under pages (Decision 13): a held collection no page holds (or two do) has no addresses; its entry says why.
	const problem = collection.problem ?? null;
	return (
		<>
			<button
				type="button"
				className={problem ? 'drow coll is-warned' : 'drow coll'}
				data-coll={collection.name}
				aria-label={`${collection.label}, ${n}${problem ? ', has no addresses' : ''}`}
				title={problem ?? undefined}
				onClick={() => editor.openCollection(collection.name)}
			>
				<Icon name={docIcon(collection)} />
				<span className="nm">{collection.label}</span>
				<span className="meta">
					{problem ? (
						<span className="wmark" data-warning="not-held">
							<Icon name="warn" size="xs" />
						</span>
					) : null}
					{/* M4: presence and waiting dots inside the collection, bubbled up. */}
					{editor.mode === 'live' ? <Bubble files={documents.map((d) => d.file)} /> : <span data-slot="bubble" hidden />}
					<span className="cnt">{n}</span>
				</span>
				<Icon name="chev-r" size="sm" />
			</button>
			{problem ? (
				<div className="note warn tight doc-why" role="note" data-why={`coll-${collection.name}`}>
					<Icon name="warn" />
					<div>
						<b>{collection.label} has no addresses</b>
						<p>{problem}</p>
					</div>
				</div>
			) : null}
		</>
	);
}

/** "Find a document": every document's title and address, grouped by collection (Decision 9). */
export function SearchResults({ query, documents, onClear }: { query: string; documents: ListedDocument[]; onClear?: () => void }) {
	const editor = useEditor();
	const folders = useStore(editor.pages, (p) => p.folders);
	const groups = searchDocuments(query, documents, editor.site.collections, { collection: arrangeSite(editor).collection, folders });
	if (groups.length === 0) {
		return (
			<p className="no-hits" role="status">
				<b>Nothing called “{query.trim()}”</b>
			</p>
		);
	}
	return (
		<>
			{groups.map((g) => (
				<section key={g.collection.name} className="grp" aria-label={g.collection.label} data-results={g.collection.name}>
					<div className="grp-h">
						{g.collection.label}{' '}
						<span className="n">{g.collection.nested || g.hits.length === g.total ? g.hits.length : `${g.hits.length} of ${g.total}`}</span>
					</div>
					{/* Page folders (check 11): a folder whose name matches opens it in the tree. */}
					{(g.folders ?? []).map((f) => (
						<button
							key={`${f.level}/(${f.id})`}
							type="button"
							className="drow is-group is-folder hit-folder"
							data-find-folder={f.id}
							aria-label={`${f.name}, a folder, ${f.count}`}
							title={`${f.name} is a folder: its pages keep their own addresses`}
							onClick={() => {
								const key = (path: string) => `${g.collection.name}:${path}`;
								const segments = f.level ? f.level.split('/') : [];
								segments.forEach((_, i) => editor.toggleGroup(key(segments.slice(0, i + 1).join('/')), true));
								const own = Object.entries(folders).flatMap(([level, list]) => list.filter((o) => o.rows.some((r) => f.level === r || f.level.startsWith(`${r}/`))).map((o) => (level ? `${level}/(${o.id})` : `(${o.id})`)));
								own.forEach((p) => editor.toggleGroup(key(p), true));
								editor.toggleGroup(key(f.level ? `${f.level}/(${f.id})` : `(${f.id})`), true);
								onClear?.();
							}}
						>
							<Icon name="folder" />
							<span className="nm">
								{f.crumb ? <span className="crumb">{f.crumb} / </span> : null}
								{f.name}
							</span>
							<span className="meta">
								<span className="cnt">{f.count}</span>
							</span>
						</button>
					))}
					{g.hits.slice(0, MAX_HITS).map((h) => (
						<DocRow key={h.doc.path} doc={h.doc} crumb={h.crumb} />
					))}
					{g.hits.length > MAX_HITS ? <div className="sw-more">{g.hits.length - MAX_HITS} more: keep typing</div> : null}
				</section>
			))}
		</>
	);
}

const MAX_HITS = 12;
