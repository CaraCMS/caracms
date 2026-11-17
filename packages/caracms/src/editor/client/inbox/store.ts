/**
 * The inbox's data in the browser (M6 Decision 9; forms/inbox.ts has the routes): the
 * list (newest first, 50 at a time, Older by cursor), the submission open on its sheet,
 * and the actions. `inboxFor(editor)`, one per editor:
 *
 *   inbox.list          { rows, older, loading, olderLoading, error }: last known while it's read again
 *   inbox.open          the open submission's GET answer (or its error), by id
 *   inbox.load()        the first page (on opening the level, and on intent: hovering its row)
 *   inbox.loadOlder()   the next 50 (`?before=`)
 *   inbox.show(id)      read it, and mark it read with an explicit POST …/read (Decision 9:
 *                       the GET never does), when it's unread
 *   inbox.notSpam(id)   POST …/not-spam ("Not spam, send it"): the sheet and the row from its
 *                       answer; an email absent from it is on its way (`OpenSubmission.sending`)
 *   inbox.markUnread(id) / inbox.remove(id)   POST …/unread and …/delete (`{ "confirm": true }`)
 *                       A delete counts as done only on the route's own 204, or its JSON 404
 *                       (already deleted): anything else, a proxy's 404 included, leaves the
 *                       row listed and says so (Acceptance 27). One delete per id at a time.
 *
 * **The unread count** (`editor.submissions`) is set from every answer: a list's and a
 * GET's `unread`, a 204's `X-Caracms-Unread`. A 503 (`submissions-unset`: the production
 * server has no bucket) sets the `submissions-off` state.
 */
import { formatBytes } from '../../../forms/rules.ts';
import { ENDPOINTS, UNREAD_HEADER, type NotSpamResponse, type SignedOutError, type SubmissionResponse, type SubmissionRow, type SubmissionsListResponse, type SubmissionsUnset } from '../../types.ts';
import type { Editor } from '../editor.ts';
import { createStore, type Store } from '../state/store.ts';
import { zoneName } from '../../zone-name.ts';

export { zoneName };

export interface InboxList {
	/** Null until the first page has been read. */
	rows: SubmissionRow[] | null;
	/** The cursor for Older, or null when there's nothing older. */
	older: string | null;
	loading: boolean;
	olderLoading: boolean;
	error: string | null;
}

export interface OpenSubmission {
	id: string;
	answer: SubmissionResponse | null;
	error: string | null;
	/** Said not spam here, and its answer had no email yet: the cloud is sending it (the sheet says so, not "unknown"). */
	sending?: true;
}

export interface Inbox {
	list: Store<InboxList>;
	open: Store<OpenSubmission | null>;
	load(): Promise<void>;
	loadOlder(): Promise<void>;
	show(id: string): Promise<void>;
	markUnread(id: string): Promise<{ ok: boolean; error?: string }>;
	notSpam(id: string): Promise<{ ok: boolean; error?: string; submission?: NotSpamResponse['submission'] }>;
	remove(id: string): Promise<{ ok: boolean; error?: string }>;
}

const inboxes = new WeakMap<Editor, Inbox>();

const COULDNT = "The submissions couldn't be read just now. Try again in a moment.";
const NOT_REACHED = "The server didn't answer just now, so nothing was deleted. Try again in a moment.";

/** An answer from the inbox's own route (forms/inbox.ts: JSON, or a 204), not a proxy's page. */
/** The count on a 204 (`X-Caracms-Unread`), or null when it's absent. */
const unreadHeader = (response: Response): number | null => {
	const v = response.headers.get(UNREAD_HEADER);
	return v !== null && /^\d+$/.test(v) ? Number(v) : null;
};
const fromRoute = (response: Response) => response.status === 204 || (response.headers.get('content-type') ?? '').includes('application/json');

export function inboxFor(editor: Editor): Inbox {
	let inbox = inboxes.get(editor);
	if (!inbox) inboxes.set(editor, (inbox = createInbox(editor)));
	return inbox;
}

function createInbox(editor: Editor): Inbox {
	const first = editor.inboxFirst;
	const list = createStore<InboxList>({ rows: first?.list?.items ?? null, older: first?.list?.older ?? null, loading: false, olderLoading: false, error: null });
	const open = createStore<OpenSubmission | null>(first?.open ? { id: first.open.submission.id, answer: first.open, error: null } : null);
	const base = ENDPOINTS.submissions;
	const route = (id: string, action?: string) => `${base}/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;

	const setUnread = (n: unknown) => {
		if (typeof n === 'number' && Number.isInteger(n) && n >= 0) editor.submissions.set({ unread: n });
	};
	/** An answer that isn't the data: signed out (live mode), not set up (503), or a sentence to show. */
	async function trouble(response: Response): Promise<string> {
		const body = (await response.json().catch(() => null)) as (Partial<SubmissionsUnset> & { error?: string }) | null;
		if (response.status === 401 && editor.liveSession) editor.liveState.update({ signedOut: body as unknown as SignedOutError });
		if (response.status === 503 && body?.code === 'submissions-unset') {
			editor.submissions.set({ unread: null, error: body.error ?? '', code: 'submissions-unset', missing: body.missing ?? [] });
		}
		return body?.error ?? COULDNT;
	}
	const post = (url: string, body?: unknown) =>
		fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body ?? {}) });

	/** The latest first-page read wins. */
	let loads = 0;
	/** Said not spam in this editor: an email still absent from a later read is on its way, not unknown. */
	const released = new Set<string>();
	const sendingFor = (id: string, answer: SubmissionResponse) => (released.has(id) && !answer.submission.email ? { sending: true as const } : {});
	/** "Not spam" presses on their way, by id: a second press waits for the first. */
	const releasing = new Map<string, ReturnType<Inbox['notSpam']>>();
	/** Deletes on their way, by id. */
	const removing = new Map<string, Promise<{ ok: boolean; error?: string }>>();

	const inbox: Inbox = {
		list,
		open,

		async load() {
			const ticket = ++loads;
			list.update({ loading: true });
			try {
				const response = await fetch(base, { headers: { Accept: 'application/json' } });
				if (ticket !== loads) return;
				if (!response.ok) {
					list.update({ loading: false, error: await trouble(response) });
					return;
				}
				const body = (await response.json()) as SubmissionsListResponse;
				if (ticket !== loads) return;
				setUnread(body.unread);
				list.set({ rows: body.items, older: body.older, loading: false, olderLoading: false, error: null });
			} catch {
				if (ticket === loads) list.update({ loading: false, error: COULDNT });
			}
		},

		async loadOlder() {
			const { older, olderLoading } = list.get();
			if (!older || olderLoading) return;
			list.update({ olderLoading: true });
			try {
				const response = await fetch(`${base}?before=${encodeURIComponent(older)}`, { headers: { Accept: 'application/json' } });
				if (!response.ok) {
					list.update({ olderLoading: false, error: await trouble(response) });
					return;
				}
				const body = (await response.json()) as SubmissionsListResponse;
				setUnread(body.unread);
				list.set((l) => {
					const have = new Set((l.rows ?? []).map((r) => r.id));
					return { ...l, rows: [...(l.rows ?? []), ...body.items.filter((r) => !have.has(r.id))], older: body.older, olderLoading: false, error: null };
				});
			} catch {
				list.update({ olderLoading: false, error: COULDNT });
			}
		},

		async show(id) {
			const known = open.get();
			// The same one again keeps what's on the sheet while it's read again.
			open.set(known?.id === id ? { ...known, error: null } : { id, answer: null, error: null });
			let answer: SubmissionResponse;
			try {
				const response = await fetch(route(id), { headers: { Accept: 'application/json' } });
				if (!response.ok) {
					const error = response.status === 404 ? "There's no such submission. It may have been deleted." : await trouble(response);
					if (open.get()?.id === id) open.set({ id, answer: null, error });
					return;
				}
				answer = (await response.json()) as SubmissionResponse;
			} catch {
				if (open.get()?.id === id) open.set({ id, answer: null, error: COULDNT });
				return;
			}
			setUnread(answer.unread);
			if (open.get()?.id !== id) return;
			open.set({ id, answer, error: null, ...sendingFor(id, answer) });
			// Decision 9: opening it marks it read, an explicit write (the GET changed nothing).
			if (answer.submission.readAt === null) {
				const now = new Date().toISOString();
				const shown = { ...answer, submission: { ...answer.submission, readAt: now } };
				open.set({ id, answer: shown, error: null, ...sendingFor(id, shown) });
				patchRow(id, { readAt: now });
				try {
					const response = await post(route(id, 'read'));
					if (response.ok) setUnread(unreadHeader(response));
					else await trouble(response);
				} catch {
					/* it stays unread on the server; the next list says so */
				}
			}
		},

		async markUnread(id) {
			try {
				const response = await post(route(id, 'unread'));
				if (response.status !== 204) return { ok: false, error: await trouble(response) };
				setUnread(unreadHeader(response));
			} catch {
				return { ok: false, error: COULDNT };
			}
			patchRow(id, { readAt: null });
			if (open.get()?.id === id) open.set(null);
			return { ok: true };
		},

		notSpam(id) {
			const running = releasing.get(id);
			if (running) return running;
			const done = (async () => {
				let body: NotSpamResponse;
				try {
					const response = await post(route(id, 'not-spam'));
					if (!response.ok) {
						const error = response.status === 404 && fromRoute(response) ? "There's no such submission. It may have been deleted." : await trouble(response);
						return { ok: false, error };
					}
					body = (await response.json()) as NotSpamResponse;
				} catch {
					return { ok: false, error: "The server didn't answer just now, so the email wasn't sent. Try again in a moment." };
				}
				released.add(id);
				// The flag and the email from the answer; read or unread stays as this editor has it.
				patchRow(id, { spam: body.row.spam, emailStatus: body.row.emailStatus });
				const known = open.get();
				if (known?.id === id && known.answer) {
					const answer = { ...known.answer, submission: { ...body.submission, readAt: known.answer.submission.readAt } };
					open.set({ id, answer, error: null, ...sendingFor(id, answer) });
				}
				return { ok: true, submission: body.submission };
			})();
			releasing.set(id, done);
			void done.finally(() => releasing.delete(id));
			return done;
		},
		remove(id) {
			// One delete per submission at a time: a second press (a double click) waits for the first.
			const running = removing.get(id);
			if (running) return running;
			const done = (async (): Promise<{ ok: boolean; error?: string }> => {
				try {
					const response = await post(route(id, 'delete'), { confirm: true });
					// Gone only on the route's own answers: its 204, or its JSON 404 (deleted already, by
					// someone else). A 404 from anything in between (a proxy, the platform's edge while a
					// deploy switches) never reached the route: nothing was deleted (Acceptance 27).
					const gone = response.status === 204 || (response.status === 404 && fromRoute(response));
					if (!gone) return { ok: false, error: response.status === 404 ? NOT_REACHED : await trouble(response) };
					if (response.status === 204) setUnread(unreadHeader(response));
				} catch {
					return { ok: false, error: COULDNT };
				}
				list.set((l) => ({ ...l, rows: l.rows ? l.rows.filter((r) => r.id !== id) : l.rows }));
				if (open.get()?.id === id) open.set(null);
				// The list as the server has it now (last known stays meanwhile).
				void inbox.load();
				return { ok: true };
			})();
			removing.set(id, done);
			void done.finally(() => removing.delete(id));
			return done;
		},
	};

	function patchRow(id: string, patch: Partial<SubmissionRow>) {
		list.set((l) => (l.rows?.some((r) => r.id === id) ? { ...l, rows: l.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : l));
	}

	return inbox;
}

// ── How the inbox words things ───────────────────────────────────────────────

/** "1 file", "2 files". */
export const filesLabel = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** A file's size and kind: "1.4 MB · PDF". */
export function fileLine(size: number, ext: string): string {
	return `${formatBytes(size)} · ${EXT_NAME[ext] ?? ext}`;
}
const EXT_NAME: Record<string, string> = {
	PDF: 'PDF',
	JPG: 'JPEG image',
	PNG: 'PNG image',
	WEBP: 'WebP image',
	HEIC: 'HEIC image',
	HEIF: 'HEIF image',
	DOCX: 'Word document',
	DOC: 'Word document',
	XLSX: 'Excel spreadsheet',
	XLS: 'Excel spreadsheet',
};

const safeZone = (timeZone: string) => {
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone });
		return timeZone;
	} catch {
		return 'UTC';
	}
};
function dayParts(iso: string | Date, timeZone: string) {
	const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
	const out: Record<string, string> = {};
	for (const p of f.formatToParts(typeof iso === 'string' ? new Date(iso) : iso)) out[p.type] = p.value;
	return out as { year: string; month: string; day: string; weekday: string; hour: string; minute: string };
}
const dayKey = (p: { year: string; month: string; day: string }) => `${p.year}-${p.month}-${p.day}`;

/**
 * A row's time (the mockup's): "14:12" today, "Yesterday", "Tue 13 Oct", and another
 * year's "13 Oct 2025". In the site's zone.
 */
export function rowTime(iso: string, timeZone: string, now: Date = new Date()): string {
	const zone = safeZone(timeZone);
	const p = dayParts(iso, zone);
	const n = dayParts(now, zone);
	if (dayKey(p) === dayKey(n)) return `${p.hour}:${p.minute}`;
	const yesterday = dayParts(new Date(now.getTime() - 86_400_000), zone);
	if (dayKey(p) === dayKey(yesterday)) return 'Yesterday';
	return p.year === n.year ? `${p.weekday} ${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

/**
 * The sheet's full time: "Thursday 15 October 2026, 14:12 Ireland Time". `name` is the
 * zone's name as the server worded it (`editor.timeZoneName()`): the browser's own
 * wording can differ, which a hydrated sheet may not (zone-name.ts).
 */
export function fullTime(iso: string, timeZone: string, name: string = zoneName(timeZone)): string {
	const zone = safeZone(timeZone);
	const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
	const p: Record<string, string> = {};
	for (const part of f.formatToParts(new Date(iso))) p[part.type] = part.value;
	return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${name}`;
}

/** "14:12" (today) or "15 Oct, 14:12" for the email's line: when it went. */
export function shortTime(iso: string, timeZone: string, now: Date = new Date()): string {
	const zone = safeZone(timeZone);
	const p = dayParts(iso, zone);
	const n = dayParts(now, zone);
	return dayKey(p) === dayKey(n) ? `${p.hour}:${p.minute}` : `${p.day} ${p.month}${p.year === n.year ? '' : ` ${p.year}`}, ${p.hour}:${p.minute}`;
}

/** Reply by email (Decision 9): the visitor's address percent-encoded, so a crafted one can't add recipients or headers. */
export function replyHref(address: string, brandName: string): string {
	return `mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent(`Re: your enquiry to ${brandName}`)}`;
}
