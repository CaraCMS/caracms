/**
 * Who may sign in: the whitelist (M4 Decision 15; the template's `server/admin-access.mjs`).
 *
 * Two halves, one rule:
 * - **The agency half, `CARACMS_ALLOW`**: comma-separated. Read once at startup
 *   (mode.ts → `LiveSettings.allow`), so nobody can edit the agency out from the editor.
 * - **The client half, `editors` in `content/site-settings.json`**, read from the
 *   in-memory `drafts` copy on every check, so a change takes effect at once, with no
 *   deploy. A missing file is an empty half. A file that doesn't parse, or whose
 *   `editors` isn't a list of strings, is an empty half too, **logged once per version
 *   of the file**.
 *
 * An entry is an exact address (`aoife@example.com`) or a whole domain (`@example.com`),
 * lower-cased and trimmed. **A public mail domain is never accepted as a domain entry**:
 * it's ignored, logged once (per entry, per half, per process). An exact address at one
 * of those domains is fine. Anything that is neither shape is ignored the same way.
 *
 * The backup account is its own path (backup.ts), not on this list.
 */
import { createHash } from 'node:crypto';

export { PUBLIC_MAIL_DOMAINS, normaliseEmail, parseAllowEntry, type AllowEntry } from './allow-rules.ts';
import { normaliseEmail, parseAllowEntry } from './allow-rules.ts';

export interface AllowList {
	addresses: Set<string>;
	domains: Set<string>;
}

type Log = (line: string) => void;

/** Addresses and domains out of raw entries; public-domain and malformed ones dropped, each logged once. */
export function compileAllowList(entries: readonly unknown[], source: string, log: Log, warned: Set<string>): AllowList {
	const addresses = new Set<string>();
	const domains = new Set<string>();
	for (const raw of entries) {
		const parsed = parseAllowEntry(raw);
		if (parsed.kind === 'address') addresses.add(parsed.value);
		else if (parsed.kind === 'domain') domains.add(parsed.value);
		else {
			const key = `${source}\u0000${parsed.value}`;
			if (warned.has(key)) continue;
			warned.add(key);
			log(
				parsed.kind === 'public-domain'
					? `ignoring "${parsed.value}" in ${source}: a public mail domain can't be a whole-domain entry (add exact addresses instead).`
					: `ignoring "${printable(parsed.value)}" in ${source}: not an email address or @domain.`,
			);
		}
	}
	return { addresses, domains };
}

/** Whether a normalised address matches a list: the exact address, or its domain. */
export function matchesAllowList(email: string, list: AllowList): boolean {
	if (!email) return false;
	if (list.addresses.has(email)) return true;
	return list.domains.has(email.slice(email.lastIndexOf('@') + 1));
}

/**
 * The client half's entries out of Site Settings' text. Null text (no file) is an
 * empty half; text that doesn't parse, or an `editors` that isn't a list of strings,
 * is an empty half plus a reason to log.
 */
export function editorsFrom(text: string | null): { entries: string[]; problem: string | null } {
	if (text === null) return { entries: [], problem: null };
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return { entries: [], problem: "it isn't valid JSON" };
	}
	if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { entries: [], problem: "it isn't a JSON object" };
	const editors = (doc as Record<string, unknown>).editors;
	if (editors === undefined) return { entries: [], problem: null };
	if (!Array.isArray(editors) || !editors.every((e) => typeof e === 'string')) return { entries: [], problem: '"editors" isn\'t a list of strings' };
	return { entries: editors as string[], problem: null };
}

export interface Whitelist {
	/** Whether this address may sign in right now. */
	allows(email: unknown): boolean;
}

/**
 * The whitelist over both halves. `agency` is CARACMS_ALLOW's entries; `readSettings`
 * gives Site Settings' current text from the `drafts` copy (or null), read on every
 * check. The compiled client half is cached per version of the file.
 */
export function createWhitelist(options: {
	agency: readonly string[];
	readSettings: () => string | null;
	settingsFile: string;
	log: Log;
}): Whitelist {
	const warned = new Set<string>();
	const agency = compileAllowList(options.agency, 'CARACMS_ALLOW', options.log, warned);
	let cached: { text: string | null; list: AllowList } | null = null;
	const loggedVersions = new Set<string>();
	const client = (): AllowList => {
		const text = options.readSettings();
		if (cached && cached.text === text) return cached.list;
		const { entries, problem } = editorsFrom(text);
		if (problem) {
			const version = createHash('sha256').update(text ?? '').digest('hex');
			if (!loggedVersions.has(version)) {
				loggedVersions.add(version);
				options.log(`${options.settingsFile}: ${problem}, so its editors list is empty; only CARACMS_ALLOW (and the backup account) can sign in.`);
			}
		}
		const list = compileAllowList(entries, `${options.settingsFile} → editors`, options.log, warned);
		cached = { text, list };
		return list;
	};
	return {
		allows(email) {
			const address = normaliseEmail(email);
			if (!address) return false;
			return matchesAllowList(address, agency) || matchesAllowList(address, client());
		},
	};
}

function printable(value: string): string {
	const shown = JSON.stringify(value).slice(1, -1);
	return shown.length > 80 ? `${shown.slice(0, 77)}...` : shown;
}
