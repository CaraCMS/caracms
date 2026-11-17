/**
 * Every `/admin/login…` page (M4 Phase 3). The logic is ../../../live/auth/login.ts;
 * this route hands it the site's brand, the editor's tokens and its face, and the
 * process's Auth. In local mode there's no sign-in: every page goes to the editor.
 */
import type { APIRoute } from 'astro';
import { site } from 'virtual:caracms/config';
import instrumentSansExt from '../../fonts/instrument-sans-latin-ext-wght-normal.woff2?url';
import instrumentSans from '../../fonts/instrument-sans-latin-wght-normal.woff2?url';
import tokensCss from '../../styles/tokens.css?raw';
import { monogramIcon } from '../../brand.ts';
import { editorMode } from '../../server/mode.ts';
import { currentBrand, editorBrand } from '../../server/settings.ts';
import { authFor } from '../../../live/auth/index.ts';
import { handleLogin, localLoginRedirect } from '../../../live/auth/login.ts';
import type { Brand, PageAssets } from '../../../live/auth/views.ts';

export const prerender = false;

/** The brand as it applies now (M5a Decision 10: Site Settings' name and accent, as committed). */
async function brandNow(): Promise<Brand> {
	const brand = editorBrand(await currentBrand(site));
	return { ...brand, icon: brand.icon ?? brand.logo ?? monogramIcon(brand.name, brand.accent) };
}

// The chrome's face, as fonts.css declares it (latin, then latin-ext), with the bundle's URLs.
const face = (src: string, range: string) =>
	`@font-face{font-family:'Instrument Sans';font-style:normal;font-display:block;font-weight:400 700;src:url('${src}') format('woff2-variations');unicode-range:${range}}`;
const assets: PageAssets = {
	tokensCss,
	fontsCss: [
		face(instrumentSans, 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'),
		face(instrumentSansExt, 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'),
	].join('\n'),
};

export const ALL: APIRoute = async (context) => {
	const mode = editorMode();
	if (mode.kind === 'local') return localLoginRedirect();
	if (mode.kind !== 'live') return new Response("The editor isn't set up on this server yet.", { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
	const auth = await authFor(site, mode.settings, context.site);
	return handleLogin(context.request, { auth, brand: await brandNow(), assets, clientAddress: () => context.clientAddress });
};
