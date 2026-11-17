/**
 * A manual collection's list in the sidebar (review gaps, Decisions 3 and 4; the mockup's
 * #order-site, #order-drag, #order-sorted, #order-find, #order-locked and #order-new-locked).
 *
 * - **Site order** by default: a grip at each row's start, dragged with the block list's
 *   mechanism (block-list/reorder.ts → `useRowDrag`), or ⌥↑/⌥↓ on a focused row. The row
 *   being dragged leaves a dashed slot, and a lifted copy says where it goes ("Goes 2nd of 7").
 *   The list moves at once; the order is kept in the background (hand-order.ts).
 * - **Sorted another way** (in the stage's table, or the grid's select): no grips, and a
 *   line says how it's sorted and that dragging happens in Site order, with a way back.
 * - **A find or a filter**: no grips either, and a line says how many show and to clear it.
 * - **Someone else has Site Settings** (live mode), which holds the order: a note says so,
 *   and the grips are drawn but off.
 * - **A new entry waiting** for its first place (made while Site Settings was someone
 *   else's): a line says it goes first once Site Settings is free, and its row says
 *   "Goes first".
 * No side rails: the lines are the sunken wash with an icon (M2 Decision 10).
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { displayName } from '../../../live/messages.ts';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { DocRow, docIcon } from '../nav/DocRow.tsx';
import { Avatar } from '../live/marks.tsx';
import { rowKeyAction, useRowDrag } from '../block-list/reorder.ts';
import { cellText, dragsInView, refIndex, SITE_ORDER, sortWords, tableColumns, type TableView } from './table.ts';
import { when } from '../live/format.ts';
import { moveInOrder, orderHolder, waitingFor } from './hand-order.ts';
import type { EditorAnyCollection, ListedDocument } from '../../types.ts';

/** 1st, 2nd, 3rd, 4th… 11th, 12th, 13th, 21st. */
export const nth = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** The line over a manual collection's list or table when it can't drag: sorted another way, or found and filtered. Null in Site order with nothing found. */
export function OrderLine(props: { collection: EditorAnyCollection; view: TableView; shown: number; total: number; update: (patch: Partial<TableView>) => void }) {
	const { view, update } = props;
	const words = sortWords(tableColumns(props.collection), view.sort);
	if (words) {
		return (
			<div className="order-line" role="status" data-line="sorted">
				<Icon name="sort" size="sm" />
				<span>
					Sorted by <b>{words.label}</b>, {words.how}. Dragging happens in Site order.{' '}
					<button type="button" className="linkbtn" data-act="site-order" onClick={() => update({ sort: { key: SITE_ORDER, dir: 'asc' } })}>
						Back to Site order
					</button>
				</span>
			</div>
		);
	}
	const finding = view.query.trim() !== '';
	const filtering = Object.keys(view.filters).length > 0;
	if (!finding && !filtering) return null;
	const what = finding && filtering ? 'the find and the filters' : finding ? 'the find' : 'the filters';
	return (
		<div className="order-line" role="status" data-line="found">
			<Icon name="search" size="sm" />
			<span>
				Showing {props.shown} of {props.total}. Clear {what} to drag.{' '}
				<button type="button" className="linkbtn" data-act="clear-find" onClick={() => update({ query: '', filters: {} })}>
					Clear
				</button>
			</span>
		</div>
	);
}

export function HandOrderList(props: { collection: EditorAnyCollection; docs: readonly ListedDocument[]; shown: readonly ListedDocument[]; view: TableView; update: (patch: Partial<TableView>) => void; readOnly: boolean }) {
	const editor = useEditor();
	const { collection, docs, shown, view } = props;
	const holder = useStore(editor.marks, (all) => (editor.mode === 'live' ? orderHolder(all) : null));
	const waiting = useStore(waitingFor(editor), (all) => all[collection.name]) ?? [];
	const inSiteOrder = dragsInView(view);
	const canDrag = inSiteOrder && !holder && !props.readOnly;
	const list = useRef<HTMLUListElement>(null);
	const focusAfter = useRef<string | null>(null);
	const [lift, setLift] = useState<number | null>(null);
	const indexOf = (path: string) => docs.findIndex((d) => d.path === path);
	// Sorted by another column (#order-sorted): each row shows that column's value on its right ("1 Jun 2022"). The title needs none.
	const documents = useStore(editor.documents);
	const refs = useMemo(() => refIndex(documents), [documents]);
	const sortedBy = view.sort.key !== SITE_ORDER && view.sort.key !== 'title' ? tableColumns(collection).find((c) => c.key === view.sort.key) : undefined;
	const now = new Date().toISOString();
	const sortedText = (d: ListedDocument) => {
		if (!sortedBy) return '';
		const text = cellText(d, sortedBy, (ms) => when(new Date(ms).toISOString(), editor.timeZone(), now), refs);
		// A day with its month short, to fit the row: "1 Jun 2022", as the mockup draws it.
		return sortedBy.kind === 'date' ? text.replace(/^(\d+ [A-Z][a-z]{2})[a-z]+/, '$1') : text;
	};

	const move = (path: string, to: number, viaKeys: boolean) => {
		const doc = docs[indexOf(path)];
		if (!doc) return;
		if (viaKeys) focusAfter.current = path;
		moveInOrder(editor, collection.name, path, to);
		editor.announce(`Moved ${doc.label} to ${to + 1} of ${docs.length}.`);
	};

	// A row moved from the keyboard keeps the focus in its new place.
	useEffect(() => {
		const path = focusAfter.current;
		if (path === null) return;
		focusAfter.current = null;
		list.current?.querySelector<HTMLElement>(`.orow[data-path="${CSS.escape(path)}"] .drow`)?.focus();
	});

	const rows = useRowDrag({
		rowOf: (target) => target.closest?.('.orow[data-path]') as HTMLElement | null,
		keyOf: (row) => row.dataset.path!,
		indexOf,
		onMove: (path, to) => move(path, to, false),
	});
	const drag = rows.drag;

	const start = (event: DragEvent, path: string) => {
		if (!canDrag) {
			event.preventDefault();
			return;
		}
		// The lifted copy below is the drag image: the browser's own is a blank.
		const blank = new Image();
		blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
		event.dataTransfer.setDragImage(blank, 0, 0);
		rows.start(event, path);
	};
	const over = (event: DragEvent) => {
		rows.over(event);
		const row = (event.target as Element).closest?.('.orow[data-path]') as HTMLElement | null;
		if (row && list.current) {
			const box = row.getBoundingClientRect();
			const after = event.clientY - box.top > box.height / 2;
			setLift(row.offsetTop + (after ? row.offsetHeight : 0) - 8);
		}
	};
	const end = () => {
		rows.cancel();
		setLift(null);
	};
	const dropped = (event: DragEvent) => {
		rows.drop(event);
		setLift(null);
	};

	const onRowKey = (event: KeyboardEvent<HTMLButtonElement>, path: string, index: number) => {
		// ⌫ never deletes from here: only the arrows.
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		if (event.altKey && !canDrag) return;
		const action = rowKeyAction(event, index, shown.length);
		if (action?.kind === 'move') move(path, action.to, true);
		else if (action?.kind === 'focus') list.current?.querySelector<HTMLElement>(`.orow[data-path="${CSS.escape(shown[action.to]!.path)}"] .drow`)?.focus();
	};

	// Where the lifted row would land, in Site order.
	const dragged = drag ? docs[indexOf(drag.key)] : undefined;
	let landing: number | null = null;
	if (drag?.drop) {
		const from = indexOf(drag.key);
		let to = indexOf(drag.drop.key) + (drag.drop.after ? 1 : 0);
		if (from < to) to -= 1;
		landing = to;
	}
	const grips = inSiteOrder && !props.readOnly;
	const head = (
		<div className="ord-h" data-order-head="">
			Site order
			{props.readOnly ? null : holder ? (
				<span className="k">Can’t change while {displayName(holder)} has Site Settings</span>
			) : (
				<span className="k">
					Drag, or <kbd>⌥</kbd>
					<kbd>↑</kbd>
					<kbd>↓</kbd>
				</span>
			)}
		</div>
	);

	return (
		<>
			{holder ? (
				<div className="note lock" role="status" data-note="order-lock">
					<Avatar person={holder} />
					<div>
						<b>{displayName(holder)} is editing Site Settings</b>
						<p>The order of {collection.label.toLowerCase()} is kept there, so it can’t change until they’re done. It frees up when they close it, or a few minutes after they stop typing, without a reload.</p>
					</div>
				</div>
			) : null}
			{waiting.map((path) => {
				const doc = docs.find((d) => d.path === path);
				return doc ? (
					<div key={path} className="order-line" role="status" data-line="waiting">
						<Icon name="clock" size="sm" />
						<span>
							<b>{doc.label}</b> goes first once Site Settings is free. Until then it’s after the others.
						</span>
					</div>
				) : null;
			})}
			{inSiteOrder ? head : <OrderLine collection={collection} view={view} shown={shown.length} total={docs.length} update={props.update} />}
			{shown.length ? (
				<ul ref={list} className={`olist${canDrag ? '' : ' is-off'}`} aria-label={`${collection.label}, in ${inSiteOrder ? 'Site order' : 'the table’s order'}`} onDragOver={over} onDrop={dropped}>
					{shown.map((d, i) => (
						<li key={d.path} className={['orow', rows.classes(d.path)].filter(Boolean).join(' ')} data-path={d.path} draggable={canDrag} onDragStart={(e) => start(e, d.path)} onDragEnd={end}>
							<DocRow
								doc={d}
								lead={
									grips ? (
										<span className="ogrip" data-grip="" aria-hidden="true">
											<Icon name="grip" />
										</span>
									) : undefined
								}
								ariaLabel={`${d.label}, ${i + 1} of ${shown.length}${canDrag ? '. Alt with the up or down arrow moves it' : ''}`}
								onKeyDown={(e) => onRowKey(e, d.path, i)}
								extra={
									<>
										{waiting.includes(d.path) ? (
											<span className="chip def" data-chip="goes-first">
												Goes first
											</span>
										) : null}
										{sortedText(d) ? (
											<span className="when" data-sorted-by={sortedBy!.key}>
												{sortedText(d)}
											</span>
										) : null}
									</>
								}
							/>
						</li>
					))}
					{dragged && drag?.ghost && lift !== null && landing !== null ? (
						<li className="odrag" style={{ top: lift }} aria-hidden="true">
							<span className="ogrip">
								<Icon name="grip" />
							</span>
							<Icon name={docIcon(collection)} />
							<span className="nm">{dragged.label}</span>
							<span className="to">
								Goes {nth(landing + 1)} of {docs.length}
							</span>
						</li>
					) : null}
				</ul>
			) : (
				<p className="no-hits" role="status">
					<b>{Object.keys(view.filters).length > 0 ? `Nothing in ${collection.label} matches the table's filters` : `Nothing in ${collection.label} called “${view.query.trim()}”`}</b>
				</p>
			)}
			{inSiteOrder && shown.length ? (
				<p className="kb-hint" data-hint="hand-order">
					The order the site shows them in. A new one goes first: drag it where it belongs.
				</p>
			) : null}
		</>
	);
}
