/**
 * `/sitemap.xml` (M6 Decision 12), prerendered at build from `SITE_URL` (Astro's `site`).
 * Every document with a URL: Pages, nested ones included, every collection with a
 * `urlBase`, and every held one at its holder's address (collections under pages), as
 * absolute URLs on the site's address. One file, no index (a site's
 * sitemap is small). Injected only when the address is known, so a build without
 * `SITE_URL` has no sitemap.
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import { build } from 'virtual:caracms/public';
import { siteCollections } from '../config.ts';
import { listDocuments } from '../content.ts';

export const prerender = true;

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** The sitemap's URLs: each document with a page, once, in config order. */
export async function sitemapUrls(siteUrl: string): Promise<string[]> {
	const urls: string[] = [];
	for (const collection of siteCollections(site)) {
		if (collection.urlBase === null && !collection.heldBy) continue;
		for (const entry of await listDocuments(site, collection.name)) {
			// M9 Decision 7: a hidden page (or one under it, or held by it) isn't on the site.
			if (entry.warning || entry.url === null || entry.hidden) continue;
			urls.push(`${siteUrl}${entry.url.split('/').map((p) => encodeURIComponent(p)).join('/')}`);
		}
	}
	return [...new Set(urls)];
}

export const GET: APIRoute = async () => {
	const urls = build.siteUrl ? await sitemapUrls(build.siteUrl) : [];
	const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${xml(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
	return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
