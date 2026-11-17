/**
 * A collection's own level (Decision 9; the mockup's #collection and
 * #collection-empty): the documents level stacked above, a header with the
 * collection's name, count and **+ New**, its own filter, and the list. An empty
 * collection's empty state lives here.
 *
 * Nesting is Pages only: a collection here is a flat list, alphabetical by title
 * (the reader's order), or a manual collection's Site order, dragged here (review gaps,
 * Decision 3: collections/HandOrderList.tsx). **+ New** (M5a Decision 11) opens the New dialog
 * (documents/dialogs.tsx). Shared blocks (M5a; the mockup's #shared-list) have their
 * own level here too: each row says where it's used, and + New asks for a block type
 * and a name.
 *
 * Pre-M7 polish: the stage shows the same collection as a table (collections/
 * CollectionTable.tsx). The list here is one view with it: the same find (either box),
 * the table's filters and its order.
 *
 * Edit in context, Decision 1: Shared blocks are grouped, Header, Footer, then the rest under
 * their block types, the ones with a warning last (collections/shared-groups.ts); a slot's
 * default has a "Default" chip once that slot has two.
 */
import { useEditor, useStore } from '../../context.tsx';
import { Icon } from '../../shell/Icons.tsx';
import { DocRow } from '../../nav/DocRow.tsx';
import { tableColumns, viewRows } from '../../collections/table.ts';
import { useRefIndex, useTableView } from '../../collections/CollectionTable.tsx';
import { CurrentHead, DocumentsTab, GlobalNotes, RecentStrip, Trail } from '../parts.tsx';
import { usedOnLine } from '../../block-list/summary.ts';
import { PAGELESS_SUB, singular } from '../../documents/actions.ts';
import { openDialog } from '../../documents/dialogs.tsx';
import { opensInEditor, type ListedDocument } from '../../../types.ts';
import { sharedGroups, showsDefault } from '../../collections/shared-groups.ts';
import { HandOrderList } from '../../collections/HandOrderList.tsx';


export function CollectionLevel() {
	const editor = useEditor();
	const name = useStore(editor.view, (v) => v.collection);
	const documents = useStore(editor.documents);
	// One view with the stage's table (pre-M7 polish): the same find, filters and order.
	const [view, update] = useTableView(name ?? '');
	const refs = useRefIndex();
	const query = view.query;
	const setQuery = (q: string) => update({ query: q });
	const signedOut = useStore(editor.access, (a) => a.signedOut);
	const collection = editor.site.collections.find((c) => c.name === name);
	if (!collection) return null;
	const docs = documents.filter((d) => d.collection === collection.name);
	const shown = viewRows(docs, tableColumns(collection), view, refs);
	const what = collection.label;
	const shared = collection.kind === 'shared';
	const manual = collection.order === 'manual';
	const one = singular(collection);
	const readOnly = !!signedOut;
	const create = () => openDialog(editor, shared ? { kind: 'new-shared' } : { kind: 'new', collection: collection.name });
	return (
		<>
			<Trail>
				<DocumentsTab />
				<CurrentHead
					back={{ label: 'Back to documents', onClick: () => editor.goTo('documents') }}
					title={collection.label}
					chips={<span className="n-chip">{docs.length}</span>}
					sub={shared ? undefined : collection.urlBase === null ? PAGELESS_SUB : <span className="mono">{`${collection.urlBase}…`}</span>}
					menu={
						<button type="button" className="btn sm" data-act="new-document" disabled={readOnly} onClick={create}>
							<Icon name="plus" size="sm" />
							New
						</button>
					}
				/>
			</Trail>
			<div className="side-body" data-collection={collection.name}>
				<GlobalNotes />
				{docs.length === 0 ? (
					<div className="empty" data-empty="collection">
						<b>{shared ? 'No shared blocks yet' : `Nothing in ${what} yet`}</b>
						{!shared && collection.urlBase === null ? <span>No pages of their own.</span> : null}
						<button type="button" className="btn sm" disabled={readOnly} onClick={create}>
							<Icon name="plus" size="sm" />
							{shared ? 'New shared block' : `New ${one}`}
						</button>
					</div>
				) : (
					<>
						<div className="find" style={{ marginTop: 0 }}>
							<Icon name="search" />
							<input
								className="input"
								type="search"
								placeholder={shared ? 'Find a shared block' : `Find in ${what}`}
								aria-label={shared ? 'Find a shared block' : `Find in ${what}`}
								data-filter="collection"
								autoComplete="off"
								spellCheck={false}
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										const first = shown.find((d) => opensInEditor(d));
										if (first) void editor.openDocument({ collection: first.collection, path: first.path });
									} else if (e.key === 'Escape' && query) {
										e.preventDefault();
										setQuery('');
									}
								}}
							/>
						</div>
						<div id="coll-list">
							{manual ? (
								// Review gaps (Decision 3): a manual collection's list drags, in Site order.
								<HandOrderList collection={collection} docs={docs} shown={shown} view={view} update={update} readOnly={readOnly} />
							) : shown.length && shared ? (
								sharedGroups(editor.site, shown).map((g) => (
									<div key={g.key} className="grp" data-group={g.key}>
										<div className="grp-h">
											{g.label} <span className="n">{g.rows.length}</span>
										</div>
										{g.rows.map((d) => (
											<DocRow key={d.path} doc={d} extra={<SharedMeta doc={d} documents={documents} />} />
										))}
									</div>
								))
							) : shown.length ? (
								shown.map((d) => <DocRow key={d.path} doc={d} />)
							) : (
								<p className="no-hits" role="status">
									<b>{Object.keys(view.filters).length > 0 ? `Nothing in ${what} matches the table's filters` : `Nothing in ${what} called “${query.trim()}”`}</b>
								</p>
							)}
						</div>
						{/* The mockup's #shared-list footnote (edit in context). */}
						{shared && shown.length ? (
							<p className="kb-hint" data-hint="shared-blocks">
								A header or footer fills its place on every page by itself. The rest are added to a page from <b>Add a block</b>, under Shared blocks.
							</p>
						) : null}
					</>
				)}
			</div>
			<RecentStrip />
		</>
	);
}

/** A shared block's row: "Default" (once its slot has two), then where it's used. */
function SharedMeta({ doc, documents }: { doc: ListedDocument; documents: readonly ListedDocument[] }) {
	return (
		<>
			{showsDefault(documents, doc) ? (
				<span className="chip def" data-chip="default">
					Default
				</span>
			) : null}
			<span>{usedOnLine(doc)}</span>
		</>
	);
}
