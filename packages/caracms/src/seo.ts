/**
 * Search and sharing (M6 Decisions 13, 14 and 16): a page's own `seo` key, Site
 * Settings' `seo` defaults, `googleTag` and `formRecipients`. How each parses (the
 * server's check on write and the head's on render) and how the file writes it.
 *
 * - `seo` is `{ "title", "description", "image": { "key", "w", "h", "focal"? } }`. **Blank
 *   parts are left out**, and a `seo` with nothing set is removed from the file, so a
 *   file that never had one is untouched. The share image is image-only with no alt
 *   (like the brand's logo, M5b Decision 11).
 * - `googleTag` is an ID, never a script: `GTM-XXXXXXX` (Tag Manager) or `G-XXXXXXXXXX`
 *   (gtag.js). Anything else renders nothing.
 * - `formRecipients` is one list of addresses per form id. Stored trimmed, a duplicate
 *   (without case) dropped, **an invalid address kept as typed** (the editor marks it
 *   "Gets no email"; the email skips it).
 *
 * Browser-safe (no imports beyond media-value.ts): the editor reads the limits and the
 * tag rule too.
 */
import { isFileKey } from './files.ts';
import { parseFocal, parseMedia } from './media-value.ts';

export interface SeoImage {
	key: string;
	w?: number;
	h?: number;
	focal?: [number, number];
}

export interface Seo {
	title?: string;
	description?: string;
	image?: SeoImage;
}

/** M5a's amber soft limits (Decision 13): over these, a note that blocks nothing. */
export const SEO_TITLE_SOFT_LIMIT = 60;
export const SEO_DESCRIPTION_SOFT_LIMIT = 160;

/** The share image's render (Decision 15): a signed `rs:fill` at this size. */
export const SHARE_IMAGE = { width: 1200, height: 630 } as const;

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** An image value as a share image: key, size and focal point only (no alt). Null for anything else. */
export function parseSeoImage(raw: unknown): SeoImage | null {
	const v = parseMedia(raw);
	if (!v || !('key' in v) || isFileKey(v.key)) return null;
	const out: SeoImage = { key: v.key };
	if (v.w !== undefined) out.w = v.w;
	if (v.h !== undefined) out.h = v.h;
	const focal = parseFocal((raw as Record<string, unknown>).focal);
	if (focal) out.focal = focal;
	return out;
}

/** `seo` as it applies: trimmed text, blank parts left out. `{}` when nothing is set. */
export function parseSeo(raw: unknown): Seo {
	const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const out: Seo = {};
	const title = text(o.title);
	const description = text(o.description);
	const image = parseSeoImage(o.image);
	if (title) out.title = title;
	if (description) out.description = description;
	if (image) out.image = image;
	return out;
}

export const isEmptySeo = (seo: Seo): boolean => !seo.title && !seo.description && !seo.image;

const line = (o: Record<string, unknown>) =>
	`{ ${Object.entries(o)
		.map(([k, v]) => `${JSON.stringify(k)}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v)}`)
		.join(', ')} }`;

/** `seo` as the file writes it: one member per line, the image on one line (as media values are). */
export function seoText(value: unknown, depth: number): string {
	const seo = parseSeo(value);
	const pad = '  '.repeat(depth + 1);
	const members: string[] = [];
	if (seo.title) members.push(`${pad}"title": ${JSON.stringify(seo.title)}`);
	if (seo.description) members.push(`${pad}"description": ${JSON.stringify(seo.description)}`);
	if (seo.image) members.push(`${pad}"image": ${line(seo.image as unknown as Record<string, unknown>)}`);
	return members.length ? `{\n${members.join(',\n')}\n${'  '.repeat(depth)}}` : '{}';
}

/** `googleTag` as written: the trimmed text (checked again when it's rendered). */
export const parseGoogleTag = (raw: unknown): string => text(raw);

/** What a Google tag ID loads: Tag Manager, gtag.js, or nothing (anything that isn't an ID). */
export function googleTagKind(id: unknown): 'gtm' | 'gtag' | null {
	if (typeof id !== 'string') return null;
	if (/^GTM-[A-Z0-9]{4,12}$/.test(id)) return 'gtm';
	if (/^G-[A-Z0-9]{6,16}$/.test(id)) return 'gtag';
	return null;
}

/**
 * The ID inside a pasted Google snippet (the mockup's "Use G-…"): the first `GTM-…` or
 * `G-…` in the text, or null.
 */
export function googleTagIn(pasted: string): string | null {
	const m = /\b(GTM-[A-Z0-9]{4,12}|G-[A-Z0-9]{6,16})\b/.exec(pasted);
	return m ? m[1]! : null;
}

/** `formRecipients` as stored: per form, the entries trimmed, blanks and duplicates (without case) dropped, invalid ones kept. Forms with none left out. */
export function parseFormRecipients(raw: unknown): Record<string, string[]> {
	const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const out: Record<string, string[]> = {};
	for (const [id, list] of Object.entries(o)) {
		if (!Array.isArray(list)) continue;
		const seen = new Set<string>();
		const kept: string[] = [];
		for (const entry of list) {
			const address = text(entry);
			if (!address || seen.has(address.toLowerCase())) continue;
			seen.add(address.toLowerCase());
			kept.push(address);
		}
		if (kept.length) out[id] = kept;
	}
	return out;
}
