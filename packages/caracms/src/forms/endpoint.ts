/**
 * `POST /_caracms/form`: every form's destination (M6 Decisions 5 and 6; the template's
 * `server/forms.mjs`, `forms.md` → The endpoint and Files: the wire contract).
 *
 * **Public.** The guard lets it through exactly (live/auth/guard.ts → `isLetThrough`)
 * and the unconfigured server's 503 exempts it (editor/middleware.ts), so it works in
 * local mode, live mode, and on a production server whose editor isn't set up. No
 * session, no same-origin check.
 *
 * In order, and **nothing is written until every check has passed**:
 *
 * 1. **The rate limit's peek** for a body that can be large (multipart on a site with a
 *    files field, or a declared length over 256 KB): an IP already at the limit gets the
 *    429 and the body is never read.
 * 2. **The body**, read up to its cap: 256 KB for any body without files; 25 MiB +
 *    256 KB for multipart only when some form has a files field (the config decides,
 *    not the client). A declared `Content-Length` over the cap is refused before a byte
 *    is read, and reading stops at the chunk that passes it: 413, which says which limit.
 * 3. **The return page** (`return`), accepted only as `^/[a-z0-9/-]*$` not starting
 *    `//`, else `/`. **A known form** (`form`), else 400: a bad id is a broken page.
 * 4. **The honeypot** (`fax`, rules.ts): filled → the success reply, nothing stored.
 * 5. **Each field**, in the form's order: required unless optional, an email's shape, a
 *    select's options (and a sourced select's documents, read from the content on disk now:
 *    form rows Decision 3; a form with one peeks at the rate limit first, so an address already
 *    at it gets the 429 before any disk read), a rows field's rows (form rows Decisions 6–8 and 17), the files
 *    (up to 5, the extension list, the declared type fits the extension). Every problem
 *    comes back in one 400.
 * 6. **The rate limit's hit** (rate-limit.ts): 5 per IP per 10 minutes, 429 past it.
 *    A hit is counted here, so a stored submission and a Turnstile refusal both count;
 *    a small body that fails 4 or 5 doesn't (a body over 256 KB does).
 * 7. **Turnstile**, when `TURNSTILE_SECRET_KEY` is set: no token or a refused one is a
 *    403; Cloudflare unreachable fails open, logged. Unset: accepted, with a warning.
 * 8. **Store** (store.ts), then **email** (email.ts), then **record** the email's outcome
 *    on the submission, then reply. A storage failure is a 502; an email failure never
 *    fails the visitor. **On CaraCMS Cloud** (caracms-cloud M4 Decision 24) the store
 *    takes the written email with the submission and the cloud sends and records it, so
 *    nothing is sent or recorded here; a cloud refusal is the same 502, its sentence logged.
 *
 * Replies: `Accept: application/json` gets `{ ok: true }` or `{ error }`; a no-JS post
 * gets a 303 to `<return>?sent=1`, or the error as plain text. Nothing about the visitor
 * (IP, user agent) is stored.
 */
import type { ResolvedSite } from '../config.ts';
import { publicOrigin } from '../live/auth/index.ts';
import { clientIp, NO_GATE_MESSAGE } from '../live/auth/request.ts';
import { readCapped } from '../editor/server/media/upload.ts';
import { isProductionBuild } from '../media.ts';
import { readFormSettings, sendNotification, writeNotification, type FormSettings } from './email.ts';
import { formLimiter, type FormRateLimiter } from './rate-limit.ts';
import {
	cleanReturn,
	FILE_KINDS,
	FILE_TYPES,
	formsAcceptFiles,
	HONEYPOT,
	isBlankRow,
	isRowNumber,
	looksLikeEmail,
	MAX_FILE_BYTES,
	MAX_FILES,
	narrowedChoices,
	rowCell,
	ROW_CELL,
	selectChoices,
	type FormFieldValue,
	type FormRow,
	type FormSources,
	type ResolvedForm,
	type ResolvedFormField,
	type SourceTitles,
} from './rules.ts';
import { formReader, readFormSources, sourcedSelects, titlesFromSources } from './sources.ts';
import { cleanFileName, fileExtension, readSubmissionsConfig, submissionStore, type NewFile, type SubmissionStore } from './store.ts';
import { shownFileName } from './rules.ts';
import { formWithWords, PACKAGE_WORDS, storedWordsOf } from './words.ts';

type Env = Record<string, string | undefined>;

export const FORM_ROUTE = '/_caracms/form';

/** The cap for every body without files, and for the fields of one with them. */
export const BODY_LIMIT = 256 * 1024;
/** The cap on a multipart body when the site takes files: the files' 25 MiB plus the fields' 256 KB. */
export const UPLOAD_BODY_LIMIT = BODY_LIMIT + MAX_FILE_BYTES;

export const TOO_LARGE_MESSAGE = `That's too much to send: attachments can come to ${MAX_FILE_BYTES / 1024 / 1024} MB in all. Send fewer or smaller files, or email them to us.`;
export const TOO_LONG_MESSAGE = "That's too much to send in one message. Shorten it, or email us.";
export const RATE_LIMITED_MESSAGE = "You've sent a few messages in a row. Please wait a few minutes and try again, or email us directly.";
export const TURNSTILE_MESSAGE = "We couldn't confirm you're a person. Please try again, or email us directly.";
export const STORE_FAILED_MESSAGE = 'Could not send your message.';
export const UNKNOWN_FORM_MESSAGE = "This form isn't on the site any more. Reload the page and try again.";
export const BAD_EMAIL_MESSAGE = "That email address doesn't look right.";

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 5_000;

export { cleanReturn };

export interface FormContext {
	/** `collections` and `blocks` read a sourced select's documents (form rows Decision 3); without them, a source offers nothing. */
	site: Pick<ResolvedSite, 'root' | 'forms' | 'timeZone'> & Partial<Pick<ResolvedSite, 'collections' | 'blocks'>>;
	/** The socket's address (Astro's `clientAddress`), read after `X-Real-IP` under `astro dev`. */
	clientAddress?: () => string | undefined;
	/** A production server: the IP comes from `caracms start`'s gate only (runs-anywhere Decision 8). Default: the build's define. */
	production?: boolean;
	env?: Env;
	/** Astro's `site` (the route passes `context.site`): the public origin for the email's editor link. */
	astroSite?: URL;
	/** Cloudflare's and Resend's `fetch`, and the bucket's (tests). */
	fetch?: typeof fetch;
	now?: () => Date;
	log?: (line: string) => void;
	limiter?: FormRateLimiter;
	/** Tests: the store, the settings reader. */
	store?: SubmissionStore;
	readSettings?: () => Promise<FormSettings>;
	/** Tests: what each sourced select offers (default: read from the content on disk, at each submission). */
	readSources?: (form: ResolvedForm) => Promise<FormSources>;
}

/** A body's values as one `get(name)`, plus its files by name (multipart read with files on), and a rows field's rows. */
interface FormBody {
	get(name: string): string;
	files(name: string): File[];
	/** Form rows (Contracts → The wire): a rows field's rows as posted, in index order, each its cells trimmed, blank ones included. */
	rows(name: string): FormRow[];
	/** The raw body's size. */
	bytes: number;
}

class BodyTooLarge extends Error {
	readonly upload: boolean;
	constructor(upload: boolean) {
		super('body over its cap');
		this.upload = upload;
	}
}

async function readFormBody(request: Request, takesFiles: boolean): Promise<FormBody> {
	const type = (request.headers.get('content-type') ?? '').toLowerCase();
	const multipart = type.includes('multipart/form-data');
	const upload = takesFiles && multipart;
	const read = await readCapped(request, upload ? UPLOAD_BODY_LIMIT : BODY_LIMIT);
	if (!read.ok) throw new BodyTooLarge(upload);
	const raw = read.bytes;
	const text = () => new TextDecoder().decode(raw);
	if (type.includes('application/x-www-form-urlencoded')) {
		const params = new URLSearchParams(text());
		return { get: (name) => (params.get(name) ?? '').trim(), files: () => [], rows: rowsOfPairs(params), bytes: raw.byteLength };
	}
	if (type.includes('application/json')) {
		const parsed = JSON.parse(text() || '{}') as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('a JSON body must be an object');
		const o = parsed as Record<string, unknown>;
		const get = (name: string) => jsonText(Object.hasOwn(o, name) ? o[name] : undefined);
		// Form rows (Contracts → The wire): `"<name>": [{ "<column>": "…" }]`; an item that isn't an object is a blank row.
		const rows = (name: string): FormRow[] => {
			const v = Object.hasOwn(o, name) ? o[name] : undefined;
			if (!Array.isArray(v)) return [];
			return v.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([k, cell]) => [k, jsonText(cell)])) : {}));
		};
		return { get, files: () => [], rows, bytes: raw.byteLength };
	}
	if (multipart) {
		// Node's own multipart parser, through the fetch API's FormData.
		const data = await new Response(raw as BodyInit, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
		let fileBytes = 0;
		for (const [, value] of data) if (typeof value !== 'string') fileBytes += value.size;
		if (upload && fileBytes > MAX_FILE_BYTES) throw new BodyTooLarge(true);
		if (upload && raw.byteLength - fileBytes > BODY_LIMIT) throw new BodyTooLarge(false);
		const get = (name: string) => {
			const v = data.get(name);
			return typeof v === 'string' ? v.trim() : '';
		};
		// A browser's empty file input (no name, no bytes) is no file. On a site that takes no files, no part is one.
		const files = (name: string) => (upload ? data.getAll(name).filter((v): v is File => typeof v !== 'string' && (v.name !== '' || v.size > 0)) : []);
		return { get, files, rows: rowsOfPairs(data), bytes: raw.byteLength };
	}
	throw new Error(`unsupported content type: ${type || '(none)'}`);
}

/**
 * The rows of a urlencoded or multipart body (Contracts → The wire): each `<name>[<index>][<column>]`
 * cell, index 0–9999, gathered by field, read in index order (gaps are fine). A cell posted twice
 * keeps its first value, as `get` does.
 */
function rowsOfPairs(pairs: Iterable<[string, unknown]>): (name: string) => FormRow[] {
	const byField = new Map<string, Map<number, FormRow>>();
	for (const [key, value] of pairs) {
		if (typeof value !== 'string') continue;
		const cell = ROW_CELL.exec(key);
		if (!cell) continue;
		const [, field, index, column] = cell;
		let rows = byField.get(field!);
		if (!rows) byField.set(field!, (rows = new Map()));
		let row = rows.get(Number(index));
		if (!row) rows.set(Number(index), (row = {}));
		if (!Object.hasOwn(row, column!)) row[column!] = value.trim();
	}
	return (name) => [...(byField.get(name) ?? new Map<number, FormRow>()).entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/** A JSON body's cell as text: a string trimmed, a number or a boolean as its text (as a top-level value is), anything else blank. */
const jsonText = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '');

/** The declared type, bare: lower case, no parameters. */
const bareType = (type: string) => type.split(';')[0]!.trim().toLowerCase();

/** The posted files of a files field: what to store, or the problems, each naming the file. */
export function checkFiles(posted: readonly File[]): { files: { name: string; type: string; blob: File }[]; problems: string[] } {
	if (posted.length > MAX_FILES) return { files: [], problems: [`Attach up to ${MAX_FILES} files (you chose ${posted.length}).`] };
	const files: { name: string; type: string; blob: File }[] = [];
	const problems: string[] = [];
	for (const file of posted) {
		const name = cleanFileName(file.name);
		const shown = shownFileName(name) || 'A file';
		const ext = fileExtension(name);
		const allowed = Object.hasOwn(FILE_TYPES, ext) ? FILE_TYPES[ext] : undefined;
		const type = bareType(file.type ?? '');
		if (!allowed) problems.push(`${shown}: we can't take that kind of file. Send ${FILE_KINDS} files.`);
		else if (type && type !== 'application/octet-stream' && !allowed.includes(type)) {
			problems.push(`${shown}: the file isn't what its name says (a .${ext} file). Save it again as a .${ext}, or send another.`);
		} else files.push({ name, type, blob: file });
	}
	return { files, problems };
}

/**
 * One rows field's posted rows against its columns (form rows Decisions 6–8 and 17): the rows to
 * store (blank ones dropped, each with every column, in column order), whether a required field
 * is missing, and each problem's sentence, a row named by the field's row word and its place among
 * the rows kept.
 */
export function vetRows(field: ResolvedFormField, posted: readonly FormRow[], sources: FormSources = {}): { rows: FormRow[]; missing: boolean; problems: string[] } {
	const columns = field.columns ?? [];
	const word = field.rowLabel || PACKAGE_WORDS.rowLabel;
	// Every cell read with rowCell (Object.hasOwn): a column may be called `constructor` (review fix 5).
	const text = (row: FormRow, name: string) => {
		const value = rowCell(row, name);
		return typeof value === 'string' ? value.trim() : '';
	};
	const kept = posted.filter((row) => !isBlankRow(field, row)).map((row) => Object.fromEntries(columns.map((c) => [c.name, text(row, c.name)])) as FormRow);
	const problems: string[] = [];
	const max = field.max ?? kept.length;
	if (kept.length > max) problems.push(`${field.label}: ${max} at most.`);
	const offered = (column: string) => (Object.hasOwn(sources, `${field.name}.${column}`) ? sources[`${field.name}.${column}`]! : []);
	kept.forEach((row, i) => {
		const at = `${word} ${i + 1}`;
		for (const c of columns) {
			const value = text(row, c.name);
			if (!value) {
				problems.push(`${at}: ${c.label} is missing.`);
				continue;
			}
			if (c.type === 'number' && !isRowNumber(value)) problems.push(`${at}: ${c.label} must be a number above 0, like 2 or 2.5.`);
			if (c.type !== 'select') continue;
			if (!selectChoices(c, offered(c.name)).some((o) => o.value === value)) {
				problems.push(`${at}: ${c.label}: choose one of the options.`);
				continue;
			}
			if (!c.from) continue;
			// Narrowed (Decision 6): only when the picked document is one offered; a wrong pick has its own sentence.
			const picked = offered(c.from.column).find((d) => d.value === text(row, c.from!.column));
			if (!picked) continue;
			const allowed = narrowedChoices(c, rowCell(picked.data, c.from.field));
			if (!allowed.includes(value)) {
				const labels = allowed.map((v) => c.options?.find((o) => o.value === v)?.label ?? v);
				problems.push(`${at}: ${c.label} for ${picked.label} is one of: ${labels.join(', ')}.`);
			}
		}
	});
	return { rows: kept, missing: kept.length === 0 && !field.optional, problems };
}

/**
 * One submission against its form: what to store, or the 400's sentence (every problem in it).
 * `sources` is what each sourced select offers now (form rows Decision 3); a source with nothing
 * in it refuses every value but a fixed option's.
 */
export function vetFields(
	form: ResolvedForm,
	body: Pick<FormBody, 'get' | 'files'> & Partial<Pick<FormBody, 'rows'>>,
	sources: FormSources = {},
): { error: string } | { fields: Record<string, FormFieldValue>; files: { name: string; type: string; blob: File }[] } {
	const fields: Record<string, FormFieldValue> = {};
	const missing: string[] = [];
	const problems: string[] = [];
	let files: { name: string; type: string; blob: File }[] = [];
	for (const field of form.fields) {
		if (field.type === 'files') {
			const posted = body.files(field.name);
			if (posted.length === 0 && !field.optional) missing.push(field.label);
			const checked = checkFiles(posted);
			problems.push(...checked.problems);
			files = checked.files;
			continue;
		}
		if (field.type === 'rows') {
			const vetted = vetRows(field, body.rows?.(field.name) ?? [], sources);
			fields[field.name] = vetted.rows;
			if (vetted.missing) missing.push(field.label);
			problems.push(...vetted.problems);
			continue;
		}
		const value = body.get(field.name);
		fields[field.name] = value;
		if (!value) {
			if (!field.optional) missing.push(field.label);
			continue;
		}
		if (field.type === 'email' && !looksLikeEmail(value)) problems.push(BAD_EMAIL_MESSAGE);
		if (field.type === 'select' && !selectChoices(field, Object.hasOwn(sources, field.name) ? sources[field.name] : []).some((o) => o.value === value)) problems.push(`${field.label}: choose one of the options.`);
	}
	const sentences = [...(missing.length ? [`Missing: ${missing.join(', ')}.`] : []), ...problems];
	return sentences.length ? { error: sentences.join(' ') } : { fields, files };
}

/** Cloudflare's check of the widget's token. Unreachable → true (fail open, logged). */
export async function verifyTurnstile(input: { token: string; secret: string; ip: string; fetch: typeof fetch; log: (line: string) => void }): Promise<boolean> {
	try {
		const res = await input.fetch(TURNSTILE_VERIFY_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ secret: input.secret, response: input.token, remoteip: input.ip }),
			signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
		});
		const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
		if (data.success !== true) input.log(`[caracms] forms: Turnstile refused a token (${(data['error-codes'] ?? []).join(', ') || 'no reason given'}).`);
		return data.success === true;
	} catch (error) {
		input.log(`[caracms] forms: couldn't reach Turnstile's check, so the submission was let through: ${error instanceof Error ? error.message : String(error)}`);
		return true;
	}
}

/** Answer one request to `/_caracms/form`. */
export async function handleForm(request: Request, ctx: FormContext): Promise<Response> {
	const env = ctx.env ?? process.env;
	const log = ctx.log ?? ((line: string) => console.error(line));
	const now = ctx.now ?? (() => new Date());
	const doFetch = ctx.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
	const limiter = ctx.limiter ?? formLimiter(env);
	const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
	let back = '/';

	const reply = (status: number, body: { ok: true } | { error: string }, extra: Record<string, string> = {}): Response => {
		const headers: Record<string, string> = { 'Cache-Control': 'private, no-store', ...extra };
		if (wantsJson) return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
		if (status < 400) return new Response(null, { status: 303, headers: { ...headers, Location: `${back}?sent=1` } });
		return new Response('error' in body ? body.error : 'Bad request.', { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
	};

	if (request.method !== 'POST') {
		await request.body?.cancel().catch(() => {});
		return reply(405, { error: 'This address takes a form post.' }, { Allow: 'POST' });
	}

	const ip = clientIp(request, ctx.clientAddress ?? (() => undefined), ctx.production ?? isProductionBuild());
	if (ip === null) {
		await request.body?.cancel().catch(() => {});
		return reply(503, { error: NO_GATE_MESSAGE });
	}
	const takesFiles = formsAcceptFiles(ctx.site.forms);
	const declared = Number(request.headers.get('content-length') ?? NaN);
	const multipart = (request.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data');
	const canBeLarge = (takesFiles && multipart) || (Number.isFinite(declared) && declared > BODY_LIMIT);
	if (canBeLarge && (await limiter.peek(ip))) {
		await request.body?.cancel().catch(() => {});
		return reply(429, { error: RATE_LIMITED_MESSAGE });
	}

	let body: FormBody;
	try {
		body = await readFormBody(request, takesFiles);
	} catch (error) {
		if (error instanceof BodyTooLarge) {
			log(`[caracms] forms: refused a body over its cap (${error.upload ? 'attachments' : 'fields'}).`);
			return reply(413, { error: error.upload ? TOO_LARGE_MESSAGE : TOO_LONG_MESSAGE });
		}
		log(`[caracms] forms: an unreadable body (${error instanceof Error ? error.message : String(error)}).`);
		return reply(400, { error: 'Expected form data.' });
	}
	back = cleanReturn(body.get('return'));
	// A large body that ends in a refusal or the honeypot still counts, so repeated large posts trip the limit.
	const large = body.bytes > BODY_LIMIT;
	const countIfLarge = async () => {
		if (large) await limiter.hit(ip);
	};

	const formId = body.get('form');
	const form = Object.hasOwn(ctx.site.forms, formId) ? ctx.site.forms[formId]! : null;
	if (!form) {
		await countIfLarge();
		log(`[caracms] forms: a post for an unknown form (${JSON.stringify(formId.slice(0, 64))}).`);
		return reply(400, { error: UNKNOWN_FORM_MESSAGE });
	}

	// The honeypot: answer as if it worked (telling a bot it failed teaches it to retry); nothing is stored, its files included.
	if (body.get(HONEYPOT)) {
		await countIfLarge();
		return reply(200, { ok: true });
	}

	// Review gaps (Decision 11): the form with Site Settings' words, so the 400's sentences, the stored labels' email and the inbox say
	// what the page says. Unreadable settings: the config's words (the email step reports the file).
	const readSettings = ctx.readSettings ?? (() => readFormSettings(ctx.site.root));
	const words = await readSettings().then((s) => s.words, () => undefined);
	const worded = formWithWords(form, storedWordsOf(words, form.id));
	// Form rows Decision 3: a sourced select's documents, read from the content on disk now (not the page's baked options).
	// An address already at the limit is answered before that read (review fix 7): it costs no disk read.
	const sourced = sourcedSelects(form).length > 0;
	if (sourced && (await limiter.peek(ip))) return reply(429, { error: RATE_LIMITED_MESSAGE });
	const sources = !sourced
		? {}
		: ctx.readSources
			? await ctx.readSources(form)
			: ctx.site.collections && ctx.site.blocks
				? await readFormSources(formReader({ root: ctx.site.root, collections: ctx.site.collections, blocks: ctx.site.blocks }), form, log)
				: {};
	const vetted = vetFields(worded, body, sources);
	if ('error' in vetted) {
		await countIfLarge();
		return reply(400, { error: vetted.error });
	}

	// Looked at here, counted once the submission is stored (below) or Turnstile refuses it: a try the server
	// failed to store (a 502) isn't the visitor's to pay for (Decision 5 counts a stored submission).
	// (A form with a sourced select was peeked at before its read, above.)
	if (!sourced && (await limiter.peek(ip))) return reply(429, { error: RATE_LIMITED_MESSAGE });

	const secret = env['TURNSTILE_SECRET_KEY']?.trim() ?? '';
	if (secret) {
		const token = body.get('cf-turnstile-response');
		if (!token || !(await verifyTurnstile({ token, secret, ip, fetch: doFetch, log }))) {
			await limiter.hit(ip);
			return reply(403, { error: TURNSTILE_MESSAGE });
		}
	} else {
		log('[caracms] forms: TURNSTILE_SECRET_KEY is not set, so this submission was accepted without a bot check.');
	}

	// STORE: what makes it received. The store writes the files, then the JSON, and removes what it wrote on a failure.
	let store: SubmissionStore;
	if (ctx.store) store = ctx.store;
	else {
		const chosen = submissionStore(readSubmissionsConfig(ctx.site.root, env), ctx.fetch);
		if ('kind' in chosen) {
			log(`[caracms] forms: a ${form.id} submission couldn't be stored. ${chosen.message}`);
			return reply(502, { error: STORE_FAILED_MESSAGE });
		}
		store = chosen;
	}
	const siteUrl = publicOrigin(ctx.astroSite, env);
	// Form rows Decision 5: the email names a sourced value by its document's title (every value here was just found offered).
	const titles: SourceTitles = titlesFromSources(form, sources);
	// On CaraCMS Cloud (caracms-cloud M4 Decision 24) the email goes with the submission: written here, sent by the cloud.
	const settingsRead = store.sendsEmail ? await readSettings().catch((error: unknown) => ({ error })) : null;
	let submission;
	try {
		const files: NewFile[] = await Promise.all(vetted.files.map(async (f) => ({ name: f.name, type: f.type, data: new Uint8Array(await f.blob.arrayBuffer()) })));
		submission = await store.create({
			form: form.id,
			receivedAt: now().toISOString(),
			fields: vetted.fields,
			...(files.length ? { files } : {}),
			...(settingsRead ? { email: (stored) => writeNotification({ submission: stored, form: worded, settings: settingsRead, siteUrl, timeZone: ctx.site.timeZone, titles, log }) } : {}),
		});
	} catch (error) {
		log(`[caracms] forms: couldn't store a ${form.id} submission: ${error instanceof Error ? error.message : String(error)}`);
		return reply(502, { error: STORE_FAILED_MESSAGE });
	}
	await limiter.hit(ip);
	if (store.sendsEmail) return reply(200, { ok: true });

	// EMAIL, then RECORD its outcome. Neither changes the visitor's reply.
	let email;
	try {
		const settings = await readSettings();
		email = await sendNotification({ submission, form: worded, settings, siteUrl, timeZone: ctx.site.timeZone, titles, env, fetch: ctx.fetch, now, log });
	} catch (error) {
		email = { status: 'failed' as const, at: now().toISOString(), to: [], error: `Could not read Site Settings: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (email.status === 'failed') log(`[caracms] forms: ${form.id} submission ${submission.id}: the email failed: ${email.error}`);
	try {
		await store.update(submission.id, { email });
	} catch (error) {
		log(`[caracms] forms: couldn't record the email's outcome on ${submission.id}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return reply(200, { ok: true });
}
