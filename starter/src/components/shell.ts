import { usableHref } from 'caracms/config';
import { fileLinkBehaviour } from 'caracms/files';
import { NETWORKS } from '../settings.ts';

/**
 * The page shell's reading of its data (M7 Decisions 17–18): the header's and the footer's
 * shared blocks (edit in context, Decision 16: the menu and the link columns) and Site
 * Settings' render data (the package's, Decision 13: the name, the contact details, the social
 * links) in, what SiteHeader.astro and SiteFooter.astro draw out. Pure, so the starter's tests
 * check the rules without a build.
 *
 * Anything unset is left out (template rule): an item with no address and no dropdown
 * links isn't drawn, a link with no label or no usable address isn't either, and a footer
 * part with nothing in it has no wrapper.
 */

export interface ShellLink {
	label: string;
	href: string;
	/** `aria-current="page"`: its address is the page's own, exactly (Decision 17). */
	current: boolean;
	/** A file link: a PDF opens in a new tab, any other file downloads (M6c Decision 11). */
	file: 'new-tab' | 'download' | null;
}

export type MenuItem = ({ kind: 'link' } & ShellLink) | { kind: 'group'; label: string; links: ShellLink[]; current: boolean };

export interface FooterColumn {
	/** Its row in the footer's `columns`, for its marks (edit in context: `columns.<index>.heading`). */
	index: number;
	heading: string;
	links: ShellLink[];
}

/** A social link, with its row in Site Settings' `socials` for its mark (`socials.<index>.network`). */
export type SocialLink = ShellLink & { index: number };

export interface FooterParts {
	columns: FooterColumn[];
	/** The email (`mailto:`) and phone (`tel:`), as links. */
	contact: ShellLink[];
	/** The postal address, one line per row. */
	address: string[];
	socials: SocialLink[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `/about/` → `/about`; `/` stays. The current-page check compares these, exactly. */
export function normalisePath(path: string): string {
	const bare = path.split(/[?#]/)[0] ?? '';
	return bare.length > 1 ? bare.replace(/\/+$/, '') || '/' : bare || '/';
}

function shellLink(label: string, hrefValue: unknown, current: string | null): ShellLink | null {
	const href = usableHref(hrefValue);
	if (!label || !href) return null;
	return { label, href, current: current !== null && href.startsWith('/') && normalisePath(href) === current, file: fileLinkBehaviour(href) };
}

/** A `link()` render value (`{ label, href }`, or null) as a shell link. */
function fromLink(value: unknown, current: string | null): ShellLink | null {
	return isRecord(value) ? shellLink(str(value.label), value.href, current) : null;
}

/** The site's name: `brand.name`, which the package has already given its fallback (Decision 13). */
export function siteName(settings: Record<string, unknown>): string {
	const brand = isRecord(settings.brand) ? settings.brand : {};
	return str(brand.name) || 'Site';
}

/**
 * The menu (the header's shared block, site-header.ts). An item with dropdown links is a
 * group, and its own address is ignored. `path` is the page's own address, or null for a
 * page with none (the header's own preview).
 */
export function menuItems(header: Record<string, unknown>, path: string | null): MenuItem[] {
	const current = path === null ? null : normalisePath(path);
	const items: MenuItem[] = [];
	for (const raw of arr(header.menu)) {
		if (!isRecord(raw)) continue;
		const label = str(raw.label);
		const links = arr(raw.links).map((l) => fromLink(l, current)).filter((l): l is ShellLink => l !== null);
		if (arr(raw.links).length > 0) {
			// A group whose links all lack an address has nothing to open: it isn't drawn.
			if (label && links.length > 0) items.push({ kind: 'group', label, links, current: links.some((l) => l.current) });
			continue;
		}
		const link = shellLink(label, isRecord(raw.href) ? raw.href.href : null, current);
		if (link) items.push({ kind: 'link', ...link });
	}
	return items;
}

const NETWORK_LABELS: Record<string, string> = Object.fromEntries(NETWORKS.map((n) => [n.value, n.label]));

/** The footer's parts (Decision 18), each empty when unset: the footer's shared block's columns, Site Settings' contact details and socials. */
export function footerParts(footer: Record<string, unknown>, settings: Record<string, unknown> = {}): FooterParts {
	const columns = arr(footer.columns)
		.map((c, index) => (isRecord(c) ? { index, heading: str(c.heading), links: arr(c.links).map((l) => fromLink(l, null)).filter((l): l is ShellLink => l !== null) } : null))
		.filter((c): c is FooterColumn => c !== null && c.links.length > 0);

	const contactValue = isRecord(settings.contact) ? settings.contact : {};
	const email = str(contactValue.email);
	const phone = str(contactValue.phone);
	const contact: ShellLink[] = [];
	if (email) contact.push({ label: email, href: `mailto:${email}`, current: false, file: null });
	if (phone) contact.push({ label: phone, href: `tel:${phone.replace(/[^\d+]/g, '')}`, current: false, file: null });
	const address = str(contactValue.address)
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

	const socials = arr(settings.socials)
		.map((s, index) => {
			const link = isRecord(s) ? shellLink(NETWORK_LABELS[str(s.network)] ?? '', isRecord(s.href) ? s.href.href : null, null) : null;
			return link ? { ...link, index } : null;
		})
		.filter((l): l is SocialLink => l !== null);

	return { columns, contact, address, socials };
}

/** A file link's attributes on the page (M6c Decision 11), as `<Link>` gives them. */
export function fileAttributes(link: ShellLink): Record<string, string | boolean> {
	if (link.file === 'new-tab') return { target: '_blank', rel: 'noopener' };
	if (link.file === 'download') return { download: true };
	return {};
}
