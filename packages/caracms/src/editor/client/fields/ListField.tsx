/**
 * List (M5a Decision 5): `list({ role: text(), name: text() })` stores objects,
 * `list(text())` a flat array. The mockup's `.items`: one row per item, one open
 * at a time; a collapsed row sums itself up in a line (the field's `itemLabel`,
 * else its first text field's value; for `list(text())` the string itself; for
 * `list(reference())` the referenced document's title, drawn as the mockup's
 * `.refs`).
 *
 * Rows add, remove (at once, with M2's Undo toast: Decision 14, through the
 * document store) and reorder by drag and ⌥↑/⌥↓, the block list's mechanism
 * (block-list/reorder.ts). An empty list says so.
 *
 * Clicking an item's render in the preview opens its row and focuses its field
 * (Decision 13): the view's picked path `credits.1.name` opens row 1.
 *
 * M7 (Decisions 14–15): an item field that is itself a list sits inside its open
 * outer row (the mockup's `.sublist`: inset, on the sunken surface, with its own
 * label, count, Add and drag hint). Its rows are the same rows, with their own one
 * open at a time, and their drag and keys move only their own list's rows. A picked
 * `menu.1.links.0.label` opens row 1 of `menu`, then row 0 of its `links`.
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
	parseField,
	titleCase,
	type Field,
	type FieldWarning,
	type LinkValue,
	type ListField as ListDescriptor,
} from '../../../fields.ts';
import { rowKeyAction, useRowDrag } from '../block-list/reorder.ts';
import { useEditor, useStore } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { FieldFrame } from './FieldFrame.tsx';
import { useFieldWarnings, useHost, warningsAt, within } from './host.tsx';
import { LinkControl } from './LinkField.tsx';
import { Warnings } from './parts.tsx';
import { RefPicker, RefRow, useCollection } from './ReferenceField.tsx';
import { FieldControl } from './FieldControl.tsx';
import { itemCount, itemNoun, itemSummary } from './list-summary.ts';
import { fileOfKey, MediaSlot, ownerOf } from './MediaField.tsx';
import { clipStill, thumbnailSrc } from '../media/store.ts';
import { parseMedia } from '../../../media-value.ts';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A new, empty item. */
const blankItem = (list: ListDescriptor): unknown =>
	list.item ? parseField(list.item, undefined) : Object.fromEntries(Object.entries(list.fields ?? {}).map(([k, f]) => [k, parseField(f, undefined)]));

/** The index a picked path opens in this list: `credits.1.name` → 1. */
const pickedIndex = (path: string | null, name: string): number | null => {
	if (!within(path, name) || path === name) return null;
	const part = path!.slice(name.length + 1).split('.')[0]!;
	return /^\d+$/.test(part) ? Number(part) : null;
};

export function ListField(props: { name: string; label: string; field: ListDescriptor; value: unknown }) {
	const { field } = props;
	if (field.item?.kind === 'reference') return <ReferenceList {...props} to={field.item.to} />;
	return <ItemList {...props} />;
}

/** The titles of referenced documents, for summaries. */
function useTitleOf(): (to: string, path: string) => string | null {
	const editor = useEditor();
	const documents = useStore(editor.documents);
	return (to, path) => {
		const doc = documents.find((d) => d.collection === to && d.path === path);
		return doc ? doc.label || doc.title : null;
	};
}

function useReorder(name: string, items: readonly unknown[], onMoved?: (from: number, to: number) => void) {
	const host = useHost();
	const editor = useEditor();
	const move = (from: number, to: number, announce = true) => {
		if (to < 0 || to >= items.length || to === from) return;
		const next = [...items];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		host.set(name, next);
		onMoved?.(from, to);
		if (announce) editor.announce(`Moved to ${to + 1} of ${items.length}`);
	};
	const drag = useRowDrag({
		// Its own rows only (`>`): an inner list's rows sit inside an open row of this one (M7).
		rowOf: (target) => target.closest?.(`[data-list="${CSS.escape(name)}"] > [data-row]`) as HTMLElement | null,
		keyOf: (row) => row.dataset.row!,
		indexOf: (key) => Number(key),
		onMove: (key, to) => move(Number(key), to),
	});
	return { move, drag };
}

function ItemList(props: { name: string; label: string; field: ListDescriptor; value: unknown }) {
	const host = useHost();
	const { field } = props;
	const items = Array.isArray(props.value) ? props.value : [];
	const one = itemNoun(props.label, props.field.itemNoun);
	const mediaItem = field.item?.kind === 'media';
	return (
		<FieldFrame
			blockKey={host.scope}
			name={props.name}
			label={props.label}
			help={field.help}
			className={mediaItem ? 'media-field' : undefined}
			meta={
				<span className="field-meta">
					{mediaItem
						? `${itemCount(items.length, props.label, field.itemNoun)}${field.min !== undefined || field.max !== undefined ? ` · ${field.min ?? 0} to ${field.max ?? '∞'}` : ''}`
						: items.length}
				</span>
			}
		>
			<Rows {...props} />
		</FieldFrame>
	);
}

/**
 * M7: a list inside an open row of a list (the mockup's `.sublist`): its label and count,
 * its help, then the same rows, Add and drag hint as a list's.
 */
function InnerList(props: { name: string; label: string; field: ListDescriptor; value: unknown }) {
	const count = Array.isArray(props.value) ? props.value.length : 0;
	return (
		<div className="sublist" data-sublist={props.name}>
			<div className="sublist-h">
				<span className="sub-label">{props.label}</span>
				<span className="field-meta">{count}</span>
			</div>
			<SubHelp help={props.field.help} />
			<Rows {...props} />
		</div>
	);
}

/** A list's rows, its own warnings, and its Add and drag hint. */
function Rows(props: { name: string; label: string; field: ListDescriptor; value: unknown }) {
	const host = useHost();
	const editor = useEditor();
	const { name, field } = props;
	const items = Array.isArray(props.value) ? props.value : [];
	const one = itemNoun(props.label, props.field.itemNoun);
	const titleOf = useTitleOf();
	const warnings = useFieldWarnings(name, field, props.value);
	const [open, setOpen] = useState<number | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	// `:scope >`: this list's own rows, never an inner list's (M7).
	const focusRow = (i: number) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`:scope > [data-row="${i}"] > .item-h > .item-sum`)?.focus());

	// A path picked from the page (or the sidebar) inside an item opens that item.
	const picked = useStore(editor.view, (v) => host.picked(v));
	useEffect(() => {
		const i = pickedIndex(picked, name);
		if (i !== null && i < items.length) setOpen(i);
	}, [picked, name]);

	const { move, drag } = useReorder(name, items, (from, to) => {
		setOpen((o) => (o === from ? to : o === to ? from : o));
	});
	const remove = (i: number) => {
		const { main } = itemSummary(field, items[i], titleOf);
		setOpen((o) => (o === null || o < i ? o : o === i ? null : o - 1));
		host.removeItem(name, i, `Removed ${one}: ${main || 'empty'}`);
	};
	// A list of media (the gallery): Add opens the library as a picker that takes several, each added as a row (M5b Decision 7).
	const mediaItem = field.item?.kind === 'media' ? field.item : null;
	const add = () => {
		if (mediaItem) {
			if (host.readOnly) return;
			const { owner, back } = ownerOf(editor, host.scope);
			editor.openMedia({
				pick: { scope: host.scope, path: `${name}.${items.length}`, only: mediaItem.only, play: mediaItem.play, label: `${owner} · ${props.label}, ${one} ${items.length + 1}`, owner, multi: true, back },
				tab: mediaItem.only === 'video' ? 'clips' : 'images',
			});
			return;
		}
		host.set(`${name}.${items.length}`, blankItem(field));
		setOpen(items.length);
		requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`:scope > [data-row="${items.length}"] > .item-b :is(input,textarea,select,[contenteditable="true"])`)?.focus());
	};
	const onKey = (event: KeyboardEvent, i: number) => {
		if (host.readOnly) return;
		const action = rowKeyAction(event, i, items.length);
		if (action?.kind === 'move') {
			move(i, action.to);
			focusRow(action.to);
		} else if (action?.kind === 'remove') {
			remove(i);
			focusRow(Math.min(i, items.length - 2));
		} else if (action?.kind === 'focus') focusRow(action.to);
	};

	return (
		<>
			{items.length === 0 ? (
				<div className="list-empty">No {props.label.toLowerCase()} yet.</div>
			) : (
				<div className="items" ref={listRef} data-list={name} onDragOver={drag.over} onDrop={drag.drop}>
					{items.map((item, i) => {
						const isOpen = open === i;
						const own = warningsAt(warnings, String(i));
						const summary = itemSummary(field, item, titleOf);
						const { main } = summary;
						// A link to a page that's gone says so in its row (the mockup's #link-missing).
						// M6c G4: a link to a file that isn't in the library, likewise.
						const gone = own.find((w) => w.code === 'link-missing');
						const more = gone ? (gone.message.startsWith("There's no file") ? "a file that isn't in the library" : "a page that's gone") : summary.more;
						return (
							<div
								key={i}
								className={['item', isOpen ? 'is-open' : '', own.length && !isOpen ? 'is-warn' : '', drag.classes(String(i))].filter(Boolean).join(' ')}
								data-row={i}
								draggable={!host.readOnly && !isOpen}
								onDragStart={(e) => {
									// An inner list's row (M7): its drag is its own list's, not the open outer row's.
									e.stopPropagation();
									drag.start(e, String(i));
								}}
								onDragEnd={(e) => {
									e.stopPropagation();
									drag.cancel();
								}}
							>
								<div className="item-h">
									<span className="grip" aria-hidden="true">
										{host.readOnly ? null : <Icon name="grip" />}
									</span>
									<button
										type="button"
										className="item-sum"
										aria-expanded={isOpen}
										aria-label={`${main || `New ${one}`}, ${i + 1} of ${items.length}. Alt and arrow keys move it`}
										onClick={() => {
											setOpen(isOpen ? null : i);
											// A gallery's open row picks its own image, so the page rings that one (the mockup's #gallery-row).
											if (mediaItem) host.pick(isOpen ? name : `${name}.${i}`);
										}}
										onKeyDown={(e) => onKey(e, i)}
									>
										{mediaItem ? <MediaMini item={item} /> : null}
										{own.length ? (
											<span className="wmark">
												<Icon name="warn" size="xs" />
											</span>
										) : null}
										{mediaItem ? (
											<MediaRowSummary item={item} />
										) : (
											<span className="s">
												{main ? main : <em>{field.item ? 'Empty' : `New ${one}`}</em>}
												{more ? <span> · {more}</span> : null}
											</span>
										)}
										<Icon name="chev-r" size="xs" />
									</button>
									{host.readOnly ? null : <ItemMenu name={name} index={i} count={items.length} onMove={(to) => { move(i, to); focusRow(to); }} onRemove={() => remove(i)} label={main || `this ${one}`} />}
								</div>
								{isOpen ? (
									<div className="item-b">
										<ItemBody list={field} name={name} index={i} item={item} warnings={own} />
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			)}
			<Warnings warnings={warnings.filter((w) => w.path === '')} />
			<div className="list-foot">
				<button type="button" className="linkbtn subtle" onClick={add}>
					<Icon name="plus" size="xs" />
					Add {one}
				</button>
			</div>
		</>
	);
}

/** The row menu: Move up, Move down, Remove, with their keys (as the block list's). */
function ItemMenu(props: { name: string; index: number; count: number; label: string; onMove: (to: number) => void; onRemove: () => void }) {
	const [open, setOpen] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
		const onDown = (event: MouseEvent) => {
			if (!(event.target as Element).closest?.('.menu, [data-item-more]')) setOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [open]);
	const onKey = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			setOpen(false);
		}
	};
	const { index, count } = props;
	return (
		<>
			<button type="button" className="ib" data-item-more="" aria-label={`Actions for ${props.label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Icon name="more" />
			</button>
			{open ? (
				<div ref={menu} className="menu" role="menu" onKeyDown={onKey}>
					<button type="button" role="menuitem" disabled={index === 0} onClick={() => (setOpen(false), props.onMove(index - 1))}>
						<Icon name="up" />
						Move up
						<span className="k">
							<kbd>⌥</kbd>
							<kbd>↑</kbd>
						</span>
					</button>
					<button type="button" role="menuitem" disabled={index === count - 1} onClick={() => (setOpen(false), props.onMove(index + 1))}>
						<Icon name="down" />
						Move down
						<span className="k">
							<kbd>⌥</kbd>
							<kbd>↓</kbd>
						</span>
					</button>
					<hr />
					<button type="button" role="menuitem" className="danger" onClick={() => (setOpen(false), props.onRemove())}>
						<Icon name="trash" />
						Remove
						<span className="k">
							<kbd>⌫</kbd>
						</span>
					</button>
				</div>
			) : null}
		</>
	);
}

/** An open item's fields: simple ones as a sub-label and a control (the mockup's subField), others as their full field. */
function ItemBody(props: { list: ListDescriptor; name: string; index: number; item: unknown; warnings: readonly FieldWarning[] }) {
	const { list, name, index } = props;
	const base = `${name}.${index}`;
	if (list.item) {
		return <SubField field={list.item} path={base} label={titleCase(itemNoun(list.label ?? name, list.itemNoun))} value={props.item} warnings={props.warnings} rel={String(index)} />;
	}
	const data = isObject(props.item) ? props.item : {};
	const entries = Object.entries(list.fields ?? {});
	const simple = entries.every(([, f]) => f.kind === 'text' && !f.multiline);
	const fields = entries.map(([key, f]) => (
		<div key={key}>
			{/* An inner list of references keeps its own field (the mockup's `.refs`), as at the top level. */}
			{f.kind === 'list' && f.item?.kind !== 'reference' ? (
				<InnerList name={`${base}.${key}`} label={f.label ?? titleCase(key)} field={f} value={data[key]} />
			) : (
				<SubField field={f} path={`${base}.${key}`} label={f.label ?? titleCase(key)} value={data[key]} warnings={warningsAt(props.warnings, `${index}.${key}`)} rel={`${index}.${key}`} />
			)}
		</div>
	));
	// Two short text fields sit side by side, as the mockup's credits do.
	return simple && entries.length === 2 ? <div className="two">{fields}</div> : <>{fields}</>;
}

/** M6c (G8): an item field's help, under its sub-label. */
function SubHelp({ help }: { help: string | undefined }) {
	return help ? (
		<p className="field-help" data-help="">
			{help}
		</p>
	) : null;
}

/** One field inside a list item. `path` is from the host's root; `rel` is the warnings' path relative to the list. */
function SubField(props: { field: Field; path: string; label: string; value: unknown; warnings: readonly FieldWarning[]; rel: string }) {
	const host = useHost();
	const { field, path, value } = props;
	const id = `f-${host.scope}-${path}`.replace(/\./g, '-');
	const set = (v: unknown) => host.set(path, v);
	const messages = (ws: readonly FieldWarning[]) => <Warnings warnings={ws} />;
	let control: ReactNode;
	switch (field.kind) {
		case 'text':
			control = field.multiline ? (
				<textarea className="input" id={id} rows={3} data-path={path} value={typeof value === 'string' ? value : ''} spellCheck={false} onChange={(e) => set(e.target.value)} />
			) : (
				<input className="input" id={id} data-path={path} value={typeof value === 'string' ? value : ''} autoComplete="off" spellCheck={false} onChange={(e) => set(e.target.value.replace(/\n+/g, ' '))} />
			);
			break;
		case 'select':
			control = (
				<select className="input" id={id} data-path={path} value={typeof value === 'string' ? value : field.default} onChange={(e) => set(e.target.value)}>
					{field.options.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			);
			break;
		case 'toggle': {
			const on = typeof value === 'boolean' ? value : field.default;
			control = (
				<button type="button" className="switch" role="switch" id={id} data-path={path} aria-checked={on} onClick={() => set(!on)}>
					<span className="track" />
					<span>{on ? 'On' : 'Off'}</span>
				</button>
			);
			break;
		}
		case 'date':
			control = <input className="input" type="date" id={id} data-path={path} value={typeof value === 'string' ? value : ''} onChange={(e) => set(e.target.value === '' ? null : e.target.value)} />;
			break;
		case 'number':
			control = (
				<input
					className="input"
					type="number"
					id={id}
					data-path={path}
					value={typeof value === 'number' ? value : ''}
					min={field.min}
					max={field.max}
					step={field.step ?? 'any'}
					onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
				/>
			);
			break;
		case 'link': {
			const v = (isObject(value) ? value : { label: '', href: '' }) as unknown as LinkValue;
			const rel = props.rel;
			// G9: an address-only link item is where it goes, under its sub-label.
			if (field.addressOnly) {
				return (
					<>
						<span className="sub-label">{props.label}</span>
						<SubHelp help={field.help} />
						<LinkControl path={`${path}.href`} href={v.href ?? ''} label={props.label} warnings={warningsAt(props.warnings, `${rel}.href`)} onChange={(href) => host.set(`${path}.href`, href)} />
					</>
				);
			}
			// The mockup's link item: its words, then where it goes, each under its own sub-label.
			return (
				<>
					<label className="sub-label" htmlFor={id}>
						Label
					</label>
					<input
						className="input"
						id={id}
						data-path={`${path}.label`}
						placeholder="Label"
						value={v.label}
						autoComplete="off"
						spellCheck={false}
						onChange={(e) => host.set(`${path}.label`, e.target.value.replace(/\n+/g, ' '))}
					/>
					<span className="sub-label">{props.label}</span>
					<SubHelp help={field.help} />
					<LinkControl path={`${path}.href`} href={v.href} warnings={warningsAt(props.warnings, `${rel}.href`)} onChange={(href) => host.set(`${path}.href`, href)} />
					{messages(props.warnings.filter((w) => w.code === 'half-link'))}
				</>
			);
		}
		case 'reference':
			return <SubReference label={props.label} help={field.help} to={field.to} path={path} value={value} warnings={props.warnings} />;
		case 'media': {
			// A gallery row's body is the slot itself (the mockup's gallery-row); its Remove removes the row.
			const [list, index] = [path.slice(0, path.lastIndexOf('.')), Number(path.slice(path.lastIndexOf('.') + 1))];
			const rel = (w: FieldWarning) => ({ ...w, path: w.path === props.rel ? '' : w.path.slice(props.rel.length + 1) });
			return (
				<>
					<SubHelp help={field.help} />
					<MediaSlot
						path={path}
						field={field}
						value={value}
						warnings={props.warnings.map(rel)}
						pickLabel={`${props.label} ${index + 1}`}
						row={{ list, index, label: `${props.label.toLowerCase()} ${index + 1}` }}
					/>
				</>
			);
		}
		default:
			// Rich text, a lockup or buttons inside a list item: their own field, at this path.
			return <FieldControl name={path} label={props.label} field={field} value={value} />;
	}
	return (
		<>
			<label className="sub-label" htmlFor={id}>
				{props.label}
			</label>
			<SubHelp help={field.help} />
			{control}
			{messages(props.warnings)}
		</>
	);
}

function SubReference(props: { label: string; help?: string; to: string; path: string; value: unknown; warnings: readonly FieldWarning[] }) {
	const host = useHost();
	const [picking, setPicking] = useState(false);
	const value = typeof props.value === 'string' && props.value !== '' ? props.value : null;
	const { label } = useCollection(props.to);
	return (
		<>
			<span className="sub-label">{props.label}</span>
			<SubHelp help={props.help} />
			{value ? <RefRow to={props.to} path={value} onRemove={() => host.set(props.path, null)} /> : null}
			<Warnings warnings={props.warnings} />
			<div className="lnk" style={{ marginTop: value ? 'var(--space-1-5)' : 0 }}>
				<button type="button" className="linkbtn subtle" data-path={props.path} aria-expanded={picking} onClick={() => setPicking(!picking)}>
					<Icon name="plus" size="xs" />
					{value ? 'Choose another' : `Choose from ${label}`}
				</button>
				{picking ? (
					<RefPicker
						to={props.to}
						taken={value ? [value] : []}
						onPick={(p) => {
							host.set(props.path, p);
							setPicking(false);
						}}
						onClose={() => setPicking(false)}
					/>
				) : null}
			</div>
		</>
	);
}

/** `list(reference({ to }))`: the mockup's `.refs`, each row the referenced document; a missing one warned. */
function ReferenceList(props: { name: string; label: string; field: ListDescriptor; value: unknown; to: string }) {
	const host = useHost();
	const { name } = props;
	const refs = (Array.isArray(props.value) ? props.value : []).map((v) => (typeof v === 'string' ? v : ''));
	const one = itemNoun(props.label, props.field.itemNoun);
	const titleOf = useTitleOf();
	const warnings = useFieldWarnings(name, props.field, props.value);
	const [picking, setPicking] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const { move, drag } = useReorder(name, refs);
	const focusRow = (i: number) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row="${i}"]`)?.focus());
	const remove = (i: number) => host.removeItem(name, i, `Removed ${one}: ${titleOf(props.to, refs[i]!) ?? 'the missing one'}`);
	const onKey = (event: KeyboardEvent, i: number) => {
		if (host.readOnly || event.target !== event.currentTarget) return;
		const action = rowKeyAction(event, i, refs.length);
		if (action?.kind === 'move') {
			move(i, action.to);
			focusRow(action.to);
		} else if (action?.kind === 'remove') {
			remove(i);
			focusRow(Math.min(i, refs.length - 2));
		} else if (action?.kind === 'focus') focusRow(action.to);
	};
	const gone = warnings.filter((w) => w.code === 'missing-reference').length;
	return (
		<FieldFrame blockKey={host.scope} name={name} label={props.label} help={props.field.help} meta={<span className="field-meta">{refs.length}</span>}>
			{refs.length === 0 ? (
				<div className="list-empty">None yet.</div>
			) : (
				<div className="refs" ref={listRef} data-list={name} onDragOver={drag.over} onDrop={drag.drop}>
					{refs.map((path, i) => (
						// The row is the reference itself (the mockup's .refs > .ref), focusable and draggable.
						<RefRow
							key={`${i}-${path}`}
							to={props.to}
							path={path}
							grip={!host.readOnly}
							onRemove={() => remove(i)}
							rowClass={drag.classes(String(i))}
							rowProps={{
								'data-row': i,
								draggable: !host.readOnly,
								tabIndex: 0,
								'data-path': `${name}.${i}`,
								'aria-label': `${titleOf(props.to, path) ?? 'One that’s gone'}, ${i + 1} of ${refs.length}. Alt and arrow keys move it`,
								onDragStart: (e: DragEvent) => drag.start(e, String(i)),
								onDragEnd: drag.cancel,
								onKeyDown: (e: KeyboardEvent) => onKey(e, i),
							}}
						/>
					))}
				</div>
			)}
			{gone ? (
				<Warnings
					warnings={[
						{
							path: '',
							code: 'missing-reference',
							message: gone === 1 ? 'One was deleted and is skipped on the site.' : `${gone} were deleted and are skipped on the site.`,
						},
					]}
				/>
			) : null}
			<Warnings warnings={warnings.filter((w) => w.code !== 'missing-reference')} />
			<div className="lnk" style={{ marginTop: 'var(--space-2)' }}>
				<button type="button" className="linkbtn subtle" aria-expanded={picking} onClick={() => setPicking(!picking)}>
					<Icon name="plus" size="xs" />
					Add {one}
				</button>
				{picking ? (
					<RefPicker
						to={props.to}
						taken={refs}
						onPick={(p) => {
							host.set(`${name}.${refs.length}`, p);
							setPicking(false);
						}}
						onClose={() => setPicking(false)}
					/>
				) : null}
			</div>
		</FieldFrame>
	);
}

/** A gallery row's picture: the server's signed thumbnail (a clip's still), small, at its focal point. */
function MediaMini({ item }: { item: unknown }) {
	const v = parseMedia(item);
	if (!v) return null;
	const src = 'key' in v ? thumbnailSrc(v.key, 160) : clipStill(v.video, v.poster, 160);
	const position = 'key' in v && v.focal ? `${Math.round(v.focal[0] * 100)}% ${Math.round(v.focal[1] * 100)}%` : undefined;
	return (
		<span className="mini ph">
			<img className="ph-img" src={src} alt="" style={position ? { objectPosition: position } : undefined} />
		</span>
	);
}

/** A gallery row's line: its alt text (Decorative, or No alt text), then its file. */
function MediaRowSummary({ item }: { item: unknown }) {
	const v = parseMedia(item);
	if (!v) return <span className="s"><em>Empty</em></span>;
	if ('video' in v) return <span className="s">{v.name || <em>A clip</em>}</span>;
	return (
		<span className="s">
			{v.decorative ? <em>Decorative</em> : v.alt.trim() ? v.alt : <em>No alt text</em>} <span>· {fileOfKey(v.key)}</span>
		</span>
	);
}
