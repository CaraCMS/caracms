/**
 * The block list (the mockup's #blocks, #removed, #drag, #unknown): a section-builder
 * document's blocks, one row each.
 *
 * - **Hover** sets `blockHover(editor)` (link.ts), and a row is drawn hovered while
 *   that store holds its key, so the preview's overlays can follow it both ways.
 *   **Selected** (`.is-current`) is `editor.view.block`.
 * - **Reorder by drag** (the grip; the drop line is full width) **and by keys**
 *   (M2's keys rule, on a focused row): ⌥↑/⌥↓ move it, ⌫ removes it (with Undo:
 *   the toast and ⌘Z, Decision 18), Enter opens it, ↑/↓ move between rows. The row
 *   menu has the same moves with their keys.
 * - **An unknown block** (Decisions 7 and 21) is marked Skipped with its kept keys
 *   summarised; it moves and is removed like any block, and opens to a panel, not
 *   fields. The serializer writes it back as read (by its `source`).
 *
 * Everything that changes the document goes through `editor.doc` (document-store.ts).
 */
import { own } from '../../../document.ts';
import { fieldHoldsMedia, fieldWarnings, type Field } from '../../../fields.ts';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { blockLabel } from '../state/document-store.ts';
import { offersBlock } from '../state/schema.ts';
import { sameDoc, type EditorBlock, type EditorSite } from '../../types.ts';
import { blockHover, openPicker, setBlockHover } from './link.ts';
import { rowKeyAction, useRowDrag } from './reorder.ts';
import { blockIcon, blockSummary, sharedOf, slotEntryOf, usedOnLine } from './summary.ts';

export function BlockList() {
	const editor = useEditor();
	const blocks = useStore(editor.doc.state, (s) => s.document.blocks);
	const title = useStore(editor.doc.state, (s) => s.document.title || s.entry.label);
	const current = useStore(editor.view, (v) => v.block);
	const hovered = useStore(blockHover(editor));
	// The row's marks beside the name (the mockup's browHTML): too long for mobile, and has its own phone lines.
	const showing = useStore(editor.previewStatus, (s) => s.showing);
	const warnings = useStore(editor.previewStatus, (s) => s.warnings);
	const ref = useStore(editor.doc.state, (s) => s.ref);
	const tooLong = new Set(sameDoc(showing, ref) ? warnings.filter((w) => w.tooLong).map((w) => w.block) : []);
	// Read-only (M4: a lock, held edits, signed out): rows still open their blocks, nothing moves or goes.
	const readOnly = useStore(editor.access, (a) => a.readOnly);
	const documents = useStore(editor.documents);
	const [menu, setMenu] = useState<string | null>(null);
	const list = useRef<HTMLOListElement>(null);
	/** A row (by key) to focus once the list has re-rendered: after a keyboard move or remove. */
	const focusNext = useRef<string | 'add' | null>(null);

	useEffect(() => {
		const want = focusNext.current;
		if (!want) return;
		focusNext.current = null;
		const el =
			want === 'add'
				? list.current?.parentElement?.querySelector<HTMLElement>('.add-row')
				: list.current?.querySelector<HTMLElement>(`.brow[data-block-key="${want}"] .brow-main`);
		el?.focus();
	});

	// A row hovered or focused when the list goes (the picker opens, a block opens) isn't hovered any more.
	useEffect(() => () => setBlockHover(editor, null), [editor]);

	// The row menu closes on a click outside it.
	useEffect(() => {
		if (!menu) return;
		const onDown = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (target?.closest?.('.menu') || target?.closest?.('.brow-more')) return;
			setMenu(null);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [menu]);

	// A shared entry that renders (M5a Decision 8) is named by its shared block; one that's skipped stays "Unknown block".
	const label = (b: EditorBlock) => sharedOf(editor.site, documents, b)?.label ?? blockLabel(editor.site, b);

	const move = (key: string, to: number, viaKeys: boolean) => {
		const from = editor.doc.indexOf(key);
		const block = editor.doc.block(key);
		if (!block || from < 0 || to < 0 || to >= blocks.length || to === from) return;
		if (viaKeys) focusNext.current = key;
		editor.doc.moveBlock(key, to);
		editor.announce(`Moved ${label(block)} to ${to + 1} of ${blocks.length}`);
	};

	const remove = (key: string, viaKeys: boolean) => {
		const index = editor.doc.indexOf(key);
		const block = editor.doc.block(key);
		if (!block) return;
		if (viaKeys) focusNext.current = blocks[index + 1]?.key ?? blocks[index - 1]?.key ?? 'add';
		editor.doc.removeBlock(key);
		editor.announce(`Removed ${label(block)}. Undo with Command Z.`);
	};

	const onRowKey = (event: KeyboardEvent<HTMLButtonElement>, block: EditorBlock, index: number) => {
		if (readOnly && (event.altKey || event.key === 'Backspace' || event.key === 'Delete')) return;
		const action = rowKeyAction(event, index, blocks.length);
		if (action?.kind === 'move') move(block.key, action.to, true);
		else if (action?.kind === 'remove') remove(block.key, true);
		else if (action?.kind === 'focus') list.current?.querySelector<HTMLElement>(`.brow[data-block-key="${blocks[action.to]!.key}"] .brow-main`)?.focus();
	};

	// Drag (HTML drag and drop on the rows; the drop line is the mockup's): reorder.ts, shared with M5a's lists.
	const rows = useRowDrag({
		rowOf: (target) => target.closest?.('.brow[data-block-key]') as HTMLElement | null,
		keyOf: (row) => row.dataset.blockKey!,
		indexOf: (key) => editor.doc.indexOf(key),
		onMove: (key, to) => move(key, to, false),
		onStart: () => setMenu(null),
	});
	const drag = rows.drag;

	const dragged = drag ? blocks.find((b) => b.key === drag.key) : undefined;
	const target = drag?.drop ? blocks.find((b) => b.key === drag.drop!.key) : undefined;

	return (
		<>
			<ol
				ref={list}
				className="blist"
				aria-label={`Blocks on ${title}`}
				onMouseLeave={() => setBlockHover(editor, null)}
				onDragOver={rows.over}
				onDrop={rows.drop}
			>
				{blocks.map((block, i) => {
					const name = label(block);
					const shared = sharedOf(editor.site, documents, block);
					const skipped = !block.known && !shared;
					const slotEntry = skipped ? slotEntryOf(documents, block) : null;
					const type = shared?.blockType ?? (block.known ? block.type : null);
					const notOffered = !!type && !offersBlock(editor.site, ref.collection, type);
					const cls = [
						'brow',
						current === block.key && !drag ? 'is-current' : '',
						skipped ? 'is-unknown' : '',
						readOnly ? 'is-disabled' : '',
						hovered === block.key && !drag ? 'hov' : '',
						rows.classes(block.key),
					]
						.filter(Boolean)
						.join(' ');
					return (
						<li
							key={block.key}
							className={cls}
							data-block-key={block.key}
							data-block-type={shared?.blockType ?? block.type}
							data-shared={shared ? shared.path : undefined}
							draggable={!readOnly}
							onMouseEnter={() => setBlockHover(editor, block.key)}
							onDragStart={(e) => rows.start(e, block.key)}
							onDragEnd={rows.cancel}
						>
							<button
								type="button"
								className="brow-main"
								aria-current={current === block.key ? 'true' : undefined}
								aria-label={`${name}${shared ? ', shared' : ''}, ${i + 1} of ${blocks.length}${skipped ? ', skipped' : ''}. Alt and arrow keys move it`}
								onClick={() => editor.openBlock(block.key)}
								onKeyDown={(e) => onRowKey(e, block, i)}
								onFocus={() => setBlockHover(editor, block.key)}
								onBlur={() => {
									if (blockHover(editor).get() === block.key) setBlockHover(editor, null);
								}}
							>
								<span className="grip" aria-hidden="true">
									{readOnly ? null : <Icon name="grip" />}
								</span>
								<span className="bi">
									<Icon name={blockIcon(shared ? { type: shared.blockType!, known: true } : block)} />
								</span>
								<span className="bt">
									<span className="nm">
										{name}
										{shared ? (
											<span className="chip shared" data-chip="shared">
												<Icon name="shared" size="xs" />
												Shared
											</span>
										) : null}
										{!skipped ? null : (
											<span className="chip warn" title={slotEntry ? `${slotEntry.label} is the page's ${slotEntry.slot}, so it isn't a block of the body. Skipped on the page; kept in the file.` : "Its type isn't in the site's code: kept in the file, skipped on the page"}>
												<Icon name="warn" size="xs" />
												Skipped
											</span>
										)}
										{notOffered ? (
											<span className="chip warn" title="Not offered by this collection" data-chip="not-offered">
												<Icon name="warn" size="xs" />
												Not offered here
											</span>
										) : null}
										{tooLong.has(i) ? (
											<span className="chip warn" title="Too long for mobile" data-chip="too-long">
												<Icon name="phone" size="xs" />
												Long
											</span>
										) : null}
										{altGaps(editor.site, block) ? (
											<span className="chip warn" title="An image has no alt text" data-chip="alt">
												<Icon name="image" size="xs" />
												Alt
											</span>
										) : null}
										{hasPhoneLines(editor.site, block) ? (
											<span className="chip phone" title="Has its own lines on Phone" data-chip="phone-lines">
												<Icon name="phone" size="xs" />
											</span>
										) : null}
									</span>
									<span className="sm">{shared ? usedOnLine(shared) : blockSummary(editor.site, block, editor.forms)}</span>
								</span>
							</button>
							{readOnly ? null : (
							<button
								type="button"
								className="ib brow-more"
								aria-label={`Actions for ${name}`}
								aria-haspopup="menu"
								aria-expanded={menu === block.key}
								onClick={() => setMenu(menu === block.key ? null : block.key)}
							>
								<Icon name="more" />
							</button>
							)}
							{menu === block.key && !readOnly ? (
								<RowMenu
									first={i === 0}
									last={i === blocks.length - 1}
									onClose={() => {
										setMenu(null);
										list.current?.querySelector<HTMLElement>(`.brow[data-block-key="${block.key}"] .brow-more`)?.focus();
									}}
									onMove={(dir) => {
										setMenu(null);
										move(block.key, i + dir, true);
									}}
									onRemove={() => {
										setMenu(null);
										remove(block.key, true);
									}}
								/>
							) : null}
						</li>
					);
				})}
			</ol>
			<button type="button" className="add-row" disabled={readOnly} onClick={() => openPicker(editor, blocks.length)}>
				<Icon name="plus" />
				Add block
			</button>
			{!readOnly && drag && dragged && target && target.key !== dragged.key ? (
				<p className="kb-hint" role="status" style={{ color: 'var(--select-strong)' }}>
					Drop to put {label(dragged)} {drag.drop!.after ? 'below' : 'above'} {label(target)}.
				</p>
			) : null}
		</>
	);
}

function RowMenu(props: { first: boolean; last: boolean; onClose: () => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
	const menu = useRef<HTMLDivElement>(null);
	useEffect(() => {
		menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
	}, []);
	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape') {
			// Closes the menu only; App.tsx would otherwise go up a level.
			event.preventDefault();
			props.onClose();
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
			const at = items.indexOf(document.activeElement as HTMLButtonElement);
			items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
		}
	};
	return (
		<div ref={menu} className="menu" role="menu" style={{ right: 4, top: 'calc(100% + 2px)' }} onKeyDown={onKey}>
			<button type="button" role="menuitem" disabled={props.first} onClick={() => props.onMove(-1)}>
				<Icon name="up" />
				Move up
				<span className="k">
					<kbd>⌥</kbd>
					<kbd>↑</kbd>
				</span>
			</button>
			<button type="button" role="menuitem" disabled={props.last} onClick={() => props.onMove(1)}>
				<Icon name="down" />
				Move down
				<span className="k">
					<kbd>⌥</kbd>
					<kbd>↓</kbd>
				</span>
			</button>
			<hr />
			<button type="button" role="menuitem" className="danger" onClick={props.onRemove}>
				<Icon name="trash" />
				Remove
				<span className="k">
					<kbd>⌫</kbd>
				</span>
			</button>
		</div>
	);
}

/** A block with a lockup that has its own phone lines (Decision 10's object form), at the top level or inside a group. */
function hasPhoneLines(site: EditorSite, block: EditorBlock): boolean {
	if (!block.known) return false;
	const fields = own(site.blocks, block.type)?.fields ?? {};
	const phoned = (field: Field, value: unknown) => {
		const phone = field.kind === 'lockup' && !!value && typeof value === 'object' ? (value as { phone?: unknown }).phone : undefined;
		return Array.isArray(phone) && phone.length > 0;
	};
	return Object.entries(fields).some(([name, field]) => {
		const value = block.data[name];
		if (field.kind !== 'group') return phoned(field, value);
		const inner = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
		return Object.entries(field.fields).some(([key, f]) => phoned(f, inner[key]));
	});
}

/**
 * How many images in a block's rendered slots have no alt text (M5b Decision 9: the field's
 * own `missing-alt` warning, so a decorative image never counts). The mockup's browHTML
 * marks such a block (its "Alt" chip); it blocks nothing. An
 * unknown block isn't rendered, and a shared entry's images are its shared block's.
 */
export function altGaps(site: EditorSite, block: EditorBlock): number {
	if (!block.known || block.shared) return 0;
	const fields = own(site.blocks, block.type)?.fields ?? {};
	let n = 0;
	for (const [name, field] of Object.entries(fields)) {
		if (!fieldHoldsMedia(field)) continue;
		n += fieldWarnings(field, block.data[name]).filter((w) => w.code === 'missing-alt').length;
	}
	return n;
}
