/**
 * The date field (pre-M7 polish, in place of the browser's own date input): a box you
 * can type a day into ("2 May 2026", 2/5/2026, 2026-05-02; fields/date.ts reads them),
 * and a button that opens the mockup's calendar (`.cal`, its dateField and calHTML) in
 * a popover under it. The calendar is react-day-picker, so its grid has the keyboard
 * (arrows, Page Up/Down for months, Home/End) and the screen-reader labels of a real
 * date grid; it's drawn with the editor's own classes and tokens. Weeks start on
 * Monday; Today is today in the site's time zone.
 *
 * The value is still a day, `YYYY-MM-DD`, or null (fields.ts → parseDay). A typed day
 * is kept on Enter or when the box loses focus; one that can't be read stays in the
 * box with a warning, and Esc puts the stored day back. An empty box clears it, as
 * the calendar's Clear does. Esc in the open calendar closes it and goes back to its
 * button, without leaving the level (App.tsx skips an Esc that's been handled).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DayPicker, type ChevronProps } from 'react-day-picker';
import type { DateField as DateDescriptor } from '../../../fields.ts';
import { parseDay } from '../../../fields.ts';
import { useEditor } from '../context.tsx';
import { Icon } from '../shell/Icons.tsx';
import { dateToDay, dayToDate, formatDay, readTypedDay, todayIn } from './date.ts';
import { FieldFrame } from './FieldFrame.tsx';
import { useFieldWarnings, useHost } from './host.tsx';
import { FieldIcon, Warn, Warnings } from './parts.tsx';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const CLASSES = {
	root: 'cal-rdp',
	months: 'cal-ms',
	month: 'cal-m',
	month_caption: 'cal-cap',
	caption_label: 'cal-cap-l',
	button_previous: 'ib cal-nav',
	button_next: 'ib cal-nav',
	chevron: 'i i-sm',
	month_grid: 'cal-g',
	weekdays: 'cal-wds',
	weekday: 'wd',
	weeks: 'cal-ws',
	week: 'cal-w',
	day: 'cal-d',
	day_button: 'cal-db',
	selected: 'is-sel',
	today: 'is-today',
	outside: 'out',
	disabled: 'is-off',
	hidden: 'is-hidden',
	focused: 'is-focused',
};

function Chevron({ orientation }: ChevronProps) {
	return <Icon name={orientation === 'left' ? 'chev-l' : 'chev-r'} size="sm" />;
}

export function DateField(props: { name: string; label: string; field: DateDescriptor; value: unknown }) {
	const editor = useEditor();
	const host = useHost();
	const id = `f-${host.scope}-${props.name}`;
	const value = parseDay(props.value);
	const warnings = useFieldWarnings(props.name, props.field, props.value);
	// What's typed, until it's kept (Enter, blur) or put back (Esc); null shows the stored day.
	const [draft, setDraft] = useState<string | null>(null);
	const [unread, setUnread] = useState(false);
	const [open, setOpen] = useState(false);
	const [month, setMonth] = useState<Date>(() => new Date());
	const wrap = useRef<HTMLDivElement>(null);
	const box = useRef<HTMLInputElement>(null);
	const today = todayIn(editor.timeZone());

	const set = (day: string | null) => {
		setDraft(null);
		setUnread(false);
		if (day !== value) host.set(props.name, day);
	};
	const keep = () => {
		if (draft === null) return;
		const day = readTypedDay(draft);
		if (day === undefined) setUnread(true);
		else set(day);
	};
	const show = () => {
		if (host.readOnly) return;
		setMonth(dayToDate(readTypedDay(draft ?? '') ?? value ?? today) ?? new Date());
		setOpen(true);
	};
	const close = (refocus: boolean) => {
		setOpen(false);
		if (refocus) box.current?.focus();
	};
	const pick = (day: string | null) => {
		set(day);
		close(true);
	};

	// A press outside the field closes the calendar (as the editor's other popovers).
	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			if (!wrap.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener('pointerdown', onDown, true);
		wrap.current?.querySelector('.cal')?.scrollIntoView({ block: 'nearest' });
		return () => document.removeEventListener('pointerdown', onDown, true);
	}, [open]);

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		if (open) {
			event.preventDefault();
			close(true);
		} else if (draft !== null) {
			event.preventDefault();
			setDraft(null);
			setUnread(false);
		}
	};

	return (
		<FieldFrame blockKey={host.scope} name={props.name} label={props.label} help={props.field.help} htmlFor={id}>
			<div
				className="datef"
				ref={wrap}
				onKeyDown={onKeyDown}
				onBlur={(event) => {
					if (open && !wrap.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
				}}
			>
				<div className="lnk-box">
					<FieldIcon name="calendar" />
					<input
						ref={box}
						id={id}
						data-path={props.name}
						value={draft ?? formatDay(value)}
						placeholder="Pick or type a day"
						autoComplete="off"
						aria-invalid={unread || undefined}
						aria-describedby={unread ? `${id}-unread` : undefined}
						onChange={(e) => {
							setDraft(e.target.value);
							setUnread(false);
						}}
						onBlur={keep}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								keep();
							} else if (e.key === 'ArrowDown' && e.altKey) {
								e.preventDefault();
								show();
							}
						}}
					/>
					<button
						type="button"
						className="ib"
						aria-label={`Pick a day for ${props.label}`}
						aria-haspopup="dialog"
						aria-expanded={open}
						onClick={() => (open ? close(false) : show())}
					>
						<Icon name="chev-d" size="sm" />
					</button>
				</div>
				{open ? (
					<div className="cal" role="dialog" aria-label={`Pick a day for ${props.label}`}>
						<DayPicker
							mode="single"
							required
							selected={dayToDate(value)}
							onSelect={(date: Date) => pick(dateToDay(date))}
							month={month}
							onMonthChange={setMonth}
							today={dayToDate(today)}
							weekStartsOn={1}
							showOutsideDays
							navLayout="around"
							autoFocus
							classNames={CLASSES}
							components={{ Chevron }}
							formatters={{ formatWeekdayName: (date: Date) => WEEKDAYS[date.getDay()]! }}
						/>
						<div className="cal-f">
							<button type="button" className="linkbtn subtle" onClick={() => pick(null)}>
								Clear
							</button>
							<button type="button" className="btn sm" onClick={() => pick(today)}>
								Today
							</button>
						</div>
					</div>
				) : null}
			</div>
			{unread ? <Warn id={`${id}-unread`}>Not a day this can read. Try 2 May 2026, or pick one.</Warn> : null}
			<Warnings warnings={warnings} />
		</FieldFrame>
	);
}
