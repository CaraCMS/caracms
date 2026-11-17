/**
 * The whitelist's rules for one entry (M4 Decision 15), browser-safe (no imports), so
 * the editor's Site Settings form checks an entry as it's typed by exactly the rules
 * the server applies (M5a Decision 10). allow.ts re-exports these; nothing here changed
 * when they moved.
 */
/** Public mail domains: never a domain entry. The template's list, as is. */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
	'gmail.com',
	'googlemail.com',
	'outlook.com',
	'hotmail.com',
	'live.com',
	'msn.com',
	'icloud.com',
	'me.com',
	'mac.com',
	'yahoo.com',
	'yahoo.co.nz',
	'aol.com',
	'proton.me',
	'protonmail.com',
	'gmx.com',
	'xtra.co.nz',
	// Regional versions and NZ internet providers.
	'hotmail.co.nz',
	'hotmail.co.uk',
	'hotmail.com.au',
	'outlook.co.nz',
	'outlook.com.au',
	'live.co.nz',
	'live.com.au',
	'yahoo.co.uk',
	'yahoo.com.au',
	'ymail.com',
	'rocketmail.com',
	'clear.net.nz',
	'vodafone.co.nz',
	'slingshot.co.nz',
	'orcon.net.nz',
	'paradise.net.nz',
	'ihug.co.nz',
]);

const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/** Longest address accepted (RFC 5321's limit). */
const MAX_ADDRESS = 254;

/** An address as it's compared and stored: trimmed and lower-cased, or '' if it isn't one. */
export function normaliseEmail(value: unknown): string {
	if (typeof value !== 'string') return '';
	const address = value.trim().toLowerCase();
	return address.length <= MAX_ADDRESS && ADDRESS_RE.test(address) ? address : '';
}

export type AllowEntry = { kind: 'address' | 'domain'; value: string } | { kind: 'public-domain' | 'invalid'; value: string };

/** What one whitelist entry is. */
export function parseAllowEntry(value: unknown): AllowEntry {
	const entry = typeof value === 'string' ? value.trim().toLowerCase() : '';
	if (entry.startsWith('@')) {
		const domain = entry.slice(1);
		if (!DOMAIN_RE.test(domain)) return { kind: 'invalid', value: entry };
		if (PUBLIC_MAIL_DOMAINS.has(domain)) return { kind: 'public-domain', value: entry };
		return { kind: 'domain', value: domain };
	}
	if (normaliseEmail(entry)) return { kind: 'address', value: entry };
	return { kind: 'invalid', value: entry };
}
