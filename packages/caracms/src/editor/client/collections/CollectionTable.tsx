/**
 * A flat collection as a table over the stage (pre-M7 polish; "a table over the
 * stage"): at a collection's level (Case studies, the Journal, Shared blocks) the
 * stage shows its documents full width in place of the preview, which stays behind it.
 *
 * The head: the collection's name and count, a find box, a filter for each select,
 * toggle or reference column, and **+ New**. The table: the title, then the columns the
 * config picks (collections/table.ts). A column's header sorts by it (again: the other
 * way); `aria-sort` says which. A list of references doesn't sort, so its header is a
 * plain label (posts and tags, Decision 13). The view opens in the config's `sort`. A row opens its document in the editor (the row, or its
 * title's button from the keyboard), and keeps the marks a sidebar row has: a file
 * that can't be opened (it says why, and doesn't open), and in live mode the merge
 * mark, someone's lock, presence and the waiting dot (live/marks.tsx). The open
 * document's row is a wash with a ring, as the sidebar's (no side rails).
 *
 * The find, filters and order are one view with the sidebar's list (tableViewFor),
 * so the two never disagree. Nothing loads: the rows are the listing the editor
 * already has, field values included (entry.columns).
 *
 * M6c (G5): a collection whose documents can hold an image (its `view`, Decision 13)
 * gets a List / Grid switch at the end of the tools row; Grid shows the same view's
 * documents as cards (CollectionGrid.tsx), with an order select in place of the
 * headers. The choice is the editor's, per collection, in the UI cookie (Decision 18;
 * the config's `view.default` until they pick), so the view is right the moment it's drawn.
 *
 * Review gaps (Decision 3): a manual collection's table opens in Site order, with a numbered
 * "Site order" column first to sort back to; sorted another way, or found or filtered, a line
 * under the tools says dragging happens in the sidebar's list, in Site order. No drag here, nor
 * in the grid, whose order select starts with Site order and whose cards say their place.
 */
import { Fragment, useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { useEditor, useStore } from '../context.tsx';
import type { Editor } from '../editor.ts';
import { createStore, type Store } from '../state/store.ts';
import { Icon } from '../shell/Icons.tsx';
import { docIcon, hiddenTitle } from '../nav/DocRow.tsx';
import { DocMarksView } from '../live/marks.tsx';
import { when } from '../live/format.ts';
import { openDialog } from '../documents/dialogs.tsx';
import { PAGELESS_SUB, singular } from '../documents/actions.ts';
import { usedOnLine } from '../block-list/summary.ts';
import { sharedGroups, showsDefault } from './shared-groups.ts';
import { docId, opensInEditor, warnedWords, type EditorAnyCollection, type ListedDocument } from '../../types.ts';
import { captionColumns, cellText, cellValue, defaultView, filterable, MISSING, nextSort, orderOptions, orderValue, refIndex, refParts, SITE_ORDER, sortable, tableColumns, viewRows, type FilterValue, type RefIndex, type TableColumn, type TableView } from './table.ts';
import { OrderLine } from './HandOrderList.tsx';
import { useCollection } from '../fields/ReferenceField.tsx';
import { CollectionGrid } from './CollectionGrid.tsx';
import { viewModeOf } from '../../ui-state.ts';
import type { ViewMode } from '../../types.ts';

const views = new WeakMap<Editor, Store<Record<string, TableView>>>();

/** The editor's table views, one per collection: kept while the editor runs, so going back finds it as left. */
export function tableViewsFor(editor: Editor): Store<Record<string, TableView>> {
	let store = views.get(editor);
	if (!store) views.set(editor, (store = createStore<Record<string, TableView>>({})));
	return store;
}

/** One collection's view, and a way to change it. It opens in Site order for a manual collection (review gaps, Decision 3), else in the config's `sort` (Decision 13), else the title A to Z. */
export function useTableView(name: string): [TableView, (patch: Partial<TableView>) => void] {
	const editor = useEditor();
	const store = tableViewsFor(editor);
	const collection = editor.site.collections.find((c) => c.name === name);
	const sort = collection?.sort;
	const manual = collection?.order === 'manual';
	const view = useStore(store, (all) => all[name]) ?? defaultView(sort, manual);
	const update = (patch: Partial<TableView>) => store.set((all) => ({ ...all, [name]: { ...(all[name] ?? defaultView(sort, manual)), ...patch } }));
	return [view, update];
}

/** Every listed document by collection and path, for reference columns (table.ts → refIndex). */
export function useRefIndex(): RefIndex {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	return useMemo(() => refIndex(documents), [documents]);
}

/** The collection's table, when the stage shows one: a flat collection at its own level. */
export function useTableCollection(): EditorAnyCollection | null {
	const editor = useEditor();
	const name = useStore(editor.view, (v) => (v.level === 'collection' ? v.collection : null));
	const collection = name ? editor.site.collections.find((c) => c.name === name) : undefined;
	return collection && !collection.nested ? collection : null;
}

/** M6c (G5): the view a collection shows, list or grid; always list without the switch (Decision 13). */
export function useViewMode(collection: EditorAnyCollection): ViewMode {
	const editor = useEditor();
	const view = collection.kind === 'shared' ? null : collection.view;
	return useStore(editor.ui, (ui) => (view ? viewModeOf(ui, collection.name, view.default) : 'list'));
}

const openDoc = (editor: Editor, doc: ListedDocument) => {
	if (doc.warning && !opensInEditor(doc)) {
		editor.announce(`${doc.label} can't be opened. ${doc.warning.message}`);
		return;
	}
	void editor.openDocument({ collection: doc.collection, path: doc.path });
};

export function CollectionTable({ collection }: { collection: EditorAnyCollection }) {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	const currentId = useStore(editor.doc.state, (s) => docId(s.ref));
	const readOnly = useStore(editor.access, (a) => !!a.signedOut);
	const [view, update] = useTableView(collection.name);
	const columns = tableColumns(collection);
	const refs = useRefIndex();
	const docs = documents.filter((d) => d.collection === collection.name);
	const rows = viewRows(docs, columns, view, refs);
	const shared = collection.kind === 'shared';
	const one = singular(collection);
	const create = () => openDialog(editor, shared ? { kind: 'new-shared' } : { kind: 'new', collection: collection.name });
	const now = new Date().toISOString();
	const zone = editor.timeZone();
	const edited = (ms: number) => when(new Date(ms).toISOString(), zone, now);
	const filters = filterable(columns);
	const filtered = view.query.trim() !== '' || Object.keys(view.filters).length > 0;
	const mode = useViewMode(collection);
	const switches = !!collection.view && !shared;
	const grid = mode === 'grid';
	// Review gaps (Decision 3): a manual collection's table has a numbered Site order column to sort back to, and no drag.
	const manual = collection.order === 'manual';
	const position = (d: ListedDocument) => docs.indexOf(d) + 1;
	const orders = grid ? orderOptions(columns, view.sort, manual) : [];

	const setFilter = (key: string, value: FilterValue | null) => {
		const next = { ...view.filters };
		if (value === null) delete next[key];
		else next[key] = value;
		update({ filters: next });
	};

	return (
		<div className="ctable" role="region" aria-label={`${collection.label}, as ${grid ? 'a grid' : 'a table'}`} data-collection-table={collection.name} data-view={mode}>
			<div className="ct-head">
				<div className="ct-title">
					<Icon name={docIcon(collection)} />
					<h2>{collection.label}</h2>
					<span className="n-chip">{filtered ? `${rows.length} of ${docs.length}` : docs.length}</span>
					{shared ? null : collection.urlBase === null ? <span className="ct-sub">{PAGELESS_SUB}</span> : <span className="ct-sub mono">{`${editor.site.host}${collection.urlBase}…`}</span>}
				</div>
				<button type="button" className="btn sm" data-act="table-new" disabled={readOnly} onClick={create}>
					<Icon name="plus" size="sm" />
					{shared ? 'New shared block' : `New ${one}`}
				</button>
				{docs.length > 0 ? (
					<div className="ct-tools">
						<div className="find">
							<Icon name="search" />
							<input
								className="input"
								type="search"
								placeholder={shared ? 'Find a shared block' : `Find in ${collection.label}`}
								aria-label={shared ? 'Find a shared block' : `Find in ${collection.label}`}
								data-filter="table"
								autoComplete="off"
								spellCheck={false}
								value={view.query}
								onChange={(e) => update({ query: e.target.value })}
								onKeyDown={(e) => {
									if (e.key === 'Escape' && view.query) {
										e.preventDefault();
										update({ query: '' });
									}
								}}
							/>
						</div>
						{filters.map((c) => (
							<FilterSelect key={c.key} column={c} value={view.filters[c.key]} onChange={(v) => setFilter(c.key, v)} />
						))}
						{grid ? (
							<select
								className="input ct-filter ct-order"
								aria-label="Order"
								data-order=""
								value={orderValue(view.sort)}
								onChange={(e) => {
									const picked = orders.find((o) => o.value === e.target.value);
									if (picked) update({ sort: picked.sort });
								}}
							>
								{orders.map((o) => (
									<option key={o.value} value={o.value}>
										Order: {o.label}
									</option>
								))}
							</select>
						) : null}
						{switches ? (
							<div className="mini-seg ct-view" role="radiogroup" aria-label="Show as">
								{(['list', 'grid'] as const).map((m) => (
									<button
										key={m}
										type="button"
										role="radio"
										aria-checked={mode === m}
										data-view-mode={m}
										onClick={() => editor.setViewMode(collection.name, m)}
									>
										<Icon name={m} size="sm" />
										{m === 'list' ? 'List' : 'Grid'}
									</button>
								))}
							</div>
						) : null}
						{manual ? <OrderLine collection={collection} view={view} shown={rows.length} total={docs.length} update={update} /> : null}
					</div>
				) : null}
			</div>
			{docs.length === 0 ? (
				<div className="empty ct-empty" data-empty="collection-table">
					<b>{shared ? 'No shared blocks yet' : `Nothing in ${collection.label} yet`}</b>
					{!shared && collection.urlBase === null ? <span>No pages of their own.</span> : null}
				</div>
			) : (
				<div className="ct-scroll">
					{grid ? (
						rows.length > 0 ? <CollectionGrid collection={collection} rows={rows} captions={captionColumns(collection, columns)} currentId={currentId} edited={edited} refs={refs} open={(d) => openDoc(editor, d)} position={manual ? position : undefined} /> : null
					) : (
						<table className="ct">
							<thead>
								<tr>
									{manual ? (
										<th scope="col" className="ct-pos" aria-sort={view.sort.key === SITE_ORDER ? 'ascending' : undefined}>
											<button type="button" className={`ct-sort${view.sort.key === SITE_ORDER ? ' on' : ''}`} title="The order the site shows them in" data-sort={SITE_ORDER} onClick={() => update({ sort: { key: SITE_ORDER, dir: 'asc' } })}>
												<span>Site order</span>
												<Icon name="down" size="xs" />
											</button>
										</th>
									) : null}
									{columns.map((c) => {
										const on = view.sort.key === c.key;
										if (!sortable(c)) {
											return (
												<th key={c.key} scope="col" className={`ct-${c.kind}`}>
													<span className="ct-sort ct-label">{c.label}</span>
												</th>
											);
										}
										return (
											<th key={c.key} scope="col" className={`ct-${c.kind}`} aria-sort={on ? (view.sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
												<button type="button" className={`ct-sort${on ? ' on' : ''}`} onClick={() => update({ sort: nextSort(view.sort, c.key) })}>
													<span>{c.label}</span>
													<Icon name={on && view.sort.dir === 'desc' ? 'down' : 'up'} size="xs" />
												</button>
											</th>
										);
									})}
								</tr>
							</thead>
							{shared ? (
								// Edit in context, Decision 1: Header, Footer, then the rest by type, warnings last.
								sharedGroups(editor.site, rows).map((g) => (
									<tbody key={g.key} data-group={g.key}>
										<tr className="ct-grp">
											<th scope="rowgroup" colSpan={columns.length}>
												{g.label} <span className="n">{g.rows.length}</span>
											</th>
										</tr>
										{g.rows.map((d) => (
											<Row key={d.path} doc={d} columns={columns} current={docId(d) === currentId} edited={edited} refs={refs} extra={usedOnLine(d)} isDefault={showsDefault(documents, d)} />
										))}
									</tbody>
								))
							) : (
								<tbody>
									{rows.map((d) => (
										<Row key={d.path} doc={d} columns={columns} current={docId(d) === currentId} edited={edited} refs={refs} extra={null} position={manual ? position(d) : undefined} />
									))}
								</tbody>
							)}
						</table>
					)}
					{rows.length === 0 ? (
						<p className="no-hits ct-none" role="status">
							<b>Nothing in {collection.label} matches</b>
							<button type="button" className="linkbtn" onClick={() => update({ query: '', filters: {} })}>
								Show all {docs.length}
							</button>
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}

function FilterSelect({ column, value, onChange }: { column: TableColumn; value: FilterValue | undefined; onChange: (value: FilterValue | null) => void }) {
	if (column.kind === 'reference' || column.kind === 'references') return <RefFilterSelect column={column} value={value} onChange={onChange} />;
	const field = column.field;
	const options: { value: string; label: string }[] =
		field?.kind === 'select'
			? [{ value: '', label: `Any ${column.label.toLowerCase()}` }, ...field.options.map((o) => ({ value: `s:${o.value}`, label: o.label }))]
			: [
					{ value: '', label: `${column.label}: any` },
					{ value: 'b:1', label: `${column.label}: on` },
					{ value: 'b:0', label: `${column.label}: off` },
				];
	const current = value === undefined ? '' : typeof value === 'boolean' ? (value ? 'b:1' : 'b:0') : `s:${value}`;
	return (
		<select
			className={`input ct-filter${value === undefined ? '' : ' is-set'}`}
			aria-label={`Filter by ${column.label.toLowerCase()}`}
			data-filter-key={column.key}
			value={current}
			onChange={(e) => {
				const v = e.target.value;
				onChange(v === '' ? null : v.startsWith('b:') ? v === 'b:1' : v.slice(2));
			}}
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	);
}

/**
 * A reference column's filter (Decision 13): one referenced document, by title ("Tag:
 * Print", the column's label as one of them), keeping the rows that point at it (for a list, among others). The options are
 * the referenced collection's documents, in its listing order; a filter on one that's
 * since gone stays listed, as Missing, so the select never lies.
 */
function RefFilterSelect({ column, value, onChange }: { column: TableColumn; value: FilterValue | undefined; onChange: (value: FilterValue | null) => void }) {
	const { documents } = useCollection(column.to ?? '');
	// "Tag: Print" for a list called Tags; a single reference by its own label ("Author: Ada").
	const one = column.kind === 'references' ? singularLabel(column.label) : column.label;
	const options = [{ value: '', label: `Any ${one.toLowerCase()}` }, ...documents.map((d) => ({ value: `r:${d.path}`, label: `${one}: ${d.label || d.title}` }))];
	const current = value === undefined ? '' : `r:${String(value)}`;
	if (value !== undefined && !options.some((o) => o.value === current)) options.push({ value: current, label: `${one}: ${MISSING}` });
	return (
		<select
			className={`input ct-filter${value === undefined ? '' : ' is-set'}`}
			aria-label={`Filter by ${one.toLowerCase()}`}
			data-filter-key={column.key}
			value={current}
			onChange={(e) => onChange(e.target.value === '' ? null : e.target.value.slice(2))}
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	);
}

/** A list's label as one of its items: "Tags" → "Tag", "Categories" → "Category". */
const singularLabel = (label: string) => (/ies$/i.test(label) ? label.replace(/ies$/i, 'y') : /[^s]s$/i.test(label) ? label.slice(0, -1) : label);

/** A reference cell (Decision 13): the title, or each of a list's joined by commas; one that's gone is "Missing", in the warning colour. */
function RefCell({ doc, column, refs }: { doc: ListedDocument; column: TableColumn; refs: RefIndex }) {
	const parts = refParts(doc, column, refs);
	if (parts.length === 0) {
		return (
			<td className={`ct-${column.kind}`}>
				<span className="ct-nil" aria-label="None">–</span>
			</td>
		);
	}
	return (
		<td className={`ct-${column.kind}`} title={cellText(doc, column, () => '', refs)}>
			{parts.map((p, i) => (
				<Fragment key={`${i}:${p.path}`}>
					{i > 0 ? ', ' : null}
					{p.title === null ? (
						<span className="ct-missing" data-missing={p.path}>
							{MISSING}
						</span>
					) : (
						p.title
					)}
				</Fragment>
			))}
		</td>
	);
}

function Row(props: { doc: ListedDocument; columns: readonly TableColumn[]; current: boolean; edited: (ms: number) => string; refs: RefIndex; extra: string | null; isDefault?: boolean; /** Review gaps (Decision 3): its place in Site order, from 1. */ position?: number }) {
	const editor = useEditor();
	const { doc } = props;
	const open = () => openDoc(editor, doc);
	const onClick = (event: MouseEvent) => {
		// The title's own button handles its click; a selection being made isn't a click on the row.
		if ((event.target as Element).closest('button') || String(window.getSelection() ?? '') !== '') return;
		open();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			const row = (event.currentTarget as HTMLElement).closest('tr');
			const next = (event.key === 'ArrowDown' ? row?.nextElementSibling : row?.previousElementSibling)?.querySelector<HTMLElement>('.ct-open');
			if (next) {
				event.preventDefault();
				next.focus();
			}
		}
	};
	return (
		<tr className={[props.current ? 'is-current' : '', doc.warning ? 'is-warned' : ''].filter(Boolean).join(' ') || undefined} data-doc={docId(doc)} onClick={onClick}>
			{props.position !== undefined ? <td className="ct-pos">{props.position}</td> : null}
			{props.columns.map((c) => {
				if (c.kind === 'title') {
					return (
						<th key={c.key} scope="row" className="ct-title-cell">
							<button type="button" className="ct-open" aria-current={props.current ? 'page' : undefined} title={doc.warning?.message} onClick={open} onKeyDown={onKeyDown}>
								<span className="nm">{doc.label}</span>
							</button>
							<span className="meta">
								{doc.warning ? (
									<span className="wmark" data-warning={doc.warning.code} title={doc.warning.message}>
										<Icon name="warn" size="xs" />
										<span className="sr">{warnedWords(doc)}: {doc.warning.message}</span>
									</span>
								) : null}
								{/* M9 Decision 7, collections under pages (Decision 11): hidden, or hidden with the page that holds it, named. */}
								{/* The sidebar's mark: the word, small and grey; the page that hides it on hover and to a screen reader. */}
								{doc.hidden ? (
									<span className="hmark" data-mark="hidden" title={hiddenTitle(doc, editor.documents.get())}>
										Hidden
										{doc.hiddenBy ? <span className="sr">: {hiddenTitle(doc, editor.documents.get())}</span> : null}
									</span>
								) : null}
								{editor.mode === 'live' ? <DocMarksView file={doc.file} /> : <span data-slot="presence" hidden />}
								{props.isDefault ? (
									<span className="chip def" data-chip="default">
										Default
									</span>
								) : null}
							</span>
							{props.extra ? <span className="ct-extra">{props.extra}</span> : null}
						</th>
					);
				}
				if (c.kind === 'toggle') {
					const on = cellValue(doc, c) === true;
					return (
						<td key={c.key} className="ct-toggle">
							{on ? <Icon name="check" size="sm" /> : null}
							<span className="sr">{on ? 'Yes' : 'No'}</span>
						</td>
					);
				}
				if (c.kind === 'reference' || c.kind === 'references') return <RefCell key={c.key} doc={doc} column={c} refs={props.refs} />;
				const text = cellText(doc, c, props.edited);
				return (
					<td key={c.key} className={`ct-${c.kind}`}>
						{text ? text : <span className="ct-nil" aria-label="None">–</span>}
					</td>
				);
			})}
		</tr>
	);
}
