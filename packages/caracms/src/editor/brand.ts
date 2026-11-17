/**
 * The brand accent's ink and edge, computed by contrast (M2 Decision 5; the
 * mockup's applyBrand): text on the accent is light or dark, whichever contrasts
 * more, and a pale accent gets a darker edge so it still reads on white.
 * The light and dark inks and the page are the tokens --on-fill, --text and
 * --surface, read from styles/tokens.css (never retyped here: M2 Decision 7).
 * Server-side only (the admin route's props, the sign-in pages).
 */
import { readFileSync } from 'node:fs';
import type { Brand, ResolvedSite } from '../config.ts';
import { parseSettingsBrand } from '../document.ts';
import { brandImageUrl, readMediaConfig, type MediaConfig } from '../media.ts';
import type { EditorBrand } from './types.ts';
import { accentPresets } from './client/accent-presets.ts';

// In a Vite build this module is bundled away from styles/, so the integration inlines
// tokens.css as a define (M4: the editor is in the build); plain Node (tests) reads the file.
declare const __CARACMS_TOKENS_CSS__: string | undefined;
const TOKENS = typeof __CARACMS_TOKENS_CSS__ === 'string' ? __CARACMS_TOKENS_CSS__ : readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf8');
function token(name: string): string {
	const found = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`).exec(TOKENS);
	if (!found) throw new Error(`caracms: the token ${name} isn't a hex colour in tokens.css`);
	return found[1]!;
}
/** The editor's neutral accent: a site whose Site Settings name no accent (M5a Decision 10). */
export const DEFAULT_ACCENT = token('--accent');
const LIGHT = token('--on-fill');
const DARK = token('--text');
const PAGE = token('--surface');
/** Site Settings' accent presets (editor restyle, Decision 12), from tokens.css; /admin's props carry them. */
export const ACCENT_PRESETS = accentPresets(token);

const expand = (hex: string) => {
	const h = hex.replace('#', '').toLowerCase();
	return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(expand(hex).slice(i, i + 2), 16) / 255);
const luminance = (hex: string) => {
	const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio between two hex colours. */
export const contrast = (a: string, b: string) => {
	const x = luminance(a);
	const y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const mix = (a: string, b: string, t: number) =>
	`#${rgb(a)
		.map((v, i) => Math.round((v * (1 - t) + rgb(b)[i]! * t) * 255).toString(16).padStart(2, '0'))
		.join('')}`;

export function brandColours(accent: string): { accent: string; accentInk: string; accentEdge: string } {
	const a = expand(accent);
	return {
		accent: a,
		accentInk: contrast(a, LIGHT) >= contrast(a, DARK) ? LIGHT : DARK,
		accentEdge: contrast(a, PAGE) < 3 ? mix(a, DARK, 0.5) : a,
	};
}

/**
 * The tab icon when a site names neither an icon nor a logo: its initial on its
 * accent, as the logo slot draws it (an SVG data URL).
 */
export function monogramIcon(name: string, accent: string): string {
	const { accent: fill, accentInk: ink, accentEdge: edge } = brandColours(accent);
	const initial = ([...name.trim()][0] ?? '').toLocaleUpperCase().replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x=".5" y=".5" width="31" height="31" rx="7" fill="${fill}" stroke="${edge}"/>` +
		`<text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="${ink}">${initial}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ── The brand from Site Settings (M5a Decision 10) ────────────────────────────

/** The name the editor shows when Site Settings has none. */
export const DEFAULT_BRAND_NAME = 'Site';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The slots' CSS heights (M5b Decision 11): the logo's largest slot is the sign-in
 * pages' 28px (`.si-logo`; the bar's is 22px inside its 26px slot), the tab icon 32px.
 * brandImageUrl asks for each at 2×.
 */
export const LOGO_CSS_HEIGHT = 28;
export const ICON_CSS_HEIGHT = 32;

/**
 * The brand from Site Settings' text (null: no file) and the config's logo and icon. Never throws.
 *
 * M5b Decision 11: Site Settings' `brand.logo` and `brand.icon` (image values), each as a
 * signed fixed-mode URL, so the editor's client gets URLs, never keys. Without the media
 * variables (or a value) there's none, and the chrome shows its neutral mark. (The
 * config's logo and icon are refused by resolveSite, so `site.brand` is empty.)
 */
export function brandFrom(settingsText: string | null, site: Pick<ResolvedSite, 'brand'>, media: MediaConfig = readMediaConfig()): Brand {
	let raw: unknown = null;
	try {
		raw = settingsText === null ? null : (JSON.parse(settingsText) as { brand?: unknown } | null)?.brand;
	} catch {
		raw = null;
	}
	const { name, accent, logo, icon } = parseSettingsBrand(raw);
	const brand: Brand = { ...site.brand, name: name || DEFAULT_BRAND_NAME, accent: HEX.test(accent) ? accent : DEFAULT_ACCENT };
	const logoUrl = logo ? brandImageUrl(logo.key, LOGO_CSS_HEIGHT, media) : null;
	const iconUrl = icon ? brandImageUrl(icon.key, ICON_CSS_HEIGHT, media) : null;
	if (logoUrl) brand.logo = logoUrl;
	if (iconUrl) brand.icon = iconUrl;
	return brand;
}

/**
 * The brand with the accent's ink and edge, as the editor's chrome takes it, and the tab's
 * icon (M5b Decision 11): the icon, else the logo, else the neutral mark.
 */
export function editorBrand(brand: Brand): EditorBrand {
	return { ...brand, ...brandColours(brand.accent), tabIcon: brand.icon ?? brand.logo ?? monogramIcon(brand.name, brand.accent) };
}

