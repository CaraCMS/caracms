/**
 * The inbox's routes (M6 Decision 9; Contracts → Routes), one handler behind
 * `/_caracms/submissions/[...path]` (routes/submissions.ts):
 *
 * | Route | Does |
 * |---|---|
 * | `GET /_caracms/submissions[?before=<id>]` | `{ items: SubmissionRow[], older, unread }`, newest first, 50 a page |
 * | `GET /_caracms/submissions/<id>` | `{ submission, form: { label, fields } \| null, titles, unread }`. Changes nothing |
 * | `POST …/<id>/read` · `/unread` · `/delete` | 204, the unread count in `X-Caracms-Unread`. `delete` needs `{ "confirm": true }` |
 * | `POST …/<id>/not-spam` | "Not spam, send it": `{ submission, row }` as they are now. 404 when the store has no spam check (only the cloud's flags spam) |
 * | `GET …/<id>/files/<n>` | The file, always as an attachment |
 *
 * - **A session in live mode** (the guard's prefix rule, checked again here), and for a
 *   POST the same origin. **No lock**: there are no roles, and nothing here is content.
 * - **Every reply is `Cache-Control: private, no-store`** and `X-Robots-Tag: noindex, nofollow`.
 * - **Ids and file numbers are checked before the store is asked**: an id that isn't one
 *   the store mints, or an `n` that isn't 1–999, is a 404 with no read. The stored key is
 *   checked again by the store (`isFileKey`), so a tampered JSON can't reach another file.
 * - **A download's type comes from the stored key's extension**, never the visitor's
 *   declared type; `Content-Disposition: attachment` with the name escaped (`filename*`
 *   in UTF-8), `nosniff`.
 * - **The production server without its bucket**: 503 `{ error, code: 'submissions-unset', missing }`.
 * - **Delete removes the files, then the JSON** (store.ts), so a failure part-way leaves it listed.
 */
import type { ResolvedSite } from '../config.ts';
import { checkOrigin, WriteRefused } from '../editor/server/write.ts';
import { FILE_TYPES, isSubmissionId, senderName, shownFileName, submissionSnippet, type ResolvedFormField, type SourceTitles } from './rules.ts';
import { formReader, readSourceTitles } from './sources.ts';
import { fileExtension, readSubmissionsConfig, submissionStore, type EmailOutcome, type StoredSubmission, type SubmissionStore } from './store.ts';
import { readCappedText } from '../body.ts';
import { readFormSettings } from './email.ts';
import { formWithWords, storedWordsOf } from './words.ts';

type Env = Record<string, string | undefined>;

export const SUBMISSIONS_PREFIX = '/_caracms/submissions';
/** The unread count on a 204 (read, unread, delete): Decision 9's "with every submissions response". */
export const UNREAD_HEADER = 'X-Caracms-Unread';

/** One row of the inbox's list. */
export interface SubmissionRow {
	id: string;
	form: string;
	/** The form's label, or its id when the form is no longer in the config. */
	formLabel: string;
	/** `senderName`: the name fields, else the address. */
	name: string;
	/** The visitor's address as sent. */
	email: string;
	/** The first textarea's text, one line. */
	snippet: string;
	receivedAt: string;
	readAt: string | null;
	/** How many files came with it. */
	files: number;
	/** The email's outcome (`held`: the cloud's, behind the site's daily limit), or null when it's unknown (the server died between storing and recording). */
	emailStatus: EmailOutcome['status'] | null;
	/** True when the cloud didn't keep its attachments (`StoredSubmission.filesNote`); absent otherwise. */
	filesNotKept?: true;
	/** The cloud's spam check marked it as possibly spam (`StoredSubmission.spam`): its email is held until someone says it isn't. */
	spam: boolean;
}

/** `POST …/<id>/not-spam`'s answer: the submission with its flag gone, and its row. */
export interface NotSpamResponse {
	submission: StoredSubmission;
	row: SubmissionRow;
}

export interface SubmissionsListResponse {
	items: SubmissionRow[];
	/** The cursor for "Older" (`?before=`), or null on the last page. */
	older: string | null;
	unread: number;
}

export interface SubmissionResponse {
	submission: StoredSubmission;
	/** The form as the config has it now, or null when it's gone (show the stored fields by name). */
	form: { label: string; fields: ResolvedFormField[] } | null;
	/**
	 * Form rows Decision 5: the titles of the submission's stored sourced values, by collection then
	 * path, looked up in the deployed files when it's opened. A value with none shows as stored.
	 */
	titles: SourceTitles;
	unread: number;
}

export interface SubmissionsUnset {
	error: string;
	code: 'submissions-unset';
	missing: string[];
}

export interface InboxContext {
	/** `collections` and `blocks` look up a sourced value's title (form rows Decision 5); without them, values show as stored. */
	site: Pick<ResolvedSite, 'root' | 'forms'> & Partial<Pick<ResolvedSite, 'collections' | 'blocks'>>;
	mode: 'local' | 'live';
	/** The signed-in person's address (live mode), or null. */
	person: string | null;
	env?: Env;
	log?: (line: string) => void;
	/** Tests: the store itself. */
	store?: SubmissionStore;
	fetch?: typeof fetch;
	/** Tests: Site Settings' `formWords` (default: read from the site's file, as the email reads it). */
	readWords?: () => Promise<unknown>;
}

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
const notFound = () => json(404, { error: "There's no such submission." });

export function rowOf(site: Pick<ResolvedSite, 'forms'>, s: StoredSubmission): SubmissionRow {
	const form = Object.hasOwn(site.forms, s.form) ? site.forms[s.form]! : null;
	const fields = s.fields ?? {};
	return {
		id: s.id,
		form: s.form,
		formLabel: form?.label ?? s.form,
		name: senderName(form, fields),
		email: typeof fields.email === 'string' ? fields.email : '',
		snippet: submissionSnippet(form, fields),
		receivedAt: s.receivedAt,
		readAt: s.readAt ?? null,
		files: s.files?.length ?? 0,
		emailStatus: s.email?.status ?? null,
		...(s.filesNote ? { filesNotKept: true as const } : {}),
		spam: Boolean(s.spam),
	};
}

/** The store for the environment, or the 503 to answer with. */
export function inboxStore(ctx: Pick<InboxContext, 'site' | 'env' | 'store' | 'fetch'>): SubmissionStore | SubmissionsUnset {
	if (ctx.store) return ctx.store;
	const chosen = submissionStore(readSubmissionsConfig(ctx.site.root, ctx.env ?? process.env), ctx.fetch);
	return 'kind' in chosen ? { error: chosen.message, code: 'submissions-unset', missing: chosen.missing } : chosen;
}

/** `Content-Disposition` for a visitor's file name: an ASCII fallback, and `filename*` in UTF-8 when it isn't plain ASCII. */
export function attachmentHeader(name: string): string {
	const base = shownFileName(name) || 'file';
	const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const plain = ascii === base;
	return plain ? `attachment; filename="${ascii}"` : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** A download's type, from the stored key's extension. */
export const downloadType = (key: string): string => FILE_TYPES[fileExtension(key)]?.[0] ?? 'application/octet-stream';

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	// caracms-cloud adversarial review, finding 10: 4 KB counted as it's read, never the whole body first.
	const text = await readCappedText(request, 4096).catch(() => '');
	if (text === null) return {};
	try {
		const value = JSON.parse(text || '{}') as unknown;
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Answer one request under `/_caracms/submissions`. */
export async function handleSubmissions(request: Request, ctx: InboxContext): Promise<Response> {
	const log = ctx.log ?? ((line: string) => console.error(line));
	const url = new URL(request.url);
	const method = request.method.toUpperCase();
	if (url.pathname !== SUBMISSIONS_PREFIX && !url.pathname.startsWith(`${SUBMISSIONS_PREFIX}/`)) return notFound();
	const parts = url.pathname.slice(SUBMISSIONS_PREFIX.length).split('/').filter(Boolean);
	const only = (allowed: string) => (method === allowed ? null : json(405, { error: `This route takes ${allowed}.` }, { Allow: allowed }));
	try {
		// Defence in depth: the guard did both in live mode.
		if (ctx.mode === 'live' && !ctx.person) return json(401, { error: 'signed-out', code: 'signed-out' });
		if (method !== 'GET' && method !== 'HEAD') checkOrigin(request);

		const [id, action, n, extra] = parts;
		// Checked before the store is asked: an id it never minted, or a route that isn't one, is a 404.
		if (id !== undefined && !isSubmissionId(id)) return notFound();
		const shapeOk =
			id === undefined || action === undefined || ((action === 'read' || action === 'unread' || action === 'delete' || action === 'not-spam') && n === undefined) || (action === 'files' && n !== undefined && /^[1-9]\d{0,2}$/.test(n) && extra === undefined);
		if (!shapeOk) return notFound();

		const store = inboxStore(ctx);
		if ('code' in store) return json(503, store);

		if (id === undefined) {
			const refused = only('GET');
			if (refused) return refused;
			const before = url.searchParams.get('before');
			if (before !== null && !isSubmissionId(before)) return json(400, { error: '`before` must be a submission id.' });
			const page = await store.list(before ? { before } : {});
			return json(200, { items: page.items.map((s) => rowOf(ctx.site, s)), older: page.older, unread: await store.unreadCount() } satisfies SubmissionsListResponse);
		}

		if (action === undefined) {
			const refused = only('GET');
			if (refused) return refused;
			const submission = await store.get(id);
			if (!submission) return notFound();
			const config = Object.hasOwn(ctx.site.forms, submission.form) ? ctx.site.forms[submission.form]! : null;
			// Review gaps (Decision 11): its fields named as Site Settings names them now, as the page and the email do.
			const form = config ? formWithWords(config, storedWordsOf(await (ctx.readWords ?? (() => readFormSettings(ctx.site.root).then((s) => s.words)))().catch(() => undefined), config.id)) : null;
			// Form rows Decision 5: sourced values by their documents' titles, from the deployed files on disk (not drafts).
			const { collections, blocks } = ctx.site;
			const titles = form && collections && blocks ? await readSourceTitles(formReader({ root: ctx.site.root, collections, blocks }), form, submission.fields ?? {}).catch(() => ({})) : {};
			return json(200, { submission, form: form ? { label: form.label, fields: form.fields } : null, titles, unread: await store.unreadCount() } satisfies SubmissionResponse);
		}

		if (action === 'files') {
			const refused = only('GET');
			if (refused) return refused;
			const found = await store.getFile(id, Number(n));
			if (!found) return notFound();
			return new Response(found.body as BodyInit, {
				status: 200,
				headers: {
					...HEADERS,
					'Content-Type': downloadType(found.file.key),
					'Content-Disposition': attachmentHeader(found.file.name || found.file.key),
					'Content-Length': String(found.body.byteLength),
					'X-Content-Type-Options': 'nosniff',
					'Content-Security-Policy': "default-src 'none'; sandbox",
				},
			});
		}

		const refused = only('POST');
		if (refused) return refused;
		if (action === 'not-spam') {
			// Only the cloud's store flags spam: without the action, it's as if there were no such submission.
			const submission = store.notSpam ? await store.notSpam(id) : null;
			if (!submission) return notFound();
			return json(200, { submission, row: rowOf(ctx.site, submission) } satisfies NotSpamResponse);
		}
		if (action === 'delete') {
			const body = await readJsonBody(request);
			if (body.confirm !== true) return json(400, { error: 'Deleting a submission is permanent: send { "confirm": true }.' });
			if (!(await store.delete(id))) return notFound();
		} else {
			const updated = await store.update(id, { readAt: action === 'read' ? new Date().toISOString() : null });
			if (!updated) return notFound();
		}
		return new Response(null, { status: 204, headers: { ...HEADERS, [UNREAD_HEADER]: String(await store.unreadCount()) } });
	} catch (error) {
		if (error instanceof WriteRefused) return json(error.status, { error: error.message, ...error.body });
		log(`[caracms] ${url.pathname} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		return json(502, { error: "The submissions couldn't be read just now. Try again in a moment." });
	}
}

/** The inbox's state for /admin's first paint and the documents list (Decision 9): the unread count, or why there's none. */
export type SubmissionsSetup = { unread: number } | { unread: null; error: string; code: 'submissions-unset' | 'submissions-unreadable'; missing: string[] };

export async function submissionsSetup(ctx: Pick<InboxContext, 'site' | 'env' | 'store' | 'fetch' | 'log'>): Promise<SubmissionsSetup> {
	const store = inboxStore(ctx);
	if ('code' in store) return { unread: null, error: store.error, code: store.code, missing: store.missing };
	try {
		return { unread: await store.unreadCount() };
	} catch (error) {
		(ctx.log ?? ((line: string) => console.error(line)))(`[caracms] couldn't count the unread submissions: ${error instanceof Error ? error.message : String(error)}`);
		return { unread: null, error: "The submissions couldn't be read just now.", code: 'submissions-unreadable', missing: [] };
	}
}

/** How long the editor's own pages wait for the unread count before going on without it. */
const SETUP_WAIT_MS = 1500;
/** How long a count that failed or timed out is not asked for again by those pages. */
const SETUP_RETRY_MS = 30_000;
/** Per store: when the last count failed or timed out (the editor pages' memory of it). */
const setupFailures = new WeakMap<SubmissionStore, number>();

/**
 * `submissionsSetup` for the editor's own pages (/admin's first paint, the documents list):
 * the count is raced against ~1.5 s, so a bucket that is slow or down can't stall the editor.
 * On a timeout or an error the answer is the `submissions-unreadable` shape, and for ~30 s
 * after, that is answered at once without asking again. A count that was still running when
 * the wait ended keeps going, and clears the memory if it lands. The inbox's own routes
 * don't use this.
 */
export async function submissionsSetupQuick(
	ctx: Pick<InboxContext, 'site' | 'env' | 'store' | 'fetch' | 'log'>,
	timing: { waitMs?: number; retryMs?: number; now?: () => number } = {},
): Promise<SubmissionsSetup> {
	const store = inboxStore(ctx);
	if ('code' in store) return { unread: null, error: store.error, code: store.code, missing: store.missing };
	const { waitMs = SETUP_WAIT_MS, retryMs = SETUP_RETRY_MS, now = Date.now } = timing;
	const unreadable: SubmissionsSetup = { unread: null, error: "The submissions couldn't be read just now.", code: 'submissions-unreadable', missing: [] };
	const failedAt = setupFailures.get(store);
	if (failedAt !== undefined && now() - failedAt < retryMs) return unreadable;

	const counting = submissionsSetup({ ...ctx, store });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), waitMs);
	});
	const result = await Promise.race([counting, timedOut]);
	clearTimeout(timer);
	if (result === 'timeout') {
		setupFailures.set(store, now());
		(ctx.log ?? ((line: string) => console.error(line)))(`[caracms] counting the unread submissions took over ${waitMs} ms; going on without it.`);
		void counting.then((late) => {
			if (late.unread !== null) setupFailures.delete(store);
		});
		return unreadable;
	}
	if (result.unread === null) setupFailures.set(store, now());
	else setupFailures.delete(store);
	return result;
}
