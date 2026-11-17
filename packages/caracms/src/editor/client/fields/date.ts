/**
 * The date field's words (pre-M7 polish: the calendar in place of the browser's own
 * date input). The stored value is still a day, `YYYY-MM-DD`, or null (fields.ts →
 * parseDay); these turn it into what the box shows ("2 May 2026", the mockup's
 * fmtDate) and read back what someone types.
 *
 * Typed days are read day first (the editor's people write 2/5/2026 for 2 May):
 * `2026-05-02`, `2/5/2026`, `2.5.2026`, `2-5-2026`, `2 May 2026`, `May 2, 2026`, a
 * month's first three letters, and a two-digit year as 20xx.
 */
import { parseDay } from '../../../fields.ts';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n: number) => String(n).padStart(2, '0');

/** "2 May 2026" for `2026-05-02`; '' for anything that isn't a day. */
export function formatDay(value: unknown): string {
	const day = parseDay(value);
	if (!day) return '';
	const [y, m, d] = day.split('-').map(Number) as [number, number, number];
	return `${d} ${MONTHS[m - 1]} ${y}`;
}

const monthOf = (word: string) => {
	const w = word.toLowerCase();
	if (w.length < 3) return 0;
	return MONTHS.findIndex((m) => m.toLowerCase().startsWith(w)) + 1;
};

const year = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));

const day = (y: number, m: number, d: number) => parseDay(`${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`);

/**
 * What someone typed, read as a day: the day (`YYYY-MM-DD`), null for an empty box
 * (clears the field), or undefined when it can't be read as a real day.
 */
export function readTypedDay(text: string): string | null | undefined {
	const t = text.trim().replace(/\s+/g, ' ');
	if (t === '') return null;
	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
	if (m) return day(Number(m[1]), Number(m[2]), Number(m[3])) ?? undefined;
	m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(t);
	if (m) return day(year(m[3]!), Number(m[2]), Number(m[1])) ?? undefined;
	m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?,? (\d{4}|\d{2})$/i.exec(t);
	if (m && monthOf(m[2]!)) return day(year(m[3]!), monthOf(m[2]!), Number(m[1])) ?? undefined;
	m = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}|\d{2})$/i.exec(t);
	if (m && monthOf(m[1]!)) return day(year(m[3]!), monthOf(m[1]!), Number(m[2])) ?? undefined;
	return undefined;
}

/** A stored day as a local Date at midnight (the calendar's), or undefined. */
export function dayToDate(value: unknown): Date | undefined {
	const d = parseDay(value);
	if (!d) return undefined;
	const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
	const at = new Date(y, m - 1, dd);
	at.setFullYear(y); // years before 100 aren't 19xx
	return at;
}

/** A calendar's Date (local) as a stored day. */
export const dateToDay = (date: Date) => `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Today, as a day, in a time zone (the site's): `en-CA` writes YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
	} catch {
		return dateToDay(now);
	}
}
