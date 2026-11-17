/**
 * People and times as live mode shows them (M4 Decision 16; M2 Decision 18).
 *
 * - **Times are absolute, in the site's time zone** (`StatusResponse.timeZone`):
 *   "14:20", "Today 14:20", "12 Oct, 09:30" (another year adds it). "Today" is the
 *   server's day (`status.now`), so the server's render and the browser's agree.
 *   History names the zone once (`zoneLine`).
 * - **People**: a name is the person's own, else the part of the address before `@`
 *   (live/messages.ts → displayName); the avatar's colour comes from the address, so
 *   a person is the same colour everywhere.
 */
import { displayName } from '../../../live/messages.ts';
import type { Person } from '../../types.ts';

export { displayName };

const safeZone = (timeZone: string) => {
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone });
		return timeZone;
	} catch {
		return 'UTC';
	}
};

function parts(iso: string, timeZone: string) {
	const f = new Intl.DateTimeFormat('en-GB', { timeZone: safeZone(timeZone), year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
	const out: Record<string, string> = {};
	for (const p of f.formatToParts(new Date(iso))) out[p.type] = p.value;
	return out as { year: string; month: string; day: string; hour: string; minute: string };
}

/** "14:20" in the site's zone. */
export function clock(iso: string, timeZone: string): string {
	const p = parts(iso, timeZone);
	return `${p.hour}:${p.minute}`;
}

/** "Today 14:20", "12 Oct, 09:30", "12 Oct 2025, 09:30": absolute, in the site's zone. */
export function when(iso: string, timeZone: string, now: string): string {
	const p = parts(iso, timeZone);
	const n = parts(now, timeZone);
	if (p.year === n.year && p.month === n.month && p.day === n.day) return `Today ${p.hour}:${p.minute}`;
	return `${p.day} ${p.month}${p.year === n.year ? '' : ` ${p.year}`}, ${p.hour}:${p.minute}`;
}

/** History's one line naming the zone: "Times are Ireland Time (Europe/Dublin)." */
export function zoneLine(timeZone: string): string {
	const zone = safeZone(timeZone);
	if (zone === 'UTC') return 'Times are UTC.';
	try {
		const name = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
		if (name && name !== zone) return `Times are ${name} (${zone}).`;
	} catch {
		/* below */
	}
	return `Times are in ${zone}.`;
}

/** "Home", "Home and About", "Home, About and Contact". */
export function joinNames(names: readonly string[]): string {
	if (names.length < 2) return names.join('');
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const COLOURS = ['var(--p-niamh)', 'var(--p-aoife)', 'var(--p-ciaran)'];

/** A person's avatar colour (one of the mockup's three), the same for them everywhere. */
export function colourOf(person: Person): string {
	let h = 0;
	for (const c of person.email.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return COLOURS[h % COLOURS.length]!;
}

export const initialOf = (person: Person) => (displayName(person).trim()[0] ?? '?').toUpperCase();

export const samePerson = (a: Person | null | undefined, b: Person | null | undefined) => !!a && !!b && a.email.toLowerCase() === b.email.toLowerCase();
