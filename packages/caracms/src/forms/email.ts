/**
 * The submission's email (M6 Decision 8; `forms.md` → Recipients and email): one
 * plain-text email per stored submission, through the package's sender (../email.ts).
 *
 * - **Recipients and the brand name are read from the deployed Site Settings file**
 *   (`content/site-settings.json` on disk: `formRecipients.<form id>`, `brand.name`), so
 *   a change applies once it's published and deployed. Unreadable: the email is recorded
 *   `failed` with "Could not read Site Settings".
 * - Every field in the form's order by its label, a select by its option's label (a sourced
 *   one by its document's title: form rows Decision 5), a rows field as one line per row
 *   (Decision 11, left out with no rows, as a files field with no files is); the
 *   files by name and size, **never attached, never linked to the bucket**; the receive
 *   time in the site's zone; one link to the submission in the editor.
 * - Subject `<the form's email subject> — <brand name> website`, from `FORMS_FROM`,
 *   Reply-To the visitor's address when it looks like one.
 * - Addresses are checked again here (Decision 14's third check): trimmed, a duplicate
 *   dropped, one that doesn't look like an address skipped. An empty list is `skipped`.
 * - **Only a production server sends.** Elsewhere the email is written to the log and
 *   recorded `skipped`, saying so.
 * - **On CaraCMS Cloud** (caracms-cloud M4 Decision 24) the site writes the email the same
 *   way (`writeNotification`), from "<brand> – <form label>", to at most ten addresses,
 *   and the cloud store hands it over with the submission; the cloud sends it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SITE_SETTINGS_FILE } from '../reserved.ts';
import { sendEmail, sendsEmail } from '../email.ts';
import { formatBytes, looksLikeEmail, plainRowLines, rowsLines, shownChoice, shownFileName, submissionAddress, type ResolvedForm, type SourceTitles } from './rules.ts';
import type { EmailOutcome, StoredSubmission, WrittenEmail } from './store.ts';

type Env = Record<string, string | undefined>;

export interface FormSettings {
	/** Site Settings' `brand.name`, trimmed; '' when it has none. */
	brandName: string;
	/** `formRecipients` as written, each list's entries trimmed (strings only). */
	recipients: Record<string, string[]>;
	/** Review gaps (Decision 11): `formWords` as written (forms/words.ts → storedWordsOf shapes it); absent when there's none. */
	words?: unknown;
}

/** The settings out of a parsed Site Settings document. */
export function formSettingsFrom(doc: unknown): FormSettings {
	const o = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
	const brand = (o.brand && typeof o.brand === 'object' ? o.brand : {}) as Record<string, unknown>;
	const lists = (o.formRecipients && typeof o.formRecipients === 'object' && !Array.isArray(o.formRecipients) ? o.formRecipients : {}) as Record<string, unknown>;
	const recipients: Record<string, string[]> = {};
	for (const [id, list] of Object.entries(lists)) {
		recipients[id] = Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string').map((v) => v.trim()) : [];
	}
	return { brandName: typeof brand.name === 'string' ? brand.name.trim() : '', recipients, ...(o.formWords !== undefined ? { words: o.formWords } : {}) };
}

/** Read the deployed file, on every submission (a few KB, no cache to go stale). Throws when it's missing or not JSON. */
export async function readFormSettings(root: string): Promise<FormSettings> {
	return formSettingsFrom(JSON.parse(await readFile(join(root, SITE_SETTINGS_FILE), 'utf8')));
}

/** Trimmed, de-duplicated (without case), only what looks like an address: who the email goes to. */
export function sendableAddresses(values: readonly unknown[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== 'string') continue;
		const address = value.trim();
		if (!looksLikeEmail(address) || seen.has(address.toLowerCase())) continue;
		seen.add(address.toLowerCase());
		out.push(address);
	}
	return out;
}

/** "25 September 2026, 9:14 pm" in the site's zone. */
export function receivedText(iso: string, timeZone: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(date);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	return `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`;
}

/** The subject, the plain-text body and the Reply-To. */
export function buildNotification(input: { submission: StoredSubmission; form: ResolvedForm | null; brandName: string; siteUrl: string | null; timeZone: string; titles?: SourceTitles }): {
	subject: string;
	text: string;
	replyTo?: string;
} {
	const { submission, form, siteUrl, timeZone } = input;
	const titles = input.titles ?? {};
	const site = input.brandName.trim();
	const formLabel = form?.label ?? submission.form;
	const lines = [`Someone sent the ${formLabel} form on the ${site || 'your'} website.`, ''];
	const push = (label: string, value: string) => {
		if (value.includes('\n')) lines.push(`${label}:`, value, '');
		else lines.push(`${label}: ${value}`);
	};
	const stored = submission.fields ?? {};
	const shown = new Set<string>();
	for (const field of form?.fields ?? []) {
		shown.add(field.name);
		if (field.type === 'files') {
			const files = submission.files ?? [];
			if (files.length) lines.push(`${field.label}:`, ...files.map((f) => `${shownFileName(f.name) || shownFileName(f.key)}, ${formatBytes(f.size)}`), '');
			continue;
		}
		const raw = stored[field.name];
		if (field.type === 'rows') {
			const rows = rowsLines(field, raw, titles);
			if (rows.length) lines.push(`${field.label}:`, ...rows, '');
			continue;
		}
		// Form rows Decision 11: a list the form doesn't declare as rows is never "[object Object]".
		if (Array.isArray(raw)) {
			if (raw.length) lines.push(`${field.label}:`, ...plainRowLines(raw), '');
			else push(field.label, '');
			continue;
		}
		const value = typeof raw === 'string' ? raw.trim() : '';
		push(field.label, field.type === 'select' && value ? shownChoice(field, value, titles) : value);
	}
	// Anything stored that the form no longer names (a form changed since), by name.
	for (const [name, value] of Object.entries(stored)) {
		if (shown.has(name)) continue;
		if (Array.isArray(value)) {
			if (value.length) lines.push(`${name}:`, ...plainRowLines(value), '');
		} else push(name, String(value ?? '').trim());
	}
	if (!form && submission.files?.length) lines.push('Files:', ...submission.files.map((f) => `${shownFileName(f.name) || shownFileName(f.key)}, ${formatBytes(f.size)}`), '');
	if (lines[lines.length - 1] !== '') lines.push('');
	lines.push(`Received: ${receivedText(submission.receivedAt, timeZone)}`);
	const visitor = typeof stored.email === 'string' ? stored.email.trim() : '';
	const replyTo = looksLikeEmail(visitor) ? visitor : undefined;
	if (replyTo) lines.push('Reply to this email to answer them.');
	// With no public origin there is no link: a Host header could be anyone's, so the email says where to look instead.
	if (siteUrl) lines.push('', submission.files?.length ? 'Open it in the editor (the files download there):' : 'Open it in the editor:', new URL(submissionAddress(submission.id), siteUrl).href);
	else lines.push('', submission.files?.length ? 'Open Site-wide → Submissions in the editor (the files download there).' : 'Open Site-wide → Submissions in the editor.');
	return {
		subject: `${form?.email.subject ?? `New ${submission.form} enquiry`} — ${site ? `${site} website` : 'your website'}`,
		text: `${lines.join('\n')}\n`,
		...(replyTo ? { replyTo } : {}),
	};
}

/** The most addresses one form email goes to on CaraCMS Cloud (caracms-cloud M4 Decision 4). */
export const MAX_RECIPIENTS = 10;

/** The sender's display name on CaraCMS Cloud (M4 Decision 11): `<brand name> – <form label>`, "CaraCMS – Contact". The cloud cleans it further. */
export function fromName(brandName: string, formLabel: string): string {
	return [brandName.trim(), formLabel.trim()].filter(Boolean).join(' – ');
}

/** The sentence for a form with no one set to get its emails. */
const noRecipients = (label: string) => `No one is set to get the ${label} form's emails (Site Settings → Forms).`;

/**
 * The email a cloud site's server hands the cloud with a submission (M4 Decisions 11 and 24):
 * written as `sendNotification` writes it, the recipients capped at the first ten (the rest
 * logged), or the reason there is none. `settings` is the Site Settings read, or the error
 * reading them threw. Never throws.
 */
export function writeNotification(input: {
	submission: StoredSubmission;
	form: ResolvedForm | null;
	settings: FormSettings | { error: unknown };
	siteUrl: string | null;
	timeZone: string;
	/** Form rows Decision 5: sourced values' titles. */
	titles?: SourceTitles;
	log?: (line: string) => void;
}): WrittenEmail {
	const log = input.log ?? ((line: string) => console.log(line));
	if ('error' in input.settings) {
		const { error } = input.settings;
		return { emailFailed: `Could not read Site Settings: ${error instanceof Error ? error.message : String(error)}` };
	}
	const settings = input.settings;
	const label = input.form?.label ?? input.submission.form;
	const all = sendableAddresses(settings.recipients[input.submission.form] ?? []);
	if (all.length === 0) return { emailSkipped: noRecipients(label) };
	const to = all.slice(0, MAX_RECIPIENTS);
	if (all.length > to.length) {
		const left = all.length - to.length;
		log(`[caracms] forms: the ${label} form has ${all.length} recipients; its email goes to the first ${MAX_RECIPIENTS}, and ${left} ${left === 1 ? 'was' : 'were'} left off (Site Settings → Forms).`);
	}
	try {
		const built = buildNotification({ submission: input.submission, form: input.form, brandName: settings.brandName, siteUrl: input.siteUrl, timeZone: input.timeZone, titles: input.titles });
		return { email: { to, subject: built.subject, text: built.text, ...(built.replyTo ? { replyTo: built.replyTo } : {}), fromName: fromName(settings.brandName, label) } };
	} catch (error) {
		return { emailFailed: `Could not write the email: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Send a submission's email and say what happened (the outcome recorded on it). Never throws. */
export async function sendNotification(input: {
	submission: StoredSubmission;
	form: ResolvedForm | null;
	settings: FormSettings;
	siteUrl: string | null;
	timeZone: string;
	/** Form rows Decision 5: sourced values' titles. */
	titles?: SourceTitles;
	env?: Env;
	fetch?: typeof fetch;
	now?: () => Date;
	log?: (line: string) => void;
}): Promise<EmailOutcome> {
	const env = input.env ?? process.env;
	const at = (input.now ?? (() => new Date()))().toISOString();
	const log = input.log ?? ((line: string) => console.log(line));
	const to = sendableAddresses(input.settings.recipients[input.submission.form] ?? []);
	const label = input.form?.label ?? input.submission.form;
	if (to.length === 0) return { status: 'skipped', at, to, error: noRecipients(label) };
	let built: ReturnType<typeof buildNotification>;
	try {
		built = buildNotification({ submission: input.submission, form: input.form, brandName: input.settings.brandName, siteUrl: input.siteUrl, timeZone: input.timeZone, titles: input.titles });
	} catch (error) {
		return { status: 'failed', at, to, error: `Could not write the email: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!sendsEmail(env)) {
		log(`[caracms] form email for ${input.submission.id} (not emailed outside production), to ${to.join(', ')}:\nSubject: ${built.subject}\n${built.text}`);
		return { status: 'skipped', at, to, error: 'Not emailed: only the production server sends email. It was written to the server log.' };
	}
	const result = await sendEmail({ to, subject: built.subject, text: built.text, replyTo: built.replyTo }, { env, fetch: input.fetch });
	return result.status === 'sent' ? { status: 'sent', at, to } : { status: result.status, at, to, error: result.error };
}
