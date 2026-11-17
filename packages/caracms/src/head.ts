/**
 * The page's head (M6 Decisions 15 and 16; Contracts → The head): what `Head.astro`
 * writes, worked out here so it can be tested without a render.
 *
 * - **Title:** the page's `seo.title` as written; otherwise, for the home page, Site
 *   Settings' `seo.title`, then the brand's name; otherwise `<document title> · <brand name>`,
 *   where ` · ` is the config's `titleSeparator` (default ` · `, M8 trial round 2). With the
 *   config's `titleFallback: 'site'` (M9), every page falls back as the home page does.
 * - **Description and share image** fall back from the page's `seo` to Site Settings'.
 * - **Canonical link and `og:url`** only with the site's address (`SITE_URL`), and never
 *   in a preview.
 * - **The share image** is a signed imgproxy `rs:fill` at 1200 × 630 with the focal
 *   point's gravity (M5b's builder). No media set up: no `og:image`.
 * - **The Google tag** is an ID, never a script: `GTM-…` loads Tag Manager, `G-…` loads
 *   gtag.js, anything else nothing. Only in a production build, never in a preview.
 */
import { DEFAULT_TITLE_SEPARATOR, type TitleFallback } from './config.ts';
import { parseSettingsBrand, type PageDocument } from './document.ts';
import { imageUrl, isResizable, type MediaConfig } from './media.ts';
import { googleTagKind, parseGoogleTag, parseSeo, SHARE_IMAGE, type Seo, type SeoImage } from './seo.ts';

export interface HeadInput {
	document: PageDocument;
	/** Site Settings' text, from the file the build or the preview renders from; null when there's none. */
	settingsText: string | null;
	/** The page's path on the site (`/`, `/about`); null in a preview without one. */
	path: string | null;
	/** The site's address without a trailing slash, or null (no canonical, no `og:url`). */
	siteUrl: string | null;
	media: MediaConfig;
	/** A production build's public page: the Google tag may go in. */
	tagAllowed: boolean;
	/** Posts and tags, Decision 16: the page of a paged listing; from 2, the title says " — page N". 1 by default. */
	listPage?: number;
	/** The config's `titleSeparator` (ResolvedSite), spaces included; ` · ` when left out. */
	titleSeparator?: string;
	/** The config's `titleFallback` (ResolvedSite); `'page-and-brand'` when left out. */
	titleFallback?: TitleFallback;
}

export interface Head {
	title: string;
	description: string | null;
	canonical: string | null;
	image: { url: string; width?: number; height?: number } | null;
	twitterCard: 'summary_large_image' | 'summary';
	googleTag: { kind: 'gtm' | 'gtag'; id: string } | null;
}

function settingsOf(text: string | null): { brandName: string; seo: Seo; googleTag: string } {
	let raw: Record<string, unknown> = {};
	try {
		const parsed = text ? (JSON.parse(text) as unknown) : null;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
	} catch {
		/* a broken Site Settings file: no defaults */
	}
	return { brandName: parseSettingsBrand(raw.brand).name, seo: parseSeo(raw.seo), googleTag: parseGoogleTag(raw.googleTag) };
}

/** The share image's URL: `rs:fill` 1200 × 630, the focal point's gravity. An SVG or a GIF passes through. */
export function shareImage(image: SeoImage, media: MediaConfig): Head['image'] {
	if (media.kind !== 'ready') return null;
	const url = imageUrl(media.settings, image.key, { width: SHARE_IMAGE.width, height: SHARE_IMAGE.height, resize: 'fill', focal: image.focal ?? null });
	return isResizable(image.key) ? { url, width: SHARE_IMAGE.width, height: SHARE_IMAGE.height } : { url };
}

/** `/about/` → `/about`; `/` stays. */
const cleanPath = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

export function headOf(input: HeadInput): Head {
	const { document } = input;
	const settings = settingsOf(input.settingsText);
	const own = document.kind === 'shared' ? {} : parseSeo((document as { seo?: Seo }).seo);
	const home = input.path !== null && cleanPath(input.path) === '/';
	const docTitle = document.title.trim();
	// Decision 16: " — page N" straight after the page's own part, before the brand, so ten pages don't share one title.
	const paged = (text: string) => (input.listPage && input.listPage > 1 && text ? `${text} — page ${input.listPage}` : text);
	const siteWide = home || input.titleFallback === 'site';
	const fallback = siteWide ? paged(settings.seo.title || settings.brandName || docTitle) : [paged(docTitle), settings.brandName].filter(Boolean).join(input.titleSeparator ?? DEFAULT_TITLE_SEPARATOR);
	const title = paged(own.title ?? '') || fallback;
	const imageValue = own.image ?? settings.seo.image ?? null;
	const image = imageValue ? shareImage(imageValue, input.media) : null;
	const kind = input.tagAllowed ? googleTagKind(settings.googleTag) : null;
	return {
		title,
		description: own.description ?? settings.seo.description ?? null,
		canonical: input.siteUrl && input.path !== null ? `${input.siteUrl}${cleanPath(input.path)}` : null,
		image,
		twitterCard: image ? 'summary_large_image' : 'summary',
		googleTag: kind ? { kind, id: settings.googleTag } : null,
	};
}

/**
 * The tag's snippet. The ID has passed `googleTagKind` (letters, digits and one `-`), so
 * it's safe in the script's text; JSON-encoded anyway.
 */
export function googleTagSnippet(tag: NonNullable<Head['googleTag']>): string {
	const id = JSON.stringify(tag.id);
	if (tag.kind === 'gtm') {
		return `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${id});</script>`;
	}
	return `<script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(tag.id)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config',${id});</script>`;
}

/**
 * An address served from a `build.format: 'file'` prerender (`/about.html`, Home at
 * `/index.html`) as the page's own address (`/about`, `/`): a document's address never ends in
 * `.html`. Others are kept as they are.
 */
export const withoutHtml = (path: string): string => path.replace(/(?:\/index)?\.html$/, '') || '/';

/**
 * PageProps' `path` (an adoption trial, item 2): the document's address, the same in a public render
 * and in its preview. A preview's is `previewUrl`, its document's URL (content.ts →
 * documentUrl; null when it has no page). A public render's is the address it's served at,
 * decoded, with no trailing slash, and a paged listing's `/page/N` taken off (`listPage` > 1):
 * `/journal/page/2` is `/journal`'s page 2. A `build.format: 'file'` prerender's `.html` comes
 * off too (`withoutHtml`).
 */
export function documentPath(input: { preview: boolean; previewUrl: string | null; pathname: string; listPage: number }): string | null {
	if (input.preview) return input.previewUrl === null ? null : cleanPath(input.previewUrl) || '/';
	let path = input.pathname;
	try {
		path = decodeURI(path);
	} catch {
		// Not valid percent-encoding: kept as it came.
	}
	path = cleanPath(path) || '/';
	path = withoutHtml(path);
	if (input.listPage > 1) path = path.replace(new RegExp(`/page/${input.listPage}$`), '') || '/';
	return path;
}
