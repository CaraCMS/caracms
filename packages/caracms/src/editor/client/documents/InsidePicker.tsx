/**
 * New page's and Change address…'s "Inside": a field that shows
 * where the page goes and opens a searchable tree of every group and page in place of a
 * select, which stopped working once every page was offered.
 *
 * - **Closed:** the chosen place's whole name (`Services › Advisory`) and the address a page
 *   inside it starts with.
 * - **Open:** a find field over the tree (insideOptions' order: what holds pages first at each
 *   level), each row its own name, indented, with its address. Typing filters by name or
 *   address, every word, and shows each hit by its whole name. "New group…" is always last.
 * - **Keys:** ↑ ↓ move, Enter picks, Esc closes the picker only (the dialog's Frame takes Esc
 *   first and, while `[data-inside-open]` is in it, sends INSIDE_CLOSE instead of closing), Tab
 *   closes it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Icon } from '../shell/Icons.tsx';
import type { InsideOption } from './actions.ts';

/** The event Frame sends an open picker on Esc. */
export const INSIDE_CLOSE = 'caracms:inside-close';

const crumbs = (o: InsideOption) => o.label.split(' / ').join(' › ');

export function InsidePicker(props: { id: string; options: readonly InsideOption[]; value: string; newGroup: string; onChange: (value: string) => void }) {
	const { id, options, value, newGroup } = props;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const trigger = useRef<HTMLButtonElement>(null);
	const root = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const rows = useMemo(() => {
		const hits = words.length ? options.filter((o) => words.every((w) => o.label.toLowerCase().includes(w) || o.base.toLowerCase().includes(w))) : options;
		return [...hits.map((o) => ({ value: o.path, option: o })), { value: newGroup, option: null }];
	}, [options, newGroup, words.join(' ')]);
	const chosen = options.find((o) => o.path === value);
	const close = (focus: boolean) => {
		setOpen(false);
		setQuery('');
		if (focus) trigger.current?.focus();
	};
	const pick = (next: string) => {
		props.onChange(next);
		close(true);
	};
	// Opening starts on what's chosen; a new search starts at the top.
	useEffect(() => {
		if (open) setActive(Math.max(0, rows.findIndex((r) => r.value === value)));
	}, [open]);
	useEffect(() => {
		if (open && query) setActive(0);
	}, [query]);
	useEffect(() => {
		const el = root.current;
		if (!open || !el) return;
		const onClose = () => close(true);
		el.addEventListener(INSIDE_CLOSE, onClose);
		return () => el.removeEventListener(INSIDE_CLOSE, onClose);
	}, [open]);
	useEffect(() => {
		list.current?.querySelector(`#${id}-o-${active}`)?.scrollIntoView({ block: 'nearest' });
	}, [active, open, id]);
	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			setActive((a) => Math.min(rows.length - 1, Math.max(0, a + step)));
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const row = rows[active];
			if (row) pick(row.value);
		} else if (event.key === 'Tab') {
			close(false);
		}
	};
	return (
		<div ref={root} className="inside-pick" data-inside-open={open ? '' : undefined}>
			<button
				ref={trigger}
				type="button"
				className="input inside-btn"
				id={id}
				aria-haspopup="listbox"
				aria-expanded={open}
				data-inside-value={value === newGroup ? '__new' : value}
				// While open, keep focus in the find field so this click closes it (and doesn't blur-close, then reopen).
				onMouseDown={(e) => open && e.preventDefault()}
				onClick={() => (open ? close(true) : setOpen(true))}
			>
				<span className="nm">{value === newGroup ? 'New group…' : chosen ? crumbs(chosen) : 'Top level'}</span>
				{value !== newGroup && chosen ? <span className="mono meta">{chosen.base}</span> : null}
				<Icon name="chev-d" size="xs" />
			</button>
			{open ? (
				<div className="lpop">
					<div className="find">
						<Icon name="search" />
						<input
							className="input"
							value={query}
							placeholder="Find a page or group"
							aria-label="Find a page or group"
							role="combobox"
							aria-expanded="true"
							aria-controls={`${id}-list`}
							aria-activedescendant={`${id}-o-${active}`}
							autoComplete="off"
							spellCheck={false}
							autoFocus
							data-inside-find=""
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={onKey}
							onBlur={(e) => {
								if (!e.relatedTarget || !(e.currentTarget.closest('.inside-pick')?.contains(e.relatedTarget as Node) ?? false)) close(false);
							}}
						/>
					</div>
					<div ref={list} className="lpop-list inside-list" role="listbox" id={`${id}-list`} aria-label="Inside">
						{rows.map((r, i) => {
							const o = r.option;
							const row = {
								id: `${id}-o-${i}`,
								role: 'option',
								'aria-selected': r.value === value,
								'data-inside-pick': o ? o.path : '__new',
								onMouseDown: (e: MouseEvent) => e.preventDefault(),
								onMouseEnter: () => setActive(i),
								onClick: () => pick(r.value),
							};
							const on = i === active ? ' is-active' : '';
							if (!o) {
								return (
									<div key="__new" className="inside-new">
										{rows.length === 1 ? <div className="sw-more">Nothing called “{query.trim()}”.</div> : null}
										<div {...row} className={`drow${on}`}>
											<Icon name="plus" />
											<span className="nm">New group…</span>
										</div>
									</div>
								);
							}
							return (
								<div key={o.path} {...row} className={`drow t${on}${r.value === value ? ' is-on' : ''}`} style={{ ['--depth' as string]: words.length ? 0 : o.depth }}>
									<Icon name={o.page ? 'page' : 'folder'} />
									<span className="nm">{words.length ? crumbs(o) : o.name}</span>
									<span className="meta">
										<span className="mono">{o.base}</span>
									</span>
								</div>
							);
						})}
					</div>
				</div>
			) : null}
		</div>
	);
}
